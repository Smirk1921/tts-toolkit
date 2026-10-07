// src/archive/detect.ts
/**
 * 素材扩展名推导：三级兜底（方案设计 §12.4，`.ttsmod` 打包的最大实现难点）。
 *
 * 背景：原工具靠运行时调 TTS 的 `CustomCache.ConvertURL` 系列函数拿扩展名；
 * 我们不依赖游戏程序集，必须自己推导。**实测本机 mods.cache 里 36,184 条素材
 * 记录中有 16,714 条（46%）没有扩展名，其中大部分是 Image 类型**——推导失败
 * 是常态不是异常。
 *
 * 三级兜底（按序尝试，命中即返回）：
 * 1. **原始 URL 路径里的扩展名**（`.../dial.jpg` → `jpg`；须在本模块白名单内，
 *    避免把 `?x.y` 之类噪声当扩展名）；
 * 2. **本地缓存目录里已有的同名文件**（TTS 下载时已经算好了名字：缓存目录里
 *    找 `sanitize(url).*`，命中文件的扩展名就是答案）；
 * 3. **HTTP `Content-Type` 响应头**（最可靠但需要联网；探测函数可注入以便离线
 *    单测，默认实现走 undici，约定与 src/assets/check.ts / fetch.ts 一致）。
 *
 * 另有一类**固定扩展名**素材（TTS 缓存约定，与 URL 无关，无需推导）：
 * - 模型   → `obj`（TTS 的 `ConvertModelURL` 无条件追加 `.obj`，实测样本
 *   `...dial12000MSHobj.obj`——URL 本身以 `.obj` 结尾也照样再追加）；
 * - 资源包 → `unity3d`（同理无条件追加）；
 * - PDF    → `PDF`（原工具 `ConvertURL(Url) + ".PDF"`，大写是实测约定）。
 *
 * **三级都失败时绝不静默跳过**：{@link detectExtensions} 把失败的条目原样列进
 * 返回值的 `unresolved`，并提供 {@link detectWarnings} 生成 t() 告警文案——
 * 原工具就是静默跳过，导致接收方拿到包才知道缺素材（§12.4 明确要求告警并列出）。
 *
 * 网络（默认探测实现 {@link httpProbeContentType}，与 src/assets/check.ts 同一套约定）：
 * - 仅 http(s) URL 会联网；`file:` 等其他形态直接返回 undefined；
 * - 走 `process.env.https_proxy || process.HTTPS_PROXY` 的代理（undici ProxyAgent）；
 * - 手动跟随重定向（301/302/303/307/308，上限 5 跳）；
 * - HEAD 不支持（405/501）时退化 GET（丢弃响应体，只取 Content-Type）；
 * - 超时双保险：AbortSignal.timeout + 竞速兜底定时器（代理 CONNECT 挂起不响应
 *   signal，实测见 check.ts 同款注释）。
 *
 * 错误：本模块自身不抛业务错误（单个 URL 探测失败记入结果，不中断批量）；
 * 入参非法由 TypeScript 类型约束排除。
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

import { ProxyAgent, request } from "undici";

import pkg from "../../package.json" with { type: "json" };
import { t } from "../i18n/index.js";
import { sanitizeUrl } from "./cachekey.js";

// ---------------------------------------------------------------------------
// 素材类型
// ---------------------------------------------------------------------------

/** `.ttsmod` 支持的素材类型（§12.2 条目布局；Audio 是原工具盲区，本工具新增） */
export type AssetKind = "image" | "model" | "assetbundle" | "pdf" | "audio";

/** 全部素材类型（固定次序，供排序与遍历） */
export const ASSET_KINDS: readonly AssetKind[] = ["image", "model", "assetbundle", "pdf", "audio"];

/**
 * 固定扩展名的素材类型 → 扩展名（不带点；PDF 按实测约定保留大写）。
 * 这些类型的缓存文件名与 URL 扩展名无关，不需要三级推导。
 */
export const FIXED_EXTENSIONS: Readonly<Partial<Record<AssetKind, string>>> = Object.freeze({
  model: "obj",
  assetbundle: "unity3d",
  pdf: "PDF",
});

/** 类型中文名（告警 / 清单文案用，走 t()） */
function kindLabel(kind: AssetKind): string {
  return t(`archive.kind.${kind}`);
}

// ---------------------------------------------------------------------------
// 三级兜底的判定数据
// ---------------------------------------------------------------------------

/**
 * 三级兜底第 1 级认可的 URL 路径扩展名白名单（小写，不含点）。
 * 只覆盖 image / audio 两类需要推导的类型；不在名单内的路径扩展名不采信
 * （避免把查询串噪声当扩展名），继续走下一级。
 */
const URL_EXTENSION_WHITELIST: Readonly<Record<"image" | "audio", ReadonlySet<string>>> =
  Object.freeze({
    image: new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tga"]),
    audio: new Set(["mp3", "ogg", "wav"]),
  });

/**
 * Content-Type（去掉参数、小写）→ 扩展名（三级兜底第 3 级）。
 * 与 src/assets/fetch.ts 的 CONTENT_TYPE_EXTENSIONS 对齐（同一份实测映射），
 * 覆盖本模块关心的 image / audio 两类。
 */
const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tga": "tga",
  "image/x-tga": "tga",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
});

/** 缓存目录命中多个同名（不同扩展名）文件时的优先序（小写，不含点） */
const CACHE_EXTENSION_PRIORITY: readonly string[] = [
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "tga", "mp3", "ogg", "wav",
];

// ---------------------------------------------------------------------------
// 缓存目录索引（第 2 级的数据结构）
// ---------------------------------------------------------------------------

/** 一个缓存目录的索引：`sanitize(url)`（小写）→ 命中文件（绝对路径 + 扩展名） */
export interface CacheIndex {
  /** 被扫描的目录（绝对路径，原样保留） */
  dir: string;
  /** `sanitize(url).toLowerCase()` → 命中文件（每个键只保留一个最优命中） */
  byBase: Map<string, { file: string; ext: string | undefined }>;
}

/**
 * 扫描一个 TTS 缓存目录（如 `<Mods>/Images`），建 `sanitize(url) → 文件` 索引。
 *
 * 命中规则：文件名（大小写不敏感）匹配 `<base>.<扩展名>`，base 为 URL 的缓存键。
 * 目录不存在 / 读取失败时返回空索引（缓存目录本就可能缺，不算错误）。
 * 同一 base 命中多个扩展名时按 {@link CACHE_EXTENSION_PRIORITY} 挑优，
 * 优先序并列时取文件名字典序最小（保证结果确定）。
 *
 * @param dir 缓存目录（绝对 / 相对路径均可，readdir 原样解释）
 * @returns 缓存目录索引（dir 为 resolve 后的绝对路径）
 */
export async function scanCacheDir(dir: string): Promise<CacheIndex> {
  const index: CacheIndex = { dir: path.resolve(dir), byBase: new Map() };
  let names: string[];
  try {
    names = await readdir(index.dir);
  } catch {
    return index;
  }
  for (const name of names) {
    const dot = name.lastIndexOf(".");
    if (dot <= 0) {
      continue; // 无扩展名 / 隐藏文件（".png" 之类不算命中）
    }
    const base = name.slice(0, dot).toLowerCase();
    const ext = name.slice(dot + 1);
    if (!/^[A-Za-z0-9]+$/.test(ext)) {
      continue; // 扩展名只认字母数字
    }
    const existing = index.byBase.get(base);
    if (existing === undefined || cacheExtBetter(ext, existing.ext)) {
      index.byBase.set(base, { file: path.join(index.dir, name), ext: ext.toLowerCase() });
    }
  }
  return index;
}

/** 两个候选扩展名谁更优：优先序表靠前者优；都不在表内（或并列）取字典序小者 */
function cacheExtBetter(candidate: string, incumbent: string | undefined): boolean {
  if (incumbent === undefined) {
    return true;
  }
  const candRank = CACHE_EXTENSION_PRIORITY.indexOf(candidate.toLowerCase());
  const incRank = CACHE_EXTENSION_PRIORITY.indexOf(incumbent.toLowerCase());
  if (candRank !== incRank) {
    return candRank !== -1 && (incRank === -1 || candRank < incRank);
  }
  return candidate.toLowerCase() < incumbent.toLowerCase();
}

// ---------------------------------------------------------------------------
// 扩展名推导
// ---------------------------------------------------------------------------

/** 扩展名来源（机器码；`undefined` 表示三级全部未命中） */
export type ExtSource = "fixed" | "url-path" | "cache-dir" | "content-type";

/** 单条 URL 的扩展名推导结果 */
export interface ExtensionDecision {
  /** 原始 URL（存档 JSON 中的原文） */
  url: string;
  /** 素材类型 */
  kind: AssetKind;
  /** 推导出的扩展名（不含点；固定类型为 `obj` / `unity3d` / `PDF`）；未命中时缺省 */
  ext?: string;
  /** 扩展名来源；三级全部未命中时缺省 */
  source?: ExtSource;
  /** 来源为 cache-dir 时命中的缓存文件（绝对路径；其余来源缺省） */
  cacheFile?: string;
}

/** 批量推导的入参条目（同一 URL 引用多次时去重由 detectExtensions 处理） */
export interface DetectEntry {
  /** 原始 URL（存档 JSON 中的原文） */
  url: string;
  /** 素材类型 */
  kind: AssetKind;
}

/** 批量推导选项 */
export interface DetectOptions {
  /**
   * 各素材类型的本地缓存目录（三级兜底第 2 级），如
   * `{ image: "C:/.../Mods/Images", audio: "C:/.../Mods/Audio" }`。
   * 目录不存在时安全跳过；不给则跳过第 2 级。
   */
  cacheDirs?: Partial<Record<AssetKind, string>>;
  /** 预建好的缓存目录索引（与 cacheDirs 二选一；给了则不再扫目录） */
  cacheIndexes?: readonly CacheIndex[];
  /** 注入的 Content-Type 探测函数（第 3 级；不给则用默认 HTTP 探测） */
  probe?: (url: string) => Promise<string | undefined>;
  /** 默认 HTTP 探测的单请求超时（毫秒），默认 10_000 */
  probeTimeoutMs?: number;
  /** 批量推导的并发上限，默认 8 */
  concurrency?: number;
}

/** 批量推导结果 */
export interface ExtensionReport {
  /** 全部去重条目的推导结果（按 kind 固定次序 + URL UTF-16 码元序排序，可复现） */
  decisions: ExtensionDecision[];
  /** 三级全部未命中的子集（ext 为 undefined；**调用方必须告警并列出**） */
  unresolved: ExtensionDecision[];
}

/** Content-Type → 扩展名（不带点、小写）；未收录返回 undefined */
function extFromContentType(contentType: string): string | undefined {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return CONTENT_TYPE_EXTENSIONS[mime];
}

/** 三级兜底第 1 级：URL 路径扩展名（须在白名单内；`file:` 路径同样适用） */
function extFromUrlPath(url: string, kind: "image" | "audio"): string | undefined {
  let pathname: string | undefined;
  try {
    pathname = new URL(url).pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // 含未配对 % 等非法编码时退回原样
    }
  } catch {
    return undefined; // URL 解析失败：第 1 级不采信
  }
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(pathname);
  const ext = match?.[1]?.toLowerCase();
  if (ext !== undefined && URL_EXTENSION_WHITELIST[kind].has(ext)) {
    return ext;
  }
  return undefined;
}

/**
 * 三级兜底第 3 级的默认实现：HTTP 探测 Content-Type（HEAD → 405/501 退化 GET）。
 * 仅 http(s) URL 联网；其余（`file:` 等）直接返回 undefined。
 * 探测失败（网络错误 / 超时 / 非 2xx）一律返回 undefined，不抛错。
 */
export async function httpProbeContentType(
  url: string,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }

  const proxy = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.https_PROXY;
  const dispatcher = proxy !== undefined ? new ProxyAgent(proxy) : undefined;
  // 超时双保险：AbortSignal.timeout + 竞速兜底定时器（代理 CONNECT 挂起不响应 signal）
  const controller = new AbortController();
  const hardTimer = setTimeout(() => controller.abort(), timeoutMs + 1_000);
  try {
    let current = url;
    for (let hop = 0; hop <= 5; hop++) {
      let method: "HEAD" | "GET" = "HEAD";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await request(current, {
            method,
            signal: controller.signal,
            dispatcher,
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
            headers: { "user-agent": `tts-toolkit/${pkg.version}` },
          });
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            const location = res.headers.location;
            res.body.dump().catch(() => {});
            if (typeof location !== "string" || hop === 5) {
              return undefined;
            }
            current = new URL(location, current).toString();
            break;
          }
          if ([405, 501].includes(res.statusCode) && method === "HEAD") {
            res.body.dump().catch(() => {});
            method = "GET"; // HEAD 不支持，退化 GET 重试一次
            continue;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.body.dump().catch(() => {});
            return undefined;
          }
          const contentType = res.headers["content-type"];
          res.body.dump().catch(() => {});
          return Array.isArray(contentType) ? contentType[0] : contentType;
        } catch {
          return undefined; // 网络错误 / 超时：单个 URL 的失败不抛错
        }
      }
    }
    return undefined;
  } finally {
    clearTimeout(hardTimer);
    if (dispatcher !== undefined) {
      // 与 fetch.ts 同款上限：关闭代理连接池最多等 2 秒，超时不阻塞调用方
      await Promise.race([
        dispatcher.close().catch(() => {}),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 2_000).unref();
        }),
      ]);
    }
  }
}

/**
 * 推导单条素材的扩展名（三级兜底；固定扩展名类型直接短路返回）。
 * 见模块头注释的三级定义；`cacheIndexes` 提供时不再扫目录。
 *
 * @param url 原始 URL
 * @param kind 素材类型
 * @param opts 推导选项（全部可省略）
 * @returns 推导结果（ext / source 缺省表示三级全部未命中）
 */
export async function detectExtension(
  url: string,
  kind: AssetKind,
  opts: DetectOptions = {},
): Promise<ExtensionDecision> {
  const report = await detectExtensions([{ url, kind }], opts);
  return report.decisions[0]!;
}

/**
 * 批量推导扩展名（三级兜底 + 去重 + 并发探测）。
 *
 * 行为：
 * - 按 `kind|url` 去重（同一素材被引用多次只推导一次）；
 * - 固定扩展名类型（model / assetbundle / pdf）直接短路，不查缓存不联网；
 * - 第 2 级每个不同目录只 readdir 一次（千级素材时避免重复扫盘）；
 * - 第 3 级并发探测（上限 opts.concurrency，默认 8），单个失败记 undefined 不中断；
 * - **三级全部未命中的条目进 `unresolved`**——调用方必须告警并列出（§12.4），
 *   绝不静默跳过；
 * - 结果排序：kind 固定次序 + URL UTF-16 码元序（跨机器可复现，便于 diff）。
 *
 * @param entries 待推导条目（url / kind）
 * @param opts 推导选项（全部可省略）
 * @returns 批量推导结果
 */
export async function detectExtensions(
  entries: readonly DetectEntry[],
  opts: DetectOptions = {},
): Promise<ExtensionReport> {
  // —— 入参防御：kind 来自运行时（CLI / 外部 JSON）时可能越界，给出明确中文错误 ——
  const kinds = new Set<string>(ASSET_KINDS);
  for (const entry of entries) {
    if (typeof entry?.url !== "string" || !kinds.has(entry.kind)) {
      throw new Error(
        `detectExtensions 入参无效：每条必须是 { url: 非空字符串, kind: ${ASSET_KINDS.join(" / ")} 之一 }（收到 ${JSON.stringify(entry)}）`,
      );
    }
  }

  // —— 去重（保持首见次序，末尾统一排序）——
  const seen = new Map<string, DetectEntry>();
  for (const entry of entries) {
    const key = `${entry.kind}|${entry.url}`;
    if (!seen.has(key)) {
      seen.set(key, entry);
    }
  }

  // —— 缓存目录索引：预建的直接用；给目录的每个不同目录只扫一次 ——
  const indexes = new Map<string, CacheIndex>();
  if (opts.cacheIndexes !== undefined) {
    for (const index of opts.cacheIndexes) {
      indexes.set(index.dir, index);
    }
  } else if (opts.cacheDirs !== undefined) {
    for (const dir of Object.values(opts.cacheDirs)) {
      if (dir !== undefined && !indexes.has(path.resolve(dir))) {
        indexes.set(path.resolve(dir), await scanCacheDir(dir));
      }
    }
  }
  const indexForKind = (kind: AssetKind): CacheIndex | undefined => {
    const dir = opts.cacheDirs?.[kind];
    if (dir === undefined) {
      return undefined;
    }
    return indexes.get(path.resolve(dir));
  };

  // —— 逐条推导（网络探测按并发上限执行）——
  const probe = opts.probe ?? ((url: string) => httpProbeContentType(url, opts.probeTimeoutMs));
  const limit = Math.max(1, opts.concurrency ?? 8);
  const keyed = [...seen.entries()];
  const results = new Map<string, ExtensionDecision>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, keyed.length) }, async () => {
    while (cursor < keyed.length) {
      const [key, entry] = keyed[cursor]!;
      cursor += 1;
      results.set(key, await resolveOne(entry, probe, indexForKind(entry.kind)));
    }
  });
  await Promise.all(workers);

  // —— 固定次序 + 码元序排序（可复现）——
  const kindOrder = new Map(ASSET_KINDS.map((kind, i) => [kind, i]));
  const decisions = [...results.values()].sort((a, b) => {
    const ka = kindOrder.get(a.kind)!;
    const kb = kindOrder.get(b.kind)!;
    if (ka !== kb) {
      return ka - kb;
    }
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
  return {
    decisions,
    unresolved: decisions.filter((d) => d.ext === undefined),
  };
}

/** 推导单条（dedup 后）：三级兜底的完整实现 */
async function resolveOne(
  entry: DetectEntry,
  probe: (url: string) => Promise<string | undefined>,
  index: CacheIndex | undefined,
): Promise<ExtensionDecision> {
  const decision: ExtensionDecision = { url: entry.url, kind: entry.kind };

  // 固定扩展名：TTS 缓存约定，与 URL 无关，直接短路
  const fixed = FIXED_EXTENSIONS[entry.kind];
  if (fixed !== undefined) {
    decision.ext = fixed;
    decision.source = "fixed";
    return decision;
  }

  const kind = entry.kind as "image" | "audio";

  // 第 1 级：URL 路径扩展名（白名单内）
  const fromUrl = extFromUrlPath(entry.url, kind);
  if (fromUrl !== undefined) {
    decision.ext = fromUrl;
    decision.source = "url-path";
    return decision;
  }

  // 第 2 级：本地缓存目录已有文件（TTS 下载时已算好名字）
  const hit = index?.byBase.get(sanitizeUrl(entry.url).toLowerCase());
  if (hit !== undefined) {
    decision.ext = hit.ext;
    decision.source = "cache-dir";
    decision.cacheFile = hit.file;
    return decision;
  }

  // 第 3 级：HTTP Content-Type（联网；失败记 undefined，不抛错）
  let contentType: string | undefined;
  try {
    contentType = await probe(entry.url);
  } catch {
    contentType = undefined;
  }
  if (contentType !== undefined) {
    const ext = extFromContentType(contentType);
    if (ext !== undefined) {
      decision.ext = ext;
      decision.source = "content-type";
      return decision;
    }
  }

  return decision; // 三级全部未命中：ext / source 缺省，进 unresolved
}

// ---------------------------------------------------------------------------
// 告警文案（§12.4：三级都失败时告警并列出，绝不静默跳过）
// ---------------------------------------------------------------------------

/**
 * 把批量推导结果里的未命中条目格式化为用户可见告警（t() 文案数组）：
 * 首行为汇总（条数），其余逐条列出 `[{类型中文名}] {url}`。
 * 无未命中条目时返回空数组（调用方免判断）。
 *
 * @param report 批量推导结果
 * @returns 告警文案（已按当前语言翻译；空数组表示无告警）
 */
export function detectWarnings(report: ExtensionReport): string[] {
  if (report.unresolved.length === 0) {
    return [];
  }
  const lines = [t("archive.detect.unresolvedSummary", { count: report.unresolved.length })];
  for (const item of report.unresolved) {
    lines.push(t("archive.detect.unresolvedItem", { url: item.url, kind: kindLabel(item.kind) }));
  }
  return lines;
}
