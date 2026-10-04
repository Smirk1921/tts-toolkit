// src/host/command.ts
/**
 * 万能逃生口：command 图床 + 两种用户扩展方式（方案设计.md §6.3.1）。
 *
 * ─── ① 配置声明（最省事）───────────────────────────────────────────────
 *
 * 在全局配置文件（Windows `%APPDATA%\tts-toolkit\config.yaml`，其他平台
 * `~/.config/tts-toolkit/config.yaml`）里声明图床。`type` 可取内置四种
 * （steamcloud / s3 / local / command，见 src/host/types.ts 的 BUILTIN_HOST_IDS），
 * 最常用的是 command —— 调用用户自定义命令上传，从 stdout 读 URL：
 *
 * ```yaml
 * hosts:
 *   rclone-cdn:
 *     type: command
 *     # 上传模板（必填）：rclone 把暂存文件拷到远端，成功后在 stdout 打印最终 URL。
 *     # 可用占位符：{file} 本地暂存文件路径；{name} 文件名。
 *     # 含空格的参数请自行加引号；stdout 至少输出一个 http(s) URL（取第一个）。
 *     command: 'rclone copyto "{file}" myremote:public/tts/{name} && echo "https://cdn.example.com/tts/{name}"'
 *     # 存活检测模板（可选）：退出码 0 = 存活；省略时改为对 URL 发 HTTP 探测。
 *     # 可用占位符：{url}
 *     check: 'curl -sfI "{url}"'
 * ```
 *
 * 上面是一份**完整可跑**的 rclone 示例，前置条件只有两条：
 * 1. 已安装 rclone 并用 `rclone config` 配好名为 `myremote` 的远端（S3 / OSS / 网盘均可）；
 * 2. `https://cdn.example.com` 是该远端对应桶 / 目录的公开访问域名（对象写到
 *    `public/tts/<文件名>`，因此 URL 拼为 `https://cdn.example.com/tts/<文件名>`）。
 * 跑通方式：写好配置 → `tts host list` 应能看到 rclone-cdn → 用它上传即可。
 *
 * s3 / local 类型同样可在此声明（字段见 src/host/s3.ts、src/host/local.ts 的头注释）。
 *
 * ─── ② 插件加载（更可控）────────────────────────────────────────────────
 *
 * 在约定插件目录放一个实现 ImageHost 接口的 JS 模块，加载时自动识别：
 *
 * ```
 * ~/.tts-toolkit/hosts/<name>.js
 * ```
 *
 * ```js
 * // ~/.tts-toolkit/hosts/my-host.js
 * export default {
 *   id: "my-host",
 *   async upload(files) {
 *     return files.map((f) => ({ file: f.name, status: "uploaded", url: "https://cdn.example.com/" + f.name }));
 *   },
 *   async check(url) {
 *     return { alive: true };
 *   },
 *   capabilities() {
 *     return { deletable: false };
 *   },
 * };
 * ```
 *
 * 模块可以是 ESM（export default，如上）也可以是 CJS（module.exports = {...}）；
 * 未实现接口（缺 id / upload / check / capabilities）一律报错，绝不静默忽略。
 *
 * ─── 安全约定 ────────────────────────────────────────────────────────────
 *
 * **配置错误必须报清楚，绝不静默回退到默认图床** —— 默认图床是 Steam Cloud，
 * 静默回退会把素材传到意想不到的地方。所有配置问题（缺字段、未知字段、类型未知、
 * 插件损坏、id 冲突）一律抛 PackError("HOST_CONFIG_INVALID" / "HOST_PLUGIN_*")。
 *
 * 错误码（PackError）：
 * - "HOST_CONFIG_INVALID"      配置声明非法（本模块解析 / 构造 / id 冲突）
 * - "HOST_PLUGIN_LOAD_FAILED"  插件文件无法 import（语法错误 / 依赖缺失）
 * - "HOST_PLUGIN_INVALID"      插件未实现 ImageHost 接口 / 占用了保留 id
 * - "HOST_NOT_FOUND"           resolveHost 找不到指定图床
 * - "HOST_INVALID_INPUT"       入参非法（files / opts / id）
 * - "HOST_UPLOAD_FAILED"       上传命令执行失败或 stdout 没有输出 URL
 *
 * 本模块新增的 i18n 键（locales/*.json 双语镜像，均挂 error.host.* 下）：
 * - `notFound` {id}；`configInvalid` {name} {detail}；`configReadFailed` {path} {detail}
 * - `pluginLoadFailed` {path} {detail}；`pluginInvalid` {path} {detail}
 * - `uploadFailed` {host} {file} {detail}；`noUrlInOutput` {file} {stdout}
 * - `commandNonZero` {code} {stderr}；`commandTimeout` {seconds}；`commandAborted`
 * - `commandSpawnFailed` {detail}；`stderrEmpty`
 * - `duplicateId` {id} {first} {second}；`reservedId` {name}
 * - `config.notObject`；`config.rootNotObject`；`config.emptyName`
 * - `config.unknownType` {type}；`config.missingCommand`；`config.missingS3Fields` {fields}
 * - `config.missingLocalDir`；`config.invalidEndpoint` {value}
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";
import { LocalHost } from "./local.js";
import { S3Host } from "./s3.js";
import { SteamCloudHost } from "./steamcloud.js";
import { BUILTIN_HOST_IDS, DEFAULT_UPLOAD_TIMEOUT_MS, parseUploadOptions, probeHttpLiveness, safeObjectName, validateUploadFiles } from "./types.js";
import type { File, HostCapabilities, ImageHost, Liveness, UploadOptions, UploadResult } from "./types.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** CommandHost 构造参数 */
export interface CommandHostOptions {
  /** 图床 id（配置声明时为声明名；直接构造时缺省 "command"） */
  readonly id?: string;
  /** 上传命令模板（必填；占位符 {file} / {name}，stdout 须输出 http(s) URL） */
  readonly command: string;
  /** 存活检测命令模板（可选；占位符 {url}，退出码 0 = 存活） */
  readonly check?: string;
}

/**
 * 全局配置 hosts 字段里单个图床的声明（`hosts.<name>`）。
 *
 * 公共字段 type 必填；其余字段按 type 取用（command 用 command/check、s3 用
 * endpoint/region/bucket/access_key_id/secret_access_key/prefix/public_base_url、
 * local 用 dir）。schema 层不交叉校验（字段共用一个宽松形状），缺字段在
 * {@link createHostFromConfig} 里按 type 报清楚。
 */
export type DeclaredHostConfig = z.infer<typeof declaredHostSchema>;

/** 图床列表项（附带来源，供 tts host list 展示） */
export interface HostEntry {
  /** 图床实例 */
  readonly host: ImageHost;
  /** 来源：builtin = 内置默认；config = 配置声明；plugin = 插件目录 */
  readonly source: "builtin" | "config" | "plugin";
}

/** listHosts / resolveHost 的选项（全部可选，主要供测试注入临时路径） */
export interface HostRegistryOptions {
  /** 全局配置文件路径（缺省 %APPDATA%\tts-toolkit\config.yaml） */
  readonly configPath?: string;
  /** 插件目录（缺省 {@link DEFAULT_HOSTS_PLUGIN_DIR}） */
  readonly hostsDir?: string;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 内置默认图床的保留 id：配置声明与插件都不允许占用，避免静默顶掉默认图床 */
export const RESERVED_DEFAULT_HOST_ID = "steamcloud";

/** 插件目录：`~/.tts-toolkit/hosts/<name>.js`（方案设计 §6.3.1 的约定路径） */
export const DEFAULT_HOSTS_PLUGIN_DIR = path.join(os.homedir(), ".tts-toolkit", "hosts");

/** 子进程输出缓冲上限（bytes）；超出即报错，正常上传命令只输出一个 URL，远用不满 */
const COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** 错误信息里 stderr / stdout 片段的最大长度（诊断数据，不占满屏幕） */
const OUTPUT_SNIPPET_MAX = 400;

/** 上传命令模板占位符（{file} / {name}） */
const COMMAND_PARAM_RE = /\{([A-Za-z0-9_-]+)\}/g;

/** 从 stdout 提取 http(s) URL */
const URL_IN_STDOUT_RE = /https?:\/\/[^\s"'<>()\\]+/g;

/** 插件文件扩展名（.js 为约定；.mjs/.cjs 一并支持，模块类型由 Node 自动识别） */
const PLUGIN_FILE_RE = /\.(js|mjs|cjs)$/i;

// ---------------------------------------------------------------------------
// zod 校验（运行时边界统一 unknown + zod，禁止 any）
// ---------------------------------------------------------------------------

/** 非空字符串（自动去除首尾空白；类型错误提示为中文） */
const nonEmptyString = z.string({ error: "必须是字符串" }).trim().min(1, "不能为空字符串");

/**
 * hosts.<name> 的 zod schema（严格模式：未知字段拒绝，防拼写错误静默生效）。
 * issue 文案按仓库既有风格写死中文，只作为 configInvalid 的 detail 数据部分出现，不走 t()。
 */
const declaredHostSchema = z.strictObject(
  {
    type: z.enum(BUILTIN_HOST_IDS, { error: "type 必须是 steamcloud / s3 / local / command 之一" }),
    command: nonEmptyString.optional(),
    check: nonEmptyString.optional(),
    endpoint: nonEmptyString.optional(),
    region: nonEmptyString.optional(),
    bucket: nonEmptyString.optional(),
    access_key_id: nonEmptyString.optional(),
    secret_access_key: nonEmptyString.optional(),
    prefix: z.string({ error: "prefix 必须是字符串" }).optional(),
    public_base_url: nonEmptyString.optional(),
    dir: nonEmptyString.optional(),
  },
  {
    error: (issue) => {
      const where = ["hosts", ...(issue.path ?? []).map((seg) => String(seg))].join(".");
      const keys = (issue as { keys?: unknown }).keys;
      if (Array.isArray(keys)) {
        return `${where} 含有无法识别的字段：${keys.map((key) => String(key)).join("、")}`;
      }
      return `${where} 必须是键值对象`;
    },
  },
);

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 将 zod 校验错误格式化为单行中文可读描述。
 * @param error zod 校验错误对象
 * @returns 形如 "type：必须是 …之一" 的描述，多个问题以"；"连接
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
 * 从 unknown 错误中取人类可读描述。
 * @param err 任意抛出值
 * @returns Error 取 message，其余用 String() 兜底
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 构造"图床 <name> 的配置无效"错误（本模块所有配置问题的统一出口）。
 * @param name 图床名（或配置文件路径等定位信息）
 * @param detail 具体问题
 * @returns PackError code="HOST_CONFIG_INVALID"
 */
function configInvalid(name: string, detail: string): PackError {
  return new PackError("HOST_CONFIG_INVALID", t("error.host.configInvalid", { name, detail }));
}

/**
 * 展开 `{name}` 形态的模板占位符；未声明的占位符原样保留（由用户命令自己处理）。
 * @param template 命令模板
 * @param params 占位符取值
 * @returns 展开后的命令行
 */
function expandTemplate(template: string, params: Record<string, string>): string {
  return template.replace(COMMAND_PARAM_RE, (match, name: string) =>
    Object.hasOwn(params, name) ? (params[name] as string) : match,
  );
}

/**
 * 从 stdout 提取第一个 http(s) URL。
 * @param stdout 命令标准输出
 * @returns 第一个 URL；没有则 undefined
 */
function pickFirstUrl(stdout: string): string | undefined {
  return stdout.match(URL_IN_STDOUT_RE)?.[0];
}

/**
 * 截取输出片段（去首尾空白，超长截断），用于错误信息。
 * @param text 原始输出
 * @param max 最大长度
 * @returns 片段（空输出返回占位文案）
 */
function snippet(text: string, max: number = OUTPUT_SNIPPET_MAX): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    return t("error.host.stderrEmpty");
  }
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * 以 Promise 包装 child_process.exec（shell 执行，支持 && 等复合命令）。
 * @param command 完整命令行（已展开占位符）
 * @param opts.timeoutMs 超时毫秒数（超时杀进程）
 * @param opts.signal 中断信号
 * @returns stdout / stderr
 */
function runCommand(command: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        timeout: opts.timeoutMs,
        signal: opts.signal,
        windowsHide: true,
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ stdout, stderr });
        } else {
          reject(err);
        }
      },
    );
  });
}

/**
 * 把命令执行异常转成中文描述（区分：用户中止 / 超时 / 非零退出码 / 无法启动）。
 * @param err exec 抛出的异常（含 code / killed / stderr 属性）
 * @param timeoutMs 超时毫秒数（用于超时文案）
 * @param signal 本次执行携带的中断信号（用于区分用户中止与超时）
 * @returns 中文错误描述
 */
function describeCommandError(err: unknown, timeoutMs: number, signal?: AbortSignal): string {
  if (signal?.aborted) {
    return t("error.host.commandAborted");
  }
  if (err instanceof Error) {
    const owned = err as Error & { code?: unknown; killed?: unknown; stderr?: unknown };
    if (owned.killed === true) {
      return t("error.host.commandTimeout", { seconds: Math.round(timeoutMs / 1000) });
    }
    if (typeof owned.code === "number") {
      return t("error.host.commandNonZero", { code: owned.code, stderr: snippet(String(owned.stderr ?? "")) });
    }
    return t("error.host.commandSpawnFailed", { detail: err.message });
  }
  return t("error.host.commandSpawnFailed", { detail: errMessage(err) });
}

/**
 * 校验"插件导出对象"是否实现了 ImageHost 接口，返回缺失项清单。
 * @param value 插件模块的默认导出（或模块本身）
 * @returns 缺失 / 非法的成员描述；空数组 = 合法
 */
function imageHostGaps(value: unknown): string[] {
  if (value === null || typeof value !== "object") {
    return ["模块必须默认导出实现 ImageHost 接口的对象"];
  }
  const candidate = value as Record<string, unknown>;
  const gaps: string[] = [];
  if (typeof candidate.id !== "string" || candidate.id.trim() === "") {
    gaps.push("id（非空字符串）");
  }
  if (typeof candidate.upload !== "function") {
    gaps.push("upload(files, opts) 函数");
  }
  if (typeof candidate.check !== "function") {
    gaps.push("check(url) 函数");
  }
  if (typeof candidate.capabilities !== "function") {
    gaps.push("capabilities() 函数");
  }
  return gaps;
}

/**
 * 解析全局配置文件的默认路径（与 src/datadir/locate.ts 保持一致）。
 * @returns 配置文件绝对路径
 */
function defaultToolkitConfigPath(): string {
  const base = process.env.APPDATA ?? path.join(os.homedir(), ".config");
  return path.join(base, "tts-toolkit", "config.yaml");
}

// ---------------------------------------------------------------------------
// 导出类：CommandHost
// ---------------------------------------------------------------------------

/**
 * command 图床：调用用户自定义命令上传，从 stdout 读 URL（万能逃生口）。
 *
 * 上传：每个文件暂存到临时目录 → 展开模板占位符（{file} 暂存路径、{name} 文件名）→
 * 交 shell 执行 → 从 stdout 提取第一个 http(s) URL 作为该文件的公开地址。
 * 文件按入参顺序逐个上传；任一失败（非零退出 / 超时 / 无 URL 输出）整体 reject。
 *
 * 检测：配置了 check 模板时执行它（退出码 0 = 存活，{url} 会被替换）；
 * 未配置时回退为对 URL 发 HTTP 探测（probeHttpLiveness）。
 */
export class CommandHost implements ImageHost {
  /** 图床 id */
  readonly id: string;

  private readonly command: string;
  private readonly checkTemplate: string | undefined;

  /**
   * @param options 构造参数
   * @throws PackError code="HOST_CONFIG_INVALID" command 模板缺失 / 为空时
   */
  constructor(options: CommandHostOptions) {
    if (typeof options.command !== "string" || options.command.trim() === "") {
      throw configInvalid(options.id ?? "command", t("error.host.config.missingCommand"));
    }
    this.id = options.id ?? "command";
    this.command = options.command;
    this.checkTemplate =
      typeof options.check === "string" && options.check.trim() !== "" ? options.check : undefined;
  }

  /**
   * 上传：逐文件执行命令模板。
   *
   * @param files 待上传文件列表
   * @param opts.timeoutMs 单文件命令超时（默认 {@link DEFAULT_UPLOAD_TIMEOUT_MS}）
   * @param opts.signal 中断信号
   * @returns 与入参同序的上传结果
   * @throws PackError code="HOST_INVALID_INPUT" 文件结构非法 / 重名 / 含 ".." 段时
   * @throws PackError code="HOST_UPLOAD_FAILED" 暂存写盘失败、命令非零退出 / 超时 / 无法启动、
   *   或 stdout 未输出任何 http(s) URL 时
   */
  async upload(files: File[], opts: UploadOptions): Promise<UploadResult[]> {
    const validated = validateUploadFiles(files);
    const options = parseUploadOptions(opts);
    const timeoutMs = options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;

    // 每次调用独立暂存目录；命令执行完即无用，留在系统临时目录由系统清理
    const stagingDir = await mkdtemp(path.join(os.tmpdir(), "tts-toolkit-command-"));
    const results: UploadResult[] = [];

    for (const file of validated) {
      const objectName = safeObjectName(file.name);
      const stagedPath = path.join(stagingDir, objectName);
      try {
        await mkdir(path.dirname(stagedPath), { recursive: true });
        await writeFile(stagedPath, file.data);
      } catch (err) {
        throw new PackError(
          "HOST_UPLOAD_FAILED",
          t("error.host.uploadFailed", { host: this.id, file: file.name, detail: errMessage(err) }),
        );
      }

      const commandLine = expandTemplate(this.command, { file: stagedPath, name: file.name });
      let stdout: string;
      try {
        const outcome = await runCommand(commandLine, { timeoutMs, signal: options.signal });
        stdout = outcome.stdout;
      } catch (err) {
        throw new PackError(
          "HOST_UPLOAD_FAILED",
          t("error.host.uploadFailed", {
            host: this.id,
            file: file.name,
            detail: describeCommandError(err, timeoutMs, options.signal),
          }),
        );
      }

      const url = pickFirstUrl(stdout);
      if (url === undefined) {
        throw new PackError(
          "HOST_UPLOAD_FAILED",
          t("error.host.uploadFailed", {
            host: this.id,
            file: file.name,
            detail: t("error.host.noUrlInOutput", { file: file.name, stdout: snippet(stdout) }),
          }),
        );
      }
      results.push({ file: file.name, status: "uploaded", url });
    }
    return results;
  }

  /**
   * 存活检测：有 check 模板则执行（退出码 0 = 存活），否则 HTTP 探测。
   * @param url 待检测 URL
   * @returns 检测结果（不抛错）
   */
  async check(url: string): Promise<Liveness> {
    if (this.checkTemplate === undefined) {
      return probeHttpLiveness(url);
    }
    try {
      await runCommand(expandTemplate(this.checkTemplate, { url }), { timeoutMs: DEFAULT_UPLOAD_TIMEOUT_MS });
      return { alive: true };
    } catch (err) {
      return { alive: false, error: describeCommandError(err, DEFAULT_UPLOAD_TIMEOUT_MS) };
    }
  }

  /**
   * 能力声明：由用户命令决定，工具侧不声明限制；删除未实现，如实声明 false。
   */
  capabilities(): HostCapabilities {
    return { deletable: false };
  }
}

// ---------------------------------------------------------------------------
// 导出函数：配置声明 → 图床实例
// ---------------------------------------------------------------------------

/**
 * 解析配置里的 hosts 字段为"声明名 → 声明"映射。
 *
 * @param data 配置文件的 hosts 字段原始值（undefined / null 视为未声明）
 * @returns 声明映射（按声明顺序）
 * @throws PackError code="HOST_CONFIG_INVALID" hosts 不是对象、声明名为空、
 *   占用了保留 id "steamcloud"、或单条声明不符合 schema 时
 */
export function parseDeclaredHosts(data: unknown): Map<string, DeclaredHostConfig> {
  if (data === undefined || data === null) {
    return new Map();
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    throw configInvalid("hosts", t("error.host.config.notObject"));
  }
  const declared = new Map<string, DeclaredHostConfig>();
  for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
    if (name.trim() === "") {
      throw configInvalid(name, t("error.host.config.emptyName"));
    }
    if (name === RESERVED_DEFAULT_HOST_ID) {
      throw configInvalid(name, t("error.host.reservedId", { name }));
    }
    const parsed = declaredHostSchema.safeParse(value);
    if (!parsed.success) {
      throw configInvalid(name, formatZodError(parsed.error));
    }
    declared.set(name, parsed.data);
  }
  return declared;
}

/**
 * 按声明构造图床实例（内置四种类型都走同一 ImageHost 接口，不搞特殊路径）。
 *
 * 缺字段在这里按 type 报清楚（s3 列出全部缺失字段；command / local 指出缺什么），
 * 实现类构造器还会再自检一遍兜底 —— 绝不让缺配置的实例带病上岗。
 *
 * @param name 声明名（作为图床 id）
 * @param cfg 单条声明
 * @returns 图床实例
 * @throws PackError code="HOST_CONFIG_INVALID" 该 type 的必填字段缺失时
 */
export function createHostFromConfig(name: string, cfg: DeclaredHostConfig): ImageHost {
  switch (cfg.type) {
    case "steamcloud":
      return new SteamCloudHost({ id: name });
    case "s3": {
      const missing = (["endpoint", "region", "bucket", "access_key_id", "secret_access_key"] as const)
        .filter((field) => cfg[field] === undefined)
        .join("、");
      if (missing !== "") {
        throw configInvalid(name, t("error.host.config.missingS3Fields", { fields: missing }));
      }
      return new S3Host({
        id: name,
        endpoint: cfg.endpoint as string,
        region: cfg.region as string,
        bucket: cfg.bucket as string,
        accessKeyId: cfg.access_key_id as string,
        secretAccessKey: cfg.secret_access_key as string,
        prefix: cfg.prefix,
        publicBaseUrl: cfg.public_base_url,
      });
    }
    case "local": {
      if (cfg.dir === undefined) {
        throw configInvalid(name, t("error.host.config.missingLocalDir"));
      }
      return new LocalHost({ id: name, dir: cfg.dir });
    }
    case "command": {
      if (cfg.command === undefined) {
        throw configInvalid(name, t("error.host.config.missingCommand"));
      }
      return new CommandHost({ id: name, command: cfg.command, check: cfg.check });
    }
  }
}

/**
 * 从全局配置文件加载配置声明的图床。
 *
 * 配置文件不存在 → 空数组（未声明任何图床不是错误）；
 * 配置文件存在但 YAML 非法 / hosts 字段非法 → HOST_CONFIG_INVALID（**绝不静默回退默认图床**）。
 *
 * @param configPath 配置文件路径（缺省 %APPDATA%\tts-toolkit\config.yaml）
 * @returns 图床实例列表（按声明顺序）
 * @throws PackError code="HOST_CONFIG_INVALID" 配置读取 / 解析 / 校验失败时
 */
export async function loadDeclaredHosts(configPath?: string): Promise<ImageHost[]> {
  const filePath = configPath ?? defaultToolkitConfigPath();
  if (!existsSync(filePath)) {
    return [];
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    throw new PackError(
      "HOST_CONFIG_INVALID",
      t("error.host.configReadFailed", { path: filePath, detail: errMessage(err) }),
    );
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new PackError(
      "HOST_CONFIG_INVALID",
      t("error.host.configReadFailed", { path: filePath, detail: errMessage(err) }),
    );
  }
  if (data === null || data === undefined) {
    return [];
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new PackError(
      "HOST_CONFIG_INVALID",
      t("error.host.configReadFailed", { path: filePath, detail: t("error.host.config.rootNotObject") }),
    );
  }

  const declared = parseDeclaredHosts((data as Record<string, unknown>).hosts);
  return [...declared.entries()].map(([name, cfg]) => createHostFromConfig(name, cfg));
}

// ---------------------------------------------------------------------------
// 导出函数：插件加载
// ---------------------------------------------------------------------------

/**
 * 从插件目录加载用户实现的 ImageHost 模块（`~/.tts-toolkit/hosts/<name>.js`）。
 *
 * - 目录不存在 → 空数组（没装插件不是错误）；
 * - 只认 *.js / *.mjs / *.cjs 文件（模块类型由 Node 按语法自动识别，ESM / CJS 均可）；
 * - 无法 import → HOST_PLUGIN_LOAD_FAILED；未实现接口或占用保留 id → HOST_PLUGIN_INVALID。
 *
 * @param hostsDir 插件目录（缺省 {@link DEFAULT_HOSTS_PLUGIN_DIR}）
 * @returns 图床实例列表（按文件名顺序）
 * @throws PackError code="HOST_PLUGIN_LOAD_FAILED" 目录不可读或插件 import 失败时
 * @throws PackError code="HOST_PLUGIN_INVALID" 插件未实现接口或占用保留 id 时
 */
export async function loadPluginHosts(hostsDir: string = DEFAULT_HOSTS_PLUGIN_DIR): Promise<ImageHost[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(hostsDir, { withFileTypes: true });
  } catch (err) {
    if (err instanceof Error && (err as Error & { code?: unknown }).code === "ENOENT") {
      return [];
    }
    throw new PackError(
      "HOST_PLUGIN_LOAD_FAILED",
      t("error.host.pluginLoadFailed", { path: hostsDir, detail: errMessage(err) }),
    );
  }

  const hosts: ImageHost[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !PLUGIN_FILE_RE.test(entry.name)) {
      continue;
    }
    const filePath = path.join(hostsDir, entry.name);

    let mod: unknown;
    try {
      mod = await import(pathToFileURL(filePath).href);
    } catch (err) {
      throw new PackError(
        "HOST_PLUGIN_LOAD_FAILED",
        t("error.host.pluginLoadFailed", { path: filePath, detail: errMessage(err) }),
      );
    }
    // ESM 取 default 导出；CJS（module.exports = {...}）经 import() 后 default 即导出对象
    const candidate =
      mod !== null && typeof mod === "object" && "default" in mod
        ? (mod as { default: unknown }).default
        : mod;

    const gaps = imageHostGaps(candidate);
    if (gaps.length > 0) {
      throw new PackError(
        "HOST_PLUGIN_INVALID",
        t("error.host.pluginInvalid", { path: filePath, detail: gaps.join("；") }),
      );
    }
    const host = candidate as ImageHost;
    if (host.id === RESERVED_DEFAULT_HOST_ID) {
      throw new PackError(
        "HOST_PLUGIN_INVALID",
        t("error.host.pluginInvalid", {
          path: filePath,
          detail: t("error.host.reservedId", { name: host.id }),
        }),
      );
    }
    hosts.push(host);
  }
  return hosts;
}

// ---------------------------------------------------------------------------
// 导出函数：图床注册表（内置 + 配置声明 + 插件，同一接口）
// ---------------------------------------------------------------------------

/**
 * 列出全部可用图床：内置默认（steamcloud）+ 配置声明 + 插件，按来源顺序。
 *
 * id 冲突（配置声明与插件之间）直接报错 —— 静默覆盖会让"用的是哪个图床"变得不可预测。
 *
 * @param opts.configPath / opts.hostsDir 覆盖默认来源路径（主要供测试）
 * @returns 图床列表项（附来源）
 * @throws PackError code="HOST_CONFIG_INVALID" 配置非法或 id 冲突时
 * @throws PackError code="HOST_PLUGIN_LOAD_FAILED" / "HOST_PLUGIN_INVALID" 插件加载失败时
 */
export async function listHosts(opts?: HostRegistryOptions): Promise<HostEntry[]> {
  const entries: HostEntry[] = [{ host: new SteamCloudHost(), source: "builtin" }];
  for (const host of await loadDeclaredHosts(opts?.configPath)) {
    entries.push({ host, source: "config" });
  }
  for (const host of await loadPluginHosts(opts?.hostsDir)) {
    entries.push({ host, source: "plugin" });
  }

  const seen = new Map<string, HostEntry["source"]>();
  for (const entry of entries) {
    const first = seen.get(entry.host.id);
    if (first !== undefined) {
      throw configInvalid(
        entry.host.id,
        t("error.host.duplicateId", { id: entry.host.id, first, second: entry.source }),
      );
    }
    seen.set(entry.host.id, entry.source);
  }
  return entries;
}

/**
 * 按 id 解析图床：内置 steamcloud → 配置声明 → 插件。
 *
 * 找不到时抛 HOST_NOT_FOUND 并提示查看方式 —— 绝不静默回退到默认图床
 * （那会把素材传到意想不到的地方，见方案设计 §6.3.1 的设计要求）。
 *
 * @param id 图床 id（'steamcloud' | 配置声明名 | 插件 id）
 * @param opts 同 {@link listHosts}
 * @returns 图床实例
 * @throws PackError code="HOST_INVALID_INPUT" id 为空时
 * @throws PackError code="HOST_NOT_FOUND" 找不到指定图床时
 * @throws PackError 其余同 {@link listHosts}
 */
export async function resolveHost(id: string, opts?: HostRegistryOptions): Promise<ImageHost> {
  if (typeof id !== "string" || id.trim() === "") {
    throw new PackError("HOST_INVALID_INPUT", t("error.host.invalidInput", { detail: "图床 id 不能为空" }));
  }
  const trimmed = id.trim();
  const entries = await listHosts(opts);
  const found = entries.find((entry) => entry.host.id === trimmed);
  if (found === undefined) {
    throw new PackError("HOST_NOT_FOUND", t("error.host.notFound", { id: trimmed }));
  }
  return found.host;
}
