// src/assets/check.ts
/**
 * URL 存活检测：并发对一批 URL 发 HEAD 请求（必要时退化为 GET），以 HTTP 2xx 判定存活。
 *
 * 职责：
 * - 走 `process.env.https_proxy || process.env.HTTPS_PROXY`（若设置）的 HTTP 代理，用 undici ProxyAgent；
 * - 自实现轻量并发池（见 {@link pLimit}），不引入 p-limit 等额外依赖；
 * - 支持抽样检测（Fisher-Yates 洗牌后取前 N），用于大图包快速体检。
 *
 * 判定规则（与接口注释一致）：拿到响应且状态码 ∈ [200, 300) → `alive: true`；
 * 其余（3xx / 4xx / 5xx、超时、DNS / 连接错误）→ `alive: false`。
 * 注意：undici 的 request 默认不跟随重定向，因此 3xx 会被判为不存活。
 *
 * 探测顺序：先发 HEAD；服务器不支持 HEAD（405 / 501）或请求未拿到响应（超时、网络错误）时，
 * 退化为 GET 重试一次（GET 的响应体会被丢弃，只取状态码）。
 *
 * 超时：每个请求设 `AbortSignal.timeout(timeoutMs)`；另外再包一层
 * `timeoutMs + 1000ms` 的硬性竞速定时器兜底——实测走代理时 undici 的 CONNECT 挂起
 * 不响应 AbortSignal，只靠 signal 会让检测卡死（详见 {@link probeOnce}）。
 *
 * @throws urls 不是字符串数组，或 opts 字段类型 / 范围非法时抛出中文错误。
 *   单个 URL 的探测失败不抛错，而是记录为 `status: 0` / 非 2xx 的结果。
 */

import { ProxyAgent, request } from "undici";
import { z } from "zod";

import pkg from "../../package.json" with { type: "json" };

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 默认并发上限 */
const DEFAULT_CONCURRENCY = 8;

/** 默认单请求超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 10_000;

/** HEAD 不可用时退化重试的 HTTP 状态码（服务器不支持 HEAD） */
const HEAD_UNSUPPORTED_STATUSES: readonly number[] = [405, 501];

/** 请求 UA（部分 CDN 对空 UA 更苛刻；保持 ASCII，避免 header 编码问题） */
const USER_AGENT = `tts-toolkit/${pkg.version}`;

/**
 * 硬性超时相对 timeoutMs 的宽限（毫秒）。
 *
 * 实测（undici 7.30 + 代理）：走代理时 CONNECT 隧道阶段的挂起不会响应 AbortSignal，
 * 只靠 signal 会导致请求永不落定、整个检测卡死。因此每次请求再包一层竞速定时器兜底：
 * 到点即按"超时"返回，不再等待传输层。宽限让正常路径仍由 signal 先触发并保持精确的超时文案。
 */
const HARD_TIMEOUT_SLACK_MS = 1_000;

/** 批次结束时关闭 ProxyAgent 的上限（毫秒）；超时则改为强制 destroy，避免连接池拖住进程 */
const AGENT_CLOSE_TIMEOUT_MS = 2_000;

/**
 * 常见网络错误码 → 中文原因。
 * 未收录的错误码会回退为「请求失败：<原始信息>」，因此漏项不会丢诊断信息。
 */
const ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ENOTFOUND: "域名解析失败",
  EAI_AGAIN: "域名解析暂时失败",
  ECONNREFUSED: "连接被拒绝",
  ECONNRESET: "连接被重置",
  ETIMEDOUT: "连接超时",
  EHOSTUNREACH: "目标主机不可达",
  ENETUNREACH: "网络不可达",
  CERT_HAS_EXPIRED: "TLS 证书已过期",
  ERR_INVALID_URL: "URL 格式非法",
  UND_ERR_CONNECT_TIMEOUT: "建立连接超时",
  UND_ERR_HEADERS_TIMEOUT: "等待响应头超时",
  UND_ERR_BODY_TIMEOUT: "读取响应体超时",
  UND_ERR_SOCKET: "连接异常中断",
  UND_ERR_CLOSED: "连接已被关闭",
  UND_ERR_DESTROYED: "连接已被销毁",
  UND_ERR_PRX_TLS: "代理 TLS 握手失败",
  UND_ERR_RESPONSE: "响应异常",
});

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单个 URL 的检测结果 */
export interface CheckResult {
  /** URL */
  url: string;
  /** 是否存活（HTTP 2xx） */
  alive: boolean;
  /** HTTP 状态码（无响应时为 0） */
  status: number;
  /** 错误信息（无则省略） */
  error?: string;
}

/** 一批 URL 的检测汇总 */
export interface CheckSummary {
  total: number;
  alive: number;
  dead: number;
  deadUrls: CheckResult[];
  results: CheckResult[];
}

// ---------------------------------------------------------------------------
// zod 校验（运行时边界统一 unknown + zod，禁止 any）
// ---------------------------------------------------------------------------

/** checkUrls 入参 URL 列表结构 */
const urlsSchema = z.array(z.string({ error: "每个 URL 必须是字符串" }), {
  error: "urls 必须是字符串数组",
});

/** checkUrls 选项结构 */
const optsSchema = z.object(
  {
    concurrency: z
      .number({ error: "concurrency 必须是数字" })
      .int("concurrency 必须是整数")
      .min(1, "concurrency 必须 ≥ 1")
      .optional(),
    timeoutMs: z
      .number({ error: "timeoutMs 必须是数字" })
      .int("timeoutMs 必须是整数")
      .min(1, "timeoutMs 必须 ≥ 1")
      .optional(),
    sample: z
      .number({ error: "sample 必须是数字" })
      .int("sample 必须是整数")
      .min(1, "sample 必须 ≥ 1")
      .optional(),
  },
  { error: "opts 必须是键值对象" },
);

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 将 zod 校验错误格式化为单行中文可读描述。
 * @param error zod 校验错误对象
 * @returns 形如 "sample：sample 必须 ≥ 1" 的描述，多个问题以"；"连接
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

/**
 * 读取代理地址：优先小写 `https_proxy`，其次大写 `HTTPS_PROXY`（Windows 环境变量名大小写不敏感，两者等价）。
 * 仅在调用时读取，便于测试/CLI 临时覆盖；空字符串视作未设置。
 * @returns 代理地址（如 `http://127.0.0.1:7890`）；未设置时 undefined
 */
function resolveProxyUrl(): string | undefined {
  const raw = process.env.https_proxy?.trim() || process.env.HTTPS_PROXY?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * 从错误对象上取出错误码（Node 网络错误与 undici 错误都把码放在 `code` 字段）。
 * @param err 任意错误值
 * @returns 错误码字符串；取不到时 undefined
 */
function extractErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * 把请求异常转成中文描述（尽量给出可读原因，未知错误码回退为原始信息）。
 * @param err 请求抛出的异常（超时为 DOMException TimeoutError，网络错误为带 code 的 Error）
 * @param timeoutMs 本次请求的超时毫秒数（用于文案）
 * @returns 中文错误描述
 */
function describeRequestError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    // AbortSignal.timeout 触发时为 DOMException（name = "TimeoutError"）
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `请求超时（超过 ${timeoutMs}ms 无响应）`;
    }
    const code = extractErrorCode(err);
    if (code !== undefined) {
      const known = Object.prototype.hasOwnProperty.call(ERROR_CODE_MESSAGES, code)
        ? ERROR_CODE_MESSAGES[code]
        : undefined;
      return known !== undefined ? `${known}（${code}）` : `请求失败：${err.message}（${code}）`;
    }
    return `请求失败：${err.message}`;
  }
  return `请求失败：${String(err)}`;
}

/** 单次探测的原始结果 */
interface ProbeOutcome {
  /** HTTP 状态码；未拿到响应时为 0 */
  status: number;
  /** 未拿到响应时的中文错误描述 */
  error?: string;
}

/** 硬性超时兜底用的内部错误（用于与 undici 自身抛出的错误区分） */
class HardTimeoutError extends Error {
  constructor() {
    super("硬性超时");
    this.name = "HardTimeoutError";
  }
}

/**
 * 对单个 URL 发起一次请求（HEAD 或 GET），只关心状态码。
 *
 * 响应体必须消费（`body.dump()`）：undici 要求把 body 读完才会复用连接，
 * 否则高频检测会不断新建连接；HEAD 响应体为空，dump 立即完成。
 *
 * 超时是双保险：
 * 1. `AbortSignal.timeout(timeoutMs)` —— 正常路径，能精确中断直连请求；
 * 2. 竞速定时器 `timeoutMs + HARD_TIMEOUT_SLACK_MS` —— 兜底代理 CONNECT 挂起等
 *    signal 不生效的场景（实测），保证任何情况下都会落定。
 *
 * @param url 目标 URL
 * @param method "HEAD" 或 "GET"
 * @param dispatcher 代理调度器；undefined 时用 undici 默认调度器
 * @param timeoutMs 单请求超时毫秒数
 * @returns 状态码，或未拿到响应时的中文错误描述；本函数不抛错
 */
async function probeOnce(
  url: string,
  method: "HEAD" | "GET",
  dispatcher: ProxyAgent | undefined,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const hardTimeoutMs = timeoutMs + HARD_TIMEOUT_SLACK_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    const attempt = (async (): Promise<number> => {
      const res = await request(url, {
        method,
        dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": USER_AGENT },
      });
      await res.body.dump();
      return res.statusCode;
    })();
    // 兜底定时器胜出后，attempt 仍可能稍后 reject（超时被放弃的请求），提前挂 catch 防止 unhandled rejection
    attempt.catch(() => {});

    const hardTimeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new HardTimeoutError());
      }, hardTimeoutMs);
    });

    const status = await Promise.race([attempt, hardTimeout]);
    return { status };
  } catch (err) {
    if (err instanceof HardTimeoutError) {
      return { status: 0, error: `请求超时（超过 ${timeoutMs}ms 无响应）` };
    }
    return { status: 0, error: describeRequestError(err, timeoutMs) };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * 检测单个 URL：先 HEAD，必要时退化为 GET。
 * @param url 目标 URL
 * @param dispatcher 代理调度器；undefined 时用 undici 默认调度器
 * @param timeoutMs 单请求超时毫秒数
 * @returns 检测结果；`error` 仅在完全没拿到 HTTP 响应（超时 / 网络错误）时填写
 */
async function checkOne(
  url: string,
  dispatcher: ProxyAgent | undefined,
  timeoutMs: number,
): Promise<CheckResult> {
  const head = await probeOnce(url, "HEAD", dispatcher, timeoutMs);
  const needFallback =
    HEAD_UNSUPPORTED_STATUSES.includes(head.status) || head.status === 0;
  const outcome = needFallback ? await probeOnce(url, "GET", dispatcher, timeoutMs) : head;

  const result: CheckResult = {
    url,
    alive: outcome.status >= 200 && outcome.status < 300,
    status: outcome.status,
  };
  if (outcome.error !== undefined) {
    result.error = outcome.error;
  }
  return result;
}

/**
 * 简单并发池：用 `concurrency` 个协程消费同一个队列，逐个调用 `fn`。
 *
 * 之所以自实现而不引入 p-limit：需求只有"限流 + 全部完成"，几十行足够，
 * 且 `queue.shift()` 在 JS 单线程下是原子的（协程只在 await 处让出），无需锁。
 *
 * @param items 待处理项（本函数不改动入参数组，内部复制队列）
 * @param concurrency 并发上限
 * @param fn 处理函数；抛错会导致整体 reject（调用方需自行决定是否吞错）
 * @returns 全部处理完成的 Promise
 */
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

/**
 * Fisher-Yates 洗牌抽样：返回 urls 的一个随机子集（不改动入参数组）。
 * @param urls 候选 URL 列表
 * @param n 取样数量（要求 1 ≤ n ≤ urls.length）
 * @returns 洗牌后的前 n 个 URL（新数组）
 */
function sampleUrls(urls: readonly string[], n: number): string[] {
  const copy = [...urls];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy.slice(0, n);
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 并发检测一批 URL 的存活状态（HTTP 2xx 视为存活）。
 *
 * 代理：设置了 `https_proxy`（或 `HTTPS_PROXY`）时，全部请求经 undici {@link ProxyAgent} 转发；
 * 否则走 undici 默认调度器（直连）。ProxyAgent 在整个批次内复用，结束时关闭。
 *
 * 抽样：`opts.sample` 提供且小于 `urls.length` 时，先 Fisher-Yates 洗牌再取前 N 个；
 * 未提供或大于等于总数时检测全部。重复 URL 会被重复检测（不做去重，保持结果与输入可对应）。
 *
 * @param urls 待检测 URL 列表
 * @param opts.concurrency 并发上限，默认 8（须 ≥ 1）
 * @param opts.timeoutMs 单请求超时毫秒数，默认 10000（须 ≥ 1）；
 *   实际最坏等待为 `timeoutMs + 1000ms`（硬性兜底），HEAD 与 GET 各一次
 * @param opts.sample 抽样数量（默认全部，须 ≥ 1）
 * @returns 汇总：total / alive / dead / deadUrls / results；
 *   results 顺序与"实际检测顺序"一致（抽样时即洗牌后的顺序），单条失败不中断整批
 * @throws Error urls 不是字符串数组，或 opts 字段类型 / 范围非法时（中文错误）
 */
export async function checkUrls(
  urls: string[],
  opts?: { concurrency?: number; timeoutMs?: number; sample?: number },
): Promise<CheckSummary> {
  const parsedUrls = urlsSchema.safeParse(urls);
  if (!parsedUrls.success) {
    throw new Error(`checkUrls 入参无效（${formatZodError(parsedUrls.error)}）`);
  }
  const parsedOpts = optsSchema.safeParse(opts ?? {});
  if (!parsedOpts.success) {
    throw new Error(`checkUrls 入参无效（${formatZodError(parsedOpts.error)}）`);
  }

  const concurrency = parsedOpts.data.concurrency ?? DEFAULT_CONCURRENCY;
  const timeoutMs = parsedOpts.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sample = parsedOpts.data.sample;

  const all = parsedUrls.data;
  const targets = sample !== undefined && sample < all.length ? sampleUrls(all, sample) : all;

  const empty: CheckSummary = { total: 0, alive: 0, dead: 0, deadUrls: [], results: [] };
  if (targets.length === 0) {
    return empty;
  }

  // 代理只创建一次，整批复用连接池；异常的代理地址在首次请求时表现为单条结果错误
  const proxyUrl = resolveProxyUrl();
  const dispatcher = proxyUrl !== undefined ? new ProxyAgent(proxyUrl) : undefined;

  try {
    // 预分配结果数组：探测顺序由并发池决定，但结果按 targets 下标回填，保证顺序确定
    const results = new Array<CheckResult>(targets.length);
    const indices = targets.map((_, index) => index);
    await pLimit(indices, concurrency, async (index) => {
      const url = targets[index];
      if (url !== undefined) {
        results[index] = await checkOne(url, dispatcher, timeoutMs);
      }
    });

    const summary: CheckSummary = {
      total: results.length,
      alive: 0,
      dead: 0,
      deadUrls: [],
      results,
    };
    for (const result of results) {
      if (result.alive) {
        summary.alive += 1;
      } else {
        summary.dead += 1;
        summary.deadUrls.push(result);
      }
    }
    return summary;
  } finally {
    // 关闭代理连接池，否则存活的 keep-alive 连接会让进程迟迟不退出。
    // 极端情况（代理握手挂起）下 close() 会一直等待，故加上限并回退 destroy()，保证 checkUrls 必定返回。
    if (dispatcher !== undefined) {
      await Promise.race([
        dispatcher.close().catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, AGENT_CLOSE_TIMEOUT_MS).unref();
        }),
      ]);
      await dispatcher.destroy().catch(() => undefined);
    }
  }
}
