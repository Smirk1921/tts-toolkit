// tests/unit/deck-slice.test.ts
/**
 * src/deck/slice.ts 单元测试：图集切片（归属解析 + 共享检测 + sharp 切片 + cards.csv）。
 *
 * 覆盖维度：
 * - 正常路径：文件名反推 / 宽高比匹配 / 显式 deckKey、deckGuid、guid+key；
 *   共享图集（2~3 个 CustomDeck 引用同一 FaceURL → selector 选择 → sharedWith）；
 *   UniqueBack=false（共用 back.png，含 BackURL==FaceURL 取最后一格、本地背面文件、
 *   本地缺失降级）；UniqueBack=true（按 slot 切 back-XXX.png，同图集与独立背面图集）；
 *   无 BackURL（back 列空）；隐藏面（69/70 → 不切 slot 70、csv 不写该行）；
 *   不同网格（10x7 / 5x5 / 3x5 / 1x1）、非整除余数吸收（最后一列/行吞掉余数像素）；
 *   嵌套容器（ChildObjects / States / AttachedDecals）遍历 + 卡牌副本折叠；
 * - 异常路径：按 PackError.code 断言（不依赖文案——locales 未补键时 t() 原样输出
 *   键名，补齐后含摘要，message 断言写成双态）：SLICE_SHEET_NOT_FOUND /
 *   SLICE_SAVE_INVALID / SLICE_ORPHAN_ATLAS / SLICE_AMBIGUOUS /
 *   SLICE_DECK_NOT_FOUND / SLICE_GRID_MISMATCH / SLICE_IMAGE_INVALID（CMYK、损坏图）；
 * - 边界值：1 基 slot（card-001.png 起、slot 70 收尾）、空 GUID 对象跳过、
 *   DeckIDs 非连续 / 跨图集块 / 重复 slot / 非法 CardID / 超容量 slot、
 *   selector 返回候选之外的对象、校验先行（失败时不产出任何文件）。
 *
 * 夹具：图集 PNG 全部用 sharp 在临时目录现场合成（每格纯色、颜色由 (col,row) 决定，
 * 切片结果用 raw 像素回读断言）；存档 JSON 内联构造（含卡牌副本等真实存档形态）。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readCardsCsv } from '../../src/deck/cards.js';
import { sanitizeAtlasUrl, sliceAtlas, type DeckCandidate } from '../../src/deck/slice.js';
import { PackError } from '../../src/pack/packyaml.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-deck-slice-'));
  selectorMustNotBeCalled.mockClear();
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具：图集合成（每格纯色，颜色由 (col,row) 决定，可精确回读断言）
// ---------------------------------------------------------------------------

/** 默认格子配色：cols≤10、rows≤10 时各通道不越界，且 (col,row) → 颜色一一对应 */
function cellColor(col: number, row: number): { r: number; g: number; b: number } {
  return { r: 10 + col * 23, g: 10 + row * 24, b: 100 + col * 7 + row * 5 };
}

/** 由 1 基 slot 反推期望颜色（行优先：左→右、上→下） */
function expectedColor(slot: number, cols: number): { r: number; g: number; b: number } {
  const index = slot - 1;
  return cellColor(index % cols, Math.floor(index / cols));
}

interface SheetSpec {
  /** 网格列数 */
  cols: number;
  /** 网格行数 */
  rows: number;
  /** 图片总宽（缺省 cols × cellW） */
  width?: number;
  /** 图片总高（缺省 rows × cellH） */
  height?: number;
  /** 格子宽（缺省 100） */
  cellW?: number;
  /** 格子高（缺省 140，≈TTS 竖卡 5:7） */
  cellH?: number;
  /** 自定义配色（如独立背面图集用不同颜色区分） */
  colorFn?: (col: number, row: number) => { r: number; g: number; b: number };
}

/**
 * 在 dir 下合成一张 cols×rows 网格的图集 PNG。
 * 余数吸收与 slice 的 slotToRect 同规则：整除余数归最后一列/最后一行。
 */
async function writeSheet(dir: string, fileName: string, spec: SheetSpec): Promise<string> {
  const cellW = spec.cellW ?? 100;
  const cellH = spec.cellH ?? 140;
  const width = spec.width ?? spec.cols * cellW;
  const height = spec.height ?? spec.rows * cellH;
  const colorFn = spec.colorFn ?? cellColor;
  const colW = Math.floor(width / spec.cols);
  const rowH = Math.floor(height / spec.rows);
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (let col = 0; col < spec.cols; col++) {
    for (let row = 0; row < spec.rows; row++) {
      const left = col * colW;
      const top = row * rowH;
      const w = col === spec.cols - 1 ? width - left : colW;
      const h = row === spec.rows - 1 ? height - top : rowH;
      const { r, g, b } = colorFn(col, row);
      composites.push({
        input: await sharp({
          create: { width: w, height: h, channels: 3, background: { r, g, b } },
        }).png().toBuffer(),
        left,
        top,
      });
    }
  }
  const filePath = path.join(dir, fileName);
  await sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite(composites as never)
    .png()
    .toFile(filePath);
  return filePath;
}

/** 回读图片第一个像素的 RGB（PNG 无损，首像素即该格纯色） */
async function firstPixel(filePath: string): Promise<[number, number, number]> {
  const { data } = await sharp(filePath).raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
}

/** 回读图片尺寸 */
async function imageSize(filePath: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(filePath).metadata();
  return { width: meta.width as number, height: meta.height as number };
}

/** 合成一张 CMYK JPEG（sharp 只能写 sRGB，先建 PNG 再转色彩空间） */
async function writeCmykJpeg(dir: string, fileName: string): Promise<string> {
  const srgb = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer();
  const cmyk = await sharp(srgb).toColorspace('cmyk').jpeg().toBuffer();
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, cmyk);
  return filePath;
}

// ---------------------------------------------------------------------------
// 夹具：存档 JSON
// ---------------------------------------------------------------------------

/** 构造一个 CustomDeck 条目（真实存档字段形态） */
function deckEntry(faceUrl: string, opts: {
  backUrl?: string;
  numWidth?: number;
  numHeight?: number;
  uniqueBack?: boolean;
} = {}): Record<string, unknown> {
  return {
    FaceURL: faceUrl,
    BackURL: opts.backUrl ?? '',
    NumWidth: opts.numWidth ?? 10,
    NumHeight: opts.numHeight ?? 7,
    UniqueBack: opts.uniqueBack ?? false,
    Type: 0,
  };
}

/** 满配 DeckIDs：key 块内 slot 1..count（1 基，CardID = key*100 + slot） */
function fullDeckIds(key: string, count: number): number[] {
  const base = Number(key) * 100;
  return Array.from({ length: count }, (_, i) => base + i + 1);
}

interface DeckSpec {
  guid: string;
  nickname?: string;
  key: string;
  faceUrl: string;
  backUrl?: string;
  numWidth?: number;
  numHeight?: number;
  uniqueBack?: boolean;
  /** 缺省 = 字段不出现（散卡语义：切全部格子） */
  deckIds?: number[];
  /** ContainedObjects 里放几张携带 CustomDeck 副本的卡（默认 0） */
  cardCopies?: number;
  /** 额外字段（如 States / AttachedDecals 由调用方自行拼装） */
  extra?: Record<string, unknown>;
}

/** 构造一个卡堆对象（含 cardCopies 张携带 CustomDeck 深拷贝的卡——坑 4 层面一形态） */
function makeDeck(spec: DeckSpec): Record<string, unknown> {
  const entry = deckEntry(spec.faceUrl, {
    backUrl: spec.backUrl,
    numWidth: spec.numWidth,
    numHeight: spec.numHeight,
    uniqueBack: spec.uniqueBack,
  });
  const obj: Record<string, unknown> = {
    GUID: spec.guid,
    Name: 'Deck',
    Nickname: spec.nickname ?? '',
    CustomDeck: { [spec.key]: entry },
    ContainedObjects: [] as unknown[],
    ...(spec.extra ?? {}),
  };
  if (spec.deckIds !== undefined) {
    obj.DeckIDs = spec.deckIds;
  }
  for (let i = 0; i < (spec.cardCopies ?? 0); i++) {
    (obj.ContainedObjects as unknown[]).push({
      GUID: `${spec.guid}-c${i}`,
      Name: 'Card',
      Nickname: '',
      CustomDeck: JSON.parse(JSON.stringify({ [spec.key]: entry })) as Record<string, unknown>,
    });
  }
  return obj;
}

/** 写存档 JSON */
async function writeSave(objects: Record<string, unknown>[]): Promise<string> {
  const filePath = path.join(tempRoot, `save-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(filePath, JSON.stringify({ SaveName: '测试存档', ObjectStates: objects }), 'utf8');
  return filePath;
}

/** 写一份非法文本（存档解析失败用） */
async function writeGarbageSave(): Promise<string> {
  const filePath = path.join(tempRoot, 'save-broken.json');
  await writeFile(filePath, '{ This is not JSON !!!', 'utf8');
  return filePath;
}

/**
 * 按 URL 约定命名图集文件（文件名反推路径用）。
 * URL 自带图片扩展名时 sanitize 结果已含扩展名，不再追加。
 */
function sheetNameFor(url: string, ext = '.png'): string {
  const base = sanitizeAtlasUrl(url);
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(base) ? base : base + ext;
}

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

/**
 * 断言 fn 抛出指定 code 的 PackError，并返回该错误。
 * 按 .code 断言（文案因 locales 未补齐 / 已补齐而不同，不直接断言 message）。
 */
async function expectSliceError(fn: () => Promise<unknown>, code: string): Promise<PackError> {
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

/** 一调用就失败的 selector（用于证明"没有走到多候选分支"） */
const selectorMustNotBeCalled = vi.fn(async (_candidates: DeckCandidate[]): Promise<DeckCandidate> => {
  throw new Error('selector 不应被调用');
});

/** 常用图集 URL / GUID / 网格 */
const FACE_URL = 'https://i.imgur.com/deckA.png';
const BACK_URL = 'https://i.imgur.com/backB.png';
const KEY = '101';
const OUT = (): string => path.join(tempRoot, 'out');

// ---------------------------------------------------------------------------
// sanitizeAtlasUrl：URL → 文件名基名（文件名反推的另一半）
// ---------------------------------------------------------------------------

describe('sanitizeAtlasUrl', () => {
  it('剥协议头、非法字符替换为下划线，正反一致（slice 与夹具共用同一约定）', () => {
    expect(sanitizeAtlasUrl('https://i.imgur.com/deckA.png')).toBe('i.imgur.com_deckA.png');
    expect(sanitizeAtlasUrl(FACE_URL)).toBe('i.imgur.com_deckA.png');
  });

  it('超长截断到 120、尾部点删除、query 一并净化（尾部下划线是合法文件名字符，保留）', () => {
    const long = `https://cloud.githubusercontent.com/${'x'.repeat(200)}.png`;
    const sanitized = sanitizeAtlasUrl(long);
    expect(sanitized.length).toBe(120);
    expect(sanitizeAtlasUrl('https://x.com/a/b/')).toBe('x.com_a_b_');
    expect(sanitizeAtlasUrl('https://x.com/p?q=1&token=ab#c')).toBe('x.com_p_q_1_token_ab_c');
  });
});

// ---------------------------------------------------------------------------
// 归属解析：自动（文件名反推 → 宽高比匹配 → 多候选 / 孤儿）
// ---------------------------------------------------------------------------

describe('归属解析：自动', () => {
  it('文件名反推 URL：单 deck（含 5 张卡副本）自动选中，selector 不被调用，deck 字段正确', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', nickname: '甲牌堆', key: KEY, faceUrl: FACE_URL,
      numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70), cardCopies: 5,
    })]);
    const result = await sliceAtlas({
      sheetPath: sheet, savePath: save, outDir: OUT(), selectCandidate: selectorMustNotBeCalled,
    });
    expect(result.deck).toEqual({
      guid: 'AAA111', nickname: '甲牌堆', deckKey: KEY, faceUrl: FACE_URL,
      numWidth: 10, numHeight: 7, uniqueBack: false,
    });
    expect(result.cardsSliced).toBe(70);
    expect(result.sharedWith).toEqual([]);
    expect(selectorMustNotBeCalled).not.toHaveBeenCalled();
  });

  it('文件名匹配大小写不敏感、扩展名不计入比较', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL, '.PNG'), { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    expect(result.deck.guid).toBe('AAA111');
  });

  it('文件名反推失败 → 退到宽高比 + 网格匹配（唯一命中即自动选）', async () => {
    const sheet = await writeSheet(tempRoot, 'unknown-sheet.png', { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    expect(result.deck.guid).toBe('AAA111');
  });

  it('孤儿图集：文件名不匹配且网格与任何 deck 都不匹配 → SLICE_ORPHAN_ATLAS，不产出 cards.csv', async () => {
    // 400x700 配 10x7 → 单格 40x100（比例 0.4），几何上说不通 → 不命中任何 deck
    const sheet = await writeSheet(tempRoot, 'unknown-sheet.png', { cols: 10, rows: 7, width: 400, height: 700 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    const err = await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() }),
      'SLICE_ORPHAN_ATLAS',
    );
    expect(err.message === 'error.pack.sliceOrphanAtlas' || err.message.includes('unknown-sheet.png')).toBe(true);
    expect(existsSync(path.join(OUT(), 'cards.csv'))).toBe(false);
  });

  it('孤儿图集：存档没有任何 CustomDeck → SLICE_ORPHAN_ATLAS', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const save = await writeSave([{ GUID: 'ZZZ999', Name: 'Deck', Nickname: '无图集' }]);
    await expectSliceError(() => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() }), 'SLICE_ORPHAN_ATLAS');
  });

  it('空 GUID 的 deck 不建索引（坑 7）：只有空 GUID deck 引用该 URL → SLICE_ORPHAN_ATLAS', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: '', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    await expectSliceError(() => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() }), 'SLICE_ORPHAN_ATLAS');
  });

  it('卡牌副本被折叠（坑 4 层面一）：候选唯一（否则会走到 selector 并失败）', async () => {
    // 若 5 张卡的 CustomDeck 副本没有被折叠成 deck 本体，候选数 = 6 → selector 被调用 → 用例失败
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70), cardCopies: 5,
    })]);
    const result = await sliceAtlas({
      sheetPath: sheet, savePath: save, outDir: OUT(), selectCandidate: selectorMustNotBeCalled,
    });
    expect(result.cardsSliced).toBe(70);
  });

  it('嵌套容器（ChildObjects / States / AttachedDecals）里的 deck 仍能找到（坑 4 层面二）', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 5, rows: 5 });
    const deck = makeDeck({
      guid: 'AAA111', key: '1', faceUrl: FACE_URL, numWidth: 5, numHeight: 5, deckIds: fullDeckIds('1', 25), cardCopies: 2,
    });
    const save = await writeSave([
      { GUID: 'BBB222', Name: 'Bag', ChildObjects: [deck] },
      { GUID: 'CCC333', Name: 'Deck', States: { '2': makeDeck({ guid: 'DDD444', key: '9', faceUrl: 'https://x.com/other.png', numWidth: 1, numHeight: 1 }) } },
      { GUID: 'EEE555', Name: 'Board', AttachedDecals: [makeDeck({ guid: 'FFF666', key: '3', faceUrl: 'https://x.com/other2.png', numWidth: 1, numHeight: 1 })] },
    ]);
    const result = await sliceAtlas({
      sheetPath: sheet, savePath: save, outDir: OUT(), selectCandidate: selectorMustNotBeCalled,
    });
    expect(result.deck.guid).toBe('AAA111');
    expect(result.cardsSliced).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// 归属解析：显式 deckKey / deckGuid / 多候选
// ---------------------------------------------------------------------------

describe('归属解析：显式与多候选', () => {
  it('显式 deckKey：文件名无关也能选中，selector 不被调用', async () => {
    const sheet = await writeSheet(tempRoot, 'whatever-sheet.png', { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    const result = await sliceAtlas({
      sheetPath: sheet, savePath: save, outDir: OUT(), deckKey: KEY, selectCandidate: selectorMustNotBeCalled,
    });
    expect(result.deck.guid).toBe('AAA111');
    expect(result.deck.deckKey).toBe(KEY);
  });

  it('显式 deckGuid：单条目 deck 直接选中', async () => {
    const sheet = await writeSheet(tempRoot, 'whatever-sheet.png', { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    const result = await sliceAtlas({
      sheetPath: sheet, savePath: save, outDir: OUT(), deckGuid: 'AAA111', selectCandidate: selectorMustNotBeCalled,
    });
    expect(result.deck.guid).toBe('AAA111');
  });

  it('显式 guid + key：多图集牌堆里精确选中该 key 的图集（key 102 不碰 101）', async () => {
    const sheet101 = await writeSheet(tempRoot, sheetNameFor('https://x.com/s101.png'), { cols: 10, rows: 7 });
    const deck = makeDeck({ guid: 'AAA111', key: '101', faceUrl: 'https://x.com/s101.png', numWidth: 10, numHeight: 7 });
    deck.CustomDeck = {
      '101': deckEntry('https://x.com/s101.png', { numWidth: 10, numHeight: 7 }),
      '102': deckEntry('https://x.com/s102.png', { numWidth: 5, numHeight: 5 }),
    };
    deck.DeckIDs = [...fullDeckIds('101', 70), ...fullDeckIds('102', 25)];
    const save = await writeSave([deck]);

    const result = await sliceAtlas({
      sheetPath: sheet101, savePath: save, outDir: OUT(), deckGuid: 'AAA111', deckKey: '101',
      selectCandidate: selectorMustNotBeCalled,
    });
    expect(result.deck.deckKey).toBe('101');
    expect(result.cardsSliced).toBe(70);
  });

  it('显式 guid + 错误 key → SLICE_DECK_NOT_FOUND', async () => {
    const sheet = await writeSheet(tempRoot, 'whatever-sheet.png', { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    const err = await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT(), deckGuid: 'AAA111', deckKey: '999' }),
      'SLICE_DECK_NOT_FOUND',
    );
    expect(err.message === 'error.pack.sliceDeckNotFound' || err.message.includes('999')).toBe(true);
  });

  it('显式 guid 不存在 → SLICE_DECK_NOT_FOUND', async () => {
    const sheet = await writeSheet(tempRoot, 'whatever-sheet.png', { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT(), deckGuid: 'NOPE00' }),
      'SLICE_DECK_NOT_FOUND',
    );
  });

  it('显式 key 不存在 → SLICE_DECK_NOT_FOUND', async () => {
    const sheet = await writeSheet(tempRoot, 'whatever-sheet.png', { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT(), deckKey: '777' }),
      'SLICE_DECK_NOT_FOUND',
    );
  });

  it('多候选（两副牌堆都有 key "1"）+ selector → 选中的是候选之一；无 selector → SLICE_AMBIGUOUS', async () => {
    const sheet = await writeSheet(tempRoot, 'whatever-sheet.png', { cols: 10, rows: 7 });
    const save = await writeSave([
      makeDeck({ guid: 'AAA111', nickname: '甲', key: '1', faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds('1', 70) }),
      makeDeck({ guid: 'BBB222', nickname: '乙', key: '1', faceUrl: 'https://i.imgur.com/deckB.png', numWidth: 10, numHeight: 7, deckIds: fullDeckIds('1', 70) }),
    ]);
    const seen: DeckCandidate[][] = [];
    const result = await sliceAtlas({
      sheetPath: sheet, savePath: save, outDir: OUT(), deckKey: '1',
      selectCandidate: async (candidates) => {
        seen.push(candidates);
        return candidates[1];
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].map((c) => c.guid)).toEqual(['AAA111', 'BBB222']);
    expect(result.deck.guid).toBe('BBB222');

    await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT(), deckKey: '1' }),
      'SLICE_AMBIGUOUS',
    );
  });

  it('selector 返回候选之外的对象 → 普通 Error（调用方编程错误）', async () => {
    const sheet = await writeSheet(tempRoot, 'whatever-sheet.png', { cols: 10, rows: 7 });
    const save = await writeSave([
      makeDeck({ guid: 'AAA111', key: '1', faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds('1', 70) }),
      makeDeck({ guid: 'BBB222', key: '1', faceUrl: 'https://i.imgur.com/deckB.png', numWidth: 10, numHeight: 7, deckIds: fullDeckIds('1', 70) }),
    ]);
    await expect(
      sliceAtlas({
        sheetPath: sheet, savePath: save, outDir: OUT(), deckKey: '1',
        selectCandidate: async () => ({ guid: 'ZZZ999', deckKey: '1', faceUrl: 'https://x.com/nope.png', numWidth: 10, numHeight: 7, uniqueBack: false }),
      }),
    ).rejects.toThrow(/selectCandidate/);
  });
});

// ---------------------------------------------------------------------------
// 共享检测
// ---------------------------------------------------------------------------

describe('共享检测', () => {
  it('共享图集：2 个 CustomDeck 引用同一 FaceURL → 列候选 → selector 选一个 → sharedWith 含另一个 GUID', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const save = await writeSave([
      makeDeck({ guid: 'AAA111', nickname: '甲', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70) }),
      makeDeck({ guid: 'BBB222', nickname: '乙', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70) }),
    ]);
    const result = await sliceAtlas({
      sheetPath: sheet, savePath: save, outDir: OUT(),
      selectCandidate: async (candidates) => candidates[1],
    });
    expect(result.deck.guid).toBe('BBB222');
    expect(result.sharedWith).toEqual(['AAA111']);
  });

  it('3 个 deck 共享同一 FaceURL → 选中中间一个 → sharedWith 按遍历序含另外两个 GUID', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const save = await writeSave([
      makeDeck({ guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70) }),
      makeDeck({ guid: 'BBB222', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70) }),
      makeDeck({ guid: 'CCC333', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70) }),
    ]);
    const result = await sliceAtlas({
      sheetPath: sheet, savePath: save, outDir: OUT(),
      selectCandidate: async (candidates) => candidates[1],
    });
    expect(result.sharedWith).toEqual(['AAA111', 'CCC333']);
  });

  it('URL 只出现在别家 BackURL 的 deck 不进 sharedWith（只认 FaceURL）', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const save = await writeSave([
      makeDeck({ guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70) }),
      makeDeck({ guid: 'BBB222', key: '5', faceUrl: 'https://i.imgur.com/other.png', backUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds('5', 70) }),
    ]);
    const result = await sliceAtlas({
      sheetPath: sheet, savePath: save, outDir: OUT(), deckGuid: 'AAA111',
    });
    expect(result.sharedWith).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 网格与切片（1 基 slot、余数吸收、GRID_MISMATCH）
// ---------------------------------------------------------------------------

describe('网格与切片', () => {
  it('10x7 满配 70 张：slot 1（左上）与 slot 70（右下）像素与图集格子一一对应（1 基、行优先）', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    expect(result.cardFiles).toHaveLength(70);
    expect(result.cardFiles[0]).toBe('card-001.png');
    expect(result.cardFiles[69]).toBe('card-070.png');
    const out = OUT();
    expect(await firstPixel(path.join(out, 'card-001.png'))).toEqual([
      expectedColor(1, 10).r, expectedColor(1, 10).g, expectedColor(1, 10).b,
    ]);
    expect(await firstPixel(path.join(out, 'card-070.png'))).toEqual([
      expectedColor(70, 10).r, expectedColor(70, 10).g, expectedColor(70, 10).b,
    ]);
    // 中间格抽查：slot 12 → col 1, row 1（0 基），即第二行第二格
    expect(await firstPixel(path.join(out, 'card-012.png'))).toEqual([
      expectedColor(12, 10).r, expectedColor(12, 10).g, expectedColor(12, 10).b,
    ]);
    const dims = await imageSize(path.join(out, 'card-005.png'));
    expect(dims).toEqual({ width: 100, height: 140 });
  });

  it('5x5 网格切 25 张；3x5 网格切 15 张（网格不是固定 10x7）', async () => {
    for (const [cols, rows, count] of [[5, 5, 25], [3, 5, 15]] as const) {
      const dir = path.join(tempRoot, `grid-${cols}x${rows}`);
      await mkdir(dir, { recursive: true });
      const url = `https://i.imgur.com/g${cols}${rows}.png`;
      const sheet = await writeSheet(tempRoot, sheetNameFor(url), { cols, rows });
      const save = await writeSave([makeDeck({
        guid: 'AAA111', key: '1', faceUrl: url, numWidth: cols, numHeight: rows, deckIds: fullDeckIds('1', count),
      })]);
      const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: dir });
      expect(result.cardsSliced).toBe(count);
      expect(result.cardFiles[count - 1]).toBe(`card-${String(count).padStart(3, '0')}.png`);
      expect(await firstPixel(path.join(dir, result.cardFiles[count - 1]))).toEqual([
        expectedColor(count, cols).r, expectedColor(count, cols).g, expectedColor(count, cols).b,
      ]);
    }
  });

  it('1x1 单卡（横图 200x100）豁免几何校验，整图切为 card-001.png', async () => {
    const sheet = await writeSheet(tempRoot, 'single-card.png', { cols: 1, rows: 1, cellW: 200, cellH: 100 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: '1', faceUrl: 'https://i.imgur.com/single.png', numWidth: 1, numHeight: 1,
    })]);
    const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    expect(result.cardsSliced).toBe(1);
    expect(result.cardFiles).toEqual(['card-001.png']);
    expect(await imageSize(path.join(OUT(), 'card-001.png'))).toEqual({ width: 200, height: 100 });
  });

  it('非整除余数吸收：1005x983 配 10x7 → 最后一列 105px、最后一行 143px', async () => {
    // 1005/10=100 余 5；983/7=140 余 3 → 最后一列宽 105、最后一行高 143
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7, width: 1005, height: 983 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    const out = OUT();
    expect(await imageSize(path.join(out, 'card-001.png'))).toEqual({ width: 100, height: 140 });
    expect(await imageSize(path.join(out, 'card-010.png'))).toEqual({ width: 105, height: 140 });
    expect(await imageSize(path.join(out, 'card-064.png'))).toEqual({ width: 100, height: 143 });
    expect(await imageSize(path.join(out, 'card-070.png'))).toEqual({ width: 105, height: 143 });
  });

  it('格子横宽（正方形图 + 5x7，单格 1.4）→ SLICE_GRID_MISMATCH', async () => {
    const sheet = await writeSheet(tempRoot, 'square.png', { cols: 7, rows: 7, cellW: 100, cellH: 100 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: '1', faceUrl: 'https://i.imgur.com/square.png', numWidth: 5, numHeight: 7, deckIds: fullDeckIds('1', 35),
    })]);
    const err = await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT(), deckGuid: 'AAA111' }),
      'SLICE_GRID_MISMATCH',
    );
    expect(err.message === 'error.pack.sliceGridMismatch' || err.message.includes('5')).toBe(true);
  });

  it('格子过扁（正方形图 + 10x1，单格 0.1）→ SLICE_GRID_MISMATCH', async () => {
    const sheet = await writeSheet(tempRoot, 'square.png', { cols: 10, rows: 10, cellW: 100, cellH: 100 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: '1', faceUrl: 'https://i.imgur.com/square.png', numWidth: 10, numHeight: 1, deckIds: fullDeckIds('1', 10),
    })]);
    await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT(), deckGuid: 'AAA111' }),
      'SLICE_GRID_MISMATCH',
    );
  });

  it('校验先行：GRID_MISMATCH 时不创建输出目录、不产出任何文件', async () => {
    const sheet = await writeSheet(tempRoot, 'square.png', { cols: 7, rows: 7, cellW: 100, cellH: 100 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: '1', faceUrl: 'https://i.imgur.com/square.png', numWidth: 5, numHeight: 7, deckIds: fullDeckIds('1', 35),
    })]);
    const out = path.join(tempRoot, 'never-created');
    await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: out, deckGuid: 'AAA111' }),
      'SLICE_GRID_MISMATCH',
    );
    expect(existsSync(out)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DeckIDs 与 slot（1 基裁决、跨图集块、脏数据）
// ---------------------------------------------------------------------------

describe('DeckIDs 与 slot', () => {
  it('DeckIDs 非连续（[10103, 10107]）→ 只切这 2 格，card_id 用 DeckID 原值', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: [10103, 10107],
    })]);
    const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    expect(result.cardFiles).toEqual(['card-003.png', 'card-007.png']);
    const rows = await readCardsCsv(OUT());
    expect(rows.map((row) => row.cardId)).toEqual([10103, 10107]);
    expect(rows.map((row) => row.slot)).toEqual([3, 7]);
  });

  it('多图集牌堆：DeckIDs 含 101 与 102 两个块 → 切 key 101 时只切 101 块的 70 张', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor('https://x.com/s101.png'), { cols: 10, rows: 7 });
    const deck = makeDeck({ guid: 'AAA111', key: '101', faceUrl: 'https://x.com/s101.png', numWidth: 10, numHeight: 7 });
    deck.CustomDeck = {
      '101': deckEntry('https://x.com/s101.png', { numWidth: 10, numHeight: 7 }),
      '102': deckEntry('https://x.com/s102.png', { numWidth: 5, numHeight: 5 }),
    };
    deck.DeckIDs = [...fullDeckIds('101', 70), ...fullDeckIds('102', 25)];
    const save = await writeSave([deck]);
    const result = await sliceAtlas({
      sheetPath: sheet, savePath: save, outDir: OUT(), deckKey: '101', selectCandidate: selectorMustNotBeCalled,
    });
    expect(result.cardsSliced).toBe(70);
    expect(result.cardFiles).not.toContain('card-071.png');
    const rows = await readCardsCsv(OUT());
    expect(rows.every((row) => row.cardId >= 10101 && row.cardId <= 10170)).toBe(true);
  });

  it('DeckIDs 全部属于其他图集块 → SLICE_SAVE_INVALID（声明与数据矛盾）', async () => {
    const sheet = await writeSheet(tempRoot, 'whatever.png', { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: '101', faceUrl: 'https://x.com/s101.png', numWidth: 10, numHeight: 7, deckIds: fullDeckIds('102', 70),
    })]);
    await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT(), deckKey: '101' }),
      'SLICE_SAVE_INVALID',
    );
  });

  it('DeckIDs 两条 CardID 指向同一 slot → SLICE_SAVE_INVALID', async () => {
    const sheet = await writeSheet(tempRoot, 'whatever.png', { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: [10103, 10103],
    })]);
    await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT(), deckKey: KEY }),
      'SLICE_SAVE_INVALID',
    );
  });

  it('DeckIDs 含非法 CardID（0 / 负数）→ SLICE_SAVE_INVALID', async () => {
    const sheet = await writeSheet(tempRoot, 'whatever.png', { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: [10101, 0],
    })]);
    await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT(), deckKey: KEY }),
      'SLICE_SAVE_INVALID',
    );
  });

  it('DeckIDs 的 slot 超出图集容量（10180 配 10x7）→ SLICE_SAVE_INVALID', async () => {
    const sheet = await writeSheet(tempRoot, 'whatever.png', { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: [10180],
    })]);
    await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT(), deckKey: KEY }),
      'SLICE_SAVE_INVALID',
    );
  });
});

// ---------------------------------------------------------------------------
// 正反面（坑 5：先判断 UniqueBack 再切；隐藏面）
// ---------------------------------------------------------------------------

describe('正反面', () => {
  it('UniqueBack=false + BackURL==FaceURL + 满配 70：back.png 用图集最后一格，每行 back=back.png', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, backUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    expect(result.backFiles).toEqual(['back.png']);
    expect(await firstPixel(path.join(OUT(), 'back.png'))).toEqual([
      expectedColor(70, 10).r, expectedColor(70, 10).g, expectedColor(70, 10).b,
    ]);
    const rows = await readCardsCsv(OUT());
    expect(rows).toHaveLength(70);
    expect(rows.every((row) => row.back === 'back.png')).toBe(true);
  });

  it('隐藏面（10x7 且 DeckIDs=69）：不切 slot 70、cards.csv 无该行，back.png 仍是最后一格', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, backUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 69),
    })]);
    const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    expect(result.cardsSliced).toBe(69);
    expect(result.cardFiles).not.toContain('card-070.png');
    expect(existsSync(path.join(OUT(), 'card-070.png'))).toBe(false);
    expect(await firstPixel(path.join(OUT(), 'back.png'))).toEqual([
      expectedColor(70, 10).r, expectedColor(70, 10).g, expectedColor(70, 10).b,
    ]);
    const rows = await readCardsCsv(OUT());
    expect(rows).toHaveLength(69);
    expect(rows.some((row) => row.slot === 70 || row.cardId === 10170)).toBe(false);
    expect(rows.every((row) => row.back === 'back.png')).toBe(true);
  });

  it('UniqueBack=false + BackURL≠FaceURL + 本地背面文件存在 → back.png 为背面整图（原样尺寸）', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const backColor = { r: 200, g: 30, b: 40 };
    await sharp({
      create: { width: 250, height: 350, channels: 3, background: backColor },
    }).png().toFile(path.join(tempRoot, sheetNameFor(BACK_URL)));
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, backUrl: BACK_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    expect(result.backFiles).toEqual(['back.png']);
    expect(await imageSize(path.join(OUT(), 'back.png'))).toEqual({ width: 250, height: 350 });
    expect(await firstPixel(path.join(OUT(), 'back.png'))).toEqual([backColor.r, backColor.g, backColor.b]);
    const rows = await readCardsCsv(OUT());
    expect(rows.every((row) => row.back === 'back.png')).toBe(true);
  });

  it('UniqueBack=false + BackURL≠FaceURL + 本地背面缺失 → 降级：back 列空、backFiles 空', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, backUrl: BACK_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    expect(result.backFiles).toEqual([]);
    expect(existsSync(path.join(OUT(), 'back.png'))).toBe(false);
    const rows = await readCardsCsv(OUT());
    expect(rows.every((row) => row.back === undefined)).toBe(true);
  });

  it('无 BackURL → 不切背面，cards.csv back 列为空', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 5, rows: 5 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: '1', faceUrl: FACE_URL, numWidth: 5, numHeight: 5, deckIds: fullDeckIds('1', 25),
    })]);
    const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    expect(result.backFiles).toEqual([]);
    const rows = await readCardsCsv(OUT());
    expect(rows.every((row) => row.back === undefined)).toBe(true);
  });

  it('UniqueBack=true + BackURL==FaceURL：按 slot 切 N 张 back-XXX.png，颜色与正面同格一致', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 5, rows: 5 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: '1', faceUrl: FACE_URL, backUrl: FACE_URL, uniqueBack: true, numWidth: 5, numHeight: 5, deckIds: fullDeckIds('1', 25),
    })]);
    const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    expect(result.backFiles).toHaveLength(25);
    expect(result.backFiles[0]).toBe('back-001.png');
    expect(result.backFiles[24]).toBe('back-025.png');
    expect(await firstPixel(path.join(OUT(), 'back-007.png'))).toEqual([
      expectedColor(7, 5).r, expectedColor(7, 5).g, expectedColor(7, 5).b,
    ]);
    const rows = await readCardsCsv(OUT());
    expect(rows.find((row) => row.slot === 7)?.back).toBe('back-007.png');
    expect(rows.every((row) => row.back === `back-${String(row.slot).padStart(3, '0')}.png`)).toBe(true);
  });

  it('UniqueBack=true + BackURL≠FaceURL + 本地背面图集存在 → 背面从独立图集按 slot 切', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 5, rows: 5 });
    const backFn = (col: number, row: number) => ({ r: 5 + col * 20, g: 60 + row * 25, b: 150 });
    await writeSheet(tempRoot, sheetNameFor(BACK_URL), { cols: 5, rows: 5, colorFn: backFn });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: '1', faceUrl: FACE_URL, backUrl: BACK_URL, uniqueBack: true, numWidth: 5, numHeight: 5, deckIds: fullDeckIds('1', 25),
    })]);
    const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    expect(result.backFiles).toHaveLength(25);
    // 背面第 2 格（slot 2 → col 1, row 0）的颜色应来自背面图集的配色
    const expected = backFn(1, 0);
    expect(await firstPixel(path.join(OUT(), 'back-002.png'))).toEqual([expected.r, expected.g, expected.b]);
    // 正面颜色与背面不同（证明背面确实来自独立图集）
    const faceExpected = expectedColor(2, 5);
    expect(await firstPixel(path.join(OUT(), 'card-002.png'))).toEqual([faceExpected.r, faceExpected.g, faceExpected.b]);
  });

  it('UniqueBack=true + 背面图集本地缺失 → SLICE_SHEET_NOT_FOUND', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 5, rows: 5 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: '1', faceUrl: FACE_URL, backUrl: BACK_URL, uniqueBack: true, numWidth: 5, numHeight: 5, deckIds: fullDeckIds('1', 25),
    })]);
    const err = await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT(), deckGuid: 'AAA111' }),
      'SLICE_SHEET_NOT_FOUND',
    );
    expect(err.message === 'error.pack.sliceBackSheetNotFound' || err.message.includes(sanitizeAtlasUrl(BACK_URL))).toBe(true);
    expect(existsSync(path.join(OUT(), 'cards.csv'))).toBe(false);
  });

  it('UniqueBack=true + BackURL==FaceURL + 隐藏面（69/70）：正反面都只切 69 张', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, backUrl: FACE_URL, uniqueBack: true, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 69),
    })]);
    const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    expect(result.cardFiles).toHaveLength(69);
    expect(result.backFiles).toHaveLength(69);
    expect(result.backFiles).not.toContain('back-070.png');
    expect(existsSync(path.join(OUT(), 'back-070.png'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 错误路径与 IO 产物
// ---------------------------------------------------------------------------

describe('错误路径与 IO 产物', () => {
  it('图集文件不存在 → SLICE_SHEET_NOT_FOUND', async () => {
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    const err = await expectSliceError(
      () => sliceAtlas({ sheetPath: path.join(tempRoot, 'missing.png'), savePath: save, outDir: OUT() }),
      'SLICE_SHEET_NOT_FOUND',
    );
    expect(err.message === 'error.pack.sliceSheetNotFound' || err.message.includes('missing.png')).toBe(true);
  });

  it('存档 JSON 解析失败 → SLICE_SAVE_INVALID', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const save = await writeGarbageSave();
    const err = await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() }),
      'SLICE_SAVE_INVALID',
    );
    expect(err.message === 'error.pack.sliceSaveInvalid' || err.message.includes('save-broken.json')).toBe(true);
  });

  it('存档缺 ObjectStates / 根不是对象 → SLICE_SAVE_INVALID', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 10, rows: 7 });
    const noStates = path.join(tempRoot, 'save-no-states.json');
    await writeFile(noStates, JSON.stringify({ SaveName: 'x' }), 'utf8');
    await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: noStates, outDir: OUT() }),
      'SLICE_SAVE_INVALID',
    );
    const notObject = path.join(tempRoot, 'save-array.json');
    await writeFile(notObject, JSON.stringify([1, 2, 3]), 'utf8');
    await expectSliceError(
      () => sliceAtlas({ sheetPath: sheet, savePath: notObject, outDir: OUT() }),
      'SLICE_SAVE_INVALID',
    );
  });

  it('CMYK 图集 → SLICE_IMAGE_INVALID（metadata.space === "cmyk"）', async () => {
    const cmyk = await writeCmykJpeg(tempRoot, 'cmyk.jpg');
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    const err = await expectSliceError(
      () => sliceAtlas({ sheetPath: cmyk, savePath: save, outDir: OUT(), deckGuid: 'AAA111' }),
      'SLICE_IMAGE_INVALID',
    );
    expect(err.message === 'error.pack.sliceImageInvalid' || err.message.includes('CMYK')).toBe(true);
  });

  it('损坏的图集（非图片字节）→ SLICE_IMAGE_INVALID', async () => {
    const bad = path.join(tempRoot, 'broken.png');
    await writeFile(bad, Buffer.from('this is definitely not an image', 'utf8'));
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: KEY, faceUrl: FACE_URL, numWidth: 10, numHeight: 7, deckIds: fullDeckIds(KEY, 70),
    })]);
    await expectSliceError(
      () => sliceAtlas({ sheetPath: bad, savePath: save, outDir: OUT(), deckGuid: 'AAA111' }),
      'SLICE_IMAGE_INVALID',
    );
  });

  it('outDir 多级不存在 → 自动创建；cards.csv 路径正确、cardFiles/backFiles 为相对 outDir 的真实文件', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 5, rows: 5 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: '1', faceUrl: FACE_URL, backUrl: FACE_URL, uniqueBack: true, numWidth: 5, numHeight: 5, deckIds: fullDeckIds('1', 25),
    })]);
    const out = path.join(tempRoot, 'packs', '示例包', 'decks', '甲牌堆');
    const result = await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: out });
    expect(result.cardsCsvPath).toBe(path.join(out, 'cards.csv'));
    expect(existsSync(result.cardsCsvPath)).toBe(true);
    expect(result.cardFiles.every((file) => !file.includes('/') && !file.includes('\\'))).toBe(true);
    expect(result.cardFiles.every((file) => existsSync(path.join(out, file)))).toBe(true);
    expect(result.backFiles.every((file) => existsSync(path.join(out, file)))).toBe(true);
  });

  it('cards.csv 全列内容精确（card_id / face / back / sheet_id=1 / slot / sheet_cols / sheet_rows / sheet_source）', async () => {
    const sheet = await writeSheet(tempRoot, sheetNameFor(FACE_URL), { cols: 3, rows: 5 });
    const save = await writeSave([makeDeck({
      guid: 'AAA111', key: '1', faceUrl: FACE_URL, backUrl: BACK_URL, numWidth: 3, numHeight: 5, deckIds: fullDeckIds('1', 15),
    })]);
    await sharp({ create: { width: 200, height: 280, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .png().toFile(path.join(tempRoot, sheetNameFor(BACK_URL)));
    await sliceAtlas({ sheetPath: sheet, savePath: save, outDir: OUT() });
    const rows = await readCardsCsv(OUT());
    expect(rows).toHaveLength(15);
    expect(rows[2]).toEqual({
      cardId: 103,
      face: 'card-003.png',
      back: 'back.png',
      sheetId: 1,
      slot: 3,
      sheetCols: 3,
      sheetRows: 5,
      sheetSource: FACE_URL,
    });
    expect(rows.every((row) => row.sheetId === 1 && row.sheetSource === FACE_URL)).toBe(true);
    expect(rows.every((row) => row.sheetCols === 3 && row.sheetRows === 5)).toBe(true);
  });
});
