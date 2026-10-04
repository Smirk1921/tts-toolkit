// src/pack/manifest.ts
/**
 * deck.yaml 与 assets.yaml：卡牌组清单与素材清单（zod schema + 读写）。
 *
 * 职责：
 * - deck.yaml（每个 decks/<name>/ 子目录一份，{@link DECK_YAML_FILENAME}）：
 *   描述一个卡牌组的显示名、GUID、共享图集的对象列表、卡牌索引 → 图片映射、
 *   以及可选的图集布局（{@link deckManifestSchema}）；
 * - assets.yaml（图包根目录至多一份，{@link ASSETS_YAML_FILENAME}）：
 *   记录图包引用的外部素材（当前 URL、可选 sha256 / 图床类型），
 *   供素材续传 / URL 体检等流程使用（{@link assetsManifestSchema}）；
 * - 读：读取 + YAML 解析 + schema 校验，失败抛 {@link PackError}（错误码见下）；
 * - 写：写前对入参再校验（绝不落盘不合规清单），`yaml.stringify`（2 空格缩进）
 *   落盘，写前确保父目录存在。
 *
 * 与 pack.yaml（packyaml.ts）的分工：pack.yaml 描述图包整体元数据，
 * 本模块只管"每个 deck 一份的 deck.yaml"与"全包一份的 assets.yaml"。
 * 约束 9（objects 与卡牌将来共用同一遍历器，阶段 2B 实现）：本模块只服务
 * decks/ 的 deck.yaml；objects/ 的 data.json 由后续阶段的遍历器另行处理。
 *
 * 字段约定（与设计一致）：
 * - schema_version 为 literal(1)：结构版本，升级时递增；
 * - deck.guid 是 6 位十六进制字符串（对应 TTS 对象 GUID，不区分大小写；
 *   读取时不做大小写归一，原样保留）；
 * - deck.shared_with 缺省为 []（YAML 里省略该键时填充空数组）；
 * - deck.cards[].id 是图集内索引（0～68）；face / back 是相对本 deck 目录的
 *   图片文件名；back 缺省表示使用牌堆默认背面；
 * - deck.atlas 可选；"atlas 列行数是否与图集图片实际尺寸匹配"不在本模块校验
 *   （需要读图片尺寸，留给 pack/build.ts 做）；
 * - assets[].url 是素材当前 URL（可能是死链，本模块不做连通性校验）；
 *   assets[].host / sha256 可选。
 *
 * 错误码（{@link PackError.code}）：
 * - "DECK_NOT_FOUND"       deck 清单文件不存在（`<deckDir>/deck.yaml`）
 * - "DECK_INVALID"         deck.yaml 不是合法 YAML、不符合 schema，
 *                          或 writeDeckManifest 入参不合规（message 含问题摘要）
 * - "DECK_READ_FAILED"     读取 deck.yaml 时发生"文件不存在"以外的 IO 错误
 * - "DECK_WRITE_FAILED"    写入 deck.yaml 时发生 IO 错误
 * - "ASSETS_INVALID"       assets.yaml 不是合法 YAML、不符合 schema，
 *                          或 writeAssetsManifest 入参不合规（message 含问题摘要）
 * - "ASSETS_READ_FAILED"   读取 assets.yaml 时发生"文件不存在"以外的 IO 错误
 *                          （文件不存在时 readAssetsManifest 返回 null，不报错）
 * - "ASSETS_WRITE_FAILED"  写入 assets.yaml 时发生 IO 错误
 *
 * 本模块新增的 i18n 键（locales/*.json 由 Run 2 补齐；缺键时 t() 原样输出键名）：
 * - `error.pack.deckNotFound` {path}
 * - `error.pack.deckReadFailed` {path} {detail}
 * - `error.pack.deckInvalidYaml` {path} {detail}
 * - `error.pack.deckInvalid` {path} {issues}
 * - `error.pack.deckInvalidWriteData` {issues}
 * - `error.pack.deckWriteFailed` {path} {detail}
 * - `error.pack.assetsReadFailed` {path} {detail}
 * - `error.pack.assetsInvalidYaml` {path} {detail}
 * - `error.pack.assetsInvalid` {path} {issues}
 * - `error.pack.assetsInvalidWriteData` {issues}
 * - `error.pack.assetsWriteFailed` {path} {detail}
 *
 * zod 各字段的 issue 文案按仓库既有风格写死中文（与 packyaml.ts 的决定一致，
 * 参见 src/i18n/index.ts、src/assets/inventory.ts），只作为 {@link formatZodError}
 * 摘要的数据部分出现，不单独面向用户，故不走 t()。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { t } from "../i18n/index.js";
import { PackError } from "./packyaml.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** deck 清单文件名（每个 decks/<name>/ 子目录一份） */
export const DECK_YAML_FILENAME = "deck.yaml";

/** 素材清单文件名（图包根目录至多一份） */
export const ASSETS_YAML_FILENAME = "assets.yaml";

/** deck GUID 的合法形式：6 位十六进制字符（不区分大小写） */
const GUID_PATTERN = /^[0-9a-f]{6}$/i;

/** 图集边长可取值（字符串形式；与 TTS 自定义图集的常用规格一致） */
const ATLAS_SIZES = ["512", "1024", "2048", "4096"] as const;

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

/**
 * 生成严格对象的中文化 error 定制（与 packyaml.ts 的同名内部函数一致）。
 *
 * 为什么不用 zod 默认文案：对未知字段 / 根类型错误，zod 默认 message 是英文，
 * 会原样进入 DECK_INVALID / ASSETS_INVALID 的用户可见摘要，违反"错误必须中文"的约束。
 *
 * @param label 对象标签（如 "atlas"；根对象用 "deck.yaml 根"）
 * @returns 可直接传给 zod 对象构造第二参数 error 的定制函数
 */
function strictObjectError(label: string): (issue: z.core.$ZodRawIssue) => string {
  return (issue) => {
    // unrecognized_keys 类 issue 携带 keys: PropertyKey[]；其余（根类型错误）没有
    const keys = (issue as { keys?: unknown }).keys;
    if (Array.isArray(keys)) {
      return `${label}含有无法识别的字段：${keys.map((key) => String(key)).join("、")}`;
    }
    return `${label}必须是键值对象`;
  };
}

/**
 * deck.cards[] 单张卡牌条目的 schema（严格模式）。
 *
 * - id：图集内索引，0～68 的整数（设计约定上限 68）；
 * - face：卡牌正面图片文件名（相对本 deck 目录）；
 * - back：自定义背面文件名，缺省用牌堆默认背面；
 * - name / nickname：卡牌名 / 别名，均可缺省。
 */
const deckCardSchema = z.strictObject(
  {
    id: z
      .number({ error: "卡牌 id 必须是数字" })
      .int("卡牌 id 必须是整数")
      .min(0, "卡牌 id 不能小于 0")
      .max(68, "卡牌 id 不能大于 68"),
    face: z.string({ error: "卡牌 face 必须是字符串" }),
    back: z.string({ error: "卡牌 back 必须是字符串" }).optional(),
    name: z.string({ error: "卡牌 name 必须是字符串" }).optional(),
    nickname: z.string({ error: "卡牌 nickname 必须是字符串" }).optional(),
  },
  { error: strictObjectError("卡牌条目") },
);

/**
 * deck.atlas 图集布局的 schema（严格模式，整块可选）。
 *
 * size 是字符串形式的图集边长（YAML 里必须带引号写作 "1024"，
 * 裸写 1024 会被当成数字而校验失败——防止 512/2048 这类值静默变类型）。
 * 列行数与图集图片实际尺寸是否匹配由 pack/build.ts 校验，本 schema 只管类型与范围。
 */
const atlasSchema = z.strictObject(
  {
    size: z.enum(ATLAS_SIZES, {
      error: '图集边长必须是 "512" / "1024" / "2048" / "4096" 之一（字符串形式）',
    }),
    columns: z
      .number({ error: "图集列数必须是数字" })
      .int("图集列数必须是整数")
      .min(1, "图集列数不能小于 1")
      .max(10, "图集列数不能大于 10"),
    rows: z
      .number({ error: "图集行数必须是数字" })
      .int("图集行数必须是整数")
      .min(1, "图集行数不能小于 1")
      .max(7, "图集行数不能大于 7"),
  },
  { error: strictObjectError("atlas") },
);

/**
 * deck.yaml 的 zod schema（严格模式：未知字段与缺失必填字段一律拒绝，
 * 防止手改 YAML 时的拼写错误静默生效）。
 *
 * 字段一览：
 * - schema_version  literal(1)，必填——结构版本
 * - name            string，必填——牌堆显示名
 * - guid            6 位十六进制字符串，必填——牌堆对象 GUID
 * - shared_with     string[]，缺省 []——共享此图集的其他对象 GUID 列表
 * - cards           卡牌条目数组，必填——见 {@link deckCardSchema}
 * - atlas           图集布局，可选——见 {@link atlasSchema}
 *
 * 严格模式用 z.strictObject（zod 4 写法），与 object(...).strict() 校验行为完全一致。
 */
const deckManifestSchema = z.strictObject(
  {
    schema_version: z.literal(1, { error: "schema_version 必须是 1" }),
    name: z.string({ error: "name 必须是字符串" }),
    guid: z
      .string({ error: "guid 必须是字符串" })
      .regex(GUID_PATTERN, "guid 必须是 6 位十六进制字符串（0-9a-f，不区分大小写）"),
    shared_with: z.array(
      z.string({ error: "shared_with 条目必须是字符串" }),
      { error: "shared_with 必须是字符串数组" },
    ).default([]),
    cards: z.array(deckCardSchema, { error: "cards 必须是卡牌条目数组" }),
    atlas: atlasSchema.optional(),
  },
  { error: strictObjectError("deck.yaml 根") },
);

/** deck.yaml 校验通过后的数据结构（schema 输出类型，shared_with 缺省已填充为 []） */
export type DeckManifest = z.infer<typeof deckManifestSchema>;

/**
 * assets.yaml 单条素材条目的 schema（严格模式）。
 *
 * - file：素材在图包内的落盘路径（相对图包根）；
 * - url：素材当前 URL（可能是死链；只校验 URL 形式，不校验连通性）；
 * - sha256：素材内容哈希（可选，供续传 / 比对）；
 * - host：图床类型（可选）。
 */
const assetEntrySchema = z.strictObject(
  {
    file: z.string({ error: "素材 file 必须是字符串" }),
    url: z
      .string({ error: "素材 url 必须是字符串" })
      .url("素材 url 必须是合法 URL"),
    sha256: z.string({ error: "素材 sha256 必须是字符串" }).optional(),
    host: z.enum(["steamcloud", "imgur", "gdrive", "dropbox", "custom"], {
      error: "素材 host 必须是 steamcloud / imgur / gdrive / dropbox / custom 之一",
    }).optional(),
  },
  { error: strictObjectError("素材条目") },
);

/**
 * assets.yaml 的 zod schema（严格模式；图包根目录至多一份，可不存在）。
 *
 * 字段一览：
 * - schema_version  literal(1)，必填——结构版本
 * - assets          素材条目数组，必填（可以为空数组）——见 {@link assetEntrySchema}
 */
const assetsManifestSchema = z.strictObject(
  {
    schema_version: z.literal(1, { error: "schema_version 必须是 1" }),
    assets: z.array(assetEntrySchema, { error: "assets 必须是素材条目数组" }),
  },
  { error: strictObjectError("assets.yaml 根") },
);

/** assets.yaml 校验通过后的数据结构（schema 输出类型） */
export type AssetsManifest = z.infer<typeof assetsManifestSchema>;

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 将 zod 校验错误格式化为单行中文可读摘要。
 * @param error zod 校验错误对象
 * @returns 形如 "cards.0.id：卡牌 id 不能大于 68" 的描述，多个问题以"；"连接
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

/**
 * 校验目录入参（防止空串被 path.join 静默解析成相对 cwd 的路径）。
 * （与 src/pack/layout.ts 的 assertRoot 同一考虑；属于调用方编程错误，
 * 按仓库惯例抛普通中文 Error 而不是 PackError。）
 * @param dir 目录路径
 * @param argName 入参名（用于错误信息）
 * @throws dir 不是非空字符串时抛出中文错误
 */
function assertDirPath(dir: string, argName: string): void {
  if (typeof dir !== "string" || dir.trim() === "") {
    throw new Error(`pack 清单入参无效：${argName} 必须是非空字符串路径`);
  }
}

/**
 * 计算 deck 清单的完整路径。
 * @param deckDir deck 子目录（绝对 / 相对均可，原样拼接，不做 resolve）
 * @returns `<deckDir>/deck.yaml`（路径分隔符跟随平台）
 */
function deckYamlPath(deckDir: string): string {
  return path.join(deckDir, DECK_YAML_FILENAME);
}

/**
 * 计算素材清单的完整路径。
 * @param root 图包根目录（绝对 / 相对均可，原样拼接，不做 resolve）
 * @returns `<root>/assets.yaml`（路径分隔符跟随平台）
 */
function assetsYamlPath(root: string): string {
  return path.join(root, ASSETS_YAML_FILENAME);
}

/**
 * 读取清单文件并解析为 unknown（schema 校验由调用方负责）。
 * @param file 清单文件完整路径
 * @param codes IO / YAML 错误的错误码与 i18n 键（调用方按 deck / assets 各自传入）
 * @returns YAML 解析结果；文件不存在（ENOENT）时返回 undefined，
 *   由调用方决定抛 DECK_NOT_FOUND 还是返回 null
 * @throws PackError 读取发生非 ENOENT 的 IO 错误（codes.read），
 *   或内容不是合法 YAML（codes.yaml）时
 */
async function readManifestYaml(
  file: string,
  codes: { read: string; readKey: string; yaml: string; yamlKey: string },
): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return undefined;
    }
    throw new PackError(codes.read, t(codes.readKey, { path: file, detail: errMessage(err) }));
  }

  try {
    return parseYaml(raw);
  } catch (err) {
    throw new PackError(codes.yaml, t(codes.yamlKey, { path: file, detail: errMessage(err) }));
  }
}

/**
 * 对 YAML 解析结果做 schema 校验。
 * @param schema 目标 schema
 * @param data YAML 解析结果（unknown）
 * @param code 校验失败时的 PackError 错误码
 * @param key 校验失败时的 i18n 键
 * @param file 清单文件完整路径（用于错误信息）
 * @returns 校验通过、缺省值已填充的数据
 * @throws PackError code=code 数据不符合 schema 时（message 含问题摘要）
 */
function validateManifest<T>(
  schema: z.ZodType<T>,
  data: unknown,
  code: string,
  key: string,
  file: string,
): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new PackError(code, t(key, { path: file, issues: formatZodError(parsed.error) }));
  }
  return parsed.data;
}

/**
 * 把校验通过的数据序列化并写入清单文件（yaml.stringify，2 空格缩进）。
 *
 * `yaml.stringify` 会省略值为 undefined 的键（避免落盘 `back: null`
 * 导致下一次读取校验失败），并保证序列化结果总是合法 YAML。
 *
 * @param file 清单文件完整路径（父目录不存在时自动创建）
 * @param data 已通过 schema 校验的数据
 * @param codes 写入错误的错误码与 i18n 键
 * @throws PackError code=codes.code 写文件发生 IO 错误时
 */
async function writeManifestYaml(
  file: string,
  data: unknown,
  codes: { code: string; key: string },
): Promise<void> {
  const yamlText = stringifyYaml(data, { indent: 2 });
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, yamlText, "utf8");
  } catch (err) {
    throw new PackError(codes.code, t(codes.key, { path: file, detail: errMessage(err) }));
  }
}

// ---------------------------------------------------------------------------
// 导出函数：deck.yaml
// ---------------------------------------------------------------------------

/**
 * 读取并校验 deck 清单。
 *
 * @param deckDir deck 子目录（即 decks/<name>/，绝对 / 相对均可，原样拼接不做 resolve）
 * @returns 校验通过、缺省值已填充（shared_with 缺省为 []）的 deck 清单
 * @throws PackError code="DECK_NOT_FOUND" `<deckDir>/deck.yaml` 不存在时
 * @throws PackError code="DECK_INVALID" 内容不是合法 YAML，或不符合 schema 时（message 含问题摘要）
 * @throws PackError code="DECK_READ_FAILED" 读取时发生其他 IO 错误时
 * @throws Error deckDir 不是非空字符串时（调用方编程错误）
 */
export async function readDeckManifest(deckDir: string): Promise<DeckManifest> {
  assertDirPath(deckDir, "deckDir");
  const filePath = deckYamlPath(deckDir);
  const data = await readManifestYaml(filePath, {
    read: "DECK_READ_FAILED",
    readKey: "error.pack.deckReadFailed",
    yaml: "DECK_INVALID",
    yamlKey: "error.pack.deckInvalidYaml",
  });
  if (data === undefined) {
    throw new PackError("DECK_NOT_FOUND", t("error.pack.deckNotFound", { path: filePath }));
  }
  return validateManifest(deckManifestSchema, data, "DECK_INVALID", "error.pack.deckInvalid", filePath);
}

/**
 * 把 deck 清单写入 `<deckDir>/deck.yaml`（yaml.stringify，2 空格缩进）。
 *
 * 写前会对 manifest 重新过一遍 schema：调用方可能传入运行时构造的不可信数据，
 * 绝不落盘不合规的清单；重新校验同时把缺省值规范化后再序列化。
 *
 * @param deckDir deck 子目录（不存在时自动逐级创建）
 * @param manifest 待写入的 deck 清单
 * @throws PackError code="DECK_INVALID" manifest 不符合 schema 时（message 含问题摘要）
 * @throws PackError code="DECK_WRITE_FAILED" 写文件发生 IO 错误时
 * @throws Error deckDir 不是非空字符串时（调用方编程错误）
 */
export async function writeDeckManifest(deckDir: string, manifest: DeckManifest): Promise<void> {
  assertDirPath(deckDir, "deckDir");
  const filePath = deckYamlPath(deckDir);
  const parsed = deckManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new PackError(
      "DECK_INVALID",
      t("error.pack.deckInvalidWriteData", { issues: formatZodError(parsed.error) }),
    );
  }
  await writeManifestYaml(filePath, parsed.data, {
    code: "DECK_WRITE_FAILED",
    key: "error.pack.deckWriteFailed",
  });
}

// ---------------------------------------------------------------------------
// 导出函数：assets.yaml
// ---------------------------------------------------------------------------

/**
 * 读取并校验素材清单。
 *
 * 与 {@link readDeckManifest} 不同：assets.yaml 在图包根目录是可选项
 * （图包可以完全不引用外部素材），因此文件不存在时返回 null 而不是报错。
 *
 * @param root 图包根目录（绝对 / 相对均可，原样拼接不做 resolve）
 * @returns 校验通过、缺省值已填充的素材清单；`<root>/assets.yaml` 不存在时返回 null
 * @throws PackError code="ASSETS_INVALID" 内容不是合法 YAML，或不符合 schema 时（message 含问题摘要）
 * @throws PackError code="ASSETS_READ_FAILED" 读取时发生其他 IO 错误时
 * @throws Error root 不是非空字符串时（调用方编程错误）
 */
export async function readAssetsManifest(root: string): Promise<AssetsManifest | null> {
  assertDirPath(root, "root");
  const filePath = assetsYamlPath(root);
  const data = await readManifestYaml(filePath, {
    read: "ASSETS_READ_FAILED",
    readKey: "error.pack.assetsReadFailed",
    yaml: "ASSETS_INVALID",
    yamlKey: "error.pack.assetsInvalidYaml",
  });
  if (data === undefined) {
    return null;
  }
  return validateManifest(assetsManifestSchema, data, "ASSETS_INVALID", "error.pack.assetsInvalid", filePath);
}

/**
 * 把素材清单写入 `<root>/assets.yaml`（yaml.stringify，2 空格缩进）。
 *
 * 写前会对 manifest 重新过一遍 schema：调用方可能传入运行时构造的不可信数据，
 * 绝不落盘不合规的清单；重新校验同时把缺省值规范化后再序列化。
 *
 * @param root 图包根目录（不存在时自动逐级创建）
 * @param manifest 待写入的素材清单
 * @throws PackError code="ASSETS_INVALID" manifest 不符合 schema 时（message 含问题摘要）
 * @throws PackError code="ASSETS_WRITE_FAILED" 写文件发生 IO 错误时
 * @throws Error root 不是非空字符串时（调用方编程错误）
 */
export async function writeAssetsManifest(root: string, manifest: AssetsManifest): Promise<void> {
  assertDirPath(root, "root");
  const filePath = assetsYamlPath(root);
  const parsed = assetsManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new PackError(
      "ASSETS_INVALID",
      t("error.pack.assetsInvalidWriteData", { issues: formatZodError(parsed.error) }),
    );
  }
  await writeManifestYaml(filePath, parsed.data, {
    code: "ASSETS_WRITE_FAILED",
    key: "error.pack.assetsWriteFailed",
  });
}
