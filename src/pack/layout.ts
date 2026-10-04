// src/pack/layout.ts
/**
 * 图包（pack）工作区目录布局模块。
 *
 * 职责：
 * - 定义图包工作区的标准目录布局与布局版本号（{@link PACK_DIRS} / {@link PACK_LAYOUT_VERSION}）；
 * - 幂等初始化目录结构（{@link ensureLayout}），并放置 .tts/.gitkeep 占位文件；
 * - 提供各子目录与骨架存档的路径换算（scriptsDir / uiDir / decksDir / objectsDir / skeletonPath）；
 * - 提供脚本 / UI 文件命名规则（{@link scriptFileName} / {@link uiFileName}），
 *   与 `tts pull`（src/cli/commands/pull.ts）的落盘命名保持一致。
 *
 * 标准目录布局（均相对图包根 <root>）：
 *
 * ```
 * packs/<图包名>/
 *   pack.yaml        图包元数据（由元数据模块负责，本模块不创建）
 *   scripts/         Lua 脚本：<guid>.<sanitize(name)>.lua；全局脚本（GUID=-1）是 Global.lua
 *   ui/              UI XML：同命名规则，扩展名 .xml
 *   decks/           卡牌组：每个子目录一个 deck（deck.yaml + 图片）
 *   objects/         对象：每个子目录一个 object（data.json + 素材）
 *   sheets/          表（备用）
 *   source/          源文件（备用）
 *   .tts/            工具内部状态（不作为图包内容对外发布）
 *     .gitkeep       空占位文件——git 不跟踪空目录，靠它保证 .tts/ 骨架入库
 *     skeleton.json  骨架存档（约束 8：绝不入 git，由图包 .gitignore 排除；本模块不写）
 *     backups/       备份
 *     cache/         缓存
 * ```
 *
 * 设计边界：
 * - 本模块只负责"目录与命名"：不创建 .git / .gitattributes / .gitignore /
 *   pack.yaml（分别由 git 初始化模块与元数据模块负责）；
 * - 约束 9（objects 与卡牌将来共用同一遍历器，阶段 2B 实现）：{@link decksDir}
 *   与 {@link objectsDir} 是同级兄弟目录，内部子目录结构约定一致
 *   （deck.yaml / data.json + 素材），为共用遍历器预留对称入口，本模块不实现遍历器；
 * - {@link sanitizeName} 与 src/cli/commands/pull.ts 的同名函数逐字一致：
 *   按约定复制粘贴、不跨模块 import 命令层实现，两处规则如需调整必须同步修改。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { GLOBAL_GUID } from "../protocol/messages.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 图包布局版本号：将来写入 pack.yaml 的 layoutVersion 字段，供布局迁移判断 */
export const PACK_LAYOUT_VERSION = 1;

/** 图包根目录下的 scripts/ 子目录名 */
const DIR_SCRIPTS = "scripts";

/** 图包根目录下的 ui/ 子目录名 */
const DIR_UI = "ui";

/** 图包根目录下的 decks/ 子目录名 */
const DIR_DECKS = "decks";

/** 图包根目录下的 objects/ 子目录名 */
const DIR_OBJECTS = "objects";

/** 图包根目录下的 sheets/ 子目录名（备用） */
const DIR_SHEETS = "sheets";

/** 图包根目录下的 source/ 子目录名（备用） */
const DIR_SOURCE = "source";

/** 图包根目录下的工具内部状态目录名（点开头；存放骨架存档 / 备份 / 缓存） */
const DIR_TTS = ".tts";

/** 工具内部状态目录下的备份子目录（相对图包根） */
const DIR_BACKUPS = ".tts/backups";

/** 工具内部状态目录下的缓存子目录（相对图包根） */
const DIR_CACHE = ".tts/cache";

/**
 * 图包工作区的全部标准目录（相对图包根的路径，固定用 "/" 分隔，
 * 由调用方经 path.join 与根路径拼接——path 会按平台归一化分隔符）。
 * {@link ensureLayout} 逐项按 mkdir -p 语义创建。
 */
export const PACK_DIRS: readonly string[] = Object.freeze([
  DIR_SCRIPTS,
  DIR_UI,
  DIR_DECKS,
  DIR_OBJECTS,
  DIR_SHEETS,
  DIR_SOURCE,
  DIR_TTS,
  DIR_BACKUPS,
  DIR_CACHE,
]);

/** .tts/ 下的目录占位文件名（git 不跟踪空目录，用空占位文件保住目录结构） */
const GITKEEP_NAME = ".gitkeep";

/** 骨架存档文件名（约束 8：绝不入 git，由图包 .gitignore 排除） */
const SKELETON_FILE = "skeleton.json";

// ---------------------------------------------------------------------------
// 文件名净化（从 src/cli/commands/pull.ts 复制，保持逐字一致）
// ---------------------------------------------------------------------------

/** Windows 文件名非法字符（`/ \ ? % * : | " < >`） */
const INVALID_FILENAME_CHARS = /[/\\?%*:|"<>]/g;

/** Windows 文件名同样不允许的控制字符 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * 把对象名净化成安全的文件名片段。
 *
 * （与 src/cli/commands/pull.ts 的同名导出函数逻辑逐字一致；按约定复制粘贴、
 * 不跨模块 import 命令层的命名实现——两处规则如需调整必须同步修改。
 * 导出给 unpack.ts 复用：空 GUID 对象（工坊原包尚未分配 GUID）的落盘主干
 * 退化为纯净化名，见 unpack.ts 的 {@link objectStem}。）
 *
 * 规则（顺序有讲究）：
 * 1. 连续空白（含 tab / 换行）转单个下划线——必须在删控制字符之前做，
 *    否则 tab 会被当控制字符删掉而丢掉词边界；
 * 2. 删除剩余控制字符；
 * 3. 删除 Windows 非法字符 `/ \ ? % * : | " < >`；
 * 4. 去掉前导的点 / 下划线与结尾的点 / 空格（Windows 会静默截断结尾的点与空格）；
 * 5. 结果为空时回退 "object"（保证永远能得到可用文件名）。
 *
 * @param raw - 对象原始名称（如 "Chess Pawn"）
 * @returns 可安全用于文件名的片段（如 "Chess_Pawn"）
 */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, "_")
    .replace(CONTROL_CHARS, "")
    .replace(INVALID_FILENAME_CHARS, "")
    .replace(/^[._]+/, "")
    .replace(/[._ ]+$/, "");
  return cleaned === "" ? "object" : cleaned;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 校验图包根路径入参（防止空串被 path.join 静默解析成相对 cwd 的路径）。
 * @param root - 图包根目录
 * @returns 校验通过的原路径（原样返回，不做 resolve）
 * @throws root 不是非空字符串时抛出中文错误
 */
function assertRoot(root: string): string {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error("pack 布局入参无效：root 必须是非空字符串路径");
  }
  return root;
}

/**
 * 计算单个对象的落盘文件名（{@link scriptFileName} / {@link uiFileName} 的公共实现）。
 *
 * 命名规则与 `tts pull` 一致：guid 为 {@link GLOBAL_GUID}（"-1"，全局脚本）时
 * 文件名主干固定为 "Global"；其他对象为 "<guid>.<净化名>"。
 *
 * @param guid - 对象 GUID
 * @param name - 对象名称（先经 {@link sanitizeName} 净化）
 * @param ext - 扩展名（含点）：".lua" 或 ".xml"
 * @returns 形如 "Global.lua" / "<guid>.<净化名>.lua" 的文件名
 * @throws guid 不是非空字符串，或 name 不是字符串时抛出中文错误
 */
function objectFileName(guid: string, name: string, ext: ".lua" | ".xml"): string {
  if (typeof guid !== "string" || guid.trim() === "") {
    throw new Error("pack 布局入参无效：guid 必须是非空字符串");
  }
  if (typeof name !== "string") {
    throw new Error("pack 布局入参无效：name 必须是字符串");
  }
  return guid === GLOBAL_GUID ? `Global${ext}` : `${guid}.${sanitizeName(name)}${ext}`;
}

// ---------------------------------------------------------------------------
// 导出函数：路径换算
// ---------------------------------------------------------------------------

/**
 * 解析图包 scripts/ 目录路径（Lua 脚本落盘位置）。
 * @param root - 图包根目录（原样拼接，不做 resolve）
 * @returns `<root>/scripts`
 * @throws root 不是非空字符串时抛出中文错误
 */
export function scriptsDir(root: string): string {
  return path.join(assertRoot(root), DIR_SCRIPTS);
}

/**
 * 解析图包 ui/ 目录路径（UI XML 落盘位置）。
 * @param root - 图包根目录（原样拼接，不做 resolve）
 * @returns `<root>/ui`
 * @throws root 不是非空字符串时抛出中文错误
 */
export function uiDir(root: string): string {
  return path.join(assertRoot(root), DIR_UI);
}

/**
 * 解析图包 decks/ 目录路径（卡牌组根目录）。
 *
 * 约束 9：decks/ 与 objects/ 是同级兄弟目录，内部子目录结构约定一致，
 * 阶段 2B 的共用遍历器以这两个入口为对称起点。
 *
 * @param root - 图包根目录（原样拼接，不做 resolve）
 * @returns `<root>/decks`
 * @throws root 不是非空字符串时抛出中文错误
 */
export function decksDir(root: string): string {
  return path.join(assertRoot(root), DIR_DECKS);
}

/**
 * 解析图包 objects/ 目录路径（对象根目录）。
 *
 * 约束 9：objects/ 与 decks/ 是同级兄弟目录，内部子目录结构约定一致，
 * 阶段 2B 的共用遍历器以这两个入口为对称起点。
 *
 * @param root - 图包根目录（原样拼接，不做 resolve）
 * @returns `<root>/objects`
 * @throws root 不是非空字符串时抛出中文错误
 */
export function objectsDir(root: string): string {
  return path.join(assertRoot(root), DIR_OBJECTS);
}

/**
 * 解析骨架存档路径。
 *
 * 约束 8：骨架存档（.tts/skeleton.json）是离线回路的关键中间产物，
 * 绝不入 git——图包的 .gitignore 必须排除它（由 git 初始化模块负责写入），
 * 本模块只提供路径、不负责写文件。
 *
 * @param root - 图包根目录（原样拼接，不做 resolve）
 * @returns `<root>/.tts/skeleton.json`
 * @throws root 不是非空字符串时抛出中文错误
 */
export function skeletonPath(root: string): string {
  return path.join(assertRoot(root), DIR_TTS, SKELETON_FILE);
}

// ---------------------------------------------------------------------------
// 导出函数：布局初始化
// ---------------------------------------------------------------------------

/**
 * 幂等初始化图包工作区目录布局。
 *
 * 行为：
 * - 在 root 下创建 {@link PACK_DIRS} 列出的全部目录（mkdir -p 语义，
 *   目录已存在时不报错，可重复调用）；
 * - 写 `.tts/.gitkeep` 空占位文件：git 不跟踪空目录，靠它保证 .tts/ 目录
 *   结构能入库；重复写入空内容是幂等的，也会把意外非空的 .gitkeep 归零；
 * - 不创建 .git / .gitattributes / .gitignore / pack.yaml（见模块头注释）。
 *
 * @param root - 图包根目录（相对或绝对路径均可，原样拼接不做 resolve）
 * @returns 布局就绪后 resolve 的 Promise
 * @throws root 不是非空字符串时抛出中文错误；
 *   目录创建 / 占位文件写入的 fs 错误（权限不足、路径被文件占用等）
 *   原样向上抛出，由调用方决定如何呈现
 */
export async function ensureLayout(root: string): Promise<void> {
  const base = assertRoot(root);
  for (const rel of PACK_DIRS) {
    // recursive: true 保证幂等：目录已存在（含嵌套目录部分存在）时静默跳过
    await mkdir(path.join(base, rel), { recursive: true });
  }
  await writeFile(path.join(base, DIR_TTS, GITKEEP_NAME), "", "utf8");
}

// ---------------------------------------------------------------------------
// 导出函数：脚本 / UI 文件命名
// ---------------------------------------------------------------------------

/**
 * 计算对象 Lua 脚本在 scripts/ 目录下的文件名。
 *
 * 命名规则与 `tts pull` 落盘一致：
 * - guid 为 "-1"（{@link GLOBAL_GUID}，全局脚本）→ `Global.lua`；
 * - 其他对象 → `<guid>.<sanitizeName(name)>.lua`（空名净化后回退 "object"）。
 *
 * @param guid - 对象 GUID（TTS 存档中的 guid 字段；"-1" 表示全局脚本）
 * @param name - 对象名称（会先净化）
 * @returns 文件名（不含目录；调用方用 {@link scriptsDir} 拼接完整路径）
 * @throws guid 不是非空字符串，或 name 不是字符串时抛出中文错误
 */
export function scriptFileName(guid: string, name: string): string {
  return objectFileName(guid, name, ".lua");
}

/**
 * 计算对象 UI XML 在 ui/ 目录下的文件名。
 *
 * 命名规则与 {@link scriptFileName} 相同，仅扩展名为 `.xml`：
 * guid 为 "-1"（全局 UI）→ `Global.xml`；其他对象 → `<guid>.<sanitizeName(name)>.xml`。
 *
 * @param guid - 对象 GUID（TTS 存档中的 guid 字段；"-1" 表示全局 UI）
 * @param name - 对象名称（会先净化）
 * @returns 文件名（不含目录；调用方用 {@link uiDir} 拼接完整路径）
 * @throws guid 不是非空字符串，或 name 不是字符串时抛出中文错误
 */
export function uiFileName(guid: string, name: string): string {
  return objectFileName(guid, name, ".xml");
}
