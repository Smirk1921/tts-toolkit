// src/test/discover.ts
/**
 * 阶段 7 测试运行器：测试文件发现模块（S4 混合发现语义）。
 *
 * 属于窗口 G（阶段 7：测试运行器 + 发布链路），由 A2 产出。
 * 职责：在图包工作区内找出所有待运行的 Lua 测试文件，产出 {@link DiscoveredTest}
 * 清单交给 runner（A3）逐个执行。发现优先级（S4 混合发现语义，高 → 低）：
 *
 * 1. 调用方显式传入的 `opts.include` / `opts.exclude`（整体替换，不是合并）；
 * 2. `<root>/pack.yaml` 的 `tests:` 段（前瞻兼容读取，见下）；
 * 3. 内置默认：include = {@link DEFAULT_TEST_GLOB}，exclude = []。
 *
 * `tests.timeout` / `tests.target_guid` 目前只有全局值（本阶段 schema 无逐文件配置），
 * 透传到每个发现条目的 `timeoutMs` / `targetGuid` 上。
 *
 * 与 Stage C pack.yaml schema 扩展的契约关系：
 * - `packYamlSchema`（src/pack/packyaml.ts）目前是 strictObject 且**没有** tests 段，
 *   含 tests 段的清单会被 readPackYaml 以 PACK_INVALID 拒绝——因此本模块**不走**
 *   readPackYaml，而是直接用 `yaml` 的 parse 读文件，只用本文件内的
 *   {@link testsSectionSchema} 校验 tests 子段（不校验整个 pack.yaml）；
 * - Stage C 给 packYamlSchema 正式加 tests: 段时，字段名与约束应与
 *   {@link testsSectionSchema} 对齐（include / exclude / timeout / target_guid）；
 * - pack.yaml 不存在属于常态（多数现存清单还没有 tests 段），静默用默认值，不告警；
 *   pack.yaml 存在但读取失败 / 不是合法 YAML / tests 段校验失败时，告警并整体回退默认。
 *
 * glob 支持子集（自实现，不引 glob 库）：
 * - `*`   单段内任意字符（不跨 `/`）；
 * - `**`  跨段通配：后跟 `/` 时匹配零个或多个完整路径段（因此默认 glob 也命中
 *         tests/ 直属文件）；位于末尾时匹配任意残余（含 `/`）；段中间（如 a**b）
 *         退化为单段 `*`；
 * - `?`   单个字符（不含 `/`）；
 * - 模式相对 pack 根、整体锚定、大小写敏感；`\` 一律按 `/` 处理。
 *
 * 扫描行为：从 pack 根递归遍历（自定义 include 可能指向 tests/ 之外），
 * 跳过 `.git`、`node_modules` 与点开头的目录；只把普通文件（含可解析的符号链接）
 * 作为候选，目录不参与 glob 匹配。结果按 relativePath 字典序排序；
 * 重复 glob 命中同一文件只保留一条（按相对路径去重）。
 *
 * 警告通道：本模块不抛错（空结果返回 []）；所有异常情况以 PackError 为载体经
 * `opts.onWarning` 回调上报，缺省时写 console.error（stderr）。CLI 可沿用
 * `t(\`error.${code}\`, { msg: message })` 的既有惯例打印。
 *
 * 本模块声明的错误码（locales 两套键由 Stage C 补齐，代码内只 new PackError）：
 * - "TEST_DISCOVER_PACK_YAML_INVALID" pack.yaml 读取失败（非不存在）/ 不是合法 YAML /
 *   tests 段不符合约定 → 忽略 tests 段，回退默认发现配置
 * - "TEST_DISCOVER_FILE_UNREADABLE"   扫描目录失败或候选文件 stat 失败 → 跳过该目录/文件
 */

import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { PackError, packYamlPath } from "../pack/packyaml.js";
import type { DiscoveredTest, DiscoverOptions } from "./types.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 默认测试文件 glob：pack 根下 tests/ 目录（含任意子目录）中的 *_test.lua。
 *
 * 命名约定（S4 定）：测试文件用 `*_test.lua`（下划线），不用 `*.test.lua`——
 * 文件名里的 "." 会被 luabundle 误认为路径分隔符，导致 bundle 模式下
 * `require("tests.foo.test")` 解析不到 `tests/foo.test.lua`（实测于窗口 G / Stage D）。
 */
export const DEFAULT_TEST_GLOB: string = "tests/**/*_test.lua";

/** 默认单文件超时（毫秒），pack.yaml tests.timeout 未配置时生效 */
export const DEFAULT_TIMEOUT_MS: number = 30_000;

/** 默认目标对象 guid（"-1" = Global），pack.yaml tests.target_guid 未配置时生效 */
export const DEFAULT_TARGET_GUID: string = "-1";

/** 递归扫描时跳过的目录名（点开头目录一律跳过，无需列在此处） */
const SKIP_DIR_NAMES = new Set([".git", "node_modules"]);

// ---------------------------------------------------------------------------
// 入参与警告
// ---------------------------------------------------------------------------

/**
 * {@link discoverTests} 的入参：在 {@link DiscoverOptions}（A1 冻结的公共契约）之上
 * 追加可选的警告回调。函数签名与契约 `discoverTests(opts: DiscoverOptions)` 完全兼容
 * （额外字段可选，只传 DiscoverOptions 的调用方不受影响）。
 */
export interface DiscoverTestsOptions extends DiscoverOptions {
  /**
   * 警告回调：pack.yaml tests 段不可用、目录/文件不可读等情况逐条上报。
   * 缺省时警告写 console.error（stderr）。
   */
  onWarning?: (warning: PackError) => void;
}

// ---------------------------------------------------------------------------
// pack.yaml tests: 段的前瞻兼容 schema（Stage C 对齐目标）
// ---------------------------------------------------------------------------

/**
 * tests 段 strictObject 的中文错误定制（packyaml.ts 的 strictObjectError 未导出，
 * 且两模块相互独立，按坑 22 的豁免写小副本）。
 */
function testsSectionError(issue: z.core.$ZodRawIssue): string {
  const keys = (issue as { keys?: unknown }).keys;
  if (Array.isArray(keys)) {
    return `tests 段含有无法识别的字段：${keys.map((key) => String(key)).join("、")}`;
  }
  return "tests 段必须是键值对象";
}

/**
 * pack.yaml `tests:` 段的前瞻兼容 zod schema（zod 4 严格对象）。
 *
 * Stage C 给 packYamlSchema 正式加 tests 段时，请与本 schema 的字段名与约束对齐：
 * - include      字符串数组（元素非空），可选——glob 模式，缺省 [DEFAULT_TEST_GLOB]
 * - exclude      字符串数组（元素非空），可选——glob 模式，缺省 []
 * - timeout      正整数，可选——单文件超时毫秒，缺省 DEFAULT_TIMEOUT_MS
 * - target_guid  非空字符串，可选——目标对象 guid，缺省 DEFAULT_TARGET_GUID
 */
const testsSectionSchema = z.strictObject(
  {
    include: z
      .array(
        z
          .string({ error: "tests.include 元素必须是字符串" })
          .min(1, { error: "tests.include 元素必须是非空字符串" }),
        { error: "tests.include 必须是字符串数组" },
      )
      .optional(),
    exclude: z
      .array(
        z
          .string({ error: "tests.exclude 元素必须是字符串" })
          .min(1, { error: "tests.exclude 元素必须是非空字符串" }),
        { error: "tests.exclude 必须是字符串数组" },
      )
      .optional(),
    timeout: z
      .number({ error: "tests.timeout 必须是数字" })
      .int({ error: "tests.timeout 必须是整数" })
      .min(1, { error: "tests.timeout 必须是正整数" })
      .optional(),
    target_guid: z
      .string({ error: "tests.target_guid 必须是字符串" })
      .min(1, { error: "tests.target_guid 必须是非空字符串" })
      .optional(),
  },
  { error: testsSectionError },
);

/** tests 段校验通过后的配置（字段缺省 = 未配置，由调用方补默认值） */
interface TestsSectionConfig {
  include?: string[];
  exclude?: string[];
  timeoutMs?: number;
  targetGuid?: string;
}

// ---------------------------------------------------------------------------
// 内部小工具（packyaml.ts 的 errCode / errMessage / formatZodError 未导出，
// 两模块相互独立，按坑 22 的豁免各写一份最小副本）
// ---------------------------------------------------------------------------

/** 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT），取不到时返回 undefined */
function errCodeOf(err: unknown): string | undefined {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

/** 从 unknown 错误中取人类可读描述 */
function errMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把 zod 校验错误格式化为单行摘要（"路径：消息"，多个以"；"连接） */
function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.map((seg) => String(seg)).join(".");
      return `${where.length > 0 ? where : "tests"}：${issue.message}`;
    })
    .join("；");
}

// ---------------------------------------------------------------------------
// glob → RegExp
// ---------------------------------------------------------------------------

/**
 * 把本模块支持的 glob 子集编译为整体锚定的 RegExp（候选路径已统一为 `/` 分隔）。
 * 支持范围见模块头注释；不支持 `{}` 备选、字符类与 `!` 取反。
 */
function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  let source = "";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          // `**/`：零个或多个完整路径段（各段自带结尾 /）
          source += "(?:[^/]+/)*";
          i += 3;
        } else if (i + 2 === normalized.length) {
          // 末尾 `**`：任意残余（含 /）
          source += ".*";
          i += 2;
        } else {
          // 段中间的 `**`：退化为单段 `*`
          source += "[^/]*";
          i += 2;
        }
      } else {
        source += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    // 其余字符按字面量转义
    source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${source}$`);
}

// ---------------------------------------------------------------------------
// pack.yaml tests 段读取
// ---------------------------------------------------------------------------

/**
 * 读取 `<root>/pack.yaml` 的 tests: 段（前瞻兼容）。
 *
 * - pack.yaml 不存在：常态（Stage C 前的清单普遍没有 tests 段），静默返回空配置；
 * - 读取失败（非 ENOENT） / YAML 解析失败 / tests 段校验失败：告警后返回空配置；
 * - 顶层不是映射（含空文件）：没有 tests 段，静默返回空配置。
 */
async function readTestsSection(
  root: string,
  warn: (warning: PackError) => void,
): Promise<TestsSectionConfig> {
  const filePath = packYamlPath(root);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (errCodeOf(err) === "ENOENT") {
      return {};
    }
    warn(
      new PackError(
        "TEST_DISCOVER_PACK_YAML_INVALID",
        `读取 ${filePath} 失败，忽略 tests 段并使用默认发现配置：${errMessageOf(err)}`,
      ),
    );
    return {};
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    warn(
      new PackError(
        "TEST_DISCOVER_PACK_YAML_INVALID",
        `解析 ${filePath} 失败（不是合法 YAML），忽略 tests 段并使用默认发现配置：${errMessageOf(err)}`,
      ),
    );
    return {};
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return {};
  }
  const section = (data as Record<string, unknown>).tests;
  if (section === undefined) {
    return {};
  }

  const parsed = testsSectionSchema.safeParse(section);
  if (!parsed.success) {
    warn(
      new PackError(
        "TEST_DISCOVER_PACK_YAML_INVALID",
        `${filePath} 的 tests 段不符合约定，忽略该段并使用默认发现配置：${summarizeIssues(parsed.error)}`,
      ),
    );
    return {};
  }
  return {
    include: parsed.data.include,
    exclude: parsed.data.exclude,
    timeoutMs: parsed.data.timeout,
    targetGuid: parsed.data.target_guid,
  };
}

// ---------------------------------------------------------------------------
// 目录递归扫描
// ---------------------------------------------------------------------------

/**
 * 从 dir 递归收集普通文件的绝对路径。
 *
 * - 跳过 {@link SKIP_DIR_NAMES} 与点开头的目录；
 * - 符号链接等非普通条目：stat 解引用后按目标类型处理；目标不可达（断链）则
 *   告警跳过——这是测试不可读文件路径的天然入口；
 * - 目录本身不可读（权限等）：告警后跳过该子树，不中断整体扫描。
 */
async function walkFiles(dir: string, warn: (warning: PackError) => void): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    warn(
      new PackError(
        "TEST_DISCOVER_FILE_UNREADABLE",
        `扫描目录 ${dir} 失败，跳过该目录：${errMessageOf(err)}`,
      ),
    );
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      files.push(...(await walkFiles(full, warn)));
      continue;
    }
    if (entry.isFile()) {
      files.push(full);
      continue;
    }
    // 符号链接等：解引用后再判断；断链在这里被捕获并告警
    try {
      const st = await stat(full);
      if (st.isFile()) {
        files.push(full);
      } else if (st.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        files.push(...(await walkFiles(full, warn)));
      }
    } catch (err) {
      warn(
        new PackError(
          "TEST_DISCOVER_FILE_UNREADABLE",
          `访问测试候选文件 ${full} 失败，跳过：${errMessageOf(err)}`,
        ),
      );
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// 导出：发现入口
// ---------------------------------------------------------------------------

/**
 * 发现图包工作区内的 Lua 测试文件（S4 混合发现语义，优先级见模块头注释）。
 *
 * 行为要点：
 * - 不抛错：workspace 无测试 / tests 目录不存在 / root 不存在等一律返回 []，
 *   异常细节经 onWarning 上报（缺省 console.error）；
 * - `opts.include` / `opts.exclude` 整体替换低优先级来源（不是合并）；
 *   显式空数组 `[]` 表示"匹配空集"，`undefined` 才表示"沿用下一优先级"；
 * - glob 匹配对象是相对 pack 根、以 `/` 分隔的路径（跨平台一致，便于报告展示）；
 * - 结果按 relativePath 字典序（Unicode 码元序）排序，重复命中按相对路径去重；
 * - `timeoutMs` / `targetGuid` 取 pack.yaml tests 段的全局值（无则默认值），
 *   透传到每个发现条目。
 *
 * @param opts 发现选项（root 必填；相对路径会先 resolve 为绝对路径）
 * @returns 按 relativePath 排序的测试文件清单
 */
export async function discoverTests(opts: DiscoverTestsOptions): Promise<DiscoveredTest[]> {
  const warn: (warning: PackError) => void =
    opts.onWarning ?? ((warning) => console.error(warning.message));
  const root = path.resolve(opts.root);

  const section = await readTestsSection(root, warn);

  const include = opts.include ?? section.include ?? [DEFAULT_TEST_GLOB];
  const exclude = opts.exclude ?? section.exclude ?? [];
  const timeoutMs = section.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const targetGuid = section.targetGuid ?? DEFAULT_TARGET_GUID;

  const includeRegexes = include.map(globToRegExp);
  const excludeRegexes = exclude.map(globToRegExp);

  const candidates = await walkFiles(root, warn);

  const seenRelative = new Set<string>();
  const discovered: DiscoveredTest[] = [];
  for (const filePath of candidates) {
    const relativePath = path.relative(root, filePath).replaceAll("\\", "/");
    if (!includeRegexes.some((re) => re.test(relativePath))) {
      continue;
    }
    if (excludeRegexes.some((re) => re.test(relativePath))) {
      continue;
    }
    // 重复 glob 命中同一文件只保留一条
    if (seenRelative.has(relativePath)) {
      continue;
    }
    seenRelative.add(relativePath);
    discovered.push({ filePath, relativePath, targetGuid, timeoutMs });
  }

  discovered.sort((a, b) => {
    if (a.relativePath < b.relativePath) {
      return -1;
    }
    if (a.relativePath > b.relativePath) {
      return 1;
    }
    return 0;
  });
  return discovered;
}
