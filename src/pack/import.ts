// src/pack/import.ts
/**
 * import.yaml：素材导入清单的导入器（方案设计 §4.6 / §5.11；契约见
 * docs/schemas/import.yaml.md）。
 *
 * 职责：
 * - 定义 import.yaml 的 zod schema（严格模式：根对象与每条 decks[] / objects[]
 *   条目都是 z.strictObject，未声明字段与缺失必填字段一律拒绝，防拼写错误静默生效）；
 * - {@link importAssets}：读取清单 → 全量校验（文件存在性、图像可读、拒 CMYK、
 *   网格容量）→ 纯内存规划 → 落盘（复制素材文件 + 写 cards.csv / objects.csv），
 *   `dryRun: true` 时只规划返回、不写任何文件。
 *
 * 命名裁决（窗口 C 主窗口，2026-10-05）：导入清单定名 import.yaml，与图包根的
 * assets.yaml（URL 台账，src/pack/manifest.ts）是两份完全不同的文件——本模块
 * 只消费前者，不读写 assets.yaml。
 *
 * ── 路径基准（契约 §6.1，必读）────────────────────────────────────────────
 * - 清单里所有相对路径**相对 import.yaml 所在目录**解析（path.resolve(base, raw)），
 *   不是相对图包根、也不是相对 CWD；源文件允许位于工作区之外（用户素材在哪都行）；
 * - 落盘目标统一在工作区内：decks/<净化名>/、objects/<type>s/<name>/；
 *   净化用 src/pack/layout.ts 的 {@link sanitizeName}（与 tts pull 落盘同名规则），
 *   防止 name 里的路径分隔符把目录逃出工作区；目标路径仍逐个断言在 root 之内
 *   （防御性 {@link assertInsideRoot}）。
 *
 * ── 卡堆导入规则 ──────────────────────────────────────────────────────────
 * - cards_dir 下的**图片文件**按文件名顺序（码元序）装入；非图片文件（含子目录）
 *   跳过并归入 warnings（不静默丢弃）；扩展名白名单见 {@link IMAGE_EXTENSIONS}；
 * - back 三模式：`common`（共用背面，back_file 必填）/ `unique`（每卡独立背面，
 *   按"序号_正面.ext ↔ 序号_背面.ext"命名约定配对，正面不带 _正面 后缀时按
 *   "同名_背面.ext" 找背面）/ `none`（无自定义背面）；back_file 只允许出现在
 *   back=common 的条目上，其余组合报 IMPORT_INVALID；
 * - card_id 按顺序分配：card_id = slotToCardId(key, slot)，**新导入的 deck 从
 *   key=1（card_id 101 起）开始**；单图集容量 = 显式 grid ? cols×rows : 70
 *   （TTS 硬上限 10×7，src/deck/grid.ts 的 MAX_SLOTS），超出自动拆多张图集：
 *   sheet_id 依次 1,2,3…，**每张图集内 slot 独立从 1 编号**，key 随 sheet 递增
 *   （cards.csv 契约 §9 的跨图集 key 进位规则）；
 * - 未显式声明 grid 时按卡数自动选网格：每张图集用 src/deck/grid.ts 的
 *   {@link inferGrid}(1, 1, 该图集卡数) 推断——导入是**逻辑布局**（不拼接图集
 *   大图，拼图走 tts deck generate），没有真实图集宽高比可依据，按正方形假设
 *   (1,1) 推断是最中性的选择；
 * - 自动生成或更新 decks/<name>/cards.csv：**已有行原样保留**（card_id 不重新
 *   分配，cards.csv 契约 §7.3），face 文件名已存在的卡只刷新图片文件、不重复
 *   建行；新增卡从"已有最大 key + 1 / 已有最大 sheet_id + 1"起另开新图集
 *   （不往已有图集里塞卡——已有行可能来自 slice，其 sheet 与真实图集对应）；
 * - **只写 cards.csv，不写 deck.yaml**（契约 §7：卡堆明细唯一源是 cards.csv；
 *   且 import.yaml 的 guid 是可选项，凑不齐 deck.yaml 的必填 guid——B2 已删除
 *   deck.yaml.cards[]，本模块更不回写该字段）；
 * - sheet_source 取"清单里声明的 cards_dir + / + 卡图文件名"（如
 *   `./新卡图/001_正面.png`）：逐卡可溯源、与机器无关；导入的 deck 没有真实
 *   图集大图，verify 对这类行的图集存在性告警是预期现象，不在本模块处理。
 *
 * ── 对象导入规则 ──────────────────────────────────────────────────────────
 * - 落盘 objects/<type>s/<name>/（类型名后直接拼 "s"，契约 §4 字段表原文）；
 * - 文件字段按类型校验必填（{@link REQUIRED_FILE_FIELD}）：tile / decal /
 *   notecard / sky / table / token / board / pawn / counter 必填 image，
 *   figurine / model / dice 必填 mesh，assetbundle 必填 assetbundle，
 *   pdf 必填 pdf，audio 必填 audio；契约未列出的开放类型不强制字段（开放集合，
 *   objects.csv 契约 §7），但会按 src/deck/types.ts 注册表告警"未注册类型"；
 * - 图像类文件（image / diffuse）过 sharp 可读性 + CMYK 检查；mesh / pdf /
 *   audio / assetbundle 只查存在性；
 * - 列映射：主文件（类型必填字段，开放类型按 image > mesh > assetbundle > pdf >
 *   audio 取第一个提供的）→ `file` 列；其余文件字段中第一个 → `file_secondary`
 *   列；diffuse → `diffuse` 列；再多余的字段照常复制文件但告警"未能映射"；
 * - 自动生成或更新 objects/objects.csv（位置 <root>/objects/objects.csv，与
 *   verify 的首选布局一致）：条目身份 = (type, name)——已有行 **asset_id 永不
 *   改变**，file / file_secondary / diffuse / source 按本次清单重算，normal /
 *   collider / origin_asset_id / origin_pack 不归导入管、原样保留；新行
 *   asset_id 由 (type, name) 的 sha256 派生（`imp-` + 8 位十六进制，确定性可
 *   复现），撞车时追加 -2 / -3 后缀；
 * - origin_asset_id 导入**不写**（窗口 C 主窗口 2026-10-05 裁决）：该列语义为
 *   "从别的图包复制来时的原始 asset_id"（溯源），由 copy 流程写入，不做哈希
 *   计算，与 objects.csv 契约 §12.2 口径对齐。
 *
 * ── 原子性与错误处理 ─────────────────────────────────────────────────────
 * - 全部校验（schema → 业务规则 → 文件存在性 → 图像可读 / CMYK）与全部规划
 *   **先于任何落盘**完成；校验失败即报错并指出具体条目，不静默跳过；
 * - 落盘顺序：复制素材文件 → 写各 deck 的 cards.csv → 写 objects.csv
 *   （csv 是下游消费的状态，最后提交，与 generate.ts 同一考虑）；
 * - dryRun 走完全相同的校验与规划，只是跳过落盘步骤。
 *
 * ── 错误码（{@link PackError.code}；错误类型复用 src/pack/packyaml.ts）────
 * - "IMPORT_INVALID"        清单不是合法 YAML / 不合 schema / 业务规则违规
 *                           （back 组合、重名、必填文件字段缺失、空卡片目录、
 *                           命名冲突、图像不可读等）
 * - "IMPORT_FILE_MISSING"   清单文件或任一源文件不存在 / 不可读 / 不是普通文件
 * - "IMPORT_CMYK"           任一导入图像是 CMYK 色彩空间（space === "cmyk"，
 *                           与 src/deck/verify.ts 的 CARD_CMYK 同一口径）
 * - "IMPORT_GRID_OVERFLOW"  单张图集需要的格数超过上限 70（防御性兜底：拆分
 *                           逻辑保证常规输入每张 ≤ 70，常规流不可达）
 * - "IMPORT_EMPTY"          decks 与 objects 全空（清单没有任何可导入条目）
 * - "IMPORT_READ_FAILED"    读取清单文件时发生"文件不存在"以外的 IO 错误
 *                           （契约未列的 IO 兜底码，与 cards.ts 的
 *                           CARDS_READ_FAILED 同构，防 IO 异常裸抛）
 * - "IMPORT_WRITE_FAILED"   复制素材文件时发生 IO 错误（IO 兜底码；csv 写入
 *                           的 IO 错误由 cards.ts / objects.ts 自身的
 *                           *_WRITE_FAILED 码承载，原样透传）
 * 既有码透传：目标 cards.csv / objects.csv 已存在但内容非法时，readCardsCsv /
 * readObjectsCsv 的 CARDS_* / OBJECTS_* 码原样向上抛（不静默覆盖损坏台账）。
 *
 * 本模块新增的 i18n 键（locales/*.json 由本阶段的 locales Run 补齐；缺键时
 * t() 原样输出键名，测试按"message 双态断言"约定处理——见
 * tests/unit/pack-import.test.ts）：
 * - `error.pack.importManifestReadFailed` {path} {detail}   → IMPORT_READ_FAILED
 * - `error.pack.importManifestInvalidYaml` {path} {detail}  → IMPORT_INVALID
 * - `error.pack.importManifestInvalid` {path} {issues}      → IMPORT_INVALID
 * - `error.pack.importEmpty`                                → IMPORT_EMPTY
 * - `error.pack.importFileMissing` {path}                   → IMPORT_FILE_MISSING
 * - `error.pack.importImageUnreadable` {path}               → IMPORT_INVALID
 * - `error.pack.importCmyk` {path}                          → IMPORT_CMYK
 * - `error.pack.importGridOverflow` {cells} {maxSlots}      → IMPORT_GRID_OVERFLOW
 * - `error.pack.importBackFileRequired` {deck}              → IMPORT_INVALID
 * - `error.pack.importBackFileForbidden` {deck} {back}      → IMPORT_INVALID
 * - `error.pack.importDuplicateDeck` {name}                 → IMPORT_INVALID
 * - `error.pack.importDuplicateObject` {type} {name}        → IMPORT_INVALID
 * - `error.pack.importObjectFieldRequired` {type} {field} {name} → IMPORT_INVALID
 * - `error.pack.importObjectNoFiles` {type} {name}          → IMPORT_INVALID
 * - `error.pack.importCardsDirEmpty` {deck} {path}          → IMPORT_INVALID
 * - `error.pack.importNameCollision` {deck} {file}          → IMPORT_INVALID
 * - `error.pack.importObjectFileCollision` {name} {file}    → IMPORT_INVALID
 * - `error.pack.importDestOutsideRoot` {path}               → IMPORT_INVALID
 * - `error.pack.importWriteFailed` {path} {detail}          → IMPORT_WRITE_FAILED
 * - `import.warning.packYamlMissing` {root}                 → warnings
 * - `import.warning.packNameMismatch` {manifestPack} {packName} → warnings
 * - `import.warning.unregisteredType` {type} {name}         → warnings
 * - `import.warning.skippedFiles` {deck} {files}            → warnings
 * - `import.warning.unmappedObjectFile` {name} {field}      → warnings
 *
 * zod 各字段的 issue 文案按仓库既有风格写死中文（与 packyaml.ts 的决定一致），
 * 只作为 formatZodError 摘要的数据部分出现，不单独面向用户，故不走 t()。
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { CARDS_CSV_FILENAME, readCardsCsv, writeCardsCsv, type CardRow } from "../deck/cards.js";
import { cardIdToKey, slotToCardId } from "../deck/cardid.js";
import { MAX_SLOTS, inferGrid, type GridSpec } from "../deck/grid.js";
import { OBJECTS_CSV_FILENAME, objectsCsvPath, readObjectsCsv, writeObjectsCsv, type ObjectRow } from "../deck/objects.js";
import { createRegistry } from "../deck/types.js";
import { t } from "../i18n/index.js";
import { decksDir, objectsDir, sanitizeName } from "./layout.js";
import { PackError, readPackYaml } from "./packyaml.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** import.yaml 的结构版本（schema_version 字面量） */
export const IMPORT_SCHEMA_VERSION = 1;

/** 卡图 / 背面命名约定的后缀（契约 §3：001_正面.png ↔ 001_背面.png） */
const FACE_SUFFIX = "_正面";
const BACK_SUFFIX = "_背面";

/** cards_dir 里视为图片的扩展名白名单（小写比较；不在名单内的文件跳过并告警） */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".avif",
]);

/** 对象条目的文件字段（image / mesh / assetbundle / pdf / audio；diffuse 单列） */
const OBJECT_FILE_FIELDS = ["image", "mesh", "assetbundle", "pdf", "audio"] as const;

/** 开放类型（不在 {@link REQUIRED_FILE_FIELD} 里）取主文件的优先序 */
const PRIMARY_FIELD_PRIORITY = OBJECT_FILE_FIELDS;

/** back 模式（契约 §3） */
const BACK_MODES = ["common", "unique", "none"] as const;

/**
 * type → 必填文件字段（契约 §4 字段表"按类型"列 + src/deck/types.ts 注册表的
 * 图像主类型；开放集合里的其他类型不强制——见 objects.csv 契约 §7）。
 */
const REQUIRED_FILE_FIELD: Readonly<Record<string, string>> = {
  tile: "image",
  decal: "image",
  notecard: "image",
  sky: "image",
  table: "image",
  token: "image",
  board: "image",
  pawn: "image",
  counter: "image",
  figurine: "mesh",
  model: "mesh",
  dice: "mesh",
  assetbundle: "assetbundle",
  pdf: "pdf",
  audio: "audio",
};

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

/**
 * 生成严格对象的中文化 error 定制（与 packyaml.ts 的同名内部函数一致）。
 *
 * 为什么不用 zod 默认文案：对未知字段 / 根类型错误，zod 默认 message 是英文，
 * 会原样进入 IMPORT_INVALID 的用户可见摘要，违反"错误必须中文"的约束。
 *
 * @param label 对象标签（如 "decks 条目"；根对象用 "import.yaml 根"）
 * @returns 可直接传给 zod 对象构造第二参数 error 的定制函数
 */
function strictObjectError(label: string): (issue: z.core.$ZodRawIssue) => string {
  return (issue) => {
    // unrecognized_keys 类 issue 携带 keys: PropertyKey[]；其余（根类型错误）没有
    const keys = (issue as { keys?: unknown }).keys;
    if (Array.isArray(keys)) {
      return `${label}含有无法识别的字段：${keys.map((key) => String(key)).join("、")}`;
    }
    return `${label}必须是键值对象`;
  };
}

/** decks[].grid 的 schema（严格模式；cols/rows 与 deck.yaml atlas 的 columns/rows 同范围） */
const gridSchema = z.strictObject(
  {
    cols: z
      .number({ error: "grid.cols 必须是数字" })
      .int("grid.cols 必须是整数")
      .min(1, "grid.cols 不能小于 1")
      .max(10, "grid.cols 不能大于 10"),
    rows: z
      .number({ error: "grid.rows 必须是数字" })
      .int("grid.rows 必须是整数")
      .min(1, "grid.rows 不能小于 1")
      .max(7, "grid.rows 不能大于 7"),
  },
  { error: strictObjectError("grid") },
);

/** decks[] 卡堆条目的 schema（严格模式） */
const deckEntrySchema = z.strictObject(
  {
    name: z.string({ error: "decks[].name 必须是字符串" }).min(1, "decks[].name 不能为空字符串"),
    guid: z.string({ error: "decks[].guid 必须是字符串" }).min(1, "decks[].guid 不能为空字符串").optional(),
    grid: gridSchema.optional(),
    back: z
      .enum(BACK_MODES, { error: "decks[].back 必须是 common / unique / none 之一" })
      .default("common"),
    back_file: z.string({ error: "decks[].back_file 必须是字符串" }).min(1, "decks[].back_file 不能为空字符串").optional(),
    cards_dir: z
      .string({ error: "decks[].cards_dir 必须是字符串" })
      .min(1, "decks[].cards_dir 不能为空字符串"),
  },
  { error: strictObjectError("decks 条目") },
);

/** objects[] 非卡牌素材条目的 schema（严格模式；type 是开放集合，不做枚举校验） */
const objectEntrySchema = z.strictObject(
  {
    type: z.string({ error: "objects[].type 必须是字符串" }).min(1, "objects[].type 不能为空字符串"),
    name: z.string({ error: "objects[].name 必须是字符串" }).min(1, "objects[].name 不能为空字符串"),
    image: z.string({ error: "objects[].image 必须是字符串" }).min(1, "objects[].image 不能为空字符串").optional(),
    mesh: z.string({ error: "objects[].mesh 必须是字符串" }).min(1, "objects[].mesh 不能为空字符串").optional(),
    diffuse: z.string({ error: "objects[].diffuse 必须是字符串" }).min(1, "objects[].diffuse 不能为空字符串").optional(),
    assetbundle: z.string({ error: "objects[].assetbundle 必须是字符串" }).min(1, "objects[].assetbundle 不能为空字符串").optional(),
    pdf: z.string({ error: "objects[].pdf 必须是字符串" }).min(1, "objects[].pdf 不能为空字符串").optional(),
    audio: z.string({ error: "objects[].audio 必须是字符串" }).min(1, "objects[].audio 不能为空字符串").optional(),
  },
  { error: strictObjectError("objects 条目") },
);

/**
 * import.yaml 的 zod schema（严格模式）。
 *
 * 字段一览（契约 §2 顶层字段表）：
 * - schema_version  literal(1)，必填——结构版本
 * - pack            string，必填——目标图包名（与 pack.yaml 的 name 仅作校验提示）
 * - decks           卡堆条目数组，可省略（缺省 []）——见 {@link deckEntrySchema}
 * - objects         非卡牌素材条目数组，可省略（缺省 []）——见 {@link objectEntrySchema}
 *
 * decks 与 objects 全空不在此拦（schema 层面不拦，业务层报 IMPORT_EMPTY——契约 §2 注）。
 */
export const importManifestSchema = z.strictObject(
  {
    schema_version: z.literal(1, { error: "schema_version 必须是 1" }),
    pack: z.string({ error: "pack 必须是字符串" }).min(1, "pack 不能为空字符串"),
    decks: z.array(deckEntrySchema, { error: "decks 必须是卡堆条目数组" }).default([]),
    objects: z.array(objectEntrySchema, { error: "objects 必须是素材条目数组" }).default([]),
  },
  { error: strictObjectError("import.yaml 根") },
);

/** import.yaml 校验通过后的数据结构（schema 输出类型，decks / objects 缺省已填充为 []） */
export type ImportManifest = z.infer<typeof importManifestSchema>;

// ---------------------------------------------------------------------------
// 公开类型（ImportResult 结构化返回，契约 §6.4：不依赖 stdout 文案）
// ---------------------------------------------------------------------------

/** importAssets 的入参 */
export interface ImportOptions {
  /** 图包工作区根目录（落盘目标必须在其内；绝对 / 相对均可，内部会 resolve） */
  root: string;
  /** import.yaml 清单文件路径（相对路径以其所在目录为源路径解析基准） */
  manifestPath: string;
  /** 只规划不落盘（默认 false）；校验与返回结构与实落盘完全一致 */
  dryRun?: boolean;
}

/** 一份待复制（或已复制）的素材文件：源 → 目标（均为绝对路径） */
export interface ImportFilePlan {
  /** 源文件绝对路径 */
  source: string;
  /** 工作区内目标文件绝对路径 */
  dest: string;
}

/** 单张图集（sheet）的落位摘要 */
export interface ImportSheetSummary {
  /** 图集编号（1 基） */
  sheetId: number;
  /** 该图集列数 */
  cols: number;
  /** 该图集行数 */
  rows: number;
  /** 该图集容纳的卡数 */
  cardCount: number;
}

/** 单个卡堆的归位结果 */
export interface DeckImportResult {
  /** 清单里声明的卡堆名 */
  name: string;
  /** 清单里声明的 GUID（未声明则缺省） */
  guid?: string;
  /** deck 目录绝对路径（<root>/decks/<净化名>/） */
  deckDir: string;
  /** cards.csv 绝对路径 */
  cardsCsvPath: string;
  /** cards.csv 导入前是否已存在（true = 更新，false = 新建） */
  cardsCsvExisted: boolean;
  /** 本次新增的卡数（face 未在已有 cards.csv 中出现的卡） */
  addedCards: number;
  /** 合并后的完整卡牌行（与落盘的 cards.csv 内容一致，按写出顺序） */
  cards: CardRow[];
  /** 按图集汇总的落位摘要（sheetId 升序） */
  sheets: ImportSheetSummary[];
  /** 本次复制（或 dry-run 下将复制）的文件清单 */
  copiedFiles: ImportFilePlan[];
  /** cards_dir 里被跳过的非图片文件 / 孤儿背面文件（文件名列表） */
  skippedFiles: string[];
}

/** 单个非卡牌素材的归位结果 */
export interface ObjectImportResult {
  /** 清单里声明的素材类型（开放集合原样保留） */
  type: string;
  /** 清单里声明的素材名 */
  name: string;
  /** 素材的 asset_id（已有行永不改变；新行按 (type,name) 哈希派生） */
  assetId: string;
  /** asset_id 是否复用自已有台账行（true = 更新，false = 新建） */
  assetIdExisted: boolean;
  /** 素材目录绝对路径（<root>/objects/<type>s/<name>/） */
  dir: string;
  /** 本次复制（或 dry-run 下将复制）的文件清单 */
  copiedFiles: ImportFilePlan[];
}

/** importAssets 的结构化返回 */
export interface ImportResult {
  /** 是否 dry-run（true 时 copiedFiles 是"将复制"的计划） */
  dryRun: boolean;
  /** resolve 后的工作区根目录（绝对路径） */
  root: string;
  /** resolve 后的清单文件路径（绝对路径） */
  manifestPath: string;
  /** 卡堆归位结果（按清单顺序） */
  decks: DeckImportResult[];
  /** 非卡牌素材归位结果（按清单顺序） */
  objects: ObjectImportResult[];
  /** objects.csv 绝对路径；清单没有任何 objects 条目时为 null（不触碰台账） */
  objectsCsvPath: string | null;
  /** 非致命提示（包名不一致、未注册类型、跳过的文件等；文案走 t()） */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 内部工具（与 packyaml.ts / cards.ts 的同名内部函数一致；模块私有无法复用）
// ---------------------------------------------------------------------------

/**
 * 将 zod 校验错误格式化为单行中文可读摘要。
 * @param error zod 校验错误对象
 * @returns 形如 "decks.0.cards_dir：不能为空字符串" 的描述，多个问题以"；"连接
 */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const segments = issue.path.map((seg) => (typeof seg === "symbol" ? seg.toString() : String(seg)));
      const where = segments.length > 0 ? segments.join(".") : "(根)";
      return `${where}：${issue.message}`;
    })
    .join("；");
}

/**
 * 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT），避免 any。
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
 * 从 unknown 错误中取人类可读描述。
 * @param err 任意抛出值
 * @returns Error 取 message，其余用 String() 兜底
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 计算文本的 sha256 十六进制摘要前缀。
 * @param text 待哈希文本（utf8）
 * @param length 截取的十六进制字符数
 * @returns 小写十六进制字符串
 */
function shortSha256(text: string, length: number): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, length);
}

/**
 * 去掉文件名里的扩展名（保留路径主干；extname 含点）。
 * @param filename 文件名
 * @returns 不含扩展名的文件名主干
 */
function stripExtension(filename: string): string {
  const ext = path.extname(filename);
  return filename.slice(0, filename.length - ext.length);
}

/**
 * 把"清单里声明的目录 + 文件名"拼成斜杠形式的溯源引用（sheet_source 用）。
 * @param dirRaw 清单里声明的目录原文（可能带 ./ 前缀或结尾斜杠）
 * @param basename 文件名
 * @returns 形如 "./新卡图/001_正面.png" 的引用串（与机器无关，git diff 友好）
 */
function sourceReference(dirRaw: string, basename: string): string {
  const trimmed = dirRaw.replace(/[\\/]+$/, "");
  return `${trimmed}/${basename}`;
}

/**
 * 断言目标路径落在工作区根之内（契约 §6.1：落盘目标统一在工作区内）。
 * 目标目录名都经过 sanitizeName 净化，正常输入恒通过；此检查是防御性兜底。
 * @param rootAbs resolve 后的工作区根
 * @param dest 候选目标路径
 * @throws PackError code="IMPORT_INVALID" 目标越出工作区根时
 */
function assertInsideRoot(rootAbs: string, dest: string): void {
  const rel = path.relative(rootAbs, dest);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PackError("IMPORT_INVALID", t("error.pack.importDestOutsideRoot", { path: dest }));
  }
}

/**
 * 断言源文件存在且是普通文件（存在性校验统一入口）。
 * @param abs 源文件绝对路径
 * @throws PackError code="IMPORT_FILE_MISSING" 不存在 / IO 错误 / 不是普通文件时
 */
async function assertSourceFile(abs: string): Promise<void> {
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new PackError("IMPORT_FILE_MISSING", t("error.pack.importFileMissing", { path: abs }));
  }
  if (!info.isFile()) {
    throw new PackError("IMPORT_FILE_MISSING", t("error.pack.importFileMissing", { path: abs }));
  }
}

/**
 * 图像校验：sharp 必须能读出正尺寸元数据，且色彩空间不得是 CMYK。
 * （CMYK 判定与 src/deck/verify.ts 的 CARD_CMYK 同一口径：space === "cmyk"。）
 * @param abs 图像文件绝对路径
 * @throws PackError code="IMPORT_INVALID" sharp 解析失败 / 尺寸缺失时
 * @throws PackError code="IMPORT_CMYK" 色彩空间是 CMYK 时
 */
async function assertImageReadable(abs: string): Promise<void> {
  let width = -1;
  let height = -1;
  let space: string | undefined;
  try {
    const meta = await sharp(abs).metadata();
    width = meta.width ?? -1;
    height = meta.height ?? -1;
    space = meta.space;
  } catch {
    throw new PackError("IMPORT_INVALID", t("error.pack.importImageUnreadable", { path: abs }));
  }
  if (width < 1 || height < 1) {
    throw new PackError("IMPORT_INVALID", t("error.pack.importImageUnreadable", { path: abs }));
  }
  if (space === "cmyk") {
    throw new PackError("IMPORT_CMYK", t("error.pack.importCmyk", { path: abs }));
  }
}

/**
 * 按卡数自动选网格（导入是逻辑布局，没有真实图集宽高比，按正方形假设推断）。
 * @param cardCount 该图集的卡数（恒 ≤ 70）
 * @returns 推断出的网格
 * @throws PackError code="IMPORT_GRID_OVERFLOW" 卡数超过 70（防御性，常规流不可达）
 */
function autoGrid(cardCount: number): GridSpec {
  try {
    return inferGrid(1, 1, cardCount);
  } catch (err) {
    if (err instanceof PackError && err.code === "ATLAS_TOO_MANY_CELLS") {
      throw new PackError(
        "IMPORT_GRID_OVERFLOW",
        t("error.pack.importGridOverflow", { cells: cardCount, maxSlots: MAX_SLOTS }),
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 清单读取
// ---------------------------------------------------------------------------

/**
 * 读取 import.yaml 并做 YAML 解析 + schema 校验。
 * @param manifestAbs 清单文件绝对路径
 * @returns 校验通过、decks / objects 缺省已填充的清单
 * @throws PackError code="IMPORT_FILE_MISSING" 清单文件不存在时
 * @throws PackError code="IMPORT_READ_FAILED" 读取发生其他 IO 错误时
 * @throws PackError code="IMPORT_INVALID" 内容不是合法 YAML 或不符合 schema 时
 */
async function readImportManifest(manifestAbs: string): Promise<ImportManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestAbs, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      throw new PackError("IMPORT_FILE_MISSING", t("error.pack.importFileMissing", { path: manifestAbs }));
    }
    throw new PackError(
      "IMPORT_READ_FAILED",
      t("error.pack.importManifestReadFailed", { path: manifestAbs, detail: errMessage(err) }),
    );
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new PackError(
      "IMPORT_INVALID",
      t("error.pack.importManifestInvalidYaml", { path: manifestAbs, detail: errMessage(err) }),
    );
  }

  const parsed = importManifestSchema.safeParse(data);
  if (!parsed.success) {
    throw new PackError(
      "IMPORT_INVALID",
      t("error.pack.importManifestInvalid", { path: manifestAbs, issues: formatZodError(parsed.error) }),
    );
  }
  return parsed.data;
}

/**
 * 包名校验提示（契约 §2：pack 仅作校验提示，不强制写回）。
 * @param rootAbs resolve 后的工作区根
 * @param manifestPack 清单里声明的 pack 名
 * @param warnings 收集器（原地追加）
 * @throws PackError root 下 pack.yaml 存在但损坏（PACK_INVALID / PACK_READ_FAILED）时
 *   原样透传——工作区元数据损坏应先修复，导入不应静默继续
 */
async function checkPackName(rootAbs: string, manifestPack: string, warnings: string[]): Promise<void> {
  let pack;
  try {
    pack = await readPackYaml(rootAbs);
  } catch (err) {
    if (err instanceof PackError && err.code === "PACK_NOT_FOUND") {
      warnings.push(t("import.warning.packYamlMissing", { root: rootAbs }));
      return;
    }
    throw err;
  }
  if (pack.name !== manifestPack) {
    warnings.push(
      t("import.warning.packNameMismatch", { manifestPack, packName: pack.name }),
    );
  }
}

// ---------------------------------------------------------------------------
// 卡堆条目规划
// ---------------------------------------------------------------------------

/** cards_dir 清点结果（图片按文件名码元序） */
interface CardsDirListing {
  /** 正面候选（unique 模式下不含 _背面 文件；common/none 模式下是全部图片） */
  faces: string[];
  /** unique 模式的背面索引：前缀（去掉 _背面 后的主干）→ 文件名 */
  backsByPrefix: Map<string, string>;
  /** 被跳过的非图片文件 / 子目录（文件名列表，告警用） */
  skipped: string[];
}

/**
 * 清点 cards_dir：挑出图片文件、按文件名排序；unique 模式额外把 *_背面 文件
 * 归入背面索引。子目录与非图片文件进 skipped（不静默丢弃）。
 * @param dirAbs cards_dir 绝对路径
 * @param unique 是否处于 back=unique 模式
 * @returns 清点结果
 * @throws PackError code="IMPORT_FILE_MISSING" 目录不存在 / 不可读 / 不是目录时
 */
async function listCardsDir(dirAbs: string, unique: boolean): Promise<CardsDirListing> {
  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    throw new PackError("IMPORT_FILE_MISSING", t("error.pack.importFileMissing", { path: dirAbs }));
  }

  const skipped: string[] = [];
  const imageFiles: string[] = [];
  for (const entry of entries) {
    const isImage = entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
    if (isImage) {
      imageFiles.push(entry.name);
    } else {
      skipped.push(entry.name);
    }
  }
  imageFiles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // 码元序，确定性

  const faces: string[] = [];
  const backsByPrefix = new Map<string, string>();
  for (const name of imageFiles) {
    const stem = stripExtension(name);
    if (unique && stem.endsWith(BACK_SUFFIX)) {
      backsByPrefix.set(stem.slice(0, stem.length - BACK_SUFFIX.length), name);
    } else {
      faces.push(name);
    }
  }
  return { faces, backsByPrefix, skipped };
}

/** 单个卡堆条目的落盘计划（校验全部通过后生成） */
interface DeckPlan {
  entry: ImportManifest["decks"][number];
  /** 净化后的目录名 */
  dirName: string;
  deckDir: string;
  copiedFiles: ImportFilePlan[];
  skippedFiles: string[];
  /** 合并后的完整卡牌行（已有行 + 新增行） */
  rows: CardRow[];
  addedCards: number;
  cardsCsvExisted: boolean;
}

/**
 * 规划单个卡堆条目：清点 cards_dir → 配对背面 → 校验源文件与图像 → 读已有
 * cards.csv → 分配 card_id / sheet_id / slot → 生成行与复制计划。
 *
 * @param entry 清单条目（schema 已校验；back 业务规则已在调用方检查）
 * @param baseDir 清单所在目录（相对路径解析基准）
 * @param rootAbs resolve 后的工作区根
 * @returns 落盘计划
 * @throws PackError code 见模块头注释（IMPORT_FILE_MISSING / IMPORT_INVALID /
 *   IMPORT_CMYK / IMPORT_GRID_OVERFLOW，以及已有 cards.csv 损坏时透传 CARDS_*）
 */
async function planDeckEntry(
  entry: ImportManifest["decks"][number],
  baseDir: string,
  rootAbs: string,
): Promise<DeckPlan> {
  const dirName = sanitizeName(entry.name);
  const deckDir = path.resolve(decksDir(rootAbs), dirName);
  assertInsideRoot(rootAbs, deckDir);

  const unique = entry.back === "unique";
  const listing = await listCardsDir(path.resolve(baseDir, entry.cards_dir), unique);
  if (listing.faces.length === 0) {
    throw new PackError(
      "IMPORT_INVALID",
      t("error.pack.importCardsDirEmpty", { deck: entry.name, path: path.resolve(baseDir, entry.cards_dir) }),
    );
  }

  // ── 背面解析 ──────────────────────────────────────────────────────────
  let backBasename: string | undefined; // common 模式：写入每张新卡 back 列的文件名
  const skipped = [...listing.skipped];
  const copiedFiles: ImportFilePlan[] = [];

  if (entry.back === "common") {
    // back_file 必填已在业务校验阶段保证（schema 之外的条件必填）
    const backFileRaw = entry.back_file as string;
    const backAbs = path.resolve(baseDir, backFileRaw);
    backBasename = path.basename(backAbs);
    if (listing.faces.some((face) => face === backBasename)) {
      throw new PackError(
        "IMPORT_INVALID",
        t("error.pack.importNameCollision", { deck: entry.name, file: backBasename ?? "" }),
      );
    }
  }

  // 正面 → 背面配对（unique 模式）：序号_正面.ext ↔ 序号_背面.ext；
  // 正面不带 _正面 后缀时按"同名_背面.ext"找
  const backForFace = new Map<string, string>();
  if (unique) {
    const usedPrefixes = new Set<string>();
    for (const face of listing.faces) {
      const ext = path.extname(face);
      const stem = stripExtension(face);
      const prefix = stem.endsWith(FACE_SUFFIX) ? stem.slice(0, stem.length - FACE_SUFFIX.length) : stem;
      const backName = listing.backsByPrefix.get(prefix);
      if (backName === undefined) {
        const expected = path.resolve(path.resolve(baseDir, entry.cards_dir), `${prefix}${BACK_SUFFIX}${ext}`);
        throw new PackError("IMPORT_FILE_MISSING", t("error.pack.importFileMissing", { path: expected }));
      }
      backForFace.set(face, backName);
      usedPrefixes.add(prefix);
    }
    for (const [prefix, backName] of listing.backsByPrefix) {
      if (!usedPrefixes.has(prefix)) {
        skipped.push(backName); // 孤儿背面：找不到配对正面，不导入（有告警，不静默）
      }
    }
  }

  // ── 源文件存在性 + 图像校验（正面 → 背面 → 共用背面）──────────────────
  const cardsDirAbs = path.resolve(baseDir, entry.cards_dir);
  for (const face of listing.faces) {
    const abs = path.join(cardsDirAbs, face);
    await assertSourceFile(abs);
    await assertImageReadable(abs);
  }
  if (unique) {
    for (const backName of backForFace.values()) {
      const abs = path.join(cardsDirAbs, backName);
      await assertSourceFile(abs);
      await assertImageReadable(abs);
    }
  }
  if (entry.back === "common") {
    const abs = path.resolve(baseDir, entry.back_file as string);
    await assertSourceFile(abs);
    await assertImageReadable(abs);
  }

  // ── 复制计划（face 与 back 的落盘文件名 = 源文件名）───────────────────
  for (const face of listing.faces) {
    copiedFiles.push({ source: path.join(cardsDirAbs, face), dest: path.join(deckDir, face) });
  }
  if (unique) {
    for (const backName of new Set(backForFace.values())) {
      copiedFiles.push({ source: path.join(cardsDirAbs, backName), dest: path.join(deckDir, backName) });
    }
  } else if (entry.back === "common") {
    const backAbs = path.resolve(baseDir, entry.back_file as string);
    copiedFiles.push({ source: backAbs, dest: path.join(deckDir, path.basename(backAbs)) });
  }

  // ── 读已有 cards.csv（损坏则 CARDS_* 原样透传）→ 分配新卡 ─────────────
  let existing: CardRow[] = [];
  let cardsCsvExisted = false;
  try {
    existing = await readCardsCsv(deckDir);
    cardsCsvExisted = true;
  } catch (err) {
    if (!(err instanceof PackError && err.code === "CARDS_NOT_FOUND")) {
      throw err;
    }
  }

  const existingFaces = new Set(existing.map((row) => row.face));
  const newFaces = listing.faces.filter((face) => !existingFaces.has(face));
  const maxKey = existing.reduce((acc, row) => Math.max(acc, Number(cardIdToKey(row.cardId))), 0);
  const maxSheetId = existing.reduce((acc, row) => Math.max(acc, row.sheetId), 0);

  // 单张图集容量：显式网格取 cols×rows，否则用 TTS 硬上限 70
  const capacity = entry.grid !== undefined ? entry.grid.cols * entry.grid.rows : MAX_SLOTS;
  const newRows: CardRow[] = [];
  for (let offset = 0; offset * capacity < newFaces.length; offset++) {
    const chunk = newFaces.slice(offset * capacity, (offset + 1) * capacity);
    const sheetId = maxSheetId + 1 + offset;
    const key = maxKey + 1 + offset;
    const grid: GridSpec =
      entry.grid !== undefined ? { columns: entry.grid.cols, rows: entry.grid.rows } : autoGrid(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      const face = chunk[i] as string;
      const slot = i + 1; // 图集内 1 基独立编号
      const row: CardRow = {
        cardId: slotToCardId(key, slot),
        face,
        sheetId,
        slot,
        sheetCols: grid.columns,
        sheetRows: grid.rows,
        sheetSource: sourceReference(entry.cards_dir, face),
      };
      const back =
        entry.back === "common"
          ? backBasename
          : entry.back === "unique"
            ? backForFace.get(face)
            : undefined;
      if (back !== undefined) {
        row.back = back;
      }
      newRows.push(row);
    }
  }

  const rows = [...existing, ...newRows];
  return {
    entry,
    dirName,
    deckDir,
    copiedFiles,
    skippedFiles: skipped,
    rows,
    addedCards: newRows.length,
    cardsCsvExisted,
  };
}

// ---------------------------------------------------------------------------
// 对象条目规划
// ---------------------------------------------------------------------------

/** 单个对象条目的落盘计划（校验全部通过后生成） */
interface ObjectPlan {
  entry: ImportManifest["objects"][number];
  dir: string;
  copiedFiles: ImportFilePlan[];
  /** 合并进台账的行（新行或对已有行的就地更新版） */
  row: ObjectRow;
  assetIdExisted: boolean;
}

/**
 * 规划单个对象条目：按类型校验必填文件字段 → 选主文件 → 校验源文件存在性
 * （图像类再过 sharp + CMYK）→ 查重 asset_id → 生成（或更新）台账行与复制计划。
 *
 * @param entry 清单条目（schema 已校验）
 * @param baseDir 清单所在目录（相对路径解析基准）
 * @param rootAbs resolve 后的工作区根
 * @param existingRows 已有台账行（查身份与 asset_id 占用）
 * @param warnings 收集器（未注册类型 / 未能映射的文件字段）
 * @returns 落盘计划
 * @throws PackError code 见模块头注释（IMPORT_INVALID / IMPORT_FILE_MISSING / IMPORT_CMYK）
 */
async function planObjectEntry(
  entry: ImportManifest["objects"][number],
  baseDir: string,
  rootAbs: string,
  existingRows: readonly ObjectRow[],
  warnings: string[],
): Promise<ObjectPlan> {
  // ── 按类型校验必填文件字段（开放类型不强制）────────────────────────────
  const requiredField = REQUIRED_FILE_FIELD[entry.type];
  if (requiredField !== undefined) {
    const value = (entry as unknown as Record<string, string | undefined>)[requiredField];
    if (value === undefined) {
      throw new PackError(
        "IMPORT_INVALID",
        t("error.pack.importObjectFieldRequired", { type: entry.type, field: requiredField, name: entry.name }),
      );
    }
  }

  // ── 文件字段清点（image/mesh/assetbundle/pdf/audio + diffuse）─────────
  const fieldValues = new Map<string, string>();
  for (const field of [...OBJECT_FILE_FIELDS, "diffuse"] as const) {
    const value = (entry as unknown as Record<string, string | undefined>)[field];
    if (value !== undefined) {
      fieldValues.set(field, value);
    }
  }
  if (!OBJECT_FILE_FIELDS.some((field) => fieldValues.has(field))) {
    throw new PackError(
      "IMPORT_INVALID",
      t("error.pack.importObjectNoFiles", { type: entry.type, name: entry.name }),
    );
  }

  // 落盘文件名 = 源文件名；同一条目内文件名不得互相冲突
  const basenames = new Set<string>();
  for (const raw of fieldValues.values()) {
    const basename = path.basename(path.resolve(baseDir, raw));
    if (basenames.has(basename)) {
      throw new PackError(
        "IMPORT_INVALID",
        t("error.pack.importObjectFileCollision", { name: entry.name, file: basename }),
      );
    }
    basenames.add(basename);
  }

  // ── 源文件存在性 + 图像校验（image / diffuse 是图像）──────────────────
  for (const [field, raw] of fieldValues) {
    const abs = path.resolve(baseDir, raw);
    await assertSourceFile(abs);
    if (field === "image" || field === "diffuse") {
      await assertImageReadable(abs);
    }
  }

  // ── 主文件 / 次文件映射 ───────────────────────────────────────────────
  const required = REQUIRED_FILE_FIELD[entry.type];
  const primaryField = required !== undefined ? required : PRIMARY_FIELD_PRIORITY.find((f) => fieldValues.has(f));
  if (primaryField === undefined) {
    // 上一段已保证至少一个文件字段存在，此处不可达；防御性兜底
    throw new PackError(
      "IMPORT_INVALID",
      t("error.pack.importObjectNoFiles", { type: entry.type, name: entry.name }),
    );
  }
  const primaryRaw = fieldValues.get(primaryField) as string;
  const leftoverFields = PRIMARY_FIELD_PRIORITY.filter((f) => f !== primaryField && fieldValues.has(f));
  const secondaryField = leftoverFields[0];
  const unmappedFields = leftoverFields.slice(1);
  for (const field of unmappedFields) {
    warnings.push(t("import.warning.unmappedObjectFile", { name: entry.name, field }));
  }

  // ── 落盘目录与复制计划 ────────────────────────────────────────────────
  const dirName = sanitizeName(entry.name);
  const typeDir = `${sanitizeName(entry.type)}s`; // 契约 §4：objects/<type>s/<name>/
  const dir = path.resolve(objectsDir(rootAbs), typeDir, dirName);
  assertInsideRoot(rootAbs, dir);
  const copiedFiles: ImportFilePlan[] = [];
  for (const raw of fieldValues.values()) {
    const source = path.resolve(baseDir, raw);
    copiedFiles.push({ source, dest: path.join(dir, path.basename(source)) });
  }

  // ── 台账行：身份 = (type, name)；asset_id 永不改变 ────────────────────
  const existingRow = existingRows.find((row) => row.type === entry.type && row.name === entry.name);
  const fileRef = `objects/${typeDir}/${dirName}/${path.basename(path.resolve(baseDir, primaryRaw))}`;
  const source = primaryRaw; // 溯源：清单里声明的原始路径
  // 窗口 C 主窗口裁决（2026-10-05）：导入不写 origin_asset_id（该列 = 从别的图包
  // 复制来时的原始 asset_id，由 copy 流程写入，不做哈希计算），与 objects.csv §12.2 对齐。

  if (existingRow !== undefined) {
    const row: ObjectRow = {
      ...existingRow,
      file: fileRef,
      source,
    };
    if (secondaryField !== undefined) {
      const raw = fieldValues.get(secondaryField);
      if (raw !== undefined) {
        row.fileSecondary = `objects/${typeDir}/${dirName}/${path.basename(path.resolve(baseDir, raw))}`;
      }
    } else {
      delete row.fileSecondary; // 本次清单未提供次要文件：导入接管该列，写空
    }
    if (fieldValues.has("diffuse")) {
      const raw = fieldValues.get("diffuse");
      if (raw !== undefined) {
        row.diffuse = `objects/${typeDir}/${dirName}/${path.basename(path.resolve(baseDir, raw))}`;
      }
    } else {
      delete row.diffuse;
    }
    return { entry, dir, copiedFiles, row, assetIdExisted: true };
  }

  // 新行：asset_id 由 (type, name) 确定性派生，撞车追加 -2 / -3 后缀
  const usedAssetIds = new Set(existingRows.map((row) => row.assetId));
  const baseId = `imp-${shortSha256(`${entry.type}\u0000${entry.name}`, 8)}`;
  let assetId = baseId;
  for (let n = 2; usedAssetIds.has(assetId); n++) {
    assetId = `${baseId}-${n}`;
  }
  const row: ObjectRow = {
    assetId,
    name: entry.name,
    type: entry.type,
    file: fileRef,
    source,
  };
  if (secondaryField !== undefined) {
    const raw = fieldValues.get(secondaryField);
    if (raw !== undefined) {
      row.fileSecondary = `objects/${typeDir}/${dirName}/${path.basename(path.resolve(baseDir, raw))}`;
    }
  }
  const diffuseRaw = fieldValues.get("diffuse");
  if (diffuseRaw !== undefined) {
    row.diffuse = `objects/${typeDir}/${dirName}/${path.basename(path.resolve(baseDir, diffuseRaw))}`;
  }
  return { entry, dir, copiedFiles, row, assetIdExisted: false };
}

// ---------------------------------------------------------------------------
// 导出主流程
// ---------------------------------------------------------------------------

/**
 * 执行素材导入：读取 import.yaml → 全量校验与规划 →（非 dry-run）复制素材
 * 文件并写 cards.csv / objects.csv → 返回结构化归位结果。
 *
 * 面向 CLI 与 agent 编程调用（契约 §6.4）：结果全部结构化，不依赖 stdout 文案；
 * 失败抛 {@link PackError}（错误码见模块头注释），按 code 分支处理。
 *
 * @param opts 入参（见 {@link ImportOptions}）
 * @returns 卡堆与对象的归位结果 + warnings
 * @throws PackError code="IMPORT_INVALID" 清单不合法 / 业务规则违规 / 图像不可读时
 * @throws PackError code="IMPORT_FILE_MISSING" 清单或任一源文件缺失时
 * @throws PackError code="IMPORT_CMYK" 任一导入图像是 CMYK 时
 * @throws PackError code="IMPORT_GRID_OVERFLOW" 单图集格数超上限（防御性）时
 * @throws PackError code="IMPORT_EMPTY" decks 与 objects 全空时
 * @throws PackError code="IMPORT_READ_FAILED" / "IMPORT_WRITE_FAILED" IO 兜底时
 * @throws PackError CARDS_* / OBJECTS_* 已有台账损坏时透传
 * @throws Error root / manifestPath 不是非空字符串时（调用方编程错误）
 */
export async function importAssets(opts: ImportOptions): Promise<ImportResult> {
  // ── 0. 入参校验（编程错误 → 普通 Error，仓库惯例）─────────────────────
  const rootRaw = opts.root;
  const manifestRaw = opts.manifestPath;
  if (typeof rootRaw !== "string" || rootRaw.trim() === "") {
    throw new Error("importAssets 入参无效：root 必须是非空字符串路径");
  }
  if (typeof manifestRaw !== "string" || manifestRaw.trim() === "") {
    throw new Error("importAssets 入参无效：manifestPath 必须是非空字符串路径");
  }
  const dryRun = opts.dryRun === true;
  const rootAbs = path.resolve(rootRaw);
  const manifestAbs = path.resolve(manifestRaw);
  const baseDir = path.dirname(manifestAbs); // 契约 §6.1：相对路径相对清单所在目录

  // ── 1. 读清单（IMPORT_FILE_MISSING / IMPORT_READ_FAILED / IMPORT_INVALID）──
  const manifest = await readImportManifest(manifestAbs);
  if (manifest.decks.length === 0 && manifest.objects.length === 0) {
    throw new PackError("IMPORT_EMPTY", t("error.pack.importEmpty"));
  }

  // ── 2. 包名校验提示（仅提示，不强制；pack.yaml 损坏则透传）────────────
  const warnings: string[] = [];
  await checkPackName(rootAbs, manifest.pack, warnings);

  // ── 3. 业务规则校验（重名 / back 组合），全部先于任何 IO ──────────────
  const seenDeckNames = new Set<string>();
  for (const entry of manifest.decks) {
    const dirName = sanitizeName(entry.name);
    if (seenDeckNames.has(dirName)) {
      throw new PackError("IMPORT_INVALID", t("error.pack.importDuplicateDeck", { name: entry.name }));
    }
    seenDeckNames.add(dirName);
    if (entry.back === "common" && entry.back_file === undefined) {
      throw new PackError("IMPORT_INVALID", t("error.pack.importBackFileRequired", { deck: entry.name }));
    }
    if (entry.back !== "common" && entry.back_file !== undefined) {
      throw new PackError(
        "IMPORT_INVALID",
        t("error.pack.importBackFileForbidden", { deck: entry.name, back: entry.back }),
      );
    }
  }
  const seenObjects = new Set<string>();
  for (const entry of manifest.objects) {
    const key = `${sanitizeName(entry.type)}/${sanitizeName(entry.name)}`;
    if (seenObjects.has(key)) {
      throw new PackError(
        "IMPORT_INVALID",
        t("error.pack.importDuplicateObject", { type: entry.type, name: entry.name }),
      );
    }
    seenObjects.add(key);
  }

  // ── 4. 规划（存在性 → 图像 → 行分配；任何失败都不落盘）────────────────
  const deckPlans: DeckPlan[] = [];
  for (const entry of manifest.decks) {
    const plan = await planDeckEntry(entry, baseDir, rootAbs);
    deckPlans.push(plan);
    if (plan.skippedFiles.length > 0) {
      warnings.push(
        t("import.warning.skippedFiles", { deck: entry.name, files: plan.skippedFiles.join("、") }),
      );
    }
  }

  // objects.csv 读取一次（损坏则 OBJECTS_* 原样透传）；没有 objects 条目则不触碰
  let existingObjectRows: ObjectRow[] = [];
  if (manifest.objects.length > 0) {
    try {
      existingObjectRows = await readObjectsCsv(objectsDir(rootAbs));
    } catch (err) {
      if (!(err instanceof PackError && err.code === "OBJECTS_NOT_FOUND")) {
        throw err;
      }
    }
  }

  const objectPlans: ObjectPlan[] = [];
  for (const entry of manifest.objects) {
    const registry = createRegistry();
    if (registry.get(entry.type) === undefined) {
      warnings.push(t("import.warning.unregisteredType", { type: entry.type, name: entry.name }));
    }
    const plan = await planObjectEntry(entry, baseDir, rootAbs, existingObjectRows, warnings);
    objectPlans.push(plan);
  }

  // 合并台账行：已有行按原位置就地更新，新行追加在尾部
  const mergedObjectRows: ObjectRow[] = existingObjectRows.map((row) => ({ ...row }));
  const rowIndexByName = new Map<string, number>();
  mergedObjectRows.forEach((row, index) => {
    rowIndexByName.set(`${row.type}\u0000${row.name ?? ""}`, index);
  });
  for (const plan of objectPlans) {
    const key = `${plan.entry.type}\u0000${plan.entry.name}`;
    const index = rowIndexByName.get(key);
    if (index !== undefined) {
      mergedObjectRows[index] = plan.row;
    } else {
      rowIndexByName.set(key, mergedObjectRows.length);
      mergedObjectRows.push(plan.row);
    }
  }

  // ── 5. 落盘（素材文件 → cards.csv → objects.csv；dry-run 跳过）─────────
  if (!dryRun) {
    for (const plan of [...deckPlans, ...objectPlans]) {
      for (const file of plan.copiedFiles) {
        try {
          await mkdir(path.dirname(file.dest), { recursive: true });
          await copyFile(file.source, file.dest);
        } catch (err) {
          throw new PackError(
            "IMPORT_WRITE_FAILED",
            t("error.pack.importWriteFailed", { path: file.dest, detail: errMessage(err) }),
          );
        }
      }
    }
    for (const plan of deckPlans) {
      await writeCardsCsv(plan.deckDir, plan.rows);
    }
    if (objectPlans.length > 0) {
      await writeObjectsCsv(objectsDir(rootAbs), mergedObjectRows);
    }
  }

  // ── 6. 组装结构化结果 ──────────────────────────────────────────────────
  const deckResults: DeckImportResult[] = deckPlans.map((plan) => {
    const sheetMap = new Map<number, ImportSheetSummary>();
    for (const row of plan.rows) {
      const summary = sheetMap.get(row.sheetId);
      if (summary === undefined) {
        sheetMap.set(row.sheetId, {
          sheetId: row.sheetId,
          cols: row.sheetCols,
          rows: row.sheetRows,
          cardCount: 1,
        });
      } else {
        summary.cardCount += 1;
      }
    }
    const sheets = [...sheetMap.values()].sort((a, b) => a.sheetId - b.sheetId);
    const result: DeckImportResult = {
      name: plan.entry.name,
      deckDir: plan.deckDir,
      cardsCsvPath: path.join(plan.deckDir, CARDS_CSV_FILENAME),
      cardsCsvExisted: plan.cardsCsvExisted,
      addedCards: plan.addedCards,
      cards: plan.rows,
      sheets,
      copiedFiles: plan.copiedFiles,
      skippedFiles: plan.skippedFiles,
    };
    if (plan.entry.guid !== undefined) {
      result.guid = plan.entry.guid;
    }
    return result;
  });

  return {
    dryRun,
    root: rootAbs,
    manifestPath: manifestAbs,
    decks: deckResults,
    objects: objectPlans.map((plan) => ({
      type: plan.entry.type,
      name: plan.entry.name,
      assetId: plan.row.assetId,
      assetIdExisted: plan.assetIdExisted,
      dir: plan.dir,
      copiedFiles: plan.copiedFiles,
    })),
    objectsCsvPath:
      objectPlans.length > 0 ? objectsCsvPath(objectsDir(rootAbs)) : null,
    warnings,
  };
}

/*
 * ── origin_asset_id 裁决说明（窗口 C 主窗口，2026-10-05）────────────────────
 * objects.csv 契约 §12.2 把 origin_asset_id 定义为"从别的图包复制来时的原始
 * asset_id，不做哈希计算"（溯源）；import.yaml 契约 §4 初版误写为"来源 URL 哈希"，
 * 两者矛盾。主窗口裁决：以被冻结的 objects.csv 契约为准，修正 import.yaml §4，
 * 本模块**不写 origin_asset_id**（已有行的旧值经 ...existingRow 展开原样保留，
 * copy 流程需要时由该流程自行写入）。实现上已删除 planObjectEntry 里的
 * originAssetId 一行，注释留存备查。
 */
