// src/cli/commands/pack.ts
/**
 * `tts pack`：图包工作区管理（阶段 2A）——把 6 个 pack 模块接到 CLI 上。
 *
 * 子命令一览（本文件是薄调用层，业务逻辑一律在 src/pack/ 内）：
 * - `tts pack init <dir>`    新建工作区（initPack）
 * - `tts pack unpack <save>` 从存档 JSON / .ttsmod 离线建工作区（unpackSave）
 * - `tts pack pull`          从运行中的 TTS 拉脚本 / UI（pullFromGame，只读）
 * - `tts pack push`          列出将推回游戏的清单（collectPushItems，骨架实现）
 * - `tts pack diff`          工作区 ↔ 游戏差异（diffWorkspace，只读）
 * - `tts pack build`         合成 TTS 可加载的存档 JSON（buildSave，含 --dry-run）
 *
 * 边界（重要，不要越界）：
 * - 本文件**不直接 import src/session/ 或 src/protocol/**：需要 TTS 会话的子命令由
 *   pack 模块内部经 src/cli/with-server.ts 完成（端口占用 / 未连接 / 超时等异常
 *   由各模块原样上抛，此处统一按错误码出口呈现）；
 * - 约束 7：push（messageID 1）只接收脚本 / UI，不接收素材字段。本文件不为 push
 *   提供任何素材相关选项，也不读 / 改素材 URL；素材改动只能走 `pack build` 的
 *   离线回路（约束 8）；
 * - 错误处理：PackError 按 `` `error.${code}` `` 取文案（占位符 {msg}），其余异常
 *   统一走 `error.unknown`，两者都以退出码 1 结束。与 src/cli/with-server.ts 的
 *   reportError 分工不同：pack 模块抛的是带机器可读 code 的 PackError，
 *   不需要按 message 文本猜分类。
 *
 * 输出约定：每个子命令只在成功时向 stdout 打一行中文摘要（经 t()）；push / diff 的
 * 清单行是纯数据（guid / 名字 / 路径），不承载文案，故不翻译。
 *
 * 本模块使用的 i18n 键（locales/*.json 由本地化步骤补齐；缺键时 t() 原样输出键名）：
 * - 静态：`cli.command.pack.*`（已存在）、`cli.pack.init.done` {dir}、
 *   `cli.pack.unpack.done` {save} {outDir} {scripts} {ui} {objects}、
 *   `cli.pack.pull.done` {scripts} {ui} {skipped}、`cli.pack.push.note`、
 *   `cli.pack.diff.summary` {added} {modified} {deleted}、`cli.pack.build.done`
 *   {outPath} {scripts} {ui} {objects}、`cli.pack.build.dryRunNote`、
 *   `error.unknown` {msg}；
 * - 动态（键 = `error.` + PackError.code，占位符 {msg}）：PACK_NOT_FOUND /
 *   PACK_INVALID / PACK_READ_FAILED / PACK_EXISTS / GIT_INIT_FAILED /
 *   GIT_LFS_INSTALL_FAILED / TTSMOD_INVALID / SAVE_INVALID / UNPACK_FAILED /
 *   PULL_FAILED / PUSH_FAILED / DIFF_FAILED / SKELETON_MISSING / SKELETON_INVALID /
 *   PACK_WRITE_FAILED / BUILD_FAILED 等（各模块错误码的完整取值见其模块头注释）。
 */

import { Command } from "commander";

import { t } from "../../i18n/index.js";
import { buildSave } from "../../pack/build.js";
import { diffWorkspace } from "../../pack/diff.js";
import { initPack } from "../../pack/init.js";
import { PackError } from "../../pack/packyaml.js";
import { pullFromGame } from "../../pack/pull.js";
import { collectPushItems, type PushItem } from "../../pack/push.js";
import { unpackSave } from "../../pack/unpack.js";

// ---------------------------------------------------------------------------
// 选项类型
// ---------------------------------------------------------------------------

/** `tts pack init` 的选项（commander 已按 --kebab-case → camelCase 归一） */
interface PackInitOptions {
  /** 图包名（缺省取目录名，由 initPack 决定） */
  name?: string;
  /** 显式 lfs 决策；只接受 "enabled" / "disabled" */
  lfs?: string;
  /** 跳过 git init */
  skipGit?: boolean;
}

/** `tts pack unpack` 的选项 */
interface PackUnpackOptions {
  /** 输出目录；缺省 `./packs/<name || "unnamed">` */
  out?: string;
  /** 图包名（缺省取存档 SaveName） */
  name?: string;
}

/** 只带 --root 的子命令（pull / push / diff）的选项 */
interface PackRootOptions {
  /** 工作区根目录（默认 "."，由 commander 的默认值填入） */
  root: string;
}

/** `tts pack build` 的选项 */
interface PackBuildOptions extends PackRootOptions {
  /** 只统计与生成摘要，不写文件 */
  dryRun?: boolean;
  /** 输出 JSON 路径（缺省 `<root>/dist/<净化(pack.yaml name)>.json`） */
  out?: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** diff 清单的分组顺序（与 src/pack/diff.ts 的 status 取值一一对应） */
const DIFF_STATUSES = ["added", "modified", "deleted"] as const;

/**
 * pack 子命令的统一错误出口。
 *
 * PackError 是按错误码分支的（如 "PACK_NOT_FOUND" / "DIFF_FAILED"），
 * 对应 `error.<code>` 文案；其余异常（含 pack 模块的入参校验、fs 错误、
 * 协议 / 会话层的未包装异常）统一走 `error.unknown`。两者都只写 stderr，
 * 绝不向 stdout 混入错误信息。
 *
 * @param err 命令 action 中捕获的异常
 * @returns 建议的进程退出码（恒为 1，与 CLI 其他命令一致）
 */
function reportPackError(err: unknown): number {
  if (err instanceof PackError) {
    console.error(t(`error.${err.code}`, { msg: err.message }));
    return 1;
  }
  console.error(t("error.unknown", { msg: err instanceof Error ? err.message : String(err) }));
  return 1;
}

/**
 * 校验并收窄 `--lfs` 的取值。
 *
 * 不合法时立即抛中文用法错误（与 pack 模块的入参校验风格一致），
 * 而不是把它塞给 initPack 让 zod 报错——zod 的文案面向调用方，
 * 命令行用户需要看到"--lfs 只接受…"。
 *
 * @param value 命令行传入的原始值；未指定时 undefined
 * @returns 合法取值；未指定时 undefined（交给 initPack 走探测 / 交互三选一）
 * @throws Error 值不是 "enabled" / "disabled" 时
 */
function parseLfs(value: string | undefined): "enabled" | "disabled" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "enabled" || value === "disabled") {
    return value;
  }
  throw new Error(`--lfs 只接受 enabled 或 disabled（收到 ${value}）`);
}

/**
 * 取 unpack 的缺省输出目录：`./packs/<name || "unnamed">`。
 * @param name `--name` 的值（未指定或空串时用 "unnamed" 占位）
 * @returns 缺省输出目录（相对当前工作目录，由 unpackSave 负责 resolve）
 */
function defaultUnpackOutDir(name: string | undefined): string {
  return `./packs/${name !== undefined && name !== "" ? name : "unnamed"}`;
}

/**
 * 把一条待推送清单渲染成一行纯数据文本。
 * 格式：`  <guid>  <name>  <脚本路径>  <UI 路径>`（缺哪边就少哪段）。
 * @param item collectPushItems 产出的清单条目
 * @returns 单行文本（不含换行）
 */
function formatPushItem(item: PushItem): string {
  const files = [item.scriptPath, item.uiPath].filter((file): file is string => file !== undefined);
  return `  ${item.guid}  ${item.name}  ${files.join("  ")}`;
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------

/**
 * `tts pack init <dir>`：新建图包工作区（目录骨架 + pack.yaml + git + lfs 三选一）。
 *
 * lfs 三选一被用户取消时 initPack 正常返回但 packYamlWritten=false（它已自行
 * 打印取消原因）——此时不再打"已创建"，改以退出码 1 标记本次未完成，便于脚本判断。
 */
const initSub = new Command("init")
  .description(t("cli.command.pack.init.description"))
  .argument("<dir>", t("cli.command.pack.init.argument.dir"))
  .option("--name <n>", t("cli.command.pack.init.option.name"))
  .option("--lfs <choice>", t("cli.command.pack.init.option.lfs"))
  .option("--skip-git", t("cli.command.pack.init.option.skipGit"))
  .action(async (dir: string, opts: PackInitOptions) => {
    try {
      const lfs = parseLfs(opts.lfs);
      const result = await initPack({ dir, name: opts.name, lfs, skipGit: opts.skipGit });
      if (!result.packYamlWritten) {
        // 取消路径：init.ts 已输出取消说明；这里只标记"未完成"，不重复打扰用户
        process.exitCode = 1;
        return;
      }
      console.log(t("cli.pack.init.done", { dir: result.packRoot }));
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

/**
 * `tts pack unpack <save>`：从存档 JSON 或 .ttsmod 离线建工作区（不需要游戏运行）。
 *
 * 输出目录缺省 `./packs/<name || "unnamed">`；未给 --name 时工作区名由 unpackSave
 * 回退到存档的 SaveName。摘要里的 outDir 用返回值 packRoot（resolve 后的绝对路径）。
 */
const unpackSub = new Command("unpack")
  .description(t("cli.command.pack.unpack.description"))
  .argument("<save>", t("cli.command.pack.unpack.argument.save"))
  .option("--out <dir>", t("cli.command.pack.unpack.option.out"))
  .option("--name <n>", t("cli.command.pack.unpack.option.name"))
  .action(async (save: string, opts: PackUnpackOptions) => {
    try {
      const outDir = opts.out !== undefined && opts.out !== "" ? opts.out : defaultUnpackOutDir(opts.name);
      const result = await unpackSave({ savePath: save, outDir, name: opts.name });
      console.log(
        t("cli.pack.unpack.done", {
          save,
          outDir: result.packRoot,
          scripts: result.scriptsWritten,
          ui: result.uiWritten,
          objects: result.objectsWritten,
        }),
      );
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

/**
 * `tts pack pull`：把运行中 TTS 的脚本 / UI 拉到工作区（在线回路，只读 TTS）。
 *
 * skipped 计数是"内容与本地一致、未覆写"的文件数，不是错误：工作区刚同步过时
 * 该值等于全部文件数，下次游戏内改动后重跑即可看到写入数。
 */
const pullSub = new Command("pull")
  .description(t("cli.command.pack.pull.description"))
  .option("--root <dir>", t("cli.command.pack.pull.option.root"), ".")
  .action(async (opts: PackRootOptions) => {
    try {
      const result = await pullFromGame({ root: opts.root });
      console.log(
        t("cli.pack.pull.done", {
          scripts: result.scriptsWritten,
          ui: result.uiWritten,
          skipped: result.skippedNoChange,
        }),
      );
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

/**
 * `tts pack push`：列出"将推回游戏"的脚本 / UI 清单（骨架实现，阶段 5 才实际推送）。
 *
 * 本命令只读工作区、不连 TTS、不调 saveAndPlay（约束 7）；清单行是纯数据，
 * 末行说明文字用 collectPushItems 返回的 note（= `cli.pack.push.note`，含对象数）。
 */
const pushSub = new Command("push")
  .description(t("cli.command.pack.push.description"))
  .option("--root <dir>", t("cli.command.pack.push.option.root"), ".")
  .action(async (opts: PackRootOptions) => {
    try {
      const result = await collectPushItems({ root: opts.root });
      for (const item of result.items) {
        console.log(formatPushItem(item));
      }
      console.log(result.note);
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

/**
 * `tts pack diff`：对比工作区与运行中 TTS 当前存档的脚本 / UI。
 *
 * 条目按 status 分组输出（added → modified → deleted），组内顺序沿用
 * diffWorkspace 的排序（GUID 升序，同一 GUID 内 script 在 ui 之前）；
 * 条目行是纯数据，行尾的中文摘要（`cli.pack.diff.summary`）给出三个计数。
 */
const diffSub = new Command("diff")
  .description(t("cli.command.pack.diff.description"))
  .option("--root <dir>", t("cli.command.pack.diff.option.root"), ".")
  .action(async (opts: PackRootOptions) => {
    try {
      const result = await diffWorkspace({ root: opts.root });
      for (const status of DIFF_STATUSES) {
        const group = result.entries.filter((entry) => entry.status === status);
        if (group.length === 0) {
          continue;
        }
        console.log(`${status}:`);
        for (const entry of group) {
          const local = entry.localPath === undefined ? "" : `  ${entry.localPath}`;
          console.log(`  ${entry.guid}  ${entry.name}  ${entry.kind}${local}`);
        }
      }
      console.log(
        t("cli.pack.diff.summary", {
          added: result.added,
          modified: result.modified,
          deleted: result.deleted,
        }),
      );
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

/**
 * `tts pack build`：读骨架 + 工作区合成 TTS 可加载的存档 JSON（离线回路，约束 8）。
 *
 * --dry-run 只统计不写文件：先打 done 摘要（含"将会写入"的路径），再补一行
 * dryRunNote 明示没有落盘。buildSave 返回的 warnings 是已翻译的中文提示
 * （如"工作区有但骨架没有的 GUID"），逐条缩进打印，不改变退出码。
 */
const buildSub = new Command("build")
  .description(t("cli.command.pack.build.description"))
  .option("--root <dir>", t("cli.command.pack.build.option.root"), ".")
  .option("--dry-run", t("cli.command.pack.build.option.dryRun"))
  .option("--out <path>", t("cli.command.pack.build.option.out"))
  .action(async (opts: PackBuildOptions) => {
    try {
      const result = await buildSave({ root: opts.root, dryRun: opts.dryRun, outPath: opts.out });
      console.log(
        t("cli.pack.build.done", {
          outPath: result.outPath,
          scripts: result.scriptsReplaced,
          ui: result.uiReplaced,
          objects: result.objectsReplaced,
        }),
      );
      if (result.dryRun) {
        console.log(t("cli.pack.build.dryRunNote"));
      }
      for (const warning of result.warnings) {
        console.log(`  ${warning}`);
      }
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

// ---------------------------------------------------------------------------
// 主命令
// ---------------------------------------------------------------------------

/** `tts pack` 主命令：6 个子命令在上方定义后统一挂载（薄分发层，无自身 action） */
export const packCommand: Command = new Command("pack").description(t("cli.command.pack.description"));

packCommand.addCommand(initSub);
packCommand.addCommand(unpackSub);
packCommand.addCommand(pullSub);
packCommand.addCommand(pushSub);
packCommand.addCommand(diffSub);
packCommand.addCommand(buildSub);
