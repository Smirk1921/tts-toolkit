// src/deck/grid.ts
/**
 * 网格布局计算：TTS 图集的网格推断、单格尺寸、slot → 像素矩形、70 格上限。
 *
 * 职责（纯计算，无 IO；图集图片的实际尺寸由调用方用 sharp 读取后传入）：
 * - {@link MAX_COLUMNS} / {@link MAX_ROWS} / {@link MAX_SLOTS}：TTS 网格硬上限；
 * - {@link inferGrid}：由图集实际宽高比 + 需要的格数推断最优网格（绝不写死 10×7）；
 * - {@link cellSize}：由图集尺寸 + 网格声明算单格整数像素尺寸；
 * - {@link slotToRect}：由 slot（1 基）算单格像素矩形，可直接传给 sharp.extract()；
 * - {@link assertValidGrid}：校验网格声明（与 deck.yaml atlas 的 zod 范围等价，抛 PackError）；
 * - {@link sheetsNeeded} / {@link cardsInSheet}：按 70 格上限拆分多张图集。
 *
 * TTS 硬约束（方案设计 §5.3，已实测验证）：
 * - 单张图集网格至多 10 列 × 7 行 = 70 格（14,693 个 CustomDeck 无一超过）；
 * - 实测网格有 10x7 / 10x5 / 8x6 / 9x7 / 5x5 / 3x5 / 1x1 等——网格不是固定 10×7，
 *   必须由图集实际宽高比 + 需要的格数推断；
 * - 隐藏面固定占用图集最后一格（slot = columns*rows，10×7 时即第 70 格）。
 *
 * slot 索引基准（B2 坑 1，全模块统一 1 基，绝不发明 0 基对外接口）：
 * TTS 存档的 CardID % 100 是 1 基（行优先，左→右、上→下，从 1 开始），
 * {@link slotToRect} 的 slot 与之同基准：slot=1 是左上角第一格，
 * slot=columns 是第一行最后一格，slot=columns+1 起跨到第二行第一格。
 *
 * 余数吸收规则：cellWidth = floor(imageWidth / columns)，整除余下的像素
 * （imageWidth % columns）全部归入最后一列（最后一行同理），不做四舍五入、
 * 不均匀分布——否则 slotToRect 的切分位置会与图集实际像素错位。
 *
 * 错误码（PackError.code，错误类型复用 src/pack/packyaml.ts 的 PackError）：
 * - "ATLAS_TOO_MANY_CELLS" 需要的格数超过单张图集上限 70；
 * - "ATLAS_GRID_TOO_FINE"  图集尺寸按网格切分后单格宽或高为 0（图集比格子还小）；
 * - "ATLAS_INVALID_GRID"   网格声明不合法（列 / 行数越界或非整数、乘积超 70）。
 *
 * 本模块新增的 i18n 键（locales/*.json 已补占位键；缺键时 t() 原样输出键名）：
 * - `error.pack.atlasTooManyCells` {minCells} {maxSlots}
 * - `error.pack.atlasGridTooFine` {imageWidth} {imageHeight} {columns} {rows}
 * - `error.pack.atlasInvalidGrid` {detail}
 *
 * 调用方编程错误（负数 / 非整数的尺寸、越界的 slot、非整数的卡数等）按仓库惯例
 * 抛普通中文 Error 而不是 PackError（与 src/pack/manifest.ts 的 assertDirPath 同一考虑）；
 * 数据性错误（图集太小、网格声明越界、超 70 格）才抛 PackError。
 *
 * inferGrid 评分（实现决策，必读）：
 * 契约原文的得分式 `|图集宽高比 - 单格宽高比 * (columns/rows)|` 中，"单格宽高比"
 * 按其给定定义（= 图集宽高比 / (columns/rows)）代入后恒等于图集宽高比——
 * 得分对任何候选恒为 0，无法区分。为保证结果确定且落在任务验收集内
 * （2048x1024 + minCells=20 → 10x2 或 7x3，而非"最接近正方形"的 10x5 / 8x4），
 * 实现按以下四级字典序取最优：
 * 1. 浪费格数最少：columns*rows - minCells 最小（面积恰好够装下所需格数）——
 *    TTS 实测网格 10x7 / 10x5 / 8x6 / 9x7 / 5x5 / 1x1 的面积都恰好等于卡数，
 *    这一级保证"由图片尺寸 + 格数反推网格"能还原原声明（verify.ts 往返校验的前提）；
 * 2. 同面积并列时，单格更趋近正方形：|单格宽高比 - 1| 最小，其中
 *    单格宽高比 = (imageWidth/columns) / (imageHeight/rows) = 图集宽高比 * (rows/columns)
 *    （即契约定义的"单格宽高比"，理想值 1 对应正方形格子）；
 * 3. 仍并列（浮点容差 1e-9 内）时，columns 更接近 10（更接近 TTS 默认，契约原文）；
 * 4. 最后取 rows 较小者，保证全序确定。
 * 例：4096x4096 + minCells=70 → 10x7（唯一候选）；2048x1024 + minCells=20 →
 * 零浪费候选 (10x2)/(5x4)/(4x5) 中按 2、3 级判给 10x2；minCells=21 → 7x3
 * （零浪费且最接近正方形）——两者都在任务验收集内。
 */

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 网格列数上限（TTS 硬约束） */
export const MAX_COLUMNS = 10;

/** 网格行数上限（TTS 硬约束） */
export const MAX_ROWS = 7;

/** 单张图集格子数上限（10 × 7 = 70；TTS 隐藏面固定占用最后一格） */
export const MAX_SLOTS = MAX_COLUMNS * MAX_ROWS;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单格尺寸（图集像素 ÷ 格子数，向下取整到整数像素，避免奇数切割） */
export interface CellSize {
  width: number;
  height: number;
}

/** 网格声明（deck.yaml atlas.columns / atlas.rows 的等价物） */
export interface GridSpec {
  columns: number;
  rows: number;
}

/** slot 在图集中的像素矩形（字段与 sharp.extract() 的提取区域一致） */
export interface SlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 校验图集像素尺寸：必须是非负整数。
 * 0 允许传入（由切分逻辑按"图集太小"报 PackError）；负数 / 非整数属于
 * 调用方编程错误，按仓库惯例抛普通中文 Error。
 * @param value 待校验的像素值
 * @param argName 入参名（用于错误信息）
 * @throws value 不是非负整数时抛出中文错误
 */
function assertImageSize(value: number, argName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`网格入参无效：${argName} 必须是非负整数像素（收到 ${String(value)}）`);
  }
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 校验网格声明合法性（与 deck.yaml atlas 的 zod schema 范围等价，但抛 PackError）：
 * - columns 整数 [1, 10]；rows 整数 [1, 7]；
 * - columns * rows <= 70（在列行上限内天然满足，此处显式兜底）；
 * - 任一失败抛 PackError code="ATLAS_INVALID_GRID"。
 *
 * @param columns 网格列数
 * @param rows 网格行数
 * @throws PackError code="ATLAS_INVALID_GRID" 任一约束不满足时
 */
export function assertValidGrid(columns: number, rows: number): void {
  if (!Number.isInteger(columns) || columns < 1 || columns > MAX_COLUMNS) {
    throw new PackError(
      "ATLAS_INVALID_GRID",
      t("error.pack.atlasInvalidGrid", {
        detail: `columns 必须是 1-${MAX_COLUMNS} 的整数（收到 ${String(columns)}）`,
      }),
    );
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) {
    throw new PackError(
      "ATLAS_INVALID_GRID",
      t("error.pack.atlasInvalidGrid", {
        detail: `rows 必须是 1-${MAX_ROWS} 的整数（收到 ${String(rows)}）`,
      }),
    );
  }
  if (columns * rows > MAX_SLOTS) {
    throw new PackError(
      "ATLAS_INVALID_GRID",
      t("error.pack.atlasInvalidGrid", {
        detail: `columns*rows 不能超过 ${MAX_SLOTS}（收到 ${columns}*${rows}=${columns * rows}）`,
      }),
    );
  }
}

/**
 * 由图集尺寸 + 网格声明算单格尺寸（整数像素）。
 *
 * 规则：
 * - cellWidth = floor(imageWidth / columns)；cellHeight = floor(imageHeight / rows)；
 * - 余数像素（imageWidth % columns）不在本函数体现，由 {@link slotToRect}
 *   归入最后一列 / 最后一行（边缘吸收）；
 * - 若 cellWidth 或 cellHeight 为 0（图集比格子还小），抛
 *   PackError code="ATLAS_GRID_TOO_FINE"。
 *
 * @param imageWidth 图集图片实际宽度（像素）
 * @param imageHeight 图集图片实际高度（像素）
 * @param columns 网格列数
 * @param rows 网格行数
 * @returns 单格尺寸（整数像素）
 * @throws Error imageWidth / imageHeight 为负数或非整数时（调用方编程错误）
 * @throws PackError code="ATLAS_INVALID_GRID" 网格声明不合法时
 * @throws PackError code="ATLAS_GRID_TOO_FINE" 单格宽或高为 0 时
 */
export function cellSize(imageWidth: number, imageHeight: number, columns: number, rows: number): CellSize {
  assertImageSize(imageWidth, "imageWidth");
  assertImageSize(imageHeight, "imageHeight");
  assertValidGrid(columns, rows);
  const width = Math.floor(imageWidth / columns);
  const height = Math.floor(imageHeight / rows);
  if (width === 0 || height === 0) {
    throw new PackError(
      "ATLAS_GRID_TOO_FINE",
      t("error.pack.atlasGridTooFine", { imageWidth, imageHeight, columns, rows }),
    );
  }
  return { width, height };
}

/**
 * 由 slot（1 基）+ 图集尺寸 + 网格声明算单格在图集中的像素矩形，
 * 返回值可直接传给 sharp.extract()（字段 left / top / width / height 一致）。
 *
 * 行优先、左→右、上→下（与 TTS CardID % 100 的 1 基顺序一致）：
 * slot=1 是左上角，slot=columns 是第一行最后一格，slot=columns+1 起跨行。
 * 最后一列的宽度 = imageWidth - left（吸收余数像素），最后一行同理，
 * 因此全部格子无重叠、无空隙地铺满整张图集。
 *
 * @param slot 格子序号（1 基，[1, columns*rows]）
 * @param imageWidth 图集图片实际宽度（像素）
 * @param imageHeight 图集图片实际高度（像素）
 * @param columns 网格列数
 * @param rows 网格行数
 * @returns 像素矩形
 * @throws Error slot 越界 / 非整数，或图集尺寸非法时（调用方编程错误）
 * @throws PackError code="ATLAS_INVALID_GRID" 网格声明不合法时
 * @throws PackError code="ATLAS_GRID_TOO_FINE" 单格宽或高为 0 时
 */
export function slotToRect(
  slot: number,
  imageWidth: number,
  imageHeight: number,
  columns: number,
  rows: number,
): SlotRect {
  const cell = cellSize(imageWidth, imageHeight, columns, rows);
  const total = columns * rows;
  if (!Number.isInteger(slot) || slot < 1 || slot > total) {
    throw new Error(`slotToRect 入参无效：slot 必须是 1-${total} 的整数（1 基，收到 ${String(slot)}）`);
  }
  // 1 基 → 0 基内部换算（对外接口保持 1 基，见模块头注释）
  const index = slot - 1;
  const column = index % columns;
  const row = Math.floor(index / columns);
  const left = column * cell.width;
  const top = row * cell.height;
  return {
    left,
    top,
    // 余数像素归最后一列 / 最后一行（边缘吸收），保证铺满整图
    width: column === columns - 1 ? imageWidth - left : cell.width,
    height: row === rows - 1 ? imageHeight - top : cell.height,
  };
}

// ---------------------------------------------------------------------------
// inferGrid：网格推断
// ---------------------------------------------------------------------------

/** 单格正方形偏差的并列判定容差（宽高比偏差仅用于同面积候选排序） */
const ASPECT_EPS = 1e-9;

/** inferGrid 的候选评分项 */
interface GridCandidate {
  /** 候选网格 */
  spec: GridSpec;
  /** 浪费格数 = columns*rows - minCells（越小越好，第一优先） */
  waste: number;
  /** 单格偏离正方形的程度 |单格宽高比 - 1|（越小越好，第二优先） */
  squarenessDeviation: number;
  /** 列数与 TTS 默认上限 10 的距离（越小越好，第三优先） */
  columnsFromMax: number;
  /** 行数（全序兜底，越小越好） */
  rows: number;
}

/**
 * 候选比较器：按 waste → squarenessDeviation（带容差）→ columnsFromMax → rows 字典序。
 * @param a 候选一
 * @param b 候选二
 * @returns a 排在前返回负数
 */
function compareCandidates(a: GridCandidate, b: GridCandidate): number {
  if (a.waste !== b.waste) {
    return a.waste - b.waste;
  }
  const deviationDiff = a.squarenessDeviation - b.squarenessDeviation;
  if (Math.abs(deviationDiff) > ASPECT_EPS) {
    return deviationDiff;
  }
  if (a.columnsFromMax !== b.columnsFromMax) {
    return a.columnsFromMax - b.columnsFromMax;
  }
  return a.rows - b.rows;
}

/**
 * 由图集图片实际尺寸 + 需要的格数推断最优网格。
 *
 * 候选范围：1 <= columns <= 10，1 <= rows <= 7，且 columns*rows >= minCells。
 * 评分次序（四级字典序， rationale 见模块头注释"inferGrid 评分"）：
 * 1. 浪费格数最少（columns*rows - minCells 最小）；
 * 2. 单格更趋近正方形（|图集宽高比*(rows/columns) - 1| 最小，容差 1e-9）；
 * 3. columns 更接近 10（更接近 TTS 默认）；
 * 4. rows 较小者。
 *
 * @param imageWidth 图集图片实际宽度（像素，正整数）
 * @param imageHeight 图集图片实际高度（像素，正整数）
 * @param minCells 需要容纳的最少格数（如卡数；<= 0 时按 0 处理，得 1x1）
 * @returns 推断出的网格声明
 * @throws Error 尺寸非正整数或 minCells 非有限数字时（调用方编程错误）
 * @throws PackError code="ATLAS_TOO_MANY_CELLS" minCells > 70 时
 */
export function inferGrid(imageWidth: number, imageHeight: number, minCells: number): GridSpec {
  assertImageSize(imageWidth, "imageWidth");
  assertImageSize(imageHeight, "imageHeight");
  if (imageWidth < 1 || imageHeight < 1) {
    throw new Error(
      `inferGrid 入参无效：imageWidth/imageHeight 必须是正整数（收到 ${imageWidth}x${imageHeight}）`,
    );
  }
  if (!Number.isFinite(minCells)) {
    throw new Error(`inferGrid 入参无效：minCells 必须是有限数字（收到 ${String(minCells)}）`);
  }
  if (minCells > MAX_SLOTS) {
    throw new PackError(
      "ATLAS_TOO_MANY_CELLS",
      t("error.pack.atlasTooManyCells", { minCells, maxSlots: MAX_SLOTS }),
    );
  }

  const imageAspect = imageWidth / imageHeight;
  // 先以 10×7（必然满足 minCells <= 70 的候选）为初始最优，再遍历所有候选替换
  let best: GridCandidate = {
    spec: { columns: MAX_COLUMNS, rows: MAX_ROWS },
    waste: MAX_SLOTS - minCells,
    squarenessDeviation: Math.abs((imageAspect * MAX_ROWS) / MAX_COLUMNS - 1),
    columnsFromMax: 0,
    rows: MAX_ROWS,
  };
  for (let columns = 1; columns <= MAX_COLUMNS; columns++) {
    for (let rows = 1; rows <= MAX_ROWS; rows++) {
      const area = columns * rows;
      if (area < minCells) {
        continue;
      }
      // 单格宽高比 = (imageWidth/columns) / (imageHeight/rows) = 图集宽高比 * (rows/columns)
      const cellAspect = (imageAspect * rows) / columns;
      const candidate: GridCandidate = {
        spec: { columns, rows },
        waste: area - minCells,
        squarenessDeviation: Math.abs(cellAspect - 1),
        columnsFromMax: Math.abs(columns - MAX_COLUMNS),
        rows,
      };
      if (compareCandidates(candidate, best) < 0) {
        best = candidate;
      }
    }
  }
  return best.spec;
}

// ---------------------------------------------------------------------------
// 多图集拆分
// ---------------------------------------------------------------------------

/**
 * 计算给定卡数需要几张图集（按 70 格上限向上取整）。
 * @param totalCards 卡牌总数（整数；<= 0 返回 0）
 * @returns 图集张数
 * @throws Error totalCards 非整数时（调用方编程错误）
 */
export function sheetsNeeded(totalCards: number): number {
  if (!Number.isInteger(totalCards)) {
    throw new Error(`sheetsNeeded 入参无效：totalCards 必须是整数（收到 ${String(totalCards)}）`);
  }
  if (totalCards <= 0) {
    return 0;
  }
  return Math.ceil(totalCards / MAX_SLOTS);
}

/**
 * 求第 sheetIndex（0 基）张图集应容纳的卡数（最后一张可能不满 70）。
 * @param totalCards 卡牌总数（整数；<= 0 时任何一张都是 0）
 * @param sheetIndex 图集序号（0 基；超出范围的图集返回 0）
 * @returns 该张图集容纳的卡数（[0, 70]）
 * @throws Error totalCards 非整数，或 sheetIndex 非整数 / 负数时（调用方编程错误）
 */
export function cardsInSheet(totalCards: number, sheetIndex: number): number {
  if (!Number.isInteger(totalCards)) {
    throw new Error(`cardsInSheet 入参无效：totalCards 必须是整数（收到 ${String(totalCards)}）`);
  }
  if (!Number.isInteger(sheetIndex) || sheetIndex < 0) {
    throw new Error(`cardsInSheet 入参无效：sheetIndex 必须是非负整数（0 基，收到 ${String(sheetIndex)}）`);
  }
  const remaining = totalCards - sheetIndex * MAX_SLOTS;
  if (remaining <= 0) {
    return 0;
  }
  return Math.min(MAX_SLOTS, remaining);
}
