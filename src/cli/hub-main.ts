#!/usr/bin/env node
// src/cli/hub-main.ts
/**
 * `tts-hub` bin 入口（package.json bin 字段 → ./dist/cli/hub-main.js）：
 * 以独立进程（不经 commander / `tts` 主 CLI）启动 hub 常驻进程。
 *
 * 分工（本文件是薄启动层）：
 * - src/hub/lifecycle.ts 的 {@link runHubProcess} 负责组装 HubDaemon（编辑器
 *   端口 39998 + TCP/WS 扇出 39997/39996）与 S2 控制通道（HTTP+JSON，缺省
 *   39995，只绑 127.0.0.1），并接管 SIGINT/SIGTERM 与 /v1/hub/shutdown 的
 *   统一优雅退出——本入口不重复注册信号处理器；
 * - 本入口只做：初始化 i18n → runHubProcess + start → 常驻等待
 *   {@link HubProcess.stopped}（SIGINT / SIGTERM / shutdown 任一路径触发
 *   停止完成后 resolve）→ 幂等的 stop() 兜底 → 打印 stopped → exit 0。
 *
 * 端口：不解析命令行参数（保持 bin 入口最小），全部用缺省值（编辑器 / TCP /
 * WS 取 src/protocol/ports.js 常量，与 `tts hub` 命令传给 lifecycle 的缺省一致；
 * 控制通道取 lifecycle 缺省 39995）。需要自定义端口 / 日志文件时用
 * `tts hub --port ...`（src/cli/commands/hub.ts）。
 *
 * 输出口径：运行期日志由 lifecycle 以 JSON Lines（英文）写 stdout；本入口只在
 * 停止后补一行本地化的 stopped 提示、失败时向 stderr 写错误——用户可见字符串
 * 全部走 t()（复用既有键，无新增）。
 *
 * 退出码：启动失败 1（端口占用输出 PortInUseError 的中文提示；其余走
 * error.generic；启动失败时 lifecycle 内部已回滚已启动资源）；正常停止 0。
 *
 * 使用的 i18n 键（既有键复用）：`error.generic` {message}、`cli.hub.stopped`。
 */

import { runHubProcess } from "../hub/lifecycle.js";
import { initI18n, t } from "../i18n/index.js";
import { EDITOR_PORT, HUB_TCP_PORT, HUB_WS_PORT } from "../protocol/ports.js";
import { describeError, isPortInUseError, red } from "./with-server.js";

// bin 入口不经 commander 的 preAction，i18n 在这里显式初始化
//（缺省 lang 按全局配置 > 系统 locale > zh-CN 的优先级解析）。
initI18n({});

const hub = runHubProcess({
  editorPort: EDITOR_PORT,
  tcpPort: HUB_TCP_PORT,
  wsPort: HUB_WS_PORT,
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

// 常驻：SIGINT / SIGTERM / /v1/hub/shutdown 触发停止完成后 resolve
//（信号处理器在 lifecycle.start() 内部注册，本入口不重复注册）。
await hub.stopped();

// 兜底：stopped() 在停止流程末尾才 resolve，这里的 stop() 是幂等空转
//（stopPromise 已缓存，直接返回同一次停止流程）。
await hub.stop();

console.log(t("cli.hub.stopped"));
process.exit(0);
