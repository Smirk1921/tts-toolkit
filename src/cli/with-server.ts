// src/cli/with-server.ts
/**
 * CLI 与协议层 / 会话层之间的共享粘合代码。
 *
 * 职责：
 * - {@link withEditorServer}：临时独占绑定编辑器端口（39998）→ 执行回调 → finally 释放，
 *   让每条命令都能"用完即走"（坑 3：绑定必须走 EditorServer 内部的 exclusive 路径）；
 * - 错误分类助手：把协议 / 会话层抛出的异常映射成 CLI 的统一出口文案。
 *
 * 本文件属薄调用层，不含任何业务逻辑：探测、协议、会话实现分别在
 * src/protocol/、src/session/、src/datadir/、src/assets/ 中。
 */

import { t } from "../i18n/index.js";
import { EditorServer } from "../protocol/editor-server.js";
import { PortInUseError } from "../protocol/ports.js";
import { SessionExec } from "../session/exec.js";
import { SessionScripts } from "../session/scripts.js";

/** 一条命令执行的会话上下文（服务器已启动，端口已独占绑定）。 */
export interface Session {
  /** 协议层编辑器服务器（监听 39998，接收 TTS 主动推送的入站消息）。 */
  server: EditorServer;
  /** 会话层 Lua 执行器（ExecuteLua / ReturnValue 往返）。 */
  exec: SessionExec;
  /** 会话层脚本快照读写（GetScripts / SaveAndPlay）。 */
  scripts: SessionScripts;
}

/**
 * 临时绑定编辑器端口（39998）→ 执行回调 → finally 释放。
 *
 * 注意：回调内**不要**调用 process.exit()——那会跳过下面的 finally，
 * 导致端口未释放（进程退出时由操作系统回收，但同进程内的后续逻辑会拿不到端口）。
 * 正确做法是把异常抛出来，由命令的 catch 分支统一 exit。
 *
 * @param fn 收到会话上下文后执行的异步函数
 * @returns fn 的返回值
 * @throws {PortInUseError} 39998 被占用（含检测与绑定之间被抢占的竞态）
 * @throws 回调自身抛出的任何异常（原样向上传递，finally 已确保端口释放）
 */
export async function withEditorServer<T>(fn: (s: Session) => Promise<T>): Promise<T> {
  const server = new EditorServer();
  await server.start();
  try {
    const exec = new SessionExec(server);
    const scripts = new SessionScripts(server);
    return await fn({ server, exec, scripts });
  } finally {
    await server.close();
  }
}

/**
 * 取错误的中文描述（非 Error 值退化为 String）。
 * @param err 任意错误值
 * @returns 可读的错误描述
 */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 判定错误是否为"TTS 未启动 / 连不上 TTS"。
 *
 * 依赖 src/protocol/tts-client.ts 的文案（该模块把 ECONNREFUSED 包装为
 * "无法连接 TTS（…）"、连接超时包装为 "连接 TTS 超时（…）"），
 * 这里按文案匹配是 CLI 层唯一可行的判据（错误码在包装时丢失）。
 *
 * @param err 命令中捕获的异常
 * @returns 属于"未连接"类错误返回 true
 */
export function isNotConnectedError(err: unknown): boolean {
  const message = describeError(err);
  return /无法连接 TTS|连接 TTS 超时|ECONNREFUSED/.test(message);
}

/**
 * 判定错误是否为超时（编辑器未响应 / Lua 执行超时）。
 *
 * 调用方必须先判 {@link isNotConnectedError}：连接阶段的超时同样含"超时"二字，
 * 但语义是"TTS 没开"而不是"脚本跑太久"。
 *
 * @param err 命令中捕获的异常
 * @returns 属于超时类错误返回 true
 */
export function isTimeoutError(err: unknown): boolean {
  return /超时/.test(describeError(err));
}

/**
 * 判定错误是否为编辑器端口被占用。
 * @param err 命令中捕获的异常
 * @returns 是 PortInUseError 实例时返回 true
 */
export function isPortInUseError(err: unknown): err is PortInUseError {
  return err instanceof PortInUseError;
}

/**
 * 红色 ANSI 着色（不引入 chalk，保持零额外依赖）。
 * 管道 / 重定向输出（非 TTY）或设置了 NO_COLOR 时自动降级为纯文本。
 *
 * @param text 待着色文本
 * @returns 着色后的文本（或原文本）
 */
export function red(text: string): string {
  const colorable = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
  return colorable ? `\u001b[31m${text}\u001b[0m` : text;
}

/**
 * 命令的统一错误出口：把异常映射成中文提示并写入 stderr。
 *
 * 分类顺序（先特殊后一般）：
 * 1. 端口占用 → 直接输出协议层的中文原文（含 PID 与处置建议）；
 * 2. 连不上 TTS → 输出调用方指定的 notConnectedKey 文案；
 * 3. 其他 → error.generic（含原始错误描述）。
 *
 * @param err 命令中捕获的异常
 * @param notConnectedKey 连不上 TTS 时使用的翻译键（如 "cli.exec.notConnected"）
 * @returns 建议的进程退出码（当前恒为 1）
 */
export function reportError(err: unknown, notConnectedKey: string): number {
  if (isPortInUseError(err)) {
    console.error(red(err.message));
    return 1;
  }
  if (isNotConnectedError(err)) {
    console.error(t(notConnectedKey));
    return 1;
  }
  console.error(t("error.generic", { message: describeError(err) }));
  return 1;
}
