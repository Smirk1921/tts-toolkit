// src/protocol/editor-server.ts
/**
 * 编辑器侧 TCP 服务器：默认监听 EDITOR_PORT（39998，构造参数可覆盖以便测试注入随机端口），
 * 接收 TTS 主动连过来推送的入站消息（每条连接一条 JSON，连接关闭后一次性解析）。
 *
 * 两条关键约束：
 * 1. 消息留存列表只增不删——轮询（waitFor/find/getAll）绝不允许消费丢弃消息，
 *    否则竞态下轮询方会永远丢消息；
 * 2. listen 必须传 exclusive: true——坑 3：Windows 的 SO_REUSEADDR 允许双绑，
 *    会出现"绑定成功但收不到消息"。
 */
import net from 'node:net';

import { parseInbound, type InboundMessage } from './messages.js';
import { EDITOR_PORT, PortInUseError, checkExclusive, createPortInUseError } from './ports.js';

/** waitFor 注册的等待者。 */
interface Waiter {
  predicate: (m: InboundMessage) => boolean;
  resolve: (m: InboundMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 编辑器侧消息服务器。
 *
 * 用法：`await server.start()` → `server.on('message', ...)` /
 * `await server.waitFor(...)` → `await server.close()`。
 */
export class EditorServer {
  /** 底层 TCP 服务器；未启动/已关闭时为 undefined。 */
  private server: net.Server | undefined;
  /** 当前存活的 TTS 连接。 */
  private readonly sockets = new Set<net.Socket>();
  /** 消息留存列表：只增不删（关键约束，不许在任何地方清理）。 */
  private readonly retained: InboundMessage[] = [];
  /** 'message' 事件处理器列表。 */
  private readonly handlers: Array<(m: InboundMessage) => void> = [];
  /** 正在 waitFor 的等待者列表。 */
  private readonly waiters: Waiter[] = [];

  /**
   * @param port 监听端口；缺省 EDITOR_PORT（39998）。
   *             测试可注入随机端口（不依赖真实 39998 端口是否空闲）。
   */
  constructor(private readonly port: number = EDITOR_PORT) {}

  /**
   * 启动编辑器服务器并监听构造时指定的端口。
   *
   * @throws {PortInUseError} 端口被占用（含"检测与绑定之间被抢占"的竞态）
   * @throws {Error} 重复启动，或监听失败（非端口占用原因）
   */
  async start(): Promise<void> {
    if (this.server !== undefined) {
      throw new Error(`编辑器服务器已在运行（端口 ${this.port}），请勿重复启动。`);
    }
    const check = await checkExclusive(this.port);
    if (!check.ok) {
      throw new PortInUseError(this.port, check.pid, check.reason);
    }
    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.removeListener('error', onError);
        // 监听成功后仍可能有错误（极少见），记录日志避免击穿进程
        server.on('error', (err: Error) => {
          console.error(`编辑器服务器错误：${err.message}`);
        });
        resolve();
      };
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        // 检测与绑定之间端口可能被其他程序抢占（TOCTOU），按端口占用处理
        void (async () => {
          reject(
            err.code === 'EADDRINUSE'
              ? await createPortInUseError(this.port)
              : new Error(`监听端口 ${this.port} 失败：${err.message}`),
          );
        })();
      };
      server.once('listening', onListening);
      server.once('error', onError);
      // 坑 3：必须 exclusive: true（Windows SO_REUSEADDR 双绑陷阱）
      server.listen({ port: this.port, exclusive: true });
    });
  }

  /**
   * 等待一条匹配的消息：先扫已留存消息（命中立即返回），否则订阅新消息。
   * 不会消费/丢弃留存列表中的任何消息。
   *
   * @param predicate 类型守卫谓词，命中即返回该消息
   * @param timeoutMs 超时毫秒数
   * @returns 第一条匹配的消息
   * @throws {Error} 超时（`等待消息超时（…ms）`）或服务器已关闭
   */
  async waitFor<T extends InboundMessage>(
    predicate: (m: InboundMessage) => m is T,
    timeoutMs: number,
  ): Promise<T> {
    const hit = this.retained.find(predicate);
    if (hit !== undefined) {
      return hit;
    }
    if (this.server === undefined) {
      throw new Error('编辑器服务器已关闭，无法等待新消息。');
    }
    return await new Promise<T>((resolveFn, rejectFn) => {
      const waiter: Waiter = {
        predicate,
        resolve: (m) => {
          clearTimeout(waiter.timer);
          resolveFn(m as T);
        },
        reject: (err) => {
          clearTimeout(waiter.timer);
          rejectFn(err);
        },
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          waiter.reject(new Error(`等待消息超时（${timeoutMs}ms）`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /**
   * 在已留存的消息中查找所有匹配项（只读扫描，不消费）。
   *
   * 传入类型守卫谓词（`m is X`）时返回收窄后的数组，例如：
   * `server.find((m): m is InboundMessage & ErrorView => m.messageID === InboundId.Error)`。
   *
   * @param predicate 匹配谓词
   * @returns 匹配的消息数组（新数组，不共享内部引用）
   */
  find<S extends InboundMessage>(predicate: (m: InboundMessage) => m is S): S[];
  find(predicate: (m: InboundMessage) => boolean): InboundMessage[];
  find(predicate: (m: InboundMessage) => boolean): InboundMessage[] {
    return this.retained.filter(predicate);
  }

  /**
   * 获取全部已留存消息的只读副本（只读扫描，不消费）。
   *
   * @returns 消息快照
   */
  getAll(): readonly InboundMessage[] {
    return [...this.retained];
  }

  /**
   * 订阅 'message' 事件：每收到一条符合协议的入站消息时回调。
   *
   * @param event 事件名，目前仅支持 'message'
   * @param handler 消息处理器（抛出的异常会被捕获并记录，不影响其他处理器）
   */
  on(event: 'message', handler: (m: InboundMessage) => void): void {
    this.handlers.push(handler);
  }

  /**
   * 关闭服务器并断开所有连接。已留存的消息保留（只增不删），
   * 等待中的 waitFor 会被拒绝。
   *
   * @throws 不抛异常；未启动/重复调用为空操作
   */
  async close(): Promise<void> {
    if (this.server === undefined) {
      return;
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    for (const waiter of [...this.waiters]) {
      waiter.reject(new Error('编辑器服务器已关闭，等待被中断。'));
    }
    this.waiters.length = 0;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  /**
   * 处理一条来自 TTS 的连接：累积 Buffer，连接关闭时一次性解析并分发。
   * TTS 每条连接只发送一条 JSON 消息。
   */
  private handleConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    // 必须监听 error，否则 TTS 异常断开时会以 uncaught exception 击穿进程
    socket.on('error', (err: Error) => {
      console.error(`与 TTS 的连接发生错误：${err.message}`);
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        return; // 空连接（探测类），忽略
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.error(`收到无法解析的消息（不是合法 JSON）：${raw.slice(0, 200)}`);
        return;
      }
      try {
        this.dispatch(parseInbound(parsed));
      } catch (err) {
        console.error(`收到不符合协议的消息：${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  /**
   * 分发一条已校验的消息：追加到留存列表（只增不删）→ 通知事件处理器 → 唤醒匹配的等待者。
   */
  private dispatch(message: InboundMessage): void {
    this.retained.push(message);
    for (const handler of [...this.handlers]) {
      try {
        handler(message);
      } catch (err) {
        console.error(`消息处理器抛出异常：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // 通知所有匹配的等待者（不消费消息，多个等待者可同时命中同一条消息）
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        waiter.resolve(message);
      }
    }
  }
}
