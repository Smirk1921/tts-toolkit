// tests/unit/hub-daemon.test.ts
/**
 * src/hub/daemon.ts（HubDaemon + WS 帧编解码）单元测试。
 *
 * 覆盖场景（对应任务 C1 清单第 2 条）：
 * - 随机端口启动 HubDaemon（操作系统分配的临时端口，见下方端口说明）；
 * - start 后 stats().editor === true；stop 后再次 start 成功；
 * - 重复 start 抛中文错；重复 stop 空操作；
 * - net.createConnection 连 TCP 扇出端口 → 模拟 TTS 连编辑器入站端口推 JSON →
 *   TCP 客户端应收到同样的 JSON；
 * - node:http 升级 WebSocket 连 WS 扇出端口 → 验证 101 握手 + Sec-WebSocket-Accept
 *   + 收到文本帧；普通 HTTP 请求一律 426。
 *
 * 端口说明：任务要求"editorPort=0 然后读 server 实端口"，但 HubDaemon /
 * EditorServer / TCP / WS 监听都不暴露实际绑定端口（editor-server.ts 的 port 为
 * private readonly，daemon.ts 的 tcpServer / wsServer 为 private），测试又必须连上
 * 这些端口才能做端到端断言；在不动 src/ 的前提下采用本仓既有约定
 * （见 tests/unit/protocol-editor-server.test.ts / protocol-ports.test.ts）：
 * listen(0) 向操作系统抢占一个空闲临时端口后释放使用，端口冲突时重试，
 * 绝不绑定真实 39995-39999。控制通道（可 port=0 且有 boundPort()）在
 * hub-control.test.ts 中按"0 让操作系统分配"执行。
 */
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HubDaemon,
  WsFrameDecoder,
  WsOpcode,
  computeSecWebSocketAccept,
  type WsFrame,
} from '../../src/hub/daemon.js';
import { InboundId, type InboundMessage } from '../../src/protocol/messages.js';

/** afterEach 统一执行的清理动作（停 hub / 销毁 socket） */
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    await fn();
  }
  cleanups.length = 0;
});

/** 已启动的 daemon 及其三个实际端口 */
interface RunningDaemon {
  daemon: HubDaemon;
  editorPort: number;
  tcpPort: number;
  wsPort: number;
}

/**
 * 用 listen(0) 向操作系统抢占一个空闲临时端口后立即释放。
 * @returns 空闲端口
 */
async function grabFreePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => {
    probe.listen({ port: 0, host: '127.0.0.1' }, () => resolve());
  });
  const addr = probe.address();
  const port = addr !== null && typeof addr === 'object' ? (addr as AddressInfo).port : 0;
  await new Promise<void>((resolve) => {
    probe.close(() => resolve());
  });
  return port;
}

/**
 * 在随机空闲端口上启动 HubDaemon；端口恰被其他进程占用时换端口重试（最多 5 次）。
 * @returns 已启动的 daemon 与三个端口
 */
async function startDaemon(): Promise<RunningDaemon> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const editorPort = await grabFreePort();
    const tcpPort = await grabFreePort();
    const wsPort = await grabFreePort();
    const daemon = new HubDaemon({ editorPort, tcpPort, wsPort, log: () => undefined });
    try {
      await daemon.start();
      cleanups.push(() => daemon.stop());
      return { daemon, editorPort, tcpPort, wsPort };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** 轮询等待条件成立（超时抛错） */
async function until(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms: ${what}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

/**
 * 模拟 TTS：连编辑器入站端口推一条 JSON 消息后关闭（每条连接一条 JSON）。
 * @param port 编辑器入站端口
 * @param msg 入站消息
 */
async function ttsPush(port: number, msg: InboundMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.on('connect', () => {
      sock.end(JSON.stringify(msg), () => resolve());
    });
    sock.on('error', reject);
    cleanups.push(() => sock.destroy());
  });
}

/**
 * 连接 TCP 扇出端口并开始收集数据。
 * @param port TCP 扇出端口
 * @returns client 客户端 socket（测试内主动断开用）；chunks 收到的文本块（utf8）
 */
function connectTcp(port: number): { client: net.Socket; chunks: string[] } {
  const chunks: string[] = [];
  const client = net.createConnection({ host: '127.0.0.1', port });
  cleanups.push(() => client.destroy());
  client.setEncoding('utf8');
  client.on('data', (chunk: string) => {
    chunks.push(chunk);
  });
  return { client, chunks };
}

/** WebSocket 升级客户端的返回 */
interface WsClient {
  /** 101 响应（可读 Sec-WebSocket-Accept 头） */
  res: http.IncomingMessage;
  /** 升级后的原始 socket（此后收到的是 WS 帧） */
  socket: net.Socket;
  /** 客户端使用的 Sec-WebSocket-Key（用于校验 Accept 值） */
  key: string;
  /** 收到的全部字节 */
  readonly received: Buffer[];
  /** socket 关闭时 resolve */
  readonly closed: Promise<void>;
}

/**
 * 用 node:http 对 WS 扇出端口发起 WebSocket 升级请求。
 * @param port WS 扇出端口
 * @returns 101 响应与原始 socket
 */
function wsUpgrade(port: number): Promise<WsClient> {
  const key = Buffer.from('tts-toolkit-test-key').toString('base64');
  const received: Buffer[] = [];
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  return new Promise<WsClient>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    cleanups.push(() => req.destroy());
    req.on('upgrade', (res, socket, head) => {
      if (head.length > 0) {
        received.push(head);
      }
      socket.on('data', (chunk: Buffer) => {
        received.push(chunk);
      });
      socket.on('close', () => {
        resolveClosed?.();
      });
      socket.on('error', () => undefined); // 测试末尾主动断开时的 ECONNRESET 不击穿
      resolve({ res, socket, key, received, closed });
    });
    req.on('response', (res) => {
      reject(new Error(`expected 101 upgrade, got HTTP ${String(res.statusCode)}`));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 解码 WS 客户端收到的全部文本帧载荷 */
function decodeTextFrames(received: readonly Buffer[]): string[] {
  const decoder = new WsFrameDecoder();
  const frames: WsFrame[] = [];
  for (const chunk of received) {
    frames.push(...decoder.push(chunk));
  }
  return frames
    .filter((frame) => frame.opcode === WsOpcode.Text)
    .map((frame) => frame.payload.toString('utf8'));
}

describe('HubDaemon：生命周期', () => {
  it('start 后 stats().editor === true 且 startedAt > 0；未启动时 editor 为 false', async () => {
    const editorPort = await grabFreePort();
    const tcpPort = await grabFreePort();
    const wsPort = await grabFreePort();
    const daemon = new HubDaemon({ editorPort, tcpPort, wsPort, log: () => undefined });
    cleanups.push(() => daemon.stop());

    expect(daemon.stats().editor).toBe(false);
    expect(daemon.stats().startedAt).toBe(0);
    await daemon.start();
    expect(daemon.stats().editor).toBe(true);
    expect(daemon.stats().startedAt).toBeGreaterThan(0);
    expect(daemon.stats().tcpClients).toBe(0);
  });

  it('重复 start 抛中文错误', async () => {
    const { daemon } = await startDaemon();
    await expect(daemon.start()).rejects.toThrow(/请勿重复调用 start\(\)/);
  });

  it('stop 后 stats().editor 为 false；重复 stop 空操作', async () => {
    const { daemon } = await startDaemon();
    await daemon.stop();
    expect(daemon.stats().editor).toBe(false);
    await expect(daemon.stop()).resolves.toBeUndefined(); // 重复 stop 不抛
  });

  it('stop 后再次 start 成功（editor 恢复 true）', async () => {
    const { daemon } = await startDaemon();
    await daemon.stop();
    await daemon.start();
    expect(daemon.stats().editor).toBe(true);
  });
});

describe('HubDaemon：TCP 扇出端到端', () => {
  it('TTS 推一条 JSON → TCP 客户端收到同样的 JSON（原样、无分隔符）', async () => {
    const { daemon, editorPort, tcpPort } = await startDaemon();
    const { chunks } = connectTcp(tcpPort);
    await until(() => daemon.stats().tcpClients === 1, 'tcp client registered');

    const msg = printMsgMessage('hello from tts');
    await ttsPush(editorPort, msg);
    await until(() => chunks.length > 0, 'tcp fanout delivered');

    const raw = chunks.join('');
    expect(raw.endsWith('\n')).toBe(false); // 不带换行分隔符
    expect(JSON.parse(raw) as unknown).toEqual(msg); // 同样的 JSON
  });

  it('TCP 客户端断开后自动摘除（stats().tcpClients 回落）', async () => {
    const { daemon, tcpPort } = await startDaemon();
    const { client } = connectTcp(tcpPort);
    await until(() => daemon.stats().tcpClients === 1, 'tcp client registered');

    client.destroy(); // 触发服务端 socket close → 扇出层自动摘除
    await until(() => daemon.stats().tcpClients === 0, 'tcp client removed');
    expect(daemon.fanout.stats().tcp).toBe(0);
  });
});

describe('HubDaemon：WS 扇出', () => {
  it('WebSocket 升级握手：101 + Sec-WebSocket-Accept 正确', async () => {
    const { wsPort } = await startDaemon();
    const client = await wsUpgrade(wsPort);
    expect(client.res.statusCode).toBe(101);
    expect(client.res.headers['sec-websocket-accept']).toBe(
      computeSecWebSocketAccept(client.key),
    );
    client.socket.destroy();
  });

  it('普通 HTTP 请求（未升级）一律 426 Upgrade Required', async () => {
    const { wsPort } = await startDaemon();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${wsPort}/`, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
    });
    expect(status).toBe(426);
  });

  it('WS 客户端收到 TTS 推送消息的文本帧（载荷为同样的 JSON）', async () => {
    const { daemon, editorPort, wsPort } = await startDaemon();
    const client = await wsUpgrade(wsPort);
    await until(() => daemon.stats().wsClients === 1, 'ws client registered');

    const msg = printMsgMessage('hello over ws');
    await ttsPush(editorPort, msg);
    await until(() => decodeTextFrames(client.received).length > 0, 'ws text frame received');

    const payload = decodeTextFrames(client.received)[0];
    expect(payload).toBe(JSON.stringify(msg));
    client.socket.destroy();
  });
});

/** 构造一条协议合法的 Print 入站消息 */
function printMsgMessage(message: string): InboundMessage {
  return { messageID: InboundId.Print, message };
}
