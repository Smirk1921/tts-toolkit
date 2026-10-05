// src/pack/diff.ts
/**
 * diffWorkspace：对比图包工作区与运行中 TTS 当前存档的脚本 / UI 差异（只读操作）。
 *
 * 职责：
 * - 校验工作区（{@link readPackYaml}）；
 * - 连接 TTS 取游戏侧脚本快照（{@link withEditorServer} → SessionScripts.getScripts）；
 * - 扫描本地 scripts/ 与 ui/ 目录（命名规则见 src/pack/layout.ts）；
 * - 按 guid + kind 比较两侧内容，产出 {@link DiffResult}；
 * - `includeHunks` 为 true 时为 modified 条目计算逐行 unified diff hunks
 *   （{@link computeHunks}）。
 *
 * 状态语义（方向以「游戏侧相对本地工作区」为准，与任务约定一致）：
 *
 * | status   | 含义               | 表现                                             |
 * | -------- | ------------------ | ------------------------------------------------ |
 * | added    | 游戏有本地无       | TTS 当前存档有该脚本 / UI，工作区没有对应文件     |
 * | deleted  | 本地有游戏无       | 工作区有文件，TTS 当前存档没有该脚本 / UI         |
 * | modified | 两边都有但内容不同 | 归一化后内容不同                                  |
 *
 * 两边都有且内容一致 → 不产生条目、不计入任何计数。{@link DiffResult.added}
 * 等三个计数都是**条目数**：同一 GUID 的脚本与 UI 各算一项。
 *
 * 比较规则（避免误报）：
 * - 内容先归一化再比较：CRLF / 单独 CR 一律折成 LF，再去掉结尾空白（trimEnd）——
 *   编辑器换行风格与结尾空行差异不算 modified；
 * - 游戏侧字段缺省（script / ui 为 undefined）视为「游戏侧没有」：本地有文件即
 *   deleted（与 TTS 协议「缺省即删除」的语义一致），本地也没有则不产生条目。
 *
 * 逐行差异（阶段 5 扩展，unified diff）：
 * - `DiffOptions.includeHunks` 为 true 时，modified 条目额外携带 `hunks`
 *   （{@link DiffHunk} 列表）：按 LCS 行对齐把两侧文本切成若干差异块，每块给出
 *   两侧起始行号（1 基）与该块的行内容（含前后各 3 行上下文，同 GNU diff -U3）；
 * - 方向约定：localLines 是本地工作区的行，remoteLines 是游戏侧（远端）的行；
 * - 算法：Hirschberg 分治 LCS（时间 O(n·m)、空间 O(n+m)），不引入 npm 依赖，
 *   见 {@link computeHunks}；平局取第一个最大分叉点，同一输入结果完全确定；
 * - 保护：归一化后任一侧超过 5000 行则跳过（hunks 字段缺省），避免超大文件的
 *   O(n·m) 耗时；added / deleted 不算 hunks（整文件新增 / 删除，无需逐行）；
 * - 间隔不超过 6 行（2×上下文）的相邻改动合并为一个 hunk，减少碎片。
 *
 * 本地索引规则（与 build.ts / pull.ts 的落盘命名约定保持一致）：
 * - 只收 scripts/ 下的 `.lua` 与 ui/ 下的 `.xml` 普通文件；
 * - `Global.lua` / `Global.xml` → GUID "-1"（{@link GLOBAL_GUID}），与普通对象
 *   同等参与对比，不是特例；
 * - 其余文件名取首个 "." 之前的片段为 GUID（`<guid>.<净化名>.<扩展名>`），
 *   绝不解析名字部分；
 * - 无 "." 前缀的散落文件无法归属任何对象，静默忽略；
 * - 同一 GUID 出现多个候选文件（如手工复制出的备份）时只取文件名码元序最小者，
 *   保证结果确定（与 build.ts「多候选取字典序第一个」的取舍一致）；
 * - scripts/ 或 ui/ 目录不存在按「本地没有」处理（空工作区，不算错误）。
 *
 * 名称来源：游戏侧存在的条目一律用游戏侧的 name；仅本地存在的条目用文件名里的
 * 名字段重建——该字段是 sanitizeName 之后的形态（空白已变下划线、非法字符已删），
 * 因此重建名可能与用户原始对象名有出入，仅作展示用。
 *
 * 排序：条目按 GUID 排序（纯整数 GUID 按数值升序，"-1" 即 Global 排最前；其余按
 * UTF-16 码元顺序，不依赖运行时 locale，保证跨机器确定）；同一 GUID 内
 * script 排在 ui 之前。
 *
 * 设计边界：
 * - 本模块**只读**：不写任何文件，不调用 saveAndPlay（约束 7：回写脚本 / UI 是
 *   push 的职责，diff 从不推送）；
 * - 需要记录「同一 GUID 多个候选文件」等不中断问题时可复用扫描逻辑，但
 *   {@link DiffResult} 按任务契约不含 warnings 字段，本模块不额外承载。
 *
 * 错误码（{@link PackError.code}）：
 * - "DIFF_FAILED" 扫描 scripts/ ui/ 目录失败，或读取本地脚本 / UI 文件失败
 * - pack.yaml 的问题原样透传（PACK_NOT_FOUND / PACK_INVALID / PACK_READ_FAILED）
 * - 端口占用 / 连不上 TTS / 等待回推超时等由 withEditorServer 与 SessionScripts
 *   原样抛出，交由 CLI 统一映射文案
 *
 * 本模块新增的 i18n 键（locales/*.json 由 Run 2 的本地化步骤补齐；缺键时 t()
 * 原样输出键名）：
 * - `error.pack.diff.scanFailed` {path} {detail}
 * - `error.pack.diff.readFailed` {path} {detail}
 *
 * 阶段 5 的逐行 hunks 扩展不产生新的用户可见文案，未新增 i18n 键。
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { withEditorServer } from "../cli/with-server.js";
import { t } from "../i18n/index.js";
import { GLOBAL_GUID } from "../protocol/messages.js";
import { SessionScripts, type ScriptState } from "../session/scripts.js";
import { scriptsDir, uiDir } from "./layout.js";
import { PackError, readPackYaml } from "./packyaml.js";

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/**
 * 一个逐行差异块（unified diff 的 hunk）。
 *
 * 由同一次 LCS 行对齐切出：块内两侧的上下文行内容一致，变动行按方向分列在
 * localLines / remoteLines 中。仅当 status === "modified" 且
 * DiffOptions.includeHunks 为 true 时由 {@link diffWorkspace} 填充到
 * {@link DiffEntry.hunks}；added / deleted 不产生 hunks（整文件新增 / 删除）。
 */
export interface DiffHunk {
  /** 本地起始行号（1 基；纯新增块本地无行时取插入点之后的行号） */
  localStart: number;
  /** 本地行（含上下文与变动；纯新增块为空数组） */
  localLines: string[];
  /** 远端（游戏侧）起始行号（1 基；纯删除块远端无行时取插入点之后的行号） */
  remoteStart: number;
  /** 远端行（含上下文与变动；纯删除块为空数组） */
  remoteLines: string[];
}

/**
 * 一条差异。
 *
 * status 的方向以「游戏侧相对本地工作区」为准（见模块头注释）：
 * - "added"    游戏有本地无；
 * - "deleted"  本地有游戏无；
 * - "modified" 两边都有但内容不同。
 */
export interface DiffEntry {
  /** 对象 GUID（"-1" 为全局脚本 / 全局 UI） */
  guid: string;
  /**
   * 展示用对象名：游戏侧存在该 GUID 时用游戏侧 name；
   * 仅本地存在（status="deleted"）时用本地文件名重建的净化名（可能不精确）。
   */
  name: string;
  /** 差异对象类型：Lua 脚本或 UI XML */
  kind: "script" | "ui";
  /** 差异方向（见接口说明） */
  status: "added" | "modified" | "deleted";
  /** 本地对应文件的绝对路径；仅当本地存在该文件（modified / deleted）时携带 */
  localPath?: string;
  /**
   * 逐行差异（unified diff hunks，见 {@link DiffHunk}）。
   * 仅 status === "modified" 且 opts.includeHunks 为 true 时填充；
   * 归一化后任一侧超过 5000 行时省 CPU 跳过（字段缺省）。
   */
  hunks?: DiffHunk[];
}

/** diffWorkspace 的返回结果 */
export interface DiffResult {
  /** 全部差异条目（按 GUID 排序，同一 GUID 内 script 在 ui 之前） */
  entries: DiffEntry[];
  /** 游戏有本地无的条目数 */
  added: number;
  /** 两边都有但内容不同的条目数 */
  modified: number;
  /** 本地有游戏无的条目数 */
  deleted: number;
}

/** diffWorkspace 的入参 */
export interface DiffOptions {
  /** 图包工作区根目录（相对路径会先 resolve；相对路径按当前工作目录解析） */
  root: string;
  /** 等待 TTS 回推 GameLoaded 的超时（毫秒）；缺省由 SessionScripts 决定（30 秒） */
  timeoutMs?: number;
  /**
   * 可选的已绑定编辑器端口服务器（阶段 4 hub 注入用）。
   *
   * 缺省时本函数经 withEditorServer 临时独占 39998；hub 路由处理器必须传入
   * daemon.server（hub 已持有 39998），避免二次独占触发 PortInUseError。
   */
  server?: import("../protocol/editor-server.js").EditorServer;
  /**
   * 是否为 modified 条目计算逐行 hunks（默认 false，省 CPU）。
   * 结果写入 {@link DiffEntry.hunks}；added / deleted 条目不受影响。
   */
  includeHunks?: boolean;
}

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

/** 本地工作区里一个 GUID 对应的脚本 / UI 文件 */
interface LocalFile {
  /** 文件的绝对路径（resolve 后的 root 与目录名拼接） */
  filePath: string;
  /** 文件内容（UTF-8，仅用于比较，绝不回写） */
  content: string;
  /** 从文件名重建的对象名（sanitizeName 后的形态，仅作展示兜底） */
  name: string;
}

/** 比较时的对象类型（DiffEntry.kind 的别名） */
type DiffKind = DiffEntry["kind"];

// ---------------------------------------------------------------------------
// 内部工具
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

/** 纯整数 GUID（可带负号）判定；TTS 的对象 GUID 实际都是这种形态 */
const INTEGER_GUID_RE = /^-?\d+$/;

/**
 * GUID 排序比较器：纯整数按数值升序（"-1" 即 Global 排最前），
 * 其余按码元序；整数与非整数混排时整数在前。
 * @param a 左 GUID
 * @param b 右 GUID
 * @returns 负数 / 0 / 正数，语义同 Array.prototype.sort 的比较器
 */
function compareGuids(a: string, b: string): number {
  const aIsInt = INTEGER_GUID_RE.test(a);
  const bIsInt = INTEGER_GUID_RE.test(b);
  if (aIsInt && bIsInt) {
    const diff = Number(a) - Number(b);
    // 超大整数（超出 IEEE-754 精度）可能算出 0，再用码元序兜底保证全序
    return diff !== 0 ? diff : compareCodeUnits(a, b);
  }
  if (aIsInt) {
    return -1;
  }
  if (bIsInt) {
    return 1;
  }
  return compareCodeUnits(a, b);
}

/**
 * 从本地脚本 / UI 文件名提取 GUID（只取首个 "." 之前的片段，绝不解析名字部分）。
 *
 * 规则与 src/pack/build.ts 的 guidFromFileName 一致：
 * "Global.lua" / "Global.xml" → "-1"；"<guid>.<净化名>.lua" → guid；
 * 无 "." 前缀的散落文件返回 undefined（不参与匹配）。
 *
 * @param fileName 文件名（不含目录，如 "aa11bb.测试牌堆.lua"）
 * @param ext 扩展名（含点：".lua" 或 ".xml"）
 * @returns GUID；无法归属时返回 undefined
 */
function guidFromFileName(fileName: string, ext: ".lua" | ".xml"): string | undefined {
  if (fileName === `Global${ext}`) {
    return GLOBAL_GUID;
  }
  const dot = fileName.indexOf(".");
  if (dot <= 0) {
    return undefined;
  }
  return fileName.slice(0, dot);
}

/**
 * 从本地文件名重建对象名（仅用于「游戏侧没有该 GUID」的条目展示）。
 *
 * 名字段是 sanitizeName 之后的形态：空白已变下划线、非法字符已删除，
 * 因此重建名可能与用户原始对象名有出入，只作展示用。
 *
 * @param fileName 文件名（不含目录）
 * @param ext 扩展名（含点）
 * @returns 名字段；文件名为 Global.lua / Global.xml 时返回 "Global"；
 *   没有名字段（如 "abc123.lua"）时退化为文件名主干
 */
function nameFromFileName(fileName: string, ext: ".lua" | ".xml"): string {
  if (fileName === `Global${ext}`) {
    return "Global";
  }
  const stem = fileName.slice(0, fileName.length - ext.length);
  const dot = stem.indexOf(".");
  if (dot >= 0 && dot < stem.length - 1) {
    return stem.slice(dot + 1);
  }
  return stem;
}

/**
 * 内容比较前的归一化：CRLF / 单独 CR 一律折成 LF，再去掉结尾空白。
 *
 * 目的：编辑器 / 平台的换行风格差异（CRLF vs LF）与结尾空行差异不应被
 * 报成 modified；行内空白与大小写保持原样，绝不做更"聪明"的等价判断。
 *
 * 阶段 5 起导出：baseline / push 等模块需要与 diff 相同的归一化语义时直接
 * 复用本函数，禁止再复制实现（此前 src/safety/baseline.ts 持有一份私有副本）。
 *
 * @param text 原始内容
 * @returns 归一化后的内容（仅用于比较，不落盘）
 */
export function normalizeContent(text: string): string {
  return text.replace(/\r\n?/g, "\n").trimEnd();
}

/**
 * 扫描 scripts/ 或 ui/ 目录，按 GUID 建立本地文件索引。
 *
 * 目录不存在 → 空索引（本地没有内容，不算错误）；读取单个文件失败 →
 * 抛 {@link PackError}（显式报错，绝不把"读不到"静默当成"没有"而误报差异）。
 *
 * @param dir 目录绝对路径（scriptsDir(root) 或 uiDir(root)）
 * @param ext 扩展名（含点：".lua" 或 ".xml"）
 * @returns guid → 本地文件信息（同 GUID 多候选取文件名码元序最小者，只保留一个）
 * @throws PackError code="DIFF_FAILED" 目录扫描失败或文件读取失败时
 */
async function scanLocalFiles(dir: string, ext: ".lua" | ".xml"): Promise<Map<string, LocalFile>> {
  let fileNames: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    fileNames = entries.filter((entry) => entry.isFile() && entry.name.endsWith(ext)).map((entry) => entry.name);
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return new Map(); // 目录缺失按空工作区处理
    }
    throw new PackError(
      "DIFF_FAILED",
      t("error.pack.diff.scanFailed", { path: dir, detail: errMessage(err) }),
    );
  }

  fileNames.sort(compareCodeUnits); // 先排序，多候选时"先到先得"即取码元序最小者

  const index = new Map<string, LocalFile>();
  for (const fileName of fileNames) {
    const guid = guidFromFileName(fileName, ext);
    if (guid === undefined) {
      continue; // 散落文件（无 guid 前缀）：不属于任何对象，静默忽略
    }
    if (index.has(guid)) {
      continue; // 同 GUID 多候选：已排序，保留码元序最小者
    }
    const filePath = path.join(dir, fileName);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (err) {
      throw new PackError(
        "DIFF_FAILED",
        t("error.pack.diff.readFailed", { path: filePath, detail: errMessage(err) }),
      );
    }
    index.set(guid, { filePath, content, name: nameFromFileName(fileName, ext) });
  }
  return index;
}

/**
 * 选取条目的展示名：游戏侧 name 优先，其次本地重建名，最后退化到 GUID。
 * @param game 游戏侧脚本状态（无则 undefined）
 * @param local 本地文件（无则 undefined）
 * @param guid 对象 GUID（兜底展示名）
 * @returns 非空的展示名
 */
function pickName(game: ScriptState | undefined, local: LocalFile | undefined, guid: string): string {
  if (game !== undefined && game.name !== "") {
    return game.name;
  }
  if (local !== undefined && local.name !== "") {
    return local.name;
  }
  return guid;
}

/**
 * 比较单个 guid + kind 的两侧内容，产出差异条目。
 *
 * 判定顺序（`gameText === undefined` 表示游戏侧没有该内容，
 * `local === undefined` 表示本地没有对应文件）：
 * 1. 两边都有 → 归一化后相同则无差异（undefined），不同则 modified；
 * 2. 仅游戏侧有 → added（游戏有本地无）；
 * 3. 仅本地有 → deleted（本地有游戏无）；
 * 4. 两边都没有 → 无差异（调用方保证不会以这种组合调用）。
 *
 * @param guid 对象 GUID
 * @param kind "script" 或 "ui"
 * @param game 游戏侧脚本状态（GUID 不存在于游戏侧时 undefined）
 * @param gameText 游戏侧该 kind 的内容（字段缺省时 undefined）
 * @param local 本地该 kind 的文件
 * @param includeHunks 是否为 modified 条目计算逐行 hunks（见 {@link DiffOptions.includeHunks}）
 * @returns 差异条目；无差异时返回 undefined
 */
function compareOne(
  guid: string,
  kind: DiffKind,
  game: ScriptState | undefined,
  gameText: string | undefined,
  local: LocalFile | undefined,
  includeHunks: boolean,
): DiffEntry | undefined {
  const name = pickName(game, local, guid);

  if (gameText !== undefined && local !== undefined) {
    const normalizedGame = normalizeContent(gameText);
    const normalizedLocal = normalizeContent(local.content);
    if (normalizedGame === normalizedLocal) {
      return undefined; // 两边一致：不计入
    }
    const entry: DiffEntry = { guid, name, kind, status: "modified", localPath: local.filePath };
    // 逐行 hunks：仅显式要求时计算；归一化后任一侧超行数上限则跳过（O(n·m) 保护）
    if (
      includeHunks &&
      splitLines(normalizedLocal).length <= HUNK_MAX_LINES &&
      splitLines(normalizedGame).length <= HUNK_MAX_LINES
    ) {
      entry.hunks = computeHunks(normalizedLocal, normalizedGame);
    }
    return entry;
  }
  if (gameText !== undefined) {
    return { guid, name, kind, status: "added" }; // 游戏有本地无
  }
  if (local !== undefined) {
    return { guid, name, kind, status: "deleted", localPath: local.filePath }; // 本地有游戏无
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 逐行 unified diff（LCS / Hirschberg 分治，阶段 5 扩展）
// ---------------------------------------------------------------------------

/** hunk 前后携带的上下文行数（与 GNU diff -U3 一致） */
const HUNK_CONTEXT = 3;

/** 计算 hunks 的行数上限：归一化后任一侧超过该行数即跳过（O(n·m) 耗时保护） */
const HUNK_MAX_LINES = 5000;

/** LCS 对齐产生的行编辑操作（keep 两侧都有 / del 仅本地 / add 仅远端） */
type DiffOp =
  | { type: "keep"; localIdx: number; remoteIdx: number }
  | { type: "del"; localIdx: number }
  | { type: "add"; remoteIdx: number };

/**
 * 把文本切成行数组（\n 为行分隔符，末行可不带换行）。
 *
 * 空文本 → 0 行；以 "\n" 结尾的文本，末尾空串是行终止符不是新的一行
 * （"a\n" 是 1 行，"a\n\n" 是 2 行且第二行为空行）。
 *
 * @param text 文本（调用方应先经 {@link normalizeContent} 归一化）
 * @returns 行内容数组（不含行尾换行符）
 */
function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * 把两侧行统一编号为整数（相同内容 → 相同 id，两侧共用一张编号表），
 * 让 LCS 内层循环做整数比较而不是字符串比较（5000 行级别输入下显著省时）。
 *
 * @param linesA 本地行
 * @param linesB 远端行
 * @returns [本地 id 序列, 远端 id 序列]，跨侧可比
 */
function internLineIds(linesA: readonly string[], linesB: readonly string[]): [number[], number[]] {
  const table = new Map<string, number>();
  const toIds = (lines: readonly string[]): number[] =>
    lines.map((line) => {
      let id = table.get(line);
      if (id === undefined) {
        id = table.size;
        table.set(line, id);
      }
      return id;
    });
  return [toIds(linesA), toIds(linesB)];
}

/**
 * 计算单条长度行：row[j] = LCS(a, b[0..j))（j: 0..b.length），滚动数组只留两行。
 * @param a id 序列（行维）
 * @param b id 序列（列维）
 * @returns 长度 b.length + 1 的行
 */
function lcsRow(a: readonly number[], b: readonly number[]): Uint32Array {
  const m = b.length;
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);
  for (const ai of a) {
    for (let j = 1; j <= m; j++) {
      curr[j] = ai === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev;
}

/**
 * Hirschberg 分治求一个 LCS 匹配对列表：时间 O(n·m)、空间 O(n+m)
 * （每层只有两条长度行，避免 5000 行级别输入构造 n×m 全表）。
 *
 * 平局取第一个最大分叉点，同一输入的输出完全确定（可复现的 diff）。
 *
 * @param a id 序列（本地侧）
 * @param b id 序列（远端侧）
 * @returns 匹配对 [localIdx, remoteIdx] 列表，两维分别严格递增
 */
function lcsMatches(a: readonly number[], b: readonly number[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return [];
  }
  if (n === 1) {
    const j = b.indexOf(a[0]);
    return j >= 0 ? [[0, j]] : [];
  }
  const mid = n >> 1;
  const forward = lcsRow(a.slice(0, mid), b); // forward[j] = LCS(a[0..mid), b[0..j))
  // 反向长度行：LCS(a[mid..n), b[j..m)) = lcsRow(反转右半, 反转 b)[m - j]
  const backward = lcsRow(a.slice(mid).reverse(), b.slice().reverse());
  let splitAt = 0;
  let best = -1;
  for (let j = 0; j <= m; j++) {
    const score = forward[j] + backward[m - j];
    if (score > best) {
      best = score;
      splitAt = j;
    }
  }
  return [
    ...lcsMatches(a.slice(0, mid), b.slice(0, splitAt)),
    ...lcsMatches(a.slice(mid), b.slice(splitAt)).map(
      ([li, rj]) => [li + mid, rj + splitAt] as [number, number],
    ),
  ];
}

/**
 * 由匹配对列表构造编辑操作序列：两处 keep 之间同时有 del 与 add 时 del 在前
 * （与 GNU diff 的 -/+ 顺序一致）。
 *
 * @param localIds 本地 id 序列
 * @param remoteIds 远端 id 序列
 * @returns 操作序列（keep/del/add 按行序排列）
 */
function buildOps(localIds: readonly number[], remoteIds: readonly number[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  for (const [mi, rj] of lcsMatches(localIds, remoteIds)) {
    while (i < mi) {
      ops.push({ type: "del", localIdx: i });
      i += 1;
    }
    while (j < rj) {
      ops.push({ type: "add", remoteIdx: j });
      j += 1;
    }
    ops.push({ type: "keep", localIdx: mi, remoteIdx: rj });
    i = mi + 1;
    j = rj + 1;
  }
  while (i < localIds.length) {
    ops.push({ type: "del", localIdx: i });
    i += 1;
  }
  while (j < remoteIds.length) {
    ops.push({ type: "add", remoteIdx: j });
    j += 1;
  }
  return ops;
}

/**
 * 找出全部改动区间（连续非 keep 的 op 段，闭区间），并把间隔不超过
 * 2×上下文行数的相邻区间合并为同一 hunk（上下文扩展会相接，分开展示只产生碎片）。
 *
 * @param ops 编辑操作序列
 * @returns 区间列表 [startOp, endOp]，不重叠、递增
 */
function changeRegions(ops: readonly DiffOp[]): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let start = -1;
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].type === "keep") {
      if (start >= 0) {
        regions.push([start, idx - 1]);
        start = -1;
      }
    } else if (start < 0) {
      start = idx;
    }
  }
  if (start >= 0) {
    regions.push([start, ops.length - 1]);
  }
  // 间隔 = 两区间之间夹着的 keep 行数；<= 2*HUNK_CONTEXT 时上下文相接 → 合并
  const merged: Array<[number, number]> = [];
  for (const region of regions) {
    const last = merged[merged.length - 1];
    if (last !== undefined) {
      let keeps = 0;
      for (let idx = last[1] + 1; idx < region[0]; idx++) {
        if (ops[idx].type === "keep") {
          keeps += 1;
        }
      }
      if (keeps <= HUNK_CONTEXT * 2) {
        last[1] = region[1];
        continue;
      }
    }
    merged.push([region[0], region[1]]);
  }
  return merged;
}

/**
 * 由编辑操作序列构造 hunk 列表：每个改动区间向两侧各扩最多
 * {@link HUNK_CONTEXT} 行 keep 上下文，再按 op 的两侧归属拆出各自的行内容。
 *
 * 起始行号取块内第一个消费该侧行的 op；纯新增 / 纯删除块该侧无行，
 * 取插入点之后（即已消费行数 + 1，1 基）。
 *
 * @param ops 编辑操作序列
 * @param localLines 本地行（下标对应 del / keep 的 localIdx）
 * @param remoteLines 远端行（下标对应 add / keep 的 remoteIdx）
 * @returns hunks（两侧完全一致时为空数组）
 */
function buildHunks(
  ops: readonly DiffOp[],
  localLines: readonly string[],
  remoteLines: readonly string[],
): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (const [regionStart, regionEnd] of changeRegions(ops)) {
    // 上下文扩展：区间边界向外各收最多 HUNK_CONTEXT 行 keep
    //（相邻区间间隔 > 2*HUNK_CONTEXT 才未合并，扩展不可能触及下一改动）
    let start = regionStart;
    for (let kept = 0; kept < HUNK_CONTEXT && start > 0 && ops[start - 1].type === "keep"; kept++) {
      start -= 1;
    }
    let end = regionEnd;
    for (
      let kept = 0;
      kept < HUNK_CONTEXT && end + 1 < ops.length && ops[end + 1].type === "keep";
      kept++
    ) {
      end += 1;
    }

    let localBefore = 0; // start 之前已消费的本地行数（纯新增块的起点兜底）
    let remoteBefore = 0;
    for (let idx = 0; idx < start; idx++) {
      if (ops[idx].type !== "add") {
        localBefore += 1;
      }
      if (ops[idx].type !== "del") {
        remoteBefore += 1;
      }
    }

    const hunkLocal: string[] = [];
    const hunkRemote: string[] = [];
    let localStart = -1;
    let remoteStart = -1;
    for (let idx = start; idx <= end; idx++) {
      const op = ops[idx];
      if (op.type === "keep") {
        if (localStart < 0) {
          localStart = op.localIdx + 1;
        }
        if (remoteStart < 0) {
          remoteStart = op.remoteIdx + 1;
        }
        hunkLocal.push(localLines[op.localIdx]);
        hunkRemote.push(remoteLines[op.remoteIdx]);
      } else if (op.type === "del") {
        if (localStart < 0) {
          localStart = op.localIdx + 1;
        }
        hunkLocal.push(localLines[op.localIdx]);
      } else {
        if (remoteStart < 0) {
          remoteStart = op.remoteIdx + 1;
        }
        hunkRemote.push(remoteLines[op.remoteIdx]);
      }
    }
    if (localStart < 0) {
      localStart = localBefore + 1; // 纯新增块：本地无行，取插入点之后的行号（1 基）
    }
    if (remoteStart < 0) {
      remoteStart = remoteBefore + 1;
    }
    hunks.push({ localStart, localLines: hunkLocal, remoteStart, remoteLines: hunkRemote });
  }
  return hunks;
}

/**
 * 计算两段文本的逐行 unified diff hunks（{@link DiffHunk} 列表）。
 *
 * 输入应为已归一化（{@link normalizeContent}）的文本：本函数只负责切行与对齐，
 * 不做换行风格 / 结尾空白归一化。两侧完全一致时返回 []。
 *
 * 复杂度：时间 O(n·m)、空间 O(n+m)（Hirschberg 分治，见 {@link lcsMatches}）。
 * 行数上千时调用方应自行评估耗时——diffWorkspace 对归一化后任一侧超过
 * 5000 行的输入直接跳过 hunks（字段缺省）。
 *
 * @param localText 本地文本
 * @param remoteText 远端（游戏侧）文本
 * @returns hunks，按出现顺序排列；上下文行数固定 {@link HUNK_CONTEXT}
 */
export function computeHunks(localText: string, remoteText: string): DiffHunk[] {
  const localLines = splitLines(localText);
  const remoteLines = splitLines(remoteText);
  if (localLines.length === 0 && remoteLines.length === 0) {
    return [];
  }
  const [localIds, remoteIds] = internLineIds(localLines, remoteLines);
  return buildHunks(buildOps(localIds, remoteIds), localLines, remoteLines);
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 对比图包工作区与运行中 TTS 当前存档的脚本 / UI 差异。
 *
 * 流程（只读，见模块头注释）：
 * 1. 校验 `opts.root` 与 `opts.timeoutMs`，并 resolve 根目录；
 * 2. `readPackYaml` 校验工作区（缺失 / 非法时透传 PackError）；
 * 3. `withEditorServer` 绑定编辑器端口 → `scripts.getScripts(timeoutMs)` 取游戏侧；
 * 4. 扫描 `<root>/scripts`（.lua）与 `<root>/ui`（.xml）建立本地索引；
 * 5. 按 guid + kind 比较两侧，返回 {@link DiffResult}。
 *
 * 先校验 pack.yaml 再连 TTS：非图包目录立刻失败，不占用 39998 端口。
 *
 * @param opts 入参（root 必填；timeoutMs 为等待 TTS 回推的超时，缺省 30 秒；
 *   includeHunks 为 true 时 modified 条目附带逐行 hunks，缺省 false）
 * @returns 差异结果（entries 排序规则见模块头注释；计数为条目数）
 * @throws Error `opts.root` 不是非空字符串，或 `timeoutMs` 不是正有限数字时
 *   （调用方编程错误，文案为中文硬编码，与 build.ts 的入参校验风格一致）
 * @throws PackError code="PACK_NOT_FOUND" / "PACK_INVALID" / "PACK_READ_FAILED"
 *   工作区 pack.yaml 缺失或非法时（原样透传）
 * @throws PackError code="DIFF_FAILED" 本地目录扫描失败或脚本 / UI 文件读取失败时
 * @throws {PortInUseError} 编辑器端口 39998 被占用时（由 withEditorServer 抛出）
 * @throws Error 连不上 TTS / 等待 GameLoaded 回推超时等（由协议层与会话层抛出，
 *   由 CLI 统一映射为中文提示）
 */
export async function diffWorkspace(opts: DiffOptions): Promise<DiffResult> {
  if (typeof opts?.root !== "string" || opts.root.trim() === "") {
    throw new Error("diff 入参无效：root 必须是非空字符串路径");
  }
  if (
    opts.timeoutMs !== undefined &&
    (typeof opts.timeoutMs !== "number" || !Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)
  ) {
    throw new Error("diff 入参无效：timeoutMs 必须是正有限数字（毫秒）");
  }
  const root = path.resolve(opts.root);

  // —— 1. 工作区校验（非图包目录立刻失败，不占用编辑器端口）——
  await readPackYaml(root);

  // —— 2. 游戏侧：取当前存档的 scriptStates ——
  // hub 注入路径复用 hub 已绑定的 39998；独立模式临时独占，命令结束释放
  const states = opts.server !== undefined
    ? await new SessionScripts(opts.server).getScripts(opts.timeoutMs)
    : await withEditorServer(async ({ scripts }) => scripts.getScripts(opts.timeoutMs));

  // —— 3. 本地侧：扫描 scripts/ 与 ui/（目录缺失按空工作区处理）——
  const localScripts = await scanLocalFiles(scriptsDir(root), ".lua");
  const localUi = await scanLocalFiles(uiDir(root), ".xml");

  // —— 4. 按 guid + kind 比较 ——
  const gameByGuid = new Map<string, ScriptState>();
  for (const state of states) {
    if (typeof state.guid !== "string" || state.guid === "") {
      continue; // guid 为空无法与文件对应，忽略（防御性；协议保证 guid 为非空字符串）
    }
    if (!gameByGuid.has(state.guid)) {
      gameByGuid.set(state.guid, state); // 同 GUID 重复出现时先到先得，保证确定性
    }
  }

  const guids = new Set<string>([...gameByGuid.keys(), ...localScripts.keys(), ...localUi.keys()]);
  const sortedGuids = [...guids].sort(compareGuids);

  const entries: DiffEntry[] = [];
  let added = 0;
  let modified = 0;
  let deleted = 0;

  for (const guid of sortedGuids) {
    const game = gameByGuid.get(guid);
    for (const kind of ["script", "ui"] as const) {
      const gameText = game === undefined ? undefined : kind === "script" ? game.script : game.ui;
      const local = (kind === "script" ? localScripts : localUi).get(guid);
      const entry = compareOne(guid, kind, game, gameText, local, opts.includeHunks === true);
      if (entry === undefined) {
        continue;
      }
      entries.push(entry);
      if (entry.status === "added") {
        added += 1;
      } else if (entry.status === "modified") {
        modified += 1;
      } else {
        deleted += 1;
      }
    }
  }

  return { entries, added, modified, deleted };
}
