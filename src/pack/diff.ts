// src/pack/diff.ts
/**
 * diffWorkspace：对比图包工作区与运行中 TTS 当前存档的脚本 / UI 差异（只读操作）。
 *
 * 职责：
 * - 校验工作区（{@link readPackYaml}）；
 * - 连接 TTS 取游戏侧脚本快照（{@link withEditorServer} → SessionScripts.getScripts）；
 * - 扫描本地 scripts/ 与 ui/ 目录（命名规则见 src/pack/layout.ts）；
 * - 按 guid + kind 比较两侧内容，产出 {@link DiffResult}。
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
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { withEditorServer } from "../cli/with-server.js";
import { t } from "../i18n/index.js";
import { GLOBAL_GUID } from "../protocol/messages.js";
import type { ScriptState } from "../session/scripts.js";
import { scriptsDir, uiDir } from "./layout.js";
import { PackError, readPackYaml } from "./packyaml.js";

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

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
 * @param text 原始内容
 * @returns 归一化后的内容（仅用于比较，不落盘）
 */
function normalizeContent(text: string): string {
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
 * @returns 差异条目；无差异时返回 undefined
 */
function compareOne(
  guid: string,
  kind: DiffKind,
  game: ScriptState | undefined,
  gameText: string | undefined,
  local: LocalFile | undefined,
): DiffEntry | undefined {
  const name = pickName(game, local, guid);

  if (gameText !== undefined && local !== undefined) {
    if (normalizeContent(gameText) === normalizeContent(local.content)) {
      return undefined; // 两边一致：不计入
    }
    return { guid, name, kind, status: "modified", localPath: local.filePath };
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
 * @param opts 入参（root 必填；timeoutMs 为等待 TTS 回推的超时，缺省 30 秒）
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

  // —— 2. 游戏侧：临时独占编辑器端口，取当前存档的 scriptStates ——
  const states = await withEditorServer(async ({ scripts }) => scripts.getScripts(opts.timeoutMs));

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
      const entry = compareOne(guid, kind, game, gameText, local);
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
