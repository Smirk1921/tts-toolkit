// src/deck/cards.ts
/**
 * cards.csv：卡牌明细（每个 deck 目录一份，B2 主窗口裁决的唯一明细源）。
 *
 * 职责（B1 契约修订：deck.yaml 不再包含 cards[]，卡牌明细全部由本文件承担）：
 * - {@link CardRow}：单行卡牌条目（解析后的 camelCase 视图，列顺序见下）；
 * - {@link readCardsCsv}：读取 + BOM 剥除 + LF/CRLF 兼容解析 + 全量校验，
 *   失败抛 {@link PackError}（错误码见下）；
 * - {@link writeCardsCsv}：写前全量校验（校验不过绝不落盘），UTF-8 BOM + LF 换行 +
 *   列严格按契约顺序落盘，写前确保父目录存在。
 *
 * 列（严格按此顺序，{@link CARDS_COLUMNS}）：
 * `card_id,face,back,name,nickname,sheet_id,slot,sheet_cols,sheet_rows,sheet_source`
 *
 * | 列 | 类型 | 必填 | 说明 |
 * |---|---|---|---|
 * | card_id | number | ✅ | TTS 完整 CardID（key*100+slot），主键唯一 |
 * | face | string | ✅ | 正面图片文件名（相对本 deck 目录） |
 * | back | string | 可省 | 自定义背面文件名；空 = 用牌堆默认背面 |
 * | name | string | 可省 | 卡牌显示名 |
 * | nickname | string | 可省 | TTS 的 Nickname |
 * | sheet_id | number | ✅ | 图集编号（1 基），同一 deck 多张图集时区分 |
 * | slot | number | ✅ | 图集内格子序号（1 基，== card_id % 100；若 %100==0 则 slot=100） |
 * | sheet_cols | number | ✅ | 该图集列数 |
 * | sheet_rows | number | ✅ | 该图集行数 |
 * | sheet_source | string | ✅ | 源图集 URL 或本地路径（追溯用） |
 *
 * ── 1 基裁决（与 src/deck/cardid.ts 一致，写死防回退）─────────────────────
 * slot 全程 **1 基**：slot = CardID % 100，当 %100 === 0 时按 TTS 约定表示
 * **第 100 格**（cardIdToSlot(10100) === 100，不是 0）。本模块不自己实现该换算，
 * 直接复用 cardid.ts 的 {@link cardIdToSlot}（单一实现，防两处口径漂移）；
 * slot 是否落在 [1, sheet_cols × sheet_rows] 复用 {@link isValidSlot}。
 * 注意两规则叠加的结论：图集硬上限 10×7=70 格 < 100，故 card_id 为 100 整数倍
 * 的行（slot 换算为 100）能通过 slot===%100 校验，但必然卡在容量上限
 * → CARDS_SLOT_OUT_OF_RANGE（而不是 MISMATCH）——这是 1 基规则 + 容量规则的
 * 数学必然，不是 bug，测试有专门用例守着。
 *
 * ── 编码细节（Excel + git 双友好）────────────────────────────────────────
 * - 写：开头 `\ufeff`（BOM，Excel 才能正确识别中文）+ 每行以 `\n` 结尾
 *   （**不许 \r\n**）+ 总是写 trailing newline；
 * - 读：剥掉开头 BOM（如果有）；CRLF / LF / 裸 \r 均按换行处理；
 *   末尾有/无 trailing newline 都容忍；空行（含末尾残留）跳过不报错；
 * - 转义：字段含逗号 / 双引号 / 换行符时用双引号包围，内部双引号转义为 ""；
 *   写时只对含特殊字符的字段加引号，其他保持裸（git diff 友好）。
 *   读解析器是本模块内手写的 ~35 行状态机（in_quotes / escape_next），
 *   **不引入 papaparse 等新 npm 依赖**（契约明确要求）。
 *
 * ── 校验规则（writeCardsCsv 与 readCardsCsv 都做）────────────────────────
 * 单行内（按下列顺序检查，一行同时踩多条时只抛最先命中的码）：
 * 1. card_id 必须是正整数 → 否则 CARDS_INVALID；
 * 2. sheet_id 必须是不小于 1 的整数 → 否则 CARDS_INVALID；
 * 3. sheet_cols ∈ [1,10]、sheet_rows ∈ [1,7] → 越界 CARDS_INVALID_GRID；
 * 4. slot 必须是整数且 == cardIdToSlot(card_id) → 不等 CARDS_SLOT_MISMATCH；
 * 5. slot ∈ [1, sheet_cols × sheet_rows] → 越界 CARDS_SLOT_OUT_OF_RANGE；
 * 6. face 不能为空字符串 → 否则 CARDS_INVALID；
 * 7. sheet_source 不能为空字符串 → 否则 CARDS_INVALID。
 * 跨行：
 * 8. card_id 全表唯一 → 重复 CARDS_DUPLICATE_ID；
 * 9. 同一 sheet_id 内 slot 不重复 → 重复 CARDS_DUPLICATE_SLOT
 *    （不同 sheet_id 的相同 slot 合法——每张图集各有自己的第 1 格）。
 * 结构层（仅读侧可能命中）：空文件 / 表头列名或列序不符 / 数据行列数 ≠ 10 /
 * 数值列不是整数字面量 → 一律 CARDS_INVALID。
 *
 * 实现说明：
 * - "写前过 schema"落在 {@link validateRows}：契约给每条规则指定了**独立的**
 *   PackError 错误码，zod 单个 schema 的 issue 列表无法一一对应这些码，
 *   故用手写校验器精准抛码（字段类型问题对 CSV 无意义——序列化时只取 10 列，
 *   未知属性不落盘，无需 strictObject）；
 * - 行号一律指**数据行序号**（1 基，跳过表头与空行后的第几条数据），
 *   不是文件物理行号（name 含换行时两者不等）；
 * - 可选列 back / name / nickname：读时空字符串视为 undefined（属性省略），
 *   写时 undefined 写作空字段——往返稳定；
 * - 读回的行保持文件顺序，不排序。
 *
 * 错误码（{@link PackError.code}）：
 * - "CARDS_NOT_FOUND"        cards.csv 不存在（`<deckDir>/cards.csv`）
 * - "CARDS_READ_FAILED"      读取 cards.csv 时发生"文件不存在"以外的 IO 错误
 * - "CARDS_WRITE_FAILED"     写入 cards.csv 时发生 IO 错误
 * - "CARDS_INVALID"          结构非法（空文件 / 表头不符 / 列数错误 / 数值列
 *                            非整数字面量）或单行规则违规（card_id、sheet_id、
 *                            face、sheet_source，见上表 1/2/6/7 条）
 * - "CARDS_DUPLICATE_ID"     card_id 重复
 * - "CARDS_SLOT_MISMATCH"    slot ≠ cardIdToSlot(card_id)
 * - "CARDS_SLOT_OUT_OF_RANGE" slot 超出 [1, sheet_cols × sheet_rows]
 * - "CARDS_INVALID_GRID"     sheet_cols ∉ [1,10] 或 sheet_rows ∉ [1,7]
 * - "CARDS_DUPLICATE_SLOT"   同一 sheet_id 内 slot 重复
 * （CARDS_READ_FAILED / CARDS_WRITE_FAILED 是契约未列的 IO 兜底码，
 * 与 packyaml.ts 的 PACK_READ_FAILED / PACK_WRITE_FAILED 同构，防 IO 异常裸抛。）
 *
 * 本模块新增的 i18n 键（locales/*.json 由 Run 2 补齐；缺键时 t() 原样输出键名）：
 * - `error.pack.cardsNotFound` {path}
 * - `error.pack.cardsReadFailed` {path} {detail}
 * - `error.pack.cardsWriteFailed` {path} {detail}
 * - `error.pack.cardsInvalid` {detail}
 * - `error.pack.cardsDuplicateId` {cardId} {firstRow} {dupRow}
 * - `error.pack.cardsSlotMismatch` {row} {cardId} {slot} {expected}
 * - `error.pack.cardsSlotOutOfRange` {row} {slot} {max}
 * - `error.pack.cardsInvalidGrid` {row} {sheetCols} {sheetRows}
 * - `error.pack.cardsDuplicateSlot` {sheetId} {slot} {firstRow} {dupRow}
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";

import { cardIdToSlot, isValidSlot } from "./cardid.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** cards.csv 的标准文件名（每个 deck 目录一份） */
export const CARDS_CSV_FILENAME = "cards.csv";

/** UTF-8 BOM（写出时置首；读入时剥除——Excel 依赖 BOM 识别 UTF-8 中文） */
const BOM = "\ufeff";

/** 表头列名，严格按契约顺序（写出即此顺序；读入逐列比对，多列少列换序都拒绝） */
const CARDS_COLUMNS = [
  "card_id", "face", "back", "name", "nickname",
  "sheet_id", "slot", "sheet_cols", "sheet_rows", "sheet_source",
] as const;

/** 图集列数上下限（与 manifest.ts 的 deck.atlas.columns 同口径：1..10） */
const SHEET_COLS_MIN = 1;
const SHEET_COLS_MAX = 10;

/** 图集行数上下限（与 manifest.ts 的 deck.atlas.rows 同口径：1..7） */
const SHEET_ROWS_MIN = 1;
const SHEET_ROWS_MAX = 7;

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/** 单行卡牌条目（解析后；可选字段缺省 = CSV 里的空字段） */
export interface CardRow {
  /** TTS 完整 CardID（key*100+slot，如 10121）；主键唯一，正整数 */
  cardId: number;
  /** 正面图片文件名（相对本 deck 目录），不能为空 */
  face: string;
  /** 自定义背面文件名；空 / 缺省 = 用牌堆默认背面 */
  back?: string;
  /** 卡牌显示名 */
  name?: string;
  /** TTS 的 Nickname */
  nickname?: string;
  /** 图集编号（1 基），同一 deck 多张图集时区分 */
  sheetId: number;
  /** 图集内格子序号（1 基，== card_id % 100；若 %100==0 则 slot=100） */
  slot: number;
  /** 该图集列数，∈ [1,10] */
  sheetCols: number;
  /** 该图集行数，∈ [1,7] */
  sheetRows: number;
  /** 源图集 URL 或本地路径（追溯用），不能为空 */
  sheetSource: string;
}

// ---------------------------------------------------------------------------
// 内部工具（与 packyaml.ts / manifest.ts 的同名内部函数一致）
// ---------------------------------------------------------------------------

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

/** 计算 cards.csv 的完整路径。 */
function cardsCsvPath(deckDir: string): string {
  return path.join(deckDir, CARDS_CSV_FILENAME);
}

/**
 * 构造 CARDS_INVALID 错误（结构与数值字面量类违规；detail 为中文数据部分，
 * 按仓库风格不走 t()——参见 packyaml.ts 头注释的同类决定）。
 * @param detail 具体问题中文描述
 */
function cardsInvalid(detail: string): PackError {
  return new PackError("CARDS_INVALID", t("error.pack.cardsInvalid", { detail }));
}

/**
 * 构造带数据行序号前缀的 CARDS_INVALID 错误。
 * @param rowNo 数据行序号（1 基，跳过表头与空行）
 * @param detail 具体问题中文描述
 */
function invalidRow(rowNo: number, detail: string): PackError {
  return cardsInvalid(`第 ${rowNo} 行：${detail}`);
}

// ---------------------------------------------------------------------------
// CSV 解析（手写 ~35 行状态机，不引入 papaparse 等新依赖）
// ---------------------------------------------------------------------------

/**
 * 把 CSV 文本解析为二维表（RFC 4180 风格 + 宽容处理）。
 *
 * 状态机：in_quotes 时逗号 / 换行都是普通字符，`""` 还原为一个双引号；
 * 不在引号内时逗号分列、CRLF / LF / 裸 \r 分行（CRLF 算一个换行）。
 * 文本末尾的换行不产生空尾行；末尾无换行的最后一行照常收；
 * 末尾悬挂的空字段（行以逗号结尾）保留为空串。
 * 宽容点：引号出现在字段中间（如 ab"cd）不报错，按开引号处理（Excel 不会产出，
 * 手改文件按宽松口径尽量救回）。
 *
 * @param text 已剥除 BOM 的 CSV 文本
 * @returns 二维表；空文本返回 []（调用方负责报"缺表头"）
 */
function parseCsvTable(text: string): string[][] {
  const table: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"'; // 转义的双引号 "" 还原为一个 "
          i += 1;
        } else {
          inQuotes = false; // 闭引号
        }
      } else {
        field += ch; // 引号内的逗号 / 换行 / 其他字符原样保留
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text.charAt(i + 1) === "\n") {
        i += 1; // CRLF 算一个换行
      }
      row.push(field);
      table.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    table.push(row);
  }
  return table;
}

/**
 * CSV 字段转义（写侧）：含逗号 / 双引号 / \r / \n 的字段用双引号包围、
 * 内部双引号翻倍为 ""；其他字段保持裸（git diff 友好）。
 * @param value 字段原始值
 * @returns 转义后的 CSV 字段文本
 */
function csvEscapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ---------------------------------------------------------------------------
// 校验（write 与 read 共用的单一实现）
// ---------------------------------------------------------------------------

/**
 * 单行校验（检查顺序见模块头注释"校验规则"）。
 * @param row 待校验条目
 * @param rowNo 数据行序号（1 基），仅用于错误信息定位
 * @throws PackError（code 见模块头注释）
 */
function validateRow(row: CardRow, rowNo: number): void {
  if (!Number.isInteger(row.cardId) || row.cardId <= 0) {
    throw invalidRow(rowNo, `card_id 必须是正整数（收到 ${String(row.cardId)}）`);
  }
  if (!Number.isInteger(row.sheetId) || row.sheetId < 1) {
    throw invalidRow(rowNo, `sheet_id 必须是不小于 1 的整数（收到 ${String(row.sheetId)}）`);
  }
  if (
    !Number.isInteger(row.sheetCols) || row.sheetCols < SHEET_COLS_MIN || row.sheetCols > SHEET_COLS_MAX
    || !Number.isInteger(row.sheetRows) || row.sheetRows < SHEET_ROWS_MIN || row.sheetRows > SHEET_ROWS_MAX
  ) {
    throw new PackError(
      "CARDS_INVALID_GRID",
      t("error.pack.cardsInvalidGrid", {
        row: rowNo,
        sheetCols: String(row.sheetCols),
        sheetRows: String(row.sheetRows),
      }),
    );
  }
  if (!Number.isInteger(row.slot)) {
    throw invalidRow(rowNo, `slot 必须是整数（收到 ${String(row.slot)}）`);
  }
  // 1 基裁决单一来源：slot === CardID % 100（%100===0 → 100），复用 cardid.ts
  const expectedSlot = cardIdToSlot(row.cardId);
  if (row.slot !== expectedSlot) {
    throw new PackError(
      "CARDS_SLOT_MISMATCH",
      t("error.pack.cardsSlotMismatch", {
        row: rowNo,
        cardId: row.cardId,
        slot: String(row.slot),
        expected: expectedSlot,
      }),
    );
  }
  // 容量上限：slot ∈ [1, sheet_cols × sheet_rows]，复用 cardid.ts 的判定
  if (!isValidSlot(row.slot, row.sheetCols, row.sheetRows)) {
    throw new PackError(
      "CARDS_SLOT_OUT_OF_RANGE",
      t("error.pack.cardsSlotOutOfRange", {
        row: rowNo,
        slot: row.slot,
        max: row.sheetCols * row.sheetRows,
      }),
    );
  }
  if (typeof row.face !== "string" || row.face === "") {
    throw invalidRow(rowNo, "face 不能为空字符串");
  }
  if (typeof row.sheetSource !== "string" || row.sheetSource === "") {
    throw invalidRow(rowNo, "sheet_source 不能为空字符串");
  }
}

/**
 * 全量校验（单行规则 + 跨行唯一性；writeCardsCsv 与 readCardsCsv 共用）。
 *
 * 行号 = 数组序号 + 1（1 基数据行序号）：写侧即入参数组顺序，读侧即
 * 跳过表头与空行后的文件顺序。
 *
 * @param rows 待校验条目（按展示顺序）
 * @throws PackError（code 见模块头注释）
 */
function validateRows(rows: readonly CardRow[]): void {
  const idFirstRow = new Map<number, number>();
  const sheetSlotFirstRow = new Map<string, number>();
  rows.forEach((row, index) => {
    const rowNo = index + 1;
    validateRow(row, rowNo);
    const idSeen = idFirstRow.get(row.cardId);
    if (idSeen !== undefined) {
      throw new PackError(
        "CARDS_DUPLICATE_ID",
        t("error.pack.cardsDuplicateId", { cardId: row.cardId, firstRow: idSeen, dupRow: rowNo }),
      );
    }
    idFirstRow.set(row.cardId, rowNo);
    const slotKey = `${row.sheetId}#${row.slot}`;
    const slotSeen = sheetSlotFirstRow.get(slotKey);
    if (slotSeen !== undefined) {
      throw new PackError(
        "CARDS_DUPLICATE_SLOT",
        t("error.pack.cardsDuplicateSlot", {
          sheetId: row.sheetId,
          slot: row.slot,
          firstRow: slotSeen,
          dupRow: rowNo,
        }),
      );
    }
    sheetSlotFirstRow.set(slotKey, rowNo);
  });
}

// ---------------------------------------------------------------------------
// 序列化（CardRow[] → CSV 文本）
// ---------------------------------------------------------------------------

/**
 * 把单行条目序列化为 CSV 数据行（列顺序 = CARDS_COLUMNS；可选字段缺省写空字段）。
 * @param row 待序列化条目（假定已过 validateRow）
 * @returns 一行文本（不含换行符）
 */
function serializeRow(row: CardRow): string {
  return [
    String(row.cardId),
    row.face,
    row.back ?? "",
    row.name ?? "",
    row.nickname ?? "",
    String(row.sheetId),
    String(row.slot),
    String(row.sheetCols),
    String(row.sheetRows),
    row.sheetSource,
  ].map(csvEscapeField).join(",");
}

/**
 * 把条目数组序列化为完整 CSV 文本：BOM + 表头 + 数据行，每行以 \n 结尾
 * （总 trailing newline；全程无 \r\n）。
 * @param rows 待序列化条目（假定已过 validateRows）
 * @returns 可直接落盘的文件文本
 */
function serializeCardsCsv(rows: readonly CardRow[]): string {
  const lines: string[] = [CARDS_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(serializeRow(row));
  }
  return BOM + lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 解析（CSV 文本 → CardRow[]）
// ---------------------------------------------------------------------------

/**
 * 解析单个整数字面量字段（读侧专用）：只接受纯数字（^\d+$），
 * 拒绝空串 / 负号 / 小数点 / 十六进制 / 指数形式——防 "0x1F"、"-5"、"2.1"
 * 被 Number() 静默转换；前导零宽容（"007" → 7）。
 * @param text 字段原文
 * @param label 列名（用于错误信息）
 * @param rowNo 数据行序号（1 基）
 * @returns 解析出的非负整数
 * @throws PackError code="CARDS_INVALID" 不是纯数字字面量时
 */
function parseIntCsvField(text: string, label: string, rowNo: number): number {
  if (!/^\d+$/.test(text)) {
    throw invalidRow(rowNo, `${label} 必须是整数字面量（收到 "${text}"）`);
  }
  return Number(text);
}

/**
 * 可选字符串字段：空字符串视为 undefined（属性省略），其余原样保留
 * （不 trim、不归一——文件名与显示名按字面使用）。
 * @param text 字段原文
 * @returns 非空字符串或 undefined
 */
function optionalField(text: string): string | undefined {
  return text === "" ? undefined : text;
}

/**
 * 把一行已拆分的字段组装为 CardRow（列顺序 = CARDS_COLUMNS）。
 * @param fields 已解析的字段数组（恰好 CARDS_COLUMNS.length 个）
 * @param rowNo 数据行序号（1 基）
 * @returns 卡牌条目
 * @throws PackError code="CARDS_INVALID" 数值列不是整数字面量时
 */
function rowFromFields(fields: string[], rowNo: number): CardRow {
  const row: CardRow = {
    cardId: parseIntCsvField(fields[0], "card_id", rowNo),
    face: fields[1],
    sheetId: parseIntCsvField(fields[5], "sheet_id", rowNo),
    slot: parseIntCsvField(fields[6], "slot", rowNo),
    sheetCols: parseIntCsvField(fields[7], "sheet_cols", rowNo),
    sheetRows: parseIntCsvField(fields[8], "sheet_rows", rowNo),
    sheetSource: fields[9],
  };
  const back = optionalField(fields[2]);
  const name = optionalField(fields[3]);
  const nickname = optionalField(fields[4]);
  if (back !== undefined) {
    row.back = back;
  }
  if (name !== undefined) {
    row.name = name;
  }
  if (nickname !== undefined) {
    row.nickname = nickname;
  }
  return row;
}

/**
 * 把 cards.csv 文本解析并校验为条目数组（readCardsCsv 的主体）。
 * @param text 文件原文（可能带 BOM、CRLF、trailing newline 有无皆可）
 * @returns 按文件顺序的卡牌条目
 * @throws PackError code="CARDS_INVALID" 空文件 / 表头不符 / 列数错误 /
 *   数值列非整数字面量，或任何一条校验规则违规时
 */
function parseCardsCsvText(text: string): CardRow[] {
  const stripped = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const table = parseCsvTable(stripped);
  if (table.length === 0) {
    throw cardsInvalid(`文件为空，缺少表头行（表头必须是 "${CARDS_COLUMNS.join(",")}"）`);
  }
  const header = table[0];
  const headerOk = header.length === CARDS_COLUMNS.length
    && CARDS_COLUMNS.every((column, i) => header[i] === column);
  if (!headerOk) {
    throw cardsInvalid(
      `表头必须是 "${CARDS_COLUMNS.join(",")}"（实际为 "${header.join(",")}"）`,
    );
  }

  const rows: CardRow[] = [];
  let dataRowNo = 0; // 数据行序号（1 基；空行不计）
  for (let i = 1; i < table.length; i++) {
    const fields = table[i];
    if (fields.length === 1 && fields[0] === "") {
      continue; // 空行（含末尾残留）容忍并跳过
    }
    dataRowNo += 1;
    if (fields.length !== CARDS_COLUMNS.length) {
      throw cardsInvalid(
        `第 ${dataRowNo} 行应为 ${CARDS_COLUMNS.length} 列，实际为 ${fields.length} 列`,
      );
    }
    rows.push(rowFromFields(fields, dataRowNo));
  }
  validateRows(rows);
  return rows;
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 读取并校验 `<deckDir>/cards.csv`。
 *
 * 解析前剥 BOM；CRLF / LF / 裸 \r 都按换行处理；末尾 trailing newline 有无皆可；
 * 空行跳过。读回的行保持文件顺序。
 *
 * @param deckDir deck 目录（decks/<name>/；绝对 / 相对均可）
 * @returns 按文件顺序的卡牌条目
 * @throws PackError code="CARDS_NOT_FOUND" 文件不存在时
 * @throws PackError code="CARDS_READ_FAILED" 读取时发生其他 IO 错误时
 * @throws PackError code="CARDS_INVALID" 结构非法或校验规则违规时
 * @throws PackError code="CARDS_DUPLICATE_ID" / "CARDS_SLOT_MISMATCH" /
 *   "CARDS_SLOT_OUT_OF_RANGE" / "CARDS_INVALID_GRID" / "CARDS_DUPLICATE_SLOT"
 *   对应校验规则违规时
 */
export async function readCardsCsv(deckDir: string): Promise<CardRow[]> {
  const filePath = cardsCsvPath(deckDir);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      throw new PackError("CARDS_NOT_FOUND", t("error.pack.cardsNotFound", { path: filePath }));
    }
    throw new PackError(
      "CARDS_READ_FAILED",
      t("error.pack.cardsReadFailed", { path: filePath, detail: errMessage(err) }),
    );
  }
  return parseCardsCsvText(raw);
}

/**
 * 把卡牌条目写入 `<deckDir>/cards.csv`（UTF-8 BOM + LF 换行 + 契约列顺序）。
 *
 * 写前对 rows 全量校验：**校验不过绝不落盘，也不创建目录**（防半成品文件
 * 被下游读到）。deckDir 不存在时自动逐级创建（与 writePackYaml 一致）。
 *
 * @param deckDir deck 目录（不存在时自动创建）
 * @param rows 卡牌条目（按写出顺序）
 * @throws PackError code="CARDS_INVALID" / "CARDS_DUPLICATE_ID" /
 *   "CARDS_SLOT_MISMATCH" / "CARDS_SLOT_OUT_OF_RANGE" / "CARDS_INVALID_GRID" /
 *   "CARDS_DUPLICATE_SLOT" rows 不满足校验规则时（文件保持原样）
 * @throws PackError code="CARDS_WRITE_FAILED" 写文件发生 IO 错误时
 */
export async function writeCardsCsv(deckDir: string, rows: CardRow[]): Promise<void> {
  validateRows(rows); // 写前过 schema：不过绝不落盘
  const filePath = cardsCsvPath(deckDir);
  const text = serializeCardsCsv(rows);
  try {
    await mkdir(deckDir, { recursive: true });
    await writeFile(filePath, text, "utf8");
  } catch (err) {
    throw new PackError(
      "CARDS_WRITE_FAILED",
      t("error.pack.cardsWriteFailed", { path: filePath, detail: errMessage(err) }),
    );
  }
}
