// src/deck/generate.ts
/**
 * 图集重新排版拼接（B2 默认模式）：cards.csv + 卡图目录 → 一张或多张图集大图。
 *
 * 与原位拼回（inplace.ts，另一模块）的关系：本模块**不共享**自动拆图集逻辑、
 * 不读 source/ 原图集像素，而是按网格重新布局每张卡图；inplace 也没有本模块的
 * 拆分逻辑（原位模式尺寸不符直接报错）。两模块只共享 grid.ts 的网格原语。
 *
 * ── 布局模型（几何上的关键裁决，必读）────────────────────────────────────
 * 1. 图集画布固定为 atlasSize × atlasSize（RGBA，背景透明）——契约原文，
 *    不随网格 / 卡数变化；
 * 2. 网格把画布切成 columns × rows 个格子，格子矩形由 grid.ts 的
 *    {@link slotToRect} 给出（cellW = floor(atlasSize/columns)，余数像素归
 *    最后一列 / 最后一行——与 verify.ts / inplace.ts 的切分模型同源）；
 * 3. 每张卡图先经 cellSize 闸门（文件必须恰为 cellSize × cellSize，默认 512，
 *    TTS 推荐值），再由 sharp 缩放到所在格子的实际像素并 composite 到格子
 *    左上角。缩放是几何必然：4096 画布 + 10x7 网格的单格只有 409x585，
 *    512px 卡图不缩放必然溢出画布（坑：composite 的 input 顺序即 z-order，
 *    溢出部分会被后续卡图覆盖或被画布裁掉）。卡图内容永远完整保留，
 *    仅分辨率随格子变化；
 * 4. composite 的 input 顺序 = slot 顺序（后合成的覆盖先合成的），本模块
 *    格子互不重叠，z-order 无实际影响，仍按 slot 升序传入。
 *
 * ── sheet 拆分与 slot 指派（1 基裁决，B2 坑 1）────────────────────────────
 * slot 不是自由变量：cards.ts 强制 slot === cardIdToSlot(card_id)
 * （= CardID % 100，%100===0 记 100），重排不许改 card_id，因此也不许重编
 * slot。本模块按"card_id 的 slot 连续段"拆图集：
 * - 按文件顺序扫描，维护 expectedNext（当前图集下一个期望 slot）；
 * - 遇到 slot ≠ expectedNext（乱序 / 跳号）或 expectedNext 超过容量
 *   （显式网格为 columns×rows，推断网格为 70）→ 开新图集；
 * - 真实 TTS 存档的 card_id 都是 key*100+slot 且 key 内 slot 连续
 *   （10101..10170 → key "101"），此时本规则**恰好等价于**契约的
 *   "前 70 张 sheet_id=1、71-140 张 sheet_id=2、每张图集内 slot 1-70"；
 * - 契约"totalCards > 70 拆多张、每张至多 70 卡"由容量 70 兜底体现。
 * 不预留隐藏面格子：契约拆分规则以满 70 格为准（70 张卡占满 10x7 单图集），
 * 背面由 deck.yaml 的 BackURL 承担，与本模块布局无关。
 *
 * ── 网格决定 ────────────────────────────────────────────────────────────
 * - 显式 columns/rows（必须成对给出）：全部图集共用，先校验 [1,10] × [1,7]
 *   （越界 GENERATE_GRID_INVALID），图集容量即 columns×rows；
 * - 否则每张图集单独用 grid.ts 的 {@link inferGrid}(atlasSize, atlasSize,
 *   该图集最大 slot) 推断（"最少浪费 → 单格趋近正方形 → 列数趋近 10"）：
 *   10 张 → 5x2、70 张 → 10x7（契约验收集）；推断的最少格数用**最大 slot**
 *   而非卡数，使跳号开段（首格 slot > 1）的图集也能容纳全部格子。
 *   卡数 / cellSize 不直接参与推断——cellSize 在第 3 条的闸门处生效，
 *   inferGrid 只消费画布宽高比 + 格数（square atlas 下 cellSize 改变宽高比
 *   无效果，这是 grid.ts 签名的固有语义）。
 *
 * ── 落盘顺序与可重入性 ───────────────────────────────────────────────────
 * 读 csv → 规划（纯内存，含全部错误检查）→ 卡图预检（存在性 + 尺寸，
 * 全部通过才开始写）→ 逐张写 sheet-N.png → 最后重写 cards.csv。
 * 中途失败不会产生半新半旧的 cards.csv（它是唯一被下游消费的状态）；
 * 但可能留下已写出的 sheet-N.png 孤儿——重跑会覆盖同名文件，而**编号变大后
 * 不再使用的旧 sheet-N.png 不会被清理**（清理是破坏性操作，契约未授权），
 * 调用方应使用干净的 outDir。
 *
 * ── 错误码（PackError.code；错误类型复用 src/pack/packyaml.ts）──────────
 * - "GENERATE_CARDS_NOT_FOUND"     cards.csv 不存在
 *                                  （由 cards.ts 的 CARDS_NOT_FOUND 映射而来）
 * - "GENERATE_CARD_FILE_MISSING"   cards.csv 引用的卡图文件不存在（或路径是目录）
 * - "GENERATE_CELL_SIZE_MISMATCH"  卡图尺寸 ≠ cellSize × cellSize
 * - "GENERATE_GRID_INVALID"        显式 columns/rows 越界（[1,10] × [1,7] 之外）
 * - "GENERATE_TOO_MANY_CARDS"      某图集需要的格数（最大 slot）超过 inferGrid
 *                                  上限 70。常规输入**不可达**：readCardsCsv
 *                                  已把 slot 限制在 [1, sheet_cols×sheet_rows]
 *                                  ≤ 70，此处仅作防御性兜底（契约注明
 *                                  "理论上不会发生，因为拆分逻辑兜底"）。
 * 另有两类透传：cards.csv 内容非法时透传 cards.ts 的 CARDS_* 码（校验收口在
 * cards.ts，本模块不重复实现）；显式网格容量容不下的 slot（仅显式网格可能）
 * 在写盘前以 CARDS_SLOT_OUT_OF_RANGE 快速失败（与 writeCardsCsv 的码一致，
 * 只是提前到产生任何 PNG 之前）。sharp 对损坏图片的内部错误原样透传。
 *
 * 本模块新增的 i18n 键（locales/*.json 由 Run 2 补齐；缺键时 t() 原样输出键名）：
 * - `error.pack.generateCardsNotFound` {path}
 * - `error.pack.generateCardFileMissing` {path}
 * - `error.pack.generateCellSizeMismatch` {path} {expected} {actual}
 * - `error.pack.generateGridInvalid` {detail}
 * - `error.pack.generateTooManyCards` {minCells} {maxSlots}
 *
 * 调用方编程错误（deckDir/outDir 为空、cellSize 非正整数、atlasSize 不在枚举、
 * columns/rows 只给一个）按仓库惯例抛普通中文 Error 而不是 PackError
 * （与 src/deck/grid.ts 的 assertImageSize 同一考虑）。
 */

import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";

import { CARDS_CSV_FILENAME, readCardsCsv, writeCardsCsv, type CardRow } from "./cards.js";
import { cardIdToSlot } from "./cardid.js";
import { MAX_COLUMNS, MAX_ROWS, MAX_SLOTS, inferGrid, slotToRect, type GridSpec } from "./grid.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 单格（卡图）默认边长：512px 是 TTS 推荐值，不要瞎改 */
export const DEFAULT_CELL_SIZE = 512;

/** 图集边长默认值（契约指定） */
export const DEFAULT_ATLAS_SIZE = "4096";

/** 图集边长可取值（契约枚举） */
const ATLAS_SIZES = ["512", "1024", "2048", "4096"] as const;

/** 图集边长类型（GenerateOptions.atlasSize 的字面量联合） */
export type AtlasSize = (typeof ATLAS_SIZES)[number];

// ---------------------------------------------------------------------------
// 数据结构（契约导出）
// ---------------------------------------------------------------------------

/** generateAtlas 的入参 */
export interface GenerateOptions {
  /** deck 目录（含 cards.csv + 卡图） */
  deckDir: string;
  /** 输出目录（图集大图落盘处） */
  outDir: string;
  /** 单格尺寸（像素，正方形；默认 512） */
  cellSize?: number;
  /** 图集边长（默认 "4096"） */
  atlasSize?: AtlasSize;
  /** 网格列数（默认从卡数 + atlasSize 推断；必须与 rows 成对给出） */
  columns?: number;
  /** 网格行数（默认从卡数 + columns 推断；必须与 columns 成对给出） */
  rows?: number;
}

/** 单张图集的产出信息 */
export interface SheetOutput {
  /** 图集编号（1 基） */
  sheetId: number;
  /** 图集文件路径（绝对） */
  filePath: string;
  /** 实际网格列数 */
  columns: number;
  /** 实际网格行数 */
  rows: number;
  /** 该图集容纳的卡数 */
  cardCount: number;
}

/** generateAtlas 的返回 */
export interface GenerateResult {
  /** 拼接的图集列表（1 张或多张；按 sheetId 升序） */
  sheets: SheetOutput[];
  /** 总卡数 */
  totalCards: number;
  /** 拼接后更新过的 cards.csv 路径（绝对；写回了新的 sheet_id/slot/sheet_cols/sheet_rows） */
  cardsCsvPath: string;
}

// ---------------------------------------------------------------------------
// 内部数据结构
// ---------------------------------------------------------------------------

/** 规划阶段的一条卡牌落位 */
interface PlannedCard {
  /** 原始行（重写 csv 时保留 card_id/face/back/name/nickname/sheet_source） */
  row: CardRow;
  /** 数据行序号（1 基，与 cards.ts 的行号口径一致），仅用于错误定位 */
  rowNo: number;
  /** 指派 slot（= cardIdToSlot(card_id)，1 基，不许改） */
  slot: number;
}

/** 规划阶段的一张图集（含最终网格） */
interface PlannedSheet {
  /** 图集编号（1 基） */
  sheetId: number;
  /** 最终网格（显式或按最大 slot 推断） */
  grid: GridSpec;
  /** 落位卡牌（按文件顺序） */
  cards: PlannedCard[];
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT），避免 any。
 * （与 src/deck/cards.ts 的同名内部函数一致；该函数为模块私有无法复用。）
 * @param err 任意抛出值
 * @returns 字符串形式的 code；取不到时返回 undefined
 */
function errCode(err: unknown): string | undefined {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

/**
 * 校验显式网格（columns/rows 成对给出时的范围检查）。
 * @param columns 显式列数
 * @param rows 显式行数
 * @throws PackError code="GENERATE_GRID_INVALID" 越界 / 非整数时
 */
function assertExplicitGrid(columns: number, rows: number): void {
  if (!Number.isInteger(columns) || columns < 1 || columns > MAX_COLUMNS) {
    throw new PackError(
      "GENERATE_GRID_INVALID",
      t("error.pack.generateGridInvalid", {
        detail: `columns 必须是 1-${MAX_COLUMNS} 的整数（收到 ${String(columns)}）`,
      }),
    );
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) {
    throw new PackError(
      "GENERATE_GRID_INVALID",
      t("error.pack.generateGridInvalid", {
        detail: `rows 必须是 1-${MAX_ROWS} 的整数（收到 ${String(rows)}）`,
      }),
    );
  }
}

/**
 * 把卡牌行按"slot 连续段"规划进图集（见模块头注释"sheet 拆分与 slot 指派"）。
 * @param rows 按文件顺序的卡牌行（已过 readCardsCsv 校验）
 * @param capacity 单张图集的 slot 容量（显式网格为 columns×rows，推断网格为 70）
 * @returns 仅含落位的图集列表（grid 稍后填充；sheetId 从 1 连续递增）
 */
function planSheets(rows: readonly CardRow[], capacity: number): PlannedSheet[] {
  const sheets: PlannedSheet[] = [];
  let current: PlannedSheet | undefined;
  let expectedNext = 1; // 当前图集的下一个期望 slot（1 基）
  rows.forEach((row, index) => {
    const slot = cardIdToSlot(row.cardId);
    // 容量检查必须在连续性检查之前：图集装满时 expectedNext 已超容量，
    // 即便下一张卡的 slot 恰好等于 expectedNext 也必须开新图集
    if (current === undefined || expectedNext > capacity || slot !== expectedNext) {
      current = { sheetId: sheets.length + 1, grid: { columns: 1, rows: 1 }, cards: [] };
      sheets.push(current);
    }
    current.cards.push({ row, rowNo: index + 1, slot });
    expectedNext = slot + 1;
  });
  return sheets;
}

// ---------------------------------------------------------------------------
// 导出主流程
// ---------------------------------------------------------------------------

/**
 * 重新排版拼接：读 cards.csv → 规划网格与拆分 → 预检卡图 → sharp 拼接落盘
 * → 重写 cards.csv 的 sheet_id / slot / sheet_cols / sheet_rows
 * （card_id 是主键不许改；face/back/name/nickname/sheet_source 原样保留）。
 *
 * @param opts 入参（见 {@link GenerateOptions}）
 * @returns 图集列表 + 总卡数 + 更新后的 cards.csv 路径
 * @throws PackError code="GENERATE_CARDS_NOT_FOUND" cards.csv 不存在时
 * @throws PackError code="GENERATE_CARD_FILE_MISSING" 引用的卡图文件缺失时
 * @throws PackError code="GENERATE_CELL_SIZE_MISMATCH" 卡图尺寸 ≠ cellSize² 时
 * @throws PackError code="GENERATE_GRID_INVALID" 显式网格越界时
 * @throws PackError code="GENERATE_TOO_MANY_CARDS" 图集所需格数超 70（防御性，常规不可达）时
 * @throws PackError cards.ts 的 CARDS_* 码（csv 内容非法 / slot 超显式容量）时透传
 * @throws Error 调用方编程错误（入参类型 / 成对性）时抛普通中文错误
 */
export async function generateAtlas(opts: GenerateOptions): Promise<GenerateResult> {
  // ── 1. 入参校验（编程错误 → 普通 Error；CLI 数据 → PackError）──────────
  const deckDir = opts.deckDir;
  const outDir = opts.outDir;
  if (typeof deckDir !== "string" || deckDir === "") {
    throw new Error("generateAtlas 入参无效：deckDir 必须是非空字符串");
  }
  if (typeof outDir !== "string" || outDir === "") {
    throw new Error("generateAtlas 入参无效：outDir 必须是非空字符串");
  }
  const cellPx = opts.cellSize ?? DEFAULT_CELL_SIZE;
  if (!Number.isInteger(cellPx) || cellPx < 1) {
    throw new Error(`generateAtlas 入参无效：cellSize 必须是正整数像素（收到 ${String(cellPx)}）`);
  }
  const atlasSizeRaw: unknown = opts.atlasSize ?? DEFAULT_ATLAS_SIZE;
  if (typeof atlasSizeRaw !== "string" || !(ATLAS_SIZES as readonly string[]).includes(atlasSizeRaw)) {
    throw new Error(
      `generateAtlas 入参无效：atlasSize 必须是 ${ATLAS_SIZES.join(" / ")} 之一（收到 ${String(atlasSizeRaw)}）`,
    );
  }
  const atlasSize = atlasSizeRaw as AtlasSize;
  const atlasPx = Number(atlasSize);

  const columnsOpt = opts.columns;
  const rowsOpt = opts.rows;
  if ((columnsOpt === undefined) !== (rowsOpt === undefined)) {
    throw new Error("generateAtlas 入参无效：columns 与 rows 必须同时给出（或同时省略）");
  }
  let explicit: GridSpec | null = null;
  if (columnsOpt !== undefined && rowsOpt !== undefined) {
    assertExplicitGrid(columnsOpt, rowsOpt);
    explicit = { columns: columnsOpt, rows: rowsOpt };
  }

  // ── 2. 读 cards.csv（CARDS_NOT_FOUND 映射为模块码，其余 CARDS_* 透传）──
  let rows: CardRow[];
  try {
    rows = await readCardsCsv(deckDir);
  } catch (err) {
    if (err instanceof PackError && err.code === "CARDS_NOT_FOUND") {
      throw new PackError(
        "GENERATE_CARDS_NOT_FOUND",
        t("error.pack.generateCardsNotFound", { path: path.resolve(deckDir, CARDS_CSV_FILENAME) }),
      );
    }
    throw err;
  }

  // ── 3. 规划：拆图集 + 定网格 + slot 容量预检（全部纯内存，先错先报）────
  const capacity = explicit !== null ? explicit.columns * explicit.rows : MAX_SLOTS;
  const planned: PlannedSheet[] = planSheets(rows, capacity);
  for (const sheet of planned) {
    if (explicit !== null) {
      sheet.grid = explicit;
    } else {
      // 推断的最少格数 = 本图集最大 slot（连续段时 == 卡数）；>70 时
      // inferGrid 抛 ATLAS_TOO_MANY_CELLS，映射为模块码 GENERATE_TOO_MANY_CARDS
      const maxSlot = sheet.cards.reduce((acc, card) => Math.max(acc, card.slot), 0);
      try {
        sheet.grid = inferGrid(atlasPx, atlasPx, maxSlot);
      } catch (err) {
        if (err instanceof PackError && err.code === "ATLAS_TOO_MANY_CELLS") {
          throw new PackError(
            "GENERATE_TOO_MANY_CARDS",
            t("error.pack.generateTooManyCards", { minCells: maxSlot, maxSlots: MAX_SLOTS }),
          );
        }
        throw err;
      }
    }
    // slot 容量预检：推断网格 area >= maxSlot 恒成立，只有显式网格可能踩中；
    // 提前到写盘前抛 writeCardsCsv 的同款错误码，避免留下孤儿 PNG
    const gridArea = sheet.grid.columns * sheet.grid.rows;
    for (const card of sheet.cards) {
      if (card.slot > gridArea) {
        throw new PackError(
          "CARDS_SLOT_OUT_OF_RANGE",
          t("error.pack.cardsSlotOutOfRange", { row: card.rowNo, slot: card.slot, max: gridArea }),
        );
      }
    }
  }

  // ── 4. 卡图预检（存在性 + 尺寸闸门）：全部通过才开始写任何输出 ─────────
  for (const sheet of planned) {
    for (const card of sheet.cards) {
      const cardFile = cardPath(card, deckDir);
      let fileInfo;
      try {
        fileInfo = await stat(cardFile);
      } catch (err) {
        if (errCode(err) === "ENOENT") {
          throw new PackError(
            "GENERATE_CARD_FILE_MISSING",
            t("error.pack.generateCardFileMissing", { path: cardFile }),
          );
        }
        throw err;
      }
      if (!fileInfo.isFile()) {
        throw new PackError(
          "GENERATE_CARD_FILE_MISSING",
          t("error.pack.generateCardFileMissing", { path: cardFile }),
        );
      }
      const meta = await sharp(cardFile).metadata();
      const width = meta.width ?? -1;
      const height = meta.height ?? -1;
      if (width !== cellPx || height !== cellPx) {
        throw new PackError(
          "GENERATE_CELL_SIZE_MISMATCH",
          t("error.pack.generateCellSizeMismatch", {
            path: cardFile,
            expected: `${cellPx}x${cellPx}`,
            actual: `${width}x${height}`,
          }),
        );
      }
    }
  }

  // ── 5. 逐张拼接落盘（atlasSize × atlasSize 透明画布 + slot 顺序 composite）──
  const outputs: SheetOutput[] = [];
  if (planned.length > 0) {
    await mkdir(outDir, { recursive: true });
  }
  for (const sheet of planned) {
    const composites: { input: Buffer; left: number; top: number }[] = [];
    for (const card of sheet.cards) {
      const rect = slotToRect(card.slot, atlasPx, atlasPx, sheet.grid.columns, sheet.grid.rows);
      // 先缩放到格子实际像素（fit fill：精确铺满，内容完整保留），再按 slot
      // 顺序入队（input 顺序即 z-order，后覆盖前）
      const input = await sharp(cardPath(card, deckDir))
        .resize(rect.width, rect.height, { fit: "fill" })
        .png()
        .toBuffer();
      composites.push({ input, left: rect.left, top: rect.top });
    }
    const filePath = path.resolve(outDir, `sheet-${sheet.sheetId}.png`);
    const canvas = sharp({
      create: {
        width: atlasPx,
        height: atlasPx,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    });
    await canvas.composite(composites).png().toFile(filePath);
    outputs.push({
      sheetId: sheet.sheetId,
      filePath,
      columns: sheet.grid.columns,
      rows: sheet.grid.rows,
      cardCount: sheet.cards.length,
    });
  }

  // ── 6. 重写 cards.csv（最后一步；行顺序不变，主键与其他列原样保留）──────
  const updatedRows: CardRow[] = planned.flatMap((sheet) =>
    sheet.cards.map((card) => ({
      ...card.row,
      sheetId: sheet.sheetId,
      slot: card.slot,
      sheetCols: sheet.grid.columns,
      sheetRows: sheet.grid.rows,
    })),
  );
  await writeCardsCsv(deckDir, updatedRows);

  return {
    sheets: outputs,
    totalCards: rows.length,
    cardsCsvPath: path.resolve(deckDir, CARDS_CSV_FILENAME),
  };
}

/**
 * 取卡图完整路径（deckDir + face 列；face 相对本 deck 目录）。
 * @param card 规划卡牌
 * @param deckDir deck 目录
 * @returns 卡图绝对 / 相对路径（与 deckDir 同形式）
 */
function cardPath(card: PlannedCard, deckDir: string): string {
  return path.join(deckDir, card.row.face);
}
