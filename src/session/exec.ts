// src/session/exec.ts
import type { EditorServer } from "../protocol/editor-server.js";
import { InboundId, OutboundId, type InboundMessage } from "../protocol/messages.js";
import { sendToTts } from "../protocol/tts-client.js";

/** guid 为 "-1" 表示 TTS 全局脚本（Global Script） */
const DEFAULT_GUID = "-1";

/** exec 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 等待返回值期间扫描 Error 消息的轮询间隔（毫秒），与官方参考实现的 50ms 轮询一致 */
const ERROR_POLL_INTERVAL_MS = 50;

/** exec / execJson 的可选参数 */
export interface ExecOptions {
  /** 目标对象 guid；缺省为 "-1"（全局脚本）。对象必须已有脚本，否则 TTS 报 "Object reference not set" */
  guid?: string;
  /** 超时毫秒数；缺省 30000 */
  timeoutMs?: number;
}

/** LuaError 的构造字段 */
export interface LuaErrorFields {
  /** 报错脚本所属对象的 guid */
  guid: string;
  /** TTS 报错消息前缀（如 "Error in Global Script: "） */
  prefix: string;
  /** TTS 原始报错文本（含行列号信息） */
  error: string;
  /** 从 error 中解析出的行号；解析失败时为 undefined */
  line?: number;
  /** 起始列号；解析失败时为 undefined */
  col?: number;
  /** 结束列号；解析失败时为 undefined */
  endCol?: number;
}

/**
 * Lua 执行错误。
 *
 * 携带 TTS Error 消息（messageID 3）的完整上下文：guid、errorMessagePrefix、error，
 * 以及从 error 文本中按 `(行,起列-止列)` 格式（如 `(36,4-8)`）解析出的行列号。
 */
export class LuaError extends Error {
  /** 报错脚本所属对象的 guid */
  readonly guid: string;
  /** TTS 报错消息前缀 */
  readonly prefix: string;
  /** TTS 原始报错文本 */
  readonly error: string;
  /** 行号（解析失败时 undefined） */
  readonly line: number | undefined;
  /** 起始列号（解析失败时 undefined） */
  readonly col: number | undefined;
  /** 结束列号（解析失败时 undefined） */
  readonly endCol: number | undefined;

  /**
   * @param fields 错误上下文字段
   */
  constructor(fields: LuaErrorFields) {
    const loc =
      fields.line !== undefined
        ? `（Lua 第 ${fields.line} 行，第 ${fields.col}–${fields.endCol} 列）`
        : "";
    super(`${fields.prefix}${fields.error}${loc}`);
    this.name = "LuaError";
    this.guid = fields.guid;
    this.prefix = fields.prefix;
    this.error = fields.error;
    this.line = fields.line;
    this.col = fields.col;
    this.endCol = fields.endCol;
  }
}

/**
 * 从 TTS 报错文本中解析行列号。
 *
 * TTS 报错格式实测为 `chunk_0:(36,4-8): unexpected symbol ...`，
 * 即 `(行,起列-止列)`。
 *
 * @param error TTS 原始报错文本
 * @returns 解析结果；未匹配到时各字段为 undefined
 */
function parsePosition(error: string): Pick<LuaErrorFields, "line" | "col" | "endCol"> {
  const m = /\((\d+),(\d+)-(\d+)\)/.exec(error);
  if (m === null) return {};
  return { line: Number(m[1]), col: Number(m[2]), endCol: Number(m[3]) };
}

/** messageID 5（ReturnValue）消息在本模块内的字段视图 */
interface ReturnValueView {
  messageID: typeof InboundId.ReturnValue;
  returnValue: unknown;
  returnID: number;
}

/** messageID 3（Error）消息在本模块内的字段视图 */
interface ErrorView {
  messageID: typeof InboundId.Error;
  guid: string;
  errorMessagePrefix: string;
  error: string;
}

/**
 * 判定消息是否为指定 returnID 的返回值消息。
 *
 * 通过视图类型访问字段，不依赖协议层判别联合的具体声明方式。
 */
function isReturnValueOf(
  m: InboundMessage,
  returnID: number,
): m is InboundMessage & ReturnValueView {
  return (
    m.messageID === InboundId.ReturnValue &&
    (m as InboundMessage & ReturnValueView).returnID === returnID
  );
}

/** 判定消息是否为 Lua 报错消息（messageID 3） */
function isErrorView(m: InboundMessage): m is InboundMessage & ErrorView {
  return m.messageID === InboundId.Error;
}

/** 把 Error 消息转成携带行列号的 LuaError */
function toLuaError(msg: InboundMessage & ErrorView): LuaError {
  return new LuaError({
    guid: msg.guid,
    prefix: msg.errorMessagePrefix,
    error: msg.error,
    ...parsePosition(msg.error),
  });
}

/**
 * 检测 Lua 多返回值的异常返回形态。
 * 实测 `return 1, 2` 会回传内部对象引用 `{ ReferenceID: ..., Type: ... }`。
 */
function isMultiReturnMarker(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const rec = v as Record<string, unknown>;
  return typeof rec.ReferenceID === "number" && typeof rec.Type === "number";
}

/**
 * 返回值整形：
 * - null / undefined → null（对应 Lua `return nil`；TTS 实测回传 returnValue 为 null）
 * - 多返回值内部引用 → 抛错（提示改用 JSON.encode）
 * - 整数值的 number → Math.trunc（TTS 数字回传全是浮点，`1+1` 实测回传 `2.0`）
 *
 * @throws Error 检测到多返回值形态时
 */
function shapeReturnValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (isMultiReturnMarker(value)) {
    throw new Error(
      "检测到 Lua 多返回值。TTS 协议不支持 return 1, 2，请改用 return JSON.encode({...})",
    );
  }
  if (typeof value === "number" && Number.isInteger(value)) return Math.trunc(value);
  return value;
}

/** 把 Lua 代码包装为 `return JSON.encode(...)` 形式 */
function wrapAsJsonEncode(lua: string): string {
  const trimmed = lua.trim();
  // 以关键字 return 开头（\b 排除 returnx 之类的标识符）：return 之后的部分即表达式；
  // 表达式统一去除首尾空白，得到紧凑形式（如 "return {a=1}" → "return JSON.encode({a=1})"）
  const expr = (/^return\b/.test(trimmed) ? trimmed.slice("return".length) : trimmed).trim();
  return `return JSON.encode(${expr})`;
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 会话层 Lua 执行封装（SessionExec）。
 *
 * 封装 TTS 外部编辑器协议的 Execute Lua（出站 messageID 3）/ 返回值（入站 messageID 5）往返，
 * 并处理实测的三大坑：
 * 1. 返回值只支持标量，table 会静默失败 → 超时错误信息中说明可能原因；
 * 2. 多返回值 `return 1, 2` 会回传内部对象引用 → 显式报错提示改用 JSON.encode；
 * 3. Lua 报错走独立的 Error 消息（入站 messageID 3）→ 等待期间并行扫描，立即抛 LuaError。
 */
export class SessionExec {
  /** 下一个待分配的 returnID（从 1 开始自增；TTS 会在 ReturnValue 消息中原样带回） */
  private nextReturnId = 1;

  /**
   * @param server 已启动的协议层编辑器服务（监听 39998，留存消息只增不删）
   */
  constructor(private readonly server: EditorServer) {}

  /**
   * 执行 Lua 代码并等待标量返回值。
   *
   * 流程：分配自增 returnID → 发送 Execute Lua（出站 messageID 3）→
   * 等待 ReturnValue（入站 messageID 5 且 returnID 匹配），
   * 期间并行扫描同 guid 的 Error 消息（入站 messageID 3），发现本次执行后的报错立即抛 LuaError。
   *
   * “时间在 returnID 发出之后”的判定：协议层消息不带时间戳，改为在发送前快照
   * 已留存的同 returnID 返回值消息与全部 Error 消息的引用集合；留存列表只增不删，
   * 快照之外的匹配消息即为本次请求之后新到的。
   *
   * @param lua 要执行的 Lua 代码（如 `return 1+1`）
   * @param opts 可选：guid（默认 "-1" 全局脚本）、timeoutMs（默认 30000）
   * @returns Lua 标量返回值；数字已整型化（2.0 → 2）；`return nil` → null
   * @throws LuaError TTS 报告 Lua 执行错误（含 guid / 前缀 / 原文 / 行列号）
   * @throws Error 检测到多返回值形态
   * @throws Error 等待超时——此时若无任何 Error 消息，多半是返回了 table（协议静默丢弃）或端口 39998 被劫持
   */
  async exec(lua: string, opts: ExecOptions = {}): Promise<unknown> {
    const guid = opts.guid ?? DEFAULT_GUID;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const returnID = this.nextReturnId++;

    // 发送前快照：见方法 JSDoc 中“时间在 returnID 发出之后”的判定说明
    const staleValues = new Set(this.server.find((m) => isReturnValueOf(m, returnID)));
    const staleErrors = new Set(this.server.find(isErrorView));

    await sendToTts({ messageID: OutboundId.ExecuteLua, guid, script: lua, returnID });

    const deadline = Date.now() + timeoutMs;
    let finished = false;

    /**
     * 扫描“本次执行之后新到的、同 guid”的第一条 Error 消息。
     * 协议层 find 不做窄化（返回 InboundMessage[]），此处运行时已由 isErrorView
     * 保证元素均为 Error 消息，故对元素做一次收窄断言。
     */
    const scanFreshError = (): (InboundMessage & ErrorView) | undefined =>
      (this.server.find(isErrorView) as Array<InboundMessage & ErrorView>).find(
        (m) => m.guid === guid && !staleErrors.has(m),
      );

    const valuePromise = this.server.waitFor(
      (m: InboundMessage): m is InboundMessage & ReturnValueView =>
        isReturnValueOf(m, returnID) && !staleValues.has(m),
      timeoutMs,
    );
    // Error 消息先到并抛出 LuaError 时，valuePromise 仍会在超时后 reject，提前挂上 catch 防止 unhandled rejection
    valuePromise.catch(() => {});

    // “同时”扫描 Error：以固定间隔轮询，发现本次执行后的报错立即返回（不等超时）
    const errorPromise = (async (): Promise<(InboundMessage & ErrorView) | undefined> => {
      while (!finished && Date.now() < deadline) {
        const hit = scanFreshError();
        if (hit !== undefined) return hit;
        await sleep(Math.min(ERROR_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 1)));
      }
      return undefined;
    })();
    errorPromise.catch(() => {});

    try {
      let winner = await Promise.race([valuePromise, errorPromise]);
      if (winner === undefined) {
        // 计时器到点而 waitFor 尚未落定的瞬间窗口：以 waitFor 的结果为准
        winner = await valuePromise;
      }
      if ((winner as InboundMessage).messageID === InboundId.Error) {
        throw toLuaError(winner as InboundMessage & ErrorView);
      }
      return shapeReturnValue((winner as InboundMessage & ReturnValueView).returnValue);
    } catch (err) {
      if (err instanceof LuaError) throw err;
      // 超时分类：有本次执行后的 Error 消息 → 脚本报错；否则 → table 静默失败或端口被劫持
      const fresh = scanFreshError();
      if (fresh !== undefined) throw toLuaError(fresh);
      if (err instanceof Error && err.message.includes("超时")) {
        throw new Error(
          "执行超时。可能原因：1) Lua 返回了 table（协议不支持，会被静默丢弃）；2) 端口 39998 被劫持",
        );
      }
      throw err;
    } finally {
      finished = true;
    }
  }

  /**
   * 推荐入口：执行 Lua 并把返回值当作 JSON 解析，拿回结构化数据。
   *
   * 自动把代码包装为 `return JSON.encode(...)`（TTS 内置 JSON 全局，实测可用），
   * 绕开“协议返回值只支持标量、table 静默失败”的坑（坑 1）：
   * - 若 lua 以关键字 `return` 开头（首尾空白去除后），把 return 之后的部分作为表达式；
   * - 否则把整段代码（去除首尾空白后）作为表达式包装。
   * 注意：包装后只支持单个表达式或单个 return 语句，多语句逻辑请收进立即执行函数。
   *
   * @param lua Lua 表达式或 return 语句（如 `return {a=1,b="x"}`）
   * @param opts 可选：guid（默认 "-1"）、timeoutMs（默认 30000）
   * @returns JSON.parse 后的结构化结果
   * @throws LuaError TTS 报告 Lua 执行错误
   * @throws Error `JSON.parse` 失败（拿到的不是字符串或不是合法 JSON）
   * @throws Error 同 {@link SessionExec.exec} 的超时 / 多返回值错误
   */
  async execJson<T = unknown>(lua: string, opts: ExecOptions = {}): Promise<T> {
    const raw = await this.exec(wrapAsJsonEncode(lua), opts);
    if (typeof raw !== "string") {
      // 正常情况下 JSON.encode 一定回传字符串；走到这里说明拿到了 nil 等意外形态
      throw new Error(`JSON.parse 失败：${String(raw)}`);
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`JSON.parse 失败：${raw}`);
    }
  }
}
