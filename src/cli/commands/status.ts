// src/cli/commands/status.ts
/**
 * `tts status`：检查 TTS 编辑器连接状态与当前存档概况。
 *
 * 流程：
 * 1. 先确认编辑器端口（39998）可被独占绑定——绑不上说明端口被别的程序（常见是
 *    VSCode 的 TTS 插件或另一个 tts-toolkit）占用，输出红色中文原因后退出 1；
 * 2. 启动编辑器服务器，依次执行 `_VERSION` 与 `#getObjects()` 两条 Lua；
 * 3. 连不上 TTS（39999 拒绝连接）时输出 notRunning 并退出 1。
 */

import { Command } from "commander";

import { t } from "../../i18n/index.js";
import { EDITOR_PORT, checkExclusive } from "../../protocol/ports.js";
import { luaGetObjectCount, luaGetVersion } from "../../session/lua.js";
import { describeError, isNotConnectedError, red, withEditorServer } from "../with-server.js";

export const statusCommand = new Command("status")
  .description(t("cli.command.status.description"))
  .action(async () => {
    const check = await checkExclusive(EDITOR_PORT);
    if (!check.ok) {
      console.error(red(t("error.portInUse", { port: EDITOR_PORT, detail: check.reason })));
      process.exit(1);
    }

    try {
      await withEditorServer(async ({ exec }) => {
        const version = await exec.execJson<string>(luaGetVersion());
        console.log(t("cli.status.connected", { port: EDITOR_PORT }));
        console.log(t("cli.status.version", { version }));
        const count = await exec.execJson<number>(luaGetObjectCount());
        console.log(t("cli.status.objects", { count }));
      });
    } catch (err) {
      if (isNotConnectedError(err)) {
        console.error(t("cli.status.notRunning"));
        process.exit(1);
      }
      console.error(t("error.generic", { message: describeError(err) }));
      process.exit(1);
    }
  });
