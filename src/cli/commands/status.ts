// src/cli/commands/status.ts
/**
 * `tts status`：检查 TTS 编辑器连接状态与当前存档概况。
 *
 * 两条路径（阶段 4 窗口 D 起）：
 * 1. **hub 委托**（{@link tryHubClient} 探测到 hub 在线时）：经 hub 控制通道调
 *    HubClient.status()——TTS 已连上 hub 时输出 connectedViaHub（hub 控制端口
 *    39995）+ version / objects（字段缺失时跳过对应行，不打印占位符）；
 *    hub 在线但 TTS 未连上时输出 hubOnlineTtsOffline 并退出 1（与独立模式的
 *    notRunning 同语义：stderr + 退出码 1）。委托失败（HubError /
 *    HubNotRunningError）输出 error.hub.delegateFailed 并退出 1——**不回退
 *    独立模式**（hub 在线时 39998 被 hub 持有，回退独立模式必然绑不上端口）；
 * 2. **独立模式**（hub 不在线，返回 null 时；行为与阶段 4 之前完全一致）：
 *    先确认编辑器端口（39998）可被独占绑定——绑不上说明端口被别的程序（常见是
 *    VSCode 的 TTS 插件或另一个 tts-toolkit）占用，输出红色中文原因后退出 1；
 *    再启动编辑器服务器，依次执行 `_VERSION` 与 `#getObjects()` 两条 Lua；
 *    连不上 TTS（39999 拒绝连接）时输出 notRunning 并退出 1。
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像；缺键时 t() 原样输出键名）：
 * - 新增：`cli.status.connectedViaHub` {port}（hub 控制端口）、
 *   `cli.status.hubOnlineTtsOffline`（无参）、`error.hub.delegateFailed` {message}；
 * - 复用既有键：`cli.status.version` {version}、`cli.status.objects` {count}、
 *   `error.portInUse` {port} {detail}、`cli.status.notRunning`（无参）、
 *   `error.generic` {message}。
 */

import { Command } from "commander";

import { t } from "../../i18n/index.js";
import { EDITOR_PORT, checkExclusive } from "../../protocol/ports.js";
import { luaGetObjectCount, luaGetVersion } from "../../session/lua.js";
import { tryHubClient } from "../_shared.js";
import { describeError, isNotConnectedError, red, withEditorServer } from "../with-server.js";

/** hub 控制通道缺省端口（S2 方案定值；与 src/hub/control.ts、src/mcp/client.ts 的内部缺省一致，两处均未导出）。 */
const HUB_CONTROL_PORT = 39995;

export const statusCommand = new Command("status")
  .description(t("cli.command.status.description"))
  .action(async () => {
    const hub = await tryHubClient();
    if (hub !== null) {
      // —— hub 委托路径：状态查询在 hub 进程内完成（它持有 39998 的独占绑定）——
      try {
        const status = await hub.status();
        if (status.tts.connected) {
          console.log(t("cli.status.connectedViaHub", { port: HUB_CONTROL_PORT }));
          if (status.tts.version !== undefined) {
            console.log(t("cli.status.version", { version: status.tts.version }));
          }
          if (status.tts.objects !== undefined) {
            console.log(t("cli.status.objects", { count: status.tts.objects }));
          }
        } else {
          // hub 在线但 TTS 没连上：与独立模式的 notRunning 同语义（stderr + 退出码 1）
          console.error(t("cli.status.hubOnlineTtsOffline"));
          process.exit(1);
        }
      } catch (err) {
        // HubClient.status() 只抛 HubError / HubNotRunningError（见 src/mcp/client.ts），
        // 任何异常都按"委托失败"处理：报错并退出，不回退独立模式
        console.error(t("error.hub.delegateFailed", { message: describeError(err) }));
        process.exit(1);
      }
      return;
    }

    // —— 独立模式（hub 不在线）：以下与阶段 4 之前的行为完全一致 ——
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
