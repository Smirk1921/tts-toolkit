// src/pack/push.ts
/**
 * push：图包工作区 → 运行中的 TTS（脚本 / UI 写回）——**骨架实现**。
 *
 * 阶段边界（本窗口只做第 1 步）：
 * - 本模块当前**不连接 TTS、不调用 saveAndPlay**，只把"将要推送什么"收集成清单，
 *   真正的 Save & Play 写入在阶段 5 接通（见 施工流程.md 阶段 5 任务 5.4 / 5.6，
 *   以及方案设计 §11.6）；
 * - 因此 {@link collectPushItems} 是纯离线操作（只读 pack.yaml 与工作区文件），
 *   不需要游戏运行，可在测试里直接断言。
 *
 * 职责（当前窗口）：
 * 1. {@link readPackYaml} 校验工作区（pack.yaml 缺失 / 损坏一律抛出，不静默跳过）；
 * 2. 扫 `scripts/`（`.lua`）与 `ui/`（`.xml`）目录，按文件名解析 guid 与 name；
 * 3. 按 guid 合并成 {@link PushItem} 清单（脚本与 UI 都记在同一个对象上）；
 * 4. 返回 {@link PushResult}：清单 + 待推送对象数 + 告知"阶段 5 才实际推送"的说明文字。
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
 * - `cli.pack.push.note` {count} —— 告知"阶段 5 才实际推送"的说明文字
 * - `error.pack.push.failed` {detail}
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { t } from "../i18n/index.js";
import { GLOBAL_GUID } from "../protocol/messages.js";
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
  /** 说明文字（中文、经 t()）：告知用户阶段 5 才实际推送 */
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
 *    （note 经 `t("cli.pack.push.note", { count })` 生成，明确告知阶段 5 才实际推送）。
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
