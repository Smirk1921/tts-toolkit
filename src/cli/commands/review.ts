// src/cli/commands/review.ts
/**
 * `tts review prepare` / `tts review status` / `tts review gate`：与「图包审批工具」
 * 的联动（方案设计 §13.2 集成层 ①②③；阶段 3，窗口 C）。
 *
 * 三个子命令各对接一个已有模块，本文件只做参数解析与结果呈现：
 * - `prepare` → src/review/config.ts：从 deck 目录生成
 *   `<pack>/.tts/approval/approval.config.json`（data_dir 指向本工具工作区内，
 *   不让审批工具往它自己仓库写）。素材集**一个 deck 一条**：源A = deck 目录
 *   （旧版图），源B = `--b` 指定的新版渲染目录；素材 id 就是文件名
 *   （approval 工具配 pair: basename，零转换）；
 * - `status` → src/review/client.ts：调审批工具总览（服务在跑走 HTTP，否则走
 *   `python agent.py`，选路在客户端内），打印 agent 返回的 JSON（机器可读数据，
 *   不翻译）；
 * - `gate` → src/review/gate.ts：读审批结果做发布门禁。待审清单从素材集所配的
 *   源A（deck 目录）的 cards.csv 推导，成品文件存在性 / 指纹过期检查用源B
 *   （`--b-root` 可覆盖）。**全 pass 才放行**；不过时逐条列出拦截理由并以
 *   退出码 1 结束（门禁语义），放行时 0。
 *
 * `status` 的 `--approval-root`：审批工具仓库根（含 agent.py）。走 HTTP
 * （`--server`）时不需要 python，故此时可省略；否则必须给出——本工具不猜
 * 别的机器上审批工具装在哪。
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像；缺键时 t() 原样输出键名）：
 * - 静态：`cli.command.review.*`（三个子命令 description 与全部 option）、
 *   `cli.review.prepare.*`、`cli.review.status.needApprovalRoot`、
 *   `cli.review.gate.*`、`error.unknown` {msg}；
 * - 动态（键 = `error.` + PackError.code，占位符 {msg}）：REVIEW_CONFIG_NOT_FOUND /
 *   REVIEW_CONFIG_READ_FAILED / REVIEW_CONFIG_INVALID / REVIEW_CONFIG_WRITE_FAILED /
 *   REVIEW_APP_MISSING / REVIEW_CALL_FAILED / REVIEW_GATE_INPUT_INVALID /
 *   REVIEW_RESULT_NOT_FOUND / REVIEW_RESULT_READ_FAILED / REVIEW_RESULT_INVALID
 *   （以及 deck 侧透传的 DECK_* / CARDS_*）。
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { t } from "../../i18n/index.js";
import { decksDir } from "../../pack/layout.js";
import { PackError } from "../../pack/packyaml.js";
import { ApprovalClient } from "../../review/client.js";
import {
  approvalConfigPath,
  approvalSetFromDeck,
  readApprovalConfigStrict,
  writeApprovalConfig,
} from "../../review/config.js";
import { evaluateGate, type GateBlockerReason } from "../../review/gate.js";

// ---------------------------------------------------------------------------
// 选项类型
// ---------------------------------------------------------------------------

/** `tts review prepare` 的选项 */
interface ReviewPrepareOptions {
  /** 图包工作区根目录（默认 "."） */
  pack: string;
  /** decks/ 下的目录名（缺省：恰好一个 deck 时自动选中） */
  deck?: string;
  /** 素材集 id（缺省取 deck 目录名） */
  set?: string;
  /** 素材集显示名（缺省取 deck.yaml 的 name） */
  name?: string;
  /** 源A（旧版图）根目录（缺省取 deck 目录） */
  a?: string;
  /** 源B（新版渲染）根目录（必填） */
  b?: string;
  /** 源A 显示标签 */
  labelA?: string;
  /** 源B 显示标签 */
  labelB?: string;
  /** 问题标签（逗号分隔） */
  tags?: string;
  /** 审批服务监听地址（缺省 127.0.0.1） */
  host?: string;
  /** 审批服务监听端口（缺省 8765） */
  port?: string;
}

/** `tts review status` 的选项 */
interface ReviewStatusOptions {
  /** 图包工作区根目录（默认 "."） */
  pack: string;
  /** 审批工具仓库根（含 agent.py；走 --server 时可省略） */
  approvalRoot?: string;
  /** 强制 CLI 直连文件（给 agent.py 传 --offline） */
  offline?: boolean;
  /** 显式服务基址（如 http://127.0.0.1:8765） */
  server?: string;
}

/** `tts review gate` 的选项 */
interface ReviewGateOptions {
  /** 图包工作区根目录（默认 "."） */
  pack: string;
  /** 素材集 id（配置里只有一个素材集时可省略） */
  set?: string;
  /** 源B（成品）目录覆盖（缺省取配置里该素材集的 b.root） */
  bRoot?: string;
  /** 审批数据目录覆盖（缺省取配置里的 data_dir） */
  dataDir?: string;
}

// ---------------------------------------------------------------------------
// 错误出口
// ---------------------------------------------------------------------------

/**
 * review 子命令的统一错误出口（与 pack.ts 的 reportPackError 同一份实现）。
 * @param err 命令 action 中捕获的异常
 * @returns 建议的进程退出码（恒为 1）
 */
function reportReviewError(err: unknown): number {
  if (err instanceof PackError) {
    console.error(t(`error.${err.code}`, { msg: err.message }));
    return 1;
  }
  console.error(t("error.unknown", { msg: err instanceof Error ? err.message : String(err) }));
  return 1;
}

/** 门禁拦截理由的界面标签 */
function blockerReasonLabel(reason: GateBlockerReason): string {
  return t(`cli.review.gate.reason.${reason}`);
}

/**
 * 列出 decks/ 下的一级子目录名（升序；目录不存在时返回空数组）。
 * @param root 图包工作区根目录
 * @returns deck 目录名列表
 */
async function listDeckDirs(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(decksDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------
// 子命令：prepare
// ---------------------------------------------------------------------------

/**
 * `tts review prepare`：生成 approval.config.json（一个 deck 一个素材集）。
 *
 * `--b` 必填（新版渲染目录是使用方的语义决定，本工具不猜）；缺省源A 取该
 * deck 目录。配置写前经严格 schema 校验（src/review/config.ts 内），写失败
 * 按 REVIEW_CONFIG_* 错误码出口。
 */
const prepareSub = new Command("prepare")
  .description(t("cli.command.review.prepare.description"))
  .option("--pack <dir>", t("cli.command.review.prepare.option.pack"), ".")
  .option("--deck <name>", t("cli.command.review.prepare.option.deck"))
  .option("--set <id>", t("cli.command.review.prepare.option.set"))
  .option("--name <display>", t("cli.command.review.prepare.option.name"))
  .option("--a <dir>", t("cli.command.review.prepare.option.a"))
  .option("--b <dir>", t("cli.command.review.prepare.option.b"))
  .option("--label-a <label>", t("cli.command.review.prepare.option.labelA"))
  .option("--label-b <label>", t("cli.command.review.prepare.option.labelB"))
  .option("--tags <list>", t("cli.command.review.prepare.option.tags"))
  .option("--host <addr>", t("cli.command.review.prepare.option.host"))
  .option("--port <n>", t("cli.command.review.prepare.option.port"))
  .action(async (opts: ReviewPrepareOptions) => {
    try {
      const root = path.resolve(opts.pack);
      let deckName = opts.deck;
      if (deckName === undefined) {
        const decks = await listDeckDirs(root);
        if (decks.length === 0) {
          console.error(t("cli.review.prepare.noDeck", { root: decksDir(root) }));
          process.exit(1);
        }
        if (decks.length > 1) {
          console.error(t("cli.review.prepare.multipleDecks", { names: decks.join("、") }));
          process.exit(1);
        }
        deckName = decks[0] as string;
      }
      if (opts.b === undefined || opts.b.trim() === "") {
        console.error(t("cli.review.prepare.needB"));
        process.exit(1);
      }

      let port: number | undefined;
      if (opts.port !== undefined) {
        port = Number(opts.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          console.error(t("cli.review.prepare.invalidPort", { value: opts.port }));
          process.exit(1);
        }
      }
      const tags =
        opts.tags === undefined
          ? undefined
          : opts.tags
              .split(",")
              .map((tag) => tag.trim())
              .filter((tag) => tag !== "");

      const deckDir = path.join(decksDir(root), deckName);
      const aRoot = opts.a ?? deckDir;
      const set = await approvalSetFromDeck(deckDir, {
        id: opts.set ?? deckName,
        ...(opts.name === undefined ? {} : { name: opts.name }),
        aRoot,
        ...(opts.labelA === undefined ? {} : { aLabel: opts.labelA }),
        bRoot: opts.b,
        ...(opts.labelB === undefined ? {} : { bLabel: opts.labelB }),
      });
      const result = await writeApprovalConfig(root, {
        sets: [set],
        ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
        ...(opts.host === undefined ? {} : { host: opts.host }),
        ...(port === undefined ? {} : { port }),
      });
      console.log(
        t("cli.review.prepare.done", {
          config: result.configPath,
          dataDir: result.dataDir,
          setId: set.id,
          aRoot,
          bRoot: opts.b,
        }),
      );
    } catch (err) {
      process.exit(reportReviewError(err));
    }
  });

// ---------------------------------------------------------------------------
// 子命令：status
// ---------------------------------------------------------------------------

/**
 * `tts review status`：调审批工具总览并打印 JSON。
 *
 * 输出是 agent 的机器可读数据（不翻译、不摘要）——字段语义见审批工具
 * docs/agent-接口.md；脚本 / agent 可直接解析。
 */
const statusSub = new Command("status")
  .description(t("cli.command.review.status.description"))
  .option("--pack <dir>", t("cli.command.review.status.option.pack"), ".")
  .option("--approval-root <dir>", t("cli.command.review.status.option.approvalRoot"))
  .option("--offline", t("cli.command.review.status.option.offline"), false)
  .option("--server <url>", t("cli.command.review.status.option.server"))
  .action(async (opts: ReviewStatusOptions) => {
    try {
      if (opts.approvalRoot === undefined && opts.server === undefined) {
        console.error(t("cli.review.status.needApprovalRoot"));
        process.exit(1);
      }
      const client = new ApprovalClient({
        approvalRoot: opts.approvalRoot ?? "",
        configPath: approvalConfigPath(path.resolve(opts.pack)),
        ...(opts.offline === true ? { offline: true } : {}),
        ...(opts.server === undefined ? {} : { server: opts.server }),
      });
      const result = await client.status();
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      process.exit(reportReviewError(err));
    }
  });

// ---------------------------------------------------------------------------
// 子命令：gate
// ---------------------------------------------------------------------------

/**
 * `tts review gate`：读审批结果做发布门禁（全 pass 才放行）。
 *
 * 待审清单与成品目录来自配置里该素材集的 a.root / b.root（`--b-root` 可覆盖
 * 成品目录）；数据目录缺省取配置的 data_dir（`--data-dir` 可覆盖）。门禁不过
 * 时逐条列出拦截理由并以退出码 1 结束。
 */
const gateSub = new Command("gate")
  .description(t("cli.command.review.gate.description"))
  .option("--pack <dir>", t("cli.command.review.gate.option.pack"), ".")
  .option("--set <id>", t("cli.command.review.gate.option.set"))
  .option("--b-root <dir>", t("cli.command.review.gate.option.bRoot"))
  .option("--data-dir <dir>", t("cli.command.review.gate.option.dataDir"))
  .action(async (opts: ReviewGateOptions) => {
    try {
      const root = path.resolve(opts.pack);
      const config = await readApprovalConfigStrict(approvalConfigPath(root));
      let setId = opts.set;
      if (setId === undefined) {
        if (config.sets.length !== 1) {
          console.error(t("cli.review.gate.needSet", { count: config.sets.length }));
          process.exit(1);
        }
        setId = config.sets[0]!.id;
      }
      const set = config.sets.find((candidate) => candidate.id === setId);
      if (set === undefined) {
        console.error(t("cli.review.gate.setNotFound", { setId }));
        process.exit(1);
      }

      const result = await evaluateGate({
        dataDir: opts.dataDir ?? config.data_dir,
        setId,
        deckDir: set.a.root,
        // 成品目录缺省取配置里该素材集的 b.root（--b-root 覆盖）：
        // 签发门禁必须核对成品文件的存在性与指纹，否则退化成只看状态的纯状态闸
        bRoot: opts.bRoot ?? set.b.root,
      });

      console.log(
        t("cli.review.gate.summary", {
          setId: result.setId,
          total: result.total,
          pass: result.counts.pass,
          reject: result.counts.reject,
          flag: result.counts.flag,
          unreviewed: result.counts.unreviewed,
          stale: result.counts.stale,
        }),
      );
      if (result.allowed) {
        console.log(t("cli.review.gate.allowed"));
        return;
      }
      console.log(t("cli.review.gate.blockersHeader", { count: result.blockers.length }));
      for (const blocker of result.blockers) {
        console.log(
          t("cli.review.gate.blocker", {
            item: blocker.itemId,
            reason: blockerReasonLabel(blocker.reason),
          }),
        );
      }
      console.log(t("cli.review.gate.blocked"));
      process.exitCode = 1;
    } catch (err) {
      process.exit(reportReviewError(err));
    }
  });

// ---------------------------------------------------------------------------
// 主命令
// ---------------------------------------------------------------------------

/** `tts review` 主命令：prepare / status / gate 三个子命令在上方定义后统一挂载 */
export const reviewCommand: Command = new Command("review").description(t("cli.command.review.description"));

reviewCommand.addCommand(prepareSub);
reviewCommand.addCommand(statusSub);
reviewCommand.addCommand(gateSub);
