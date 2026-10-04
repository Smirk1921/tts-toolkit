// tests/unit/vcs-verify.test.ts
/**
 * src/vcs/verify.ts 单元测试：deck 体检 + git 状态检查的合并包装。
 *
 * 真实 git 子进程（execa("git", [...]) 在 os.tmpdir() 的临时目录里跑
 * git init / add / commit / checkout / merge），覆盖：
 * - 基础行为：非 git 仓库纯工作区 verify、deck error 与 git issue 的合并统计、
 *   deckVerify 与 verifyPack 直接结果一致、packRoot 非法入参；
 * - git 状态检查：干净仓库 / 修改未提交 / 未跟踪 / 仅暂存 → VCS_UNCOMMITTED，
 *   UU / AA / UD（一方修改一方删除）合并冲突 → VCS_UNRESOLVED_CONFLICT
 *   （UD/DU 验证"全部 7 种未合并状态"的超集判定，规格点名 UU/AA/DD），
 *   git 不在 PATH（mock PATH）→ 整体跳过；
 * - lfs 三方一致性：.gitattributes 有规则 + git-lfs 不可用（PATH 前置 git.cmd /
 *   sh shim，拦截 `git lfs` 子命令、转发其余命令——真实代码路径）→ VCS_LFS_MISSING，
 *   enabled 缺规则 / disabled 含规则 / disabled-no-lfs / 全一致，
 *   多项 issue 叠加时的产出顺序（warning 在前，检查项序）；
 * - 选项开关：checkGit=false 整体跳过、checkCmyk / checkAtlasSize 透传
 *   verifyPack（默认触发 issue、关掉后消失）、pack.yaml 损坏透传 PACK_INVALID。
 *
 * 断言约定：gitIssues 的 code / severity 精确断言，message 用 includes() 断言
 * 关键片段；PackError 按 .code 断言。
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { verifyPack } from '../../src/deck/verify.js';
import { writeCardsCsv, type CardRow } from '../../src/deck/cards.js';
import { writeObjectsCsv } from '../../src/deck/objects.js';
import { PACK_YAML_FILENAME, PackError, writePackYaml, type PackYaml } from '../../src/pack/packyaml.js';
import { writeDeckManifest } from '../../src/pack/manifest.js';
import { vcsVerify, type VcsVerifyResult } from '../../src/vcs/verify.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时图包根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

/** git-lfs 不可用 mock 的 shim 目录（懒创建；beforeEach 清空，afterEach 删除） */
let shimRoot: string | null = null;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-vcs-verify-'));
  shimRoot = null;
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  if (shimRoot !== null) {
    await rm(shimRoot, { recursive: true, force: true });
    shimRoot = null;
  }
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助：git
// ---------------------------------------------------------------------------

/** 在指定目录跑 git 命令，失败即抛（测试夹具自身用，不走被测代码） */
async function git(args: string[], cwd: string = tempRoot): Promise<void> {
  const result = await execa('git', args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
  }
}

/** 初始化一个带提交者身份、固定分支名、关闭 autocrlf 的测试仓库 */
async function initRepo(dir: string = tempRoot): Promise<void> {
  await git(['init', '-b', 'main'], dir);
  await git(['config', 'user.email', 'test@test.local'], dir);
  await git(['config', 'user.name', 'tester'], dir);
  await git(['config', 'core.autocrlf', 'false'], dir);
}

/** git add -A + commit（全部改动入库，让 status 干净） */
async function commitAll(message: string, dir: string = tempRoot): Promise<void> {
  await git(['add', '-A'], dir);
  await git(['commit', '-m', message], dir);
}

/** 写一个文件并提交 */
async function commitFile(relPath: string, content: string, message: string): Promise<void> {
  await writeFile(path.join(tempRoot, relPath), content, 'utf8');
  await git(['add', relPath]);
  await git(['commit', '-m', message]);
}

/** 删除一个文件并把删除入库 */
async function deleteAndCommit(relPath: string, message: string): Promise<void> {
  await rm(path.join(tempRoot, relPath));
  await git(['add', relPath]);
  await git(['commit', '-m', message]);
}

/**
 * 制造指定形态的未解决合并冲突（merge 退出码非 0，工作区停留在冲突态）：
 * - UU：双方修改同一文件；
 * - AA：双方新增同一路径（内容不同）；
 * - UD/DU：一方修改、一方删除同一文件（验证"任一侧为 U 即未合并"的超集判定）。
 */
async function makeConflict(kind: 'UU' | 'AA' | 'UD'): Promise<void> {
  if (kind === 'UU') {
    await commitFile('conflict.txt', 'base', 'base');
    await git(['checkout', '-b', 'feature']);
    await commitFile('conflict.txt', 'feature', 'feature');
    await git(['checkout', 'main']);
    await commitFile('conflict.txt', 'main', 'main');
  } else if (kind === 'AA') {
    await commitFile('base.txt', 'base', 'base');
    await git(['checkout', '-b', 'feature']);
    await commitFile('new.txt', 'feature', 'feature');
    await git(['checkout', 'main']);
    await commitFile('new.txt', 'main', 'main');
  } else {
    await commitFile('del.txt', 'base', 'base');
    await git(['checkout', '-b', 'feature']);
    await deleteAndCommit('del.txt', 'feature delete');
    await git(['checkout', 'main']);
    await commitFile('del.txt', 'main modified', 'main modify');
  }
  const merge = await execa('git', ['merge', 'feature'], { cwd: tempRoot, reject: false });
  if (merge.exitCode === 0) {
    throw new Error(`预期 merge 冲突（${kind}），但合并成功：${merge.stdout}`);
  }
}

// ---------------------------------------------------------------------------
// 测试夹具与辅助：图包工作区
// ---------------------------------------------------------------------------

/** B1 init.ts 写入 .gitattributes 的模板行（与 vcs-lfs.test.ts 保持一致） */
const INIT_TEMPLATE_LINES: readonly string[] = Object.freeze([
  '*.png filter=lfs diff=lfs merge=lfs -text',
  '*.jpg filter=lfs diff=lfs merge=lfs -text',
  '*.jpeg filter=lfs diff=lfs merge=lfs -text',
  '*.gif filter=lfs diff=lfs merge=lfs -text',
  '*.webp filter=lfs diff=lfs merge=lfs -text',
  '*.obj filter=lfs diff=lfs merge=lfs -text',
  '*.ttsmod filter=lfs diff=lfs merge=lfs -text',
]);

/** 写一份最小合法 pack.yaml（经 writePackYaml 的 schema 校验，vcs.lfs 可指定） */
async function writePack(root: string, lfs: PackYaml['vcs']['lfs'] = 'disabled'): Promise<PackYaml> {
  const pack: PackYaml = {
    schema_version: 1,
    name: '测试图包',
    workshop_id: null,
    source_mod: null,
    vcs: { lfs },
    paths: { workdir: '.' },
    upload: { prefix: '' },
  };
  await writePackYaml(root, pack);
  return pack;
}

/** 写 .gitattributes（原始文本，用于构造各种规则形态） */
async function writeAttributes(root: string, text: string): Promise<void> {
  await writeFile(path.join(root, '.gitattributes'), text, 'utf8');
}

/** 把 pack.yaml 覆写为不合规内容（schema_version 非 1） */
async function corruptPackYaml(): Promise<void> {
  await writeFile(path.join(tempRoot, PACK_YAML_FILENAME), 'schema_version: 2\nname: 坏的\n', 'utf8');
}

/**
 * 一套 deck verify 全通过的图包夹具：合法 pack.yaml + deck.yaml + 只有表头的
 * cards.csv + 空 objects.csv（无图无存档，所有校验面零 issue）。
 */
async function makeCleanPack(lfs: PackYaml['vcs']['lfs'] = 'disabled'): Promise<void> {
  const deckDir = path.join(tempRoot, 'decks', 'deckA');
  await writeDeckManifest(deckDir, { schema_version: 1, name: 'deckA', guid: 'AAA111', shared_with: [] });
  await writeCardsCsv(deckDir, []);
  await writeObjectsCsv(path.join(tempRoot, 'objects'), []);
  await writePack(tempRoot, lfs);
}

// ── 卡牌夹具（透传 checkCmyk / checkAtlasSize 用）──

/** 默认网格：2 列 × 3 行，单格 64px（图集 128×192） */
const COLS = 2;
const ROWS = 3;
const CELL = 64;

/** 构造一行卡牌（默认 2x3 网格、本地图集 source/sheet-1.png，slot 按 1 基换算） */
function makeRow(overrides: Partial<CardRow> & Pick<CardRow, 'cardId'>): CardRow {
  return {
    face: `card_${overrides.cardId}.png`,
    sheetId: 1,
    slot: (overrides.cardId % 100) === 0 ? 100 : overrides.cardId % 100,
    sheetCols: COLS,
    sheetRows: ROWS,
    sheetSource: 'source/sheet-1.png',
    ...overrides,
  };
}

/** 落盘一张 PNG 图集（默认尺寸 = 网格 × 64px 方格；可指定假尺寸） */
async function makeAtlas(
  deckDir: string,
  opts: { width?: number; height?: number } = {},
): Promise<void> {
  const file = path.join(deckDir, 'source', 'sheet-1.png');
  await mkdir(path.dirname(file), { recursive: true });
  await sharp({
    create: {
      width: opts.width ?? COLS * CELL,
      height: opts.height ?? ROWS * CELL,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 1 },
    },
  }).png().toFile(file);
}

/** 落盘一张卡图（默认 sRGB PNG；cmyk=true 时输出 CMYK JPEG） */
async function makeCardImage(
  deckDir: string,
  relative: string,
  opts: { cmyk?: boolean } = {},
): Promise<void> {
  const file = path.join(deckDir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  const base = sharp({
    create: { width: CELL, height: CELL, channels: 3, background: { r: 200, g: 10, b: 10 } },
  });
  if (opts.cmyk) {
    await base.toColorspace('cmyk').jpeg({ quality: 90 }).toFile(file);
  } else {
    await base.png().toFile(file);
  }
}

/**
 * 一套"卡铺满 + 图集吻合"的全通过工作区；cmykCard=第 1 张卡图用 CMYK，
 * badAtlasSize=图集尺寸 100x100（与声明网格不符）。
 */
async function makeFullDeck(opts: { cmykCard?: boolean; badAtlasSize?: boolean } = {}): Promise<string> {
  const deckDir = path.join(tempRoot, 'decks', 'deckA');
  await writeDeckManifest(deckDir, { schema_version: 1, name: 'deckA', guid: 'AAA111', shared_with: [] });
  const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({ cardId: 10100 + slot }));
  await writeCardsCsv(deckDir, rows);
  await makeAtlas(deckDir, opts.badAtlasSize ? { width: 100, height: 100 } : {});
  for (const row of rows) {
    await makeCardImage(deckDir, row.face, { cmyk: opts.cmykCard === true && row.slot === 1 });
  }
  await writeObjectsCsv(path.join(tempRoot, 'objects'), []);
  await writePack(tempRoot, 'disabled');
  return deckDir;
}

// ---------------------------------------------------------------------------
// 测试夹具与辅助：mock / 断言
// ---------------------------------------------------------------------------

/** 断言 fn 抛出指定 code 的 PackError，并返回该错误供进一步断言 */
async function expectPackError(fn: () => Promise<unknown>, code: string): Promise<PackError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PackError);
    const packError = err as PackError;
    expect(packError.code).toBe(code);
    expect(packError.message.length).toBeGreaterThan(0);
    return packError;
  }
  throw new Error(`预期抛出 code=${code} 的 PackError，但调用成功了`);
}

/**
 * 临时替换 process.env.PATH 执行 fn（finally 恢复）。
 * vitest 的 worker 之间进程隔离、文件内用例串行，改动只影响当前用例。
 */
async function withMockedPath<T>(pathValue: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = pathValue;
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = original;
    }
  }
}

/**
 * 构造"git 可用但 git-lfs 不可用"的 mock：在独立临时目录放一个 git 垫片
 * （win32 用 git.cmd，POSIX 用 sh 脚本），拦截 `git lfs` 子命令（exitCode 1 +
 * git 的真实报错文案）、其余命令按绝对路径转发给真实 git。返回垫片目录。
 *
 * 为什么不用 nuked PATH：PATH 清空后 git 本身也不可用，vcsVerify 会在
 * isGitRepo 处以 GIT_NOT_FOUND 整体跳过 git 检查，VCS_LFS_MISSING 永远不触发；
 * 垫片方案让 statusPorcelain / isGitRepo 走真实 git，只有 lfs 探测失败。
 *
 * 实现备忘（实测 execa 10 + git 2.55 on win32）：execa 对 .cmd 参数做双重转义，
 * 批处理里 %~1 展开后自带一层引号，所以拦截比较必须用方括号形态
 * （[%~1]==[lfs] 与 [%~1]==["lfs"] 各查一遍），不能写 "%~1"=="lfs"（引号套引号
 * → cmd 语法错误）。
 */
async function makeGitLfsShim(): Promise<string> {
  shimRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-vcs-verify-shim-'));
  const shimDir = path.join(shimRoot, 'bin');
  await mkdir(shimDir, { recursive: true });

  if (process.platform === 'win32') {
    const whereResult = await execa('where', ['git'], { reject: false });
    const realGit = whereResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().endsWith('git.exe'));
    if (realGit === undefined) {
      throw new Error('找不到 git.exe，无法构造 git-lfs 未安装的 mock');
    }
    const shim = [
      '@echo off',
      'if /I [%~1]==[lfs] goto :nolfshim',
      'if /I [%~1]==["lfs"] goto :nolfshim',
      `"${realGit}" %*`,
      'exit /b %errorlevel%',
      ':nolfshim',
      "echo git: 'lfs' is not a git command. See 'git --help'. 1>&2",
      'exit /b 1',
      '',
    ].join('\r\n');
    await writeFile(path.join(shimDir, 'git.cmd'), shim, 'utf8');
  } else {
    const whichResult = await execa('which', ['git'], { reject: false });
    const realGit = whichResult.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '');
    if (realGit === undefined) {
      throw new Error('找不到 git，无法构造 git-lfs 未安装的 mock');
    }
    const shimPath = path.join(shimDir, 'git');
    const shim = [
      '#!/bin/sh',
      'if [ "$1" = "lfs" ]; then',
      '  echo "git: \'lfs\' is not a git command." >&2',
      '  exit 1',
      'fi',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n');
    await writeFile(shimPath, shim, 'utf8');
    await chmod(shimPath, 0o755);
  }
  return shimDir;
}

/** 在"git 可用但 git-lfs 不可用"的 PATH 下执行 fn（垫片目录前置到 PATH） */
async function withGitLfsMissing<T>(fn: () => Promise<T>): Promise<T> {
  const shimDir = await makeGitLfsShim();
  const original = process.env.PATH;
  return withMockedPath(`${shimDir}${path.delimiter}${original ?? ''}`, fn);
}

/** 结果里 gitIssues 的 code 序列 */
function gitCodes(result: VcsVerifyResult): string[] {
  return result.gitIssues.map((issue) => issue.code);
}

/** 结果里 deckVerify.issues 的 code 序列 */
function deckCodes(result: VcsVerifyResult): string[] {
  return result.deckVerify.issues.map((issue) => issue.code);
}

// ---------------------------------------------------------------------------
// 基础行为与透传
// ---------------------------------------------------------------------------

describe('vcsVerify：基础行为', () => {
  it('非 git 仓库 + 干净工作区：ok=true、gitIssues=[]、0 错 0 警、deckVerify 原样返回', async () => {
    await makeCleanPack();
    const result = await vcsVerify({ packRoot: tempRoot });
    expect(result.gitIssues).toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.deckVerify.ok).toBe(true);
    expect(result.deckVerify.issues).toEqual([]);
  });

  it('非 git 仓库 + 空工作区（缺 objects.csv）：deck error 使 ok=false，gitIssues 仍为空', async () => {
    // 什么都不放：decks / skeleton 缺席跳过，objects.csv 缺失 → error
    const result = await vcsVerify({ packRoot: tempRoot });
    expect(result.gitIssues).toEqual([]);
    expect(deckCodes(result)).toEqual(['OBJECTS_NOT_FOUND']);
    expect(result.errorCount).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('deckVerify 字段与直接调用 verifyPack 的结果一致（git 噪音不污染 deck 结果）', async () => {
    await makeCleanPack();
    await initRepo();
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'untracked.txt'), '工作区噪音', 'utf8');

    const result = await vcsVerify({ packRoot: tempRoot });
    const direct = await verifyPack({ packRoot: tempRoot });
    expect(result.deckVerify).toEqual(direct);
    expect(gitCodes(result)).toEqual(['VCS_UNCOMMITTED']);
  });

  it('deck error + git warning：errorCount / warningCount 分别合并，ok=false', async () => {
    await initRepo();
    await commitFile('README.md', 'readme', 'init');
    await writeFile(path.join(tempRoot, 'draft.txt'), '未提交', 'utf8');

    const result = await vcsVerify({ packRoot: tempRoot });
    expect(deckCodes(result)).toEqual(['OBJECTS_NOT_FOUND']); // deck error ×1
    expect(gitCodes(result)).toEqual(['VCS_UNCOMMITTED']); // git warning ×1
    expect(result.errorCount).toBe(1);
    expect(result.warningCount).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('packRoot 非法（空字符串）：拒绝执行，抛普通 Error（编程错误，非 PackError）', async () => {
    await expect(vcsVerify({ packRoot: '' })).rejects.toThrow('packRoot');
  });

  it('非 git 仓库 + pack.yaml 损坏：git 检查跳过先于清单解析，不抛 PACK_INVALID', async () => {
    await makeCleanPack();
    await corruptPackYaml();
    const result = await vcsVerify({ packRoot: tempRoot });
    expect(result.gitIssues).toEqual([]); // 非 git 仓库 → lfs 检查整体跳过
    expect(result.ok).toBe(true); // deck 校验面无 issue
  });
});

// ---------------------------------------------------------------------------
// git 状态检查
// ---------------------------------------------------------------------------

describe('git 状态检查（checkGit 默认开启）', () => {
  it('干净仓库（全部已提交）：gitIssues=[]、0 错 0 警、ok=true', async () => {
    await makeCleanPack();
    await initRepo();
    await commitAll('init');
    const result = await vcsVerify({ packRoot: tempRoot });
    expect(result.gitIssues).toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.ok).toBe(true);
  });

  it('已跟踪文件被修改未提交：VCS_UNCOMMITTED warning，ok 仍 true', async () => {
    await makeCleanPack();
    await initRepo();
    await commitAll('init');
    // 重写 pack.yaml（name 不同 → 字节级差异）→ git status 出现工作区改动
    await writePackYaml(tempRoot, {
      schema_version: 1,
      name: '改名后的图包',
      workshop_id: null,
      source_mod: null,
      vcs: { lfs: 'disabled' },
      paths: { workdir: '.' },
      upload: { prefix: '' },
    });
    const result = await vcsVerify({ packRoot: tempRoot });

    expect(gitCodes(result)).toEqual(['VCS_UNCOMMITTED']);
    expect(result.gitIssues[0]?.severity).toBe('warning');
    expect(result.gitIssues[0]?.message).toContain('未提交改动');
    expect(result.errorCount).toBe(0);
    expect(result.ok).toBe(true); // warning 不阻塞通过
  });

  it('未跟踪新文件：VCS_UNCOMMITTED warning', async () => {
    await makeCleanPack();
    await initRepo();
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'new.txt'), '未跟踪', 'utf8');
    const result = await vcsVerify({ packRoot: tempRoot });
    expect(gitCodes(result)).toEqual(['VCS_UNCOMMITTED']);
  });

  it('仅暂存未提交（git add 后不 commit）：VCS_UNCOMMITTED warning', async () => {
    await makeCleanPack();
    await initRepo();
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'staged.txt'), '已暂存', 'utf8');
    await git(['add', 'staged.txt']);
    const result = await vcsVerify({ packRoot: tempRoot });
    expect(gitCodes(result)).toEqual(['VCS_UNCOMMITTED']);
  });

  it('UU 冲突（双方修改）：VCS_UNRESOLVED_CONFLICT error + VCS_UNCOMMITTED warning（warning 在前），ok=false', async () => {
    await makeCleanPack();
    await initRepo();
    await commitAll('init');
    await makeConflict('UU');
    const result = await vcsVerify({ packRoot: tempRoot });

    // 冲突态的 status 必然非空 → 未提交改动（warning）与未解决冲突（error）同时成立
    expect(gitCodes(result)).toEqual(['VCS_UNCOMMITTED', 'VCS_UNRESOLVED_CONFLICT']);
    expect(result.gitIssues[0]?.severity).toBe('warning');
    expect(result.gitIssues[1]?.severity).toBe('error');
    expect(result.gitIssues[1]?.message).toContain('合并冲突');
    expect(result.errorCount).toBe(1);
    expect(result.warningCount).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('AA 冲突（双方新增同一路径）：VCS_UNRESOLVED_CONFLICT error', async () => {
    await makeCleanPack();
    await initRepo();
    await commitAll('init');
    await makeConflict('AA');
    const result = await vcsVerify({ packRoot: tempRoot });
    expect(gitCodes(result)).toContain('VCS_UNRESOLVED_CONFLICT');
    const conflict = result.gitIssues.find((issue) => issue.code === 'VCS_UNRESOLVED_CONFLICT');
    expect(conflict?.severity).toBe('error');
    expect(result.ok).toBe(false);
  });

  it('UD/DU 冲突（一方修改一方删除）：VCS_UNRESOLVED_CONFLICT error（超集判定）', async () => {
    await makeCleanPack();
    await initRepo();
    await commitAll('init');
    await makeConflict('UD');
    const result = await vcsVerify({ packRoot: tempRoot });
    expect(gitCodes(result)).toContain('VCS_UNRESOLVED_CONFLICT');
    expect(result.errorCount).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('git 不在 PATH（mock PATH）：git 检查整体跳过，deck 结果照常返回', async () => {
    await makeCleanPack();
    await initRepo();
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'untracked.txt'), '改动', 'utf8');

    // PATH 指向无任何可执行文件的目录 → GIT_NOT_FOUND → 跳过 git 检查（不抛错）
    const result = await withMockedPath(tempRoot, () => vcsVerify({ packRoot: tempRoot }));
    expect(result.gitIssues).toEqual([]);
    expect(result.deckVerify.ok).toBe(true);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lfs 三方一致性检查
// ---------------------------------------------------------------------------

describe('lfs 三方一致性检查', () => {
  it('.gitattributes 有 lfs 规则 + git-lfs 不可用（shim 拦截 lfs）：VCS_LFS_MISSING error', async () => {
    await makeCleanPack('enabled');
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES.join('\n')}\n`);
    await initRepo();
    await commitAll('init');

    const result = await withGitLfsMissing(() => vcsVerify({ packRoot: tempRoot }));
    expect(gitCodes(result)).toEqual(['VCS_LFS_MISSING']);
    expect(result.gitIssues[0]?.severity).toBe('error');
    expect(result.gitIssues[0]?.message).toContain('未装 git-lfs');
    expect(result.errorCount).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('.gitattributes 有 lfs 规则 + 真实 git-lfs 已安装：无 VCS_LFS_MISSING', async () => {
    await makeCleanPack('enabled');
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES.join('\n')}\n`);
    await initRepo();
    await commitAll('init');

    const result = await vcsVerify({ packRoot: tempRoot });
    expect(gitCodes(result)).not.toContain('VCS_LFS_MISSING');
    expect(result.gitIssues).toEqual([]); // lfs 三方全一致且工作区干净
  });

  it('vcs.lfs=enabled 但 .gitattributes 缺规则：VCS_LFS_INCONSISTENT error，ok=false', async () => {
    await makeCleanPack('enabled'); // 无 .gitattributes
    await initRepo();
    await commitAll('init');

    const result = await vcsVerify({ packRoot: tempRoot });
    expect(gitCodes(result)).toEqual(['VCS_LFS_INCONSISTENT']);
    expect(result.gitIssues[0]?.severity).toBe('error');
    expect(result.gitIssues[0]?.message).toContain('缺规则');
    expect(result.ok).toBe(false);
  });

  it('vcs.lfs=disabled 但 .gitattributes 含规则：VCS_LFS_INCONSISTENT warning，ok=true', async () => {
    await makeCleanPack('disabled');
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES.join('\n')}\n`);
    await initRepo();
    await commitAll('init');

    const result = await vcsVerify({ packRoot: tempRoot });
    expect(gitCodes(result)).toEqual(['VCS_LFS_INCONSISTENT']);
    expect(result.gitIssues[0]?.severity).toBe('warning');
    expect(result.gitIssues[0]?.message).toContain('仍含规则');
    expect(result.errorCount).toBe(0);
    expect(result.ok).toBe(true); // warning 不阻塞通过
  });

  it('vcs.lfs=disabled-no-lfs 且含规则：不算不一致（规格只查 disabled）', async () => {
    await makeCleanPack('disabled-no-lfs');
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES.join('\n')}\n`);
    await initRepo();
    await commitAll('init');

    const result = await vcsVerify({ packRoot: tempRoot });
    expect(result.gitIssues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('lfs 三方全一致（enabled + 规则齐全 + 已安装）：gitIssues=[]', async () => {
    await makeCleanPack('enabled');
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES.join('\n')}\n`);
    await initRepo();
    await commitAll('init');

    const result = await vcsVerify({ packRoot: tempRoot });
    expect(result.gitIssues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('多项 git issue 叠加：顺序 [VCS_UNCOMMITTED, VCS_LFS_MISSING, VCS_LFS_INCONSISTENT]', async () => {
    // disabled + 含规则 + 未装 lfs + 有未提交改动 → 1 error + 2 warning 全部成立
    await makeCleanPack('disabled');
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES.join('\n')}\n`);
    await initRepo();
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'untracked.txt'), '未提交', 'utf8');

    const result = await withGitLfsMissing(() => vcsVerify({ packRoot: tempRoot }));
    expect(gitCodes(result)).toEqual(['VCS_UNCOMMITTED', 'VCS_LFS_MISSING', 'VCS_LFS_INCONSISTENT']);
    expect(result.gitIssues.map((issue) => issue.severity)).toEqual(['warning', 'error', 'warning']);
    expect(result.errorCount).toBe(1);
    expect(result.warningCount).toBe(2);
    expect(result.ok).toBe(false);
  });

  it('两条 error 叠加：UU 冲突 + 未装 lfs（含规则）→ errorCount=2', async () => {
    await makeCleanPack('enabled');
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES.join('\n')}\n`);
    await initRepo();
    await commitAll('init');
    await makeConflict('UU');

    const result = await withGitLfsMissing(() => vcsVerify({ packRoot: tempRoot }));
    expect(gitCodes(result)).toEqual(['VCS_UNCOMMITTED', 'VCS_UNRESOLVED_CONFLICT', 'VCS_LFS_MISSING']);
    expect(result.errorCount).toBe(2); // 冲突 + LFS 缺失
    expect(result.warningCount).toBe(1); // 未提交改动
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 选项开关
// ---------------------------------------------------------------------------

describe('选项开关', () => {
  it('checkGit=false：仓库有未提交改动 + lfs 不一致也全部跳过（对照开着的情形）', async () => {
    await makeCleanPack('enabled'); // enabled 且无 .gitattributes → lfs 不一致
    await initRepo();
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'untracked.txt'), '未提交', 'utf8');

    const skipped = await vcsVerify({ packRoot: tempRoot, checkGit: false });
    expect(skipped.gitIssues).toEqual([]);
    expect(skipped.errorCount).toBe(0);
    expect(skipped.ok).toBe(true);

    // 对照：同一工作区不关 checkGit 时两项 git issue 都在
    const withGit = await vcsVerify({ packRoot: tempRoot });
    expect(gitCodes(withGit)).toContain('VCS_UNCOMMITTED');
    expect(gitCodes(withGit)).toContain('VCS_LFS_INCONSISTENT');
  });

  it('checkCmyk 默认 true：CMYK 卡图 → CARD_CMYK error', async () => {
    await makeFullDeck({ cmykCard: true });
    const result = await vcsVerify({ packRoot: tempRoot });
    expect(deckCodes(result)).toContain('CARD_CMYK');
    expect(result.deckVerify.errorCount).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('checkCmyk=false：CMYK 卡图不报（透传 verifyPack）', async () => {
    await makeFullDeck({ cmykCard: true });
    const result = await vcsVerify({ packRoot: tempRoot, checkCmyk: false });
    expect(deckCodes(result)).not.toContain('CARD_CMYK');
    expect(result.deckVerify.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('checkAtlasSize 默认 true：假尺寸图集（100x100 冒充 2x3）→ ATLAS_GRID_MISMATCH error', async () => {
    await makeFullDeck({ badAtlasSize: true });
    const result = await vcsVerify({ packRoot: tempRoot });
    expect(deckCodes(result)).toContain('ATLAS_GRID_MISMATCH');
    expect(result.ok).toBe(false);
  });

  it('checkAtlasSize=false：不读图集尺寸，存在性检查照跑（无 SHEET_SOURCE_MISSING）', async () => {
    await makeFullDeck({ badAtlasSize: true });
    const result = await vcsVerify({ packRoot: tempRoot, checkAtlasSize: false });
    expect(deckCodes(result)).not.toContain('ATLAS_GRID_MISMATCH');
    expect(deckCodes(result)).not.toContain('SHEET_SOURCE_MISSING'); // 存在性检查仍在
    expect(result.deckVerify.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('git 仓库 + pack.yaml 损坏：透传 PACK_INVALID（不静默当作未声明）', async () => {
    await makeCleanPack();
    await initRepo();
    await commitAll('init');
    await corruptPackYaml();
    await expectPackError(() => vcsVerify({ packRoot: tempRoot }), 'PACK_INVALID');
  });
});
