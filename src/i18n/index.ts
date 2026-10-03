// src/i18n/index.ts
/**
 * 极简 i18n 模块：中文 / 英文两套 JSON 资源，不引入任何 i18n 框架。
 *
 * 职责：
 * - 解析当前语言（显式指定 > 全局配置文件 > 系统 locale > 中文）；
 * - 按 `a.b.c` 键取翻译，缺翻译时回退中文，dev 模式向 stderr 告警（不静默显示 key）；
 * - 支持 `{name}` 字符串插值。
 *
 * 语言解析优先级（从高到低）：
 * 1. {@link initI18n} 的 `opts.lang`（非法值直接抛中文错误，不做猜测）；
 * 2. 全局配置文件 `%APPDATA%\tts-toolkit\config.yaml` 的 `lang` 字段
 *    （文件不存在 / 读取失败 / YAML 非法 / 值无法识别时一律跳过，不阻塞 CLI 启动）；
 * 3. 系统 locale（`Intl.DateTimeFormat().resolvedOptions().locale`，含 "zh" 视为 zh-CN）；
 * 4. 兜底 `"zh-CN"`。
 *
 * dev 模式：`opts.dev === true` 或环境变量 `TTS_DEV === "1"`（两者是"或"关系，
 * 显式传 `dev: false` 不能关闭环境变量开关）。dev 模式下的告警只写 stderr，
 * 不改变 {@link t} 的返回值。
 *
 * 资源键与占位符约定（占位符写作 `{name}`；缺参时原样保留字面量并在 dev 模式告警）：
 * - `cli.status.connected` {port}；`cli.status.portInUse` {port}
 * - `cli.pull.done` {scripts} {ui}
 * - `cli.exec.timeout` {seconds}；`cli.exec.luaError` {message}；`cli.exec.multipleReturns` {count}
 * - `cli.assets.summary` {alive} {dead}；`cli.assets.alive` / `cli.assets.dead` {url}
 * - `cli.config.datadir.selected` {path}；`cli.config.datadir.written` {path} {config}
 * - `error.portInUse` {port} {detail}；`error.notConnected` {port}；
 *   `error.timeout` {seconds} {detail}；`error.jsonParse` {detail}；`error.invalidDatadir` {path}
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import enUS from "../../locales/en-US.json" with { type: "json" };
import zhCN from "../../locales/zh-CN.json" with { type: "json" };

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 支持的语言标签 */
export type Lang = "zh-CN" | "en-US";

/** i18n 初始化选项 */
export interface I18nOptions {
  /** 显式指定语言（最高优先级） */
  lang?: Lang;
  /** 开发模式（缺翻译时 stderr 警告） */
  dev?: boolean;
}

/** 翻译资源树（叶子节点为翻译文本） */
export interface TranslationTree {
  [key: string]: string | TranslationTree;
}

/** 模块内部状态（initI18n 之后固定） */
interface I18nState {
  /** 当前语言 */
  lang: Lang;
  /** 是否处于 dev 模式 */
  dev: boolean;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 支持的语言列表（供 zod 校验使用） */
const SUPPORTED_LANGS = ["zh-CN", "en-US"] as const;

/** 资源缺失时的最终回退语言 */
const FALLBACK_LANG: Lang = "zh-CN";

/** 全局配置目录名（与 src/datadir/locate.ts 保持一致） */
const CONFIG_DIR_NAME = "tts-toolkit";

/** 全局配置文件名 */
const CONFIG_FILE_NAME = "config.yaml";

/** 插值占位符：`{name}`，name 允许字母 / 数字 / 下划线 / 点 / 连字符 */
const PLACEHOLDER_RE = /\{([A-Za-z0-9_.-]+)\}/g;

/** 资源表（编译期静态导入，运行时不读文件） */
const RESOURCES: Record<Lang, TranslationTree> = {
  "zh-CN": zhCN as TranslationTree,
  "en-US": enUS as TranslationTree,
};

// ---------------------------------------------------------------------------
// zod 校验（运行时边界统一 unknown + zod，禁止 any）
// ---------------------------------------------------------------------------

/** initI18n 入参结构 */
const i18nOptionsSchema = z.object(
  {
    lang: z.enum(SUPPORTED_LANGS, { error: '仅支持 "zh-CN" 或 "en-US"' }).optional(),
    dev: z.boolean({ error: "必须是布尔值" }).optional(),
  },
  { error: "initI18n 入参必须是键值对象" },
);

// ---------------------------------------------------------------------------
// 模块状态
// ---------------------------------------------------------------------------

/** 当前状态；undefined 表示尚未初始化（首次 getLang / t 会惰性初始化） */
let state: I18nState | undefined;

/** 已告警过的键（避免同一缺失键在循环里刷屏） */
const warned = new Set<string>();

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 将 zod 校验错误格式化为单行中文描述。
 * @param error - zod 校验错误对象
 * @returns 形如 "lang：仅支持 \"zh-CN\" 或 \"en-US\"" 的描述，多个问题以"；"连接
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
 * 向 stderr 写一条 i18n 告警（调用方负责判断是否处于 dev 模式）。
 * @param message - 告警内容（中文）
 */
function warn(message: string): void {
  process.stderr.write(`[i18n] ${message}\n`);
}

/**
 * 仅在 dev 模式且在本次进程中未告警过时，输出一条 stderr 告警。
 * @param dev - 是否 dev 模式
 * @param dedupeKey - 去重键（通常是缺失的翻译键 / 占位符名）
 * @param message - 告警内容（中文）
 */
function warnOnce(dev: boolean, dedupeKey: string, message: string): void {
  if (!dev || warned.has(dedupeKey)) {
    return;
  }
  warned.add(dedupeKey);
  warn(message);
}

/**
 * 把任意语言标签归一化为支持的语言。
 * 只做前缀匹配（"zh-Hans-CN" → zh-CN，"en" → en-US），识别不了返回 undefined。
 * @param value - 待归一化的值（可能来自配置文件等不可信来源）
 * @returns 归一化后的语言；无法识别时返回 undefined
 */
function normalizeLang(value: unknown): Lang | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const tag = value.trim().toLowerCase();
  if (tag === "") {
    return undefined;
  }
  const [primary] = tag.split("-");
  if (primary === "zh") {
    return "zh-CN";
  }
  if (primary === "en") {
    return "en-US";
  }
  return undefined;
}

/**
 * 解析全局配置文件的默认路径。
 * Windows 下为 `%APPDATA%\tts-toolkit\config.yaml`；
 * APPDATA 未设置（非 Windows）时回退 `~/.config/tts-toolkit/config.yaml`。
 * @returns 配置文件绝对路径
 */
function defaultConfigPath(): string {
  const base = process.env.APPDATA ?? path.join(os.homedir(), ".config");
  return path.join(base, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/**
 * 从全局配置文件读取 `lang` 字段（宽松解析：任何异常都只是"读不到"）。
 *
 * 之所以不抛错：语言只是展示偏好，配置文件损坏不应该让 CLI 起不来，
 * 此时回退系统 locale 即可（配置本身的问题由 datadir 模块的 readConfig 严格报错）。
 *
 * @param dev - 是否 dev 模式（控制 stderr 告警）
 * @returns 识别到的语言；文件不存在 / 不可读 / YAML 非法 / 字段无法识别时返回 undefined
 */
function langFromConfig(dev: boolean): Lang | undefined {
  const filePath = defaultConfigPath();
  if (!existsSync(filePath)) {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    warnOnce(dev, `config-read:${filePath}`, `读取配置文件失败，忽略 lang 字段：${filePath}（${err instanceof Error ? err.message : String(err)}）`);
    return undefined;
  }
  if (raw.trim() === "") {
    return undefined;
  }
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    warnOnce(dev, `config-yaml:${filePath}`, `配置文件不是合法 YAML，忽略 lang 字段：${filePath}（${err instanceof Error ? err.message : String(err)}）`);
    return undefined;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const parsed = normalizeLang((data as Record<string, unknown>).lang);
  if (parsed === undefined) {
    const rawLang = (data as Record<string, unknown>).lang;
    if (rawLang !== undefined && rawLang !== null) {
      warnOnce(dev, `config-lang:${filePath}`, `配置文件的 lang 字段无法识别（${String(rawLang)}），改用系统语言`);
    }
  }
  return parsed;
}

/**
 * 读取系统 locale 并归一化。
 * @returns 识别到的语言；`Intl` 不可用或 locale 不属于支持范围时返回 undefined
 */
function langFromSystem(): Lang | undefined {
  try {
    return normalizeLang(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    // 极端环境下 Intl 不可用：视作无法识别
    return undefined;
  }
}

/**
 * 组装最终状态（语言优先级见模块头注释）。
 * @param lang - 显式指定的语言（已经过 zod 校验）
 * @param dev - 是否 dev 模式
 * @returns 内部状态
 */
function resolveState(lang: Lang | undefined, dev: boolean): I18nState {
  return {
    lang: lang ?? langFromConfig(dev) ?? langFromSystem() ?? FALLBACK_LANG,
    dev,
  };
}

/**
 * 惰性初始化：initI18n 未被调用时（例如模块级直接调 t），按默认优先级解析一次。
 * @returns 当前状态
 */
function ensureState(): I18nState {
  if (state === undefined) {
    state = resolveState(undefined, process.env.TTS_DEV === "1");
  }
  return state;
}

/**
 * 按键取模板文本：先整体键（支持扁平书写 "a.b"），再按 "." 逐层下钻。
 * 使用 hasOwnProperty 语义（Object.hasOwn），避免命中原型链上的属性。
 * @param tree - 资源树
 * @param key - 翻译键
 * @returns 模板字符串；键不存在或对应值不是字符串时返回 undefined
 */
function lookup(tree: TranslationTree, key: string): string | undefined {
  const flat = tree[key];
  if (typeof flat === "string") {
    return flat;
  }
  let node: string | TranslationTree | undefined = tree;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, segment)) {
      return undefined;
    }
    node = node[segment];
  }
  return typeof node === "string" ? node : undefined;
}

/**
 * 把占位符参数转成字符串（对象用 JSON 序列化，避免出现 "[object Object]"）。
 * @param value - 参数值
 * @returns 字符串形式
 */
function stringifyParam(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) {
        return json;
      }
    } catch {
      // 循环引用等无法序列化的情况，退回 String()
    }
  }
  return String(value);
}

/**
 * 替换模板中的 `{name}` 占位符。
 * 参数缺失（未传 / undefined / null）时保留字面量，dev 模式告警，绝不静默吞掉。
 * @param template - 含占位符的模板
 * @param key - 翻译键（仅用于告警信息）
 * @param params - 插值参数
 * @param dev - 是否 dev 模式
 * @returns 替换后的文本
 */
function interpolate(
  template: string,
  key: string,
  params: Record<string, unknown> | undefined,
  dev: boolean,
): string {
  return template.replace(PLACEHOLDER_RE, (match, name: string) => {
    if (params === undefined || !Object.hasOwn(params, name)) {
      warnOnce(dev, `param:${key}:${name}`, `翻译 ${key} 缺少插值参数 {${name}}，已原样保留`);
      return match;
    }
    const value = params[name];
    if (value === undefined || value === null) {
      warnOnce(dev, `param:${key}:${name}`, `翻译 ${key} 的插值参数 {${name}} 为 ${String(value)}，已原样保留`);
      return match;
    }
    return stringifyParam(value);
  });
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 初始化 i18n（CLI 启动时调一次；重复调用会按新选项重新解析，便于测试）。
 *
 * 语言优先级：opts.lang > 全局配置文件 lang 字段 > 系统 locale > "zh-CN"。
 * dev 模式：opts.dev 为 true，或环境变量 TTS_DEV === "1"。
 *
 * @param opts - 初始化选项；lang 必须显式合法（非法值抛错而不是猜测），
 *   dev 为可选布尔值
 * @throws opts 不是键值对象，或 lang / dev 类型非法时抛出中文错误
 */
export function initI18n(opts: I18nOptions): void {
  const parsed = i18nOptionsSchema.safeParse(opts);
  if (!parsed.success) {
    throw new Error(`initI18n 入参无效（${formatZodError(parsed.error)}）`);
  }
  const dev = parsed.data.dev === true || process.env.TTS_DEV === "1";
  state = resolveState(parsed.data.lang, dev);
}

/**
 * 取当前语言。
 * @returns 当前语言标签；若尚未 {@link initI18n}，先按默认优先级惰性解析一次
 */
export function getLang(): Lang {
  return ensureState().lang;
}

/**
 * 取翻译。
 *
 * 查找顺序：当前语言 → 中文（缺翻译时回退，dev 模式 stderr 告警）
 * → 键本身（两套资源都没有该键时的最后兜底，dev 模式亦告警）。
 * 模板中的 `{name}` 用 params 插值；缺参时保留字面量并告警，不静默吞掉。
 *
 * @param key - 翻译键，形如 "cli.pull.done"
 * @param params - 插值参数，如 `{ scripts: 36, ui: 1 }`
 * @returns 翻译文本（已插值）
 * @throws key 不是非空字符串时抛出中文错误（调用方编程错误）
 */
export function t(key: string, params?: Record<string, unknown>): string {
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error(`t 的 key 无效：必须是非空字符串（收到 ${typeof key === "string" ? "空字符串" : typeof key}）`);
  }
  const current = ensureState();
  let template = lookup(RESOURCES[current.lang], key);
  if (template === undefined && current.lang !== FALLBACK_LANG) {
    warnOnce(current.dev, `missing:${current.lang}:${key}`, `缺少 ${current.lang} 翻译：${key}，已回退 ${FALLBACK_LANG}`);
    template = lookup(RESOURCES[FALLBACK_LANG], key);
  }
  if (template === undefined) {
    warnOnce(current.dev, `missing:${FALLBACK_LANG}:${key}`, `资源中不存在翻译键：${key}，已原样输出键名`);
    return key;
  }
  return interpolate(template, key, params, current.dev);
}
