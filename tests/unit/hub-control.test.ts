// tests/unit/hub-control.test.ts
/**
 * src/hub/control.ts（S2 控制通道）单元测试。
 *
 * 覆盖场景（对应任务 C1 清单第 3 条）：直接用 HubDaemon + createControlServer
 * 起 daemon 与控制通道（不经 lifecycle），用 fetch 打路由：
 * - 12 条路由的 200 / 400 / 404 / 405 分类（415 顺带覆盖）；
 * - HUB_CONFIRM_REQUIRED：POST /v1/push 不带 confirm:true → 400；
 * - PackError 透传：/v1/diff 对无 pack.yaml 的目录 → 400 HUB_PACK_ERROR +
 *   details.packCode === "PACK_NOT_FOUND"（/v1/deck/plan 非法规则 → PLAN_RULE_INVALID）；
 * - GET /v1/events SSE：建立连接 → daemon.fanout 扇出 → 收到 data: 行；
 *   不在 SSE 转发集合的消息（ReturnValue）不产生 data: 行。
 *
 * 端口约束：daemon 三端口用 listen(0) 抢占的临时端口（daemon 不暴露实绑端口，
 * 见 hub-daemon.test.ts 头注释）；控制通道用 port=0 由操作系统分配并经
 * boundPort() 读回。绝不绑定真实 39995-39999。资源在 afterEach 全部关闭。
 */
import net, { type AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { HubDaemon } from '../../src/hub/daemon.js';
import { createControlServer, type ControlServer } from '../../src/hub/control.js';
import { InboundId, type InboundMessage } from '../../src/protocol/messages.js';

/** afterEach 统一执行的清理动作（停 control / 停 daemon） */
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    await fn();
  }
  cleanups.length = 0;
});

/** 已启动的 daemon + 控制通道栈 */
interface RunningStack {
  daemon: HubDaemon;
  control: ControlServer;
  /** 控制通道基础 URL（http://127.0.0.1:<port>/v1） */
  base: string;
  /** /v1/hub/shutdown 触发的 onShutdown 调用次数 */
  shutdownCalls: { count: number };
  /** 编辑器入站端口（模拟 TTS 推送用） */
  editorPort: number;
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
 * 启动 daemon（随机空闲端口）+ 控制通道（port=0 由操作系统分配）。
 * 端口恰被占用时换端口重试（最多 5 次）。
 * @returns 运行中的栈（base URL / onShutdown 计数 / 编辑器端口）
 */
async function startStack(): Promise<RunningStack> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const editorPort = await grabFreePort();
    const tcpPort = await grabFreePort();
    const wsPort = await grabFreePort();
    const daemon = new HubDaemon({ editorPort, tcpPort, wsPort, log: () => undefined });
    const shutdownCalls = { count: 0 };
    const control = createControlServer(daemon, {
      port: 0, // 操作系统分配；boundPort() 读回
      log: () => undefined,
      onShutdown: async () => {
        shutdownCalls.count += 1;
      },
    });
    try {
      await daemon.start();
      try {
        await control.start();
      } catch (err) {
        await daemon.stop();
        throw err;
      }
    } catch (err) {
      lastErr = err;
      continue;
    }
    cleanups.push(() => control.stop());
    cleanups.push(() => daemon.stop());
    return { daemon, control, base: `http://127.0.0.1:${control.boundPort()}/v1`, shutdownCalls, editorPort };
  }
  throw lastErr;
}

/** 便捷 GET，返回原始 Response */
const get = (base: string, pathname: string): Promise<Response> => fetch(`${base}${pathname}`);

/** 便捷 POST JSON，返回原始 Response */
const postJson = (base: string, pathname: string, body: unknown): Promise<Response> =>
  fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 便捷 POST（不带 Content-Type），返回原始 Response */
const postRaw = (base: string, pathname: string, body: string): Promise<Response> =>
  fetch(`${base}${pathname}`, { method: 'POST', body });

/** 断言统一错误响应体形状并取 error 字段 */
function expectErrorBody(status: number, body: unknown, code: string): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  expect(status).toBeGreaterThanOrEqual(400);
  expect(status).toBeLessThan(500);
  const err = (body as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })
    .error;
  expect(err?.code).toBe(code);
  expect(typeof err?.message).toBe('string');
  return { code: err?.code ?? '', message: err?.message ?? '', details: err?.details };
}

describe('GET /v1/status 与 /v1/packs（200 路由）', () => {
  it('GET /v1/status：200，hub.editor 为 true，tts.connected 为布尔值', async () => {
    const { base } = await startStack();
    const res = await get(base, '/status');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body: unknown = await res.json();
    const status = body as {
      ok?: boolean;
      hub?: { editor?: boolean; startedAt?: number };
      tts?: { connected?: boolean };
    };
    expect(status.ok).toBe(true);
    expect(status.hub?.editor).toBe(true);
    expect(typeof status.hub?.startedAt).toBe('number');
    expect(typeof status.tts?.connected).toBe('boolean'); // 探测失败不是路由错误，仍 200
  });

  it('GET /v1/packs：.registry.yaml 不存在时 200 容错返回（packs 数组）', async () => {
    const { base } = await startStack();
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'tts-control-packs-'));
    const res = await get(base, `/packs?packsRoot=${encodeURIComponent(tmp)}`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(Array.isArray((body as { packs?: unknown[] }).packs)).toBe(true);
  });
});

describe('路由分类：404 / 405 / 415', () => {
  it('未注册路径 → 404 HUB_NOT_FOUND', async () => {
    const { base } = await startStack();
    const res = await get(base, '/nope');
    expect(res.status).toBe(404);
    expectErrorBody(res.status, await res.json(), 'HUB_NOT_FOUND');
  });

  it('POST 打 GET-only 路由 → 405 HUB_METHOD_NOT_ALLOWED（Allow: GET）', async () => {
    const { base } = await startStack();
    const res = await postJson(base, '/status', {});
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expectErrorBody(res.status, await res.json(), 'HUB_METHOD_NOT_ALLOWED');
  });

  it('DELETE 打 POST-only 路由 → 405（Allow: POST）', async () => {
    const { base } = await startStack();
    const res = await fetch(`${base}/exec`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expectErrorBody(res.status, await res.json(), 'HUB_METHOD_NOT_ALLOWED');
  });

  it('POST 缺 Content-Type → 415 HUB_UNSUPPORTED_MEDIA_TYPE', async () => {
    const { base } = await startStack();
    const res = await postRaw(base, '/exec', '{}');
    expect(res.status).toBe(415);
    expectErrorBody(res.status, await res.json(), 'HUB_UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('POST 路由请求侧校验（400 HUB_BAD_REQUEST）', () => {
  const cases: ReadonlyArray<{ route: string; body: unknown }> = [
    { route: '/scripts/pull', body: {} },
    { route: '/scripts/save-and-play', body: {} },
    { route: '/scripts/save-and-play', body: { scriptStates: 'not-an-array' } },
    { route: '/exec', body: {} },
    { route: '/exec', body: { lua: 'print(1)', timeoutMs: -1 } },
    { route: '/assets/check', body: {} },
    { route: '/assets/check', body: { urls: [] } },
    { route: '/deck/slice', body: {} },
    { route: '/deck/slice', body: { sheetPath: 'a', savePath: 'b' } }, // 缺 outDir
    { route: '/deck/plan', body: { savePath: 'x', rules: 'not-an-array' } },
    { route: '/import', body: {} },
    { route: '/diff', body: {} },
    { route: '/push', body: {} }, // 缺 root（confirm 门之前先过 root 必填）
  ];

  for (const { route, body } of cases) {
    it(`POST /v1${route} body=${JSON.stringify(body)} → 400 HUB_BAD_REQUEST`, async () => {
      const { base } = await startStack();
      const res = await postJson(base, route, body);
      expect(res.status).toBe(400);
      expectErrorBody(res.status, await res.json(), 'HUB_BAD_REQUEST');
    });
  }

  it('POST 请求体不是合法 JSON → 400 HUB_BAD_REQUEST', async () => {
    const { base } = await startStack();
    const res = await fetch(`${base}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expectErrorBody(res.status, await res.json(), 'HUB_BAD_REQUEST');
  });
});

describe('HUB_CONFIRM_REQUIRED 与 PackError 透传', () => {
  it('POST /v1/push 带 root 但不带 confirm:true → 400 HUB_CONFIRM_REQUIRED', async () => {
    const { base } = await startStack();
    const res = await postJson(base, '/push', { root: os.tmpdir() });
    expect(res.status).toBe(400);
    expectErrorBody(res.status, await res.json(), 'HUB_CONFIRM_REQUIRED');
  });

  it('POST /v1/push confirm:false → 400 HUB_CONFIRM_REQUIRED', async () => {
    const { base } = await startStack();
    const res = await postJson(base, '/push', { root: os.tmpdir(), confirm: false });
    expect(res.status).toBe(400);
    expectErrorBody(res.status, await res.json(), 'HUB_CONFIRM_REQUIRED');
  });

  it('POST /v1/diff 对无 pack.yaml 的目录 → 400 HUB_PACK_ERROR + details.packCode=PACK_NOT_FOUND', async () => {
    const { base } = await startStack();
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'tts-control-diff-'));
    const res = await postJson(base, '/diff', { root: tmp });
    expect(res.status).toBe(400);
    const err = expectErrorBody(res.status, await res.json(), 'HUB_PACK_ERROR');
    expect(err.details?.packCode).toBe('PACK_NOT_FOUND');
  });

  it('POST /v1/deck/plan 非法规则 → 400 HUB_PACK_ERROR + details.packCode=PLAN_RULE_INVALID', async () => {
    const { base } = await startStack();
    const res = await postJson(base, '/deck/plan', {
      savePath: 'unused-save.json',
      rules: [{ mode: 'no-such-mode' }],
    });
    expect(res.status).toBe(400);
    const err = expectErrorBody(res.status, await res.json(), 'HUB_PACK_ERROR');
    expect(err.details?.packCode).toBe('PLAN_RULE_INVALID');
  });
});

describe('POST /v1/hub/shutdown', () => {
  it('返回 200 {ok:true} 且触发 onShutdown 回调', async () => {
    const { base, shutdownCalls } = await startStack();
    const res = await postJson(base, '/hub/shutdown', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // onShutdown 在响应之后异步触发，轮询等待
    const deadline = Date.now() + 5000;
    while (shutdownCalls.count === 0) {
      if (Date.now() > deadline) {
        throw new Error('onShutdown was not called within 5000ms');
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    expect(shutdownCalls.count).toBe(1);
  });
});

describe('GET /v1/events（SSE）', () => {
  it('建立连接 → 扇出转发集合内的消息收到 data: 行；集合外的不转发', async () => {
    const { daemon, base, editorPort } = await startStack();
    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    const res = await fetch(`${base}/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = sseReader(res);

    const text = await readSseUntil(reader, (t) => t.includes(':connected'));
    expect(text).toContain(':connected');

    // 模拟 TTS 推送一条 Print（在 SSE 转发集合内）→ 走 daemon 扇出 → SSE 收到
    const msg: InboundMessage = { messageID: InboundId.Print, message: 'sse-hello' };
    await ttsPush(editorPort, msg);
    const afterPrint = await readSseUntil(
      reader,
      (t) => t.includes(`data: ${JSON.stringify(msg)}`),
      text,
    );
    expect(afterPrint).toContain(`data: ${JSON.stringify(msg)}`);

    // ReturnValue 不在转发集合：扇出后不得出现新的 data: 行（短窗口读取应超时）
    daemon.fanout.fanout({
      messageID: InboundId.ReturnValue,
      returnValue: 'noise',
      returnID: 42,
    });
    await expect(
      readSseUntil(reader, (t) => t.includes('noise'), afterPrint, 500),
    ).rejects.toThrow(/SSE predicate not met/);

    controller.abort();
  });

  it('daemon.fanout 直接扇出 Print 同样落到 SSE 流', async () => {
    const { daemon, base } = await startStack();
    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    const res = await fetch(`${base}/events`, { signal: controller.signal });
    const reader = sseReader(res);
    await readSseUntil(reader, (t) => t.includes(':connected'));

    const msg: InboundMessage = { messageID: InboundId.Print, message: 'inproc-sse' };
    daemon.fanout.fanout(msg);
    const text = await readSseUntil(reader, (t) => t.includes(`data: ${JSON.stringify(msg)}`));
    expect(text).toContain(`data: ${JSON.stringify(msg)}`);
    controller.abort();
  });
});

/** 模拟 TTS：连编辑器入站端口推一条 JSON 消息后关闭 */
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
 * 为 SSE Response 创建唯一 reader（同一 Response 只能锁一次，多次调用
 * getReader() 会抛 "ReadableStream is locked"）。
 * @param res SSE Response
 * @returns 流 reader
 */
function sseReader(res: Response): ReadableStreamDefaultReader<Uint8Array> {
  const body = res.body;
  if (body === null) {
    throw new Error('SSE response body is null');
  }
  return body.getReader();
}

/**
 * 持续读取 SSE 流直到谓词成立或超时（编辑器入站连接关闭才 dispatch，
 * 写入与到达之间有微小时延，故轮询而不是立即断言）。
 * @param reader 同一 Response 的唯一 reader（见 {@link sseReader}）
 * @param predicate 谓词（对累计文本判定）
 * @param seed 谓词判定的初始文本（此前已读到的内容）
 * @param timeoutMs 超时毫秒数
 * @returns 累计文本
 */
async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  seed = '',
  timeoutMs = 5000,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = seed;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate(text)) {
      return text;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`SSE predicate not met within ${timeoutMs}ms; received: ${text.slice(0, 200)}`);
    }
    let timerId: NodeJS.Timeout | undefined;
    const timer = new Promise<'timeout'>((resolve) => {
      timerId = setTimeout(() => resolve('timeout'), remaining);
    });
    const read = reader.read();
    void read.catch(() => undefined); // 中止竞态下的 unhandled rejection 防护
    const chunk = await Promise.race([read, timer]);
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
    if (chunk === 'timeout') {
      continue;
    }
    if (chunk.done) {
      if (predicate(text)) {
        return text;
      }
      throw new Error(`SSE stream ended before predicate met; received: ${text.slice(0, 200)}`);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}
