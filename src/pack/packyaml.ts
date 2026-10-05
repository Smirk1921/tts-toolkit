// src/pack/packyaml.ts
/**
 * pack.yaml：图包元数据清单（每个图包工作区根目录有且仅有一份）。
 *
 * 职责：
 * - 定义 pack.yaml 的 zod schema（严格模式：未知字段与缺失必填字段一律拒绝，防止拼写错误静默生效）；
 * - {@link readPackYaml}：读取 + 校验，失败时抛 {@link PackError}（错误码见下）；
 * - {@link writePackYaml}：写前再校验，`yaml.stringify`（2 空格缩进）落盘，写前确保父目录存在。
 *
 * 错误码（{@link PackError.code}）：
 * - "PACK_NOT_FOUND"    清单文件不存在（`<root>/pack.yaml`）
 * - "PACK_INVALID"      内容不是合法 YAML，或不符合 schema（message 含 zod issues 摘要）；
 *                       writePackYaml 入参不合规时同样抛此码
 * - "PACK_READ_FAILED"  读取清单时发生"文件不存在"以外的 IO 错误（如权限不足）
 * - "PACK_WRITE_FAILED" 写入清单时发生 IO 错误
 *
 * 本模块新增的 i18n 键（locales/*.json 由 Run 2 补齐；缺键时 t() 原样输出键名）：
 * - `error.pack.notFound` {path}
 * - `error.pack.readFailed` {path} {detail}
 * - `error.pack.invalidYaml` {path} {detail}
 * - `error.pack.invalid` {path} {issues}
 * - `error.pack.writeFailed` {path} {detail}
 * - `error.pack.invalidWriteData` {issues}
 *
 * zod 各字段的 issue 文案按仓库既有风格写死中文（参见 src/i18n/index.ts、src/assets/inventory.ts），
 * 只作为 {@link formatZodError} 摘要的数据部分出现，不单独面向用户，故不走 t()。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { t } from "../i18n/index.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 图包清单文件名（每个图包工作区根目录一份） */
export const PACK_YAML_FILENAME = "pack.yaml";

/** 图床类型（host 字段可取值；缺省 "steamcloud"） */
export const PACK_HOSTS = ["steamcloud", "imgur", "gdrive", "dropbox", "custom"] as const;

/**
 * vcs.lfs 可取值。
 *
 * 约束 10：git-lfs 绝不静默降级，init 必须显式三选一（装 / 禁用二次确认 / 取消），
 * 因此该字段没有默认值，缺失即校验失败。
 */
export const PACK_LFS_MODES = ["enabled", "disabled", "disabled-no-lfs"] as const;

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/**
 * 图包模块错误：在普通 Error 上附加机器可读的 code，
 * 供 CLI 与上层模块按错误码分支处理（而不是解析 message 文本）。
 */
export class PackError extends Error {
  /** 机器可读错误码（如 "PACK_NOT_FOUND"，完整取值见模块头注释） */
  readonly code: string;

  /**
   * @param code 机器可读错误码
   * @param message 面向用户的中文描述（调用方应通过 t() 生成）
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = "PackError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

/**
 * 生成严格对象的中文化 error 定制。
 *
 * 为什么不用 zod 默认文案：对未知字段 / 根类型错误，zod 默认 message 是英文，
 * 会原样进入 PACK_INVALID 的用户可见摘要，违反"错误必须中文"的约束。
 *
 * @param label 字段标签（如 "vcs"；根对象用 "pack.yaml"）
 * @returns 可直接传给 zod 对象构造第二参数 error 的定制函数
 */
function strictObjectError(label: string): (issue: z.core.$ZodRawIssue) => string {
  return (issue) => {
    // unrecognized_keys 类 issue 携带 keys: PropertyKey[]；其余（根类型错误）没有
    const keys = (issue as { keys?: unknown }).keys;
    if (Array.isArray(keys)) {
      return `${label} 含有无法识别的字段：${keys.map((key) => String(key)).join("、")}`;
    }
    return `${label} 必须是键值对象`;
  };
}

/**
 * pack.yaml 的 zod schema（严格模式）。
 *
 * 字段一览（与设计文档一致）：
 * - schema_version  literal(1)，必填——结构版本，升级时递增
 * - name            string，必填——图包显示名
 * - workshop_id     number | null，必填——创意工坊 ID，未发布为 null
 * - source_mod      number | null，必填——上游模组 ID，无上游为 null
 * - host            图床枚举，缺省 "steamcloud"
 * - editor          { adapter: "vscode" }，可选——编辑器适配预留
 * - vcs             { lfs: 三选一 }，必填——约束 10，无默认值
 * - paths           { workdir: string }——workdir 缺省 "."
 * - upload          { prefix: string }——prefix 缺省 ""
 * - push            { backup_retention, baseline_check }，可选——阶段 5 写入路径的
 *                   push 子配置：backup_retention 备份保留数（整数 1~100，缺省 20）、
 *                   baseline_check 基线冲突检测开关（缺省 true）。整个节点缺省
 *                   （pack.yaml 不写 push）即视为 { backup_retention: 20, baseline_check: true }，
 *                   向后兼容旧清单；init 的初始模板不需要包含它
 *
 * 严格模式用 z.strictObject（zod 4 写法），与 object(...).strict() 校验行为完全一致。
 */
export const packYamlSchema = z.strictObject(
  {
    schema_version: z.literal(1, { error: "schema_version 必须是 1" }),
    name: z.string({ error: "name 必须是字符串" }),
    workshop_id: z
      .number({ error: "workshop_id 必须是数字或 null" })
      .nullable(),
    source_mod: z
      .number({ error: "source_mod 必须是数字或 null" })
      .nullable(),
    host: z
      .enum(PACK_HOSTS, { error: "host 必须是 steamcloud / imgur / gdrive / dropbox / custom 之一" })
      .default("steamcloud"),
    editor: z
      .strictObject(
        { adapter: z.enum(["vscode"], { error: "editor.adapter 必须是 vscode" }) },
        { error: strictObjectError("editor") },
      )
      .optional(),
    vcs: z.strictObject(
      {
        lfs: z.enum(PACK_LFS_MODES, {
          error: "vcs.lfs 必须是 enabled / disabled / disabled-no-lfs 之一",
        }),
      },
      { error: strictObjectError("vcs") },
    ),
    paths: z.strictObject(
      { workdir: z.string({ error: "paths.workdir 必须是字符串" }).default(".") },
      { error: strictObjectError("paths") },
    ),
    upload: z.strictObject(
      { prefix: z.string({ error: "upload.prefix 必须是字符串" }).default("") },
      { error: strictObjectError("upload") },
    ),
    push: z.optional(
      z.strictObject(
        {
          backup_retention: z
            .number({ error: "push.backup_retention 必须是数字" })
            .int({ error: "push.backup_retention 必须是整数" })
            .min(1, { error: "push.backup_retention 不能小于 1" })
            .max(100, { error: "push.backup_retention 不能大于 100" })
            .default(20),
          baseline_check: z.boolean({ error: "push.baseline_check 必须是布尔值" }).default(true),
        },
        { error: strictObjectError("push") },
      ),
    ),
  },
  { error: strictObjectError("pack.yaml") },
);

/** pack.yaml 校验通过后的数据结构（schema 输出类型，默认值已填充） */
export type PackYaml = z.infer<typeof packYamlSchema>;

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 将 zod 校验错误格式化为单行中文可读摘要。
 * @param error zod 校验错误对象
 * @returns 形如 "vcs.lfs：必须是 enabled / disabled / disabled-no-lfs 之一" 的描述，多个问题以"；"连接
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
 * 从 unknown 错误中取人类可读描述。
 * @param err 任意抛出值
 * @returns Error 取 message，其余用 String() 兜底
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 计算图包清单的完整路径。
 * @param root 图包工作区根目录（绝对 / 相对均可，原样拼接）
 * @returns `<root>/pack.yaml`（路径分隔符跟随平台）
 */
export function packYamlPath(root: string): string {
  return path.join(root, PACK_YAML_FILENAME);
}

/**
 * 读取并校验图包清单。
 *
 * @param root 图包工作区根目录
 * @returns 校验通过、默认值已填充（host / paths.workdir / upload.prefix；push 节点
 *          出现时填充 backup_retention / baseline_check，节点缺省时保持 undefined）的图包元数据
 * @throws PackError code="PACK_NOT_FOUND" 清单文件不存在时
 * @throws PackError code="PACK_INVALID" 内容不是合法 YAML，或不符合 schema 时（message 含问题摘要）
 * @throws PackError code="PACK_READ_FAILED" 读取时发生其他 IO 错误时
 */
export async function readPackYaml(root: string): Promise<PackYaml> {
  const filePath = packYamlPath(root);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      throw new PackError("PACK_NOT_FOUND", t("error.pack.notFound", { path: filePath }));
    }
    throw new PackError(
      "PACK_READ_FAILED",
      t("error.pack.readFailed", { path: filePath, detail: errMessage(err) }),
    );
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new PackError(
      "PACK_INVALID",
      t("error.pack.invalidYaml", { path: filePath, detail: errMessage(err) }),
    );
  }

  const parsed = packYamlSchema.safeParse(data);
  if (!parsed.success) {
    throw new PackError(
      "PACK_INVALID",
      t("error.pack.invalid", { path: filePath, issues: formatZodError(parsed.error) }),
    );
  }
  return parsed.data;
}

/**
 * 把图包元数据写入 `<root>/pack.yaml`（yaml.stringify，2 空格缩进）。
 *
 * 写前会对 data 重新过一遍 schema：调用方可能传入运行时构造的不可信数据，
 * 绝不落盘不合规的清单；重新校验同时把默认值规范化后再序列化。
 *
 * @param root 图包工作区根目录（父目录不存在时自动创建）
 * @param data 待写入的图包元数据
 * @throws PackError code="PACK_INVALID" data 不符合 schema 时（message 含问题摘要）
 * @throws PackError code="PACK_WRITE_FAILED" 写文件发生 IO 错误时
 */
export async function writePackYaml(root: string, data: PackYaml): Promise<void> {
  const filePath = packYamlPath(root);
  const parsed = packYamlSchema.safeParse(data);
  if (!parsed.success) {
    throw new PackError(
      "PACK_INVALID",
      t("error.pack.invalidWriteData", { issues: formatZodError(parsed.error) }),
    );
  }

  const yamlText = stringifyYaml(parsed.data, { indent: 2 });
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, yamlText, "utf8");
  } catch (err) {
    throw new PackError(
      "PACK_WRITE_FAILED",
      t("error.pack.writeFailed", { path: filePath, detail: errMessage(err) }),
    );
  }
}
