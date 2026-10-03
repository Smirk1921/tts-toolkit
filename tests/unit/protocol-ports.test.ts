// tests/unit/protocol-ports.test.ts
/**
 * ports.ts 单元测试：checkExclusive / PortInUseError。
 * 不依赖真实 39996-39999 端口：空闲端口用 listen(0) 临时抢占获取，
 * 占用场景用临时 net.createServer 自造。
 */
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PortInUseError, checkExclusive } from '../../src/protocol/ports.js';

/** afterEach 统一关闭的占位服务器集合 */
const placeholders: net.Server[] = [];

afterEach(async () => {
  for (const server of placeholders) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  placeholders.length = 0;
});

/**
 * 起一个临时监听抢占空闲随机端口，随后立即释放并返回端口号。
 * 保证后续 checkExclusive 检测的是真正空闲的端口。
 */
async function grabFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('checkExclusive', () => {
  it('空闲端口返回 { ok: true }', async () => {
    const port = await grabFreePort();
    await expect(checkExclusive(port)).resolves.toEqual({ ok: true });
  });

  it('被占端口返回 { ok: false }，reason 包含端口号与占用进程 PID', async () => {
    const port = await grabFreePort();
    const blocker = net.createServer();
    placeholders.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(port, () => resolve()));
    const result = await checkExclusive(port);
    expect(result.ok).toBe(false);
    if (result.ok) return; // 类型收窄辅助（上一行已断言 false）
    expect(result.reason).toContain(`端口 ${port}`);
    // 占用者就是本测试进程：pwsh Get-NetTCPConnection 应查到本进程 PID
    expect(result.pid).toBe(process.pid);
  }, 15_000);

  it('检测完成后端口已释放：同一端口可连续两次检测成功（边界）', async () => {
    const port = await grabFreePort();
    await expect(checkExclusive(port)).resolves.toEqual({ ok: true });
    await expect(checkExclusive(port)).resolves.toEqual({ ok: true });
  });
});

describe('PortInUseError', () => {
  it('携带 port / pid 字段，缺省 message 为含端口号的中文提示', () => {
    const err = new PortInUseError(45123, 456);
    expect(err.port).toBe(45123);
    expect(err.pid).toBe(456);
    expect(err.name).toBe('PortInUseError');
    expect(err.message).toContain('45123');
  });

  it('自定义 message 原样保留（createPortInUseError 查到 PID 时会传入含 PID 的文案）', () => {
    const err = new PortInUseError(
      45123,
      456,
      '端口 45123 已被占用（PID 456）。常见原因：VSCode 的 TTS 插件正在运行，请关闭后重试。',
    );
    expect(err.message).toContain('PID 456');
    expect(err.message).toContain('VSCode 的 TTS 插件');
  });

  it('未提供 pid 时 pid 字段省略，message 为通用中文提示', () => {
    const err = new PortInUseError(45123);
    expect(err.pid).toBeUndefined();
    expect(err.message).toContain('端口 45123 已被占用');
  });

  it('是 Error 的子类，可被 instanceof / try-catch 正常捕获', () => {
    expect(new PortInUseError(1)).toBeInstanceOf(Error);
    expect(new PortInUseError(1)).toBeInstanceOf(PortInUseError);
  });
});
