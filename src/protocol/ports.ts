// src/protocol/ports.ts
/**
 * 端口常量与端口占用检测。
 *
 * 坑 3（Windows SO_REUSEADDR 允许双绑）：Windows 上可能出现两个进程"绑定成功"
 * 同一端口、但消息只被其中一个收到（表现为"绑定成功但收不到消息"）。
 * 因此所有监听一律传 `exclusive: true`，端口检测也必须先做独占绑定验证。
 */
import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 编辑器侧监听端口：TTS 主动连过来推送消息（入站方向）。 */
export const EDITOR_PORT = 39998;
/** TTS 监听端口：编辑器侧连过去发请求（出站方向）。 */
export const TTS_PORT = 39999;
/** 预留：hub TCP 扇出端口（阶段 4 实现，本次不使用）。 */
export const HUB_TCP_PORT = 39997;
/** 预留：hub WebSocket 扇出端口（阶段 4 实现，本次不使用）。 */
export const HUB_WS_PORT = 39996;

/** {@link checkExclusive} 的返回结果。 */
export type ExclusiveCheckResult = { ok: true } | { ok: false; pid?: number; reason: string };

/**
 * 端口被占用时抛出的错误。
 * 携带被占用的端口号与（若能查到）占用进程的 PID。
 */
export class PortInUseError extends Error {
  /** 被占用的端口。 */
  readonly port: number;
  /** 占用端口的进程 PID；查询不到时为 undefined（字段省略）。 */
  readonly pid?: number;

  /**
   * @param port 被占用的端口
   * @param pid 占用进程 PID；未知时省略该字段
   * @param message 中文错误描述；缺省给出通用提示
   */
  constructor(port: number, pid?: number, message?: string) {
    super(message ?? `端口 ${port} 已被占用。请检查是否有其他程序在使用。`);
    this.name = 'PortInUseError';
    this.port = port;
    if (pid !== undefined) {
      this.pid = pid;
    }
  }
}

/**
 * 用 pwsh 查询监听指定端口的进程 PID（仅 Windows 有效，其他平台直接返回 undefined）。
 * 查询失败（pwsh 不可用、无监听进程等）时静默返回 undefined，不向上抛错。
 *
 * @param port 目标端口
 * @returns 占用进程的 PID；查不到为 undefined
 */
async function getPortOwnerPid(port: number): Promise<number | undefined> {
  if (process.platform !== 'win32') {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
          'Select-Object -First 1 -ExpandProperty OwningProcess',
      ],
      { timeout: 10_000, windowsHide: true },
    );
    const pid = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 构造端口占用错误：查询占用进程 PID 并生成中文提示。
 * 供 {@link checkExclusive} 与 EditorServer 的 listen 竞态路径复用，保证提示文案一致。
 *
 * @param port 被占用的端口
 * @returns 携带 pid（若查到）与中文 reason 的错误对象
 */
export async function createPortInUseError(port: number): Promise<PortInUseError> {
  const pid = await getPortOwnerPid(port);
  return pid === undefined
    ? new PortInUseError(port, undefined, `端口 ${port} 已被占用。请检查是否有其他程序在使用。`)
    : new PortInUseError(
        port,
        pid,
        `端口 ${port} 已被占用（PID ${pid}）。常见原因：VSCode 的 TTS 插件正在运行，请关闭后重试。`,
      );
}

/**
 * 单次独占试绑（checkExclusive 的内部探针）。
 *
 * 用 `net.createServer().listen({ port, exclusive: true, host? })` 试绑：
 * - 成功：等 close 完成后返回 `{ ok: true }`（确保端口确实已释放）；
 * - EADDRINUSE：Windows 下用 pwsh 查占用进程 PID，返回 `{ ok: false, pid?, reason }`；
 * - 其他错误：返回 `{ ok: false, reason }`（不抛异常）。
 */
async function probeBind(port: number, host?: string): Promise<ExclusiveCheckResult> {
  return await new Promise<ExclusiveCheckResult>((resolve) => {
    const server = net.createServer();
    let settled = false;
    const settle = (result: ExclusiveCheckResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    server.once('error', (err: NodeJS.ErrnoException) => {
      void (async () => {
        if (err.code === 'EADDRINUSE') {
          const cause = await createPortInUseError(port);
          settle(
            cause.pid === undefined
              ? { ok: false, reason: cause.message }
              : { ok: false, pid: cause.pid, reason: cause.message },
          );
        } else {
          settle({ ok: false, reason: `端口 ${port} 检测失败：${err.message}` });
        }
      })();
    });
    server.once('listening', () => {
      // 等 close 完成再返回，确保端口已释放，避免与后续绑定互相干扰
      server.close(() => settle({ ok: true }));
    });
    // 坑 3：必须 exclusive: true，防止 Windows 上 SO_REUSEADDR 双绑
    server.listen({ port, exclusive: true, ...(host !== undefined ? { host } : {}) });
  });
}

/**
 * 检测端口能否被独占绑定（两段探针）。
 *
 * ① 通配地址试绑 `listen({ port, exclusive: true })`——失败即端口被占用；
 * ② 通过后补一次 `127.0.0.1` 特定地址试绑——坑 3 变体：实测（本机 TTS 监听
 *    127.0.0.1:39999）通配试绑会因 SO_REUSEADDR 的"通配 vs 特定地址共存"而
 *    假阴性，导致"绑定成功但 127.0.0.1 的消息被原占用者截走"。
 *    编辑器/插件间流量全部走 127.0.0.1，因此②是必要校验。
 *
 * @param port 待检测的端口
 * @returns `{ ok: true }` 或 `{ ok: false, pid?, reason }`；PID 查不到时省略 pid 字段
 */
export async function checkExclusive(port: number): Promise<ExclusiveCheckResult> {
  const wildcard = await probeBind(port);
  if (!wildcard.ok) {
    return wildcard;
  }
  const loopback = await probeBind(port, '127.0.0.1');
  if (!loopback.ok) {
    return loopback;
  }
  return { ok: true };
}
