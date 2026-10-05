// src/cli/commands/exec.ts
/**
 * `tts exec '<lua>'`：在当前存档的全局脚本（guid "-1"）中执行一段 Lua。
 *
 * 两条路径（阶段 4 窗口 D 起）：
 * 1. **hub 委托**（{@link tryHubClient} 探测到 hub 在线时）：首行打印 viaHub，
 *    经 hub 控制通道调 HubClient.exec(lua, {guid: "-1", timeoutMs})——与独立
 *    模式完全相同的全局脚本 / 超时语义；结果取响应体 `{result:...}` 包装里的
 *    result 字段（hub 侧执行同一 execJson 的返回值）按独立模式同样的格式打印。
 *    委托失败（HubError / HubNotRunningError）输出 error.hub.delegateFailed 并
 *    退出 1——**不回退独立模式**（hub 在线时 39998 被 hub 持有，回退独立模式
 *    必然绑不上端口）；
 * 2. **独立模式**（hub 不在线，返回 null 时；行为与阶段 4 之前完全一致）。
 *
 * 返回值的取法（独立模式）：走 SessionExec.execJson（坑 1：协议只回传标量，
 * execJson 会把代码包成 `return JSON.encode(...)` 再 JSON.parse），
 * 因此对象 / 数组能完整回传，标量按原值打印；hub 委托路径由 hub 侧执行同一
 * execJson，响应体 `{result:...}` 的 result 即其返回值。
 *
 * 错误分类（决定文案与退出码；LuaError / 未连接 / 超时只出现在独立模式）：
 * - LuaError → cli.exec.luaError（+ 非全局对象的 guid）；
 * - 连不上 TTS → cli.exec.notConnected；
 * - 超时 → cli.exec.timeout（含秒数）；
 * - 其他 → error.generic。
 * hub 委托路径的失败一律归入 error.hub.delegateFailed（hub 侧 Lua 运行时错误
 * 以 HUB_LUA_ERROR 透传，message 携带原始 Lua 错误文本）。
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像；缺键时 t() 原样输出键名）：
 * - 新增：`cli.exec.viaHub`（无参）、`error.hub.delegateFailed` {message}；
 * - 复用既有键：`cli.exec.luaError` {message}、`cli.exec.luaErrorObject` {guid}、
 *   `cli.exec.notConnected`（无参）、`cli.exec.timeout` {seconds}、
 *   `error.generic` {message}（经 reportError）。
 */

import { Command } from "commander";

import { t } from "../../i18n/index.js";
import { GLOBAL_GUID } from "../../protocol/messages.js";
import { LuaError } from "../../session/exec.js";
import { tryHubClient } from "../_shared.js";
import { describeError, isNotConnectedError, isTimeoutError, reportError, withEditorServer } from "../with-server.js";

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

/**
 * 从 hub /v1/exec 的响应体（`{result:...}` 包装，见 src/hub/control.ts 的
 * handleExec）中取出 Lua 返回值；HubClient.exec 的返回类型是 unknown，
 * 这里窄化为所需字段。
 * @param body 控制通道 JSON 响应体
 * @returns 响应体含 result 字段时取其值；否则 undefined（按"无返回值"打印）
 */
function unwrapExecBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  return Object.hasOwn(record, "result") ? record.result : undefined;
}

export const execCommand = new Command("exec")
  .description(t("cli.command.exec.description"))
  .argument("<lua>", t("cli.command.exec.argument.lua"))
  .action(async (lua: string) => {
    const hub = await tryHubClient();
    if (hub !== null) {
      // —— hub 委托路径：执行在 hub 进程内完成（它持有 39998 的独占绑定）——
      console.log(t("cli.exec.viaHub"));
      try {
        const body = await hub.exec(lua, { guid: GLOBAL_GUID, timeoutMs: EXEC_TIMEOUT_MS });
        console.log(formatResult(unwrapExecBody(body)));
      } catch (err) {
        // HubClient.exec 只抛 HubError / HubNotRunningError（见 src/mcp/client.ts），
        // 任何异常都按"委托失败"处理：报错并退出，不回退独立模式
        console.error(t("error.hub.delegateFailed", { message: describeError(err) }));
        process.exit(1);
      }
      return;
    }

    // —— 独立模式（hub 不在线）：以下与阶段 4 之前的行为完全一致 ——
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
