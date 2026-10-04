// src/deck/objects.ts
/**
 * objects.csv：非卡牌素材（objects/）台账的读写与校验（方案设计 §5.9，用户已确认）。
 *
 * 与 cards.csv 同构（UTF-8 BOM + LF + 写时 trailing newline；RFC 4180 风格转义），
 * 但**没有图集概念**——以 `source`（源 URL 或本地路径，追溯用）替代 cards.csv
 * 的 `sheet_source`。列定义（严格按此顺序，共 11 列）：
 *
 * ```
 * asset_id,name,type,file,file_secondary,diffuse,normal,collider,source,origin_asset_id,origin_pack
 * ```
 *
 * 职责：
 * - {@link ObjectRow}：一行素材台账的结构化形式（可选字段空字符串 → undefined）；
 * - {@link readObjectsCsv}：读 `<root>/objects.csv`（root 由调用方决定，通常为
 *   图包根或 objects/ 目录）→ 解析 + 逐行校验 → ObjectRow[]；
 * - {@link writeObjectsCsv}：写前校验（字段必须是字符串、必填非空、asset_id 唯一）→
 *   转义序列化 → BOM + LF + trailing newline 落盘，父目录不存在时自动创建。
 *
 * 错误码（{@link PackError.code}）：
 * - "OBJECTS_NOT_FOUND"     台账文件不存在
 * - "OBJECTS_READ_FAILED"   读取时的其他 IO 错误（如路径是目录、权限不足）
 * - "OBJECTS_INVALID"       表头不符 / 数据行列数不符 / 必填列为空 / 字段不是字符串
 * - "OBJECTS_DUPLICATE_ID"  asset_id 重复（读、写两条路径都会检查）
 * - "OBJECTS_WRITE_FAILED"  写入时的 IO 错误
 *
 * 本模块新增的 i18n 键（locales/*.json 待后续 Run 补齐；缺键时 t() 原样输出键名）：
 * - `error.objects.notFound` {path}
 * - `error.objects.readFailed` {path} {detail}
 * - `error.objects.invalid` {path} {detail}
 * - `error.objects.duplicateId` {path} {assetId}
 * - `error.objects.writeFailed` {path} {detail}
 *
 * 设计决定：
 * - **开放集合**：type 不做枚举校验（开放集合约定见 src/deck/types.ts 的
 *   ASSET_TYPES），未知类型字符串原样保留、不报错、不告警（告警由调用方按需触发）；
 * - **parser 暂置本模块**：cards.ts 尚未动工，按契约先在这里实现 CSV parser；
 *   cards.ts 动工时**必须**把 parser 抽到 src/deck/csv.ts 共用（单一实现防漂移），
 *   本模块届时改为 import——不要留下两份实现；
 * - 转义按 RFC 4180：字段含逗号 / 双引号 / CR / LF 时整体加引号，内部双引号翻倍；
 *   读取宽容：接受 UTF-8 BOM、CRLF 换行、缺 trailing newline、未加引号字段中部的
 *   裸引号（按字面量处理）、数据行之间的空行（跳过）；
 * - **不归一、不 trim**：所有字段值原样保留（前后空格是值的一部分）；asset_id
 *   唯一性按**精确字符串相等**判断（与"GUID 读取时不做大小写归一"的 B2 约定一致，
 *   "abc" 与 "ABC" 是两个不同 asset_id）；必填字段的"空"严格指空字符串 `""`，
 *   空白字符 `" "` 不算空。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 非卡牌素材台账文件名（与 cards.csv 同构的 CSV） */
export const OBJECTS_CSV_FILENAME = "objects.csv";

/**
 * objects.csv 的列名（严格按契约顺序，不可增删改序）。
 * 导出供 cards.ts 抽取 parser 时对齐表头校验、CLI 列提示与测试夹具使用。
 */
export const OBJECTS_CSV_COLUMNS = [
  "asset_id", "name", "type", "file", "file_secondary", "diffuse",
  "normal", "collider", "source", "origin_asset_id", "origin_pack",
] as const;

/** 可选列对应的 ObjectRow 属性名（用于把空字段从结果对象上摘除） */
const OPTIONAL_KEYS = [
  "name", "fileSecondary", "diffuse", "normal", "collider",
  "originAssetId", "originPack",
] as const;

/** CSV 转义触发字符：字段含任一字符时整体加引号 */
const CSV_SPECIAL = /[",\r\n]/;

/** UTF-8 BOM（写出时置于文件头，读取时剥离） */
const BOM = "\uFEFF";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** objects.csv 的一行（可选字段缺省 / 空字符串时为 undefined） */
export interface ObjectRow {
  /** 素材 ID（图包内唯一，通常是 GUID 或自定义字符串；必填） */
  assetId: string;
  /** 素材显示名（可省） */
  name?: string;
  /**
   * 素材类型（必填）。开放集合：允许 {@link ASSET_TYPES}（src/deck/types.ts）
   * 之外的字符串，原样保留不丢——本模块不 import ASSET_TYPES 做校验。
   */
  type: string;
  /** 主文件路径（相对图包根；必填） */
  file: string;
  /** 次要文件（如 ImageSecondaryURL 对应的文件；可省） */
  fileSecondary?: string;
  /** 漫反射贴图（model 类型；可省） */
  diffuse?: string;
  /** 法线贴图（model 类型；可省） */
  normal?: string;
  /** 碰撞体（model 类型；可省） */
  collider?: string;
  /** 源 URL 或本地路径（追溯用；必填） */
  source: string;
  /** 原始 asset_id（从别的图包复制来时；可省） */
  originAssetId?: string;
  /** 原始图包名（从别的图包复制来时；可省） */
  originPack?: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT / EISDIR），避免 any。
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
 * 解析 CSV 文本为记录数组（RFC 4180 风格，双引号转义）。
 *
 * 语义：
 * - 字段分隔符 `,`，记录分隔符 LF 或 CRLF（宽容：兼容 Excel 存盘）；
 * - 双引号包裹的字段内允许逗号 / 换行 / 双引号（`""` 转义为字面量 `"`），
 *   内嵌换行按原样保留；
 * - 未加引号字段中部的裸引号按字面量宽容处理（不报错）；
 * - 文本末尾的换行不产生空记录（trailing newline 友好）；文本中间的空行产生
 *   单空字段记录 `[""]`，由调用方（{@link parseObjectsCsv}）跳过；
 * - 按UTF-16 码元逐字符扫描：分隔符均为 ASCII，代理对原样透传，不切割码点。
 *
 * @param text 已剥离 BOM 的 CSV 文本
 * @returns 记录数组（每条记录为字段字符串数组）
 */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === `"`) {
        if (text[i + 1] === `"`) {
          field += `"`; // "" 转义为字面量双引号
          i += 2;
        } else {
          inQuotes = false; // 收引号
          i += 1;
        }
      } else {
        field += ch; // 引号内逐字符原样保留（含换行）
        i += 1;
      }
      continue;
    }
    if (ch === `"`) {
      // 引号只应在字段开头开启；出现在未加引号字段的中部时按字面量宽容处理
      if (field === "") {
        inQuotes = true;
        i += 1;
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === ",") {
      fields.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1; // CRLF 整体消费
      fields.push(field);
      records.push(fields);
      fields = [];
      field = "";
      continue;
    }
    field += ch;
    i += 1;
  }
  // 收尾：文本不以换行结束（或缺 trailing newline）时还有最后一条记录
  if (field !== "" || fields.length > 0) {
    fields.push(field);
    records.push(fields);
  }
  return records;
}

/**
 * 序列化单个 CSV 字段：含逗号 / 双引号 / CR / LF 时整体加引号，内部双引号翻倍。
 * @param value 字段原始值
 * @returns 转义后的 CSV 字段文本
 */
function escapeCsvField(value: string): string {
  if (!CSV_SPECIAL.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, `""`)}"`;
}

/**
 * 计算台账文件完整路径。
 * @param root 台账所在目录（绝对 / 相对均可，原样拼接；由调用方决定是图包根
 *   还是 objects/ 目录）
 * @returns `<root>/objects.csv`（路径分隔符跟随平台）
 */
export function objectsCsvPath(root: string): string {
  return path.join(root, OBJECTS_CSV_FILENAME);
}

/**
 * 把一条数据记录（11 个原始字段）映射为 {@link ObjectRow} 并逐列校验。
 *
 * - 必填列（asset_id / type / file / source）为空字符串 → OBJECTS_INVALID；
 * - 可选列为空字符串 → undefined，并从结果对象上摘除该键（保持 JSON 输出干净）；
 * - 不 trim、不归一：字段值原样保留。
 *
 * @param fields 原始字段数组（长度必须已由调用方校验为 11）
 * @param rowNo 数据行号（1 基，跳过空行后计数，仅用于错误信息）
 * @param filePath 台账文件路径（仅用于错误信息）
 * @returns 结构化行对象
 */
function fieldsToObjectRow(fields: string[], rowNo: number, filePath: string): ObjectRow {
  const required = (index: number): string => {
    const value = fields[index];
    if (value === "") {
      throw new PackError(
        "OBJECTS_INVALID",
        t("error.objects.invalid", {
          path: filePath,
          detail: `第 ${rowNo} 行必填列 ${OBJECTS_CSV_COLUMNS[index]} 为空`,
        }),
      );
    }
    return value;
  };
  const optional = (index: number): string | undefined => {
    const value = fields[index];
    return value === "" ? undefined : value;
  };

  const row: ObjectRow = {
    assetId: required(0),
    name: optional(1),
    type: required(2),
    file: required(3),
    fileSecondary: optional(4),
    diffuse: optional(5),
    normal: optional(6),
    collider: optional(7),
    source: required(8),
    originAssetId: optional(9),
    originPack: optional(10),
  };
  for (const key of OPTIONAL_KEYS) {
    if (row[key] === undefined) {
      delete row[key];
    }
  }
  return row;
}

/**
 * 解析 objects.csv 文本（表头校验 + 逐行映射 + asset_id 唯一性检查）。
 *
 * @param filePath 台账文件路径（仅用于错误信息）
 * @param raw 文件原始文本（可带 UTF-8 BOM，内部剥离）
 * @returns 按文件顺序排列的结构化行
 * @throws PackError code="OBJECTS_INVALID" 文件为空 / 表头不符 / 列数不符 /
 *   必填列为空时
 * @throws PackError code="OBJECTS_DUPLICATE_ID" asset_id 重复时
 */
function parseObjectsCsv(filePath: string, raw: string): ObjectRow[] {
  const text = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
  const records = parseCsvRecords(text);

  if (records.length === 0) {
    throw new PackError(
      "OBJECTS_INVALID",
      t("error.objects.invalid", { path: filePath, detail: "文件为空（缺少表头行）" }),
    );
  }

  const expectedHeader = OBJECTS_CSV_COLUMNS.join(",");
  const actualHeader = records[0].join(",");
  if (actualHeader !== expectedHeader) {
    throw new PackError(
      "OBJECTS_INVALID",
      t("error.objects.invalid", {
        path: filePath,
        detail: `表头必须是 ${expectedHeader}，实际是 ${actualHeader}`,
      }),
    );
  }

  const rows: ObjectRow[] = [];
  const seen = new Set<string>();
  let rowNo = 0;
  for (let i = 1; i < records.length; i++) {
    const fields = records[i];
    if (fields.length === 1 && fields[0] === "") {
      continue; // 空行跳过（含末尾多余换行产生的空记录）
    }
    rowNo += 1;
    if (fields.length !== OBJECTS_CSV_COLUMNS.length) {
      throw new PackError(
        "OBJECTS_INVALID",
        t("error.objects.invalid", {
          path: filePath,
          detail: `第 ${rowNo} 行应为 ${OBJECTS_CSV_COLUMNS.length} 列，实际 ${fields.length} 列`,
        }),
      );
    }
    const row = fieldsToObjectRow(fields, rowNo, filePath);
    if (seen.has(row.assetId)) {
      throw new PackError(
        "OBJECTS_DUPLICATE_ID",
        t("error.objects.duplicateId", { path: filePath, assetId: row.assetId }),
      );
    }
    seen.add(row.assetId);
    rows.push(row);
  }
  return rows;
}

/**
 * 把一行结构化数据序列化为 11 个 CSV 字段，并做写前校验。
 *
 * @param row 待写出的结构化行
 * @param rowLabel 行标签（如 "第 1 行"，仅用于错误信息）
 * @param filePath 目标文件路径（仅用于错误信息）
 * @returns 与 {@link OBJECTS_CSV_COLUMNS} 顺序一致的原始字段数组
 * @throws PackError code="OBJECTS_INVALID" 字段不是字符串，或必填字段为空字符串时
 */
function rowToFields(row: ObjectRow, rowLabel: string, filePath: string): string[] {
  const column = (index: number, value: unknown): string => {
    if (typeof value !== "string") {
      throw new PackError(
        "OBJECTS_INVALID",
        t("error.objects.invalid", {
          path: filePath,
          detail: `${rowLabel} 列 ${OBJECTS_CSV_COLUMNS[index]} 的值必须是字符串（收到 ${typeof value}）`,
        }),
      );
    }
    return value;
  };
  const required = (index: number, value: unknown): string => {
    const text = column(index, value);
    if (text === "") {
      throw new PackError(
        "OBJECTS_INVALID",
        t("error.objects.invalid", {
          path: filePath,
          detail: `${rowLabel} 必填列 ${OBJECTS_CSV_COLUMNS[index]} 为空`,
        }),
      );
    }
    return text;
  };

  return [
    required(0, row.assetId),
    column(1, row.name ?? ""),
    required(2, row.type),
    required(3, row.file),
    column(4, row.fileSecondary ?? ""),
    column(5, row.diffuse ?? ""),
    column(6, row.normal ?? ""),
    column(7, row.collider ?? ""),
    required(8, row.source),
    column(9, row.originAssetId ?? ""),
    column(10, row.originPack ?? ""),
  ];
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 读取并校验非卡牌素材台账 `<root>/objects.csv`。
 *
 * 读取宽容：接受 UTF-8 BOM、CRLF / LF 换行、缺 trailing newline、数据行之间的
 * 空行（跳过）。校验严格：表头必须与 {@link OBJECTS_CSV_COLUMNS} 完全一致，
 * 数据行必须恰为 11 列，必填列（asset_id / type / file / source）不得为空字符串，
 * asset_id 不得重复（精确字符串相等）。
 *
 * @param root 台账所在目录（绝对 / 相对均可）
 * @returns 按文件顺序排列的结构化行（可选字段空字符串 → 键被摘除）
 * @throws PackError code="OBJECTS_NOT_FOUND" 文件不存在时
 * @throws PackError code="OBJECTS_READ_FAILED" 读取时发生其他 IO 错误时
 * @throws PackError code="OBJECTS_INVALID" 文件为空 / 表头不符 / 列数不符 /
 *   必填列为空时
 * @throws PackError code="OBJECTS_DUPLICATE_ID" asset_id 重复时
 */
export async function readObjectsCsv(root: string): Promise<ObjectRow[]> {
  const filePath = objectsCsvPath(root);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      throw new PackError("OBJECTS_NOT_FOUND", t("error.objects.notFound", { path: filePath }));
    }
    throw new PackError(
      "OBJECTS_READ_FAILED",
      t("error.objects.readFailed", { path: filePath, detail: errMessage(err) }),
    );
  }
  return parseObjectsCsv(filePath, raw);
}

/**
 * 把非卡牌素材台账写入 `<root>/objects.csv`。
 *
 * 写前校验（不过则绝不落盘）：每个字段必须是字符串（null / undefined 的可选
 * 字段视为空字符串）、必填字段（asset_id / type / file / source）不得为空字符串、
 * asset_id 不得重复。编码与格式：UTF-8 BOM + LF 换行 + 末尾恰一个 trailing
 * newline；字段含逗号 / 双引号 / CR / LF 时按 RFC 4180 转义。父目录不存在时
 * 自动创建。
 *
 * @param root 台账所在目录（绝对 / 相对均可）
 * @param rows 待写出的行（按数组顺序落盘）
 * @throws PackError code="OBJECTS_INVALID" 字段不是字符串或必填字段为空时
 * @throws PackError code="OBJECTS_DUPLICATE_ID" asset_id 重复时
 * @throws PackError code="OBJECTS_WRITE_FAILED" 写文件发生 IO 错误时
 */
export async function writeObjectsCsv(root: string, rows: ObjectRow[]): Promise<void> {
  const filePath = objectsCsvPath(root);

  // 先完整校验并序列化（任何一行不过都不落盘），再做 IO
  const recordLines: string[] = [OBJECTS_CSV_COLUMNS.join(",")];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const fields = rowToFields(rows[i], `第 ${i + 1} 行`, filePath);
    if (seen.has(fields[0])) {
      throw new PackError(
        "OBJECTS_DUPLICATE_ID",
        t("error.objects.duplicateId", { path: filePath, assetId: fields[0] }),
      );
    }
    seen.add(fields[0]);
    recordLines.push(fields.map(escapeCsvField).join(","));
  }
  const text = `${BOM}${recordLines.join("\n")}\n`;

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, text, "utf8");
  } catch (err) {
    throw new PackError(
      "OBJECTS_WRITE_FAILED",
      t("error.objects.writeFailed", { path: filePath, detail: errMessage(err) }),
    );
  }
}
