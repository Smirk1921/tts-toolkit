// src/hub/control.ts
/**
 * hub 控制通道（S2）：HTTP+JSON 服务，监听 http://127.0.0.1:39995/v1，零框架（node:http）。
 *
 * 路由表（S2 12 条 + 阶段 7 的 /v1/test/run、/v1/pack/build + UI-1b 的
 * /v1/files/read、/v1/files/write；不暴露 pack export / pack import .ttsmod /
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
 * | POST | /v1/test/run              | 跑 Lua 测试返回 RunReport（阶段 7） |
 * | POST | /v1/pack/build            | 工作区 → 存档 JSON → BSON（阶段 7） |
 * | POST | /v1/files/read            | 读 root 内文件 → base64（UI-1b）    |
 * | PUT  | /v1/files/write           | 写文本文件进 root（UI-1b，乐观锁）  |
 *
 * 统一约定：
 * - 只监听回环地址（opts.host 缺省 "127.0.0.1"；通配地址 "0.0.0.0" / "::" /
 *   空串在 {@link createControlServer} 构造时直接抛错，绝不监听所有接口）；
 * - 读体路由（POST / PUT）请求体上限 1MB（超限 413 HUB_PAYLOAD_TOO_LARGE；
 *   /v1/files/write 单独放宽到 8MB——其 content 业务上限仍是 1MB，放宽只为
 *   容纳 JSON 字符串转义的最坏膨胀，超限映射见 {@link handleFilesWrite}），
 *   Content-Type 必须是 application/json（否则 415）；三条 GET 路由不读请求体；
 * - loopback CORS（UI-1b，桌面 UI / Vite dev server 跨源访问）：Origin 缺省
 *   （同源请求）或非白名单来源时不发任何 CORS 头；Origin 为字面 "null" 或
 *   http(s)://localhost / 127.0.0.1 / [::1]（任意端口）时回显
 *   Access-Control-Allow-Origin；OPTIONS（预检）统一 204 +
 *   Access-Control-Allow-Methods: GET,POST,PUT,OPTIONS +
 *   Access-Control-Allow-Headers: Content-Type，不进路由表；
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
 * - /v1/test/run 与 /v1/pack/build（阶段 7，窗口 G）：两条互不相关的本地流水线路由——
 *   - /v1/test/run：body `{root, targetGuid?, timeoutMs?, bail?, bundle?, include?}`，
 *     discoverTests 发现文件 → targetGuid / timeoutMs 覆盖到每个条目 →
 *     `new TestRunner(this.daemon.server).run({..., server: this.daemon.server})`
 *     （坑 17：复用 hub 已绑定的 39998，绝不二次绑定），响应是 RunReport；
 *     发现不到测试文件不是错误（返回 total=0 的空报告，由调用方决定退出码）；
 *   - /v1/pack/build：body `{root, outPath?, dryRun?}`，纯本地文件操作、
 *     **不依赖 daemon.server**：buildSave（工作区 → 存档 JSON）→ buildBson
 *     （JSON → BSON，内部自检前 4 字节长度 == 文件大小），响应为
 *     BsonBuildResult + 诊断字段（dryRun / jsonPath / warnings 等；dryRun=true
 *     时不写任何文件，byteLength / headerLength 恒为 0）；
 *   两条路由的业务失败都经 respondError 映射为 400 HUB_PACK_ERROR +
 *   details.packCode（TEST_RUN_* / SKELETON_* / PUBLISH_* 等）。
 * - /v1/files/read 与 /v1/files/write（UI-1b，桌面 UI 专用，**不注册为 MCP 工具**
 *   ——红线 15，防 MCP 越权读写宿主机文件）：
 *   - /v1/files/read：body `{root, path}`；root 必须是已注册图包根（在
 *     `<packsRoot>/.registry.yaml` 里有对应条目，否则 400 HUB_BAD_REQUEST），
 *     path 必须相对 root 且通过 {@link resolveWithinRoot} 的四层路径防护
 *     （HUB_PATH_ESCAPE → 400）；扩展名白名单
 *     png/jpg/jpeg/webp/gif/pdf/txt/lua/xml/json/csv/md 之外 400；文件上限
 *     20MB（413 HUB_FILE_TOO_LARGE）；响应 `{base64, mime, size}`；
 *   - /v1/files/write：body `{root, path, content, baseSha256?}`；同套路径防护
 *     （root 不要求已注册——按方案 §8.4，仅 read 校验注册表）；仅文本
 *     （content 含 null 字节 400）、content 上限 1MB（413 HUB_FILE_TOO_LARGE）、
 *     父目录必须已存在（不隐式建目录）；baseSha256（64 位 hex）提供时与当前
 *     文件 sha256 乐观锁比对（文件不存在也视为冲突），不符 409 HUB_CONFLICT；
 *     响应 `{sha256, size}`；
 *   - appMode：opts.appMode（"standalone" | "app"，缺省 "standalone"，由
 *     lifecycle 层按启动旗标 / TTS_HUB_APP_MODE 环境变量决定）；appMode ===
 *     "app" 时（桌面 sidecar 形态）所有错误响应的 details 附带 userAction
 *     字段（i18n 风格提示键，UI 直接渲染；standalone 形态不带）。
 *
 * 本模块不产出面向用户的文案：错误 message 是协议层英文短句（消费方是 MCP 工具
 * 层与运维日志，双语呈现由 MCP 层负责），与 src/hub/lifecycle.ts 的日志同一口径
 * 不引入 i18n；业务错误（PackError / LuaError）的 message 由底层模块经 t() 生成
 * 后原样透传。唯一的例外是 details.userAction——它是给桌面 UI 渲染用的 i18n
 * 提示键（键名即契约，译文由 UI 侧维护），standalone 形态不出现。
 */

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import path from "node:path";

import pkg from "../../package.json" with { type: "json" };
import { checkUrls } from "../assets/check.js";
import { planReplace, type PlanOptions } from "../deck/plan.js";
import { sliceAtlas, type SliceOptions } from "../deck/slice.js";
import { buildSave } from "../pack/build.js";
import { diffWorkspace } from "../pack/diff.js";
import { importAssets } from "../pack/import.js";
import { PackError } from "../pack/packyaml.js";
import { pullFromGame } from "../pack/pull.js";
import { pushSaveAndPlay } from "../pack/push.js";
import { findPack, readRegistry, registryPath } from "../pack/registry.js";
import { InboundId } from "../protocol/messages.js";
import { buildBson } from "../publish/bson.js";
import { luaGetObjectCount, luaGetVersion } from "../session/lua.js";
import { LuaError } from "../session/exec.js";
import type { ScriptState } from "../session/scripts.js";
import { discoverTests, TestRunner } from "../test/index.js";
import type { HubDaemon } from "./daemon.js";
import { PathEscapeError, resolveWithinRoot } from "./paths.js";

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

/** /v1/files/read 的文件大小上限：20MB。 */
const MAX_READ_FILE_BYTES = 20 * 1_048_576;

/** /v1/files/write 的 content 大小上限：1MB（UTF-8 字节数）。 */
const MAX_WRITE_CONTENT_BYTES = 1_048_576;

/**
 * /v1/files/write 的请求体上限：8MB。content 业务上限是 1MB，但 JSON 字符串
 * 转义最坏逐字符膨胀 6 倍（控制字符 → \uXXXX），放宽请求体上限是为了让
 * "content 超限"落在 413 HUB_FILE_TOO_LARGE 的专用错误码上，而不是先被通用
 * 的 413 HUB_PAYLOAD_TOO_LARGE 截胡（两码都是 413，但语义不同）。
 */
const MAX_WRITE_BODY_BYTES = 8 * 1_048_576;

/**
 * /v1/files/read 的扩展名 → MIME 白名单（大小写不敏感；白名单之外的扩展名
 * 400 HUB_BAD_REQUEST 拒绝）。lua 无注册 MIME，按纯文本给出。
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  lua: "text/plain",
  xml: "application/xml",
  json: "application/json",
  csv: "text/csv",
  md: "text/markdown",
};

/**
 * CORS 白名单来源：字面 "null"（file:// / 沙箱 iframe 场景）或 http(s) 的
 * loopback 主机（localhost / 127.0.0.1 / [::1]，任意端口）。其余来源
 * （含 http://tauri.localhost / 局域网地址 / 公网域名）一律不发 CORS 头。
 */
const CORS_ALLOWED_ORIGIN_PATTERN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

/**
 * appMode === "app" 时错误码 → details.userAction 提示键的专用映射
 * （i18n 风格键名，译文由桌面 UI 侧维护；未命中的错误码走
 * {@link DEFAULT_USER_ACTION}）。
 */
const ERROR_USER_ACTIONS: Readonly<Record<string, string>> = {
  HUB_LUA_ERROR: "hub.error.checkScript",
  HUB_PACK_ERROR: "hub.error.checkWorkspace",
};

/** appMode === "app" 时未命中 {@link ERROR_USER_ACTIONS} 的错误码统一回落键。 */
const DEFAULT_USER_ACTION = "hub.error.restartTts";

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
  /**
   * 应用模式（UI-1b）："standalone"（独立运行，缺省）或 "app"（由桌面 UI 作为
   * sidecar 启动）。取值由 lifecycle 层按启动旗标 --app-mode / TTS_HUB_APP_MODE
   * 环境变量解析后传入，本模块不校验白名单（仅 "app" 触发行为差异：错误响应的
   * details 附带 userAction 提示键）；其余取值一律按 standalone 处理。
   * /v1/status 的 hub.appMode 原样回显该值。
   */
  appMode?: string;
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
 * 从请求体取可选的非空字符串字段（/v1/test/run 的 targetGuid、/v1/pack/build 的
 * outPath 共用）。
 * @param body 已解析的请求体
 * @param field 字段名（用于错误消息）
 * @returns 字段值；缺省时 undefined
 * @throws BadRequestError 字段存在但不是非空字符串时
 */
function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  throw new BadRequestError(`invalid field: ${field} (non-empty string required)`);
}

/**
 * 从请求体取可选的字符串数组字段（/v1/test/run 的 include：CLI 把位置参数
 * `tts test <path>` 委托给 hub 时用；元素必须是字符串，空数组按"匹配空集"处理）。
 * @param body 已解析的请求体
 * @param field 字段名（用于错误消息）
 * @returns 字段值；缺省时 undefined
 * @throws BadRequestError 字段存在但不是字符串数组时
 */
function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (isStringArray(value)) {
    return value;
  }
  throw new BadRequestError(`invalid field: ${field} (array of strings required)`);
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

/**
 * 解析请求 Origin 头得到允许回显的 Access-Control-Allow-Origin 值（loopback CORS）。
 * 无 Origin（同源请求）与非白名单来源返回 undefined（不发 CORS 头）；字面 "null"
 * 与 http(s) loopback 主机（localhost / 127.0.0.1 / [::1]，任意端口）原样回显。
 * @param origin 请求头 origin（可能 undefined）
 * @returns 允许回显时返回 Origin 值本身；否则 undefined
 */
function allowedCorsOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) {
    return undefined;
  }
  if (origin === "null") {
    return "null";
  }
  return CORS_ALLOWED_ORIGIN_PATTERN.test(origin) ? origin : undefined;
}

/**
 * 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT / EISDIR），避免 any。
 * @param err 任意抛出值
 * @returns 字符串形式的 code；取不到时返回 undefined
 */
function errCode(err: unknown): string | undefined {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

/**
 * 把 /v1/files/* 文件操作抛出的 fs 错误映射为请求侧 400（ENOENT → 文件不存在、
 * EISDIR → 路径是目录）；其余错误原样返回（由 respondError 映射为 500）。
 * @param err fs 操作抛出的任意值
 * @param relPath 请求的相对路径（用于错误消息定位）
 * @returns 映射后的错误（应作为 throw 值使用；不可映射时是原错误本身）
 */
function asFileAccessError(err: unknown, relPath: string): unknown {
  const code = errCode(err);
  if (code === "ENOENT") {
    return new BadRequestError(`file not found: ${relPath}`);
  }
  if (code === "EISDIR") {
    return new BadRequestError(`path is a directory: ${relPath}`);
  }
  return err;
}

/**
 * 取文件扩展名对应的白名单 MIME（大小写不敏感）；白名单外抛 400。
 * @param target 已解析的目标文件绝对路径
 * @returns MIME 字符串（如 "image/png"）
 * @throws BadRequestError 扩展名不在 {@link MIME_BY_EXTENSION} 白名单时
 */
function mimeForFile(target: string): string {
  const ext = path.extname(target).replace(/^\./, "").toLowerCase();
  const mime = MIME_BY_EXTENSION[ext];
  if (mime === undefined) {
    throw new BadRequestError(
      `unsupported file type: ${ext === "" ? "(no extension)" : `"${ext}"`} (allowed: ${Object.keys(MIME_BY_EXTENSION).join("/")})`,
    );
  }
  return mime;
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
  /** 应用模式（"standalone" | "app"；仅 "app" 时错误响应附 userAction） */
  private readonly appMode: string;
  /** GET 路由表 */
  private readonly getRoutes: ReadonlyMap<string, RouteHandler>;
  /** POST 路由表 */
  private readonly postRoutes: ReadonlyMap<string, RouteHandler>;
  /** PUT 路由表 */
  private readonly putRoutes: ReadonlyMap<string, RouteHandler>;
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
    this.appMode = opts?.appMode ?? "standalone";
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
      ["/v1/test/run", (req, res) => this.handleTestRun(req, res)],
      ["/v1/pack/build", (req, res) => this.handlePackBuild(req, res)],
      ["/v1/files/read", (req, res) => this.handleFilesRead(req, res)],
      ["/v1/hub/shutdown", (_req, res) => this.handleShutdown(res)],
    ]);
    this.putRoutes = new Map<string, RouteHandler>([
      ["/v1/files/write", (req, res) => this.handleFilesWrite(req, res)],
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
   * 路由分发：入口先做 loopback CORS 中间件（放行来源回显
   * Access-Control-Allow-Origin，非放行来源不发 CORS 头）与 OPTIONS 预检
   * （204 + 允许的方法 / 请求头，不进路由表）；随后按方法分流到 GET / POST /
   * PUT 三张路由表——未匹配路径 → 404；路径存在但方法不对 → 405（Allow 头聚合
   * 三张表的命中）；处理函数抛出的异常按统一错误映射响应。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      this.sendAppError(res, 400, "HUB_BAD_REQUEST", "malformed request URL");
      return;
    }
    const pathname = url.pathname;
    try {
      // —— loopback CORS 中间件（UI-1b）：放行来源回显 ACAO；其余来源不发头 ——
      // （用 setHeader 而不是 writeHead：与后续各 handler 的 writeHead 合并发送）
      const allowOrigin = allowedCorsOrigin(req.headers.origin);
      if (allowOrigin !== undefined) {
        res.setHeader("Access-Control-Allow-Origin", allowOrigin);
        res.setHeader("Vary", "Origin"); // ACAO 随 Origin 变化，提示缓存按请求区分
      }
      const method = req.method ?? "";
      if (method === "OPTIONS") {
        // —— 预检：204 + 允许的方法 / 请求头（204 不允许携带响应体）——
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Content-Length": "0",
        });
        res.end();
        return;
      }
      const table =
        method === "GET"
          ? this.getRoutes
          : method === "POST"
            ? this.postRoutes
            : method === "PUT"
              ? this.putRoutes
              : undefined;
      const handler = table?.get(pathname);
      if (handler !== undefined) {
        await handler(req, res, url);
        return;
      }
      if (
        this.getRoutes.has(pathname) ||
        this.postRoutes.has(pathname) ||
        this.putRoutes.has(pathname)
      ) {
        const allow: string[] = [];
        if (this.getRoutes.has(pathname)) {
          allow.push("GET");
        }
        if (this.postRoutes.has(pathname)) {
          allow.push("POST");
        }
        if (this.putRoutes.has(pathname)) {
          allow.push("PUT");
        }
        this.sendAppError(
          res,
          405,
          "HUB_METHOD_NOT_ALLOWED",
          `method ${method} is not allowed for ${pathname}`,
          undefined,
          { Allow: allow.join(", ") },
        );
        return;
      }
      this.sendAppError(res, 404, "HUB_NOT_FOUND", `no route for ${pathname}`);
    } catch (err) {
      if (err instanceof PathEscapeError) {
        this.sendAppError(res, 400, err.code, err.message);
        return;
      }
      if (err instanceof BadRequestError) {
        this.sendAppError(res, 400, "HUB_BAD_REQUEST", err.message);
        return;
      }
      this.respondError(res, err);
    }
  }

  /**
   * 统一错误响应出口（appMode 感知）：appMode === "app"（桌面 sidecar 形态）时
   * 在 details 里附带 userAction 提示键（按错误码查 {@link ERROR_USER_ACTIONS}，
   * 未命中回落 {@link DEFAULT_USER_ACTION}），UI 拿到后直接渲染可操作提示；
   * standalone 形态不带 userAction，details 原样透传。
   *
   * 所有类内错误响应（含请求侧 4xx 与 {@link respondError} 的异常映射）都经由
   * 本方法发出，保证 userAction 的有无只取决于 appMode，与触发路径无关。
   * @param res 目标响应
   * @param status HTTP 状态码（4xx / 5xx）
   * @param code 机器可读错误码
   * @param message 错误描述
   * @param details 可选结构化细节（undefined 字段不进入 JSON）
   * @param headers 可选附加响应头（如 405 的 Allow）
   */
  private sendAppError(
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): void {
    if (this.appMode === "app") {
      const merged: Record<string, unknown> = {
        ...(details ?? {}),
        userAction: ERROR_USER_ACTIONS[code] ?? DEFAULT_USER_ACTION,
      };
      sendError(res, status, code, message, merged, headers);
      return;
    }
    sendError(res, status, code, message, details, headers);
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
      this.sendAppError(res, 400, "HUB_LUA_ERROR", err.message, details);
      return;
    }
    if (err instanceof PackError) {
      this.sendAppError(res, 400, "HUB_PACK_ERROR", err.message, { packCode: err.code });
      return;
    }
    this.sendAppError(res, 500, "HUB_INTERNAL_ERROR", describeError(err));
  }

  /**
   * 读取并把读体路由（POST / PUT）的请求体解析为 JSON 对象；所有请求侧问题
   * （非 JSON 媒体类型 / 超限 / 非法 JSON / 非对象）在此直接响应错误并返回
   * undefined。
   * @param req 进入的请求
   * @param res 目标响应
   * @param maxBytes 请求体字节上限（缺省 1MB；/v1/files/write 传入放宽值，见
   *   {@link MAX_WRITE_BODY_BYTES}）
   * @returns 解析出的键值对象；请求侧问题已响应（或连接已断）时 undefined
   */
  private async readJsonBody(
    req: IncomingMessage,
    res: ServerResponse,
    maxBytes: number = MAX_BODY_BYTES,
  ): Promise<Record<string, unknown> | undefined> {
    if (!isJsonContentType(req.headers["content-type"])) {
      this.sendAppError(res, 415, "HUB_UNSUPPORTED_MEDIA_TYPE", "content-type must be application/json");
      return undefined;
    }
    const raw = await readBody(req, maxBytes);
    if (raw.kind === "aborted") {
      return undefined; // 连接已断，无从响应
    }
    if (raw.kind === "too-large") {
      this.sendAppError(res, 413, "HUB_PAYLOAD_TOO_LARGE", `request body exceeds ${maxBytes} bytes`);
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.buffer.toString("utf8"));
    } catch {
      this.sendAppError(res, 400, "HUB_BAD_REQUEST", "request body is not valid JSON");
      return undefined;
    }
    if (!isPlainObject(parsed)) {
      this.sendAppError(res, 400, "HUB_BAD_REQUEST", "request body must be a JSON object");
      return undefined;
    }
    return parsed;
  }

  // -- GET 路由 -------------------------------------------------------------

  /**
   * GET /v1/status：hub 健康 + TTS 连接状态。
   *
   * hub 字段来自 daemon.stats()（uptimeMs 现算，负值截为 0）+ 本进程 package.json
   * 的 version 与配置的 appMode（UI-1b：桌面 UI 用 hub.version 做"旧版 hub 功能
   * 降级"判断，用 hub.appMode 区分 sidecar 形态；旧版 hub 无这两个字段，UI 侧
   * 按缺失降级处理）。tts.connected 通过执行 luaGetVersion 探测（2s 超时），成功
   * 时顺带探测对象数（失败只影响可选的 objects 字段）。探测失败不是路由错误——
   * 仍 200，connected=false。
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
        version: pkg.version,
        appMode: this.appMode,
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
      this.sendAppError(res, 400, "HUB_CONFIRM_REQUIRED", "this operation requires confirm:true in the request body");
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
   * POST /v1/test/run：在 TTS 中跑图包工作区的 Lua 测试，返回 RunReport（阶段 7）。
   *
   * 流程：
   * 1. 字段校验（root 必填；targetGuid / outPath 类非空字符串、timeoutMs 正数、
   *    bail / bundle 布尔、include 字符串数组，非法即 400 HUB_BAD_REQUEST）；
   * 2. {@link discoverTests} 发现测试文件（include 缺省走 pack.yaml tests.include，
   *    再缺省内置 glob `tests/**\/*.test.lua`）——发现不到不是错误；
   * 3. targetGuid / timeoutMs 是**逐文件条目的覆盖值**（pack.yaml 里是全局配置），
   *    给了就整体覆盖到每个发现条目上；
   * 4. 坑 17：`new TestRunner(this.daemon.server)` 并把 `server: this.daemon.server`
   *    注入 RunOptions（runner 侧 opts.server 优先），复用 hub 已绑定的编辑器端口
   *    39998——本路由绝不二次绑定（与 /v1/pull、/v1/diff、/v1/push 同款）；
   * 5. 响应体就是 RunReport（结构化 JSON 英文键名，不走 t()）：`{runId, root,
   *    startedAt, endedAt, durationMs, total, passed, failed, errored, bailed,
   *    results[]}`。
   *
   * 业务失败（PackError：TEST_RUN_BUNDLE_FAILED / TEST_RUN_FILE_UNREADABLE /
   * TEST_RUN_FILE_TIMEOUT / TEST_RUN_EXEC_FAILED / TEST_RUN_RESULTS_MALFORMED /
   * TEST_RUN_GLOBAL_TIMEOUT）由 respondError 统一映射为 400 HUB_PACK_ERROR +
   * details.packCode；注意"测试用例断言失败"不是路由错误——那是报告里的
   * failed / errored 计数，路由照样 200。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async handleTestRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res);
    if (body === undefined) {
      return;
    }
    const root = requireString(body, "root");
    const targetGuid = optionalString(body, "targetGuid");
    const timeoutMs = optionalPositiveNumber(body, "timeoutMs");
    const bail = optionalBoolean(body, "bail");
    const bundle = optionalBoolean(body, "bundle");
    const include = optionalStringArray(body, "include");

    const discovered = await discoverTests({
      root,
      ...(include !== undefined ? { include } : {}),
    });
    // targetGuid / timeoutMs 是全局覆盖值：给了就覆盖每个发现条目（否则用 pack.yaml
    // tests 段 / 内置缺省值——由 discoverTests 已经算好）
    const files = discovered.map((entry) => ({
      ...entry,
      ...(targetGuid !== undefined ? { targetGuid } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }));

    const runner = new TestRunner(this.daemon.server);
    const report = await runner.run({
      root,
      files,
      server: this.daemon.server, // 坑 17：复用 hub 已绑定的编辑器端口，绝不二次绑定
      ...(bundle !== undefined ? { bundle } : {}),
      ...(bail !== undefined ? { bail } : {}),
    });
    sendJson(res, 200, report);
  }

  /**
   * POST /v1/pack/build：图包工作区 → 存档 JSON → 工坊上传用 BSON 载荷（阶段 7）。
   *
   * 纯本地文件流水线，**不依赖 daemon.server**（不碰 39998 / 39999）：
   * 1. {@link buildSave}：工作区 → TTS 存档 JSON（缺省
   *    `<root>/dist/<净化(pack.yaml name)>.json`；dryRun 只统计不写盘）；
   * 2. {@link buildBson}：JSON → BSON（内部自检"前 4 字节小端整数 == 文件大小"）；
   *    dryRun=true 时跳过本步——没有产物就不做自检，也不虚报字节数。
   *
   * outPath 语义：**输出 BSON 载荷路径**（中间 JSON 走 buildSave 自己的缺省命名）；
   * 缺省与 JSON 同目录同名、扩展名换成 .bson（与 CLI `tts build -o` /
   * `tts publish --bson` 的缺省推导口径一致）。
   *
   * 响应体：BsonBuildResult 三字段 `{outPath, byteLength, headerLength}`
   * （自检保证后两者相等）追加诊断字段 `dryRun` / `jsonPath` / `warnings[]` /
   * `scriptsReplaced` / `uiReplaced` / `objectsReplaced` / `decksPatched`；
   * dryRun=true 时 byteLength / headerLength 恒为 0（未生成载荷）。
   *
   * 业务失败（PackError：SKELETON_MISSING / SKELETON_INVALID / GUID_MISMATCH /
   * BUILD_FAILED / PUBLISH_JSON_NOT_FOUND / PUBLISH_JSON_INVALID /
   * PUBLISH_BSON_INVALID / PUBLISH_OUTPUT_EXISTS）由 respondError 统一映射为
   * 400 HUB_PACK_ERROR + details.packCode。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async handlePackBuild(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res);
    if (body === undefined) {
      return;
    }
    const root = requireString(body, "root");
    const outPath = optionalString(body, "outPath");
    const dryRun = optionalBoolean(body, "dryRun") ?? false;

    const build = await buildSave({ root, dryRun });
    const jsonPath = build.outPath;
    const bsonPath =
      outPath !== undefined
        ? path.resolve(outPath)
        : path.join(path.dirname(jsonPath), `${path.basename(jsonPath).replace(/\.json$/i, "")}.bson`);

    const response: Record<string, unknown> = {
      // BsonBuildResult 三字段（dryRun 下 outPath 是"将写入"的路径，字节数为 0）
      outPath: bsonPath,
      byteLength: 0,
      headerLength: 0,
      // 诊断字段（附加，不属于 BsonBuildResult 的核心契约）
      dryRun,
      jsonPath,
      warnings: build.warnings,
      scriptsReplaced: build.scriptsReplaced,
      uiReplaced: build.uiReplaced,
      objectsReplaced: build.objectsReplaced,
      decksPatched: build.decksPatched,
    };
    if (!dryRun) {
      const bson = await buildBson({ jsonPath, outPath: bsonPath });
      response.outPath = bson.outPath;
      response.byteLength = bson.byteLength;
      response.headerLength = bson.headerLength;
    }
    sendJson(res, 200, response);
  }

  // -- UI-1b 文件路由（不注册为 MCP 工具——红线 15）---------------------------

  /**
   * 校验 root 是已注册图包根：`<packsRoot>/.registry.yaml`（packsRoot 取 root 的
   * 父目录）中存在 dir = root 基名的条目。注册表模型见 src/pack/registry.ts
   * （图包永远是 packs_root 下的一级子目录）。
   * @param root 请求体里的工作区根目录
   * @throws BadRequestError root 不在注册表中（或注册表非法 / IO 失败——后者经
   *                         respondError 以 400 HUB_PACK_ERROR 透传）
   */
  private async assertRegisteredPackRoot(root: string): Promise<void> {
    const rootAbs = path.resolve(root);
    const packsRoot = path.dirname(rootAbs);
    const dir = path.basename(rootAbs);
    const entry = await findPack(packsRoot, dir);
    if (entry === null) {
      throw new BadRequestError(
        `root is not a registered pack workspace: ${rootAbs} (no entry "${dir}" in ${registryPath(packsRoot)})`,
      );
    }
  }

  /**
   * POST /v1/files/read：读工作区 root 内的一个文件，返回 base64（UI-1b，卡牌 /
   * 素材本地预览用）。**不注册为 MCP 工具**（红线 15：防 MCP 越权读宿主机文件）。
   *
   * 流程：字段校验（root / path 非空字符串）→ root 注册表校验（400）→
   * {@link resolveWithinRoot} 四层路径防护（HUB_PATH_ESCAPE → 400）→ 扩展名
   * MIME 白名单（400）→ stat（ENOENT → 400；非普通文件 → 400；>20MB →
   * 413 HUB_FILE_TOO_LARGE）→ readFile → `{base64, mime, size}`。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async handleFilesRead(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res);
    if (body === undefined) {
      return;
    }
    const root = requireString(body, "root");
    const relPath = requireString(body, "path");
    await this.assertRegisteredPackRoot(root);
    const target = await resolveWithinRoot(root, relPath);
    const mime = mimeForFile(target);
    let info: Stats;
    try {
      info = await stat(target);
    } catch (err) {
      throw asFileAccessError(err, relPath);
    }
    if (!info.isFile()) {
      throw new BadRequestError(`not a regular file: ${relPath}`);
    }
    if (info.size > MAX_READ_FILE_BYTES) {
      this.sendAppError(
        res,
        413,
        "HUB_FILE_TOO_LARGE",
        `file exceeds the ${MAX_READ_FILE_BYTES}-byte limit for /v1/files/read`,
      );
      return;
    }
    let content: Buffer;
    try {
      content = await readFile(target);
    } catch (err) {
      throw asFileAccessError(err, relPath);
    }
    sendJson(res, 200, { base64: content.toString("base64"), mime, size: content.length });
  }

  /**
   * PUT /v1/files/write：把一个文本文件写进工作区 root（UI-1b，工作台保存脚本
   * 用）。**不注册为 MCP 工具**（红线 15）。方法用 PUT 表达幂等覆写语义。
   *
   * 流程与约束：
   * 1. 字段校验：root / path 非空字符串；content 必须是字符串（**允许空串**——
   *    清空文件是合法操作）；baseSha256 可选、必须 64 位 hex（不区分大小写）；
   * 2. content 仅文本：含 null 字节 → 400；UTF-8 字节数 > 1MB →
   *    413 HUB_FILE_TOO_LARGE（请求体上限放宽到 8MB 只为让超限 content 落到本
   *    专用错误码，见 {@link MAX_WRITE_BODY_BYTES}）；
   * 3. {@link resolveWithinRoot} 同套四层路径防护（HUB_PATH_ESCAPE → 400；root
   *    不要求已注册——按方案 §8.4 仅 read 校验注册表）；
   * 4. 父目录必须已存在（不隐式 mkdir，防拼写笔误静默建目录树）→ 不存在 400；
   * 5. 乐观锁：baseSha256 提供时与当前文件 sha256 比对（目标不存在视为必然
   *    冲突——创建新文件请不要带 baseSha256），不符 409 HUB_CONFLICT，
   *    details.currentSha256 携带当前值供 UI 重新对齐；
   * 6. writeFile 覆写（不存在则创建）→ `{sha256, size}`（对写入后的 UTF-8
   *    字节计算，与下次乐观锁基准一致）。
   * @param req 进入的请求
   * @param res 目标响应
   */
  private async handleFilesWrite(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res, MAX_WRITE_BODY_BYTES);
    if (body === undefined) {
      return;
    }
    const root = requireString(body, "root");
    const relPath = requireString(body, "path");
    const content = body.content;
    if (typeof content !== "string") {
      throw new BadRequestError("missing or invalid field: content (string required; empty string allowed)");
    }
    if (content.includes("\0")) {
      throw new BadRequestError("invalid field: content (plain text without null bytes required)");
    }
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > MAX_WRITE_CONTENT_BYTES) {
      this.sendAppError(
        res,
        413,
        "HUB_FILE_TOO_LARGE",
        `content exceeds the ${MAX_WRITE_CONTENT_BYTES}-byte limit for /v1/files/write`,
      );
      return;
    }
    const baseSha256 = optionalString(body, "baseSha256");
    if (baseSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(baseSha256)) {
      throw new BadRequestError("invalid field: baseSha256 (64-character hex sha256 required)");
    }
    const target = await resolveWithinRoot(root, relPath);
    const parent = path.dirname(target);
    try {
      const parentInfo = await stat(parent);
      if (!parentInfo.isDirectory()) {
        throw new BadRequestError(`parent path is not a directory: ${relPath}`);
      }
    } catch (err) {
      if (err instanceof BadRequestError) {
        throw err;
      }
      if (errCode(err) === "ENOENT") {
        throw new BadRequestError(`parent directory does not exist: ${relPath}`);
      }
      throw err;
    }
    if (baseSha256 !== undefined) {
      let currentSha: string | undefined;
      try {
        currentSha = createHash("sha256").update(await readFile(target)).digest("hex");
      } catch (err) {
        if (errCode(err) !== "ENOENT") {
          throw asFileAccessError(err, relPath);
        }
        // 目标不存在：currentSha 保持 undefined，与任何 baseSha256 比对都是冲突
      }
      if (currentSha !== baseSha256.toLowerCase()) {
        this.sendAppError(
          res,
          409,
          "HUB_CONFLICT",
          "baseSha256 does not match the current file content (optimistic-lock conflict)",
          currentSha !== undefined ? { currentSha256: currentSha } : undefined,
        );
        return;
      }
    }
    const buffer = Buffer.from(content, "utf8");
    try {
      await writeFile(target, buffer);
    } catch (err) {
      throw asFileAccessError(err, relPath);
    }
    sendJson(res, 200, {
      sha256: createHash("sha256").update(buffer).digest("hex"),
      size: buffer.length,
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
