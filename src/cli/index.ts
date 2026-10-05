#!/usr/bin/env node
// src/cli/index.ts
/**
 * CLI 入口：commander 程序定义、全局选项处理与命令注册。
 *
 * 设计要点：
 * - 全局选项（--lang / --dev / --datadir）只在 preAction 钩子里初始化 i18n，
 *   所有命令的 action 运行时翻译已经就绪；
 * - commander 自带的英文文案（帮助标题、报错行）统一替换为中文：
 *   帮助标题走 configureHelp({ styleTitle })，解析期报错走
 *   exitOverride() + outputError 静默 + main() 里按错误码输出中文；
 * - 本文件是薄调用层：真正的实现都在 src/i18n/ src/protocol/ src/session/
 *   src/assets/ src/datadir/ 中（见 src/cli/commands/*.ts）。
 *
 * 已知限制：子命令描述 / 帮助标题在模块加载时求值（早于 --lang 生效），
 * 因此 `tts --help` 的文案跟随系统语言而非 --lang。
 */

import { Command, CommanderError } from "commander";

import { initI18n, t, type Lang } from "../i18n/index.js";
import { assetsCommand } from "./commands/assets.js";
import { configCommand } from "./commands/config.js";
import { deckCommand } from "./commands/deck.js";
import { execCommand } from "./commands/exec.js";
import { fetchCommand } from "./commands/fetch.js";
import { hostCommand } from "./commands/host.js";
import { hubCommand } from "./commands/hub.js";
import { importCommand } from "./commands/import.js";
import { migrateCommand } from "./commands/migrate.js";
import { packCommand } from "./commands/pack.js";
import { pullCommand } from "./commands/pull.js";
import { reviewCommand } from "./commands/review.js";
import { statusCommand } from "./commands/status.js";
import { vcsCommand } from "./commands/vcs.js";
import { watchCommand } from "./commands/watch.js";

/** 支持的输出语言（与 src/i18n/index.ts 保持一致）。 */
const SUPPORTED_LANGS: readonly Lang[] = ["zh-CN", "en-US"];

/** 全局选项（program 级）。 */
interface GlobalOptions {
  /** 输出语言；缺省按 i18n 模块的优先级解析 */
  lang?: string;
  /** 开发模式（缺翻译时 stderr 告警） */
  dev?: boolean;
  /** 显式指定的 TTS 数据目录（Mods 目录） */
  datadir?: string;
}

/**
 * 类型守卫：判定字符串是否为受支持的语言标签。
 * @param value 待判定的选项值
 * @returns 是 "zh-CN" / "en-US" 时返回 true
 */
function isLang(value: string): value is Lang {
  return value === "zh-CN" || value === "en-US";
}

/**
 * 把 commander 的英文帮助标题翻译成中文。
 * formatHelp 会把 'Usage:' / 'Arguments:' / 'Options:' / 'Commands:' /
 * 'Global Options:' 这类标题交给 styleTitle 处理，因此在这里统一替换，
 * 未收录的标题（自定义 helpGroup）原样返回。
 *
 * @param title commander 生成的英文标题
 * @returns 中文标题
 */
function translateHelpTitle(title: string): string {
  const titles: Readonly<Record<string, string>> = {
    "Usage:": t("cli.help.usage"),
    "Arguments:": t("cli.help.arguments"),
    "Options:": t("cli.help.options"),
    "Commands:": t("cli.help.commands"),
    "Global Options:": t("cli.help.globalOptions"),
  };
  return titles[title] ?? title;
}

const program = new Command();

program
  .name("tts")
  .description(t("cli.program.description"))
  .version("0.1.0", "-V, --version", t("cli.option.version"))
  .helpOption("-h, --help", t("cli.option.help"))
  .option("--lang <lang>", t("cli.option.lang"))
  .option("--dev", t("cli.option.dev"))
  .option("--datadir <path>", t("cli.option.datadir"))
  .configureOutput({
    // commander 的报错行是英文且带 "error:" 前缀，这里整体静默，
    // 改由 main() 按错误码输出中文（否则会出现中英混排）。
    outputError: () => {
      /* 由 main() 统一输出中文错误 */
    },
  })
  .exitOverride();

// 全局 option 处理：在所有命令 action 前 initI18n。
// 注意：必须放在 addCommand 之前——子命令通过 copyInheritedSettings 继承
// outputError / exitOverride 配置。
program.hook("preAction", (_thisCommand, actionCommand) => {
  const opts = actionCommand.optsWithGlobals<GlobalOptions>();
  const lang = opts.lang;
  if (lang !== undefined && !isLang(lang)) {
    // 语言非法时先用默认语言输出提示（initI18n 会拒绝非法 lang 并抛错）
    initI18n({ dev: opts.dev });
    console.error(t("cli.error.invalidLang", { lang }));
    process.exit(1);
  }
  initI18n({ lang, dev: opts.dev });
});

/**
 * 给一条命令挂上中文 help 子命令（替换 commander 内置的 "help [command]"，
 * 否则命令列表里会残留英文描述 "display help for command"）。
 *
 * 只对"确实有子命令"的命令调用：commander 的 _addImplicitHelpCommand 一旦置位，
 * 叶子命令也会凭空多出一个 help 子命令。
 *
 * @param cmd 目标命令
 */
function attachHelpCommand(cmd: Command): void {
  cmd
    .command("help [command]")
    .description(t("cli.command.help.description"))
    .action((name: string | undefined) => {
      if (name === undefined) {
        cmd.outputHelp();
        return;
      }
      const target = cmd.commands.find((child) => child.name() === name);
      if (target === undefined) {
        console.error(t("cli.error.unknownCommand", { command: name }));
        process.exit(1);
      }
      target.outputHelp();
    });
}

/**
 * 递归本地化 + 统一错误出口配置整棵命令树。
 *
 * 两条都不能省（`addCommand` 与 `.command()` 不同，**不会**调用
 * copyInheritedSettings，所以 standalone Command 对象既不继承
 * configureHelp / helpOption，也不继承 outputError / exitOverride）：
 * - configureHelp + helpOption：否则 `tts status --help` 会输出
 *   "Usage: / Options:" 等英文标题；
 * - configureOutput + exitOverride：否则子命令的解析期报错（如缺参数）
 *   会直接打印英文 "error: ..." 并 process.exit，绕过 main() 的中文出口。
 *
 * @param cmd 子树根命令
 */
function localizeCommandTree(cmd: Command): void {
  cmd.configureHelp({ styleTitle: translateHelpTitle });
  cmd.helpOption("-h, --help", t("cli.option.help"));
  cmd.configureOutput({
    // commander 的报错行是英文且带 "error:" 前缀，这里整体静默，
    // 改由 main() 按错误码输出中文（否则会出现中英混排）。
    outputError: () => {
      /* 由 main() 统一输出中文错误 */
    },
  });
  cmd.exitOverride();
  const children = [...cmd.commands];
  if (children.length > 0 && !children.some((child) => child.name() === "help")) {
    attachHelpCommand(cmd);
  }
  for (const child of children) {
    localizeCommandTree(child);
  }
}

program.addCommand(statusCommand);
program.addCommand(configCommand);
program.addCommand(pullCommand);
program.addCommand(execCommand);
program.addCommand(assetsCommand);
program.addCommand(packCommand);
program.addCommand(deckCommand);
program.addCommand(vcsCommand);
program.addCommand(importCommand);
program.addCommand(hostCommand);
program.addCommand(fetchCommand);
program.addCommand(migrateCommand);
program.addCommand(reviewCommand);
program.addCommand(hubCommand);
// 阶段 5 新增：watch 长驻命令（阶段 5 收尾补注册；实现见 commands/watch.ts）
program.addCommand(watchCommand);
localizeCommandTree(program);

/**
 * 输出 commander 解析期错误的中文提示。
 * @param err commander 抛出的错误（已由 exitOverride 转为异常）
 */
function reportCommanderError(err: CommanderError): void {
  // commander 的消息形如 "unknown option '--foo'"，单引号里是出错的对象
  const token = /'([^']*)'/.exec(err.message)?.[1] ?? err.message;
  switch (err.code) {
    case "commander.unknownCommand":
      console.error(t("cli.error.unknownCommand", { command: token }));
      return;
    case "commander.unknownOption":
      console.error(t("cli.error.unknownOption", { option: token }));
      return;
    case "commander.missingArgument":
    case "commander.optionMissingArgument":
    case "commander.missingMandatoryOptionValue":
      console.error(t("cli.error.missingArgument", { argument: token }));
      return;
    default:
      console.error(t("error.generic", { message: err.message }));
  }
}

/**
 * 主流程：解析命令行并统一处理抛出的异常。
 * - 帮助 / 版本属于正常结束（exitCode 0）；
 * - 解析期错误（未知命令、缺参数等）转成中文提示后以非 0 退出；
 * - 其余异常按通用错误输出。
 */
async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.help" || err.code === "commander.version") {
        process.exit(err.exitCode);
      }
      reportCommanderError(err);
      process.exit(err.exitCode === 0 ? 1 : err.exitCode);
    }
    console.error(t("error.generic", { message: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  }
}

await main();
