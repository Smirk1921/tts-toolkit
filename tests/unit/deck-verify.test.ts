// tests/unit/deck-verify.test.ts
/**
 * src/deck/verify.ts 单元测试：工作区校验器（网格 / 卡数 / CMYK / CardID / 父子一致）。
 *
 * 覆盖维度：
 * - 正常路径：空 deck（cards.csv 只表头）→ ok、全通过的小工作区（cards.csv +
 *   图集 + 卡图 + objects.csv 齐备）→ ok、父子 CustomDeck 一致 → 无 issue、
 *   {lang} 完好 → 无 issue、共享图集已在 shared_with 声明 → 无 warning、
 *   多 deck 工作区各自独立校验、decks/ 下只有 data.json 没有 deck.yaml 的目录
 *   静默跳过（坑 5）、无 skeleton.json 时存档校验整段跳过、checkCmyk /
 *   checkAtlasSize=false 只关掉读图检查（存在性等廉价检查照跑）；
 * - 异常路径：网格声明与实际不符（非整除 / 非方格）→ ATLAS_GRID_MISMATCH、
 *   卡数超容量 → DECK_TOO_MANY_CARDS、CMYK（正面 / 背面 / 图集）→ CARD_CMYK /
 *   ATLAS_CMYK、CardID 与 slot 不匹配 → CARD_ID_MISMATCH（cards.ts 的
 *   CARDS_SLOT_MISMATCH 语义映射）、图集缺失 → SHEET_SOURCE_MISSING、
 *   父子 CustomDeck 不一致 → PARENT_CHILD_DECK_MISMATCH（URL 不同 / 快照条数
 *   不同 / 非 URL 字段不同 / 两层嵌套四个角度）、{lang} 被破坏 →
 *   LANG_VARIANT_MALFORMED / LANG_VARIANT_SUSPECT、共享图集未声明 →
 *   SHARED_ATLAS_NOT_DECLARED、objects.csv 缺失 / 非法 / file 引用缺失；
 * - 边界值：slot=100（card_id %100===0 的 1 基回绕，cards.ts 拒绝 →
 *   CARDS_SLOT_OUT_OF_RANGE 透传）、GUID 大小写不归一（shared_with 精确匹配）、
 *   空串 GUID 不建索引不告警（坑 7）、sheet_source 的四种解析（file: URL /
 *   绝对路径 / 相对 deckDir / 相对 packRoot）、问题不中断（多类 issue 一次
 *   返回）、卡图缺失 / 损坏 → warning（可能尚未拉取，不阻塞通过）。
 *
 * 断言约定：PackError 透传码按 .code 断言，message 双态断言（locales 未补齐时
 * t() 原样返回键名）；本模块自身 issue 文案写死中文，直接 includes() 断言。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeCardsCsv, type CardRow } from '../../src/deck/cards.js';
import { writeObjectsCsv } from '../../src/deck/objects.js';
import { verifyPack, type VerifyIssue, type VerifyResult } from '../../src/deck/verify.js';
import { writeDeckManifest } from '../../src/pack/manifest.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时图包根目录 */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-deck-verify-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具辅助
// ---------------------------------------------------------------------------

/** 默认网格：2 列 × 3 行，单格 64px（图集 128×192） */
const COLS = 2;
const ROWS = 3;
const CELL = 64;

/** 在 decks/<name>/ 写一份最小合法 deck.yaml，返回 deck 目录 */
async function addDeck(name: string, guid: string = 'AAA111', sharedWith: string[] = []): Promise<string> {
  const dir = path.join(tempRoot, 'decks', name);
  await writeDeckManifest(dir, { schema_version: 1, name, guid, shared_with: sharedWith });
  return dir;
}

/** 写一份只有表头的 objects.csv（<root>/objects/objects.csv，合法但为空） */
async function ensureObjectsCsv(root: string = tempRoot): Promise<void> {
  await writeObjectsCsv(path.join(root, 'objects'), []);
}

/** 构造一行卡牌（默认 2x3 网格、本地图集 source/sheet-1.png，slot 按 1 基换算） */
function makeRow(overrides: Partial<CardRow> & Pick<CardRow, 'cardId'>): CardRow {
  return {
    face: `card_${overrides.cardId}.png`,
    sheetId: 1,
    slot: ((overrides.cardId % 100) === 0 ? 100 : overrides.cardId % 100),
    sheetCols: COLS,
    sheetRows: ROWS,
    sheetSource: 'source/sheet-1.png',
    ...overrides,
  };
}

/** 落盘一张 PNG 图集（默认尺寸 = 网格 × 64px 方格；file 可指定绝对路径） */
async function makeAtlas(
  deckDir: string,
  sheetId: number,
  opts: { width?: number; height?: number; file?: string } = {},
): Promise<string> {
  const file = opts.file ?? path.join(deckDir, 'source', `sheet-${sheetId}.png`);
  await mkdir(path.dirname(file), { recursive: true });
  await sharp({
    create: {
      width: opts.width ?? COLS * CELL,
      height: opts.height ?? ROWS * CELL,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 1 },
    },
  }).png().toFile(file);
  return file;
}

/** 落盘一张卡图（默认 sRGB PNG；cmyk=true 时输出 CMYK JPEG——文件名需 .jpg） */
async function makeCardImage(
  deckDir: string,
  relative: string,
  opts: { cmyk?: boolean; garbage?: boolean } = {},
): Promise<string> {
  const file = path.join(deckDir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  if (opts.garbage) {
    await writeFile(file, Buffer.from('this is not an image'));
    return file;
  }
  const base = sharp({
    create: { width: CELL, height: CELL, channels: 3, background: { r: 200, g: 10, b: 10 } },
  });
  if (opts.cmyk) {
    await base.toColorspace('cmyk').jpeg({ quality: 90 }).toFile(file);
  } else {
    await base.png().toFile(file);
  }
  return file;
}

/**
 * 一套"全通过"的 deck 夹具：deck.yaml + 6 张卡（slot 1..6 铺满 2x3）+
 * 尺寸吻合的本地图集 + 6 张 sRGB 卡图 + 空.objects.csv。返回 deck 目录。
 */
async function addCleanDeck(name = 'deckA'): Promise<string> {
  const dir = await addDeck(name);
  const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({ cardId: 10100 + slot }));
  await writeCardsCsv(dir, rows);
  await makeAtlas(dir, 1);
  for (const row of rows) {
    await makeCardImage(dir, row.face);
  }
  await ensureObjectsCsv();
  return dir;
}

/** 带合法 deck.yaml + 空 cards.csv（只有表头）的 deck；共享图集声明类测试用 */
async function addDeckWithEmptyCards(name: string, guid: string, sharedWith: string[] = []): Promise<string> {
  const dir = await addDeck(name, guid, sharedWith);
  await writeCardsCsv(dir, []);
  return dir;
}

// ── skeleton 夹具 ──

/** CustomDeck 规格对象（含非 URL 字段——父子比较按整对象快照） */
interface SpecFixture {
  FaceURL: string;
  BackURL: string;
  NumWidth: number;
  NumHeight: number;
  Type: number;
  UniqueBack: boolean;
}

function baseSpec(overrides: Partial<SpecFixture> = {}): SpecFixture {
  return { FaceURL: 'http://x/face.png', BackURL: 'http://x/back.png', NumWidth: 2, NumHeight: 3, Type: 0, UniqueBack: false, ...overrides };
}

function cardObject(guid: string, spec: SpecFixture, key = '101'): Record<string, unknown> {
  return { GUID: guid, Name: 'Card', CardID: 10101, CustomDeck: { [key]: structuredClone(spec) } };
}

function deckObject(
  guid: string,
  spec: SpecFixture,
  contained?: Record<string, unknown>[],
  key = '101',
): Record<string, unknown> {
  const obj: Record<string, unknown> = { GUID: guid, Name: 'Deck', CustomDeck: { [key]: structuredClone(spec) } };
  if (contained !== undefined) {
    obj['ContainedObjects'] = contained;
  }
  return obj;
}

async function writeSkeleton(save: unknown, root: string = tempRoot): Promise<void> {
  await mkdir(path.join(root, '.tts'), { recursive: true });
  await writeFile(path.join(root, '.tts', 'skeleton.json'), JSON.stringify(save, null, 2), 'utf8');
}

// ── 断言辅助 ──

function codesOf(result: VerifyResult): string[] {
  return result.issues.map((issue) => issue.code);
}

function firstIssue(result: VerifyResult, code: string): VerifyIssue {
  const issue = result.issues.find((candidate) => candidate.code === code);
  expect(issue, `应有 code=${code} 的 issue，实际：${JSON.stringify(result.issues, null, 1)}`).toBeDefined();
  return issue as VerifyIssue;
}

/** PackError 透传码的 message 双态断言（locales 未补齐 → t() 原样返回键名） */
function expectDualMessage(issue: VerifyIssue, rawKey: string, fragment: string): void {
  expect(issue.message === rawKey || issue.message.includes(fragment)).toBe(true);
}

/** 默认选项的 verifyPack 快捷入口 */
function verify(opts: Partial<Parameters<typeof verifyPack>[0]> = {}): Promise<VerifyResult> {
  return verifyPack({ packRoot: tempRoot, ...opts });
}

// ---------------------------------------------------------------------------
// 第 1 节：卡牌校验（decks/<name>/）
// ---------------------------------------------------------------------------

describe('卡牌校验：cards.csv 与结构检查', () => {
  it('空 deck（cards.csv 只有表头）→ ok，无任何 issue', async () => {
    await addDeckWithEmptyCards('deckA', 'AAA111');
    await ensureObjectsCsv();
    const result = await verify();
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it('全通过的小工作区（6 卡铺满 2x3 + 图集吻合 + sRGB 卡图）→ ok=true、0 错 0 警', async () => {
    await addCleanDeck();
    const result = await verify();
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it('cards.csv 缺失 → CARDS_NOT_FOUND（error，location 指向该 deck 目录）', async () => {
    await addDeck('deckA'); // 只有 deck.yaml，没有 cards.csv
    await ensureObjectsCsv();
    const result = await verify();
    expect(codesOf(result)).toEqual(['CARDS_NOT_FOUND']);
    const issue = firstIssue(result, 'CARDS_NOT_FOUND');
    expect(issue.severity).toBe('error');
    expect(issue.location).toBe(path.join(tempRoot, 'decks', 'deckA', 'cards.csv'));
    expectDualMessage(issue, 'error.pack.cardsNotFound', 'cards.csv');
  });

  it('cards.csv 表头错误 → CARDS_INVALID（error）', async () => {
    const dir = await addDeck('deckA');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'cards.csv'), 'wrong,header\n', 'utf8');
    await ensureObjectsCsv();
    const result = await verify();
    expect(codesOf(result)).toEqual(['CARDS_INVALID']);
    expect(firstIssue(result, 'CARDS_INVALID').severity).toBe('error');
  });

  it('slot 与 card_id 不匹配（card_id 10101 配 slot 2）→ CARD_ID_MISMATCH', async () => {
    const dir = await addDeck('deckA');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'cards.csv'),
      'card_id,face,back,name,nickname,sheet_id,slot,sheet_cols,sheet_rows,sheet_source\n'
        + '10101,card_1.png,,,,1,2,2,3,source/sheet-1.png\n',
      'utf8',
    );
    await ensureObjectsCsv();
    const result = await verify();
    expect(codesOf(result)).toEqual(['CARD_ID_MISMATCH']);
    const issue = firstIssue(result, 'CARD_ID_MISMATCH');
    expect(issue.severity).toBe('error');
    // cards.ts 的 CARDS_SLOT_MISMATCH 语义映射为本模块的 CARD_ID_MISMATCH，message 双态断言
    expect(issue.message === 'error.pack.cardsSlotMismatch' || issue.message.includes('10101')).toBe(true);
  });

  it('card_id=10100（slot 100，%100===0 的 1 基回绕）超出 2x3 容量 → CARDS_SLOT_OUT_OF_RANGE 透传', async () => {
    const dir = await addDeck('deckA');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'cards.csv'),
      'card_id,face,back,name,nickname,sheet_id,slot,sheet_cols,sheet_rows,sheet_source\n'
        + '10100,card_1.png,,,,1,100,2,3,source/sheet-1.png\n',
      'utf8',
    );
    await ensureObjectsCsv();
    const result = await verify();
    expect(codesOf(result)).toEqual(['CARDS_SLOT_OUT_OF_RANGE']);
    const issue = firstIssue(result, 'CARDS_SLOT_OUT_OF_RANGE');
    expect(issue.severity).toBe('error');
    expectDualMessage(issue, 'error.pack.cardsSlotOutOfRange', '100');
  });

  it('单 sheet 卡数超容量（6 行 2x3 + 1 行 10x7 声明）→ DECK_TOO_MANY_CARDS + 声明矛盾', async () => {
    const dir = await addDeck('deckA');
    const rows = [
      ...[1, 2, 3, 4, 5, 6].map((slot) => makeRow({ cardId: 10100 + slot })),
      makeRow({ cardId: 10207, slot: 7, sheetCols: 10, sheetRows: 7, face: 'card_7.png' }),
    ];
    await writeCardsCsv(dir, rows);
    await ensureObjectsCsv();
    const result = await verify({ checkCmyk: false });
    // 容量按最小声明（2x3=6）计 → 超容；行间声明不一致 → ATLAS_GRID_MISMATCH；两者都是 truthy 的问题
    expect(codesOf(result).sort()).toEqual(['ATLAS_GRID_MISMATCH', 'DECK_TOO_MANY_CARDS']);
    expect(firstIssue(result, 'DECK_TOO_MANY_CARDS').severity).toBe('error');
    expect(firstIssue(result, 'DECK_TOO_MANY_CARDS').message).toContain('7 张卡');
  });

  it('卡数超容量是结构检查：checkAtlasSize=false 时仍然报', async () => {
    const dir = await addDeck('deckA');
    const rows = [
      ...[1, 2, 3, 4, 5, 6].map((slot) => makeRow({ cardId: 10100 + slot })),
      makeRow({ cardId: 10207, slot: 7, sheetCols: 10, sheetRows: 7, face: 'card_7.png' }),
    ];
    await writeCardsCsv(dir, rows);
    await ensureObjectsCsv();
    const result = await verify({ checkCmyk: false, checkAtlasSize: false });
    expect(codesOf(result)).toContain('DECK_TOO_MANY_CARDS');
  });

  it('空白格（只用了 slot 1、3）→ DECK_EMPTY_SLOT warning，ok 仍为 true', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 3].map((slot) => makeRow({ cardId: 10100 + slot }));
    await writeCardsCsv(dir, rows);
    await makeAtlas(dir, 1);
    for (const row of rows) {
      await makeCardImage(dir, row.face);
    }
    await ensureObjectsCsv();
    const result = await verify();
    expect(codesOf(result)).toEqual(['DECK_EMPTY_SLOT']);
    const issue = firstIssue(result, 'DECK_EMPTY_SLOT');
    expect(issue.severity).toBe('warning');
    expect(issue.message).toContain('2、4、5、6');
    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(1);
  });
});

describe('卡牌校验：网格一致性与图集存在性', () => {
  it('图集尺寸整除但非方格（96x96 声明 2x3 → 48x32）→ ATLAS_GRID_MISMATCH', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({ cardId: 10100 + slot }));
    await writeCardsCsv(dir, rows);
    await makeAtlas(dir, 1, { width: 96, height: 96 });
    for (const row of rows) {
      await makeCardImage(dir, row.face);
    }
    await ensureObjectsCsv();
    const result = await verify();
    expect(codesOf(result)).toEqual(['ATLAS_GRID_MISMATCH']);
    const issue = firstIssue(result, 'ATLAS_GRID_MISMATCH');
    expect(issue.severity).toBe('error');
    expect(issue.message).toContain('48x32');
    expect(issue.location).toBe(path.join(dir, 'source', 'sheet-1.png'));
  });

  it('图集尺寸不整除（100x100 声明 2x3 → 高度商非整数）→ ATLAS_GRID_MISMATCH', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({ cardId: 10100 + slot }));
    await writeCardsCsv(dir, rows);
    await makeAtlas(dir, 1, { width: 100, height: 100 });
    for (const row of rows) {
      await makeCardImage(dir, row.face);
    }
    await ensureObjectsCsv();
    const result = await verify();
    expect(codesOf(result)).toEqual(['ATLAS_GRID_MISMATCH']);
  });

  it('checkAtlasSize=false → 尺寸不符不报（不读图），其余全通过', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({ cardId: 10100 + slot }));
    await writeCardsCsv(dir, rows);
    await makeAtlas(dir, 1, { width: 96, height: 96 }); // 尺寸不符，但检查被关闭
    for (const row of rows) {
      await makeCardImage(dir, row.face);
    }
    await ensureObjectsCsv();
    const result = await verify({ checkAtlasSize: false });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('checkAtlasSize=false → 图集存在性检查照跑（缺失仍报 SHEET_SOURCE_MISSING）', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({ cardId: 10100 + slot }));
    await writeCardsCsv(dir, rows);
    await ensureObjectsCsv();
    const result = await verify({ checkAtlasSize: false, checkCmyk: false });
    expect(codesOf(result)).toEqual(['SHEET_SOURCE_MISSING']);
    expect(firstIssue(result, 'SHEET_SOURCE_MISSING').severity).toBe('error');
  });

  it('sheet_source 为远程 URL 且无本地副本 → SHEET_SOURCE_MISSING（message 含 source）', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({
      cardId: 10100 + slot,
      sheetSource: 'https://img.example.com/source-101.png',
    }));
    await writeCardsCsv(dir, rows);
    await ensureObjectsCsv();
    const result = await verify({ checkAtlasSize: false, checkCmyk: false });
    expect(codesOf(result)).toEqual(['SHEET_SOURCE_MISSING']);
    expect(firstIssue(result, 'SHEET_SOURCE_MISSING').message).toContain('https://img.example.com/source-101.png');
  });

  it('图集损坏（非图片内容）→ ATLAS_UNREADABLE（error）', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({ cardId: 10100 + slot }));
    await writeCardsCsv(dir, rows);
    for (const row of rows) {
      await makeCardImage(dir, row.face);
    }
    await mkdir(path.join(dir, 'source'), { recursive: true });
    await writeFile(path.join(dir, 'source', 'sheet-1.png'), Buffer.from('not a png'));
    await ensureObjectsCsv();
    const result = await verify();
    expect(codesOf(result)).toEqual(['ATLAS_UNREADABLE']);
    expect(firstIssue(result, 'ATLAS_UNREADABLE').severity).toBe('error');
  });

  it('sheet_source 相对 deckDir 的自定义路径 → 正确解析并通过', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({
      cardId: 10100 + slot,
      sheetSource: 'textures/atlas.png',
    }));
    await writeCardsCsv(dir, rows);
    await makeAtlas(dir, 1, { file: path.join(dir, 'textures', 'atlas.png') });
    for (const row of rows) {
      await makeCardImage(dir, row.face);
    }
    await ensureObjectsCsv();
    const result = await verify();
    expect(result.issues).toEqual([]);
  });

  it('sheet_source 相对 packRoot 的路径 → 第二候选解析并通过', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({
      cardId: 10100 + slot,
      sheetSource: 'assets/common/sheet-1.png',
    }));
    await writeCardsCsv(dir, rows);
    await makeAtlas(dir, 1, { file: path.join(tempRoot, 'assets', 'common', 'sheet-1.png') });
    for (const row of rows) {
      await makeCardImage(dir, row.face);
    }
    await ensureObjectsCsv();
    const result = await verify();
    expect(result.issues).toEqual([]);
  });

  it('sheet_source 为 file: URL → fileURLToPath 解析并通过', async () => {
    const dir = await addDeck('deckA');
    const atlasFile = await makeAtlas(dir, 1, { file: path.join(tempRoot, 'external', 'atlas.png') });
    const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({
      cardId: 10100 + slot,
      sheetSource: pathToFileURL(atlasFile).href,
    }));
    await writeCardsCsv(dir, rows);
    for (const row of rows) {
      await makeCardImage(dir, row.face);
    }
    await ensureObjectsCsv();
    const result = await verify();
    expect(result.issues).toEqual([]);
  });
});

describe('卡牌校验：CMYK 与卡图可读性', () => {
  it('正面卡图是 CMYK → CARD_CMYK（error，location 指向图片）', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({
      cardId: 10100 + slot,
      face: slot === 1 ? 'card_cmyk.jpg' : `card_${slot}.png`,
    }));
    await writeCardsCsv(dir, rows);
    await makeAtlas(dir, 1);
    for (const row of rows) {
      await makeCardImage(dir, row.face, { cmyk: row.face.endsWith('.jpg') });
    }
    await ensureObjectsCsv();
    const result = await verify();
    expect(codesOf(result)).toEqual(['CARD_CMYK']);
    const issue = firstIssue(result, 'CARD_CMYK');
    expect(issue.severity).toBe('error');
    expect(issue.location).toBe(path.join(dir, 'card_cmyk.jpg'));
  });

  it('背面卡图是 CMYK → CARD_CMYK（back 列同样检查，按文件去重只报一条）', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({ cardId: 10100 + slot, back: 'back.jpg' }));
    await writeCardsCsv(dir, rows);
    await makeAtlas(dir, 1);
    for (const row of rows) {
      await makeCardImage(dir, row.face);
    }
    await makeCardImage(dir, 'back.jpg', { cmyk: true });
    await ensureObjectsCsv();
    const result = await verify();
    expect(codesOf(result)).toEqual(['CARD_CMYK']);
    expect(firstIssue(result, 'CARD_CMYK').location).toBe(path.join(dir, 'back.jpg'));
  });

  it('checkCmyk=false → 跳过 CMYK 与卡图存在性检查，其余检查照跑', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({
      cardId: 10100 + slot,
      face: slot === 1 ? 'card_cmyk.jpg' : `card_${slot}.png`,
    }));
    await writeCardsCsv(dir, rows);
    await makeAtlas(dir, 1, { width: 96, height: 96 }); // 尺寸不符 → 网格检查（开着）应报
    // card_2.png..card_6.png 故意不落盘：卡图存在性检查随 CMYK 一起被关闭
    await makeCardImage(dir, 'card_cmyk.jpg', { cmyk: true });
    await ensureObjectsCsv();
    const result = await verify({ checkCmyk: false });
    expect(codesOf(result)).toEqual(['ATLAS_GRID_MISMATCH']);
  });

  it('卡图文件缺失 → CARD_IMAGE_MISSING（warning，可能尚未拉取）', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({ cardId: 10100 + slot }));
    await writeCardsCsv(dir, rows);
    await makeAtlas(dir, 1);
    await makeCardImage(dir, rows[0].face); // 只落盘第 1 张，其余 5 张缺失
    await ensureObjectsCsv();
    const result = await verify();
    expect(codesOf(result)).toEqual([
      'CARD_IMAGE_MISSING', 'CARD_IMAGE_MISSING', 'CARD_IMAGE_MISSING',
      'CARD_IMAGE_MISSING', 'CARD_IMAGE_MISSING',
    ]);
    const issue = firstIssue(result, 'CARD_IMAGE_MISSING');
    expect(issue.severity).toBe('warning');
    expect(result.ok).toBe(true);
  });

  it('卡图损坏 → CARD_IMAGE_UNREADABLE（warning）', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 2, 3, 4, 5, 6].map((slot) => makeRow({ cardId: 10100 + slot }));
    await writeCardsCsv(dir, rows);
    await makeAtlas(dir, 1);
    await makeCardImage(dir, rows[0].face);
    await makeCardImage(dir, rows[1].face, { garbage: true });
    for (let i = 2; i < rows.length; i++) {
      await makeCardImage(dir, rows[i].face);
    }
    await ensureObjectsCsv();
    const result = await verify();
    expect(codesOf(result)).toEqual(['CARD_IMAGE_UNREADABLE']);
    expect(firstIssue(result, 'CARD_IMAGE_UNREADABLE').severity).toBe('warning');
  });
});

// ---------------------------------------------------------------------------
// 多 deck 工作区
// ---------------------------------------------------------------------------

describe('多 deck 工作区与 decks/ 遍历', () => {
  it('多 deck 工作区 → 每个 deck 独立校验，issue 定位到各自的目录', async () => {
    await addCleanDeck('deckA'); // 干净
    await addDeck('deckB', 'BBB222'); // 缺 cards.csv
    const result = await verify();
    expect(codesOf(result)).toEqual(['CARDS_NOT_FOUND']);
    expect(firstIssue(result, 'CARDS_NOT_FOUND').location).toContain(path.join('decks', 'deckB'));
  });

  it('decks/ 下只有 data.json 没有 deck.yaml 的目录 → 静默跳过（坑 5，不告警）', async () => {
    await addCleanDeck('deckA');
    const orphan = path.join(tempRoot, 'decks', 'orphanGUID');
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, 'data.json'), '{"GUID":"zzzzzz"}', 'utf8');
    const result = await verify();
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('deck.yaml 非法（未知字段，strictObject 拒绝）→ DECK_INVALID（error）', async () => {
    const dir = path.join(tempRoot, 'decks', 'deckA');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'deck.yaml'),
      'schema_version: 1\nname: deckA\nguid: AAA111\nunknown_key: oops\n',
      'utf8',
    );
    await ensureObjectsCsv();
    const result = await verify();
    expect(codesOf(result)).toEqual(['DECK_INVALID']);
    const issue = firstIssue(result, 'DECK_INVALID');
    expect(issue.severity).toBe('error');
    expectDualMessage(issue, 'error.pack.deckInvalid', 'unknown_key');
  });

  it('不中断：cards 非法 + 父子不一致 + objects 文件缺失 → 三类 issue 一次返回', async () => {
    const dir = await addDeck('deckA');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'cards.csv'), 'wrong,header\n', 'utf8');
    const spec = baseSpec();
    await writeSkeleton({
      ObjectStates: [deckObject('AAA111', spec, [cardObject('CCC333', { ...spec, FaceURL: 'http://x/other.png' })])],
    });
    await writeObjectsCsv(path.join(tempRoot, 'objects'), [
      { assetId: 'chip01', type: 'chip', file: 'objects/chip.png', source: 'http://x/chip.png' },
    ]);
    const result = await verify();
    const codes = codesOf(result);
    expect(codes).toContain('CARDS_INVALID');
    expect(codes).toContain('PARENT_CHILD_DECK_MISMATCH');
    expect(codes).toContain('OBJECT_FILE_MISSING');
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 第 2 节：存档校验（skeleton.json）
// ---------------------------------------------------------------------------

describe('存档校验：父子 CustomDeck 一致（坑 4 回归）', () => {
  it('无 skeleton.json → 存档校验整段跳过（clean 工作区仍 ok）', async () => {
    await addCleanDeck();
    const result = await verify();
    expect(result.issues).toEqual([]);
  });

  it('父牌堆与每张 Card 的 CustomDeck 深度相等 → 无 PARENT_CHILD_DECK_MISMATCH', async () => {
    await ensureObjectsCsv();
    const spec = baseSpec();
    await writeSkeleton({
      ObjectStates: [deckObject('AAA111', spec, [
        cardObject('CCC333', spec),
        cardObject('CCC334', spec),
      ])],
    });
    const result = await verify();
    expect(result.issues).toEqual([]);
  });

  it('子对象 FaceURL 与父不同 → PARENT_CHILD_DECK_MISMATCH（location 指向子对象路径）', async () => {
    await ensureObjectsCsv();
    const spec = baseSpec();
    await writeSkeleton({
      ObjectStates: [deckObject('AAA111', spec, [
        cardObject('CCC333', { ...spec, FaceURL: 'http://x/other.png' }),
      ])],
    });
    const result = await verify();
    expect(codesOf(result)).toEqual(['PARENT_CHILD_DECK_MISMATCH']);
    const issue = firstIssue(result, 'PARENT_CHILD_DECK_MISMATCH');
    expect(issue.severity).toBe('error');
    expect(issue.location).toBe('ObjectStates[0].ContainedObjects[0]');
    expect(issue.message).toContain('坑 4');
  });

  it('子对象缺 BackURL（快照条数不同）→ PARENT_CHILD_DECK_MISMATCH', async () => {
    await ensureObjectsCsv();
    const spec = baseSpec();
    await writeSkeleton({
      ObjectStates: [deckObject('AAA111', spec, [
        cardObject('CCC333', { ...spec, BackURL: '' }),
      ])],
    });
    const result = await verify();
    expect(codesOf(result)).toEqual(['PARENT_CHILD_DECK_MISMATCH']);
    expect(firstIssue(result, 'PARENT_CHILD_DECK_MISMATCH').message).toContain('条数不同');
  });

  it('URL 全同但 NumWidth 不同 → 仍报（快照覆盖规格对象的全部字段）', async () => {
    await ensureObjectsCsv();
    const spec = baseSpec();
    await writeSkeleton({
      ObjectStates: [deckObject('AAA111', spec, [
        cardObject('CCC333', { ...spec, NumWidth: 5 }),
      ])],
    });
    const result = await verify();
    expect(codesOf(result)).toEqual(['PARENT_CHILD_DECK_MISMATCH']);
    expect(firstIssue(result, 'PARENT_CHILD_DECK_MISMATCH').message).toContain('NumWidth');
  });

  it('两层嵌套：孙辈与中间层不一致 → 报在孙辈路径上', async () => {
    await ensureObjectsCsv();
    const spec = baseSpec();
    const mid = deckObject('MMM222', spec, [cardObject('GGG333', { ...spec, FaceURL: 'http://x/grand.png' })]);
    await writeSkeleton({ ObjectStates: [deckObject('AAA111', spec, [mid])] });
    const result = await verify();
    expect(codesOf(result)).toEqual(['PARENT_CHILD_DECK_MISMATCH']);
    expect(firstIssue(result, 'PARENT_CHILD_DECK_MISMATCH').location)
      .toBe('ObjectStates[0].ContainedObjects[0].ContainedObjects[0]');
  });

  it('States 容器下的对象不参与父子比对（契约只查 ContainedObjects）', async () => {
    await ensureObjectsCsv();
    const spec = baseSpec();
    await writeSkeleton({
      ObjectStates: [{
        GUID: 'AAA111',
        Name: 'Deck',
        CustomDeck: { '101': structuredClone(spec) },
        States: { '1': cardObject('SSS444', { ...spec, FaceURL: 'http://x/state.png' }) },
      }],
    });
    const result = await verify();
    expect(result.issues).toEqual([]);
  });

  it('多张卡只有一张被漏改 → 逐张比对都能抓出', async () => {
    await ensureObjectsCsv();
    const spec = baseSpec();
    await writeSkeleton({
      ObjectStates: [deckObject('AAA111', spec, [
        cardObject('CCC333', spec),
        cardObject('CCC334', { ...spec, BackURL: 'http://x/stale-back.png' }),
        cardObject('CCC335', spec),
      ])],
    });
    const result = await verify();
    expect(codesOf(result)).toEqual(['PARENT_CHILD_DECK_MISMATCH']);
    expect(firstIssue(result, 'PARENT_CHILD_DECK_MISMATCH').location).toBe('ObjectStates[0].ContainedObjects[1]');
  });
});

describe('存档校验：{lang} 完好性与共享图集（坑 5 / 坑 7）', () => {
  it('{lang} 值完好（{en}…{zh-cn}… 成对）→ 无 issue', async () => {
    await ensureObjectsCsv();
    const spec = baseSpec({
      FaceURL: '{en}http://en.png{zh-cn}http://zh.png',
      BackURL: '{en}http://en-back.png{zh-cn}http://zh-back.png',
    });
    await writeSkeleton({
      ObjectStates: [deckObject('AAA111', spec, [cardObject('CCC333', spec)])],
    });
    const result = await verify();
    expect(result.issues).toEqual([]);
  });

  it('{lang} 值被破坏（段后缺 URL）→ LANG_VARIANT_MALFORMED（error）', async () => {
    await ensureObjectsCsv();
    const spec = baseSpec({ FaceURL: '{en}http://a.png{zh-cn}' });
    await writeSkeleton({ ObjectStates: [deckObject('AAA111', spec)] });
    const result = await verify();
    expect(codesOf(result)).toEqual(['LANG_VARIANT_MALFORMED']);
    const issue = firstIssue(result, 'LANG_VARIANT_MALFORMED');
    expect(issue.severity).toBe('error');
    expect(issue.message).toContain('CustomDeck.FaceURL');
  });

  it('普通 URL 中部出现 {lang} 段 → LANG_VARIANT_SUSPECT（warning，不阻塞通过）', async () => {
    await ensureObjectsCsv();
    const spec = baseSpec({ FaceURL: 'http://x/{en}/img.png' });
    await writeSkeleton({ ObjectStates: [deckObject('AAA111', spec)] });
    const result = await verify();
    expect(codesOf(result)).toEqual(['LANG_VARIANT_SUSPECT']);
    expect(firstIssue(result, 'LANG_VARIANT_SUSPECT').severity).toBe('warning');
    expect(result.ok).toBe(true);
  });

  it('共享图集已在 shared_with 声明 → 无 SHARED_ATLAS_NOT_DECLARED', async () => {
    await addDeckWithEmptyCards('deckA', 'AAA111', ['BBB222']);
    await ensureObjectsCsv();
    const spec = baseSpec();
    await writeSkeleton({
      ObjectStates: [
        deckObject('AAA111', spec),
        deckObject('BBB222', spec),
      ],
    });
    const result = await verify();
    expect(result.issues).toEqual([]);
  });

  it('共享图集未声明 → SHARED_ATLAS_NOT_DECLARED（warning，location 指向 deck.yaml）', async () => {
    await addDeckWithEmptyCards('deckA', 'AAA111'); // shared_with 缺省 []
    await ensureObjectsCsv();
    const spec = baseSpec();
    await writeSkeleton({
      ObjectStates: [
        deckObject('AAA111', spec),
        deckObject('BBB222', spec),
      ],
    });
    const result = await verify();
    expect(codesOf(result)).toEqual(['SHARED_ATLAS_NOT_DECLARED']);
    const issue = firstIssue(result, 'SHARED_ATLAS_NOT_DECLARED');
    expect(issue.severity).toBe('warning');
    expect(issue.location).toBe(path.join(tempRoot, 'decks', 'deckA', 'deck.yaml'));
    expect(issue.message).toContain('BBB222');
    expect(result.ok).toBe(true);
  });

  it('共享图集但不存在任何 deck.yaml → 仍告警（location 指向 skeleton）', async () => {
    await ensureObjectsCsv();
    const spec = baseSpec();
    await writeSkeleton({
      ObjectStates: [
        deckObject('AAA111', spec),
        deckObject('BBB222', spec),
      ],
    });
    const result = await verify();
    expect(codesOf(result)).toEqual(['SHARED_ATLAS_NOT_DECLARED']);
    expect(firstIssue(result, 'SHARED_ATLAS_NOT_DECLARED').location)
      .toBe(path.join(tempRoot, '.tts', 'skeleton.json'));
  });

  it('同一 FaceURL 只被一个对象引用（含同对象多图集 key）→ 不算共享', async () => {
    await ensureObjectsCsv();
    const spec = baseSpec();
    const spec2 = baseSpec({ BackURL: 'http://x/back2.png' });
    await writeSkeleton({
      ObjectStates: [{
        GUID: 'AAA111',
        Name: 'Deck',
        CustomDeck: { '101': structuredClone(spec), '102': structuredClone(spec2) },
      }],
    });
    const result = await verify();
    expect(result.issues).toEqual([]);
  });

  it('空串 GUID 的对象共享 FaceURL → 不建索引、不告警（坑 7）', async () => {
    await ensureObjectsCsv();
    const spec = baseSpec();
    await writeSkeleton({
      ObjectStates: [
        deckObject('', spec),
        deckObject('', spec),
      ],
    });
    const result = await verify();
    expect(result.issues).toEqual([]);
  });

  it('GUID 大小写不归一：shared_with 写小写而对象是大写 → 仍告警（精确匹配）', async () => {
    await addDeckWithEmptyCards('deckA', 'AAA111', ['bbb222']);
    await ensureObjectsCsv();
    const spec = baseSpec();
    await writeSkeleton({
      ObjectStates: [
        deckObject('AAA111', spec),
        deckObject('BBB222', spec),
      ],
    });
    const result = await verify();
    expect(codesOf(result)).toEqual(['SHARED_ATLAS_NOT_DECLARED']);
    expect(firstIssue(result, 'SHARED_ATLAS_NOT_DECLARED').message).toContain('BBB222');
  });

  it('skeleton.json 不是合法 JSON → SKELETON_INVALID（error）', async () => {
    await ensureObjectsCsv();
    await mkdir(path.join(tempRoot, '.tts'), { recursive: true });
    await writeFile(path.join(tempRoot, '.tts', 'skeleton.json'), '{oops', 'utf8');
    const result = await verify();
    expect(codesOf(result)).toEqual(['SKELETON_INVALID']);
    expect(firstIssue(result, 'SKELETON_INVALID').severity).toBe('error');
  });

  it('skeleton.json 根是数组 → SKELETON_INVALID（根必须是对象）', async () => {
    await ensureObjectsCsv();
    await writeSkeleton([]);
    const result = await verify();
    expect(codesOf(result)).toEqual(['SKELETON_INVALID']);
  });
});

// ---------------------------------------------------------------------------
// 第 3 节：对象校验（objects/）
// ---------------------------------------------------------------------------

describe('对象校验（objects/）', () => {
  it('objects.csv 合法且 file 引用的文件存在 → 无 issue', async () => {
    await writeObjectsCsv(path.join(tempRoot, 'objects'), [
      { assetId: 'chip01', type: 'chip', file: 'objects/chip.png', source: 'http://x/chip.png' },
    ]);
    await makeCardImage(path.join(tempRoot, 'objects'), 'chip.png');
    const result = await verify();
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('file 引用的文件不存在 → OBJECT_FILE_MISSING（warning，ok 仍 true）', async () => {
    await writeObjectsCsv(path.join(tempRoot, 'objects'), [
      { assetId: 'chip01', type: 'chip', file: 'objects/chip.png', source: 'http://x/chip.png' },
    ]);
    const result = await verify();
    expect(codesOf(result)).toEqual(['OBJECT_FILE_MISSING']);
    const issue = firstIssue(result, 'OBJECT_FILE_MISSING');
    expect(issue.severity).toBe('warning');
    expect(issue.message).toContain('chip01');
    expect(issue.location).toBe(path.join(tempRoot, 'objects', 'chip.png'));
    expect(result.ok).toBe(true);
  });

  it('objects.csv 缺失（objects/ 与根都没有）→ OBJECTS_NOT_FOUND（error）', async () => {
    const result = await verify();
    expect(codesOf(result)).toEqual(['OBJECTS_NOT_FOUND']);
    expect(firstIssue(result, 'OBJECTS_NOT_FOUND').severity).toBe('error');
    expectDualMessage(firstIssue(result, 'OBJECTS_NOT_FOUND'), 'error.objects.notFound', 'objects.csv');
  });

  it('objects.csv 在图包根（而非 objects/ 目录）→ 兜底解析也能读到', async () => {
    await writeObjectsCsv(tempRoot, [
      { assetId: 'chip01', type: 'chip', file: 'assets/chip.png', source: 'http://x/chip.png' },
    ]);
    await makeCardImage(path.join(tempRoot, 'assets'), 'chip.png');
    const result = await verify();
    expect(result.issues).toEqual([]);
  });

  it('objects.csv 表头非法 → OBJECTS_INVALID（error）', async () => {
    const dir = path.join(tempRoot, 'objects');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'objects.csv'), 'asset_id,name\n', 'utf8');
    const result = await verify();
    expect(codesOf(result)).toEqual(['OBJECTS_INVALID']);
    const issue = firstIssue(result, 'OBJECTS_INVALID');
    expect(issue.severity).toBe('error');
    expectDualMessage(issue, 'error.objects.invalid', '表头');
  });
});

// ---------------------------------------------------------------------------
// 汇总统计
// ---------------------------------------------------------------------------

describe('VerifyResult 汇总', () => {
  it('errorCount / warningCount / ok 与 issues 一致（混合场景）', async () => {
    const dir = await addDeck('deckA');
    const rows = [1, 3].map((slot) => makeRow({ cardId: 10100 + slot }));
    await writeCardsCsv(dir, rows); // 空 4 格 → 1 warning
    await makeAtlas(dir, 1, { width: 96, height: 96 }); // 网格不符 → 1 error
    for (const row of rows) {
      await makeCardImage(dir, row.face);
    }
    await ensureObjectsCsv();
    const result = await verify();
    expect(result.errorCount).toBe(1);
    expect(result.warningCount).toBe(1);
    expect(result.issues).toHaveLength(2);
    expect(result.ok).toBe(false);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toHaveLength(result.errorCount);
    expect(result.issues.filter((issue) => issue.severity === 'warning')).toHaveLength(result.warningCount);
  });

  it('packRoot 为空字符串 → 抛普通中文 Error（调用方编程错误）', async () => {
    await expect(verifyPack({ packRoot: '' })).rejects.toThrow('packRoot');
  });
});
