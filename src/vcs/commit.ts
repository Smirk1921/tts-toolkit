// src/vcs/commit.ts
/**
 * 语义化提交（`tts vcs commit` 等命令的数据层）：基于 {@link analyzeStatus} 的
 * 语义化分析结果自动生成有意义的 commit message，然后 `git add -A` +
 * `git commit`。
 *
 * message 生成规则：
 * - autoSummary 由 {@link SemanticChange} 列表生成：按 kind 优先级
 *   （{@link KIND_PRIORITY}，卡图 > 卡表 > 脚本 > UI > 素材 > 元数据 > unknown）
 *   升序取前 {@link SUMMARY_LIMIT} 条（同 kind 保持分析结果的首次出现顺序，
 *   Array.sort 稳定），每条套固定中文模板（写死不走 t()）：
 *   | kind           | 模板                              |
 *   |----------------|-----------------------------------|
 *   | deck-cards     | 替换 <subject> <cardCount> 张卡图 |
 *   | deck-cards-csv | 调整 <subject> 卡表               |
 *   | script         | 修改 <subject> 脚本（+X/-Y 行）   |
 *   | ui             | 修改 <subject> UI（+X/-Y 行）     |
 *   | object-asset   | 更新素材 <subject>                |
 *   | deck-yaml      | 调整 <subject> 元数据             |
 *   | pack-yaml      | 调整图包配置                      |
 *   | metadata       | 调整元数据                        |
 *   | unknown        | 其他改动                          |
 *   多条用 "，" 连接；总条数超过 {@link SUMMARY_LIMIT} 时末尾追加
 *   "等 N 项改动"（N 为总条数，即 status.changes.length）；
 * - 有 userMessage 时最终 message 为 "<userMessage>：<autoSummary>"（全角冒号）；
 *   userMessage 去首尾空白后为空则视为未提供。无 userMessage 时 message 就是
 *   autoSummary 本身；
 * - 工作区无改动（status.dirty=false）时**不抛错**，返回 message=""、
 *   committed=false、commitHash=null——"工作区干净"由 CLI 层提示。
 *
 * 提交流程（{@link vcsCommit}）：
 * 1. {@link analyzeStatus} 取语义化状态（git 层错误原样透传）；
 * 2. 无改动 → 直接返回空结果；
 * 3. 生成 autoSummary 并拼接最终 message；
 * 4. dryRun=true → 到此为止：不 add、不 commit、不触碰工作区，commitHash=null；
 * 5. autoAdd（默认 true）→ `git add -A`（经 runGitOrThrow，参数走数组）；
 * 6. `git commit -m <message>`；
 * 7. {@link headCommit} 取新提交的完整 hash 返回。
 *
 * 错误码（{@link PackError.code}）：
 * - "VCS_ADD_FAILED"     git add -A 失败（映射自 GIT_COMMAND_FAILED，错误消息
 *                         保留原命令行与 stderr）
 * - "VCS_COMMIT_FAILED"  git commit 失败（同上；含"暂存区为空无可提交"）
 * - GIT_NOT_A_REPO / GIT_NOT_FOUND 等环境错误原样透传不改码——"不是 git 仓库"
 *   是调用方必须看到的硬错误，与"这次提交没成功"性质不同。
 *
 * 注意：
 * - result.status 是**提交前**的分析快照；autoAdd=false 时只提交已暂存内容，
 *   未暂存改动留在工作区（message 仍按提交前的全部分动生成，由调用方取舍）；
 * - 本模块离线：不 import 命令层 / with-server.ts / session/*。
 */

import { PackError } from "../pack/packyaml.js";
import { headCommit, runGitOrThrow } from "./git.js";
import { analyzeStatus } from "./semantic.js";
import type { SemanticChange, SemanticChangeKind, SemanticStatus } from "./semantic.js";

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** {@link vcsCommit} 的选项 */
export interface CommitOptions {
  /** 图包工作区根目录（必须是 git 仓库工作树） */
  packRoot: string;
  /**
   * 用户提供的 message（可选）；提供时最终 message 为
   * "<userMessage>：<autoSummary>"，去首尾空白后为空则视为未提供。
   * 不提供时完全自动生成（即 autoSummary 本身）。
   */
  userMessage?: string;
  /** 是否自动 `git add -A`（默认 true）；false 时只提交已暂存内容 */
  autoAdd?: boolean;
  /** dry-run：只生成 message，不实际 add / commit（默认 false），commitHash 恒为 null */
  dryRun?: boolean;
}

/** {@link vcsCommit} 的返回结果 */
export interface CommitResult {
  /** 实际使用（或 dryRun 下将会使用）的 commit message */
  message: string;
  /** 是否实际执行了 commit（dryRun=true 或工作区无改动时为 false） */
  committed: boolean;
  /** 新提交的完整 hash（40 位十六进制；dryRun 或无改动时为 null） */
  commitHash: string | null;
  /** 自动生成的摘要部分（不含用户 message） */
  autoSummary: string;
  /** 提交前的语义化分析快照 */
  status: SemanticStatus;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** autoSummary 最多展开的改动条数；总条数超出时末尾追加"等 N 项改动" */
const SUMMARY_LIMIT = 3;

/**
 * kind → autoSummary 模板优先级（小者优先）。
 * 卡图改动最直观、卡表次之，脚本 / UI 再次；元数据与反查失败的 unknown 殿后。
 */
const KIND_PRIORITY: Record<SemanticChangeKind, number> = {
  "deck-cards": 1,
  "deck-cards-csv": 2,
  "script": 3,
  "ui": 4,
  "object-asset": 5,
  "deck-yaml": 6,
  "pack-yaml": 7,
  "metadata": 8,
  "unknown": 9,
};

// ---------------------------------------------------------------------------
// message 生成
// ---------------------------------------------------------------------------

/**
 * 把单条 {@link SemanticChange} 套上固定中文模板（模板写死，不走 t()）。
 * 行数 / 卡数字段缺失时按 0 兜底（analyzeStatus 恒会填写，这里只是防御）。
 * @param change 聚合后的语义化改动
 * @returns 摘要文本（如 "冒险牌堆 2 张卡换图" 对应的 "替换 冒险牌堆 2 张卡图"）
 */
function describeChange(change: SemanticChange): string {
  const subject = change.subject ?? "";
  switch (change.kind) {
    case "deck-cards":
      return `替换 ${subject} ${change.cardCount ?? 0} 张卡图`;
    case "deck-cards-csv":
      return `调整 ${subject} 卡表`;
    case "script":
      return `修改 ${subject} 脚本（+${change.added ?? 0}/-${change.deleted ?? 0} 行）`;
    case "ui":
      return `修改 ${subject} UI（+${change.added ?? 0}/-${change.deleted ?? 0} 行）`;
    case "object-asset":
      return `更新素材 ${subject}`;
    case "deck-yaml":
      return `调整 ${subject} 元数据`;
    case "pack-yaml":
      return "调整图包配置";
    case "metadata":
      return "调整元数据";
    case "unknown":
      return "其他改动";
  }
}

/**
 * 由语义化改动列表生成 autoSummary：按 {@link KIND_PRIORITY} 升序取前
 * {@link SUMMARY_LIMIT} 条（同 kind 保持首次出现顺序，sort 稳定），用 "，"
 * 连接；总条数超过 {@link SUMMARY_LIMIT} 时末尾追加 "等 N 项改动"（N 为总条数）。
 * @param changes analyzeStatus 输出的改动列表（只读，不被修改）
 * @returns 摘要文本；changes 为空时为空串
 */
function buildAutoSummary(changes: readonly SemanticChange[]): string {
  if (changes.length === 0) {
    return "";
  }
  const ranked = [...changes].sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
  let summary = ranked
    .slice(0, SUMMARY_LIMIT)
    .map(describeChange)
    .join("，");
  if (changes.length > SUMMARY_LIMIT) {
    summary += `等 ${changes.length} 项改动`;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 生成语义化 commit message 并提交（规则与流程详见模块头注释）。
 *
 * @param opts packRoot 必填；userMessage / autoAdd / dryRun 可选
 * @returns 提交结果（status 为提交前快照）
 * @throws PackError code="GIT_NOT_A_REPO" packRoot 不是 git 仓库工作树时（分析阶段透传）
 * @throws PackError code="GIT_NOT_FOUND" git 不在 PATH 时
 * @throws PackError code="VCS_ADD_FAILED" git add -A 失败时
 * @throws PackError code="VCS_COMMIT_FAILED" git commit 失败时（含暂存区为空）
 * @throws Error packRoot 不是非空字符串时（调用方编程错误，来自 analyzeStatus）
 */
export async function vcsCommit(opts: CommitOptions): Promise<CommitResult> {
  const packRoot = opts.packRoot;
  const status = await analyzeStatus(packRoot);

  // 工作区干净：不抛错，交由 CLI 层提示"工作区干净"。
  // changes 为空是 dirty=true 下的防御分支（正常分析两者恒一致）。
  if (!status.dirty || status.changes.length === 0) {
    return { message: "", committed: false, commitHash: null, autoSummary: "", status };
  }

  const autoSummary = buildAutoSummary(status.changes);
  const trimmedUserMessage = opts.userMessage?.trim();
  const message = trimmedUserMessage ? `${trimmedUserMessage}：${autoSummary}` : autoSummary;

  if (opts.dryRun === true) {
    return { message, committed: false, commitHash: null, autoSummary, status };
  }

  if (opts.autoAdd !== false) {
    try {
      await runGitOrThrow(["add", "-A"], { cwd: packRoot });
    } catch (err) {
      // 仅映射"命令本身失败"；GIT_NOT_FOUND 等环境错误原样透传不改码
      if (err instanceof PackError && err.code === "GIT_COMMAND_FAILED") {
        throw new PackError("VCS_ADD_FAILED", err.message);
      }
      throw err;
    }
  }

  try {
    await runGitOrThrow(["commit", "-m", message], { cwd: packRoot });
  } catch (err) {
    if (err instanceof PackError && err.code === "GIT_COMMAND_FAILED") {
      throw new PackError("VCS_COMMIT_FAILED", err.message);
    }
    throw err;
  }

  const commitHash = await headCommit(packRoot);
  return { message, committed: true, commitHash, autoSummary, status };
}
