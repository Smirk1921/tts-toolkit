// src/cli/commands/edit.ts
/**
 * `tts edit <对象名>`：在用户配置的编辑器里打开指定对象的 Lua 脚本（阶段 6 / 6A 轻量层）。
 *
 * 行为：
 * 1. 读取 pack.yaml 校验工作区
 * 2. 在工作区 `scripts/` 下定位脚本文件（locateScript；工作区没有 → 报错 + 候选名）
 * 3. 三层合并解析编辑器适配器（CLI --adapter > pack.yaml editor.adapter > 环境变量
 *    TTS_EDITOR_ADAPTER > 缺省 vscode）
 * 4. 调 adapter.isAvailable()；不可用时报错并提示改用其他 adapter
 * 5. 调 adapter.openFile({ absPath, line, column })，detached spawn 立即返回
 *
 * 设计说明：
 * - **纯本地命令**：不连 TTS、不连 hub、不拉脚本——脚本必须先由 `tts pull` /
 *   `tts pack pull` 落盘到工作区。这是 6A 轻量层的刻意简化（成本低、价值高），
 *   与 E 窗口的 watch 配合形成完整工作流：pull → edit → watch 自动同步
 * - 不提供 --save 选项（保存/推送的统一入口是 `tts pack push` 与 `tts watch`，
 *   避免在 edit 上重新发明一套安全链）
 * - system 预设静默忽略 line / column（`start`/`open`/`xdg-open` 不支持行列参数）
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像）：
 * - `cli.command.edit.description` / `.argument.name` / `.option.line` / `.option.column`
 *   / `.option.adapter` / `.option.command` / `.option.root`
 * - `cli.edit.opened` {name} {path}
 * - `cli.edit.adapterUnavailable` {adapter} {command}
 * - `error.editor.objectNotFound` {name} {candidates}（locate.ts 抛出）
 * - `error.editor.adapterUnknown` {adapter}（resolve.ts 抛出）
 * - `error.editor.commandRequired`（resolve.ts 抛出）
 * - `error.editor.templateInvalid` {template}（command.ts 抛出）
 * - `error.editor.spawnFailed` {command} {detail}（command.ts 抛出）
 */

import path from "node:path";

import { Command } from "commander";

import { locateScript } from "../../editor/locate.js";
import { resolveAdapter } from "../../editor/resolve.js";
import { t } from "../../i18n/index.js";
import { PackError, readPackYaml } from "../../pack/packyaml.js";
import { describeError, reportError } from "../with-server.js";

/** 命令行选项的运行时形状（commander 的 opts() 类型是 any，这里收窄）。 */
interface EditCommandOptions {
  line?: string;
  column?: string;
  adapter?: string;
  command?: string;
  root: string;
}

/**
 * 把命令行字符串选项解析为正整数（行 / 列号）。
 * @param raw 原始字符串（commander 已保证非空）
 * @param optionName 选项名（用于错误提示）
 * @returns 1-based 正整数
 * @throws PackError code="EDITOR_LINE_COLUMN_INVALID" 不是正整数时
 */
function parsePositiveInt(raw: string, optionName: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new PackError(
      "EDITOR_LINE_COLUMN_INVALID",
      t("error.editor.lineColumnInvalid", { option: optionName, value: raw }),
    );
  }
  return n;
}

export const editCommand = new Command("edit")
  .description(t("cli.command.edit.description"))
  .argument("<name>", t("cli.command.edit.argument.name"))
  .option("--line <n>", t("cli.command.edit.option.line"))
  .option("--column <n>", t("cli.command.edit.option.column"))
  .option("--adapter <id>", t("cli.command.edit.option.adapter"))
  .option("--command <tpl>", t("cli.command.edit.option.command"))
  .option("--root <dir>", t("cli.command.edit.option.root"), ".")
  .action(async (name: string, opts: EditCommandOptions) => {
    const root = path.resolve(opts.root);

    try {
      // 1. 校验工作区
      const packYaml = await readPackYaml(root);

      // 2. 定位脚本（PackError "EDITOR_OBJECT_NOT_FOUND" 由此抛出）
      const located = await locateScript(root, name);

      // 3. 解析行列
      const line = opts.line === undefined ? undefined : parsePositiveInt(opts.line, "--line");
      const column =
        opts.column === undefined ? undefined : parsePositiveInt(opts.column, "--column");

      // 4. 解析适配器（PackError "EDITOR_ADAPTER_UNKNOWN" / "EDITOR_COMMAND_REQUIRED" 由此抛出）
      const adapter = resolveAdapter(packYaml, {
        adapter: opts.adapter,
        command: opts.command,
      });

      // 5. 探测可用性
      const available = await adapter.isAvailable();
      if (!available) {
        console.error(
          t("cli.edit.adapterUnavailable", {
            adapter: adapter.id,
            command: opts.command ?? adapter.id,
          }),
        );
        process.exit(1);
      }

      // 6. 打开（PackError "EDITOR_SPAWN_FAILED" / "EDITOR_TEMPLATE_INVALID" 由此抛出）
      await adapter.openFile({
        absPath: located.absPath,
        line,
        column,
      });

      console.log(t("cli.edit.opened", { name: located.name, path: located.absPath }));
    } catch (err) {
      // PackError：按机器码查 i18n 报错（机器码在 message 里已带完整文案）
      if (err instanceof PackError) {
        console.error(err.message);
        process.exit(1);
      }
      // 其他错误（PACK_NOT_FOUND / 文件系统错误等）走统一出口
      process.exit(reportError(err, "cli.edit.notConnected"));
    }
  });

// 导出供单元测试使用（避免测试通过 commander 进程调用）
export { describeError };
