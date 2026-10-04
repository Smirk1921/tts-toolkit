// tests/unit/deck-inplace.test.ts
/**
 * src/deck/inplace.ts 单元测试：原位拼回（按 cards.csv 记录，未改的取原像素）。
 *
 * 纯文件 IO + sharp（临时目录），无网络、无 TTS、无 git 依赖：
 * - 正常路径：全未改时输出与源图集逐字节一致；mtime 模式改 3 张（含第一行
 *   最后一格 / 第二行第一格的跨行边界）后未改格子逐像素一致、改的格子为
 *   新色（方案设计回归验收）；多张图集 sheet_id=1,2 独立处理；显式 cellSize
 *   与省略推断两条路径；face 含子目录路径；空 cards.csv（0 行）→ sheets 为空
 *   且不产出文件；RGB（3 通道）源图集同样拼回；
 * - mtime 改判：卡图 mtime 严格晚于源图集 → 替换；早于 → 保留原像素；
 *   恰好相等 → 保留（契约"晚于"不含相等）；晚 1ms → 替换（mtimeMs 精度）；
 *   modifiedCardIds 为空数组 → 回退 mtime 模式；
 * - 显式改判：modifiedCardIds=[10101] 只替换该卡（其余卡图 mtime 更新也不
 *   替换）；显式模式下 mtime 旧仍替换；集合含未知 CardID 忽略；声明的卡
 *   卡图文件缺失 → 回退源像素不报错（契约 3c："存在于 deckDir"是前提）；
 * - 错误路径（PackError 一律按 .code 断言；message 双态断言——locales 未补
 *   键时 t() 原样输出键名，补齐后含定位信息）：cards.csv 不存在
 *   INPLACE_CARDS_NOT_FOUND；源图集缺失 INPLACE_SOURCE_MISSING（单张 / 多张
 *   时缺 sheet-2）；改判卡图尺寸不符 INPLACE_CELL_SIZE_MISMATCH（mtime 与
 *   显式两模式）；源图集与网格不符 INPLACE_GRID_MISMATCH（显式 cellSize
 *   相乘不等 / 推断不整除 / 推断非方格 / 高不整除 / 同 sheet 网格声明
 *   不一致）；cellSize 非正整数 → 普通 Error（调用方编程错误）；
 * - 回归验收：输出图集尺寸与源完全一致（不静默改图集大小）；cards.csv
 *   原样不动（逐字节不变）。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inplaceAtlas } from '../../src/deck/inplace.js';
import { PackError } from '../../src/pack/packyaml.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

/** deck 目录（cards.csv + 卡图） */
let deckDir: string;
/** 源图集目录（sheet-N.png） */
let sourceDir: string;
/** 输出目录 */
let outDir: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-deck-inplace-'));
  deckDir = path.join(tempRoot, 'deck');
  sourceDir = path.join(tempRoot, 'source');
  outDir = path.join(tempRoot, 'out');
  await mkdir(deckDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 契约表头 */
const HEADER_LINE = 'card_id,face,back,name,nickname,sheet_id,slot,sheet_cols,sheet_rows,sheet_source';

/** RGBA 颜色 */
type Rgba = [number, number, number, number];

/** 标准夹具网格：3 列 × 2 行，单格 100px（源图集 300x200，6 格） */
const COLS = 3;
const ROWS = 2;
const CELL = 100;

/** mtime 时间轴（整数 ms，完全确定）：源图集 / 新卡图 / 旧卡图 */
const SOURCE_MTIME = 1_700_000_000_000;
const NEW_MTIME = SOURCE_MTIME + 3_600_000;
const OLD_MTIME = SOURCE_MTIME - 3_600_000;

/** 替换卡图的醒目颜色（与任何 slotColor 都不同） */
const REPLACED_COLOR: Rgba = [255, 10, 40, 255];

/** 源图集第 slot 格（1 基）的确定性颜色（互不相同：37/61/89 与 256 互质） */
function slotColor(slot: number): Rgba {
  return [(slot * 37) % 256, (slot * 61) % 256, (slot * 89) % 256, 255];
}

/** 生成纯色 RGBA png（Buffer 形式） */
async function solidPng(width: number, height: number, color: Rgba): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: color[0], g: color[1], b: color[2], alpha: color[3] / 255 },
    },
  })
    .png()
    .toBuffer();
}

/**
 * 生成每格颜色互不相同的源图集 png（RGBA，8bit）。
 * @param cols 列数
 * @param rows 行数
 * @param cell 单格边长（像素）
 */
async function gridSheetPng(cols: number, rows: number, cell: number): Promise<Buffer> {
  return sharp(await expectedSheetData(cols, rows, cell, []), {
    raw: { width: cols * cell, height: rows * cell, channels: 4 },
  })
    .png()
    .toBuffer();
}

/**
 * 构造期望图的原始 RGBA 像素：源色格子（slotColor）+ 指定 slot 替换为
 * REPLACED_COLOR（与拼回输出的逐字节比较基准）。
 */
async function expectedSheetData(
  cols: number,
  rows: number,
  cell: number,
  replacedSlots: readonly number[],
): Promise<Buffer> {
  const width = cols * cell;
  const height = rows * cell;
  const raw = Buffer.alloc(width * height * 4);
  const replaced = new Set(replacedSlots);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const slot = row * cols + col + 1; // 1 基（行优先，与 TTS CardID % 100 一致）
      const color = replaced.has(slot) ? REPLACED_COLOR : slotColor(slot);
      for (let py = 0; py < cell; py++) {
        for (let px = 0; px < cell; px++) {
          const o = ((row * cell + py) * width + (col * cell + px)) * 4;
          raw[o] = color[0];
          raw[o + 1] = color[1];
          raw[o + 2] = color[2];
          raw[o + 3] = color[3];
        }
      }
    }
  }
  return raw;
}

/** 落盘一张标准源图集到 sourceDir（并固定 mtime 为 SOURCE_MTIME） */
async function writeSourceSheet(sheetId: number, cols = COLS, rows = ROWS, cell = CELL): Promise<string> {
  const filePath = path.join(sourceDir, `sheet-${sheetId}.png`);
  await writeFile(filePath, await gridSheetPng(cols, rows, cell));
  await setMtime(filePath, SOURCE_MTIME);
  return filePath;
}

/**
 * 写 cards.csv（裸文本；slot 1 基，cardId = key*100 + slot 必须满足
 * slot == cardId % 100，cards.ts 会校验）。
 */
async function writeDeckCsv(lines: string[]): Promise<void> {
  const text = lines.length > 0 ? HEADER_LINE + '\n' + lines.join('\n') + '\n' : HEADER_LINE + '\n';
  await writeFile(path.join(deckDir, 'cards.csv'), text, 'utf8');
}

/** 构造一行 cards.csv 数据（10 列；back/name/nickname 留空） */
function csvLine(cardId: number, face: string, sheetId: number, slot: number, cols: number, rows: number): string {
  return `${cardId},${face},,,,${sheetId},${slot},${cols},${rows},https://example.invalid/sheet-${sheetId}.png`;
}

/** 写入标准 6 卡 cards.csv（sheet_id=sheetId，slot 1..6，3x2 网格） */
async function writeStandardCsv(sheetId = 1): Promise<void> {
  const lines: string[] = [];
  for (let slot = 1; slot <= COLS * ROWS; slot++) {
    lines.push(csvLine(10100 + slot, `card_${10100 + slot}.png`, sheetId, slot, COLS, ROWS));
  }
  await writeDeckCsv(lines);
}

/** 标准夹具：源图集 + 6 卡 cards.csv（卡图一律不写，按用例需要补） */
async function setupStandardSheet(sheetId = 1): Promise<void> {
  await writeSourceSheet(sheetId);
  await writeStandardCsv(sheetId);
}

/** 在 deckDir 落盘一张替换卡图（可指定相对路径，自动建子目录），并固定 mtime */
async function writeCardPng(cardId: number, cell: number, mtimeMs: number, face?: string, color?: Rgba): Promise<string> {
  const facePath = face ?? `card_${cardId}.png`;
  const filePath = path.join(deckDir, facePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, await solidPng(cell, cell, color ?? REPLACED_COLOR));
  await setMtime(filePath, mtimeMs);
  return filePath;
}

/** 设置文件 mtime（整数 ms，确定无精度漂移） */
async function setMtime(filePath: string, ms: number): Promise<void> {
  const stamp = new Date(ms);
  await utimes(filePath, stamp, stamp);
}

/** 解码图片为统一 8bit RGBA 原始像素（比较基准；ensureAlpha 对齐通道数） */
async function rawOf(input: Buffer | string): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** 断言两张图（路径或 Buffer）的 RGBA 像素逐字节一致且尺寸相同 */
function expectSamePixels(a: { data: Buffer; width: number; height: number }, b: { data: Buffer; width: number; height: number }): void {
  expect(b.width).toBe(a.width);
  expect(b.height).toBe(a.height);
  expect(a.data.length).toBe(b.data.length);
  expect(Buffer.compare(a.data, b.data)).toBe(0);
}

/** 取图内某格（1 基 slot + 列数）中心像素颜色 */
function cellColor(raw: { data: Buffer; width: number }, cols: number, cell: number, slot: number): Rgba {
  const col = (slot - 1) % cols;
  const row = Math.floor((slot - 1) / cols);
  const cx = col * cell + Math.floor(cell / 2);
  const cy = row * cell + Math.floor(cell / 2);
  const o = (cy * raw.width + cx) * 4;
  return [raw.data[o], raw.data[o + 1], raw.data[o + 2], raw.data[o + 3]];
}

/**
 * 断言 fn 抛出指定 code 的 PackError；可选做 message 双态断言
 * （locales 缺键时 t() 原样输出键名，补齐后 message 含定位信息）。
 */
async function expectInplaceError(
  fn: () => Promise<unknown>,
  code: string,
  i18nKey?: string,
  messageMarker?: string,
): Promise<PackError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PackError);
    const packError = err as PackError;
    expect(packError.code).toBe(code);
    expect(packError.message.length).toBeGreaterThan(0);
    if (i18nKey !== undefined && messageMarker !== undefined) {
      expect(packError.message === i18nKey || packError.message.includes(messageMarker)).toBe(true);
    }
    return packError;
  }
  throw new Error(`预期抛出 code=${code} 的 PackError，但调用成功了`);
}

/** 跑默认参数的原位拼回（标准目录布局） */
function runInplace(modifiedCardIds?: number[]): Promise<ReturnType<typeof inplaceAtlas>> {
  return inplaceAtlas({ deckDir, sourceDir, outDir, modifiedCardIds });
}

// ---------------------------------------------------------------------------
// 正常路径
// ---------------------------------------------------------------------------

describe('inplaceAtlas 正常路径', () => {
  it('全未改（deckDir 无卡图）：输出与源图集逐字节一致，modifiedCount=0', async () => {
    await setupStandardSheet();

    const result = await runInplace();

    expect(result.sheets).toHaveLength(1);
    const sheet = result.sheets[0];
    expect(sheet.sheetId).toBe(1);
    expect(sheet.columns).toBe(COLS);
    expect(sheet.rows).toBe(ROWS);
    expect(sheet.modifiedCount).toBe(0);
    expect(sheet.totalCount).toBe(COLS * ROWS);

    const source = await rawOf(await readFile(path.join(sourceDir, 'sheet-1.png')));
    const output = await rawOf(sheet.filePath);
    expectSamePixels(source, output);
  });

  it('mtime 模式改 3 张（含 slot=3 行尾、slot=4 换行边界）：未改格子逐像素一致，改的格子为新色', async () => {
    await setupStandardSheet();
    // slot 1（左上）、slot 3（第一行最后一格）、slot 4（第二行第一格）
    await writeCardPng(10101, CELL, NEW_MTIME);
    await writeCardPng(10103, CELL, NEW_MTIME);
    await writeCardPng(10104, CELL, NEW_MTIME);

    const result = await runInplace();

    expect(result.sheets[0].modifiedCount).toBe(3);
    expect(result.sheets[0].totalCount).toBe(6);
    const output = await rawOf(result.sheets[0].filePath);
    // 改的格子 = 替换色
    expect(cellColor(output, COLS, CELL, 1)).toEqual(REPLACED_COLOR);
    expect(cellColor(output, COLS, CELL, 3)).toEqual(REPLACED_COLOR);
    expect(cellColor(output, COLS, CELL, 4)).toEqual(REPLACED_COLOR);
    // 未改的格子 = 源像素（回归验收：逐格比较）
    expect(cellColor(output, COLS, CELL, 2)).toEqual(slotColor(2));
    expect(cellColor(output, COLS, CELL, 5)).toEqual(slotColor(5));
    expect(cellColor(output, COLS, CELL, 6)).toEqual(slotColor(6));
    // 整图逐字节回归：期望图（未改格用源色、改格用替换色）逐像素一致
    const expected = await expectedSheetData(COLS, ROWS, CELL, [1, 3, 4]);
    expect(Buffer.compare(output.data, expected)).toBe(0);
  });

  it('多张图集 sheet_id=1,2 各自独立处理（不同网格与单格尺寸）', async () => {
    await writeSourceSheet(1); // 3x2 cell 100
    await writeSourceSheet(2, 2, 2, 50); // 2x2 cell 50 → 100x100
    await writeDeckCsv([
      csvLine(10101, 'card_10101.png', 1, 1, COLS, ROWS),
      csvLine(10102, 'card_10102.png', 1, 2, COLS, ROWS),
      csvLine(10201, 'card_10201.png', 2, 1, 2, 2),
      csvLine(10202, 'card_10202.png', 2, 2, 2, 2),
      csvLine(10203, 'card_10203.png', 2, 3, 2, 2),
      csvLine(10204, 'card_10204.png', 2, 4, 2, 2),
    ]);
    await writeCardPng(10202, 50, NEW_MTIME);

    const result = await runInplace();

    expect(result.sheets.map((s) => s.sheetId)).toEqual([1, 2]);
    const sheet1 = result.sheets[0];
    const sheet2 = result.sheets[1];
    expect(sheet1.columns).toBe(COLS);
    expect(sheet1.rows).toBe(ROWS);
    expect(sheet1.modifiedCount).toBe(0);
    expect(sheet1.totalCount).toBe(2);
    expect(sheet2.columns).toBe(2);
    expect(sheet2.rows).toBe(2);
    expect(sheet2.modifiedCount).toBe(1);
    expect(sheet2.totalCount).toBe(4);
    // sheet1 与源逐字节一致；sheet2 的第 2 格被替换
    expectSamePixels(
      await rawOf(await readFile(path.join(sourceDir, 'sheet-1.png'))),
      await rawOf(sheet1.filePath),
    );
    const out2 = await rawOf(sheet2.filePath);
    expect(cellColor(out2, 2, 50, 2)).toEqual(REPLACED_COLOR);
    expect(cellColor(out2, 2, 50, 1)).toEqual(slotColor(1));
    expect(cellColor(out2, 2, 50, 4)).toEqual(slotColor(4));
  });

  it('输出文件名与源图集一致（sheet-<id>.png），filePath 指向 outDir', async () => {
    await setupStandardSheet();

    const result = await runInplace();

    const expectedPath = path.join(outDir, 'sheet-1.png');
    expect(result.sheets[0].filePath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(existsSync(path.join(sourceDir, 'sheet-1.png'))).toBe(true); // 源不被覆盖
  });

  it('显式 cellSize 与源图集匹配时成功', async () => {
    await setupStandardSheet();
    await writeCardPng(10101, CELL, NEW_MTIME);

    const result = await inplaceAtlas({ deckDir, sourceDir, outDir, cellSize: CELL });

    expect(result.sheets[0].modifiedCount).toBe(1);
    const output = await rawOf(result.sheets[0].filePath);
    expect(output.width).toBe(COLS * CELL);
    expect(output.height).toBe(ROWS * CELL);
  });

  it('省略 cellSize 时从源图集推断（300x200 ÷ 3x2 → 100）', async () => {
    await setupStandardSheet();
    await writeCardPng(10105, CELL, NEW_MTIME);

    const result = await runInplace();

    expect(result.sheets[0].modifiedCount).toBe(1);
    const output = await rawOf(result.sheets[0].filePath);
    expect(output.width).toBe(300);
    expect(output.height).toBe(200);
    expect(cellColor(output, COLS, CELL, 5)).toEqual(REPLACED_COLOR);
  });

  it('face 含子目录路径时能定位卡图并替换', async () => {
    await writeSourceSheet(1);
    await writeDeckCsv([csvLine(10101, 'cards/sub/card_10101.png', 1, 1, COLS, ROWS)]);
    await writeCardPng(10101, CELL, NEW_MTIME, 'cards/sub/card_10101.png');

    const result = await runInplace();

    expect(result.sheets[0].modifiedCount).toBe(1);
    const output = await rawOf(result.sheets[0].filePath);
    expect(cellColor(output, COLS, CELL, 1)).toEqual(REPLACED_COLOR);
  });

  it('cards.csv 只有表头（0 行）→ sheets 为空且不产出任何文件', async () => {
    await writeDeckCsv([]);

    const result = await runInplace();

    expect(result.sheets).toEqual([]);
    expect(existsSync(outDir)).toBe(false);
  });

  it('RGB（3 通道）源图集也能拼回，未改格子像素一致', async () => {
    // 3 通道源图集（无 alpha）
    const rgbPng = await sharp(await gridSheetPng(COLS, ROWS, CELL)).removeAlpha().png().toBuffer();
    await writeFile(path.join(sourceDir, 'sheet-1.png'), rgbPng);
    await setMtime(path.join(sourceDir, 'sheet-1.png'), SOURCE_MTIME);
    await writeStandardCsv(1);
    await writeCardPng(10101, CELL, NEW_MTIME);

    const result = await runInplace();

    expect(result.sheets[0].modifiedCount).toBe(1);
    const output = await rawOf(result.sheets[0].filePath);
    expect(cellColor(output, COLS, CELL, 1)).toEqual(REPLACED_COLOR);
    // 期望图（slot1 替换、其余源色）逐字节一致（ensureAlpha 对齐通道数）
    const expected = await expectedSheetData(COLS, ROWS, CELL, [1]);
    expect(output.width).toBe(COLS * CELL);
    expect(Buffer.compare(output.data, expected)).toBe(0);
  });

  it('卡图 mtime 恰好等于源图集 → 未改（契约"晚于"不含相等）', async () => {
    await setupStandardSheet();
    await writeCardPng(10101, CELL, SOURCE_MTIME); // 与源 mtime 完全相同

    const result = await runInplace();

    expect(result.sheets[0].modifiedCount).toBe(0);
    const output = await rawOf(result.sheets[0].filePath);
    expect(cellColor(output, COLS, CELL, 1)).toEqual(slotColor(1));
  });
});

// ---------------------------------------------------------------------------
// mtime 改判模式
// ---------------------------------------------------------------------------

describe('inplaceAtlas mtime 改判', () => {
  it('卡图 mtime 新于源图集 → 替换为卡图像素', async () => {
    await setupStandardSheet();
    await writeCardPng(10102, CELL, NEW_MTIME);

    const result = await runInplace();

    expect(result.sheets[0].modifiedCount).toBe(1);
    const output = await rawOf(result.sheets[0].filePath);
    expect(cellColor(output, COLS, CELL, 2)).toEqual(REPLACED_COLOR);
  });

  it('卡图 mtime 旧于源图集 → 保留原像素（即使卡图内容不同）', async () => {
    await setupStandardSheet();
    await writeCardPng(10102, CELL, OLD_MTIME, undefined, [0, 0, 255, 255]);

    const result = await runInplace();

    expect(result.sheets[0].modifiedCount).toBe(0);
    const output = await rawOf(result.sheets[0].filePath);
    expect(cellColor(output, COLS, CELL, 2)).toEqual(slotColor(2));
  });

  it('卡图 mtime 比源图集晚 1ms → 替换（mtimeMs 精度）', async () => {
    await setupStandardSheet();
    await writeCardPng(10102, CELL, SOURCE_MTIME + 1);

    const result = await runInplace();

    expect(result.sheets[0].modifiedCount).toBe(1);
    const output = await rawOf(result.sheets[0].filePath);
    expect(cellColor(output, COLS, CELL, 2)).toEqual(REPLACED_COLOR);
  });

  it('modifiedCardIds 为空数组 → 回退 mtime 模式', async () => {
    await setupStandardSheet();
    await writeCardPng(10106, CELL, NEW_MTIME);

    const result = await runInplace([]);

    expect(result.sheets[0].modifiedCount).toBe(1);
    const output = await rawOf(result.sheets[0].filePath);
    expect(cellColor(output, COLS, CELL, 6)).toEqual(REPLACED_COLOR);
  });
});

// ---------------------------------------------------------------------------
// 显式改判模式
// ---------------------------------------------------------------------------

describe('inplaceAtlas 显式改判', () => {
  it('modifiedCardIds=[10101]：只替换该卡，其余卡图即使 mtime 更新也不替换', async () => {
    await setupStandardSheet();
    await writeCardPng(10101, CELL, NEW_MTIME);
    await writeCardPng(10102, CELL, NEW_MTIME);
    await writeCardPng(10103, CELL, NEW_MTIME);

    const result = await runInplace([10101]);

    expect(result.sheets[0].modifiedCount).toBe(1);
    const output = await rawOf(result.sheets[0].filePath);
    expect(cellColor(output, COLS, CELL, 1)).toEqual(REPLACED_COLOR);
    expect(cellColor(output, COLS, CELL, 2)).toEqual(slotColor(2));
    expect(cellColor(output, COLS, CELL, 3)).toEqual(slotColor(3));
  });

  it('显式模式下卡图 mtime 旧于源图集 → 仍替换', async () => {
    await setupStandardSheet();
    await writeCardPng(10101, CELL, OLD_MTIME);

    const result = await runInplace([10101]);

    expect(result.sheets[0].modifiedCount).toBe(1);
    const output = await rawOf(result.sheets[0].filePath);
    expect(cellColor(output, COLS, CELL, 1)).toEqual(REPLACED_COLOR);
  });

  it('modifiedCardIds 含 cards.csv 中不存在的 CardID → 忽略，不报错', async () => {
    await setupStandardSheet();
    await writeCardPng(99999, CELL, NEW_MTIME); // 不在 cards.csv 里的卡

    const result = await runInplace([99999, 10101]);

    // 99999 不在 csv → 忽略；10101 声明了但卡图不存在 → 回退源像素
    expect(result.sheets[0].modifiedCount).toBe(0);
    const output = await rawOf(result.sheets[0].filePath);
    expectSamePixels(
      await rawOf(await readFile(path.join(sourceDir, 'sheet-1.png'))),
      output,
    );
  });

  it('显式声明的卡图文件缺失 → 回退源像素，不报错（契约 3c：存在于 deckDir 是前提）', async () => {
    await setupStandardSheet(); // 不写任何卡图

    const result = await runInplace([10101, 10104]);

    expect(result.sheets[0].modifiedCount).toBe(0);
    const output = await rawOf(result.sheets[0].filePath);
    expect(cellColor(output, COLS, CELL, 1)).toEqual(slotColor(1));
    expect(cellColor(output, COLS, CELL, 4)).toEqual(slotColor(4));
  });
});

// ---------------------------------------------------------------------------
// 错误路径
// ---------------------------------------------------------------------------

describe('inplaceAtlas 错误路径', () => {
  it('cards.csv 不存在 → INPLACE_CARDS_NOT_FOUND', async () => {
    // deckDir 存在但没有 cards.csv
    await expectInplaceError(
      () => runInplace(),
      'INPLACE_CARDS_NOT_FOUND',
      'error.pack.inplaceCardsNotFound',
      'cards.csv',
    );
  });

  it('source/sheet-1.png 缺失 → INPLACE_SOURCE_MISSING', async () => {
    await writeStandardCsv(1); // cards.csv 有 sheet 1 的行，但 source 目录为空

    await expectInplaceError(
      () => runInplace(),
      'INPLACE_SOURCE_MISSING',
      'error.pack.inplaceSourceMissing',
      'sheet-1.png',
    );
  });

  it('多图集时 sheet-2.png 缺失 → INPLACE_SOURCE_MISSING', async () => {
    await writeSourceSheet(1);
    await writeDeckCsv([
      csvLine(10101, 'card_10101.png', 1, 1, COLS, ROWS),
      csvLine(10201, 'card_10201.png', 2, 1, COLS, ROWS),
    ]);

    await expectInplaceError(
      () => runInplace(),
      'INPLACE_SOURCE_MISSING',
      'error.pack.inplaceSourceMissing',
      'sheet-2.png',
    );
  });

  it('mtime 判改但卡图尺寸不符（50x50 ≠ cell 100）→ INPLACE_CELL_SIZE_MISMATCH', async () => {
    await setupStandardSheet();
    await writeCardPng(10101, 50, NEW_MTIME); // 尺寸错的卡图（mtime 新 → 判为改过）

    const err = await expectInplaceError(
      () => runInplace(),
      'INPLACE_CELL_SIZE_MISMATCH',
      'error.pack.inplaceCellSizeMismatch',
      '10101',
    );
    expect(err.message === 'error.pack.inplaceCellSizeMismatch' || err.message.includes('50x50')).toBe(true);
  });

  it('显式模式卡图尺寸不符 → INPLACE_CELL_SIZE_MISMATCH', async () => {
    await setupStandardSheet();
    await writeCardPng(10104, 30, OLD_MTIME); // mtime 旧，但显式声明改过 → 仍会校验尺寸

    await expectInplaceError(
      () => runInplace([10104]),
      'INPLACE_CELL_SIZE_MISMATCH',
      'error.pack.inplaceCellSizeMismatch',
      '30x30',
    );
  });

  it('显式 cellSize 与源图集不符（源 300x200，cellSize=150）→ INPLACE_GRID_MISMATCH', async () => {
    await setupStandardSheet();

    await expectInplaceError(
      () => inplaceAtlas({ deckDir, sourceDir, outDir, cellSize: 150 }),
      'INPLACE_GRID_MISMATCH',
      'error.pack.inplaceGridMismatch',
      '300x200',
    );
  });

  it('推断模式：源图集宽不能被 sheet_cols 整除 → INPLACE_GRID_MISMATCH', async () => {
    // 305x200（3x2）：305 % 3 ≠ 0
    const raw = Buffer.alloc(305 * 200 * 4);
    await writeFile(
      path.join(sourceDir, 'sheet-1.png'),
      await sharp(raw, { raw: { width: 305, height: 200, channels: 4 } }).png().toBuffer(),
    );
    await writeStandardCsv(1);

    await expectInplaceError(
      () => runInplace(),
      'INPLACE_GRID_MISMATCH',
      'error.pack.inplaceGridMismatch',
      '305x200',
    );
  });

  it('推断模式：源图集高不能被 sheet_rows 整除 → INPLACE_GRID_MISMATCH', async () => {
    // 300x201（3x2）：201 % 2 ≠ 0
    const raw = Buffer.alloc(300 * 201 * 4);
    await writeFile(
      path.join(sourceDir, 'sheet-1.png'),
      await sharp(raw, { raw: { width: 300, height: 201, channels: 4 } }).png().toBuffer(),
    );
    await writeStandardCsv(1);

    await expectInplaceError(
      () => runInplace(),
      'INPLACE_GRID_MISMATCH',
      'error.pack.inplaceGridMismatch',
      '300x201',
    );
  });

  it('推断模式：格子非正方形（400x200 声明 2x2）→ INPLACE_GRID_MISMATCH', async () => {
    const raw = Buffer.alloc(400 * 200 * 4);
    await writeFile(
      path.join(sourceDir, 'sheet-1.png'),
      await sharp(raw, { raw: { width: 400, height: 200, channels: 4 } }).png().toBuffer(),
    );
    await writeDeckCsv([csvLine(10101, 'card_10101.png', 1, 1, 2, 2)]);

    const err = await expectInplaceError(
      () => runInplace(),
      'INPLACE_GRID_MISMATCH',
      'error.pack.inplaceGridMismatch',
      '400x200',
    );
    expect(err.message === 'error.pack.inplaceGridMismatch' || err.message.includes('200x100')).toBe(true);
  });

  it('同一 sheet 的 sheet_cols/sheet_rows 声明不一致 → INPLACE_GRID_MISMATCH', async () => {
    await writeSourceSheet(1);
    await writeDeckCsv([
      csvLine(10101, 'card_10101.png', 1, 1, 3, 2),
      csvLine(10102, 'card_10102.png', 1, 2, 4, 2), // 同 sheet 声明不同列数
    ]);

    await expectInplaceError(
      () => runInplace(),
      'INPLACE_GRID_MISMATCH',
      'error.pack.inplaceGridMismatch',
      '4x2',
    );
  });

  it('cellSize 非正整数（0）→ 普通 Error（调用方编程错误，非 PackError）', async () => {
    await setupStandardSheet();

    await expect(
      inplaceAtlas({ deckDir, sourceDir, outDir, cellSize: 0 }),
    ).rejects.toThrow(/cellSize/);
    await expect(
      inplaceAtlas({ deckDir, sourceDir, outDir, cellSize: -100 }),
    ).rejects.toThrow(/cellSize/);
  });
});

// ---------------------------------------------------------------------------
// 回归验收（方案设计：尺寸 / 布局 / 格子位置不变；cards.csv 不动）
// ---------------------------------------------------------------------------

describe('inplaceAtlas 回归验收', () => {
  it('输出图集尺寸与源完全一致（不静默改图集大小）', async () => {
    await setupStandardSheet();
    await writeCardPng(10101, CELL, NEW_MTIME);
    await writeCardPng(10106, CELL, NEW_MTIME);

    const result = await runInplace();

    const sourceMeta = await sharp(path.join(sourceDir, 'sheet-1.png')).metadata();
    const outputMeta = await sharp(result.sheets[0].filePath).metadata();
    expect(outputMeta.width).toBe(sourceMeta.width);
    expect(outputMeta.height).toBe(sourceMeta.height);
    expect(outputMeta.width).toBe(300);
    expect(outputMeta.height).toBe(200);
  });

  it('原位拼回不改写 cards.csv（逐字节不变）', async () => {
    await setupStandardSheet();
    await writeCardPng(10102, CELL, NEW_MTIME);
    const csvPath = path.join(deckDir, 'cards.csv');
    const before = await readFile(csvPath);
    const beforeStat = await stat(csvPath);

    await runInplace();

    const after = await readFile(csvPath);
    const afterStat = await stat(csvPath);
    expect(Buffer.compare(before, after)).toBe(0);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });
});
