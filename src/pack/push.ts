// src/pack/push.ts
/**
 * push：图包工作区 → 运行中的 TTS（脚本 / UI 写回）。
 *
 * 本模块包含两个函数：
 * - {@link collectPushItems}：纯离线清单收集器（B1 建；不连 TTS、不调 saveAndPlay，
 *   只把"将要推送什么"扫成清单）。当前主要供内部使用——阶段 5 的
 *   {@link pushSaveAndPlay} 在它的结果之上组装完整 scriptStates。
 * - {@link pushSaveAndPlay}：阶段 5 完整推送流水线（备份 → 基线校验 → 素材检测 →
 *   过滤无变化 → 确认 → saveAndPlay → 回读校验 → 更新 baseline）。详见下方 JSDoc。
 *
 * 职责（{@link collectPushItems}）：
 * 1. {@link readPackYaml} 校验工作区（pack.yaml 缺失 / 损坏一律抛出，不静默跳过）；
 * 2. 扫 `scripts/`（`.lua`）与 `ui/`（`.xml`）目录，按文件名解析 guid 与 name；
 * 3. 按 guid 合并成 {@link PushItem} 清单（脚本与 UI 都记在同一个对象上）；
 * 4. 返回 {@link PushResult}：清单 + 待推送对象数 + 中文说明文字。
 *
 * 文件名解析规则（与 {@link scriptFileName} / {@link uiFileName} 的落盘命名互为逆运算，
 * 也与 pack/build.ts 的 guidFromFileName 约定一致：**只认第一个点之前的 guid**，
 * 绝不解析名字部分）：
 * - `Global.lua` / `Global.xml` → guid 为 {@link GLOBAL_GUID}（"-1"），name 为 "Global"；
 * - `<guid>.<name>.lua` / `<guid>.<name>.xml` → guid 是第一个点之前的部分
 *   （正则 `^([0-9a-f-]+)\.(.+)\.lua$`，不区分大小写；guid 原样保留，不做大小写归一），
 *   name 是中间部分（**可以含点**，如 `aa11bb.My.Deck v2.lua` → name = "My.Deck v2"）；
 * - 其余散落文件（如 `readme.txt`、`noguid.lua`、扩展名大小写不符）静默跳过——
 *   {@link PushResult} 没有 warnings 字段，本骨架不提供警告通道；将来阶段 5 若要提示，
 *   需先扩展返回值契约。
 *
 * 合并与顺序规则（保证确定性，便于测试与摘要）：
 * - 先扫 scripts/ 再扫 ui/；同一 guid 在两边都出现时合并为一个 {@link PushItem}，
 *   同时带 scriptPath 与 uiPath；
 * - name 取**先扫到的那个**：scripts 优先；只有 ui/ 命中时（如新加的 UI）才用 UI 文件名的 name；
 * - 清单排序：Global（guid "-1"）排最前，其余按 guid 字典序（localeCompare）。
 *
 * ⚠️ 约束 7（push 协议的能力边界，阶段 5 实现时必须遵守）：
 * Save & Play（出站 messageID 1）只接收 `scriptStates: [{name, guid, script, ui}]`，
 * **不接收 CustomDeck / CustomImage 等任何素材字段**——素材改动永远不可能通过 push 生效，
 * 必须走 pack/build.ts 的离线回路。因此本模块只收集 `.lua` / `.xml`，
 * 绝不读取、修改或携带任何素材 URL；阶段 5 接通协议时也只能调
 * `SessionScripts.saveAndPlay()`，且必须为每个对象带上完整的 script / ui 字段
 * （缺字段 = TTS 删除对应内容，见 src/session/scripts.ts 的 JSDoc）。
 *
 * ⚠️ name 的来源限制（阶段 5 必须处理）：PushItem.name 是从**文件名**解析出的净化名
 * （如 "Chess_Pawn"），未必等于游戏内对象的显示名（"Chess Pawn"）。
 * 阶段 5 写回前应先用 getScripts() 取到游戏内真实 name 并与之对账，
 * 避免用净化名把对象改名。
 *
 * 错误码（{@link PackError.code}）：
 * - 透传 readPackYaml 的 "PACK_NOT_FOUND" / "PACK_INVALID" / "PACK_READ_FAILED"；
 * - "PUSH_FAILED" 其余失败（scripts/ / ui/ 目录读取失败等 IO 错误）
 *
 * 本模块新增的 i18n 键（locales/*.json 由 Run 2 补齐；缺键时 t() 原样输出键名）：
 * - `cli.pack.push.note` {count} —— 说明"仅列出清单，实际推送请用 tts pack push"的文字
 * - `error.pack.push.failed` {detail}
 *
 * ---------------------------------------------------------------------------
 * pushSaveAndPlay（阶段 5「写入路径」：完整 push 流水线）
 * ---------------------------------------------------------------------------
 *
 * {@link pushSaveAndPlay} 把本地工作区的脚本 / UI 改动安全地写回运行中的 TTS，
 * 流程固定为（每步都做、顺序不可调换）：
 *
 * 1. {@link readPackYaml} 校验工作区（缺 pack.yaml 立即失败）；
 * 2. {@link collectPushItems} 收集工作区清单（空清单直接返回 pushed=0 / skipped=0，
 *    不连 TTS、不占 39998 端口）；
 * 3. 拉游戏内 scriptStates（{@link SessionScripts.getScripts}）；
 * 4. 素材改动检测（用户裁决「内容 hash 最严」）：{@link readBaseline} +
 *    {@link detectAssetChanges}，任何 changed / added / deleted 且未显式
 *    `forceScriptsOnly` → 抛 PUSH_ASSET_CHANGES_DETECTED（错误 message 含
 *    assets upload → pack build → 加载存档 → 再 push 的四步修复引导）——
 *    约束 7：push 协议（messageID 1）只接收 scriptStates，不接收素材字段，
 *    素材改动永远无法靠热重载生效；
 * 5. 基线冲突检测：{@link diffBaseline} 发现游戏侧相对基线被人改过且未显式
 *    `skipBaselineCheck` → 抛 BASELINE_CONFLICT（message 含冲突清单前 10 条，
 *    引导先 pull 对账）；
 * 6. 过滤无变化对象：本地内容与游戏侧按 {@link normalizeContent} 归一化后比较，
 *    script 与 ui 都无变化的 {@link PushItem} 剔除并计入 skipped（CRLF / 结尾空行
 *    差异不算变化）；
 * 7. 强制带 ui（关键安全约束）：缺 scriptPath / uiPath 的维度从游戏侧同 guid 的
 *    现有内容原样补齐——TTS 协议规定 scriptStates 缺字段即删除对应内容，漏带
 *    会把未改动的一半删掉；补齐后两个维度都无内容的对象跳过（防御性，
 *    collectPushItems 的结果不会出现这种条目）；name 一律用游戏侧真实显示名，
 *    绝不用 PushItem 的净化名（避免把对象改名）；
 * 8. dryRun（默认 true）：到此返回，不备份、不确认、不发送、不写 baseline；
 * 9. 备份：{@link createBackup}（reason="push"，快照游戏内全部 scriptStates 到
 *    `.tts/backups/<时间戳>/`，按 retention 清理旧备份）；
 * 10. 确认门：`opts.confirm` 存在时调用，返回 false → 抛 PUSH_ABORTED
 *     （CLI 传 {@link confirmPush} 包装；MCP 由 hub 层 z.literal(true) 拦截，
 *     不会到这里）；
 * 11. {@link SessionScripts.saveAndPlay} 写回（只发过滤后的有变化对象）；
 * 12. 回读校验：再次 getScripts，与发送内容按归一化 hash 比对，不一致抛
 *     PUSH_VERIFY_FAILED（baseline 不更新，游戏侧状态以回读快照为准）；
 * 13. 更新基线：{@link writeBaseline}(回读快照) + {@link touchLastPushAt}。
 *
 * 坑 17（端口绑定）：`opts.server` 存在（hub 注入）→ 直接复用，绝不 withEditorServer；
 * 缺省（独立 CLI 模式）→ 用 {@link withEditorServer} 包住「拉远端 → 备份 → 发送 →
 * 回读」整个流程，只绑定 / 释放 39998 一次，绝不在中间过程反复进出。
 *
 * {@link PushSaveResult} 字段语义：`pushed` = 实际写入（或 dryRun 下将写入）的对象数；
 * `skipped` = 无变化（含防御性跳过）的对象数；`backupDir` 仅在实写且未 skipBackup 时
 * 携带；`baselineConflicts` / `assetChanges` 仅在检测到且被对应开关放行时携带
 * （否则已按第 4 / 5 步抛错中断）。
 *
 * pushSaveAndPlay 新增错误码（{@link PackError.code}）：
 * - "PUSH_ASSET_CHANGES_DETECTED" 素材清单有改动且未 forceScriptsOnly（步骤 4）
 * - "BASELINE_CONFLICT"           游戏侧相对基线被改且未 skipBaselineCheck（步骤 5）
 * - "PUSH_ABORTED"                确认门返回 false（步骤 10）
 * - "PUSH_VERIFY_FAILED"          写回后回读与发送内容不一致（步骤 12）
 * - 透传：PACK_NOT_FOUND / PACK_INVALID / PACK_READ_FAILED（pack.yaml）、
 *   PUSH_FAILED（本地脚本 / UI 文件读取失败）、BASELINE_READ_FAILED /
 *   BASELINE_ASSET_SCAN_FAILED / BASELINE_WRITE_FAILED（基线模块）、
 *   BACKUP_WRITE_FAILED / BACKUP_PRUNE_FAILED / BACKUP_DIR_INVALID（备份模块）；
 *   端口占用 / 连不上 TTS / 等待回推超时等协议层异常原样上抛，交由 CLI 统一映射。
 *
 * pushSaveAndPlay 新增的 i18n 键（locales/*.json 由 Run 2 补齐）：
 * - `cli.pack.push.noteEmpty`                      —— 空清单摘要
 * - `cli.pack.push.noteDryRun` {pushed} {skipped}  —— 试运行摘要
 * - `cli.pack.push.noteDone` {pushed} {skipped}    —— 写入完成摘要
 * - `error.push.assetChangesDetected` {changedCount} {files}
 *   （{files} 为已格式化的清单文本，每行 `  - <相对路径>`，最多 10 条；
 *   译文须含 assets upload → pack build → 加载存档 → 再 push 的四步引导与
 *   --force-scripts-only 提示，模板见阶段 5 任务书）
 * - `error.push.baselineConflict` {details} —— {details} 为冲突清单（前 10 条）
 * - `error.push.aborted`                    —— 确认门拒绝
 * - `error.push.verifyFailed` {details}     —— {details} 为回读不一致清单
 */

import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { withEditorServer } from "../cli/with-server.js";
import { t } from "../i18n/index.js";
import type { EditorServer } from "../protocol/editor-server.js";
import { GLOBAL_GUID } from "../protocol/messages.js";
import { createBackup } from "../safety/backup.js";
import {
  detectAssetChanges,
  diffBaseline,
  readBaseline,
  touchLastPushAt,
  writeBaseline,
  type AssetChanges,
  type BaselineConflict,
} from "../safety/baseline.js";
import { SessionScripts, type ScriptState } from "../session/scripts.js";
import { normalizeContent } from "./diff.js";
import { scriptsDir, uiDir } from "./layout.js";
import { PackError, readPackYaml } from "./packyaml.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 脚本文件扩展名（与 layout.scriptFileName 的落盘扩展名一致） */
const LUA_EXT = ".lua" as const;

/** UI 文件扩展名（与 layout.uiFileName 的落盘扩展名一致） */
const XML_EXT = ".xml" as const;

/** Global 文件的名称主干（不含扩展名；GUID 为 {@link GLOBAL_GUID} 时的固定写法） */
const GLOBAL_STEM = "Global";

/**
 * 各扩展名对应的本地文件名解析正则（与任务约定逐字一致）。
 *
 * 只匹配"guid.name.ext"三段式：第一段必须是十六进制字符或连字符（GUID 形状，
 * 不区分大小写），中间段至少一个字符且**允许含点**（贪婪匹配到最后一个扩展名），
 * 最后一段是扩展名。Global.lua / Global.xml 由调用方单独处理，不进这里。
 */
const LOCAL_NAME_PATTERNS: Record<typeof LUA_EXT | typeof XML_EXT, RegExp> = {
  [LUA_EXT]: /^([0-9a-f-]+)\.(.+)\.lua$/i,
  [XML_EXT]: /^([0-9a-f-]+)\.(.+)\.xml$/i,
};

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** collectPushItems 的入参 */
export interface PushOptions {
  /** 图包工作区根目录（相对路径会先 resolve） */
  root: string;
  /**
   * 预留：将来调 saveAndPlay 时支持"只报告不写入"（默认 false）。
   * 本骨架不推送任何内容，因此该字段当前不改变行为，仅为阶段 5 保留接口形状。
   */
  dryRun?: boolean;
}

/** 单个待推送对象（按 guid 合并后的脚本 / UI 清单条目） */
export interface PushItem {
  /** 对象 GUID（"-1" 为全局脚本 / 全局 UI） */
  guid: string;
  /**
   * 从本地文件名解析出的对象名（净化后的形式，如 "Chess_Pawn"；
   * 未必等于游戏内显示名，见模块头注释的阶段 5 注意事项）
   */
  name: string;
  /** 本地 .lua 脚本的完整路径（path.resolve 后的绝对路径）；无脚本时缺省 */
  scriptPath?: string;
  /** 本地 .xml UI 的完整路径（path.resolve 后的绝对路径）；无 UI 时缺省 */
  uiPath?: string;
}

/** collectPushItems 的返回值 */
export interface PushResult {
  /** 待推送对象清单（Global 最前，其余按 guid 字典序；每个对象至多一条） */
  items: PushItem[];
  /** 将要推送的对象数（含 Global；= items.length） */
  wouldPush: number;
  /** 说明文字（中文、经 t()）：告知用户本函数仅列清单，实际推送用 tts pack push */
  note: string;
}

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

/** 从本地文件名解析出的对象标识 */
interface ParsedLocalFile {
  /** 文件名首段解析出的 GUID（Global 为 "-1"） */
  guid: string;
  /** 文件名中间段解析出的对象名（Global 固定为 "Global"） */
  name: string;
}

// ---------------------------------------------------------------------------
// 内部工具（各模块各自持有，不跨模块导出；与 pack/build.ts 同名函数同一考虑）
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
 * 解析单个本地文件名（脚本或 UI）。
 *
 * Global 文件单独判定（大小写敏感的精确匹配，与 pack/build.ts 的 guidFromFileName
 * 处理一致），其余交给 {@link LOCAL_NAME_PATTERNS} 的三段式正则。
 *
 * @param fileName 文件名（不含目录，如 "aa11bb.测试牌堆.lua"）
 * @param ext 扩展名（含点，".lua" / ".xml"）
 * @returns 解析出的 guid 与 name；文件名不符合命名规则时返回 undefined（调用方静默跳过）
 */
function parseLocalFileName(fileName: string, ext: typeof LUA_EXT | typeof XML_EXT): ParsedLocalFile | undefined {
  if (fileName === `${GLOBAL_STEM}${ext}`) {
    return { guid: GLOBAL_GUID, name: GLOBAL_STEM };
  }
  const matched = LOCAL_NAME_PATTERNS[ext].exec(fileName);
  if (matched === null) {
    return undefined;
  }
  return { guid: matched[1], name: matched[2] };
}

/**
 * 列出目录下的普通文件名（只保留指定扩展名），按字典序排序保证确定性。
 *
 * 目录不存在（ENOENT）按空工作区处理、返回空数组而不是报错——刚 init 出来的图包
 * 可以没有任何脚本 / UI（与 pack/build.ts 对 scripts/ui 目录的处理一致）。
 *
 * @param dir 目录路径
 * @param ext 扩展名（含点）
 * @returns 排序后的文件名列表（不含目录部分）
 * @throws 目录存在但读取失败（权限不足等）时原样抛出，由调用方包装为 PUSH_FAILED
 */
async function listFilesSorted(dir: string, ext: typeof LUA_EXT | typeof XML_EXT): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return [];
    }
    throw err;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * 把一个本地文件并入按 guid 索引的清单。
 *
 * 同一 guid 已存在时只补对应路径字段，**不改动 name**——因此 name 由先扫描的
 * scripts/ 决定（见模块头注释的合并规则）。
 *
 * @param items guid → PushItem 的累积表（原地修改）
 * @param parsed 文件名解析结果
 * @param key 该文件对应的清单字段（"scriptPath" 或 "uiPath"）
 * @param filePath 文件完整路径
 */
function mergeItem(
  items: Map<string, PushItem>,
  parsed: ParsedLocalFile,
  key: "scriptPath" | "uiPath",
  filePath: string,
): void {
  const existing = items.get(parsed.guid);
  if (existing === undefined) {
    const item: PushItem = { guid: parsed.guid, name: parsed.name };
    item[key] = filePath;
    items.set(parsed.guid, item);
    return;
  }
  existing[key] = filePath;
}

/**
 * 清单排序比较器：Global（guid "-1"）最前，其余按 guid 字典序。
 * @param a 待比较条目
 * @param b 待比较条目
 * @returns 负数 / 0 / 正数，语义同 Array.prototype.sort
 */
function compareItems(a: PushItem, b: PushItem): number {
  if (a.guid === GLOBAL_GUID || b.guid === GLOBAL_GUID) {
    if (a.guid === b.guid) {
      return 0;
    }
    return a.guid === GLOBAL_GUID ? -1 : 1;
  }
  return a.guid.localeCompare(b.guid);
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 收集图包工作区中"将要推送到 TTS"的脚本 / UI 清单（**骨架：不实际推送**）。
 *
 * 流程：
 * 1. 校验入参并 resolve 根路径；
 * 2. {@link readPackYaml} 读 pack.yaml（缺失 / 损坏一律抛出，不静默跳过）；
 * 3. 扫 `<root>/scripts`（`.lua`）与 `<root>/ui`（`.xml`），按文件名解析 guid 与 name，
 *    按 guid 合并成 {@link PushItem}（同一对象的脚本与 UI 合成一条）；
 * 4. 返回 {@link PushResult}：清单 + 待推送对象数 + 中文说明文字
 *    （note 经 `t("cli.pack.push.note", { count })` 生成，提示用户实际推送请用 tts pack push）。
 *
 * 本函数**只读**、不连 TTS、不调 saveAndPlay、不写任何文件；`dryRun` 在当前实现下
 * 不改变行为（没有副作用可关闭），仅为阶段 5 保留接口形状。
 *
 * @param opts 入参（root 必填；dryRun 预留）
 * @returns 待推送清单（Global 最前、其余按 guid 字典序）与对象数
 * @throws Error root 不是非空字符串时（调用方编程错误）
 * @throws PackError code="PACK_NOT_FOUND" 工作区没有 pack.yaml 时（引导先跑 tts pack init / unpack）
 * @throws PackError code="PACK_INVALID" / "PACK_READ_FAILED" pack.yaml 损坏时（透传）
 * @throws PackError code="PUSH_FAILED" scripts/ 或 ui/ 目录读取失败等其余 IO 错误时
 */
export async function collectPushItems(opts: PushOptions): Promise<PushResult> {
  if (typeof opts?.root !== "string" || opts.root.trim() === "") {
    throw new Error("push 入参无效：root 必须是非空字符串路径");
  }
  const root = path.resolve(opts.root);

  try {
    // —— 1. 校验 pack.yaml（本骨架唯一的必填前置；后续阶段还要用它读 upload 等配置）——
    await readPackYaml(root);

    // —— 2. 先扫 scripts/，再扫 ui/；同名 guid 合并 ——
    const items = new Map<string, PushItem>();

    const localScriptsDir = scriptsDir(root);
    for (const fileName of await listFilesSorted(localScriptsDir, LUA_EXT)) {
      const parsed = parseLocalFileName(fileName, LUA_EXT);
      if (parsed === undefined) {
        continue; // 散落文件（无 guid 前缀等）：不属于任何对象，静默跳过
      }
      mergeItem(items, parsed, "scriptPath", path.join(localScriptsDir, fileName));
    }

    const localUiDir = uiDir(root);
    for (const fileName of await listFilesSorted(localUiDir, XML_EXT)) {
      const parsed = parseLocalFileName(fileName, XML_EXT);
      if (parsed === undefined) {
        continue;
      }
      mergeItem(items, parsed, "uiPath", path.join(localUiDir, fileName));
    }

    // —— 3. 排序 + 计数 + 说明文字 ——
    const sorted = [...items.values()].sort(compareItems);
    return {
      items: sorted,
      wouldPush: sorted.length,
      note: t("cli.pack.push.note", { count: sorted.length }),
    };
  } catch (err) {
    if (err instanceof PackError) {
      throw err; // pack.yaml 的错误码原样透传，交给 CLI 分流提示
    }
    throw new PackError("PUSH_FAILED", t("error.pack.push.failed", { detail: errMessage(err) }));
  }
}

// ---------------------------------------------------------------------------
// pushSaveAndPlay：完整 push 流水线（阶段 5 写入路径，流程见模块头注释）
// ---------------------------------------------------------------------------

/** getScripts / saveAndPlay / 回读校验共用的默认等待超时（毫秒） */
const DEFAULT_SAVE_TIMEOUT_MS = 60_000;

/** 备份保留份数缺省值（透传 createBackup 的 retention） */
const DEFAULT_BACKUP_RETENTION = 20;

/** 错误 message 里清单类数据（素材清单 / 冲突清单 / 回读差异）的最大行数 */
const MAX_ERROR_LIST_LINES = 10;

/** {@link pushSaveAndPlay} 的入参 */
export interface PushSaveOptions extends PushOptions {
  /**
   * 已绑定编辑器端口的服务器（坑 17：hub 路由注入用）。
   * 缺省时本函数经 {@link withEditorServer} 临时独占 39998，并把「拉远端 → 备份 →
   * 发送 → 回读」整个流程包在同一次绑定里（绝不反复进出，见模块头注释）。
   */
  server?: EditorServer;
  /** 等待 TTS 回推 GameLoaded 的超时（毫秒）；getScripts / saveAndPlay / 回读共用；缺省 60000 */
  timeoutMs?: number;
  /** 试运行：只做检测与过滤、返回将推送什么，不备份不确认不发送不写基线；缺省 true */
  dryRun?: boolean;
  /** --no-backup：跳过 push 前自动备份（不推荐）；缺省 false */
  skipBackup?: boolean;
  /** --no-baseline-check：跳过基线冲突检测（冲突照常记入结果）；缺省 false */
  skipBaselineCheck?: boolean;
  /** --force-scripts-only：素材有改动时仍强制只推脚本（用户自担风险）；缺省 false */
  forceScriptsOnly?: boolean;
  /**
   * CLI 注入的确认函数（通常包装 {@link confirmPush}）；返回 false → 抛 PUSH_ABORTED。
   * MCP 链路由 hub 层 z.literal(true) 拦截，不会带未确认的写入到这里。
   */
  confirm?: () => Promise<boolean>;
  /** 备份保留份数（透传 createBackup）；缺省 20；<=0 视为不清理旧备份 */
  backupRetention?: number;
}

/** {@link pushSaveAndPlay} 的返回值 */
export interface PushSaveResult {
  /** 是否试运行（与入参 dryRun 一致） */
  dryRun: boolean;
  /** 实际写入（dryRun 下为"将写入"）的对象数 */
  pushed: number;
  /** 无变化（含防御性跳过）而未发送的对象数 */
  skipped: number;
  /** 备份目录完整路径；dryRun 或 skipBackup 时缺省 */
  backupDir?: string;
  /** 基线冲突清单；仅在检测到且被 skipBaselineCheck 放行时携带（否则已抛错中断） */
  baselineConflicts?: BaselineConflict[];
  /** 素材改动清单；仅在检测到且被 forceScriptsOnly 放行时携带（否则已抛错中断） */
  assetChanges?: AssetChanges;
  /** 中文摘要（经 t()） */
  note: string;
}

/**
 * 从游戏侧快照建 guid → ScriptState 索引（同 guid 先到先得，与 diff.ts 一致）。
 * guid 缺失 / 空串的元素跳过（防御性；协议保证不出现）。
 */
function gameByGuid(states: readonly ScriptState[]): Map<string, ScriptState> {
  const byGuid = new Map<string, ScriptState>();
  for (const state of states) {
    if (state === null || typeof state !== "object") {
      continue;
    }
    if (typeof state.guid !== "string" || state.guid === "") {
      continue;
    }
    if (!byGuid.has(state.guid)) {
      byGuid.set(state.guid, state);
    }
  }
  return byGuid;
}

/**
 * 判定"本地将要发送的内容"相对游戏侧是否算变化。
 * 两侧归一化后比较：任一侧缺内容（undefined）即算变化（缺 → 有 = 新增脚本，反之亦然）。
 */
function contentDiffers(localText: string, remoteText: string | undefined): boolean {
  if (remoteText === undefined) {
    return true;
  }
  return normalizeContent(localText) !== normalizeContent(remoteText);
}

/**
 * 读本地脚本 / UI 文件内容（utf8）。
 * @param filePath 文件完整路径；undefined（该维度没有本地文件）返回 undefined
 * @throws PackError code="PUSH_FAILED" 读取失败时（复用 error.pack.push.failed 键）
 */
async function readLocalText(filePath: string | undefined): Promise<string | undefined> {
  if (filePath === undefined) {
    return undefined;
  }
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    throw new PackError(
      "PUSH_FAILED",
      t("error.pack.push.failed", { detail: `${filePath}：${errMessage(err)}` }),
    );
  }
}

/** 把清单行格式化成 `  - <行>` 的多行文本（超过 {@link MAX_ERROR_LIST_LINES} 条截断）。 */
function bulletLines(lines: readonly string[]): string {
  return lines
    .slice(0, MAX_ERROR_LIST_LINES)
    .map((line) => `  - ${line}`)
    .join("\n");
}

/** 基线冲突清单 → 错误 message 的数据部分（前 10 条；hash 只取前 12 位便于阅读）。 */
function conflictLines(conflicts: readonly BaselineConflict[]): string {
  return bulletLines(
    conflicts.map((conflict) => {
      const baselineHash = conflict.baselineHash === undefined ? "（无记录）" : conflict.baselineHash.slice(0, 12);
      const remoteHash = conflict.remoteHash === undefined ? "（无记录）" : conflict.remoteHash.slice(0, 12);
      return `${conflict.name}（guid ${conflict.guid}）${conflict.kind}：基线 ${baselineHash}，游戏侧 ${remoteHash}`;
    }),
  );
}

/** 素材改动清单 → 错误 message 的数据部分（changed + added + deleted 顺序，前 10 条）。 */
function assetFileLines(changes: AssetChanges): string {
  return bulletLines([...changes.changed, ...changes.added, ...changes.deleted]);
}

/**
 * 步骤 6 + 7：过滤无变化对象并组装待发送的 ScriptState[]。
 *
 * 每个维度（script / ui）的发送内容 = 本地文件内容；本地没有该文件时用游戏侧
 * 同 guid 的现有内容补齐（约束："强制带 ui"——TTS 对缺省字段的语义是删除）。
 * 补齐后两个维度都无内容的对象跳过（防御性，collectPushItems 不会产出这种条目）。
 *
 * "无变化"判定（按实际发送内容对账）：
 * - 本地有文件的维度：归一化后与游戏侧不同 → 有变化（游戏侧没有该 guid / 该字段也算变化）；
 * - 本地没有文件的维度：发送的就是游戏侧现有内容原样 → 永远不算变化；
 * - 两个维度都无变化的对象剔除并计入 skipped。
 *
 * name 取游戏侧真实显示名（远端无该 guid 的新对象回退 PushItem 的净化名）。
 *
 * @returns 待发送 states（顺序与 items 一致）与跳过数
 * @throws PackError code="PUSH_FAILED" 本地文件读取失败时
 */
async function prepareStates(
  items: readonly PushItem[],
  remoteByGuid: Map<string, ScriptState>,
): Promise<{ states: ScriptState[]; skipped: number }> {
  const states: ScriptState[] = [];
  let skipped = 0;
  for (const item of items) {
    const remote = remoteByGuid.get(item.guid);
    const localScript = await readLocalText(item.scriptPath);
    const localUi = await readLocalText(item.uiPath);

    // —— 实际发送内容：本地优先，缺失维度用游戏侧现有内容补齐（缺字段 = TTS 删除）——
    const script = localScript ?? remote?.script;
    const ui = localUi ?? remote?.ui;
    if (script === undefined && ui === undefined) {
      skipped += 1; // 防御性：两个维度都无内容可发
      continue;
    }

    // —— 无变化过滤：本地没有文件的维度发送原样内容，恒不构成变化 ——
    const scriptChanged = localScript !== undefined && contentDiffers(localScript, remote?.script);
    const uiChanged = localUi !== undefined && contentDiffers(localUi, remote?.ui);
    if (!scriptChanged && !uiChanged) {
      skipped += 1;
      continue;
    }

    // —— name 必须用游戏内真实显示名（净化名会把对象改名）——
    const name = remote !== undefined && remote.name !== "" ? remote.name : item.name;
    const state: ScriptState = { guid: item.guid, name };
    if (script !== undefined) {
      state.script = script;
    }
    if (ui !== undefined) {
      state.ui = ui;
    }
    states.push(state);
  }
  return { states, skipped };
}

/**
 * 步骤 12 的回读校验：逐个比对"已发送 states"与"重新拉取的游戏侧快照"。
 * 按 {@link normalizeContent} 归一化后比较；发送时带了的字段回读必须存在且一致，
 * guid 整个消失也算失败。只校验发送过的对象（游戏里其他对象不归 push 管）。
 * @returns 问题描述清单（空数组 = 校验通过）
 */
function verifyStates(sent: readonly ScriptState[], reread: readonly ScriptState[]): string[] {
  const rereadByGuid = gameByGuid(reread);
  const problems: string[] = [];
  for (const state of sent) {
    const back = rereadByGuid.get(state.guid);
    if (back === undefined) {
      problems.push(`${state.name}（guid ${state.guid}）：回读快照中不存在`);
      continue;
    }
    if (
      state.script !== undefined &&
      (back.script === undefined || normalizeContent(back.script) !== normalizeContent(state.script))
    ) {
      problems.push(`${state.name}（guid ${state.guid}）：script 内容与发送不一致`);
    }
    if (
      state.ui !== undefined &&
      (back.ui === undefined || normalizeContent(back.ui) !== normalizeContent(state.ui))
    ) {
      problems.push(`${state.name}（guid ${state.guid}）：ui 内容与发送不一致`);
    }
  }
  return problems;
}

/**
 * pushSaveAndPlay 的主体流水线（步骤 3 → 13，见模块头注释）。
 * 由 {@link pushSaveAndPlay} 在「已注入 server」或「withEditorServer 窗口内」调用，
 * 本函数自身不再绑定端口。
 */
async function runPushPipeline(
  root: string,
  items: readonly PushItem[],
  scripts: SessionScripts,
  opts: PushSaveOptions,
  timeoutMs: number,
  dryRun: boolean,
): Promise<PushSaveResult> {
  // —— 3. 游戏侧快照 ——
  const remoteStates = await scripts.getScripts(timeoutMs);
  const remoteByGuid = gameByGuid(remoteStates);

  // —— 4. 素材改动检测（内容 hash 最严：任何 changed / added / deleted 都拦截）——
  const baseline = await readBaseline(root);
  const assetChanges = await detectAssetChanges(root, baseline);
  const assetChangeCount =
    assetChanges.changed.length + assetChanges.added.length + assetChanges.deleted.length;
  if (assetChangeCount > 0 && opts.forceScriptsOnly !== true) {
    throw new PackError(
      "PUSH_ASSET_CHANGES_DETECTED",
      t("error.push.assetChangesDetected", { changedCount: assetChangeCount, files: assetFileLines(assetChanges) }),
    );
  }

  // —— 5. 基线冲突检测（游戏侧相对基线被人改过 → 先 pull 对账）——
  const conflicts = await diffBaseline(root, remoteStates);
  if (conflicts.length > 0 && opts.skipBaselineCheck !== true) {
    throw new PackError(
      "BASELINE_CONFLICT",
      t("error.push.baselineConflict", { details: conflictLines(conflicts) }),
    );
  }

  // —— 6 + 7. 过滤无变化对象 + 强制带 ui，组装待发送 states ——
  const { states, skipped } = await prepareStates(items, remoteByGuid);

  // —— 8. dryRun：到此为止，不备份不确认不发送不写基线 ——
  if (dryRun) {
    return {
      dryRun: true,
      pushed: states.length,
      skipped,
      ...(assetChangeCount > 0 ? { assetChanges } : {}),
      ...(conflicts.length > 0 ? { baselineConflicts: conflicts } : {}),
      note: t("cli.pack.push.noteDryRun", { pushed: states.length, skipped }),
    };
  }

  // —— 9. 备份：游戏内全部 scriptStates 快照（confirm 之前——反悔也不丢现场）——
  let backupDir: string | undefined;
  if (opts.skipBackup !== true) {
    const backup = await createBackup({
      root,
      reason: "push",
      retention: opts.backupRetention ?? DEFAULT_BACKUP_RETENTION,
      scriptStates: remoteStates,
    });
    backupDir = backup.dir;
  }

  // —— 10. 确认门（CLI 注入；MCP 由 hub 层拦截不会到这里）——
  if (opts.confirm !== undefined) {
    const approved = await opts.confirm();
    if (!approved) {
      throw new PackError("PUSH_ABORTED", t("error.push.aborted"));
    }
  }

  // —— 11. 写回（只发过滤后的有变化对象；字段已按"缺省即删除"语义补齐）——
  await scripts.saveAndPlay(states, timeoutMs);

  // —— 12. 回读校验：发送内容必须原样回到游戏侧 ——
  const newRemoteStates = await scripts.getScripts(timeoutMs);
  const problems = verifyStates(states, newRemoteStates);
  if (problems.length > 0) {
    throw new PackError("PUSH_VERIFY_FAILED", t("error.push.verifyFailed", { details: bulletLines(problems) }));
  }

  // —— 13. 更新基线（回读快照 = 新的游戏侧基准）+ 盖推送时间戳 ——
  await writeBaseline(root, newRemoteStates);
  await touchLastPushAt(root);

  return {
    dryRun: false,
    pushed: states.length,
    skipped,
    ...(backupDir !== undefined ? { backupDir } : {}),
    ...(assetChangeCount > 0 ? { assetChanges } : {}),
    ...(conflicts.length > 0 ? { baselineConflicts: conflicts } : {}),
    note: t("cli.pack.push.noteDone", { pushed: states.length, skipped }),
  };
}

/**
 * 把本地工作区的脚本 / UI 改动安全地写回运行中的 TTS（完整流水线，
 * 步骤与安全约束见模块头注释）。
 *
 * @param opts 入参（root 必填；dryRun 缺省 true——不显式传 false 绝不实写）
 * @returns 推送结果（pushed / skipped / backupDir / 摘要等，见 {@link PushSaveResult}）
 * @throws Error root 不是非空字符串，或 timeoutMs 不是正有限数字时（调用方编程错误）
 * @throws PackError code="PACK_NOT_FOUND" / "PACK_INVALID" / "PACK_READ_FAILED"
 *   工作区 pack.yaml 缺失或非法时（原样透传）
 * @throws PackError code="PUSH_ASSET_CHANGES_DETECTED" 素材清单有改动且未
 *   forceScriptsOnly 时（message 含四步修复引导与改动文件清单）
 * @throws PackError code="BASELINE_CONFLICT" 游戏侧相对基线被人改过且未
 *   skipBaselineCheck 时（message 含冲突清单前 10 条）
 * @throws PackError code="PUSH_ABORTED" 确认门（opts.confirm）返回 false 时
 * @throws PackError code="PUSH_VERIFY_FAILED" 写回后回读与发送内容不一致时
 * @throws PackError code="PUSH_FAILED" 本地脚本 / UI 文件读取失败时
 * @throws PackError 基线 / 备份模块的错误码原样透传（见模块头注释）
 * @throws {PortInUseError} 独立模式下编辑器端口 39998 被占用时（withEditorServer 抛出）
 * @throws Error 连不上 TTS / 等待 GameLoaded 回推超时等协议层异常（原样上抛）
 */
export async function pushSaveAndPlay(opts: PushSaveOptions): Promise<PushSaveResult> {
  if (typeof opts?.root !== "string" || opts.root.trim() === "") {
    throw new Error("push 入参无效：root 必须是非空字符串路径");
  }
  if (
    opts.timeoutMs !== undefined &&
    (typeof opts.timeoutMs !== "number" || !Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)
  ) {
    throw new Error("push 入参无效：timeoutMs 必须是正有限数字（毫秒）");
  }
  const root = path.resolve(opts.root);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SAVE_TIMEOUT_MS;
  const dryRun = opts.dryRun ?? true;

  // —— 1. 工作区校验（非图包目录立刻失败，不占用编辑器端口）——
  await readPackYaml(root);

  // —— 2. 工作区清单；空清单直接返回（不连 TTS、不占 39998）——
  const collected = await collectPushItems({ root });
  if (collected.items.length === 0) {
    return { dryRun, pushed: 0, skipped: 0, note: t("cli.pack.push.noteEmpty") };
  }

  // —— 3 → 13. 坑 17：hub 注入 server 直接复用；独立模式一次 withEditorServer 包全程 ——
  if (opts.server !== undefined) {
    return runPushPipeline(root, collected.items, new SessionScripts(opts.server), opts, timeoutMs, dryRun);
  }
  return withEditorServer(({ scripts }) =>
    runPushPipeline(root, collected.items, scripts, opts, timeoutMs, dryRun),
  );
}
