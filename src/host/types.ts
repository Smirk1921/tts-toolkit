// src/host/types.ts
/**
 * 图床插件化契约（方案设计.md §6）。
 *
 * 职责：
 * - 定义 {@link ImageHost} 统一接口与 {@link File} / {@link UploadResult} / {@link Liveness} /
 *   {@link HostCapabilities} 等契约类型 —— 内置四种实现（steamcloud / s3 / local / command）
 *   与用户自定义扩展（配置声明、插件加载）走**同一接口**，不搞特殊路径；
 * - 提供所有实现共用的运行时助手：入参校验（{@link validateUploadFiles} / {@link parseUploadOptions}）、
 *   对象名安全化（{@link safeObjectName}）、HTTP 存活探测（{@link probeHttpLiveness}）。
 *
 * 契约要点：
 * - `upload` 按入参顺序逐个上传；任一文件失败时整体 reject（PackError），保证返回的数组
 *   要么全部成功、要么没有部分结果（调用方无需处理"传了一半"的中间态）；
 * - {@link UploadResult} 用 `status` 区分"已上传"（有 url）与"待人工完成"（无 url、带
 *   {@link PendingUpload} 提示）—— Steam Cloud 的手动上传是**可接受结果**，不是失败（§6.5）；
 * - 所有错误一律是 `src/pack/packyaml.ts` 的 {@link PackError}，错误码（HOST_* 全系列）见各实现。
 *
 * 本模块新增的 i18n 键（locales/*.json 双语镜像）：
 * - `error.host.invalidInput` {detail}
 * - `error.host.probeUnavailable` {url}
 * - `error.host.httpStatusDead` {status}
 *
 * zod 各字段的 issue 文案按仓库既有风格写死中文（同 src/pack/packyaml.ts 的取舍），
 * 只作为校验失败摘要的数据部分出现，不单独面向用户，故不走 t()。
 */

import { z } from "zod";

import { t } from "../i18n/index.js";
import { checkUrls } from "../assets/check.js";
import { PackError } from "../pack/packyaml.js";

// ---------------------------------------------------------------------------
// 契约类型
// ---------------------------------------------------------------------------

/**
 * 待上传文件（与浏览器 DOM 的 File 无关）。
 *
 * `data` 用 Uint8Array 表达（Buffer 是其子类，直接可传）；`mime` 缺省时由实现按扩展名推断。
 */
export interface File {
  /** 上传后的对象名（可含 "/" 表达子目录，如 "decks/hero.png"） */
  readonly name: string;
  /** 文件内容 */
  readonly data: Uint8Array;
  /** MIME 类型（缺省按扩展名推断） */
  readonly mime?: string;
}

/** 上传选项（所有实现共用；实现只取自己关心的字段） */
export interface UploadOptions {
  /** 单文件操作超时毫秒数（网络请求 / 子进程），默认 {@link DEFAULT_UPLOAD_TIMEOUT_MS} */
  readonly timeoutMs?: number;
  /** steamcloud：待上传文件的暂存目录（缺省 `<cwd>/.tts/steamcloud-pending`） */
  readonly stagingDir?: string;
  /** 中断信号（网络请求 / 子进程透传） */
  readonly signal?: AbortSignal;
}

/** 需要人工完成的上传（Steam Cloud 手动流程，见方案设计 §6.5） */
export interface PendingUpload {
  /** 给用户的操作提示（已本地化，可直接展示） */
  readonly hint: string;
  /** 文件已备好的暂存目录（绝对路径） */
  readonly stagingDir: string;
  /** 待上传清单文件路径（YAML，列出全部待上传文件） */
  readonly manifestPath: string;
}

/** 单个文件的上传结果 */
export interface UploadResult {
  /** 文件名（对应入参 {@link File.name}） */
  readonly file: string;
  /**
   * 上传状态："uploaded" = 已上传，`url` 可用；
   * "pending" = 需按 `pending.hint` 人工完成（Steam Cloud 手动流程），此时没有 `url`。
   */
  readonly status: "uploaded" | "pending";
  /** 公开可访问的 URL（仅 status="uploaded" 时存在） */
  readonly url?: string;
  /** 人工完成步骤说明（仅 status="pending" 时存在） */
  readonly pending?: PendingUpload;
}

/** 单个 URL 的存活检测结果 */
export interface Liveness {
  /** 是否存活 */
  readonly alive: boolean;
  /** HTTP 状态码（非 HTTP 检测或未拿到响应时缺省 / 为 0） */
  readonly status?: number;
  /** 不存活时的原因描述（存活时缺省） */
  readonly error?: string;
}

/** 图床能力声明 */
export interface HostCapabilities {
  /** 单文件大小上限（字节）；未声明上限时缺省 */
  readonly maxFileSize?: number;
  /** 支持的格式扩展名（如 ["png", "jpg"]）；不限时缺省 */
  readonly formats?: readonly string[];
  /** 是否支持删除已上传的素材 */
  readonly deletable: boolean;
}

/**
 * 图床统一接口 —— 内置实现与用户扩展的唯一契约（方案设计 §6.2）。
 */
export interface ImageHost {
  /** 图床 id：'steamcloud' | 's3' | 'local' | 'command' | 用户自定义名 */
  readonly id: string;
  /** 上传文件，返回可公开访问的 URL（Steam Cloud 手动流程返回 pending 结果） */
  upload(files: File[], opts: UploadOptions): Promise<UploadResult[]>;
  /** 存活检测（不抛网络错误，失败一律以 alive=false + error 描述返回） */
  check(url: string): Promise<Liveness>;
  /** 能力声明 */
  capabilities(): HostCapabilities;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 内置图床类型（配置声明 `hosts.<name>.type` 的合法取值） */
export const BUILTIN_HOST_IDS = ["steamcloud", "s3", "local", "command"] as const;

/** 单文件操作（网络请求 / 子进程）的默认超时毫秒数 */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// zod 校验（运行时边界统一 unknown + zod，禁止 any）
// ---------------------------------------------------------------------------

/** 非空字符串（自动去除首尾空白；类型错误提示为中文） */
const nonEmptyString = z.string({ error: "必须是字符串" }).trim().min(1, "不能为空字符串");

/** File 结构（严格模式：未知字段拒绝，防拼写错误静默生效） */
const fileSchema = z.strictObject(
  {
    name: nonEmptyString,
    data: z.instanceof(Uint8Array, { error: "data 必须是 Uint8Array / Buffer" }),
    mime: nonEmptyString.optional(),
  },
  {
    error: (issue) => {
      const keys = (issue as { keys?: unknown }).keys;
      if (Array.isArray(keys)) {
        return `文件对象含有无法识别的字段：${keys.map((key) => String(key)).join("、")}`;
      }
      return "文件必须是键值对象";
    },
  },
);

/** UploadOptions 结构 */
const uploadOptionsSchema = z.object(
  {
    timeoutMs: z
      .number({ error: "timeoutMs 必须是数字" })
      .int("timeoutMs 必须是整数")
      .min(1, "timeoutMs 必须 ≥ 1")
      .optional(),
    stagingDir: nonEmptyString.optional(),
    signal: z.instanceof(AbortSignal, { error: "signal 必须是 AbortSignal" }).optional(),
  },
  { error: "opts 必须是键值对象" },
);

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 将 zod 校验错误格式化为单行中文可读描述。
 * @param error zod 校验错误对象
 * @returns 形如 "name：不能为空字符串" 的描述，多个问题以"；"连接
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

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 校验上传文件列表（所有图床实现共用同一个入口，保证行为一致）。
 *
 * 规则：files 必须是非空数组；每项过 {@link fileSchema}（name 非空、data 是 Uint8Array）；
 * 对象名安全化（{@link safeObjectName}）后不得重复 —— 重名会让"多传一"的结果不可预测，
 * 直接报错而不是静默覆盖。
 *
 * @param files 待上传文件列表
 * @returns 校验通过后的文件列表（name 已去除首尾空白）
 * @throws PackError code="HOST_INVALID_INPUT" 结构非法 / 列表为空 / 对象名重名时
 */
export function validateUploadFiles(files: File[]): File[] {
  if (!Array.isArray(files)) {
    throw new PackError("HOST_INVALID_INPUT", t("error.host.invalidInput", { detail: "files 必须是数组" }));
  }
  if (files.length === 0) {
    throw new PackError("HOST_INVALID_INPUT", t("error.host.invalidInput", { detail: "files 不能为空数组" }));
  }
  const parsed: File[] = [];
  const seenNames = new Set<string>();
  for (const file of files) {
    const result = fileSchema.safeParse(file);
    if (!result.success) {
      throw new PackError(
        "HOST_INVALID_INPUT",
        t("error.host.invalidInput", { detail: formatZodError(result.error) }),
      );
    }
    const normalized = safeObjectName(result.data.name);
    if (seenNames.has(normalized)) {
      throw new PackError(
        "HOST_INVALID_INPUT",
        t("error.host.invalidInput", { detail: `文件名重复：${normalized}` }),
      );
    }
    seenNames.add(normalized);
    parsed.push(result.data);
  }
  return parsed;
}

/**
 * 校验上传选项（宽松：所有字段可选；非法值报错而不是猜测）。
 * @param opts 调用方传入的选项（可为 undefined）
 * @returns 校验通过的选项（未提供的字段保持缺省）
 * @throws PackError code="HOST_INVALID_INPUT" 字段类型 / 范围非法时
 */
export function parseUploadOptions(opts: UploadOptions | undefined): UploadOptions {
  const result = uploadOptionsSchema.safeParse(opts ?? {});
  if (!result.success) {
    throw new PackError("HOST_INVALID_INPUT", t("error.host.invalidInput", { detail: formatZodError(result.error) }));
  }
  return result.data;
}

/**
 * 把文件名安全化为相对对象名（s3 key / 本地相对路径共用）。
 *
 * 规则：反斜杠归一化为 "/"；丢弃空段与 "." 段；拒绝 ".." 段（防目录穿越）与空结果。
 * 例："a\\b.png" → "a/b.png"；"/x/./y/" → "x/y"；"../etc/passwd" → 拒绝。
 *
 * @param name 原始文件名
 * @returns 安全化后的相对对象名（不含首尾分隔符）
 * @throws PackError code="HOST_INVALID_INPUT" 含 ".." 段或结果为空时
 */
export function safeObjectName(name: string): string {
  const segments = name
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new PackError("HOST_INVALID_INPUT", t("error.host.invalidInput", { detail: `对象名不能包含 ".."：${name}` }));
  }
  const joined = segments.join("/");
  if (joined === "") {
    throw new PackError("HOST_INVALID_INPUT", t("error.host.invalidInput", { detail: `对象名无效：${name}` }));
  }
  return joined;
}

/**
 * HTTP 存活探测（steamcloud / s3 / command 的默认 check 实现）。
 *
 * 复用 src/assets/check.ts 的 checkUrls（代理支持、HEAD→GET 退化、硬性超时兜底都在那里），
 * 不重新实现探测逻辑。单条结果缺失理论上不可能，仍兜底返回不存活。
 *
 * @param url 待检测 URL
 * @returns 检测结果（不抛网络错误）
 */
export async function probeHttpLiveness(url: string): Promise<Liveness> {
  const summary = await checkUrls([url]);
  const first = summary.results[0];
  if (first === undefined) {
    return { alive: false, error: t("error.host.probeUnavailable", { url }) };
  }
  const liveness: Liveness = { alive: first.alive, status: first.status };
  if (first.error !== undefined) {
    return { ...liveness, error: first.error };
  }
  // 拿到了 HTTP 响应但不存活（3xx / 4xx / 5xx）：checkUrls 不填 error，
  // 这里补一条原因，保证"不存活必有描述"（诊断数据，状态码本身即原因）
  if (!first.alive) {
    return { ...liveness, error: t("error.host.httpStatusDead", { status: first.status }) };
  }
  return liveness;
}
