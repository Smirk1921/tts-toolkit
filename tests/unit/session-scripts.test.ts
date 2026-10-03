// tests/unit/session-scripts.test.ts
/**
 * src/session/scripts.ts 单元测试。
 *
 * 不依赖运行中的 TTS：
 * - 被测 EditorServer 注入随机端口；
 * - 用 net.createServer 在随机端口起"假 TTS"，收 GetScripts / SaveAndPlay 后
 *   连回编辑器端口回推 GameLoaded（真实 TCP 往返）；
 * - sendToTts 通过 vi.mock 仅注入 host/port 覆盖，出站路径仍走真实实现。
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
import { SessionScripts, type ScriptState } from '../../src/session/scripts.js';

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
    const socket = net.createConnection({ host: '127.0.0.1', port: this.editorPort });
    socket.on('error', () => {}); // 编辑器已关闭等场景不击穿测试进程
    socket.end(JSON.stringify(m), 'utf8');
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
        // 套件关闭后到达的残包 / 不合法消息：忽略
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

describe('SessionScripts.getScripts（假 TTS 真实 TCP 往返）', () => {
  it('发送 messageID 0，并返回新回推的 scriptStates（name/guid/script/ui 原样保留）', async () => {
    const wire = [
      { name: 'Global', guid: '-1', script: 'print(1)', ui: '<Panel/>', },
      { name: 'Deck', guid: 'aabbcc', script: '--deck script' },
    ];
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.GetScripts) return;
      push({ messageID: InboundId.GameLoaded, scriptStates: wire });
    };
    const scripts = new SessionScripts(editor);
    const got = await scripts.getScripts(3000);
    expect(fakeTts.received.length).toBe(1);
    expect(fakeTts.received[0]).toMatchObject({ messageID: OutboundId.GetScripts });
    expect(got).toEqual(wire);
  });

  it('缺 ui 字段的 scriptState 原样保留（ui 为 undefined，不做补全或丢弃）', async () => {
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.GetScripts) return;
      push({
        messageID: InboundId.GameLoaded,
        scriptStates: [{ name: 'Card', guid: 'ff01', script: '--s' }],
      });
    };
    const scripts = new SessionScripts(editor);
    const got = await scripts.getScripts(3000);
    expect(got.length).toBe(1);
    expect(got[0].name).toBe('Card');
    expect(got[0].guid).toBe('ff01');
    expect(got[0].script).toBe('--s');
    expect(got[0].ui).toBeUndefined();
  });

  it('发出请求前已留存的 GameLoaded 被忽略（不返回旧快照）', async () => {
    // 请求前推送一条"旧"GameLoaded
    fakeTts.pushToEditor({
      messageID: InboundId.GameLoaded,
      scriptStates: [{ name: '旧存档对象', guid: 'old1', script: '--old', ui: '<Old/>' }],
    });
    // 必须等到"这一条"（guid old1）确实入库：此前用例已留存过其他 GameLoaded，
    // 泛匹配会提前返回，导致旧消息在快照之后才到达、被误判为"新回推"
    await waitRetained(
      editor,
      (m) => m.messageID === InboundId.GameLoaded && m.scriptStates.some((s) => s.guid === 'old1'),
    );
    const wire = [{ name: '新存档对象', guid: 'new1', script: '--new', ui: '<New/>' }];
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.GetScripts) return;
      push({ messageID: InboundId.GameLoaded, scriptStates: wire });
    };
    const scripts = new SessionScripts(editor);
    const got = await scripts.getScripts(3000);
    expect(got).toEqual(wire); // 只含请求之后新回推的那一份
    expect(got.some((s) => s.guid === 'old1')).toBe(false);
  });

  it('假 TTS 不回推 → 按传入超时抛「等待消息超时」', async () => {
    fakeTts.onMessage = () => {}; // 装死
    const scripts = new SessionScripts(editor);
    const err = await scripts.getScripts(200).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('等待消息超时（200ms）');
  });
});

describe('SessionScripts.saveAndPlay', () => {
  it('发送 messageID 1 与完整 scriptStates，并等待 GameLoaded 回推完成', async () => {
    const states: ScriptState[] = [
      { name: 'Global', guid: '-1', script: 'print(2)', ui: '<Panel/>' },
      { name: 'Deck', guid: 'aabbcc', script: '--updated', ui: '' },
    ];
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.SaveAndPlay) return;
      // 入站 GameLoaded 的 scriptState 必须携带 script（协议实测总会携带），
      // 回推内容与本用例断言无关，补齐为合法字段即可
      push({
        messageID: InboundId.GameLoaded,
        scriptStates: states.map((s) => ({ ...s, script: s.script ?? '--reload' })),
      });
    };
    const scripts = new SessionScripts(editor);
    await expect(scripts.saveAndPlay(states, 3000)).resolves.toBeUndefined();
    expect(fakeTts.received.length).toBe(1);
    expect(fakeTts.received[0]).toMatchObject({ messageID: OutboundId.SaveAndPlay });
    expect(
      (fakeTts.received[0] as { scriptStates: ScriptState[] }).scriptStates,
    ).toEqual(states);
  });

  it('script/ui 缺省的出站消息原样透传（对应官方「缺省即删除」语义）', async () => {
    const states: ScriptState[] = [{ name: 'Card', guid: 'ff02' }]; // 故意缺 script 与 ui
    fakeTts.onMessage = (msg, push) => {
      if (msg.messageID !== OutboundId.SaveAndPlay) return;
      // 入站 GameLoaded 的 scriptState 按协议要求必须携带 script（实测总会携带），
      // 因此回推用合法的完整字段；"缺省透传"的断言只针对出站方向
      push({
        messageID: InboundId.GameLoaded,
        scriptStates: [{ name: 'Card', guid: 'ff02', script: '--reload', ui: '<Panel/>' }],
      });
    };
    const scripts = new SessionScripts(editor);
    await expect(scripts.saveAndPlay(states, 3000)).resolves.toBeUndefined();
    const sent = fakeTts.received[fakeTts.received.length - 1] as { scriptStates: ScriptState[] };
    expect(sent.scriptStates.length).toBe(1);
    expect(sent.scriptStates[0]).toEqual({ name: 'Card', guid: 'ff02' });
    expect('script' in sent.scriptStates[0] && sent.scriptStates[0].script !== undefined).toBe(false);
    expect('ui' in sent.scriptStates[0] && sent.scriptStates[0].ui !== undefined).toBe(false);
  });

  it('假 TTS 不回推 GameLoaded → 按传入超时抛「等待消息超时」', async () => {
    fakeTts.onMessage = () => {}; // 装死
    const scripts = new SessionScripts(editor);
    const err = await scripts
      .saveAndPlay([{ name: 'Global', guid: '-1', script: '', ui: '' }], 200)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('等待消息超时（200ms）');
  });
});

describe('SessionScripts 类型导出（编译期检查）', () => {
  it('导出 ScriptState 类型且 script / ui 可缺省（saveAndPlay 删除警告的类型前提）', () => {
    // 编译通过即代表类型导出存在且字段可选；缺省 script/ui 在协议中意味着删除
    const minimal: ScriptState = { name: 'Global', guid: '-1' };
    expect(minimal.script).toBeUndefined();
    expect(minimal.ui).toBeUndefined();
    const full: ScriptState = { name: 'Global', guid: '-1', script: '--', ui: '<Panel/>' };
    expect(full.script).toBe('--');
    expect(full.ui).toBe('<Panel/>');
  });
});
