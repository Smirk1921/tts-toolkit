// tests/unit/hub-control-files.test.ts
/**
 * src/hub/control.ts · /v1/files/read（POST）与 /v1/files/write（PUT）单元测试
 * （UI-1b 文件路由；不注册为 MCP 工具——红线 15）。
 *
 * 与 tests/unit/hub-control.test.ts 的分工：那里覆盖通用路由分类（404 / 405 /
 * 415 / SSE），这里深挖 UI-1b 两条文件路由与 CORS / appMode 行为：
 * - POST /v1/files/read：200 `{base64, mime, size}`（base64 对字节精确往返、
 *   mime 按扩展名白名单推断）；root 必须是已注册图包根（400 HUB_BAD_REQUEST）；
 *   路径防护参数化（绝对路径 / ".." 段 / 盘符前缀 / null 字节 / symlink 逃逸
 *   → 400 HUB_PATH_ESCAPE）；>20MB → 413 HUB_FILE_TOO_LARGE；
 * - PUT /v1/files/write：200 `{sha256, size}`（sha256 对写入的 UTF-8 字节计算）；
 *   乐观锁三态——baseSha256 匹配 → 200 覆写 / 不匹配 → 409 HUB_CONFLICT
 *   （details.currentSha256 带当前值；目标不存在也是冲突）/ 不提供 → 跳过校验；
 *   content >1MB → 413 HUB_FILE_TOO_LARGE；root 不要求已注册（§8.4：仅 read
 *   校验注册表）；GET 打写路由 → 405 且 Allow: PUT（PUT 路由表生效的对照）；
 * - loopback CORS（UI-1b）：http://localhost:<port> Origin → 回显
 *   Access-Control-Allow-Origin；非白名单来源 → 完全不发 CORS 头；OPTIONS
 *   预检 → 204 + Allow-Methods: GET,POST,PUT,OPTIONS；
 * - GET /v1/status：hub.version（= package.json 版本）与 hub.appMode（缺省
 *   "standalone"）；appMode="app" 时错误响应 details 附带 userAction 提示键
 *   （standalone 形态不带）。
 *
 * mock 策略（真实 HTTP + 真实文件 IO，不 mock 任何模块）：
 * - daemon 与控制通道用真实现（随机临时端口，绝不绑 39995-39999），请求用真
 *   fetch 发出；
 * - 测试 root 用 mkdtemp 临时目录 + upsertPack 写 .registry.yaml 构造"已注册
 *   图包根"（findPack 按 root 的父目录与基名查注册表）；临时目录在 afterEach
 *   全部删除；
 * - symlink 逃逸用例用 junction 语义（POSIX 上 type 参数被忽略等价普通符号
 *   链接，Windows 上 junction 无需特权），并带能力探针 skipIf 兜底。
 *
 * 错误断言只看 code / details（协议层机器可读键），不断言 message 文案。
 */
import net, { type AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import pkg from '../../package.json' with { type: 'json' };
import { HubDaemon } from '../../src/hub/daemon.js';
import { createControlServer, type ControlServer } from '../../src/hub/control.js';
import { upsertPack } from '../../src/pack/registry.js';

// ---------------------------------------------------------------------------
// 符号链接能力探针（模块收集期执行一次；个别沙箱环境禁用一切链接创建）
// ---------------------------------------------------------------------------

/** 当前环境能否创建目录链接（junction 在 Windows 无需特权；POSIX 忽略 type） */
const dirLinkSupported = await (async () => {
  const probe = await mkdtemp(path.join(os.tmpdir(), 'tts-files-link-probe-'));
  try {
    const dir = path.join(probe, 'dir');
    await mkdir(dir);
    try {
      await symlink(dir, path.join(probe, 'link'), 'junction');
      return true;
    } catch {
      return false;
    }
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
})();

// ---------------------------------------------------------------------------
// 栈管理（与 hub-control.test.ts 同款：随机临时端口 + afterEach 全关）
// ---------------------------------------------------------------------------

/** 运行中的 daemon + 控制通道栈 */
interface RunningStack {
  daemon: HubDaemon;
  control: ControlServer;
  /** 控制通道基础 URL（http://127.0.0.1:<port>/v1） */
  base: string;
}

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    await fn();
  }
  cleanups.length = 0;
});

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
 * 启动 daemon（三端口 listen(0) 抢占的临时端口）+ 控制通道（port=0 由操作系统
 * 分配，boundPort() 读回）。端口恰被占用时换端口重试（最多 5 次）。
 * @param opts.opts.appMode 传给 ControlServerOptions.appMode（undefined = 缺省 standalone）
 * @returns 运行中的栈
 */
async function startStack(opts: { appMode?: string } = {}): Promise<RunningStack> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const editorPort = await grabFreePort();
    const tcpPort = await grabFreePort();
    const wsPort = await grabFreePort();
    const daemon = new HubDaemon({ editorPort, tcpPort, wsPort, log: () => undefined });
    const control = createControlServer(daemon, {
      port: 0,
      log: () => undefined,
      ...(opts.appMode !== undefined ? { appMode: opts.appMode } : {}),
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
    return { daemon, control, base: `http://127.0.0.1:${control.boundPort()}/v1` };
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 测试夹具：已注册 / 未注册的图包工作区 root
// ---------------------------------------------------------------------------

/** 测试用图包工作区 root（含其 packsRoot 与临时基目录） */
interface TestRoot {
  /** 临时基目录（afterEach 整体删除） */
  tmpBase: string;
  /** 图包根目录（root 的父目录，持有 .registry.yaml） */
  packsRoot: string;
  /** 已注册的图包工作区根目录 */
  root: string;
}

/**
 * 构造"已注册图包根"：`<tmpBase>/packs/ok-pack` + .registry.yaml 中 dir="ok-pack"
 * 的条目，并预建 root/scripts 子目录（write 的父目录必须已存在）。
 * @returns 测试 root 三元组
 */
async function makeRegisteredRoot(): Promise<TestRoot> {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'tts-files-root-'));
  const packsRoot = path.join(tmpBase, 'packs');
  const root = path.join(packsRoot, 'ok-pack');
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await upsertPack(packsRoot, {
    dir: 'ok-pack',
    name: 'OK Pack',
    kind: 'original',
    upstream: null,
    branch: 'main',
    host: 'custom',
    modified: '', // upsert 语义：新增时自动填当天日期
    stats: { decks: 0, cards: 0, scripts: 0 },
    lfs_status: 'disabled',
  });
  cleanups.push(() => rm(tmpBase, { recursive: true, force: true }));
  return { tmpBase, packsRoot, root };
}

/** 构造"未注册"的目录（无 .registry.yaml，findPack 容错返回空表 → 400） */
async function makeUnregisteredRoot(): Promise<string> {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'tts-files-ghost-'));
  const root = path.join(tmpBase, 'ghost-pack');
  await mkdir(root, { recursive: true });
  cleanups.push(() => rm(tmpBase, { recursive: true, force: true }));
  return root;
}

/** 在 root 内落一个文件（自动逐级建父目录），返回绝对路径 */
async function seedFile(root: string, relPath: string, data: string | Buffer): Promise<string> {
  const abs = path.join(root, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, data);
  return abs;
}

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------

/** 便捷 POST JSON（body = unknown），返回原始 Response */
const postJson = (base: string, pathname: string, body: unknown): Promise<Response> =>
  fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 便捷 PUT JSON 到 /v1/files/write，返回原始 Response */
const putJson = (base: string, body: unknown): Promise<Response> =>
  fetch(`${base}/files/write`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 解析统一错误响应体并断言 code，返回 details 供进一步断言 */
async function expectErrorBody(res: Response, status: number, code: string): Promise<{
  message: string;
  details?: Record<string, unknown>;
}> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as {
    error?: { code?: string; message?: string; details?: Record<string, unknown> };
  };
  expect(body.error?.code).toBe(code);
  expect(typeof body.error?.message).toBe('string');
  return { message: body.error?.message ?? '', details: body.error?.details };
}

/** 文本（UTF-8 字节）的 sha256 hex */
function sha256Of(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

// ---------------------------------------------------------------------------
// POST /v1/files/read · 200 正常返回
// ---------------------------------------------------------------------------

describe('POST /v1/files/read · 200 正常返回', () => {
  it('文本文件（.lua，含中文）→ 200 {base64, mime:"text/plain", size}，base64 解码与原字节一致', async () => {
    const { base } = await startStack();
    const { root } = await makeRegisteredRoot();
    const text = '-- 引导脚本（UTF-8 多字节）\nlocal seed = 42\n';
    await seedFile(root, 'scripts/bootstrap.lua', text);

    const res = await postJson(base, '/files/read', { root, path: 'scripts/bootstrap.lua' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { base64?: string; mime?: string; size?: number };
    expect(body.mime).toBe('text/plain'); // lua 无注册 MIME，按纯文本给出
    expect(body.size).toBe(Buffer.byteLength(text, 'utf8'));
    expect(Buffer.from(body.base64 ?? '', 'base64').toString('utf8')).toBe(text);
  });

  it('二进制文件（.png，PNG 魔数含 0x00）→ 200 mime:"image/png"，base64 字节级往返一致', async () => {
    const { base } = await startStack();
    const { root } = await makeRegisteredRoot();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0x80]);
    await seedFile(root, 'decks/back.png', bytes);

    const res = await postJson(base, '/files/read', { root, path: 'decks/back.png' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { base64?: string; mime?: string; size?: number };
    expect(body.mime).toBe('image/png');
    expect(body.size).toBe(bytes.length);
    const decoded = Buffer.from(body.base64 ?? '', 'base64');
    expect(decoded.equals(bytes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/files/read · 路径防护（HUB_PATH_ESCAPE）
// ---------------------------------------------------------------------------

describe('POST /v1/files/read · 路径防护（400 HUB_PATH_ESCAPE）', () => {
  const escapeCases: ReadonlyArray<{ name: string; relPath: string }> = [
    { name: '绝对路径 /etc/passwd', relPath: '/etc/passwd' },
    { name: '".." 段 scripts/../../outside.lua', relPath: 'scripts/../../outside.lua' },
    { name: '盘符前缀 C:foo', relPath: 'C:foo' },
    { name: 'null 字节', relPath: 'a\0b' },
  ];

  for (const { name, relPath } of escapeCases) {
    it(`${name} → 400 HUB_PATH_ESCAPE`, async () => {
      const { base } = await startStack();
      const { root } = await makeRegisteredRoot();
      const res = await postJson(base, '/files/read', { root, path: relPath });
      await expectErrorBody(res, 400, 'HUB_PATH_ESCAPE');
    });
  }

  it('symlink 逃逸（root 内目录链接指向 root 外）→ 400 HUB_PATH_ESCAPE', async (ctx) => {
    if (!dirLinkSupported) {
      ctx.skip(); // 个别环境禁用链接创建：能力探针兜底跳过
    }
    const { base } = await startStack();
    const { packsRoot, root } = await makeRegisteredRoot();
    const outside = path.join(packsRoot, 'outside'); // root 的兄弟目录（在 root 外）
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'top secret', 'utf8');
    // junction：Windows 无需特权；POSIX 忽略 type，等价普通目录符号链接
    await symlink(outside, path.join(root, 'link'), 'junction');

    const res = await postJson(base, '/files/read', { root, path: 'link/secret.txt' });
    await expectErrorBody(res, 400, 'HUB_PATH_ESCAPE');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/files/read · 大小上限与 root 注册校验
// ---------------------------------------------------------------------------

describe('POST /v1/files/read · 大小上限与 root 注册校验', () => {
  it('>20MB（白名单扩展名）→ 413 HUB_FILE_TOO_LARGE', async () => {
    const { base } = await startStack();
    const { root } = await makeRegisteredRoot();
    await seedFile(root, 'decks/big.png', Buffer.alloc(20 * 1_048_576 + 1));

    const res = await postJson(base, '/files/read', { root, path: 'decks/big.png' });
    await expectErrorBody(res, 413, 'HUB_FILE_TOO_LARGE');
  });

  it('root 未注册（注册表无对应条目）→ 400 HUB_BAD_REQUEST', async () => {
    const { base } = await startStack();
    const ghostRoot = await makeUnregisteredRoot();
    const res = await postJson(base, '/files/read', { root: ghostRoot, path: 'anything.txt' });
    await expectErrorBody(res, 400, 'HUB_BAD_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// PUT /v1/files/write · 写入与乐观锁
// ---------------------------------------------------------------------------

describe('PUT /v1/files/write · 写入与乐观锁', () => {
  it('正常写入 → 200 {sha256, size}，sha256 对写入的 UTF-8 字节计算，磁盘内容一致', async () => {
    const { base } = await startStack();
    const { root } = await makeRegisteredRoot();
    const content = '-- 由 UI 重写\nlocal ok = true\n';

    const res = await putJson(base, { root, path: 'scripts/bootstrap.lua', content });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sha256?: string; size?: number };
    expect(body.sha256).toBe(sha256Of(content));
    expect(body.size).toBe(Buffer.byteLength(content, 'utf8'));
    expect(await readFile(path.join(root, 'scripts', 'bootstrap.lua'), 'utf8')).toBe(content);
  });

  it('乐观锁：baseSha256 与当前内容匹配 → 200 覆写，返回新内容的 sha256', async () => {
    const { base } = await startStack();
    const { root } = await makeRegisteredRoot();
    const first = 'version one';
    await seedFile(root, 'notes.md', first);

    const res = await putJson(base, {
      root,
      path: 'notes.md',
      content: 'version two',
      baseSha256: sha256Of(first),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sha256?: string; size?: number };
    expect(body.sha256).toBe(sha256Of('version two'));
    expect(await readFile(path.join(root, 'notes.md'), 'utf8')).toBe('version two');
  });

  it('乐观锁：baseSha256 不匹配 → 409 HUB_CONFLICT（details.currentSha256 带当前值，文件不变）；目标不存在也是冲突', async () => {
    const { base } = await startStack();
    const { root } = await makeRegisteredRoot();
    const current = 'current content';
    await seedFile(root, 'notes.md', current);
    const currentSha = sha256Of(current);

    const res = await putJson(base, {
      root,
      path: 'notes.md',
      content: 'stale overwrite',
      baseSha256: '0'.repeat(64), // 错误的基准
    });
    const err = await expectErrorBody(res, 409, 'HUB_CONFLICT');
    expect(err.details?.currentSha256).toBe(currentSha);
    expect(await readFile(path.join(root, 'notes.md'), 'utf8')).toBe(current); // 未被覆盖

    // 子场景：目标不存在 + 提供 baseSha256 → 409（创建新文件请不要带 baseSha256）
    const resMissing = await putJson(base, {
      root,
      path: 'scripts/never-created.lua',
      content: 'x',
      baseSha256: currentSha,
    });
    const errMissing = await expectErrorBody(resMissing, 409, 'HUB_CONFLICT');
    expect(errMissing.details?.currentSha256).toBeUndefined(); // 无当前文件，无 currentSha256
  });

  it('乐观锁：不提供 baseSha256 → 跳过校验，已存在的文件直接覆写 200', async () => {
    const { base } = await startStack();
    const { root } = await makeRegisteredRoot();
    await seedFile(root, 'notes.md', 'old content');

    const res = await putJson(base, { root, path: 'notes.md', content: 'new body' });
    expect(res.status).toBe(200);
    expect(await readFile(path.join(root, 'notes.md'), 'utf8')).toBe('new body');
  });

  it('content >1MB（UTF-8 字节）→ 413 HUB_FILE_TOO_LARGE', async () => {
    const { base } = await startStack();
    const { root } = await makeRegisteredRoot();
    const res = await putJson(base, {
      root,
      path: 'scripts/big.lua',
      content: 'a'.repeat(1_048_577), // 1MB + 1 字节
    });
    await expectErrorBody(res, 413, 'HUB_FILE_TOO_LARGE');
  });

  it('root 未注册仍可写（§8.4：仅 read 校验注册表）→ 200', async () => {
    const { base } = await startStack();
    const ghostRoot = await makeUnregisteredRoot();
    const res = await putJson(base, { root: ghostRoot, path: 'free.md', content: 'no registry needed' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sha256?: string };
    expect(body.sha256).toBe(sha256Of('no registry needed'));
  });
});

// ---------------------------------------------------------------------------
// PUT 路由与方法白名单
// ---------------------------------------------------------------------------

describe('PUT 路由与方法白名单', () => {
  it('PUT /v1/files/write 路由生效；GET 打写路由 → 405 且 Allow: PUT', async () => {
    const { base } = await startStack();
    const { root } = await makeRegisteredRoot();

    // PUT 命中专用路由表（三路 dispatch 之一）
    const ok = await putJson(base, { root, path: 'notes.md', content: 'route-check' });
    expect(ok.status).toBe(200);

    // GET /v1/files/write → 405，Allow 聚合三张表后只含 PUT
    const res = await fetch(`${base}/files/write`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('PUT');
    await expectErrorBody(res, 405, 'HUB_METHOD_NOT_ALLOWED');
  });
});

// ---------------------------------------------------------------------------
// loopback CORS（UI-1b）
// ---------------------------------------------------------------------------

describe('loopback CORS（UI-1b）', () => {
  it('loopback Origin（http://localhost:1420）→ 回显 Access-Control-Allow-Origin + Vary: Origin', async () => {
    const { base } = await startStack();
    const res = await fetch(`${base}/status`, { headers: { Origin: 'http://localhost:1420' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:1420');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('非白名单 Origin（http://evil.com）→ 不发任何 CORS 头', async () => {
    const { base } = await startStack();
    const res = await fetch(`${base}/status`, { headers: { Origin: 'http://evil.com' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('vary')).toBeNull();
  });

  it('OPTIONS 预检 → 204 + Allow-Methods: GET,POST,PUT,OPTIONS + Allow-Headers: Content-Type', async () => {
    const { base } = await startStack();
    const res = await fetch(`${base}/files/write`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:1420' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:1420');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET,POST,PUT,OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/status · UI-1b 字段与 appMode
// ---------------------------------------------------------------------------

describe('GET /v1/status · UI-1b 字段与 appMode', () => {
  it('hub.version 为非空字符串且与 package.json 一致；hub.appMode 缺省 "standalone"', async () => {
    const { base } = await startStack();
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hub?: { version?: string; appMode?: string } };
    expect(typeof body.hub?.version).toBe('string');
    expect(body.hub?.version).toBe(pkg.version); // 顶部 import 本进程 package.json
    expect(body.hub?.appMode).toBe('standalone'); // 测试栈未传 appMode → 缺省值
  });

  it('appMode="app" → 错误响应 details.userAction 提示键；standalone 对照不带', async () => {
    const app = await startStack({ appMode: 'app' });
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'tts-files-appmode-'));
    cleanups.push(() => rm(tmp, { recursive: true, force: true }));

    // HUB_PACK_ERROR 有专用提示键映射（ERROR_USER_ACTIONS）
    const res = await postJson(app.base, '/diff', { root: tmp }); // 无 pack.yaml → PACK_NOT_FOUND
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: { code?: string; details?: Record<string, unknown> };
    };
    expect(body.error?.code).toBe('HUB_PACK_ERROR');
    expect(body.error?.details?.packCode).toBe('PACK_NOT_FOUND');
    expect(body.error?.details?.userAction).toBe('hub.error.checkWorkspace');

    // 对照：standalone 形态同样的错误，details 只有 packCode，不带 userAction
    const standalone = await startStack();
    const resPlain = await postJson(standalone.base, '/diff', { root: tmp });
    expect(resPlain.status).toBe(400);
    const bodyPlain = (await resPlain.json()) as {
      error?: { code?: string; details?: Record<string, unknown> };
    };
    expect(bodyPlain.error?.code).toBe('HUB_PACK_ERROR');
    expect(bodyPlain.error?.details).toHaveProperty('packCode');
    expect(bodyPlain.error?.details).not.toHaveProperty('userAction');
  });
});
