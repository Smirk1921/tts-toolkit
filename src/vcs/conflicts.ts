// src/vcs/conflicts.ts
/**
 * 合并冲突分析：检测 git merge 冲突并把冲突文件反查成"哪个牌堆的哪张卡 / 哪个
 * 对象的哪个素材"（方案设计 §14.2），输出用户能直接决策的报告。
 *
 * 职责：
 * - {@link analyzeConflicts}：读 `git status --porcelain -z`（经 src/vcs/git.ts），
 *   过滤出全部未合并（unmerged）条目（XY ∈ DD / AU / UD / UA / DU / AA / UU，
 *   git 文档列出的 7 种），逐条按路径形状反查归属，返回 {@link ConflictsReport}；
 * - {@link formatConflict}：把单个 {@link ConflictInfo} 格式化成用户可读的多行
 *   中文文本（含"保留哪一侧"的命令提示，但**绝不代用户执行**）。
 *
 * 反查规则（方案设计 §14.2，路径为 git porcelain 输出的 POSIX 分隔相对路径）：
 * 1. `decks/<deckName>/<fileName>`：
 *    - cards.csv 本身冲突 → type="cards-csv"，并收录进
 *      {@link ConflictsReport.cardsCsvConflictPaths}（卡表是反查的数据源，
 *      报告会提示"必须先解决"，否则其余卡图反查不可用）；
 *    - deck.yaml 冲突 → type="deck-yaml"；deck.yaml 带冲突标记时解析必然失败，
 *      此时回退用目录名当 deckName、guid 留空串，**不降级为 unknown**；
 *    - 其他文件 → 读该牌堆 cards.csv 查 face（正面）/ back（背面）列；
 *      命中 → type="card-image"（deck.yaml 只用于补 guid，缺失时 guid=""），
 *      未命中 → type="unknown"（fallbackReason=`cards.csv 中未找到 <fileName>`）。
 * 2. `objects/<fileName>`：读 objects.csv（先 `<root>/objects/objects.csv`，
 *    兜底 `<root>/objects.csv`，与 src/deck/verify.ts 的双布局口径一致），
 *    查 `file === 整条路径`（台账的 file 字段相对图包根、含 objects/ 前缀）；
 *    命中 → type="object-asset"，未命中 / 台账缺失或非法 → type="unknown"。
 * 3. `scripts/<fileName>.lua`：按 src/pack/layout.ts 的 scriptFileName 规则反推
 *    （`<guid>.<净化名>.lua`；全局脚本 `Global.lua`）→ type="script"；
 * 4. `ui/<fileName>.xml`：同上 → type="ui"；
 * 5. XY 语义：UU 双方都改、AA 双方都加（正常按路径反查）；DD 双方都删、
 *    DU/UD 一删一改 → type 一律特化为 "deleted-modified"（反查出的 card /
 *    object 归属信息仍会附带，供用户决策"保留还是删除"）；
 * 6. 任何反查环节的 IO / 解析失败都降级为 type="unknown" 并写明
 *    fallbackReason，**绝不抛错**——仓库级失败（不是 git 仓库 / git status 本身
 *    失败 / git 不在 PATH）除外，这类错误原样透传自 statusPorcelain。
 *
 * 设计边界（B3 约定）：
 * - **绝不替用户选边**：本模块不出现任何 --ours / --theirs 的自动执行流程，
 *   只在 formatConflict 的文案里给出"可选命令"，由用户自行决定与执行；
 * - git 子进程只经 src/vcs/git.ts 的 statusPorcelain，不直接 execa；
 * - 性能：一次 analyzeConflicts 内每牌堆的 cards.csv / deck.yaml 至多读一次；
 *   objects.csv 按双布局探测（先 objects/ 子目录、兜底 pack 根，与
 *   src/deck/verify.ts 的口径一致），一次扫描中每个候选路径至多读一次
 *   （缓存随调用创建，不跨调用复用，避免两次扫描之间文件被解决后读到旧数据）；
 * - objects.csv 台账只按 `file` 主文件列匹配（§14.2 口径）；file_secondary /
 *   diffuse 等次要文件列暂不参与反查，冲突时会降级为 unknown；
 * - 本模块离线：不 import 命令层 / with-server.ts / session/*；
 * - 错误消息写死中文不走 t()（vcs 模块离线约定）；反查过程中吃到的下游
 *   PackError（cards.csv / objects.csv / deck.yaml 的 t() 文案）原样进入
 *   fallbackReason，不二次包装。
 */

import path from "node:path";

import { GLOBAL_GUID } from "../protocol/messages.js";
import { CARDS_CSV_FILENAME, readCardsCsv, type CardRow } from "../deck/cards.js";
import { OBJECTS_CSV_FILENAME, readObjectsCsv, type ObjectRow } from "../deck/objects.js";
import { DECK_YAML_FILENAME, readDeckManifest, type DeckManifest } from "../pack/manifest.js";
import { decksDir, objectsDir, scriptsDir, uiDir } from "../pack/layout.js";
import { PackError } from "../pack/packyaml.js";

import { statusPorcelain } from "./git.js";

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** 冲突类型（反查结果的粗分类） */
export type ConflictType =
  | "card-image" // decks/<deck>/<file> 且反查成功 → 某张卡的图
  | "cards-csv" // cards.csv 本身冲突（特殊：警告先解决这个）
  | "deck-yaml" // deck.yaml 冲突
  | "object-asset" // objects/<file> 反查成功
  | "script" // scripts/<file>.lua 冲突
  | "ui" // ui/<file>.xml 冲突
  | "deleted-modified" // 删除 / 修改冲突（DD / DU / UD）
  | "unknown"; // 反查失败降级

/** 单个冲突文件的反查结果 */
export interface ConflictInfo {
  type: ConflictType;
  /** 冲突文件相对 pack 根的路径（git porcelain 输出，POSIX 分隔） */
  path: string;
  /** git XY 状态码（"UU" / "AA" / "DD" / "DU" / "UD" / "AU" / "UA"） */
  xy: string;
  /** type=card-image 时的反查结果 */
  card?: {
    deckName: string;
    deckGuid: string;
    cardId: number;
    cardName?: string; // CardRow.name
    cardNickname?: string; // CardRow.nickname
    fileName: string; // face 或 back 文件名
    isBack: boolean; // true=背面，false=正面
    sheetId: number;
    slot: number;
    sheetSource: string;
  };
  /** type=object-asset 时的反查结果 */
  object?: {
    assetId: string;
    name?: string;
    fileName: string;
  };
  /** type=script / ui 时 */
  script?: {
    name: string; // Global 或对象名
    guid: string; // "-1"=Global
  };
  /** type=cards-csv / deck-yaml 时 */
  deck?: {
    deckName: string;
    deckGuid: string;
  };
  /** 反查失败原因（type=unknown 时） */
  fallbackReason?: string;
}

/** 冲突分析报告（analyzeConflicts 的返回值） */
export interface ConflictsReport {
  /** 是否有冲突 */
  hasConflicts: boolean;
  /** 按 type 分组的冲突列表（顺序与 git status 输出一致） */
  conflicts: ConflictInfo[];
  /** 特殊警告：cards.csv 本身冲突（应先解决） */
  cardsCsvConflictPaths: string[];
  /** 特殊警告：反查失败降级（type=unknown）的数量 */
  unknownCount: number;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * git porcelain 路径里的顶层目录段名（由 layout.ts 的路径函数反推，
 * 不在模块里硬编码目录名字符串——目录布局改名时此处自动跟随）。
 */
const DECKS_SEGMENT = path.basename(decksDir("."));
const OBJECTS_SEGMENT = path.basename(objectsDir("."));
const SCRIPTS_SEGMENT = path.basename(scriptsDir("."));
const UI_SEGMENT = path.basename(uiDir("."));

/** 全局脚本 / UI 的文件名主干（与 layout.ts objectFileName 的 `Global${ext}` 约定一致） */
const GLOBAL_STEM = "Global";

/** 全局脚本在 scripts/ui 文件名反推时的对象名（同上约定） */
const GLOBAL_NAME = "Global";

/** git status --porcelain 的全部未合并（unmerged）XY 状态码（git 文档列出的 7 种） */
const UNMERGED_XY: ReadonlySet<string> = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** 删除侧参与的未合并状态：双方都删（DD）或一删一改（DU / UD）→ 特化为 deleted-modified */
const DELETION_XY: ReadonlySet<string> = new Set(["DD", "DU", "UD"]);

/** XY 状态码 → 中文语义（formatConflict 用；AU/UA 多由 rename 产生，按 git 文档措辞）。
 * DU/UD 的语义为实测（git 2.55：merge 提示 "deleted in HEAD" 的条目 porcelain 显示 DU）：
 * X 位对应 HEAD（我方）、Y 位对应对方分支。 */
const XY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  UU: "双方都修改",
  AA: "双方都新增",
  DD: "双方都删除",
  DU: "一方删除、一方修改（我方删除）",
  UD: "一方删除、一方修改（对方删除）",
  AU: "我方新增（未合并）",
  UA: "对方新增（未合并）",
});

// ---------------------------------------------------------------------------
// 内部类型与工具
// ---------------------------------------------------------------------------

/** 单个牌堆 cards.csv 的反查缓存条目（读取 / 解析失败时记错误消息，同牌堆不重复读） */
type CardsCsvLookup = { rows: CardRow[] } | { error: string };

/** 全包 objects.csv 的反查缓存条目（同上） */
type ObjectsCsvLookup = { rows: ObjectRow[] } | { error: string };

/**
 * 一次 analyzeConflicts 调用的反查上下文：持有全部读文件缓存。
 * 缓存随调用创建、不跨调用复用（两次扫描之间用户可能已解决部分冲突）。
 */
interface LookupContext {
  packRoot: string;
  /** key = 牌堆目录名（git 路径里的 decks/ 下第一段） */
  cardsCsvCache: Map<string, CardsCsvLookup>;
  /** key = 牌堆目录名；null = deck.yaml 缺失 / 解析失败（冲突标记等） */
  deckYamlCache: Map<string, DeckManifest | null>;
  /** objects.csv 全包至多一份，单槽缓存；settled 标记是否已读过 */
  objectsCsvCache: { settled: boolean; lookup: ObjectsCsvLookup | null };
}

/** 按路径形状反查出的"归属分类"（不含 xy / path 等与路径无关的字段） */
type Classified = Pick<ConflictInfo, "type" | "card" | "object" | "script" | "deck" | "fallbackReason">;

/**
 * 从 unknown 错误中取人类可读描述。
 * @param err 任意抛出值
 * @returns Error 取 message，其余用 String() 兜底
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 牌堆目录在磁盘上的完整路径（decksDir 换算，不硬编码 "decks"）。 */
function deckDirOf(packRoot: string, deckDirName: string): string {
  return path.join(decksDir(packRoot), deckDirName);
}

/**
 * 读取某牌堆的 cards.csv（按牌堆缓存）。
 * @param ctx 反查上下文
 * @param deckDirName 牌堆目录名
 * @returns 行数组；读取 / 校验失败时返回 error 消息（不抛错）
 */
async function loadDeckCardsCsv(ctx: LookupContext, deckDirName: string): Promise<CardsCsvLookup> {
  const hit = ctx.cardsCsvCache.get(deckDirName);
  if (hit !== undefined) {
    return hit;
  }
  let lookup: CardsCsvLookup;
  try {
    lookup = { rows: await readCardsCsv(deckDirOf(ctx.packRoot, deckDirName)) };
  } catch (err) {
    lookup = { error: errMessage(err) };
  }
  ctx.cardsCsvCache.set(deckDirName, lookup);
  return lookup;
}

/**
 * 读取某牌堆的 deck.yaml（按牌堆缓存）。
 * @returns 校验通过的清单；缺失 / 非法 YAML / schema 不过时 null（不抛错——
 *   冲突中的 deck.yaml 带合并标记，解析失败是常态而非异常）
 */
async function loadDeckManifest(ctx: LookupContext, deckDirName: string): Promise<DeckManifest | null> {
  const hit = ctx.deckYamlCache.get(deckDirName);
  if (hit !== undefined) {
    return hit;
  }
  let manifest: DeckManifest | null = null;
  try {
    manifest = await readDeckManifest(deckDirOf(ctx.packRoot, deckDirName));
  } catch {
    manifest = null;
  }
  ctx.deckYamlCache.set(deckDirName, manifest);
  return manifest;
}

/**
 * 读取全包 objects.csv（单槽缓存；先 objects/ 子目录、兜底 pack 根，
 * 与 src/deck/verify.ts 的双布局口径一致）。
 * @returns 行数组；两种布局都缺文件或台账非法时返回 error 消息（不抛错）
 */
async function loadObjectsCsv(ctx: LookupContext): Promise<ObjectsCsvLookup> {
  const cache = ctx.objectsCsvCache;
  if (cache.settled && cache.lookup !== null) {
    return cache.lookup;
  }
  let lookup: ObjectsCsvLookup;
  let lastNotFound = "";
  const candidates = [objectsDir(ctx.packRoot), ctx.packRoot];
  for (const candidateRoot of candidates) {
    try {
      lookup = { rows: await readObjectsCsv(candidateRoot) };
      cache.settled = true;
      cache.lookup = lookup;
      return lookup;
    } catch (err) {
      if (err instanceof PackError && err.code === "OBJECTS_NOT_FOUND") {
        lastNotFound = err.message;
        continue; // 该布局没有台账 → 试下一个布局
      }
      // 台账存在但读取 / 解析失败（如冲突标记）：与 verify.ts 同口径，不再试其他布局
      lookup = { error: errMessage(err) };
      cache.settled = true;
      cache.lookup = lookup;
      return lookup;
    }
  }
  lookup = { error: lastNotFound };
  cache.settled = true;
  cache.lookup = lookup;
  return lookup;
}

/**
 * 牌堆显示身份：优先 deck.yaml 的 name / guid，deck.yaml 缺失或非法时
 * 回退目录名 + 空串（不抛错）。
 */
async function deckIdentityOf(
  ctx: LookupContext,
  deckDirName: string,
): Promise<{ deckName: string; deckGuid: string }> {
  const manifest = await loadDeckManifest(ctx, deckDirName);
  return {
    deckName: manifest?.name ?? deckDirName,
    deckGuid: manifest?.guid ?? "",
  };
}

// ---------------------------------------------------------------------------
// 按路径形状反查（§14.2 步骤 1-4）
// ---------------------------------------------------------------------------

/**
 * 反查 `decks/<deckName>/<fileName>`。
 * @param ctx 反查上下文
 * @param deckDirName 牌堆目录名（POSIX 路径第一段）
 * @param fileName 牌堆目录下的文件名
 */
async function classifyDecksPath(ctx: LookupContext, deckDirName: string, fileName: string): Promise<Classified> {
  if (fileName === CARDS_CSV_FILENAME) {
    return { type: "cards-csv", deck: await deckIdentityOf(ctx, deckDirName) };
  }
  if (fileName === DECK_YAML_FILENAME) {
    const identity = await deckIdentityOf(ctx, deckDirName);
    return { type: "deck-yaml", deck: identity };
  }

  const lookup = await loadDeckCardsCsv(ctx, deckDirName);
  if ("error" in lookup) {
    return { type: "unknown", fallbackReason: `读取 cards.csv 失败：${lookup.error}` };
  }
  const rows = lookup.rows;
  // 先查正面再查背面（同一文件既是某卡 face 又是另一卡 back 时按正面算）
  const faceRow = rows.find((row) => row.face === fileName);
  if (faceRow !== undefined) {
    return {
      type: "card-image",
      card: { ...(await deckIdentityOf(ctx, deckDirName)), ...cardFieldsOf(faceRow, fileName, false) },
    };
  }
  const backRow = rows.find((row) => row.back === fileName);
  if (backRow !== undefined) {
    return {
      type: "card-image",
      card: { ...(await deckIdentityOf(ctx, deckDirName)), ...cardFieldsOf(backRow, fileName, true) },
    };
  }
  return { type: "unknown", fallbackReason: `cards.csv 中未找到 ${fileName}` };
}

/** card 反查字段（不含 deckName / deckGuid——由 deckIdentityOf 并入）。 */
interface CardFields {
  cardId: number;
  cardName?: string;
  cardNickname?: string;
  fileName: string;
  isBack: boolean;
  sheetId: number;
  slot: number;
  sheetSource: string;
}

/** 组装 card 反查字段。 */
function cardFieldsOf(row: CardRow, fileName: string, isBack: boolean): CardFields {
  return {
    cardId: row.cardId,
    cardName: row.name,
    cardNickname: row.nickname,
    fileName,
    isBack,
    sheetId: row.sheetId,
    slot: row.slot,
    sheetSource: row.sheetSource,
  };
}

/**
 * 反查 `objects/<fileName>`：台账 file 列是相对 pack 根的 POSIX 路径
 * （含 objects/ 前缀），所以用整条冲突路径比对。
 */
async function classifyObjectsPath(ctx: LookupContext, relPath: string, fileName: string): Promise<Classified> {
  const lookup = await loadObjectsCsv(ctx);
  if ("error" in lookup) {
    return { type: "unknown", fallbackReason: `读取 objects.csv 失败：${lookup.error}` };
  }
  const row = lookup.rows.find((candidate) => candidate.file === relPath);
  if (row === undefined) {
    return { type: "unknown", fallbackReason: `objects.csv 中未找到 ${relPath}` };
  }
  return { type: "object-asset", object: { assetId: row.assetId, name: row.name, fileName } };
}

/**
 * 反查 `scripts/<fileName>.lua` / `ui/<fileName>.xml`：按 layout.ts 的
 * scriptFileName / uiFileName 规则从文件名反推 `<guid>.<净化名>`；
 * `Global.lua` / `Global.xml` 是全局脚本（guid=-1）。
 * @param kind 目标类型（scripts/ → "script"，ui/ → "ui"）
 * @param fileName 目录下的文件名
 * @param ext 期望扩展名（".lua" / ".xml"）
 */
function classifyTextAssetPath(kind: "script" | "ui", fileName: string, ext: ".lua" | ".xml"): Classified {
  const dirLabel = kind === "script" ? "scripts" : "ui";
  if (!fileName.endsWith(ext)) {
    return { type: "unknown", fallbackReason: `${dirLabel}/ 目录下的冲突文件不是 ${ext} 文件，无法反推归属对象` };
  }
  const stem = fileName.slice(0, fileName.length - ext.length);
  if (stem === GLOBAL_STEM) {
    return { type: kind, script: { name: GLOBAL_NAME, guid: GLOBAL_GUID } };
  }
  // <guid>.<净化名>：净化名可含点（sanitizeName 不删内部点），guid 是第一段非点串
  const match = /^(?<guid>[^.]+)\.(?<name>.+)$/.exec(stem);
  if (match?.groups !== undefined) {
    return { type: kind, script: { name: match.groups.name, guid: match.groups.guid } };
  }
  return {
    type: "unknown",
    fallbackReason: `无法从文件名解析对象 GUID 与名称（期望 <guid>.<名称>${ext} 或 Global${ext}）`,
  };
}

/**
 * 单条冲突路径的反查总入口（§14.2 步骤 1-4 的分发；任何失败降级 unknown）。
 * @param ctx 反查上下文
 * @param relPath git porcelain 输出的 POSIX 分隔相对路径
 */
async function classifyPath(ctx: LookupContext, relPath: string): Promise<Classified> {
  const segments = relPath.split("/");
  const [top, second, third] = segments;
  if (top === DECKS_SEGMENT) {
    // decks/<deck>/<file>：嵌套层级不符（牌堆不应有子目录）时降级 unknown
    if (segments.length === 3 && second !== "" && third !== "") {
      return classifyDecksPath(ctx, second, third);
    }
    return { type: "unknown", fallbackReason: `decks/ 下的路径不符合 <牌堆>/<文件> 布局：${relPath}` };
  }
  if (top === OBJECTS_SEGMENT) {
    if (segments.length === 2 && second !== "") {
      return classifyObjectsPath(ctx, relPath, second);
    }
    return { type: "unknown", fallbackReason: `objects/ 下的路径不符合 <文件> 布局：${relPath}` };
  }
  if (top === SCRIPTS_SEGMENT) {
    if (segments.length === 2 && second !== "") {
      return classifyTextAssetPath("script", second, ".lua");
    }
    return { type: "unknown", fallbackReason: `scripts/ 下的路径不符合 <文件>.lua 布局：${relPath}` };
  }
  if (top === UI_SEGMENT) {
    if (segments.length === 2 && second !== "") {
      return classifyTextAssetPath("ui", second, ".xml");
    }
    return { type: "unknown", fallbackReason: `ui/ 下的路径不符合 <文件>.xml 布局：${relPath}` };
  }
  return {
    type: "unknown",
    fallbackReason: `冲突路径不在 ${DECKS_SEGMENT}/、${OBJECTS_SEGMENT}/、${SCRIPTS_SEGMENT}/、${UI_SEGMENT}/ 已知目录下：${relPath}`,
  };
}

// ---------------------------------------------------------------------------
// 导出函数：analyzeConflicts
// ---------------------------------------------------------------------------

/**
 * 扫描 pack 根的 git 状态，反查所有冲突文件。
 *
 * 只处理 git 的未合并条目（DD / AU / UD / UA / DU / AA / UU）；普通修改、
 * 暂存、未跟踪文件不算冲突。逐条反查永不抛错（失败降级 unknown 并记录
 * fallbackReason）；仓库级失败（不是 git 仓库、git status 本身失败、git 不在
 * PATH）原样透传 statusPorcelain 的 PackError。
 *
 * @param packRoot 图包根目录（须是 git 仓库工作树）
 * @returns 冲突报告
 * @throws PackError code="GIT_NOT_A_REPO" packRoot 不是 git 仓库工作树时
 * @throws PackError code="GIT_COMMAND_FAILED" git status 本身失败时
 * @throws PackError code="GIT_NOT_FOUND" git 不在 PATH 时
 */
export async function analyzeConflicts(packRoot: string): Promise<ConflictsReport> {
  const entries = await statusPorcelain(packRoot);
  const ctx: LookupContext = {
    packRoot,
    cardsCsvCache: new Map(),
    deckYamlCache: new Map(),
    objectsCsvCache: { settled: false, lookup: null },
  };

  const conflicts: ConflictInfo[] = [];
  const cardsCsvConflictPaths: string[] = [];
  let unknownCount = 0;

  for (const entry of entries) {
    if (!UNMERGED_XY.has(entry.xy)) {
      continue;
    }
    const classified = await classifyPath(ctx, entry.path);
    // DD / DU / UD：删除侧参与的冲突一律特化（反查出的归属信息仍保留，辅助决策）
    const type: ConflictType = DELETION_XY.has(entry.xy) ? "deleted-modified" : classified.type;

    const info: ConflictInfo = { type, path: entry.path, xy: entry.xy };
    if (classified.card !== undefined) {
      info.card = classified.card;
    }
    if (classified.object !== undefined) {
      info.object = classified.object;
    }
    if (classified.script !== undefined) {
      info.script = classified.script;
    }
    if (classified.deck !== undefined) {
      info.deck = classified.deck;
    }
    if (classified.fallbackReason !== undefined) {
      info.fallbackReason = classified.fallbackReason;
    }

    // cards.csv 本身冲突：无论最终是否被特化为 deleted-modified 都要收录
    if (classified.type === "cards-csv") {
      cardsCsvConflictPaths.push(entry.path);
    }
    if (type === "unknown") {
      unknownCount += 1;
    }
    conflicts.push(info);
  }

  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
    cardsCsvConflictPaths,
    unknownCount,
  };
}

// ---------------------------------------------------------------------------
// 导出函数：formatConflict
// ---------------------------------------------------------------------------

/** XY 状态码的中文语义；未知状态码原样带回（不抛错）。 */
function xyLabelOf(xy: string): string {
  return XY_LABELS[xy] ?? `未知状态 (${xy})`;
}

/** "冲突类型：双方都修改 (UU)" 行。 */
function conflictTypeLine(info: ConflictInfo): string {
  return `冲突类型：${xyLabelOf(info.xy)} (${info.xy})`;
}

/** 卡牌显示名：name 优先、nickname 兜底，都缺失时返回 null。 */
function cardDisplayName(info: NonNullable<ConflictInfo["card"]>): string | null {
  return info.cardName ?? info.cardNickname ?? null;
}

/** 卡牌图冲突（需人工选择）的完整模板。 */
function formatCardImage(info: ConflictInfo): string {
  const card = info.card as NonNullable<ConflictInfo["card"]>;
  const guidSuffix = card.deckGuid === "" ? "" : ` (GUID: ${card.deckGuid})`;
  const displayName = cardDisplayName(card);
  const cardLine =
    displayName === null ? `卡牌：(CardID: ${card.cardId})` : `卡牌：${displayName} (CardID: ${card.cardId})`;
  return [
    "⚠️ 卡牌图片冲突（需人工选择）",
    "",
    `牌堆：${card.deckName}${guidSuffix}`,
    cardLine,
    `文件：${info.path}（${card.isBack ? "背面" : "正面"}）`,
    `所属图集：sheet_id=${card.sheetId}, slot=${card.slot}`,
    `源 URL：${card.sheetSource}`,
    "",
    conflictTypeLine(info),
    "",
    "选择：",
    `  git checkout --ours   ${info.path}   # 保留当前分支版本`,
    `  git checkout --theirs ${info.path}   # 用对方分支版本`,
    "  或手动用图像工具合成后 git add",
  ].join("\n");
}

/** 卡表冲突（必须先解决）的警告模板。 */
function formatCardsCsv(info: ConflictInfo): string {
  const deck = info.deck;
  const identityLines =
    deck === undefined
      ? []
      : [`牌堆：${deck.deckName}${deck.deckGuid === "" ? "" : ` (GUID: ${deck.deckGuid})`}`];
  return [
    "⚠️ 卡表冲突（cards.csv）——必须最先解决",
    "",
    ...identityLines,
    `文件：${info.path}`,
    "",
    conflictTypeLine(info),
    "",
    "警告：卡表冲突必须先解决，否则卡牌反查不可用——",
    "其余卡图冲突的\"属于哪张卡\"都依赖 cards.csv 的正确版本。",
    "在编辑器中手工合并两侧卡表（保留全部卡行）后 git add，再重新运行冲突分析。",
  ].join("\n");
}

/** 牌堆元数据冲突模板。 */
function formatDeckYaml(info: ConflictInfo): string {
  const deck = info.deck;
  return [
    "⚠️ 牌堆元数据冲突（deck.yaml）",
    "",
    `牌堆：${deck?.deckName ?? "(未知)"}`,
    `文件：${info.path}`,
    "",
    conflictTypeLine(info),
    "",
    "deck.yaml 记录牌堆名称 / GUID / 图集布局：合并时两边的元数据都要保留合理值，",
    "在编辑器中手工合并后 git add。",
  ].join("\n");
}

/** 素材文件冲突模板。 */
function formatObjectAsset(info: ConflictInfo): string {
  const object = info.object as NonNullable<ConflictInfo["object"]>;
  const objectLine =
    object.name === undefined ? `素材：(AssetID: ${object.assetId})` : `素材：${object.name} (AssetID: ${object.assetId})`;
  return [
    "⚠️ 素材文件冲突（需人工选择）",
    "",
    objectLine,
    `文件：${info.path}`,
    "",
    conflictTypeLine(info),
    "",
    "选择：",
    `  git checkout --ours   ${info.path}   # 保留当前分支版本`,
    `  git checkout --theirs ${info.path}   # 用对方分支版本`,
    "  或手动选定正确版本后 git add",
  ].join("\n");
}

/** 脚本 / UI 文本冲突模板（可走编辑器标准合并）。 */
function formatTextAsset(info: ConflictInfo): string {
  const isScript = info.type === "script";
  const script = info.script;
  const guidSuffix = script === undefined ? "" : ` (GUID: ${script.guid})`;
  const title = isScript ? "⚠️ Lua 脚本冲突（文本，可标准合并）" : "⚠️ UI XML 冲突（文本，可标准合并）";
  const subject = isScript ? "脚本" : "UI XML";
  const identityLine = script === undefined ? [] : [`对象：${script.name}${guidSuffix}`];
  return [
    title,
    "",
    ...identityLine,
    `文件：${info.path}`,
    "",
    conflictTypeLine(info),
    "",
    `${subject}是文本文件：在编辑器中按 <<<<<<< / ======= / >>>>>>> 标记手工合并，`,
    "或用合并工具处理后 git add。",
  ].join("\n");
}

/** 删除 / 修改冲突模板（需要人工决策保留还是删除）。 */
function formatDeletedModified(info: ConflictInfo): string {
  const identityLines: string[] = [];
  if (info.card !== undefined) {
    const card = info.card;
    const displayName = cardDisplayName(card);
    identityLines.push(
      `牌堆：${card.deckName}${card.deckGuid === "" ? "" : ` (GUID: ${card.deckGuid})`}`,
      displayName === null ? `卡牌：(CardID: ${card.cardId})` : `卡牌：${displayName} (CardID: ${card.cardId})`,
    );
  } else if (info.object !== undefined) {
    const object = info.object;
    identityLines.push(
      object.name === undefined
        ? `素材：(AssetID: ${object.assetId})`
        : `素材：${object.name} (AssetID: ${object.assetId})`,
    );
  }
  return [
    "⚠️ 删除/修改冲突（需人工决策）",
    "",
    ...identityLines,
    `文件：${info.path}`,
    "",
    conflictTypeLine(info),
    "",
    "一侧分支删除了该文件，另一侧修改（或双方都删除）。需要人工决策保留还是删除：",
    `  保留文件：git checkout <分支或提交> -- ${info.path} 后 git add ${info.path}`,
    `  确认删除：git rm ${info.path}`,
  ].join("\n");
}

/** 反查失败（unknown）的降级模板。 */
function formatUnknown(info: ConflictInfo): string {
  return [
    "⚠️ 未识别的冲突文件",
    "",
    `文件：${info.path}`,
    "",
    conflictTypeLine(info),
    "",
    `反查失败：${info.fallbackReason ?? "(未提供原因)"}`,
    "请人工确认该文件属于哪个牌堆 / 对象，再决定保留哪一侧版本。",
  ].join("\n");
}

/**
 * 把单个 ConflictInfo 格式化成用户可读的多行中文文本。
 *
 * 各 type 的模板见模块内 formatXxx 函数；card-image / object-asset / script /
 * ui / deleted-modified 模板给出的 checkout --ours / --theirs / git rm 等命令
 * 只是"可选操作提示"，本模块绝不代用户执行（不自动选边）。
 *
 * @param info analyzeConflicts 输出的单条冲突
 * @returns 多行文本（LF 换行，无尾随换行）
 */
export function formatConflict(info: ConflictInfo): string {
  switch (info.type) {
    case "card-image":
      return formatCardImage(info);
    case "cards-csv":
      return formatCardsCsv(info);
    case "deck-yaml":
      return formatDeckYaml(info);
    case "object-asset":
      return formatObjectAsset(info);
    case "script":
    case "ui":
      return formatTextAsset(info);
    case "deleted-modified":
      return formatDeletedModified(info);
    case "unknown":
      return formatUnknown(info);
  }
}
