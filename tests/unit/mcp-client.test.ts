// tests/unit/mcp-client.test.ts
/**
 * src/mcp/client.ts（HubClient / probeHub）单元测试。
 *
 * 用 stub HTTP 服务（node:http，listen(0) 随机端口）模拟 hub 控制通道：
 * - HubClient 每个方法的请求路径 / 方法 / body 与 12 条 S2 路由一一对应；
 * - 4xx/5xx 标准错误体 → HubError 保留 code / httpStatus / details；
 *   非标准错误体 → HubError(HUB_UNKNOWN)；2xx 非法 JSON → HubError(HUB_UNKNOWN)；
 * - 网络错误（连接拒绝 / 超时中止）→ HubNotRunningError；
 * - probeHub 成功 / 超时（800ms）/ 拒绝连接 三态。
 *
 * 阶段 5 push 升级：push(root, confirm, opts?) 三参（PushOptions 逐项透传、
 * undefined 字段不出现在请求体），定型响应对齐 /v1/push 新形
 * {ok, dryRun, pushed, skipped, items(=pushed+skipped 别名), backupDir?,
 * baselineConflicts?, assetChanges?}——仅强制 ok/dryRun/pushed/skipped，可选
 * 字段原样透传；缺 items 时客户端按 pushed+skipped 补算（向后兼容别名）。
 *
 * 端口约束：stub 服务全部 listen(0) 由操作系统分配；"连接拒绝"场景用
 * listen(0) 抢占后立即释放的端口。绝不绑定真实 39995-39999。
 */
import http, { type RequestListener } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HubClient,
  HubError,
  HubNotRunningError,
  probeHub,
} from '../../src/mcp/client.js';

/** stub 服务收到的一次请求 */
interface StubCall {
  method: string;
  url: string;
  body: string;
  contentType: string | undefined;
}

/** stub 服务的应答 */
interface StubReply {
  status?: number;
  /** JSON 响应体 */
  json?: unknown;
  /** 原始文本响应体（优先于 json） */
  raw?: string;
  /** 响应前的延迟毫秒数（超时测试用） */
  delayMs?: number;
}

/** 运行中的 stub 服务 */
interface RunningStub {
  port: number;
  /** 收到的全部请求（按序） */
  calls: StubCall[];
  /** 当前应答策略（测试内可随时更换） */
  reply: (call: StubCall) => StubReply | Promise<StubReply>;
  close(): Promise<void>;
}

/** afterEach 统一执行的清理动作（关 stub / 销毁探针） */
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    await fn();
  }
  cleanups.length = 0;
});

/**
 * 启动 stub hub 控制通道（listen(0)，操作系统分配端口）。
 * @returns 运行中的 stub（calls / reply / close）
 */
function startStub(): Promise<RunningStub> {
  const calls: StubCall[] = [];
  const state: { reply: (call: StubCall) => StubReply | Promise<StubReply> } = {
    reply: () => ({ json: { ok: true } }),
  };
  const handler: RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      void (async () => {
        const call: StubCall = {
          method: req.method ?? '',
          url: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          contentType: req.headers['content-type'],
        };
        calls.push(call);
        const reply = await state.reply(call);
        if (reply.delayMs !== undefined && reply.delayMs > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, reply.delayMs);
          });
        }
        const payload =
          reply.raw !== undefined
            ? Buffer.from(reply.raw, 'utf8')
            : Buffer.from(JSON.stringify(reply.json ?? null), 'utf8');
        res.writeHead(reply.status ?? 200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(payload.length),
        });
        res.end(payload);
      })();
    });
    req.on('error', () => undefined);
  };
  return new Promise<RunningStub>((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const addr = server.address();
      if (addr === null || typeof addr !== 'object') {
        reject(new Error(`unexpected stub address: ${String(addr)}`));
        return;
      }
      const port = (addr as AddressInfo).port;
      const stub: RunningStub = {
        port,
        calls,
        get reply() {
          return state.reply;
        },
        set reply(value: (call: StubCall) => StubReply | Promise<StubReply>) {
          state.reply = value;
        },
        close: () =>
          new Promise<void>((resolveClose) => {
            server.closeAllConnections();
            server.close(() => resolveClose());
          }),
      };
      cleanups.push(() => stub.close());
      resolve(stub);
    });
  });
}

/**
 * 用 listen(0) 向操作系统抢占一个空闲临时端口后立即释放（"连接拒绝"场景）。
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

/** 取最近一次请求的便捷方法 */
function lastCall(stub: RunningStub): StubCall {
  const call = stub.calls.at(-1);
  if (call === undefined) {
    throw new Error('stub received no requests');
  }
  return call;
}

describe('HubClient：请求路径 / 方法 / body 契约', () => {
  it('status() → GET /v1/status，定型返回 {ok, hub, tts}', async () => {
    const stub = await startStub();
    stub.reply = () => ({
      json: { ok: true, hub: { uptimeMs: 1, startedAt: 2 }, tts: { connected: false } },
    });
    const client = new HubClient({ port: stub.port });
    const result = await client.status();
    const call = lastCall(stub);
    expect(call.method).toBe('GET');
    expect(call.url).toBe('/v1/status');
    expect(result).toEqual({
      ok: true,
      hub: { uptimeMs: 1, startedAt: 2 },
      tts: { connected: false },
    });
  });

  it('status() 透传 tts.version / tts.objects 可选字段', async () => {
    const stub = await startStub();
    stub.reply = () => ({
      json: {
        ok: true,
        hub: { uptimeMs: 1, startedAt: 2 },
        tts: { connected: true, version: 'v1.0', objects: 7 },
      },
    });
    const client = new HubClient({ port: stub.port });
    const result = await client.status();
    expect(result.tts).toEqual({ connected: true, version: 'v1.0', objects: 7 });
  });

  it('pullScripts(root) → POST /v1/scripts/pull，body {root}', async () => {
    const stub = await startStub();
    stub.reply = () => ({ json: { scripts: 1 } });
    const client = new HubClient({ port: stub.port });
    const result = await client.pullScripts('D:\\pack');
    const call = lastCall(stub);
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/v1/scripts/pull');
    expect(call.contentType).toBe('application/json');
    expect(JSON.parse(call.body) as unknown).toEqual({ root: 'D:\\pack' });
    expect(result).toEqual({ scripts: 1 }); // 原样返回控制通道 JSON
  });

  it('saveAndPlay(states) → POST /v1/scripts/save-and-play，body {scriptStates}', async () => {
    const stub = await startStub();
    stub.reply = () => ({ json: { ok: true } });
    const client = new HubClient({ port: stub.port });
    const states = [{ name: 'Global', guid: '-1', script: 'x' }];
    const result = await client.saveAndPlay(states);
    const call = lastCall(stub);
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/v1/scripts/save-and-play');
    expect(JSON.parse(call.body) as unknown).toEqual({ scriptStates: states });
    expect(result).toEqual({ ok: true });
  });

  it('exec(lua, opts) → POST /v1/exec，body {lua, guid, timeoutMs}', async () => {
    const stub = await startStub();
    stub.reply = () => ({ json: { result: 42 } });
    const client = new HubClient({ port: stub.port });
    const result = await client.exec('1+1', { guid: 'abc', timeoutMs: 1234 });
    const call = lastCall(stub);
    expect(call.url).toBe('/v1/exec');
    expect(JSON.parse(call.body) as unknown).toEqual({ lua: '1+1', guid: 'abc', timeoutMs: 1234 });
    expect(result).toEqual({ result: 42 });
  });

  it('exec(lua) 不带 opts 时 body 只有 {lua}', async () => {
    const stub = await startStub();
    const client = new HubClient({ port: stub.port });
    await client.exec('print(1)');
    expect(JSON.parse(lastCall(stub).body) as unknown).toEqual({ lua: 'print(1)' });
  });

  it('assetsCheck(urls, timeoutMs) → POST /v1/assets/check；缺省不带 timeoutMs 字段', async () => {
    const stub = await startStub();
    stub.reply = () => ({ json: { total: 2, alive: 2, dead: 0, deadUrls: [] } });
    const client = new HubClient({ port: stub.port });
    await client.assetsCheck(['u1', 'u2'], 500);
    expect(JSON.parse(lastCall(stub).body) as unknown).toEqual({
      urls: ['u1', 'u2'],
      timeoutMs: 500,
    });
    await client.assetsCheck(['u3']);
    expect(JSON.parse(lastCall(stub).body) as unknown).toEqual({ urls: ['u3'] });
  });

  it('listPacks() → GET /v1/packs；listPacks(root) 带编码后的 packsRoot 查询参数', async () => {
    const stub = await startStub();
    stub.reply = () => ({ json: { schema_version: 1, packs: [] } });
    const client = new HubClient({ port: stub.port });
    await client.listPacks();
    expect(lastCall(stub).url).toBe('/v1/packs');
    await client.listPacks('D:\\x y\\pack');
    expect(lastCall(stub).url).toBe(`/v1/packs?packsRoot=${encodeURIComponent('D:\\x y\\pack')}`);
  });

  it('deckSlice(opts) → POST /v1/deck/slice，body 就是 SliceOptions 本身', async () => {
    const stub = await startStub();
    const opts = { sheetPath: 's.png', savePath: 'v.json', outDir: 'out' };
    const client = new HubClient({ port: stub.port });
    await client.deckSlice(opts);
    const call = lastCall(stub);
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/v1/deck/slice');
    expect(JSON.parse(call.body) as unknown).toEqual(opts);
  });

  it('deckPlan(opts) → POST /v1/deck/plan，body 就是 PlanOptions 本身', async () => {
    const stub = await startStub();
    const opts = { savePath: 'p.json', rules: [{ mode: 'exact' as const, from: 'a', to: 'b' }] };
    const client = new HubClient({ port: stub.port });
    await client.deckPlan(opts);
    const call = lastCall(stub);
    expect(call.url).toBe('/v1/deck/plan');
    expect(JSON.parse(call.body) as unknown).toEqual(opts);
  });

  it('importAssets(root, manifestPath, dryRun?) → POST /v1/import；缺省不带 dryRun 字段', async () => {
    const stub = await startStub();
    const client = new HubClient({ port: stub.port });
    await client.importAssets('r', 'm', true);
    expect(JSON.parse(lastCall(stub).body) as unknown).toEqual({
      root: 'r',
      manifestPath: 'm',
      dryRun: true,
    });
    await client.importAssets('r', 'm');
    expect(JSON.parse(lastCall(stub).body) as unknown).toEqual({ root: 'r', manifestPath: 'm' });
  });

  it('diff(root) → POST /v1/diff，body {root}', async () => {
    const stub = await startStub();
    const client = new HubClient({ port: stub.port });
    await client.diff('D:\\pack');
    expect(lastCall(stub).url).toBe('/v1/diff');
    expect(JSON.parse(lastCall(stub).body) as unknown).toEqual({ root: 'D:\\pack' });
  });

  it('push(root, true) 无 opts → POST /v1/push，body 只有 {root, confirm:true}，定型返回新形', async () => {
    const stub = await startStub();
    stub.reply = () => ({ json: { ok: true, dryRun: true, pushed: 2, skipped: 1, items: 3 } });
    const client = new HubClient({ port: stub.port });
    const result = await client.push('D:\\pack', true);
    const call = lastCall(stub);
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/v1/push');
    expect(JSON.parse(call.body) as unknown).toEqual({ root: 'D:\\pack', confirm: true });
    expect(result).toEqual({ ok: true, dryRun: true, pushed: 2, skipped: 1, items: 3 });
  });

  it('push(root, true, opts) 全字段 → body 逐项透传（undefined 字段不出现）', async () => {
    const stub = await startStub();
    stub.reply = () => ({ json: { ok: true, dryRun: false, pushed: 1, skipped: 0, items: 1 } });
    const client = new HubClient({ port: stub.port });
    await client.push('D:\\pack', true, {
      dryRun: false,
      forceScriptsOnly: true,
      skipBackup: true,
      skipBaselineCheck: true,
      backupRetention: 33,
    });
    expect(JSON.parse(lastCall(stub).body) as unknown).toEqual({
      root: 'D:\\pack',
      confirm: true,
      dryRun: false,
      forceScriptsOnly: true,
      skipBackup: true,
      skipBaselineCheck: true,
      backupRetention: 33,
    });
  });

  it('push(root, true, {dryRun}) 部分字段 → body 只带给定字段', async () => {
    const stub = await startStub();
    stub.reply = () => ({ json: { ok: true, dryRun: true, pushed: 0, skipped: 0, items: 0 } });
    const client = new HubClient({ port: stub.port });
    await client.push('r', true, { dryRun: true });
    expect(JSON.parse(lastCall(stub).body) as unknown).toEqual({ root: 'r', confirm: true, dryRun: true });
  });

  it('push(root, true, {}) 空 opts → body 与无 opts 相同（{root, confirm:true}）', async () => {
    const stub = await startStub();
    stub.reply = () => ({ json: { ok: true, dryRun: true, pushed: 0, skipped: 0, items: 0 } });
    const client = new HubClient({ port: stub.port });
    await client.push('r', true, {});
    expect(JSON.parse(lastCall(stub).body) as unknown).toEqual({ root: 'r', confirm: true });
  });

  it('push：响应缺 items → 客户端按 pushed + skipped 补算别名', async () => {
    const stub = await startStub();
    stub.reply = () => ({ json: { ok: true, dryRun: false, pushed: 4, skipped: 2 } });
    const client = new HubClient({ port: stub.port });
    const result = await client.push('r', true);
    expect(result.items).toBe(6);
  });

  it('push：backupDir / baselineConflicts / assetChanges 原样透传，缺省不携带', async () => {
    const stub = await startStub();
    stub.reply = () => ({
      json: {
        ok: true,
        dryRun: false,
        pushed: 1,
        skipped: 0,
        items: 1,
        backupDir: 'D:\\pack\\.tts\\backups\\t1',
        baselineConflicts: [{ guid: 'aa11bb', name: '棋盘', kind: 'script' }],
        assetChanges: { changed: ['decks/x/cards.csv'], added: [], deleted: [] },
      },
    });
    const client = new HubClient({ port: stub.port });
    const result = await client.push('r', true);
    expect(result.backupDir).toBe('D:\\pack\\.tts\\backups\\t1');
    expect(result.baselineConflicts).toEqual([{ guid: 'aa11bb', name: '棋盘', kind: 'script' }]);
    expect(result.assetChanges).toEqual({ changed: ['decks/x/cards.csv'], added: [], deleted: [] });

    const stub2 = await startStub();
    stub2.reply = () => ({ json: { ok: true, dryRun: true, pushed: 0, skipped: 0, items: 0 } });
    const result2 = await new HubClient({ port: stub2.port }).push('r', true);
    expect(result2).not.toHaveProperty('backupDir');
    expect(result2).not.toHaveProperty('baselineConflicts');
    expect(result2).not.toHaveProperty('assetChanges');
  });

  it('push：dryRun 非布尔 / pushed 或 skipped 缺失 → HubError(HUB_UNKNOWN)（协议违规）', async () => {
    const badBodies: unknown[] = [
      { ok: true, pushed: 1, skipped: 0, items: 1 }, // 缺 dryRun
      { ok: true, dryRun: true, skipped: 0, items: 0 }, // 缺 pushed
      { ok: true, dryRun: true, pushed: 1, items: 1 }, // 缺 skipped
      { dryRun: true, pushed: 1, skipped: 0, items: 1 }, // 缺 ok
      { ok: true, dryRun: true, pushed: 1, skipped: 0, items: 1, extra: true }, // 多余字段仍放行
    ];
    const stub = await startStub();
    const client = new HubClient({ port: stub.port });
    for (const [i, bad] of badBodies.entries()) {
      stub.reply = () => ({ json: bad });
      const err = await client.push('r', true).catch((e: unknown) => e);
      if (i === badBodies.length - 1) {
        expect(err).not.toBeInstanceOf(HubError); // 多余字段不校验、放行
      } else {
        expect(err).toBeInstanceOf(HubError);
        if (err instanceof HubError) {
          expect(err.code).toBe('HUB_UNKNOWN');
          expect(err.message).toContain('/v1/push');
        }
      }
    }
  });

  it('shutdown() → POST /v1/hub/shutdown，返回 {ok:true}', async () => {
    const stub = await startStub();
    const client = new HubClient({ port: stub.port });
    const result = await client.shutdown();
    expect(lastCall(stub).url).toBe('/v1/hub/shutdown');
    expect(result).toEqual({ ok: true });
  });
});

describe('HubClient：错误分类', () => {
  it('4xx 标准错误体 → HubError 保留 code / httpStatus / details', async () => {
    const stub = await startStub();
    stub.reply = () => ({
      status: 400,
      json: { error: { code: 'HUB_CONFIRM_REQUIRED', message: 'need confirm', details: { a: 1 } } },
    });
    const client = new HubClient({ port: stub.port });
    const err = await client.push('r', true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubError);
    if (err instanceof HubError) {
      expect(err.httpStatus).toBe(400);
      expect(err.code).toBe('HUB_CONFIRM_REQUIRED');
      expect(err.message).toBe('need confirm');
      expect(err.details).toEqual({ a: 1 });
    }
  });

  it('5xx 非标准错误体 → HubError(HUB_UNKNOWN)，message 为原始 body 文本', async () => {
    const stub = await startStub();
    stub.reply = () => ({ status: 500, raw: 'boom' });
    const client = new HubClient({ port: stub.port });
    const err = await client.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubError);
    if (err instanceof HubError) {
      expect(err.httpStatus).toBe(500);
      expect(err.code).toBe('HUB_UNKNOWN');
      expect(err.message).toBe('boom');
    }
  });

  it('2xx 但 body 非法 JSON → HubError(HUB_UNKNOWN)', async () => {
    const stub = await startStub();
    stub.reply = () => ({ status: 200, raw: 'not-json' });
    const client = new HubClient({ port: stub.port });
    const err = await client.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubError);
    if (err instanceof HubError) {
      expect(err.code).toBe('HUB_UNKNOWN');
    }
  });

  it('定型路由响应 shape 不符 → HubError(HUB_UNKNOWN)（如 save-and-play 返回非 {ok:true}）', async () => {
    const stub = await startStub();
    stub.reply = () => ({ status: 200, json: { unexpected: 1 } });
    const client = new HubClient({ port: stub.port });
    const err = await client.saveAndPlay([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubError);
    if (err instanceof HubError) {
      expect(err.code).toBe('HUB_UNKNOWN');
    }
  });

  it('连接拒绝（hub 不在线）→ HubNotRunningError', async () => {
    const port = await grabFreePort(); // 抢占后释放：连入必被拒
    const client = new HubClient({ port });
    await expect(client.status()).rejects.toBeInstanceOf(HubNotRunningError);
  });

  it('响应超时中止（timeoutMs 覆盖全程）→ HubNotRunningError', async () => {
    const stub = await startStub();
    stub.reply = () => ({ json: { ok: true }, delayMs: 500 });
    const client = new HubClient({ port: stub.port, timeoutMs: 50 });
    await expect(client.status()).rejects.toBeInstanceOf(HubNotRunningError);
  });
});

describe('probeHub：零异常探测', () => {
  it('hub 在线 → 从 /v1/status 的 hub 字段提取 {uptimeMs, startedAt}', async () => {
    const stub = await startStub();
    stub.reply = () => ({
      json: { ok: true, hub: { uptimeMs: 12, startedAt: 34 }, tts: { connected: false } },
    });
    const result = await probeHub({ port: stub.port });
    expect(result).toEqual({ uptimeMs: 12, startedAt: 34 });
  });

  it('hub 不在线（连接拒绝）→ null 不抛', async () => {
    const port = await grabFreePort();
    const result = await probeHub({ port });
    expect(result).toBeNull();
  });

  it('响应超过 800ms 探测超时 → null 不抛', async () => {
    const stub = await startStub();
    stub.reply = () => ({ json: { ok: true }, delayMs: 1600 });
    const started = Date.now();
    const result = await probeHub({ port: stub.port });
    expect(result).toBeNull();
    // 超时上限附近返回（不晚于延迟响应的 1600ms，探测固定 800ms）
    expect(Date.now() - started).toBeLessThan(1600);
  });
});
