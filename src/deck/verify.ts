// src/deck/verify.ts
/**
 * 工作区校验器（方案设计验收标准 5：校验能抓出问题）。
 *
 * 职责：对图包工作区做**只读**体检，把发现的问题全部收集为 {@link VerifyIssue}
 * 一次性返回（行为契约：不中断、不修改、错误与警告分级）。三大校验面：
 *
 * 1. **卡牌校验**（每个 decks/<name>/，以 cards.csv 为明细源）：
 *    - cards.csv 存在且合法（用 src/deck/cards.ts 读，捕获 PackError 转为 issue；
 *      其中 CARDS_SLOT_MISMATCH 语义即"CardID 与 slot 不匹配"，转为本模块的
 *      {@link VerifyIssue.code} "CARD_ID_MISMATCH"，其余码原样透传）；
 *    - 网格一致性（checkAtlasSize 时）：对每张 sheet 读图集实际宽高
 *      （sharp.metadata），要求 imageWidth / sheet_cols 与 imageHeight /
 *      sheet_rows 都是**整数且相等**（契约公式 cellSize = 宽/列 = 高/行，
 *      即方格），不符 → error ATLAS_GRID_MISMATCH。图集文件解析顺序：
 *      sheet_source（file: URL / 绝对路径 / 相对 deckDir / 相对 packRoot）
 *      → 兜底 `<deckDir>/source/sheet-<sheetId>.png`（generate.ts 的落盘命名）；
 *    - 卡数超容量：单 sheet 卡数 > 容量 → error DECK_TOO_MANY_CARDS。容量按
 *      该 sheet 各行声明的**最小** sheet_cols × sheet_rows 计（最保守口径）；
 *    - 空白格：slot 1..cols×rows 中未使用的 → warning DECK_EMPTY_SLOT
 *      （每 sheet 一条，message 列出空格号）；
 *    - CMYK（checkCmyk 时）：face / back 卡图（去重后）space === "cmyk" →
 *      error CARD_CMYK；文件缺失 / 损坏 → warning CARD_IMAGE_MISSING /
 *      CARD_IMAGE_UNREADABLE（图可能尚未拉取，属建议补齐而非数据损坏）；
 *    - CardID 匹配：slot === cardIdToSlot(card_id)（1 基，%100===0 → 100，
 *      换算单一来源 src/deck/cardid.ts）→ 不等 error CARD_ID_MISMATCH
 *      （读侧已拦截，此处按防御性复核再跑一遍）；
 *    - 图集存在性：sheet_source 解析不到本地文件 → error SHEET_SOURCE_MISSING
 *      （不依赖读图，checkAtlasSize=false 时仍然检查）。
 *
 * 2. **存档校验**（packRoot/.tts/skeleton.json 存在时，文件不存在则整段跳过）：
 *    - 父子 CustomDeck 一致（坑 4 回归）：用 walkSaveUrls 遍历（遍历逻辑单一
 *      实现收口在 src/deck/patch.ts，本模块不手写容器递归），对每个带
 *      CustomDeck 的对象，取其 ContainedObjects 直接子对象，双方 CustomDeck
 *      规格对象逐一 JSON.stringify 后字符串比较（契约认可的"最简单可靠"口径，
 *      键序敏感）→ 不等 error PARENT_CHILD_DECK_MISMATCH；
 *    - {lang} 完好性（坑 5）：所有 URL 字段中含 {lang} 段的值必须仍是合法
 *      {lang} 格式（一段语言标记 + 一段无空白无花括号的 URL，可重复多组）：
 *      以语言段开头但整体不合法 → error LANG_VARIANT_MALFORMED；仅在值中部
 *      出现语言段（疑似被拼接进普通 URL）→ warning LANG_VARIANT_SUSPECT；
 *    - 共享图集：同一 FaceURL 被多个**顶层**对象（ObjectStates[i]，非空 GUID）
 *      引用时，对应 deck.yaml 的 shared_with 必须记录其余 GUID（精确字符串
 *      相等——GUID 不做大小写归一）→ 未记录 warning SHARED_ATLAS_NOT_DECLARED；
 *      没有任何 deck.yaml 声明时同样告警（location 指向 skeleton）。嵌套对象
 *      （ContainedObjects 等容器内）与父对象共享同 URL 是坑 4 的常态，不算
 *      共享，由父子一致性检查负责；空串 GUID 的对象不建索引、不告警
 *      （坑 7，与 src/pack/build.ts:401 的约定一致）。
 *
 * 3. **对象校验**（objects/）：
 *    - objects.csv 存在且合法（用 src/deck/objects.ts 读；先找
 *      `<root>/objects/objects.csv`，再兜底 `<root>/objects.csv`——objects.ts
 *      约定 root 由调用方决定，校验器对两种布局都容忍）；
 *    - file 字段引用的文件存在（相对图包根解析）→ 不存在 warning
 *      OBJECT_FILE_MISSING。
 *
 * ── 设计决定 ────────────────────────────────────────────────────────────────
 * - **issue 文案写死中文、不走 t()**：VerifyIssue 是返回值不是异常，其 code
 *   不是 PackError 错误码（locales 的 error.* 占位键约定只覆盖 PackError）；
 *   文案风格与 src/pack/manifest.ts 的 zod 中文化 error 定制一致。从下游模块
 *   捕获的 PackError 则原样透传其 message（可能是 t() 键名——locales 未补齐时，
 *   测试按"message 双态断言"约定处理）；
 * - **sheet 级检查取该 sheet 首行的 sheet_cols / sheet_rows / sheet_source**：
 *   同一 sheet 的各行应声明同一网格与同一图集；行间声明不一致本身就是问题，
 *   报 ATLAS_GRID_MISMATCH（声明互相矛盾即"网格声明与实际/彼此不符"），
 *   该 sheet 的图级检查跳过（无法选定口径），容量 / CardID 等结构检查照跑；
 * - **不重用 grid.ts 的 cellSize**：它对余数像素向下取整（切割语义），会掩盖
 *   "不整除"这类校验问题；校验需要严格整除判定，故独立计算商并要求整数；
 * - **确定性**：decks/ 子目录按名称排序后逐一校验，issue 顺序稳定（decks →
 *   skeleton → objects），同一工作区两次校验产出逐条一致；
 * - 本模块只读（readdir / readFile / stat / sharp 读元数据），不写任何文件。
 *
 * issue 码一览（severity）：
 * - ATLAS_GRID_MISMATCH      (error)   网格声明与实际图片不符 / 同 sheet 行间声明矛盾
 * - DECK_TOO_MANY_CARDS      (error)   单 sheet 卡数超过声明的最小网格容量
 * - DECK_EMPTY_SLOT          (warning) sheet 有未使用的格子
 * - CARD_CMYK                (error)   卡图（face / back）是 CMYK 色彩空间
 * - CARD_ID_MISMATCH         (error)   slot ≠ cardIdToSlot(card_id)
 * - SHEET_SOURCE_MISSING     (error)   sheet_source 解析不到本地图集文件
 * - ATLAS_UNREADABLE         (error)   图集存在但 sharp 读不出 / 尺寸非法
 * - CARD_IMAGE_MISSING       (warning) 卡图文件不存在（可能尚未拉取）
 * - CARD_IMAGE_UNREADABLE    (warning) 卡图存在但 sharp 读不出
 * - PARENT_CHILD_DECK_MISMATCH (error) 父牌堆与 ContainedObjects 子对象的
 *                                      CustomDeck 深度比较不一致（坑 4 回归）
 * - LANG_VARIANT_MALFORMED   (error)   {lang} 值以语言段开头但整体格式被破坏
 * - LANG_VARIANT_SUSPECT     (warning) 普通 URL 值中部出现 {lang} 段（疑似损坏）
 * - SHARED_ATLAS_NOT_DECLARED (warning) 多对象共享 FaceURL 但 deck.yaml 的
 *                                      shared_with 未记录
 * - SKELETON_INVALID         (error)   skeleton.json 不是合法 JSON 对象
 * - SKELETON_UNREADABLE      (error)   skeleton.json 读取发生非 ENOENT 的 IO 错误
 * - OBJECT_FILE_MISSING      (warning) objects.csv 的 file 引用文件不存在
 * - 下游 PackError 码透传：CARDS_NOT_FOUND / CARDS_INVALID / CARDS_SLOT_OUT_OF_RANGE
 *   / CARDS_DUPLICATE_* / DECK_INVALID / OBJECTS_NOT_FOUND / OBJECTS_INVALID /
 *   OBJECTS_DUPLICATE_ID 等（severity 一律 error——台账损坏即数据损坏）。
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import type { Metadata } from "sharp";

import { decksDir, objectsDir, skeletonPath } from "../pack/layout.js";
import { DECK_YAML_FILENAME, readDeckManifest, type DeckManifest } from "../pack/manifest.js";
import { PackError } from "../pack/packyaml.js";

import { cardIdToSlot } from "./cardid.js";
import { CARDS_CSV_FILENAME, readCardsCsv, type CardRow } from "./cards.js";
import { OBJECTS_CSV_FILENAME, readObjectsCsv } from "./objects.js";
import { isLangVariant, walkSaveUrls } from "./patch.js";

// ---------------------------------------------------------------------------
// 公开类型（契约）
// ---------------------------------------------------------------------------

/** 单条校验结果 */
export interface VerifyIssue {
  /** 严重级别 */
  severity: "error" | "warning";
  /** 机器可读码（如 "ATLAS_GRID_MISMATCH"，完整取值见模块头注释） */
  code: string;
  /** 中文描述 */
  message: string;
  /** 出问题的位置（文件路径或对象路径） */
  location: string;
}

/** 校验选项 */
export interface VerifyOptions {
  /** 图包根目录 */
  packRoot: string;
  /** 是否检查 CMYK（默认 true；需要读图，慢） */
  checkCmyk?: boolean;
  /** 是否检查图集尺寸与 atlas 一致性（默认 true；需要读图，慢） */
  checkAtlasSize?: boolean;
}

/** 校验结果 */
export interface VerifyResult {
  /** 错误数（severity=error） */
  errorCount: number;
  /** 警告数 */
  warningCount: number;
  /** 所有 issue（按 decks 名称序 → skeleton → objects 的确定性顺序） */
  issues: VerifyIssue[];
  /** 是否通过（errorCount === 0；warning 不阻塞通过） */
  ok: boolean;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 合法 {lang} 值的整体格式：一段或多段"语言标记 + URL 块"。
 * 语言标记与 src/deck/patch.ts 的 LANG_SEGMENT_RE 同文法（{xx} / {xx-yy}），
 * URL 块为非空、不含花括号与空白的连续字符（如 "{en}http://a.png{zh-cn}http://b.png"）。
 * 判定入口仍用 patch.ts 的 isLangVariant（检测单一来源），本正则只做"整体合法性"。
 */
const LANG_VARIANT_FULL_RE = /^(?:\{[a-z]{2,3}(?:-[a-z0-9]{2,8})?\}[^{}\s]+)+$/;

/** {lang} 值的开头是否是语言标记（区分"以段开头的变体"与"段嵌在普通 URL 中部"） */
const LANG_VARIANT_PREFIX_RE = /^\{[a-z]{2,3}(?:-[a-z0-9]{2,8})?\}/;

/**
 * 顶层对象的 objectPath 形态（如 "ObjectStates[3]"）。
 * 共享图集只在这些对象之间判定——嵌套对象（ContainedObjects 等容器内）与
 * 父对象共享同 URL 是坑 4 的常态，不是共享图集。
 */
const TOP_LEVEL_OBJECT_RE = /^ObjectStates\[\d+\]$/;

/** generate.ts 切出的本地图集副本目录名（sheet_source 的兜底解析位置） */
const SHEET_FALLBACK_DIR = "source";

/** file: 协议前缀（大小写不敏感，与 patch.ts 的判定一致） */
const FILE_URL_RE = /^file:/i;

/** 从 unknown 错误中取人类可读描述。 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 从 unknown 错误中取 Node 风格 code（如 ENOENT）。 */
function errCode(err: unknown): string | undefined {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

/** 断言 packRoot 是非空字符串（调用方编程错误按仓库惯例抛普通中文 Error）。 */
function assertPackRoot(packRoot: string): void {
  if (typeof packRoot !== "string" || packRoot.trim() === "") {
    throw new Error("verify 入参无效：packRoot 必须是非空字符串路径");
  }
}

/** issue 便捷构造与收集 */
class IssueCollector {
  readonly issues: VerifyIssue[] = [];

  push(severity: VerifyIssue["severity"], code: string, message: string, location: string): void {
    this.issues.push({ severity, code, message, location });
  }

  error(code: string, message: string, location: string): void {
    this.push("error", code, message, location);
  }

  warning(code: string, message: string, location: string): void {
    this.push("warning", code, message, location);
  }

  /** 把 PackError 转为 error issue（CARDS_SLOT_MISMATCH 语义映射为 CARD_ID_MISMATCH）。 */
  packError(err: unknown, fallbackCode: string, location: string): void {
    if (err instanceof PackError) {
      const code = err.code === "CARDS_SLOT_MISMATCH" ? "CARD_ID_MISMATCH" : err.code;
      this.error(code, err.message, location);
      return;
    }
    this.error(fallbackCode, errMessage(err), location);
  }
}

// ---------------------------------------------------------------------------
// 第 1 节：卡牌校验（decks/<name>/）
// ---------------------------------------------------------------------------

/** 已加载的 deck（deck.yaml 校验通过），cards 校验的入参 */
interface LoadedDeck {
  /** deck 目录（decks/<name>/） */
  dir: string;
  /** 目录名（decks/ 下的子目录名） */
  name: string;
  /** deck.yaml 内容（shared_with 缺省已填充 []） */
  manifest: DeckManifest;
  /** deck.yaml 完整路径（issue 的 location） */
  yamlPath: string;
}

/**
 * 枚举 decks/ 下所有带合法 deck.yaml 的子目录（名称排序保证确定性）。
 *
 * 容忍规则（B2 坑 5）：decks/ 下允许存在只有 data.json 没有 deck.yaml 的子目录
 * （GUID 不合规的牌堆）——readDeckManifest 抛 DECK_NOT_FOUND 时静默跳过，
 * 不建 issue、不告警；decks/ 目录本身不存在时返回空数组（无 deck 可校验）。
 * 其他 PackError（DECK_INVALID / DECK_READ_FAILED 等）转为 error issue。
 */
async function loadDecks(packRoot: string, out: IssueCollector): Promise<LoadedDeck[]> {
  const decksRoot = decksDir(packRoot);
  let entries: Dirent[];
  try {
    entries = await readdir(decksRoot, { withFileTypes: true });
  } catch {
    return []; // decks/ 不存在 → 图包没有卡牌组，非问题
  }
  const decks: LoadedDeck[] = [];
  const dirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const name of dirNames) {
    const dir = path.join(decksRoot, name);
    const yamlPath = path.join(dir, DECK_YAML_FILENAME);
    try {
      const manifest = await readDeckManifest(dir);
      decks.push({ dir, name, manifest, yamlPath });
    } catch (err) {
      if (err instanceof PackError && err.code === "DECK_NOT_FOUND") {
        continue; // 坑 5：只有 data.json 的目录是合法状态，静默跳过
      }
      out.packError(err, "DECK_INVALID", yamlPath);
    }
  }
  return decks;
}

/**
 * 解析 sheet_source 为本地图集文件路径；找不到返回 null（→ SHEET_SOURCE_MISSING）。
 *
 * 候选顺序：file: URL（fileURLToPath）→ 绝对路径 → 相对 deckDir → 相对 packRoot
 * → 兜底 `<deckDir>/source/sheet-<sheetId>.png`（契约的本地副本约定，
 * 文件名与 generate.ts 的落盘命名 sheet-<sheetId>.png 一致）。
 */
async function resolveSheetFile(
  source: string,
  sheetId: number,
  deckDir: string,
  packRoot: string,
): Promise<string | null> {
  const candidates: string[] = [];
  if (FILE_URL_RE.test(source)) {
    try {
      candidates.push(fileURLToPath(source));
    } catch {
      // 非法 file: URL → 跳过该候选，交给后续兜底
    }
  } else if (path.isAbsolute(source)) {
    candidates.push(source);
  } else {
    candidates.push(path.join(deckDir, source), path.join(packRoot, source));
  }
  candidates.push(path.join(deckDir, SHEET_FALLBACK_DIR, `sheet-${sheetId}.png`));
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        return candidate;
      }
    } catch {
      // 不存在 → 试下一个候选
    }
  }
  return null;
}

/** 读图集 / 卡图元数据；返回 null 表示 sharp 读不出（调用方按各自码报 issue）。 */
async function readImageMeta(filePath: string): Promise<Metadata | null> {
  try {
    return await sharp(filePath).metadata();
  } catch {
    return null;
  }
}

/**
 * 单个 deck 的卡牌校验（cards.csv + 逐 sheet 结构检查 + 可选的图级检查）。
 * cards.csv 读不出来时记 issue 并返回（后续检查无从谈起）。
 */
async function verifyDeckCards(
  deck: LoadedDeck,
  packRoot: string,
  opts: { checkCmyk: boolean; checkAtlasSize: boolean },
  out: IssueCollector,
): Promise<void> {
  const cardsPath = path.join(deck.dir, CARDS_CSV_FILENAME);

  // ── cards.csv 存在且合法（用 cards.ts 读，PackError 转 issue）──
  let rows: CardRow[];
  try {
    rows = await readCardsCsv(deck.dir);
  } catch (err) {
    out.packError(err, "CARDS_INVALID", cardsPath);
    return;
  }

  // ── 按 sheet_id 分组（Map 保持首次出现顺序 = 文件顺序，确定性）──
  const sheets = new Map<number, CardRow[]>();
  for (const row of rows) {
    const group = sheets.get(row.sheetId);
    if (group === undefined) {
      sheets.set(row.sheetId, [row]);
    } else {
      group.push(row);
    }
  }

  for (const [sheetId, sheetRows] of sheets) {
    const first = sheetRows[0];

    // ── 卡数超容量（容量按各行声明的最小 cols×rows 计，最保守口径）──
    //    结构性检查，不依赖读图，checkAtlasSize=false 时照跑。
    const minCapacity = Math.min(...sheetRows.map((row) => row.sheetCols * row.sheetRows));
    if (sheetRows.length > minCapacity) {
      out.error(
        "DECK_TOO_MANY_CARDS",
        `sheet ${sheetId} 有 ${sheetRows.length} 张卡，超过声明的最小网格容量 ${minCapacity}`,
        cardsPath,
      );
    }

    // ── 行间声明一致性：同一 sheet 的各行必须声明同一网格 ──
    const declarations = new Set(sheetRows.map((row) => `${row.sheetCols}x${row.sheetRows}`));
    if (declarations.size > 1) {
      out.error(
        "ATLAS_GRID_MISMATCH",
        `sheet ${sheetId} 的行列声明不一致：${[...declarations].map((d) => `${d}（共 ${sheetRows.filter((row) => `${row.sheetCols}x${row.sheetRows}` === d).length} 行）`).join("、")}`,
        cardsPath,
      );
      continue; // 网格口径无法选定，跳过该 sheet 的图级检查（结构检查已在上）
    }

    const cols = first.sheetCols;
    const rowCount = first.sheetRows;
    const capacity = cols * rowCount;

    // ── 空白格（1 基 slot 1..capacity 中未使用的；warning，不阻塞通过）──
    const usedSlots = new Set(sheetRows.map((row) => row.slot));
    const missingSlots: number[] = [];
    for (let slot = 1; slot <= capacity; slot++) {
      if (!usedSlots.has(slot)) {
        missingSlots.push(slot);
      }
    }
    if (missingSlots.length > 0) {
      out.warning(
        "DECK_EMPTY_SLOT",
        `sheet ${sheetId} 有未使用的格子：${missingSlots.join("、")}（${missingSlots.length}/${capacity} 格空）`,
        cardsPath,
      );
    }

    // ── CardID 匹配复核（1 基单一来源 cardid.ts；读侧已拦截，防御性再跑）──
    for (const row of sheetRows) {
      if (row.slot !== cardIdToSlot(row.cardId)) {
        out.error(
          "CARD_ID_MISMATCH",
          `card_id ${row.cardId} 的 slot 应为 ${cardIdToSlot(row.cardId)}（1 基，%100===0 记 100），实际为 ${row.slot}`,
          cardsPath,
        );
      }
    }

    // ── 图集存在性（不依赖读图，checkAtlasSize=false 时仍然检查）──
    const atlasPath = await resolveSheetFile(first.sheetSource, sheetId, deck.dir, packRoot);
    if (atlasPath === null) {
      const fallback = path.join(deck.dir, SHEET_FALLBACK_DIR, `sheet-${sheetId}.png`);
      out.error(
        "SHEET_SOURCE_MISSING",
        `sheet ${sheetId} 的图集文件不存在：sheet_source=${first.sheetSource}（本地副本 ${fallback} 也不存在）`,
        cardsPath,
      );
      continue;
    }
    if (!opts.checkAtlasSize) {
      continue; // 尺寸一致性需要读图，按选项跳过
    }

    // ── 网格一致性：宽/列 与 高/行 必须都是整数且相等（契约的方格公式）──
    const meta = await readImageMeta(atlasPath);
    if (meta === null || typeof meta.width !== "number" || typeof meta.height !== "number"
      || meta.width <= 0 || meta.height <= 0) {
      out.error("ATLAS_UNREADABLE", `sheet ${sheetId} 的图集无法读取或尺寸非法：${atlasPath}`, atlasPath);
      continue;
    }
    if (opts.checkCmyk && meta.space === "cmyk") {
      out.error("ATLAS_CMYK", `sheet ${sheetId} 的图集是 CMYK 色彩空间（TTS 不支持）：${atlasPath}`, atlasPath);
    }
    const cellWidth = meta.width / cols;
    const cellHeight = meta.height / rowCount;
    if (!Number.isInteger(cellWidth) || !Number.isInteger(cellHeight) || cellWidth !== cellHeight) {
      out.error(
        "ATLAS_GRID_MISMATCH",
        `sheet ${sheetId} 图集实际 ${meta.width}x${meta.height}，按声明 ${cols}x${rowCount} 切出的单格为 ${cellWidth}x${cellHeight}（应为相等整数值的方格）`,
        atlasPath,
      );
    }
  }

  // ── CMYK / 卡图可读性（checkCmyk 时；face + back 去重后逐一检查）──
  if (opts.checkCmyk) {
    const imageFiles = new Set<string>();
    for (const row of rows) {
      imageFiles.add(row.face);
      if (row.back !== undefined) {
        imageFiles.add(row.back);
      }
    }
    for (const relative of imageFiles) {
      const imagePath = path.join(deck.dir, relative);
      let info;
      try {
        info = await stat(imagePath);
      } catch {
        out.warning("CARD_IMAGE_MISSING", `卡图文件不存在（可能尚未拉取）：${relative}`, imagePath);
        continue;
      }
      if (!info.isFile()) {
        out.warning("CARD_IMAGE_UNREADABLE", `卡图路径不是文件：${relative}`, imagePath);
        continue;
      }
      const meta = await readImageMeta(imagePath);
      if (meta === null) {
        out.warning("CARD_IMAGE_UNREADABLE", `卡图无法读取（文件损坏或格式不支持）：${relative}`, imagePath);
        continue;
      }
      if (meta.space === "cmyk") {
        out.error("CARD_CMYK", `卡图是 CMYK 色彩空间（TTS 不支持）：${relative}`, imagePath);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 第 2 节：存档校验（skeleton.json）
// ---------------------------------------------------------------------------

/** 父子一致比较用的 CustomDeck 规格快照（遍历顺序即对齐顺序） */
interface DeckSpecSnapshot {
  /** 字段路径标签（如 "CustomDeck.FaceURL"） */
  fieldKey: string;
  /** 规格对象的可变引用（含 NumWidth 等非 URL 字段；比较时 JSON.stringify） */
  host: Record<string, unknown>;
}

/** 共享图集检测用的 FaceURL 引用记录（顶层判定在 checkSharedAtlas 里做） */
interface FaceUrlRef {
  guid: string;
  url: string;
  /** 引用对象的原始 objectPath（如 "ObjectStates[0]"；用于顶层判定） */
  objectPath: string;
}

/** skeleton 校验的收集产物 */
interface SkeletonScan {
  /** objectPath → 该对象 CustomDeck 的规格快照序列（遍历顺序） */
  specs: Map<string, DeckSpecSnapshot[]>;
  /** FaceURL 引用（非 {lang} 值、非空 GUID；坑 7：空 GUID 不建索引） */
  faceRefs: FaceUrlRef[];
}

/**
 * 用 walkSaveUrls 扫描 skeleton（skipLangVariants=false：只读校验不改写，
 * {lang} 值也必须被看到才能检查完好性）。一次遍历同时收集：
 * 父子一致快照、FaceURL 引用，{lang} 完好性在 visitor 内直接判定。
 */
function scanSkeleton(root: unknown, out: IssueCollector): SkeletonScan {
  const scan: SkeletonScan = { specs: new Map(), faceRefs: [] };
  walkSaveUrls(
    root,
    (loc) => {
      const objectPath = loc.objectPath === "" ? "(根)" : loc.objectPath;
      const fieldLabel = loc.fieldPath.join(".");

      // ── {lang} 完好性（坑 5）──
      if (isLangVariant(loc.currentValue) && !LANG_VARIANT_FULL_RE.test(loc.currentValue)) {
        if (LANG_VARIANT_PREFIX_RE.test(loc.currentValue)) {
          out.error(
            "LANG_VARIANT_MALFORMED",
            `字段 ${fieldLabel} 的 {lang} 值格式被破坏（应为"{语言段}{URL 块}"的重复）：${loc.currentValue}`,
            objectPath,
          );
        } else {
          out.warning(
            "LANG_VARIANT_SUSPECT",
            `字段 ${fieldLabel} 的值中部出现 {lang} 段（疑似普通 URL 被拼接损坏）：${loc.currentValue}`,
            objectPath,
          );
        }
      }

      // ── 父子一致快照（坑 4 回归）──
      if (loc.fieldPath[0] === "CustomDeck") {
        const list = scan.specs.get(loc.objectPath);
        const snapshot: DeckSpecSnapshot = { fieldKey: fieldLabel, host: loc.host };
        if (list === undefined) {
          scan.specs.set(loc.objectPath, [snapshot]);
        } else {
          list.push(snapshot);
        }
      }

      // ── 共享图集引用（仅 FaceURL；{lang} 值与空 GUID 不参与，坑 7）──
      //    记录原始 objectPath，顶层判定在 checkSharedAtlas 里做。
      if (loc.fieldPath[0] === "CustomDeck" && loc.hostKey === "FaceURL" && loc.guid !== ""
        && !isLangVariant(loc.currentValue)) {
        scan.faceRefs.push({ guid: loc.guid, url: loc.currentValue, objectPath: loc.objectPath });
      }
    },
    { skipLangVariants: false },
  );
  return scan;
}

/**
 * 父子 CustomDeck 一致性（坑 4 回归）：
 * 对每个带 CustomDeck 快照的对象 P，找其 ContainedObjects 直接子对象
 * （objectPath 恰为 `${P}.ContainedObjects[i]`）中同样有快照的，逐条比较
 * 快照序列（长度 + fieldKey + hostJson）。子对象没有 CustomDeck 快照时跳过
 * （URL 全空 / 非 Card 的容器对象，无法比较也不算不一致）。
 */
function checkParentChild(scan: SkeletonScan, out: IssueCollector): void {
  for (const [parentPath, parentSpecs] of scan.specs) {
    const childPrefix = parentPath === "" ? "ContainedObjects[" : `${parentPath}.ContainedObjects[`;
    for (const [childPath, childSpecs] of scan.specs) {
      if (childPath === parentPath || !childPath.startsWith(childPrefix)) {
        continue;
      }
      if (!/^\d+\]$/.test(childPath.slice(childPrefix.length))) {
        continue; // 是孙辈或更深的后代，不是直接子对象（孙辈与各自的父比对）
      }
      const firstDiff = compareSpecs(parentSpecs, childSpecs);
      if (firstDiff !== null) {
        const detail = firstDiff.index === -1
          ? firstDiff.detail
          : `第 ${firstDiff.index + 1} 条（${firstDiff.fieldKey}）${firstDiff.detail}`;
        out.error(
          "PARENT_CHILD_DECK_MISMATCH",
          `父对象 ${parentPath === "" ? "(根)" : parentPath} 与 ContainedObjects 子对象 ${childPath} 的 CustomDeck 不一致：${detail}（坑 4：改图集必须父子同步）`,
          childPath,
        );
      }
    }
  }
}

/** 两个规格快照逐字段找出首个差异的中文描述。 */
function specDiffDetail(parent: DeckSpecSnapshot, child: DeckSpecSnapshot): string {
  const keys = new Set([...Object.keys(parent.host), ...Object.keys(child.host)]);
  for (const key of keys) {
    const parentValue = JSON.stringify(parent.host[key]) ?? "undefined";
    const childValue = JSON.stringify(child.host[key]) ?? "undefined";
    if (parentValue !== childValue) {
      return `字段 ${key} 不同（${parentValue} → ${childValue}）`;
    }
  }
  return "规格内容或键序不同";
}

/** 比较两个快照序列；一致返回 null，否则返回首个差异的位置与描述。 */
function compareSpecs(
  parent: readonly DeckSpecSnapshot[],
  child: readonly DeckSpecSnapshot[],
): { index: number; fieldKey: string; detail: string } | null {
  if (parent.length !== child.length) {
    return {
      index: -1,
      fieldKey: parent[0]?.fieldKey ?? child[0]?.fieldKey ?? "CustomDeck",
      detail: `快照条数不同（父 ${parent.length} 条，子 ${child.length} 条）`,
    };
  }
  for (let i = 0; i < parent.length; i++) {
    const p = parent[i];
    const c = child[i];
    if (p.fieldKey !== c.fieldKey || JSON.stringify(p.host) !== JSON.stringify(c.host)) {
      return { index: i, fieldKey: p.fieldKey, detail: specDiffDetail(p, c) };
    }
  }
  return null;
}

/**
 * 共享图集声明检查：同一 FaceURL 被 ≥2 个**顶层**对象（objectPath 恰为
 * ObjectStates[i]）的不同非空 GUID 引用时，每个 guid 落在引用集合里的
 * deck.yaml，其 shared_with 必须记录其余 GUID（精确字符串相等，不做大小写
 * 归一）；一个声明方都没有 → 也告警。
 *
 * 为什么只看顶层对象：父牌堆与其 ContainedObjects 里的每张 Card 本来就共享
 * 同一 FaceURL（坑 4 的常态，CustomDeck 整份复制），那不是"共享图集"而是
 * "同一牌堆的父子同步"，由父子一致性检查负责；若把嵌套对象计入，任何正常
 * 牌堆都会误报 SHARED_ATLAS_NOT_DECLARED。
 */
function checkSharedAtlas(
  scan: SkeletonScan,
  decks: readonly LoadedDeck[],
  skeletonFile: string,
  out: IssueCollector,
): void {
  const topLevelRefs = scan.faceRefs.filter((ref) => TOP_LEVEL_OBJECT_RE.test(ref.objectPath));
  const byUrl = new Map<string, Set<string>>();
  for (const ref of topLevelRefs) {
    const guids = byUrl.get(ref.url);
    if (guids === undefined) {
      byUrl.set(ref.url, new Set([ref.guid]));
    } else {
      guids.add(ref.guid);
    }
  }
  for (const [url, guidSet] of byUrl) {
    if (guidSet.size < 2) {
      continue; // 单对象引用（同一对象内多个图集 key 同 URL 也不算共享）
    }
    const guids = [...guidSet];
    const declaring = decks.filter((deck) => guidSet.has(deck.manifest.guid));
    if (declaring.length === 0) {
      out.warning(
        "SHARED_ATLAS_NOT_DECLARED",
        `FaceURL 被 ${guids.length} 个对象共享（GUID ${guids.join("、")}），但没有任何 deck.yaml 的 shared_with 声明这一共享`,
        skeletonFile,
      );
      continue;
    }
    for (const deck of declaring) {
      const missing = guids.filter((guid) => guid !== deck.manifest.guid
        && !deck.manifest.shared_with.includes(guid));
      if (missing.length > 0) {
        out.warning(
          "SHARED_ATLAS_NOT_DECLARED",
          `GUID ${deck.manifest.guid} 与 ${missing.join("、")} 共享同一 FaceURL，但 ${deck.yamlPath} 的 shared_with 未记录：${missing.join("、")}`,
          deck.yamlPath,
        );
      }
    }
  }
}

/** 存档校验主流程：skeleton.json 不存在时整段跳过。 */
async function verifySkeleton(
  packRoot: string,
  decks: readonly LoadedDeck[],
  out: IssueCollector,
): Promise<void> {
  const skeletonFile = skeletonPath(packRoot);
  let raw: string;
  try {
    raw = await readFile(skeletonFile, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return; // 没有骨架存档（尚未 pull/unpack）→ 整段跳过，非问题
    }
    out.error("SKELETON_UNREADABLE", `骨架存档读取失败：${errMessage(err)}`, skeletonFile);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    out.error("SKELETON_INVALID", `骨架存档不是合法 JSON：${errMessage(err)}`, skeletonFile);
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    out.error("SKELETON_INVALID", "骨架存档根必须是 JSON 对象", skeletonFile);
    return;
  }

  const scan = scanSkeleton(parsed, out);
  checkParentChild(scan, out);
  checkSharedAtlas(scan, decks, skeletonFile, out);
}

// ---------------------------------------------------------------------------
// 第 3 节：对象校验（objects/）
// ---------------------------------------------------------------------------

/**
 * 对象校验：objects.csv 存在且合法（先 `<root>/objects/objects.csv`，
 * 兜底 `<root>/objects.csv`——objects.ts 约定 root 由调用方决定，两种布局都认），
 * 再逐行检查 file 引用的文件存在（相对图包根解析）。
 */
async function verifyObjects(packRoot: string, out: IssueCollector): Promise<void> {
  const primaryDir = objectsDir(packRoot);
  let rows: Awaited<ReturnType<typeof readObjectsCsv>> | null = null;
  let notFound: PackError | null = null;
  for (const candidateRoot of [primaryDir, packRoot]) {
    try {
      rows = await readObjectsCsv(candidateRoot);
      break;
    } catch (err) {
      if (err instanceof PackError && err.code === "OBJECTS_NOT_FOUND") {
        notFound = err;
        continue;
      }
      out.packError(err, "OBJECTS_INVALID", path.join(candidateRoot, OBJECTS_CSV_FILENAME));
      return;
    }
  }
  if (rows === null) {
    const err = notFound;
    out.error(
      "OBJECTS_NOT_FOUND",
      err === null ? "objects.csv 不存在" : err.message,
      path.join(primaryDir, OBJECTS_CSV_FILENAME),
    );
    return;
  }

  for (const row of rows) {
    const filePath = path.isAbsolute(row.file) ? row.file : path.join(packRoot, row.file);
    let ok = false;
    try {
      ok = (await stat(filePath)).isFile();
    } catch {
      ok = false;
    }
    if (!ok) {
      out.warning(
        "OBJECT_FILE_MISSING",
        `素材 ${row.assetId}（type=${row.type}）的 file 引用的文件不存在：${row.file}`,
        filePath,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 校验图包工作区（只读；所有 issue 收集后一次性返回，不在第一个错误就抛）。
 *
 * 校验面与 issue 码见模块头注释。行为要点：
 * - decks/ 下的目录按名称排序逐一校验（确定性）；只有 data.json 没有 deck.yaml
 *   的目录静默跳过（坑 5）；deck.yaml 非法报 error 后不再校验该 deck 的 cards；
 * - skeleton.json 不存在 → 存档校验整段跳过；objects.csv 不存在 → error；
 * - checkCmyk / checkAtlasSize 只关掉"需要读图"的检查（CMYK、网格尺寸），
 *   存在性等廉价检查照跑；
 * - packRoot 不是非空字符串时抛普通中文 Error（调用方编程错误，仓库惯例）。
 *
 * @param opts 校验选项（packRoot 必填，checkCmyk / checkAtlasSize 默认 true）
 * @returns 全部 issue 与统计（ok = errorCount === 0，warning 不阻塞通过）
 */
export async function verifyPack(opts: VerifyOptions): Promise<VerifyResult> {
  assertPackRoot(opts.packRoot);
  const packRoot = opts.packRoot;
  const options = {
    checkCmyk: opts.checkCmyk !== false,
    checkAtlasSize: opts.checkAtlasSize !== false,
  };
  const out = new IssueCollector();

  // ── 第 1 节：卡牌校验（decks/<name>/，名称序）──
  const decks = await loadDecks(packRoot, out);
  for (const deck of decks) {
    await verifyDeckCards(deck, packRoot, options, out);
  }

  // ── 第 2 节：存档校验（skeleton.json 存在时）──
  await verifySkeleton(packRoot, decks, out);

  // ── 第 3 节：对象校验（objects/）──
  await verifyObjects(packRoot, out);

  const errorCount = out.issues.filter((issue) => issue.severity === "error").length;
  const warningCount = out.issues.length - errorCount;
  return { errorCount, warningCount, issues: out.issues, ok: errorCount === 0 };
}
