// src/assets/fetch.ts
/**
 * 素材下载器与"素材健康报告"（方案设计 §6.4，与上传同等重要的刚需能力）。
 *
 * 背景（§6.4 实测）：19 个图包里 Imgur 10,419 个引用、Google Drive 8,906 个、
 * paste.ee 5,396 个——第三方图床大面积不可靠，素材修复是刚需而非可选优化。
 *
 * 职责：
 * - {@link describeUrl}：识别 URL 源类型并计算各类改写（纯函数、无网络）：
 *   · `www.` 缺协议 → 自动补 `https://`；
 *   · Google Drive 分享链接（`/file/d/<id>/view|edit`、`/open?id=`）→ 直链
 *     `https://drive.google.com/uc?export=download&id=<fileId>`；
 *   · Dropbox `?dl=0`（或缺省）→ `?dl=1`；
 *   · paste.ee（`/p/<id>` → `/r/<id>`）、pastebin（`/<id>` → `/raw/<id>`）、
 *     gist（`gist.github.com/<user>/<id>` → `gist.githubusercontent.com/<user>/<id>/raw`）
 *     按各自的 raw 形式取；
 *   · 老式 Steam Cloud 域名 `cloud-<N>.steamusercontent.com` → 迁移到
 *     `steamusercontent-a.akamaihd.net`（§6.4："直接可用；同时提供域名迁移"）；
 *   · `file:` 本地路径 / {lang} 语言变体 / 无法识别的形态 → 不可下载，归入需人工处理。
 * - {@link checkAssetHealth}：并发探测一批 URL（去重），输出四类健康报告：
 *   **正常 ok / 可迁移 migratable / 死链 dead / 需人工处理 manual**，附修复动作。
 *   分类语义：
 *   · ok        —— 探测 2xx 且没有任何可用改写；
 *   · migratable —— 探测 2xx 但存在改写动作（补协议 / 转直链 / 迁移域名），
 *     或原地址已死但迁移域名后可用（老 Steam Cloud 域名被 Valve 弃用的真实收益）；
 *   · dead      —— 所有候选地址都探不通，修复动作 = 重新上传；
 *   · manual    —— 工具无法自动处理（file: 本地路径、{lang} 变体、未知形态、
 *     Google Drive 返回网页而非文件的大文件确认页）。
 * - {@link fetchAsset}：实际下载字节（GET + 手动跟随重定向 + 大小上限），
 *   供 `assets/migrate.ts` 的离线预置与 CLI 复用。
 * - {@link guessExtension}：从 URL 路径 / Content-Type 猜扩展名（§6.8 缓存文件名用）。
 *
 * 网络（与 src/assets/check.ts 同一套约定）：
 * - 走 `process.env.https_proxy || process.env.HTTPS_PROXY` 的代理（undici ProxyAgent）；
 * - undici request 默认不跟随重定向，本模块**手动跟随**（探测 / 下载都可能被 301/302
 *   重定向到 CDN，判死链必须先跟完重定向）；
 * - HEAD 不支持（405/501）或未拿到响应时退化 GET；
 * - 超时双保险：AbortSignal.timeout + 竞速兜底定时器（代理 CONNECT 挂起不响应 signal，
 *   实测见 check.ts 同款注释）。
 *
 * 错误：入参校验失败抛 {@link PackError}（code="ASSETS_FETCH_INVALID"）；
 * 单个 URL 的网络失败不抛错，记录进结果（批量操作不因单条失败中断）。
 *
 * 测试边界：{@link checkAssetHealth} 支持 opts.probe 注入假探测函数（网络边界依赖注入），
 * 使四分类逻辑可离线单测；{@link fetchAsset} 直接对 localhost 服务器可测。
 */

import { ProxyAgent, request } from "undici";
import { z } from "zod";

import pkg from "../../package.json" with { type: "json" };
import { isLangVariant, isLocalFileUrl, isMissingProtocol } from "../deck/patch.js";
import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 默认并发上限（与 check.ts 一致） */
const DEFAULT_CONCURRENCY = 8;

/** 默认单请求超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 10_000;

/** 硬性超时相对 timeoutMs 的宽限（毫秒；代理 CONNECT 挂起兜底，见模块头注释） */
const HARD_TIMEOUT_SLACK_MS = 1_000;

/** 重定向跟随上限（探测与下载共用；超过即按失败处理） */
const DEFAULT_MAX_REDIRECTS = 5;

/** HEAD 不可用时退化重试的 HTTP 状态码（与 check.ts 一致） */
const HEAD_UNSUPPORTED_STATUSES: readonly number[] = [405, 501];

/** 需要跟随的重定向状态码 */
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];

/** 请求 UA（与 check.ts 保持一致） */
const USER_AGENT = `tts-toolkit/${pkg.version}`;

/** 批次结束时关闭 ProxyAgent 的上限（毫秒），超时改强制 destroy（与 check.ts 一致） */
const AGENT_CLOSE_TIMEOUT_MS = 2_000;

/**
 * 老式 Steam Cloud 域名（§6.8 实测样例为 cloud-3；不同存档里也存在 cloud-2 等兄弟域名，
 * 统一按 `cloud-<数字>.steamusercontent.com` 识别）→ Akamai CDN 域名。
 */
const STEAM_CLOUD_HOST_RE = /^cloud-\d+\.steamusercontent\.com$/;

/** Steam Cloud 迁移目标域名（方案设计 §6.4 表格原文） */
export const STEAM_CLOUD_MIGRATED_HOST = "steamusercontent-a.akamaihd.net";

/** Google Drive 文件页路径：/file/d/<id>（后续段可有可无，如 /view、/edit、/usp=sharing） */
const GDRIVE_FILE_PATH_RE = /^\/file\/d\/([A-Za-z0-9_-]{10,})(?:\/.*)?$/;

/** Google Drive 直链路径（docs.google.com/uc 与 drive.google.com/uc 都是实测存在的直链形态） */
const GDRIVE_DIRECT_PATH_RE = /^\/uc\/?$/;

/** Dropbox 主域（子域 www 等一并覆盖） */
const DROPBOX_HOST_RE = /(^|\.)dropbox\.com$/;

/** paste.ee 主域 */
const PASTEE_HOST_RE = /(^|\.)paste\.ee$/;

/** pastebin.com 主域 */
const PASTEBIN_HOST_RE = /(^|\.)pastebin\.com$/;

/** gist 页面域（raw 域为 gist.githubusercontent.com，另一个常量） */
const GIST_HOST_RE = /(^|\.)gist\.github\.com$/;

/** gist raw 域名（已在该域上的 URL 视为直链） */
const GIST_RAW_HOST = "gist.githubusercontent.com";

/** Imgur 主域（i.imgur.com 直图 / imgur.com 页面都算；§6.4：只判活死，不做改写） */
const IMGUR_HOST_RE = /(^|\.)imgur\.com$/;

/** Google Drive 家族域名 */
const GDRIVE_HOST_RE = /(^|\.)(drive|docs)\.google\.com$/;

/**
 * pastebin.com 的非贴文保留路径段（/u/<user>、/api 等）——对这些做 /raw/ 改写只会得到 404，
 * 识别不出贴文 ID 时宁可直接归入需人工处理。
 */
const PASTEBIN_RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  "raw", "u", "api", "archive", "languages", "faq", "tools", "login", "signup",
  "trends", "dmca", "contact", "jobs", "widgets", "doc", "alerts", "locations",
]);

/**
 * {@link guessExtension} 认可的扩展名白名单（小写）。
 * 不在名单内的 URL 路径扩展名不采信（避免把 "?x.y" 之类噪声当扩展名）。
 */
const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "tga", "psd", "pdf",
  "mp3", "ogg", "wav", "mp4", "obj", "mtl", "fbx", "unity3d", "json", "txt", "bin",
]);

/** Content-Type → 扩展名（guessExtension 的第二优先级） */
const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tga": "tga",
  "image/x-tga": "tga",
  "application/pdf": "pdf",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "video/mp4": "mp4",
  "text/plain": "txt",
  "application/json": "json",
});

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** URL 源类型（§6.4 表格逐行对应） */
export type UrlKind =
  | "plain"        // 普通 HTTP(S)
  | "steam-cloud"  // 老式 Steam Cloud（cloud-<N>.steamusercontent.com）
  | "gdrive"       // Google Drive
  | "dropbox"      // Dropbox
  | "paste"        // paste.ee / pastebin / gist
  | "imgur"        // Imgur（只判活死）
  | "local-file"   // file: 本地路径
  | "lang-variant" // {lang} 语言变体
  | "unknown";     // 无法识别（空值 / 非 http(s) 方案 / 解析失败）

/** URL 改写 / 修复动作（机器码，面向用户的文案用 {@link fixActionLabel}） */
export type FixAction =
  | "add-protocol"   // 补 https://
  | "convert-direct" // 分享链接 → 直链
  | "migrate-domain" // 老 Steam Cloud 域名 → Akamai 域名
  | "reupload"       // 重新上传素材并替换 URL
  | "manual-review"; // 人工确认后处理

/** 素材健康四分类（§6.4） */
export type AssetCategory = "ok" | "migratable" | "dead" | "manual";

/** 单个 URL 的形态描述（describeUrl 的产物，纯计算、无网络） */
export interface UrlDescription {
  /** 原始 URL（原样保留，不做 trim 改写） */
  url: string;
  /** 源类型 */
  kind: UrlKind;
  /**
   * 可实际下载的地址：补协议 / 转直链之后的最终形态。
   * 不可下载（file: / {lang} / unknown / Google Drive 非文件链接 / paste 站未识别出贴文）时缺省。
   */
  downloadUrl?: string;
  /**
   * Steam Cloud 域名迁移目标（仅 kind="steam-cloud" 时存在）；
   * 其余源类型不存在该字段。
   */
  migratedUrl?: string;
  /** 原值缺协议（www. 开头），改写动作 = add-protocol */
  needsProtocolFix: boolean;
  /** 需要分享链接 → 直链改写（gdrive / dropbox / paste），改写动作 = convert-direct */
  needsDirectConversion: boolean;
  /** 需要域名迁移（老 Steam Cloud），改写动作 = migrate-domain */
  needsMigration: boolean;
}

/** 单次探测结果（status=0 表示未拿到 HTTP 响应） */
export interface ProbeOutcome {
  /** HTTP 状态码；未拿到响应时为 0 */
  status: number;
  /** 响应 Content-Type（2xx 时尽量带上；用于识别 Google Drive 网页确认页） */
  contentType?: string;
  /** 未拿到响应时的中文错误描述 */
  error?: string;
}

/** 探测函数类型（checkAssetHealth 的网络边界，可注入替换用于离线测试） */
export type ProbeFn = (url: string) => Promise<ProbeOutcome>;

/** 健康报告里的单条记录 */
export interface AssetHealthEntry {
  /** 原始 URL（存档中的原文） */
  url: string;
  /** 四分类之一 */
  category: AssetCategory;
  /** 源类型 */
  kind: UrlKind;
  /** 建议的修复动作（按执行顺序排列） */
  fixActions: FixAction[];
  /** 建议改写成的 URL（可迁移时有；Google Drive 网页确认页的人工处理场景也会给出） */
  fixedUrl?: string;
  /** HTTP 状态码（探测过才有；未拿到响应为 0） */
  status?: number;
  /** 中文补充说明（死因 / 迁移后可用的说明等；无则缺省） */
  detail?: string;
}

/** 素材健康报告（§6.4：正常 / 可迁移 / 死链 / 需人工处理 四类及修复动作） */
export interface AssetHealthReport {
  /** 去重后的 URL 总数 */
  total: number;
  /** 正常 */
  ok: number;
  /** 可迁移 */
  migratable: number;
  /** 死链 */
  dead: number;
  /** 需人工处理 */
  manual: number;
  /** 逐 URL 记录（按 URL 字典序——UTF-16 码元序——升序，保证可复现） */
  entries: AssetHealthEntry[];
}

/** fetchAsset 的结果：成功带字节，失败带中文原因（单个 URL 的失败不抛错） */
export type FetchOutcome =
  | { ok: true; url: string; finalUrl: string; status: number; contentType?: string; data: Uint8Array }
  | { ok: false; url: string; status?: number; error: string };

/** checkAssetHealth 选项 */
export interface CheckHealthOptions {
  /** 并发上限，默认 8（须 ≥ 1） */
  concurrency?: number;
  /** 单请求超时毫秒数，默认 10000（须 ≥ 1） */
  timeoutMs?: number;
  /** 重定向跟随上限，默认 5（须 ≥ 0） */
  maxRedirects?: number;
  /**
   * 自定义探测函数（网络边界依赖注入）：默认实现为"HEAD→GET 退化 + 手动跟随重定向"。
   * 传入后本模块不再创建任何网络资源（不读代理环境变量），全部探测交由该函数完成。
   */
  probe?: ProbeFn;
}

/** fetchAsset 选项 */
export interface FetchAssetOptions {
  /** 单请求超时毫秒数，默认 10000（须 ≥ 1） */
  timeoutMs?: number;
  /** 响应体大小上限字节数（默认不限；须 ≥ 1） */
  maxBytes?: number;
  /** 重定向跟随上限，默认 5（须 ≥ 0） */
  maxRedirects?: number;
  /**
   * 复用的代理调度器（批量下载时由调用方创建并统一关闭，避免每条素材各建一个连接池；
   * 如 presetOfflineCache 的批内复用）。缺省时本函数自行按代理环境变量创建并在结束时关闭。
   */
  dispatcher?: ProxyAgent;
}

// ---------------------------------------------------------------------------
// zod 校验（运行时边界统一 unknown + zod，禁止 any）
// ---------------------------------------------------------------------------

/** checkAssetHealth 入参 URL 列表结构 */
const urlsSchema = z.array(z.string({ error: "每个 URL 必须是字符串" }), {
  error: "urls 必须是字符串数组",
});

/** checkAssetHealth 选项结构（probe 用 z.custom 校验函数形态） */
const checkHealthOptsSchema = z.object(
  {
    concurrency: z
      .number({ error: "concurrency 必须是数字" })
      .int("concurrency 必须是整数")
      .min(1, "concurrency 必须 ≥ 1")
      .optional(),
    timeoutMs: z
      .number({ error: "timeoutMs 必须是数字" })
      .int("timeoutMs 必须 ≥ 1")
      .min(1, "timeoutMs 必须 ≥ 1")
      .optional(),
    maxRedirects: z
      .number({ error: "maxRedirects 必须是数字" })
      .int("maxRedirects 必须是整数")
      .min(0, "maxRedirects 必须 ≥ 0")
      .optional(),
    probe: z.custom<ProbeFn>((value) => typeof value === "function", {
      error: "probe 必须是函数",
    }).optional(),
  },
  { error: "opts 必须是键值对象" },
);

/** fetchAsset 选项结构 */
const fetchAssetOptsSchema = z.object(
  {
    timeoutMs: z
      .number({ error: "timeoutMs 必须是数字" })
      .int("timeoutMs 必须是整数")
      .min(1, "timeoutMs 必须 ≥ 1")
      .optional(),
    maxBytes: z
      .number({ error: "maxBytes 必须是数字" })
      .int("maxBytes 必须是整数")
      .min(1, "maxBytes 必须 ≥ 1")
      .optional(),
    maxRedirects: z
      .number({ error: "maxRedirects 必须是数字" })
      .int("maxRedirects 必须是整数")
      .min(0, "maxRedirects 必须 ≥ 0")
      .optional(),
    dispatcher: z.custom<ProxyAgent>((value) => value instanceof ProxyAgent, {
      error: "dispatcher 必须是 undici ProxyAgent 实例",
    }).optional(),
  },
  { error: "opts 必须是键值对象" },
);

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 将 zod 校验错误格式化为单行中文可读描述（仓库各模块同款实现）。
 * @param error zod 校验错误对象
 * @returns 形如 "timeoutMs：timeoutMs 必须 ≥ 1" 的描述，多个问题以"；"连接
 */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const segments = issue.path.map((seg) => (typeof seg === "symbol" ? seg.toString() : String(seg)));
      const where = segments.length > 0 ? segments.join(".") : "(根)";
      return `${where}：${issue.message}`;
    })
    .join("；");
}

/** 入参非法时统一抛出的 PackError（code 固定 ASSETS_FETCH_INVALID） */
function invalidFetch(detail: string): PackError {
  return new PackError("ASSETS_FETCH_INVALID", t("error.assets.fetchInvalid", { detail }));
}

/**
 * 读取代理地址：优先小写 `https_proxy`，其次大写 `HTTPS_PROXY`（与 check.ts 同款约定）。
 * 仅在调用时读取，便于测试临时覆盖；空字符串视作未设置。
 * @returns 代理地址（如 `http://127.0.0.1:7890`）；未设置时 undefined
 */
function resolveProxyUrl(): string | undefined {
  const raw = process.env.https_proxy?.trim() || process.env.HTTPS_PROXY?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

/** 创建代理调度器；未设置代理环境变量时返回 undefined（走 undici 默认直连） */
function openProxyDispatcher(): ProxyAgent | undefined {
  const proxyUrl = resolveProxyUrl();
  return proxyUrl !== undefined ? new ProxyAgent(proxyUrl) : undefined;
}

/**
 * 关闭代理调度器（含超时兜底与 destroy 回退，与 check.ts 同款——
 * keep-alive 连接会让进程迟迟不退出，必须显式关闭）。
 */
async function closeProxyDispatcher(dispatcher: ProxyAgent | undefined): Promise<void> {
  if (dispatcher === undefined) {
    return;
  }
  await Promise.race([
    dispatcher.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, AGENT_CLOSE_TIMEOUT_MS).unref();
    }),
  ]);
  await dispatcher.destroy().catch(() => undefined);
}

/** 从错误对象上取出错误码（与 check.ts 同款） */
function extractErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

/** 已收录 i18n 文案的网络错误码（探测时按码查键，未收录的回退 unknown） */
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "EHOSTUNREACH", "ENETUNREACH", "CERT_HAS_EXPIRED", "ERR_INVALID_URL",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_CLOSED", "UND_ERR_DESTROYED", "UND_ERR_PRX_TLS",
  "UND_ERR_RESPONSE",
]);

/**
 * 把请求异常转成中文描述（i18n 键 assets.fetch.netError.*）。
 * @param err 请求抛出的异常（超时为 DOMException TimeoutError，网络错误为带 code 的 Error）
 * @param timeoutMs 本次请求的超时毫秒数（用于文案）
 * @returns 中文错误描述
 */
function describeRequestError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    // AbortSignal.timeout 触发时为 DOMException（name = "TimeoutError"）
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return t("assets.fetch.netError.timeout", { ms: timeoutMs });
    }
    const code = extractErrorCode(err);
    if (code !== undefined && KNOWN_ERROR_CODES.has(code)) {
      return t(`assets.fetch.netError.${code}`);
    }
    const message = code !== undefined ? `${err.message}（${code}）` : err.message;
    return t("assets.fetch.netError.unknown", { message });
  }
  return t("assets.fetch.netError.unknown", { message: String(err) });
}

/** 硬性超时兜底用的内部错误（与 check.ts 同款，用于与 undici 自身错误区分） */
class HardTimeoutError extends Error {
  constructor() {
    super("hard timeout");
    this.name = "HardTimeoutError";
  }
}

/** 单次 HTTP 请求拿到的原始信息（跟随重定向 / 下载用） */
interface RequestSnapshot {
  status: number;
  /** 3xx 响应的 Location 头（存在且非空时才有） */
  location?: string;
  /** 2xx 响应的 Content-Type（下载 / 网页识别用） */
  contentType?: string;
  /** 2xx 响应体（仅下载路径——requestOnce 带 maxBytes 时读取） */
  data?: Uint8Array;
  /** 未拿到响应时的中文错误描述 */
  error?: string;
}

/**
 * 对单个 URL 发起一次请求（不跟随重定向），按需消费响应体。
 *
 * 超时双保险（与 check.ts 同款）：
 * 1. `AbortSignal.timeout(timeoutMs)` —— 正常路径；
 * 2. 竞速定时器 `timeoutMs + HARD_TIMEOUT_SLACK_MS` —— 兜底代理 CONNECT 挂起等
 *    signal 不生效的场景，保证任何情况下都会落定。
 *
 * @param captureBytes 响应体消费方式：undefined 时 dump 丢弃（探测路径——body
 *   必须消费连接才会复用）；传字节数时**读取完整响应体**放入 snapshot.data（下载
 *   路径，不限大小传 Number.MAX_SAFE_INTEGER），超限时 snapshot.error 为 oversized
 *   文案且无 data。
 * @returns 状态码 / Location / Content-Type / 响应体，或未拿到响应时的中文错误描述；本函数不抛错
 */
async function requestOnce(
  url: string,
  method: "HEAD" | "GET",
  dispatcher: ProxyAgent | undefined,
  timeoutMs: number,
  captureBytes?: number,
): Promise<RequestSnapshot> {
  const hardTimeoutMs = timeoutMs + HARD_TIMEOUT_SLACK_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    const attempt = (async (): Promise<RequestSnapshot> => {
      const res = await request(url, {
        method,
        dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": USER_AGENT },
      });
      const locationRaw = res.headers.location;
      const location =
        typeof locationRaw === "string" && locationRaw !== ""
          ? locationRaw
          : Array.isArray(locationRaw) && typeof locationRaw[0] === "string" && locationRaw[0] !== ""
            ? locationRaw[0]
            : undefined;
      const snapshot: RequestSnapshot = { status: res.statusCode };
      if (location !== undefined) {
        snapshot.location = location;
      }
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const contentTypeRaw = res.headers["content-type"];
        const contentType =
          typeof contentTypeRaw === "string" && contentTypeRaw !== ""
            ? contentTypeRaw
            : Array.isArray(contentTypeRaw) && typeof contentTypeRaw[0] === "string"
              ? contentTypeRaw[0]
              : undefined;
        if (contentType !== undefined) {
          snapshot.contentType = contentType;
        }
        if (captureBytes === undefined) {
          // 探测路径：body 必须消费（dump）连接才会复用
          await res.body.dump();
        } else {
          // 下载路径：读取完整响应体（超限即中断；break 会销毁流并释放连接）
          const chunks: Buffer[] = [];
          let total = 0;
          let oversized = false;
          for await (const chunk of res.body) {
            const buf = chunk as Buffer;
            total += buf.byteLength;
            if (total > captureBytes) {
              oversized = true;
              break;
            }
            chunks.push(buf);
          }
          if (oversized) {
            snapshot.status = 0;
            snapshot.error = t("assets.fetch.netError.oversized", { max: captureBytes });
          } else {
            snapshot.data = new Uint8Array(Buffer.concat(chunks));
          }
        }
      } else {
        // 非 2xx：body 仍须消费
        await res.body.dump();
      }
      return snapshot;
    })();
    // 兜底定时器胜出后 attempt 仍可能稍后 reject，提前挂 catch 防 unhandled rejection
    attempt.catch(() => {});

    const hardTimeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new HardTimeoutError());
      }, hardTimeoutMs);
    });

    return await Promise.race([attempt, hardTimeout]);
  } catch (err) {
    if (err instanceof HardTimeoutError) {
      return { status: 0, error: t("assets.fetch.netError.timeout", { ms: timeoutMs }) };
    }
    return { status: 0, error: describeRequestError(err, timeoutMs) };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** HEAD→GET 退化判定（与 check.ts 一致：405/501 或完全没拿到响应） */
function needsGetFallback(snapshot: RequestSnapshot): boolean {
  return snapshot.status === 0 || HEAD_UNSUPPORTED_STATUSES.includes(snapshot.status);
}

/**
 * 默认探测实现：HEAD 起步，必要时退化 GET，手动跟随重定向（undici request 不自动跟随）。
 * 每一跳都使用完整的 timeoutMs（多跳最坏耗时 = 跳数 × timeoutMs + 兜底宽限）。
 * @returns 终态快照；重定向超限时返回 status=0 + tooManyRedirects 错误
 */
async function defaultProbe(
  url: string,
  dispatcher: ProxyAgent | undefined,
  timeoutMs: number,
  maxRedirects: number,
): Promise<ProbeOutcome> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let snapshot = await requestOnce(current, "HEAD", dispatcher, timeoutMs);
    if (needsGetFallback(snapshot)) {
      snapshot = await requestOnce(current, "GET", dispatcher, timeoutMs);
    }
    if (REDIRECT_STATUSES.includes(snapshot.status)) {
      if (snapshot.location === undefined) {
        // 3xx 但无 Location：按终态处理（非 2xx → 判死）
        return snapshot;
      }
      if (hop === maxRedirects) {
        return {
          status: 0,
          error: t("assets.fetch.netError.tooManyRedirects", { max: maxRedirects }),
        };
      }
      current = new URL(snapshot.location, current).toString();
      continue;
    }
    return snapshot;
  }
  // 循环正常耗尽（理论不可达，防御性兜底）
  return { status: 0, error: t("assets.fetch.netError.tooManyRedirects", { max: maxRedirects }) };
}

/** 简单并发池（与 check.ts 同款实现：queue.shift() 在 JS 单线程下原子，无需锁） */
async function pLimit<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

/** URL 字典序比较（UTF-16 码元序，与 inventory.ts 一致，保证输出可复现） */
function compareUrls(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// URL 形态识别（纯函数，无网络）
// ---------------------------------------------------------------------------

/** 描述"不可下载"的形态：downloadUrl 缺省 + kind 指明原因 */
function undescribable(url: string, kind: UrlKind): UrlDescription {
  return {
    url,
    kind,
    needsProtocolFix: false,
    needsDirectConversion: false,
    needsMigration: false,
  };
}

/** 从 Google Drive URL 提取文件 ID；提取不到（文件夹 / 其他文档形态）返回 undefined */
function extractGdriveFileId(parsed: URL): string | undefined {
  const fileMatch = GDRIVE_FILE_PATH_RE.exec(parsed.pathname);
  if (fileMatch !== null) {
    return fileMatch[1];
  }
  const id = parsed.searchParams.get("id");
  if (id !== null && /^[A-Za-z0-9_-]{10,}$/.test(id)) {
    return id;
  }
  return undefined;
}

/**
 * 识别一个 URL 的源类型与可用改写（§6.4 表格的实现）。
 *
 * 处理顺序（判定互不重叠，可叠加的只有"缺协议 + 各类改写"）：
 * 1. 空值 / {lang} 变体 / file: 本地路径 → 不可下载；
 * 2. `www.` 缺协议 → 记 needsProtocolFix 并补 `https://` 后继续识别；
 * 3. URL 解析失败或方案非 http(s) → unknown；
 * 4. 按域名识别 steam-cloud / gdrive / dropbox / paste / imgur，其余为 plain。
 *
 * @param url 原始 URL 字符串
 * @returns 形态描述；不可下载时 downloadUrl 缺省
 * @throws PackError（code="ASSETS_FETCH_INVALID"）url 不是字符串时
 */
export function describeUrl(url: string): UrlDescription {
  if (typeof url !== "string") {
    throw invalidFetch(t("error.assets.invalidUrl", { detail: `typeof url = ${typeof url}` }));
  }
  if (url.trim() === "") {
    return undescribable(url, "unknown");
  }
  if (isLangVariant(url)) {
    return undescribable(url, "lang-variant");
  }
  if (isLocalFileUrl(url)) {
    return undescribable(url, "local-file");
  }

  const needsProtocolFix = isMissingProtocol(url);
  const normalized = needsProtocolFix ? `https://${url}` : url;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return undescribable(url, "unknown");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undescribable(url, "unknown");
  }

  const host = parsed.hostname.toLowerCase();

  // ---- 老式 Steam Cloud：直接可用，提供域名迁移（§6.4） ----
  if (STEAM_CLOUD_HOST_RE.test(host)) {
    const migrated = new URL(normalized);
    migrated.hostname = STEAM_CLOUD_MIGRATED_HOST;
    return {
      url,
      kind: "steam-cloud",
      downloadUrl: normalized,
      migratedUrl: migrated.toString(),
      needsProtocolFix,
      needsDirectConversion: false,
      needsMigration: true,
    };
  }

  // ---- Google Drive：分享链接 → uc?export=download&id=<fileId>（§6.4） ----
  if (GDRIVE_HOST_RE.test(host)) {
    const fileId = extractGdriveFileId(parsed);
    if (fileId === undefined) {
      // 文件夹或其他文档形态：无法转直链，归入需人工处理
      return undescribable(url, "gdrive");
    }
    const isDirect =
      GDRIVE_DIRECT_PATH_RE.test(parsed.pathname) &&
      parsed.searchParams.get("export") === "download" &&
      parsed.searchParams.get("id") === fileId;
    const direct = new URL("https://drive.google.com/uc");
    direct.searchParams.set("export", "download");
    direct.searchParams.set("id", fileId);
    return {
      url,
      kind: "gdrive",
      downloadUrl: direct.toString(),
      needsProtocolFix,
      needsDirectConversion: !isDirect,
      needsMigration: false,
    };
  }

  // ---- Dropbox：?dl=0（或缺省）→ ?dl=1（§6.4；raw=1 已是直链形态则不动） ----
  if (DROPBOX_HOST_RE.test(host)) {
    const params = parsed.searchParams;
    const alreadyDirect = params.get("dl") === "1" || params.get("raw") === "1";
    if (alreadyDirect) {
      return {
        url,
        kind: "dropbox",
        downloadUrl: normalized,
        needsProtocolFix,
        needsDirectConversion: false,
        needsMigration: false,
      };
    }
    params.set("dl", "1");
    return {
      url,
      kind: "dropbox",
      downloadUrl: parsed.toString(),
      needsProtocolFix,
      needsDirectConversion: true,
      needsMigration: false,
    };
  }

  // ---- paste.ee / pastebin / gist：按各自的 raw 形式取（§6.4） ----
  if (PASTEE_HOST_RE.test(host)) {
    const match = /^\/(?:p|r)\/([A-Za-z0-9]+)(?:\/.*)?$/.exec(parsed.pathname);
    if (match === null) {
      return undescribable(url, "paste");
    }
    const isDirect = parsed.pathname.startsWith("/r/");
    const raw = new URL(normalized);
    raw.pathname = `/r/${match[1]}`;
    return {
      url,
      kind: "paste",
      downloadUrl: raw.toString(),
      needsProtocolFix,
      needsDirectConversion: !isDirect,
      needsMigration: false,
    };
  }
  if (PASTEBIN_HOST_RE.test(host)) {
    const segments = parsed.pathname.replace(/\/+$/, "").split("/").filter((s) => s !== "");
    if (segments.length === 1 && /^[A-Za-z0-9]{1,32}$/.test(segments[0]!) && !PASTEBIN_RESERVED_SEGMENTS.has(segments[0]!)) {
      const raw = new URL(normalized);
      raw.pathname = `/raw/${segments[0]}`;
      return {
        url,
        kind: "paste",
        downloadUrl: raw.toString(),
        needsProtocolFix,
        needsDirectConversion: true,
        needsMigration: false,
      };
    }
    if (segments.length === 2 && segments[0] === "raw" && /^[A-Za-z0-9]{1,32}$/.test(segments[1]!)) {
      // 已是 raw 形式
      return {
        url,
        kind: "paste",
        downloadUrl: normalized,
        needsProtocolFix,
        needsDirectConversion: false,
        needsMigration: false,
      };
    }
    return undescribable(url, "paste");
  }
  if (GIST_HOST_RE.test(host)) {
    const segments = parsed.pathname.replace(/\/+$/, "").split("/").filter((s) => s !== "");
    if (segments.length >= 2 && /^[A-Za-z0-9]+$/.test(segments[1]!)) {
      const raw = new URL("https://" + GIST_RAW_HOST);
      raw.pathname = `/${segments[0]}/${segments[1]}/raw`;
      return {
        url,
        kind: "paste",
        downloadUrl: raw.toString(),
        needsProtocolFix,
        needsDirectConversion: true,
        needsMigration: false,
      };
    }
    return undescribable(url, "paste");
  }
  if (host === GIST_RAW_HOST) {
    // 已是 gist raw 域：直链
    return {
      url,
      kind: "paste",
      downloadUrl: normalized,
      needsProtocolFix,
      needsDirectConversion: false,
      needsMigration: false,
    };
  }

  // ---- Imgur：只判活死，不改写（§6.4："失败则标记为死链"） ----
  if (IMGUR_HOST_RE.test(host)) {
    return {
      url,
      kind: "imgur",
      downloadUrl: normalized,
      needsProtocolFix,
      needsDirectConversion: false,
      needsMigration: false,
    };
  }

  // ---- 普通 HTTP(S) ----
  return {
    url,
    kind: "plain",
    downloadUrl: normalized,
    needsProtocolFix,
    needsDirectConversion: false,
    needsMigration: false,
  };
}

// ---------------------------------------------------------------------------
// 面向用户的标签（CLI 打印用；文案见 locales assets.fetch.*）
// ---------------------------------------------------------------------------

/** 四分类的面向用户文案 */
export function categoryLabel(category: AssetCategory): string {
  return t(`assets.fetch.category.${category}`);
}

/** 源类型的面向用户文案 */
export function kindLabel(kind: UrlKind): string {
  const camel = kind.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  return t(`assets.fetch.kind.${camel}`);
}

/** 修复动作的面向用户文案 */
export function fixActionLabel(action: FixAction): string {
  const camel = action.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  return t(`assets.fetch.fix.${camel}`);
}

/**
 * 不可下载形态的中文说明（manual 分类的 detail；migrate 的 skipped 原因复用）。
 * @param kind 源类型
 * @returns 中文说明
 */
export function manualReasonText(kind: UrlKind): string {
  switch (kind) {
    case "local-file":
      return t("assets.fetch.manualReason.localFile");
    case "lang-variant":
      return t("assets.fetch.manualReason.langVariant");
    case "gdrive":
      return t("assets.fetch.manualReason.gdriveNotFile");
    default:
      return t("assets.fetch.manualReason.unknownKind");
  }
}

// ---------------------------------------------------------------------------
// 健康报告
// ---------------------------------------------------------------------------

/** 2xx 判定 */
function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** 2xx 但 Content-Type 是网页：对 Google Drive 而言是"大文件病毒扫描确认页"，不是素材 */
function isGdriveInterstitial(kind: UrlKind, outcome: ProbeOutcome): boolean {
  return (
    kind === "gdrive" &&
    is2xx(outcome.status) &&
    (outcome.contentType ?? "").toLowerCase().includes("text/html")
  );
}

/** 由形态描述 + 探测结果得出单条健康记录（checkAssetHealth 的纯判定核心） */
function evaluateEntry(
  desc: UrlDescription,
  probe: ProbeFn,
): Promise<AssetHealthEntry> {
  const rewriteActions: FixAction[] = [];
  if (desc.needsProtocolFix) rewriteActions.push("add-protocol");
  if (desc.needsDirectConversion) rewriteActions.push("convert-direct");
  if (desc.needsMigration) rewriteActions.push("migrate-domain");

  if (desc.downloadUrl === undefined) {
    const entry: AssetHealthEntry = {
      url: desc.url,
      category: "manual",
      kind: desc.kind,
      fixActions: desc.kind === "local-file" ? ["reupload"] : ["manual-review"],
      detail: manualReasonText(desc.kind),
    };
    return Promise.resolve(entry);
  }

  return probe(desc.downloadUrl).then(async (primary) => {
    if (is2xx(primary.status) && !isGdriveInterstitial(desc.kind, primary)) {
      // 存活：有改写动作 → 可迁移；否则正常
      if (rewriteActions.length === 0) {
        const entry: AssetHealthEntry = {
          url: desc.url,
          category: "ok",
          kind: desc.kind,
          fixActions: [],
          status: primary.status,
        };
        return entry;
      }
      const entry: AssetHealthEntry = {
        url: desc.url,
        category: "migratable",
        kind: desc.kind,
        fixActions: [...rewriteActions],
        fixedUrl: desc.migratedUrl ?? desc.downloadUrl,
        status: primary.status,
      };
      return entry;
    }

    // 首选地址探不通：老 Steam Cloud 还有"迁移域名"这最后一根稻草（域名弃用是死链常见成因）
    if (desc.migratedUrl !== undefined) {
      const migrated = await probe(desc.migratedUrl);
      if (is2xx(migrated.status)) {
        return {
          url: desc.url,
          category: "migratable",
          kind: desc.kind,
          fixActions: [...rewriteActions],
          fixedUrl: desc.migratedUrl,
          status: migrated.status,
          detail: t("assets.fetch.migratedAlive", {
            reason: primary.error ?? t("assets.fetch.httpError", { status: primary.status }),
          }),
        };
      }
      // 两头都死：以"更 informative"的一侧为死因（优先迁移目标侧的响应/错误）
      const outcome = migrated.status !== 0 || migrated.error !== undefined ? migrated : primary;
      return {
        url: desc.url,
        category: "dead",
        kind: desc.kind,
        fixActions: ["reupload"],
        status: outcome.status,
        detail: outcome.error ?? t("assets.fetch.httpError", { status: outcome.status }),
      };
    }

    // Google Drive 确认页：改写已做、字节拿不到，需人工（浏览器确认 / 换图）
    if (isGdriveInterstitial(desc.kind, primary)) {
      return {
        url: desc.url,
        category: "manual",
        kind: desc.kind,
        fixActions: [...rewriteActions, "manual-review"],
        fixedUrl: desc.downloadUrl,
        status: primary.status,
        detail: t("assets.fetch.gdriveHtml"),
      };
    }

    return {
      url: desc.url,
      category: "dead",
      kind: desc.kind,
      fixActions: ["reupload"],
      status: primary.status,
      detail: primary.error ?? t("assets.fetch.httpError", { status: primary.status }),
    };
  });
}

/**
 * 并发生成"素材健康报告"（§6.4）：对一批 URL 去重后逐个 {@link describeUrl} +
 * 探测（默认 HEAD→GET 退化 + 手动跟随重定向，走代理），输出四分类与修复动作。
 *
 * 行为约定：
 * - 输入去重（同一 URL 只探测一次、只产出一条记录）；引用次数统计是 inventory 的职责；
 * - `entries` 按 URL 字典序（UTF-16 码元序）升序，结果可复现；
 * - 单个 URL 探测失败不中断整批，失败信息记录在 entry.detail / entry.status；
 * - file: / {lang} / 未知形态不发起网络请求，直接归入 manual；
 * - opts.probe 提供时完全替代默认网络实现（离线测试 / 上层自定义传输）。
 *
 * @param urls 待体检的 URL 列表
 * @param opts.concurrency 并发上限，默认 8
 * @param opts.timeoutMs 单请求超时毫秒数，默认 10000
 * @param opts.maxRedirects 重定向跟随上限，默认 5
 * @param opts.probe 自定义探测函数（默认走代理的真实探测）
 * @returns 健康报告（四类计数 + 逐 URL 记录）
 * @throws PackError（code="ASSETS_FETCH_INVALID"）urls 不是字符串数组，或 opts 字段非法时
 */
export async function checkAssetHealth(
  urls: readonly string[],
  opts: CheckHealthOptions = {},
): Promise<AssetHealthReport> {
  const parsedUrls = urlsSchema.safeParse(urls);
  if (!parsedUrls.success) {
    throw invalidFetch(formatZodError(parsedUrls.error));
  }
  const parsedOpts = checkHealthOptsSchema.safeParse(opts);
  if (!parsedOpts.success) {
    throw invalidFetch(formatZodError(parsedOpts.error));
  }

  const concurrency = parsedOpts.data.concurrency ?? DEFAULT_CONCURRENCY;
  const timeoutMs = parsedOpts.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = parsedOpts.data.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  // 去重（Set 保插入序，最终按码元序排序输出）
  const distinct = [...new Set(parsedUrls.data)];
  if (distinct.length === 0) {
    return { total: 0, ok: 0, migratable: 0, dead: 0, manual: 0, entries: [] };
  }

  const injectedProbe = parsedOpts.data.probe;
  const dispatcher = injectedProbe === undefined ? openProxyDispatcher() : undefined;
  try {
    const probe: ProbeFn =
      injectedProbe ??
      ((url: string) => defaultProbe(url, dispatcher, timeoutMs, maxRedirects));

    const entries = new Map<string, AssetHealthEntry>();
    await pLimit(distinct, concurrency, async (url) => {
      const desc = describeUrl(url);
      entries.set(url, await evaluateEntry(desc, probe));
    });

    const report: AssetHealthReport = {
      total: entries.size,
      ok: 0,
      migratable: 0,
      dead: 0,
      manual: 0,
      entries: [],
    };
    for (const entry of [...entries.values()].sort((a, b) => compareUrls(a.url, b.url))) {
      report.entries.push(entry);
      report[entry.category] += 1;
    }
    return report;
  } finally {
    await closeProxyDispatcher(dispatcher);
  }
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

/**
 * 下载单个素材的字节流：GET + 手动跟随重定向 + 可选大小上限。
 *
 * - 实际请求地址是 {@link describeUrl} 算出的 `downloadUrl`（分享链接自动转直链）；
 * - `file:` / {lang} / 未知形态不可下载 → 返回 ok:false（不抛错，批量调用方友好）；
 * - 超过 `opts.maxBytes` 时中断读取并返回 ok:false；
 * - 网络失败 / 非 2xx 都返回 ok:false，中文原因见 error 字段。
 *
 * @param url 素材 URL（存档原文即可，内部自动转直链）
 * @param opts.timeoutMs 单请求超时毫秒数，默认 10000
 * @param opts.maxBytes 响应体大小上限字节数（默认不限）
 * @param opts.maxRedirects 重定向跟随上限，默认 5
 * @param opts.dispatcher 复用的代理调度器（批量场景由调用方创建并统一关闭；
 *   缺省时自行创建代理并在结束时关闭）
 * @returns 成功：字节 + Content-Type + 最终 URL；失败：中文原因
 * @throws PackError（code="ASSETS_FETCH_INVALID"）url 不是非空字符串，或 opts 字段非法时
 */
export async function fetchAsset(
  url: string,
  opts: FetchAssetOptions = {},
): Promise<FetchOutcome> {
  if (typeof url !== "string" || url.trim() === "") {
    throw invalidFetch(
      t("error.assets.invalidUrl", { detail: `typeof url = ${typeof url}` }),
    );
  }
  const parsedOpts = fetchAssetOptsSchema.safeParse(opts);
  if (!parsedOpts.success) {
    throw invalidFetch(formatZodError(parsedOpts.error));
  }
  const timeoutMs = parsedOpts.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = parsedOpts.data.maxBytes;
  const maxRedirects = parsedOpts.data.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const desc = describeUrl(url);
  if (desc.downloadUrl === undefined) {
    return { ok: false, url, error: manualReasonText(desc.kind) };
  }

  // 调用方提供 dispatcher 时复用且不关闭（连接池归调用方管理）；否则自建自关
  const ownDispatcher = parsedOpts.data.dispatcher === undefined;
  const dispatcher = parsedOpts.data.dispatcher ?? openProxyDispatcher();
  try {
    let current = desc.downloadUrl;
    // 下载路径必须读取响应体；maxBytes 未设置时用 MAX_SAFE_INTEGER 表示"读全部、不限大小"
    const captureBytes = maxBytes ?? Number.MAX_SAFE_INTEGER;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const snapshot = await requestOnce(current, "GET", dispatcher, timeoutMs, captureBytes);
      if (REDIRECT_STATUSES.includes(snapshot.status)) {
        if (snapshot.location === undefined) {
          return { ok: false, url, status: snapshot.status, error: t("assets.fetch.httpError", { status: snapshot.status }) };
        }
        if (hop === maxRedirects) {
          return {
            ok: false,
            url,
            error: t("assets.fetch.netError.tooManyRedirects", { max: maxRedirects }),
          };
        }
        current = new URL(snapshot.location, current).toString();
        continue;
      }
      if (snapshot.status === 0) {
        // 未拿到响应：网络错误 / 超时 / 响应体超限（oversized 的 error 文案已在 snapshot 里）
        return { ok: false, url, error: snapshot.error ?? t("assets.fetch.netError.unknown", { message: "no response" }) };
      }
      if (!is2xx(snapshot.status)) {
        return { ok: false, url, status: snapshot.status, error: t("assets.fetch.httpError", { status: snapshot.status }) };
      }
      return {
        ok: true,
        url,
        finalUrl: current,
        status: snapshot.status,
        contentType: snapshot.contentType,
        data: snapshot.data ?? new Uint8Array(0),
      };
    }
    return {
      ok: false,
      url,
      error: t("assets.fetch.netError.tooManyRedirects", { max: maxRedirects }),
    };
  } finally {
    if (ownDispatcher) {
      await closeProxyDispatcher(dispatcher);
    }
  }
}

// ---------------------------------------------------------------------------
// 扩展名推断（§6.8 离线缓存文件名用）
// ---------------------------------------------------------------------------

/**
 * 从 URL 路径与 Content-Type 猜文件扩展名（不含点，小写）。
 *
 * 优先级：URL 路径扩展名（须在白名单内）→ Content-Type 映射 → 无法判断返回 undefined。
 * 调用方（离线预置）在两者都无结论时要求显式提供 ext，不做猜测。
 *
 * @param url 素材 URL
 * @param contentType 响应 Content-Type（可省略）
 * @returns 扩展名（如 "png"）；无法判断时 undefined
 * @throws PackError（code="ASSETS_FETCH_INVALID"）url 不是字符串时
 */
export function guessExtension(url: string, contentType?: string): string | undefined {
  if (typeof url !== "string") {
    throw invalidFetch(t("error.assets.invalidUrl", { detail: `typeof url = ${typeof url}` }));
  }
  try {
    const parsed = new URL(url);
    let pathname = parsed.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // 含未配对 % 等非法编码时退回原样
    }
    const match = /\.([A-Za-z0-9]{1,5})$/.exec(pathname);
    const ext = match?.[1]?.toLowerCase();
    if (ext !== undefined && KNOWN_EXTENSIONS.has(ext)) {
      return ext;
    }
  } catch {
    // URL 解析失败：跳过路径判断，继续看 Content-Type
  }
  if (typeof contentType === "string") {
    const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    const mapped = CONTENT_TYPE_EXTENSIONS[mime];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  return undefined;
}
