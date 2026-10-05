// tests/unit/hub-control-push.test.ts
/**
 * src/hub/control.ts · POST /v1/push（阶段 5 写入路径升级）单元测试。
 *
 * 与 tests/unit/hub-control.test.ts 的分工：那里覆盖 12 条 S2 路由的通用分类
 * （404 / 405 / 415 / 请求侧校验 / confirm 门 / SSE），这里只深挖 /v1/push 升级
 * 后的委托契约：
 * - confirm 门保持不变（body.confirm !== true → 400 HUB_CONFIRM_REQUIRED，且
 *   **不触碰** pushSaveAndPlay）；
 * - 新字段透传：dryRun / forceScriptsOnly / skipBackup / skipBaselineCheck
 *   （可选布尔）与 backupRetention（可选正数）逐项校验，非法 → 400
 *   HUB_BAD_REQUEST；缺省对齐 MCP tts_push 语义（dryRun=false 实写、retention=20）；
 * - 坑 17：pushSaveAndPlay 收到的 opts.server 必须与 daemon.server **同一对象**
 *   （hub 复用已绑定的 39998，绝不二次绑定）；且不向其传 confirm 函数；
 * - 响应体形：{ok:true, dryRun, pushed, skipped, items(=pushed+skipped),
 *   backupDir?/baselineConflicts?/assetChanges?（仅存在时携带）}；
 * - 错误映射：PackError → 400 HUB_PACK_ERROR + details.packCode；其余 → 500。
 *
 * mock 策略（单测不真连 TTS / 不做真文件 IO）：
 * - `src/pack/push.js` 整模块 vi.mock——handlePush 升级后只 import
 *   pushSaveAndPlay 一个符号，流水线（pack.yaml 校验 / 基线 / 备份 / saveAndPlay）
 *   全部在 mock 边界之外，与本测试无关；
 * - daemon 与控制通道用真实现（随机临时端口，绝不绑 39995-39999），请求用真
 *   fetch 发出——HTTP 层（confirm 门 / 字段校验 / JSON 序列化）保持真实。
 *
 * 错误断言只看 code / details（协议层机器可读键），不断言 message 文案。
 */
import net, { type AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// —— 流水线 mock：handlePush 委托的唯一出口，全部断言在此观察 ——
vi.mock('../../src/pack/push.js', () => ({
  pushSaveAndPlay: vi.fn(),
}));

import { pushSaveAndPlay, type PushSaveResult } from '../../src/pack/push.js';
import { PackError } from '../../src/pack/packyaml.js';
import { HubDaemon } from '../../src/hub/daemon.js';
import { createControlServer, type ControlServer } from '../../src/hub/control.js';

const pushSaveAndPlayMock = vi.mocked(pushSaveAndPlay);

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
 * （daemon 三端口不暴露实绑端口也不支持 0，见 hub-daemon.test.ts 头注释的端口说明。）
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
 * @returns 运行中的栈
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
    return { daemon, control, base: `http://127.0.0.1:${control.boundPort()}/v1` };
  }
  throw lastErr;
}

/** 便捷 POST JSON，返回 Response */
const postJson = (base: string, body: unknown): Promise<Response> =>
  fetch(`${base}/push`, {
    method: 'POST',
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

// ---------------------------------------------------------------------------
// pushSaveAndPlay mock 的缺省返回值
// ---------------------------------------------------------------------------

/** mock 流水线的全字段返回（实写 + 全部可选字段都携带） */
const FULL_RESULT: PushSaveResult = {
  dryRun: false,
  pushed: 3,
  skipped: 2,
  backupDir: 'D:\\pack\\.tts\\backups\\20261005',
  baselineConflicts: [{ guid: 'aa11bb', name: '棋盘', kind: 'script', baselineHash: 'a', remoteHash: 'b' }],
  assetChanges: { changed: ['decks/x/cards.csv'], added: [], deleted: [] },
  note: 'note-text',
};

beforeEach(() => {
  pushSaveAndPlayMock.mockReset();
  pushSaveAndPlayMock.mockResolvedValue({ ...FULL_RESULT });
});

/** pushSaveAndPlay 收到的第一个入参（未调用时断言失败） */
function receivedOpts(): Record<string, unknown> {
  expect(pushSaveAndPlayMock).toHaveBeenCalledTimes(1);
  return pushSaveAndPlayMock.mock.calls[0][0] as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// confirm 门（保持现有行为）
// ---------------------------------------------------------------------------

describe('POST /v1/push · confirm 门（保持现有行为）', () => {
  it('不带 confirm → 400 HUB_CONFIRM_REQUIRED，且不触碰 pushSaveAndPlay', async () => {
    const { base } = await startStack();
    const res = await postJson(base, { root: 'D:\\pack' });
    await expectErrorBody(res, 400, 'HUB_CONFIRM_REQUIRED');
    expect(pushSaveAndPlayMock).not.toHaveBeenCalled();
  });

  it('confirm:false → 400 HUB_CONFIRM_REQUIRED，且不触碰 pushSaveAndPlay', async () => {
    const { base } = await startStack();
    const res = await postJson(base, { root: 'D:\\pack', confirm: false });
    await expectErrorBody(res, 400, 'HUB_CONFIRM_REQUIRED');
    expect(pushSaveAndPlayMock).not.toHaveBeenCalled();
  });

  it('confirm 非布尔（truthy 字符串）→ 400 HUB_CONFIRM_REQUIRED（严格 === true）', async () => {
    const { base } = await startStack();
    const res = await postJson(base, { root: 'D:\\pack', confirm: 'yes' });
    await expectErrorBody(res, 400, 'HUB_CONFIRM_REQUIRED');
    expect(pushSaveAndPlayMock).not.toHaveBeenCalled();
  });

  it('缺 root（confirm 之前先过 root 必填）→ 400 HUB_BAD_REQUEST', async () => {
    const { base } = await startStack();
    const res = await postJson(base, { confirm: true });
    await expectErrorBody(res, 400, 'HUB_BAD_REQUEST');
    expect(pushSaveAndPlayMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 委托：新字段透传 + 坑 17 注入
// ---------------------------------------------------------------------------

describe('POST /v1/push · 委托 pushSaveAndPlay（字段透传与坑 17 注入）', () => {
  it('confirm:true + 完整字段 → 200，pushSaveAndPlay 收到逐项透传的参数', async () => {
    const { base } = await startStack();
    const res = await postJson(base, {
      root: 'D:\\pack',
      confirm: true,
      dryRun: false,
      forceScriptsOnly: true,
      skipBackup: true,
      skipBaselineCheck: true,
      backupRetention: 33,
    });
    expect(res.status).toBe(200);
    const opts = receivedOpts();
    expect(opts).toEqual({
      root: 'D:\\pack',
      dryRun: false,
      forceScriptsOnly: true,
      skipBackup: true,
      skipBaselineCheck: true,
      backupRetention: 33,
      server: expect.anything(),
    });
    expect(opts).not.toHaveProperty('confirm'); // hub 场景不传 CLI 确认函数
  });

  it('缺省字段 → dryRun=false（confirm 已表意）/ 各开关 false / retention=20', async () => {
    const { base } = await startStack();
    const res = await postJson(base, { root: 'D:\\pack', confirm: true });
    expect(res.status).toBe(200);
    const opts = receivedOpts();
    expect(opts.dryRun).toBe(false);
    expect(opts.forceScriptsOnly).toBe(false);
    expect(opts.skipBackup).toBe(false);
    expect(opts.skipBaselineCheck).toBe(false);
    expect(opts.backupRetention).toBe(20);
  });

  it('坑 17：opts.server 与 daemon.server 是同一对象（注入而非新建）', async () => {
    const { base, daemon } = await startStack();
    const res = await postJson(base, { root: 'D:\\pack', confirm: true });
    expect(res.status).toBe(200);
    const opts = receivedOpts();
    expect(opts.server).toBe(daemon.server); // 同一引用：复用 hub 已绑定的编辑器端口
  });

  it('backupRetention 透传且不再追加额外键（入参逐键对齐）', async () => {
    const { base } = await startStack();
    await postJson(base, { root: 'D:\\pack', confirm: true, backupRetention: 1 });
    expect(Object.keys(receivedOpts()).sort()).toEqual(
      ['backupRetention', 'dryRun', 'forceScriptsOnly', 'root', 'server', 'skipBackup', 'skipBaselineCheck'],
    );
  });
});

// ---------------------------------------------------------------------------
// 响应体形（新形 + items 向后兼容别名）
// ---------------------------------------------------------------------------

describe('POST /v1/push · 响应体形', () => {
  it('全字段结果 → {ok:true, dryRun, pushed, skipped, items, backupDir, baselineConflicts, assetChanges}，note 不透出', async () => {
    const { base } = await startStack();
    const res = await postJson(base, { root: 'D:\\pack', confirm: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ok: true,
      dryRun: false,
      pushed: 3,
      skipped: 2,
      items: 5, // pushed + skipped 的向后兼容别名
      backupDir: FULL_RESULT.backupDir,
      baselineConflicts: FULL_RESULT.baselineConflicts,
      assetChanges: FULL_RESULT.assetChanges,
    });
    expect(body).not.toHaveProperty('note'); // note 是 CLI 文案，不进协议响应
  });

  it('dryRun=true → 响应体 dryRun:true（pushed 语义 = 将写入数，原样透传）', async () => {
    const { base } = await startStack();
    pushSaveAndPlayMock.mockResolvedValue({
      ...FULL_RESULT,
      dryRun: true,
      backupDir: undefined,
    });
    const res = await postJson(base, { root: 'D:\\pack', confirm: true, dryRun: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.dryRun).toBe(true);
    expect(body).not.toHaveProperty('backupDir'); // dry-run 无备份目录
  });

  it('结果无可选字段时响应体不带对应键（backupDir / baselineConflicts / assetChanges）', async () => {
    const { base } = await startStack();
    pushSaveAndPlayMock.mockResolvedValue({ dryRun: false, pushed: 1, skipped: 0, note: '' });
    const res = await postJson(base, { root: 'D:\\pack', confirm: true });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('backupDir');
    expect(body).not.toHaveProperty('baselineConflicts');
    expect(body).not.toHaveProperty('assetChanges');
    expect(body.items).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 错误映射
// ---------------------------------------------------------------------------

describe('POST /v1/push · 错误映射', () => {
  it('PackError → 400 HUB_PACK_ERROR + details.packCode 透传业务错误码', async () => {
    const { base } = await startStack();
    pushSaveAndPlayMock.mockRejectedValue(
      new PackError('PUSH_ASSET_CHANGES_DETECTED', '素材有改动'),
    );
    const res = await postJson(base, { root: 'D:\\pack', confirm: true });
    const err = await expectErrorBody(res, 400, 'HUB_PACK_ERROR');
    expect(err.details?.packCode).toBe('PUSH_ASSET_CHANGES_DETECTED');
  });

  it('BASELINE_CONFLICT 的 PackError 同样 400 + packCode 透传', async () => {
    const { base } = await startStack();
    pushSaveAndPlayMock.mockRejectedValue(new PackError('BASELINE_CONFLICT', '基线冲突'));
    const res = await postJson(base, { root: 'D:\\pack', confirm: true });
    const err = await expectErrorBody(res, 400, 'HUB_PACK_ERROR');
    expect(err.details?.packCode).toBe('BASELINE_CONFLICT');
  });

  it('普通 Error → 500 HUB_INTERNAL_ERROR', async () => {
    const { base } = await startStack();
    pushSaveAndPlayMock.mockRejectedValue(new Error('boom'));
    const res = await postJson(base, { root: 'D:\\pack', confirm: true });
    await expectErrorBody(res, 500, 'HUB_INTERNAL_ERROR');
  });

  it('非 Error 抛出值（字符串）→ 500 HUB_INTERNAL_ERROR', async () => {
    const { base } = await startStack();
    pushSaveAndPlayMock.mockRejectedValue('plain-string-rejection');
    const res = await postJson(base, { root: 'D:\\pack', confirm: true });
    await expectErrorBody(res, 500, 'HUB_INTERNAL_ERROR');
  });
});

// ---------------------------------------------------------------------------
// 新字段逐项校验（可选布尔 / 可选正数）
// ---------------------------------------------------------------------------

describe('POST /v1/push · 新字段类型校验（400 HUB_BAD_REQUEST）', () => {
  const badBodies: ReadonlyArray<{ name: string; field: Record<string, unknown> }> = [
    { name: 'dryRun 是字符串', field: { dryRun: 'true' } },
    { name: 'dryRun 是数字', field: { dryRun: 1 } },
    { name: 'forceScriptsOnly 是字符串', field: { forceScriptsOnly: 'yes' } },
    { name: 'skipBackup 是数字', field: { skipBackup: 0 } },
    { name: 'skipBaselineCheck 是 null', field: { skipBaselineCheck: null } },
    { name: 'backupRetention 是字符串', field: { backupRetention: '20' } },
    { name: 'backupRetention 是 0', field: { backupRetention: 0 } },
    { name: 'backupRetention 是负数', field: { backupRetention: -5 } },
  ];

  for (const { name, field } of badBodies) {
    it(`${name} → 400 HUB_BAD_REQUEST，且不触碰 pushSaveAndPlay`, async () => {
      const { base } = await startStack();
      const res = await postJson(base, { root: 'D:\\pack', confirm: true, ...field });
      await expectErrorBody(res, 400, 'HUB_BAD_REQUEST');
      expect(pushSaveAndPlayMock).not.toHaveBeenCalled();
    });
  }

  it('backupRetention 合法值（正数）→ 透传不报错', async () => {
    const { base } = await startStack();
    const res = await postJson(base, { root: 'D:\\pack', confirm: true, backupRetention: 100 });
    expect(res.status).toBe(200);
    expect(receivedOpts().backupRetention).toBe(100);
  });
});
