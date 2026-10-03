// tests/unit/session-exec.test.ts
/**
 * src/session/exec.ts 单元测试。
 *
 * 不依赖运行中的 TTS：
 * - 被测 EditorServer 注入随机端口（EditorServer 构造参数支持端口覆盖）；
 * - 用 net.createServer 在随机端口起"假 TTS"，收 ExecuteLua 后按场景用
 *   net.createConnection 连回编辑器端口推送 ReturnValue / Error（真实 TCP 往返）；
 * - sendToTts 通过 vi.mock 仅注入 host/port 覆盖，连接/写入/关闭逻辑仍走真实实现。
 */
import net from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** 假 TTS 端点（vi.hoisted 保证在 mock 工厂中可用；beforeAll 时填入随机端口）。 */
const fakeEndpoint = vi.hoisted(() => ({ host: '127.0.0.1', port: 0 }));

// 包装真实 sendToTts：只注入假 TTS 的 host/port，出站 TCP 路径完全走真实实现
vi.mock('../../src/protocol/tts-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/protocol/tts-client.js')>();
  const realSendToTts = actual.sendToTts;
  return {
    ...actual,
    sendToTts: (
      msg: Parameters<typeof realSendToTts>[0],
      opts?: Parameters<typeof realSendToTts>[1],
    ) => realSendToTts(msg, { ...opts, host: fakeEndpoint.host, port: fakeEndpoint.port }),
  };
});

import { EditorServer } from '../../src/protocol/editor-server.js';
import {
  InboundId,
  OutboundId,
  outboundSchema,
  type InboundMessage,
  type OutboundMessage,
} from '../../src/protocol/messages.js';
import { LuaError, SessionExec } from '../../src/session/exec.js';
import { luaScanUrlsInObject } from '../../src/session/lua.js';

/** 取一个当前空闲的 TCP 端口（探测后立即释放；给 EditorServer 注入用）。 */
async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen({ port: 0, host: '127.0.0.1' }, () => {
      const addr = probe.address();
      if (addr === null || typeof addr === 'string') {
        probe.close(() => reject(new Error('无法获取随机端口。')));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 假 TTS：监听随机端口接收出站消息（真实 TCP，每条连接一条 JSON、连 → 写 → 关），
 * 按各用例注入的场景脚本（onMessage）向编辑器端口回推入站消息。
 */
class FakeTts {
  private server: net.Server | undefined;
  private readonly inbox: OutboundMessage[] = [];
  /** 场景脚本：收到一条出站消息时如何回推；push 向编辑器推送一条入站消息。 */
  onMessage: (msg: OutboundMessage, push: (m: InboundMessage) => void) => void = () => {};
  private editorPort = 0;

  /** 已收到的出站消息（按到达顺序）。 */
  get received(): readonly OutboundMessage[] {
    return this.inbox;
  }

  /** 假 TTS 监听的随机端口；未启动时抛错。 */
  get port(): number {
    const addr = this.server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') {
      throw new Error('假 TTS 未启动或尚未监听。');
    }
    return addr.port;
  }

  /** 在随机端口启动；editorPort 是被测 EditorServer 的端口（回推目标）。 */
  async start(editorPort: number): Promise<void> {
    this.editorPort = editorPort;
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer((socket) => this.handleConnection(socket));
      this.server = srv;
      srv.once('error', reject);
      srv.listen({ port: 0, host: '127.0.0.1' }, () => resolve());
    });
  }

  /** 模拟 TTS 推送一条入站消息：主动连接编辑器端口，连 → 写 → 关。 */
  pushToEditor(m: InboundMessage): void {
    this.pushRawToEditor(JSON.stringify(m));
  }

  /** 同 {@link pushToEditor}，但发送原始 JSON 文本（用于构造 2.0 这类 JSON 字面量）。 */
  pushRawToEditor(payload: string): void {
    const socket = net.createConnection({ host: '127.0.0.1', port: this.editorPort });
    socket.on('error', () => {}); // 编辑器已关闭等场景不击穿测试进程
    socket.end(payload, 'utf8');
  }

  /** 清空已收到的出站消息（beforeEach 用）。 */
  reset(): void {
    this.inbox.length = 0;
  }

  async close(): Promise<void> {
    const srv = this.server;
    if (srv === undefined) return;
    this.server = undefined;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  private handleConnection(socket: net.Socket): void {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (raw.length === 0) return;
        // 顺带校验：会话层发出的必须是通过协议 schema 的合法出站消息
        const msg = outboundSchema.parse(JSON.parse(raw));
        this.inbox.push(msg);
        this.onMessage(msg, (m) => this.pushToEditor(m));
      } catch {
        // 套件关闭后到达的残包 / 不合法消息：忽略，不让异步回调击穿测试
      }
    });
  }
}

let editor: EditorServer;
let fakeTts: FakeTts;

beforeAll(
  async () => {
    const editorPort = await getFreePort();
    editor = new EditorServer(editorPort); // 构造参数覆盖端口（测试注入）
    await editor.start();
    fakeTts = new FakeTts();
    await fakeTts.start(editorPort);
    fakeEndpoint.host = '127.0.0.1';
    fakeEndpoint.port = fakeTts.port;
  },
  10_000,
);

afterAll(async () => {
  await fakeTts.close();
  await editor.close();
});

beforeEach(() => {
  fakeTts.onMessage = () => {};
  fakeTts.reset();
});

/** 等待编辑器留存列表中出现匹配谓词的消息（假 TTS 推送是异步到达的）。 */
async function waitRetained(
  srv: EditorServer,
  pred: (m: InboundMessage) => boolean,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(srv.find(pred).length).toBeGreaterThan(0);
    },
    { timeout: 2000, interval: 20 },
  );
}

/** 执行并捕获异常（供精确断言错误类型与 message）。 */
async function execError(p: Promise<unknown>): Promise<unknown> {
  return await p.then(
    () => null,
    (e: unknown) => e,
  );
}

describe('SessionExec.exec（假 TTS 真实 TCP 往返）', () => {
  it('发送 ExecuteLua：returnID 从 1 自增、guid 默认 "-1"，返回值按 returnID 匹配', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      // 按脚本内容回推不同的值，证明两次执行各自拿到自己的返回值
      const value = msg.script === 'return 5' ? 5 : 6;
      push({ messageID: InboundId.ReturnValue, returnValue: value, returnID: msg.returnID });
    };
    const exec = new SessionExec(editor);
    await expect(exec.exec('return 5')).resolves.toBe(5);
    await expect(exec.exec('return 6')).resolves.toBe(6);
    expect(fakeTts.received.length).toBe(2);
    expect(fakeTts.received[0]).toMatchObject({
      messageID: OutboundId.ExecuteLua,
      guid: '-1',
      script: 'return 5',
      returnID: 1,
    });
    expect(fakeTts.received[1]).toMatchObject({
      messageID: OutboundId.ExecuteLua,
      guid: '-1',
      script: 'return 6',
      returnID: 2,
    });
  });

  it('returnID 匹配：returnID 不符的返回值不会被采纳', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      // 先回推一条 returnID 不符的旧值，再回推正确的
      push({ messageID: InboundId.ReturnValue, returnValue: 'wrong', returnID: 999 });
      setTimeout(
        () => push({ messageID: InboundId.ReturnValue, returnValue: 'right', returnID: msg.returnID }),
        30,
      );
    };
    const exec = new SessionExec(editor);
    await expect(exec.exec('return "right"')).resolves.toBe('right');
  });

  it('guid 参数透传到出站消息', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      push({ messageID: InboundId.ReturnValue, returnValue: 'ok', returnID: msg.returnID });
    };
    const exec = new SessionExec(editor);
    await expect(exec.exec("return 'ok'", { guid: 'abc123' })).resolves.toBe('ok');
    expect(fakeTts.received[fakeTts.received.length - 1]).toMatchObject({ guid: 'abc123' });
  });

  it('数字整形：TTS 回传 JSON 字面量 2.0 → 得到整数 2', async () => {
    fakeTts.onMessage = (msg) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      fakeTts.pushRawToEditor(
        `{"messageID":${InboundId.ReturnValue},"returnValue":2.0,"returnID":${msg.returnID}}`,
      );
    };
    const exec = new SessionExec(editor);
    const r = await exec.exec('return 1+1');
    expect(r).toBe(2);
    expect(Number.isInteger(r)).toBe(true);
  });

  it('非整数浮点不截断：2.5 保持 2.5', async () => {
    fakeTts.onMessage = (msg) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      fakeTts.pushRawToEditor(
        `{"messageID":${InboundId.ReturnValue},"returnValue":2.5,"returnID":${msg.returnID}}`,
      );
    };
    const exec = new SessionExec(editor);
    await expect(exec.exec('return 2.5')).resolves.toBe(2.5);
  });

  it('returnValue 为 null（Lua return nil）→ 返回 null', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      push({ messageID: InboundId.ReturnValue, returnValue: null, returnID: msg.returnID });
    };
    const exec = new SessionExec(editor);
    await expect(exec.exec('return nil')).resolves.toBe(null);
  });

  it('多返回值异常形态 { ReferenceID, Type } → 抛指定中文错误', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      push({
        messageID: InboundId.ReturnValue,
        returnValue: { ReferenceID: 6941666, Type: 3 },
        returnID: msg.returnID,
      });
    };
    const exec = new SessionExec(editor);
    const err = await execError(exec.exec('return 1, 2'));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      '检测到 Lua 多返回值。TTS 协议不支持 return 1, 2，请改用 return JSON.encode({...})',
    );
  });

  it('超时且无任何 Error 消息 → 抛「执行超时」中文错误（table 静默失败 / 端口劫持）', async () => {
    fakeTts.onMessage = () => {}; // 假 TTS 装死：什么都不回推
    const exec = new SessionExec(editor);
    const startedAt = Date.now();
    const err = await execError(exec.exec('return {1,2,3}', { timeoutMs: 300 }));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      '执行超时。可能原因：1) Lua 返回了 table（协议不支持，会被静默丢弃）；2) 端口 39998 被劫持',
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(280); // 确实等满了超时
  });

  it('超时前收到 Error 消息 → 立即抛 LuaError，行列号从 error 中解析正确', async () => {
    fakeTts.onMessage = (msg) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      setTimeout(() => {
        fakeTts.pushToEditor({
          messageID: InboundId.Error,
          guid: '-1',
          errorMessagePrefix: 'Error in Global Script: ',
          error: "chunk_0:(36,4-8): unexpected symbol near 'deck'",
        });
      }, 20);
    };
    const exec = new SessionExec(editor);
    const err = await execError(exec.exec('deck = 1', { timeoutMs: 5000 }));
    expect(err).toBeInstanceOf(LuaError);
    const luaErr = err as LuaError;
    expect(luaErr.guid).toBe('-1');
    expect(luaErr.prefix).toBe('Error in Global Script: ');
    expect(luaErr.line).toBe(36);
    expect(luaErr.col).toBe(4);
    expect(luaErr.endCol).toBe(8);
    expect(luaErr.message).toContain("unexpected symbol near 'deck'");
  });

  it('Error 消息不含行列号 → line/col/endCol 为 undefined', async () => {
    fakeTts.onMessage = (msg) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      setTimeout(() => {
        fakeTts.pushToEditor({
          messageID: InboundId.Error,
          guid: '-1',
          errorMessagePrefix: '[Global] ',
          error: 'attempt to call a nil value',
        });
      }, 20);
    };
    const exec = new SessionExec(editor);
    const err = await execError(exec.exec('nope()', { timeoutMs: 3000 }));
    expect(err).toBeInstanceOf(LuaError);
    const luaErr = err as LuaError;
    expect(luaErr.line).toBeUndefined();
    expect(luaErr.col).toBeUndefined();
    expect(luaErr.endCol).toBeUndefined();
  });

  it('其他 guid 的 Error 消息不干扰本次执行', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      setTimeout(() => {
        fakeTts.pushToEditor({
          messageID: InboundId.Error,
          guid: 'other',
          errorMessagePrefix: 'E: ',
          error: 'x:(1,1-1): unrelated',
        });
      }, 10);
      setTimeout(
        () => push({ messageID: InboundId.ReturnValue, returnValue: 'ok', returnID: msg.returnID }),
        80,
      );
    };
    const exec = new SessionExec(editor);
    await expect(exec.exec("return 'ok'", { guid: 'mine', timeoutMs: 3000 })).resolves.toBe('ok');
  });

  it('发出请求前已留存的 Error 消息不会触发 LuaError（时间早于 returnID 发出）', async () => {
    fakeTts.pushToEditor({
      messageID: InboundId.Error,
      guid: '-1',
      errorMessagePrefix: '[old] ',
      error: 'old:(1,1-1): stale error from previous run',
    });
    // 必须等到"这一条"Error 确实入库（此前用例已留存过其他 Error，泛匹配会提前返回）
    await waitRetained(
      editor,
      (m) => m.messageID === InboundId.Error && m.error.includes('stale error from previous run'),
    );
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      setTimeout(
        () => push({ messageID: InboundId.ReturnValue, returnValue: 7, returnID: msg.returnID }),
        20,
      );
    };
    const exec = new SessionExec(editor);
    await expect(exec.exec('return 7', { timeoutMs: 3000 })).resolves.toBe(7);
  });
});

describe('SessionExec.execJson（自动 JSON 包装与解析）', () => {
  it('"return 1+1" → 实际发送 "return JSON.encode(1+1)" 并解析为 2', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      push({ messageID: InboundId.ReturnValue, returnValue: '2', returnID: msg.returnID });
    };
    const exec = new SessionExec(editor);
    await expect(exec.execJson('return 1+1')).resolves.toBe(2);
    expect(fakeTts.received[fakeTts.received.length - 1]).toMatchObject({
      messageID: OutboundId.ExecuteLua,
      script: 'return JSON.encode(1+1)',
    });
  });

  it('"return {a=1}" → 实际发送 "return JSON.encode({a=1})" 并解析为对象', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      push({ messageID: InboundId.ReturnValue, returnValue: '{"a":1}', returnID: msg.returnID });
    };
    const exec = new SessionExec(editor);
    await expect(exec.execJson('return {a=1}')).resolves.toEqual({ a: 1 });
    expect(fakeTts.received[fakeTts.received.length - 1]).toMatchObject({
      script: 'return JSON.encode({a=1})',
    });
  });

  it('"1+1"（无 return）→ 整体作为表达式包装为 "return JSON.encode(1+1)"', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      push({ messageID: InboundId.ReturnValue, returnValue: '2', returnID: msg.returnID });
    };
    const exec = new SessionExec(editor);
    await expect(exec.execJson('1+1')).resolves.toBe(2);
    expect(fakeTts.received[fakeTts.received.length - 1]).toMatchObject({
      script: 'return JSON.encode(1+1)',
    });
  });

  it('"returnx = 1" 不以 return 关键字开头 → 按表达式分支整体包装（\\b 边界）', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      push({ messageID: InboundId.ReturnValue, returnValue: '1', returnID: msg.returnID });
    };
    const exec = new SessionExec(editor);
    await expect(exec.execJson('returnx = 1')).resolves.toBe(1);
    expect(fakeTts.received[fakeTts.received.length - 1]).toMatchObject({
      script: 'return JSON.encode(returnx = 1)',
    });
  });

  it('多语句立即执行函数片段：return 之后的部分原样保留为表达式', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      push({ messageID: InboundId.ReturnValue, returnValue: '42', returnID: msg.returnID });
    };
    const exec = new SessionExec(editor);
    await expect(exec.execJson('return (function() return 42 end)()')).resolves.toBe(42);
    expect(fakeTts.received[fakeTts.received.length - 1]).toMatchObject({
      script: 'return JSON.encode((function() return 42 end)())',
    });
  });

  it('TTS 回传 JSON 字符串 → JSON.parse 还原嵌套结构', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      push({
        messageID: InboundId.ReturnValue,
        returnValue: '[{"path":"-1.MeshURL","url":"https://x/y.png"}]',
        returnID: msg.returnID,
      });
    };
    const exec = new SessionExec(editor);
    await expect(exec.execJson<Array<{ path: string; url: string }>>(luaScanUrlsInObject())).resolves.toEqual([
      { path: '-1.MeshURL', url: 'https://x/y.png' },
    ]);
  });

  it('TTS 回传非 JSON 字符串 → 抛「JSON.parse 失败：<原文>」', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      push({ messageID: InboundId.ReturnValue, returnValue: 'nil', returnID: msg.returnID });
    };
    const exec = new SessionExec(editor);
    const err = await execError(exec.execJson('nil'));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('JSON.parse 失败：nil');
  });

  it('TTS 回传非字符串（意外形态）→ 同样抛「JSON.parse 失败：…」', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.ExecuteLua) return;
      push({ messageID: InboundId.ReturnValue, returnValue: null, returnID: msg.returnID });
    };
    const exec = new SessionExec(editor);
    const err = await execError(exec.execJson('broken'));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('JSON.parse 失败：null');
  });
});
