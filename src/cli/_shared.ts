// src/cli/_shared.ts
/**
 * CLI 命令共享的 hub 委托入口（阶段 4，窗口 D）。
 *
 * 职责（唯一）：探测本机 hub 常驻进程（`tts hub`，控制通道 127.0.0.1:39995）
 * 是否在线；在线则返回一个可用的 {@link HubClient}，离线则返回 null——
 * 调用方（status / pull / exec 命令）据此选择"hub 委托"或"独立模式"。
 *
 * 契约：
 * - **不缓存**：每次调用都重新 {@link probeHub}（hub 随时可能被启动 / 关闭，
 *   也可能中途退出），绝不保留跨命令的客户端实例；
 * - **零异常**：probeHub 自身吞掉一切网络层失败（超时 / 连接拒绝 / 响应不合
 *   形状时返回 null，见 src/mcp/client.ts），本函数因此不会因"hub 不在线"而
 *   抛错；调用方拿到 null 即走独立模式；
 * - 本函数只探测与构造，不发起任何业务请求；后续 status / pullScripts / exec
 *   若抛 HubError / HubNotRunningError，由调用方按"委托失败"处理（报错并
 *   退出 1，**不回退独立模式**——hub 在线时编辑器端口 39998 由 hub 持有，
 *   回退独立模式必然绑不上端口）。
 *
 * 本模块不产出面向用户的文案，不引入 i18n。
 */

import { HubClient, probeHub } from "../mcp/client.js";

/**
 * 探测 hub 并返回可用的控制通道客户端（每次现探，不缓存）。
 *
 * @returns hub 在跑时返回新建的 {@link HubClient}（缺省连 127.0.0.1:39995）；
 *   hub 未在跑或探测失败时返回 null，调用方应走独立模式
 * @throws 不抛错（probeHub 零异常；HubClient 构造只做字符串拼接）
 */
export async function tryHubClient(): Promise<HubClient | null> {
  const probed = await probeHub();
  if (probed === null) {
    return null;
  }
  return new HubClient();
}
