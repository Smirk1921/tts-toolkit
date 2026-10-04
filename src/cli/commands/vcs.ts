// src/cli/commands/vcs.ts
/**
 * `tts vcs`：版本控制语义封装（阶段 2C）——把 8 个 vcs 模块接到 CLI 上。
 *
 * 子命令一览（本文件是薄调用层，业务逻辑一律在 src/vcs/ 内）：
 * - `tts vcs status [--conflicts]`  工作区改动的语义化列表（analyzeStatus ± analyzeConflicts）
 * - `tts vcs commit [--dry-run]`    自动生成中文 commit message 并提交（vcsCommit）
 * - `tts vcs verify [--skip-*]`     工作区 + git 状态校验（vcsVerify）
 * - `tts vcs size`                  仓库各部分体积（analyzeSize）
 * - `tts vcs lfs status|enable|disable|migrate`  git-lfs 三方状态管理（inspectLfs 等）
 *
 * 输出约定：
 * - 摘要行 / 数据行走 stdout（经 t() 的文案 + 模块产出的中文数据行）；
 * - 仅 `vcs verify` 的 error 级 git issue 走 stderr（与 warning 分流，便于 CI 只收错误），
 *   以及所有命令的错误出口走 stderr；
 * - 退出码：0 成功；1 一般错误 / lfs 校验不一致 / verify 有 error；2 = `vcs status
 *   --conflicts` 发现未解决冲突（CI 可据此区分"有改动"与"有冲突"）。
 *
 * 边界（重要，不要越界）：
 * - 本文件不 import src/session/ 或 src/protocol/**，也不直接 execa("git", …)：
 *   所有 git 调用都收口在 src/vcs/git.ts（经各 vcs 模块）；
 * - `vcs lfs disable` 的二次确认在**本层**完成（约束 10）：disableLfs 自己不做确认，
 *   非交互环境必须显式 `--yes`，绝不静默禁用；
 * - `vcs lfs migrate` 是重写全部历史 `--everything` 语义的破坏性操作，其前置条件
 *   （已装 git-lfs / 工作区干净）由 migrateLfs 自行强制（见 src/vcs/lfs.ts 该函数
 *   的 @throws），本层原样呈现其结果；
 * - 错误处理：PackError 按 `` `error.${code}` `` 取文案（占位符 {msg}），其余异常统一
 *   走 `error.unknown`，两者都以退出码 1 结束（与 src/cli/commands/pack.ts 同模板）。
 *
 * 本模块使用的 i18n 键（locales/*.json 由本地化步骤补齐；缺键时 t() 原样输出键名）：
 * - 静态：`cli.command.vcs.*`（含 lfs 四个子子命令）、`cli.vcs.status.*`、
 *   `cli.vcs.commit.*`、`cli.vcs.verify.summary`、`cli.vcs.size.*`、`cli.vcs.lfs.*`、
 *   `error.unknown` {msg}；
 * - 动态（键 = `error.` + PackError.code，占位符 {msg}）：GIT_NOT_A_REPO /
 *   GIT_NOT_FOUND / GIT_COMMAND_FAILED / VCS_ADD_FAILED / VCS_COMMIT_FAILED /
 *   LFS_NOT_INSTALLED / LFS_ATTRIBUTES_FAILED / PACK_NOT_FOUND / PACK_INVALID /
 *   PACK_WRITE_FAILED 等（各模块错误码的完整取值见其模块头注释）。
 *
 * 与命令层其他文件的约定：createPrompter 三件套在 deck.ts / pack.ts / config.ts 各有一份，
 * 这里按同样方式复制第四份（命令层模块之间不互相 import）。
 */

import { createInterface } from "node:readline";

import { Command } from "commander";

import { t } from "../../i18n/index.js";
import { PackError } from "../../pack/packyaml.js";
import { vcsCommit } from "../../vcs/commit.js";
import { analyzeConflicts, formatConflict } from "../../vcs/conflicts.js";
import { disableLfs, enableLfs, inspectLfs, migrateLfs } from "../../vcs/lfs.js";
import { analyzeStatus } from "../../vcs/semantic.js";
import { analyzeSize } from "../../vcs/size.js";
import { vcsVerify } from "../../vcs/verify.js";

// ---------------------------------------------------------------------------
// 选项类型
// ---------------------------------------------------------------------------

/** `tts vcs status` 的选项 */
interface VcsStatusOptions {
  /** 图包根目录（默认 "."，由 commander 的默认值填入） */
  root: string;
  /** 是否附带合并冲突的语义化报告 */
  conflicts: boolean;
}

/** `tts vcs commit` 的选项（--no-add 在 commander 里是默认 true 的布尔值） */
interface VcsCommitOptions {
  /** 图包根目录 */
  root: string;
  /** 用户自定义 message（缺省时完全自动生成） */
  message?: string;
  /** 只生成 message，不实际提交 */
  dryRun?: boolean;
  /** 是否自动 git add -A；--no-add 时为 false */
  add: boolean;
}

/** `tts vcs verify` 的选项 */
interface VcsVerifyOptions {
  /** 图包根目录 */
  root: string;
  /** 跳过 CMYK 检查（需要读图，慢） */
  skipCmyk: boolean;
  /** 跳过图集尺寸检查（需要读图，慢） */
  skipAtlas: boolean;
  /** 跳过 git 仓库状态检查 */
  skipGit: boolean;
}

/** 只带 --root 的 vcs 子命令（size / lfs 四件套）的选项 */
interface VcsRootOptions {
  /** 图包根目录 */
  root: string;
}

/** `tts vcs lfs disable` 的选项 */
interface LfsDisableOptions extends VcsRootOptions {
  /** 跳过二次确认（脚本场景） */
  yes: boolean;
}

// ---------------------------------------------------------------------------
// 错误出口
// ---------------------------------------------------------------------------

/**
 * vcs 子命令的统一错误出口。
 *
 * PackError 是按错误码分支的（如 "GIT_NOT_A_REPO" / "VCS_COMMIT_FAILED"），
 * 对应 `error.<code>` 文案；其余异常（含模块入参校验、fs 错误）统一走
 * `error.unknown`。两者都只写 stderr，绝不向 stdout 混入错误信息。
 *
 * （与 src/cli/commands/pack.ts 的 reportPackError 是同一份实现，仅改前缀名。）
 *
 * @param err 命令 action 中捕获的异常
 * @returns 建议的进程退出码（恒为 1，与 CLI 其他命令一致）
 */
function reportVcsError(err: unknown): number {
  if (err instanceof PackError) {
    console.error(t(`error.${err.code}`, { msg: err.message }));
    return 1;
  }
  console.error(t("error.unknown", { msg: err instanceof Error ? err.message : String(err) }));
  return 1;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 字节数换算单位（从大到小依次试探；不足 1 KB 时直接输出字节） */
const BYTE_UNITS: ReadonlyArray<{ limit: number; suffix: string }> = [
  { limit: 1024 ** 4, suffix: "TB" },
  { limit: 1024 ** 3, suffix: "GB" },
  { limit: 1024 ** 2, suffix: "MB" },
  { limit: 1024, suffix: "KB" },
];

/**
 * 把字节数格式化成人可读文本：不足 1 KB 输出整数字节（"512 B"），
 * 其余按 1024 进制取最大适用单位并保留两位小数（"1.50 MB"）。
 *
 * @param bytes 字节数（非负整数；analyzeSize 的统计值）
 * @returns 格式化文本
 */
function formatBytes(bytes: number): string {
  for (const unit of BYTE_UNITS) {
    if (bytes >= unit.limit) {
      return `${(bytes / unit.limit).toFixed(2)} ${unit.suffix}`;
    }
  }
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------
// 交互提示器（lfs disable 的二次确认用）
// ---------------------------------------------------------------------------

/** 命令内复用的交互提示器 */
interface Prompter {
  /**
   * 提问并读一行。
   * @param question 提示语（已翻译）
   * @returns 去除首尾空白的输入；EOF / 流关闭时返回空串（调用方按"取消"处理）
   */
  ask(question: string): Promise<string>;
  /** 关闭底层 readline 接口 */
  close(): void;
}

/**
 * 创建交互提示器。
 *
 * 实现要点（踩过的坑）：不能直接用 `rl.question` 逐个提问——readline 在没有
 * pending question 时会丢掉已到达的行。管道输入（`printf 'yes\n' | tts vcs lfs disable`）
 * 一次性送达时第二行会被丢弃，表现为"输入无效后立刻取消"。
 * 因此这里自己维护"待消费行队列 + 等待者队列"：line 事件先喂等待者，没人等就入队，
 * 下个提问直接取队列，EOF 时统一按空串（取消）唤醒。
 *
 * （与 deck.ts / pack.ts / config.ts 的 createPrompter 是同一份实现；命令层模块之间
 * 不互相 import，此处为第 4 份副本，四处如需调整必须同步修改。）
 *
 * @returns 提示器；调用方负责在结束时 {@link Prompter.close}
 */
function createPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  /** 已到达但尚无提问消费的行 */
  const pendingLines: string[] = [];
  /** 正在等待输入的提问回调 */
  const waiters: Array<(line: string) => void> = [];
  let closed = false;

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(trimmed);
      return;
    }
    pendingLines.push(trimmed);
  });
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter("");
    }
  });

  return {
    ask(question: string): Promise<string> {
      process.stdout.write(question);
      const buffered = pendingLines.shift();
      if (buffered !== undefined) {
        return Promise.resolve(buffered);
      }
      if (closed) {
        return Promise.resolve("");
      }
      return new Promise<string>((resolve) => {
        waiters.push(resolve);
      });
    },
    close(): void {
      rl.close();
    },
  };
}

/**
 * stdin 是否还可读（决定能否弹交互提示）。
 *
 * 不要求 isTTY：管道 / 重定向（`printf 'yes\n' | tts vcs lfs disable`）也应能确认；
 * child_process 以 stdio: "ignore" 启动时 stdin 会被销毁，此时返回 false，
 * 命令按"必须显式 --yes"处理而不是挂死。
 *
 * @returns stdin 可读返回 true
 */
function canPrompt(): boolean {
  return process.stdin.readable === true && process.stdin.destroyed !== true;
}

// ---------------------------------------------------------------------------
// 子命令：status / commit / verify / size
// ---------------------------------------------------------------------------

/**
 * `tts vcs status`：用图包语言显示工作区状态。
 *
 * 干净时不输出任何改动行（只打一条 clean 摘要）；有改动时逐条打模块生成的
 * 中文摘要（summary 由 src/vcs/semantic.ts 写死，不走 t()——它是数据不是界面文案）。
 * `--conflicts` 在改动列表之后追加合并冲突报告：每个冲突一段多行文本（formatConflict），
 * 发现冲突时以退出码 2 结束，便于脚本区分"有改动"与"有冲突"。
 */
const statusSub = new Command("status")
  .description(t("cli.command.vcs.status.description"))
  .option("--root <dir>", t("cli.command.vcs.status.option.root"), ".")
  .option("--conflicts", t("cli.command.vcs.status.option.conflicts"), false)
  .action(async (opts: VcsStatusOptions) => {
    try {
      const status = await analyzeStatus(opts.root);
      if (!status.dirty) {
        console.log(t("cli.vcs.status.clean"));
        return;
      }
      for (const change of status.changes) {
        console.log(change.summary);
      }
      if (status.unknownCount > 0) {
        console.log(t("cli.vcs.status.unknownNote", { count: status.unknownCount }));
      }

      if (!opts.conflicts) {
        return;
      }
      const report = await analyzeConflicts(opts.root);
      if (!report.hasConflicts) {
        return;
      }
      console.log(t("cli.vcs.status.conflictsHeader", { count: report.conflicts.length }));
      for (const info of report.conflicts) {
        console.log(formatConflict(info));
      }
      if (report.cardsCsvConflictPaths.length > 0) {
        console.log(t("cli.vcs.status.cardsCsvWarning"));
      }
      // 冲突退出码：用 exitCode 而不是 process.exit()，保证 stdout 已写完
      process.exitCode = 2;
    } catch (err) {
      process.exit(reportVcsError(err));
    }
  });

/**
 * `tts vcs commit`：自动生成中文 commit message 并提交（vcsCommit）。
 *
 * 工作区干净时 vcsCommit 返回全空结果（message=""），这里只提示 clean 且以 0 退出；
 * dryRun 只打印将会使用的 message，不 add / 不 commit。--no-add 时只提交已暂存内容，
 * 未暂存改动留在工作区（message 仍按提交前的全部改动生成）。
 */
const commitSub = new Command("commit")
  .description(t("cli.command.vcs.commit.description"))
  .option("--root <dir>", t("cli.command.vcs.commit.option.root"), ".")
  .option("-m, --message <msg>", t("cli.command.vcs.commit.option.message"))
  .option("--dry-run", t("cli.command.vcs.commit.option.dryRun"), false)
  // 注意：--no-add 不能传第三参默认值 false（commander 会把它同时当作 add 的默认值，
  // 使 --no-add 恒为 false、自动 add 永久关闭）；不给默认值时 add 默认 true，--no-add → false。
  .option("--no-add", t("cli.command.vcs.commit.option.noAdd"))
  .action(async (opts: VcsCommitOptions) => {
    try {
      const result = await vcsCommit({
        packRoot: opts.root,
        userMessage: opts.message,
        autoAdd: opts.add,
        dryRun: opts.dryRun,
      });
      if (!result.committed && result.commitHash === null && result.message === "") {
        console.log(t("cli.vcs.commit.clean"));
        return;
      }
      if (opts.dryRun === true) {
        console.log(t("cli.vcs.commit.dryRunMessage", { message: result.message }));
        return;
      }
      console.log(
        t("cli.vcs.commit.done", {
          hash: result.commitHash?.slice(0, 7) ?? "",
          message: result.message,
        }),
      );
    } catch (err) {
      process.exit(reportVcsError(err));
    }
  });

/**
 * `tts vcs verify`：工作区 + git 状态校验（vcsVerify，只读）。
 *
 * 输出分两段：
 * - deck 侧 issue（result.deckVerify.issues）沿用 `tts deck verify` 的纯数据行格式
 *   写 stdout（severity / code / message / location）——vcsVerify 的统计包含了这批
 *   issue，不打印它们会让摘要里的错误数无从对应；
 * - git 侧 issue（result.gitIssues）按 severity 分流：error 写 stderr，warning 写
 *   stdout（CI 可以只看 stderr 抓阻塞项）。
 * 末行摘要给出合并后的错误 / 警告数；有 error 时以 `process.exitCode = 1` 结束
 * （不用 process.exit，便于 CI 当门禁且保证输出已 flush）。
 */
const verifySub = new Command("verify")
  .description(t("cli.command.vcs.verify.description"))
  .option("--root <dir>", t("cli.command.vcs.verify.option.root"), ".")
  .option("--skip-cmyk", t("cli.command.vcs.verify.option.skipCmyk"), false)
  .option("--skip-atlas", t("cli.command.vcs.verify.option.skipAtlas"), false)
  .option("--skip-git", t("cli.command.vcs.verify.option.skipGit"), false)
  .action(async (opts: VcsVerifyOptions) => {
    try {
      const result = await vcsVerify({
        packRoot: opts.root,
        checkCmyk: !opts.skipCmyk,
        checkAtlasSize: !opts.skipAtlas,
        checkGit: !opts.skipGit,
      });
      for (const issue of result.deckVerify.issues) {
        console.log(`  [${issue.severity}] ${issue.code}  ${issue.message}  (${issue.location})`);
      }
      for (const issue of result.gitIssues) {
        const line = `  [${issue.severity}] ${issue.code}  ${issue.message}`;
        if (issue.severity === "error") {
          console.error(line);
        } else {
          console.log(line);
        }
      }
      console.log(
        t("cli.vcs.verify.summary", {
          errors: result.errorCount,
          warnings: result.warningCount,
        }),
      );
      if (!result.ok) {
        process.exitCode = 1;
      }
    } catch (err) {
      process.exit(reportVcsError(err));
    }
  });

/**
 * `tts vcs size`：报告仓库各部分体积（analyzeSize，只读）。
 *
 * 输出工作区 / .git 两行总量；lfs 启用时补一行 .git/lfs/objects（它包含在 .git 里，
 * 是解释"仓库为什么大"的关键项）。随后按目录分解（dir / 体积 / 文件数），桶序沿用
 * analyzeSize 的 bytes 降序，不再重排。
 */
const sizeSub = new Command("size")
  .description(t("cli.command.vcs.size.description"))
  .option("--root <dir>", t("cli.command.vcs.size.option.root"), ".")
  .action(async (opts: VcsRootOptions) => {
    try {
      const report = await analyzeSize(opts.root);
      console.log(t("cli.vcs.size.workspace", { bytes: formatBytes(report.workspaceBytes) }));
      console.log(t("cli.vcs.size.git", { bytes: formatBytes(report.gitBytes) }));
      if (report.lfsEnabled) {
        console.log(t("cli.vcs.size.lfsObjects", { bytes: formatBytes(report.lfsObjectsBytes) }));
      }
      console.log(t("cli.vcs.size.breakdownHeader"));
      for (const bucket of report.breakdown) {
        console.log(`  ${bucket.dir}  ${formatBytes(bucket.bytes)}  ${bucket.fileCount}`);
      }
    } catch (err) {
      process.exit(reportVcsError(err));
    }
  });

// ---------------------------------------------------------------------------
// 子命令：lfs（含 4 个子子命令）
// ---------------------------------------------------------------------------

/** `tts vcs lfs` 主命令：4 个子子命令在下方定义后统一挂载（薄分发层，无自身 action） */
const lfsSub = new Command("lfs").description(t("cli.command.vcs.lfs.description"));

/**
 * `tts vcs lfs status`：查看 lfs 三方（系统 git-lfs / .gitattributes / pack.yaml）一致性。
 *
 * 恒打印三行事实（是否安装 + 版本、.gitattributes 是否含规则、pack.yaml 的 vcs.lfs），
 * 有警告时逐条打印并以退出码 1 结束（门禁语义），全部一致时打一行 consistent。
 * pack.yaml 不存在时 vcs.lfs 为 null，用 "-" 占位（不硬编码中文，缺键由 t() 兜底）。
 */
const lfsStatusSub = new Command("status")
  .description(t("cli.command.vcs.lfs.status.description"))
  .option("--root <dir>", t("cli.command.vcs.lfs.status.option.root"), ".")
  .action(async (opts: VcsRootOptions) => {
    try {
      const inspection = await inspectLfs(opts.root);
      console.log(
        inspection.installed
          ? t("cli.vcs.lfs.installed", { version: inspection.version ?? "-" })
          : t("cli.vcs.lfs.notInstalled"),
      );
      console.log(t("cli.vcs.lfs.attributesHasLfs", { yes: inspection.attributesHasLfs }));
      console.log(t("cli.vcs.lfs.packYamlLfs", { mode: inspection.packYamlLfs ?? "-" }));
      if (inspection.warnings.length > 0) {
        for (const warning of inspection.warnings) {
          console.log(warning);
        }
        process.exitCode = 1;
        return;
      }
      console.log(t("cli.vcs.lfs.consistent"));
    } catch (err) {
      process.exit(reportVcsError(err));
    }
  });

/**
 * `tts vcs lfs enable`：写 / 补全 .gitattributes 的 lfs 规则 + pack.yaml 的 vcs.lfs
 * → "enabled"（enableLfs）。已处于 enabled 状态时 changed=false，补一行提示。
 */
const lfsEnableSub = new Command("enable")
  .description(t("cli.command.vcs.lfs.enable.description"))
  .option("--root <dir>", t("cli.command.vcs.lfs.enable.option.root"), ".")
  .action(async (opts: VcsRootOptions) => {
    try {
      const result = await enableLfs(opts.root);
      console.log(t("cli.vcs.lfs.enableDone"));
      if (!result.changed) {
        console.log(t("cli.vcs.lfs.alreadyEnabled"));
      }
    } catch (err) {
      process.exit(reportVcsError(err));
    }
  });

/**
 * `tts vcs lfs disable`：清空 .gitattributes 的 lfs 规则 + pack.yaml 的 vcs.lfs
 * → "disabled"（disableLfs）。
 *
 * 约束 10 的二次确认在**本层**做（disableLfs 自己不做）：交互环境先打印后果警告、
 * 要求输入 yes；非交互环境必须显式 `--yes`，否则以退出码 1 拒绝执行——绝不静默禁用。
 */
const lfsDisableSub = new Command("disable")
  .description(t("cli.command.vcs.lfs.disable.description"))
  .option("--root <dir>", t("cli.command.vcs.lfs.disable.option.root"), ".")
  .option("--yes", t("cli.command.vcs.lfs.disable.option.yes"), false)
  .action(async (opts: LfsDisableOptions) => {
    try {
      if (!opts.yes) {
        if (!canPrompt()) {
          console.error(t("cli.vcs.lfs.disableNeedsYes"));
          process.exit(1);
        }
        console.log(t("cli.vcs.lfs.disableWarning"));
        const prompter = createPrompter();
        let answer: string;
        try {
          answer = await prompter.ask(t("cli.vcs.lfs.disableConfirm"));
        } finally {
          prompter.close();
        }
        if (answer !== "yes") {
          console.log(t("cli.vcs.lfs.disableCancelled"));
          return;
        }
      }
      await disableLfs(opts.root);
      console.log(t("cli.vcs.lfs.disableDone"));
    } catch (err) {
      process.exit(reportVcsError(err));
    }
  });

/**
 * `tts vcs lfs migrate`：`git lfs migrate import --everything`，把历史提交中的
 * 图片 / 模型 / ttsmod 转成 lfs 指针（migrateLfs）。
 *
 * 破坏性操作（重写全部提交历史，已有远端需 force push）：本层原样呈现 git 的
 * 合并输出，前置条件（已装 lfs / 工作区干净）由 migrateLfs 自行强制。
 */
const lfsMigrateSub = new Command("migrate")
  .description(t("cli.command.vcs.lfs.migrate.description"))
  .option("--root <dir>", t("cli.command.vcs.lfs.migrate.option.root"), ".")
  .action(async (opts: VcsRootOptions) => {
    try {
      const result = await migrateLfs(opts.root);
      console.log(t("cli.vcs.lfs.migrateDone", { output: result.output }));
    } catch (err) {
      process.exit(reportVcsError(err));
    }
  });

lfsSub.addCommand(lfsStatusSub);
lfsSub.addCommand(lfsEnableSub);
lfsSub.addCommand(lfsDisableSub);
lfsSub.addCommand(lfsMigrateSub);

// ---------------------------------------------------------------------------
// 主命令
// ---------------------------------------------------------------------------

/** `tts vcs` 主命令：5 个子命令在上方定义后统一挂载（薄分发层，无自身 action） */
export const vcsCommand: Command = new Command("vcs").description(t("cli.command.vcs.description"));

vcsCommand.addCommand(statusSub);
vcsCommand.addCommand(commitSub);
vcsCommand.addCommand(verifySub);
vcsCommand.addCommand(sizeSub);
vcsCommand.addCommand(lfsSub);
