// src/hub/control.ts
/**
 * hub 控制通道（S2）：HTTP+JSON 服务，监听 http://127.0.0.1:39995/v1，零框架（node:http）。
 *
 * 路由表（与方案设计 §14.5.1 S2 一致；不暴露 pack export / pack import .ttsmod /
 * sync-upstream / review）：
 *
 * | 方法 | 路由                      | 作用                                |
 * | ---- | ------------------------- | ----------------------------------- |
 * | GET  | /v1/status                | hub 健康 + TTS 连接状态             |
 * | POST | /v1/scripts/pull          | 拉全部脚本到工作区                  |
 * | POST | /v1/scripts/save-and-play | 回写 scriptStates（供 push 用）     |
 * | POST | /v1/exec                  | 执行 Lua 返回 JSON                  |
 * | POST | /v1/assets/check          | 素材盘点 / 存活检测                 |
 * | GET  | /v1/packs                 | 列出注册表图包                      |
 * | POST | /v1/deck/slice            | 切片                                |
 * | POST | /v1/deck/plan             | 替换计划 dry-run                    |
 * | POST | /v1/import                | 按 import.yaml 导入                 |
 * | POST | /v1/diff                  | 本地 vs 游戏内差异                  |
 * | POST | /v1/push                  | 写回并重载（必须 confirm:true）     |
 * | POST | /v1/hub/shutdown          | 优雅关闭 hub                        |
 * | GET  | /v1/events                | SSE 事件流                          |
 *
 * 统一约定：
 * - 只监听回环地址（opts.host 缺省 "127.0.0.1"；通配地址 "0.0.0.0" / "::" /
 *   空串在 {@link createControlServer} 构造时直接抛错，绝不监听所有接口）；
 * - POST 请求体上限 1MB（超限 413），Content-Type 必须是 application/json
 *   （否则 415）；三条 GET 路由不读请求体；
 * - 响应统一 JSON；错误统一 `{error:{code,message,details?}}` + 4xx/5xx：
 *   - 请求侧：HUB_BAD_REQUEST / HUB_NOT_FOUND / HUB_METHOD_NOT_ALLOWED /
 *     HUB_PAYLOAD_TOO_LARGE / HUB_UNSUPPORTED_MEDIA_TYPE / HUB_CONFIRM_REQUIRED；
 *   - 业务侧：{@link PackError} → 400 HUB_PACK_ERROR（details.packCode 透传业务错误码）、
 *     {@link LuaError} → 400 HUB_LUA_ERROR（details 携带 guid / line / col / endCol）、
 *     其余异常 → 500 HUB_INTERNAL_ERROR；
 * - /v1/deck/slice 与 /v1/deck/plan 的请求体就是 {@link SliceOptions} /
 *   {@link PlanOptions} 本身（sheetPath/savePath/outDir、savePath/rules 由调用方
 *   显式给绝对路径，与 CLI 的 --sheet/--save/-o 同构；不做 root+deck → 路径推导）。
 *   slice 不注入 selectCandidate——HTTP 场景无交互，多候选时 sliceAtlas 抛
 *   SLICE_AMBIGUOUS（PackError → 400 HUB_PACK_ERROR），调用方应先用 deckKey /
 *   deckGuid 消歧后重试；
 * - /v1/push（阶段 5 写入路径）：整条流水线委托 src/pack/push.ts 的
 *   pushSaveAndPlay（素材改动检测 → 基线冲突检测 → 备份 → 无变化过滤 →
 *   强制带 ui → saveAndPlay → 回读校验 → 更新基线），并注入 daemon.server
 *   复用 hub 已绑定的编辑器端口（坑 17，绝不二次绑定 39998）。confirm 门不变
 *   （body.confirm !== true → 400 HUB_CONFIRM_REQUIRED）；请求体扩展字段
 *   dryRun / forceScriptsOnly / skipBackup / skipBaselineCheck（可选布尔）与
 *   backupRetention（可选正数）逐项校验后透传，缺省 dryRun=false（confirm 已
 *   表达实写意图）、backupRetention=20；响应体
 *   `{ok:true, dryRun, pushed, skipped, items(=pushed+skipped), backupDir?,
 *   baselineConflicts?, assetChanges?}`，业务 PackError 由 respondError 统一
 *   映射为 400 HUB_PACK_ERROR + details.packCode。
 *
 * 本模块不产出面向用户的文案：错误 message 是协议层英文短句（消费方是 MCP 工具
 * 层与运维日志，双语呈现由 MCP 层负责），与 src/hub/lifecycle.ts 的日志同一口径
 * 不引入 i18n；业务错误（PackError / LuaError）的 message 由底层模块经 t() 生成
 * 后原样透传。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { checkUrls } from "../assets/check.js";
import { planReplace, type PlanOptions } from "../deck/plan.js";
import { sliceAtlas, type SliceOptions } from "../deck/slice.js";
import { diffWorkspace } from "../pack/diff.js";
import { importAssets } from "../pack/import.js";
import { PackError } from "../pack/packyaml.js";
import { pullFromGame } from "../pack/pull.js";
import { pushSaveAndPlay } from "../pack/push.js";
import { readRegistry } from "../pack/registry.js";
import { InboundId } from "../protocol/messages.js";
import { luaGetObjectCount, luaGetVersion } from "../session/lua.js";
import { LuaError } from "../session/exec.js";
import type { ScriptState } from "../session/scripts.js";
import type { HubDaemon } from "./daemon.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 控制通道缺省端口（S2 方案：HTTP+JSON on http://127.0.0.1:39995/v1）。 */
const DEFAULT_CONTROL_PORT = 39995;

/** 控制通道缺省监听地址（只绑回环，绝不监听所有接口）。 */
const DEFAULT_CONTROL_HOST = "127.0.0.1";

/** 拒绝监听的通配地址（构造 {@link createControlServer} 时直接抛错）。 */
const FORBIDDEN_HOSTS: ReadonlySet<string> = new Set(["", "0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);

/** 请求体大小上限：1MB。 */
const MAX_BODY_BYTES = 1_048_576;

/** /v1/push 请求不带 backupRetention 时的备份保留份数（与 pushSaveAndPlay 缺省一致）。 */
const DEFAULT_BACKUP_RETENTION = 20;

/** /v1/status 探测 TTS 时单次 exec 的超时毫秒数。 */
const TTS_PROBE_TIMEOUT_MS = 2_000;

/** stop() 等现有连接结束的宽限期；超时后强关全部连接。 */
const STOP_GRACE_MS = 1_000;

/**
 * SSE 转发的入站消息 ID 集合（S2 路由表约定：GameLoaded / Print / Error /
 * CustomMessage / GameSaved / ObjectCreated；不含 PushNewObject 与 ReturnValue——
 * 前者是内部推送，后者是 exec 往返的协议噪声）。
 */
const SSE_FORWARDED_MESSAGE_IDS: ReadonlySet<number> = new Set<number>([
  InboundId.GameLoaded,
  InboundId.Print,
  InboundId.Error,
  InboundId.CustomMessage,
  InboundId.GameSaved,
  InboundId.ObjectCreated,
]);

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** {@link createControlServer} 的选项。 */
export interface ControlServerOptions {
  /** 监听端口（默认 39995，测试可注入随机端口；0 表示由操作系统分配临时端口）。 */
  port?: number;
  /** 监听地址（默认 "127.0.0.1"，绝不接受 0.0.0.0 等通配地址）。 */
  host?: string;
  /** 日志回调（默认 console.error；生命周期层会注入 JSON Lines 写入器）。 */
  log?: (line: string) => void;
  /**
   * 优雅退出回调（/v1/hub/shutdown 调用；返回 promise 表示退出流程已启动）。
   * 响应发出后才触发；回调自身的失败只记日志，绝不产生未处理 rejection。
   */
  onShutdown?: () => Promise<void>;
}

/** hub 控制通道服务器句柄（{@link createControlServer} 的返回值）。 */
export interface ControlServer {
  /** 启动 HTTP 服务（重复调用幂等，直接返回）。 */
  start(): Promise<void>;
  /** 停止 HTTP 服务（等现有连接结束或超时强关；未启动时幂等返回）。 */
  stop(): Promise<void>;
  /**
   * 实际监听的端口（启动后可用；port=0 时有用）。
   * @returns 实际绑定的端口号
   * @throws Error 尚未成功 start（地址未分配）时
   */
  boundPort(): number;
}

// ---------------------------------------------------------------------------
// 内部类型与工具
// ---------------------------------------------------------------------------

/**
 * 请求体校验失败（路由内部抛出；dispatch 统一转 400 HUB_BAD_REQUEST）。
 * 模块内部错误类型，不导出。
 */
class BadRequestError extends Error {
  /**
   * @param message 英文校验失败描述（进入 error.message）
   */
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/** 统一 JSON 错误响应体结构。 */
interface ErrorBody {
  /** 固定为 "error" 键的嵌套结构 */
  error: {
    /** 机器可读错误码（HUB_* 或透传约定） */
    code: string;
    /** 错误描述（协议层英文短句 / 底层透传文本） */
    message: string;
    /** 可选的结构化细节 */
    details?: Record<string, unknown>;
  };
}

/** 读请求体的结果（三态：读满 / 超限 / 连接中途断开）。 */
type BodyReadResult =
  | { kind: "ok"; buffer: Buffer }
  | { kind: "too-large" }
  | { kind: "aborted" };

/** 单条路由的处理函数（url 为已解析的请求 URL，含查询参数）。 */
type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;

/**
 * 从 unknown 错误中取人类可读描述（非 Error 退化为 String）。
 * @param err 任意抛出值
 * @returns 错误描述文本
 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 判定值是否为"键值对象"（不含 null 与数组）。
 * @param v 任意值
 * @returns 是普通对象时 true
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 判定值是否为字符串数组。
 * @param v 任意值
 * @returns 是字符串数组时 true
 */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

/**
 * 判定 Content-Type 是否为 application/json（允许带 charset 等参数）。
 * @param contentType 请求头 content-type（可能 undefined）
 * @returns 是 JSON 媒体类型时 true
 */
function isJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) {
    return false;
  }
  return contentType.split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * 校验监听地址不是通配地址（S2 安全约束：只允许回环）。
 * @param host 待校验的监听地址
 * @throws Error host 是空串 / 0.0.0.0 / :: 等通配地址时
 */
function assertLoopbackHost(host: string): void {
  if (FORBIDDEN_HOSTS.has(host.toLowerCase())) {
    throw new Error(
      `control server refuses to listen on "${host === "" ? "(empty)" : host}": only loopback addresses are allowed (e.g. 127.0.0.1)`,
    );
  }
}

/**
 * 读取请求体（上限 maxBytes；超限时丢弃后续数据并在请求结束后返回 too-large）。
 * @param req 进入的请求流
 * @param maxBytes 字节数上限
 * @returns 读到的缓冲区 / 超限 / 连接断开三态之一
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyReadResult> {
  return new Promise<BodyReadResult>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let settled = false;
    const settle = (result: BodyReadResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        chunks.length = 0; // 超限后丢弃已收数据，不再缓冲
        return;
      }
      if (!overflow) {
        chunks.push(chunk);
      }
    });
    req.once("end", () => {
      settle(overflow ? { kind: "too-large" } : { kind: "ok", buffer: Buffer.concat(chunks) });
    });
    req.once("error", () => settle({ kind: "aborted" }));
    req.once("close", () => settle({ kind: "aborted" }));
  });
}

/**
 * 发送 JSON 响应（Content-Type: application/json; charset=utf-8，含 Content-Length）。
 * 响应已开始 / 已结束 / 连接已坏时不再发送，直接销毁连接兜底。
 * @param res 目标响应
 * @param status HTTP 状态码
 * @param body 响应体（JSON 序列化）
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  if (res.headersSent) {
    res.destroy(); // 响应已开始却走到这里属于异常路径：无法再补 JSON 错误体
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.length),
  });
  res.end(payload);
}

/**
 * 发送统一错误响应 `{error:{code,message,details?}}`。
 * @param res 目标响应
 * @param status HTTP 状态码（4xx / 5xx）
 * @param code 机器可读错误码
 * @param message 错误描述
 * @param details 可选结构化细节（undefined 字段不进入 JSON）
 * @param headers 可选附加响应头（如 405 的 Allow）
 */
function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  headers?: Record<string, string>,
): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body: ErrorBody = { error: { code, message } };
  if (details !== undefined) {
    body.error.details = details;
  }
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.length),
    ...headers,
  });
  res.end(payload);
}

/**
 * 从请求体取必填非空字符串字段。
 * @param body 已解析的请求体
 * @param field 字段名（用于错误消息）
 * @returns 字段值
 * @throws BadRequestError 字段缺失 / 非字符串 / 全空白时
 */
function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  throw new BadRequestError(`missing or invalid field: ${field} (non-empty string required)`);
}

/**
 * 从请求体取可选的正有限数字字段。
 * @param body 已解析的请求体
 * @param field 字段名（用于错误消息）
 * @returns 字段值；缺省时 undefined
 * @throws BadRequestError 字段存在但不是正有限数字时
 */
function optionalPositiveNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  throw new BadRequestError(`invalid field: ${field} (positive finite number required)`);
}

/**
 * 从请求体取可选的布尔字段（/v1/push 的 dryRun / forceScriptsOnly / skipBackup /
 * skipBaselineCheck 等开关共用）。
 * @param body 已解析的请求体
 * @param field 字段名（用于错误消息）
 * @returns 字段值；缺省时 undefined（由调用方决定缺省语义）
 * @throws BadRequestError 字段存在但不是布尔值时
 */
function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new BadRequestError(`invalid field: ${field} (boolean required)`);
}

/**
 * 把请求体中 scriptStates 字段整理为会话层 ScriptState[]（运行时逐元素校验，
 * 额外字段丢弃后只带 name / guid / script / ui 转发给 TTS）。
 * @param value scriptStates 字段原始值
 * @returns 合法的状态列表；结构不符时 undefined
 */
function asScriptStates(value: unknown): ScriptState[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const states: ScriptState[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      return undefined;
    }
    if (typeof item.name !== "string" || typeof item.guid !== "string") {
      return undefined;
    }
    if (item.script !== undefined && typeof item.script !== "string") {
      return undefined;
    }
    if (item.ui !== undefined && typeof item.ui !== "string") {
      return undefined;
    }
    const state: ScriptState = { name: item.name, guid: item.guid };
    if (item.script !== undefined) {
      state.script = item.script;
    }
    if (item.ui !== undefined) {
      state.ui = item.ui;
    }
    states.push(state);
  }
  return states;
}

/**
 * 把请求体整理为 {@link SliceOptions}（sheetPath / savePath / outDir 必填非空字符串；
 * deckKey / deckGuid 可选字符串；selectCandidate 不注入——HTTP 场景无交互）。
 * @param body 已解析的请求体
 * @returns 合法的切片选项；结构不符时 undefined
 */
function asSliceOptions(body: Record<string, unknown>): SliceOptions | undefined {
  const sheetPath = body.sheetPath;
  const savePath = body.savePath;
  const outDir = body.outDir;
  if (typeof sheetPath !== "string" || sheetPath.trim() === "") {
    return undefined;
  }
  if (typeof savePath !== "string" || savePath.trim() === "") {
    return undefined;
  }
  if (typeof outDir !== "string" || outDir.trim() === "") {
    return undefined;
  }
  const opts: SliceOptions = { sheetPath, savePath, outDir };
  const deckKey = body.deckKey;
  if (deckKey !== undefined) {
    if (typeof deckKey !== "string") {
      return undefined;
    }
    opts.deckKey = deckKey;
  }
  const deckGuid = body.deckGuid;
  if (deckGuid !== undefined) {
    if (typeof deckGuid !== "string") {
      return undefined;
    }
    opts.deckGuid = deckGuid;
  }
  return opts;
}

/**
 * 把请求体整理为 {@link PlanOptions}（savePath 必须是路径字符串或已解析的键值对象；
 * rules 必须是数组——规则元素由 planReplace 自行深度校验，非法规则以
 * PLAN_RULE_INVALID 的 PackError 透传为 400）。
 * @param body 已解析的请求体
 * @returns 合法的替换计划选项；结构不符时 undefined
 */
function asPlanOptions(body: Record<string, unknown>): PlanOptions | undefined {
  const savePath = body.savePath;
  const rules = body.rules;
  if (typeof savePath !== "string" && !isPlainObject(savePath)) {
    return undefined;
  }
  if (!Array.isArray(rules)) {
    return undefined;
  }
  return {
    savePath: savePath as string | Record<string, unknown>,
    rules: rules as PlanOptions["rules"],
  };
}

/**
 * 判定扇出消息是否属于 SSE 转发集合（见 {@link SSE_FORWARDED_MESSAGE_IDS}）。
 * 按结构判定（含数字 messageID 且在集合内），不依赖 daemon 扇出层的具体类型声明。
 * @param msg 扇出层回调收到的消息
 * @returns 属于转发集合时 true
 */
function isSseForwarded(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) {
    return false;
  }
  const id = (msg as { messageID?: unknown }).messageID;
  return typeof id === "number" && SSE_FORWARDED_MESSAGE_IDS.has(id);
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

/**
 * 控制通道服务器实现（不导出；经 {@link createControlServer} 创建）。
 *
 * 请求处理是全 try/catch 的：dispatch 捕获一切异常并映射为统一错误响应，
 * 请求 / 响应流上的错误事件（客户端中途断开等）吞掉，绝不产生未处理 rejection
 * 或未捕获异常把 hub 进程打崩。
 */
class ControlServerImpl implements ControlServer {
  /** 所属 hub 守护进程（提供 exec / scripts / fanout / stats） */
  private readonly daemon: HubDaemon;
  /** 配置的监听端口 */
  private readonly port: number;
  /** 配置的监听地址（已通过 assertLoopbackHost 校验） */
  private readonly host: string;
  /** 日志回调 */
  private readonly log: (line: string) => void;
  /** 优雅退出回调（/v1/hub/shutdown 触发） */
  private readonly onShutdown: (() => Promise<void>) | undefined;
  /** GET 路由表 */
  private readonly getRoutes: ReadonlyMap<string, RouteHandler>;
  /** POST 路由表 */
  private readonly postRoutes: ReadonlyMap<string, RouteHandler>;
  /** node:http 服务器实例 */
  private readonly server: Server;
  /** 当前打开的连接（stop() 超时强关用） */
  private readonly sockets = new Set<Socket>();
  /** 是否处于监听状态（start 成功后 true，stop 后 false） */
  private listening = false;

  /**
   * @param daemon hub 守护进程实例
   * @param opts 服务选项（undefined 按各字段缺省值处理）
   * @throws Error opts.host 是通配地址时
   */
  constructor(daemon: HubDaemon, opts?: ControlServerOptions) {
    this.daemon = daemon;
    this.port = opts?.port ?? DEFAULT_CONTROL_PORT;
    this.host = opts?.host ?? DEFAULT_CONTROL_HOST;
    assertLoopbackHost(this.host);
    this.log = opts?.log ?? ((line: string) => console.error(line));
    this.onShutdown = opts?.onShutdown;
    this.getRoutes = new Map<string, RouteHandler>([
      ["/v1/status", (req, res) => this.handleStatus(req, res)],
      ["/v1/packs", (_req, res, url) => this.handlePacks(res, url)],
      ["/v1/events", (_req, res) => this.handleEvents(res)],
    ]);
    this.postRoutes = new Map<string, RouteHandler>([
      ["/v1/scripts/pull", (req, res) => this.handlePull(req, res)],
      ["/v1/scripts/save-and-play", (req, res) => this.handleSaveAndPlay(req, res)],
      ["/v1/exec", (req, res) => this.handleExec(req, res)],
      ["/v1/assets/check", (req, res) => this.handleAssetsCheck(req, res)],
      ["/v1/deck/slice", (req, res) => this.handleDeckSlice(req, res)],
      ["/v1/deck/plan", (req, res) => this.handleDeckPlan(req, res)],
      ["/v1/import", (req, res) => this.handleImport(req, res)],
      ["/v1/diff", (req, res) => this.handleDiff(req, res)],
      ["/v1/push", (req, res) => this.handlePush(req, res)],
      ["/v1/hub/shutdown", (_req, res) => this.handleShutdown(res)],
    ]);
    this.server = createServer((req, res) => {
      this.onRequest(req, res);
    });
  }

  /** @inheritdoc */
  async start(): Promise<void> {
    if (this.listening) {
      return;
    }
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      const onListenError = (err: Error): void => {
        reject(err);
      };
      server.once("error", onListenError);
      server.listen(this.port, this.host, () => {
        server.removeListener("error", onListenError);
        resolve();
      });
    });
    // listen 阶段之后的服务器级错误（极少见）只记日志，绝不让进程崩溃
    this.server.on("error", (err: Error) => {
      this.log(`control server error: ${describeError(err)}`);
    });
    // 记录连接集合，供 stop() 超时强关（SSE 长连接不会自然结束）
    this.server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.once("close", () => {
        this.sockets.delete(socket);
      });
    });
    this.listening = true;
    this.log(`control server listening on ${this.host}:${this.boundPort()}`);
  }

  /** @inheritdoc */
  async stop(): Promise<void> {
    if (!this.listening) {
      return;
    }
    this.listening = false;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(graceTimer);
        resolve();
      };
      // 宽限期后强关全部连接（SSE 长连接不会自然结束），close 回调随即触发
      const graceTimer = setTimeout(() => {
        for (const socket of this.sockets) {
          socket.destroy();
        }
      }, STOP_GRACE_MS);
      try {
        this.server.close(() => finish());
      } catch {
        finish(); // 未监听等状态下的 close 抛错：视为已停止
      }
    });
    this.sockets.clear();
    this.log("control server stopped");
  }

  /** @inheritdoc */
  boundPort(): number {
    const addr = this.server.address();
    if (addr !== null && typeof addr === "object") {
      return addr.port;
    }
    throw new Error("control server is not listening: boundPort is only available after start()");
  }

  /**
   * 请求入口：吞掉请求 / 响应流上的错误事件，进入 dispatch。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    // 客户端中途断开等流错误不进业务分支：吞掉即可，避免未处理 'error' 事件打崩进程
    req.once("error", () => undefined);
    res.once("error", () => undefined);
    void this.dispatch(req, res);
  }

  /**
   * 路由分发：未匹配路径 → 404；路径存在但方法不对 → 405（带 Allow 头）；
   * 处理函数抛出的异常按统一错误映射响应。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      sendError(res, 400, "HUB_BAD_REQUEST", "malformed request URL");
      return;
    }
    const pathname = url.pathname;
    try {
      const method = req.method ?? "";
      const table = method === "GET" ? this.getRoutes : method === "POST" ? this.postRoutes : undefined;
      const handler = table?.get(pathname);
      if (handler !== undefined) {
        await handler(req, res, url);
        return;
      }
      if (this.getRoutes.has(pathname) || this.postRoutes.has(pathname)) {
        const allow: string[] = [];
        if (this.getRoutes.has(pathname)) {
          allow.push("GET");
        }
        if (this.postRoutes.has(pathname)) {
          allow.push("POST");
        }
        sendError(
          res,
          405,
          "HUB_METHOD_NOT_ALLOWED",
          `method ${method} is not allowed for ${pathname}`,
          undefined,
          { Allow: allow.join(", ") },
        );
        return;
      }
      sendError(res, 404, "HUB_NOT_FOUND", `no route for ${pathname}`);
    } catch (err) {
      if (err instanceof BadRequestError) {
        sendError(res, 400, "HUB_BAD_REQUEST", err.message);
        return;
      }
      this.respondError(res, err);
    }
  }

  /**
   * 业务异常的统一映射：LuaError → 400 HUB_LUA_ERROR；PackError → 400
   * HUB_PACK_ERROR；其余 → 500 HUB_INTERNAL_ERROR。
   * @param res 目标响应
   * @param err 处理过程中抛出的异常
   */
  private respondError(res: ServerResponse, err: unknown): void {
    if (err instanceof LuaError) {
      const details: Record<string, unknown> = { guid: err.guid };
      if (err.line !== undefined) {
        details.line = err.line;
      }
      if (err.col !== undefined) {
        details.col = err.col;
      }
      if (err.endCol !== undefined) {
        details.endCol = err.endCol;
      }
      sendError(res, 400, "HUB_LUA_ERROR", err.message, details);
      return;
    }
    if (err instanceof PackError) {
      sendError(res, 400, "HUB_PACK_ERROR", err.message, { packCode: err.code });
      return;
    }
    sendError(res, 500, "HUB_INTERNAL_ERROR", describeError(err));
  }

  /**
   * 读取并把 POST 请求体解析为 JSON 对象；所有请求侧问题（非 JSON 媒体类型 /
   * 超限 / 非法 JSON / 非对象）在此直接响应错误并返回 undefined。
   * @param req 进入的请求
   * @param res 目标响应
   * @returns 解析出的键值对象；请求侧问题已响应（或连接已断）时 undefined
   */
  private async readJsonBody(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<Record<string, unknown> | undefined> {
    if (!isJsonContentType(req.headers["content-type"])) {
      sendError(res, 415, "HUB_UNSUPPORTED_MEDIA_TYPE", "content-type must be application/json");
      return undefined;
    }
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (raw.kind === "aborted") {
      return undefined; // 连接已断，无从响应
    }
    if (raw.kind === "too-large") {
      sendError(res, 413, "HUB_PAYLOAD_TOO_LARGE", `request body exceeds ${MAX_BODY_BYTES} bytes`);
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.buffer.toString("utf8"));
    } catch {
      sendError(res, 400, "HUB_BAD_REQUEST", "request body is not valid JSON");
      return undefined;
    }
    if (!isPlainObject(parsed)) {
      sendError(res, 400, "HUB_BAD_REQUEST", "request body must be a JSON object");
      return undefined;
    }
    return parsed;
  }

  // -- GET 路由 -------------------------------------------------------------

  /**
   * GET /v1/status：hub 健康 + TTS 连接状态。
   *
   * hub 字段来自 daemon.stats()（uptimeMs 现算，负值截为 0）；tts.connected 通过
   * 执行 luaGetVersion 探测（2s 超时），成功时顺带探测对象数（失败只影响可选的
   * objects 字段）。探测失败不是路由错误——仍 200，connected=false。
   * @param _req 进入的请求（未使用）
   * @param res 目标响应
   */
  private async handleStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const stats = this.daemon.stats();
    const tts: { connected: boolean; version?: string; objects?: number } = { connected: false };
    try {
      const version = await this.daemon.exec.execJson<string>(luaGetVersion(), {
        timeoutMs: TTS_PROBE_TIMEOUT_MS,
      });
      tts.connected = true;
      if (typeof version === "string") {
        tts.version = version;
      }
      try {
        const objects = await this.daemon.exec.execJson<number>(luaGetObjectCount(), {
          timeoutMs: TTS_PROBE_TIMEOUT_MS,
        });
        if (typeof objects === "number") {
          tts.objects = objects;
        }
      } catch {
        // objects 探测失败只影响可选字段，不影响 connected / version
      }
    } catch {
      // TTS 未连接 / 探测失败：connected=false，路由本身仍 200（S2 约定）
    }
    sendJson(res, 200, {
      ok: true,
      hub: {
        editor: stats.editor,
        tcpClients: stats.tcpClients,
        wsClients: stats.wsClients,
        inprocClients: stats.inprocClients,
        startedAt: stats.startedAt,
        uptimeMs: Math.max(0, Date.now() - stats.startedAt),
      },
      tts,
    });
  }

  /**
   * GET /v1/packs：列出注册表图包。
   *
   * packsRoot 取查询参数（缺省 / 空串用 process.cwd()）。.registry.yaml 不存在
   * 时 readRegistry 容错返回空表（`{schema_version:1, packs:[]}`），不视为错误。
   * @param res 目标响应
   * @param url 已解析的请求 URL（取 packsRoot 查询参数）
   */
  private async handlePacks(res: ServerResponse, url: URL): Promise<void> {
    const packsRootParam = url.searchParams.get("packsRoot");
    const packsRoot = packsRootParam !== null && packsRootParam !== "" ? packsRootParam : process.cwd();
    const registry = await readRegistry(packsRoot);
    sendJson(res, 200, registry);
  }

  /**
   * GET /v1/events：SSE 事件流。
   *
   * 订阅 daemon 扇出，收到 {@link SSE_FORWARDED_MESSAGE_IDS} 集合内的消息时写
   * `data: ${JSON.stringify(msg)}\n\n`；客户端断开（响应 close）即退订。
   * 订阅回调里的写失败不向上抛（连接已坏时退订兜底）。
   * @param res 目标响应
   */
  private handleEvents(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(":connected\n\n");
    let closed = false;
    const unsubscribe = this.daemon.fanout.subscribe((msg: unknown) => {
      if (closed || res.writableEnded || res.destroyed) {
        return;
      }
      if (!isSseForwarded(msg)) {
        return;
      }
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    });
    const cleanup = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        unsubscribe();
      } catch {
        // 退订失败不影响连接清理（扇出层断开自动摘除）
      }
    };
    // 客户端断开（响应 close，含连接被强关）即退订；close 与 cleanup 均幂等
    res.once("close", cleanup);
  }

  // -- POST 路由 ------------------------------------------------------------

  /**
   * POST /v1/scripts/pull：拉全部脚本到工作区（pullFromGame）。
   *
   * hub 注入：传 daemon.server 复用 hub 已绑定的 39998，避免 pullFromGame 内部
   * withEditorServer 二次独占触发 PortInUseError（阶段 4 已知问题 #1 修复）。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async handlePull(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res);
    if (body === undefined) {
      return;
    }
    const root = requireString(body, "root");
    const result = await pullFromGame({ root, server: this.daemon.server });
    sendJson(res, 200, result);
  }

  /**
   * POST /v1/scripts/save-and-play：回写 scriptStates 并重载存档。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async handleSaveAndPlay(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res);
    if (body === undefined) {
      return;
    }
    const states = asScriptStates(body.scriptStates);
    if (states === undefined) {
      throw new BadRequestError(
        "missing or invalid field: scriptStates (array of {name, guid, script?, ui?} required)",
      );
    }
    await this.daemon.scripts.saveAndPlay(states);
    sendJson(res, 200, { ok: true });
  }

  /**
   * POST /v1/exec：执行 Lua 并返回 JSON（execJson 的返回值包在 `{result:...}`）。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async handleExec(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res);
    if (body === undefined) {
      return;
    }
    const lua = requireString(body, "lua");
    const execOpts: { guid?: string; timeoutMs?: number } = {};
    const guid = body.guid;
    if (guid !== undefined) {
      if (typeof guid !== "string" || guid.trim() === "") {
        throw new BadRequestError("invalid field: guid (non-empty string required)");
      }
      execOpts.guid = guid;
    }
    const timeoutMs = optionalPositiveNumber(body, "timeoutMs");
    if (timeoutMs !== undefined) {
      execOpts.timeoutMs = timeoutMs;
    }
    const result = await this.daemon.exec.execJson(lua, execOpts);
    sendJson(res, 200, { result });
  }

  /**
   * POST /v1/assets/check：素材存活检测（checkUrls）。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async handleAssetsCheck(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res);
    if (body === undefined) {
      return;
    }
    const urls = body.urls;
    if (!isStringArray(urls) || urls.length === 0) {
      throw new BadRequestError(
        "missing or invalid field: urls (non-empty array of strings required)",
      );
    }
    const timeoutMs = optionalPositiveNumber(body, "timeoutMs");
    const summary = await checkUrls(urls, timeoutMs !== undefined ? { timeoutMs } : undefined);
    sendJson(res, 200, summary);
  }

  /**
   * POST /v1/deck/slice：切片（body 就是 SliceOptions，见模块头注释的契约裁决）。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async handleDeckSlice(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res);
    if (body === undefined) {
      return;
    }
    const opts = asSliceOptions(body);
    if (opts === undefined) {
      throw new BadRequestError(
        "missing or invalid field: sheetPath/savePath/outDir (non-empty strings required; deckKey/deckGuid optional strings)",
      );
    }
    const result = await sliceAtlas(opts);
    sendJson(res, 200, result);
  }

  /**
   * POST /v1/deck/plan：替换计划 dry-run（body 就是 PlanOptions，规则元素由
   * planReplace 自行校验，非法规则以 PLAN_RULE_INVALID 透传为 400）。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async handleDeckPlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res);
    if (body === undefined) {
      return;
    }
    const opts = asPlanOptions(body);
    if (opts === undefined) {
      throw new BadRequestError(
        "missing or invalid field: savePath (string or object) / rules (array required)",
      );
    }
    const result = await planReplace(opts);
    sendJson(res, 200, result);
  }

  /**
   * POST /v1/import：按 import.yaml 导入素材（importAssets）。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async handleImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res);
    if (body === undefined) {
      return;
    }
    const root = requireString(body, "root");
    const manifestPath = requireString(body, "manifestPath");
    let dryRun: boolean | undefined;
    if (body.dryRun !== undefined) {
      if (typeof body.dryRun !== "boolean") {
        throw new BadRequestError("invalid field: dryRun (boolean required)");
      }
      dryRun = body.dryRun;
    }
    const result = await importAssets({ root, manifestPath, dryRun });
    sendJson(res, 200, result);
  }

  /**
   * POST /v1/diff：本地 vs 游戏内差异（diffWorkspace）。
   *
   * hub 注入：传 daemon.server 复用 hub 已绑定的 39998（阶段 4 已知问题 #1 修复）。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async handleDiff(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res);
    if (body === undefined) {
      return;
    }
    const root = requireString(body, "root");
    const result = await diffWorkspace({ root, server: this.daemon.server });
    sendJson(res, 200, result);
  }

  /**
   * POST /v1/push：把本地工作区的脚本 / UI 改动安全地写回运行中的 TTS（阶段 5）。
   *
   * confirm 门：body.confirm 不严格等于 true 时 400 HUB_CONFIRM_REQUIRED（写回是
   * 危险操作，HTTP 层显式确认不变；CLI / MCP 调用方各自再设一道门）。
   *
   * 流程：整条流水线委托 {@link pushSaveAndPlay}（素材改动检测 → 基线冲突检测 →
   * 备份 → 无变化过滤 → 强制带 ui → saveAndPlay → 回读校验 → 更新基线），本路由
   * 只做三件事：
   * 1. 请求侧字段校验（root 必填；dryRun / forceScriptsOnly / skipBackup /
   *    skipBaselineCheck 可选布尔、backupRetention 可选正数，非法即 400）；
   * 2. 坑 17 注入：传 `server: this.daemon.server` 复用 hub 已绑定的编辑器端口
   *    39998，绝不允许 pushSaveAndPlay 内部再起 withEditorServer 二次独占；
   * 3. 缺省值对齐 MCP `tts_push` 语义：confirm 已过门 → dryRun 缺省 false
   *    （实写），backupRetention 缺省 20——与 pushSaveAndPlay 自身"dryRun 缺省
   *    true"的安全缺省刻意不同，因为 HTTP 层的 confirm:true 已表达实写意图。
   *
   * 不向 pushSaveAndPlay 传 confirm 函数：CLI 交互确认门只在 CLI 进程内有意义，
   * hub 场景由本路由的 confirm:true 一门拦截。
   *
   * 响应体：`{ok:true, dryRun, pushed, skipped, items, backupDir?, baselineConflicts?,
   * assetChanges?}`——items 是 `pushed + skipped` 的向后兼容别名；backupDir 仅在
   * 实写且未 skipBackup 时携带；baselineConflicts / assetChanges 仅在检测到且被
   * 对应开关放行时携带（否则已按 400 HUB_PACK_ERROR 抛错中断）；dryRun=true 时
   * pushed 是"若实写将写入"的对象数。业务失败（PackError）由 respondError 统一
   * 映射为 400 HUB_PACK_ERROR + details.packCode。
   *
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async handlePush(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res);
    if (body === undefined) {
      return;
    }
    const root = requireString(body, "root");
    if (body.confirm !== true) {
      sendError(res, 400, "HUB_CONFIRM_REQUIRED", "this operation requires confirm:true in the request body");
      return;
    }
    const dryRun = optionalBoolean(body, "dryRun") ?? false;
    const forceScriptsOnly = optionalBoolean(body, "forceScriptsOnly") ?? false;
    const skipBackup = optionalBoolean(body, "skipBackup") ?? false;
    const skipBaselineCheck = optionalBoolean(body, "skipBaselineCheck") ?? false;
    const backupRetention = optionalPositiveNumber(body, "backupRetention") ?? DEFAULT_BACKUP_RETENTION;
    const result = await pushSaveAndPlay({
      root,
      server: this.daemon.server, // 坑 17：复用 hub 已绑定的编辑器端口，绝不二次绑定
      dryRun,
      forceScriptsOnly,
      skipBackup,
      skipBaselineCheck,
      backupRetention,
      // hub 场景 confirm 已由本路由 confirm:true 拦截，不传 CLI 交互确认函数
    });
    sendJson(res, 200, {
      ok: true,
      dryRun: result.dryRun,
      pushed: result.pushed,
      skipped: result.skipped,
      items: result.pushed + result.skipped, // 向后兼容别名（旧客户端的 items 计数）
      ...(result.backupDir !== undefined ? { backupDir: result.backupDir } : {}),
      ...(result.baselineConflicts !== undefined
        ? { baselineConflicts: result.baselineConflicts }
        : {}),
      ...(result.assetChanges !== undefined ? { assetChanges: result.assetChanges } : {}),
    });
  }

  /**
   * POST /v1/hub/shutdown：先回 200 `{ok:true}`，响应出站后再触发 onShutdown
   * （避免退出流程强杀当前连接）；回调失败只记日志，绝不产生未处理 rejection。
   * @param res 目标响应
   */
  private handleShutdown(res: ServerResponse): void {
    sendJson(res, 200, { ok: true });
    const shutdown = this.onShutdown;
    if (shutdown !== undefined) {
      void shutdown().catch((err: unknown) => {
        this.log(`control server onShutdown callback failed: ${describeError(err)}`);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 创建 hub 控制通道服务器（S2：HTTP+JSON on http://127.0.0.1:39995/v1）。
 *
 * 传入的 daemon 需已具备 {@link HubDaemon} 的 exec / scripts / fanout / stats
 * 成员；服务器只监听回环地址，通配 host 在本函数内直接抛错。
 *
 * @param daemon hub 守护进程实例
 * @param opts 服务选项（undefined 按各字段缺省值处理：端口 39995、host 127.0.0.1、
 *   日志 console.error、无 onShutdown）
 * @returns 控制通道服务器句柄（尚未监听；调用 start() 才开始服务）
 * @throws Error opts.host 是通配地址（空串 / 0.0.0.0 / :: 等）时
 */
export function createControlServer(daemon: HubDaemon, opts?: ControlServerOptions): ControlServer {
  return new ControlServerImpl(daemon, opts);
}
