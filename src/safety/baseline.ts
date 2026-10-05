// src/safety/baseline.ts
/**
 * safety.baseline：基线 hash 与冲突检测（阶段 5「写入路径」的安全基座）。
 *
 * 用途（回答 push 前的两个安全问题）：
 * 1. 「游戏内脚本 / UI 是否被别人改过？」——pull 之后立即 {@link writeBaseline} 把
 *    当时游戏侧各对象 script / ui 的归一化 sha256 记到基线；push 前
 *    {@link diffBaseline} 把当前游戏侧快照与基线对比，不一致即 {@link BaselineConflict}
 *    （提示用户先 pull 对账，避免覆盖他人改动）；
 * 2. 「工作区素材是否漂移？」——{@link writeBaseline} 同时按用户裁决（「内容 hash 最严」）
 *    记录文本素材清单的内容 hash（口径见下）；push 前 {@link detectAssetChanges} 发现
 *    任何 changed / added / deleted 都必须拦截：约束 7 —— push 协议（messageID 1）只接收
 *    scriptStates，不接收素材字段，素材改动永远不可能靠 push 生效，必须走
 *    pack/build.ts 的离线回路。
 *
 * baseline 文件：<root>/.tts/baseline.json（2 空格缩进 JSON + 末尾换行）。
 * src/pack/init.ts 已把它列入图包 .gitignore（工具内部状态，不入库）。
 * 路径由 layout.ts 的 {@link baselinePath} 提供（与 skeletonPath 同级）。
 *
 * 典型时序（调用方 = 阶段 5 的 pull / push 命令与 hub 路由）：
 * - pull：pullFromGame 落盘后 → writeBaseline(states)（保留旧 lastPushAt，不抹掉推送史）；
 * - push 前：getScripts 快照 → diffBaseline（冲突即停）→ detectAssetChanges
 *   （素材漂移即停）→ confirmPush（src/safety/confirm.ts）；
 * - push 成功：saveAndPlay → writeBaseline(推送的 states) → touchLastPushAt
 *   （writeBaseline 只「保留」旧 lastPushAt，时间戳由 touchLastPushAt 单独盖）。
 *
 * hash 约定：
 * - 算法与 src/pack/import.ts 的 shortSha256 同款：
 *   createHash("sha256").update(text, "utf8").digest("hex")，不截断（64 字符小写 hex）；
 * - **前置归一化**（CRLF / 单独 CR 折成 LF + trimEnd）从 src/pack/diff.ts 导入
 *   normalizeContent（与 push.ts 同一份实现；diff.ts 起统一导出，禁止再持私有副本），
 *   不归一化会把编辑器换行风格 / 结尾空行差异误报成冲突（假冲突）。
 *
 * 素材集合口径（用户裁决「内容 hash 最严」；只覆盖以下文本清单，不含图片等二进制素材）：
 * - `<root>/decks/<每个卡堆目录>/cards.csv`
 * - `<root>/decks/<每个卡堆目录>/deck.yaml`
 * - `<root>/objects/objects.csv`
 * 全部按 utf8 读出 → 归一化 → sha256；文件不存在 → 跳过（不进表）。
 * assetFiles 的 key 是相对 root 的正斜杠路径（如 `decks/冒险牌堆/cards.csv`），
 * 与平台分隔符无关，保证 baseline 跨机器可比。
 *
 * 损坏语义：readBaseline 对「文件不存在」与「JSON 解析失败 / 结构不符合 version 1
 * 形状」一律返回 null（当作没有基线），只有「文件在但读不出」（权限等）的 IO 错误
 * 才抛 BASELINE_READ_FAILED——损坏基线的安全方向是「没有基线」（调用方按首跑处理、
 * 重建即可），而不是让整条写入链路卡死。基线里 hash 值只做类型校验不做格式校验：
 * 对比是等值比较，畸形 hash 只会必然不相等（报冲突，安全方向），不会误放行。
 *
 * 其他确定性约定：
 * - states 里同一 guid 重复出现 → 先到先得（与 diff.ts 的 gameByGuid 一致）；
 *   guid 缺失 / 空串的 state 无法与文件对账，跳过（防御性，协议保证不出现）；
 * - BaselineEntry.name 是 pull 落盘文件名里的净化名：guid "-1"（Global）固定
 *   "Global"，其余取 sanitizeName(state.name)（与 layout.scriptFileName 的命名一致）；
 * - diffBaseline 逐 kind 等值比较（undefined 也算一个值）：baseline 与远端「都没记」
 *   不算冲突（无意义），「一边有另一边没有」算冲突——缺失一侧的 hash 字段缺省；
 * - 全部列表 / 键序按 UTF-16 码元排序，不依赖 locale，跨机器结果一致。
 *
 * 本模块纯离线：不连 TTS、不起 withEditorServer（坑 17 不适用），不触碰
 * pack/build.ts（约束 8）、walkSaveUrls（坑 4）与任何素材 URL。
 * normalizeContent 只从 diff.ts 借用（纯函数；该 import 不触发任何会话 / 端口）。
 *
 * 错误码（{@link PackError.code}）：
 * - "BASELINE_READ_FAILED"       baseline.json 存在但读取发生「不存在」以外的 IO 错误
 * - "BASELINE_WRITE_FAILED"      写 baseline.json（建目录 / 写文件）失败
 * - "BASELINE_ASSET_SCAN_FAILED" 扫描 / 读取素材清单（decks / objects）时发生
 *                                「不存在」以外的 IO 错误
 *
 * 本模块新增的 i18n 键（locales/*.json 由本地化步骤统一补齐；缺键时 t() 原样输出键名）：
 * - `error.baseline.readFailed` {path} {detail}
 * - `error.baseline.writeFailed` {path} {detail}
 * - `error.baseline.assetScanFailed` {detail}
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { t } from "../i18n/index.js";
import { normalizeContent } from "../pack/diff.js";
import { baselinePath, decksDir, objectsDir, sanitizeName } from "../pack/layout.js";
import { PackError } from "../pack/packyaml.js";
import { GLOBAL_GUID } from "../protocol/messages.js";
import type { ScriptState } from "../session/scripts.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** decks/ 下卡堆清单文件名 */
const DECK_MANIFEST_FILE = "deck.yaml";

/** decks/ 下卡堆卡表文件名 */
const DECK_CARDS_FILE = "cards.csv";

/** objects/ 下的对象总表文件名 */
const OBJECTS_CSV_FILE = "objects.csv";

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** 基线里单个对象的脚本 / UI hash 记录 */
export interface BaselineEntry {
  /** 对象 GUID（"-1" 为全局脚本 / 全局 UI） */
  guid: string;
  /** 净化名（来自 pull 时的文件名；Global 固定 "Global"） */
  name: string;
  /** 脚本内容（归一化后）的 sha256 hex；pull 时该对象没有 script 字段则缺省 */
  scriptHash?: string;
  /** UI 内容（归一化后）的 sha256 hex；pull 时该对象没有 ui 字段则缺省 */
  uiHash?: string;
}

/** baseline.json 的结构（version 固定 1；形状不符按损坏处理，见模块头注释） */
export interface Baseline {
  /** 结构版本号；readBaseline 只认 1，其他版本按损坏返回 null */
  version: 1;
  /** 写入时刻的图包根目录（绝对路径） */
  packRoot: string;
  /** 基线写入时刻（ISO 时间戳） */
  updatedAt: string;
  /** 上次成功 push 完成时间（ISO 时间戳）；由 touchLastPushAt 单独维护 */
  lastPushAt?: string;
  /** 各对象的脚本 / UI hash（按写入时 states 顺序） */
  entries: BaselineEntry[];
  /** 素材明细文件相对路径（正斜杠）→ sha256（见模块头注释的素材集合口径） */
  assetFiles: Record<string, string>;
}

/** 一条基线冲突（游戏侧相对基线发生了变化） */
export interface BaselineConflict {
  /** 对象 GUID */
  guid: string;
  /** 对象净化名（取自基线条目） */
  name: string;
  /** 冲突对象类型 */
  kind: "script" | "ui";
  /** 基线记录的 hash；缺省 = 基线没记录该字段 */
  baselineHash?: string;
  /** 游戏侧当前 hash；缺省 = 远端没这字段（或整个 guid 不在远端） */
  remoteHash?: string;
}

/** 素材三向对比结果（相对路径均为正斜杠、按码元序排序） */
export interface AssetChanges {
  /** 相对路径在表里但当前 hash 与基线不一致 */
  changed: string[];
  /** 基线没记录但磁盘当前存在 */
  added: string[];
  /** 基线有记录但磁盘当前不存在 */
  deleted: string[];
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT），避免 any。
 * （与 src/pack/packyaml.ts / diff.ts 的同名内部函数一致，各模块各自持有。）
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
 * 按 UTF-16 码元顺序比较字符串（不依赖运行时 locale，保证跨机器确定性）。
 * @param a 左值
 * @param b 右值
 * @returns 负数 / 0 / 正数，语义同 Array.prototype.sort 的比较器
 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * 计算文本的 sha256 十六进制全量摘要（64 字符小写 hex）。
 * 与 src/pack/import.ts 的 shortSha256 同款算法，不截断。
 * @param text 待哈希文本（utf8；调用方负责先归一化）
 * @returns 小写十六进制字符串
 */
function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 计算 ScriptState 字段的 hash（缺字段返回 undefined）。
 * @param text 字段内容（undefined = 远端没这字段）
 * @returns 归一化后的 sha256；text 非 string / undefined 时返回 undefined
 */
function hashOfOptionalText(text: unknown): string | undefined {
  return typeof text === "string" ? sha256Text(normalizeContent(text)) : undefined;
}

/**
 * 校验 root 入参（防止空串被 path.join / resolve 静默解析成 cwd 下的路径）。
 * @param root 图包工作区根目录
 * @returns 校验通过的原路径
 * @throws root 不是非空字符串时抛出中文错误（调用方编程错误）
 */
function assertRoot(root: string): string {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error("baseline 入参无效：root 必须是非空字符串路径");
  }
  return root;
}

/**
 * 基线条目的净化名：guid "-1"（Global）的落盘文件名固定 Global.lua / Global.xml，
 * 名字与 state.name 无关；其余对象取 sanitizeName(state.name)（空名回退 "object"，
 * 与 layout.scriptFileName 的命名规则一致）。
 * @param guid 对象 GUID
 * @param rawName 游戏侧原始对象名（可能缺失 / 非字符串，防御性处理）
 * @returns 净化名
 */
function baselineEntryName(guid: string, rawName: unknown): string {
  if (guid === GLOBAL_GUID) {
    return "Global";
  }
  return sanitizeName(typeof rawName === "string" ? rawName : "");
}

// ---------------------------------------------------------------------------
// 内部实现：baseline.json 读写
// ---------------------------------------------------------------------------

/**
 * 把 unknown JSON 数据解析成 Baseline（version 1 形状校验；只保留已知字段）。
 * @param raw 文件原文
 * @returns 校验通过的 Baseline；JSON 解析失败或形状不符时返回 null（按损坏处理）
 */
function parseBaseline(raw: string): Baseline | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null; // JSON 语法损坏：当没有基线
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) {
    return null; // 未知结构版本：语义无法保证，按损坏处理
  }
  if (typeof obj.packRoot !== "string" || typeof obj.updatedAt !== "string") {
    return null;
  }
  if (obj.lastPushAt !== undefined && typeof obj.lastPushAt !== "string") {
    return null;
  }
  if (!Array.isArray(obj.entries)) {
    return null;
  }
  const entries: BaselineEntry[] = [];
  for (const item of obj.entries) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const rawEntry = item as Record<string, unknown>;
    if (typeof rawEntry.guid !== "string" || rawEntry.guid === "" || typeof rawEntry.name !== "string") {
      return null;
    }
    if (rawEntry.scriptHash !== undefined && typeof rawEntry.scriptHash !== "string") {
      return null;
    }
    if (rawEntry.uiHash !== undefined && typeof rawEntry.uiHash !== "string") {
      return null;
    }
    const entry: BaselineEntry = { guid: rawEntry.guid, name: rawEntry.name };
    if (rawEntry.scriptHash !== undefined) {
      entry.scriptHash = rawEntry.scriptHash;
    }
    if (rawEntry.uiHash !== undefined) {
      entry.uiHash = rawEntry.uiHash;
    }
    entries.push(entry);
  }
  if (obj.assetFiles === null || typeof obj.assetFiles !== "object" || Array.isArray(obj.assetFiles)) {
    return null;
  }
  const assetFiles: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj.assetFiles)) {
    if (typeof value !== "string") {
      return null;
    }
    assetFiles[key] = value;
  }
  const baseline: Baseline = {
    version: 1,
    packRoot: obj.packRoot,
    updatedAt: obj.updatedAt,
    entries,
    assetFiles,
  };
  if (obj.lastPushAt !== undefined) {
    baseline.lastPushAt = obj.lastPushAt;
  }
  return baseline;
}

/**
 * 把 Baseline 序列化落盘（2 空格缩进 JSON + 末尾换行），父目录不存在时自动创建。
 * @param file baseline.json 完整路径
 * @param baseline 待写入的基线
 * @throws PackError code="BASELINE_WRITE_FAILED" 建目录 / 写文件发生 IO 错误时
 */
async function writeBaselineFile(file: string, baseline: Baseline): Promise<void> {
  const text = `${JSON.stringify(baseline, null, 2)}\n`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
  } catch (err) {
    throw new PackError(
      "BASELINE_WRITE_FAILED",
      t("error.baseline.writeFailed", { path: file, detail: errMessage(err) }),
    );
  }
}

// ---------------------------------------------------------------------------
// 内部实现：素材清单扫描
// ---------------------------------------------------------------------------

/**
 * 读单个素材清单文件并记入表（key 为相对 root 的正斜杠路径）。
 * 文件不存在（ENOENT）→ 跳过；其他 IO 错误 → BASELINE_ASSET_SCAN_FAILED。
 * @param table 累积表（原地写入）
 * @param relKey 相对路径（正斜杠）
 * @param absPath 文件绝对路径
 * @throws PackError code="BASELINE_ASSET_SCAN_FAILED" 读取发生「不存在」以外错误时
 */
async function addAssetFile(table: Map<string, string>, relKey: string, absPath: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return; // 文件不存在：跳过，不进表
    }
    throw new PackError(
      "BASELINE_ASSET_SCAN_FAILED",
      t("error.baseline.assetScanFailed", { detail: `${absPath}：${errMessage(err)}` }),
    );
  }
  table.set(relKey, sha256Text(normalizeContent(text)));
}

/**
 * 扫描当前工作区的素材清单文件，产出「相对路径 → 归一化 sha256」表。
 *
 * 口径（见模块头注释）：decks/<每个卡堆目录>/{cards.csv, deck.yaml} +
 * objects/objects.csv；decks/ 或 objects/ 目录不存在按「无素材」处理（ENOENT 不报错）。
 * 输出按 key 码元序排序，保证 JSON 序列化结果跨机器确定。
 *
 * @param root resolve 后的图包根目录
 * @returns 排序后的 assetFiles 表（可能为空对象）
 * @throws PackError code="BASELINE_ASSET_SCAN_FAILED" 目录扫描或文件读取失败时
 */
async function scanAssetFiles(root: string): Promise<Record<string, string>> {
  const table = new Map<string, string>();

  // —— decks/<每个卡堆目录>/{cards.csv, deck.yaml}（只扫一层子目录）——
  let deckEntries: Dirent[];
  try {
    deckEntries = await readdir(decksDir(root), { withFileTypes: true });
  } catch (err) {
    if (errCode(err) !== "ENOENT") {
      throw new PackError(
        "BASELINE_ASSET_SCAN_FAILED",
        t("error.baseline.assetScanFailed", { detail: `${decksDir(root)}：${errMessage(err)}` }),
      );
    }
    deckEntries = []; // decks/ 不存在：按无素材处理
  }
  const deckDirs = deckEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  deckDirs.sort(compareCodeUnits);
  for (const deckDir of deckDirs) {
    await addAssetFile(table, `decks/${deckDir}/${DECK_CARDS_FILE}`, path.join(decksDir(root), deckDir, DECK_CARDS_FILE));
    await addAssetFile(
      table,
      `decks/${deckDir}/${DECK_MANIFEST_FILE}`,
      path.join(decksDir(root), deckDir, DECK_MANIFEST_FILE),
    );
  }

  // —— objects/objects.csv（单文件，不存在则跳过）——
  await addAssetFile(table, `objects/${OBJECTS_CSV_FILE}`, path.join(objectsDir(root), OBJECTS_CSV_FILE));

  const record: Record<string, string> = {};
  for (const [key, hash] of [...table.entries()].sort((a, b) => compareCodeUnits(a[0], b[0]))) {
    record[key] = hash;
  }
  return record;
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 读取基线。
 *
 * 行为（损坏语义见模块头注释）：
 * - 文件不存在 → null；
 * - JSON 解析失败 / 结构不符合 version 1 形状 → null（不抛错）；
 * - 文件存在但读取发生其他 IO 错误（权限等）→ PackError BASELINE_READ_FAILED。
 *
 * @param root 图包工作区根目录（相对路径会先 resolve）
 * @returns 基线；没有可用基线时 null
 * @throws Error root 不是非空字符串时（调用方编程错误）
 * @throws PackError code="BASELINE_READ_FAILED" 文件存在但读取失败（非「不存在」）时
 */
export async function readBaseline(root: string): Promise<Baseline | null> {
  const file = baselinePath(path.resolve(assertRoot(root)));
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return null;
    }
    throw new PackError(
      "BASELINE_READ_FAILED",
      t("error.baseline.readFailed", { path: file, detail: errMessage(err) }),
    );
  }
  return parseBaseline(raw);
}

/**
 * 写入基线（pull 之后 / push 成功之后调用）。
 *
 * 流程：
 * 1. 扫描当前素材清单（decks / objects）算出 assetFiles 表（口径见模块头注释）；
 * 2. 把 states 转成 BaselineEntry[]：script / ui 字段先归一化再 sha256；
 *    缺字段不记 hash（与「缺字段即删除」的 push 语义对应）；同 guid 先到先得；
 * 3. 旧基线（若可读出）的 lastPushAt 保留到新基线——保留是 best-effort：
 *    旧文件不存在 / 损坏 / 读不出都视为无旧值，不因此中断写入；
 * 4. 落盘 `<root>/.tts/baseline.json`（2 空格缩进 + 末尾换行），updatedAt 为当前时刻。
 *
 * 注意：本函数**不设置** lastPushAt（只保留旧值）；push 成功后请另调
 * {@link touchLastPushAt} 盖时间戳。
 *
 * @param root 图包工作区根目录（相对路径会先 resolve）
 * @param states 游戏侧脚本状态快照（如 getScripts 的返回值 / push 推送的列表）
 * @returns 已写入的基线（与文件内容一致）
 * @throws Error root 不是非空字符串，或 states 不是数组时（调用方编程错误）
 * @throws PackError code="BASELINE_ASSET_SCAN_FAILED" 素材清单扫描 / 读取失败时
 * @throws PackError code="BASELINE_WRITE_FAILED" 建目录 / 写文件失败时
 */
export async function writeBaseline(root: string, states: ScriptState[]): Promise<Baseline> {
  assertRoot(root);
  if (!Array.isArray(states)) {
    throw new Error("baseline 入参无效：states 必须是 ScriptState 数组");
  }
  const resolved = path.resolve(root);

  // —— 1. 当前素材 hash 表（口径见模块头注释；错误码 BASELINE_ASSET_SCAN_FAILED）——
  const assetFiles = await scanAssetFiles(resolved);

  // —— 2. states → BaselineEntry[]（同 guid 先到先得；缺字段不记 hash）——
  const entries: BaselineEntry[] = [];
  const seenGuids = new Set<string>();
  for (const state of states) {
    if (state === null || typeof state !== "object") {
      continue; // 防御性：非对象元素跳过
    }
    if (typeof state.guid !== "string" || state.guid === "") {
      continue; // 无法与文件对账的 state 跳过（协议保证 guid 为非空字符串）
    }
    if (seenGuids.has(state.guid)) {
      continue; // 先到先得，保证确定性
    }
    seenGuids.add(state.guid);
    const entry: BaselineEntry = { guid: state.guid, name: baselineEntryName(state.guid, state.name) };
    const scriptHash = hashOfOptionalText(state.script);
    if (scriptHash !== undefined) {
      entry.scriptHash = scriptHash;
    }
    const uiHash = hashOfOptionalText(state.ui);
    if (uiHash !== undefined) {
      entry.uiHash = uiHash;
    }
    entries.push(entry);
  }

  // —— 3. 保留旧 lastPushAt（best-effort：读不出 / 损坏一律视为无旧值）——
  let previousLastPushAt: string | undefined;
  try {
    const raw = await readFile(baselinePath(resolved), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const lastPushAt = (parsed as { lastPushAt?: unknown }).lastPushAt;
      if (typeof lastPushAt === "string") {
        previousLastPushAt = lastPushAt;
      }
    }
  } catch {
    previousLastPushAt = undefined; // 不存在 / 损坏 / IO 错：不保留，也不中断写入
  }

  // —— 4. 落盘 ——
  const baseline: Baseline = {
    version: 1,
    packRoot: resolved,
    updatedAt: new Date().toISOString(),
    ...(previousLastPushAt !== undefined ? { lastPushAt: previousLastPushAt } : {}),
    entries,
    assetFiles,
  };
  await writeBaselineFile(baselinePath(resolved), baseline);
  return baseline;
}

/**
 * 基线冲突检测：对比「游戏侧当前快照」与「基线」的脚本 / UI hash。
 *
 * 规则（逐 kind 等值比较，undefined 也算一个值；详见模块头注释）：
 * - 基线不可用（readBaseline 返回 null，含文件不存在 / 损坏）→ 返回 []，不报错；
 *   基线文件读取的 IO 错误（BASELINE_READ_FAILED）原样上抛；
 * - 基线条目与远端同 guid：某 kind 两侧 hash 不一致 → 一条 {@link BaselineConflict}
 *   （缺失一侧的 hash 字段缺省）；两侧都缺 → 不算冲突；
 * - 基线有但远端没整个 guid → 该条目每个「已记录 hash」的 kind 各一条冲突
 *   （remoteHash 缺省）；条目没记录 hash 的 kind 两侧都没有，不算冲突；
 * - 远端多出的新 guid（基线没有）→ 不算冲突（新增不是覆盖风险）。
 *
 * 远端快照的 hash 计算与 {@link writeBaseline} 完全同款（归一化 + sha256），
 * 因此「内容等价但换行风格不同」不会误报；同 guid 重复出现时先到先得。
 *
 * 返回顺序：按基线条目顺序遍历，同一条目内 script 在 ui 之前。
 *
 * @param root 图包工作区根目录（相对路径会先 resolve）
 * @param remoteStates 游戏侧当前脚本状态快照（如 getScripts 的返回值）
 * @returns 全部冲突（无冲突 / 无基线时为空数组）
 * @throws Error root 不是非空字符串，或 remoteStates 不是数组时（调用方编程错误）
 * @throws PackError code="BASELINE_READ_FAILED" 基线文件存在但读取失败时（原样上抛）
 */
export async function diffBaseline(root: string, remoteStates: ScriptState[]): Promise<BaselineConflict[]> {
  assertRoot(root);
  if (!Array.isArray(remoteStates)) {
    throw new Error("baseline 入参无效：remoteStates 必须是 ScriptState 数组");
  }

  const baseline = await readBaseline(path.resolve(root));
  if (baseline === null) {
    return []; // 无基线（首跑 / 损坏）：无从冲突，调用方按首跑流程处理
  }

  const remoteByGuid = new Map<string, { scriptHash?: string; uiHash?: string }>();
  for (const state of remoteStates) {
    if (state === null || typeof state !== "object") {
      continue;
    }
    if (typeof state.guid !== "string" || state.guid === "") {
      continue;
    }
    if (remoteByGuid.has(state.guid)) {
      continue; // 先到先得，保证确定性
    }
    remoteByGuid.set(state.guid, {
      scriptHash: hashOfOptionalText(state.script),
      uiHash: hashOfOptionalText(state.ui),
    });
  }

  const conflicts: BaselineConflict[] = [];
  for (const entry of baseline.entries) {
    const remote = remoteByGuid.get(entry.guid);
    for (const kind of ["script", "ui"] as const) {
      const baselineHash = kind === "script" ? entry.scriptHash : entry.uiHash;
      const remoteHash = remote === undefined ? undefined : kind === "script" ? remote.scriptHash : remote.uiHash;
      if (baselineHash === remoteHash) {
        continue; // 一致（含两侧都缺）不算冲突
      }
      conflicts.push({ guid: entry.guid, name: entry.name, kind, baselineHash, remoteHash });
    }
  }
  return conflicts;
}

/**
 * 素材三向对比：当前磁盘上的素材清单 vs 基线记录（口径见模块头注释）。
 *
 * - baseline 传 null（没有基线）→ changed / deleted 为空，added 为当前全部素材文件
 *   （首跑口径：所有素材都「基线没记录」）；
 * - 否则逐 key 三向对比：两侧都有但 hash 不同 → changed；只在磁盘 → added；
 *   只在基线 → deleted。
 *
 * 本函数不读 baseline.json——基线由调用方传入（push 流程先 readBaseline 再传进来，
 * 避免重复读盘）；需要独立重扫基线时可自行组合两者。
 *
 * @param root 图包工作区根目录（相对路径会先 resolve）
 * @param baseline 基线（可为 null）
 * @returns 三向差异（每个数组按相对路径码元序排序）
 * @throws Error root 不是非空字符串时（调用方编程错误）
 * @throws PackError code="BASELINE_ASSET_SCAN_FAILED" 素材清单扫描 / 读取失败时
 */
export async function detectAssetChanges(root: string, baseline: Baseline | null): Promise<AssetChanges> {
  const resolved = path.resolve(assertRoot(root));
  const current = await scanAssetFiles(resolved);

  if (baseline === null) {
    return { changed: [], added: Object.keys(current), deleted: [] };
  }

  const changed: string[] = [];
  const added: string[] = [];
  for (const [key, hash] of Object.entries(current)) {
    const recorded = baseline.assetFiles[key];
    if (recorded === undefined) {
      added.push(key);
    } else if (recorded !== hash) {
      changed.push(key);
    }
  }
  const deleted: string[] = [];
  for (const key of Object.keys(baseline.assetFiles)) {
    if (!(key in current)) {
      deleted.push(key);
    }
  }

  const byKey = (a: string, b: string): number => compareCodeUnits(a, b);
  return { changed: changed.sort(byKey), added: added.sort(byKey), deleted: deleted.sort(byKey) };
}

/**
 * 盖「上次成功 push 完成」时间戳：只更新 lastPushAt 字段，其余内容原样保留。
 *
 * - 基线不存在 / 损坏（readBaseline 返回 null）→ 什么都不做（不创建文件、不报错）；
 *   基线读取的 IO 错误（BASELINE_READ_FAILED）原样上抛；
 * - 写回沿用 2 空格缩进 + 末尾换行；updatedAt / entries / assetFiles 不变。
 *
 * @param root 图包工作区根目录（相对路径会先 resolve）
 * @throws Error root 不是非空字符串时（调用方编程错误）
 * @throws PackError code="BASELINE_READ_FAILED" 基线文件存在但读取失败时（原样上抛）
 * @throws PackError code="BASELINE_WRITE_FAILED" 写回失败时
 */
export async function touchLastPushAt(root: string): Promise<void> {
  const resolved = path.resolve(assertRoot(root));
  const baseline = await readBaseline(resolved);
  if (baseline === null) {
    return; // 无基线：什么都不做
  }
  baseline.lastPushAt = new Date().toISOString();
  await writeBaselineFile(baselinePath(resolved), baseline);
}
