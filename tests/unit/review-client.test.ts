// tests/unit/review-client.test.ts
/**
 * src/review/client.ts 单元测试：审批工具客户端的自动选路与两条通路。
 *
 * 全程 mock，无真网络、无真 python：
 * - HTTP：`fetchImpl` 注入（探测 /api/config 与 /api/agent/* 全走它，
 *   并记录每次调用的 url/init 供断言）；服务存活 / pid 兜底 / 显式 server /
 *   探测落空回退 CLI 四种选路各一用例；
 * - CLI：`runImpl` 注入（不发子进程），断言 argv 拼法
 *   （agent.py 路径 + --config + [--offline] + 子命令 + 参数数组）、
 *   ok:false → REVIEW_CALL_FAILED、非 JSON + 解释器缺失 → REVIEW_APP_MISSING、
 *   超时 → REVIEW_CALL_FAILED；
 * - 参数构建纯函数：items 的 CLI argv 与 HTTP query 同源同义；
 *   review 的圈选走 --annotations（整段 JSON）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PackError } from '../../src/pack/packyaml.js';
import {
  ApprovalClient,
  buildItemsCliArgs,
  buildItemsQuery,
  buildReviewCliArgs,
  type CliRunResult,
  type CliRunner,
} from '../../src/review/client.js';
import { writeApprovalConfig } from '../../src/review/config.js';

// ---------------------------------------------------------------------------
// 临时目录与夹具
// ---------------------------------------------------------------------------

let tempRoot: string;
let configPath: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-review-client-'));
  configPath = (
    await writeApprovalConfig(tempRoot, {
      sets: [{ id: 'demo_cards', name: '演示', aRoot: path.join(tempRoot, 'a'), bRoot: path.join(tempRoot, 'b') }],
    })
  ).configPath;
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** fetch 替身：记录每次调用，按注册的处理器返回 Response */
function fetchMock(handler: (url: string, init?: RequestInit) => Response): typeof fetch & { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch & { calls: { url: string; init?: RequestInit }[] };
  fn.calls = calls;
  return fn;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** CLI 替身：记录 argv，按脚本返回结果 */
function runMock(responses: Partial<CliRunResult>[]): CliRunner & { argvs: string[][] } {
  const argvs: string[][] = [];
  const runner = (async (_python: string, argv: string[]) => {
    argvs.push(argv);
    return { exitCode: 0, stdout: '', stderr: '', ...responses[argvs.length - 1] };
  }) as CliRunner & { argvs: string[][] };
  runner.argvs = argvs;
  return runner;
}

const approvalRoot = () => path.join(tempRoot, '审批工具仓库');

const client = (overrides: { fetchImpl?: typeof fetch; runImpl?: CliRunner; server?: string; offline?: boolean } = {}) =>
  new ApprovalClient({
    approvalRoot: approvalRoot(),
    configPath,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// 自动选路
// ---------------------------------------------------------------------------

describe('detectServer 自动选路', () => {
  it('配置端口上有审批工具（/api/config 200）→ 走该 base', async () => {
    const fm = fetchMock(() => jsonResponse({ ok: true }));
    await expect(client({ fetchImpl: fm }).detectServer()).resolves.toBe('http://127.0.0.1:8765');
    expect(fm.calls.map((c) => c.url)).toEqual(['http://127.0.0.1:8765/api/config']);
  });

  it('配置端口落空 + app.pid 记了非默认端口且存活 → 走 pid 端口', async () => {
    const dataDir = path.join(tempRoot, '.tts', 'approval', 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'app.pid'), '4242\n9999\n', 'utf8');
    const fm = fetchMock((url) => (url === 'http://127.0.0.1:9999/api/config' ? jsonResponse({ ok: true }) : jsonResponse({}, 404)));
    await expect(client({ fetchImpl: fm }).detectServer()).resolves.toBe('http://127.0.0.1:9999');
  });

  it('pid 端口与配置端口相同（残留 pid）→ 不兜底，回退 undefined', async () => {
    const dataDir = path.join(tempRoot, '.tts', 'approval', 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'app.pid'), '4242\n8765\n', 'utf8');
    const fm = fetchMock(() => jsonResponse({}, 500));
    await expect(client({ fetchImpl: fm }).detectServer()).resolves.toBeUndefined();
  });

  it('服务没跑（fetch 抛错）→ undefined', async () => {
    const fm = fetchMock(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(client({ fetchImpl: fm }).detectServer()).resolves.toBeUndefined();
  });

  it('显式 server 选项：直接返回，不探测', async () => {
    const fm = fetchMock(() => jsonResponse({ ok: true }));
    await expect(client({ fetchImpl: fm, server: 'http://127.0.0.1:1234/' }).detectServer()).resolves.toBe(
      'http://127.0.0.1:1234',
    );
    expect(fm.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HTTP 通路（/api/agent/*）
// ---------------------------------------------------------------------------

describe('HTTP 通路', () => {
  it('服务在跑：status() 走 GET /api/agent/status', async () => {
    // 探测 /api/config 与业务端点都要 200（无 server 选项时先探测再走 HTTP）
    const fm = fetchMock((url) =>
      url.endsWith('/api/config') || url === 'http://127.0.0.1:8765/api/agent/status'
        ? jsonResponse({ ok: true, transport: 'http', sets: [] })
        : jsonResponse({}, 404),
    );
    const result = await client({ fetchImpl: fm }).status();
    expect(result).toMatchObject({ ok: true, transport: 'http' });
    expect(fm.calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:8765/api/config',
      'http://127.0.0.1:8765/api/agent/status',
    ]);
  });

  it('items() 的 GET 查询串：set / status / stale=1 / limit', async () => {
    const fm = fetchMock((url) => jsonResponse({ ok: true, items: [] }));
    await client({ fetchImpl: fm }).items('demo_cards', { status: 'reject', stale: true, limit: 20 });
    const agentUrl = new URL(fm.calls.at(-1)!.url);
    expect(agentUrl.pathname).toBe('/api/agent/items');
    expect(agentUrl.searchParams.get('set')).toBe('demo_cards');
    expect(agentUrl.searchParams.get('status')).toBe('reject');
    expect(agentUrl.searchParams.get('stale')).toBe('1');
    expect(agentUrl.searchParams.get('limit')).toBe('20');
    // 未设置的筛选不出现
    expect(agentUrl.searchParams.has('tag')).toBe(false);
  });

  it('review() 走 POST /api/agent/review，body 含 set/id/status/tags/note/annotations', async () => {
    const fm = fetchMock(() => jsonResponse({ ok: true, changed: 1 }));
    await client({ fetchImpl: fm }).review('demo_cards', '102_front.png', {
      status: 'reject',
      tags: ['文字溢出'],
      note: '正文超出文本框',
      annotations: [{ side: 'b', x: 0.09, y: 0.55, w: 0.82, h: 0.28, note: '正文溢出到框外' }],
    });
    const call = fm.calls.at(-1)!;
    expect(call.url).toBe('http://127.0.0.1:8765/api/agent/review');
    const init = call.init!;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      set: 'demo_cards',
      id: '102_front.png',
      status: 'reject',
      tags: ['文字溢出'],
      note: '正文超出文本框',
      annotations: [{ side: 'b', x: 0.09, y: 0.55, w: 0.82, h: 0.28, note: '正文溢出到框外' }],
    });
  });

  it('clearStale() 的 dryRun 映射为 body 的 dry_run', async () => {
    const fm = fetchMock(() => jsonResponse({ ok: true }));
    await client({ fetchImpl: fm }).clearStale('demo_cards', { ids: ['a.png', 'b.png'], dryRun: true });
    const call = fm.calls.at(-1)!;
    expect(call.url).toBe('http://127.0.0.1:8765/api/agent/clear-stale');
    expect(JSON.parse(call.init!.body as string)).toEqual({
      set: 'demo_cards',
      ids: ['a.png', 'b.png'],
      dry_run: true,
    });
  });

  it('agent 报错（400 + ok:false）→ REVIEW_CALL_FAILED，详情取 error 字段', async () => {
    const fm = fetchMock((url) =>
      url.endsWith('/api/config')
        ? jsonResponse({ ok: true })
        : jsonResponse({ ok: false, error: '素材集不存在：demo_cards' }, 400),
    );
    await expect(client({ fetchImpl: fm }).status()).rejects.toMatchObject({
      code: 'REVIEW_CALL_FAILED',
    } satisfies Partial<PackError>);
  });

  it('响应不是 JSON / 缺 ok:true → REVIEW_CALL_FAILED', async () => {
    const fm = fetchMock((url) =>
      url.endsWith('/api/config') ? jsonResponse({ ok: true }) : new Response('<html>not json</html>', { status: 200 }),
    );
    await expect(client({ fetchImpl: fm }).status()).rejects.toMatchObject({
      code: 'REVIEW_CALL_FAILED',
    } satisfies Partial<PackError>);

    const fm2 = fetchMock((url) =>
      url.endsWith('/api/config') ? jsonResponse({ ok: true }) : jsonResponse({ hello: 'world' }),
    );
    await expect(client({ fetchImpl: fm2 }).status()).rejects.toMatchObject({
      code: 'REVIEW_CALL_FAILED',
    } satisfies Partial<PackError>);
  });

  it('请求异常（连接拒绝）→ REVIEW_CALL_FAILED', async () => {
    const fm = fetchMock(() => {
      throw new Error('fetch failed');
    });
    await expect(
      client({ fetchImpl: fm, server: 'http://127.0.0.1:8765' }).status(),
    ).rejects.toMatchObject({ code: 'REVIEW_CALL_FAILED' } satisfies Partial<PackError>);
  });
});

// ---------------------------------------------------------------------------
// CLI 通路（python agent.py）
// ---------------------------------------------------------------------------

describe('CLI 通路', () => {
  it('探测落空自动回退 CLI：argv = [agent.py, status, --config, …]（全局选项在子命令后）', async () => {
    const fm = fetchMock(() => jsonResponse({}, 404));
    const rm_ = runMock([{ stdout: JSON.stringify({ ok: true, transport: 'file' }) }]);
    const result = await client({ fetchImpl: fm, runImpl: rm_ }).status();
    expect(result).toEqual({ ok: true, transport: 'file' });
    expect(rm_.argvs[0]).toEqual([
      path.join(approvalRoot(), 'agent.py'),
      'status',
      '--config',
      configPath,
    ]);
    expect(fm.calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:8765/api/config',
    ]);
  });

  it('offline 选项：跳过探测并给 agent.py 传 --offline', async () => {
    const fm = fetchMock(() => jsonResponse({ ok: true }));
    const rm_ = runMock([{ stdout: JSON.stringify({ ok: true }) }]);
    await client({ fetchImpl: fm, runImpl: rm_, offline: true }).status();
    expect(fm.calls).toEqual([]);
    expect(rm_.argvs[0]).toContain('--offline');
  });

  it('items 的 CLI 参数拼法：子命令后跟参数，全局选项收尾', async () => {
    const rm_ = runMock([{ stdout: JSON.stringify({ ok: true, items: [] }) }]);
    const c = client({ runImpl: rm_, offline: true });
    await c.items('demo_cards', { status: 'reject', stale: true, limit: 5, offset: 10 });
    expect(rm_.argvs[0]).toEqual([
      path.join(approvalRoot(), 'agent.py'),
      'items',
      '--set',
      'demo_cards',
      '--status',
      'reject',
      '--stale',
      '--limit',
      '5',
      '--offset',
      '10',
      '--config',
      configPath,
      '--offline',
    ]);
  });

  it('review 的圈选走 --annotations（整段 JSON，note 含逗号也安全）', async () => {
    const rm_ = runMock([{ stdout: JSON.stringify({ ok: true }) }]);
    const annotations = [{ side: 'b' as const, x: 0.1, y: 0.2, w: 0.3, h: 0.4, note: '说明,含逗号' }];
    await client({ runImpl: rm_, offline: true }).review('s', 'i', { status: 'reject', tags: ['文字溢出'], note: 'n', annotations });
    const argv = rm_.argvs[0]!;
    const ai = argv.indexOf('--annotations');
    expect(JSON.parse(argv[ai + 1]!)).toEqual(annotations);
  });

  it('agent 失败（exit 1 + ok:false）→ REVIEW_CALL_FAILED', async () => {
    const rm_ = runMock([{ exitCode: 1, stdout: JSON.stringify({ ok: false, error: '配置里没有这个素材集' }) }]);
    await expect(client({ runImpl: rm_, offline: true }).status()).rejects.toMatchObject({
      code: 'REVIEW_CALL_FAILED',
    } satisfies Partial<PackError>);
  });

  it('exit 0 但 stdout 不是 JSON → REVIEW_CALL_FAILED；解释器缺失 → REVIEW_APP_MISSING', async () => {
    const rm_ = runMock([{ exitCode: 0, stdout: '不是 JSON' }]);
    await expect(client({ runImpl: rm_, offline: true }).status()).rejects.toMatchObject({
      code: 'REVIEW_CALL_FAILED',
    } satisfies Partial<PackError>);

    const rm2 = runMock([{ exitCode: 1, stdout: '', stderr: "python: command not found" }]);
    await expect(
      client({ runImpl: rm2, offline: true, python: 'tts-无此解释器-xyz' }).status(),
    ).rejects.toMatchObject({ code: 'REVIEW_APP_MISSING' } satisfies Partial<PackError>);
  });

  it('超时（timedOut，未正常退出）→ REVIEW_CALL_FAILED', async () => {
    const rm_ = runMock([{ timedOut: true, exitCode: undefined, stdout: '', stderr: '' }]);
    await expect(client({ runImpl: rm_, offline: true }).status()).rejects.toMatchObject({
      code: 'REVIEW_CALL_FAILED',
    } satisfies Partial<PackError>);
  });
});

// ---------------------------------------------------------------------------
// 纯参数构建（CLI argv 与 HTTP query 同源同义）
// ---------------------------------------------------------------------------

describe('buildItemsCliArgs / buildItemsQuery / buildReviewCliArgs', () => {
  it('items：argv 与 query 字段一一对应', () => {
    const filter = { status: 'unreviewed', tag: '文字溢出', noTags: false, annotated: true, limit: 3, offset: 6 };
    const argv = buildItemsCliArgs('s', filter);
    const query = buildItemsQuery('s', filter);
    expect(argv).toEqual(['--set', 's', '--status', 'unreviewed', '--tag', '文字溢出', '--annotated', '--limit', '3', '--offset', '6']);
    expect(query).toMatchObject({
      set: 's',
      status: 'unreviewed',
      tag: '文字溢出',
      stale: undefined,
      no_tags: undefined,
      annotated: 1,
      noted: undefined,
      limit: 3,
      offset: 6,
    });
  });

  it('items：全空 filter 只带 --set / set', () => {
    expect(buildItemsCliArgs('s', {})).toEqual(['--set', 's']);
    expect(buildItemsQuery('s', {})).toEqual({ set: 's' });
  });

  it('review：tags 逗号连接，annotations 整段 JSON', () => {
    const argv = buildReviewCliArgs('s', 'i', {
      status: 'flag',
      tags: ['a', 'b'],
      note: 'n',
      annotations: [{ side: 'a', x: 1, y: 2, w: 3, h: 4 }],
    });
    expect(argv).toEqual([
      '--set', 's', '--id', 'i', '--status', 'flag',
      '--tags', 'a,b',
      '--note', 'n',
      '--annotations', JSON.stringify([{ side: 'a', x: 1, y: 2, w: 3, h: 4 }]),
    ]);
  });
});
