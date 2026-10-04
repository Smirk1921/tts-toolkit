// tests/unit/pack-upstream.test.ts
/**
 * src/pack/upstream.ts 单元测试：上游分支模型（pack import --as-upstream +
 * pack sync-upstream，方案设计 §4.10 / 施工流程 2C.3）。
 *
 * mock 环境：os.tmpdir() + fs.mkdtemp 临时目录里真实跑 git（init / branch /
 * commit / checkout / rev-parse / ls-tree / ls-files / show），快照用合成存档
 * JSON（与 tests/unit/pack-unpack.test.ts 同构的最小 ObjectStates），全程离线、
 * 不依赖真机 TTS 数据目录。
 *
 * 覆盖（对应任务四类要求）：
 * - import 落 upstream 分支：内容整树替换（快照产物在、用户文件不在）、切回原
 *   分支且现场复原、pack.yaml / .gitignore 等基础设施保留（upstream 分支不持有
 *   快照版 pack.yaml）、约束 8（.tts/skeleton.json 绝不入 git 且磁盘基准不被
 *   覆盖）、注册表 upstream 字段刷新；
 * - sync 拉新 commit：新快照 → upstream 分支前进、fast-forward 合回当前分支、
 *   注册表 last_synced / local_commit 刷新；
 * - 冲突时只提示不选边：双方改同一脚本 → merge 冲突保持进行中（索引未合并、
 *   磁盘文件带 <<<<<<< / >>>>>>> 标记且两侧内容都在），analyzeConflicts 反查出
 *   script {name: Global, guid: -1}，结果结构化（merged=false + conflicts），
 *   绝无自动 --ours/--theirs；注册表仍按 upstream 分支事实状态刷新；
 * - lfs 三方不一致时拦截：pack.yaml 声明 enabled 而 .gitattributes 缺规则 →
 *   import / sync 都抛 UPSTREAM_LFS_INCONSISTENT，git 现场（分支 / 提交）不动。
 * 补充错误路径：脏工作区 / 无提交前的快照缺失 / 未 import 先 sync /
 * datadir 兜底解析（显式假 Mods 目录，离线）。
 *
 * 断言约定：错误一律按 PackError.code（机器可读）断言，不依赖文案——文案走 t()，
 * locales/*.json 由本阶段 locales Run 补齐，补齐前后 message 不同。
 *
 * 注：本机 os.tmpdir() 路径含中文用户名，全部用例隐式覆盖中文 cwd。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PackError, readPackYaml, writePackYaml, type PackYaml } from '../../src/pack/packyaml.js';
import { findPack, registryPath, writeRegistry, type PackEntry } from '../../src/pack/registry.js';
import { importAsUpstream, syncUpstream } from '../../src/pack/upstream.js';

// 每个 it 里要跑十几次 git 子进程：超时由 vitest.config.ts 统一放宽到 30s，此处无需重复设置

// ---------------------------------------------------------------------------
// 常量与夹具数据
// ---------------------------------------------------------------------------

/** packs_root 与图包子目录（注册表在 packsRoot 级，图包是其下一级子目录） */
const PACKS_DIR = 'packs';
const PACK_DIR = '测试包';

/** 合成存档的三个版本内容（只有全局 Lua 不同：v1 基线 → 用户改 → v2 上游更新） */
const LUA_V1 = "print('global lua')\n";
const LUA_USER = "print('user edit')\n";
const LUA_V2 = "print('upstream v2')\n";

/**
 * 合成存档（与 pack-unpack.test.ts 的 buildSave 同构的最小两对象：带牌堆 +
 * 带脚本/UI 对象）。luaScript 可变，用于构造 v1 / v2 两个上游快照。
 */
function buildSave(luaScript: string): Record<string, unknown> {
  return {
    SaveName: '上游快照存档',
    LuaScript: luaScript,
    ObjectStates: [
      {
        GUID: 'aa11bb',
        Name: 'Deck',
        Nickname: '测试牌堆',
        CustomDeck: { '1': { FaceURL: 'http://example.invalid/face.png' } },
        ContainedObjects: [{ GUID: 'cc22dd', Name: 'Card', Nickname: '杀' }],
      },
      {
        GUID: 'dd33ee',
        Name: 'Custom_Pawn',
        Nickname: 'Scripted Trigger',
        LuaScript: "print('pawn script')\n",
        XmlUI: '<Panel id="pawn-ui" />',
      },
    ],
  };
}

/** 注册表条目夹具（与 docs/schemas/registry.yaml.md §4 的字段一一对应） */
function registryEntry(): PackEntry {
  return {
    dir: PACK_DIR,
    name: '测试包（汉化）',
    kind: 'localization',
    upstream: null,
    branch: 'main',
    host: 'steamcloud',
    modified: new Date().toISOString().slice(0, 10),
    stats: { decks: 0, cards: 0, scripts: 0 },
    lfs_status: 'disabled-no-lfs',
  };
}

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录 */
let tempRoot: string;
/** packs_root（注册表所在） */
let packsRoot: string;
/** 图包工作区根（= git 仓库工作树） */
let packRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-upstream-'));
  packsRoot = path.join(tempRoot, PACKS_DIR);
  packRoot = path.join(packsRoot, PACK_DIR);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/**
 * 在 packRoot 跑 git 命令，失败即抛（夹具专用，不走被测代码）。
 * @param args git 参数（不含 "git"）
 * @param cwd 工作目录（缺省 packRoot）
 * @returns stdout（execa 去除了末尾换行）
 */
async function git(args: string[], cwd: string = packRoot): Promise<string> {
  const result = await execa('git', args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
  }
  return result.stdout;
}

/**
 * 允许失败的 git 调用（探测分支存在性等），返回退出码与输出。
 */
async function gitRaw(args: string[], cwd: string = packRoot): Promise<{ code: number; stdout: string }> {
  const result = await execa('git', args, { cwd, reject: false });
  return { code: result.exitCode, stdout: result.stdout };
}

/** 当前分支名（git rev-parse --abbrev-ref HEAD） */
async function branchName(): Promise<string> {
  return (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

/** add -A + commit（夹具提交一律全量暂存） */
async function commitAll(message: string): Promise<void> {
  await git(['add', '-A']);
  await git(['commit', '-m', message]);
}

/** `git ls-tree -r --name-only -z`：某分支的完整文件清单（-z 避免中文路径被转义） */
async function listTree(branch: string): Promise<string[]> {
  const stdout = await git(['ls-tree', '-r', '--name-only', '-z', branch]);
  return stdout.split('\0').filter((entry) => entry !== '');
}

/** 期望抛出指定 code 的 PackError，否则失败（断言约定：按 code，不按文案） */
async function expectPackError(fn: () => Promise<unknown>, code: string): Promise<PackError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof PackError && err.code === code) {
      return err;
    }
    throw new Error(
      `期望 PackError(${code})，实际抛出：${err instanceof Error ? `${err.name}(${(err as PackError).code ?? '-'}): ${err.message}` : String(err)}`,
    );
  }
  throw new Error(`期望抛出 PackError(${code})，但调用成功了`);
}

/**
 * 建一个最小图包工作区 + git 仓库：
 * pack.yaml（vcs.lfs 可指定）+ .gitignore（排除骨架）+ .tts/skeleton.json
 * （用户的离线回路替换基准，被忽略不入库）+ mine.txt（用户自有文件）→
 * git init -b main + 首次提交 → 可选写 .registry.yaml 条目。
 * @param opts.lfs pack.yaml 的 vcs.lfs（缺省 disabled-no-lfs：无 .gitattributes 时三方一致）
 * @param opts.withRegistry 是否写注册表条目（缺省 true）
 */
async function makeWorkspace(opts: { lfs?: PackYaml['vcs']['lfs']; withRegistry?: boolean } = {}): Promise<void> {
  const lfs = opts.lfs ?? 'disabled-no-lfs';
  await mkdir(path.join(packRoot, '.tts'), { recursive: true });
  await writePackYaml(packRoot, {
    schema_version: 1,
    name: '测试包',
    workshop_id: null,
    source_mod: null,
    vcs: { lfs },
    paths: { workdir: '.' },
    upload: { prefix: '' },
  });
  await writeFile(path.join(packRoot, '.gitignore'), '.tts/skeleton.json\n', 'utf8');
  await writeFile(path.join(packRoot, '.tts', 'skeleton.json'), 'user-skeleton-baseline\n', 'utf8');
  await writeFile(path.join(packRoot, 'mine.txt'), '用户自有文件\n', 'utf8');
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'test@test.local']);
  await git(['config', 'user.name', 'tester']);
  await git(['config', 'core.autocrlf', 'false']);
  await commitAll('初始内容');
  if (opts.withRegistry !== false) {
    await writeRegistry(packsRoot, { schema_version: 1, packs: [registryEntry()] });
  }
}

/** 把合成存档写成 JSON 文件，返回绝对路径 */
async function writeSaveFile(name: string, luaScript: string): Promise<string> {
  const savePath = path.join(tempRoot, name);
  await writeFile(savePath, JSON.stringify(buildSave(luaScript), null, 2), 'utf8');
  return savePath;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('importAsUpstream：上游快照落到 upstream 分支', () => {
  it('快照整树落 upstream 分支，切回原分支且现场复原，骨架不入 git', async () => {
    await makeWorkspace();
    const saveV1 = await writeSaveFile('save-v1.json', LUA_V1);

    const result = await importAsUpstream({ root: packRoot, workshopId: 123456, snapshotPath: saveV1, packsRoot });

    // 结构化结果
    expect(result.snapshotPath).toBe(saveV1);
    expect(result.workshopId).toBe(123456);
    expect(result.branch).toBe('main');
    expect(result.committed).toBe(true);
    expect(result.mergeAttempted).toBe(false); // import 不做合并
    expect(result.merged).toBe(false);
    expect(result.conflicts).toBeNull();
    expect(result.upstreamCommit).toBe((await git(['rev-parse', 'refs/heads/upstream'])).trim());
    expect(await branchName()).toBe('main'); // 已切回原分支

    // upstream 分支内容：快照产物在、用户自有文件不在、基础设施保留、约束 8
    const tree = await listTree('upstream');
    expect(tree).toContain('scripts/Global.lua');
    expect(tree).toContain('decks/aa11bb.测试牌堆/data.json');
    expect(tree).toContain('decks/aa11bb.测试牌堆/deck.yaml');
    expect(tree).toContain('pack.yaml');
    expect(tree).toContain('.gitignore');
    expect(tree).not.toContain('mine.txt');
    expect(tree).not.toContain('.tts/skeleton.json'); // 约束 8：骨架绝不入 git
    expect((await git(['show', 'upstream:scripts/Global.lua'])).trimEnd()).toBe(LUA_V1.trimEnd());
    // pack.yaml 是用户工作区的基础设施：upstream 分支持有的仍是用户的版本
    expect(await git(['show', 'upstream:pack.yaml'])).toContain('name: 测试包');

    // 切回 main 后现场复原：用户文件与骨架基准都在（骨架内容未被快照覆盖）
    expect(await readFile(path.join(packRoot, 'mine.txt'), 'utf8')).toBe('用户自有文件\n');
    expect(await readFile(path.join(packRoot, '.tts', 'skeleton.json'), 'utf8')).toBe('user-skeleton-baseline\n');
    expect((await readPackYaml(packRoot)).name).toBe('测试包');

    // 注册表 upstream 字段已刷新
    const entry = await findPack(packsRoot, PACK_DIR);
    expect(entry?.upstream).toEqual({
      workshop_id: 123456,
      last_synced: new Date().toISOString().slice(0, 10),
      local_commit: result.upstreamCommit,
    });
    expect(entry?.branch).toBe('main');
  });

  it('再次 import（upstream 分支已存在）按快照整树覆盖', async () => {
    await makeWorkspace();
    const saveV1 = await writeSaveFile('save-v1.json', LUA_V1);
    await importAsUpstream({ root: packRoot, workshopId: 123456, snapshotPath: saveV1 });
    const firstCommit = (await git(['rev-parse', 'refs/heads/upstream'])).trim();

    // v2 快照再 import：upstream 分支前进，内容更新
    const saveV2 = await writeSaveFile('save-v2.json', LUA_V2);
    const result = await importAsUpstream({ root: packRoot, workshopId: 123456, snapshotPath: saveV2 });
    expect(result.committed).toBe(true);
    expect(result.upstreamCommit).not.toBe(firstCommit);
    expect((await git(['show', 'upstream:scripts/Global.lua'])).trimEnd()).toBe(LUA_V2.trimEnd());
    expect(await branchName()).toBe('main');
  });
});

describe('syncUpstream：拉上游新版本并合回当前分支', () => {
  it('新快照产生新提交并 fast-forward 合回（main 落后 upstream 的场景）', async () => {
    await makeWorkspace(); // withRegistry 默认 true；packsRoot 走缺省（root 的父目录）
    const saveV1 = await writeSaveFile('save-v1.json', LUA_V1);
    await importAsUpstream({ root: packRoot, workshopId: 123456, snapshotPath: saveV1, packsRoot });
    const firstCommit = (await git(['rev-parse', 'refs/heads/upstream'])).trim();

    const saveV2 = await writeSaveFile('save-v2.json', LUA_V2);
    const result = await syncUpstream({ root: packRoot, snapshotPath: saveV2 });

    // upstream 分支前进 + 干净合并（fast-forward）
    expect(result.committed).toBe(true);
    expect(result.upstreamCommit).not.toBe(firstCommit);
    expect(result.mergeAttempted).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.conflicts).toBeNull();
    expect(result.branch).toBe('main');
    expect(await branchName()).toBe('main');

    // fast-forward：main 现在指向 upstream 提交，磁盘内容是新快照
    expect((await git(['rev-parse', 'refs/heads/main'])).trim()).toBe(result.upstreamCommit);
    expect(await readFile(path.join(packRoot, 'scripts', 'Global.lua'), 'utf8')).toBe(LUA_V2);
    // 用户基础设施不受合并影响（快照不携带 pack.yaml 的变更）
    expect((await readPackYaml(packRoot)).name).toBe('测试包');
    expect(await readFile(path.join(packRoot, '.tts', 'skeleton.json'), 'utf8')).toBe('user-skeleton-baseline\n');

    // 注册表刷新为新提交
    const entry = await findPack(packsRoot, PACK_DIR);
    expect(entry?.upstream?.local_commit).toBe(result.upstreamCommit);
    expect(entry?.upstream?.last_synced).toBe(new Date().toISOString().slice(0, 10));
  });

  it('快照与 upstream 现状一致时不产生空提交', async () => {
    await makeWorkspace();
    const saveV1 = await writeSaveFile('save-v1.json', LUA_V1);
    await importAsUpstream({ root: packRoot, workshopId: 123456, snapshotPath: saveV1, packsRoot });
    const before = (await git(['rev-parse', 'refs/heads/upstream'])).trim();

    const result = await syncUpstream({ root: packRoot, snapshotPath: saveV1 });
    expect(result.committed).toBe(false);
    expect(result.upstreamCommit).toBe(before);
    expect(result.merged).toBe(true); // already up to date 也算干净合并
  });
});

describe('syncUpstream：合并冲突只提示不选边', () => {
  it('双方改同一脚本 → 冲突保持进行中，反查报告 + 标记留存，绝不自动选边', async () => {
    await makeWorkspace();
    const saveV1 = await writeSaveFile('save-v1.json', LUA_V1);
    await importAsUpstream({ root: packRoot, workshopId: 123456, snapshotPath: saveV1, packsRoot });

    // 用户基于 upstream 开自己的分支（方案设计 §4.10 流程），改同一个文件并提交
    await git(['checkout', '-b', 'zh-cn', 'upstream']);
    await writeFile(path.join(packRoot, 'scripts', 'Global.lua'), LUA_USER, 'utf8');
    await commitAll('用户改了全局脚本');

    // 上游更新同一文件 → merge 必然冲突
    const saveV2 = await writeSaveFile('save-v2.json', LUA_V2);
    const result = await syncUpstream({ root: packRoot, snapshotPath: saveV2 });

    // 结构化结果：merged=false + 冲突报告（不抛错、不选边、不 abort）
    expect(result.merged).toBe(false);
    expect(result.mergeAttempted).toBe(true);
    expect(result.conflicts).not.toBeNull();
    expect(result.conflicts?.hasConflicts).toBe(true);
    expect(result.conflicts?.conflicts).toHaveLength(1);
    const conflict = result.conflicts?.conflicts[0];
    expect(conflict?.type).toBe('script');
    expect(conflict?.xy).toBe('UU');
    expect(conflict?.path).toBe('scripts/Global.lua');
    expect(conflict?.script).toEqual({ name: 'Global', guid: '-1' });
    expect(result.branch).toBe('zh-cn');
    expect(await branchName()).toBe('zh-cn');

    // merge 保持进行中：索引未合并（3 个 stage 条目），绝不自动 --ours/--theirs
    expect((await git(['ls-files', '-u'])).length).toBeGreaterThan(0);
    // 磁盘文件带冲突标记，且两侧内容都在（没有被任何一侧静默覆盖）
    const onDisk = await readFile(path.join(packRoot, 'scripts', 'Global.lua'), 'utf8');
    expect(onDisk).toContain('<<<<<<<');
    expect(onDisk).toContain('=======');
    expect(onDisk).toContain('>>>>>>>');
    expect(onDisk).toContain("print('user edit')");
    expect(onDisk).toContain("print('upstream v2')");

    // 注册表仍按 upstream 分支的事实状态刷新（同步动作本身已完成）
    const entry = await findPack(packsRoot, PACK_DIR);
    expect(entry?.upstream?.local_commit).toBe(result.upstreamCommit);
    expect(entry?.upstream?.last_synced).toBe(new Date().toISOString().slice(0, 10));
    expect(entry?.branch).toBe('zh-cn');
  });
});

describe('lfs 三方不一致时拦截', () => {
  it('pack.yaml 声明 enabled 但 .gitattributes 缺规则 → import / sync 都拒绝且 git 现场不动', async () => {
    await makeWorkspace({ lfs: 'enabled' });
    const saveV1 = await writeSaveFile('save-v1.json', LUA_V1);
    const headBefore = (await git(['rev-parse', 'HEAD'])).trim();

    const err1 = await expectPackError(
      () => importAsUpstream({ root: packRoot, workshopId: 123456, snapshotPath: saveV1 }),
      'UPSTREAM_LFS_INCONSISTENT',
    );
    expect(err1.message.length).toBeGreaterThan(0); // 文案走 t()，按 code 断言
    // upstream 分支没有被创建，HEAD 未动
    expect((await gitRaw(['rev-parse', '--verify', '--quiet', 'refs/heads/upstream'])).code).not.toBe(0);
    expect((await git(['rev-parse', 'HEAD'])).trim()).toBe(headBefore);
    expect(await branchName()).toBe('main');

    // sync 同样拦截（先手工建 upstream 分支以满足"已 import"前置）
    await git(['branch', 'upstream']);
    const upstreamBefore = (await git(['rev-parse', 'refs/heads/upstream'])).trim();
    await expectPackError(() => syncUpstream({ root: packRoot, snapshotPath: saveV1 }), 'UPSTREAM_LFS_INCONSISTENT');
    expect((await git(['rev-parse', 'refs/heads/upstream'])).trim()).toBe(upstreamBefore);
  });
});

describe('前置拒绝与快照解析', () => {
  it('脏工作区（含未跟踪文件）→ UPSTREAM_DIRTY_WORKTREE，import 与 sync 都拒绝', async () => {
    await makeWorkspace();
    const saveV1 = await writeSaveFile('save-v1.json', LUA_V1);
    await writeFile(path.join(packRoot, '未跟踪.txt'), 'dirty\n', 'utf8');

    await expectPackError(
      () => importAsUpstream({ root: packRoot, workshopId: 123456, snapshotPath: saveV1 }),
      'UPSTREAM_DIRTY_WORKTREE',
    );
    await expectPackError(() => syncUpstream({ root: packRoot, snapshotPath: saveV1 }), 'UPSTREAM_DIRTY_WORKTREE');
    expect(await branchName()).toBe('main');
    expect((await gitRaw(['rev-parse', '--verify', '--quiet', 'refs/heads/upstream'])).code).not.toBe(0);
  });

  it('未 import 先 sync → UPSTREAM_NOT_IMPORTED', async () => {
    await makeWorkspace();
    const saveV1 = await writeSaveFile('save-v1.json', LUA_V1);
    await expectPackError(() => syncUpstream({ root: packRoot, snapshotPath: saveV1 }), 'UPSTREAM_NOT_IMPORTED');
  });

  it('快照找不到 → UPSTREAM_SNAPSHOT_NOT_FOUND（显式路径 / 无工坊 ID / datadir 里没有）', async () => {
    await makeWorkspace();
    const saveV1 = await writeSaveFile('save-v1.json', LUA_V1);

    // a. 显式路径不存在
    await expectPackError(
      () => importAsUpstream({ root: packRoot, workshopId: 1, snapshotPath: path.join(tempRoot, '不存在.json') }),
      'UPSTREAM_SNAPSHOT_NOT_FOUND',
    );

    // b. sync 无 snapshotPath，注册表已删、pack.yaml.source_mod 为 null → 无工坊 ID 可用
    await git(['branch', 'upstream']); // 满足"已 import"前置，让检查走到快照解析
    await rm(registryPath(packsRoot), { force: true });
    await expectPackError(() => syncUpstream({ root: packRoot }), 'UPSTREAM_SNAPSHOT_NOT_FOUND');

    // c. 注册表记了工坊 ID 777，但显式 datadir 里没有 Workshop/777.json
    const entry = registryEntry();
    await writeRegistry(packsRoot, {
      schema_version: 1,
      packs: [{ ...entry, upstream: { workshop_id: 777, last_synced: '2026-10-01', local_commit: 'a1b2c3d' } }],
    });
    const emptyMods = path.join(tempRoot, 'empty-mods');
    await mkdir(path.join(emptyMods, 'Workshop'), { recursive: true });
    await expectPackError(() => syncUpstream({ root: packRoot, datadir: emptyMods }), 'UPSTREAM_SNAPSHOT_NOT_FOUND');
  });

  it('datadir 兜底解析：import 按 workshopId 找 Mods/Workshop/<id>.json，sync 沿用注册表 ID', async () => {
    await makeWorkspace();
    const fakeMods = path.join(tempRoot, 'fake-mods');
    await mkdir(path.join(fakeMods, 'Workshop'), { recursive: true });
    const modSave = path.join(fakeMods, 'Workshop', '999.json');
    await writeFile(modSave, JSON.stringify(buildSave(LUA_V1), null, 2), 'utf8');

    // import：不给 snapshotPath，按 workshopId + datadir 解析
    const imported = await importAsUpstream({ root: packRoot, workshopId: 999, datadir: fakeMods });
    expect(imported.snapshotPath).toBe(modSave);
    expect(imported.committed).toBe(true);
    expect((await findPack(packsRoot, PACK_DIR))?.upstream?.workshop_id).toBe(999);

    // sync：同样不给 snapshotPath，工坊 ID 从注册表 upstream.workshop_id 解析
    await writeFile(modSave, JSON.stringify(buildSave(LUA_V2), null, 2), 'utf8');
    const synced = await syncUpstream({ root: packRoot, datadir: fakeMods });
    expect(synced.snapshotPath).toBe(modSave);
    expect(synced.workshopId).toBe(999);
    expect(synced.committed).toBe(true);
    expect(synced.merged).toBe(true);
    expect(await readFile(path.join(packRoot, 'scripts', 'Global.lua'), 'utf8')).toBe(LUA_V2);
  });

  it('入参编程错误 → 普通 Error（root 空 / workshopId 非正整数）', async () => {
    await makeWorkspace();
    await expect(importAsUpstream({ root: '', workshopId: 1 })).rejects.toThrow(Error);
    await expect(
      importAsUpstream({ root: packRoot, workshopId: 0, snapshotPath: 'x.json' }),
    ).rejects.toThrow('workshopId');
    await expect(
      importAsUpstream({ root: packRoot, workshopId: 1.5, snapshotPath: 'x.json' }),
    ).rejects.toThrow('workshopId');
    await expect(syncUpstream({ root: '' })).rejects.toThrow(Error);
  });
});
