// src/pack/pull.ts
/**
 * pullFromGame：从运行中的 TTS 拉取脚本 / UI 到图包工作区（在线回路）。
 *
 * 流程（与阶段 2A 设计一致）：
 * 1. 读 pack.yaml 确认工作区合法（缺失 → PackError code="PACK_NOT_FOUND"）；
 * 2. ensureLayout 补齐标准目录布局（幂等）；
 * 3. withEditorServer 独占绑定编辑器端口 39998，取会话层 SessionScripts；
 * 4. scripts.getScripts(timeoutMs) 拿当前存档全部 ScriptState（出站 messageID 0）；
 * 5. 逐对象落盘：GUID "-1"（全局）写 Global.lua / Global.xml，其他对象写
 *    `<guid>.<净化名>.lua` / `.xml`——复用 layout 的 scriptFileName / uiFileName，
 *    与 `tts pull`（src/cli/commands/pull.ts）及 unpack / build 的命名完全一致；
 * 6. 缺字段即删除（见下）；
 * 7. 写 baseline（阶段 5 写入路径）：落盘完成后调 safety/baseline.ts 的
 *    writeBaseline，把"本次拉取时游戏侧各对象 script / ui 的归一化 sha256"记到
 *    `<root>/.tts/baseline.json`——push 前 diffBaseline 才有可信对照基准
 *    （否则游戏侧被别人改过也发现不了）。states 就是第 4 步 getScripts 拿到的
 *    快照，不重新拉一次。
 *
 * 三个关键决策（都有明确理由，不要凭直觉"优化"掉）：
 * - 【不写骨架】本命令不更新 .tts/skeleton.json：骨架由 unpack 单独生成
 *   （用户已确认的决策）。在线增量拉取不重建骨架，避免用当前存档覆盖离线回路
 *   （约束 8）的定点替换基准；
 * - 【baseline 与工作区同步】每次 pull 都重写 baseline.json 的 entries /
 *   assetFiles / updatedAt（writeBaseline 内部会保留旧 lastPushAt——推送史由
 *   push 成功后的 touchLastPushAt 单独盖章，pull 不清除也不设置它）。这样
 *   push 前的 diffBaseline 对比的是"上次 pull 时游戏侧的样子"，游戏侧被人
 *   改过就能检测出来。写入失败绝不能静默吞掉：基线没更新却让 pull 报成功，
 *   用户会在"基线过期"的错觉下放行下一次 push；
 * - 【素材 hash 顺带入基线】writeBaseline 同时按其口径扫描 decks / objects
 *   的文本素材清单记 hash，为 push 前的素材漂移拦截（约束 7：push 协议不收
 *   素材字段）提供对照。素材目录不存在按"无素材"处理，不报错；
 * - 【缺字段即删除】TTS 协议规定：scriptStates 中某对象不提供 script / ui 字段，
 *   对应的 Lua / UI 就会被删除（见 src/session/scripts.ts 的 JSDoc 警告）。
 *   拉取必须忠实反映存档现状：state.script / state.ui 缺省时，删除本地
 *   scripts|ui 目录下属于该 guid 的全部文件。删除按 guid 前缀扫描而不是只删
 *   当前推导名——对象改名后遗留的旧文件名同样会被清掉；
 * - 【无 state 的 guid 不删除】某 guid 完全没出现在 scriptStates 里（对象已从
 *   存档删除）时不动本地文件：否则对着一份空存档拉取会把整个工作区清空，
 *   破坏性过强。本命令只同步"有 state 的对象"；
 * - 【改名但仍有脚本时不清理旧文件名】写路径只写当前推导名，不做"同 guid
 *   其他文件"的清理（只有删除分支才按 guid 前缀扫描）。因此游戏内改名后
 *   落盘为 `<guid>.新名.lua`，旧的 `<guid>.旧名.lua` 会留下——push / diff
 *   按 guid 归并时需容忍同 guid 多文件名（或由用户在 workdir 里自行清理）。
 *
 * 计数语义（{@link PullResult}）：
 * - scriptsWritten / uiWritten 只统计真正落盘的写入；内容与本地完全一致时不写、
 *   计入 skippedNoChange（脚本与 UI 合计同一个计数器）；
 * - 比对用整串内容（不做行尾归一）：文件是本工具写下去的，未改动时逐字符相同。
 *
 * 错误约定：
 * - 工作区 / 写盘 / 命名问题抛 {@link PackError}（错误码见下）；
 * - 协议 / 会话层错误（未连接 TTS、端口占用、等待 GameLoaded 超时等）原样上抛，
 *   便于 CLI 层用 src/cli/with-server.ts 的分类助手给出准确文案；
 * - 第 7 步 writeBaseline 的失败（基线写盘 / 素材扫描 IO 错误）原样上抛，让 pull
 *   整体失败——不包装成 PULL_FAILED，保住 baseline 模块的机器可读错误码。
 *
 * 错误码（{@link PackError.code}）：
 * - "PACK_NOT_FOUND" 工作区不合法：`<root>/pack.yaml` 不存在（由 readPackYaml 抛出）
 * - "PULL_FAILED"    创建目录布局、写文件、删除过期文件等出错时
 * - "BASELINE_WRITE_FAILED"      写 `.tts/baseline.json` 失败（writeBaseline 上抛）
 * - "BASELINE_ASSET_SCAN_FAILED" 扫描 decks / objects 素材清单失败（writeBaseline 上抛）
 *
 * 本模块新增的 i18n 键（locales/*.json 由 Run 2 补齐；缺键时 t() 原样输出键名）：
 * - `error.pack.pull.failed` {detail}
 *
 * 本模块沿用（不改文案）的 i18n 键——来自 safety/baseline.ts 的模块头登记：
 * - `error.baseline.writeFailed` {path} {detail}
 * - `error.baseline.assetScanFailed` {detail}
 */

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { withEditorServer } from "../cli/with-server.js";
import { t } from "../i18n/index.js";
import { GLOBAL_GUID } from "../protocol/messages.js";
import { writeBaseline } from "../safety/baseline.js";
import { SessionScripts, type ScriptState } from "../session/scripts.js";
import { ensureLayout, scriptFileName, scriptsDir, uiDir, uiFileName } from "./layout.js";
import { PackError, readPackYaml } from "./packyaml.js";

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** pullFromGame 的入参 */
export interface PullOptions {
  /** 图包工作区根目录（必须已有 pack.yaml，否则抛 PACK_NOT_FOUND） */
  root: string;
  /** 等待 TTS 回推脚本快照的超时（毫秒）；缺省走 SessionScripts 的 30000 */
  timeoutMs?: number;
  /**
   * 可选的已绑定编辑器端口服务器（阶段 4 hub 注入用）。
   *
   * 缺省时本函数经 withEditorServer 临时独占 39998；hub 路由处理器必须传入
   * daemon.server（hub 已持有 39998），避免二次独占触发 PortInUseError。
   */
  server?: import("../protocol/editor-server.js").EditorServer;
}

/** pullFromGame 的返回值（计数语义见模块头注释） */
export interface PullResult {
  /** 实际写入 scripts/ 的 Lua 文件数 */
  scriptsWritten: number;
  /** 实际写入 ui/ 的 XML 文件数 */
  uiWritten: number;
  /** 内容与本地一致、跳过覆写的文件数（脚本 + UI 合计） */
  skippedNoChange: number;
}

// ---------------------------------------------------------------------------
// 常量与内部类型
// ---------------------------------------------------------------------------

/** 全局脚本 / UI 的固定文件名（layout 命名规则：GUID "-1" → "Global"） */
const GLOBAL_LUA_FILE = scriptFileName(GLOBAL_GUID, "");
const GLOBAL_XML_FILE = uiFileName(GLOBAL_GUID, "");

/** 三个计数器的可变载体（落盘过程中累加；结构与 PullResult 一致） */
interface PullCounters {
  scriptsWritten: number;
  uiWritten: number;
  skippedNoChange: number;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT），避免 any。
 * （与 src/pack/packyaml.ts / unpack.ts 的同名内部函数一致，各模块各自持有。）
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
 * 构造 PULL_FAILED 错误（面向用户的文案走 t()，detail 为具体步骤与原因）。
 * @param detail 出错的步骤描述（含路径与原因）
 * @returns 带机器可读错误码的 PackError
 */
function pullFailed(detail: string): PackError {
  return new PackError("PULL_FAILED", t("error.pack.pull.failed", { detail }));
}

/**
 * 执行一个落盘步骤，把非 PackError 的异常统一包装成 PULL_FAILED。
 *
 * 只用于本模块自己的文件操作与命名步骤：协议 / 会话层错误在调用点之外
 * （getScripts / withEditorServer），不会被这里包装掉。
 *
 * @param detail 出错时展示的步骤描述
 * @param fn 实际执行的步骤
 * @returns fn 的返回值
 * @throws PackError code="PULL_FAILED" 步骤抛出非 PackError 异常时
 */
async function guard<T>(detail: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PackError) {
      throw err;
    }
    throw pullFailed(`${detail}：${errMessage(err)}`);
  }
}

/**
 * 读取文本文件；文件不存在返回 undefined，其他 IO 错误包装为 PULL_FAILED。
 * @param file 文件完整路径
 * @returns 文件内容（utf8）；ENOENT 时返回 undefined
 * @throws PackError code="PULL_FAILED" 读取发生其他错误时
 */
async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return undefined;
    }
    throw pullFailed(`${file}：${errMessage(err)}`);
  }
}

/**
 * 内容与本地一致时跳过覆写（计入 skippedNoChange），否则落盘（对应计数 +1）。
 * @param file 目标文件完整路径
 * @param content 待写入内容
 * @param counters 计数器载体（原地累加）
 * @param writtenKey 实际写入时递增的计数键
 * @throws PackError code="PULL_FAILED" 写盘失败时
 */
async function writeIfChanged(
  file: string,
  content: string,
  counters: PullCounters,
  writtenKey: "scriptsWritten" | "uiWritten",
): Promise<void> {
  const existing = await readTextIfExists(file);
  if (existing === content) {
    counters.skippedNoChange += 1;
    return;
  }
  await guard(`写入 ${file}`, () => writeFile(file, content, "utf8"));
  counters[writtenKey] += 1;
}

/**
 * 取全局对象（GUID "-1"）在本模块关心的扩展名下的固定文件名。
 * @param ext 扩展名（".lua" / ".xml"）
 * @returns "Global.lua" / "Global.xml"
 */
function globalFileName(ext: ".lua" | ".xml"): string {
  return ext === ".lua" ? GLOBAL_LUA_FILE : GLOBAL_XML_FILE;
}

/**
 * 列出目录下属于指定 guid 的脚本 / UI 文件（"缺字段即删除"的定位依据）。
 *
 * 匹配规则与 layout 的落盘命名一一对应：
 * - GUID "-1"：文件名恰为 Global.lua / Global.xml；
 * - 其他 guid：以 "<guid>." 开头且扩展名匹配——对象改名后遗留的旧文件也能命中
 *   （不会误伤别的 guid："abc1234.x.lua" 不以 "abc123." 开头）。
 *
 * @param dir scripts/ 或 ui/ 目录
 * @param guid 目标对象 GUID
 * @param ext 扩展名（".lua" / ".xml"）
 * @returns 命中的文件完整路径列表（目录不存在时为空数组）
 * @throws PackError code="PULL_FAILED" 读目录发生非 ENOENT 的错误时
 */
async function findLocalFilesForGuid(
  dir: string,
  guid: string,
  ext: ".lua" | ".xml",
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return []; // 布局由 ensureLayout 保证存在；防御性兜底：目录被删时视为无本地文件
    }
    throw pullFailed(`读取目录 ${dir}：${errMessage(err)}`);
  }

  const found: string[] = [];
  for (const name of names) {
    if (!name.endsWith(ext)) {
      continue;
    }
    const hit = guid === GLOBAL_GUID ? name === globalFileName(ext) : name.startsWith(`${guid}.`);
    if (hit) {
      found.push(path.join(dir, name));
    }
  }
  return found;
}

/**
 * 删除本地属于该 guid 的脚本 / UI 文件（缺字段即删除，见模块头注释）。
 * @param dir scripts/ 或 ui/ 目录
 * @param guid 目标对象 GUID
 * @param ext 扩展名（".lua" / ".xml"）
 * @throws PackError code="PULL_FAILED" 删除失败时
 */
async function deleteLocalForGuid(dir: string, guid: string, ext: ".lua" | ".xml"): Promise<void> {
  const files = await findLocalFilesForGuid(dir, guid, ext);
  for (const file of files) {
    await guard(`删除 ${file}`, () => rm(file, { force: true }));
  }
}

/**
 * 把单个 ScriptState 同步到工作区（写 / 跳过 / 删除）。
 *
 * guid "-1" 时 layout 的命名函数忽略 name，恒得 Global.lua / Global.xml；
 * 其他 guid 得 `<guid>.<净化名>`（空名净化后回退 "object"）。
 *
 * @param root 图包工作区根目录
 * @param state 单个对象的脚本状态（script / ui 缺省 = 删除）
 * @param counters 计数器载体（原地累加）
 * @throws PackError code="PULL_FAILED" 命名非法或写 / 删失败时
 */
async function applyState(root: string, state: ScriptState, counters: PullCounters): Promise<void> {
  const scripts = scriptsDir(root);
  const ui = uiDir(root);

  if (state.script !== undefined) {
    await writeIfChanged(
      path.join(scripts, scriptFileName(state.guid, state.name)),
      state.script,
      counters,
      "scriptsWritten",
    );
  } else {
    await deleteLocalForGuid(scripts, state.guid, ".lua");
  }

  if (state.ui !== undefined) {
    await writeIfChanged(path.join(ui, uiFileName(state.guid, state.name)), state.ui, counters, "uiWritten");
  } else {
    await deleteLocalForGuid(ui, state.guid, ".xml");
  }
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 从运行中的 TTS 拉取脚本 / UI 到图包工作区（流程与决策见模块头注释）。
 *
 * 只读 TTS（出站 messageID 0 GetScripts），不触碰 push 协议（约束 7）：
 * 本函数不调用 saveAndPlay，绝不回写 TTS。
 *
 * @param opts 入参（root 必填；timeoutMs 缺省 30000）
 * @returns 落盘计数（scriptsWritten / uiWritten / skippedNoChange）
 * @throws Error opts.root 不是非空字符串时（调用方编程错误）
 * @throws PackError code="PACK_NOT_FOUND" `<root>/pack.yaml` 不存在时
 * @throws PackError code="PACK_INVALID" pack.yaml 内容非法时（readPackYaml 抛出）
 * @throws PackError code="PULL_FAILED" 目录布局、写文件、删文件出错时
 * @throws PackError code="BASELINE_WRITE_FAILED" 写 `.tts/baseline.json` 失败时
 *   （writeBaseline 上抛；此时脚本 / UI 可能已部分落盘——先写盘后记基线）
 * @throws PackError code="BASELINE_ASSET_SCAN_FAILED" 扫描 decks / objects 素材清单
 *   失败时（writeBaseline 上抛；同上，脚本 / UI 可能已部分落盘）
 * @throws {PortInUseError} 编辑器端口 39998 被占用时（withEditorServer 抛出，原样上抛）
 * @throws Error TTS 未运行（连不上 39999）或等待 GameLoaded 超时时（原样上抛，
 *   由 CLI 层按 src/cli/with-server.ts 的分类助手给出文案）
 */
export async function pullFromGame(opts: PullOptions): Promise<PullResult> {
  if (typeof opts?.root !== "string" || opts.root.trim() === "") {
    throw new Error("pull 入参无效：root 必须是非空字符串路径");
  }
  const root = opts.root;

  // —— 1. 工作区合法性：pack.yaml 缺失 / 非法由 readPackYaml 抛 PackError ——
  await readPackYaml(root);

  // —— 2. 目录布局（幂等；不存在时补齐，不触碰 pack.yaml）——
  await guard("创建图包目录布局", () => ensureLayout(root));

  const counters: PullCounters = { scriptsWritten: 0, uiWritten: 0, skippedNoChange: 0 };

  // —— 3~5. 独占编辑器端口 → 拉快照 → 逐对象落盘 ——
  // 协议 / 会话层错误（端口占用 / 未连接 / 超时）不在这里包装，原样上抛给 CLI 分类。
  // states 提升到外层：两条路径共用第 4 步拿到的同一份快照（第 7 步写 baseline 复用，不重新拉）
  let states: ScriptState[];
  if (opts.server !== undefined) {
    // hub 注入路径：复用 hub 已绑定的 39998，不再独占
    const scripts = new SessionScripts(opts.server);
    states = await scripts.getScripts(opts.timeoutMs);
    for (const state of states) {
      await guard(`同步对象 ${state.name}`, () => applyState(root, state, counters));
    }
  } else {
    // 独立模式：临时独占 39998，命令结束立即释放
    let independentStates: ScriptState[] = [];
    await withEditorServer(async ({ scripts }) => {
      independentStates = await scripts.getScripts(opts.timeoutMs);
      for (const state of independentStates) {
        // 单个对象的问题（命名非法 / 写盘失败）统一转成 PackError
        await guard(`同步对象 ${state.name}`, () => applyState(root, state, counters));
      }
    });
    states = independentStates;
  }

  // —— 6~7. pull 成功后写 baseline（保持 baseline 与工作区同步，见模块头注释）——
  // writeBaseline 的 IO 失败（BASELINE_WRITE_FAILED / BASELINE_ASSET_SCAN_FAILED）
  // 不吞错、不包装，原样上抛让 pull 整体失败：基线没更新却报成功，会让用户在
  // "基线过期"的错觉下放行下一次 push（漏检游戏侧他人改动）。
  await writeBaseline(root, states);

  return counters;
}
