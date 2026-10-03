// tests/unit/protocol-editor-server.test.ts
/**
 * editor-server.ts / tts-client.ts 单元测试。
 * 不依赖运行中的 TTS：
 * - EditorServer 通过构造参数注入随机端口（40000-40999，避开真实 39998）；
 * - sendToTts 通过 { port } 覆盖连到随机端口的假 TTS；
 * - 模拟 TTS 客户端 / 假 TTS 接收端均用临时 net.createServer / createConnection。
 */
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorServer } from '../../src/protocol/editor-server.js';
import {
  GLOBAL_GUID,
  InboundId,
  OutboundId,
  type InboundMessage,
} from '../../src/protocol/messages.js';
import { PortInUseError } from '../../src/protocol/ports.js';
import { sendToTts } from '../../src/protocol/tts-client.js';

/** ask 指定的随机端口公式：避开 39998/39999 真实端口 */
const randomPort = (): number => 40000 + Math.floor(Math.random() * 1000);

/** afterEach 统一执行的清理动作（关服务器 / restore mock） */
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    await fn();
  }
  cleanups.length = 0;
  vi.restoreAllMocks();
});

/**
 * 在随机端口启动 EditorServer；端口恰被占用时换端口重试（最多 5 次）。
 * @returns 服务器实例与其监听端口
 */
async function startEditor(): Promise<{ server: EditorServer; port: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = randomPort();
    const server = new EditorServer(port);
    try {
      await server.start();
      cleanups.push(() => server.close());
      return { server, port };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** 模拟 TTS 客户端：连接 → 发一条 JSON → 关闭（FIN），数据落盘后 resolve */
function sendJson(port: number, payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.on('connect', () => {
      sock.end(JSON.stringify(payload), () => resolve());
    });
    sock.on('error', reject);
  });
}

/** 模拟 TTS 客户端发送任意原始文本（用于非法输入） */
function sendRaw(port: number, raw: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.on('connect', () => {
      sock.end(raw, () => resolve());
    });
    sock.on('error', reject);
  });
}

/** 起临时监听抢占空闲端口后立即释放（用于 ECONNREFUSED 场景） */
async function grabFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 启动假 TTS 接收端（随机端口），记录收到的原始文本与客户端是否主动关闭 */
function startFakeTts(): Promise<{
  port: number;
  received: Promise<{ raw: string; clientEnded: boolean }>;
}> {
  let resolveGot!: (v: { raw: string; clientEnded: boolean }) => void;
  const received = new Promise<{ raw: string; clientEnded: boolean }>((r) => {
    resolveGot = r;
  });
  const sockets = new Set<net.Socket>();
  const fake = net.createServer((sock) => {
    sockets.add(sock);
    let raw = '';
    let clientEnded = false;
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      raw += chunk;
    });
    // 客户端发送完主动 end()（连 → 写 → 关），服务端收到 FIN
    sock.on('end', () => {
      clientEnded = true;
    });
    sock.on('close', () => {
      sockets.delete(sock);
      resolveGot({ raw, clientEnded });
    });
  });
  cleanups.push(() => {
    for (const sock of sockets) {
      sock.destroy();
    }
    return new Promise<void>((resolve) => fake.close(() => resolve()));
  });
  return new Promise((resolve, reject) => {
    fake.once('error', reject);
    fake.listen(0, '127.0.0.1', () => {
      resolve({ port: (fake.address() as net.AddressInfo).port, received });
    });
  });
}

/** 类型守卫：Print 消息 */
const isPrint = (
  m: InboundMessage,
): m is Extract<InboundMessage, { messageID: typeof InboundId.Print }> =>
  m.messageID === InboundId.Print;
/** 类型守卫：ObjectCreated 消息 */
const isObjectCreated = (
  m: InboundMessage,
): m is Extract<InboundMessage, { messageID: typeof InboundId.ObjectCreated }> =>
  m.messageID === InboundId.ObjectCreated;

describe('EditorServer（构造参数注入随机端口）', () => {
  it('模拟 TTS 连接发送单条消息：message 事件触发并存入留存', async () => {
    const { server: es, port } = await startEditor();
    const got = new Promise<InboundMessage>((resolve) => es.on('message', resolve));
    await sendJson(port, { messageID: InboundId.Print, message: '你好，TTS' });
    const msg = await got;
    expect(msg).toEqual({ messageID: InboundId.Print, message: '你好，TTS' });
    expect(es.getAll().length).toBe(1);
  });

  it('留存只增不删：发 3 条消息后 getAll().length === 3，waitFor 重复命中不消费', async () => {
    const { server: es, port } = await startEditor();
    const got3 = new Promise<InboundMessage[]>((resolve) => {
      const arr: InboundMessage[] = [];
      es.on('message', (m) => {
        arr.push(m);
        if (arr.length === 3) resolve(arr);
      });
    });
    await sendJson(port, { messageID: InboundId.Print, message: '第1条' });
    await sendJson(port, { messageID: InboundId.Print, message: '第2条' });
    await sendJson(port, { messageID: InboundId.ObjectCreated, guid: 'obj-1' });
    expect((await got3).length).toBe(3);
    expect(es.getAll().length).toBe(3);
    // waitFor 命中留存列表：多次调用都立即返回同一条消息，且留存不减少
    const first = await es.waitFor(isPrint, 1000);
    expect(first.message).toBe('第1条');
    const again = await es.waitFor(isPrint, 1000);
    expect(again.message).toBe('第1条');
    expect(es.find(isPrint).length).toBe(2);
    expect(es.getAll().length).toBe(3);
  });

  it('waitFor 命中已留存消息时立即返回（不等超时）', async () => {
    const { server: es, port } = await startEditor();
    await sendJson(port, { messageID: InboundId.Print, message: '已留存' });
    await vi.waitFor(() => expect(es.getAll().length).toBe(1));
    const begin = Date.now();
    const msg = await es.waitFor(isPrint, 5000);
    expect(Date.now() - begin).toBeLessThan(5000);
    expect(msg.message).toBe('已留存');
  });

  it('waitFor 能等到尚未到达的新消息', async () => {
    const { server: es, port } = await startEditor();
    const pending = es.waitFor(isObjectCreated, 3000);
    // 先注册等待，100ms 后才推送消息
    setTimeout(() => {
      void sendJson(port, { messageID: InboundId.ObjectCreated, guid: 'new-obj' });
    }, 100);
    const msg = await pending;
    expect(msg.guid).toBe('new-obj');
  });

  it('waitFor 超时抛错，文案为中文且含毫秒数', async () => {
    const { server: es } = await startEditor();
    await expect(es.waitFor(() => false, 120)).rejects.toThrow('等待消息超时（120ms）');
  });

  it('close() 释放端口：同端口可再次 start 成功', async () => {
    const { server: es, port } = await startEditor();
    await es.close();
    const es2 = new EditorServer(port);
    cleanups.push(() => es2.close());
    await expect(es2.start()).resolves.toBeUndefined();
  });

  it('非法 JSON 与未知 messageID 不入留存、不崩溃，后续消息仍可接收（错误处理）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { server: es, port } = await startEditor();
    await sendRaw(port, '这不是JSON');
    await sendJson(port, { messageID: 999, junk: true });
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(2));
    expect(es.getAll().length).toBe(0);
    // 服务器仍然存活，正常消息继续接收
    const got = new Promise<InboundMessage>((resolve) => es.on('message', resolve));
    await sendJson(port, { messageID: InboundId.Print, message: '仍可用' });
    expect((await got).message).toBe('仍可用');
  });

  it('同端口第二个实例 start 抛 PortInUseError（含端口号与占用 PID）', async () => {
    const { server: es, port } = await startEditor();
    const es2 = new EditorServer(port);
    await expect(es2.start()).rejects.toMatchObject({
      name: 'PortInUseError',
      port,
      pid: process.pid,
    });
  }, 15_000);
});

describe('sendToTts（随机端口假 TTS 接收端）', () => {
  it('把消息以 JSON 发给假 TTS，且发送完立即主动关闭连接（连 → 写 → 关）', async () => {
    const { port, received } = await startFakeTts();
    const msg = {
      messageID: OutboundId.ExecuteLua,
      guid: GLOBAL_GUID,
      script: 'return 1+1',
      returnID: 42,
    };
    await sendToTts(msg, { port });
    const { raw, clientEnded } = await received;
    expect(JSON.parse(raw)).toEqual(msg);
    // 客户端写完即 end()，服务端应收到 FIN
    expect(clientEnded).toBe(true);
  });

  it('目标端口无人监听时抛 ECONNREFUSED 中文错误（错误处理）', async () => {
    const port = await grabFreePort();
    await expect(sendToTts({ messageID: OutboundId.GetScripts }, { port })).rejects.toThrow(
      `无法连接 TTS（127.0.0.1:${port}）。请确认游戏已启动并加载了存档。`,
    );
  });

  it('host 与 port 均可注入（依赖注入验证）', async () => {
    const { port, received } = await startFakeTts();
    const msg = { messageID: OutboundId.GetScripts };
    await sendToTts(msg, { host: '127.0.0.1', port });
    const { raw } = await received;
    expect(JSON.parse(raw)).toEqual({ messageID: 0 });
  });
});
