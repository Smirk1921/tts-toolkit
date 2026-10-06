// src/mcp/client.ts
/**
 * hub 控制通道 HTTP 客户端（{@link HubClient} / {@link probeHub}）：CLI 与 MCP 工具层
 * 共用的唯一 hub 访问入口，与 src/hub/control.ts 的 12 条 S2 路由 + 2 条阶段 7
 * 路由（/v1/test/run、/v1/pack/build）一一对应（本模块
 * 不覆盖 GET /v1/events SSE——事件订阅由扇出层 TCP / WS 客户端承担，见
 * src/hub/fanout.ts）。
 *
 * 职责边界（纯传输层，不做业务解包）：
 * - 方法与路由一一对应，body 契约与 src/hub/control.ts 严格一致：/v1/deck/slice 的
 *   body 就是 {@link SliceOptions} 本身（selectCandidate 是函数，JSON 序列化时自然
 *   丢弃——HTTP 场景无交互）、/v1/deck/plan 的 body 就是 {@link PlanOptions} 本身、
 *   /v1/push 必须 confirm:true（push 的 confirm 参数类型是字面量 `true`，调用方传
 *   false 编译期即报错，与服务端 HUB_CONFIRM_REQUIRED 门对齐）；
 * - 除 status / saveAndPlay / push / shutdown 按定型返回外，其余方法原样返回控制
 *   通道的 JSON 响应体（unknown）：/v1/exec 的响应体是 `{result:...}` 包装（见
 *   src/hub/control.ts 的 handleExec）、/v1/packs 是注册表 JSON、/v1/assets/check
 *   是 CheckSummary——工具层直接把该返回值放进 structuredContent（结构化 JSON
 *   英文键名，不走 t()）；
 * - 错误分类（失败时抛出，绝不返回半截结果）：
 *   - 网络层失败：fetch reject（连接拒绝 ECONNREFUSED 等）、超时中止（AbortError /
 *     TimeoutError）、响应体读取中断 → {@link HubNotRunningError}（语义：hub 没在
 *     跑或不可达）；
 *   - HTTP 4xx/5xx：body 是 `{error:{code,message,details?}}` 标准形 →
 *     {@link HubError}（原样保留 code / httpStatus / details；业务错误 PackError →
 *     HUB_PACK_ERROR、LuaError → HUB_LUA_ERROR 由 hub 侧打包后在此透传）；否则 →
 *     {@link HubError}(httpStatus, "HUB_UNKNOWN", 原始 body 文本)；
 *   - HTTP 2xx 但 body 不是合法 JSON、或定型路由 shape 不符 → {@link HubError}
 *     (httpStatus, "HUB_UNKNOWN", ...)（协议违规，不归入"hub 未运行"）；
 * - {@link probeHub} 是零异常探测：GET /v1/status + 800ms AbortController 超时，
 *   任何失败（超时 / 连接拒绝 / 响应 shape 不符）都返回 null 不抛——CLI 用它判断
 *   hub 是否已在跑（决定提示 `hub start` 还是直接复用）；
 * - 超时实现：AbortController + setTimeout 覆盖"发起请求 + 读取响应体"全程，finally
 *   中 clearTimeout——不遗留常驻定时器、不产生 unhandled rejection；用全局 fetch
 *   （Node 24 内置），零新增依赖。
 *
 * 本模块不产出面向用户的文案：错误 message 是协议层英文短句（消费方是 MCP 工具层
 * 与 CLI 呈现层，双语呈现由调用方负责），与 src/hub/control.ts 同一口径不引入
 * i18n；业务错误（PackError 等）的 message 由 hub 侧经 t() 生成后经
 * `{error:{code,message,details}}` 原样透传。
 */

import type { PlanOptions } from "../deck/plan.js";
import type { SliceOptions } from "../deck/slice.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** hub 控制通道缺省端口（S2 约定，与 src/hub/control.ts 的 DEFAULT_CONTROL_PORT 一致）。 */
const DEFAULT_HUB_PORT = 39995;

/** hub 控制通道缺省地址（只连回环，与服务端"绝不监听所有接口"的约束对称）。 */
const DEFAULT_HUB_HOST = "127.0.0.1";

/** 常规请求缺省超时毫秒数。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** {@link probeHub} 的固定探测超时毫秒数（S2 约定 800ms，快速失败）。 */
const PROBE_TIMEOUT_MS = 800;

/** {@link describeCause} 解包 cause 链的最大深度（防御环形 cause 导致无限递归）。 */
const MAX_CAUSE_DEPTH = 5;

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** {@link HubClient} 与 {@link probeHub} 的共用选项。 */
export interface HubClientOptions {
  /** hub 控制通道端口（默认 39995）。 */
  port?: number;
  /** hub 控制通道地址（默认 "127.0.0.1"；IPv6 字面量如 "::1" 自动加方括号）。 */
  host?: string;
  /** 单次请求超时毫秒数，覆盖"发起请求 + 读取响应体"全程（默认 30000）。 */
  timeoutMs?: number;
}

/** {@link probeHub} 的返回类型（hub 在跑时从 /v1/status 的 hub 字段提取）。 */
export interface HubProbeResult {
  /** hub 进程已运行毫秒数（hub 侧现算，负值截为 0）。 */
  uptimeMs: number;
  /** hub 进程启动时刻（epoch 毫秒）。 */
  startedAt: number;
}

/** {@link HubClient.status} 返回中 TTS 连接状态部分。 */
export interface HubTtsStatus {
  /** TTS 是否已连上 hub 的编辑器入站端口（39998）。 */
  connected: boolean;
  /** TTS 版本号（探测成功时存在）。 */
  version?: string;
  /** 游戏内对象数（探测成功时存在）。 */
  objects?: number;
}

/** {@link HubClient.status} 的返回类型（GET /v1/status 的定型形状）。 */
export interface HubStatusResult {
  /** 固定 true（hub 侧 200 约定）。 */
  ok: true;
  /** hub 自身状态（editor/tcpClients/wsClients/inprocClients/startedAt/uptimeMs）。 */
  hub: unknown;
  /** TTS 连接状态。 */
  tts: HubTtsStatus;
}

/** {@link HubClient.saveAndPlay} / {@link HubClient.shutdown} 的返回类型。 */
export interface HubOkResult {
  /** 固定 true。 */
  ok: true;
}

/**
 * {@link HubClient.push} 的第 3 参（阶段 5 写入路径的 push 选项）。
 *
 * 字段与 src/hub/control.ts 的 /v1/push 请求体扩展字段一一对应（全部可选：
 * 不带某字段时 hub 侧按各自缺省值处理——dryRun 缺省 false、backupRetention
 * 缺省 20）；confirm 不在本接口里，它是 push 方法的第 2 参（字面量 true）。
 */
export interface PushOptions {
  /** 试运行：只做检测与过滤、返回将推送什么，不备份不确认不发送不写基线。 */
  dryRun?: boolean;
  /** --force-scripts-only：素材有改动时仍强制只推脚本（用户自担风险）。 */
  forceScriptsOnly?: boolean;
  /** 跳过 push 前自动备份（不推荐）。 */
  skipBackup?: boolean;
  /** 跳过基线冲突检测（冲突照常记入结果）。 */
  skipBaselineCheck?: boolean;
  /** 备份保留份数（透传 hub 侧 createBackup 的 retention）。 */
  backupRetention?: number;
}

/** {@link HubClient.push} 的返回类型（POST /v1/push 的定型形状，阶段 5 扩展）。 */
export interface HubPushResult {
  /** 固定 true。 */
  ok: true;
  /** 是否试运行（与 hub 侧 pushSaveAndPlay 的 dryRun 一致）。 */
  dryRun: boolean;
  /** 实际写入（dryRun 下为"将写入"）的对象数。 */
  pushed: number;
  /** 无变化（含防御性跳过）而未发送的对象数。 */
  skipped: number;
  /**
   * `pushed + skipped` 的别名（向后兼容字段）：hub 侧恒带，缺省时客户端按
   * pushed + skipped 补算。
   */
  items: number;
  /** 备份目录完整路径；dryRun 或 skipBackup 时缺省。 */
  backupDir?: string;
  /** 基线冲突清单（检测到且被放行时携带；元素结构由 hub 侧 BaselineConflict 定义）。 */
  baselineConflicts?: unknown[];
  /** 素材改动清单（检测到且被放行时携带；结构由 hub 侧 AssetChanges 定义）。 */
  assetChanges?: unknown;
}

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/**
 * hub 控制通道返回的协议层错误（HTTP 4xx/5xx 或定型响应 shape 不符）。
 *
 * code 是 hub 侧机器可读错误码（HUB_BAD_REQUEST / HUB_NOT_FOUND /
 * HUB_METHOD_NOT_ALLOWED / HUB_PAYLOAD_TOO_LARGE / HUB_UNSUPPORTED_MEDIA_TYPE /
 * HUB_CONFIRM_REQUIRED / HUB_PACK_ERROR / HUB_LUA_ERROR / HUB_INTERNAL_ERROR /
 * HUB_UNKNOWN，业务码经 details.packCode 透传）；message 是协议层英文短句或底层
 * 透传文本；details 是可选结构化细节（PackError 时携带 packCode，LuaError 时携带
 * guid / line / col / endCol）。
 */
export class HubError extends Error {
  /** 机器可读错误码（hub 侧 HUB_* 或 HUB_UNKNOWN）。 */
  readonly code: string;
  /** 触发本错误的 HTTP 状态码。 */
  readonly httpStatus: number;
  /** 可选结构化细节（hub 侧 error.details 原样透传；无细节时 undefined）。 */
  readonly details?: unknown;

  /**
   * @param httpStatus 触发本错误的 HTTP 状态码
   * @param code 机器可读错误码
   * @param message 协议层英文错误描述
   * @param details 可选结构化细节（undefined 时不产生 details 字段语义）
   */
  constructor(httpStatus: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HubError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/**
 * hub 控制通道不可达（网络层失败：连接拒绝、超时中止、响应体读取中断）。
 * 与 {@link HubError} 互为兄弟类（都直接继承 Error）——消费方若同时 instanceof
 * 两者，应先判本类（见 src/mcp/tools/errors.ts 的判断顺序约定）。
 */
export class HubNotRunningError extends Error {
  /**
   * @param message 协议层英文描述（缺省为通用短句；本模块构造时总是带 URL 与原因）
   */
  constructor(message = "hub control channel is not running or unreachable") {
    super(message);
    this.name = "HubNotRunningError";
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 判定值是否为"键值对象"（不含 null 与数组）。
 * @param v 任意值
 * @returns 是普通对象时 true
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 从网络层抛出值中取人类可读原因：AbortError / TimeoutError 归并为超时中止描述；
 * fetch 把底层网络错误包成 "TypeError: fetch failed"，真正原因（如
 * "connect ECONNREFUSED 127.0.0.1:39995"）在 cause 链上，逐层解包拼接
 * （{@link MAX_CAUSE_DEPTH} 封顶，防御环形 cause）。
 * @param err fetch / 响应体读取抛出的任意值
 * @param depth 当前递归深度（内部参数，调用方不传）
 * @returns 英文原因描述
 */
function describeCause(err: unknown, depth = 0): string {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return "request aborted before completion (timeout)";
    }
    if (depth < MAX_CAUSE_DEPTH && err.cause instanceof Error && err.cause !== err) {
      return `${err.message} (${describeCause(err.cause, depth + 1)})`;
    }
    return err.message;
  }
  return String(err);
}

/**
 * 宽松解析 JSON 文本（解析失败返回 undefined，不抛）。
 * @param text 待解析文本
 * @returns 解析结果；非法 JSON 时 undefined
 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 把 4xx/5xx 响应体映射为 {@link HubError}：body 是 `{error:{code,message,details?}}`
 * 标准形时保留 code / details，否则整体降级为 HUB_UNKNOWN（message = 原始 body
 * 文本；body 为空时给出含状态码的短句）。
 * @param httpStatus HTTP 状态码（4xx / 5xx）
 * @param rawBody 已读取的原始响应体文本
 * @returns 分类后的 HubError
 */
function errorFromBadStatus(httpStatus: number, rawBody: string): HubError {
  const parsed = tryParseJson(rawBody);
  if (isPlainObject(parsed)) {
    const err = parsed.error;
    if (isPlainObject(err) && typeof err.code === "string" && typeof err.message === "string") {
      return new HubError(httpStatus, err.code, err.message, err.details);
    }
  }
  return new HubError(
    httpStatus,
    "HUB_UNKNOWN",
    rawBody === "" ? `HTTP ${httpStatus} with empty or non-JSON body` : rawBody,
  );
}

/**
 * 校验 `{ok:true}` 形响应（save-and-play / shutdown 等）。
 * @param body 已解析的响应体
 * @param route 路由路径（用于错误消息定位）
 * @returns 固定 `{ok:true}`
 * @throws HubError 响应 shape 不符时（code=HUB_UNKNOWN，details 携带原始 body）
 */
function expectOkBody(body: unknown, route: string): HubOkResult {
  if (isPlainObject(body) && body.ok === true) {
    return { ok: true };
  }
  throw new HubError(200, "HUB_UNKNOWN", `${route} response is not the expected {ok:true} shape`, body);
}

/**
 * 拼接控制通道基础 URL（host 为 IPv6 字面量时自动加方括号）。
 * @param host 主机名 / IP 字面量（不含端口与协议）
 * @param port 端口
 * @returns 形如 `http://127.0.0.1:39995/v1` 的基础 URL（路由路径直接拼接）
 */
function buildBaseUrl(host: string, port: number): string {
  const hostPart = host.includes(":") ? `[${host}]` : host;
  return `http://${hostPart}:${port}/v1`;
}

// ---------------------------------------------------------------------------
// HubClient
// ---------------------------------------------------------------------------

/**
 * hub 控制通道 HTTP 客户端：方法与 src/hub/control.ts 的 12 条 S2 路由 + 2 条
 * 阶段 7 路由（/v1/test/run、/v1/pack/build）一一对应，
 * CLI 与 MCP 工具层共用。实例无状态（可长期持有），失败按模块头注释的三类语义
 * 抛 {@link HubNotRunningError} / {@link HubError}，绝不返回半截结果。
 */
export class HubClient {
  /** 控制通道基础 URL（含 /v1 前缀） */
  private readonly baseUrl: string;
  /** 单次请求超时毫秒数 */
  private readonly timeoutMs: number;

  /**
   * @param opts 客户端选项（undefined 按各字段缺省值处理：端口 39995、
   *   host 127.0.0.1、timeoutMs 30000）
   */
  constructor(opts?: HubClientOptions) {
    const port = opts?.port ?? DEFAULT_HUB_PORT;
    const host = opts?.host ?? DEFAULT_HUB_HOST;
    this.baseUrl = buildBaseUrl(host, port);
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * 单次 HTTP 请求 + 统一错误分类（本类的核心原语，各公开方法经由此访问 hub）。
   *
   * 超时覆盖"发起请求 + 读取响应体"全程（finally 中 clearTimeout）；网络层失败
   * （fetch reject / 中止 / 响应体读取中断）→ HubNotRunningError；4xx/5xx 按响应
   * 体标准形分类为 HubError；2xx 但 body 非法 JSON → HubError(HUB_UNKNOWN)。
   * @param method HTTP 方法（控制通道只用 GET / POST）
   * @param path 路由路径（相对 /v1，如 "/exec"）
   * @param body 请求体（undefined 表示 GET / 不带体；否则 JSON 序列化）
   * @returns 已解析的 JSON 响应体
   * @throws HubNotRunningError 网络层失败时
   * @throws HubError HTTP 4xx/5xx 或响应体不是合法 JSON 时
   */
  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw errorFromBadStatus(res.status, text);
      }
      const parsed = tryParseJson(text);
      if (parsed === undefined) {
        throw new HubError(
          res.status,
          "HUB_UNKNOWN",
          text === "" ? `HTTP ${res.status} with empty response body` : text,
        );
      }
      return parsed;
    } catch (err) {
      if (err instanceof HubError || err instanceof HubNotRunningError) {
        throw err; // 已分类的协议错误原样上抛
      }
      throw new HubNotRunningError(
        `hub control channel request failed after ${this.timeoutMs}ms (${url}): ${describeCause(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET /v1/status：hub 健康 + TTS 连接状态。
   * @returns 定型状态（hub 字段原样透传，tts 字段经轻量校验重组）
   * @throws HubNotRunningError hub 不可达时
   * @throws HubError hub 返回协议错误或 status 响应 shape 不符时
   */
  async status(): Promise<HubStatusResult> {
    const body = await this.request("GET", "/status");
    if (!isPlainObject(body) || body.ok !== true) {
      throw new HubError(
        200,
        "HUB_UNKNOWN",
        "/v1/status response is not the expected {ok:true,hub,tts} shape",
        body,
      );
    }
    const ttsRaw = body.tts;
    if (!isPlainObject(ttsRaw) || typeof ttsRaw.connected !== "boolean") {
      throw new HubError(
        200,
        "HUB_UNKNOWN",
        "/v1/status response has an invalid tts field",
        body,
      );
    }
    const tts: HubTtsStatus = { connected: ttsRaw.connected };
    if (typeof ttsRaw.version === "string") {
      tts.version = ttsRaw.version;
    }
    if (typeof ttsRaw.objects === "number") {
      tts.objects = ttsRaw.objects;
    }
    return { ok: true, hub: body.hub, tts };
  }

  /**
   * POST /v1/scripts/pull：把游戏内全部脚本拉取到工作区（pullFromGame）。
   * @param root 图包工作区根目录（绝对路径）
   * @returns 控制通道 JSON 响应体（PullResult）
   * @throws HubNotRunningError hub 不可达时
   * @throws HubError hub 返回协议错误（含 HUB_PACK_ERROR 业务透传）时
   */
  async pullScripts(root: string): Promise<unknown> {
    return this.request("POST", "/scripts/pull", { root });
  }

  /**
   * POST /v1/scripts/save-and-play：回写 scriptStates 并重载存档。
   *
   * 注意协议语义：状态缺 script / ui 字段时 TTS 会删除对应内容（见
   * src/session/scripts.ts 的警告）。
   * @param scriptStates 脚本状态列表（{name, guid, script?, ui?}，元素结构由
   *   hub 侧 asScriptStates 逐项校验）
   * @returns 固定 `{ok:true}`
   * @throws HubNotRunningError hub 不可达时
   * @throws HubError hub 返回协议错误或响应 shape 不符时
   */
  async saveAndPlay(scriptStates: unknown[]): Promise<HubOkResult> {
    const body = await this.request("POST", "/scripts/save-and-play", { scriptStates });
    return expectOkBody(body, "/v1/scripts/save-and-play");
  }

  /**
   * POST /v1/exec：在 TTS 内执行 Lua 并拿回 JSON。
   * @param lua Lua 源码（单条语句或返回值的表达式，语义同 session 层 execJson）
   * @param opts 可选参数：guid 目标对象（缺省由 hub 侧补全局脚本）、timeoutMs 超时
   * @returns 控制通道 JSON 响应体（`{result:...}` 包装，result 为 JSON-Lua 返回值）
   * @throws HubNotRunningError hub 不可达时
   * @throws HubError hub 返回协议错误（Lua 运行时错误 → HUB_LUA_ERROR，details 携带
   *   guid / line / col / endCol）时
   */
  async exec(lua: string, opts?: { guid?: string; timeoutMs?: number }): Promise<unknown> {
    const body: Record<string, unknown> = { lua };
    if (opts?.guid !== undefined) {
      body.guid = opts.guid;
    }
    if (opts?.timeoutMs !== undefined) {
      body.timeoutMs = opts.timeoutMs;
    }
    return this.request("POST", "/exec", body);
  }

  /**
   * POST /v1/assets/check：素材 URL 存活检测（checkUrls）。
   * @param urls 素材 URL 列表（非空，hub 侧校验）
   * @param timeoutMs 单个 URL 的检测超时毫秒数（缺省由 hub 侧决定）
   * @returns 控制通道 JSON 响应体（CheckSummary：total / alive / dead / deadUrls / results）
   * @throws HubNotRunningError hub 不可达时
   * @throws HubError hub 返回协议错误时
   */
  async assetsCheck(urls: string[], timeoutMs?: number): Promise<unknown> {
    const body: Record<string, unknown> = { urls };
    if (timeoutMs !== undefined) {
      body.timeoutMs = timeoutMs;
    }
    return this.request("POST", "/assets/check", body);
  }

  /**
   * GET /v1/packs：列出注册表图包（readRegistry）。
   * @param packsRoot 注册表查找根目录；缺省 / 空串时不带查询参数，由 hub 侧以
   *   自己的 process.cwd() 兜底（与控制通道契约一致）
   * @returns 注册表 JSON（`{schema_version, packs:[...]}`；.registry.yaml 不存在时
   *   hub 侧容错返回空表）
   * @throws HubNotRunningError hub 不可达时
   * @throws HubError hub 返回协议错误时
   */
  async listPacks(packsRoot?: string): Promise<unknown> {
    const path =
      packsRoot !== undefined && packsRoot !== ""
        ? `/packs?packsRoot=${encodeURIComponent(packsRoot)}`
        : "/packs";
    return this.request("GET", path);
  }

  /**
   * POST /v1/deck/slice：把牌堆图集按网格切片成单卡图（body 就是 SliceOptions，
   * 见模块头注释的契约说明）。
   * @param opts 切片选项（sheetPath / savePath / outDir 必填；selectCandidate 函数
   *   字段在 JSON 序列化时自然丢弃——HTTP 场景无交互，多候选时 hub 侧抛
   *   SLICE_AMBIGUOUS，调用方应先用 deckKey / deckGuid 消歧后重试）
   * @returns 控制通道 JSON 响应体（SliceResult）
   * @throws HubNotRunningError hub 不可达时
   * @throws HubError hub 返回协议错误（HUB_BAD_REQUEST / HUB_PACK_ERROR）时
   */
  async deckSlice(opts: SliceOptions): Promise<unknown> {
    return this.request("POST", "/deck/slice", opts);
  }

  /**
   * POST /v1/deck/plan：替换计划 dry-run（body 就是 PlanOptions，规则元素由
   * hub 侧 planReplace 自行深度校验）。
   * @param opts 计划选项（savePath 必须是路径字符串或已解析的键值对象；rules 必填）
   * @returns 控制通道 JSON 响应体（PlanResult）
   * @throws HubNotRunningError hub 不可达时
   * @throws HubError hub 返回协议错误（HUB_BAD_REQUEST / HUB_PACK_ERROR，非法规则
   *   以 PLAN_RULE_INVALID 透传）时
   */
  async deckPlan(opts: PlanOptions): Promise<unknown> {
    return this.request("POST", "/deck/plan", opts);
  }

  /**
   * POST /v1/import：按 import.yaml 导入素材（importAssets）。
   * @param root 图包工作区根目录（绝对路径）
   * @param manifestPath import.yaml 清单路径
   * @param dryRun true 时只盘点不写文件；缺省时不带该字段（hub 侧按 undefined 处理）
   * @returns 控制通道 JSON 响应体（导入盘点 / 结果）
   * @throws HubNotRunningError hub 不可达时
   * @throws HubError hub 返回协议错误（含 HUB_PACK_ERROR 业务透传）时
   */
  async importAssets(root: string, manifestPath: string, dryRun?: boolean): Promise<unknown> {
    const body: Record<string, unknown> = { root, manifestPath };
    if (dryRun !== undefined) {
      body.dryRun = dryRun;
    }
    return this.request("POST", "/import", body);
  }

  /**
   * POST /v1/diff：本地 vs 游戏内差异（diffWorkspace）。
   * @param root 图包工作区根目录（绝对路径）
   * @returns 控制通道 JSON 响应体（差异清单）
   * @throws HubNotRunningError hub 不可达时
   * @throws HubError hub 返回协议错误时
   */
  async diff(root: string): Promise<unknown> {
    return this.request("POST", "/diff", { root });
  }

  /**
   * POST /v1/push：把本地工作区的脚本 / UI 改动安全地写回运行中的 TTS（阶段 5）。
   *
   * confirm 参数类型是字面量 `true`：调用方传 false（或漏传）编译期即报错，
   * 与服务端 HUB_CONFIRM_REQUIRED 门双保险。hub 侧的完整流水线（素材改动检测 →
   * 基线冲突检测 → 备份 → 过滤 → saveAndPlay → 回读校验 → 更新基线）由
   * src/hub/control.ts 的 handlePush 委托 pushSaveAndPlay 完成，本方法只负责
   * 透传 {@link PushOptions} 与定型响应。
   * @param root 图包工作区根目录（绝对路径）
   * @param confirm 必须显式传 true（字面量类型约束）
   * @param opts 可选 push 选项（dryRun / forceScriptsOnly / skipBackup /
   *   skipBaselineCheck / backupRetention；不带某字段时 hub 侧按缺省值处理）
   * @returns 定型结果（dryRun / pushed / skipped / items = pushed+skipped，
   *   backupDir / baselineConflicts / assetChanges 仅在存在时携带）
   * @throws HubNotRunningError hub 不可达时
   * @throws HubError hub 返回协议错误或响应 shape 不符时（业务 PackError 以
   *   HUB_PACK_ERROR 透传，details.packCode 携带业务错误码）
   */
  async push(root: string, confirm: true, opts?: PushOptions): Promise<HubPushResult> {
    const body: Record<string, unknown> = { root, confirm };
    if (opts !== undefined) {
      if (opts.dryRun !== undefined) {
        body.dryRun = opts.dryRun;
      }
      if (opts.forceScriptsOnly !== undefined) {
        body.forceScriptsOnly = opts.forceScriptsOnly;
      }
      if (opts.skipBackup !== undefined) {
        body.skipBackup = opts.skipBackup;
      }
      if (opts.skipBaselineCheck !== undefined) {
        body.skipBaselineCheck = opts.skipBaselineCheck;
      }
      if (opts.backupRetention !== undefined) {
        body.backupRetention = opts.backupRetention;
      }
    }
    const parsed = await this.request("POST", "/push", body);
    if (
      isPlainObject(parsed) &&
      parsed.ok === true &&
      typeof parsed.dryRun === "boolean" &&
      typeof parsed.pushed === "number" &&
      typeof parsed.skipped === "number"
    ) {
      const extra = parsed as {
        backupDir?: unknown;
        baselineConflicts?: unknown;
        assetChanges?: unknown;
        items?: unknown;
      };
      const result: HubPushResult = {
        ok: true,
        dryRun: parsed.dryRun,
        pushed: parsed.pushed,
        skipped: parsed.skipped,
        items: typeof extra.items === "number" ? extra.items : parsed.pushed + parsed.skipped,
      };
      // 可选字段原样透传不校验（形状由 hub 侧 pushSaveAndPlay 保证）
      if (extra.backupDir !== undefined && typeof extra.backupDir === "string") {
        result.backupDir = extra.backupDir;
      }
      if (extra.baselineConflicts !== undefined && Array.isArray(extra.baselineConflicts)) {
        result.baselineConflicts = extra.baselineConflicts;
      }
      if (extra.assetChanges !== undefined) {
        result.assetChanges = extra.assetChanges;
      }
      return result;
    }
    throw new HubError(
      200,
      "HUB_UNKNOWN",
      "/v1/push response is not the expected {ok,dryRun,pushed,skipped} shape",
      parsed,
    );
  }

  /**
   * POST /v1/hub/shutdown：优雅关闭 hub（hub 侧先回 200 再触发退出流程）。
   * @returns 固定 `{ok:true}`
   * @throws HubNotRunningError hub 不可达时
   * @throws HubError hub 返回协议错误或响应 shape 不符时
   */
  async shutdown(): Promise<HubOkResult> {
    const body = await this.request("POST", "/hub/shutdown");
    return expectOkBody(body, "/v1/hub/shutdown");
  }

  /**
   * POST /v1/test/run：在 TTS 中跑图包工作区的 Lua 测试（阶段 7）。
   *
   * 未提供的可选字段不出现在请求体里，缺省语义由 hub 侧决定（targetGuid 走
   * pack.yaml tests.target_guid / "-1"，timeoutMs 走 tests.timeout / 30000，
   * bail=false，bundle=true）。hub 侧负责发现测试文件并注入自己已绑定的编辑器
   * 端口（坑 17），本方法只透传。
   * @param opts 运行参数（root 必填；targetGuid / timeoutMs 是逐文件覆盖值）
   * @returns 控制通道 JSON 响应体（RunReport：`{runId, root, startedAt, endedAt,
   *   durationMs, total, passed, failed, errored, bailed, results}`；无测试文件时
   *   是 total=0 的空报告，不是错误）
   * @throws HubNotRunningError hub 不可达时
   * @throws HubError hub 返回协议错误（业务 PackError 以 HUB_PACK_ERROR 透传，
   *   details.packCode ∈ TEST_RUN_* / TEST_DISCOVER_*）时
   */
  async testRun(opts: {
    root: string;
    targetGuid?: string;
    timeoutMs?: number;
    bail?: boolean;
    bundle?: boolean;
  }): Promise<unknown> {
    return this.request("POST", "/test/run", opts);
  }

  /**
   * POST /v1/pack/build：图包工作区 → 存档 JSON → BSON 载荷（阶段 7）。
   *
   * 纯本地文件操作，hub 侧不依赖编辑器端口；outPath 指**输出 BSON 路径**（缺省与
   * 中间 JSON 同目录同名、扩展名换成 .bson）。
   * @param opts 构建参数（root 必填；outPath / dryRun 可选——dryRun=true 时不写
   *   任何文件，响应里的 byteLength / headerLength 恒为 0）
   * @returns 控制通道 JSON 响应体（BsonBuildResult `{outPath, byteLength,
   *   headerLength}` 追加诊断字段 dryRun / jsonPath / warnings / 各替换计数）
   * @throws HubNotRunningError hub 不可达时
   * @throws HubError hub 返回协议错误（业务 PackError 以 HUB_PACK_ERROR 透传，
   *   details.packCode ∈ SKELETON_* / BUILD_FAILED / GUID_MISMATCH / PUBLISH_*）时
   */
  async packBuild(opts: { root: string; outPath?: string; dryRun?: boolean }): Promise<unknown> {
    return this.request("POST", "/pack/build", opts);
  }
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 零异常探测 hub 是否在跑：GET /v1/status + 800ms AbortController 超时。
 *
 * 任何失败（超时、连接拒绝、非 200、响应体非法 JSON、hub 字段缺
 * uptimeMs / startedAt 数值）都返回 null，绝不抛——供 CLI 判断"提示 hub start
 * 还是直接复用"，与 {@link HubClient.status} 的抛错语义形成对照。
 * @param opts 客户端选项（port / host 同 {@link HubClientOptions}；timeoutMs 不
 *   参与探测，超时固定 800ms）
 * @returns hub 在跑时返回 `{uptimeMs, startedAt}`；否则 null
 */
export async function probeHub(opts?: HubClientOptions): Promise<HubProbeResult | null> {
  const port = opts?.port ?? DEFAULT_HUB_PORT;
  const host = opts?.host ?? DEFAULT_HUB_HOST;
  const url = `${buildBaseUrl(host, port)}/status`;
  // Windows 下 Node 全局 fetch 首次连接 127.0.0.1 实测需要 ~1.5s（IPv6 localhost 解析顺序
  // 或代理检测），800ms 固定超时会在 hub 真实在线时误判为不在线，导致 CLI 的 tryHubClient
  // 走独立模式绑 39998 与 hub 冲突（窗口 G / Stage D 实测）。允许 opts.timeoutMs 覆盖。
  const timeoutMs = opts?.timeoutMs ?? PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return null;
    }
    const body: unknown = await res.json();
    if (!isPlainObject(body) || !isPlainObject(body.hub)) {
      return null;
    }
    const hub = body.hub;
    const uptimeMs = hub.uptimeMs;
    const startedAt = hub.startedAt;
    if (typeof uptimeMs !== "number" || typeof startedAt !== "number") {
      return null;
    }
    return { uptimeMs, startedAt };
  } catch {
    return null; // 零异常约定：探测失败一律 null
  } finally {
    clearTimeout(timer);
  }
}
