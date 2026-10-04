// tests/unit/deck-generate.test.ts
/**
 * src/deck/generate.ts 单元测试：图集重新排版拼接（含超 70 自动拆多张图集）。
 *
 * 真实 sharp 合成 + 临时目录，无网络、无 TTS：
 * - 正常路径：单图集的字段齐全性与绝对路径、网格推断落在契约验收集内
 *   （10 张 → 5x2、70 张 → 10x7、单卡 → 1x1）、图集画布 = atlasSize²、
 *   未占用格子背景透明、卡图按 1 基行优先落位（slot 1 左上 / slot columns
 *   行末 / slot columns+1 换行，B2 坑 1）、余数吸收边界（4096/10 → 第 410 px
 *   起是第 2 格）、单卡 1x1 铺满整图、卡图 alpha 原样保留；
 * - 拆分：71 → 2 张（70+1）、141 → 3 张（70+70+1）、尾图集网格按其卡数
 *   独立推断（10x7 + 1x1）、命名 sheet-N.png、sheet 间卡图互不串位；
 * - 显式网格：columns/rows 成对覆盖推断、按 columns×rows 容量拆分
 *   （5x2 + 25 张 → 10+10+5）、越界 GENERATE_GRID_INVALID、只给一个参数
 *   抛普通 Error、容量容不下的 slot 以 CARDS_SLOT_OUT_OF_RANGE 快速失败
 *   （不落任何 PNG）；
 * - cellSize 闸门：默认 512、显式 256 / 1024 通过，尺寸不符
 *   GENERATE_CELL_SIZE_MISMATCH，且 fail-fast（不写图集、不改 csv）；
 * - 错误路径：cards.csv 缺失 GENERATE_CARDS_NOT_FOUND、卡图缺失 /
 *   路径是目录 GENERATE_CARD_FILE_MISSING（message 双态断言：键名原样输出
 *   或含定位片段——locales 由 Run 2 补齐，缺键时 t() 原样输出键名）；
 *   GENERATE_TOO_MANY_CARDS 为防御性兜底，常规输入（slot ≤ 70 由
 *   readCardsCsv 把关）不可达，故无 e2e 用例、仅实现内注释说明；
 * - cards.csv 更新：sheet_id 重排（初始拆两半 → 合并回 70+1）、
 *   sheet_cols/sheet_rows 跟随推断网格重写、card_id/face/back/name/nickname/
 *   sheet_source 原样保留（含 CSV 转义字符往返）、行顺序不变、
 *   整体幂等（二次 generate 字节一致）；
 * - 边界值：空 cards.csv（0 图集）、outDir 多级自动创建、atlasSize 512 小图集、
 *   非法入参（deckDir 空 / cellSize 非正整数 / atlasSize 越枚举 / columns、
 *   rows 不成对）抛普通中文 Error。
 *
 * 像素断言口径：图集格子矩形由 src/deck/grid.ts 的 slotToRect（余数吸收）
 * 给出，取格子中心读 RGBA；卡图为纯色 PNG，缩放不改变颜色。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CARDS_CSV_FILENAME,
  readCardsCsv,
  writeCardsCsv,
  type CardRow,
} from '../../src/deck/cards.js';
import {
  DEFAULT_ATLAS_SIZE,
  DEFAULT_CELL_SIZE,
  generateAtlas,
} from '../../src/deck/generate.js';
import { slotToRect } from '../../src/deck/grid.js';
import { PackError } from '../../src/pack/packyaml.js';

// 重活是 sharp 合成（70+ 张卡的用例），整体放宽单测超时
vi.setConfig({ testTimeout: 60_000 });

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;
/** deck 目录（cards.csv + 卡图） */
let deckDir: string;
/** 默认输出目录 */
let outDir: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-deck-generate-'));
  deckDir = path.join(tempRoot, 'deck');
  outDir = path.join(tempRoot, 'out');
  await mkdir(deckDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 第 i（1 基）张测试卡的颜色（i ≤ 255 时两两不同，足够 141 张的用例） */
function cardColor(i: number): { r: number; g: number; b: number } {
  return { r: (i * 67) % 256, g: (i * 129 + 13) % 256, b: (i * 199 + 77) % 256 };
}

/**
 * 生成对齐 card_id：第 i 张卡的 CardID = (101 + 段号) × 100 + 段内 slot
 * （1 基行优先），chunk 为每段卡数（默认 70，即 10x7 满图集的分段）。
 * 真实 TTS 存档的 CardID 就是这种 key 边界对齐形态。
 */
function alignedCardId(i: number, chunk = 70): number {
  return (101 + Math.floor((i - 1) / chunk)) * 100 + (((i - 1) % chunk) + 1);
}

/**
 * 构造 n 张对齐卡牌行（初始布局 = 标准对齐布局：每 chunk 张一张 10x7 图集，
 * sheet_id = 段号 + 1）。该初始布局本身通过 cards.ts 全量校验。
 */
function alignedRows(n: number, chunk = 70): CardRow[] {
  const rows: CardRow[] = [];
  for (let i = 1; i <= n; i++) {
    const segment = Math.floor((i - 1) / chunk);
    rows.push({
      cardId: alignedCardId(i, chunk),
      face: `card_${i}.png`,
      sheetId: segment + 1,
      slot: ((i - 1) % chunk) + 1,
      sheetCols: 10,
      sheetRows: 7,
      sheetSource: `https://img.example.com/source-${101 + segment}.png`,
    });
  }
  return rows;
}

/**
 * 写一张 size × size 的纯色 PNG 卡图到 dir（alpha 可选，默认不透明）。
 * 用手写 raw RGBA 缓冲而不是 sharp 的 create+background：sharp 0.35 的
 * create background 半透明 alpha 落盘会被抬成 255（已实测），raw 缓冲
 * 则逐字节保真，alpha < 255 的用例才可靠。
 */
async function writeCardImage(
  dir: string,
  filename: string,
  size: number,
  color: { r: number; g: number; b: number },
  alpha = 255,
): Promise<void> {
  const raw = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    raw[i * 4] = color.r;
    raw[i * 4 + 1] = color.g;
    raw[i * 4 + 2] = color.b;
    raw[i * 4 + 3] = alpha;
  }
  await sharp(raw, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toFile(path.join(dir, filename));
}

/** 夹具一体化：写 cards.csv + 为每行生成 512×512（或指定尺寸）纯色卡图 */
async function makeDeck(rows: CardRow[], cellPx = DEFAULT_CELL_SIZE): Promise<void> {
  await writeCardsCsv(deckDir, rows);
  for (const [index, row] of rows.entries()) {
    await writeCardImage(deckDir, row.face, cellPx, cardColor(index + 1));
  }
}

/** 读图集 PNG 上 (x, y) 处的 RGBA 像素 */
async function pixelAt(
  pngPath: string,
  x: number,
  y: number,
): Promise<{ r: number; g: number; b: number; a: number }> {
  const raw = await sharp(pngPath).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer();
  return { r: raw[0], g: raw[1], b: raw[2], a: raw[3] };
}

/** slot（1 基）所在格子的中心像素坐标（基于 grid.ts 的余数吸收矩形） */
function cellCenter(slot: number, atlasPx: number, columns: number, rows: number): { x: number; y: number } {
  const rect = slotToRect(slot, atlasPx, atlasPx, columns, rows);
  return { x: rect.left + Math.floor(rect.width / 2), y: rect.top + Math.floor(rect.height / 2) };
}

/** 断言像素颜色（alpha 默认不透明） */
function expectPixel(
  actual: { r: number; g: number; b: number; a: number },
  color: { r: number; g: number; b: number },
  alpha = 255,
): void {
  expect(actual).toEqual({ ...color, a: alpha });
}

/**
 * 断言 fn 抛出指定 code 的 PackError，并返回该错误。
 * 只断言 code 与 message 非空，不断言完整文案（locales 由 Run 2 补齐，
 * 缺键时 t() 原样输出键名）。
 */
async function expectGenerateError(fn: () => Promise<unknown>, code: string): Promise<PackError> {
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
 * 断言 fn 抛出普通 Error（调用方编程错误，非 PackError）。
 * @param fn 待执行函数
 * @param messagePart 期望 message 包含的片段
 */
async function expectPlainError(fn: () => Promise<unknown>, messagePart: string): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PackError);
    const error = err as Error;
    expect(error.message).toContain(messagePart);
    return error;
  }
  throw new Error(`预期抛出包含 "${messagePart}" 的普通 Error，但调用成功了`);
}

// ---------------------------------------------------------------------------
// 常量与默认值
// ---------------------------------------------------------------------------

describe('常量与默认值', () => {
  it('DEFAULT_CELL_SIZE=512（TTS 推荐值不许瞎改）、DEFAULT_ATLAS_SIZE="4096"', () => {
    expect(DEFAULT_CELL_SIZE).toBe(512);
    expect(DEFAULT_ATLAS_SIZE).toBe('4096');
  });
});

// ---------------------------------------------------------------------------
// 单图集正常路径（网格推断 / 画布 / 透明背景 / 落位 / 余数吸收 / alpha）
// ---------------------------------------------------------------------------

describe('单图集正常路径', () => {
  it('10 张卡 → 1 张图集：字段齐全、filePath 绝对路径、cardsCsvPath 指向 deck/cards.csv', async () => {
    await makeDeck(alignedRows(10));
    const result = await generateAtlas({ deckDir, outDir });
    expect(result.totalCards).toBe(10);
    expect(result.sheets).toHaveLength(1);
    const sheet = result.sheets[0];
    expect(sheet.sheetId).toBe(1);
    expect(sheet.cardCount).toBe(10);
    expect(path.isAbsolute(sheet.filePath)).toBe(true);
    expect(sheet.filePath).toBe(path.resolve(outDir, 'sheet-1.png'));
    expect(existsSync(sheet.filePath)).toBe(true);
    expect(result.cardsCsvPath).toBe(path.resolve(deckDir, CARDS_CSV_FILENAME));
  });

  it('10 张卡网格推断为 5x2（零浪费候选中单格最接近正方形，契约验收集）', async () => {
    await makeDeck(alignedRows(10));
    const result = await generateAtlas({ deckDir, outDir });
    expect(result.sheets[0].columns).toBe(5);
    expect(result.sheets[0].rows).toBe(2);
  });

  it('70 张卡 → 推断 10x7 满规格单图集（cardCount=70）', async () => {
    await makeDeck(alignedRows(70));
    const result = await generateAtlas({ deckDir, outDir, atlasSize: '1024' });
    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0].columns).toBe(10);
    expect(result.sheets[0].rows).toBe(7);
    expect(result.sheets[0].cardCount).toBe(70);
  });

  it('图集 PNG 实际尺寸 = atlasSize × atlasSize（默认 4096；显式 1024）', async () => {
    await makeDeck(alignedRows(10));
    const result = await generateAtlas({ deckDir, outDir });
    const meta = await sharp(result.sheets[0].filePath).metadata();
    expect(meta.width).toBe(4096);
    expect(meta.height).toBe(4096);
    expect(meta.channels).toBe(4);

    const outDir2 = path.join(tempRoot, 'out2');
    const result2 = await generateAtlas({ deckDir, outDir: outDir2, atlasSize: '1024' });
    const meta2 = await sharp(result2.sheets[0].filePath).metadata();
    expect(meta2.width).toBe(1024);
    expect(meta2.height).toBe(1024);
  });

  it('未占用格子背景透明（显式 5x2 + 3 张卡，slot 4 空白 alpha=0）', async () => {
    await makeDeck(alignedRows(3));
    const result = await generateAtlas({ deckDir, outDir, atlasSize: '1024', columns: 5, rows: 2 });
    const center = cellCenter(4, 1024, result.sheets[0].columns, result.sheets[0].rows);
    const pixel = await pixelAt(result.sheets[0].filePath, center.x, center.y);
    expect(pixel).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('卡图按 1 基行优先落位：slot 1 左上、slot 5 第一行末、slot 6 换行首（B2 坑 1）', async () => {
    await makeDeck(alignedRows(6));
    const result = await generateAtlas({ deckDir, outDir, atlasSize: '1024', columns: 5, rows: 2 });
    const png = result.sheets[0].filePath;
    // slot 1：左上角第 1 格
    expectPixel(await pixelAt(png, ...xy(cellCenter(1, 1024, 5, 2))), cardColor(1));
    // slot 5：第一行最后一格（5 列）
    expectPixel(await pixelAt(png, ...xy(cellCenter(5, 1024, 5, 2))), cardColor(5));
    // slot 6：第二行第一格（1 基行优先跨行点）
    expectPixel(await pixelAt(png, ...xy(cellCenter(6, 1024, 5, 2))), cardColor(6));
  });

  it('10x7 网格余数吸收：4096/10 向下取整 409，边界两侧分别是第 1、2、3 格的颜色', async () => {
    await makeDeck(alignedRows(10));
    const result = await generateAtlas({ deckDir, outDir, columns: 10, rows: 7 });
    const png = result.sheets[0].filePath;
    const y = 200; // 第一行内（行高 585）
    expectPixel(await pixelAt(png, 408, y), cardColor(1)); // 第 1 格最后一列像素
    expectPixel(await pixelAt(png, 409, y), cardColor(2)); // 第 2 格起始列（left=409）
    expectPixel(await pixelAt(png, 817, y), cardColor(2)); // 第 2 格最后一列像素
    expectPixel(await pixelAt(png, 818, y), cardColor(3)); // 第 3 格起始列
  });

  it('单张卡 → 推断 1x1，卡图铺满整张 4096 图集（中心像素颜色正确）', async () => {
    await makeDeck(alignedRows(1));
    const result = await generateAtlas({ deckDir, outDir });
    expect(result.sheets[0]).toMatchObject({ columns: 1, rows: 1, cardCount: 1 });
    const pixel = await pixelAt(result.sheets[0].filePath, 2048, 2048);
    expectPixel(pixel, cardColor(1));
  });

  it('卡图自带半透明 alpha 时原样保留（alpha=128 合成后读回 128）', async () => {
    const rows = alignedRows(1);
    await writeCardsCsv(deckDir, rows);
    await writeCardImage(deckDir, rows[0].face, 512, cardColor(1), 128);
    const result = await generateAtlas({ deckDir, outDir, atlasSize: '512' });
    const pixel = await pixelAt(result.sheets[0].filePath, 256, 256);
    expectPixel(pixel, cardColor(1), 128);
  });
});

// ---------------------------------------------------------------------------
// 拆分多图集（>70 自动拆，sheet_id 1,2,3...）
// ---------------------------------------------------------------------------

describe('拆分多图集', () => {
  it('71 张卡 → 2 张图集（70 + 1），sheet-1.png / sheet-2.png 都落盘', async () => {
    await makeDeck(alignedRows(71));
    const result = await generateAtlas({ deckDir, outDir, atlasSize: '1024' });
    expect(result.totalCards).toBe(71);
    expect(result.sheets).toHaveLength(2);
    expect(result.sheets[0].cardCount).toBe(70);
    expect(result.sheets[1].cardCount).toBe(1);
    expect(existsSync(result.sheets[0].filePath)).toBe(true);
    expect(existsSync(result.sheets[1].filePath)).toBe(true);
  });

  it('141 张卡 → 3 张图集（70+70+1），命名 sheet-1/2/3.png 且路径绝对', async () => {
    await makeDeck(alignedRows(141));
    const result = await generateAtlas({ deckDir, outDir, atlasSize: '1024' });
    expect(result.sheets).toHaveLength(3);
    expect(result.sheets.map((sheet) => sheet.cardCount)).toEqual([70, 70, 1]);
    expect(result.sheets.map((sheet) => sheet.sheetId)).toEqual([1, 2, 3]);
    expect(result.sheets.map((sheet) => path.basename(sheet.filePath))).toEqual([
      'sheet-1.png',
      'sheet-2.png',
      'sheet-3.png',
    ]);
    for (const sheet of result.sheets) {
      expect(path.isAbsolute(sheet.filePath)).toBe(true);
      expect(existsSync(sheet.filePath)).toBe(true);
    }
  });

  it('尾图集网格按其卡数独立推断：sheet1 10x7、sheet2（1 张）1x1', async () => {
    await makeDeck(alignedRows(71));
    const result = await generateAtlas({ deckDir, outDir, atlasSize: '1024' });
    expect(result.sheets[0].columns).toBe(10);
    expect(result.sheets[0].rows).toBe(7);
    expect(result.sheets[1].columns).toBe(1);
    expect(result.sheets[1].rows).toBe(1);
  });

  it('拆分后卡图不串位：第 71 张卡落在 sheet-2 的 1x1 格中心', async () => {
    await makeDeck(alignedRows(71));
    const result = await generateAtlas({ deckDir, outDir, atlasSize: '1024' });
    const pixel = await pixelAt(result.sheets[1].filePath, 512, 512);
    expectPixel(pixel, cardColor(71));
  });
});

// ---------------------------------------------------------------------------
// 显式网格（columns/rows 覆盖推断、按容量拆分、越界与不成对）
// ---------------------------------------------------------------------------

describe('显式网格', () => {
  it('显式 columns/rows 覆盖推断（10 张卡显式 2x5，slot 3 落在第二行第一格）', async () => {
    await makeDeck(alignedRows(10));
    const result = await generateAtlas({ deckDir, outDir, atlasSize: '1024', columns: 2, rows: 5 });
    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0]).toMatchObject({ columns: 2, rows: 5, cardCount: 10 });
    const png = result.sheets[0].filePath;
    // 2x5 网格：cellW = 512、cellH = 204；slot 3 = 第 2 行第 1 格
    expectPixel(await pixelAt(png, ...xy(cellCenter(3, 1024, 2, 5))), cardColor(3));
  });

  it('显式网格按 columns×rows 容量拆分：5x2 + 25 张对齐卡 → 3 张（10+10+5）', async () => {
    await makeDeck(alignedRows(25, 10)); // card_id 按 10 张一段对齐（10101..10110, 10201.., 10301..）
    const result = await generateAtlas({ deckDir, outDir, atlasSize: '512', columns: 5, rows: 2 });
    expect(result.sheets).toHaveLength(3);
    expect(result.sheets.map((sheet) => [sheet.sheetId, sheet.columns, sheet.rows, sheet.cardCount])).toEqual([
      [1, 5, 2, 10],
      [2, 5, 2, 10],
      [3, 5, 2, 5],
    ]);
    // 第 3 张图集（5 张卡）的 slot 回绕到 1..5
    const csvRows = await readCardsCsv(deckDir);
    expect(csvRows.slice(20).map((row) => [row.sheetId, row.slot])).toEqual([
      [3, 1],
      [3, 2],
      [3, 3],
      [3, 4],
      [3, 5],
    ]);
  });

  it('显式网格越界（columns=11 / rows=8 / columns=0）→ GENERATE_GRID_INVALID，message 双态', async () => {
    await makeDeck(alignedRows(2));
    const err = await expectGenerateError(
      () => generateAtlas({ deckDir, outDir, columns: 11, rows: 7 }),
      'GENERATE_GRID_INVALID',
    );
    expect(err.message === 'error.pack.generateGridInvalid' || err.message.includes('11')).toBe(true);
    await expectGenerateError(() => generateAtlas({ deckDir, outDir, columns: 10, rows: 8 }), 'GENERATE_GRID_INVALID');
    await expectGenerateError(() => generateAtlas({ deckDir, outDir, columns: 0, rows: 7 }), 'GENERATE_GRID_INVALID');
    await expectGenerateError(() => generateAtlas({ deckDir, outDir, columns: 10, rows: 0 }), 'GENERATE_GRID_INVALID');
  });

  it('只给 columns 不给 rows（或反之）→ 普通 Error 提示成对给出', async () => {
    await makeDeck(alignedRows(2));
    await expectPlainError(() => generateAtlas({ deckDir, outDir, columns: 5 }), 'columns');
    await expectPlainError(() => generateAtlas({ deckDir, outDir, rows: 5 }), 'rows');
  });

  it('显式网格容量容不下 slot（1x1 + slot 2 的卡）→ CARDS_SLOT_OUT_OF_RANGE 快速失败，不落任何 PNG', async () => {
    await makeDeck(alignedRows(2)); // 初始 10x7 合法布局；slot 2 的卡真实存在
    const err = await expectGenerateError(
      () => generateAtlas({ deckDir, outDir, atlasSize: '512', columns: 1, rows: 1 }),
      'CARDS_SLOT_OUT_OF_RANGE',
    );
    expect(err.message === 'error.pack.cardsSlotOutOfRange' || err.message.includes('2')).toBe(true);
    expect(existsSync(outDir)).toBe(false);
    expect(existsSync(path.join(outDir, 'sheet-1.png'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cellSize 闸门（默认 512；显式 256 / 1024；尺寸不符报错）
// ---------------------------------------------------------------------------

describe('cellSize 闸门', () => {
  it('显式 cellSize 256：256×256 卡图通过且落位正确（512 图集推断 2x2）', async () => {
    await makeDeck(alignedRows(4), 256);
    const result = await generateAtlas({ deckDir, outDir, atlasSize: '512', cellSize: 256 });
    expect(result.sheets[0]).toMatchObject({ columns: 2, rows: 2, cardCount: 4 });
    expectPixel(
      await pixelAt(result.sheets[0].filePath, ...xy(cellCenter(1, 512, 2, 2))),
      cardColor(1),
    );
  });

  it('显式 cellSize 1024：1024×1024 卡图通过（2048 图集推断 2x2）', async () => {
    await makeDeck(alignedRows(4), 1024);
    const result = await generateAtlas({ deckDir, outDir, atlasSize: '2048', cellSize: 1024 });
    expect(result.sheets[0]).toMatchObject({ columns: 2, rows: 2 });
    expectPixel(
      await pixelAt(result.sheets[0].filePath, ...xy(cellCenter(4, 2048, 2, 2))),
      cardColor(4),
    );
  });

  it('卡图损坏（不是合法图片）→ GENERATE_CELL_SIZE_MISMATCH，message 双态', async () => {
    const rows = alignedRows(2);
    await makeDeck(rows);
    // 第 2 张改成非图片内容（损坏）
    await writeFile(path.join(deckDir, rows[1].face), Buffer.from('not a png'));
    const err = await expectGenerateError(() => generateAtlas({ deckDir, outDir }), 'GENERATE_CELL_SIZE_MISMATCH');
    expect(err.message === 'error.pack.generateCellSizeMismatch' || err.message.includes(rows[1].face)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 错误路径（cards.csv 缺失 / 卡图缺失 / fail-fast 不落盘）
// ---------------------------------------------------------------------------

describe('错误路径', () => {
  it('cards.csv 不存在 → GENERATE_CARDS_NOT_FOUND，message 双态含 cards.csv', async () => {
    const err = await expectGenerateError(() => generateAtlas({ deckDir, outDir }), 'GENERATE_CARDS_NOT_FOUND');
    expect(err.message === 'error.pack.generateCardsNotFound' || err.message.includes('cards.csv')).toBe(true);
  });

  it('cards.csv 引用的卡图文件缺失 → GENERATE_CARD_FILE_MISSING，message 双态含文件名', async () => {
    await writeCardsCsv(deckDir, alignedRows(2)); // 只写 csv，不生成卡图
    const err = await expectGenerateError(() => generateAtlas({ deckDir, outDir }), 'GENERATE_CARD_FILE_MISSING');
    expect(err.message === 'error.pack.generateCardFileMissing' || err.message.includes('card_1.png')).toBe(true);
  });

  it('卡图路径是目录（不是文件）→ GENERATE_CARD_FILE_MISSING', async () => {
    const rows = alignedRows(1);
    await writeCardsCsv(deckDir, rows);
    await mkdir(path.join(deckDir, rows[0].face)); // face 指向目录
    await expectGenerateError(() => generateAtlas({ deckDir, outDir }), 'GENERATE_CARD_FILE_MISSING');
  });

  it('fail-fast：任一卡图损坏 → 不写图集、不创建 outDir、cards.csv 字节不变', async () => {
    const rows = alignedRows(3);
    await makeDeck(rows);
    await writeFile(path.join(deckDir, rows[1].face), Buffer.from('not a png')); // 第 2 张损坏
    const before = await readFile(path.join(deckDir, CARDS_CSV_FILENAME));
    await expectGenerateError(() => generateAtlas({ deckDir, outDir }), 'GENERATE_CELL_SIZE_MISMATCH');
    expect(existsSync(outDir)).toBe(false);
    expect(existsSync(path.join(outDir, 'sheet-1.png'))).toBe(false);
    const after = await readFile(path.join(deckDir, CARDS_CSV_FILENAME));
    expect(after.equals(before)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cards.csv 更新（sheet_id / slot / sheet_cols / sheet_rows 重写，其余保留）
// ---------------------------------------------------------------------------

describe('cards.csv 更新', () => {
  it('sheet_id 重排：初始拆两半（35+36）→ 生成后前 70 张 sheet_id=1，第 71 张 sheet_id=2', async () => {
    const rows = alignedRows(71);
    // 初始布局故意与生成结果不同：卡 36..70 也放在 sheet 2
    for (const [index, row] of rows.entries()) {
      if (index + 1 > 35) {
        row.sheetId = 2;
      }
    }
    await makeDeck(rows);
    await generateAtlas({ deckDir, outDir, atlasSize: '1024' });
    const csvRows = await readCardsCsv(deckDir);
    expect(csvRows).toHaveLength(71);
    expect(csvRows.slice(0, 70).map((row) => row.sheetId)).toEqual(Array(70).fill(1));
    expect(csvRows.slice(0, 70).map((row) => row.slot)).toEqual(Array.from({ length: 70 }, (_, i) => i + 1));
    expect(csvRows[70]).toMatchObject({ sheetId: 2, slot: 1, cardId: 10201 });
  });

  it('sheet_cols/sheet_rows 跟随推断网格重写：初始 10x7（3 张卡）→ 生成后 3x1', async () => {
    await makeDeck(alignedRows(3));
    const result = await generateAtlas({ deckDir, outDir, atlasSize: '512' });
    expect(result.sheets[0]).toMatchObject({ columns: 3, rows: 1 });
    const csvRows = await readCardsCsv(deckDir);
    expect(csvRows.map((row) => [row.sheetCols, row.sheetRows])).toEqual([
      [3, 1],
      [3, 1],
      [3, 1],
    ]);
    expect(csvRows.map((row) => row.slot)).toEqual([1, 2, 3]);
  });

  it('card_id/face/back/name/nickname/sheet_source 原样保留（含 CSV 转义字符往返），行顺序不变', async () => {
    const rows = alignedRows(4).map((row, index) => ({
      ...row,
      back: `back_${index + 1}.png`,
      name: index === 0 ? '卡牌,带逗号' : `卡牌 ${index + 1}`,
      nickname: `昵称"引号"${index + 1}`,
    }));
    await makeDeck(rows);
    await generateAtlas({ deckDir, outDir, atlasSize: '512' });
    const csvRows = await readCardsCsv(deckDir);
    expect(csvRows).toHaveLength(4);
    csvRows.forEach((row, index) => {
      expect(row.cardId).toBe(rows[index].cardId);
      expect(row.face).toBe(rows[index].face);
      expect(row.back).toBe(rows[index].back);
      expect(row.name).toBe(rows[index].name);
      expect(row.nickname).toBe(rows[index].nickname);
      expect(row.sheetSource).toBe(rows[index].sheetSource);
      expect(row.sheetId).toBe(1);
      expect(row.slot).toBe(index + 1);
    });
  });

  it('整体幂等：对同一 deck 连跑两遍，结果字段一致、cards.csv 字节一致', async () => {
    await makeDeck(alignedRows(10));
    const first = await generateAtlas({ deckDir, outDir });
    const csvPath = path.join(deckDir, CARDS_CSV_FILENAME);
    const bytes1 = await readFile(csvPath);
    const second = await generateAtlas({ deckDir, outDir });
    expect(second.sheets).toEqual(first.sheets);
    expect(second.totalCards).toBe(first.totalCards);
    const bytes2 = await readFile(csvPath);
    expect(bytes2.equals(bytes1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 边界值与入参校验
// ---------------------------------------------------------------------------

describe('边界值与入参校验', () => {
  it('空 cards.csv（0 张卡）→ 0 张图集、totalCards=0、csv 仍可读回为空表', async () => {
    await writeCardsCsv(deckDir, []);
    const result = await generateAtlas({ deckDir, outDir });
    expect(result.sheets).toEqual([]);
    expect(result.totalCards).toBe(0);
    expect(existsSync(path.join(outDir, 'sheet-1.png'))).toBe(false);
    await expect(readCardsCsv(deckDir)).resolves.toEqual([]);
  });

  it('outDir 不存在时自动创建（含多级父目录）', async () => {
    await makeDeck(alignedRows(2));
    const deep = path.join(tempRoot, 'x', 'y', 'z');
    const result = await generateAtlas({ deckDir, outDir: deep, atlasSize: '512' });
    expect(existsSync(result.sheets[0].filePath)).toBe(true);
  });

  it('atlasSize 显式 "512"：小图集同样按卡数推断（10 张 → 5x2，画布 512×512）', async () => {
    await makeDeck(alignedRows(10));
    const result = await generateAtlas({ deckDir, outDir, atlasSize: '512' });
    expect(result.sheets[0]).toMatchObject({ columns: 5, rows: 2 });
    const meta = await sharp(result.sheets[0].filePath).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  it('非法入参（deckDir 空 / cellSize 非正整数 / atlasSize 越枚举）→ 普通 Error', async () => {
    await expectPlainError(() => generateAtlas({ deckDir: '', outDir }), 'deckDir');
    await makeDeck(alignedRows(1));
    await expectPlainError(() => generateAtlas({ deckDir, outDir, cellSize: 0 }), 'cellSize');
    await expectPlainError(() => generateAtlas({ deckDir, outDir, cellSize: 100.5 }), 'cellSize');
    await expectPlainError(() => generateAtlas({ deckDir, outDir, atlasSize: '8192' }), 'atlasSize');
  });
});

/** 展开坐标对象为 pixelAt 的两个位置参数（测试可读性小工具） */
function xy(point: { x: number; y: number }): [number, number] {
  return [point.x, point.y];
}
