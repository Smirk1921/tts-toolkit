// src/protocol/tts-client.ts
/**
 * 出站通道：编辑器 → TTS（连接 TTS_PORT 39999）。
 *
 * 关键约束：连 → 写 → 关，绝不保持长连接。
 * TTS 每条连接只处理一条消息，长连接会导致消息无法送达。
 */
import net from 'node:net';

import type { OutboundMessage } from './messages.js';
import { TTS_PORT } from './ports.js';

/** sendToTts 的可选参数。 */
export interface SendToTtsOptions {
  /** 整个"连接 + 发送"过程的超时毫秒数，默认 5000。 */
  timeoutMs?: number;
  /** 覆盖目标主机；缺省 127.0.0.1（测试注入假 TTS 地址用）。 */
  host?: string;
  /** 覆盖目标端口；缺省 TTS_PORT（测试注入随机端口用）。 */
  port?: number;
}

/**
 * 向 TTS 发送一条出站消息（连 → 写 → 关）。
 *
 * @param msg 出站消息；建议发送前先用 messages.ts 的 outboundSchema 校验，
 *            尤其 CustomMessage 的 customMessage 必须是可 JSON 序列化的纯对象（Lua table）
 * @param opts 超时 / 目标地址端口覆盖等可选项
 * @returns 数据已写入并关闭写端后 resolve
 * @throws {Error} 连接被拒绝（ECONNREFUSED，TTS 未启动）、超时或其他网络错误，均为中文提示
 */
export async function sendToTts(msg: OutboundMessage, opts?: SendToTtsOptions): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const host = opts?.host ?? '127.0.0.1';
  const port = opts?.port ?? TTS_PORT;
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const ok = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const fail = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => {
      fail(
        new Error(
          `连接 TTS 超时（${timeoutMs}ms，${host}:${port}）。请确认游戏已启动并加载了存档。`,
        ),
      );
    }, timeoutMs);
    socket.on('connect', () => {
      socket.write(JSON.stringify(msg), 'utf8', () => {
        // 连 → 写 → 关：不保持长连接
        socket.end();
        ok();
      });
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      fail(
        err.code === 'ECONNREFUSED'
          ? new Error(`无法连接 TTS（${host}:${port}）。请确认游戏已启动并加载了存档。`)
          : new Error(`与 TTS 通信失败：${err.message}`),
      );
    });
  });
}
