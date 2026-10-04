// src/vcs/lfs.ts
/**
 * git-lfs 状态机：管理仓库的 lfs 启用状态，与 pack.yaml 的 `vcs.lfs` 三选一同步。
 *
 * "三方"指 lfs 启用状态的三个载体，任何一方漂移都会让图片 checkout 出问题：
 * 1. 系统：本机是否装了 git-lfs（`git lfs version`）；
 * 2. 仓库：`.gitattributes` 是否声明了 lfs filter 规则；
 * 3. 清单：pack.yaml 的 `vcs.lfs`（"enabled" / "disabled" / "disabled-no-lfs"）。
 *
 * 公共 API：
 * - {@link inspectLfs}   只读检查，不写盘：三方现状 + 中文警告列表 + 一致性结论；
 * - {@link enableLfs}    启用：写 / 补全 .gitattributes 规则 + pack.yaml → "enabled"；
 * - {@link disableLfs}   禁用：清除 .gitattributes 中含 filter=lfs 的行（保留其他行）
 *                        + pack.yaml → "disabled"；清空后只剩空行 / 注释则删除文件；
 * - {@link migrateLfs}   `git lfs migrate import --include=<模式表> --everything`
 *                        （重写全部历史，把历史提交里的图片转成 lfs 指针）；
 * - {@link isLfsPointer} 判断单个文件是不是 lfs 指针（文件头 100 字节含
 *                        "version https://git-lfs"）。
 *
 * 设计边界（B3 约定）：
 * - **禁用不做二次确认**——约束 10 的二次确认在 CLI 层（vcs.ts）做，本模块只负责
 *   落盘；调用方必须已经拿到用户的明确确认；
 * - enable / disable 是纯文件 + pack.yaml 操作，不要求 packRoot 是 git 仓库；
 *   migrateLfs 必须在 git 仓库里跑（且工作区干净，git lfs migrate 会自行拒绝脏仓库）；
 * - git 子进程全部经由 src/vcs/git.ts，不直接 execa；
 * - .gitattributes 的 lfs 规则模板与 B1 init.ts（GITATTRIBUTES_LINES）逐行一致，
 *   两处按仓库惯例复制粘贴维护，调整时必须同步修改。
 *
 * 错误码（{@link PackError.code}）：
 * - "LFS_NOT_INSTALLED"      migrateLfs 时本机没装 git-lfs
 * - "LFS_ATTRIBUTES_FAILED"  .gitattributes 读取发生"文件不存在"以外的 IO 错误
 * - pack.yaml 相关错误原样透传自 readPackYaml / writePackYaml
 *   （"PACK_NOT_FOUND" 不是图包工作区 / "PACK_INVALID" 清单不合规 /
 *   "PACK_READ_FAILED"、"PACK_WRITE_FAILED" IO 错误）
 * - git 子进程错误透传自 src/vcs/git.ts（"GIT_NOT_FOUND" / "GIT_COMMAND_FAILED"）
 *
 * 本模块离线：不 import 命令层 / with-server.ts / session/*；
 * 错误消息按 B3 约定写死中文，不走 t()（CLI 层才做 i18n）。
 */

import { open, readFile, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { PackError, readPackYaml, writePackYaml, type PackYaml } from "../pack/packyaml.js";

import { lfsVersion, runGitOrThrow } from "./git.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** .gitattributes 文件名（写在图包根，与 init.ts 一致） */
const GITATTRIBUTES_FILENAME = ".gitattributes";

/**
 * lfs 跟踪的扩展名模式表（与 init.ts 的 GITATTRIBUTES_LINES 一一对应）。
 * migrateLfs 的 --include 参数也由它拼出。
 */
const LFS_PATTERNS: readonly string[] = Object.freeze([
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.obj",
  "*.ttsmod",
]);

/** 每个模式在 .gitattributes 里对应的行尾（lfs filter 声明） */
const LFS_ATTRIBUTE_SUFFIX = " filter=lfs diff=lfs merge=lfs -text";

/** .gitattributes 的 lfs 规则行（与 src/pack/init.ts 的 GITATTRIBUTES_LINES 逐行一致） */
const LFS_ATTRIBUTE_LINES: readonly string[] = Object.freeze(
  LFS_PATTERNS.map((pattern) => `${pattern}${LFS_ATTRIBUTE_SUFFIX}`),
);

/** 判定"这一行是 lfs 规则"的标记（子串匹配） */
const LFS_LINE_MARKER = "filter=lfs";

/** lfs 指针文件的版本行前缀（文件头 100 字节内应含此串） */
const LFS_POINTER_MARKER = "version https://git-lfs";

/** lfs 指针判定读取的文件头长度（字节） */
const LFS_POINTER_PROBE_BYTES = 100;

/** git-lfs 官网地址（错误提示里出现） */
const LFS_INSTALL_URL = "https://git-lfs.github.com/";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** lfs 总体状态（packYamlLfs / installed 综合后的归类值，供 registry / CLI 使用） */
export type LfsStatus = "enabled" | "disabled" | "disabled-no-lfs" | "not-installed";

/** pack.yaml 中 vcs.lfs 的合法取值（透传 schema 类型） */
export type PackLfsMode = PackYaml["vcs"]["lfs"];

/** {@link inspectLfs} 的只读检查结果 */
export interface LfsInspection {
  /** 系统是否装了 git-lfs（`git lfs version` 能跑通） */
  installed: boolean;
  /** 安装时的版本（如 "3.4.0"），未装为 null */
  version: string | null;
  /** .gitattributes 是否含 lfs 规则（注释行不算；文件不存在视为不含） */
  attributesHasLfs: boolean;
  /** pack.yaml 的 vcs.lfs 值（packRoot 不是图包工作区时为 null） */
  packYamlLfs: PackLfsMode | null;
  /** 三方一致性（= warnings.length === 0） */
  consistent: boolean;
  /** 不一致的警告消息列表（中文，逐条可直接展示） */
  warnings: string[];
}

/** {@link enableLfs} / {@link disableLfs} 的结果 */
export interface LfsEnableResult {
  /** 是否发生了任何改动（已处于目标状态时为 false） */
  changed: boolean;
  /** 是否写了 / 改了 / 删了 .gitattributes */
  attributesWritten: boolean;
  /** 是否改了 pack.yaml 的 vcs.lfs */
  packYamlUpdated: boolean;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT），避免 any。
 * （与 src/pack/packyaml.ts 的同名内部函数一致。）
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
 * 这一行是否是"有效内容"（非空且非注释）——disableLfs 判断清空后能否删除文件用。
 * @param line 原始行
 * @returns 行去首尾空白后非空且不以 "#" 开头时 true
 */
function isMeaningfulLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("#");
}

/**
 * 判定一行是否声明了 lfs 规则（子串 filter=lfs；注释行不算有效声明）。
 * @param line 原始行
 * @returns 是 lfs 规则行时 true
 */
function isLfsRuleLine(line: string): boolean {
  return !line.trim().startsWith("#") && line.includes(LFS_LINE_MARKER);
}

/**
 * 读取图包根的 .gitattributes 原文。
 * @param packRoot 图包工作区根目录
 * @returns 文件内容；文件不存在时 null（视为无规则，属正常状态）
 * @throws PackError code="LFS_ATTRIBUTES_FAILED" 读取发生其他 IO 错误时
 */
async function readAttributesRaw(packRoot: string): Promise<string | null> {
  const filePath = path.join(packRoot, GITATTRIBUTES_FILENAME);
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return null;
    }
    throw new PackError(
      "LFS_ATTRIBUTES_FAILED",
      `读取 ${filePath} 失败：${errMessage(err)}`,
    );
  }
}

/**
 * 读取 pack.yaml 的 vcs.lfs。
 * @param packRoot 图包工作区根目录
 * @returns vcs.lfs 值；packRoot 下没有 pack.yaml（不是图包工作区）时 null
 * @throws PackError pack.yaml 存在但不合规 / IO 失败时，原样透传 readPackYaml 的错误
 */
async function readPackLfsMode(packRoot: string): Promise<PackLfsMode | null> {
  try {
    const pack = await readPackYaml(packRoot);
    return pack.vcs.lfs;
  } catch (err) {
    if (err instanceof PackError && err.code === "PACK_NOT_FOUND") {
      return null;
    }
    throw err;
  }
}

/**
 * 把 vcs.lfs 写回 pack.yaml（原地改字段，经 writePackYaml 的 schema 二次校验落盘）。
 * @param packRoot 图包工作区根目录
 * @param pack readPackYaml 读出的完整清单
 * @param mode 目标 vcs.lfs 值
 * @throws PackError 透传 readPackYaml / writePackYaml 的错误
 */
async function writePackLfsMode(packRoot: string, pack: PackYaml, mode: PackLfsMode): Promise<void> {
  // 浅拷贝改 vcs 一个字段即可，pack.yaml 是小对象，无需深拷贝
  await writePackYaml(packRoot, { ...pack, vcs: { ...pack.vcs, lfs: mode } });
}

// ---------------------------------------------------------------------------
// 导出函数：只读检查
// ---------------------------------------------------------------------------

/**
 * 只读检查三方 lfs 状态（系统 git-lfs / .gitattributes / pack.yaml），不写盘。
 *
 * 警告规则（逐条中文，可整表直接展示）：
 * - 未装 git-lfs 但 .gitattributes 声明了 lfs：图片将无法正常 checkout；
 * - pack.yaml 声明启用但 .gitattributes 缺规则：新提交的图片不会走 lfs；
 * - pack.yaml 声明禁用但 .gitattributes 仍含规则：文件会继续被 lfs 改写。
 *
 * @param packRoot 图包工作区根目录
 * @returns 检查结果（见 {@link LfsInspection}；consistent = warnings.length === 0）
 * @throws PackError code="LFS_ATTRIBUTES_FAILED" .gitattributes 读取失败时
 * @throws PackError pack.yaml 存在但不合规时，透传 readPackYaml 的错误
 * @throws PackError code="GIT_NOT_FOUND" git 不在 PATH 时（视为未装 git-lfs 之外
 *   的环境问题——连 git 都没有，无法区分"没装 lfs"和"git 坏了"，直接上抛）
 */
export async function inspectLfs(packRoot: string): Promise<LfsInspection> {
  const version = await lfsVersion(packRoot);
  const installed = version !== null;

  const raw = await readAttributesRaw(packRoot);
  const lines = raw === null ? [] : raw.split(/\r?\n/);
  const attributesHasLfs = lines.some((line) => isLfsRuleLine(line));

  const packYamlLfs = await readPackLfsMode(packRoot);

  const warnings: string[] = [];
  if (!installed && attributesHasLfs) {
    warnings.push(".gitattributes 声明了 lfs 但本机未装 git-lfs，图片将无法正常 checkout");
  }
  if (packYamlLfs === "enabled" && !attributesHasLfs) {
    warnings.push("pack.yaml 声明启用 lfs 但 .gitattributes 缺规则");
  }
  if (packYamlLfs === "disabled" && attributesHasLfs) {
    warnings.push("pack.yaml 声明禁用 lfs 但 .gitattributes 仍含规则");
  }

  return {
    installed,
    version,
    attributesHasLfs,
    packYamlLfs,
    consistent: warnings.length === 0,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 导出函数：启用 / 禁用
// ---------------------------------------------------------------------------

/**
 * 启用 lfs：写 / 补全 .gitattributes 的 lfs 规则 + pack.yaml 的 vcs.lfs → "enabled"。
 *
 * .gitattributes 合并策略：文件不存在则整份写入模板；已存在则保留全部现有行、
 * 在末尾追加模板中缺失的行（按"去首尾空白后整行相等"判重，已有的规则行不重复写）。
 *
 * @param packRoot 图包工作区根目录
 * @returns 各项是否改动；已完全处于 enabled 状态时 changed=false
 * @throws PackError code="PACK_NOT_FOUND" packRoot 不是图包工作区时
 * @throws PackError code="PACK_INVALID" / "PACK_WRITE_FAILED" pack.yaml 不合规 / 写失败时
 * @throws PackError code="LFS_ATTRIBUTES_FAILED" .gitattributes 读取失败时
 * @throws fs 错误 .gitattributes 写入失败时原样向上抛
 */
export async function enableLfs(packRoot: string): Promise<LfsEnableResult> {
  const pack = await readPackYaml(packRoot);

  const raw = await readAttributesRaw(packRoot);
  let attributesWritten = false;
  if (raw === null) {
    await writeFile(
      path.join(packRoot, GITATTRIBUTES_FILENAME),
      `${LFS_ATTRIBUTE_LINES.join("\n")}\n`,
      "utf8",
    );
    attributesWritten = true;
  } else {
    const existing = new Set(raw.split(/\r?\n/).map((line) => line.trim()));
    const missing = LFS_ATTRIBUTE_LINES.filter((line) => !existing.has(line));
    if (missing.length > 0) {
      const base = raw.endsWith("\n") || raw === "" ? raw : `${raw}\n`;
      await writeFile(
        path.join(packRoot, GITATTRIBUTES_FILENAME),
        `${base}${missing.join("\n")}\n`,
        "utf8",
      );
      attributesWritten = true;
    }
  }

  const packYamlUpdated = pack.vcs.lfs !== "enabled";
  if (packYamlUpdated) {
    await writePackLfsMode(packRoot, pack, "enabled");
  }

  return { changed: attributesWritten || packYamlUpdated, attributesWritten, packYamlUpdated };
}

/**
 * 禁用 lfs：清除 .gitattributes 中含 filter=lfs 的行（保留其他行）+ pack.yaml 的
 * vcs.lfs → "disabled"；清空后只剩空行 / 注释则删除整个文件。
 *
 * **不做二次确认**——约束 10 的二次确认在 CLI 层做，调用方必须已取得用户确认。
 *
 * @param packRoot 图包工作区根目录
 * @returns 各项是否改动；已完全处于 disabled 状态时 changed=false
 * @throws PackError code="PACK_NOT_FOUND" packRoot 不是图包工作区时
 * @throws PackError code="PACK_INVALID" / "PACK_WRITE_FAILED" pack.yaml 不合规 / 写失败时
 * @throws PackError code="LFS_ATTRIBUTES_FAILED" .gitattributes 读取失败时
 * @throws fs 错误 .gitattributes 写入 / 删除失败时原样向上抛
 */
export async function disableLfs(packRoot: string): Promise<LfsEnableResult> {
  const pack = await readPackYaml(packRoot);

  const raw = await readAttributesRaw(packRoot);
  let attributesWritten = false;
  if (raw !== null && raw.includes(LFS_LINE_MARKER)) {
    const kept = raw.split(/\r?\n/).filter((line) => !line.includes(LFS_LINE_MARKER));
    const filePath = path.join(packRoot, GITATTRIBUTES_FILENAME);
    if (!kept.some((line) => isMeaningfulLine(line))) {
      // 清空后只剩空行 / 注释：整个文件删掉
      try {
        await unlink(filePath);
      } catch (err) {
        if (errCode(err) !== "ENOENT") {
          throw err;
        }
      }
    } else {
      const content = kept.join("\n");
      const normalized = content.endsWith("\n") ? content : `${content}\n`;
      await writeFile(filePath, normalized, "utf8");
    }
    attributesWritten = true;
  }

  const packYamlUpdated = pack.vcs.lfs !== "disabled";
  if (packYamlUpdated) {
    await writePackLfsMode(packRoot, pack, "disabled");
  }

  return { changed: attributesWritten || packYamlUpdated, attributesWritten, packYamlUpdated };
}

// ---------------------------------------------------------------------------
// 导出函数：历史迁移 / 指针判定
// ---------------------------------------------------------------------------

/**
 * `git lfs migrate import --include=<模式表> --everything`：重写全部历史，
 * 把历史提交中的图片 / 模型 / ttsmod 转成 lfs 指针。
 *
 * 前提（git lfs migrate 自行强制，本模块不重复检查）：
 * - 本机已装 git-lfs（未装时本函数抛 LFS_NOT_INSTALLED）；
 * - packRoot 是 git 仓库且工作区干净。
 *
 * **破坏性操作**：重写全部提交历史，已有远端的话需要 force push；
 * 调用方（CLI 层）负责确认与提示。
 *
 * @param packRoot 图包工作区根目录（须是干净的 git 仓库）
 * @returns migrated 恒为 true（失败走异常）；output 为 git 的合并输出
 *   （migrate 的进度信息在 stderr，与 stdout 合并返回）
 * @throws PackError code="LFS_NOT_INSTALLED" 本机没装 git-lfs 时
 * @throws PackError code="GIT_COMMAND_FAILED" 迁移命令失败时（脏仓库 / 非仓库等）
 * @throws PackError code="GIT_NOT_FOUND" git 不在 PATH 时
 */
export async function migrateLfs(packRoot: string): Promise<{ migrated: boolean; output: string }> {
  const version = await lfsVersion(packRoot);
  if (version === null) {
    throw new PackError(
      "LFS_NOT_INSTALLED",
      `git-lfs 未安装，无法迁移历史。请先安装 git-lfs（${LFS_INSTALL_URL}）`,
    );
  }

  const result = await runGitOrThrow(
    ["lfs", "migrate", "import", `--include=${LFS_PATTERNS.join(",")}`, "--everything"],
    { cwd: packRoot },
  );
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return { migrated: true, output };
}

/**
 * 判断文件是不是 lfs 指针：读文件头 {@link LFS_POINTER_PROBE_BYTES} 字节（100），
 * 内容含 "version https://git-lfs" 即是指针。
 *
 * 文件不存在时返回 false（不存在的文件谈不上是指针）；其余 IO 错误原样上抛。
 *
 * @param filePath 待判定文件的路径
 * @returns 是 lfs 指针时 true
 * @throws fs 错误读取失败（除 ENOENT）时原样向上抛
 */
export async function isLfsPointer(filePath: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, "r");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return false;
    }
    throw err;
  }
  try {
    const buffer = Buffer.alloc(LFS_POINTER_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, LFS_POINTER_PROBE_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").includes(LFS_POINTER_MARKER);
  } finally {
    await handle.close();
  }
}
