// src/vcs/verify.ts
/**
 * vcs verify：deck 工作区体检 + git 仓库状态检查的合并包装
 * （`tts vcs verify` 命令的数据层，方案设计 §4.11）。
 *
 * 职责：
 * - {@link vcsVerify}：调用 src/deck/verify.ts 的 verifyPack（decks / 存档 / 对象
 *   三大校验面），叠加 git 仓库状态检查（工作区是否干净、冲突是否解决、lfs 三方
 *   是否一致），把两边的 issue 合并统计后一次性返回。**只读**：不写盘、不改仓库、
 *   不执行 add / commit 等任何变更性 git 子命令。
 *
 * git 检查项（checkGit !== false 且 packRoot 是 git 仓库时；issue 按此顺序产出）：
 * 1. `git status --porcelain` 非空 →
 *    warning VCS_UNCOMMITTED "存在未提交改动"（含未跟踪 / 已暂存 / 已修改，一条汇总）；
 * 2. 状态含未合并条目 →
 *    error VCS_UNRESOLVED_CONFLICT "存在未解决的合并冲突"。规格点名 UU/AA/DD，
 *    实现按"XY 任一侧为 U，或 AA/DD"判定，覆盖 git 全部 7 种未合并状态
 *    UU/AU/UD/UA/DU/AA/DD——它们同样是"未解决的合并冲突"，漏报任何一个都会让
 *    带冲突标记的文件流进后续流程；
 * 3. .gitattributes 声明了 lfs 规则但本机没装 git-lfs（`git lfs version` 失败）→
 *    error VCS_LFS_MISSING ".gitattributes 声明了 lfs 但本机未装 git-lfs"；
 * 4. pack.yaml 的 vcs.lfs="enabled" 但 .gitattributes 缺 lfs 规则 →
 *    error VCS_LFS_INCONSISTENT "pack.yaml 声明启用 lfs 但 .gitattributes 缺规则"；
 * 5. pack.yaml 的 vcs.lfs="disabled" 但 .gitattributes 含 lfs 规则 →
 *    warning VCS_LFS_INCONSISTENT "pack.yaml 声明禁用 lfs 但 .gitattributes 仍含规则"。
 *    vcs.lfs="disabled-no-lfs" 表示"明确不用 lfs 且预期不装"，第 4/5 项均不适用。
 *
 * 设计决定：
 * - **允许纯工作区 verify**：packRoot 不是 git 仓库时 git 检查整体跳过
 *   （gitIssues 为空数组，不报错）；git 可执行文件不在 PATH（GIT_NOT_FOUND）时
 *   同样跳过——此时既无法判定"是否是仓库"也无法执行任何 git 子命令，git 缺失
 *   属环境问题，由其他必须用 git 的命令显式暴露；
 * - **lfs 三方检查复用 inspectLfs**（src/vcs/lfs.ts）：.gitattributes 的 lfs 规则
 *   解析（注释行不算规则）与 pack.yaml 的 vcs.lfs 读取都收口在那一处实现，
 *   本模块不重写文件解析；
 * - git 子进程全部经由 src/vcs/git.ts（isGitRepo / statusPorcelain），
 *   不直接 execa——git 调用的唯一入口约定；
 * - deckVerify 原样内嵌 verifyPack 的完整结果（issues 顺序即其文档约定的
 *   decks 名称序 → skeleton → objects 确定性顺序）；gitIssues 按上述检查项顺序
 *   产出，同一工作区两次校验产出逐条一致；
 * - 约束 10（git-lfs 绝不静默降级）在第 3/4 项体现为 error 而非 warning；
 * - 本模块离线：不 import 命令层 / with-server.ts / session/*；
 *   issue 与错误消息写死中文不走 t()（CLI 层才做 i18n）。
 *
 * 错误传播：
 * - verifyPack 抛出的 PackError 原样透传（约定保留；verifyPack 自身把业务问题
 *   收集为 issue，正常不抛）；
 * - git 检查中的异常错误原样透传：仓库损坏导致 statusPorcelain 失败
 *   （"GIT_COMMAND_FAILED"）、pack.yaml 存在但不合规导致 inspectLfs 抛
 *   "PACK_INVALID"——清单不合规必须显式暴露，绝不静默当作"未声明"处理；
 * - packRoot 不是非空字符串时抛普通中文 Error（调用方编程错误，仓库惯例）。
 */

import { verifyPack, type VerifyResult } from "../deck/verify.js";
import { PackError } from "../pack/packyaml.js";

import { isGitRepo, statusPorcelain } from "./git.js";
import { inspectLfs } from "./lfs.js";

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** {@link vcsVerify} 的选项 */
export interface VcsVerifyOptions {
  /** 图包工作区根目录（可以不是 git 仓库） */
  packRoot: string;
  /** 是否检查 CMYK（透传 verifyPack；需要读图，慢，默认 true） */
  checkCmyk?: boolean;
  /** 是否检查图集尺寸（透传 verifyPack；需要读图，慢，默认 true） */
  checkAtlasSize?: boolean;
  /** 是否检查 git 状态（默认 true；非 git 仓库时该项自动跳过） */
  checkGit?: boolean;
}

/** git 状态检查的单条 issue（deck 校验的 issue 带location，git 检查统一指向仓库根，故省略） */
export interface VcsGitIssue {
  /** 严重级别 */
  severity: "error" | "warning";
  /** 机器可读码（VCS_UNCOMMITTED / VCS_UNRESOLVED_CONFLICT / VCS_LFS_MISSING / VCS_LFS_INCONSISTENT） */
  code: string;
  /** 中文描述 */
  message: string;
}

/** {@link vcsVerify} 的结果 */
export interface VcsVerifyResult {
  /** 总 error 数（deck verify 的 error + git 检查的 error） */
  errorCount: number;
  /** 总 warning 数（deck verify 的 warning + git 检查的 warning） */
  warningCount: number;
  /** deck verify 的完整结果（原样内嵌，issue 顺序确定） */
  deckVerify: VerifyResult;
  /** git 状态检查的 issue（非 git 仓库 / checkGit=false / git 不在 PATH 时为空数组） */
  gitIssues: VcsGitIssue[];
  /** 是否通过（errorCount === 0；warning 不阻塞通过） */
  ok: boolean;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * XY 状态码是否为"未合并"（存在未解决的冲突）。
 *
 * git status --porcelain 的未合并状态共 7 种：DD / AU / UD / UA / DU / AA / UU。
 * 判定规则：任一侧为 U（涉及 unmerged 标记），或双侧同为 A / 同为 D
 * （双方新增 / 双方删除不出现 U，但同样是未解决冲突）。
 * @param xy porcelain 条目的两字符状态码
 * @returns 是未合并状态时 true
 */
function isUnmergedStatus(xy: string): boolean {
  return xy.includes("U") || xy === "AA" || xy === "DD";
}

/**
 * git 仓库状态检查（模块头注释的 5 个检查项）。
 * @param packRoot 图包工作区根目录（调用方已确认是 git 仓库工作树）
 * @returns issue 列表（按检查项顺序；全部通过时为空数组）
 * @throws PackError code="GIT_COMMAND_FAILED" git status 失败时（透传自 git.ts）
 * @throws PackError pack.yaml 存在但不合规时（透传自 inspectLfs → readPackYaml）
 */
async function collectGitIssues(packRoot: string): Promise<VcsGitIssue[]> {
  const issues: VcsGitIssue[] = [];

  // ── 检查 1/2：工作区状态（未提交改动 / 未解决冲突）──
  const entries = await statusPorcelain(packRoot);
  if (entries.length > 0) {
    issues.push({ severity: "warning", code: "VCS_UNCOMMITTED", message: "存在未提交改动" });
  }
  if (entries.some((entry) => isUnmergedStatus(entry.xy))) {
    issues.push({ severity: "error", code: "VCS_UNRESOLVED_CONFLICT", message: "存在未解决的合并冲突" });
  }

  // ── 检查 3/4/5：lfs 三方一致性（复用 inspectLfs，不重写 .gitattributes / pack.yaml 解析）──
  const lfs = await inspectLfs(packRoot);
  if (lfs.attributesHasLfs && !lfs.installed) {
    issues.push({
      severity: "error",
      code: "VCS_LFS_MISSING",
      message: ".gitattributes 声明了 lfs 但本机未装 git-lfs",
    });
  }
  if (lfs.packYamlLfs === "enabled" && !lfs.attributesHasLfs) {
    issues.push({
      severity: "error",
      code: "VCS_LFS_INCONSISTENT",
      message: "pack.yaml 声明启用 lfs 但 .gitattributes 缺规则",
    });
  }
  if (lfs.packYamlLfs === "disabled" && lfs.attributesHasLfs) {
    issues.push({
      severity: "warning",
      code: "VCS_LFS_INCONSISTENT",
      message: "pack.yaml 声明禁用 lfs 但 .gitattributes 仍含规则",
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 校验图包工作区 + git 仓库状态（只读；所有 issue 收集后一次性返回）。
 *
 * deck 校验与 git 检查相互独立，二者并行执行；git 检查的跳过规则见模块头注释
 * （非 git 仓库 / git 不在 PATH / checkGit=false 时 gitIssues 为空数组）。
 *
 * @param opts 校验选项（packRoot 必填，三个 check 开关默认全部 true）
 * @returns deck verify 完整结果 + git issue + 合并统计（ok = errorCount === 0，
 *          warning 不阻塞通过）
 * @throws PackError 透传 verifyPack / statusPorcelain / inspectLfs 的业务错误
 * @throws Error packRoot 不是非空字符串时（调用方编程错误）
 */
export async function vcsVerify(opts: VcsVerifyOptions): Promise<VcsVerifyResult> {
  if (typeof opts.packRoot !== "string" || opts.packRoot.trim() === "") {
    throw new Error("vcsVerify 入参无效：packRoot 必须是非空字符串路径");
  }
  const packRoot = opts.packRoot;

  // git 检查前置判定：非 git 仓库（或 git 不在 PATH）→ 跳过全部 git 检查
  const gitIssuesPromise: Promise<VcsGitIssue[]> = (async () => {
    if (opts.checkGit === false) {
      return [];
    }
    let inRepo: boolean;
    try {
      inRepo = await isGitRepo(packRoot);
    } catch (err) {
      if (err instanceof PackError && err.code === "GIT_NOT_FOUND") {
        return []; // git 不在 PATH：无法执行任何 git 检查，按纯工作区处理
      }
      throw err;
    }
    if (!inRepo) {
      return []; // 不是 git 仓库：允许纯工作区 verify
    }
    return collectGitIssues(packRoot);
  })();

  const [deckVerify, gitIssues] = await Promise.all([
    verifyPack({
      packRoot,
      checkCmyk: opts.checkCmyk,
      checkAtlasSize: opts.checkAtlasSize,
    }),
    gitIssuesPromise,
  ]);

  const gitErrorCount = gitIssues.filter((issue) => issue.severity === "error").length;
  const errorCount = deckVerify.errorCount + gitErrorCount;
  const warningCount = deckVerify.warningCount + (gitIssues.length - gitErrorCount);
  return { errorCount, warningCount, deckVerify, gitIssues, ok: errorCount === 0 };
}
