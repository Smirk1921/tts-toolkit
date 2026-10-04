// src/vcs/size.ts
/**
 * 仓库体积报告（`tts vcs size` 命令的数据层，方案设计 §4.11 / §4.12）。
 *
 * 职责：
 * - {@link analyzeSize}：扫描图包工作区与 .git，返回 {@link RepoSizeReport}；
 * - 纯文件系统扫描（readdir / stat / readFile），不调用 git / git-lfs 子进程，完全离线。
 *
 * 统计口径：
 * - {@link RepoSizeReport.workspaceBytes}：工作区总体积（不含 .git），
 *   恒等于 breakdown 各桶 bytes 之和；
 * - {@link RepoSizeReport.gitBytes}：`.git` 整体递归体积——包含其内部的 lfs 对象，
 *   故 `lfsObjectsBytes <= gitBytes`；`.git` 是指针文件（git worktree 布局）时
 *   按单文件计入 gitBytes；
 * - {@link RepoSizeReport.lfsObjectsBytes}：`.git/lfs/objects` 子树体积，缺失或为空时为 0；
 * - {@link RepoSizeReport.breakdown}：顶层目录分解（不含 .git）——已知目录
 *   （decks / objects / scripts / ui / source / sheets / .tts）各自成桶，
 *   其余顶层目录聚合进 {@link OTHER_DIR_BUCKET}（"其他"），根目录散文件
 *   （pack.yaml / .gitattributes / .gitignore 等）聚合进 {@link ROOT_FILES_BUCKET}（"."）；
 *   空目录也成桶（0 字节 0 文件）；按 bytes 降序排列，bytes 相同按目录名
 *   （码元序）升序，保证顺序稳定可测；
 * - 符号链接（含 Windows junction）一律跳过不统计，防循环；
 * - {@link RepoSizeReport.lfsEnabled}：`.gitattributes` 存在非注释行含 "filter=lfs"
 *   规则即视为启用（与 git-lfs init 写入的规则形态一致），缺文件或无规则为 false；
 * - 文件总数（工作区 + .git）超过 {@link LARGE_REPO_FILE_COUNT} 时 console.warn
 *   提醒统计较慢，但仍完整统计（不截断、不采样）。
 *
 * 错误码（{@link PackError.code}）：
 * - "SIZE_NOT_A_PACK"   packRoot 不存在或不是目录
 * - "SIZE_READ_FAILED"  扫描过程中的文件系统读取失败（权限不足、被占用、
 *                       .gitattributes 是目录等）
 *
 * 错误消息写死中文不走 t()（vcs 模块离线约定）；本模块绝不 import 命令层与 session。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { PackError } from "../pack/packyaml.js";

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** 单个顶层目录（桶）的体积分解 */
export interface DirectorySize {
  /** 相对 pack 根的目录路径（如 "decks" / "objects"；未知目录聚合为"其他"，根散文件为"."） */
  dir: string;
  /** 字节数 */
  bytes: number;
  /** 文件数 */
  fileCount: number;
}

/** 仓库体积报告（tts vcs size 的数据结构） */
export interface RepoSizeReport {
  /** 工作区总体积（不含 .git），恒等于 breakdown 各桶之和 */
  workspaceBytes: number;
  /** .git 总体积（含其内部的 lfs 对象） */
  gitBytes: number;
  /** .git/lfs/objects 体积（lfs 启用时非 0；缺失时为 0；包含于 gitBytes） */
  lfsObjectsBytes: number;
  /** 按目录分解（不含 .git），bytes 降序 */
  breakdown: DirectorySize[];
  /** lfs 是否启用（根据 .gitattributes 是否含 lfs 规则） */
  lfsEnabled: boolean;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** git 目录名（工作区根下） */
const GIT_DIR_NAME = ".git";

/** gitattributes 文件名（工作区根下，lfs 规则的判定来源） */
const GITATTRIBUTES_FILENAME = ".gitattributes";

/** lfs 规则的判定标记：git-lfs 写入的属性行必然含 filter=lfs */
const LFS_FILTER_MARK = "filter=lfs";

/** 大仓库阈值：文件总数（工作区 + .git）超过该值时 console.warn，但仍完整统计 */
export const LARGE_REPO_FILE_COUNT = 10_000;

/** 已知的顶层目录名：breakdown 中各自成桶 */
const KNOWN_TOP_DIRS: ReadonlySet<string> = new Set([
  "decks",
  "objects",
  "scripts",
  "ui",
  "source",
  "sheets",
  ".tts",
]);

/** 根目录散文件（pack.yaml / .gitattributes / .gitignore 等）在 breakdown 中的桶名 */
export const ROOT_FILES_BUCKET = ".";

/** 未知顶层目录聚合后的 breakdown 桶名 */
export const OTHER_DIR_BUCKET = "其他";

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT / EISDIR），避免 any。
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

/** 一个目录子树的累计统计 */
interface DirStats {
  bytes: number;
  fileCount: number;
}

/** 递归遍历时附加的统计钩子：命中相对前缀的文件体积额外累加进 sink（用于单遍扫描 .git/lfs/objects） */
interface WalkHooks {
  /** 相对遍历根的文件前缀（POSIX 分隔、以 / 结尾） */
  prefix: string;
  /** 命中文件的体积累加目标 */
  sink: { bytes: number };
}

/**
 * 递归统计一个目录子树下所有普通文件的体积与数量。
 *
 * - 符号链接（含 Windows junction）直接跳过，不递归、不计数（防循环）；
 * - 其余非常规条目（FIFO / 套接字 / 设备文件）同样不计数；
 * - readdir / stat 失败一律抛 PackError("SIZE_READ_FAILED")。
 *
 * @param absDir 绝对目录路径
 * @param relDir 相对遍历根的目录路径（根为 ""；仅用于 hooks 前缀匹配）
 * @param hooks 附加统计钩子（可省略）
 * @returns 子树累计的字节数与文件数
 * @throws PackError code="SIZE_READ_FAILED" 目录或文件读取失败时
 */
async function measureDir(absDir: string, relDir: string, hooks: WalkHooks | undefined): Promise<DirStats> {
  const result: DirStats = { bytes: 0, fileCount: 0 };
  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    throw new PackError("SIZE_READ_FAILED", `读取目录 ${absDir} 失败：${errMessage(err)}`);
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue; // 符号链接跳过不统计（防循环）
    }
    const absChild = path.join(absDir, entry.name);
    const relChild = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      const sub = await measureDir(absChild, relChild, hooks);
      result.bytes += sub.bytes;
      result.fileCount += sub.fileCount;
    } else if (entry.isFile()) {
      let size: number;
      try {
        size = (await stat(absChild)).size;
      } catch (err) {
        throw new PackError("SIZE_READ_FAILED", `读取文件 ${absChild} 失败：${errMessage(err)}`);
      }
      result.bytes += size;
      result.fileCount += 1;
      if (hooks !== undefined && relChild.startsWith(hooks.prefix)) {
        hooks.sink.bytes += size;
      }
    }
  }
  return result;
}

/**
 * 判断 .gitattributes 是否含 lfs 规则。
 *
 * 判定：存在非空、非注释（# 开头）的行包含 "filter=lfs"（git-lfs 写入的标准形态
 * 如 `*.png filter=lfs diff=lfs merge=lfs -text`）。文件不存在视为未启用。
 *
 * @param packRoot 图包工作区根目录
 * @returns 是否含 lfs 规则
 * @throws PackError code="SIZE_READ_FAILED" .gitattributes 存在但读取失败时（如是目录）
 */
async function gitattributesHasLfsRule(packRoot: string): Promise<boolean> {
  const filePath = path.join(packRoot, GITATTRIBUTES_FILENAME);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return false;
    }
    throw new PackError("SIZE_READ_FAILED", `读取 ${filePath} 失败：${errMessage(err)}`);
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.includes(LFS_FILTER_MARK)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 扫描图包仓库，产出体积报告（`tts vcs size` 的数据层）。
 *
 * 统计口径详见模块头注释。本函数只读，不修改任何文件，不调用 git 子进程。
 *
 * @param packRoot 图包工作区根目录（须为已存在的目录；是否真的是图包由调用方先行校验）
 * @returns 体积报告
 * @throws PackError code="SIZE_NOT_A_PACK" packRoot 不存在或不是目录时
 * @throws PackError code="SIZE_READ_FAILED" 扫描过程中文件系统读取失败时
 */
export async function analyzeSize(packRoot: string): Promise<RepoSizeReport> {
  let rootStats;
  try {
    rootStats = await stat(packRoot);
  } catch (err) {
    throw new PackError(
      "SIZE_NOT_A_PACK",
      `图包根目录不存在或不可访问：${packRoot}（${errMessage(err)}）`,
    );
  }
  if (!rootStats.isDirectory()) {
    throw new PackError("SIZE_NOT_A_PACK", `图包根路径不是目录：${packRoot}`);
  }

  let topEntries: Dirent[];
  try {
    topEntries = await readdir(packRoot, { withFileTypes: true });
  } catch (err) {
    throw new PackError("SIZE_READ_FAILED", `读取目录 ${packRoot} 失败：${errMessage(err)}`);
  }

  /** breakdown 桶（已知目录 / 其他 / 根散文件），键为桶名 */
  const bucketMap = new Map<string, DirStats>();
  const addToBucket = (dir: string, bytes: number, fileCount: number): void => {
    const current = bucketMap.get(dir);
    if (current === undefined) {
      bucketMap.set(dir, { bytes, fileCount });
    } else {
      current.bytes += bytes;
      current.fileCount += fileCount;
    }
  };

  let gitBytes = 0;
  let gitFileCount = 0;
  let lfsObjectsBytes = 0;

  for (const entry of topEntries) {
    if (entry.isSymbolicLink()) {
      continue; // 符号链接跳过不统计（防循环）
    }
    const absChild = path.join(packRoot, entry.name);

    if (entry.name === GIT_DIR_NAME) {
      // .git 单独统计：整体作为 gitBytes，不进 breakdown；
      // .git/lfs/objects 借 hooks 在同一遍扫描中单独累加
      if (entry.isDirectory()) {
        const lfsSink = { bytes: 0 };
        const gitStats = await measureDir(absChild, "", { prefix: "lfs/objects/", sink: lfsSink });
        gitBytes = gitStats.bytes;
        gitFileCount = gitStats.fileCount;
        lfsObjectsBytes = lfsSink.bytes;
      } else if (entry.isFile()) {
        // git worktree 布局：.git 是内容为 "gitdir: ..." 的指针文件
        let size: number;
        try {
          size = (await stat(absChild)).size;
        } catch (err) {
          throw new PackError("SIZE_READ_FAILED", `读取文件 ${absChild} 失败：${errMessage(err)}`);
        }
        gitBytes = size;
        gitFileCount = 1;
      }
      continue;
    }

    if (entry.isFile()) {
      let size: number;
      try {
        size = (await stat(absChild)).size;
      } catch (err) {
        throw new PackError("SIZE_READ_FAILED", `读取文件 ${absChild} 失败：${errMessage(err)}`);
      }
      addToBucket(ROOT_FILES_BUCKET, size, 1);
      continue;
    }

    if (entry.isDirectory()) {
      const sub = await measureDir(absChild, entry.name, undefined);
      const bucketName = KNOWN_TOP_DIRS.has(entry.name) ? entry.name : OTHER_DIR_BUCKET;
      addToBucket(bucketName, sub.bytes, sub.fileCount);
    }
    // 其余非常规条目（FIFO / 套接字 / 设备文件）不计数
  }

  const breakdown: DirectorySize[] = [...bucketMap.entries()].map(([dir, stats]) => ({
    dir,
    bytes: stats.bytes,
    fileCount: stats.fileCount,
  }));
  breakdown.sort((a, b) => b.bytes - a.bytes || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));

  const workspaceBytes = breakdown.reduce((sum, bucket) => sum + bucket.bytes, 0);
  const workspaceFileCount = breakdown.reduce((sum, bucket) => sum + bucket.fileCount, 0);

  const lfsEnabled = await gitattributesHasLfsRule(packRoot);

  const totalFileCount = workspaceFileCount + gitFileCount;
  if (totalFileCount > LARGE_REPO_FILE_COUNT) {
    console.warn(
      `[tts-toolkit] 仓库文件总数 ${totalFileCount} 已超过 ${LARGE_REPO_FILE_COUNT}，` +
        "体积统计可能较慢（仍在完整统计，不截断）",
    );
  }

  return {
    workspaceBytes,
    gitBytes,
    lfsObjectsBytes,
    breakdown,
    lfsEnabled,
  };
}
