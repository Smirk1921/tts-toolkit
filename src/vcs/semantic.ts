// src/vcs/semantic.ts
/**
 * 语义化状态分析（`tts vcs status` 等命令的数据层）：把 git 的文件级状态输出
 * 翻译成图包语言。
 *
 * 职责：
 * - {@link analyzeStatus}：对图包根跑 `git status --porcelain -z`（经由
 *   {@link statusPorcelain}），把每个改动文件按路径前缀反查归类成
 *   {@link SemanticChangeKind}，再按 kind + subject 聚合成 {@link SemanticChange}，
 *   附上人类可读的中文摘要（{@link SemanticStatus}）；
 * - 例：`decks/冒险牌堆/001_正面.png` 与 `003_正面.png` 改动 →
 *   「冒险牌堆 2 张卡换图（001_正面.png, 003_正面.png）」；
 *   `scripts/Global.lua` 改 +42/-7 行 → 「Global 脚本 +42/-7 行」。
 *
 * 分类规则（输入为相对 pack 根的 POSIX 风格路径，即 GitStatusEntry.path）：
 * 1. `decks/<deckName>/cards.csv` → deck-cards-csv；`decks/<deckName>/deck.yaml` →
 *    deck-yaml（subject 均为 deckName）；
 * 2. `decks/<deckName>/<图片>` → 读 `<deckDir>/cards.csv`（经 readCardsCsv）反查
 *    face / back 两列：命中 → deck-cards（cardFile 累积）；cards.csv 缺失、解析
 *    失败或文件不在表中 → unknown；
 * 3. `objects/<file>` → 读 pack 根 objects.csv（经 readObjectsCsv）反查 file 列
 *    （file 是相对 pack 根的路径，即 `objects/<file>`）：命中 → object-asset
 *    （subject = assetId）；否则 unknown；
 * 4. `scripts/<file>` / `ui/<file>` → script / ui，subject 按 B1 layout 的落盘
 *    命名规则反推：`Global.lua` / `Global.xml` → "Global"；`<guid>.<name>.<ext>`
 *    → name（去掉扩展名后取首个 "." 之后的片段）；无 "." 前缀的散落文件取
 *    去扩展名的文件名本身；
 * 5. `pack.yaml` → pack-yaml；
 * 6. 其余（.gitattributes / .gitignore / source/ / sheets/ / objects.csv 等）→
 *    metadata；`decks/` 下不满足上述形态的散落路径无法反查 → unknown；
 * 7. 反查过程中任何 IO / 解析失败一律降级 unknown，绝不抛错。
 *
 * 未跟踪目录的展开：`git status --porcelain` 把整体未跟踪的目录折叠成单条
 * `?? decks/新牌堆/`——不展开的话"新拉取的牌堆"只能降级成 unknown。本模块递归
 * 列出目录内的文件、逐文件按上述规则分类（xy 沿用目录条目的状态码）；目录读取
 * 失败时该条目按 unknown 兜底。
 *
 * 聚合规则（同 kind + 同 subject 合并为一条 SemanticChange，保持首次出现顺序）：
 * - deck-cards：cardFiles 去重累积，cardCount = 去重后的文件名数
 *   （cardFiles 字段最多保留前 {@link CARD_FILES_SHOWN_LIMIT} 个，摘要同）；
 * - script / ui：added / deleted 求和（deck-cards-csv / pack-yaml 同样带行数）；
 * - 其余 kind：paths 合并（rename 条目把新 / 原两个路径都计入，去重）；
 * - xy：组内出现过的 XY 状态码按首次出现顺序以 "/" 连接（单状态时即原码）。
 *
 * 行数统计（numstat 集成）：
 * - 仅当存在文本类改动（script / ui / deck-cards-csv / pack-yaml）时调**一次**
 *   {@link diffNumstat}；deck-cards / object-asset 是二进制改动，不取行数（省时）；
 * - git diff 无记录的文本改动（未跟踪 / 仅暂存的新增、仅暂存的删除）按工作区
 *   现存文件行数记 added（文件已不存在记 0）——保证 script / ui 的摘要恒有数字；
 * - numstat 报二进制（added / deleted 为 null）按 0 行计；numstat 命令本身失败
 *   （status 已成功时理论上不该发生）降级为"无行数"，不抛错。
 *
 * 性能与容错：
 * - cards.csv / objects.csv 的反查索引在**一次 {@link analyzeStatus} 调用内**缓存
 *   （同 deck / 同台账只读一次，失败结果同样缓存，不重试）；跨调用不缓存，
 *   避免下次分析读到陈旧索引；
 * - 改动文件数（展开未跟踪目录后）超过 {@link LARGE_CHANGE_FILE_COUNT} 时
 *   console.warn 提示，但仍完整分析（不截断、不采样）。
 *
 * 错误处理：
 * - git 层错误原样透传（GIT_NOT_A_REPO / GIT_NOT_FOUND / GIT_COMMAND_FAILED，
 *   见 ../git.ts）——"不是 git 仓库"是调用方必须看到的硬错误；
 * - 反查（cards.csv / objects.csv / 目录展开 / 行数兜底读文件）的任何失败
 *   不抛错，一律降级为 unknown 或 0 行。
 *
 * 本模块离线：不 import 命令层 / with-server.ts / session/*；
 * 错误与摘要消息写死中文，不走 t()（B3 vcs 模块约定）。
 */

import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { CARDS_CSV_FILENAME, readCardsCsv } from "../deck/cards.js";
import { readObjectsCsv } from "../deck/objects.js";
import { DECK_YAML_FILENAME } from "../pack/manifest.js";
import { PACK_YAML_FILENAME } from "../pack/packyaml.js";
import { diffNumstat, statusPorcelain } from "./git.js";
import type { GitStatusEntry, NumstatEntry } from "./git.js";

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** 语义化改动的类别 */
export type SemanticChangeKind =
  | "deck-cards" // 某牌堆 N 张卡换图
  | "deck-cards-csv" // 卡表改动
  | "deck-yaml" // deck.yaml 改动
  | "object-asset" // objects/ 下素材改动
  | "script" // 脚本改动（含行数）
  | "ui" // UI 改动（含行数）
  | "pack-yaml" // pack.yaml 改动
  | "metadata" // 其他元数据（.gitattributes 等）
  | "unknown"; // 反查失败的降级

/** 一条聚合后的语义化改动 */
export interface SemanticChange {
  kind: SemanticChangeKind;
  /** 人类可读摘要，如 "冒险牌堆 3 张卡换图"（中文，写死不走 t()） */
  summary: string;
  /** 牌堆名 / 对象 assetId / 脚本名（Global 或对象名），kind 决定 */
  subject?: string;
  /** 卡牌相关：改动的卡数（kind=deck-cards 时） */
  cardCount?: number;
  /** 卡牌相关：改动的卡面文件名列表（前 5 个） */
  cardFiles?: string[];
  /** 文本改动：added 行数（script / ui 恒有值；deck-cards-csv / pack-yaml 有 numstat 或兜底行数时携带） */
  added?: number;
  /** 文本改动：deleted 行数（同上） */
  deleted?: number;
  /** 改动的原始文件路径列表（相对 pack 根，POSIX 分隔；rename 条目含新 / 原两个路径） */
  paths: string[];
  /** git XY 状态码（" M" / "A " / "D " / "??" / "UU" 等）；组内多状态时按首次出现顺序以 "/" 连接 */
  xy: string;
}

/** {@link analyzeStatus} 的返回结果 */
export interface SemanticStatus {
  /** 是否有改动（git status 有任何输出即 true，含未跟踪文件） */
  dirty: boolean;
  /** 按 kind + subject 分组后的语义化列表（保持状态输出的首次出现顺序） */
  changes: SemanticChange[];
  /** 反查失败降级为 unknown 的数量（unknown 分组内的改动文件总数，非分组数） */
  unknownCount: number;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 图包根下的牌堆目录名（与 src/pack/layout.ts 的内部常量一致；layout 未导出，按分类规则字面定义） */
const DIR_DECKS = "decks";

/** 图包根下的对象素材目录名（同上） */
const DIR_OBJECTS = "objects";

/** 图包根下的脚本目录名（同上） */
const DIR_SCRIPTS = "scripts";

/** 图包根下的 UI 目录名（同上） */
const DIR_UI = "ui";

/** 全局脚本的落盘文件名（B1 layout 命名规则：GUID 为 "-1" 时固定为 Global.lua） */
const GLOBAL_SCRIPT_FILENAME = "Global.lua";

/** 全局 UI 的落盘文件名（同上：Global.xml） */
const GLOBAL_UI_FILENAME = "Global.xml";

/** cardFiles 字段与摘要最多展示的卡面文件名个数 */
const CARD_FILES_SHOWN_LIMIT = 5;

/** 大改动量提示阈值：改动文件数（展开未跟踪目录后）超过该值时 console.warn，仍完整分析 */
const LARGE_CHANGE_FILE_COUNT = 1000;

/** 需要统计行数（查 numstat）的文本类 kind；二进制类（deck-cards / object-asset）不取行数 */
const LINE_COUNT_KINDS: ReadonlySet<SemanticChangeKind> = new Set<SemanticChangeKind>([
  "script",
  "ui",
  "deck-cards-csv",
  "pack-yaml",
]);

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

/** 单个改动文件的分类结果（聚合前的中间形态） */
interface Classification {
  kind: SemanticChangeKind;
  subject?: string;
  /** kind=deck-cards 时命中的卡面文件名（face / back 列的值，相对 deck 目录） */
  cardFile?: string;
}

/** 同 kind + subject 的聚合分组（聚合后的可变中间形态） */
interface ChangeGroup {
  kind: SemanticChangeKind;
  subject?: string;
  /** 改动文件路径（POSIX、去重、含 rename 的原路径） */
  paths: Set<string>;
  /** deck-cards 的卡面文件名（去重累积） */
  cardFiles: Set<string>;
  /** 文本类 kind 的行数累计 */
  added: number;
  deleted: number;
  /** 组内出现过的 XY 状态码（去重） */
  xySeen: Set<string>;
  /** XY 状态码按首次出现顺序 */
  xyCodes: string[];
}

/** cards.csv / objects.csv 反查索引（一次 analyzeStatus 调用内共用） */
interface ReverseLookup {
  /** `<deckDir>/cards.csv` 的 face / back 列是否含指定文件名（索引失败时恒 false） */
  deckHasCard(deckName: string, fileName: string): Promise<boolean>;
  /** objects.csv 的 file 列 → assetId；未命中返回 null（索引失败时恒 null） */
  assetIdForFile(relPath: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 校验图包根路径入参（防止空串被 path.join / 子进程 cwd 静默解析成别的目录）。
 * @param root 图包根目录
 * @returns 校验通过的原路径（原样返回，不做 resolve）
 * @throws root 不是非空字符串时抛出中文错误（调用方编程错误）
 */
function assertRoot(root: string): string {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error("vcs 语义分析入参无效：packRoot 必须是非空字符串路径");
  }
  return root;
}

/**
 * 把路径统一成 POSIX 分隔（git 在 Windows 上本就输出 "/"，此处只是防御性归一）。
 * @param relPath 相对路径
 * @returns "/" 分隔的路径
 */
function toPosix(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

/**
 * 把相对 pack 根的 POSIX 路径换算成平台路径（读文件 / 列目录用）。
 * @param packRoot 图包根目录
 * @param relPosix 相对路径（"/" 分隔）
 * @returns 平台完整路径
 */
function toPlatformPath(packRoot: string, relPosix: string): string {
  return path.join(packRoot, ...relPosix.split("/"));
}

/**
 * 从 scripts/ / ui/ 的落盘文件名反推展示名（B1 layout 命名规则的逆运算）。
 *
 * 规则：`Global.lua` / `Global.xml` → "Global"；`<guid>.<name>.<ext>` → name
 * （去掉扩展名后取首个 "." 之后的片段，name 本身经 sanitizeName 可能含 "_"）；
 * 无 "." 前缀的散落文件取去扩展名的文件名本身。
 *
 * @param fileName 文件名（不含目录）
 * @returns 展示用 subject
 */
function objectFileSubject(fileName: string): string {
  if (fileName === GLOBAL_SCRIPT_FILENAME || fileName === GLOBAL_UI_FILENAME) {
    return "Global";
  }
  const stem = fileName.replace(/\.[^.]*$/, "");
  if (stem === "") {
    return fileName; // 全是扩展名的畸形名（如 ".gitkeep"）：原样保留
  }
  const dot = stem.indexOf(".");
  return dot >= 0 ? stem.slice(dot + 1) : stem;
}

// ---------------------------------------------------------------------------
// 反查索引（一次 analyzeStatus 调用内的缓存）
// ---------------------------------------------------------------------------

/**
 * 创建本次分析共用的 cards.csv / objects.csv 反查索引。
 *
 * - 同一 deck 的 cards.csv 只在第一次遇到时读一次（含解析失败 / 缺失的负缓存）；
 * - pack 根 objects.csv 只读一次（含失败缓存）；
 * - 任何读取 / 解析失败都吞掉并按"未命中"处理，绝不抛错。
 *
 * @param packRoot 图包根目录
 * @returns 反查接口
 */
function createReverseLookup(packRoot: string): ReverseLookup {
  /** deckName → cards.csv 的 face/back 文件名集合；ok=false 表示 cards.csv 缺失或解析失败 */
  const deckIndexCache = new Map<string, { ok: true; files: Set<string> } | { ok: false }>();
  /** objects.csv 反查索引：file（相对 pack 根）→ assetId */
  const objectsIndex: { done: boolean; byFile: Map<string, string> } = { done: false, byFile: new Map() };

  return {
    async deckHasCard(deckName: string, fileName: string): Promise<boolean> {
      let index = deckIndexCache.get(deckName);
      if (index === undefined) {
        try {
          const rows = await readCardsCsv(path.join(packRoot, DIR_DECKS, deckName));
          const files = new Set<string>();
          for (const row of rows) {
            if (row.face !== "") {
              files.add(row.face);
            }
            if (row.back !== undefined && row.back !== "") {
              files.add(row.back);
            }
          }
          index = { ok: true, files };
        } catch {
          // CARDS_NOT_FOUND / CARDS_INVALID / 其他 IO 失败：该 deck 全部图片降级 unknown
          index = { ok: false };
        }
        deckIndexCache.set(deckName, index);
      }
      return index.ok && index.files.has(fileName);
    },

    async assetIdForFile(relPath: string): Promise<string | null> {
      if (!objectsIndex.done) {
        try {
          const rows = await readObjectsCsv(packRoot);
          for (const row of rows) {
            if (row.file !== "" && !objectsIndex.byFile.has(row.file)) {
              objectsIndex.byFile.set(row.file, row.assetId);
            }
          }
        } catch {
          // OBJECTS_NOT_FOUND / OBJECTS_INVALID / 其他 IO 失败：全部素材降级 unknown
        }
        objectsIndex.done = true;
      }
      return objectsIndex.byFile.get(relPath) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

/**
 * 按路径前缀把单个改动文件分类（反查失败一律 unknown，不抛错）。
 * @param relPath 相对 pack 根的改动路径（git 输出，POSIX 风格）
 * @param lookup 本次分析的反查索引
 * @returns 分类结果
 */
async function classifyPath(relPath: string, lookup: ReverseLookup): Promise<Classification> {
  const posix = toPosix(relPath);
  if (posix === PACK_YAML_FILENAME) {
    return { kind: "pack-yaml" };
  }
  if (posix.endsWith("/")) {
    // 目录条目（仅当未跟踪目录展开失败时才会走到这里）：无法逐文件分类
    return { kind: "unknown" };
  }

  const segments = posix.split("/");
  const top = segments[0];

  if (top === DIR_DECKS) {
    if (segments.length < 3) {
      // decks/ 本身或 decks 下直接散落的文件：无法按牌堆反查
      return { kind: "unknown" };
    }
    const deckName = segments[1];
    const fileName = segments.slice(2).join("/");
    if (fileName === CARDS_CSV_FILENAME) {
      return { kind: "deck-cards-csv", subject: deckName };
    }
    if (fileName === DECK_YAML_FILENAME) {
      return { kind: "deck-yaml", subject: deckName };
    }
    const hit = await lookup.deckHasCard(deckName, fileName);
    return hit ? { kind: "deck-cards", subject: deckName, cardFile: fileName } : { kind: "unknown" };
  }

  if (top === DIR_OBJECTS && segments.length >= 2) {
    const assetId = await lookup.assetIdForFile(segments.join("/"));
    return assetId !== null ? { kind: "object-asset", subject: assetId } : { kind: "unknown" };
  }

  if (top === DIR_SCRIPTS && segments.length >= 2) {
    return { kind: "script", subject: objectFileSubject(segments[segments.length - 1]) };
  }

  if (top === DIR_UI && segments.length >= 2) {
    return { kind: "ui", subject: objectFileSubject(segments[segments.length - 1]) };
  }

  return { kind: "metadata" };
}

// ---------------------------------------------------------------------------
// 未跟踪目录展开
// ---------------------------------------------------------------------------

/**
 * 递归列出目录下的全部普通文件（相对 pack 根、POSIX 分隔、按文件名排序保证确定）。
 * @param packRoot 图包根目录
 * @param relDir 相对目录路径（可带尾部 "/"）
 * @returns 文件相对路径列表；目录读取失败时 null（调用方按 unknown 兜底）
 */
async function listFilesUnder(packRoot: string, relDir: string): Promise<string[] | null> {
  const baseRel = relDir.replace(/\/+$/, "");
  const collected: string[] = [];
  const walk = async (rel: string): Promise<boolean> => {
    let dirents: Dirent[];
    try {
      dirents = await readdir(toPlatformPath(packRoot, rel), { withFileTypes: true });
    } catch {
      return false; // 目录被删 / 权限不足等：整体放弃该条目
    }
    // 按文件名排序（码元序），保证展开顺序跨机器确定
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) {
        continue; // 符号链接（含 Windows junction）不跟进，防循环（与 src/vcs/size.ts 同口径）
      }
      const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (!(await walk(childRel))) {
          return false;
        }
      } else if (dirent.isFile()) {
        collected.push(childRel);
      }
    }
    return true;
  };
  return (await walk(baseRel)) ? collected : null;
}

/**
 * 把 status 条目里的目录条目（尾部 "/"，来自整体未跟踪的目录折叠）展开为
 * 其中的文件条目（xy 沿用目录条目）；展开失败时原样保留，由分类阶段兜底 unknown。
 * @param packRoot 图包根目录
 * @param entries statusPorcelain 的原始条目
 * @returns 展开后的文件级条目列表
 */
async function expandUntrackedDirs(
  packRoot: string,
  entries: readonly GitStatusEntry[],
): Promise<GitStatusEntry[]> {
  const fileEntries: GitStatusEntry[] = [];
  for (const entry of entries) {
    if (!entry.path.endsWith("/")) {
      fileEntries.push(entry);
      continue;
    }
    const files = await listFilesUnder(packRoot, entry.path);
    if (files === null) {
      fileEntries.push(entry);
    } else {
      for (const rel of files) {
        fileEntries.push({ xy: entry.xy, path: rel });
      }
    }
  }
  return fileEntries;
}

// ---------------------------------------------------------------------------
// 行数统计
// ---------------------------------------------------------------------------

/**
 * 数工作区现存文件的行数（numstat 无记录时的兜底：未跟踪 / 仅暂存的新增文件）。
 * 按 "\n" 计数，末行无换行符也算一行；文件不存在（如仅暂存的删除）或不可读记 0。
 * @param filePath 平台完整路径
 * @returns 行数；任何读取失败返回 0
 */
async function countLines(filePath: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return 0;
  }
  if (text.length === 0) {
    return 0;
  }
  let lines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
    }
  }
  if (text.charCodeAt(text.length - 1) !== 10) {
    lines += 1;
  }
  return lines;
}

/**
 * 给文本类分组（{@link LINE_COUNT_KINDS}）累计 added / deleted 行数。
 *
 * 优先用一次 `diffNumstat`（工作区 vs 暂存区）的逐文件计数；git diff 无记录的
 * 路径（未跟踪 / 仅暂存）按工作区现存文件行数记 added；numstat 报二进制按 0 行。
 * 非文本类分组（deck-cards / object-asset / …）不动——二进制改动不数行。
 *
 * @param packRoot 图包根目录
 * @param groups 聚合分组（原地写入 added / deleted）
 */
async function applyLineCounts(packRoot: string, groups: ReadonlyMap<string, ChangeGroup>): Promise<void> {
  let needsNumstat = false;
  for (const group of groups.values()) {
    if (LINE_COUNT_KINDS.has(group.kind)) {
      needsNumstat = true;
      break;
    }
  }
  if (!needsNumstat) {
    return; // 纯二进制改动：省掉一次 git diff 子进程
  }

  const numstatByPath = new Map<string, NumstatEntry>();
  try {
    for (const item of await diffNumstat(packRoot)) {
      numstatByPath.set(item.path, item);
    }
  } catch {
    // status 已成功时 numstat 理论上不该失败；万一失败降级为"无行数"，不抛错
  }

  for (const group of groups.values()) {
    if (!LINE_COUNT_KINDS.has(group.kind)) {
      continue;
    }
    for (const rel of group.paths) {
      const entry = numstatByPath.get(rel);
      if (entry !== undefined) {
        group.added += entry.added ?? 0;
        group.deleted += entry.deleted ?? 0;
      } else {
        group.added += await countLines(toPlatformPath(packRoot, rel));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

/**
 * 按 kind 生成中文摘要（模板写死，不走 t()）。
 * @param group 聚合分组（added / deleted / cardFiles 已就位）
 * @returns 摘要文本
 */
function buildSummary(group: ChangeGroup): string {
  const subject = group.subject ?? "";
  switch (group.kind) {
    case "deck-cards": {
      const cardFiles = [...group.cardFiles];
      const count = cardFiles.length;
      const shown = cardFiles.slice(0, CARD_FILES_SHOWN_LIMIT).join(", ");
      return `${subject} ${count} 张卡换图（${shown}${count > CARD_FILES_SHOWN_LIMIT ? "…" : ""}）`;
    }
    case "deck-cards-csv":
      return `${subject} 卡表改动`;
    case "deck-yaml":
      return `${subject} 元数据改动`;
    case "object-asset":
      return `素材 ${subject} 改动`;
    case "script":
      return `${subject} 脚本 +${group.added}/-${group.deleted} 行`;
    case "ui":
      return `${subject} UI +${group.added}/-${group.deleted} 行`;
    case "pack-yaml":
      return "pack.yaml 改动";
    case "metadata":
      return `元数据改动（${group.paths.size} 个文件）`;
    case "unknown":
      return `其他改动（${group.paths.size} 个文件）`;
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 分析图包根目录的 git 状态，返回语义化报告。
 *
 * 流程：`git status --porcelain -z`（经 {@link statusPorcelain}）→ 展开未跟踪
 * 目录条目 → 逐文件分类（cards.csv / objects.csv 反查，调用内缓存）→ 按
 * kind + subject 聚合 → 文本类补行数（一次 {@link diffNumstat} + 兜底行数）→
 * 生成中文摘要。
 *
 * @param packRoot 图包工作区根目录（必须是 git 仓库工作树）
 * @returns 语义化状态报告
 * @throws PackError code="GIT_NOT_A_REPO" packRoot 不是 git 仓库工作树时
 * @throws PackError code="GIT_NOT_FOUND" git 不在 PATH 时
 * @throws PackError code="GIT_COMMAND_FAILED" git status 本身失败时
 * @throws Error packRoot 不是非空字符串时（调用方编程错误）
 */
export async function analyzeStatus(packRoot: string): Promise<SemanticStatus> {
  assertRoot(packRoot);
  const entries = await statusPorcelain(packRoot);

  // 1. 展开未跟踪目录条目（"??" 形如 "decks/新牌堆/"），得到文件级条目
  const fileEntries = await expandUntrackedDirs(packRoot, entries);
  if (fileEntries.length > LARGE_CHANGE_FILE_COUNT) {
    console.warn(`图包改动量较大（${fileEntries.length} 个文件），语义分析可能较慢，仍将完整分析`);
  }

  // 2. 逐文件分类，并按 kind + subject 聚合（保持首次出现顺序）
  const lookup = createReverseLookup(packRoot);
  const groups = new Map<string, ChangeGroup>();
  for (const entry of fileEntries) {
    const classified = await classifyPath(entry.path, lookup);
    const key = `${classified.kind}\u0000${classified.subject ?? ""}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        kind: classified.kind,
        subject: classified.subject,
        paths: new Set<string>(),
        cardFiles: new Set<string>(),
        added: 0,
        deleted: 0,
        xySeen: new Set<string>(),
        xyCodes: [],
      };
      groups.set(key, group);
    }
    group.paths.add(toPosix(entry.path));
    if (entry.origPath !== undefined) {
      group.paths.add(toPosix(entry.origPath)); // rename：新 / 原路径都算改动足迹
    }
    if (classified.cardFile !== undefined) {
      group.cardFiles.add(classified.cardFile);
    }
    if (!group.xySeen.has(entry.xy)) {
      group.xySeen.add(entry.xy);
      group.xyCodes.push(entry.xy);
    }
  }

  // 3. 文本类分组补行数（一次 numstat + 兜底行数）；二进制分组不数行
  await applyLineCounts(packRoot, groups);

  // 4. 生成 SemanticChange 列表与摘要
  const changes: SemanticChange[] = [];
  let unknownCount = 0;
  for (const group of groups.values()) {
    const paths = [...group.paths];
    const change: SemanticChange = {
      kind: group.kind,
      summary: buildSummary(group),
      paths,
      xy: group.xyCodes.join("/"),
    };
    if (group.subject !== undefined) {
      change.subject = group.subject;
    }
    if (group.kind === "deck-cards") {
      change.cardCount = group.cardFiles.size;
      change.cardFiles = [...group.cardFiles].slice(0, CARD_FILES_SHOWN_LIMIT);
    }
    if (LINE_COUNT_KINDS.has(group.kind)) {
      change.added = group.added;
      change.deleted = group.deleted;
    }
    changes.push(change);
    if (group.kind === "unknown") {
      unknownCount += paths.length;
    }
  }

  return { dirty: entries.length > 0, changes, unknownCount };
}
