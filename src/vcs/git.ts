// src/vcs/git.ts
/**
 * 系统 git 的薄封装：所有 `git` 子命令的唯一调用入口。
 *
 * 设计约束（B3 约定）：
 * - 其他 vcs 模块**不许**直接 `execa("git", ...)`，必须经由本模块，便于统一
 *   超时 / 错误码 / 编码 / PATH 探测策略；
 * - 子进程一律用 {@link https://github.com/sindresorhus/execa | execa} 且
 *   **参数走数组**（`execa("git", args, …)`），绝不拼命令行字符串——中文与空格
 *   路径由参数数组保证不被二次解析（防注入）；
 * - `reject: false`：命令失败（exitCode != 0）在 {@link GitResult} 里原样上交，
 *   由调用方判断；本模块只在两种"无法上交"的情况下抛 {@link PackError}：
 *   git 可执行文件不存在（"GIT_NOT_FOUND"）与调用方要求"失败即抛"
 *   （runGitOrThrow → "GIT_COMMAND_FAILED"）；
 * - 输出按 UTF-8 解码。Windows 上 git 的 stderr 理论上存在 GBK 混合编码的
 *   可能，按约定先用 utf8，后续实测遇到乱码再调整（git 2.55 实测 stdout /
 *   stderr 均为 UTF-8 / ASCII）。
 *
 * 错误码（{@link PackError.code}）：
 * - "GIT_NOT_FOUND"       spawn 失败：git 不在 PATH（详见 {@link isGitExecutableAvailable}）
 * - "GIT_COMMAND_FAILED"  命令 exitCode != 0（仅 runGitOrThrow 抛出）
 * - "GIT_NOT_A_REPO"      在非 git 仓库工作树里调用了需要仓库的函数
 *                         （statusPorcelain / diffNumstat / currentBranch / headCommit）
 *
 * 实现备忘（实测 execa 10 on win32）：
 * - execa 在 Windows 上自行解析命令；解析不到时会回退 `cmd.exe` 执行并**合成
 *   `exitCode 1`**，错误对象上没有 `code` / `cause` 可判别 ENOENT（stderr 是
 *   cmd 的本地化文案，内容随系统语言变化，不可作判据）。因此
 *   "GIT_NOT_FOUND" 用 {@link isGitExecutableAvailable} 自行扫描 PATH 判定，
 *   与 execa 的解析语义保持一致；
 * - `git status --porcelain -z` 与 `git diff --numstat -z` 的确切字节格式
 *   （实测 git 2.55）：
 *   - status：条目为 `XY<空格>path\0`；rename/copy 为 `XY<空格>新路径\0旧路径\0`
 *     （新路径在前）；路径原样输出不转义（中文 / 空格安全），UTF-8；
 *   - numstat：条目为 `added<TAB>deleted<TAB>path\0`，二进制文件两个计数为
 *     `-`；rename 是**三段**：`added<TAB>deleted<TAB>\0旧路径\0新路径\0`
 *     （计数行的路径字段为空，随后两条记录依次为旧路径、新路径）；
 * - 本模块离线：不 import 命令层 / with-server.ts / session/*。
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { execa } from "execa";

import { PackError } from "../pack/packyaml.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 未显式指定时的子进程超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 超时 / 被信号终止等"进程没有正常退出"的场景下，GitResult.exitCode 的哨兵值。
 * git 的真实退出码不可能是负数，调用方可据此区分"命令失败"与"没跑完"。
 */
const NO_EXIT_CODE = -1;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** {@link runGit} / {@link runGitOrThrow} 的选项 */
export interface GitRunOptions {
  /** 工作目录（git 子进程的 cwd；须已存在） */
  cwd: string;
  /** 超时毫秒，默认 {@link DEFAULT_TIMEOUT_MS}（30 秒），超时后进程被终止 */
  timeoutMs?: number;
}

/** git 命令的执行结果（exitCode != 0 也原样返回，不抛错） */
export interface GitResult {
  /**
   * 退出码。进程没有正常退出（超时被杀等）时为 {@link NO_EXIT_CODE}（-1）。
   */
  exitCode: number;
  /** 标准输出（UTF-8 解码，末尾换行已由 execa 去除） */
  stdout: string;
  /** 标准错误（UTF-8 解码，末尾换行已由 execa 去除） */
  stderr: string;
}

/** `git status --porcelain -z` 的解析结果（单条目） */
export interface GitStatusEntry {
  /** XY 两个字符的状态码，如 " M"（工作区改动）、"M "（已暂存）、"A "、"??"、"UU"、"AA" */
  xy: string;
  /** 相对仓库根的路径（-z 模式原样输出，不转义，中文 / 空格安全） */
  path: string;
  /** rename / copy 时的原路径（-z 模式下紧跟条目记录的那一段），否则 undefined */
  origPath?: string;
}

/** `git diff --numstat` 的解析结果（单条目） */
export interface NumstatEntry {
  /** 新增行数；null 表示二进制文件（git 输出为 "-"） */
  added: number | null;
  /** 删除行数；null 表示二进制文件（git 输出为 "-"） */
  deleted: number | null;
  /** 路径；rename 条目取新路径（旧路径不在本接口内） */
  path: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 判断 "git" 可执行文件能否在 PATH 上解析出来。
 *
 * 为什么不用错误对象的字段判别：见模块头注释——execa 10 在 Windows 上对解析
 * 不到的命令回退 `cmd.exe` 执行，错误对象无 `code` / `cause`，stderr 是随系统
 * 语言变化的本地化文案。因此按 execa 的解析语义（PATH 逐目录 + Windows 可执行
 * 扩展名）自行扫描。只在命令已失败时调用，扫描成本可忽略。
 *
 * @returns PATH 上存在 git 可执行文件时 true
 */
function isGitExecutableAvailable(): boolean {
  const searchPath = process.env.PATH ?? "";
  const names = process.platform === "win32" ? ["git.exe", "git.cmd", "git.bat"] : ["git"];
  for (const dir of searchPath.split(path.delimiter)) {
    // execa 的解析允许目录带引号（含空格的 PATH 条目），保持一致
    const unquoted = dir.length > 1 && dir.startsWith('"') && dir.endsWith('"') ? dir.slice(1, -1) : dir;
    if (unquoted === "") {
      continue;
    }
    for (const name of names) {
      try {
        if (existsSync(path.resolve(unquoted, name))) {
          return true;
        }
      } catch {
        // PATH 中存在非法条目（非法字符等）时跳过，不影响其余条目
      }
    }
  }
  return false;
}

/**
 * 把 execa 的结果归一化为 {@link GitResult}，并识别 spawn 失败（GIT_NOT_FOUND）。
 * @param args 原始 git 参数（用于错误消息）
 * @param opts 原始选项（用于错误消息中的超时值）
 */
async function execGit(args: string[], opts: GitRunOptions): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await execa("git", args, {
    cwd: opts.cwd,
    timeout: timeoutMs,
    reject: false,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.failed && !isGitExecutableAvailable()) {
    throw new PackError("GIT_NOT_FOUND", "未找到可执行的 git：请确认 git 已安装并在 PATH 中");
  }

  // 超时被杀时 exitCode 为 undefined；stderr 若为空则补一句超时说明，
  // 让 runGitOrThrow 的错误消息至少能解释"为什么失败"
  const stderr =
    result.timedOut && result.stderr.trim() === ""
      ? `命令超过 ${timeoutMs} 毫秒未结束，已被终止`
      : result.stderr;

  return {
    exitCode: typeof result.exitCode === "number" ? result.exitCode : NO_EXIT_CODE,
    stdout: result.stdout,
    stderr,
  };
}

/**
 * 前置检查：cwd 必须是 git 仓库的工作树，否则抛 GIT_NOT_A_REPO。
 * @param cwd 待检查目录
 * @throws PackError code="GIT_NOT_A_REPO" cwd 不是 git 仓库工作树时
 */
async function requireWorkTree(cwd: string): Promise<void> {
  if (!(await isGitRepo(cwd))) {
    throw new PackError("GIT_NOT_A_REPO", `目录不是 git 仓库工作树：${cwd}`);
  }
}

// ---------------------------------------------------------------------------
// 导出函数：通用执行
// ---------------------------------------------------------------------------

/**
 * 执行 git 命令。exitCode != 0 也返回（不抛错），由调用方判断；
 * 仅当 git 可执行文件不存在（spawn 失败）时抛 PackError("GIT_NOT_FOUND")。
 *
 * @param args git 参数数组（不含 "git" 本身；参数走数组，绝不拼字符串）
 * @param opts 工作目录与超时
 * @returns 归一化的执行结果
 * @throws PackError code="GIT_NOT_FOUND" git 不在 PATH 时
 */
export async function runGit(args: string[], opts: GitRunOptions): Promise<GitResult> {
  return execGit(args, opts);
}

/**
 * 执行 git 命令，exitCode != 0 时抛 PackError("GIT_COMMAND_FAILED")，
 * 错误消息含完整命令行与 stderr（中文）。
 *
 * @param args git 参数数组（不含 "git" 本身）
 * @param opts 工作目录与超时
 * @returns 执行结果（exitCode 恒为 0）
 * @throws PackError code="GIT_NOT_FOUND" git 不在 PATH 时
 * @throws PackError code="GIT_COMMAND_FAILED" 命令退出码非 0 时
 */
export async function runGitOrThrow(args: string[], opts: GitRunOptions): Promise<GitResult> {
  const result = await execGit(args, opts);
  if (result.exitCode !== 0) {
    throw new PackError(
      "GIT_COMMAND_FAILED",
      `git ${args.join(" ")} 失败：${result.stderr.trim() === "" ? "(无 stderr)" : result.stderr.trim()}`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// 导出函数：status / diff
// ---------------------------------------------------------------------------

/**
 * 解析 `git status --porcelain -z` 输出（NUL 分隔）。
 *
 * 条目格式（实测 git 2.55）：`XY<空格>path`；rename/copy 条目后紧跟一条独立
 * 记录，是原路径。解析用状态机：上一条是 R/C 时，当前记录必为原路径。
 *
 * @param output git 的 -z 原始输出（UTF-8 已解码）
 * @returns 条目列表（输出为空时为空数组）
 */
function parseStatusZ(output: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  let pendingOrig: GitStatusEntry | null = null;
  for (const record of output.split("\0")) {
    if (record === "") {
      continue; // 末尾 NUL 产生的空段
    }
    if (pendingOrig !== null) {
      // rename/copy 条目的原路径段（整段就是路径，不再套状态码）
      pendingOrig.origPath = record;
      pendingOrig = null;
      continue;
    }
    // 条目：XY（两个状态字符）+ 一个空格分隔符 + 路径
    if (record.length >= 4 && record[2] === " ") {
      const xy = record.slice(0, 2);
      const entry: GitStatusEntry = { xy, path: record.slice(3) };
      entries.push(entry);
      // rename/copy 的状态字母只会出现在 X（暂存侧）；两侧都查一遍以防格式扩展
      if (xy.includes("R") || xy.includes("C")) {
        pendingOrig = entry;
      }
    }
    // 不符合条目格式的残片（正常输出中不存在）直接丢弃
  }
  return entries;
}

/**
 * `git status --porcelain -z`：机器可读的工作区状态（中文 / 空格路径安全）。
 * @param cwd 仓库内任意目录（含仓库根）
 * @returns 条目列表；工作区干净（刚 init 的空仓库）时为空数组
 * @throws PackError code="GIT_NOT_A_REPO" cwd 不是 git 仓库工作树时
 * @throws PackError code="GIT_COMMAND_FAILED" git status 本身失败时
 * @throws PackError code="GIT_NOT_FOUND" git 不在 PATH 时
 */
export async function statusPorcelain(cwd: string): Promise<GitStatusEntry[]> {
  await requireWorkTree(cwd);
  const result = await runGitOrThrow(["status", "--porcelain", "-z"], { cwd });
  return parseStatusZ(result.stdout);
}

/**
 * 解析 `git diff --numstat -z` 输出（NUL 分隔，字段 TAB 分隔）。
 *
 * 条目格式（实测 git 2.55）：
 * - 普通条目：`added<TAB>deleted<TAB>path`（二进制为 `-\t-\tpath`）；
 * - rename 条目：`added<TAB>deleted<TAB>\0旧路径\0新路径\0`——计数行的路径字段
 *   为空，随后两条记录依次是旧路径、新路径（本接口只保留新路径）。
 *
 * 解析用状态机：读到"路径字段为空"的计数记录进入等待态，吞掉旧路径、
 * 用新路径产出条目。
 *
 * @param output git 的 -z 原始输出
 * @returns 条目列表
 */
function parseNumstatZ(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  /** 等待 rename 条目旧/新路径记录时的挂起状态 */
  let pendingRename: { added: number | null; deleted: number | null; oldSeen: boolean } | null = null;
  const recordRegExp = /^(-|\d+)\t(-|\d+)\t(.*)$/;
  for (const record of output.split("\0")) {
    if (record === "") {
      // 末尾 NUL 产生的空段；同时天然防御"rename 后缺路径"的畸形流
      continue;
    }
    if (pendingRename !== null) {
      if (pendingRename.oldSeen) {
        entries.push({ added: pendingRename.added, deleted: pendingRename.deleted, path: record });
        pendingRename = null;
      } else {
        pendingRename.oldSeen = true;
      }
      continue;
    }
    const match = recordRegExp.exec(record);
    if (match === null) {
      continue; // 不认识的残片（正常输出中不存在），跳过
    }
    const added = match[1] === "-" ? null : Number(match[1]);
    const deleted = match[2] === "-" ? null : Number(match[2]);
    if (match[3] === "") {
      // rename 条目：路径字段为空，后面两条记录依次为旧路径、新路径
      pendingRename = { added, deleted, oldSeen: false };
    } else {
      entries.push({ added, deleted, path: match[3] });
    }
  }
  return entries;
}

/**
 * `git diff --numstat`：逐文件增删行数（二进制文件 added / deleted 为 null）。
 * @param cwd 仓库内任意目录
 * @param base 基线（commit-ish）；省略时比较工作区与暂存区（git diff 默认行为）
 * @returns 条目列表；无差异时为空数组
 * @throws PackError code="GIT_NOT_A_REPO" cwd 不是 git 仓库工作树时
 * @throws PackError code="GIT_COMMAND_FAILED" git diff 本身失败（如 base 不是有效 revision）时
 * @throws PackError code="GIT_NOT_FOUND" git 不在 PATH 时
 */
export async function diffNumstat(cwd: string, base?: string): Promise<NumstatEntry[]> {
  await requireWorkTree(cwd);
  const args = ["diff", "--numstat", "-z"];
  if (base !== undefined && base !== "") {
    args.push(base);
  }
  const result = await runGitOrThrow(args, { cwd });
  return parseNumstatZ(result.stdout);
}

// ---------------------------------------------------------------------------
// 导出函数：仓库状态探测
// ---------------------------------------------------------------------------

/**
 * 当前分支名。detached HEAD（不在任何分支上）时返回 null。
 * @param cwd 仓库内任意目录
 * @returns 分支名（如 "main"）；detached 时 null
 * @throws PackError code="GIT_NOT_A_REPO" cwd 不是 git 仓库工作树时
 * @throws PackError code="GIT_COMMAND_FAILED" git 查询本身失败时
 * @throws PackError code="GIT_NOT_FOUND" git 不在 PATH 时
 */
export async function currentBranch(cwd: string): Promise<string | null> {
  await requireWorkTree(cwd);
  // 正常分支：symbolic-ref 成功；detached HEAD：exitCode 128（"ref HEAD is not a symbolic ref"）
  const symbolic = await runGit(["symbolic-ref", "--short", "HEAD"], { cwd });
  if (symbolic.exitCode === 0 && symbolic.stdout.trim() !== "") {
    return symbolic.stdout.trim();
  }
  // 复核：detached 时 rev-parse --abbrev-ref 返回字面量 "HEAD"
  const rev = await runGitOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  const name = rev.stdout.trim();
  return name === "HEAD" ? null : name;
}

/**
 * cwd 是否在 git 仓库的工作树里（`git rev-parse --is-inside-work-tree`）。
 * 本函数不抛 GIT_NOT_A_REPO（它本身就是判别器）；git 不在 PATH 时仍抛
 * GIT_NOT_FOUND（这是环境问题，不是"不是仓库"）。
 * @param cwd 待检查目录
 * @returns 是 git 仓库工作树（含子目录）时 true
 * @throws PackError code="GIT_NOT_FOUND" git 不在 PATH 时
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/**
 * git-lfs 版本（`git lfs version`）。探测与是否在仓库内无关；
 * git 或 git-lfs 未安装 / 命令失败时返回 null（探测失败不算错误）。
 * @param cwd 工作目录；省略时用 process.cwd()（须存在）
 * @returns 版本字符串（如 "3.4.0"）；未装时 null
 */
export async function lfsVersion(cwd?: string): Promise<string | null> {
  let result: GitResult;
  try {
    result = await runGit(["lfs", "version"], { cwd: cwd ?? process.cwd() });
  } catch (err) {
    if (err instanceof PackError && err.code === "GIT_NOT_FOUND") {
      return null;
    }
    throw err;
  }
  if (result.exitCode !== 0) {
    // git 已装但 git-lfs 未装：git 报 "'lfs' is not a git command"
    return null;
  }
  // 输出形如 "git-lfs/3.7.1 (GitHub; windows amd64; ...)"
  const match = /git-lfs\/(\d+(?:\.\d+)+)/.exec(result.stdout);
  return match === null ? null : match[1];
}

/**
 * 最新提交的完整 hash（`git log -1 --format=%H`）。
 * @param cwd 仓库内任意目录
 * @returns 40 位十六进制 hash；仓库还没有任何提交时 null
 * @throws PackError code="GIT_NOT_A_REPO" cwd 不是 git 仓库工作树时
 * @throws PackError code="GIT_NOT_FOUND" git 不在 PATH 时
 */
export async function headCommit(cwd: string): Promise<string | null> {
  await requireWorkTree(cwd);
  const result = await runGit(["log", "-1", "--format=%H"], { cwd });
  const hash = result.stdout.trim();
  // 空仓库：git log 退出码非 0（"does not have any commits yet"）
  if (result.exitCode !== 0 || hash === "") {
    return null;
  }
  return hash;
}
