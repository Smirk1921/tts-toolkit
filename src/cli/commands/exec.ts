// src/cli/commands/exec.ts
/**
 * `tts exec '<lua>'`：在当前存档的全局脚本（guid "-1"）中执行一段 Lua。
 *
 * 返回值的取法：走 SessionExec.execJson（坑 1：协议只回传标量，
 * execJson 会把代码包成 `return JSON.encode(...)` 再 JSON.parse），
 * 因此对象 / 数组能完整回传，标量按原值打印。
 *
 * 错误分类（决定文案与退出码）：
 * - LuaError → cli.exec.luaError（+ 非全局对象的 guid）；
 * - 连不上 TTS → cli.exec.notConnected；
 * - 超时 → cli.exec.timeout（含秒数）；
 * - 其他 → error.generic。
 */

import { Command } from "commander";

import { t } from "../../i18n/index.js";
import { GLOBAL_GUID } from "../../protocol/messages.js";
import { LuaError } from "../../session/exec.js";
import { isNotConnectedError, isTimeoutError, reportError, withEditorServer } from "../with-server.js";

/** Lua 执行超时（毫秒）。与 SessionExec 默认值一致，显式传入以便文案里的秒数准确。 */
const EXEC_TIMEOUT_MS = 30_000;

/**
 * 格式化执行结果：对象 / 数组美化输出 JSON，标量直接打印。
 * @param result execJson 的解析结果
 * @returns 可直接打印的字符串
 */
function formatResult(result: unknown): string {
  if (result !== null && typeof result === "object") {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      // 循环引用等无法序列化的形态：退回 String()，不因打印失败而报错
      return String(result);
    }
  }
  return String(result);
}

export const execCommand = new Command("exec")
  .description(t("cli.command.exec.description"))
  .argument("<lua>", t("cli.command.exec.argument.lua"))
  .action(async (lua: string) => {
    try {
      await withEditorServer(async ({ exec }) => {
        const result = await exec.execJson(lua, { timeoutMs: EXEC_TIMEOUT_MS });
        console.log(formatResult(result));
      });
      return;
    } catch (err) {
      if (err instanceof LuaError) {
        console.error(t("cli.exec.luaError", { message: err.message }));
        if (err.guid !== GLOBAL_GUID) {
          console.error(t("cli.exec.luaErrorObject", { guid: err.guid }));
        }
        process.exit(1);
      }
      if (isNotConnectedError(err)) {
        console.error(t("cli.exec.notConnected"));
        process.exit(1);
      }
      if (isTimeoutError(err)) {
        console.error(t("cli.exec.timeout", { seconds: EXEC_TIMEOUT_MS / 1000 }));
        process.exit(1);
      }
      process.exit(reportError(err, "cli.exec.notConnected"));
    }
  });
