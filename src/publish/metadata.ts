// src/publish/metadata.ts
/**
 * 工坊条目元数据读取：Steam Web API 免 key 端点 GetPublishedFileDetails。
 *
 * 所属：窗口 G · 阶段 7（发布链路）；本文件由 B3 产出。
 * 参考：`参考资料/05-工坊发布/上传方式与SteamAPI.md` §2.1（【实测】2026-10-03 直接调用）。
 *
 * 端点（免 key：本端点实测**不需要** Steam Web API key；需要 key 的是
 * IPublishedFileService/GetDetails 等端点，本模块不用）：
 *
 *   POST https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/
 *   Content-Type: application/x-www-form-urlencoded
 *   body: itemcount=1&publishedfileids[0]=<itemId>
 *
 * 结果码（§2.1 实测）：`result: 1` = 正常；`result: 9` = 条目私有/无权限。
 *
 * 职责：
 * - {@link fetchPublishedFileDetails}：按 itemId 拉取单个工坊条目的公开元数据。
 *   只保留我们用到的字段子集（{@link PublishedFileDetails}），缺失字段补默认值
 *   （subscriptions=0 等），数字/字符串互窜的字段按声明类型归一化；
 * - {@link checkItemUpdated}：基于 `time_updated` 判断条目是否在上次 build 后被
 *   更新过（发布链路用来提醒"远端比本地新"）。
 *
 * 网络：统一走 `undici.fetch`（项目约定，不用全局 fetch）；超时用
 * `AbortSignal.timeout`（默认 10s，`opts.timeoutMs` 可覆盖）。
 *
 * 错误码（{@link PackError} 的 code，本模块新增；locales 两套键由 Stage C 补齐）：
 * - "PUBLISH_API_ERROR"      Steam API 返回非 200、响应体非 JSON、result 不是 1/9、
 *                            或 result=1 却没有条目详情
 * - "PUBLISH_ITEM_PRIVATE"   条目私有/无权限（result === 9）
 * - "PUBLISH_NETWORK_ERROR"  网络层错误（DNS 解析失败 / 超时 / 连接失败等 fetch 拒绝），
 *                            原始错误挂在 `error.cause` 上
 *
 * 本模块新增的 i18n 键（locales/*.json 由 Stage C 补齐；缺键时 t() 原样输出键名）：
 * - `error.publish.networkError` {itemId} {detail}
 * - `error.publish.apiStatus`    {status}
 * - `error.publish.apiBody`      {status} {detail}
 * - `error.publish.apiResult`    {result}
 * - `error.publish.itemPrivate`  {itemId}
 * - `error.publish.detailsEmpty` {itemId}
 */

import { fetch } from "undici";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** GetPublishedFileDetails v1 端点（§2.1 实测免 key） */
const PUBLISH_METADATA_ENDPOINT =
  "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";

/** 默认单请求超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Steam API 正常结果码 */
const RESULT_OK = 1;

/** Steam API "条目私有/无权限"结果码（§2.1 实测） */
const RESULT_PRIVATE = 9;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** GetPublishedFileDetails 免 key 返回（字段子集，只保留我们用到的） */
export interface PublishedFileDetails {
  publishedfileid: string;
  creator: string;
  creator_app_id: number;
  consumer_app_id: number;
  filename: string;
  file_size: string;
  file_url: string;
  preview_url?: string;
  title: string;
  description: string;
  time_created: number;
  time_updated: number;
  visibility: number;
  banned: number;
  ban_reason: string;
  subscriptions: number;
  favorited: number;
  lifetime_subscriptions: number;
  tags?: Array<{ tag: string }>;
}

/** {@link fetchPublishedFileDetails} 参数 */
export interface FetchMetadataOptions {
  /** 工坊条目 ID */
  itemId: string | number;
  /** 超时（毫秒，默认 10000） */
  timeoutMs?: number;
}

/** {@link checkItemUpdated} 参数 */
export interface CheckItemUpdatedOptions {
  /** 工坊条目 ID */
  itemId: string | number;
  /** 上次 build 的时间戳（秒；缺省视为"不知道上次时间"，直接返回 updated: true） */
  sinceTimestamp?: number;
  /** 超时（毫秒，默认 10000；透传给 fetchPublishedFileDetails） */
  timeoutMs?: number;
}

/** {@link checkItemUpdated} 返回 */
export interface CheckItemUpdatedResult {
  /** 条目是否在 sinceTimestamp 之后被更新过 */
  updated: boolean;
  /** 条目当前 time_updated（秒） */
  timeUpdated: number;
  /** 完整元数据 */
  details: PublishedFileDetails;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 归一化为 string：API 给 number / string 都收，缺失给默认值 */
function asString(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

/** 归一化为 number：API 给 number / 数字字符串都收（§2.1 实测 file_size 是字符串），缺失给 0 */
function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

/**
 * 把 API 返回的原始条目对象归一化为 {@link PublishedFileDetails}。
 *
 * §2.1 实测字段类型并不严格（file_size 是字符串、subscriptions 是数字，不同条目可能互窜），
 * 这里按接口声明统一：数字字段收 number/数字字符串，字符串字段收 string/number，
 * 缺失字段给默认值（subscriptions=0、ban_reason=""、time_updated=0 等）。
 */
function normalizeDetails(raw: Record<string, unknown>, itemId: string): PublishedFileDetails {
  const tagsRaw = raw.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw
        .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
        .map((entry) => ({ tag: asString(entry.tag, "") }))
    : undefined;
  const previewUrl = asString(raw.preview_url, "");
  return {
    publishedfileid: asString(raw.publishedfileid, itemId),
    creator: asString(raw.creator, ""),
    creator_app_id: asNumber(raw.creator_app_id),
    consumer_app_id: asNumber(raw.consumer_app_id),
    filename: asString(raw.filename, ""),
    file_size: asString(raw.file_size, "0"),
    file_url: asString(raw.file_url, ""),
    ...(previewUrl !== "" ? { preview_url: previewUrl } : {}),
    title: asString(raw.title, ""),
    description: asString(raw.description, ""),
    time_created: asNumber(raw.time_created),
    time_updated: asNumber(raw.time_updated),
    visibility: asNumber(raw.visibility),
    banned: asNumber(raw.banned),
    ban_reason: asString(raw.ban_reason, ""),
    subscriptions: asNumber(raw.subscriptions),
    favorited: asNumber(raw.favorited),
    lifetime_subscriptions: asNumber(raw.lifetime_subscriptions),
    ...(tags !== undefined ? { tags } : {}),
  };
}

/** 网络错误的 detail 摘要（Error.message / abort 原因等） */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 拉取单个工坊条目的公开元数据（免 key，§2.1）。
 *
 * @throws PackError("PUBLISH_NETWORK_ERROR") fetch 层失败（DNS / 超时 / 连接失败），cause 保留原始错误
 * @throws PackError("PUBLISH_API_ERROR") 非 200、响应体非 JSON、result 不是 1/9、或没有条目详情
 * @throws PackError("PUBLISH_ITEM_PRIVATE") result === 9（条目私有/无权限）
 */
export async function fetchPublishedFileDetails(opts: FetchMetadataOptions): Promise<PublishedFileDetails> {
  const itemId = String(opts.itemId);
  const body = new URLSearchParams();
  body.set("itemcount", "1");
  body.set("publishedfileids[0]", itemId);

  let res;
  try {
    res = await fetch(PUBLISH_METADATA_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    const err = new PackError(
      "PUBLISH_NETWORK_ERROR",
      t("error.publish.networkError", { itemId, detail: describeCause(cause) }),
    );
    err.cause = cause;
    throw err;
  }

  if (res.status !== 200) {
    throw new PackError("PUBLISH_API_ERROR", t("error.publish.apiStatus", { status: res.status }));
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (cause) {
    const err = new PackError(
      "PUBLISH_API_ERROR",
      t("error.publish.apiBody", { status: res.status, detail: describeCause(cause) }),
    );
    err.cause = cause;
    throw err;
  }

  // GetPublishedFileDetails v1 的响应形状：{ response: { result, resultcount, publishedfiledetails[] } }
  const response = (payload as { response?: { result?: unknown; publishedfiledetails?: unknown } }).response;
  const result = typeof response?.result === "number" ? response.result : Number(response?.result);

  if (result === RESULT_PRIVATE) {
    throw new PackError("PUBLISH_ITEM_PRIVATE", t("error.publish.itemPrivate", { itemId }));
  }
  if (result !== RESULT_OK) {
    throw new PackError("PUBLISH_API_ERROR", t("error.publish.apiResult", { result: String(result) }));
  }

  const detailsRaw = response?.publishedfiledetails;
  const first = Array.isArray(detailsRaw) ? detailsRaw[0] : undefined;
  if (first === null || typeof first !== "object") {
    throw new PackError("PUBLISH_API_ERROR", t("error.publish.detailsEmpty", { itemId }));
  }
  // 条目级 result：publishedfiledetails[i].result——9 = 条目私有/无权限/已删除，
  // 1 = 公开可用。顶层 result===1 只表示 API 调用本身成功，不代表条目可读
  // （窗口 G / Stage D 实测：curl 私有条目返回 {response:{result:1,publishedfiledetails:[{result:9}]}}）。
  const itemResult = (first as Record<string, unknown>).result;
  const itemResultNum = typeof itemResult === "number" ? itemResult : Number(itemResult);
  if (itemResultNum === RESULT_PRIVATE) {
    throw new PackError("PUBLISH_ITEM_PRIVATE", t("error.publish.itemPrivate", { itemId }));
  }
  if (itemResultNum !== RESULT_OK) {
    throw new PackError("PUBLISH_API_ERROR", t("error.publish.apiResult", { result: String(itemResultNum) }));
  }
  return normalizeDetails(first as Record<string, unknown>, itemId);
}

/**
 * 检查条目是否在上次 build 后被更新过（比较 time_updated 与 sinceTimestamp）。
 *
 * `sinceTimestamp` 缺省时无法比较，直接返回 `updated: true`（保守：提示调用方先核对）。
 *
 * @throws 同 {@link fetchPublishedFileDetails}
 */
export async function checkItemUpdated(opts: CheckItemUpdatedOptions): Promise<CheckItemUpdatedResult> {
  const details = await fetchPublishedFileDetails({ itemId: opts.itemId, timeoutMs: opts.timeoutMs });
  const timeUpdated = details.time_updated;
  const updated = opts.sinceTimestamp === undefined ? true : timeUpdated > opts.sinceTimestamp;
  return { updated, timeUpdated, details };
}
