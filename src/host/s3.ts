// src/host/s3.ts
/**
 * S3 兼容图床：Cloudflare R2 / AWS S3 / MinIO（方案设计.md §6.3）。
 *
 * 职责：
 * - 走 S3 REST API（PUT Object）+ AWS Signature V4 签名，**不引入 AWS SDK 依赖**；
 * - path-style 寻址（`<endpoint>/<bucket>/<key>`）：R2、MinIO 原生支持，AWS 各区域亦兼容；
 * - 公开 URL 优先取 `public_base_url`（R2 需绑自定义域或 r2.dev 才能公开访问），
 *   缺省用 `<endpoint>/<bucket>`（MinIO 本机测试够用）。
 *
 * 全局配置声明（config.yaml 的 hosts 字段，由 src/host/command.ts 解析并构造本类）：
 *
 * ```yaml
 * hosts:
 *   my-s3:
 *     type: s3
 *     endpoint: https://<accountid>.r2.cloudflarestorage.com   # MinIO 如 http://127.0.0.1:9000
 *     region: auto                                             # R2 固定 auto；AWS 如 us-east-1
 *     bucket: my-bucket
 *     access_key_id: <ACCESS_KEY_ID>
 *     secret_access_key: <SECRET_ACCESS_KEY>
 *     prefix: tts/                                             # 可选，对象 key 前缀
 *     public_base_url: https://cdn.example.com/tts/            # 可选，公开访问基址
 * ```
 *
 * 签名细节（SigV4）：服务名 "s3"，unsigned payload 不用 —— 每次上传都带
 * `x-amz-content-sha256: <body 哈希>`（body 已在内存，直接算）。
 *
 * 错误码（PackError）：
 * - "HOST_CONFIG_INVALID" 构造参数非法（endpoint 缺失 / 不是 http(s) URL、密钥为空等）
 * - "HOST_INVALID_INPUT"  入参文件结构非法 / 重名 / 超过 maxFileSize
 * - "HOST_UPLOAD_FAILED"  PUT 返回非 2xx（detail 含状态码与响应体摘要）或请求异常
 *
 * 本模块新增的 i18n 键（locales/*.json 双语镜像）：
 * - `error.host.fileTooLarge` {file} {size} {max}
 * （error.host.uploadFailed / error.host.invalidInput / error.host.config* 见 types.ts、command.ts）
 */

import { createHash, createHmac } from "node:crypto";

import { request } from "undici";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";
import { DEFAULT_UPLOAD_TIMEOUT_MS, parseUploadOptions, probeHttpLiveness, safeObjectName, validateUploadFiles } from "./types.js";
import type { File, HostCapabilities, ImageHost, Liveness, UploadOptions, UploadResult } from "./types.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** SigV4 服务名 */
const S3_SERVICE = "s3";

/** SigV4 请求签名算法名 */
const ALGORITHM = "AWS4-HMAC-SHA256";

/** 单次 PUT Object 的体积上限：AWS S3 / Cloudflare R2 均为 5 GiB */
export const S3_MAX_PUT_BYTES = 5 * 1024 ** 3;

/** 非实体请求 UA（与 src/assets/check.ts 保持一致） */
const USER_AGENT = "tts-toolkit/0.1.0";

/** 常见扩展名 → MIME（缺省 application/octet-stream） */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
});

/** 错误响应体里截取给用户看的最大字节数（服务端报错原文是诊断数据，不占用全屏） */
const ERROR_BODY_SNIPPET_BYTES = 512;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** S3Host 构造参数（字段全部必填，由配置解析层负责"缺字段报清楚"） */
export interface S3HostOptions {
  /** 图床 id（配置声明时为声明名；直接构造时缺省 "s3"） */
  readonly id?: string;
  /** S3 兼容端点，如 https://<accountid>.r2.cloudflarestorage.com 或 http://127.0.0.1:9000 */
  readonly endpoint: string;
  /** 区域：R2 固定 "auto"；AWS 如 "us-east-1"；MinIO 任意非空（常写 "us-east-1"） */
  readonly region: string;
  /** 桶名 */
  readonly bucket: string;
  /** 访问密钥 ID */
  readonly accessKeyId: string;
  /** 秘密访问密钥 */
  readonly secretAccessKey: string;
  /** 对象 key 前缀（自动归一化为 "xxx/" 形态或空串） */
  readonly prefix?: string;
  /** 公开访问基址（缺省 `<endpoint>/<bucket>`） */
  readonly publicBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// 内部工具（SigV4 签名）
// ---------------------------------------------------------------------------

/**
 * SHA-256 十六进制摘要。
 * @param data 待摘要内容
 * @returns 64 位小写十六进制串
 */
function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * HMAC-SHA256。
 * @param key 密钥（Buffer 或字符串）
 * @param data 数据
 * @returns 摘要 Buffer
 */
function hmacSha256(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * RFC 3986 URI 编码（AWS SigV4 要求：除 A-Za-z0-9-._~ 外全部编码，包括 !'()*）。
 * @param value 待编码段
 * @returns 编码后的段
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * 从扩展名推断 MIME 类型。
 * @param name 文件名
 * @returns MIME；识别不了时 application/octet-stream
 */
function guessMime(name: string): string {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// 导出类
// ---------------------------------------------------------------------------

/**
 * S3 兼容图床（Cloudflare R2 / AWS S3 / MinIO）。
 */
export class S3Host implements ImageHost {
  /** 图床 id */
  readonly id: string;

  /** 归一化后的端点（无尾随斜杠） */
  private readonly endpoint: string;
  private readonly region: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  /** 归一化后的 key 前缀（"xxx/" 形态或空串） */
  private readonly prefix: string;
  /** 公开访问基址（无尾随斜杠） */
  private readonly publicBaseUrl: string;

  /**
   * @param options 构造参数（必填字段缺失 / endpoint 非法时直接报配置错误）
   * @throws PackError code="HOST_CONFIG_INVALID" 必填字段为空或 endpoint 不是 http(s) URL 时
   */
  constructor(options: S3HostOptions) {
    const hostId = options.id ?? "s3";
    // 必填字段按配置键名报错（与 config.yaml 里的字段名一致，用户能对上号）
    const requiredFields: ReadonlyArray<readonly [string, string | undefined]> = [
      ["endpoint", options.endpoint],
      ["region", options.region],
      ["bucket", options.bucket],
      ["access_key_id", options.accessKeyId],
      ["secret_access_key", options.secretAccessKey],
    ];
    const missing = requiredFields
      .filter(([, value]) => typeof value !== "string" || value.trim() === "")
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new PackError(
        "HOST_CONFIG_INVALID",
        t("error.host.configInvalid", {
          name: hostId,
          detail: t("error.host.config.missingS3Fields", { fields: missing.join("、") }),
        }),
      );
    }
    let endpointUrl: URL;
    try {
      endpointUrl = new URL(options.endpoint);
    } catch {
      throw new PackError(
        "HOST_CONFIG_INVALID",
        t("error.host.configInvalid", {
          name: hostId,
          detail: t("error.host.config.invalidEndpoint", { value: options.endpoint }),
        }),
      );
    }
    if (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:") {
      throw new PackError(
        "HOST_CONFIG_INVALID",
        t("error.host.configInvalid", {
          name: hostId,
          detail: t("error.host.config.invalidEndpoint", { value: options.endpoint }),
        }),
      );
    }

    this.id = hostId;
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.region = options.region.trim();
    this.bucket = options.bucket.trim();
    this.accessKeyId = options.accessKeyId.trim();
    this.secretAccessKey = options.secretAccessKey.trim();

    const rawPrefix = (options.prefix ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    this.prefix = rawPrefix === "" ? "" : `${rawPrefix}/`;
    this.publicBaseUrl = (options.publicBaseUrl ?? `${this.endpoint}/${this.bucket}`).replace(/\/+$/, "");
  }

  /**
   * 上传：按入参顺序逐个 PUT Object；任一文件失败即整体 reject。
   *
   * @param files 待上传文件列表
   * @param opts.timeoutMs 单文件请求超时（默认 {@link DEFAULT_UPLOAD_TIMEOUT_MS}）
   * @param opts.signal 中断信号（透传 undici）
   * @returns 与入参同序的上传结果（公开访问 URL）
   * @throws PackError code="HOST_INVALID_INPUT" 文件结构非法 / 重名 / 超过 5 GiB 时
   * @throws PackError code="HOST_UPLOAD_FAILED" PUT 非 2xx 或网络异常时
   */
  async upload(files: File[], opts: UploadOptions): Promise<UploadResult[]> {
    const validated = validateUploadFiles(files);
    const options = parseUploadOptions(opts);
    const timeoutMs = options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;

    const results: UploadResult[] = [];
    for (const file of validated) {
      const objectName = safeObjectName(file.name);
      if (file.data.byteLength > S3_MAX_PUT_BYTES) {
        throw new PackError(
          "HOST_INVALID_INPUT",
          t("error.host.fileTooLarge", { file: file.name, size: file.data.byteLength, max: S3_MAX_PUT_BYTES }),
        );
      }
      const url = await this.putObject(this.prefix + objectName, file, timeoutMs, options.signal);
      results.push({ file: file.name, status: "uploaded", url });
    }
    return results;
  }

  /**
   * 存活检测：S3 对象的公开 URL 就是普通 http(s) 资源，走通用 HTTP 探测。
   * @param url 待检测 URL
   * @returns 检测结果（不抛网络错误）
   */
  async check(url: string): Promise<Liveness> {
    return probeHttpLiveness(url);
  }

  /**
   * 能力声明：单文件上限取 AWS/R2 单次 PUT 的 5 GiB；格式不限；删除未实现，如实声明 false。
   */
  capabilities(): HostCapabilities {
    return { maxFileSize: S3_MAX_PUT_BYTES, deletable: false };
  }

  // -------------------------------------------------------------------------
  // 内部：PUT Object + SigV4
  // -------------------------------------------------------------------------

  /**
   * 签名并 PUT 一个对象。
   * @param key 完整对象 key（已含前缀，未经 URL 编码）
   * @param file 文件内容
   * @param timeoutMs 超时毫秒数
   * @param signal 中断信号
   * @returns 公开访问 URL
   * @throws PackError code="HOST_UPLOAD_FAILED" 非 2xx 或网络异常时
   */
  private async putObject(
    key: string,
    file: File,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const keySegments = key.split("/");
    const encodedPath = `/${[this.bucket, ...keySegments].map(encodeRfc3986).join("/")}`;

    const target = new URL(this.endpoint);
    // 保留 endpoint 自带的路径前缀（如 MinIO 反代部署在子路径下）
    const basePath = target.pathname.replace(/\/+$/, "");
    target.pathname = `${basePath}${encodedPath}`;

    const body = file.data;
    const payloadHash = sha256Hex(body);
    const contentType = file.mime ?? guessMime(file.name);
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    // 签名头必须与实际发送的头完全一致（host 含非默认端口）
    const headers: Record<string, string> = {
      "content-type": contentType,
      host: target.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((name) => `${name}:${headers[name]?.trim()}\n`)
      .join("");

    const canonicalRequest = [
      "PUT",
      target.pathname,
      "", // canonical query string：上传无查询参数
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const scope = `${dateStamp}/${this.region}/${S3_SERVICE}/aws4_request`;
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = hmacSha256(
      hmacSha256(hmacSha256(hmacSha256(`AWS4${this.secretAccessKey}`, dateStamp), this.region), S3_SERVICE),
      "aws4_request",
    );
    const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

    headers["authorization"] =
      `${ALGORITHM} Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    headers["user-agent"] = USER_AGENT;
    // host 头参与签名但不显式发送：undici 会按 URL 自动补 host（值相同），避免重复头
    const requestHeaders: Record<string, string> = { ...headers };
    delete requestHeaders.host;

    let statusCode: number;
    let responseText = "";
    try {
      const response = await request(target, {
        method: "PUT",
        headers: requestHeaders,
        body,
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });
      statusCode = response.statusCode;
      if (statusCode < 200 || statusCode >= 300) {
        // 错误响应体（XML）含服务端诊断信息，截取前若干字节辅助定位
        responseText = (await response.body.text()).slice(0, ERROR_BODY_SNIPPET_BYTES);
      } else {
        await response.body.dump();
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new PackError(
        "HOST_UPLOAD_FAILED",
        t("error.host.uploadFailed", { host: this.id, file: file.name, detail }),
      );
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new PackError(
        "HOST_UPLOAD_FAILED",
        t("error.host.uploadFailed", {
          host: this.id,
          file: file.name,
          detail: `HTTP ${statusCode}${responseText === "" ? "" : `：${responseText}`}`,
        }),
      );
    }

    return `${this.publicBaseUrl}/${keySegments.map(encodeRfc3986).join("/")}`;
  }
}
