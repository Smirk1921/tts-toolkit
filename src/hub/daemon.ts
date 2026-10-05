// src/hub/daemon.ts
/**
 * hub 守护进程主类（{@link HubDaemon}）：组合协议层 EditorServer（编辑器入站端口，
 * 默认 39998）与三路扇出（{@link FanoutHub}：TCP / WS / 进程内事件总线），提供生命周期管理。
 *
 * 端口布局（常量见 src/protocol/ports.ts）：
 * - editorPort（默认 39998）：TTS 主动连过来推送入站消息（EditorServer 提供）；
 * - tcpPort（默认 39997）：TCP 扇出，下游连入后持续收到 JSON 串（原样、不带分隔符）；
 * - wsPort（默认 39996）：WS 扇出，下游经 WebSocket 连入后持续收到文本帧。
 *
 * WS 实现决策：本仓无 ws 包依赖，WS 服务在 node:http 上按 RFC6455 手写极简实现——
 * - 握手：仅接受 `GET /` 且 `Upgrade: websocket`，回复 101 +
 *   Sec-WebSocket-Accept（{@link computeSecWebSocketAccept}），其余一律 426 断开；
 * - 发送：{@link encodeWsFrame} 文本帧（fire-and-forget，不等 drain）；
 * - 接收：只处理 Ping（回同载荷 Pong）与 Close（回 Close 后断开），
 *   数据帧一律忽略（下游只收）；
 * - 不设心跳定时器：断开经 socket close / error 事件感知并自动摘除。
 * 帧编解码（{@link encodeWsFrame} / {@link WsFrameDecoder}）均为独立导出的纯函数/类，可单测。
 *
 * 控制通道本身（HTTP+JSON，39995）由 src/hub/control.ts 实现；本模块只提供它需要的入口：
 * {@link HubDaemon.exec} / {@link HubDaemon.scripts} / {@link HubDaemon.fanout} / {@link HubDaemon.stats}。
 *
 * start() 失败语义：任一监听启动失败即回滚全部已启动资源（销毁扇出客户端 →
 * 逐个关闭监听 → 关闭 EditorServer），随后抛出原始错误（端口冲突按 PortInUseError
 * 呈现，与 EditorServer 行为一致）。
 */
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";

import { EditorServer } from "../protocol/editor-server.js";
import {
  EDITOR_PORT,
  HUB_TCP_PORT,
  HUB_WS_PORT,
  PortInUseError,
  checkExclusive,
} from "../protocol/ports.js";
import { SessionExec } from "../session/exec.js";
import { SessionScripts } from "../session/scripts.js";
import { createFanout, type FanoutHub, type FanoutWsClient } from "./fanout.js";

/** RFC6455 正常关闭状态码（1000 = normal closure）。 */
const WS_CLOSE_NORMAL = 1000;

/**
 * 单帧载荷上限（字节，1 MiB）。下游只收不发，上行只会出现控制帧（Ping/Pong/Close，
 * 几个字节），超出即按协议违规处理（断开），同时防止恶意长度声明触发大内存分配。
 */
const WS_MAX_FRAME_BYTES = 1_048_576;

/** RFC6455 握手固定的魔术 GUID（RFC 6455 §1.3）。 */
const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** 默认日志出口：JSON Lines 直接写 stderr。 */
const defaultLog = (line: string): void => {
  console.error(line);
};

/**
 * 本模块用到的 RFC6455 帧操作码子集。
 */
export enum WsOpcode {
  /** 分片延续帧（下游只收，忽略）。 */
  Continuation = 0x0,
  /** 文本帧。 */
  Text = 0x1,
  /** 二进制帧（忽略）。 */
  Binary = 0x2,
  /** 连接关闭。 */
  Close = 0x8,
  /** 心跳 Ping（回同载荷 Pong）。 */
  Ping = 0x9,
  /** 心跳 Pong。 */
  Pong = 0xa,
}

/**
 * 计算 Sec-WebSocket-Accept 响应值：base64( SHA-1( key + 魔术 GUID ) )。
 *
 * @param key 客户端握手请求头 Sec-WebSocket-Key 的值
 * @returns 101 响应应写入的 Sec-WebSocket-Accept 值
 * @example key 为 "dGhlIHNhbXBsZSBub25jZQ==" 时返回 "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="（RFC 6455 §1.3 示例）
 */
export function computeSecWebSocketAccept(key: string): string {
  return createHash("sha1").update(`${key}${WS_MAGIC_GUID}`).digest("base64");
}

/**
 * 编码一帧服务端 → 客户端帧（FIN=1，不掩码——RFC6455 规定服务端出站帧不得掩码）。
 *
 * @param opcode 帧操作码
 * @param payload 帧载荷；缺省为空（Ping / 不带状态码的 Close 场景）
 * @returns 完整帧字节（帧头 + 载荷）
 */
export function encodeWsFrame(opcode: WsOpcode, payload: Buffer = Buffer.alloc(0)): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN=1
  return Buffer.concat([header, payload]);
}

/** {@link WsFrameDecoder} 解析出的一帧。 */
export interface WsFrame {
  /** 帧操作码。 */
  opcode: WsOpcode;
  /** 帧载荷（客户端帧已去掩码）。 */
  payload: Buffer;
  /** 是否为消息的最后一个分片（FIN 位）。 */
  fin: boolean;
}

/**
 * 极简增量式 RFC6455 帧解析器。
 *
 * 用途仅限识别上行控制帧（Ping / Close）：跨 chunk 的不完整帧由内部缓冲暂存，
 * 凑齐一帧即解析返回。下游只收——上行数据帧的载荷虽被解析但不做任何消费。
 * 载荷超过 {@link WS_MAX_FRAME_BYTES} 时抛错（调用方应直接断开该连接）。
 *
 * 注意：不做 RSV 位校验、允许未掩码的客户端帧（宽容解析，非通用 WS 库）。
 */
export class WsFrameDecoder {
  /** 尚未凑成完整帧的字节缓冲。 */
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * 喂入一段收到的字节，返回其中所有完整帧。
   *
   * @param chunk 本次新收到的字节
   * @returns 本次解析出的完整帧（可能为空数组）
   * @throws {Error} 帧载荷超过 {@link WS_MAX_FRAME_BYTES}
   */
  push(chunk: Buffer): WsFrame[] {
    this.buffer =
      this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: WsFrame[] = [];
    for (;;) {
      const frame = this.tryReadFrame();
      if (frame === undefined) {
        break;
      }
      frames.push(frame);
    }
    return frames;
  }

  /**
   * 从缓冲中尝试读取一帧；字节不足时返回 undefined（保留现场等下一块）。
   *
   * @returns 一帧，或 undefined（字节不足）
   * @throws {Error} 帧载荷超过 {@link WS_MAX_FRAME_BYTES}
   */
  private tryReadFrame(): WsFrame | undefined {
    const buf = this.buffer;
    if (buf.length < 2) {
      return undefined;
    }
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = (buf[0] & 0x0f) as WsOpcode;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < offset + 2) {
        return undefined;
      }
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) {
        return undefined;
      }
      const bigLength = buf.readBigUInt64BE(offset);
      if (bigLength > BigInt(WS_MAX_FRAME_BYTES)) {
        throw new Error(`ws frame too large: ${bigLength} bytes`);
      }
      length = Number(bigLength);
      offset += 8;
    }
    const maskOffset = offset;
    if (masked) {
      offset += 4;
    }
    if (buf.length < offset + length) {
      return undefined;
    }
    let payload = buf.subarray(offset, offset + length);
    if (masked) {
      const mask = buf.subarray(maskOffset, maskOffset + 4);
      const unmasked = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i++) {
        unmasked[i] = payload[i] ^ mask[i & 3];
      }
      payload = unmasked;
    }
    this.buffer = buf.subarray(offset + length);
    return { opcode, payload, fin };
  }
}

/**
 * 极简 WS 下行连接：把 RFC6455 握手完成后的原始 socket 包装成 {@link FanoutWsClient}。
 *
 * 只做三件事：
 * 1. send()：把 JSON 字符串包成文本帧写出（fire-and-forget，不等 drain）；
 * 2. 收到 Ping → 回同载荷 Pong（尽力而为，失败不抛）；
 * 3. 收到 Close / 对端半关 → 回 Close(1000) 后销毁 socket。
 * 数据帧一律忽略（下游只收）。断开经 close / error 回调通知扇出层摘除。
 */
class WsConnection implements FanoutWsClient {
  /** 已注册的 close 回调。 */
  private readonly closeCbs: Array<() => void> = [];
  /** 已注册的 error 回调。 */
  private readonly errorCbs: Array<() => void> = [];
  /** 增量帧解析器（识别上行 Ping / Close）。 */
  private readonly decoder = new WsFrameDecoder();
  /** 关闭标志：置位后 send() 抛错、上行数据被忽略。 */
  private closed = false;

  /**
   * @param socket 已完成 101 握手的原始 socket（此后归本类持有）
   * @param head node:http 在 upgrade 时刻附带交付的早期数据（须先于 'data' 事件解析）
   */
  constructor(private readonly socket: net.Socket, head: Buffer) {
    socket.on("data", (chunk: Buffer) => {
      this.handleData(chunk);
    });
    socket.on("end", () => {
      // 对端半关写方向：已不可能再收到任何东西，主动关闭
      this.close();
    });
    socket.on("error", () => {
      this.emit("error");
    });
    socket.on("close", () => {
      this.closed = true;
      this.emit("close");
    });
    if (head.length > 0) {
      this.handleData(head);
    }
  }

  /**
   * 发送一帧文本数据（JSON 字符串）。
   *
   * @param data 要发送的文本内容
   * @throws {Error} 连接已关闭（扇出层捕获 send 抛错即摘除该连接）
   */
  send(data: string): void {
    if (this.closed || this.socket.destroyed) {
      throw new Error("ws connection already closed");
    }
    const frame = encodeWsFrame(WsOpcode.Text, Buffer.from(data, "utf8"));
    // fire-and-forget：故意忽略 write 的背压信号，不等 drain；
    // 写失败经 socket 'error' 事件呈现并触发自动摘除
    void this.socket.write(frame);
  }

  /**
   * 注册 close / error 回调（扇出层借其自动摘除连接）。
   *
   * @param event 事件名："close" 或 "error"
   * @param cb 回调（监听器异常会被吞掉，避免击穿 socket 事件循环）
   */
  on(event: "close" | "error", cb: () => void): void {
    (event === "close" ? this.closeCbs : this.errorCbs).push(cb);
  }

  /**
   * 主动断开：发送 Close 帧（状态码 1000）后销毁 socket。幂等。
   */
  close(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        if (this.socket.writable && !this.socket.destroyed) {
          const status = Buffer.alloc(2);
          status.writeUInt16BE(WS_CLOSE_NORMAL, 0);
          void this.socket.write(encodeWsFrame(WsOpcode.Close, status));
        }
      } catch {
        // Close 帧写失败不阻塞断开
      }
    }
    this.socket.destroy();
  }

  /** 解析上行帧：Ping 回 Pong，Close 触发断开，数据帧忽略。 */
  private handleData(chunk: Buffer): void {
    if (this.closed) {
      return;
    }
    let frames: WsFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch {
      // 协议违规（如帧超长）：直接断开
      this.close();
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === WsOpcode.Ping) {
        this.writeOrIgnore(encodeWsFrame(WsOpcode.Pong, frame.payload));
      } else if (frame.opcode === WsOpcode.Close) {
        this.close();
        return;
      }
      // Pong / Text / Binary / Continuation：下游只收，忽略
    }
  }

  /** 尽力而为的一次写入；已关闭 / 写失败一律吞掉（用于 Pong 等"失败无所谓"的回包）。 */
  private writeOrIgnore(frame: Buffer): void {
    try {
      if (!this.closed && !this.socket.destroyed) {
        void this.socket.write(frame);
      }
    } catch {
      // 写失败由 socket 的 error / close 事件兜底摘除
    }
  }

  /** 触发某事件的全部回调（快照迭代；单个监听器抛错不影响其余）。 */
  private emit(event: "close" | "error"): void {
    const cbs = [...(event === "close" ? this.closeCbs : this.errorCbs)];
    for (const cb of cbs) {
      try {
        cb();
      } catch {
        // 监听器失败不阻塞其余监听器
      }
    }
  }
}

/** 可关闭监听器的最小结构（net.Server 与 http.Server 的公共形状）。 */
interface ClosableListener {
  /** 是否正在监听。 */
  readonly listening: boolean;
  /**
   * 停止接受新连接，全部既有连接结束后触发回调。
   *
   * @param callback 关闭完成回调
   */
  close(callback?: () => void): unknown;
}

/**
 * 关闭一条 TCP / HTTP 监听：停止接受新连接，并等待底层关闭完成。
 *
 * 注意：net/http 的 close 会等既有连接结束，调用方必须先销毁客户端连接
 * （fanout.closeAll / closeAllConnections），否则返回的 Promise 永不 resolve。
 *
 * @param server 要关闭的监听；undefined（未启动）或未监听时直接完成
 */
async function closeListener(server: ClosableListener | undefined): Promise<void> {
  if (server === undefined || !server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/** {@link HubDaemon} 的构造选项。 */
export interface HubDaemonOptions {
  /** 编辑器入站端口；默认 {@link EDITOR_PORT}（39998），测试可注入随机端口。 */
  editorPort?: number;
  /** TCP 扇出端口；默认 {@link HUB_TCP_PORT}（39997）。 */
  tcpPort?: number;
  /** WS 扇出端口；默认 {@link HUB_WS_PORT}（39996）。 */
  wsPort?: number;
  /** 日志回调（JSON Lines，英文）；默认 console.error（stderr）。 */
  log?: (line: string) => void;
}

/** {@link HubDaemon.stats} 的返回结构（供 /v1/status 路由使用）。 */
export interface HubStats {
  /** 编辑器入站通道是否就绪（true = hub 已成功 start 且尚未 stop）。 */
  editor: boolean;
  /** 当前 TCP 下行连接数。 */
  tcpClients: number;
  /** 当前 WS 下行连接数。 */
  wsClients: number;
  /** 当前进程内订阅者数。 */
  inprocClients: number;
  /** start() 成功时刻（Unix 毫秒）；未启动时为 0。 */
  startedAt: number;
}

/**
 * hub 守护进程主类。
 *
 * 用法：`const hub = new HubDaemon(); await hub.start(); … await hub.stop();`
 * start / stop 需配对：重复 start 抛错，重复 stop 为空操作；stop 后允许再次 start。
 *
 * 入站消息通路：TTS → EditorServer（留存列表只增不删）→ 'message' 事件 →
 * {@link HubDaemon.fanout} 三路扇出（fire-and-forget）。
 */
export class HubDaemon {
  /** 生效的编辑器入站端口。 */
  private readonly editorPort: number;
  /** 生效的 TCP 扇出端口。 */
  private readonly tcpPort: number;
  /** 生效的 WS 扇出端口。 */
  private readonly wsPort: number;
  /** 日志出口。 */
  private readonly logFn: (line: string) => void;
  /** 运行标志：true = start() 已成功且尚未 stop。 */
  private started = false;
  /** start() 进行中标志（防止并发重复 start）。 */
  private starting = false;
  /** TCP 扇出监听；未启动为 undefined。 */
  private tcpServer: net.Server | undefined;
  /** WS 扇出监听；未启动为 undefined。 */
  private wsServer: http.Server | undefined;
  /** start() 成功时刻（Unix 毫秒）；未启动为 0。 */
  private startedAt = 0;

  /** 内部 SessionExec（供控制通道 /v1/exec 路由调用）。 */
  readonly exec: SessionExec;
  /** 内部 SessionScripts（供控制通道 /v1/scripts/* 路由调用）。 */
  readonly scripts: SessionScripts;
  /** 内部 FanoutHub（供 SSE 路由 /v1/events 订阅及 /v1/status 报数）。 */
  readonly fanout: FanoutHub;
  /** 内部 EditorServer（仅供测试）。 */
  readonly server: EditorServer;

  /**
   * @param opts 配置项；全部字段有默认值（标准端口 39998 / 39997 / 39996）
   */
  constructor(opts: HubDaemonOptions = {}) {
    this.editorPort = opts.editorPort ?? EDITOR_PORT;
    this.tcpPort = opts.tcpPort ?? HUB_TCP_PORT;
    this.wsPort = opts.wsPort ?? HUB_WS_PORT;
    this.logFn = opts.log ?? defaultLog;
    this.server = new EditorServer(this.editorPort);
    this.fanout = createFanout();
    this.exec = new SessionExec(this.server);
    this.scripts = new SessionScripts(this.server);
    // TTS 入站 → 三路扇出（fire-and-forget；fanout 内部吞掉单路故障）
    this.server.on("message", (msg) => {
      this.fanout.fanout(msg);
    });
  }

  /**
   * 启动 hub：端口预检 → EditorServer（编辑器入站）→ TCP 扇出监听 → WS 扇出监听。
   *
   * @throws {PortInUseError} 编辑器入站端口被占用（预检与 EditorServer 内部复查双重保障）
   * @throws {Error} 重复调用 start()，或 TCP/WS 扇出端口监听失败（抛原始错误）
   */
  async start(): Promise<void> {
    if (this.started || this.starting) {
      throw new Error(`hub 已启动或正在启动，请勿重复调用 start()（编辑器端口 ${this.editorPort}）。`);
    }
    this.starting = true;
    try {
      // ① 端口预检：checkExclusive 先行探针（方案要求；EditorServer.start() 内部还会
      //    复查一次，两次探测之间的竞态由其 EADDRINUSE 兜底路径闭环）
      const check = await checkExclusive(this.editorPort);
      if (!check.ok) {
        throw new PortInUseError(this.editorPort, check.pid, check.reason);
      }
      // ② EditorServer：独占绑定编辑器入站端口（TTS 主动连入）
      await this.server.start();
      let tcpServer: net.Server | undefined;
      let wsServer: http.Server | undefined;
      try {
        // ③ TCP 扇出监听
        tcpServer = await this.startTcpListener();
        // ④ WS 扇出监听（node:http + 手写极简 RFC6455）
        wsServer = await this.startWsListener();
      } catch (err) {
        // 回滚已启动资源：先销毁扇出客户端（让监听 close 能完成），
        // 再逐个关闭监听，最后关闭 EditorServer；回滚完成后抛出原始错误
        this.fanout.closeAll();
        wsServer?.closeAllConnections();
        await Promise.all([closeListener(wsServer), closeListener(tcpServer)]);
        await this.server.close();
        throw err;
      }
      this.tcpServer = tcpServer;
      this.wsServer = wsServer;
      this.startedAt = Date.now();
      this.started = true;
      this.log("info", "hub started", {
        editorPort: this.editorPort,
        tcpPort: this.tcpPort,
        wsPort: this.wsPort,
      });
    } finally {
      this.starting = false;
    }
  }

  /**
   * 优雅停止 hub：先关 TCP/WS 监听（拒绝新连接）→ 销毁全部扇出客户端 →
   * 关闭 EditorServer（断开剩余 TTS 连接；进行中的 waitFor 会被拒绝）。
   *
   * @throws 不抛异常；未启动或重复调用为空操作
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    const tcpServer = this.tcpServer;
    const wsServer = this.wsServer;
    this.tcpServer = undefined;
    this.wsServer = undefined;
    // ① 关闭 TCP/WS 监听：停止接受新连接（先不 await；既有客户端随即由②销毁，close 才能完成）
    const tcpClosed = closeListener(tcpServer);
    const wsClosed = closeListener(wsServer);
    // ② 销毁全部扇出客户端（TCP socket 直接 destroy；WS 先回 Close 帧再 destroy）
    this.fanout.closeAll();
    // 销毁 WS HTTP 服务上尚未完成 upgrade 的滞留连接（未注册进 fanout），确保 close 能完成
    wsServer?.closeAllConnections();
    await Promise.all([tcpClosed, wsClosed]);
    // ③ 关闭 EditorServer（断开剩余 TTS 连接；留存消息保留——只增不删约束）
    await this.server.close();
    this.log("info", "hub stopped");
  }

  /**
   * 当前连接统计（供 /v1/status 路由处理器调用）。
   *
   * @returns 各通道计数与启动时刻；未启动时 {@link HubStats.startedAt} 为 0
   */
  stats(): HubStats {
    const fanoutStats = this.fanout.stats();
    return {
      editor: this.started,
      tcpClients: fanoutStats.tcp,
      wsClients: fanoutStats.ws,
      inprocClients: fanoutStats.inproc,
      startedAt: this.startedAt,
    };
  }

  /**
   * 启动 TCP 扇出监听（127.0.0.1:{@link HubDaemon.tcpPort}，exclusive: true）。
   * 接受的连接注册进扇出层（fire-and-forget 写入、断开自动摘除）。
   *
   * @returns 已进入监听状态的 TCP 服务
   * @throws {Error} 监听失败（含 EADDRINUSE，抛原始错误）
   */
  private startTcpListener(): Promise<net.Server> {
    return new Promise<net.Server>((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.fanout.addTcpClient(socket);
      });
      const onListening = (): void => {
        server.removeListener("error", onError);
        // 监听成功后的错误（极少见）仅记录，避免击穿进程
        server.on("error", (err: Error) => {
          this.log("error", "hub tcp listener error", { detail: err.message });
        });
        resolve(server);
      };
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      // 坑 3：exclusive: true，防 Windows SO_REUSEADDR 双绑；扇出只服务本机，绑 127.0.0.1
      server.listen({ port: this.tcpPort, host: "127.0.0.1", exclusive: true });
    });
  }

  /**
   * 启动 WS 扇出监听（127.0.0.1:{@link HubDaemon.wsPort}，exclusive: true）。
   *
   * 以 node:http 实现：普通 HTTP 请求一律 426；带 Upgrade 头的请求进入
   * {@link HubDaemon.handleWsUpgrade} 做极简 RFC6455 握手。
   *
   * @returns 已进入监听状态的 HTTP 服务（承载 WS 升级）
   * @throws {Error} 监听失败（含 EADDRINUSE，抛原始错误）
   */
  private startWsListener(): Promise<http.Server> {
    return new Promise<http.Server>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        // 普通 HTTP 请求（未做 WebSocket 升级）：按方案一律 426
        res.writeHead(426, {
          Upgrade: "websocket",
          Connection: "close",
          "Content-Type": "text/plain; charset=utf-8",
        });
        res.end(`426 Upgrade Required: use ws://127.0.0.1:${this.wsPort}/`);
      });
      server.on("upgrade", (req, socket, head) => {
        this.handleWsUpgrade(req, socket as net.Socket, head);
      });
      const onListening = (): void => {
        server.removeListener("error", onError);
        server.on("error", (err: Error) => {
          this.log("error", "hub ws listener error", { detail: err.message });
        });
        resolve(server);
      };
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      // 坑 3：exclusive: true
      server.listen({ port: this.wsPort, host: "127.0.0.1", exclusive: true });
    });
  }

  /**
   * 处理一条 WebSocket 升级请求（极简 RFC6455 握手）。
   *
   * 仅接受 `GET /` 且携带 `Upgrade: websocket` 与非空 Sec-WebSocket-Key 的请求：
   * 回 101 + Sec-WebSocket-Accept，并把连接注册进扇出层；
   * 其余情况（含非 "/" 路径）回 426 后断开。
   *
   * @param req 升级请求
   * @param socket 原始 socket（握手成功后由本类接管，http 服务不再管理）
   * @param head 升级时刻附带的早期数据（少见，须先于后续 'data' 事件解析）
   */
  private handleWsUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    // 必须先挂一个 error 监听：否则裸 socket 异常（如对端在握手前断开）会以
    // uncaught exception 击穿进程
    socket.on("error", (err: Error) => {
      this.log("warn", "ws socket error", { detail: err.message });
    });
    const rawUpgrade = req.headers.upgrade;
    const upgrade = Array.isArray(rawUpgrade) ? rawUpgrade[0] : rawUpgrade;
    const rawKey = req.headers["sec-websocket-key"];
    const key = typeof rawKey === "string" ? rawKey : Array.isArray(rawKey) ? rawKey[0] : undefined;
    const isWsGetRoot =
      req.method === "GET" &&
      req.url === "/" &&
      upgrade !== undefined &&
      upgrade.toLowerCase() === "websocket" &&
      key !== undefined &&
      key.length > 0;
    if (!isWsGetRoot || key === undefined) {
      // 握手条件不满足（含非 "/" 路径）：426 后断开。已是裸 socket，须手写 HTTP 响应。
      socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroySoon();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${computeSecWebSocketAccept(key)}\r\n` +
        "\r\n",
    );
    const connection = new WsConnection(socket, head);
    this.fanout.addWsClient(connection);
  }

  /**
   * 写一条 JSON Lines 日志：`{"ts":…,"level":…,"msg":…,…fields}`。
   *
   * @param level 日志级别
   * @param msg 事件名（英文）
   * @param fields 附加字段（端口、计数等），拼接在 msg 字段之后
   */
  private log(
    level: "info" | "warn" | "error",
    msg: string,
    fields?: Record<string, number | string>,
  ): void {
    const entry: Record<string, number | string> = {
      ts: new Date().toISOString(),
      level,
      msg,
    };
    if (fields !== undefined) {
      Object.assign(entry, fields);
    }
    this.logFn(JSON.stringify(entry));
  }
}
