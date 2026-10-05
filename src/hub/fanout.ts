// src/hub/fanout.ts
/**
 * hub 扇出层：TTS 入站消息的三路下游分发。
 *
 * 三个通道（全部 fire-and-forget，单个下游的失败绝不阻塞其他通道与上游）：
 * - TCP（默认 39997）：消息序列化为 JSON 字符串原样写入每条 socket
 *   （不带换行分隔符，见 S2 方案 §14.5.1）；write 失败 / 断开自动摘除；
 * - WS（默认 39996）：JSON 字符串经最小连接接口（{@link FanoutWsClient}）send；
 *   send 抛错 / close / error 自动摘除；
 * - 进程内：依次调用订阅者回调；单个 handler 抛错仅记录、不击穿。
 *
 * 数据流：EditorServer（编辑器入站端口）收到 TTS 推送 → HubDaemon 调
 * {@link FanoutHub.fanout} → 三路同时扇出（同步返回，不等待任何下游）。
 *
 * 摘除约定：下游断开即从集合移除（socket close/error 事件或连接的 close/error 回调），
 * 不做轮询探活、不设心跳定时器；Set 语义保证重复摘除无副作用。
 */
import type { Socket } from "node:net";

import type { InboundMessage } from "../protocol/messages.js";

/**
 * WS 下行连接的最小接口：扇出层只需要"发文本 + 注册摘除回调（+ 可选关闭）"。
 * daemon 自实现的 RFC6455 连接与外部 ws.WebSocket 均可结构化适配。
 */
export interface FanoutWsClient {
  /**
   * 发送一帧文本数据（JSON 字符串）。
   *
   * @param data 要发送的文本内容
   * @throws {Error} 连接已不可用（扇出层捕获后摘除该连接）
   */
  send(data: string): void;

  /**
   * 注册连接关闭 / 出错回调（扇出层借其自动摘除连接）。
   *
   * @param event 事件名："close" 或 "error"
   * @param cb 摘除回调（不得抛出）
   */
  on(event: "close" | "error", cb: () => void): void;

  /**
   * 可选的主动断开。存在时由 {@link FanoutHub.closeAll} 调用；
   * 未实现该方法的连接只从扇出集合移除，生命周期由其属主自行管理。
   */
  close?(): void;
}

/**
 * hub 三路扇出接口：把 TTS 入站消息同时分发到 TCP / WS / 进程内三个通道。
 * 实例经 {@link createFanout} 创建；三个通道彼此独立，单路故障不影响其余两路。
 */
export interface FanoutHub {
  /**
   * 注册一条 TCP 下行 socket（来自 39997 的客户端连接）。
   *
   * @param socket 已连接的客户端 socket；close / error 事件触发自动摘除
   */
  addTcpClient(socket: Socket): void;

  /**
   * 注册一条 WS 下行连接（来自 39996 的 ws.WebSocket 或自实现适配连接）。
   *
   * @param ws 最小 WS 连接（见 {@link FanoutWsClient}）；close / error 自动摘除
   */
  addWsClient(ws: FanoutWsClient): void;

  /**
   * 进程内订阅：每条入站消息都会回调 handler。
   *
   * @param handler 消息回调（抛错时被捕获并 console.error，不影响其他订阅者）
   * @returns 退订函数（幂等）
   */
  subscribe(handler: (msg: InboundMessage) => void): () => void;

  /**
   * 收到 TTS 入站消息时由 daemon 调用：向三路同时扇出。
   * 同步返回，不等任何下游（fire-and-forget）。
   *
   * @param msg 已由协议层校验的入站消息
   */
  fanout(msg: InboundMessage): void;

  /**
   * 当前各通道连接数（用于 /v1/status 报告）。
   *
   * @returns tcp / ws / inproc 三路的当前计数
   */
  stats(): { tcp: number; ws: number; inproc: number };

  /** 关闭所有客户端连接并清空订阅（hub 退出时调用）。幂等。 */
  closeAll(): void;
}

/**
 * 创建扇出实例。
 *
 * @returns {@link FanoutHub} 实现；内部以 Set 维护三个通道的下游，
 *          断开自动摘除，无需外部干预
 */
export function createFanout(): FanoutHub {
  /** TCP 下行 socket 集合。 */
  const tcpClients = new Set<Socket>();
  /** WS 下行连接集合。 */
  const wsClients = new Set<FanoutWsClient>();
  /** 进程内订阅者集合。 */
  const inprocHandlers = new Set<(msg: InboundMessage) => void>();

  const addTcpClient = (socket: Socket): void => {
    tcpClients.add(socket);
    // 必须监听 'error'：否则下游异常断开（EPIPE 等）会以 uncaught exception 击穿进程
    socket.on("close", () => {
      tcpClients.delete(socket);
    });
    socket.on("error", () => {
      tcpClients.delete(socket);
    });
  };

  const addWsClient = (ws: FanoutWsClient): void => {
    wsClients.add(ws);
    ws.on("close", () => {
      wsClients.delete(ws);
    });
    ws.on("error", () => {
      wsClients.delete(ws);
    });
  };

  const subscribe = (handler: (msg: InboundMessage) => void): (() => void) => {
    inprocHandlers.add(handler);
    return () => {
      inprocHandlers.delete(handler);
    };
  };

  const fanout = (msg: InboundMessage): void => {
    const json = JSON.stringify(msg);
    for (const socket of [...tcpClients]) {
      if (socket.destroyed) {
        tcpClients.delete(socket);
        continue;
      }
      try {
        // fire-and-forget：write 立即返回，故意忽略背压信号，不等 drain
        void socket.write(json);
      } catch {
        tcpClients.delete(socket);
      }
    }
    for (const client of [...wsClients]) {
      try {
        client.send(json);
      } catch {
        wsClients.delete(client);
      }
    }
    for (const handler of [...inprocHandlers]) {
      try {
        handler(msg);
      } catch (err) {
        console.error(
          `[hub:fanout] inproc handler failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  const stats = (): { tcp: number; ws: number; inproc: number } => ({
    tcp: tcpClients.size,
    ws: wsClients.size,
    inproc: inprocHandlers.size,
  });

  const closeAll = (): void => {
    for (const socket of [...tcpClients]) {
      socket.destroy();
    }
    for (const client of [...wsClients]) {
      try {
        client.close?.();
      } catch {
        // 单个连接关闭失败不阻塞整体关闭
      }
    }
    tcpClients.clear();
    wsClients.clear();
    inprocHandlers.clear();
  };

  return { addTcpClient, addWsClient, subscribe, fanout, stats, closeAll };
}
