// src/safety/backup.ts
/**
 * 安全备份：push 前把游戏内全部脚本 / UI 快照到 `<root>/.tts/backups/<ISO 时间戳>/`。
 *
 * 阶段 5（写入路径）安全链的第一环：任何写回 TTS 的操作（push）之前，先用
 * SessionScripts.getScripts() 拿到当前存档的完整 scriptStates，再由本模块原样
 * 落盘成一份带 manifest 的本地快照——push 出问题（对象被改名、缺字段导致 TTS
 * 删除脚本 / UI 等）时可用 {@link restoreBackup} 把快照拷回工作区找回来。
 *
 * 职责（本模块只做备份文件的读写；不连 TTS、不调 saveAndPlay、不 push）：
 * - {@link createBackup}：把 scriptStates 快照写入备份目录（scripts/ + ui/ +
 *   manifest.json），并按 retention 清理旧备份；
 * - {@link listBackups}：列出全部有效备份（按 createdAt 新→旧）；
 * - {@link pruneBackups}：只保留最新 retention 份、删除其余，返回删除份数；
 * - {@link restoreBackup}：把指定备份的 scripts/ + ui/ 复制回工作区（覆盖）。
 *
 * 写盘布局（文件名复用 layout.ts 的 {@link scriptFileName} / {@link uiFileName}，
 * 与 pull / push / unpack 的落盘命名完全一致：GUID "-1" → Global.lua / Global.xml）：
 *
 * ```
 * <root>/.tts/backups/<ISO 时间戳>/      ← new Date().toISOString().replace(/:/g, "-")，保留毫秒
 *   scripts/Global.lua / <guid>.<净化名>.lua
 *   ui/Global.xml / <guid>.<净化名>.xml
 *   manifest.json                        ← BackupManifest（2 空格缩进 + 末尾换行）
 * ```
 *
 * 关键决策（不要凭直觉"优化"掉）：
 * - 【忠实快照】scriptStates 里缺 script / ui 字段的对象只是没有对应备份文件
 *   （快照反映游戏内现状），不做补齐或删除推断；
 * - 【manifest 是备份的身份证】{@link listBackups} 只认 manifest.json 可解析且
 *   符合 BackupManifest 形状的目录（其余目录静默跳过，不报错）——半途而废的
 *   写入（manifest 尚未落盘的目录）不会被当作有效备份；{@link pruneBackups}
 *   因此只清理"能识别的"备份，无法识别的目录一律不删（宁多留、不误删）；
 * - 【restore 只覆盖、不删除】工作区里多出来的文件保留不动；skeleton.json /
 *   baseline.json / pack.yaml 一律不触碰（离线回路与基线冲突检测的基准不能被
 *   恢复动作改掉）；恢复前校验 manifest（缺失或形状不符 → BACKUP_MANIFEST_INVALID），
 *   且 timestamp 只允许单一目录名（拒绝路径分隔符 / ".." / 冒号，防路径穿越）；
 * - 【同一毫秒复用同一目录】时间戳精确到毫秒，同毫秒内两次备份会写入同一目录
 *   （后者覆盖前者的 manifest）——快照语义下视为同一次备份；
 * - 【prune 失败不吞】{@link createBackup} 末尾的清理若失败会整体上抛
 *   （BACKUP_PRUNE_FAILED），此时备份本身已成功落盘，由调用方决定是否继续 push。
 *
 * 错误码（{@link PackError.code}）：
 * - "PACK_NOT_FOUND"              工作区不合法：pack.yaml 缺失（readPackYaml 透传，仅 createBackup）
 * - "BACKUP_DIR_INVALID"          入参 timestamp 非法（路径穿越等）或 .tts/backups 被同名文件占用
 * - "BACKUP_MANIFEST_INVALID"     备份的 manifest.json 缺失 / 非法 JSON / 不符合 BackupManifest 形状（restore 时）
 * - "BACKUP_TIMESTAMP_NOT_FOUND"  restore 指定的时间戳没有对应的备份目录
 * - "BACKUP_WRITE_FAILED"         createBackup 中建目录 / 写脚本 / 写 UI / 读 baseline / 写 manifest 失败
 * - "BACKUP_RESTORE_FAILED"       restoreBackup 中把备份文件复制回工作区失败
 * - "BACKUP_PRUNE_FAILED"         pruneBackups 删除过期备份失败
 *
 * 本模块新增的 i18n 键（locales/*.json 由 Run 2 补齐；缺键时 t() 原样输出键名）：
 * - `error.safety.backup.dirInvalid` {detail}
 * - `error.safety.backup.manifestInvalid` {path} {detail}
 * - `error.safety.backup.timestampNotFound` {timestamp}
 * - `error.safety.backup.writeFailed` {detail}
 * - `error.safety.backup.restoreFailed` {detail}
 * - `error.safety.backup.pruneFailed` {detail}
 */

import type { Dirent, Stats } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { z } from "zod";

import { t } from "../i18n/index.js";
import { scriptFileName, scriptsDir, uiDir, uiFileName } from "../pack/layout.js";
import { PackError, readPackYaml } from "../pack/packyaml.js";
import type { ScriptState } from "../session/scripts.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 工具内部状态目录名（与 layout.ts 的 DIR_TTS 一致；该常量未导出，本模块自持） */
const DIR_TTS = ".tts";

/** 备份根目录名（相对工具内部状态目录：<root>/.tts/backups） */
const DIR_BACKUPS = "backups";

/** 备份目录内的脚本子目录名（与工作区 scripts/ 同名） */
const SUBDIR_SCRIPTS = "scripts";

/** 备份目录内的 UI 子目录名（与工作区 ui/ 同名） */
const SUBDIR_UI = "ui";

/** 备份清单文件名（每个备份目录一份） */
const MANIFEST_FILE = "manifest.json";

/** 基线文件名（阶段 5 基线冲突检测的基准；备份只读它算指纹，绝不改写） */
const BASELINE_FILE = "baseline.json";

/** 默认备份保留份数（createBackup 的 retention 缺省值） */
const DEFAULT_RETENTION = 20;

/** 备份目录名（时间戳）中不允许出现的字符：路径分隔符、冒号、空字节 */
const UNSAFE_DIR_NAME_RE = /[/\\:\0]/;

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** 一份备份的清单（manifest.json 的内容，同时是 listBackups 的返回元素） */
export interface BackupManifest {
  /** ISO 时间戳（同时是目录名，冒号已替换为连字符以避开 Windows 文件名限制） */
  createdAt: string;
  /** 备份原因：push 前自动备份 / 手动备份 */
  reason: "push" | "manual";
  /** 备份时的图包工作区根目录（绝对路径） */
  packRoot: string;
  /** 图包显示名（来自 pack.yaml 的 name） */
  packName: string;
  /** 备份的 Lua 脚本文件数（scriptStates 中 script 字段存在的对象数） */
  scriptsCount: number;
  /** 备份的 UI XML 文件数（scriptStates 中 ui 字段存在的对象数） */
  uiCount: number;
  /** 备份时 baseline.json 的 sha256（基线文件存在才有） */
  baselineHash?: string;
}

/** createBackup 的入参 */
export interface BackupOptions {
  /** 图包工作区根目录（必须已有 pack.yaml，否则抛 PACK_NOT_FOUND） */
  root: string;
  /** 备份原因（写入 manifest.reason）；缺省 "push" */
  reason?: "push" | "manual";
  /**
   * 备份保留份数：createBackup 成功后调 pruneBackups 清理旧备份；缺省 20；
   * <=0 视为不清理
   */
  retention?: number;
  /** 游戏内全部对象的脚本状态快照（来自 SessionScripts.getScripts() 的结果） */
  scriptStates: ScriptState[];
}

// ---------------------------------------------------------------------------
// manifest 校验（zod；非严格对象——未知字段剥掉，向前兼容旧/新版本互读）
// ---------------------------------------------------------------------------

/** BackupManifest 的 zod schema（读侧门禁：listBackups 过滤 / restore 放行） */
const backupManifestSchema = z.object({
  createdAt: z.string({ error: "createdAt 必须是字符串" }),
  reason: z.enum(["push", "manual"], { error: "reason 必须是 push / manual 之一" }),
  packRoot: z.string({ error: "packRoot 必须是字符串" }),
  packName: z.string({ error: "packName 必须是字符串" }),
  scriptsCount: z.number({ error: "scriptsCount 必须是数字" }),
  uiCount: z.number({ error: "uiCount 必须是数字" }),
  baselineHash: z.string({ error: "baselineHash 必须是字符串" }).optional(),
});

// ---------------------------------------------------------------------------
// 内部工具（各模块各自持有，不跨模块导出；与 pack/pull.ts 的同名函数同一考虑）
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
 * 将 zod 校验错误格式化为单行中文可读摘要（作为 manifestInvalid 的 detail 数据部分）。
 * @param error zod 校验错误对象
 * @returns 形如 "packName：必须是字符串" 的描述，多个问题以"；"连接
 */
function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const segments = issue.path.map((seg) => (typeof seg === "symbol" ? seg.toString() : String(seg)));
      const where = segments.length > 0 ? segments.join(".") : "(根)";
      return `${where}：${issue.message}`;
    })
    .join("；");
}

/** 构造 BACKUP_DIR_INVALID（detail 为具体原因，硬编码中文技术片段，走 t() 包装） */
function dirInvalid(detail: string): PackError {
  return new PackError("BACKUP_DIR_INVALID", t("error.safety.backup.dirInvalid", { detail }));
}

/** 构造 BACKUP_MANIFEST_INVALID */
function manifestInvalid(manifestPath: string, detail: string): PackError {
  return new PackError(
    "BACKUP_MANIFEST_INVALID",
    t("error.safety.backup.manifestInvalid", { path: manifestPath, detail }),
  );
}

/** 构造 BACKUP_TIMESTAMP_NOT_FOUND */
function timestampNotFound(timestamp: string): PackError {
  return new PackError("BACKUP_TIMESTAMP_NOT_FOUND", t("error.safety.backup.timestampNotFound", { timestamp }));
}

/** 构造 BACKUP_WRITE_FAILED */
function writeFailed(detail: string): PackError {
  return new PackError("BACKUP_WRITE_FAILED", t("error.safety.backup.writeFailed", { detail }));
}

/** 构造 BACKUP_RESTORE_FAILED */
function restoreFailed(detail: string): PackError {
  return new PackError("BACKUP_RESTORE_FAILED", t("error.safety.backup.restoreFailed", { detail }));
}

/** 构造 BACKUP_PRUNE_FAILED */
function pruneFailed(detail: string): PackError {
  return new PackError("BACKUP_PRUNE_FAILED", t("error.safety.backup.pruneFailed", { detail }));
}

/**
 * 执行一个备份写入步骤，把非 PackError 的异常统一包装成 BACKUP_WRITE_FAILED。
 * @param detail 出错时展示的步骤描述（含路径）
 * @param fn 实际执行的步骤
 * @returns fn 的返回值
 * @throws PackError code="BACKUP_WRITE_FAILED" 步骤抛出非 PackError 异常时
 */
async function guardWrite<T>(detail: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PackError) {
      throw err;
    }
    throw writeFailed(`${detail}：${errMessage(err)}`);
  }
}

/**
 * 执行一个恢复步骤，把非 PackError 的异常统一包装成 BACKUP_RESTORE_FAILED。
 * @param detail 出错时展示的步骤描述（含路径）
 * @param fn 实际执行的步骤
 * @returns fn 的返回值
 * @throws PackError code="BACKUP_RESTORE_FAILED" 步骤抛出非 PackError 异常时
 */
async function guardRestore<T>(detail: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PackError) {
      throw err;
    }
    throw restoreFailed(`${detail}：${errMessage(err)}`);
  }
}

/** 解析备份根目录 `<root>/.tts/backups`。 */
function backupsDir(root: string): string {
  return path.join(root, DIR_TTS, DIR_BACKUPS);
}

/**
 * 生成本次备份的目录名（ISO 时间戳，冒号换连字符，保留毫秒）。
 * @returns 形如 "2026-10-05T08-15-30.123Z" 的字符串
 */
function backupTimestamp(): string {
  return new Date().toISOString().replace(/:/g, "-");
}

/**
 * 校验"备份目录名"是否安全（restore 的 timestamp 入参、prune 的删除目标都过这道门）。
 * 规则：非空字符串；不含路径分隔符 / 冒号 / 空字节；不含 ".."（防路径穿越——
 * 合法时间戳是单一文件名片段，永远满足这些条件）。
 * @param name 待校验值（可能来自不可信调用方 / manifest.json）
 * @returns 是安全的单一目录名时 true
 */
function isSafeBackupDirName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name !== "" &&
    name.trim() !== "" &&
    !name.includes("..") &&
    !UNSAFE_DIR_NAME_RE.test(name)
  );
}

/**
 * 探测备份根目录状态：不存在返回 false；存在且是目录返回 true；
 * 被同名文件占用（含父目录被文件占用导致的 ENOTDIR）抛 BACKUP_DIR_INVALID。
 * @param backupsRoot `<root>/.tts/backups` 的完整路径
 * @returns 目录是否存在
 * @throws PackError code="BACKUP_DIR_INVALID" 路径被文件占用时
 * @throws Error 其他 IO 错误（由调用方按各自错误码包装）
 */
async function backupsRootIsDir(backupsRoot: string): Promise<boolean> {
  let st: Stats;
  try {
    st = await stat(backupsRoot);
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return false;
    }
    if (errCode(err) === "ENOTDIR") {
      throw dirInvalid(`${backupsRoot} 不是目录（路径被同名文件占用）`);
    }
    throw err;
  }
  if (!st.isDirectory()) {
    throw dirInvalid(`${backupsRoot} 不是目录（路径被同名文件占用）`);
  }
  return true;
}

/**
 * 读取文件内容（二进制）；文件不存在返回 undefined，其他错误原样上抛（由调用方包装）。
 * @param file 文件完整路径
 * @returns 文件内容；ENOENT 时返回 undefined
 */
async function readBufferIfExists(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/**
 * 读取并校验一个备份目录的 manifest.json（listBackups 的宽松门禁）。
 *
 * 读不到 / 非法 JSON / 不符合 BackupManifest 形状一律返回 undefined，
 * 由调用方把该目录跳过（不报错）——半途而废或被手工改坏的目录不是有效备份。
 *
 * @param backupDir 备份目录完整路径
 * @returns 校验通过的 manifest；不可用时返回 undefined
 */
async function readManifestIfValid(backupDir: string): Promise<BackupManifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(backupDir, MANIFEST_FILE), "utf8");
  } catch {
    return undefined; // 缺失 / 权限等：视为没有有效 manifest
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined; // 非法 JSON
  }
  const parsed = backupManifestSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/**
 * 把备份子目录的全部内容复制到目标目录（递归、覆盖同名文件、不删除目标多余文件）。
 *
 * 源目录不存在（备份没有该子目录）按"没有可恢复内容"静默返回；
 * 符号链接等其他类型一律跳过：备份由本工具写出，不应包含它们，出现即视为
 * 目录被手工改动，恢复时宁可少恢复也不执行来历不明的链接目标。
 *
 * @param srcDir 源目录（备份内的 scripts/ 或 ui/）
 * @param destDir 目标目录（工作区的 scripts/ 或 ui/；不存在时自动创建）
 * @throws Error 复制过程中的 IO 错误（由调用方包装成 BACKUP_RESTORE_FAILED）
 */
async function copyDirContents(srcDir: string, destDir: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return;
    }
    throw err;
  }
  await mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirContents(src, dest);
    } else if (entry.isFile()) {
      await copyFile(src, dest); // copyFile 默认覆盖同名目标文件
    }
  }
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 创建一份备份：把 scriptStates 快照写入 `<root>/.tts/backups/<时间戳>/`。
 *
 * 流程：
 * 1. {@link readPackYaml} 校验工作区（pack.yaml 缺失 / 非法原样抛出）；
 * 2. 确认 `<root>/.tts/backups` 未被文件占用，mkdir -p `<时间戳>/scripts` 与 `/ui`；
 * 3. 逐对象落盘：script 字段存在 → 写 scripts/，ui 字段存在 → 写 ui/
 *    （文件名用 layout 的 {@link scriptFileName} / {@link uiFileName}）；
 * 4. `.tts/baseline.json` 存在时计算其 sha256 记入 manifest（只读不改）；
 * 5. 写 manifest.json（2 空格缩进 + 末尾换行）；
 * 6. {@link pruneBackups}(root, retention) 清理旧备份（retention<=0 时不清理）。
 *
 * @param opts 入参（root / scriptStates 必填；reason 缺省 "push"；retention 缺省 20）
 * @returns 备份目录完整路径与写入的 manifest（createdAt 即目录名）
 * @throws Error root 不是非空字符串、scriptStates 不是数组、reason 非法时（调用方编程错误）
 * @throws PackError code="PACK_NOT_FOUND" `<root>/pack.yaml` 不存在时（readPackYaml 透传）
 * @throws PackError code="PACK_INVALID" / "PACK_READ_FAILED" pack.yaml 损坏时（透传）
 * @throws PackError code="BACKUP_DIR_INVALID" `.tts/backups` 被同名文件占用时
 * @throws PackError code="BACKUP_WRITE_FAILED" 建目录 / 写文件 / 读 baseline 失败时
 * @throws PackError code="BACKUP_PRUNE_FAILED" 末尾清理旧备份失败时（备份本身已落盘）
 */
export async function createBackup(opts: BackupOptions): Promise<{ dir: string; manifest: BackupManifest }> {
  if (typeof opts?.root !== "string" || opts.root.trim() === "") {
    throw new Error("backup 入参无效：root 必须是非空字符串路径");
  }
  if (!Array.isArray(opts.scriptStates)) {
    throw new Error("backup 入参无效：scriptStates 必须是数组");
  }
  if (opts.reason !== undefined && opts.reason !== "push" && opts.reason !== "manual") {
    throw new Error('backup 入参无效：reason 只能是 "push" 或 "manual"');
  }
  const root = path.resolve(opts.root);
  const reason = opts.reason ?? "push";
  const retention = opts.retention ?? DEFAULT_RETENTION;

  // —— 1. 工作区合法性：pack.yaml 缺失 / 非法由 readPackYaml 抛 PackError（透传）——
  const meta = await readPackYaml(root);

  // —— 2. 备份目录：先确认 .tts/backups 未被文件占用，再 mkdir -p 两个子目录 ——
  const backupsRoot = backupsDir(root);
  await guardWrite("检查备份根目录", () => backupsRootIsDir(backupsRoot));
  const timestamp = backupTimestamp();
  const dir = path.join(backupsRoot, timestamp);
  await guardWrite(`创建备份目录 ${dir}`, () => mkdir(path.join(dir, SUBDIR_SCRIPTS), { recursive: true }));
  await guardWrite(`创建备份目录 ${dir}`, () => mkdir(path.join(dir, SUBDIR_UI), { recursive: true }));

  // —— 3. 逐对象落盘：缺 script / ui 字段 = 游戏内该对象没有对应内容，不写文件 ——
  let scriptsCount = 0;
  let uiCount = 0;
  for (const element of opts.scriptStates) {
    // 运行时数据可能不是合法对象（JS 调用方绕过类型）；显式收窄后再比较，避免与 null 无交集
    const state = element as ScriptState | null | undefined;
    if (state === null || typeof state !== "object") {
      throw new Error("backup 入参无效：scriptStates 元素必须是对象");
    }
    const script = state.script;
    if (script !== undefined) {
      const file = await guardWrite(`计算脚本备份文件名（对象 ${String(state.name)}）`, () =>
        path.join(dir, SUBDIR_SCRIPTS, scriptFileName(state.guid, state.name)),
      );
      await guardWrite(`备份脚本 ${file}`, () => writeFile(file, script, "utf8"));
      scriptsCount += 1;
    }
    const ui = state.ui;
    if (ui !== undefined) {
      const file = await guardWrite(`计算 UI 备份文件名（对象 ${String(state.name)}）`, () =>
        path.join(dir, SUBDIR_UI, uiFileName(state.guid, state.name)),
      );
      await guardWrite(`备份 UI ${file}`, () => writeFile(file, ui, "utf8"));
      uiCount += 1;
    }
  }

  // —— 4. baseline.json 指纹（存在才算；只读不改——备份/恢复都不能动基线基准）——
  const baselineFile = path.join(root, DIR_TTS, BASELINE_FILE);
  const baselineData = await guardWrite(`读取 ${baselineFile}`, () => readBufferIfExists(baselineFile));
  const baselineHash =
    baselineData !== undefined ? createHash("sha256").update(baselineData).digest("hex") : undefined;

  // —— 5. manifest.json（2 空格缩进 + 末尾换行；baselineHash 为 undefined 时 JSON 不含该键）——
  const manifest: BackupManifest = {
    createdAt: timestamp,
    reason,
    packRoot: root,
    packName: meta.name,
    scriptsCount,
    uiCount,
    baselineHash,
  };
  const manifestFile = path.join(dir, MANIFEST_FILE);
  await guardWrite(`写入 ${manifestFile}`, () =>
    writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  );

  // —— 6. 清理旧备份（retention<=0 时 pruneBackups 直接返回 0，不做任何删除）——
  await pruneBackups(root, retention);

  return { dir, manifest };
}

/**
 * 列出图包的全部有效备份（按 createdAt 倒序：新 → 旧）。
 *
 * 扫 `<root>/.tts/backups/` 下的目录，逐个读 manifest.json：
 * 读不到、非法 JSON 或不符合 BackupManifest 形状的目录静默跳过（不报错）；
 * 散文件与符号链接不当作备份。备份根目录不存在时返回空数组。
 *
 * @param root 图包工作区根目录
 * @returns 有效备份的 manifest 列表（新 → 旧）
 * @throws Error root 不是非空字符串时（调用方编程错误）
 * @throws PackError code="BACKUP_DIR_INVALID" `.tts/backups` 被同名文件占用 / 无法读取时
 */
export async function listBackups(root: string): Promise<BackupManifest[]> {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error("backup 入参无效：root 必须是非空字符串路径");
  }
  const backupsRoot = backupsDir(path.resolve(root));
  if (!(await backupsRootIsDir(backupsRoot))) {
    return []; // 备份根目录不存在 → 没有任何备份
  }
  let entries: Dirent[];
  try {
    entries = await readdir(backupsRoot, { withFileTypes: true });
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return []; // 探测与读取之间的竞态兜底：仍视为没有备份
    }
    throw dirInvalid(`${backupsRoot} 无法读取：${errMessage(err)}`);
  }

  const manifests: BackupManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue; // 散文件 / 符号链接不当作备份
    }
    const manifest = await readManifestIfValid(path.join(backupsRoot, entry.name));
    if (manifest !== undefined) {
      manifests.push(manifest);
    }
  }
  // 固定格式（等长 ISO 变体）的时间戳按字典序比较即时间序；新 → 旧
  return manifests.sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0));
}

/**
 * 清理过期备份：只保留最新 retention 份，删除其余，返回删除份数。
 *
 * 以 {@link listBackups} 的结果为准——只有 manifest 合法可读的目录才参与
 * 计数与删除（manifest 损坏的目录既不计入份数也不会被删，宁多留、不误删）；
 * createdAt 推不出安全目录名的条目同样跳过不删。
 *
 * @param root 图包工作区根目录
 * @param retention 保留份数；<=0（或非法值）视为不清理，直接返回 0
 * @returns 实际删除的备份份数
 * @throws Error root 不是非空字符串时（调用方编程错误）
 * @throws PackError code="BACKUP_DIR_INVALID" `.tts/backups` 被同名文件占用 / 无法读取时（listBackups 抛出）
 * @throws PackError code="BACKUP_PRUNE_FAILED" 删除目录失败时
 */
export async function pruneBackups(root: string, retention: number): Promise<number> {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error("backup 入参无效：root 必须是非空字符串路径");
  }
  if (typeof retention !== "number" || !Number.isFinite(retention) || retention <= 0) {
    return 0; // <=0（含 NaN / Infinity 等非法值）视为不清理
  }
  const rootResolved = path.resolve(root);
  const backupsRoot = backupsDir(rootResolved);
  const stale = (await listBackups(rootResolved)).slice(retention);

  let removed = 0;
  for (const manifest of stale) {
    if (!isSafeBackupDirName(manifest.createdAt)) {
      continue; // 保守：目录名推不出来的一律不删
    }
    const dir = path.join(backupsRoot, manifest.createdAt);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      throw pruneFailed(`删除过期备份 ${dir}：${errMessage(err)}`);
    }
    removed += 1;
  }
  return removed;
}

/**
 * 把指定备份的 scripts/ + ui/ 复制回工作区（覆盖同名文件，不删除工作区多余文件）。
 *
 * 边界（安全约束，见模块头注释）：
 * - 只恢复到工作区 `<root>/scripts/` 与 `<root>/ui/`——**不 push**（不触碰 TTS）；
 * - **不动** skeleton.json / baseline.json / pack.yaml；
 * - 恢复前校验 manifest.json（缺失 / 非法 JSON / 形状不符 → BACKUP_MANIFEST_INVALID）：
 *   只有本工具写出的完整快照才允许恢复；
 * - timestamp 必须是单一目录名（拒绝路径分隔符 / ".." / 冒号），防路径穿越。
 *
 * @param root 图包工作区根目录
 * @param timestamp 备份目录名（即 manifest.createdAt，同 listBackups 返回值）
 * @throws Error root 不是非空字符串时（调用方编程错误）
 * @throws PackError code="BACKUP_DIR_INVALID" timestamp 非法（路径穿越等）或备份根路径被文件占用时
 * @throws PackError code="BACKUP_TIMESTAMP_NOT_FOUND" 时间戳没有对应的备份目录（或不是目录）时
 * @throws PackError code="BACKUP_MANIFEST_INVALID" 备份的 manifest.json 缺失或非法时
 * @throws PackError code="BACKUP_RESTORE_FAILED" 复制文件到工作区失败时
 */
export async function restoreBackup(root: string, timestamp: string): Promise<void> {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error("backup 入参无效：root 必须是非空字符串路径");
  }
  if (!isSafeBackupDirName(timestamp)) {
    throw dirInvalid(`timestamp 非法（不允许路径分隔符 / ".." / 冒号）：${JSON.stringify(timestamp)}`);
  }
  const rootResolved = path.resolve(root);
  const backupsRoot = backupsDir(rootResolved);

  // —— 1. 备份根检查 + 定位备份目录（必须存在且是目录）——
  // 先确认备份根本身是目录：Windows 下 stat 穿过"文件型路径段"报 ENOENT 而不是
  // ENOTDIR，靠目标 stat 区分不出"根被文件占用"和"时间戳不存在"
  const rootIsDir = await guardRestore(`检查备份根目录 ${backupsRoot}`, () => backupsRootIsDir(backupsRoot));
  if (!rootIsDir) {
    throw timestampNotFound(timestamp); // 备份根不存在 → 任何时间戳都不存在
  }
  const dir = path.join(backupsRoot, timestamp);
  let st: Stats;
  try {
    st = await stat(dir);
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      throw timestampNotFound(timestamp);
    }
    throw restoreFailed(`读取备份目录 ${dir}：${errMessage(err)}`);
  }
  if (!st.isDirectory()) {
    throw timestampNotFound(timestamp);
  }

  // —— 2. manifest 合法性门禁：只有本工具写出的完整快照才允许恢复 ——
  const manifestFile = path.join(dir, MANIFEST_FILE);
  let data: unknown;
  try {
    data = JSON.parse(await readFile(manifestFile, "utf8"));
  } catch (err) {
    throw manifestInvalid(manifestFile, errMessage(err));
  }
  const parsed = backupManifestSchema.safeParse(data);
  if (!parsed.success) {
    throw manifestInvalid(manifestFile, formatZodIssues(parsed.error));
  }

  // —— 3. 复制 scripts/ + ui/ 到工作区（覆盖；不删多余文件；不碰 skeleton/baseline/pack.yaml）——
  await guardRestore(`恢复脚本到 ${scriptsDir(rootResolved)}`, () =>
    copyDirContents(path.join(dir, SUBDIR_SCRIPTS), scriptsDir(rootResolved)),
  );
  await guardRestore(`恢复 UI 到 ${uiDir(rootResolved)}`, () =>
    copyDirContents(path.join(dir, SUBDIR_UI), uiDir(rootResolved)),
  );
}
