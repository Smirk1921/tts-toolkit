// tests/unit/deck-grid.test.ts
/**
 * src/deck/grid.ts 单元测试：网格布局计算 / 宽高比推断 / 70 格上限。
 *
 * 纯计算模块（无文件 IO、无网络、无 sharp 依赖），因此不需要临时目录：
 * - 正常路径：cellSize 向下取整、slotToRect 的 1 基行优先定位（B2 坑 1）、
 *   余数像素归最后一列/行（边缘吸收）、inferGrid 按"最小浪费 → 单格趋近正方形 →
 *   列数趋近 10"四级字典序推断、sheetsNeeded / cardsInSheet 的 70 格拆分；
 * - 异常路径：按 PackError.code（机器可读）断言，不依赖错误文案——
 *   message 走 t()，断言写成双态（键名原样输出 或 补齐后的中文文案）；
 *   调用方编程错误（越界 slot、非法尺寸、非整数卡数）按仓库惯例抛普通
 *   中文 Error 而非 PackError，单独断言；
 * - 边界值：网格 1x1 / 10x7 上下界、slot=1 / slot=70、minCells=70 / 71、
 *   4095（非整除余数 5）、70 格矩形恰好铺满整图（无重叠无空隙）。
 */
import { describe, expect, it } from 'vitest';

import { PackError } from '../../src/pack/packyaml.js';
import {
  MAX_COLUMNS,
  MAX_ROWS,
  MAX_SLOTS,
  assertValidGrid,
  cardsInSheet,
  cellSize,
  inferGrid,
  sheetsNeeded,
  slotToRect,
  type GridSpec,
} from '../../src/deck/grid.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/**
 * 断言 fn 同步抛出指定 code 的 PackError，并返回该错误。
 * @param fn 待执行（预期抛 PackError）的函数
 * @param code 期望的机器可读错误码
 * @returns 实际抛出的 PackError（可对 message 做进一步断言）
 */
function expectPackError(fn: () => unknown, code: string): PackError {
  try {
    fn();
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
 * 断言 fn 同步抛出普通 Error（调用方编程错误），并返回该错误。
 * @param fn 待执行（预期抛普通 Error）的函数
 * @param messagePart 期望 message 包含的片段
 * @returns 实际抛出的 Error
 */
function expectPlainError(fn: () => unknown, messagePart: string): Error {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PackError);
    const error = err as Error;
    expect(error.message).toContain(messagePart);
    return error;
  }
  throw new Error(`预期抛出包含 "${messagePart}" 的普通 Error，但调用成功了`);
}

/**
 * 暴力求在 10x7 候选范围内面积 >= minCells 的最小面积。
 * @param minCells 需要的最少格数
 * @returns 可达的最小面积
 */
function bruteMinArea(minCells: number): number {
  let min = Number.POSITIVE_INFINITY;
  for (let columns = 1; columns <= MAX_COLUMNS; columns++) {
    for (let rows = 1; rows <= MAX_ROWS; rows++) {
      const area = columns * rows;
      if (area >= minCells && area < min) {
        min = area;
      }
    }
  }
  return min;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

describe('常量：TTS 网格硬上限', () => {
  it('MAX_COLUMNS=10、MAX_ROWS=7、MAX_SLOTS=70（10*7，隐藏面固定占最后一格）', () => {
    expect(MAX_COLUMNS).toBe(10);
    expect(MAX_ROWS).toBe(7);
    expect(MAX_SLOTS).toBe(MAX_COLUMNS * MAX_ROWS);
    expect(MAX_SLOTS).toBe(70);
  });
});

// ---------------------------------------------------------------------------
// assertValidGrid
// ---------------------------------------------------------------------------

describe('assertValidGrid', () => {
  it('边界内合法组合不抛：1x1、10x7、1x7、10x1、5x5、9x7', () => {
    expect(() => assertValidGrid(1, 1)).not.toThrow();
    expect(() => assertValidGrid(MAX_COLUMNS, MAX_ROWS)).not.toThrow();
    expect(() => assertValidGrid(1, MAX_ROWS)).not.toThrow();
    expect(() => assertValidGrid(MAX_COLUMNS, 1)).not.toThrow();
    expect(() => assertValidGrid(5, 5)).not.toThrow();
    expect(() => assertValidGrid(9, 7)).not.toThrow();
  });

  it('columns 越界（0 / 11 / -1）→ ATLAS_INVALID_GRID，message 双态', () => {
    for (const columns of [0, MAX_COLUMNS + 1, -1]) {
      const err = expectPackError(() => assertValidGrid(columns, 7), 'ATLAS_INVALID_GRID');
      expect(err.message === 'error.pack.atlasInvalidGrid' || err.message.includes('columns')).toBe(true);
    }
  });

  it('rows 越界（0 / 8）→ ATLAS_INVALID_GRID', () => {
    for (const rows of [0, MAX_ROWS + 1]) {
      expectPackError(() => assertValidGrid(10, rows), 'ATLAS_INVALID_GRID');
    }
  });

  it('非整数（2.5 / NaN / Infinity）→ ATLAS_INVALID_GRID', () => {
    expectPackError(() => assertValidGrid(2.5, 3), 'ATLAS_INVALID_GRID');
    expectPackError(() => assertValidGrid(Number.NaN, 3), 'ATLAS_INVALID_GRID');
    expectPackError(() => assertValidGrid(10, Number.POSITIVE_INFINITY), 'ATLAS_INVALID_GRID');
  });

  it('columns*rows=71（借 71x1 触发乘积上限兜底）→ ATLAS_INVALID_GRID', () => {
    // 71x1 同时越 columns 上限，先命中列数分支；乘积兜底分支只在列行都越界时可达
    const err = expectPackError(() => assertValidGrid(71, 1), 'ATLAS_INVALID_GRID');
    expect(err.message === 'error.pack.atlasInvalidGrid' || err.message.includes('columns')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cellSize
// ---------------------------------------------------------------------------

describe('cellSize', () => {
  it('4096x4096 10x7 → 409x585（向下取整，不是 409.6 / 585.14）', () => {
    expect(cellSize(4096, 4096, 10, 7)).toEqual({ width: 409, height: 585 });
  });

  it('4096x4096 10x5 → 409x819；10x2 → 409x2048', () => {
    expect(cellSize(4096, 4096, 10, 5)).toEqual({ width: 409, height: 819 });
    expect(cellSize(4096, 4096, 10, 2)).toEqual({ width: 409, height: 2048 });
  });

  it('整除时无余数：4096x4096 8x4 → 512x1024', () => {
    expect(cellSize(4096, 4096, 8, 4)).toEqual({ width: 512, height: 1024 });
  });

  it('非整除各自向下取整：2048x1024 7x3 → 292x341', () => {
    expect(cellSize(2048, 1024, 7, 3)).toEqual({ width: 292, height: 341 });
  });

  it('imageWidth=5, columns=10（格子太细）→ ATLAS_GRID_TOO_FINE，message 双态', () => {
    const err = expectPackError(() => cellSize(5, 4096, 10, 7), 'ATLAS_GRID_TOO_FINE');
    expect(err.message === 'error.pack.atlasGridTooFine' || err.message.includes('10x7')).toBe(true);
  });

  it('imageHeight 太小（4096x6 按 7 行切）→ ATLAS_GRID_TOO_FINE', () => {
    expectPackError(() => cellSize(4096, 6, 10, 7), 'ATLAS_GRID_TOO_FINE');
  });

  it('imageWidth=0 → ATLAS_GRID_TOO_FINE（图集比格子还小）', () => {
    expectPackError(() => cellSize(0, 4096, 10, 7), 'ATLAS_GRID_TOO_FINE');
  });

  it('网格声明非法（columns=11 / rows=8）→ ATLAS_INVALID_GRID', () => {
    expectPackError(() => cellSize(4096, 4096, 11, 7), 'ATLAS_INVALID_GRID');
    expectPackError(() => cellSize(4096, 4096, 10, 8), 'ATLAS_INVALID_GRID');
  });

  it('尺寸为负数 / 非整数 → 普通 Error（调用方编程错误，不是 PackError）', () => {
    expectPlainError(() => cellSize(-1, 4096, 10, 7), 'imageWidth');
    expectPlainError(() => cellSize(4096.5, 4096, 10, 7), 'imageWidth');
    expectPlainError(() => cellSize(4096, Number.NaN, 10, 7), 'imageHeight');
  });
});

// ---------------------------------------------------------------------------
// slotToRect（1 基：B2 坑 1）
// ---------------------------------------------------------------------------

describe('slotToRect：4096x4096 10x7 基准网格', () => {
  const W = 4096;
  const H = 4096;
  const COLS = 10;
  const ROWS = 7;

  it('slot=1 → 左上角 {0,0,409,585}', () => {
    expect(slotToRect(1, W, H, COLS, ROWS)).toEqual({ left: 0, top: 0, width: 409, height: 585 });
  });

  it('slot=10 → 第一行最后一格 {3681,0,415,585}（列余数 6 吸收进最后一列）', () => {
    expect(slotToRect(10, W, H, COLS, ROWS)).toEqual({ left: 3681, top: 0, width: 415, height: 585 });
  });

  it('slot=11 → 跨行到第二行第一格 {0,585,409,585}（1 基：第 11 张不在第一行）', () => {
    expect(slotToRect(11, W, H, COLS, ROWS)).toEqual({ left: 0, top: 585, width: 409, height: 585 });
  });

  it('slot=70 → 右下角 {3681,3510,415,586}（行余数 1 吸收进最后一行，即隐藏面所在格）', () => {
    expect(slotToRect(70, W, H, COLS, ROWS)).toEqual({ left: 3681, top: 3510, width: 415, height: 586 });
  });

  it('余数吸收（任务点名场景）：4095 宽按 10 列切 → 单格 409 余 5，最后一列宽 409+5=414', () => {
    expect(slotToRect(1, 4095, 4095, 10, 7)).toEqual({ left: 0, top: 0, width: 409, height: 585 });
    const lastColumn = slotToRect(10, 4095, 4095, 10, 7);
    expect(lastColumn.left).toBe(9 * 409);
    expect(lastColumn.width).toBe(414);
  });

  it('行余数吸收：4095x4096 按 10x7 切，最后一行（slot 64..70）高 586', () => {
    for (let slot = 64; slot <= 70; slot++) {
      const rect = slotToRect(slot, 4095, 4096, 10, 7);
      expect(rect.top).toBe(6 * 585);
      expect(rect.height).toBe(4096 - 6 * 585);
      expect(rect.height).toBe(586);
    }
  });

  it('平铺不变量：70 个矩形恰好铺满 4096x4096（无重叠、无空隙）', () => {
    const cell = cellSize(W, H, COLS, ROWS);
    for (let slot = 1; slot <= MAX_SLOTS; slot++) {
      const rect = slotToRect(slot, W, H, COLS, ROWS);
      const index = slot - 1; // 1 基 → 0 基（仅测试内部换算）
      const column = index % COLS;
      const row = Math.floor(index / COLS);
      expect(rect.left).toBe(column * cell.width);
      expect(rect.top).toBe(row * cell.height);
      // 右缘：非末列 = 下一列起点；末列 = 图宽。底缘同理 —— 保证无重叠无空隙
      expect(rect.left + rect.width).toBe(column < COLS - 1 ? (column + 1) * cell.width : W);
      expect(rect.top + rect.height).toBe(row < ROWS - 1 ? (row + 1) * cell.height : H);
      expect(rect.width).toBeGreaterThanOrEqual(1);
      expect(rect.height).toBeGreaterThanOrEqual(1);
    }
  });

  it('非末列/行的宽高与 cellSize 一致', () => {
    const cell = cellSize(W, H, COLS, ROWS);
    const rect = slotToRect(13, W, H, COLS, ROWS); // 第二行第三格
    expect(rect.width).toBe(cell.width);
    expect(rect.height).toBe(cell.height);
  });

  it('slot 越界（0 / 71 / -1 / 2.5）→ 普通 Error 且不是 PackError', () => {
    expectPlainError(() => slotToRect(0, W, H, COLS, ROWS), 'slot');
    expectPlainError(() => slotToRect(MAX_SLOTS + 1, W, H, COLS, ROWS), 'slot');
    expectPlainError(() => slotToRect(-1, W, H, COLS, ROWS), 'slot');
    expectPlainError(() => slotToRect(2.5, W, H, COLS, ROWS), 'slot');
  });
});

// ---------------------------------------------------------------------------
// inferGrid
// ---------------------------------------------------------------------------

describe('inferGrid', () => {
  it('4096x4096 + minCells=70 → 10x7（唯一能装下 70 格的候选）', () => {
    expect(inferGrid(4096, 4096, 70)).toEqual({ columns: 10, rows: 7 });
  });

  it('2048x1024 + minCells=20 → 10x2（任务验收集允许 10x2 或 7x3；零浪费候选中列数趋近 10 者胜）', () => {
    expect(inferGrid(2048, 1024, 20)).toEqual({ columns: 10, rows: 2 });
  });

  it('2048x1024 + minCells=21 → 7x3（零浪费且单格最接近正方形，验收集的另一值）', () => {
    expect(inferGrid(2048, 1024, 21)).toEqual({ columns: 7, rows: 3 });
  });

  it('4096x4096 + minCells=1 → 1x1；minCells=25 → 5x5（面积恰好的唯一因数对）', () => {
    expect(inferGrid(4096, 4096, 1)).toEqual({ columns: 1, rows: 1 });
    expect(inferGrid(4096, 4096, 25)).toEqual({ columns: 5, rows: 5 });
  });

  it('面积恰好的唯一因数对：4096x4096 + 48 → 8x6；+63 → 9x7（复现实测 TTS 网格）', () => {
    expect(inferGrid(4096, 4096, 48)).toEqual({ columns: 8, rows: 6 });
    expect(inferGrid(4096, 4096, 63)).toEqual({ columns: 9, rows: 7 });
  });

  it('同面积因数对按单格趋近正方形定向：4096x4096 + 42 → 7x6（竖版格子）；+15 → 5x3', () => {
    expect(inferGrid(4096, 4096, 42)).toEqual({ columns: 7, rows: 6 });
    expect(inferGrid(4096, 4096, 15)).toEqual({ columns: 5, rows: 3 });
  });

  it('minCells=69 → 10x7（装不下 69 的最小面积是 70）', () => {
    expect(inferGrid(4096, 4096, 69)).toEqual({ columns: 10, rows: 7 });
  });

  it('minCells=0（退化输入）→ 1x1（文档化行为：按 0 处理取最小面积）', () => {
    expect(inferGrid(4096, 4096, 0)).toEqual({ columns: 1, rows: 1 });
  });

  it('minCells=71 → ATLAS_TOO_MANY_CELLS，message 双态（含上限 70）', () => {
    const err = expectPackError(() => inferGrid(4096, 4096, 71), 'ATLAS_TOO_MANY_CELLS');
    expect(err.message === 'error.pack.atlasTooManyCells' || err.message.includes('70')).toBe(true);
  });

  it('尺寸非正整数或 minCells 非有限数字 → 普通 Error（调用方编程错误）', () => {
    // 0 先过"非负整数"检查，再命中 inferGrid 自己的"必须为正"分支
    expectPlainError(() => inferGrid(0, 4096, 5), 'inferGrid');
    // 负数 / 非整数在 assertImageSize 就被拦下
    expectPlainError(() => inferGrid(-1, 4096, 5), 'imageWidth');
    expectPlainError(() => inferGrid(4096.5, 4096, 5), 'imageWidth');
    expectPlainError(() => inferGrid(4096, 4096, Number.NaN), 'minCells');
    expectPlainError(() => inferGrid(4096, 4096, Number.POSITIVE_INFINITY), 'minCells');
  });

  it('性质：minCells=1..70 时结果在界内且面积是可达最小值（浪费格数最少优先）', () => {
    for (let minCells = 1; minCells <= MAX_SLOTS; minCells++) {
      const spec: GridSpec = inferGrid(4096, 4096, minCells);
      expect(spec.columns).toBeGreaterThanOrEqual(1);
      expect(spec.columns).toBeLessThanOrEqual(MAX_COLUMNS);
      expect(spec.rows).toBeGreaterThanOrEqual(1);
      expect(spec.rows).toBeLessThanOrEqual(MAX_ROWS);
      const area = spec.columns * spec.rows;
      expect(area).toBeGreaterThanOrEqual(minCells);
      expect(area).toBe(bruteMinArea(minCells));
    }
  });

  it('推断结果可直接喂给 cellSize / slotToRect（2048x1024 + 20 → 10x2）', () => {
    const spec = inferGrid(2048, 1024, 20);
    expect(spec).toEqual({ columns: 10, rows: 2 });
    expect(cellSize(2048, 1024, spec.columns, spec.rows)).toEqual({ width: 204, height: 512 });
    // 第 20 张（末格）：第二行最后一列，列余数 8 吸收 → 宽 212
    expect(slotToRect(20, 2048, 1024, spec.columns, spec.rows)).toEqual({
      left: 1836,
      top: 512,
      width: 212,
      height: 512,
    });
  });
});

// ---------------------------------------------------------------------------
// sheetsNeeded / cardsInSheet：70 格上限拆分
// ---------------------------------------------------------------------------

describe('sheetsNeeded', () => {
  it('任务点名取值：0→0、1→1、70→1、71→2、140→2、141→3', () => {
    expect(sheetsNeeded(0)).toBe(0);
    expect(sheetsNeeded(1)).toBe(1);
    expect(sheetsNeeded(70)).toBe(1);
    expect(sheetsNeeded(71)).toBe(2);
    expect(sheetsNeeded(140)).toBe(2);
    expect(sheetsNeeded(141)).toBe(3);
  });

  it('负数 → 0；69 → 1；210 → 3；211 → 4', () => {
    expect(sheetsNeeded(-5)).toBe(0);
    expect(sheetsNeeded(69)).toBe(1);
    expect(sheetsNeeded(210)).toBe(3);
    expect(sheetsNeeded(211)).toBe(4);
  });

  it('非整数 → 普通 Error（调用方编程错误）', () => {
    expectPlainError(() => cardsInSheet(70.5, 0), 'totalCards');
    expectPlainError(() => sheetsNeeded(Number.NaN), 'totalCards');
  });
});

describe('cardsInSheet', () => {
  it('totalCards=71：sheet0=70、sheet1=1、sheet2=0（最后一张不满 70）', () => {
    expect(cardsInSheet(71, 0)).toBe(70);
    expect(cardsInSheet(71, 1)).toBe(1);
    expect(cardsInSheet(71, 2)).toBe(0);
  });

  it('totalCards=140：前两张各 70、第三张 0；totalCards=205：sheet2=65', () => {
    expect(cardsInSheet(140, 0)).toBe(70);
    expect(cardsInSheet(140, 1)).toBe(70);
    expect(cardsInSheet(140, 2)).toBe(0);
    expect(cardsInSheet(205, 2)).toBe(65);
  });

  it('totalCards=0 或负数 → 任何一张都是 0', () => {
    expect(cardsInSheet(0, 0)).toBe(0);
    expect(cardsInSheet(-3, 0)).toBe(0);
  });

  it('totalCards 非整数，或 sheetIndex 非整数 / 负数 → 普通 Error（调用方编程错误）', () => {
    expectPlainError(() => cardsInSheet(70.5, 0), 'totalCards');
    expectPlainError(() => cardsInSheet(70, -1), 'sheetIndex');
    expectPlainError(() => cardsInSheet(70, 0.5), 'sheetIndex');
  });

  it('与 sheetsNeeded 一致：sum(cardsInSheet(n,i)) === n（n=0..300 抽样全验）', () => {
    for (let total = 0; total <= 300; total++) {
      const sheets = sheetsNeeded(total);
      let sum = 0;
      for (let i = 0; i < sheets; i++) {
        const count = cardsInSheet(total, i);
        expect(count).toBeGreaterThanOrEqual(0);
        expect(count).toBeLessThanOrEqual(MAX_SLOTS);
        sum += count;
      }
      expect(sum).toBe(total);
    }
  });
});
