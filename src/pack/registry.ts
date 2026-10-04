// src/pack/registry.ts
/**
 * .registry.yaml：多图包索引（packs_root 级注册表，B3 阶段 2C）。
 *
 * 位置与作用：
 * - 位于 `<packs_root>/.registry.yaml`（packs_root 是"图包根目录"，下面挂多个图包子目录）；
 * - 记录所有图包的索引（目录名、显示名、类型、上游同步状态、分支、图床、统计、LFS 状态），
 *   供 `tts pack list / status / open` 等命令使用；
 * - `lfs_status` 冗余自各图包 pack.yaml 的 vcs.lfs（读注册表不必逐包开 pack.yaml）；
 *   两者不一致时以 pack.yaml 为准（一致性由上层同步流程维护，本模块不做交叉校验）。
 *
 * 职责：
 * - 定义 .registry.yaml 的 zod schema（严格模式：未知字段与缺失必填字段一律拒绝，
 *   防止手改 YAML 时的拼写错误静默生效）；
 * - {@link readRegistry}：读取 + 校验；**文件不存在时容错**——返回空注册表
 *   （`{ schema_version: 1, packs: [] }`）而不是抛错，让"第一个图包还没登记"是正常状态；
 * - {@link writeRegistry}：写前对入参再校验（绝不落盘不合规数据），`yaml.stringify`
 *   （2 空格缩进）+ **writeFile 到临时文件后 rename 原子替换**（防半写）；
 * - {@link upsertPack} / {@link removePack}：带**乐观锁并发写保护**（设计搁置项 S6）——
 *   读时记录 mtime，写盘前重新 stat，mtime 变了抛 {@link PackError} code="REGISTRY_CONFLICT"；
 * - {@link findPack}：按 dir 查找，找不到返回 null（不抛错）。
 *
 * upsert 语义：
 * - `dir` 已存在 → 原位替换整行；不存在 → 追加到末尾；
 * - `modified` 字段：`entry.modified` 为**空字符串 ""** 表示"由本模块处理"——
 *   替换时保留原条目的 modified，新增时填当天 UTC 日期；非空值一律视为调用方
 *   显式指定，原样写入（调用方从旧条目展开后原样带上 modified，也能达到保留效果）。
 *
 * 乐观锁流程（upsertPack / removePack 共用 {@link updateRegistry}，S6）：
 * 1. 取基线：**本进程最近一次"读取事件"记录的 mtime**——readRegistry / findPack
 *   （后者走前者）每次读取都记录所见 mtime；writeRegistry / upsert / remove 成功
 *   写入后把基线刷新为写完的 mtime（否则会把自己上一次的写误判成冲突）。基线是
 *   进程内状态（{@link knownMtimeByPath}）：S6 的冲突语义是"自我上次读取之后文件
 *   有没有被别人动过"，基线必须来自调用之前的读取事件，upsert / remove 自己的
 *   内部读取只取内容、**不刷新基线**（否则读-写窗口内的外部改动会被自己的读取
 *   掩盖）。本进程从未读过时现取基线（文件不存在视为 0），退化为仅调用内竞态保护。
 *   局限：其他进程不共享本表，但检测依然有效——比对的是磁盘当前 mtime；
 * 2. 读 .registry.yaml，在解析后的 Registry 上原地 mutate（不 deep clone，与 patch.ts 同一风格）；
 * 3. 校验 + 序列化（不过 schema 抛 REGISTRY_INVALID，绝不落盘）；
 * 4. 写盘前重新 stat：磁盘当前 mtime 与基线不一致（含"读后在写前被删 / 被改"与
 *   "读时无、写前被人建"两种竞态）→ 抛 REGISTRY_CONFLICT，**一个字节都不写**；
 * 5. mtime 一致才 writeFile 临时文件 + rename 原子替换，随后把写完的 mtime 记为新基线。
 *
 * 错误码（{@link PackError.code}）：
 * - "REGISTRY_NOT_FOUND"     注册表文件不存在。**当前 API 不会抛此码**：readRegistry 对
 *                            缺文件容错返回空表（upsert / remove 同样把缺文件当空表起建）。
 *                            该码保留给将来"要求注册表必须已存在"的调用方区分两种状态
 * - "REGISTRY_INVALID"       内容不是合法 YAML、不符合 schema，或 writeRegistry /
 *                            upsertPack 的入参不合规（message 含问题摘要）
 * - "REGISTRY_READ_FAILED"   读取注册表时发生"文件不存在"以外的 IO 错误（如权限不足）
 * - "REGISTRY_WRITE_FAILED"  写入注册表时发生 IO 错误
 * - "REGISTRY_CONFLICT"      乐观锁冲突：读之后文件 mtime 被其他进程改动（S6）
 * - "REGISTRY_PACK_NOT_FOUND" removePack 找不到指定 dir 的条目（findPack 找不到返回 null，不抛）
 *
 * i18n：按 B3 窗口约定，模块内部错误消息写死中文、不走 t()（与 B1/B2 的 t() + 键位风格
 * 不同是有意为之——B3 模块不再向 locales/*.json 增加键，CLI 层展示时自行用 t() 包装）。
 * zod 各字段的 issue 文案同样写死中文，只作为 REGISTRY_INVALID 摘要的数据部分出现。
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { PACK_HOSTS, PACK_LFS_MODES, PackError } from "./packyaml.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 多图包索引文件名（位于 packs_root 根目录，管理其下所有图包子目录） */
export const REGISTRY_FILENAME = ".registry.yaml";

/** 图包类型（kind 字段可取值） */
export const PACK_KINDS = ["original", "localization", "modification"] as const;

/** 图包类型 */
export type PackKind = (typeof PACK_KINDS)[number];

/** 图床类型（复用 pack.yaml 的 host 枚举，不重复定义取值） */
export type PackHost = (typeof PACK_HOSTS)[number];

/** git-lfs 状态（冗余自 pack.yaml 的 vcs.lfs，取值完全一致） */
export type LfsStatus = (typeof PACK_LFS_MODES)[number];

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/** 上游同步信息（upstream 为 null 表示本地原创包，没有工坊来源） */
export interface UpstreamInfo {
  /** 创意工坊 ID（正整数） */
  workshop_id: number;
  /** 最近一次与上游同步的日期（ISO 日期字符串 YYYY-MM-DD） */
  last_synced: string;
  /** 同步时上游对应的本地 git 提交（短哈希或完整哈希均可，非空字符串） */
  local_commit: string;
}

/** 图包规模统计（计数器允许 0——刚 init 完的空包也要能登记） */
export interface PackStats {
  /** 卡牌组数量 */
  decks: number;
  /** 卡牌总数量 */
  cards: number;
  /** 脚本文件数量 */
  scripts: number;
}

/** 注册表中单个图包的条目 */
export interface PackEntry {
  /** 相对 packs_root 的一级子目录名（不允许含路径分隔符，不允许 . / ..） */
  dir: string;
  /** 图包显示名 */
  name: string;
  /** 图包类型 */
  kind: PackKind;
  /** 上游同步信息；null 表示本地包 */
  upstream: UpstreamInfo | null;
  /** 当前 git 分支名 */
  branch: string;
  /** 图床类型（复用 PACK_HOSTS 枚举） */
  host: PackHost;
  /** 最近修改日期（ISO 日期字符串 YYYY-MM-DD；upsert 时传 "" 表示由本模块按 upsert 语义处理） */
  modified: string;
  /** 规模统计 */
  stats: PackStats;
  /** git-lfs 状态（冗余自 pack.yaml 的 vcs.lfs） */
  lfs_status: LfsStatus;
}

/** .registry.yaml 校验通过后的数据结构 */
export interface Registry {
  /** 结构版本，升级时递增 */
  schema_version: 1;
  /** 图包条目列表（可以为空数组） */
  packs: PackEntry[];
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

/**
 * 生成严格对象的中文化 error 定制（与 packyaml.ts / manifest.ts 的同名内部函数一致）。
 *
 * 为什么不用 zod 默认文案：对未知字段 / 根类型错误，zod 默认 message 是英文，
 * 会原样进入 REGISTRY_INVALID 的用户可见摘要，违反"错误必须中文"的约束。
 *
 * @param label 字段标签（如 "upstream"；根对象用 ".registry.yaml 根"）
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

/** ISO 日期字符串（YYYY-MM-DD）形式校验；是否为真实存在的日期不做语义检查 */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 一级子目录名：不含任何路径分隔符（Windows 的 \\ 与 POSIX 的 / 都禁止） */
const DIR_SEGMENT_PATTERN = /^[^/\\]+$/;

/**
 * 上游同步信息的 schema（严格模式）。
 */
const upstreamSchema = z.strictObject(
  {
    workshop_id: z
      .number({ error: "upstream.workshop_id 必须是数字" })
      .int("upstream.workshop_id 必须是整数")
      .positive("upstream.workshop_id 必须是正整数"),
    last_synced: z
      .string({ error: "upstream.last_synced 必须是字符串" })
      .regex(ISO_DATE_PATTERN, "upstream.last_synced 必须是 ISO 日期字符串（YYYY-MM-DD）"),
    local_commit: z
      .string({ error: "upstream.local_commit 必须是字符串" })
      .min(1, "upstream.local_commit 不能为空字符串"),
  },
  { error: strictObjectError("upstream") },
);

/**
 * 规模统计的 schema（严格模式；计数器非负整数——0 表示空包，是合法状态）。
 */
const statsSchema = z.strictObject(
  {
    decks: z
      .number({ error: "stats.decks 必须是数字" })
      .int("stats.decks 必须是整数")
      .min(0, "stats.decks 不能为负数"),
    cards: z
      .number({ error: "stats.cards 必须是数字" })
      .int("stats.cards 必须是整数")
      .min(0, "stats.cards 不能为负数"),
    scripts: z
      .number({ error: "stats.scripts 必须是数字" })
      .int("stats.scripts 必须是整数")
      .min(0, "stats.scripts 不能为负数"),
  },
  { error: strictObjectError("stats") },
);

/**
 * 单个图包条目的 schema（严格模式）。
 *
 * dir 只允许一级子目录名：注册表是 packs_root 下挂包的索引，dir 含 / 或 \\、
 * 或为 . / .. 时按它拼路径会逃出 packs_root（或指向 packs_root 本身），一律拒绝。
 */
const packEntrySchema = z.strictObject(
  {
    dir: z
      .string({ error: "dir 必须是字符串" })
      .min(1, "dir 不能为空字符串")
      .regex(DIR_SEGMENT_PATTERN, "dir 必须是相对 packs_root 的一级子目录名（不能含 / 或 \\）")
      .refine((dir) => dir !== "." && dir !== "..", "dir 不能是 . 或 .."),
    name: z
      .string({ error: "name 必须是字符串" })
      .min(1, "name 不能为空字符串"),
    kind: z.enum(PACK_KINDS, {
      error: "kind 必须是 original / localization / modification 之一",
    }),
    upstream: upstreamSchema.nullable(),
    branch: z
      .string({ error: "branch 必须是字符串" })
      .min(1, "branch 不能为空字符串"),
    host: z.enum(PACK_HOSTS, {
      error: "host 必须是 steamcloud / imgur / gdrive / dropbox / custom 之一",
    }),
    modified: z
      .string({ error: "modified 必须是字符串" })
      .regex(ISO_DATE_PATTERN, "modified 必须是 ISO 日期字符串（YYYY-MM-DD）"),
    stats: statsSchema,
    lfs_status: z.enum(PACK_LFS_MODES, {
      error: "lfs_status 必须是 enabled / disabled / disabled-no-lfs 之一",
    }),
  },
  { error: strictObjectError("图包条目") },
);

/**
 * .registry.yaml 的 zod schema（严格模式）。
 *
 * 字段一览：
 * - schema_version  literal(1)，必填——结构版本
 * - packs           图包条目数组，必填（可以为空数组）——见 {@link packEntrySchema}
 */
const registrySchema = z.strictObject(
  {
    schema_version: z.literal(1, { error: "schema_version 必须是 1" }),
    packs: z.array(packEntrySchema, { error: "packs 必须是图包条目数组" }),
  },
  { error: strictObjectError(".registry.yaml 根") },
);

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 编译期断言两个类型完全一致（双向 assignable），不一致时使用处的赋值编译失败。
 * 用于锁定"schema 推断类型 === 导出接口"，防止两边各自漂移。
 */
type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// schema ↔ 导出接口一致性自检（无运行时开销；任一侧漂移即 npm run build 失败）
const _checkUpstream: SameType<z.infer<typeof upstreamSchema>, UpstreamInfo> = true;
const _checkStats: SameType<z.infer<typeof statsSchema>, PackStats> = true;
const _checkEntry: SameType<z.infer<typeof packEntrySchema>, PackEntry> = true;
const _checkRegistry: SameType<z.infer<typeof registrySchema>, Registry> = true;

/**
 * 将 zod 校验错误格式化为单行中文可读摘要（与 packyaml.ts 的同名内部函数一致）。
 * @param error zod 校验错误对象
 * @returns 形如 "packs.0.kind：必须是 … 之一" 的描述，多个问题以"；"连接
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

/** 空注册表（每次调用返回新对象，调用方可安全持有 / 原地 mutate） */
function emptyRegistry(): Registry {
  return { schema_version: 1, packs: [] };
}

/**
 * 解析并校验注册表 YAML 文本。
 * @param filePath 注册表完整路径（只用于错误消息）
 * @param raw 文件原始文本
 * @returns 校验通过的注册表
 * @throws PackError code="REGISTRY_INVALID" 不是合法 YAML 或不符合 schema 时
 */
function parseRegistry(filePath: string, raw: string): Registry {
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new PackError(
      "REGISTRY_INVALID",
      `注册表不是合法 YAML：${filePath}（${errMessage(err)}）`,
    );
  }
  const parsed = registrySchema.safeParse(data);
  if (!parsed.success) {
    throw new PackError(
      "REGISTRY_INVALID",
      `注册表不符合 schema：${filePath}（${formatZodError(parsed.error)}）`,
    );
  }
  return parsed.data;
}

/**
 * 校验注册表数据并序列化为 YAML 文本（写前防线：绝不落盘不合规数据）。
 * @param reg 待写入的注册表数据
 * @returns 2 空格缩进的 YAML 文本
 * @throws PackError code="REGISTRY_INVALID" 数据不符合 schema 时
 */
function serializeRegistry(reg: Registry): string {
  const parsed = registrySchema.safeParse(reg);
  if (!parsed.success) {
    throw new PackError(
      "REGISTRY_INVALID",
      `待写入的注册表数据不符合 schema（${formatZodError(parsed.error)}）`,
    );
  }
  return stringifyYaml(parsed.data, { indent: 2 });
}

/**
 * stat 文件取 mtime（毫秒）；文件不存在返回 null（调用方按 0 处理）。
 * @param filePath 目标文件
 * @returns mtime 毫秒数；文件不存在时 null
 * @throws PackError code="REGISTRY_READ_FAILED" 发生 ENOENT 以外的 IO 错误时
 */
async function statMtimeOrNull(filePath: string): Promise<number | null> {
  try {
    const st = await stat(filePath);
    return st.mtimeMs;
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return null;
    }
    throw new PackError(
      "REGISTRY_READ_FAILED",
      `读取注册表失败：${filePath}（${errMessage(err)}）`,
    );
  }
}

/**
 * 乐观锁基线表（S6）：本进程最近一次"读取 / 写入事件"看到的各注册表 mtime。
 * key 为注册表完整路径，value 为 mtime 毫秒（文件不存在记 0）。
 * 语义与生命周期见模块头注释"乐观锁流程"第 1 条；按路径分键是为了同一进程
 * 管理多个 packs_root 时互不干扰。
 */
const knownMtimeByPath = new Map<string, number>();

/**
 * 写入成功后刷新基线为写完的 mtime，避免把自己这次写判成下一次的冲突。
 * 收尾 stat 意外失败时不抛错（写入本身已成功），只丢弃基线——下次操作
 * 会退化为现取基线，最多少一层保护，绝不误报。
 * @param filePath 刚写完的注册表完整路径
 */
async function recordWrittenMtime(filePath: string): Promise<void> {
  try {
    const mtime = await statMtimeOrNull(filePath);
    if (mtime === null) {
      knownMtimeByPath.delete(filePath);
    } else {
      knownMtimeByPath.set(filePath, mtime);
    }
  } catch {
    knownMtimeByPath.delete(filePath);
  }
}

/**
 * 原子写入：先写同目录临时文件，再 rename 覆盖目标（防半写；rename 覆盖已存在
 * 文件在 Windows 上等价于 MoveFileEx + MOVEFILE_REPLACE_EXISTING）。
 * 失败时尽力清理临时文件（清理失败不掩盖原错误）。
 * @param filePath 目标文件完整路径
 * @param text 待写入文本
 * @throws 透传底层 IO 错误，由调用方包装为 REGISTRY_WRITE_FAILED
 */
async function writeAtomic(filePath: string, text: string): Promise<void> {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, text, "utf8");
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * 乐观锁更新注册表的公共流程（upsertPack / removePack 共用，S6）：
 * 取基线 → 读内容 → 原地 mutate → 校验序列化 → 写前核对 mtime → 原子写。
 *
 * mtime 基线约定（见模块头注释"乐观锁流程"第 1 条）：
 * - 优先用本进程最近一次读取 / 写入事件记录的基线（{@link knownMtimeByPath}）；
 * - 本进程从未接触过该注册表时现取：先 stat 后读（竞态时基线偏旧 → 宁可误报冲突
 *   也不漏报）；文件不存在视为 0（因此"读时无、写前被别人建"也是冲突）；
 * - 极端竞态"stat 不到但 readFile 成功"（stat 与读之间文件刚被建）按 mtime -1
 *   处理：无论目标之后是什么状态都不等于基线，必然冲突，绝不基于过期认知落盘。
 * 注意：本函数内部的 readFile 只取内容，**不刷新基线**——刷新只发生在
 * readRegistry 的读取事件与本模块的成功写入之后。
 *
 * @param packsRoot 图包根目录
 * @param mutate 对解析后的 Registry 做原地修改；可抛 PackError 中止本次更新
 * @throws PackError code="REGISTRY_READ_FAILED" / "REGISTRY_INVALID" /
 *                   "REGISTRY_CONFLICT"（mtime 变了，一个字节都不写）/
 *                   "REGISTRY_WRITE_FAILED"，以及 mutate 抛出的原错误
 */
async function updateRegistry(packsRoot: string, mutate: (registry: Registry) => void): Promise<void> {
  const filePath = registryPath(packsRoot);

  // 1. 取 mtime 基线：本进程最近一次已知 mtime；从未接触过则先 stat 后读现取
  const knownMtime = knownMtimeByPath.get(filePath);
  let seenMtime: number | null = null;
  let raw: string | null = null;
  if (knownMtime === undefined) {
    seenMtime = await statMtimeOrNull(filePath);
  }
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (errCode(err) !== "ENOENT") {
      throw new PackError(
        "REGISTRY_READ_FAILED",
        `读取注册表失败：${filePath}（${errMessage(err)}）`,
      );
    }
  }
  let expectedMtime: number;
  let registry: Registry;
  if (raw === null) {
    // 读不到文件 = 空表起建；基线：有记录用记录，否则视为 0
    registry = emptyRegistry();
    expectedMtime = knownMtime ?? 0;
  } else {
    registry = parseRegistry(filePath, raw);
    if (knownMtime !== undefined) {
      expectedMtime = knownMtime;
    } else {
      // 现取基线：stat 说存在但读之间被删（seenMtime 非 null 而文件没了）→
      // 或 stat 与读之间刚被建（seenMtime 为 null）→ 都按"必然冲突"的 -1 处理
      expectedMtime = seenMtime ?? -1;
    }
  }

  // 2. 原地 mutate（不 deep clone）
  mutate(registry);

  // 3. 校验 + 序列化（不过 schema 抛 REGISTRY_INVALID，绝不落盘）
  const text = serializeRegistry(registry);

  // 4. 写盘前核对 mtime：文件不存在视为 0，与基线约定对称
  const actualMtime = (await statMtimeOrNull(filePath)) ?? 0;
  if (actualMtime !== expectedMtime) {
    throw new PackError(
      "REGISTRY_CONFLICT",
      `注册表已被其他进程修改，拒绝覆盖（期望 mtime=${expectedMtime}，实际 mtime=${actualMtime}）：${filePath}，请重读后重试`,
    );
  }

  // 5. 原子替换落盘，随后把写完的 mtime 记为新基线
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeAtomic(filePath, text);
  } catch (err) {
    throw new PackError(
      "REGISTRY_WRITE_FAILED",
      `写入注册表失败：${filePath}（${errMessage(err)}）`,
    );
  }
  await recordWrittenMtime(filePath);
}

/**
 * 处理 upsert 的 modified 语义：
 * - entry.modified 非空 → 调用方显式指定，原样保留；
 * - entry.modified 为 "" → 替换时保留原条目的 modified；新增时填当天 UTC 日期。
 *
 * @param entry 调用方传入的条目
 * @param previousModified 被替换条目的原 modified；新增时为 undefined
 * @returns modified 已就位的条目（浅拷贝，不改入参对象）
 */
function resolveModified(entry: PackEntry, previousModified: string | undefined): PackEntry {
  if (entry.modified !== "") {
    return entry;
  }
  const fallback = previousModified ?? new Date().toISOString().slice(0, 10);
  return { ...entry, modified: fallback };
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 计算多图包索引的完整路径。
 * @param packsRoot 图包根目录（绝对 / 相对均可，原样拼接）
 * @returns `<packsRoot>/.registry.yaml`（路径分隔符跟随平台）
 */
export function registryPath(packsRoot: string): string {
  return path.join(packsRoot, REGISTRY_FILENAME);
}

/**
 * 读取并校验多图包索引。
 *
 * **文件不存在时容错**：返回空注册表（`{ schema_version: 1, packs: [] }`），
 * 不抛错——"第一个图包还没登记"是正常状态，不是故障。
 *
 * @param packsRoot 图包根目录
 * @returns 校验通过的注册表
 * @throws PackError code="REGISTRY_INVALID" 内容不是合法 YAML 或不符合 schema 时
 * @throws PackError code="REGISTRY_READ_FAILED" 读取时发生"文件不存在"以外的 IO 错误时
 */
export async function readRegistry(packsRoot: string): Promise<Registry> {
  const filePath = registryPath(packsRoot);
  // 先 stat 后读：把"这次读取事件"看到的 mtime 记为乐观锁基线（S6）。
  // 竞态时基线偏旧（读到的比记录的新）→ 后续写必然冲突，宁可误报也不漏报。
  const seenMtime = await statMtimeOrNull(filePath);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      // REGISTRY_NOT_FOUND 容错路径：返回空表而不是抛错；基线记 0
      knownMtimeByPath.set(filePath, 0);
      return emptyRegistry();
    }
    throw new PackError(
      "REGISTRY_READ_FAILED",
      `读取注册表失败：${filePath}（${errMessage(err)}）`,
    );
  }
  knownMtimeByPath.set(filePath, seenMtime ?? 0);
  return parseRegistry(filePath, raw);
}

/**
 * 把注册表写入 `<packsRoot>/.registry.yaml`（yaml.stringify，2 空格缩进，
 * writeFile 临时文件 + rename 原子替换）。
 *
 * 写前对 reg 重新过一遍 schema：调用方可能传入运行时构造的不可信数据，
 * 绝不落盘不合规的注册表。**本函数不做乐观锁**——需要并发保护的上层流程
 * 应使用 {@link upsertPack} / {@link removePack}。
 *
 * @param packsRoot 图包根目录（不存在时自动逐级创建）
 * @param reg 待写入的注册表数据
 * @throws PackError code="REGISTRY_INVALID" reg 不符合 schema 时（message 含问题摘要）
 * @throws PackError code="REGISTRY_WRITE_FAILED" 写文件发生 IO 错误时
 */
export async function writeRegistry(packsRoot: string, reg: Registry): Promise<void> {
  const filePath = registryPath(packsRoot);
  const text = serializeRegistry(reg);
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeAtomic(filePath, text);
  } catch (err) {
    throw new PackError(
      "REGISTRY_WRITE_FAILED",
      `写入注册表失败：${filePath}（${errMessage(err)}）`,
    );
  }
  // 写入成功 → 本进程已知文件状态，刷新乐观锁基线（见模块头注释"乐观锁流程"第 1 条）
  await recordWrittenMtime(filePath);
}

/**
 * 新增或替换一个图包条目（带乐观锁并发写保护）。
 *
 * 语义：
 * - `dir` 已存在 → 原位替换整行；不存在 → 追加到 packs 末尾；
 * - `entry.modified === ""` → 替换时保留原条目的 modified，新增时填当天 UTC 日期；
 *   非空值视为调用方显式指定，原样写入。
 *
 * @param packsRoot 图包根目录（注册表不存在时以空表起建并创建文件）
 * @param entry 待写入的图包条目
 * @throws PackError code="REGISTRY_INVALID" entry 或现有注册表不合规时
 * @throws PackError code="REGISTRY_CONFLICT" 读之后注册表 mtime 被其他进程改动时（不落盘）
 * @throws PackError code="REGISTRY_READ_FAILED" / "REGISTRY_WRITE_FAILED" IO 失败时
 */
export async function upsertPack(packsRoot: string, entry: PackEntry): Promise<void> {
  await updateRegistry(packsRoot, (registry) => {
    const index = registry.packs.findIndex((pack) => pack.dir === entry.dir);
    if (index >= 0) {
      registry.packs[index] = resolveModified(entry, registry.packs[index].modified);
    } else {
      registry.packs.push(resolveModified(entry, undefined));
    }
  });
}

/**
 * 从注册表中删除一个图包条目（带乐观锁并发写保护）。
 *
 * @param packsRoot 图包根目录
 * @param dir 要删除的图包子目录名（与 entry.dir 精确匹配，不做大小写 / 空格归一）
 * @throws PackError code="REGISTRY_PACK_NOT_FOUND" 注册表中不存在该 dir 的条目时
 * @throws PackError code="REGISTRY_INVALID" 现有注册表不合规时
 * @throws PackError code="REGISTRY_CONFLICT" 读之后注册表 mtime 被其他进程改动时（不落盘）
 * @throws PackError code="REGISTRY_READ_FAILED" / "REGISTRY_WRITE_FAILED" IO 失败时
 */
export async function removePack(packsRoot: string, dir: string): Promise<void> {
  await updateRegistry(packsRoot, (registry) => {
    const index = registry.packs.findIndex((pack) => pack.dir === dir);
    if (index < 0) {
      throw new PackError(
        "REGISTRY_PACK_NOT_FOUND",
        `注册表中不存在目录为"${dir}"的图包条目：${registryPath(packsRoot)}`,
      );
    }
    registry.packs.splice(index, 1);
  });
}

/**
 * 按子目录名查找图包条目。
 *
 * @param packsRoot 图包根目录（注册表不存在时按空表处理，返回 null）
 * @param dir 图包子目录名（与 entry.dir 精确匹配）
 * @returns 命中的条目；找不到返回 null（不抛错）
 * @throws PackError code="REGISTRY_INVALID" / "REGISTRY_READ_FAILED" 读取校验失败时
 */
export async function findPack(packsRoot: string, dir: string): Promise<PackEntry | null> {
  const registry = await readRegistry(packsRoot);
  return registry.packs.find((pack) => pack.dir === dir) ?? null;
}
