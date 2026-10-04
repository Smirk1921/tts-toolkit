// src/deck/cardid.ts
/**
 * CardID 编号规则与 1 基 slot 换算（方案设计 §5.4）。
 *
 * TTS 的 CardID 编码规则（【实测】自真实存档，见
 * 参考资料/02-数据格式/图集规格与CardID.md §3）：
 *
 * ```
 * CustomDeck 的 key = floor(CardID / 100)   （字符串形式——JSON 对象键只能是字符串）
 * CardID 的低两位   = 该图集内的格子序号（slot，1 基：从 1 开始，行优先：左→右、上→下）
 * ```
 *
 * 实例：DeckIDs [10121, 10122] → key "101"，对应格子 21、22。
 *
 * 本模块是**纯算术换算**（无 IO、无网络、无状态）：
 * - 转换函数（{@link cardIdToKey} / {@link cardIdToSlot} / {@link slotToCardId} /
 *   {@link slotToGrid} / {@link gridToSlot}）遇到非法入参直接抛**普通中文 Error**
 *   （调用方编程错误，按仓库惯例不走 PackError——PackError 是文件 / 清单错误的
 *   载体，参见 src/pack/manifest.ts 的 assertDirPath 注释）；
 * - 校验函数（{@link isValidCardId} / {@link isValidSlot}）**永不抛错**，
 *   非法入参（含 NaN / Infinity / 非数值类型）一律返回 false。
 *
 * ── 1 基裁决（主窗口 2026-10-04，写死防回退）───────────────────────────────
 * slot 全程 **1 基**：slot = CardID % 100，当 %100 === 0 时按 TTS 约定表示**第 100 格**
 * （cardIdToSlot(10100) === 100，**不是 0**）。
 * isValidCardId 的裁决：**正整数即合法**（cardId > 0 且 Number.isInteger）。
 * 因此 100、10000、10100 都是合法 CardID，slot 均换算为 100：
 * - cardId=100   → key "1"   slot 100
 * - cardId=10000 → key "100" slot 100
 * - cardId=10100 → key "101" slot 100
 * 拒绝 10000 但接受 10100 在数学上矛盾（都是 100 的整数倍，%100 均为 0），
 * 任何基于余数的规则都无法区分；且真实存档中 10000 完全可能是 key "100" 的第 100 格。
 * **不要**把 isValidCardId "修"成拒绝 %100===0 的 CardID——
 * tests/unit/deck-cardid.test.ts 有专门用例守着这条裁决。
 *
 * ── slot=100 的编码回绕（编码本身的固有性质，非 bug）──────────────────────
 * CardID = key × 100 + slot，slot=100 时合成的 CardID 落进**下一个 key** 的编码域：
 * slotToCardId("101", 100) === 10200，读回时 cardIdToKey(10200) === "102"。
 * 即 slot ∈ [1, 99] 时 key/slot 完美往返；slot=100 往返会把 key 加一。
 * 调用方（cards.ts / patch.ts / inplace.ts）需要 key 无损往返时请限定 slot ∈ [1, 99]
 * （TTS 图集硬上限 10×7=70 格，正常网格永远落在 [1, 70] ⊂ [1, 99]）。
 *
 * 变量命名约定：带 `1based` / `0based` 后缀防混淆——slot 是 1 基，格点坐标
 * (col, row) 与线性索引 index 是 0 基，两者相差恒为一。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * CardID 编码的进位块长：CardID = key × 100 + slot。
 * 低两位的编码域为 1..99 加"0 表示 100"，故 slot 的合法区间是 [1, 100]。
 */
const KEY_BLOCK = 100;

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 断言 CardID 合法（{@link isValidCardId} 的抛错版，裁决口径单一来源）。
 * @param cardId 待校验的 CardID
 * @param argName 入参名（用于错误信息）
 * @throws cardId 不是正整数时抛出中文 Error（调用方编程错误）
 */
function assertCardId(cardId: number, argName: string): void {
  if (!isValidCardId(cardId)) {
    throw new Error(`${argName} 必须是正整数（收到 ${String(cardId)}）`);
  }
}

/**
 * 断言 1 基 slot 落在 [1, max] 的整数区间。
 * @param slot 待校验的 1 基 slot
 * @param max slot 上限（含）
 * @param argName 入参名（用于错误信息）
 * @throws slot 不是该区间内的整数时抛出中文 Error
 */
function assertSlotInRange1based(slot: number, max: number, argName: string): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > max) {
    throw new Error(`${argName} 必须是 1 到 ${max} 之间的整数（收到 ${String(slot)}）`);
  }
}

/**
 * 断言值是不小于 1 的整数（slot / columns 等下界为 1 的量）。
 * @param value 待校验值
 * @param label 入参名（用于错误信息）
 * @throws 不是 ≥1 的整数时抛出中文 Error
 */
function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} 必须是不小于 1 的整数（收到 ${String(value)}）`);
  }
}

/**
 * 断言 0 基格点坐标（col / row）是不小于 0 的整数。
 * @param value 待校验的 0 基坐标
 * @param label 入参名（用于错误信息）
 * @throws 不是 ≥0 的整数时抛出中文 Error
 */
function assertCoord0based(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} 必须是不小于 0 的整数（收到 ${String(value)}）`);
  }
}

/**
 * 把 CustomDeck 的 key 归一为非负整数的规范字符串形式。
 *
 * CustomDeck 的 key 在存档里一定是字符串（JSON 对象键），但手写代码常给数字；
 * 归一规则：数字 → 十进制字符串；字符串 → 必须是纯数字（^\d+$），
 * 经 Number 归一后输出（"007" 归一为 "7"，与 cardIdToKey 的输出形式一致）。
 * key "0" 合法——CardID 1..99 换算出的 key 就是 "0"（与"正整数即合法"裁决一致）。
 *
 * @param key CustomDeck 的 key（数字或纯数字字符串）
 * @returns 归一后的字符串形式（如 101 → "101"、"007" → "7"）
 * @throws key 不是非负整数 / 纯数字字符串时抛出中文 Error
 */
function normalizeKey(key: string | number): string {
  if (typeof key === "number") {
    if (!Number.isInteger(key) || key < 0) {
      throw new Error(`key 必须是非负整数（收到 ${String(key)}）`);
    }
    return String(key);
  }
  if (!/^\d+$/.test(key)) {
    throw new Error(`key 必须是纯数字字符串（收到 "${key}"）`);
  }
  return String(Number(key));
}

// ---------------------------------------------------------------------------
// 导出函数：CardID ↔ key / slot
// ---------------------------------------------------------------------------

/**
 * 由 CardID 求所属图集的 key（字符串形式，与存档 CustomDeck 的 key 一致）。
 *
 * @param cardId TTS 的 CardID（正整数）
 * @returns key 字符串，如 cardIdToKey(10121) === "101"（是字符串 "101"，不是数字 101）
 * @throws cardId 不是正整数时抛出中文 Error
 */
export function cardIdToKey(cardId: number): string {
  assertCardId(cardId, "cardId");
  return String(Math.floor(cardId / KEY_BLOCK));
}

/**
 * 由 CardID 求图集内 slot（**1 基**，与 CardID % 100 一致）。
 *
 * 当 CardID % 100 === 0 时按 TTS 约定返回 100（第 100 格），**不是 0**：
 * cardIdToSlot(10121) === 21，cardIdToSlot(10100) === 100。
 *
 * @param cardId TTS 的 CardID（正整数）
 * @returns 1 基 slot，取值范围 [1, 100]
 * @throws cardId 不是正整数时抛出中文 Error
 */
export function cardIdToSlot(cardId: number): number {
  assertCardId(cardId, "cardId");
  const remainder0based = cardId % KEY_BLOCK; // 0..99（0 即第 100 格）
  return remainder0based === 0 ? KEY_BLOCK : remainder0based;
}

/**
 * 由 key + slot 合成 CardID（key 接受 string 或 number，内部归一为规范字符串再运算）。
 *
 * @param key CustomDeck 的 key（如 "101" 或 101；纯数字字符串，"0" 合法）
 * @param slot 1 基 slot，取值范围 [1, 100]
 * @returns CardID = key × 100 + slot，如 slotToCardId("101", 21) === 10121
 * @throws key 不是非负整数 / 纯数字字符串，或 slot 不在 [1, 100] 时抛出中文 Error
 */
export function slotToCardId(key: string | number, slot: number): number {
  const keyNormalized = normalizeKey(key);
  assertSlotInRange1based(slot, KEY_BLOCK, "slot");
  return Number(keyNormalized) * KEY_BLOCK + slot;
}

// ---------------------------------------------------------------------------
// 导出函数：slot（1 基）↔ 格点坐标（0 基）
// ---------------------------------------------------------------------------

/**
 * 由 slot（**1 基**）+ 列数求 **0 基**的 (col, row) 坐标（行优先：左→右、上→下）。
 *
 * slot=1 → (0, 0)；slot=columns → (columns-1, 0)；slot=columns+1 → (0, 1)。
 * 本函数不知道行数，不设 slot 上界——图集容量上限（columns×rows）由调用方
 * 用 {@link isValidSlot} 把关。
 *
 * @param slot 1 基 slot（≥1 的整数）
 * @param columns 列数（≥1 的整数）
 * @returns 0 基格点坐标，如 slotToGrid(70, 10) === { col: 9, row: 6 }
 * @throws slot < 1 或 columns < 1（含非整数）时抛出中文 Error
 */
export function slotToGrid(slot: number, columns: number): { col: number; row: number } {
  assertPositiveInt(slot, "slot");
  assertPositiveInt(columns, "columns");
  const index0based = slot - 1; // 1 基 slot → 0 基线性索引
  const col0based = index0based % columns;
  const row0based = Math.floor(index0based / columns);
  return { col: col0based, row: row0based };
}

/**
 * 由 **0 基**的 (col, row) + 列数求 slot（**1 基**）。
 *
 * gridToSlot(0, 0, 10) === 1；gridToSlot(9, 6, 10) === 70。
 * 与 {@link slotToGrid} 互逆。
 *
 * @param col 0 基列号（≥0 的整数）
 * @param row 0 基行号（≥0 的整数）
 * @param columns 列数（≥1 的整数）
 * @returns 1 基 slot
 * @throws col / row < 0 或 columns < 1（含非整数）时抛出中文 Error
 */
export function gridToSlot(col: number, row: number, columns: number): number {
  assertCoord0based(col, "col");
  assertCoord0based(row, "row");
  assertPositiveInt(columns, "columns");
  const index0based = row * columns + col; // 0 基线性索引
  return index0based + 1; // 0 基索引 → 1 基 slot
}

// ---------------------------------------------------------------------------
// 导出函数：校验（永不抛错）
// ---------------------------------------------------------------------------

/**
 * 校验 CardID 合法性：**正整数即合法**（主窗口 2026-10-04 裁决，写死防回退）。
 *
 * 即 cardId > 0 且 Number.isInteger(cardId)。slot 维度无需单独检查：
 * 由 {@link cardIdToSlot} 的"%100===0 → 100"映射保证，任何正整数的 slot
 * 恒在 [1, 100]——100、10000、10100 都是合法 CardID（slot 均为 100）。
 * 拒绝：0、负数、小数、NaN、±Infinity。
 *
 * @param cardId 待校验的 CardID
 * @returns 合法返回 true，否则 false（非法入参不抛错）
 */
export function isValidCardId(cardId: number): boolean {
  return Number.isInteger(cardId) && cardId > 0;
}

/**
 * 校验 slot 合法性：**1 基**整数，落在 [1, columns × rows] 之间。
 *
 * 网格参数（columns / rows）非法（非整数或 < 1）时同样返回 false——
 * 校验函数永不抛错。
 *
 * @param slot 待校验的 1 基 slot
 * @param columns 列数
 * @param rows 行数
 * @returns 合法返回 true，否则 false（非法入参不抛错）
 */
export function isValidSlot(slot: number, columns: number, rows: number): boolean {
  if (!Number.isInteger(slot) || !Number.isInteger(columns) || !Number.isInteger(rows)) {
    return false;
  }
  if (columns < 1 || rows < 1) {
    return false;
  }
  return slot >= 1 && slot <= columns * rows;
}
