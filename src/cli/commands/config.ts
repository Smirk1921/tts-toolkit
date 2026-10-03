// src/cli/commands/config.ts
/**
 * `tts config datadir [--set <path>]`：探测 / 选择 / 写入 TTS 数据目录（Mods 目录）。
 *
 * 流程（与设计一致）：
 * - `--set <path>`：直接写配置，跳过探测（用户已明确指定）；
 * - 否则调 locateDatadir 列出全部候选（含来源与有效子目录数）；
 * - 多个有效候选（requiresChoice）→ 交互式让用户选编号；
 * - 恰好一个有效（recommended）→ 打印推荐路径并询问 y/N；
 * - 一个有效候选都没有 → 提示并退出 1。
 *
 * 数据目录探测逻辑全部在 src/datadir/locate.ts（坑 6：绝不写死路径），本文件只做交互。
 */

import path from "node:path";
import { createInterface } from "node:readline";

import { Command } from "commander";

import { locateDatadir, writeConfig, type DatadirCandidate } from "../../datadir/locate.js";
import { t } from "../../i18n/index.js";
import { describeError } from "../with-server.js";

/** DatadirCandidate.source → 翻译键后缀（源枚举值带连字符，不能直接拼键） */
const SOURCE_KEY_SUFFIX: Readonly<Record<DatadirCandidate["source"], string>> = {
  explicit: "explicit",
  config: "config",
  registry: "registry",
  "install-dir": "installDir",
  documents: "documents",
  macos: "macos",
  linux: "linux",
};

/**
 * 把候选来源翻译成中文标签。
 * @param source 候选来源枚举值
 * @returns 该来源的显示名
 */
function sourceLabel(source: DatadirCandidate["source"]): string {
  return t(`cli.config.datadir.source.${SOURCE_KEY_SUFFIX[source]}`);
}

/** 命令内复用的交互提示器（整个命令共用一条 readline 接口）。 */
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
 * pending question 时会丢掉已到达的行。管道输入（`printf 'abc\n3\n' | tts config datadir`）
 * 一次性送达两行时，第二行会被丢弃，表现为"输入无效后立刻取消"。
 * 因此这里自己维护"待消费行队列 + 等待者队列"：line 事件先喂等待者，没人等就入队，
 * 下个提问直接取队列，EOF 时统一按空串（取消）唤醒。
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
 * 不要求 isTTY：管道 / 重定向（如 `printf '1\n' | tts config datadir`）也应能选编号；
 * child_process 以 stdio: "ignore" 启动时 stdin 会被销毁，此时才判定为不可交互。
 * 提示不会挂死——readline 触发 close（EOF）时 {@link Prompter.ask} 按"取消"返回空串。
 *
 * @returns stdin 可读返回 true
 */
function canPrompt(): boolean {
  return process.stdin.readable === true && process.stdin.destroyed !== true;
}

/**
 * 打印全部候选。
 * @param candidates 探测到的候选列表（已按优先级排序）
 */
function printCandidates(candidates: readonly DatadirCandidate[]): void {
  console.log(t("cli.config.datadir.found", { count: candidates.length }));
  candidates.forEach((candidate, index) => {
    console.log(
      t("cli.config.datadir.candidate", {
        index: index + 1,
        path: candidate.path,
        source: sourceLabel(candidate.source),
        subdirs: candidate.validSubdirs,
      }),
    );
  });
}

/**
 * 交互式选择候选编号。
 * @param prompter 命令内复用的提示器
 * @param candidates 候选列表（编号即数组下标 + 1）
 * @returns 所选候选的路径；用户取消（回车 / EOF）时返回 undefined
 */
async function chooseCandidate(
  prompter: Prompter,
  candidates: readonly DatadirCandidate[],
): Promise<string | undefined> {
  console.log(t("cli.config.datadir.multiple"));
  for (;;) {
    const answer = await prompter.ask(t("cli.config.datadir.prompt", { max: candidates.length }));
    if (answer === "") {
      return undefined;
    }
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= candidates.length) {
      const chosen = candidates[index - 1];
      if (chosen !== undefined) {
        return chosen.path;
      }
    }
    console.log(t("cli.config.datadir.invalidChoice", { max: candidates.length }));
  }
}

/**
 * datadir 子命令的主逻辑。
 * @param opts 子命令选项（set：直接写入的路径）
 * @param command 当前命令实例（用于读取 program 级 --datadir）
 * @returns 进程退出码（0 = 已写入配置；1 = 取消 / 无候选 / 无法交互）
 */
async function runDatadir(opts: { set?: string }, command: Command): Promise<number> {
  if (opts.set !== undefined) {
    if (opts.set.trim() === "") {
      console.error(t("cli.error.emptyOptionValue", { option: "--set" }));
      return 1;
    }
    const target = path.resolve(opts.set);
    await writeConfig({ datadir: target });
    console.log(t("cli.config.datadir.writtenPath", { path: target }));
    return 0;
  }

  const globals = command.optsWithGlobals<{ datadir?: string }>();
  if (globals.datadir !== undefined && globals.datadir.trim() === "") {
    console.error(t("cli.error.emptyOptionValue", { option: "--datadir" }));
    return 1;
  }
  const result = await locateDatadir(
    globals.datadir === undefined ? {} : { explicitPath: globals.datadir },
  );
  printCandidates(result.candidates);

  const recommended = result.recommended;
  if (!result.requiresChoice && recommended === undefined) {
    console.error(t("cli.config.datadir.none"));
    return 1;
  }
  if (!canPrompt()) {
    console.error(t("cli.config.datadir.nonInteractive"));
    return 1;
  }

  const prompter = createPrompter();
  try {
    if (result.requiresChoice) {
      const chosen = await chooseCandidate(prompter, result.candidates);
      if (chosen === undefined) {
        console.log(t("cli.config.datadir.cancelled"));
        return 1;
      }
      await writeConfig({ datadir: chosen });
      console.log(t("cli.config.datadir.selected", { path: chosen }));
      return 0;
    }
    if (recommended === undefined) {
      console.error(t("cli.config.datadir.none"));
      return 1;
    }
    console.log(t("cli.config.datadir.recommend", { path: recommended }));
    const answer = (await prompter.ask(`${t("cli.config.datadir.confirm")} `)).toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.log(t("cli.config.datadir.cancelled"));
      return 1;
    }
    await writeConfig({ datadir: recommended });
    console.log(t("cli.config.datadir.selected", { path: recommended }));
    return 0;
  } finally {
    prompter.close();
  }
}

const datadirCommand = new Command("datadir")
  .description(t("cli.command.config.datadir.description"))
  .option("--set <path>", t("cli.command.config.datadir.option.set"))
  .action(async (opts: { set?: string }, command: Command) => {
    try {
      process.exit(await runDatadir(opts, command));
    } catch (err) {
      console.error(t("error.generic", { message: describeError(err) }));
      process.exit(1);
    }
  });

export const configCommand = new Command("config")
  .description(t("cli.command.config.description"))
  .addCommand(datadirCommand);
