// tests/unit/safety-baseline.test.ts
/**
 * src/safety/baseline.ts 单元测试：基线 hash 与冲突检测（阶段 5 写入路径的安全基座）。
 *
 * 纯文件 IO（os.tmpdir() 下的临时目录，mkdtemp + rm -rf），无网络、无 TTS：
 * baseline 模块是纯离线操作（不连 39998、不起 withEditorServer、不调 saveAndPlay），
 * 与 tests/unit/pack-push.test.ts 同款夹具风格——真临时目录 + 手写夹具文件。
 *
 * 覆盖（按公开函数分组）：
 * - baselinePath：路径拼接（.tts/baseline.json，正斜杠与平台分隔符由 path 决定）；
 * - readBaseline：不存在 / JSON 损坏 / 结构不符（version、entries、assetFiles）→ null；
 *   正常读取；IO 错误（baseline.json 是目录）→ BASELINE_READ_FAILED；
 * - writeBaseline：基本流（结构 / packRoot / updatedAt / 写盘 2 空格 + 末尾换行）/
 *   hash 正确性与 CRLF 归一化 / Global 名字 / name 净化 / 缺字段不记 hash /
 *   空 states / 同 guid 先到先得 / 保留旧 lastPushAt（损坏时不保留也不报错）/
 *   素材口径（cards.csv + deck.yaml + objects/objects.csv，其他文件不进表，
 *   缺文件跳过，中文目录名，key 正斜杠）/ 空 assetFiles /
 *   BASELINE_WRITE_FAILED（.tts 被文件占用）/ BASELINE_ASSET_SCAN_FAILED（cards.csv 是目录）；
 * - diffBaseline：无冲突（含 CRLF 等价）/ script 冲突 / ui 冲突 / 双冲突顺序 /
 *   远端缺整 guid / baseline 缺失或损坏 → 空 / 基线缺 hash 而远端有 → 冲突 /
 *   远端新 guid 不算冲突 / 远端同 guid 先到先得 / IO 错误上抛；
 * - detectAssetChanges：baseline null（added=全部）/ 全匹配 / changed /
 *   CRLF 等价不算 changed（防假冲突核心用例）/ added / deleted / 混合 /
 *   传入手搓 baseline（不读盘）/ BASELINE_ASSET_SCAN_FAILED；
 * - touchLastPushAt：baseline 存在（只改 lastPushAt，其余逐字保留）/
 *   baseline 不存在或损坏 → 什么都不做 / 写失败 → BASELINE_WRITE_FAILED。
 *
 * 错误按 PackError.code（机器可读）断言，不断言 message（i18n 文案会变）。
 * Windows 专属触发器（.tts 被文件占用 → mkdir EEXIST；只读文件 → 写 EPERM）已在本机
 * 用 node 实测错误码后选用；Linux 上对应路径分别为 ENOTDIR/EACCES，同样 ≠ 静默成功。
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectAssetChanges,
  diffBaseline,
  readBaseline,
  touchLastPushAt,
  writeBaseline,
  type Baseline,
} from '../../src/safety/baseline.js';
import { baselinePath } from '../../src/pack/layout.js';
import type { ScriptState } from '../../src/session/scripts.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-baseline-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

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

/** 构造一个 ScriptState（script / ui 缺省 = 字段不出现，与协议「缺字段即删除」对应） */
function state(guid: string, name: string, script?: string, ui?: string): ScriptState {
  const s: ScriptState = { name, guid };
  if (script !== undefined) {
    s.script = script;
  }
  if (ui !== undefined) {
    s.ui = ui;
  }
  return s;
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

/** 直接往 <root>/.tts/baseline.json 写原始文本（损坏 / 手搓基线用；自动建目录） */
async function writeRawBaselineText(root: string, text: string): Promise<void> {
  await mkdir(path.join(root, '.tts'), { recursive: true });
  await writeFile(baselinePath(root), text, 'utf8');
}

/** 手搓一个合法形状的 Baseline（供 detectAssetChanges 的「不读盘」与损坏变体用） */
function handBaseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    version: 1,
    packRoot: 'X:/somewhere/else',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: [],
    assetFiles: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// baselinePath
// ---------------------------------------------------------------------------

describe('baselinePath（路径拼接）', () => {
  it('拼接 <root>/.tts/baseline.json', () => {
    expect(baselinePath('D:/some/pack')).toBe(path.join('D:/some/pack', '.tts', 'baseline.json'));
  });

  it('root 非法（空串 / 纯空白）→ 同步抛编程错误', () => {
    expect(() => baselinePath('')).toThrow();
    expect(() => baselinePath('   ')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// readBaseline
// ---------------------------------------------------------------------------

describe('readBaseline（读取基线）', () => {
  it('baseline.json 不存在 → null（不抛错）', async () => {
    expect(await readBaseline(tempRoot)).toBeNull();
  });

  it('JSON 语法损坏 → null（不抛错）', async () => {
    await writeRawBaselineText(tempRoot, 'not json {{{');
    expect(await readBaseline(tempRoot)).toBeNull();
  });

  it('顶层不是对象（数组 / 字符串 / null）→ null', async () => {
    await writeRawBaselineText(tempRoot, JSON.stringify([1, 2]));
    expect(await readBaseline(tempRoot)).toBeNull();

    await writeRawBaselineText(tempRoot, JSON.stringify('just a string'));
    expect(await readBaseline(tempRoot)).toBeNull();

    await writeRawBaselineText(tempRoot, 'null');
    expect(await readBaseline(tempRoot)).toBeNull();
  });

  it('version !== 1 → null（未知结构版本按损坏处理）', async () => {
    await writeRawBaselineText(tempRoot, JSON.stringify({ ...handBaseline(), version: 2 }));
    expect(await readBaseline(tempRoot)).toBeNull();
  });

  it('entries 形状不符（非数组 / 元素非对象 / 缺 guid / 缺 name）→ null', async () => {
    await writeRawBaselineText(tempRoot, JSON.stringify({ ...handBaseline(), entries: 'nope' }));
    expect(await readBaseline(tempRoot)).toBeNull();

    await writeRawBaselineText(tempRoot, JSON.stringify({ ...handBaseline(), entries: ['nope'] }));
    expect(await readBaseline(tempRoot)).toBeNull();

    await writeRawBaselineText(tempRoot, JSON.stringify({ ...handBaseline(), entries: [{ name: 'X' }] }));
    expect(await readBaseline(tempRoot)).toBeNull();

    await writeRawBaselineText(
      tempRoot,
      JSON.stringify({ ...handBaseline(), entries: [{ guid: 'aa' }] }),
    );
    expect(await readBaseline(tempRoot)).toBeNull();
  });

  it('assetFiles 形状不符（非对象 / 值非字符串）→ null', async () => {
    await writeRawBaselineText(tempRoot, JSON.stringify({ ...handBaseline(), assetFiles: null }));
    expect(await readBaseline(tempRoot)).toBeNull();

    await writeRawBaselineText(tempRoot, JSON.stringify({ ...handBaseline(), assetFiles: { 'decks/x/cards.csv': 42 } }));
    expect(await readBaseline(tempRoot)).toBeNull();
  });

  it('正常读取：writeBaseline 产出的文件读回与返回值深度一致', async () => {
    const written = await writeBaseline(tempRoot, [state('aa', '测试牌堆', '--lua', '<Panel/>')]);

    const read = await readBaseline(tempRoot);
    expect(read).not.toBeNull();
    expect(read).toEqual(written);
  });

  it('lastPushAt：缺省时读回 undefined；文件里有则读回字符串', async () => {
    const fresh = await writeBaseline(tempRoot, [state('aa', 'X', 'v')]);
    const read1 = await readBaseline(tempRoot);
    expect(read1?.lastPushAt).toBeUndefined();

    const withStamp = JSON.stringify({ ...fresh, lastPushAt: '2026-01-01T00:00:00.000Z' });
    await writeRawBaselineText(tempRoot, withStamp);
    const read2 = await readBaseline(tempRoot);
    expect(read2?.lastPushAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('.tts/baseline.json 是目录（IO 错误，非「不存在」）→ PackError BASELINE_READ_FAILED', async () => {
    await mkdir(baselinePath(tempRoot), { recursive: true });
    await expect(readBaseline(tempRoot)).rejects.toMatchObject({ code: 'BASELINE_READ_FAILED' });
  });

  it('root 非法（空串 / 纯空白）→ 拒绝（编程错误）', async () => {
    await expect(readBaseline('')).rejects.toThrow();
    await expect(readBaseline('   ')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// writeBaseline
// ---------------------------------------------------------------------------

describe('writeBaseline（写入基线）', () => {
  it('基本流：结构 / packRoot 绝对路径 / updatedAt ISO / entries / assetFiles / 写盘格式 / 读回一致', async () => {
    await writeDeckFile(tempRoot, '冒险牌堆', 'cards.csv', 'id\n1\n');
    await writeObjectsCsv(tempRoot, 'guid,name\nabc,棋子\n');
    const globalScript = '--global\nprint("hi")\n';
    const globalUi = '<Panel id="g" />\n';
    const states = [state('-1', 'Global', globalScript, globalUi), state('aa11bb', '棋子', '--pawn\n')];

    const written = await writeBaseline(tempRoot, states);

    expect(written.version).toBe(1);
    expect(written.packRoot).toBe(path.resolve(tempRoot));
    expect(Number.isNaN(Date.parse(written.updatedAt))).toBe(false);
    expect(written.lastPushAt).toBeUndefined();
    expect(written.entries).toEqual([
      { guid: '-1', name: 'Global', scriptHash: hashOf(globalScript), uiHash: hashOf(globalUi) },
      { guid: 'aa11bb', name: '棋子', scriptHash: hashOf('--pawn\n') },
    ]);
    expect(written.assetFiles).toEqual({
      'decks/冒险牌堆/cards.csv': hashOf('id\n1\n'),
      'objects/objects.csv': hashOf('guid,name\nabc,棋子\n'),
    });

    // 落盘格式：2 空格缩进 + 末尾单个换行（非 CRLF）
    const raw = await readFile(baselinePath(tempRoot), 'utf8');
    expect(raw.startsWith('{\n  "version": 1,\n  "packRoot": ')).toBe(true);
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.endsWith('\r\n')).toBe(false);

    // 读回与返回值一致
    expect(await readBaseline(tempRoot)).toEqual(written);
  }, 30_000);

  it('CRLF 归一化：CRLF + 结尾空行的内容 hash 等于 LF 版本（防换行风格假冲突）', async () => {
    await writeBaseline(tempRoot, [state('aa', 'X', 'line1\r\nline2\r\n\r\n')]);

    const baseline = await readBaseline(tempRoot);
    expect(baseline?.entries[0]?.scriptHash).toBe(sha256Of('line1\nline2'));
    expect(baseline?.entries[0]?.scriptHash).toBe(hashOf('line1\nline2\n'));
  });

  it('Global（guid "-1"）名字固定 "Global"，与 state.name 无关', async () => {
    await writeBaseline(tempRoot, [state('-1', '不管叫什么', '--g')]);

    const baseline = await readBaseline(tempRoot);
    expect(baseline?.entries).toEqual([{ guid: '-1', name: 'Global', scriptHash: hashOf('--g') }]);
  });

  it('普通对象 name 走 sanitizeName（空白变下划线；空名回退 object）', async () => {
    await writeBaseline(tempRoot, [state('aa', 'Chess Pawn', 'v'), state('bb', '', 'v')]);

    const baseline = await readBaseline(tempRoot);
    expect(baseline?.entries.map((entry) => entry.name)).toEqual(['Chess_Pawn', 'object']);
  });

  it('state 缺 script / ui 字段 → 对应 hash 缺省（对应「缺字段即删除」语义）', async () => {
    await writeBaseline(tempRoot, [state('aa', 'X'), state('bb', 'Y', undefined, '<Panel/>')]);

    const baseline = await readBaseline(tempRoot);
    expect(baseline?.entries[0]).toEqual({ guid: 'aa', name: 'X' });
    expect(baseline?.entries[0]?.scriptHash).toBeUndefined();
    expect(baseline?.entries[0]?.uiHash).toBeUndefined();
    expect(baseline?.entries[1]).toEqual({ guid: 'bb', name: 'Y', uiHash: hashOf('<Panel/>') });
    expect(baseline?.entries[1]?.scriptHash).toBeUndefined();
  });

  it('空 states → entries []，文件照常写盘', async () => {
    const written = await writeBaseline(tempRoot, []);

    expect(written.entries).toEqual([]);
    expect(written.assetFiles).toEqual({});
    const read = await readBaseline(tempRoot);
    expect(read?.entries).toEqual([]);
  });

  it('同 guid 重复出现 → 先到先得（一条，名字与 hash 取第一个）', async () => {
    await writeBaseline(tempRoot, [state('aa', 'First', 'v1'), state('aa', 'Second', 'v2')]);

    const baseline = await readBaseline(tempRoot);
    expect(baseline?.entries).toEqual([{ guid: 'aa', name: 'First', scriptHash: hashOf('v1') }]);
  });

  it('保留旧 lastPushAt：已有基线的 lastPushAt 原样带入新基线，updatedAt 刷新', async () => {
    await writeBaseline(tempRoot, [state('aa', 'X', 'v1')]);
    const first = await readBaseline(tempRoot);
    // 手工给旧基线盖一个 lastPushAt（模拟「上一次 push 已成功」）
    await writeRawBaselineText(tempRoot, JSON.stringify({ ...first, lastPushAt: '2026-01-01T00:00:00.000Z' }));

    const before = Date.now();
    const second = await writeBaseline(tempRoot, [state('aa', 'X', 'v2')]);

    expect(second.lastPushAt).toBe('2026-01-01T00:00:00.000Z');
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(before);
    expect(second.entries).toEqual([{ guid: 'aa', name: 'X', scriptHash: hashOf('v2') }]);
  });

  it('旧基线损坏（非法 JSON）→ 不保留 lastPushAt 也不报错，照常写入新基线', async () => {
    await writeBaseline(tempRoot, [state('aa', 'X', 'v1')]);
    await writeRawBaselineText(tempRoot, 'garbage{');

    const second = await writeBaseline(tempRoot, [state('aa', 'X', 'v2')]);

    expect(second.lastPushAt).toBeUndefined();
    expect(await readBaseline(tempRoot)).toEqual(second);
  });

  it('中文 deck 目录 → key 为正斜杠相对路径，hash 正确', async () => {
    const content = 'id,name\n1,正面\n';
    await writeDeckFile(tempRoot, '冒险牌堆', 'cards.csv', content);

    const written = await writeBaseline(tempRoot, []);

    expect(Object.keys(written.assetFiles)).toEqual(['decks/冒险牌堆/cards.csv']);
    expect(written.assetFiles['decks/冒险牌堆/cards.csv']).toBe(hashOf(content));
  });

  it('素材口径：cards.csv + deck.yaml + objects/objects.csv 进表；其他文件不进；缺文件跳过', async () => {
    await writeDeckFile(tempRoot, '堆A', 'cards.csv', 'a\n');
    await writeDeckFile(tempRoot, '堆A', 'deck.yaml', 'name: 堆A\n');
    await writeDeckFile(tempRoot, '堆A', '001.png', 'binary-ish\n'); // 非清单文件：不进表
    await writeDeckFile(tempRoot, '堆B', 'cards.csv', 'b\n'); // 堆B 没有 deck.yaml：只记 cards.csv
    await writeObjectsCsv(tempRoot, 'o\n');

    const written = await writeBaseline(tempRoot, []);

    expect(written.assetFiles).toEqual({
      'decks/堆A/cards.csv': hashOf('a\n'),
      'decks/堆A/deck.yaml': hashOf('name: 堆A\n'),
      'decks/堆B/cards.csv': hashOf('b\n'),
      'objects/objects.csv': hashOf('o\n'),
    });
  });

  it('空 assetFiles：没有 decks/ 与 objects/ 时为 {}（目录缺失不算错误）', async () => {
    const written = await writeBaseline(tempRoot, []);

    expect(written.assetFiles).toEqual({});
  });

  it('.tts 被普通文件占用（mkdir 失败）→ PackError BASELINE_WRITE_FAILED', async () => {
    await writeFile(path.join(tempRoot, '.tts'), 'not a dir', 'utf8');

    await expect(writeBaseline(tempRoot, [state('aa', 'X', 'v')])).rejects.toMatchObject({
      code: 'BASELINE_WRITE_FAILED',
    });
  });

  it('cards.csv 是目录（读素材失败）→ PackError BASELINE_ASSET_SCAN_FAILED', async () => {
    await mkdir(path.join(tempRoot, 'decks', '堆A', 'cards.csv'), { recursive: true });

    await expect(writeBaseline(tempRoot, [])).rejects.toMatchObject({ code: 'BASELINE_ASSET_SCAN_FAILED' });
  });

  it('decks 是普通文件（readdir 失败）→ PackError BASELINE_ASSET_SCAN_FAILED', async () => {
    await mkdir(tempRoot, { recursive: true });
    await writeFile(path.join(tempRoot, 'decks'), 'not a dir', 'utf8');

    await expect(writeBaseline(tempRoot, [])).rejects.toMatchObject({ code: 'BASELINE_ASSET_SCAN_FAILED' });
  });

  it('入参非法：root 空串 / states 非数组 → 拒绝（编程错误）', async () => {
    await expect(writeBaseline('', [])).rejects.toThrow();
    await expect(writeBaseline(tempRoot, 'nope' as unknown as ScriptState[])).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// diffBaseline
// ---------------------------------------------------------------------------

describe('diffBaseline（基线冲突检测）', () => {
  it('无冲突：内容一致（含仅换行风格不同的等价内容）→ []', async () => {
    await writeBaseline(tempRoot, [state('aa', '棋子', 'line1\nline2\n', '<Panel/>\n')]);

    expect(await diffBaseline(tempRoot, [state('aa', '棋子', 'line1\nline2\n', '<Panel/>\n')])).toEqual([]);
    // 仅 CRLF / 结尾空行差异：归一化后等价，不算冲突
    expect(await diffBaseline(tempRoot, [state('aa', '棋子', 'line1\r\nline2\r\n', '<Panel/>\r\n\r\n')])).toEqual([]);
  });

  it('script 冲突：远端脚本内容不同 → 一条 kind="script" 的冲突，两侧 hash 正确', async () => {
    await writeBaseline(tempRoot, [state('aa', '棋子', 'old script', '<Panel/>\n')]);

    const conflicts = await diffBaseline(tempRoot, [state('aa', '棋子', 'new script', '<Panel/>\n')]);

    expect(conflicts).toEqual([
      {
        guid: 'aa',
        name: '棋子',
        kind: 'script',
        baselineHash: hashOf('old script'),
        remoteHash: hashOf('new script'),
      },
    ]);
  });

  it('ui 冲突：远端 UI 内容不同 → 一条 kind="ui" 的冲突', async () => {
    await writeBaseline(tempRoot, [state('aa', '棋子', 'script\n', '<Old/>\n')]);

    const conflicts = await diffBaseline(tempRoot, [state('aa', '棋子', 'script\n', '<New/>\n')]);

    expect(conflicts).toEqual([
      {
        guid: 'aa',
        name: '棋子',
        kind: 'ui',
        baselineHash: hashOf('<Old/>\n'),
        remoteHash: hashOf('<New/>\n'),
      },
    ]);
  });

  it('script 与 ui 同时冲突 → 两条，顺序 script 在 ui 之前', async () => {
    await writeBaseline(tempRoot, [state('aa', '棋子', 'old', 'oldUI')]);

    const conflicts = await diffBaseline(tempRoot, [state('aa', '棋子', 'new', 'newUI')]);

    expect(conflicts.map((conflict) => conflict.kind)).toEqual(['script', 'ui']);
  });

  it('远端缺整 guid → 该条目已记录 hash 的每个 kind 各一条冲突（remoteHash 缺省）', async () => {
    await writeBaseline(tempRoot, [state('aa', '棋子', 'script', 'ui'), state('bb', '另一个', 'v')]);

    const conflicts = await diffBaseline(tempRoot, [state('bb', '另一个', 'v')]);

    expect(conflicts).toEqual([
      { guid: 'aa', name: '棋子', kind: 'script', baselineHash: hashOf('script'), remoteHash: undefined },
      { guid: 'aa', name: '棋子', kind: 'ui', baselineHash: hashOf('ui'), remoteHash: undefined },
    ]);
  });

  it('baseline 不存在（首跑）→ 空数组，不报错', async () => {
    expect(await diffBaseline(tempRoot, [state('aa', 'X', 'v')])).toEqual([]);
  });

  it('baseline 损坏（非法 JSON）→ 空数组，不报错', async () => {
    await writeRawBaselineText(tempRoot, 'garbage{');

    expect(await diffBaseline(tempRoot, [state('aa', 'X', 'v')])).toEqual([]);
  });

  it('基线条目缺 scriptHash 而远端有 script → 冲突（baselineHash 缺省 = 基线没记录）', async () => {
    await writeRawBaselineText(
      tempRoot,
      JSON.stringify({
        version: 1,
        packRoot: tempRoot,
        updatedAt: '2026-01-01T00:00:00.000Z',
        entries: [{ guid: 'aa', name: 'X' }],
        assetFiles: {},
      }),
    );

    const conflicts = await diffBaseline(tempRoot, [state('aa', 'X', 'appeared later')]);

    expect(conflicts).toEqual([
      { guid: 'aa', name: 'X', kind: 'script', baselineHash: undefined, remoteHash: hashOf('appeared later') },
    ]);
  });

  it('基线条目没有任何 hash 且远端缺整 guid → 双侧都缺，不算冲突', async () => {
    await writeRawBaselineText(
      tempRoot,
      JSON.stringify({
        version: 1,
        packRoot: tempRoot,
        updatedAt: '2026-01-01T00:00:00.000Z',
        entries: [{ guid: 'aa', name: 'X' }],
        assetFiles: {},
      }),
    );

    expect(await diffBaseline(tempRoot, [])).toEqual([]);
  });

  it('远端多出的新 guid（基线没有）→ 不算冲突', async () => {
    await writeBaseline(tempRoot, [state('aa', '棋子', 'script\n')]);

    const conflicts = await diffBaseline(tempRoot, [
      state('aa', '棋子', 'script\n'),
      state('bb', '新对象', 'brand new'),
    ]);

    expect(conflicts).toEqual([]);
  });

  it('远端同 guid 重复出现 → 先到先得（hash 取第一个）', async () => {
    await writeBaseline(tempRoot, [state('aa', 'X', 'baseline')]);

    const conflicts = await diffBaseline(tempRoot, [state('aa', 'First', 'v1'), state('aa', 'Second', 'v2')]);

    expect(conflicts).toEqual([
      { guid: 'aa', name: 'X', kind: 'script', baselineHash: hashOf('baseline'), remoteHash: hashOf('v1') },
    ]);
  });

  it('baseline.json 是目录（IO 错误）→ BASELINE_READ_FAILED 原样上抛（不吞成空数组）', async () => {
    await mkdir(baselinePath(tempRoot), { recursive: true });

    await expect(diffBaseline(tempRoot, [])).rejects.toMatchObject({ code: 'BASELINE_READ_FAILED' });
  });

  it('入参非法：root 空串 / remoteStates 非数组 → 拒绝（编程错误）', async () => {
    await expect(diffBaseline('', [])).rejects.toThrow();
    await expect(diffBaseline(tempRoot, 'nope' as unknown as ScriptState[])).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// detectAssetChanges
// ---------------------------------------------------------------------------

describe('detectAssetChanges（素材三向对比）', () => {
  it('baseline 为 null 且无素材 → 三个数组全空', async () => {
    expect(await detectAssetChanges(tempRoot, null)).toEqual({ changed: [], added: [], deleted: [] });
  });

  it('baseline 为 null 且有素材 → 全部算 added（首跑口径），changed / deleted 为空', async () => {
    await writeDeckFile(tempRoot, '堆A', 'cards.csv', 'a\n');
    await writeDeckFile(tempRoot, '堆A', 'deck.yaml', 'y\n');
    await writeObjectsCsv(tempRoot, 'o\n');

    const changes = await detectAssetChanges(tempRoot, null);

    expect(changes).toEqual({
      changed: [],
      added: ['decks/堆A/cards.csv', 'decks/堆A/deck.yaml', 'objects/objects.csv'],
      deleted: [],
    });
  });

  it('全匹配 → 三个数组全空', async () => {
    await writeDeckFile(tempRoot, '堆A', 'cards.csv', 'a\n');
    await writeObjectsCsv(tempRoot, 'o\n');
    const written = await writeBaseline(tempRoot, []);

    const changes = await detectAssetChanges(tempRoot, written);

    expect(changes).toEqual({ changed: [], added: [], deleted: [] });
  });

  it('changed：文件内容被改 → changed 恰含该相对路径', async () => {
    await writeDeckFile(tempRoot, '堆A', 'cards.csv', 'a\n');
    const written = await writeBaseline(tempRoot, []);
    await writeDeckFile(tempRoot, '堆A', 'cards.csv', 'a-changed\n');

    const changes = await detectAssetChanges(tempRoot, written);

    expect(changes).toEqual({ changed: ['decks/堆A/cards.csv'], added: [], deleted: [] });
  });

  it('CRLF 等价不算 changed（换行风格差异不触发素材拦截——防假冲突核心用例）', async () => {
    await writeDeckFile(tempRoot, '堆A', 'cards.csv', 'id,name\n1,卡\n');
    const written = await writeBaseline(tempRoot, []);
    // 改成 CRLF + 结尾多一个空行：归一化后与原内容等价
    await writeDeckFile(tempRoot, '堆A', 'cards.csv', 'id,name\r\n1,卡\r\n\r\n');

    const changes = await detectAssetChanges(tempRoot, written);

    expect(changes).toEqual({ changed: [], added: [], deleted: [] });
  });

  it('added：基线之后新增的素材文件 → added 恰含它', async () => {
    await writeDeckFile(tempRoot, '堆A', 'cards.csv', 'a\n');
    const written = await writeBaseline(tempRoot, []);
    await writeDeckFile(tempRoot, '堆B', 'cards.csv', 'b\n');

    const changes = await detectAssetChanges(tempRoot, written);

    expect(changes).toEqual({ changed: [], added: ['decks/堆B/cards.csv'], deleted: [] });
  });

  it('deleted：基线有记录但磁盘已删除 → deleted 恰含它', async () => {
    await writeObjectsCsv(tempRoot, 'o\n');
    const written = await writeBaseline(tempRoot, []);
    await rm(path.join(tempRoot, 'objects', 'objects.csv'));

    const changes = await detectAssetChanges(tempRoot, written);

    expect(changes).toEqual({ changed: [], added: [], deleted: ['objects/objects.csv'] });
  });

  it('混合：changed + added + deleted 同时发生且互不串扰', async () => {
    await writeDeckFile(tempRoot, '堆A', 'cards.csv', 'a\n');
    await writeDeckFile(tempRoot, '堆A', 'deck.yaml', 'y\n');
    const written = await writeBaseline(tempRoot, []);
    await writeDeckFile(tempRoot, '堆A', 'cards.csv', 'a2\n'); // changed
    await rm(path.join(tempRoot, 'decks', '堆A', 'deck.yaml')); // deleted
    await writeDeckFile(tempRoot, '堆C', 'cards.csv', 'c\n'); // added

    const changes = await detectAssetChanges(tempRoot, written);

    expect(changes).toEqual({
      changed: ['decks/堆A/cards.csv'],
      added: ['decks/堆C/cards.csv'],
      deleted: ['decks/堆A/deck.yaml'],
    });
  });

  it('使用传入的 baseline 对象（不读盘）：手搓基线的 hash 与磁盘不符 → changed', async () => {
    await writeDeckFile(tempRoot, 'x', 'cards.csv', 'real content\n');

    const changes = await detectAssetChanges(
      tempRoot,
      handBaseline({ assetFiles: { 'decks/x/cards.csv': 'deadbeef'.repeat(8) } }),
    );

    expect(changes.changed).toEqual(['decks/x/cards.csv']);
  });

  it('cards.csv 是目录（读素材失败）→ PackError BASELINE_ASSET_SCAN_FAILED', async () => {
    await mkdir(path.join(tempRoot, 'decks', '堆A', 'cards.csv'), { recursive: true });

    await expect(detectAssetChanges(tempRoot, null)).rejects.toMatchObject({
      code: 'BASELINE_ASSET_SCAN_FAILED',
    });
  });

  it('root 非法（空串）→ 拒绝（编程错误）', async () => {
    await expect(detectAssetChanges('', null)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// touchLastPushAt
// ---------------------------------------------------------------------------

describe('touchLastPushAt（盖推送时间戳）', () => {
  it('baseline 存在 → 只更新 lastPushAt，其余字段逐字保留', async () => {
    await writeDeckFile(tempRoot, '堆A', 'cards.csv', 'a\n');
    const written = await writeBaseline(tempRoot, [state('aa', 'X', 'v')]);
    await writeRawBaselineText(tempRoot, JSON.stringify({ ...written, lastPushAt: '2026-01-01T00:00:00.000Z' }));
    const before = await readBaseline(tempRoot);
    expect(before?.lastPushAt).toBe('2026-01-01T00:00:00.000Z');

    await touchLastPushAt(tempRoot);

    const after = await readBaseline(tempRoot);
    expect(after?.lastPushAt).not.toBe('2026-01-01T00:00:00.000Z');
    expect(Number.isNaN(Date.parse(after?.lastPushAt ?? 'garbage'))).toBe(false);
    // 其余字段逐字不变（含 updatedAt）
    const { lastPushAt: _droppedBefore, ...restBefore } = before as Baseline;
    const { lastPushAt: _droppedAfter, ...restAfter } = after as Baseline;
    expect(restAfter).toEqual(restBefore);
    // 写回沿用统一格式：末尾单个换行
    const raw = await readFile(baselinePath(tempRoot), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.endsWith('\r\n')).toBe(false);
  });

  it('baseline 不存在 → 什么都不做（不抛错、不创建文件）', async () => {
    await expect(touchLastPushAt(tempRoot)).resolves.toBeUndefined();
    expect(existsSync(baselinePath(tempRoot))).toBe(false);
  });

  it('baseline 损坏（非法 JSON）→ 什么都不做（文件原样保留）', async () => {
    await writeRawBaselineText(tempRoot, 'garbage{');
    const rawBefore = await readFile(baselinePath(tempRoot), 'utf8');

    await expect(touchLastPushAt(tempRoot)).resolves.toBeUndefined();

    expect(await readFile(baselinePath(tempRoot), 'utf8')).toBe(rawBefore);
  });

  it('基线文件只读（写失败）→ PackError BASELINE_WRITE_FAILED', async () => {
    await writeBaseline(tempRoot, [state('aa', 'X', 'v')]);
    const file = baselinePath(tempRoot);
    await chmod(file, 0o444); // Windows 置只读属性；POSIX 去写权限
    try {
      await expect(touchLastPushAt(tempRoot)).rejects.toMatchObject({ code: 'BASELINE_WRITE_FAILED' });
    } finally {
      await chmod(file, 0o666); // 恢复可写，保证 afterEach 清理成功
    }
  });

  it('root 非法（空串）→ 拒绝（编程错误）', async () => {
    await expect(touchLastPushAt('')).rejects.toThrow();
  });
});
