// src/review/config.ts
/**
 * 审批配置生成：把本工具的 YAML 元数据转成「图包审批工具」的 JSON 清单
 * （方案设计 §13.2 集成层 ①②）。
 *
 * 职责：
 * - {@link approvalConfigPath} / {@link approvalDataDir}：审批集成文件在图包
 *   工作区内的落点换算（`.tts/approval/`，工具私有区，不作图包内容发布）；
 * - {@link approvalSetFromDeck}：读 deck.yaml（{@link readDeckManifest}）取
 *   牌堆显示名，组装一个审批素材集条目——**素材 id 就是文件名**：审批工具配
 *   `pair: "basename"`（按文件名配对）后，其素材 id 与 deck 目录内
 *   cards.csv 的 face / back 文件名天然一致，零转换；
 * - {@link buildApprovalConfig}：纯构建（无 IO 校验）：data_dir 缺省指向
 *   `<workspaceRoot>/.tts/approval/data`（**不让审批工具往它自己仓库写**，
 *   方案设计 §13.2），源根目录绝对化（审批工具对相对路径按配置文件所在目录
 *   解析，绝对路径避免歧义）；
 * - {@link writeApprovalConfig}：构建 + 严格 schema 校验 + JSON 落盘
 *   （2 空格缩进 + 末尾换行），写前确保父目录存在；
 * - {@link readApprovalConfig}：读回 + 校验（{@link readApprovalConfigStrict}
 *   为严格版，供 client.ts / 上层按需选用）。
 *
 * 审批工具侧的契约（实测其 core/config.py，本模块不发明字段名）：
 * - 只接受 JSON 清单（不读 YAML），根为键值对象；
 * - `data_dir` 相对路径按**配置文件所在目录**解析，故本模块写绝对路径；
 * - `tags` 缺省时工具用自己内置的默认标签，本模块仅在调用方显式给出时写出；
 * - 素材集条目：`id / name / type: "image" / pair: "basename" /
 *   items_from: "b" / a.b: {root, label} / include / exclude / recurse`；
 *   `recurse: false` 保证素材 id 恒为纯文件名（递归子目录时 id 会带路径分隔符，
 *   破坏"与 cards.csv 文件名一致"的配对约定）；
 * - 工具对配置宽松（未知键忽略、以 `_` 开头的键当注释），本模块写出的键
 *   全部在其 `_normalize_set` / `DEFAULT_RUNTIME` 的认领范围内。
 *
 * 严格 schema 的意义（与 packyaml.ts 同一考虑）：写前校验挡住调用方传入的
 * 不可信数据（拼错的字段名、空素材集），绝不落盘一份审批工具读不懂或读出
 * 错误语义的配置——工具侧对未知键静默忽略，错了它不会喊。
 *
 * 错误码（{@link PackError.code}）：
 * - "REVIEW_CONFIG_NOT_FOUND"    读取 approval.config.json 时文件不存在
 * - "REVIEW_CONFIG_READ_FAILED"  读取 approval.config.json 时的其他 IO 错误
 * - "REVIEW_CONFIG_INVALID"      入参不合法（setId / 根目录 / sets 空等），
 *                                或读回的配置 JSON 解析失败 / 不符合 schema
 * - "REVIEW_CONFIG_WRITE_FAILED" 写入 approval.config.json 时 IO 失败
 * （写前校验不过同抛 REVIEW_CONFIG_INVALID，message 含 zod issues 摘要。）
 *
 * 本模块新增的 i18n 键（locales/*.json 双语镜像；缺键时 t() 原样输出键名）：
 * - `error.review.configNotFound` {path}
 * - `error.review.configReadFailed` {path} {detail}
 * - `error.review.configInputInvalid` {detail}
 * - `error.review.configInvalid` {path} {issues}
 * - `error.review.configWriteFailed` {path} {detail}
 *
 * zod 各字段的 issue 文案按仓库既有风格写死中文（参见 src/pack/packyaml.ts），
 * 只作为 formatZodError 摘要的数据部分出现，不单独面向用户，故不走 t()。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { t } from "../i18n/index.js";
import { readDeckManifest } from "../pack/manifest.js";
import { PackError } from "../pack/packyaml.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 审批配置文件名（每图包工作区一份，位于 `.tts/approval/`） */
export const APPROVAL_CONFIG_FILENAME = "approval.config.json";

/** 审批集成目录相对段（相对图包根；`.tts/` 是工具私有区，不作图包内容发布） */
export const APPROVAL_DIR_SEGMENTS = [".tts", "approval"] as const;

/** 审批服务缺省监听地址 / 端口（与审批工具 DEFAULT_RUNTIME 一致） */
export const APPROVAL_DEFAULT_HOST = "127.0.0.1";
export const APPROVAL_DEFAULT_PORT = 8765;

/** 图片素材集的 include / exclude 缺省值（TTS 图包素材全是位图；exclude 与工具默认一致） */
export const APPROVAL_IMAGE_INCLUDE = ["*.png", "*.jpg", "*.jpeg", "*.webp"] as const;
export const APPROVAL_IMAGE_EXCLUDE = ["_*", ".*", "~*"] as const;

// ---------------------------------------------------------------------------
// 类型与 schema
// ---------------------------------------------------------------------------

/** 单个审批素材集条目（与审批工具 sets[] 条目同构，字段名保持其 snake_case） */
export interface ApprovalSetSpec {
  /** 素材集 id（= 审批结果文件 `data/results/<id>.json` 的文件名主干） */
  id: string;
  /** 素材集显示名 */
  name: string;
  /** 源A 根目录（旧版图；绝对 / 相对均可，写出时绝对化） */
  aRoot: string;
  /** 源A 显示标签（可选；缺省空串，审批工具界面回退自己的默认） */
  aLabel?: string;
  /** 源B 根目录（新版渲染；绝对 / 相对均可，写出时绝对化） */
  bRoot: string;
  /** 源B 显示标签（可选） */
  bLabel?: string;
}

/** 单个素材集条目（写出形态，缺省值已填充） */
export interface ApprovalSet {
  /** 素材集 id */
  id: string;
  /** 素材集显示名 */
  name: string;
  /** 素材集类型，恒为 "image"（图包素材是位图对照） */
  type: "image";
  /** 配对方式，恒为 "basename"（按文件名配对——素材 id 即文件名） */
  pair: "basename";
  /** 清单从哪侧取，恒为 "b"（以新版渲染目录为准） */
  items_from: "b";
  /** 源A（旧版图） */
  a: { root: string; label: string };
  /** 源B（新版渲染） */
  b: { root: string; label: string };
  /** 参与审批的文件通配（缺省 {@link APPROVAL_IMAGE_INCLUDE}） */
  include: string[];
  /** 排除的文件通配（缺省 {@link APPROVAL_IMAGE_EXCLUDE}） */
  exclude: string[];
  /** 是否递归子目录；false 保证素材 id 恒为纯文件名 */
  recurse: boolean;
}

/** approval.config.json（写出形态，缺省值已填充） */
export interface ApprovalConfig {
  /** 审批服务监听地址（缺省 127.0.0.1） */
  host: string;
  /** 审批服务监听端口（缺省 8765） */
  port: number;
  /** 启动网页版时是否开浏览器；本工具生成恒为 false（headless 习惯由人自己开） */
  open_browser: boolean;
  /** 审批数据目录（结果 / 缩略图 / pid 落这里；缺省 `<workspaceRoot>/.tts/approval/data`） */
  data_dir: string;
  /** 问题标签（可选；缺省时审批工具用自己的内置默认标签） */
  tags?: string[];
  /** 素材集列表 */
  sets: ApprovalSet[];
}

/** approval.config.json 的 zod schema（严格模式，与 packyaml.ts 同一考虑） */
export const approvalConfigSchema = z.strictObject(
  {
    host: z
      .string({ error: "host 必须是字符串" })
      .min(1, "host 不能为空字符串")
      .default(APPROVAL_DEFAULT_HOST),
    port: z
      .number({ error: "port 必须是数字" })
      .int("port 必须是整数")
      .min(1, "port 不能小于 1")
      .max(65535, "port 不能大于 65535")
      .default(APPROVAL_DEFAULT_PORT),
    open_browser: z.boolean({ error: "open_browser 必须是布尔值" }).default(false),
    data_dir: z.string({ error: "data_dir 必须是字符串" }).min(1, "data_dir 不能为空字符串"),
    tags: z
      .array(z.string({ error: "tags 条目必须是字符串" }).min(1, "tags 条目不能为空字符串"), {
        error: "tags 必须是字符串数组",
      })
      .nonempty("tags 显式给出时不能是空数组（不给该字段即用审批工具默认标签）")
      .optional(),
    sets: z.array(
      z.strictObject(
        {
          id: z.string({ error: "sets[].id 必须是字符串" }).min(1, "sets[].id 不能为空字符串"),
          name: z.string({ error: "sets[].name 必须是字符串" }).min(1, "sets[].name 不能为空字符串"),
          type: z.literal("image", { error: 'sets[].type 必须是 "image"' }),
          pair: z.literal("basename", { error: 'sets[].pair 必须是 "basename"' }),
          items_from: z.literal("b", { error: 'sets[].items_from 必须是 "b"' }),
          a: z.strictObject(
            {
              root: z.string({ error: "sets[].a.root 必须是字符串" }).min(1, "sets[].a.root 不能为空"),
              label: z.string({ error: "sets[].a.label 必须是字符串" }).default(""),
            },
            { error: "sets[].a 必须是 {root, label} 键值对象" },
          ),
          b: z.strictObject(
            {
              root: z.string({ error: "sets[].b.root 必须是字符串" }).min(1, "sets[].b.root 不能为空"),
              label: z.string({ error: "sets[].b.label 必须是字符串" }).default(""),
            },
            { error: "sets[].b 必须是 {root, label} 键值对象" },
          ),
          include: z.array(z.string({ error: "include 条目必须是字符串" }), {
            error: "include 必须是字符串数组",
          }).default([...APPROVAL_IMAGE_INCLUDE]),
          exclude: z.array(z.string({ error: "exclude 条目必须是字符串" }), {
            error: "exclude 必须是字符串数组",
          }).default([...APPROVAL_IMAGE_EXCLUDE]),
          recurse: z.boolean({ error: "recurse 必须是布尔值" }).default(false),
        },
        { error: "sets 条目必须是键值对象" },
      ),
      { error: "sets 必须是素材集条目数组" },
    ),
  },
  { error: "approval.config.json 必须是键值对象" },
);

// ---------------------------------------------------------------------------
// 内部工具（与 packyaml.ts / manifest.ts 的同名内部函数一致，按约定复制粘贴）
// ---------------------------------------------------------------------------

/**
 * 将 zod 校验错误格式化为单行中文可读摘要。
 * @param error zod 校验错误对象
 * @returns 形如 "sets.0.id：不能为空字符串" 的描述，多个问题以"；"连接
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
 * 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT），避免 any。
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
 * 从 unknown 错误中取人类可读描述。
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** REVIEW_CONFIG_INVALID 的统一构造（入参问题，无 path 上下文） */
function configInputInvalid(detail: string): PackError {
  return new PackError("REVIEW_CONFIG_INVALID", t("error.review.configInputInvalid", { detail }));
}

// ---------------------------------------------------------------------------
// setId 校验（gate.ts 复用同一判定，两模块各自抛自己的错误码）
// ---------------------------------------------------------------------------

/**
 * 素材集 id 的合法形式：非空、不含路径分隔符与 Windows 文件名非法字符、
 * 不是 "." / ".."、不含控制字符。
 *
 * setId 直接用作审批结果文件名（`data/results/<setId>.json`），宽松的 id 会
 * 造成路径穿越或落盘失败，故在生成与读取两侧都挡。
 *
 * @param id 待校验的素材集 id
 * @returns 合法返回 true
 */
export function isValidSetId(id: string): boolean {
  return (
    typeof id === "string" &&
    id !== "" &&
    id !== "." &&
    id !== ".." &&
    !/[/\\:<>*?"|]/.test(id) &&
    !/[\x00-\x1f]/.test(id)
  );
}

// ---------------------------------------------------------------------------
// 路径换算
// ---------------------------------------------------------------------------

/**
 * 计算审批配置文件的完整路径。
 * @param packRoot 图包工作区根目录（原样拼接，不做 resolve）
 * @returns `<packRoot>/.tts/approval/approval.config.json`
 */
export function approvalConfigPath(packRoot: string): string {
  return path.join(packRoot, ...APPROVAL_DIR_SEGMENTS, APPROVAL_CONFIG_FILENAME);
}

/**
 * 计算审批数据目录的缺省路径（data_dir 指向本工具工作区内，
 * 不让审批工具往它自己仓库写——方案设计 §13.2）。
 * @param packRoot 图包工作区根目录（原样拼接，不做 resolve）
 * @returns `<packRoot>/.tts/approval/data`
 */
export function approvalDataDir(packRoot: string): string {
  return path.join(packRoot, ...APPROVAL_DIR_SEGMENTS, "data");
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

/** {@link buildApprovalConfig} / {@link writeApprovalConfig} 的入参 */
export interface BuildApprovalConfigOptions {
  /** 素材集条目（单个或数组；至少一个） */
  sets: ApprovalSetSpec | ApprovalSetSpec[];
  /** 问题标签（可选；不给则审批工具用自己内置的默认标签） */
  tags?: string[];
  /** 审批服务监听地址（缺省 {@link APPROVAL_DEFAULT_HOST}） */
  host?: string;
  /** 审批服务监听端口（缺省 {@link APPROVAL_DEFAULT_PORT}） */
  port?: number;
  /** 覆盖 data_dir（一般不用；缺省 `<workspaceRoot>/.tts/approval/data`） */
  dataDir?: string;
}

/**
 * 纯构建 approval.config.json 内容（不落盘）。
 *
 * - data_dir 缺省 `<workspaceRoot>/.tts/approval/data`，并做绝对化；
 * - 素材集的 aRoot / bRoot 绝对化（审批工具把相对路径按配置文件所在目录
 *   解析，绝对路径消除歧义）；
 * - open_browser 恒为 false；
 * - 构建结果不保证过 schema（入参可能非法）——落盘前必须再校验
 *   （{@link writeApprovalConfig} 已做；直接消费返回值的调用方自担）。
 *
 * @param workspaceRoot 本工具工作区根（图包根；data_dir 的锚点）
 * @param opts 素材集与可选覆盖
 * @returns 待写出的配置对象
 * @throws PackError code="REVIEW_CONFIG_INVALID" sets 为空 / 含非法 id /
 *   根目录为空 / tags 为空数组等入参问题时
 */
export function buildApprovalConfig(
  workspaceRoot: string,
  opts: BuildApprovalConfigOptions,
): ApprovalConfig {
  const specs = Array.isArray(opts.sets) ? opts.sets : [opts.sets];
  if (specs.length === 0) {
    throw configInputInvalid("sets 不能为空：至少需要一个素材集条目");
  }

  const sets: ApprovalSet[] = specs.map((spec, index) => {
    const label = `第 ${index + 1} 个素材集`;
    if (!isValidSetId(spec.id)) {
      throw configInputInvalid(
        `${label}的 id 不合法（不能为空，且不得包含路径分隔符或文件名非法字符）：${JSON.stringify(spec.id)}`,
      );
    }
    if (typeof spec.name !== "string" || spec.name.trim() === "") {
      throw configInputInvalid(`${label}（${spec.id}）的 name 不能为空`);
    }
    for (const [side, root] of [["a", spec.aRoot], ["b", spec.bRoot]] as const) {
      if (typeof root !== "string" || root.trim() === "") {
        throw configInputInvalid(`${label}（${spec.id}）的源${side.toUpperCase()}根目录不能为空`);
      }
    }
    return {
      id: spec.id,
      name: spec.name,
      type: "image" as const,
      pair: "basename" as const,
      items_from: "b" as const,
      a: { root: path.resolve(spec.aRoot), label: spec.aLabel ?? "" },
      b: { root: path.resolve(spec.bRoot), label: spec.bLabel ?? "" },
      include: [...APPROVAL_IMAGE_INCLUDE],
      exclude: [...APPROVAL_IMAGE_EXCLUDE],
      recurse: false,
    };
  });

  if (opts.tags !== undefined && (!Array.isArray(opts.tags) || opts.tags.length === 0)) {
    throw configInputInvalid("tags 显式给出时必须是非空字符串数组（不给即用审批工具默认标签）");
  }

  const dataDir = opts.dataDir !== undefined ? path.resolve(opts.dataDir) : path.resolve(approvalDataDir(workspaceRoot));

  const config: ApprovalConfig = {
    host: opts.host ?? APPROVAL_DEFAULT_HOST,
    port: opts.port ?? APPROVAL_DEFAULT_PORT,
    open_browser: false,
    data_dir: dataDir,
    sets,
  };
  if (opts.tags !== undefined) {
    config.tags = [...opts.tags];
  }
  return config;
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

/**
 * 把审批配置写入 `<packRoot>/.tts/approval/approval.config.json`。
 *
 * 写前对内容重新过 schema：绝不落盘审批工具读不懂或读出错误语义的配置
 * （工具侧对未知键静默忽略，错了它不会喊）。序列化用 JSON.stringify
 * （2 空格缩进 + 末尾换行），写前确保父目录存在。
 *
 * @param packRoot 图包工作区根目录（父目录不存在时自动创建）
 * @param opts 构建入参（见 {@link buildApprovalConfig}）
 * @returns 实际写出的配置文件路径与 data_dir
 * @throws PackError code="REVIEW_CONFIG_INVALID" 构建入参不合法或结果不符 schema 时
 * @throws PackError code="REVIEW_CONFIG_WRITE_FAILED" 写文件 IO 失败时
 */
export async function writeApprovalConfig(
  packRoot: string,
  opts: BuildApprovalConfigOptions,
): Promise<{ configPath: string; dataDir: string }> {
  const content = buildApprovalConfig(packRoot, opts);
  const filePath = approvalConfigPath(packRoot);

  const parsed = approvalConfigSchema.safeParse(content);
  if (!parsed.success) {
    throw new PackError(
      "REVIEW_CONFIG_INVALID",
      t("error.review.configInvalid", { path: filePath, issues: formatZodError(parsed.error) }),
    );
  }

  const jsonText = `${JSON.stringify(parsed.data, null, 2)}\n`;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, jsonText, "utf8");
  } catch (err) {
    throw new PackError(
      "REVIEW_CONFIG_WRITE_FAILED",
      t("error.review.configWriteFailed", { path: filePath, detail: errMessage(err) }),
    );
  }
  return { configPath: filePath, dataDir: parsed.data.data_dir };
}

/**
 * 读取并校验审批配置（宽松版：host / port / open_browser 缺省值已填充）。
 *
 * @param configPath approval.config.json 路径
 * @returns 校验通过的配置
 * @throws PackError code="REVIEW_CONFIG_NOT_FOUND" 文件不存在时
 * @throws PackError code="REVIEW_CONFIG_READ_FAILED" 其他 IO 错误时
 * @throws PackError code="REVIEW_CONFIG_INVALID" JSON 解析失败或不符合 schema 时
 */
export async function readApprovalConfig(configPath: string): Promise<ApprovalConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      throw new PackError("REVIEW_CONFIG_NOT_FOUND", t("error.review.configNotFound", { path: configPath }));
    }
    throw new PackError(
      "REVIEW_CONFIG_READ_FAILED",
      t("error.review.configReadFailed", { path: configPath, detail: errMessage(err) }),
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new PackError(
      "REVIEW_CONFIG_INVALID",
      t("error.review.configInvalid", { path: configPath, issues: errMessage(err) }),
    );
  }

  const parsed = approvalConfigSchema.safeParse(data);
  if (!parsed.success) {
    throw new PackError(
      "REVIEW_CONFIG_INVALID",
      t("error.review.configInvalid", { path: configPath, issues: formatZodError(parsed.error) }),
    );
  }
  return parsed.data;
}

/**
 * 读审批配置并额外要求 sets 非空（client / CLI 侧使用）。
 *
 * schema 层面 sets 允许空数组（读旧文件不过度拒绝），但"拿配置去调审批工具"
 * 的场景没有素材集一定是谁的笔误，在此收口为 REVIEW_CONFIG_INVALID。
 *
 * @param configPath approval.config.json 路径
 * @returns 校验通过且至少含一个素材集的配置
 * @throws PackError code="REVIEW_CONFIG_*" 见 {@link readApprovalConfig}
 * @throws PackError code="REVIEW_CONFIG_INVALID" sets 为空数组时
 */
export async function readApprovalConfigStrict(configPath: string): Promise<ApprovalConfig> {
  const config = await readApprovalConfig(configPath);
  if (config.sets.length === 0) {
    throw new PackError(
      "REVIEW_CONFIG_INVALID",
      t("error.review.configInputInvalid", { detail: `配置不含任何素材集：${configPath}` }),
    );
  }
  return config;
}

// ---------------------------------------------------------------------------
// deck.yaml → 审批素材集
// ---------------------------------------------------------------------------

/** {@link approvalSetFromDeck} 的入参（根目录必填——新旧两版目录由调用方决定） */
export interface ApprovalSetFromDeckOptions {
  /** 素材集 id（缺省取 deck 目录名） */
  id?: string;
  /** 素材集显示名（缺省取 deck.yaml 的 name） */
  name?: string;
  /** 源A 根目录（旧版图目录；必填） */
  aRoot: string;
  /** 源A 显示标签（可选） */
  aLabel?: string;
  /** 源B 根目录（新版渲染目录；必填） */
  bRoot: string;
  /** 源B 显示标签（可选） */
  bLabel?: string;
}

/**
 * 从一个 deck 目录构建审批素材集条目（"从 deck.yaml 转一道"的落地）。
 *
 * - 显示名缺省取 deck.yaml 的 name（读不到 deck.yaml 时按调用方显式传名处理，
 *   文件真不存在则抛 DECK_NOT_FOUND，与 manifest.ts 口径一致）；
 * - 素材 id 不在此枚举：审批工具 `pair: "basename"` 直接按两侧目录的文件名
 *   配对，id 与 cards.csv 的 face / back 文件名天然一致（方案设计 §13.2 ①）；
 * - aRoot / bRoot 必须显式给出：哪个目录算"旧版"、哪个算"新版渲染"是使用方
 *   的语义决定，本模块不猜。
 *
 * @param deckDir deck 子目录（含 deck.yaml）
 * @param opts 素材集 id / 显示名覆盖与两个源根目录
 * @returns 审批素材集条目（根目录未绝对化，由 {@link buildApprovalConfig} 统一处理）
 * @throws PackError 透传 readDeckManifest 的 DECK_* 错误码；
 *   id / name / 根目录不合法时 code="REVIEW_CONFIG_INVALID"
 */
export async function approvalSetFromDeck(
  deckDir: string,
  opts: ApprovalSetFromDeckOptions,
): Promise<ApprovalSetSpec> {
  const manifest = await readDeckManifest(deckDir);
  const id = opts.id ?? path.basename(deckDir);
  const name = opts.name ?? manifest.name;

  if (typeof opts.aRoot !== "string" || opts.aRoot.trim() === "") {
    throw configInputInvalid(`素材集（${id}）的源A根目录（aRoot）不能为空`);
  }
  if (typeof opts.bRoot !== "string" || opts.bRoot.trim() === "") {
    throw configInputInvalid(`素材集（${id}）的源B根目录（bRoot）不能为空`);
  }

  return {
    id,
    name,
    aRoot: opts.aRoot,
    aLabel: opts.aLabel,
    bRoot: opts.bRoot,
    bLabel: opts.bLabel,
  };
}
