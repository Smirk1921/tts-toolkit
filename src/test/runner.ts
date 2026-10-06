// src/test/runner.ts
/**
 * 阶段 7 测试运行器：Lua 测试执行引擎（TestRunner）。
 *
 * 属于窗口 G（阶段 7：测试运行器 + 发布链路），由 A3 产出。
 *
 * 与 SessionExec（src/session/exec.ts）的关系：
 * - 每个测试文件一次独立的 ExecuteLua 往返全部经 SessionExec 完成
 *   （坑 1/2/3 已在那一层处理），本模块只负责组织与汇总；
 * - 结果取回不走 execJson：execJson 对"不以 return 开头的多语句代码"会把整段
 *   包进 JSON.encode(...) 直接造成 Lua 语法错误，因此这里统一在 chunk 末尾追加
 *   `return JSON.encode(current_test_results())` 后用 exec 原始执行，自行 JSON.parse。
 *
 * 与 bundle.ts（A4）的关系：
 * - 本模块静态 `import { bundleTests } from "./bundle.js"`。bundle.ts 由 A4 与本模块
 *   并行开发：开发期间曾以"临时前向 d.ts + 变量说明符动态 import"两种方案兜底，实测
 *   vitest 3 只能拦截静态可分析的导入（变量说明符会绕过 vi.mock 直接落盘解析，
 *   bundle.ts 未落盘时直接 Cannot find module），最终定型为静态 import——bundle.ts
 *   落盘前类型由临时前向声明兜底、单测经 vi.mock 拦截；落盘后（现状）直接使用真实
 *   导出，临时前向声明已删除。
 * - bundle 模式（默认）：每个测试文件单独打包——先在临时目录写一个合成入口文件
 *   （内容 = require("tts.assert") + require("<测试模块名>")，即任务书所说
 *   "tts.test.main" 合成入口的按文件版，见 {@link synthesizeBundleEntry}），再调
 *   bundleTests({ entryPath, searchPaths, builtinModules: { "tts.assert": LUA_ASSERT_LIBRARY } })
 *   得到单文件 Lua + lineMap，用 lineMap 把报错行号回映射到源文件；
 * - 直跑模式（bundle=false）：不打包，把 LUA_ASSERT_LIBRARY 以 package.preload
 *   方式内联注册为 "tts.assert" 后直接执行文件内容；行号用"前缀行数偏移"换算。
 *   注意直跑模式没有模块解析能力：测试文件里的 require（断言库除外）会落到
 *   TTS 的真实 require 上，需要模块解析的场景请用 bundle 模式。
 *
 * 执行模型（对齐任务书"每个测试文件独立执行、不要合并成一个超大 ExecuteLua"）：
 * - 每个 DiscoveredTest 一次独立 ExecuteLua（guid / timeoutMs 取自该条目）；
 * - bail 粒度是文件：某文件跑完出现 failed/error 用例即停止后续文件
 *   （同一文件内的用例由 Lua 侧一次性全部执行，无法中途停止）；
 * - 全局超时（globalTimeoutMs，默认 300_000）：每次执行文件前检查截止时间，
 *   到点后剩余文件不再执行，并逐文件合成"全局超时未执行"的 error 条目
 *   （区别于 bail 的有意停止，超时属于被动中断，必须在报告里可见）。
 *
 * Print 收集：
 * - 每次执行前快照 server.find(messageID === 2)，执行后 diff 出新增 Print 消息；
 * - 与 Lua 侧已捕获的 prints 按文本去重后，追加到该文件最后一个用例的 prints
 *   （文件没有任何用例时无处可挂，丢弃——RunReport 没有文件级 prints 字段）。
 *
 * 本模块声明的 PackError 错误码（locales 两套键由 Stage C 补齐，代码内只 new PackError）：
 * - "TEST_RUN_BUNDLE_FAILED"     bundleTests 打包某测试文件失败（入口/依赖不可读等）
 * - "TEST_RUN_FILE_UNREADABLE"   直跑模式读取测试文件失败
 * - "TEST_RUN_FILE_TIMEOUT"      单文件执行超时（SessionExec 抛出的超时错误）
 * - "TEST_RUN_EXEC_FAILED"       其他执行期错误（非 LuaError、非超时）
 * - "TEST_RUN_RESULTS_MALFORMED" 返回值不是合法 JSON / 不是字符串 / 缺少 tests 数组
 * - "TEST_RUN_GLOBAL_TIMEOUT"    全局超时后剩余文件未执行（合成条目用）
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { EditorServer } from "../protocol/editor-server.js";
import { GLOBAL_GUID, InboundId, type InboundMessage } from "../protocol/messages.js";
import { PackError } from "../pack/packyaml.js";
import { LuaError, SessionExec } from "../session/exec.js";
import { LUA_ASSERT_LIBRARY } from "./assert.js";
import { bundleTests } from "./bundle.js";
import { DEFAULT_TIMEOUT_MS } from "./discover.js";
import type {
  AssertResult,
  DiscoveredTest,
  RunOptions,
  RunReport,
  TestResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 全局超时缺省值：整个 run 的墙钟上限（毫秒），可用 RunOptions.globalTimeoutMs 覆盖 */
const DEFAULT_GLOBAL_TIMEOUT_MS = 300_000;

/** 结果取回语句：追加在每个（打包后的）测试 chunk 末尾 */
const RUN_TAIL = "return JSON.encode(current_test_results())";

/**
 * 直跑模式前缀：把内置断言库源码直接执行一遍（TTS 的 Lua 环境没有 require，
 * package.preload 注册的模块无法被加载——经实测 type(require) === "nil"，
 * 见窗口 G / Stage D 环境探测）。库源码末尾会把 describe / it / assert_* /
 * expect_error / current_test_results 提升到 _G，测试文件直接裸调用即可。
 */
const DIRECT_MODE_PREFIX = [
  "-- tts-toolkit 测试运行器（直跑模式）注入：直接展开内置断言库源码",
  "--（TTS Lua 无 require，package.preload 注册的模块不会被加载；库自身会提升 API 到 _G）",
  "(function()",
  LUA_ASSERT_LIBRARY,
  "end)()",
].join("\n");

/**
 * 直跑模式的行号偏移：chunk 行 = 文件行 + 该偏移
 * （chunk = DIRECT_MODE_PREFIX + "\n" + 文件内容 + "\n" + RUN_TAIL）。
 */
const DIRECT_MODE_LINE_OFFSET = countLines(DIRECT_MODE_PREFIX);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 文本行数（"\n" 分割；空串算 0 行） */
function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/**
 * 相对路径 → Lua 模块名：
 * - "tests/foo_test.lua" → "tests.foo_test"
 * - "tests/foo.test.lua" → "tests.foo_test"（文件名里的 "." 是测试命名约定，不是路径分隔符，
 *   转成 "_" 让模块名能被 luabundle 按 "tests.foo_test → tests/foo_test.lua" 反解析回真实文件）
 * - "tests/sub/bar.test.lua" → "tests.sub.bar_test"
 */
function toLuaModuleName(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  const withoutExt = normalized.endsWith(".lua") ? normalized.slice(0, -".lua".length) : normalized;
  const sep = withoutExt.lastIndexOf("/");
  const dir = sep >= 0 ? withoutExt.slice(0, sep + 1) : "";
  const basename = sep >= 0 ? withoutExt.slice(sep + 1) : withoutExt;
  const safeBasename = basename.replaceAll(".", "_");
  return (dir + safeBasename).replaceAll("/", ".");
}

/** 文件名安全化：只保留字母数字与 ._ -，其余替换为下划线 */
function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** 把 lineMap 里的源文件引用统一转成"相对 pack 根、以 / 分隔"的路径 */
function relFromRoot(root: string, sourceFile: string): string {
  const abs = path.isAbsolute(sourceFile) ? sourceFile : path.resolve(root, sourceFile);
  return path.relative(root, abs).replaceAll("\\", "/");
}

/** 从 unknown 错误取人类可读描述 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 行号映射器：chunk/Lua 报告里的行号 → { 相对源文件, 源文件行号 } */
type LineMapper = (line: number) => { sourceFile: string; sourceLine: number };

// ---------------------------------------------------------------------------
// Lua 侧结果（current_test_results() 经 JSON 回传）的宽松视图
// ---------------------------------------------------------------------------

/** 单条断言条目（宽松视图，字段缺失不视为致命） */
interface LuaAssertView {
  kind?: unknown;
  passed?: unknown;
  message?: unknown;
  line?: unknown;
}

/** 单个用例条目（宽松视图，字段缺失不视为致命） */
interface LuaCaseView {
  name?: unknown;
  source_line?: unknown;
  status?: unknown;
  failure_reason?: unknown;
  asserts?: unknown;
  prints?: unknown;
}

/** 把 Lua 侧一条断言映射为 AssertResult（行号经 mapper 回写源文件位置） */
function mapAssert(item: unknown, mapLine: LineMapper): AssertResult {
  const rec = (item ?? {}) as LuaAssertView;
  const kind = typeof rec.kind === "string" ? rec.kind : "unknown";
  const line = typeof rec.line === "number" ? rec.line : 0;
  const loc = mapLine(line);
  return {
    kind,
    passed: rec.passed === true,
    message: typeof rec.message === "string" ? rec.message : undefined,
    sourceFile: loc.sourceFile,
    sourceLine: loc.sourceLine,
  };
}

/** 把 Lua 侧一个用例映射为 TestResult（行号经 mapper 回写源文件位置） */
function mapCase(
  item: unknown,
  mapLine: LineMapper,
  durationMs: number,
): TestResult {
  const rec = (item ?? {}) as LuaCaseView;
  const name = typeof rec.name === "string" ? rec.name : "";
  const line = typeof rec.source_line === "number" ? rec.source_line : 0;
  const loc = mapLine(line);
  const statusRaw = typeof rec.status === "string" ? rec.status : "";
  const status: TestResult["status"] =
    statusRaw === "passed" || statusRaw === "failed" ? statusRaw : "error";
  const failureReason = typeof rec.failure_reason === "string" ? rec.failure_reason : undefined;
  const statusNote =
    statusRaw !== "" && statusRaw !== "passed" && statusRaw !== "failed" && statusRaw !== "error"
      ? `（Lua 侧返回未知状态 ${JSON.stringify(statusRaw)}，按 error 记录）`
      : undefined;
  return {
    case: { name, sourceFile: loc.sourceFile, sourceLine: loc.sourceLine },
    status,
    failureReason: failureReason ?? statusNote,
    asserts: Array.isArray(rec.asserts) ? rec.asserts.map((a) => mapAssert(a, mapLine)) : [],
    prints: Array.isArray(rec.prints)
      ? rec.prints.filter((p): p is string => typeof p === "string")
      : [],
    durationMs,
  };
}

/** 合成一条"文件级错误"条目（整份文件没有产出任何用例结果时使用） */
function syntheticErrorEntry(relativePath: string, failureReason: string, durationMs: number): TestResult {
  return {
    case: { name: `${relativePath}（文件级错误）`, sourceFile: relativePath, sourceLine: 0 },
    status: "error",
    failureReason,
    asserts: [],
    prints: [],
    durationMs,
  };
}

/**
 * 合成 bundle 模式的入口文件内容（"tts.test.main" 合成入口的按文件版）。
 *
 * 先加载内置断言库（测试文件可直接裸调用 assert_* / describe / it），再加载测试
 * 文件模块；末尾 return JSON.encode(current_test_results()) 把结果回传给 runner——
 * bundle 结果末尾的 `return __bundle_require("__root")` 会执行入口并把这个值作为
 * 整个 chunk 的返回值，所以**不能**再在外面拼接 {@link RUN_TAIL}（会出现两个顶层
 * return，Lua 报 `<eof> expected near 'return'`，窗口 G / Stage D 实测）。
 * 导出供 runner 的单测复现完全相同的打包输入，从而校验行号映射。
 *
 * @param moduleName 测试文件的 Lua 模块名（如 "tests.foo_test"）
 */
export function synthesizeBundleEntry(moduleName: string): string {
  return [
    '-- tts-toolkit 测试运行器合成的 bundle 入口（"tts.test.main" 按文件版）：',
    "-- 先加载内置断言库，再加载单个测试文件；末尾 return JSON.encode(current_test_results())",
    "-- 供 bundle 结果末尾的 return __bundle_require(\"__root\") 把整个 chunk 的返回值带回。",
    'require("tts.assert")',
    `require("${moduleName}")`,
    "return JSON.encode(current_test_results())",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// TestRunner
// ---------------------------------------------------------------------------

/**
 * 阶段 7 测试运行器。
 *
 * 用法：`const runner = new TestRunner(server); const report = await runner.run(opts);`
 * server 也可经 RunOptions.server 传入（hub 委托模式预留）：opts.server 优先于
 * 构造函数注入的 server。每个 run 内复用同一个 SessionExec 实例（returnID 自增）。
 */
export class TestRunner {
  /**
   * @param server 注入的协议层编辑器服务（独立模式下由调用方 start 后传入；
   *               仅使用其 find 只读扫描能力做 Print 快照/差分）
   */
  constructor(private readonly server: EditorServer) {}

  /**
   * 执行一整轮测试并产出运行报告。
   *
   * @param opts 运行选项（files 来自 discover 模块）
   * @returns 运行报告（runId = 时间戳(36 进制) + "-" + 8 位随机后缀）
   * @throws {PackError} TEST_RUN_BUNDLE_FAILED / TEST_RUN_FILE_UNREADABLE 等按文件
   *                     合成 error 条目不抛出；仅当无法拿到任何可用的执行通道时抛出
   */
  async run(opts: RunOptions): Promise<RunReport> {
    // opts.server（hub 委托模式经 RunOptions 注入）优先于构造函数注入的 server
    const server = opts.server ?? this.server;
    const root = path.resolve(opts.root);
    const useBundle = opts.bundle ?? true;
    const bail = opts.bail ?? false;
    const globalTimeoutMs = opts.globalTimeoutMs ?? DEFAULT_GLOBAL_TIMEOUT_MS;
    const startMs = Date.now();
    const startedAt = new Date(startMs).toISOString();
    const deadline = startMs + globalTimeoutMs;
    const exec = new SessionExec(server);

    const results: TestResult[] = [];
    let bailed = false;

    // 每轮 run 一个临时目录，存放按文件合成的 bundle 入口
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tts-toolkit-test-run-"));
    try {
      for (const [index, entry] of opts.files.entries()) {
        // 全局超时：被动中断也要在报告里可见（合成"未执行"错误条目）
        if (Date.now() >= deadline) {
          results.push(
            syntheticErrorEntry(
              entry.relativePath,
              new PackError(
                "TEST_RUN_GLOBAL_TIMEOUT",
                `全局超时（${globalTimeoutMs}ms）已到，测试文件 ${entry.relativePath} 未执行。`,
              ).message,
              0,
            ),
          );
          continue;
        }
        const fileResults = await this.runOneFile(exec, server, entry, root, useBundle, tempRoot, index);
        results.push(...fileResults);
        // bail：粒度是文件；首个含 failed/error 用例的文件跑完即停
        if (bail && fileResults.some((r) => r.status !== "passed")) {
          bailed = true;
          break;
        }
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }

    const endedMs = Date.now();
    const passed = results.filter((r) => r.status === "passed").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const errored = results.length - passed - failed;
    return {
      runId: `${startMs.toString(36)}-${randomBytes(4).toString("hex")}`,
      root,
      startedAt,
      endedAt: new Date(endedMs).toISOString(),
      durationMs: Math.max(0, endedMs - startMs),
      total: results.length,
      passed,
      failed,
      errored,
      bailed,
      results,
    };
  }

  /**
   * 执行单个测试文件（独立 ExecuteLua），返回该文件的用例结果列表。
   *
   * 任何文件级失败（打包失败 / 读取失败 / LuaError / 超时 / 返回值畸形）都以
   * 合成的 error 条目呈现，不向 run() 抛出。
   */
  private async runOneFile(
    exec: SessionExec,
    server: EditorServer,
    entry: DiscoveredTest,
    root: string,
    useBundle: boolean,
    tempRoot: string,
    index: number,
  ): Promise<TestResult[]> {
    const fileStart = Date.now();
    const elapsedMs = (): number => Math.max(0, Math.round(Date.now() - fileStart));
    const filePath = path.resolve(entry.filePath);
    const relativePath =
      entry.relativePath !== "" ? entry.relativePath : relFromRoot(root, filePath);

    // 1. 组装待执行 Lua + 行号映射器
    let lua: string;
    let mapLine: LineMapper;
    try {
      if (useBundle) {
        const moduleName = toLuaModuleName(relativePath);
        const entryPath = path.join(tempRoot, `bundle_entry_${index}_${sanitizeFileName(moduleName)}.lua`);
        await writeFile(entryPath, synthesizeBundleEntry(moduleName), "utf8");
        const bundled = await bundleTests({
          entryPath,
          searchPaths: [root, path.dirname(filePath)],
          builtinModules: { "tts.assert": LUA_ASSERT_LIBRARY },
        });
        lua = bundled.code;
        mapLine = (line: number): { sourceFile: string; sourceLine: number } => {
          const hit = bundled.lineMap.get(line);
          if (hit !== undefined) {
            return { sourceFile: relFromRoot(root, hit.sourceFile), sourceLine: hit.sourceLine };
          }
          // bundle 行号超出映射表（如末尾拼接的取回语句报错）：回退相对路径 + 原始行号
          return { sourceFile: relativePath, sourceLine: line };
        };
      } else {
        const source = await readFile(filePath, "utf8");
        lua = `${DIRECT_MODE_PREFIX}\n${source.replace(/^\uFEFF/, "")}\n${RUN_TAIL}`;
        mapLine = (line: number): { sourceFile: string; sourceLine: number } => {
          const shifted = line - DIRECT_MODE_LINE_OFFSET;
          return { sourceFile: relativePath, sourceLine: shifted > 0 ? shifted : 0 };
        };
      }
    } catch (err) {
      // 打包/读取失败：该文件一条合成 error 条目，继续跑后续文件
      const failureReason =
        err instanceof PackError
          ? err.message
          : new PackError(
              useBundle ? "TEST_RUN_BUNDLE_FAILED" : "TEST_RUN_FILE_UNREADABLE",
              useBundle
                ? `打包测试文件 ${relativePath} 失败：${messageOf(err)}`
                : `读取测试文件 ${filePath} 失败：${messageOf(err)}`,
            ).message;
      return [syntheticErrorEntry(relativePath, failureReason, elapsedMs())];
    }

    // 2. Print 快照（留存列表只增不删，引用集合差分即"本次执行的新增 Print"）
    const printsBefore = new Set(
      server.find((m: InboundMessage) => m.messageID === InboundId.Print),
    );

    // 3. 执行（独立 ExecuteLua；guid/timeoutMs 取自发现条目）
    let raw: unknown;
    try {
      raw = await exec.exec(lua, {
        guid: entry.targetGuid ?? GLOBAL_GUID,
        timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      return errorEntriesFromExec(err, relativePath, mapLine, elapsedMs());
    }

    // 4. 解析 JSON（Lua 侧 current_test_results() 经 JSON.encode 回传字符串）
    if (typeof raw !== "string") {
      return [
        syntheticErrorEntry(
          relativePath,
          new PackError(
            "TEST_RUN_RESULTS_MALFORMED",
            `测试文件 ${relativePath} 的执行返回值不是 JSON 字符串（实际为 ${raw === null ? "null" : typeof raw}），无法解析测试结果。`,
          ).message,
          elapsedMs(),
        ),
      ];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return [
        syntheticErrorEntry(
          relativePath,
          new PackError(
            "TEST_RUN_RESULTS_MALFORMED",
            `测试文件 ${relativePath} 的返回值不是合法 JSON：${raw.slice(0, 120)}`,
          ).message,
          elapsedMs(),
        ),
      ];
    }
    const tests =
      typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { tests?: unknown }).tests)
        ? ((parsed as { tests: unknown[] }).tests as unknown[])
        : undefined;
    if (tests === undefined) {
      return [
        syntheticErrorEntry(
          relativePath,
          new PackError(
            "TEST_RUN_RESULTS_MALFORMED",
            `测试文件 ${relativePath} 的返回值 JSON 缺少 tests 数组，无法解析测试结果。`,
          ).message,
          elapsedMs(),
        ),
      ];
    }

    // 5. 映射为 TestResult（同一文件的用例共享该文件的执行耗时：Lua 侧未逐用例计时）
    const durationMs = elapsedMs();
    const cases = tests.map((item) => mapCase(item, mapLine, durationMs));

    // 6. 新增 Print 消息：与 Lua 侧已捕获的 prints 按文本去重，追加到最后一个用例
    const knownPrints = new Set(cases.flatMap((c) => c.prints));
    const freshPrints = server
      .find((m: InboundMessage) => m.messageID === InboundId.Print)
      .filter((m) => !printsBefore.has(m))
      .map((m) => (m as { message: string }).message)
      .filter((text) => !knownPrints.has(text));
    if (freshPrints.length > 0 && cases.length > 0) {
      cases[cases.length - 1].prints.push(...freshPrints);
    }
    return cases;
  }
}

/**
 * 把 exec 阶段的异常合成 error 条目：
 * - LuaError：用 err.line 经行号映射回源文件（拿不到行号时记 0）；
 * - 其他错误：消息含"超时"归为 TEST_RUN_FILE_TIMEOUT，否则 TEST_RUN_EXEC_FAILED。
 */
function errorEntriesFromExec(
  err: unknown,
  relativePath: string,
  mapLine: LineMapper,
  durationMs: number,
): TestResult[] {
  if (err instanceof LuaError) {
    const loc =
      typeof err.line === "number" ? mapLine(err.line) : { sourceFile: relativePath, sourceLine: 0 };
    return [
      {
        case: { name: `${relativePath}（文件级错误）`, sourceFile: loc.sourceFile, sourceLine: loc.sourceLine },
        status: "error",
        failureReason: err.message,
        asserts: [],
        prints: [],
        durationMs,
      },
    ];
  }
  const message = messageOf(err);
  const code = message.includes("超时") ? "TEST_RUN_FILE_TIMEOUT" : "TEST_RUN_EXEC_FAILED";
  return [
    syntheticErrorEntry(
      relativePath,
      new PackError(code, `测试文件 ${relativePath} 执行失败：${message}`).message,
      durationMs,
    ),
  ];
}
