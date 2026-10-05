// tests/unit/safety-backup.test.ts
/**
 * src/safety/backup.ts 单元测试：push 前自动备份（快照 / 清单 / 清理 / 恢复）。
 *
 * 纯文件 IO（os.tmpdir() 下的临时目录，mkdtemp + rm -rf），无网络、无 TTS：
 * createBackup 只吃调用方给好的 scriptStates（真实来源是 SessionScripts.getScripts()，
 * 由集成测试覆盖），本文件不连 39998 / 39999。
 *
 * 覆盖：
 * - createBackup：基本流（多对象多脚本多 UI，manifest 字段与落盘文件名全对齐）/
 *   只有 script / 只有 ui / 空 scriptStates / 中文名净化 / baseline.json 的 sha256 /
 *   reason 透传 / retention 自动清理 / 缺 pack.yaml → PACK_NOT_FOUND /
 *   guid 非法 → BACKUP_WRITE_FAILED / .tts/backups 被文件占用 → BACKUP_DIR_INVALID；
 * - listBackups：目录不存在 / 空目录 / 按 createdAt 倒序 / 损坏与缺失 manifest 跳过 /
 *   散文件忽略 / 未知额外字段向前兼容 / 备份根被文件占用 → BACKUP_DIR_INVALID；
 * - pruneBackups：retention<=0 不清理 / 超额删除并返回份数 / retention 富余全保留 /
 *   目录不存在返回 0 / 损坏 manifest 的目录不计数也不删；
 * - restoreBackup：完整还原（覆盖 + 多余文件保留）/ 不碰 pack.yaml、baseline.json、
 *   skeleton.json / timestamp 不存在 → BACKUP_TIMESTAMP_NOT_FOUND / 路径穿越与空串
 *   → BACKUP_DIR_INVALID / manifest 缺失或损坏 → BACKUP_MANIFEST_INVALID /
 *   缺 ui 子目录、工作区目录缺失、与 createBackup/listBackups 组合恢复最新一份。
 *
 * ⚠️ 时间戳夹具：每个用例开头一次性算好常量（pastTimestamp 是相对 Date.now() 的
 * 相对时间，同一个"秒数"调两次会差毫秒），种子与断言必须复用同一批常量——
 * 绝不在断言里重新调用 pastTimestamp。
 *
 * 错误按 PackError.code（机器可读）断言，不断言 message（i18n 文案会变）。
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBackup, listBackups, pruneBackups, restoreBackup } from '../../src/safety/backup.js';
import type { ScriptState } from '../../src/session/scripts.js';
import { PackError, writePackYaml } from '../../src/pack/packyaml.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-safety-backup-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** makePackRoot 写入的图包名（manifest.packName 断言用） */
const PACK_NAME = '备份测试图包';

/**
 * 建一个带合法 pack.yaml 的工作区根目录（不建 scripts/ ui/，按用例自行落文件）。
 * @returns 工作区根目录
 */
async function makePackRoot(): Promise<string> {
  const root = path.join(tempRoot, 'pack');
  await writePackYaml(root, {
    schema_version: 1,
    name: PACK_NAME,
    workshop_id: null,
    source_mod: null,
    host: 'steamcloud',
    vcs: { lfs: 'disabled-no-lfs' },
    paths: { workdir: '.' },
    upload: { prefix: '' },
  });
  return root;
}

/** 构造一个 ScriptState（script / ui 按需给，缺省不带字段） */
function state(guid: string, name: string, fields: { script?: string; ui?: string } = {}): ScriptState {
  return { guid, name, ...fields };
}

/**
 * 生成一个"过去"的备份目录名（比当前时刻早 secondsAgo 秒），格式与 createBackup 一致。
 * ⚠️ 相对时间：同一秒数调用两次结果差毫秒——每用例只在开头算一次并复用常量。
 */
function pastTimestamp(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/:/g, '-');
}

/** 手工造备份的选项 */
interface SeedOptions {
  /** scripts/ 子目录的文件（文件名 → 内容）；缺省无 */
  scripts?: Record<string, string>;
  /** ui/ 子目录的文件（文件名 → 内容）；缺省无 */
  ui?: Record<string, string>;
  /** 不创建 ui/ 子目录（模拟只有脚本的备份） */
  omitUi?: boolean;
  /** manifest 覆盖字段（createdAt 默认取目录名；传额外字段可测向前兼容） */
  manifestOverrides?: Record<string, unknown>;
  /** 直接给定 manifest.json 原文（造非法 JSON / 缺字段等）；给了就忽略 manifestOverrides */
  rawManifest?: string;
  /** 完全不写 manifest.json */
  omitManifest?: boolean;
}

/**
 * 手工 seed 一份备份（绕过 createBackup，用于测 listBackups / prune / restore）。
 * @param root 工作区根目录
 * @param timestamp 备份目录名（同时写入 manifest.createdAt）
 * @param opts 备份内容选项
 * @returns 备份目录完整路径
 */
async function seedBackup(root: string, timestamp: string, opts: SeedOptions = {}): Promise<string> {
  const dir = path.join(root, '.tts', 'backups', timestamp);
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  if (!opts.omitUi) {
    await mkdir(path.join(dir, 'ui'), { recursive: true });
  }
  for (const [name, content] of Object.entries(opts.scripts ?? {})) {
    await writeFile(path.join(dir, 'scripts', name), content, 'utf8');
  }
  for (const [name, content] of Object.entries(opts.ui ?? {})) {
    await writeFile(path.join(dir, 'ui', name), content, 'utf8');
  }
  if (!opts.omitManifest) {
    const manifest: Record<string, unknown> = {
      createdAt: timestamp,
      reason: 'push',
      packRoot: root,
      packName: PACK_NAME,
      scriptsCount: Object.keys(opts.scripts ?? {}).length,
      uiCount: Object.keys(opts.ui ?? {}).length,
      ...opts.manifestOverrides,
    };
    const raw = opts.rawManifest ?? `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(path.join(dir, 'manifest.json'), raw, 'utf8');
  }
  return dir;
}

/**
 * 列出 `<root>/.tts/backups` 下的条目名（排序后），目录不存在返回 []。
 * @param root 工作区根目录
 * @returns 排序后的条目名列表
 */
async function backupDirNames(root: string): Promise<string[]> {
  try {
    return (await readdir(path.join(root, '.tts', 'backups'))).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// createBackup
// ---------------------------------------------------------------------------

describe('createBackup（创建备份）', () => {
  it('基本流：多对象多脚本多 UI，manifest 字段与落盘文件名全部对齐', async () => {
    const root = await makePackRoot();
    const states = [
      state('-1', 'Global', { script: '--global lua', ui: '<Panel id="g" />' }),
      state('abc111', 'Chess Pawn', { script: '--pawn', ui: '<Panel id="pawn" />' }),
      state('abc222', '棋盘 游戏:V2', { script: '--board' }),
    ];

    const { dir, manifest } = await createBackup({ root, scriptStates: states });

    // manifest 字段：时间戳格式（冒号已替换、保留毫秒）、reason 缺省 push、packRoot 绝对路径
    expect(manifest.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
    expect(manifest.reason).toBe('push');
    expect(manifest.packRoot).toBe(path.resolve(root));
    expect(manifest.packName).toBe(PACK_NAME);
    expect(manifest.scriptsCount).toBe(3);
    expect(manifest.uiCount).toBe(2);
    expect(manifest.baselineHash).toBeUndefined();

    // dir = .tts/backups/<createdAt>，目录真实存在
    expect(dir).toBe(path.join(root, '.tts', 'backups', manifest.createdAt));
    await expect(stat(dir)).resolves.toBeTruthy();

    // 落盘文件名与 layout 命名一致（Global 固定名；中文名净化：空格→_、冒号删除）
    expect(await readFile(path.join(dir, 'scripts', 'Global.lua'), 'utf8')).toBe('--global lua');
    expect(await readFile(path.join(dir, 'ui', 'Global.xml'), 'utf8')).toBe('<Panel id="g" />');
    expect(await readFile(path.join(dir, 'scripts', 'abc111.Chess_Pawn.lua'), 'utf8')).toBe('--pawn');
    expect(await readFile(path.join(dir, 'ui', 'abc111.Chess_Pawn.xml'), 'utf8')).toBe('<Panel id="pawn" />');
    expect(await readFile(path.join(dir, 'scripts', 'abc222.棋盘_游戏V2.lua'), 'utf8')).toBe('--board');

    // manifest.json：可解析且与返回值一致，2 空格缩进 + 末尾换行
    const raw = await readFile(path.join(dir, 'manifest.json'), 'utf8');
    expect(raw.startsWith('{\n  "createdAt"')).toBe(true);
    expect(raw.endsWith('}\n')).toBe(true);
    expect(JSON.parse(raw)).toMatchObject({ createdAt: manifest.createdAt, scriptsCount: 3, uiCount: 2 });
  }, 30_000);

  it('reason: "manual" 透传进 manifest；retention 缺省（20）不误删少量旧备份', async () => {
    const root = await makePackRoot();
    const tsOld = pastTimestamp(30);
    await seedBackup(root, tsOld);

    const { manifest } = await createBackup({ root, reason: 'manual', scriptStates: [] });

    expect(manifest.reason).toBe('manual');
    expect(await backupDirNames(root)).toHaveLength(2); // 旧 1 份 + 新 1 份，全保留
  }, 30_000);

  it('只有 script 没有 ui：脚本落盘、ui 目录存在但为空、uiCount=0', async () => {
    const root = await makePackRoot();

    const { dir, manifest } = await createBackup({
      root,
      scriptStates: [state('abc111', 'Pawn', { script: '--x' })],
    });

    expect(manifest.scriptsCount).toBe(1);
    expect(manifest.uiCount).toBe(0);
    expect(await readFile(path.join(dir, 'scripts', 'abc111.Pawn.lua'), 'utf8')).toBe('--x');
    expect(await readdir(path.join(dir, 'ui'))).toEqual([]);
  }, 30_000);

  it('只有 ui 没有 script：UI 落盘、scripts 目录存在但为空、scriptsCount=0', async () => {
    const root = await makePackRoot();

    const { dir, manifest } = await createBackup({
      root,
      scriptStates: [state('abc111', 'Pawn', { ui: '<Panel />' })],
    });

    expect(manifest.scriptsCount).toBe(0);
    expect(manifest.uiCount).toBe(1);
    expect(await readdir(path.join(dir, 'scripts'))).toEqual([]);
    expect(await readFile(path.join(dir, 'ui', 'abc111.Pawn.xml'), 'utf8')).toBe('<Panel />');
  }, 30_000);

  it('空 scriptStates：scripts/ui 目录都创建、计数 0、manifest 无 baselineHash 键', async () => {
    const root = await makePackRoot();

    const { dir, manifest } = await createBackup({ root, scriptStates: [] });

    expect(manifest.scriptsCount).toBe(0);
    expect(manifest.uiCount).toBe(0);
    expect(await readdir(path.join(dir, 'scripts'))).toEqual([]);
    expect(await readdir(path.join(dir, 'ui'))).toEqual([]);
    const parsed = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect('baselineHash' in parsed).toBe(false); // JSON.stringify 丢掉 undefined 字段
  }, 30_000);

  it('中文名与 Windows 非法字符净化：与 layout.scriptFileName 的落盘命名一致', async () => {
    const root = await makePackRoot();

    const { dir } = await createBackup({
      root,
      scriptStates: [state('abc333', '扑克 牌堆:V2?', { script: '--deck' })],
    });

    // 空格→_，冒号与问号删除，与 sanitizeName 规则一致
    expect(await readFile(path.join(dir, 'scripts', 'abc333.扑克_牌堆V2.lua'), 'utf8')).toBe('--deck');
  }, 30_000);

  it('baseline.json 存在时记入其 sha256；不存在时缺省', async () => {
    const root = await makePackRoot();
    await mkdir(path.join(root, '.tts'), { recursive: true });
    await writeFile(path.join(root, '.tts', 'baseline.json'), '{"snapshot":1}', 'utf8');

    const withBaseline = await createBackup({ root, scriptStates: [] });
    const expected = createHash('sha256')
      .update(await readFile(path.join(root, '.tts', 'baseline.json')))
      .digest('hex');
    expect(withBaseline.manifest.baselineHash).toBe(expected);

    // 删掉 baseline 再备一份：新 manifest 不含 baselineHash
    await rm(path.join(root, '.tts', 'baseline.json'));
    const withoutBaseline = await createBackup({ root, scriptStates: [] });
    expect(withoutBaseline.manifest.baselineHash).toBeUndefined();
  }, 30_000);

  it('缺 pack.yaml → PackError code="PACK_NOT_FOUND"', async () => {
    const missing = path.join(tempRoot, 'not-a-pack');

    await expect(createBackup({ root: missing, scriptStates: [] })).rejects.toMatchObject({
      code: 'PACK_NOT_FOUND',
    });
  });

  it('retention=5：7 份旧备份 + 本次新备份 → 保留最新 5 份、最旧 3 份被清', async () => {
    const root = await makePackRoot();
    const [ts70, ts60, ts50, ts40, ts30, ts20, ts10] = [70, 60, 50, 40, 30, 20, 10].map(pastTimestamp);
    for (const ts of [ts70, ts60, ts50, ts40, ts30, ts20, ts10]) {
      await seedBackup(root, ts);
    }

    const { manifest } = await createBackup({ root, retention: 5, scriptStates: [] });

    const names = await backupDirNames(root);
    expect(names).toHaveLength(5);
    expect(names).toContain(manifest.createdAt); // 本次备份最新，必被保留
    expect(names).not.toContain(ts70);
    expect(names).not.toContain(ts60);
    expect(names).not.toContain(ts50);
    expect(names).toContain(ts10);
  }, 30_000);

  it('retention=0：不清理旧备份', async () => {
    const root = await makePackRoot();
    const [ts30, ts20, ts10] = [30, 20, 10].map(pastTimestamp);
    for (const ts of [ts30, ts20, ts10]) {
      await seedBackup(root, ts);
    }

    await createBackup({ root, retention: 0, scriptStates: [] });

    expect(await backupDirNames(root)).toHaveLength(4); // 旧 3 份 + 新 1 份
  }, 30_000);

  it('guid 非法（空串）→ PackError code="BACKUP_WRITE_FAILED"', async () => {
    const root = await makePackRoot();

    await expect(
      createBackup({ root, scriptStates: [state('', 'Pawn', { script: '--x' })] }),
    ).rejects.toMatchObject({ code: 'BACKUP_WRITE_FAILED' });
  }, 30_000);

  it('.tts/backups 被同名文件占用 → PackError code="BACKUP_DIR_INVALID"', async () => {
    const root = await makePackRoot();
    await mkdir(path.join(root, '.tts'), { recursive: true });
    await writeFile(path.join(root, '.tts', 'backups'), 'not a dir', 'utf8');

    await expect(createBackup({ root, scriptStates: [] })).rejects.toMatchObject({
      code: 'BACKUP_DIR_INVALID',
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// listBackups
// ---------------------------------------------------------------------------

describe('listBackups（列出备份）', () => {
  it('无 .tts/backups 目录 → 空数组，不报错', async () => {
    const root = await makePackRoot();
    await expect(listBackups(root)).resolves.toEqual([]);
  }, 30_000);

  it('.tts/backups 空目录 → 空数组', async () => {
    const root = await makePackRoot();
    await mkdir(path.join(root, '.tts', 'backups'), { recursive: true });
    await expect(listBackups(root)).resolves.toEqual([]);
  }, 30_000);

  it('多份备份按 createdAt 倒序（新 → 旧）', async () => {
    const root = await makePackRoot();
    const [ts30, ts20, ts10] = [30, 20, 10].map(pastTimestamp);
    await seedBackup(root, ts30);
    await seedBackup(root, ts10);
    await seedBackup(root, ts20);

    const manifests = await listBackups(root);

    expect(manifests.map((m) => m.createdAt)).toEqual([ts10, ts20, ts30]);
    // 字段完整性
    expect(manifests[0]).toMatchObject({ reason: 'push', packRoot: path.resolve(root), packName: PACK_NAME });
  }, 30_000);

  it('非法 JSON 的 manifest 跳过（其余照常列出）', async () => {
    const root = await makePackRoot();
    const [ts20, ts10] = [20, 10].map(pastTimestamp);
    await seedBackup(root, ts20);
    await seedBackup(root, ts10, { rawManifest: '{not json' });

    const manifests = await listBackups(root);

    expect(manifests.map((m) => m.createdAt)).toEqual([ts20]);
  }, 30_000);

  it('缺 manifest.json 的目录跳过；manifest 缺必填字段的目录也跳过', async () => {
    const root = await makePackRoot();
    const [ts30, ts20, ts10] = [30, 20, 10].map(pastTimestamp);
    await seedBackup(root, ts30, { omitManifest: true }); // 没 manifest
    await seedBackup(root, ts20, {
      // 缺 packName / uiCount
      rawManifest: JSON.stringify({ createdAt: ts20, reason: 'push', packRoot: root, scriptsCount: 0 }),
    });
    await seedBackup(root, ts10); // 唯一合法的

    const manifests = await listBackups(root);

    expect(manifests.map((m) => m.createdAt)).toEqual([ts10]);
  }, 30_000);

  it('.tts/backups 是文件 → PackError code="BACKUP_DIR_INVALID"', async () => {
    const root = await makePackRoot();
    await mkdir(path.join(root, '.tts'), { recursive: true });
    await writeFile(path.join(root, '.tts', 'backups'), 'not a dir', 'utf8');

    await expect(listBackups(root)).rejects.toMatchObject({ code: 'BACKUP_DIR_INVALID' });
  }, 30_000);

  it('backups 下的散文件忽略；含未知额外字段的合法 manifest 照常列出（向前兼容）', async () => {
    const root = await makePackRoot();
    const ts10 = pastTimestamp(10);
    await mkdir(path.join(root, '.tts', 'backups'), { recursive: true });
    await writeFile(path.join(root, '.tts', 'backups', 'readme.txt'), 'stray', 'utf8');
    await seedBackup(root, ts10, { manifestOverrides: { note: '额外字段' } });

    const manifests = await listBackups(root);

    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.createdAt).toBe(ts10);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// pruneBackups
// ---------------------------------------------------------------------------

describe('pruneBackups（清理备份）', () => {
  it('retention=0：不清理，返回 0，全部保留', async () => {
    const root = await makePackRoot();
    const seeds = [30, 20, 10].map(pastTimestamp);
    for (const ts of seeds) {
      await seedBackup(root, ts);
    }

    await expect(pruneBackups(root, 0)).resolves.toBe(0);
    await expect(backupDirNames(root)).resolves.toHaveLength(3);
  }, 30_000);

  it('retention 为负 / NaN：不清理，返回 0', async () => {
    const root = await makePackRoot();
    const ts10 = pastTimestamp(10);
    await seedBackup(root, ts10);

    await expect(pruneBackups(root, -3)).resolves.toBe(0);
    await expect(pruneBackups(root, Number.NaN)).resolves.toBe(0);
    await expect(backupDirNames(root)).resolves.toHaveLength(1);
  }, 30_000);

  it('5 份 retention=3：删 2 份并返回 2，剩最新 3 份，目录真实消失', async () => {
    const root = await makePackRoot();
    const [ts50, ts40, ts30, ts20, ts10] = [50, 40, 30, 20, 10].map(pastTimestamp);
    for (const ts of [ts50, ts40, ts30, ts20, ts10]) {
      await seedBackup(root, ts);
    }

    await expect(pruneBackups(root, 3)).resolves.toBe(2);

    const names = await backupDirNames(root);
    // backupDirNames 按字典序排序（定长 ISO 变体：字典序 = 时间正序，旧 → 新）
    expect(names).toEqual([ts30, ts20, ts10]);
    await expect(stat(path.join(root, '.tts', 'backups', ts40))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(root, '.tts', 'backups', ts50))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('retention 大于份数：返回 0，全保留', async () => {
    const root = await makePackRoot();
    const [ts20, ts10] = [20, 10].map(pastTimestamp);
    await seedBackup(root, ts20);
    await seedBackup(root, ts10);

    await expect(pruneBackups(root, 99)).resolves.toBe(0);
    await expect(backupDirNames(root)).resolves.toHaveLength(2);
  }, 30_000);

  it('无 backups 目录：返回 0，不报错', async () => {
    const root = await makePackRoot();
    await expect(pruneBackups(root, 3)).resolves.toBe(0);
  }, 30_000);

  it('损坏 manifest 的目录不计数也不删除（宁多留、不误删）', async () => {
    const root = await makePackRoot();
    const [ts30, tsBroken, ts10] = [30, 20, 10].map(pastTimestamp);
    await seedBackup(root, ts30);
    await seedBackup(root, tsBroken, { rawManifest: 'broken' }); // 无法识别
    await seedBackup(root, ts10);

    await expect(pruneBackups(root, 1)).resolves.toBe(1); // 只删能识别的最旧一份

    const names = await backupDirNames(root);
    expect(names).toHaveLength(2); // 损坏目录留下，不参与计数
    expect(names).toContain(tsBroken);
    expect(names).not.toContain(ts30);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// restoreBackup
// ---------------------------------------------------------------------------

describe('restoreBackup（恢复到工作区）', () => {
  it('完整还原：备份内容覆盖工作区同名文件，工作区多余文件保留', async () => {
    const root = await makePackRoot();
    const ts = pastTimestamp(10);
    await seedBackup(root, ts, {
      scripts: { 'Global.lua': '--backup-global', 'abc111.Chess_Pawn.lua': '--backup-pawn' },
      ui: { 'Global.xml': '<Panel>backup</Panel>' },
    });
    // 工作区预置旧内容 + 备份里没有的多余文件
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, 'ui'), { recursive: true });
    await writeFile(path.join(root, 'scripts', 'Global.lua'), '--workspace-old', 'utf8');
    await writeFile(path.join(root, 'scripts', 'extra.lua'), '--extra', 'utf8');
    await writeFile(path.join(root, 'ui', 'Global.xml'), '<Panel>old</Panel>', 'utf8');

    await expect(restoreBackup(root, ts)).resolves.toBeUndefined();

    expect(await readFile(path.join(root, 'scripts', 'Global.lua'), 'utf8')).toBe('--backup-global');
    expect(await readFile(path.join(root, 'scripts', 'abc111.Chess_Pawn.lua'), 'utf8')).toBe('--backup-pawn');
    expect(await readFile(path.join(root, 'ui', 'Global.xml'), 'utf8')).toBe('<Panel>backup</Panel>');
    expect(await readFile(path.join(root, 'scripts', 'extra.lua'), 'utf8')).toBe('--extra'); // 不删多余
  }, 30_000);

  it('还原不碰 pack.yaml / baseline.json / skeleton.json，也不 push', async () => {
    const root = await makePackRoot();
    const ts = pastTimestamp(10);
    await seedBackup(root, ts, { scripts: { 'Global.lua': '--b' } });
    await mkdir(path.join(root, '.tts'), { recursive: true });
    await writeFile(path.join(root, '.tts', 'baseline.json'), '{"keep":true}', 'utf8');
    await writeFile(path.join(root, '.tts', 'skeleton.json'), '{"keep":2}', 'utf8');
    const packBefore = await readFile(path.join(root, 'pack.yaml'), 'utf8');

    await restoreBackup(root, ts);

    expect(await readFile(path.join(root, '.tts', 'baseline.json'), 'utf8')).toBe('{"keep":true}');
    expect(await readFile(path.join(root, '.tts', 'skeleton.json'), 'utf8')).toBe('{"keep":2}');
    expect(await readFile(path.join(root, 'pack.yaml'), 'utf8')).toBe(packBefore);
  }, 30_000);

  it('timestamp 不存在 → PackError code="BACKUP_TIMESTAMP_NOT_FOUND"', async () => {
    const root = await makePackRoot();
    const ts10 = pastTimestamp(10);
    await seedBackup(root, ts10);

    await expect(restoreBackup(root, '2000-01-01T00-00-00.000Z')).rejects.toMatchObject({
      code: 'BACKUP_TIMESTAMP_NOT_FOUND',
    });
  }, 30_000);

  it('timestamp 含路径穿越（.. / 子路径）或空串 → PackError code="BACKUP_DIR_INVALID"', async () => {
    const root = await makePackRoot();

    await expect(restoreBackup(root, '..')).rejects.toMatchObject({ code: 'BACKUP_DIR_INVALID' });
    await expect(restoreBackup(root, 'a/b')).rejects.toMatchObject({ code: 'BACKUP_DIR_INVALID' });
    await expect(restoreBackup(root, 'a\\b')).rejects.toMatchObject({ code: 'BACKUP_DIR_INVALID' });
    await expect(restoreBackup(root, '')).rejects.toMatchObject({ code: 'BACKUP_DIR_INVALID' });
  });

  it('备份缺 manifest.json / 非法 JSON / 形状不符 → PackError code="BACKUP_MANIFEST_INVALID"', async () => {
    const root = await makePackRoot();
    const [ts30, ts20, ts10] = [30, 20, 10].map(pastTimestamp);
    await seedBackup(root, ts30, { omitManifest: true });
    await seedBackup(root, ts20, { rawManifest: '{nope' });
    await seedBackup(root, ts10, {
      rawManifest: JSON.stringify({ createdAt: ts10, reason: 'bogus' }), // 形状不符
    });

    await expect(restoreBackup(root, ts30)).rejects.toMatchObject({ code: 'BACKUP_MANIFEST_INVALID' });
    await expect(restoreBackup(root, ts20)).rejects.toMatchObject({ code: 'BACKUP_MANIFEST_INVALID' });
    await expect(restoreBackup(root, ts10)).rejects.toMatchObject({ code: 'BACKUP_MANIFEST_INVALID' });
  }, 30_000);

  it('备份只有 scripts（无 ui 子目录）→ 只恢复脚本，不报错', async () => {
    const root = await makePackRoot();
    const ts = pastTimestamp(10);
    await seedBackup(root, ts, { scripts: { 'Global.lua': '--only-scripts' }, omitUi: true });

    await expect(restoreBackup(root, ts)).resolves.toBeUndefined();
    expect(await readFile(path.join(root, 'scripts', 'Global.lua'), 'utf8')).toBe('--only-scripts');
    await expect(stat(path.join(root, 'ui'))).rejects.toMatchObject({ code: 'ENOENT' }); // 没造 ui 就不建
  }, 30_000);

  it('工作区没有 scripts/ui 目录 → 自动创建并恢复', async () => {
    const root = await makePackRoot();
    const ts = pastTimestamp(10);
    await seedBackup(root, ts, {
      scripts: { 'abc111.Pawn.lua': '--p' },
      ui: { 'abc111.Pawn.xml': '<Panel />' },
    });

    await restoreBackup(root, ts);

    expect(await readFile(path.join(root, 'scripts', 'abc111.Pawn.lua'), 'utf8')).toBe('--p');
    expect(await readFile(path.join(root, 'ui', 'abc111.Pawn.xml'), 'utf8')).toBe('<Panel />');
  }, 30_000);

  it('与 createBackup/listBackups 组合：备份 → 改坏工作区 → 恢复最新一份找回原内容', async () => {
    const root = await makePackRoot();
    const states = [
      state('-1', 'Global', { script: '--origin-global', ui: '<Panel>origin</Panel>' }),
      state('abc111', 'Pawn', { script: '--origin-pawn' }),
    ];
    const { manifest } = await createBackup({ root, scriptStates: states });

    // 灾难现场：工作区脚本被改坏
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'scripts', 'Global.lua'), '--corrupted', 'utf8');

    const latest = await listBackups(root);
    expect(latest[0]?.createdAt).toBe(manifest.createdAt);
    await restoreBackup(root, latest[0]!.createdAt);

    expect(await readFile(path.join(root, 'scripts', 'Global.lua'), 'utf8')).toBe('--origin-global');
    expect(await readFile(path.join(root, 'ui', 'Global.xml'), 'utf8')).toBe('<Panel>origin</Panel>');
    expect(await readFile(path.join(root, 'scripts', 'abc111.Pawn.lua'), 'utf8')).toBe('--origin-pawn');
  }, 30_000);

  it('备份根被同名文件占用 → PackError code="BACKUP_DIR_INVALID"', async () => {
    const root = await makePackRoot();
    await mkdir(path.join(root, '.tts'), { recursive: true });
    await writeFile(path.join(root, '.tts', 'backups'), 'not a dir', 'utf8');

    await expect(restoreBackup(root, 'any-timestamp')).rejects.toMatchObject({
      code: 'BACKUP_DIR_INVALID',
    });
  }, 30_000);

  it('root 空串 → 编程错误（普通 Error，不是 PackError）', async () => {
    await expect(listBackups('')).rejects.toBeInstanceOf(Error);
    await expect(pruneBackups('', 3)).rejects.toBeInstanceOf(Error);
    await expect(restoreBackup('', 'x')).rejects.toBeInstanceOf(Error);
    await expect(listBackups('')).rejects.not.toBeInstanceOf(PackError);
  });
});
