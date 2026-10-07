// src/cli/commands/hub.ts
/**
 * `tts hub`：启动 hub 常驻进程（阶段 4，窗口 D）。
 *
 * 分工（本文件是薄调用层）：
 * - src/hub/lifecycle.ts 的 {@link runHubProcess} 负责组装 HubDaemon（编辑器
 *   端口 39998 + TCP/WS 扇出 39997/39996）与 S2 控制通道（HTTP+JSON，缺省
 *   39995，只绑 127.0.0.1），并接管 SIGINT/SIGTERM 与 /v1/hub/shutdown 的
 *   统一退出流程；
 * - 本命令只做：解析端口选项 → runHubProcess + start → 打印一行 started →
 *   常驻等待 `hub.stopped()`（SIGINT / SIGTERM / shutdown 任一路径触发停止
 *   完成后 resolve）→ 打印 stopped 并以 0 退出。
 *
 * 常驻实现：`await hub.stopped()`——即任务书中的
 * `await new Promise<void>((resolve) => { /* SIGINT/SIGTERM/shutdown 时 resolve *\/ })`，
 * resolve 源在 lifecycle 内部（信号与 shutdown 都在那一层统一接管，本命令
 * 不重复注册信号处理器）。
 *
 * 退出码：启动失败 1（端口占用输出 PortInUseError 的中文提示；其余走
 * error.generic）；正常停止 0。启动失败时 lifecycle 内部已回滚已启动资源，
 * 本层不再做清理。
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像；缺键时 t() 原样输出键名）：
 * - 静态：`cli.command.hub.description`、`cli.hub.option.port` /
 *   `cli.hub.option.editorPort` / `cli.hub.option.tcpPort` /
 *   `cli.hub.option.wsPort` / `cli.hub.option.logFile` /
 *   `cli.hub.option.appMode`、`cli.hub.stopped`；
 * - 插值：`cli.hub.started` {controlPort} {editorPort} {tcpPort} {wsPort}；
 * - 复用既有键：`cli.review.prepare.invalidPort` {value}（端口非法提示，文案
 *   通用：端口无效：{value}（需为 1..65535 的整数））、
 *   `cli.review.prepare.invalidOption` {value} {allowed}（选项值不在白名单的
 *   提示，--app-mode 校验用）、`error.generic` {message}（非端口占用的启动
 *   失败统一出口）。
 */

import { Command } from "commander";

import { runHubProcess } from "../../hub/lifecycle.js";
import { t } from "../../i18n/index.js";
import { EDITOR_PORT, HUB_TCP_PORT, HUB_WS_PORT } from "../../protocol/ports.js";
import { describeError, isPortInUseError, red } from "../with-server.js";

// ---------------------------------------------------------------------------
// 选项类型
// ---------------------------------------------------------------------------

/** `tts hub` 的选项（commander 已按 --kebab-case → camelCase 归一） */
interface HubCliOptions {
  /** 控制通道端口（字符串形式，action 内校验为 1..65535 的整数） */
  port?: string;
  /** 编辑器端口（缺省 39998） */
  editorPort?: string;
  /** TCP 扇出端口（缺省 39997） */
  tcpPort?: string;
  /** WS 扇出端口（缺省 39996） */
  wsPort?: string;
  /** 日志文件路径（追加写；缺省只写 stdout） */
  logFile?: string;
  /** 应用模式（字符串形式，action 内校验白名单 ["standalone", "app"]） */
  appMode?: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * `--app-mode` 的合法取值白名单（v0.8.0）：
 * - "standalone"：独立运行（CLI 手动启动，缺省）；
 * - "app"：由桌面 UI 作 sidecar 启动（控制通道错误体 details 会附 userAction
 *   提示键，供 UI 直接渲染，见 docs/schemas/hub-control.md §3.2）。
 */
const APP_MODE_WHITELIST: readonly string[] = ["standalone", "app"];

/**
 * 解析端口选项：字符串 → 1..65535 的整数；未提供选项时返回 undefined
 * 表示"用缺省端口"（控制通道 39995 / 编辑器 39998 / TCP 39997 / WS 39996）。
 *
 * @param value 命令行原始值；undefined 表示未提供该选项
 * @returns 端口号；未提供选项时 undefined
 * @returns 非法值时向 stderr 输出中文提示并 process.exit(1)（不返回）
 */
function parsePortOption(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(t("cli.review.prepare.invalidPort", { value }));
    process.exit(1);
  }
  return port;
}

/**
 * 解析 --app-mode 选项：须命中白名单 ["standalone", "app"]；未提供选项时返回
 * undefined 表示"用 lifecycle 的解析链"（参数 > 环境变量 TTS_HUB_APP_MODE >
 * 缺省 "standalone"，见 src/hub/lifecycle.ts）。
 *
 * @param value 命令行原始值；undefined 表示未提供该选项
 * @returns 合法的应用模式；未提供选项时 undefined
 * @returns 非法值时向 stderr 输出本地化提示并 process.exit(1)（不返回）
 */
function parseAppModeOption(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!APP_MODE_WHITELIST.includes(value)) {
    console.error(
      t("cli.review.prepare.invalidOption", {
        value,
        allowed: APP_MODE_WHITELIST.join(" / "),
      }),
    );
    process.exit(1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------

/**
 * `tts hub [--port <n>] [--editor-port <n>] [--tcp-port <n>] [--ws-port <n>]
 * [--log-file <路径>] [--app-mode <standalone|app>]`：前台常驻的 hub 进程
 * （控制通道 + 协议扇出）。
 *
 * 启动成功打印一行 started（含实际端口），随后常驻；SIGINT / SIGTERM /
 * /v1/hub/shutdown 触发优雅停止后打印 stopped 并以 0 退出。
 *
 * --app-mode（v0.8.0）：standalone=独立运行（缺省）；app=由桌面 UI 作 sidecar
 * 启动（控制通道错误体 details 附 userAction 提示键）。`tts-hub` bin 保持零
 * 旗标，同语义经环境变量 TTS_HUB_APP_MODE 透传。
 */
export const hubCommand: Command = new Command("hub")
  .description(t("cli.command.hub.description"))
  .option("--port <number>", t("cli.hub.option.port"))
  .option("--editor-port <number>", t("cli.hub.option.editorPort"))
  .option("--tcp-port <number>", t("cli.hub.option.tcpPort"))
  .option("--ws-port <number>", t("cli.hub.option.wsPort"))
  .option("--log-file <path>", t("cli.hub.option.logFile"))
  .option("--app-mode <mode>", t("cli.hub.option.appMode"))
  .action(async (opts: HubCliOptions) => {
    const controlPort = parsePortOption(opts.port);
    const editorPort = parsePortOption(opts.editorPort) ?? EDITOR_PORT;
    const tcpPort = parsePortOption(opts.tcpPort) ?? HUB_TCP_PORT;
    const wsPort = parsePortOption(opts.wsPort) ?? HUB_WS_PORT;
    const appMode = parseAppModeOption(opts.appMode);

    const hub = runHubProcess({
      ...(controlPort !== undefined ? { controlPort } : {}),
      editorPort,
      tcpPort,
      wsPort,
      ...(opts.logFile !== undefined ? { logFile: opts.logFile } : {}),
      ...(appMode !== undefined ? { appMode } : {}),
    });

    try {
      await hub.start();
    } catch (err) {
      // 端口占用：输出 PortInUseError 的中文提示（含 PID 与处置建议）；
      // 其余启动失败走 error.generic。lifecycle 内部已回滚已启动资源。
      if (isPortInUseError(err)) {
        console.error(red(err.message));
      } else {
        console.error(t("error.generic", { message: describeError(err) }));
      }
      process.exit(1);
    }

    console.log(
      t("cli.hub.started", {
        controlPort: hub.controlPort(),
        editorPort,
        tcpPort,
        wsPort,
      }),
    );

    // 常驻：SIGINT / SIGTERM / /v1/hub/shutdown 触发停止完成后 resolve
    await hub.stopped();

    console.log(t("cli.hub.stopped"));
    process.exit(0);
  });
