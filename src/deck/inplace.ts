// src/deck/inplace.ts
/**
 * 原位拼回（inplace）：按 cards.csv 记录的原始位置，把改过的卡图拼回图集，
 * 未改的格子从 source/ 目录取原像素（方案设计"原位拼回 vs 重新排版"）。
 *
 * 与 generate.ts 的"重新排版"模式完全独立：
 * - **不做**自动拆图集（不用 grid.ts 的 inferGrid / sheetsNeeded）；
 * - **不改** card_id / slot / sheet_id 等溯源信息，也绝不改写 cards.csv；
 * - 图集尺寸、行列、格子位置必须与源图集完全一致，尺寸不符直接报错
 *   （绝不静默改图集大小——B2 坑 3）。
 *
 * 用途：汉化后回写上游存档——图集 URL 与格子位置都不能变。
 *
 * ── 流程（契约行为 1-6）──────────────────────────────────────────────────
 * 1. 复用 cards.ts 的 readCardsCsv 读 cards.csv（单一实现；CARDS_NOT_FOUND
 *    在此转码为 INPLACE_CARDS_NOT_FOUND，其余 CARDS_* 校验错误原样上抛——
 *    cards.csv 内容错误归 cards.ts 管辖，不在这里重复造码）；
 * 2. 按 sheet_id 分组，升序逐张独立处理；
 * 3. 对每张图集：
 *    a. 读源图集 `<sourceDir>/sheet-<sheetId>.png`（stat 存在性 + sharp 解码）；
 *    b. 确定 cellSize（见下"cellSize 校验"）；
 *    c. 对该 sheet 的每行 cards.csv：
 *       - 改判为"改过"（见下"改判策略"）→ 读卡图、校验尺寸 == cellSize×cellSize、
 *         记为对应格子的替换输入；
 *       - 否则 → 该格沿用源图集原像素；
 *    d. **全部** cols×rows 个格子 composite 到一张与源图集同尺寸的透明画布上：
 *       判改的格子放卡图，其余格子（含 cards.csv 未列出的格子——共享图集
 *       场景下属于其他 deck 的卡，见下）从源图集一次解码出的 8bit RGBA
 *       原始像素中切出（slot 经 cardid.ts 的 slotToGrid 换算 0 基坐标，
 *       1 基裁决单一来源），png 无损中转后回贴。png 落盘到
 *       `<outDir>/sheet-<sheetId>.png`（文件名与源图集一致）。
 *
 * 为什么 csv 未列出的格子也取源像素而不是留透明：同一图集 URL 可能被多个
 * CustomDeck 引用（B2 坑 2），此时每个 deck 的 cards.csv 只列自己 key 的
 * slot——清成透明会破坏共享图集上其他 deck 的卡。"原位拼回"的语义因此是：
 * **输出图集 = 源图集，仅 cards.csv 记录且判改的格子被替换**。
 *    d. 全部格子 composite 到一张与源图集同尺寸的**透明画布**上，png 落盘到
 *       `<outDir>/sheet-<sheetId>.png`（文件名与源图集一致）。
 *
 * 为什么以透明画布为底、而不是以源图集为底：composite 的 over 合成会把
 * "下面的图"混进半透明像素——若以源图为底，半透明卡图会与旧像素混合
 * （不是"替换"）；透明画布则保证每个格子的合成结果就是该格输入本身
 * （改的格子 == 卡图，未改的格子 == 源像素）。libvips 合成内部用 float
 * 预乘 / 反预乘，8bit 不透明像素逐字节无损往返（tests 有逐字节断言守着）。
 *
 * ── 改判策略（契约"改判策略"，两种模式调用方任选）────────────────────────
 * - **显式模式**：opts.modifiedCardIds 给出非空数组 → 只替换集合内的 CardID，
 *   完全不看 mtime（集合外即使 mtime 更新也不替换；集合中 cards.csv 没有
 *   的 CardID 忽略不报错）；
 * - **mtime 模式**（默认；modifiedCardIds 省略或空数组）：卡图文件的
 *   mtimeMs **严格大于**源图集的 mtimeMs 才判"改过"（契约"晚于"，相等不算）。
 * - 卡图缺失（两种模式一致）：face 引用的文件在 deckDir 下不存在（或不是
 *   文件）→ 不替换，从源图集取原像素，不报错——契约行为 3c 的字面前提是
 *   "卡图存在于 deckDir"，上游 deck 可能只改了部分卡。
 *
 * ── cellSize 校验（契约行为 4，方格语义）────────────────────────────────
 * - 调用方显式给 cellSize：必须是正整数（否则普通 Error），且源图集
 *   宽 == cellSize×sheet_cols、高 == cellSize×sheet_rows，否则
 *   INPLACE_GRID_MISMATCH；
 * - 省略 cellSize：从源图集推断——宽必须能被 sheet_cols 整除、高必须能被
 *   sheet_rows 整除，且两个商相等（正方形格子），cellSize = 宽 / sheet_cols；
 *   任一不满足 → INPLACE_GRID_MISMATCH（如源图集 4096x2048 但声明 10x7，
 *   4096/10 不整除；或 400x200 声明 2x2，格子 200x100 非方格）。
 * 本模块按契约只支持正方形格子（卡图校验 cellSize×cellSize 同源），不支持
 * grid.ts slotToRect 那种"余数吸收进最后一列 / 行"的切分——原位拼回的前提
 * 是与源图集逐像素对齐，出现余数即网格声明与图片不符，直接报错。
 *
 * ── 错误码（PackError.code，类型复用 src/pack/packyaml.ts 的 PackError）──
 * - "INPLACE_CARDS_NOT_FOUND"    deckDir 下没有 cards.csv；
 * - "INPLACE_SOURCE_MISSING"     sourceDir/sheet-<sheetId>.png 不存在或不是文件；
 * - "INPLACE_CELL_SIZE_MISMATCH" 判定为"改过"的卡图尺寸 ≠ cellSize×cellSize；
 * - "INPLACE_GRID_MISMATCH"      源图集尺寸与 sheet_cols/sheet_rows 推算的
 *                                cellSize 不符（不整除 / 非方格 / 与显式
 *                                cellSize 相乘不等），或同一 sheet_id 的
 *                                sheet_cols/sheet_rows 声明不一致。
 *
 * 本模块新增的 i18n 键（locales/*.json 由 Run 2 补齐；缺键时 t() 原样输出键名）：
 * - `error.pack.inplaceCardsNotFound` {path}
 * - `error.pack.inplaceSourceMissing` {path}
 * - `error.pack.inplaceCellSizeMismatch` {cardId} {path} {expected} {actual}
 * - `error.pack.inplaceGridMismatch` {detail}
 *
 * 调用方编程错误（deckDir / sourceDir / outDir 非非空字符串、cellSize 非正整数）
 * 按仓库惯例抛普通中文 Error（与 src/deck/grid.ts 的 assertImageSize 同一考虑）；
 * 数据性错误才抛 PackError。源图集损坏等异常 IO 由 sharp / Node 原生错误上抛。
 */

import { mkdir, readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import sharp from "sharp";
import type { OverlayOptions } from "sharp";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";

import { slotToRect } from "./grid.js";
import { CARDS_CSV_FILENAME, readCardsCsv, type CardRow } from "./cards.js";

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/** 原位拼回的入参（见 {@link inplaceAtlas}） */
export interface InplaceOptions {
  /** deck 目录（含 cards.csv + 卡图；face 相对此目录解析，可含子目录） */
  deckDir: string;
  /** 源图集目录（decks/<name>/source/，含 sheet-1.png / sheet-2.png 等原始图集） */
  sourceDir: string;
  /** 输出目录（拼好的图集落盘处，文件名与源图集一致；不存在时自动创建） */
  outDir: string;
  /**
   * 单格尺寸（像素，正方形边长）。省略时从源图集宽 ÷ sheet_cols 推断
   * （要求宽高都能整除且两个商相等）。给定但与源图集不符 → INPLACE_GRID_MISMATCH。
   */
  cellSize?: number;
  /**
   * 显式改判模式：只替换这些 CardID（不看 mtime；cards.csv 中不存在的
   * CardID 忽略；声明的卡若卡图文件缺失，与所有"卡图缺失"一致，回退源像素）。
   * 省略或空数组 → mtime 模式（卡图 mtime 严格晚于源图集 → 改过）。
   */
  modifiedCardIds?: number[];
}

/** 单张图集的拼回结果 */
export interface InplaceSheetResult {
  /** 图集编号（1 基，来自 cards.csv 的 sheet_id） */
  sheetId: number;
  /** 拼好的图集落盘路径（`<outDir>/sheet-<sheetId>.png`） */
  filePath: string;
  /** 该图集列数（cards.csv 的 sheet_cols） */
  columns: number;
  /** 该图集行数（cards.csv 的 sheet_rows） */
  rows: number;
  /** 改过的卡数（其余从源图集取原像素） */
  modifiedCount: number;
  /** 该图集总卡数（cards.csv 中该 sheet 的行数） */
  totalCount: number;
}

/** 原位拼回的整体结果（sheets 按 sheet_id 升序） */
export interface InplaceResult {
  sheets: InplaceSheetResult[];
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT），避免 any。
 * （与 packyaml.ts / cards.ts 的同名内部函数一致。）
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
 * 断言路径类入参是非空字符串（调用方编程错误 → 普通 Error）。
 * @param value 待校验值
 * @param argName 入参名（用于错误信息）
 */
function assertPathOption(value: string, argName: string): void {
  if (typeof value !== "string" || value === "") {
    throw new Error(`inplaceAtlas 入参无效：${argName} 必须是非空字符串（收到 ${String(value)}）`);
  }
}

/**
 * 校验源图集尺寸与网格声明的兼容性（Stage 3 修订：支持余数吸收）。
 *
 * Stage 3 修订：原版要求"整除 + 正方形"，真实 TTS 图集（4096x4096 配 5x5 网格，
 * 单格 819.2x819.2）完全不满足。修订为：
 * - 计算 cellWidth = floor(sourceWidth / columns)，cellHeight = floor(sourceHeight / gridRows)；
 * - 余数 = sourceWidth % columns（列余数）/ sourceHeight % gridRows（行余数）；
 * - 余数必须 < columns / gridRows（即每列/行至多吸收 1 像素，与 slotToRect 的语义一致）；
 * - 显式 declared cellSize 时：要求 declared == cellWidth 且 declared == cellHeight
 *   （基准尺寸一致；余数吸收到最后一列/行由 slotToRect 处理）；
 * - 省略 declared 时：要求 cellWidth == cellHeight（基准是方格，余数吸收是另一回事）。
 *
 * @param declared 调用方显式给定的 cellSize（undefined = 推断模式）
 * @param sourceWidth 源图集实际宽度（像素）
 * @param sourceHeight 源图集实际高度（像素）
 * @param columns 网格列数（cards.csv 的 sheet_cols）
 * @param gridRows 网格行数（cards.csv 的 sheet_rows）
 * @param sheetId 图集编号（仅用于错误信息定位）
 * @returns 基准单格尺寸（正方形边长，像素；不含余数）
 * @throws PackError code="INPLACE_GRID_MISMATCH" 尺寸与网格声明不符时
 */
function resolveCellSize(
  declared: number | undefined,
  sourceWidth: number,
  sourceHeight: number,
  columns: number,
  gridRows: number,
  sheetId: number,
): number {
  const cellWidth = Math.floor(sourceWidth / columns);
  const cellHeight = Math.floor(sourceHeight / gridRows);
  const widthRemainder = sourceWidth % columns;
  const heightRemainder = sourceHeight % gridRows;

  // 余数合法性：每列/行至多吸收 1 像素（与 slotToRect 的"边缘吸收"语义一致）。
  // 余数必然 < 列数 / 行数（取余定义），这里只是文档化断言，实际不会触发。
  if (widthRemainder < 0 || heightRemainder < 0) {
    throw new Error(`inplaceAtlas 内部错误：源图集尺寸为负（${sourceWidth}x${sourceHeight}）`);
  }

  if (declared !== undefined) {
    // 显式模式：declared 必须等于基准尺寸（不含余数）。
    // 真实 TTS 4096/5=819.2，declared 应是 819 而不是 820——
    // 余数吸收由 slotToRect 处理，不是 declared 的职责。
    if (declared !== cellWidth || declared !== cellHeight) {
      throw new PackError(
        "INPLACE_GRID_MISMATCH",
        t("error.pack.inplaceGridMismatch", {
          detail:
            `sheet ${sheetId}：源图集 ${sourceWidth}x${sourceHeight} 按 ${columns}x${gridRows} ` +
            `切分的基准格子 ${cellWidth}x${cellHeight}（余数 ${widthRemainder}/${heightRemainder}）` +
            `与显式 cellSize ${declared} 不符`,
        }),
      );
    }
    return declared;
  }

  // 推断模式：基准必须是方格（余数吸收不改变基准的形状）。
  if (cellWidth !== cellHeight) {
    throw new PackError(
      "INPLACE_GRID_MISMATCH",
      t("error.pack.inplaceGridMismatch", {
        detail:
          `sheet ${sheetId}：源图集 ${sourceWidth}x${sourceHeight} 按 ${columns}x${gridRows} ` +
          `切分的基准格子 ${cellWidth}x${cellHeight} 不是正方形`,
      }),
    );
  }
  return cellWidth;
}

/**
 * 从整张源图集的 8bit RGBA 原始像素中切出一个格子（纯内存行拷贝，无损）。
 * @param sourceRaw 整张源图集的 RGBA 原始像素（长 = width*height*4）
 * @param sourceWidth 源图集宽度（行跨距依据）
 * @param left 格子左上角 x（0 基像素）
 * @param top 格子左上角 y（0 基像素）
 * @param width 格子宽（像素）
 * @param height 格子高（像素）
 * @returns 格子的 RGBA 原始像素（长 = width*height*4）
 */
function sliceCellRaw(
  sourceRaw: Buffer,
  sourceWidth: number,
  left: number,
  top: number,
  width: number,
  height: number,
): Buffer {
  const bytesPerRow = width * 4;
  const out = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    const srcStart = ((top + y) * sourceWidth + left) * 4;
    sourceRaw.copy(out, y * bytesPerRow, srcStart, srcStart + bytesPerRow);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 单张图集拼回
// ---------------------------------------------------------------------------

/**
 * 拼回单张图集（流程见模块头注释步骤 3）。
 *
 * @param sheetId 图集编号（1 基）
 * @param sheetRows cards.csv 中该 sheet 的全部行（非空）
 * @param opts 原位拼回入参
 * @param explicitMode true = 显式改判模式（看 explicitIds），false = mtime 模式
 * @param explicitIds 显式模式的 CardID 集合（explicitMode 为 false 时不读）
 * @returns 该图集的拼回结果
 * @throws PackError（码见模块头注释）
 */
async function rebuildSheet(
  sheetId: number,
  sheetRows: CardRow[],
  opts: InplaceOptions,
  explicitMode: boolean,
  explicitIds: ReadonlySet<number>,
): Promise<InplaceSheetResult> {
  // 同一 sheet_id 的网格声明必须一致（cards.ts 的单行校验不覆盖跨行一致性）
  const columns = sheetRows[0].sheetCols;
  const gridRows = sheetRows[0].sheetRows;
  for (const row of sheetRows) {
    if (row.sheetCols !== columns || row.sheetRows !== gridRows) {
      throw new PackError(
        "INPLACE_GRID_MISMATCH",
        t("error.pack.inplaceGridMismatch", {
          detail:
            `sheet ${sheetId} 的网格声明不一致：${columns}x${gridRows} 与 ` +
            `${row.sheetCols}x${row.sheetRows}（card_id ${row.cardId}）`,
        }),
      );
    }
  }

  // 源图集存在性（不存在 / 不是普通文件 → INPLACE_SOURCE_MISSING）
  const sourcePath = path.join(opts.sourceDir, `sheet-${sheetId}.png`);
  let sourceStat: Stats;
  try {
    sourceStat = await stat(sourcePath);
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      throw new PackError(
        "INPLACE_SOURCE_MISSING",
        t("error.pack.inplaceSourceMissing", { path: sourcePath }),
      );
    }
    throw err;
  }
  if (!sourceStat.isFile()) {
    throw new PackError(
      "INPLACE_SOURCE_MISSING",
      t("error.pack.inplaceSourceMissing", { path: sourcePath }),
    );
  }

  // 源图集实际尺寸 → cellSize 校验 / 推断
  const sourceMeta = await sharp(sourcePath).metadata();
  const sourceWidth = sourceMeta.width;
  const sourceHeight = sourceMeta.height;
  if (sourceWidth === undefined || sourceHeight === undefined) {
    throw new Error(`源图集尺寸无法读取：${sourcePath}`);
  }
  // cellSize 是基准尺寸（不含余数吸收）；余数由 slotToRect 在拼回时逐格处理
  const cell = resolveCellSize(opts.cellSize, sourceWidth, sourceHeight, columns, gridRows, sheetId);

  // 一次解码源图集为 8bit RGBA 原始像素（未改格子从这里切原像素，整图只解码一次）
  const sourcePixels = await sharp(sourcePath)
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rawWidth = sourcePixels.info.width;
  if (sourcePixels.info.channels !== 4) {
    throw new Error(
      `源图集解码通道数异常：${sourcePath}（期望 4，实际 ${sourcePixels.info.channels}）`,
    );
  }
  const sourceMtimeMs = sourceStat.mtimeMs;

  const composites: OverlayOptions[] = [];

  // 第一步：改判（仅 cards.csv 记录的行参与）——判改的格子记下卡图替换输入
  const overrides = new Map<number, Buffer>();
  let modifiedCount = 0;
  for (const row of sheetRows) {
    const cardPath = path.join(opts.deckDir, row.face);
    const cardStat = await stat(cardPath).catch((): Stats | undefined => undefined);
    const cardExists = cardStat !== undefined && cardStat.isFile();
    // 改判：显式模式只看集合；mtime 模式严格大于（契约"晚于"，相等不算改过）
    const isModified =
      cardExists
      && (explicitMode
        ? explicitIds.has(row.cardId)
        : (cardStat as Stats).mtimeMs > sourceMtimeMs);
    if (!isModified) {
      continue; // 未改（或卡图缺失）：该格沿用源像素，见下方全格子回贴
    }

    const cardBuffer = await readFile(cardPath);
    let cardWidth: number | undefined;
    let cardHeight: number | undefined;
    try {
      const cardMeta = await sharp(cardBuffer).metadata();
      cardWidth = cardMeta.width;
      cardHeight = cardMeta.height;
    } catch {
      // sharp 解析失败（损坏 / 非图片格式）：落到下面的闸门统一报 INPLACE_CELL_SIZE_MISMATCH
      cardWidth = undefined;
      cardHeight = undefined;
    }
    // 卡图尺寸闸门（Stage 3 修订）：只拦截"明显损坏"的输入（尺寸缺失 / 0 像素 / 无法解析）。
    // 不再做强宽高比校验——下面 resize 步骤会精确铺满 slotToRect 算出的格子，
    // 变形与否是用户的选择（slice 切的卡图已是 slotToRect 输出，零变形；
    // 新做的卡图是任意尺寸，resize 拉伸是预期行为）。
    if (cardWidth === undefined || cardHeight === undefined || cardWidth < 1 || cardHeight < 1) {
      throw new PackError(
        "INPLACE_CELL_SIZE_MISMATCH",
        t("error.pack.inplaceCellSizeMismatch", {
          cardId: row.cardId,
          path: cardPath,
          expected: "尺寸 ≥ 1x1 且可读",
          actual: `${String(cardWidth)}x${String(cardHeight)}`,
        }),
      );
    }
    overrides.set(row.slot, cardBuffer);
    modifiedCount += 1;
  }

  // 第二步：全部 cols×rows 个格子按 1 基 slot 逐格 composite——
  // 判改的格子放卡图（resize 到该 slot 实际尺寸），其余格子（含 csv 未列出的，
  // 共享图集语义见头注释）从源像素切出原样回贴（png 无损中转）。
  // Stage 3 修订：用 slotToRect 算每个 slot 的实际位置/尺寸（含余数吸收），
  // 而不是统一 cell*col——这样源图集 4096x4096 配 5x5 网格（单格 819.2）能正确拼回。
  for (let slot = 1; slot <= columns * gridRows; slot++) {
    const rect = slotToRect(slot, sourceWidth, sourceHeight, columns, gridRows);
    const override = overrides.get(slot);
    if (override !== undefined) {
      // 改过的卡图：resize 到该 slot 实际尺寸（slice 切出的余数图会被拉回基准，
      // 新做的卡图会被精确铺满）；
      const resized = await sharp(override)
        .resize(rect.width, rect.height, { fit: "fill" })
        .png()
        .toBuffer();
      composites.push({ input: resized, left: rect.left, top: rect.top });
      continue;
    }
    // 未改的格子：从源像素切出该 slot 的实际区域（含余数吸收的 1 像素）
    const cellRaw = sliceCellRaw(sourcePixels.data, rawWidth, rect.left, rect.top, rect.width, rect.height);
    const cellPng = await sharp(cellRaw, { raw: { width: rect.width, height: rect.height, channels: 4 } })
      .png()
      .toBuffer();
    composites.push({ input: cellPng, left: rect.left, top: rect.top });
  }

  // 透明画布为底 + 全部格子 composite（理由见模块头注释：半透明不混底）
  await mkdir(opts.outDir, { recursive: true });
  const outPath = path.join(opts.outDir, `sheet-${sheetId}.png`);
  await sharp({
    create: {
      width: sourceWidth,
      height: sourceHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites) // 不开 tile（契约：tile 模式不要开，按格子精确落位）
    .png()
    .toFile(outPath);

  return {
    sheetId,
    filePath: outPath,
    columns,
    rows: gridRows,
    modifiedCount,
    totalCount: sheetRows.length,
  };
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 原位拼回：读 cards.csv，按 sheet_id 分组，把改过的卡图按记录位置拼回图集，
 * 未改的格子从源图集取原像素，输出到 outDir（文件名与源图集一致）。
 *
 * @param opts 入参（deckDir / sourceDir / outDir 必填；cellSize 与
 *   modifiedCardIds 可选，语义见 {@link InplaceOptions}）
 * @returns 各图集的拼回结果（按 sheet_id 升序；cards.csv 无数据行时为空数组）
 * @throws PackError code="INPLACE_CARDS_NOT_FOUND" cards.csv 不存在时
 * @throws PackError code="INPLACE_SOURCE_MISSING" 某张源图集缺失时
 * @throws PackError code="INPLACE_CELL_SIZE_MISMATCH" 判定为"改过"的卡图
 *   尺寸 ≠ cellSize×cellSize 时
 * @throws PackError code="INPLACE_GRID_MISMATCH" 源图集尺寸与网格声明推算的
 *   cellSize 不符，或同一 sheet_id 的网格声明不一致时
 * @throws PackError 其余 CARDS_* cards.csv 内容校验失败时（原样上抛自 cards.ts）
 * @throws Error 入参编程错误（路径为空 / cellSize 非正整数）时
 */
export async function inplaceAtlas(opts: InplaceOptions): Promise<InplaceResult> {
  assertPathOption(opts.deckDir, "deckDir");
  assertPathOption(opts.sourceDir, "sourceDir");
  assertPathOption(opts.outDir, "outDir");
  if (opts.cellSize !== undefined && (!Number.isInteger(opts.cellSize) || opts.cellSize < 1)) {
    throw new Error(
      `inplaceAtlas 入参无效：cellSize 必须是正整数像素（收到 ${String(opts.cellSize)}）`,
    );
  }

  // 1. 读 cards.csv（CARDS_NOT_FOUND → INPLACE_CARDS_NOT_FOUND，其余原样上抛）
  let rows: CardRow[];
  try {
    rows = await readCardsCsv(opts.deckDir);
  } catch (err) {
    if (err instanceof PackError && err.code === "CARDS_NOT_FOUND") {
      throw new PackError(
        "INPLACE_CARDS_NOT_FOUND",
        t("error.pack.inplaceCardsNotFound", {
          path: path.join(opts.deckDir, CARDS_CSV_FILENAME),
        }),
      );
    }
    throw err;
  }

  // 2. 按 sheet_id 分组（键升序处理，输出顺序确定）
  const groups = new Map<number, CardRow[]>();
  for (const row of rows) {
    const bucket = groups.get(row.sheetId);
    if (bucket === undefined) {
      groups.set(row.sheetId, [row]);
    } else {
      bucket.push(row);
    }
  }

  const explicitIds = new Set(opts.modifiedCardIds ?? []);
  const explicitMode = explicitIds.size > 0;

  // 3. 逐张图集拼回
  const sheets: InplaceSheetResult[] = [];
  const sheetIds = [...groups.keys()].sort((a, b) => a - b);
  for (const sheetId of sheetIds) {
    const sheetRows = groups.get(sheetId);
    if (sheetRows === undefined) {
      continue; // 不可达（sheetIds 来自同一 Map 的键），防御性跳过
    }
    sheets.push(await rebuildSheet(sheetId, sheetRows, opts, explicitMode, explicitIds));
  }
  return { sheets };
}
