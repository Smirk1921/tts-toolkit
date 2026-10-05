// tests/unit/hub-fanout.test.ts
/**
 * src/hub/fanout.ts 单元测试（三路扇出）。
 *
 * 覆盖场景（对应任务 C1 清单第 1 条）：
 * - createFanout() 三路注册 / 摘除 / fanout 不 throw；
 * - TCP：真实 socket 端到端收到原样 JSON（不带换行分隔符）；
 *   fake socket write 同步抛错自动摘除；close / error 事件自动摘除；
 * - WS：send 抛错自动摘除；close / error 回调自动摘除；
 * - 进程内：单个 handler 抛错不击穿其他 handler（console.error 记录后退订不受影响）；
 * - closeAll() 幂等；stats() 计数正确；三路全故障时 fanout 仍同步返回。
 *
 * 资源约束：真实 TCP 服务端用 listen(0) 由操作系统分配端口（本模块不涉及
 * 39995-39999 真实端口）；全部 socket / server 在 afterEach 关闭。
 */
import { EventEmitter } from 'node:events';
import net, { type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFanout, type FanoutWsClient } from '../../src/hub/fanout.js';
import { InboundId, type InboundMessage } from '../../src/protocol/messages.js';

/** afterEach 统一执行的清理动作（销毁 socket / 关闭 server） */
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    await fn();
  }
  cleanups.length = 0;
  vi.restoreAllMocks();
});

/** 构造一条协议合法的 Print 入站消息 */
const printMsg = (message: string): InboundMessage => ({ messageID: InboundId.Print, message });

/**
 * 让服务端在随机端口（listen(0)，操作系统分配）进入监听。
 * @param server 待监听的 TCP 服务
 * @returns 实际绑定端口
 */
function listenOn(server: net.Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const addr = server.address();
      if (addr !== null && typeof addr === 'object') {
        resolve((addr as AddressInfo).port);
      } else {
        reject(new Error(`unexpected server address: ${String(addr)}`));
      }
    });
  });
}

/** fake TCP socket 的扩展视图（扇出测试用） */
interface FakeTcpSocket extends Socket {
  /** write() 收到的全部文本（按序） */
  writes: string[];
  /** 手动触发 close 事件 */
  emitClose(): void;
  /** 手动触发 error 事件 */
  emitError(): void;
}

/**
 * fake TCP 下行 socket：只实现扇出层用到的结构（on / write / destroyed / destroy）。
 * @param options.writeImpl write 的行为（缺省记录调用并成功返回）
 */
function makeFakeTcpSocket(options?: { writeImpl?: (data: string) => void }): FakeTcpSocket {
  class FakeTcpSocketImpl extends EventEmitter {
    destroyed = false;
    writes: string[] = [];
    write = (data: string): boolean => {
      if (options?.writeImpl !== undefined) {
        options.writeImpl(data);
        return true;
      }
      this.writes.push(data);
      return true;
    };
    override destroy(): this {
      this.destroyed = true;
      this.emit('close');
      return this;
    }
    emitClose(): void {
      this.emit('close');
    }
    emitError(): void {
      this.emit('error');
    }
  }
  return new FakeTcpSocketImpl() as unknown as FakeTcpSocket;
}

/** fake WS 下行连接：实现 FanoutWsClient 最小接口，便于手动触发 close / error */
class FakeWsClient implements FanoutWsClient {
  /** send() 收到的全部文本（按序） */
  readonly sent: string[] = [];
  /** close / error 回调注册记录 */
  private readonly cbs: Record<'close' | 'error', Array<() => void>> = { close: [], error: [] };
  /** close() 是否应抛错（测试 closeAll 的容错分支） */
  closeThrows = false;

  /** @inheritdoc */
  send(data: string): void {
    this.sent.push(data);
  }

  /** @inheritdoc */
  on(event: 'close' | 'error', cb: () => void): void {
    this.cbs[event].push(cb);
  }

  /** 手动触发 close 回调（模拟连接关闭） */
  emitClose(): void {
    for (const cb of [...this.cbs.close]) {
      cb();
    }
  }

  /** 手动触发 error 回调（模拟连接出错） */
  emitError(): void {
    for (const cb of [...this.cbs.error]) {
      cb();
    }
  }

  /** @inheritdoc */
  close(): void {
    if (this.closeThrows) {
      throw new Error('close failed');
    }
  }
}

describe('createFanout：注册与 stats 计数', () => {
  it('三路注册后 stats 返回各自计数', () => {
    const fanout = createFanout();
    expect(fanout.stats()).toEqual({ tcp: 0, ws: 0, inproc: 0 });

    fanout.addTcpClient(makeFakeTcpSocket());
    fanout.addWsClient(new FakeWsClient());
    const unsubscribe = fanout.subscribe(() => undefined);

    expect(fanout.stats()).toEqual({ tcp: 1, ws: 1, inproc: 1 });
    unsubscribe();
    expect(fanout.stats()).toEqual({ tcp: 1, ws: 1, inproc: 0 });
  });

  it('同一 socket / 连接重复注册只计一次（Set 语义）', () => {
    const fanout = createFanout();
    const socket = makeFakeTcpSocket();
    fanout.addTcpClient(socket);
    fanout.addTcpClient(socket);
    expect(fanout.stats().tcp).toBe(1);
  });
});

describe('createFanout：TCP 下行', () => {
  it('真实 socket 收到与入站消息一致的原样 JSON（不带换行分隔符）', async () => {
    const fanout = createFanout();
    const server = net.createServer((socket) => {
      fanout.addTcpClient(socket);
      cleanups.push(() => socket.destroy());
    });
    const port = await listenOn(server);
    cleanups.push(() => server.close());

    const received: string[] = [];
    const client = net.createConnection({ host: '127.0.0.1', port });
    cleanups.push(() => client.destroy());
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      received.push(chunk);
    });
    await vi.waitFor(() => {
      expect(fanout.stats().tcp).toBe(1);
    });

    const msg = printMsg('fanout-tcp-e2e');
    fanout.fanout(msg);

    await vi.waitFor(() => {
      expect(received.length).toBeGreaterThan(0);
    });
    expect(received.join('')).toBe(JSON.stringify(msg)); // 原样 JSON，无换行
    expect(received.join('').endsWith('\n')).toBe(false);
    expect(JSON.parse(received.join('')) as unknown).toEqual(msg);
  });

  it('write 同步抛错 → 自动摘除且 fanout 不 throw', () => {
    const fanout = createFanout();
    fanout.addTcpClient(
      makeFakeTcpSocket({
        writeImpl: () => {
          throw new Error('EPIPE');
        },
      }),
    );
    expect(fanout.stats().tcp).toBe(1);

    expect(() => fanout.fanout(printMsg('x'))).not.toThrow();
    expect(fanout.stats().tcp).toBe(0);
  });

  it('close 事件触发自动摘除', () => {
    const fanout = createFanout();
    const socket = makeFakeTcpSocket();
    fanout.addTcpClient(socket);
    expect(fanout.stats().tcp).toBe(1);
    socket.emitClose();
    expect(fanout.stats().tcp).toBe(0);
  });

  it('error 事件触发自动摘除', () => {
    const fanout = createFanout();
    const socket = makeFakeTcpSocket();
    fanout.addTcpClient(socket);
    socket.emitError();
    expect(fanout.stats().tcp).toBe(0);
  });

  it('fanout 跳过已 destroyed 的 socket（惰性摘除）', () => {
    const fanout = createFanout();
    const socket = makeFakeTcpSocket();
    fanout.addTcpClient(socket);
    (socket as unknown as { destroyed: boolean }).destroyed = true; // 模拟外部置毁
    expect(() => fanout.fanout(printMsg('x'))).not.toThrow();
    expect(fanout.stats().tcp).toBe(0);
    expect(socket.writes).toHaveLength(0);
  });
});

describe('createFanout：WS 下行', () => {
  it('send 抛错 → 自动摘除且不阻塞进程内通道', () => {
    const fanout = createFanout();
    const bad = new FakeWsClient();
    bad.send = () => {
      throw new Error('ws send failed');
    };
    const good = new FakeWsClient();
    const inprocSeen: InboundMessage[] = [];
    fanout.addWsClient(bad);
    fanout.addWsClient(good);
    fanout.subscribe((m) => inprocSeen.push(m));

    const msg = printMsg('ws-send-throw');
    expect(() => fanout.fanout(msg)).not.toThrow();

    expect(fanout.stats().ws).toBe(1); // 只有 good 留存
    expect(good.sent).toEqual([JSON.stringify(msg)]);
    expect(inprocSeen).toEqual([msg]);
  });

  it('close 回调触发自动摘除', () => {
    const fanout = createFanout();
    const ws = new FakeWsClient();
    fanout.addWsClient(ws);
    ws.emitClose();
    expect(fanout.stats().ws).toBe(0);
  });

  it('error 回调触发自动摘除', () => {
    const fanout = createFanout();
    const ws = new FakeWsClient();
    fanout.addWsClient(ws);
    ws.emitError();
    expect(fanout.stats().ws).toBe(0);
  });
});

describe('createFanout：进程内订阅', () => {
  it('单个 handler 抛错不击穿：其余 handler 照常收到，fanout 不 throw', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fanout = createFanout();
    const seen: string[] = [];
    fanout.subscribe(() => {
      throw new Error('handler boom');
    });
    fanout.subscribe((m) => {
      seen.push(m.message);
    });

    const msg = printMsg('inproc-isolated');
    expect(() => fanout.fanout(msg)).not.toThrow();
    expect(seen).toEqual(['inproc-isolated']);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0]?.[0])).toContain('handler boom');
    expect(fanout.stats().inproc).toBe(2); // 抛错不导致退订
  });

  it('退订函数幂等（重复调用无副作用）', () => {
    const fanout = createFanout();
    let calls = 0;
    const unsubscribe = fanout.subscribe(() => {
      calls += 1;
    });
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    fanout.fanout(printMsg('after-unsub'));
    expect(calls).toBe(0);
    expect(fanout.stats().inproc).toBe(0);
  });
});

describe('createFanout：fire-and-forget 与 closeAll', () => {
  it('三路全故障时 fanout 仍同步返回且不 throw', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fanout = createFanout();
    fanout.addTcpClient(
      makeFakeTcpSocket({
        writeImpl: () => {
          throw new Error('tcp down');
        },
      }),
    );
    const ws = new FakeWsClient();
    ws.send = () => {
      throw new Error('ws down');
    };
    fanout.addWsClient(ws);
    fanout.subscribe(() => {
      throw new Error('handler down');
    });

    expect(() => fanout.fanout(printMsg('all-fail'))).not.toThrow();
    expect(fanout.stats()).toEqual({ tcp: 0, ws: 0, inproc: 1 });
    expect(consoleError).toHaveBeenCalled();
  });

  it('closeAll 关闭全部下游并清空订阅；幂等', async () => {
    const fanout = createFanout();
    const socket = makeFakeTcpSocket();
    const server = net.createServer((accepted) => {
      fanout.addTcpClient(accepted);
    });
    const port = await listenOn(server);
    cleanups.push(() => server.close());

    const client = net.createConnection({ host: '127.0.0.1', port });
    cleanups.push(() => client.destroy());

    const ws = new FakeWsClient();
    const closeSpy = vi.spyOn(ws, 'close');
    fanout.addTcpClient(socket);
    fanout.addWsClient(ws);
    fanout.subscribe(() => undefined);
    // 等真实连接进入扇出集合（服务端 accept + addTcpClient 都是异步的）
    await vi.waitFor(() => {
      expect(fanout.stats().tcp).toBe(2);
    });
    expect(fanout.stats()).toEqual({ tcp: 2, ws: 1, inproc: 1 });

    expect(() => fanout.closeAll()).not.toThrow();
    expect(fanout.stats()).toEqual({ tcp: 0, ws: 0, inproc: 0 });
    expect(socket.destroyed).toBe(true); // fake socket destroy 置位
    expect(closeSpy).toHaveBeenCalledOnce();

    expect(() => fanout.closeAll()).not.toThrow(); // 幂等
    expect(fanout.stats()).toEqual({ tcp: 0, ws: 0, inproc: 0 });
  });
});
