// tests/unit/hub-control-import-ttsmod.test.ts
/**
 * src/hub/control.ts 的 POST /v1/pack/import-ttsmod（v9-3 窗口新增路由）单元测试。
 *
 * 覆盖场景（任务书 5 用例）：
 * - 正常导入：合法 .ttsmod → 200 {ok:true, warnings, objectsImported}，文件确实
 *   落到 modsParentDir / modSaveLocation（Mods/ 前缀 → 父目录、Saves/ → 存档位）；
 * - 文件不存在 → 400 {ok:false, code:"TTSMOD_INVALID"}（importTtsmod 的 PackError
 *   经路由映射，message 为底层 t() 文案原样透传）；
 * - 非 ZIP（垃圾字节）→ 400 TTSMOD_INVALID；
 * - 空 modsParentDir（全空白）→ 400 INVALID_INPUT；
 * - 相对路径 file → 400 INVALID_INPUT（路由层 path.isAbsolute 校验）。
 *
 * 测试方式与 hub-control.test.ts 同款：直接用 HubDaemon + createControlServer
 * 起 daemon 与控制通道（不经 lifecycle，端口 listen(0)/0 由操作系统分配），
 * 用 fetch 打路由。.ttsmod 夹具用 src/archive/ttsmod.ts 的 writeZip 现场生成
 * （不依赖 tests/fixtures 的真实样本，保持纯离线自足）。
 *
 * 错误形说明：本路由自身判定的 INVALID_INPUT 与底层 PackError（TTSMOD_INVALID）
 * 用 v9-3 契约的专用响应形 `{ok:false, code, message}`（与其余路由的
 * `{error:{...}}` 不同）；请求侧通用错误（如缺字段）仍走统一 HUB_BAD_REQUEST 形，
 * 附带用例断言。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeZip } from '../../src/archive/ttsmod.js';
import { HubDaemon } from '../../src/hub/daemon.js';
import { createControlServer, type ControlServer } from '../../src/hub/control.js';

/** afterEach 统一执行的清理动作（停 control / 停 daemon） */
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    await fn();
  }
  cleanups.length = 0;
});

/** 每个用例独立的临时根目录（beforeEach 创建、afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-hub-ttsmod-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
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

/** 已启动的 daemon + 控制通道栈（只需 base URL） */
interface RunningStack {
  /** 控制通道基础 URL（http://127.0.0.1:<port>/v1） */
  base: string;
}

/**
 * 启动 daemon（随机空闲端口）+ 控制通道（port=0 由操作系统分配）。
 * 端口恰被占用时换端口重试（最多 5 次）。
 */
async function startStack(): Promise<RunningStack> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const editorPort = await grabFreePort();
    const tcpPort = await grabFreePort();
    const wsPort = await grabFreePort();
    const daemon = new HubDaemon({ editorPort, tcpPort, wsPort, log: () => undefined });
    const control = createControlServer(daemon, { port: 0, log: () => undefined });
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
    return { base: `http://127.0.0.1:${control.boundPort()}/v1` };
  }
  throw lastErr;
}

/** 便捷 POST JSON，返回原始 Response */
const postJson = (base: string, pathname: string, body: unknown): Promise<Response> =>
  fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 断言 v9-3 专用错误响应体形状 `{ok:false, code, message}` 并取字段 */
function expectTtsmodErrorBody(body: unknown, code: string): { ok: false; code: string; message: string } {
  const b = body as { ok?: unknown; code?: unknown; message?: unknown };
  expect(b.ok).toBe(false);
  expect(b.code).toBe(code);
  expect(typeof b.message).toBe('string');
  expect((b.message as string).length).toBeGreaterThan(0);
  return b as { ok: false; code: string; message: string };
}

describe('POST /v1/pack/import-ttsmod（v9-3）', () => {
  it('正常导入：合法 .ttsmod → 200 {ok:true, warnings, objectsImported}，文件落到 modsParentDir / modSaveLocation', async () => {
    const { base } = await startStack();
    const modFile = path.join(tempRoot, 'sample.ttsmod');
    await writeFile(
      modFile,
      writeZip([
        { name: 'Mods/Images/httpexamplecomfacepng.png', data: Buffer.from('face-bytes') },
        { name: 'Mods/Workshop/31415926.json', data: Buffer.from('{"SaveName":"Sample"}') },
        { name: 'Saves/My Save.json', data: Buffer.from('save-data') },
      ]),
    );
    const modsParentDir = path.join(tempRoot, 'datadir');
    const modSaveLocation = path.join(tempRoot, 'saves');

    const res = await postJson(base, '/pack/import-ttsmod', {
      file: modFile,
      modsParentDir,
      modSaveLocation,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { ok?: unknown; warnings?: unknown; objectsImported?: unknown };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect((body.warnings as string[]).every((w) => typeof w === 'string')).toBe(true);
    expect(body.objectsImported).toBe(3);

    // 文件确实落地：Mods/ 前缀条目 → modsParentDir；Saves/ 条目 → modSaveLocation
    expect(
      await readFile(path.join(modsParentDir, 'Mods', 'Images', 'httpexamplecomfacepng.png'), 'utf8'),
    ).toBe('face-bytes');
    expect(
      await readFile(path.join(modsParentDir, 'Mods', 'Workshop', '31415926.json'), 'utf8'),
    ).toBe('{"SaveName":"Sample"}');
    expect(await readFile(path.join(modSaveLocation, 'Saves', 'My Save.json'), 'utf8')).toBe('save-data');
  });

  it('文件不存在 → 400 {ok:false, code:"TTSMOD_INVALID"}（PackError 经路由映射）', async () => {
    const { base } = await startStack();
    const modsParentDir = path.join(tempRoot, 'datadir');
    await mkdir(modsParentDir, { recursive: true });
    const res = await postJson(base, '/pack/import-ttsmod', {
      file: path.join(tempRoot, 'no-such.ttsmod'),
      modsParentDir,
      modSaveLocation: path.join(tempRoot, 'saves'),
    });
    expect(res.status).toBe(400);
    const body = expectTtsmodErrorBody(await res.json(), 'TTSMOD_INVALID');
    // message 是底层 t() 文案原样透传（zh-CN 下含"不存在"），不是协议层英文短句
    expect(body.message).toContain(path.join(tempRoot, 'no-such.ttsmod'));
  });

  it('非 ZIP（垃圾字节）→ 400 TTSMOD_INVALID', async () => {
    const { base } = await startStack();
    const garbage = path.join(tempRoot, 'garbage.ttsmod');
    await writeFile(garbage, 'definitely not a zip');
    const res = await postJson(base, '/pack/import-ttsmod', {
      file: garbage,
      modsParentDir: path.join(tempRoot, 'datadir'),
      modSaveLocation: path.join(tempRoot, 'saves'),
    });
    expect(res.status).toBe(400);
    expectTtsmodErrorBody(await res.json(), 'TTSMOD_INVALID');
    // 垃圾字节没有落地任何文件
    expect(existsSync(path.join(tempRoot, 'datadir'))).toBe(false);
  });

  it('空 modsParentDir（全空白）→ 400 INVALID_INPUT（requireString 先拦）', async () => {
    const { base } = await startStack();
    const modFile = path.join(tempRoot, 'sample.ttsmod');
    await writeFile(
      modFile,
      writeZip([{ name: 'Mods/Workshop/1.json', data: Buffer.from('{}') }]),
    );
    const res = await postJson(base, '/pack/import-ttsmod', {
      file: modFile,
      modsParentDir: '   ',
      modSaveLocation: path.join(tempRoot, 'saves'),
    });
    expect(res.status).toBe(400);
    expectTtsmodErrorBody(await res.json(), 'INVALID_INPUT');
  });

  it('相对路径 file → 400 INVALID_INPUT（路由层 path.isAbsolute 校验）', async () => {
    const { base } = await startStack();
    const res = await postJson(base, '/pack/import-ttsmod', {
      file: 'relative/sample.ttsmod',
      modsParentDir: tempRoot,
      modSaveLocation: tempRoot,
    });
    expect(res.status).toBe(400);
    const body = expectTtsmodErrorBody(await res.json(), 'INVALID_INPUT');
    expect(body.message).toContain('file');
  });

  it('附带：缺必填字段（无 file）→ 400 INVALID_INPUT（路由层字段校验覆盖"缺失"，message 指名 file）', async () => {
    const { base } = await startStack();
    const res = await postJson(base, '/pack/import-ttsmod', {
      modsParentDir: tempRoot,
      modSaveLocation: tempRoot,
    });
    expect(res.status).toBe(400);
    const body = expectTtsmodErrorBody(await res.json(), 'INVALID_INPUT');
    expect(body.message).toContain('file');
  });

  it('附带：非 JSON Content-Type → 415 统一形 HUB_UNSUPPORTED_MEDIA_TYPE（请求侧通用门不落本路由专用形）', async () => {
    const { base } = await startStack();
    const res = await fetch(`${base}/pack/import-ttsmod`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(415);
    const err = (await res.json()) as { error?: { code?: unknown } };
    expect(err.error?.code).toBe('HUB_UNSUPPORTED_MEDIA_TYPE');
  });

  it('附带：modSaveLocation 相对路径 → 400 INVALID_INPUT（三个路径字段同规则）', async () => {
    const { base } = await startStack();
    const modFile = path.join(tempRoot, 'sample.ttsmod');
    await writeFile(
      modFile,
      writeZip([{ name: 'Mods/Workshop/1.json', data: Buffer.from('{}') }]),
    );
    const res = await postJson(base, '/pack/import-ttsmod', {
      file: modFile,
      modsParentDir: tempRoot,
      modSaveLocation: 'relative/saves',
    });
    expect(res.status).toBe(400);
    const body = expectTtsmodErrorBody(await res.json(), 'INVALID_INPUT');
    expect(body.message).toContain('modSaveLocation');
  });
});
