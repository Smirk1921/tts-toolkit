// tests/unit/cli-shared.test.ts
/**
 * src/cli/_shared.ts（tryHubClient）单元测试。
 *
 * 覆盖场景（对应任务 C1 清单第 5 条）：
 * - hub 在线（probeHub 命中）→ 返回可用的 HubClient 实例；
 * - hub 不在线（probeHub 返回 null）→ 返回 null；
 * - 每次调用都现探（不缓存）：连续两次调用触发两次探测。
 *
 * 实现方式说明（与任务清单"用 stub HTTP 服务控制在线/不在线"的偏差）：
 * tryHubClient 内部硬编码连 127.0.0.1:39995（src/cli/_shared.ts:33 调
 * `probeHub()`、:37 调 `new HubClient()`，均取缺省端口 39995），而测试约束红线
 * 禁止绑定真实 39995 端口——stub HTTP 服务无法在不踩红线的前提下被 tryHubClient
 * 探测到。故以 vi.mock 替换 probeHub 这一个导出（HubClient 保持真实实现），
 * 在不占任何端口的情况下等价覆盖"在线 / 不在线"两条分支与全部行为断言。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/mcp/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/client.js')>();
  return { ...actual, probeHub: vi.fn() };
});

import { tryHubClient } from '../../src/cli/_shared.js';
import { HubClient, probeHub } from '../../src/mcp/client.js';

beforeEach(() => {
  vi.mocked(probeHub).mockReset();
});

describe('tryHubClient', () => {
  it('hub 在线（probeHub 命中）→ 返回 HubClient 实例', async () => {
    vi.mocked(probeHub).mockResolvedValue({ uptimeMs: 1, startedAt: 2 });
    const client = await tryHubClient();
    expect(client).toBeInstanceOf(HubClient);
    expect(probeHub).toHaveBeenCalledTimes(1);
    expect(probeHub).toHaveBeenCalledWith({ timeoutMs: 3000 }); // 放宽探测（窗口 G / Stage D：Windows 下 Node fetch 首次连接 127.0.0.1 实测 ~1.5s）
  });

  it('hub 不在线（probeHub 返回 null）→ 返回 null 且不抛', async () => {
    vi.mocked(probeHub).mockResolvedValue(null);
    const client = await tryHubClient();
    expect(client).toBeNull();
  });

  it('不缓存：每次调用都重新探测', async () => {
    vi.mocked(probeHub).mockResolvedValue(null);
    await tryHubClient();
    await tryHubClient();
    expect(probeHub).toHaveBeenCalledTimes(2);
  });
});
