// tests/unit/pack-pull-baseline.test.ts
/**
 * src/pack/pull.ts × safety/baseline.ts 集成单元测试：pull 落盘后写 baseline
 * （阶段 5 写入路径：pull 之后立即把游戏侧 script / ui 的归一化 hash 记到
 * `<root>/.tts/baseline.json`，作为 push 前 diffBaseline 的对照基准）。
 *
 * 不依赖运行中的 TTS（与 tests/unit/pack-pull.test.ts 同款打桩）：
 * - src/cli/with-server.ts 被 vi.mock 替换为固定会话（getScripts 由用例注入
 *   scriptStates）——独立模式路径；
 * - src/protocol/tts-client.ts 的 sendToTts 被 vi.mock 为 no-op——仅 server 注入
 *   路径（SessionScripts 内部会发 messageID 0）需要，避免真连 127.0.0.1:39999；
 *   注入的 EditorServer 用 waitFor 直返注入快照的最小假体；
 * - pack.yaml 校验、目录布局、脚本 / UI 落盘、baseline.json 与素材扫描全部走
 *   真实文件 IO（os.tmpdir() 下的临时目录，mkdtemp + rm -rf）。
 *
 * 覆盖：
 * - 基本语义：pull 后 baseline.json 存在 / 结构（version、packRoot、updatedAt）/
 *   entries 与快照一一对应（guid、净化名、hash）/ hash 是归一化内容的 sha256
 *   （CRLF / 单独 CR / 结尾空白不进 hash）/ 缺 script / ui 字段不记 hash /
 *   Global 固定名 / 同 guid 先到先得 / 空快照仍写基线且不动本地文件 / packRoot
 *   用 resolve 后绝对路径；
 * - 素材清单：decks/<堆>/{cards.csv, deck.yaml} 与 objects/objects.csv 进
 *   assetFiles（key 为正斜杠相对路径、中文目录名）、缺文件跳过、无关文件不进表；
 * - 多次 pull：entries 刷成最新快照 / 保留旧 lastPushAt（pull 不清除也不设置
 *   推送时间戳）/ 从未 push 时 lastPushAt 保持 undefined；
 * - 失败不吞错：写 baseline 失败（baseline.json 是目录）→ BASELINE_WRITE_FAILED
 *   且 pull 整体失败（脚本已落盘的半成品状态可见）；素材扫描失败（cards.csv 是
 *   目录）→ BASELINE_ASSET_SCAN_FAILED；server 注入路径（坑 17，hub 复用 39998）
 *   同样写 baseline。
 *
 * 错误按 PackError.code（机器可读）断言，不断言 message（i18n 文案会变）。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 会话层 getScripts 的替身（vi.hoisted 保证在 vi.mock 工厂中可用）。 */
const mockGetScripts = vi.hoisted(() => vi.fn());

/** 被 mock 的 withEditorServer 收到的会话上下文（本模块只用到 scripts）。 */
interface MockSession {
  scripts: { getScripts: typeof mockGetScripts };
}

// 打桩 1：with-server —— 独立模式路径的会话来源
vi.mock('../../src/cli/with-server.js', () => ({
  withEditorServer: async (fn: (session: MockSession) => Promise<unknown>) =>
    fn({ scripts: { getScripts: mockGetScripts } }),
}));

// 打桩 2：tts-client —— server 注入路径里 SessionScripts 会发 messageID 0，
// 单测不允许真连 127.0.0.1:39999（网络 mock 约定）
vi.mock('../../src/protocol/tts-client.js', () => ({
  sendToTts: async (): Promise<void> => {},
}));

import {
  readBaseline,
  touchLastPushAt,
  writeBaseline,
} from '../../src/safety/baseline.js';
import type { EditorServer } from '../../src/protocol/editor-server.js';
import { writePackYaml } from '../../src/pack/packyaml.js';
import { pullFromGame } from '../../src/pack/pull.js';
import type { ScriptState } from '../../src/session/scripts.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-pull-baseline-'));
  mockGetScripts.mockReset();
  mockGetScripts.mockResolvedValue([]);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 建一个带合法 pack.yaml 的工作区根目录（其余目录由 pullFromGame 的 ensureLayout 补齐） */
async function makePackRoot(): Promise<string> {
  const root = path.join(tempRoot, 'pack');
  await writePackYaml(root, {
    schema_version: 1,
    name: '拉取基线测试图包',
    workshop_id: null,
    source_mod: null,
    host: 'steamcloud',
    vcs: { lfs: 'disabled-no-lfs' },
    paths: { workdir: '.' },
    upload: { prefix: '' },
  });
  return root;
}

/** 往 <root>/scripts/ 落一个脚本文件（自动建目录） */
async function writeScript(root: string, fileName: string, content: string): Promise<string> {
  const dir = path.join(root, 'scripts');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  await writeFile(file, content, 'utf8');
  return file;
}

/** 往 <root>/decks/<deckName>/ 落一个素材清单文件（自动建目录） */
async function writeDeckFile(root: string, deckName: string, fileName: string, content: string): Promise<void> {
  const dir = path.join(root, 'decks', deckName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), content, 'utf8');
}

/** 写 <root>/objects/objects.csv（自动建目录） */
async function writeObjectsCsv(root: string, content: string): Promise<void> {
  const dir = path.join(root, 'objects');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'objects.csv'), content, 'utf8');
}

/** sha256（与 baseline.ts / import.ts 同款算法，测试侧独立实现用于对账） */
function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 归一化（与 baseline.ts 持有的 normalizeContent 同语义：CRLF/CR → LF + trimEnd） */
function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').trimEnd();
}

/** hash 前置归一化后的 sha256（即写入 baseline 的 hash） */
function hashOf(text: string): string {
  return sha256Of(normalize(text));
}

/**
 * server 注入路径用的最小假 EditorServer：find 返回空（无留存消息），
 * waitFor 直接返回注入的快照（SessionScripts 只用到这两个成员）。
 */
function fakeEditorServer(states: ScriptState[]): EditorServer {
  return {
    find: () => [],
    waitFor: async () => ({ messageID: 1 as const, scriptStates: states }),
  } as unknown as EditorServer;
}

// ---------------------------------------------------------------------------
// 基线写入：基本语义
// ---------------------------------------------------------------------------

describe('pullFromGame → baseline：基本语义', () => {
  it('pull 完成后 <root>/.tts/baseline.json 存在', async () => {
    const root = await makePackRoot();
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--s' }]);

    await pullFromGame({ root });

    expect(existsSync(path.join(root, '.tts', 'baseline.json'))).toBe(true);
  }, 30_000);

  it('baseline 结构正确：version=1 / packRoot=resolve(root) / updatedAt 为 ISO 时间戳', async () => {
    const root = await makePackRoot();

    await pullFromGame({ root });

    const baseline = await readBaseline(root);
    expect(baseline).not.toBeNull();
    expect(baseline!.version).toBe(1);
    expect(baseline!.packRoot).toBe(path.resolve(root));
    expect(Number.isNaN(Date.parse(baseline!.updatedAt))).toBe(false);
  }, 30_000);

  it('entries 与快照一一对应：按 states 顺序记录 guid / 净化名', async () => {
    const root = await makePackRoot();
    mockGetScripts.mockResolvedValue([
      { guid: 'abc', name: '测试对象', script: '--a' },
      { guid: 'def', name: 'Chess Pawn', script: '--b', ui: '<Panel/>' },
    ]);

    await pullFromGame({ root });

    const baseline = await readBaseline(root);
    expect(baseline!.entries.map((e) => e.guid)).toEqual(['abc', 'def']);
    expect(baseline!.entries[0].name).toBe('测试对象');
    expect(baseline!.entries[1].name).toBe('Chess_Pawn'); // 净化名与落盘文件名一致
  }, 30_000);

  it('scriptHash / uiHash 是归一化内容的 sha256（测试侧独立实现对账）', async () => {
    const root = await makePackRoot();
    mockGetScripts.mockResolvedValue([
      { guid: 'abc', name: '测试', script: '--s', ui: '<Panel id="x" />' },
    ]);

    await pullFromGame({ root });

    const baseline = await readBaseline(root);
    expect(baseline!.entries[0].scriptHash).toBe(hashOf('--s'));
    expect(baseline!.entries[0].uiHash).toBe(hashOf('<Panel id="x" />'));
  }, 30_000);

  it('CRLF / 单独 CR / 结尾空白归一化后再 hash（换行风格差异不进基线）', async () => {
    const root = await makePackRoot();
    const raw = '-- line1\r\n-- line2\r\n  \r\n';
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: raw }]);

    await pullFromGame({ root });

    const baseline = await readBaseline(root);
    expect(baseline!.entries[0].scriptHash).toBe(hashOf(raw));
    expect(baseline!.entries[0].scriptHash).toBe(hashOf('-- line1\n-- line2'));
    expect(baseline!.entries[0].scriptHash).not.toBe(sha256Of(raw)); // 确实先归一化
  }, 30_000);

  it('state 缺 script 字段 → entry 无 scriptHash（ui 正常记录）', async () => {
    const root = await makePackRoot();
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', ui: '<Panel/>' }]);

    await pullFromGame({ root });

    const baseline = await readBaseline(root);
    expect(baseline!.entries[0].scriptHash).toBeUndefined();
    expect(baseline!.entries[0].uiHash).toBe(hashOf('<Panel/>'));
  }, 30_000);

  it('state 缺 ui 字段 → entry 无 uiHash（script 正常记录）', async () => {
    const root = await makePackRoot();
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--s' }]);

    await pullFromGame({ root });

    const baseline = await readBaseline(root);
    expect(baseline!.entries[0].uiHash).toBeUndefined();
    expect(baseline!.entries[0].scriptHash).toBe(hashOf('--s'));
  }, 30_000);

  it('guid "-1"（全局）的 entry name 恒为 "Global"，与 state.name 无关', async () => {
    const root = await makePackRoot();
    mockGetScripts.mockResolvedValue([{ guid: '-1', name: '随便什么名', script: '--global' }]);

    await pullFromGame({ root });

    const baseline = await readBaseline(root);
    expect(baseline!.entries).toEqual([
      { guid: '-1', name: 'Global', scriptHash: hashOf('--global') },
    ]);
  }, 30_000);

  it('空 scriptStates → baseline 仍写入：entries=[]，本地已有文件保持不动', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'xyz.旧对象.lua', '--keep');

    await pullFromGame({ root }); // 空快照：模块头决策——无 state 的 guid 不删除

    const baseline = await readBaseline(root);
    expect(baseline!.entries).toEqual([]);
    expect(await readFile(path.join(root, 'scripts', 'xyz.旧对象.lua'), 'utf8')).toBe('--keep');
  }, 30_000);

  it('同 guid 重复出现 → 先到先得只记一条（与 diff.ts 的 gameByGuid 语义一致）', async () => {
    const root = await makePackRoot();
    mockGetScripts.mockResolvedValue([
      { guid: 'abc', name: '第一次', script: '--first' },
      { guid: 'abc', name: '第二次', script: '--second' },
    ]);

    await pullFromGame({ root });

    const baseline = await readBaseline(root);
    expect(baseline!.entries.length).toBe(1);
    expect(baseline!.entries[0]).toMatchObject({ guid: 'abc', name: '第一次', scriptHash: hashOf('--first') });
  }, 30_000);

  it('root 含 ".." 片段 → baseline.packRoot 是 resolve 后的绝对路径（跨机器可比）', async () => {
    const root = path.join(tempRoot, 'pack', 'nested', '..');
    await writePackYaml(root, {
      schema_version: 1,
      name: '路径归一测试',
      workshop_id: null,
      source_mod: null,
      host: 'steamcloud',
      vcs: { lfs: 'disabled-no-lfs' },
      paths: { workdir: '.' },
      upload: { prefix: '' },
    });

    await pullFromGame({ root });

    const baseline = await readBaseline(root);
    expect(baseline!.packRoot).toBe(path.resolve(root));
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 素材清单进 assetFiles
// ---------------------------------------------------------------------------

describe('pullFromGame → baseline：素材清单', () => {
  it('assetFiles 记录 decks/<堆>/{cards.csv, deck.yaml} 与 objects/objects.csv（key 正斜杠、hash 归一化）', async () => {
    const root = await makePackRoot();
    await writeDeckFile(root, '冒险牌堆', 'cards.csv', 'Card,Name\n1,甲\r\n');
    await writeDeckFile(root, '冒险牌堆', 'deck.yaml', 'name: 冒险\n');
    await writeObjectsCsv(root, 'guid,name\nabc,测试\n');

    await pullFromGame({ root });

    const baseline = await readBaseline(root);
    expect(baseline!.assetFiles).toEqual({
      'decks/冒险牌堆/cards.csv': hashOf('Card,Name\n1,甲\r\n'),
      'decks/冒险牌堆/deck.yaml': hashOf('name: 冒险\n'),
      'objects/objects.csv': hashOf('guid,name\nabc,测试\n'),
    });
  }, 30_000);

  it('缺失素材文件跳过：deck 只有 deck.yaml、无 objects.csv → 只记存在的文件', async () => {
    const root = await makePackRoot();
    await writeDeckFile(root, '牌堆', 'deck.yaml', 'name: x\n');

    await pullFromGame({ root });

    const baseline = await readBaseline(root);
    expect(baseline!.assetFiles).toEqual({ 'decks/牌堆/deck.yaml': hashOf('name: x\n') });
  }, 30_000);

  it('无关文件不进表：decks 根下的散文件、deck 目录里的其他文件、子目录的子目录都不扫', async () => {
    const root = await makePackRoot();
    await writeDeckFile(root, '牌堆', 'cards.csv', 'Card\n1\n');
    await writeDeckFile(root, '牌堆', 'ignore.txt', '无关');
    await writeFile(path.join(root, 'decks', 'loose.txt'), 'decks 根下的散文件', 'utf8');

    await pullFromGame({ root });

    const baseline = await readBaseline(root);
    expect(Object.keys(baseline!.assetFiles)).toEqual(['decks/牌堆/cards.csv']);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 多次 pull 与 lastPushAt
// ---------------------------------------------------------------------------

describe('pullFromGame → baseline：多次 pull 与 lastPushAt', () => {
  it('多次 pull：第二次 pull 把 entries 刷成最新快照（旧 hash 不残留）', async () => {
    const root = await makePackRoot();
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--v1' }]);
    await pullFromGame({ root });

    mockGetScripts.mockResolvedValue([
      { guid: 'abc', name: '测试', script: '--v2' },
      { guid: 'new', name: '新对象', script: '--new' },
    ]);
    await pullFromGame({ root });

    const baseline = await readBaseline(root);
    expect(baseline!.entries).toEqual([
      { guid: 'abc', name: '测试', scriptHash: hashOf('--v2') },
      { guid: 'new', name: '新对象', scriptHash: hashOf('--new') },
    ]);
  }, 30_000);

  it('多次 pull 保留旧 lastPushAt（pull 不清除推送史，也不设置它）', async () => {
    const root = await makePackRoot();
    // 预置一次"曾经的 push"：写基线 + touchLastPushAt（真实模块，不手搓 JSON）
    await writeBaseline(root, [{ guid: 'abc', name: '测试', script: '--pushed' }]);
    await touchLastPushAt(root);
    const before = await readBaseline(root);
    expect(before!.lastPushAt).toBeDefined();

    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--repulled' }]);
    await pullFromGame({ root });

    const after = await readBaseline(root);
    expect(after!.lastPushAt).toBe(before!.lastPushAt); // 旧推送时间戳原样保留
    expect(after!.updatedAt >= before!.updatedAt).toBe(true); // 但 updatedAt 已刷新
    expect(after!.entries[0].scriptHash).toBe(hashOf('--repulled')); // entries 已是最新快照
  }, 30_000);

  it('从未 push（无 lastPushAt）→ 多次 pull 后 lastPushAt 仍为 undefined', async () => {
    const root = await makePackRoot();
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--a' }]);
    await pullFromGame({ root });
    await pullFromGame({ root });

    const baseline = await readBaseline(root);
    expect(baseline!.lastPushAt).toBeUndefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 失败不吞错
// ---------------------------------------------------------------------------

describe('pullFromGame → baseline：失败不吞错', () => {
  it('写 baseline 失败（baseline.json 是目录）→ pull 整体失败 BASELINE_WRITE_FAILED（脚本已落盘）', async () => {
    const root = await makePackRoot();
    // 手工把 .tts/baseline.json 占位成目录：writeBaselineFile 写文件时 EISDIR
    await mkdir(path.join(root, '.tts', 'baseline.json'), { recursive: true });
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--s' }]);

    await expect(pullFromGame({ root })).rejects.toMatchObject({ code: 'BASELINE_WRITE_FAILED' });

    // 半成品状态可见：脚本落盘发生在写基线之前（先写盘后记基线）
    expect(await readFile(path.join(root, 'scripts', 'abc.测试.lua'), 'utf8')).toBe('--s');
  }, 30_000);

  it('素材扫描失败（cards.csv 是目录）→ pull 整体失败 BASELINE_ASSET_SCAN_FAILED', async () => {
    const root = await makePackRoot();
    await mkdir(path.join(root, 'decks', '坏牌堆', 'cards.csv'), { recursive: true });
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--s' }]);

    await expect(pullFromGame({ root })).rejects.toMatchObject({ code: 'BASELINE_ASSET_SCAN_FAILED' });
  }, 30_000);

  it('server 注入路径（hub 复用 39998，坑 17）同样写 baseline 且 entries 正确', async () => {
    const root = await makePackRoot();
    const states: ScriptState[] = [
      { guid: '-1', name: 'Global', script: '--global', ui: '<Panel/>' },
      { guid: 'abc', name: '注入对象', script: '--injected' },
    ];

    await pullFromGame({ root, server: fakeEditorServer(states) });

    // 注入路径不经过被 mock 的 withEditorServer
    expect(mockGetScripts).not.toHaveBeenCalled();
    const baseline = await readBaseline(root);
    expect(baseline!.entries).toEqual([
      { guid: '-1', name: 'Global', scriptHash: hashOf('--global'), uiHash: hashOf('<Panel/>') },
      { guid: 'abc', name: '注入对象', scriptHash: hashOf('--injected') },
    ]);
    // 注入路径同样落盘了脚本（applyState 照常执行）
    expect(await readFile(path.join(root, 'scripts', 'abc.注入对象.lua'), 'utf8')).toBe('--injected');
  }, 30_000);
});
