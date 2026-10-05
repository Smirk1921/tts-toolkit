#!/usr/bin/env node
// src/mcp/main.ts
/**
 * `tts-mcp` bin 入口（package.json bin 字段 → ./dist/mcp/main.js）：
 * 以独立 stdio 进程启动 tts-toolkit MCP 服务器（不经 commander / `tts` 主 CLI）。
 *
 * 分工（本文件是薄启动层）：
 * - src/mcp/server.ts 的 {@link main} 负责全部实际工作：解析 `--lang`、初始化
 *   i18n、安装进程级致命错误兜底（uncaughtException / unhandledRejection →
 *   stderr → exit 1）、创建 HubClient、注册 10 个工具、挂 StdioServerTransport；
 * - 本入口只做：`await main()`。connect 成功后 main 即 resolve，进程由传输层
 *   事件循环保持常驻直到客户端断开或致命错误触发 exit 1。
 *
 * 输出口径：MCP 会话期 stdout 是协议通道，本入口不向 stdout 写任何内容；
 * stderr 与 src/mcp/server.ts 的诊断同通道。
 *
 * 错误出口：main() 抛出（传输初始化失败等会话外异常）时向 stderr 写原始错误
 * 描述并 exit 1。不走 t() 包装：此处可能在 i18n 初始化完成之前失败（main 内部
 * 才初始化 i18n），且与 server.ts 的 stderr 英文诊断口径一致；工具运行期错误
 * 不经此路径（工具层自己捕获并转成 isError 结果）。
 */

import { main } from "./server.js";

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
