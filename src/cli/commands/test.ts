// src/cli/commands/test.ts
/**
 * `tts test [path]`：Lua 测试运行器 CLI（窗口 G / 阶段 7：测试运行器 + 发布链路，
 * 由 C1 产出）。
 *
 * 用途：在 TTS 图包工作区里发现并运行 Lua 测试文件（Stage A 的 src/test/ 运行器），
 * 把 RunReport 打到控制台、可选落盘 JSON，并以退出码区分"全过 / 有失败 / 有错误"
 * 三种结局——供本地与 CI 直接取用。
 *
 * 流程（薄调用层：发现、执行、报告全在 src/test/ 内，本文件只做参数编排与输出）：
 * 1. 解析参数（[path] 位置参数 + --root / --target / --timeout / --json / --bail /
 *    --bundle / --no-bundle / --verbose）；
 * 2. {@link discoverTests} 取测试文件清单——不给 path 时用 pack.yaml tests 段 /
 *    内置默认（pack 根下 tests/ 目录里任意深度的 *.test.lua）；给 path 时按
 *    "目录 → 目录 + "/" + ** + "/" + *.test.lua、单文件 → 原样 glob"折算成 include
 *    （见 {@link toIncludeGlob}）；
 * 3. 空清单 → 打印 cli.test.no_tests_found 并退出 0（不探测 hub、不绑编辑器端口）；
 * 4. {@link tryHubClient} 探测 hub（src/cli/_shared.js）：
 *    - **hub 在线**：委托 `POST /v1/test/run`（HubClient.testRun，阶段 C2d 落盘），
 *      首行打印 cli.test.hub_delegated；hub 侧失败（网络层 / 协议层）或响应不是
 *      RunReport 形状 → error.hub.delegateFailed 并退出 1，**不回退独立模式**
 *      （与 exec 命令同款理由：hub 在线时 39998 由 hub 独占，回退必然绑不上端口）；
 *    - **hub 离线**：独立模式——new EditorServer() → start() → new TestRunner(server)
 *      → runner.run(RunOptions)，跑完（含异常路径）在 finally 里 close() 释放端口；
 * 5. 输出：formatConsole(report, { color: true, verbose })（报告末行即结果总结）；
 *    --json 时 toJson(report) 落盘（自动创建父目录）并打印 `json: <绝对路径>`
 *    纯数据行；退出码非 0 时再按实际计数往 stderr 补 cli.test.failed / errored；
 * 6. 退出码：全过 0；有失败 1；有错误 2（错误优先于失败）；命令级异常一律 1。
 *
 * 与 hub 委托的字段对齐：阶段 C2d 的 HubClient.testRun 声明
 * `{ root, targetGuid?, timeoutMs?, bail?, bundle? }`，而 hub 的 /v1/test/run 路由
 * 另外接受可选 `include` 字符串数组（src/hub/control.ts 的 optionalStringArray，
 * 注释里写明"CLI 把位置参数 `tts test <path>` 委托给 hub 时用"）。本命令在有
 * `[path]` 时把折算出的 include 一并送过去（客户端方法把 opts 原样 JSON 序列化进
 * 请求体，多出的字段照常送达 hub），让两种模式的过滤语义一致——否则 hub 在线时
 * `[path]` 会被无声忽略、跑出"比用户要求更多"的测试。hub 响应体按 RunReport 直接
 * 解，同时兼容 `{ report: RunReport }` 包装（见 {@link unwrapRunReport}）。
 *
 * --target / --timeout 的缺省语义：两者都不在 commander 层写死默认值——缺省时沿用
 * 每个发现条目上的值（即 pack.yaml tests.target_guid / tests.timeout 或内置默认
 * "-1" / 30000，见 src/test/types.ts 的 DiscoveredTest）；显式给出时覆盖全部条目。
 * 这样 pack.yaml 的配置不会被 CLI 默认值无声压掉（任务书写"--target 默认 -1"，
 * 与 A2 discover 的"pack.yaml tests 段优先"语义合并为"CLI > pack.yaml > 内置默认"）。
 *
 * 本模块使用的 i18n 键（键名按 C3 已落盘的 locales/*.json 对齐；缺键时 t() 原样
 * 输出键名，可接受）：
 * - `cli.test.description`（无参）——命令描述
 * - `cli.test.argument.path`（无参）——位置参数 [path]
 * - `cli.test.option_root` / `cli.test.option_target` / `cli.test.option_timeout` /
 *   `cli.test.option_json` / `cli.test.option_bail` / `cli.test.option_bundle` /
 *   `cli.test.option_verbose`（均无参）；`--no-bundle` 复用 `cli.test.option_bundle`
 *   （其文案本身即"用 luabundle 打包多文件测试（--no-bundle 关闭）"，locales 里
 *   没有单独的 option_no_bundle 键）
 * - `cli.test.no_tests_found`（C3 文案无占位符；仍传 {root} 以便日后加占位）
 * - `cli.test.hub_delegated` {port}——hub 委托模式首行（端口取
 *   {@link HUB_CONTROL_PORT}）
 * - `cli.test.failed` {failed} / `cli.test.errored` {errored}——退出码非 0 时按
 *   实际计数补打的 stderr 摘要（分别只在 failed / errored > 0 时打印，不虚报 0）
 * 说明：`cli.test.summary`（C3 已落盘）与 formatConsole 报告末行"总结: 通过 …
 * / 失败 … / 错误 …"同文，故本命令不再重复打印。
 * 复用既有键：`error.hub.delegateFailed` {message}（exec 命令引入）、
 * `error.unknown` {msg}，以及 `` `error.${code}` `` 家族——PackError 统一出口
 * （含 Stage A 声明的 TEST_DISCOVER_* / TEST_RUN_* / TEST_ENTRY_NOT_FOUND /
 * TEST_BUNDLE_FAILED 等，locales 由 Stage C 补齐）。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Command, InvalidArgumentError } from "commander";

import { t } from "../../i18n/index.js";
import type { HubClient } from "../../mcp/client.js";
import { PackError } from "../../pack/packyaml.js";
import { EditorServer } from "../../protocol/editor-server.js";
import {
  discoverTests,
  formatConsole,
  TestRunner,
  toJson,
  type DiscoverTestsOptions,
  type DiscoveredTest,
  type RunOptions,
  type RunReport,
} from "../../test/index.js";
import { tryHubClient } from "../_shared.js";
import { describeError, isPortInUseError, red } from "../with-server.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 退出码：全部通过 */
export const EXIT_OK = 0;

/** 退出码：有断言失败（且没有错误） */
export const EXIT_FAILED = 1;

/** 退出码：有用例出错（优先级高于失败） */
export const EXIT_ERRORED = 2;

/** 目录型 path 折算出的 glob 后缀（目录 + "/" + ** + "/" + *.test.lua） */
const DIRECTORY_GLOB_SUFFIX = "/**/*.test.lua";

/** path 指到 pack 根（"." / "" / "./"）时的 include glob（任意深度的测试文件） */
const ROOT_GLOB = "**/*.test.lua";

/**
 * hub 控制通道缺省端口（S2 方案定值；与 src/hub/control.ts 的 DEFAULT_CONTROL_PORT、
 * src/mcp/client.ts 的 DEFAULT_HUB_PORT 一致，两处均未导出——与
 * src/cli/commands/status.ts 的 HUB_CONTROL_PORT 同款本地副本）。
 * 仅用于 cli.test.hub_delegated 文案里的 {port} 展示。
 */
const HUB_CONTROL_PORT = 39995;

// ---------------------------------------------------------------------------
// 选项类型
// ---------------------------------------------------------------------------

/** `tts test` 的选项（commander 已按 --kebab-case → camelCase 归一） */
interface TestOptions {
  /** 图包工作区根目录（默认 "."） */
  root: string;
  /** 目标对象 guid（缺省沿用发现条目上的值：pack.yaml tests.target_guid 或 "-1"） */
  target?: string;
  /** 单文件超时毫秒数（缺省沿用发现条目上的值：pack.yaml tests.timeout 或 30000） */
  timeout?: number;
  /** JSON 报告输出路径（缺省不落盘） */
  json?: string;
  /** 首个失败即停（--bail） */
  bail?: boolean;
  /** 是否启用 luabundle（--bundle / --no-bundle，缺省 true） */
  bundle?: boolean;
  /** 显示用例的 print 输出（--verbose） */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// hub 委托（阶段 C2d 的接口视图）
// ---------------------------------------------------------------------------

/** 阶段 C2d 的 HubClient.testRun 入参（本窗口按契约调用）。 */
export interface TestRunRequest {
  /** 图包工作区根 */
  root: string;
  /** 目标对象 guid（缺省由 hub 侧按 pack.yaml / "-1" 决定） */
  targetGuid?: string;
  /** 单文件超时毫秒数（缺省由 hub 侧按 pack.yaml / 30000 决定） */
  timeoutMs?: number;
  /**
   * 发现的 include glob 列表（[path] 位置参数折算结果；缺省由 hub 侧按 pack.yaml
   * tests.include / 内置默认决定）。HubClient.testRun 的定型签名未列此字段，但
   * hub 的 /v1/test/run 路由接受它（见 {@link TestRunDelegator} 的说明）。
   */
  include?: string[];
  /** 首个失败即停 */
  bail?: boolean;
  /** 是否启用 bundle */
  bundle?: boolean;
}

/**
 * hub 委托所需的最小结构化方法视图（HubClient.testRun 的超集）。
 *
 * 为什么经结构化收窄（`as unknown as`）而不是直接调 `hub.testRun(...)`：C2 落盘的
 * HubClient.testRun 只声明 5 个字段，而 hub 的 /v1/test/run 路由另外接受可选
 * `include`（src/hub/control.ts 的 optionalStringArray：专为"CLI 把 `tts test <path>`
 * 委托给 hub"准备）。本视图补上 include，避免 hub 在线时 [path] 被无声忽略；
 * 客户端方法把 opts 原样序列化进请求体，多出的字段会照常送达 hub。
 */
interface TestRunDelegator {
  testRun(opts: TestRunRequest): Promise<unknown>;
}

/** hub 委托失败（网络层 / 协议层 / 响应形状不符）：报错并退出 1，不回退独立模式。 */
class HubDelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubDelegationError";
  }
}

// ---------------------------------------------------------------------------
// 纯函数小工具
// ---------------------------------------------------------------------------

/** 判定值是否为"键值对象"（不含 null 与数组） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 宽松判定一个值是否具备 RunReport 的关键形状（results 数组 + total 数字） */
function looksLikeRunReport(value: unknown): value is RunReport {
  return isPlainObject(value) && Array.isArray(value.results) && typeof value.total === "number";
}

/**
 * 从 hub 委托的响应体里取出 RunReport：响应体本身是 RunReport 时原样返回；
 * 是 `{ report: RunReport }` 包装时取 report；两者都不是时返回 undefined
 * （调用方按委托失败处理，绝不用半截数据编报告）。
 */
function unwrapRunReport(body: unknown): RunReport | undefined {
  if (looksLikeRunReport(body)) {
    return body;
  }
  if (isPlainObject(body) && looksLikeRunReport(body.report)) {
    return body.report;
  }
  return undefined;
}

/**
 * 报告 → 退出码：有错误 2（优先）> 有失败 1 > 全过 0。
 *
 * @param report 运行报告
 * @returns 退出码常量（{@link EXIT_OK} / {@link EXIT_FAILED} / {@link EXIT_ERRORED}）
 */
export function exitCodeFor(report: RunReport): number {
  if (report.errored > 0) {
    return EXIT_ERRORED;
  }
  if (report.failed > 0) {
    return EXIT_FAILED;
  }
  return EXIT_OK;
}

/**
 * commander 的 --timeout 值解析：正整数毫秒数。
 *
 * 非法值抛 InvalidArgumentError（commander 打印用法行并以退出码 1 结束），
 * 不把 NaN / 负数带进运行层。
 *
 * @param value 命令行原文
 * @returns 正整数毫秒数
 * @throws {InvalidArgumentError} 不是正整数时
 */
export function parseTimeoutMs(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("必须是正整数（毫秒）");
  }
  return parsed;
}

/**
 * 把 [path] 位置参数折算成 discoverTests 的 include glob。
 *
 * 规则（候选路径是"相对 pack 根、以 / 分隔"的路径，见 src/test/discover.ts）：
 * - 绝对路径先相对 `root` 折算；
 * - 已含 glob 通配（`*` / `?`）→ 原样使用；
 * - 以 `.lua` 结尾 → 视为单个测试文件，原样使用；
 * - 其余按目录处理：去掉首尾的 "./" 与结尾斜杠后拼 "/" + ** + "/" + *.test.lua；
 * - 折算结果为 "." / 空（指到 pack 根）→ 任意深度的 *.test.lua。
 *
 * @param inputPath [path] 位置参数原文
 * @param root 图包工作区根（解释绝对路径用）
 * @returns discoverTests 的 include 模式
 */
export function toIncludeGlob(inputPath: string, root: string): string {
  const relative = path.isAbsolute(inputPath)
    ? path.relative(path.resolve(root), inputPath)
    : inputPath;
  const normalized = relative
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (normalized.includes("*") || normalized.includes("?")) {
    return normalized;
  }
  if (normalized.endsWith(".lua")) {
    return normalized;
  }
  if (normalized === "" || normalized === ".") {
    return ROOT_GLOB;
  }
  return `${normalized}${DIRECTORY_GLOB_SUFFIX}`;
}

/**
 * 把 --target / --timeout 的显式覆盖值应用到每个发现条目上。
 *
 * 两者都未给出时原样返回（沿用 pack.yaml tests 段 / 内置默认）；给出时覆盖全部
 * 条目（单元素级字段覆盖，不动 filePath / relativePath）。
 *
 * @param files discoverTests 的发现结果
 * @param targetGuid 显式 --target（undefined / 空串 = 不覆盖）
 * @param timeoutMs 显式 --timeout（undefined = 不覆盖）
 * @returns 覆盖后的发现条目清单
 */
function applyOverrides(
  files: DiscoveredTest[],
  targetGuid: string | undefined,
  timeoutMs: number | undefined,
): DiscoveredTest[] {
  const overrideTarget =
    targetGuid !== undefined && targetGuid !== "" ? targetGuid : undefined;
  if (overrideTarget === undefined && timeoutMs === undefined) {
    return files;
  }
  return files.map((file) => ({
    ...file,
    ...(overrideTarget !== undefined ? { targetGuid: overrideTarget } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }));
}

// ---------------------------------------------------------------------------
// 委托 / 独立运行 / 输出
// ---------------------------------------------------------------------------

/**
 * 调 hub 的 `POST /v1/test/run`（HubClient.testRun）并解出 RunReport。
 *
 * @param hub tryHubClient() 返回的 hub 客户端
 * @param request 委托请求体（对应 hub 侧 RunOptions 除 server / files 外的字段）
 * @returns hub 侧产出的运行报告
 * @throws {HubDelegationError} 请求失败（HubError / HubNotRunningError）或响应
 *   不是 RunReport 形状时（消息里带原始原因，供 error.hub.delegateFailed 呈现）
 */
async function delegateRun(hub: HubClient, request: TestRunRequest): Promise<RunReport> {
  let body: unknown;
  try {
    body = await (hub as unknown as TestRunDelegator).testRun(request);
  } catch (err) {
    throw new HubDelegationError(describeError(err));
  }
  const report = unwrapRunReport(body);
  if (report === undefined) {
    throw new HubDelegationError("/v1/test/run 响应不是 RunReport 形状（缺 results / total 字段）");
  }
  return report;
}

/**
 * 独立模式：临时独占编辑器端口（39998）跑完一整轮测试后释放。
 *
 * EditorServer 由本函数创建并 start；TestRunner 复用该 server 做 Print 快照 /
 * 差分。**process.exit 必须在 finally 之后**（本函数返回后由 action 统一退出），
 * 否则端口不会通过 close() 释放——与 src/cli/with-server.ts 的告诫同源。
 *
 * @param root 图包工作区根
 * @param files 已发现（并套用覆盖值）的测试文件清单
 * @param opts 命令选项（bundle / bail）
 * @returns 运行报告
 * @throws {PortInUseError} 39998 被占用（统一错误出口按端口占用呈现）
 */
async function runStandalone(
  root: string,
  files: DiscoveredTest[],
  opts: TestOptions,
): Promise<RunReport> {
  const server = new EditorServer();
  await server.start();
  try {
    const runner = new TestRunner(server);
    const runOptions: RunOptions = {
      root,
      files,
      server,
      bundle: opts.bundle !== false,
      bail: opts.bail === true,
    };
    return await runner.run(runOptions);
  } finally {
    await server.close();
  }
}

/**
 * 把 --json 报告写到指定路径（父目录不存在时自动创建）。
 * @param jsonPath 命令行的 --json 值（相对路径按 cwd 解析）
 * @param report 运行报告
 * @returns 实际写入的绝对路径
 */
async function writeJsonReport(jsonPath: string, report: RunReport): Promise<string> {
  const resolved = path.resolve(jsonPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, toJson(report), "utf8");
  return resolved;
}

/**
 * `tts test` 的统一错误出口（与 pack/build/publish 的 report*Error 同款；命令层
 * 模块之间按仓库约定不互相 import，故为本地副本）。
 *
 * 分类顺序：hub 委托失败 → PackError 按 `` `error.${code}` `` → 端口占用（协议层
 * 中文原文）→ error.unknown。全部只写 stderr，绝不向 stdout 混入错误信息。
 *
 * @param err action 中捕获的异常
 * @returns 建议的进程退出码（恒为 1）
 */
function reportTestError(err: unknown): number {
  if (err instanceof HubDelegationError) {
    console.error(t("error.hub.delegateFailed", { message: err.message }));
    return EXIT_FAILED;
  }
  if (err instanceof PackError) {
    console.error(t(`error.${err.code}`, { msg: err.message }));
    return EXIT_FAILED;
  }
  if (isPortInUseError(err)) {
    console.error(red(err.message));
    return EXIT_FAILED;
  }
  console.error(t("error.unknown", { msg: describeError(err) }));
  return EXIT_FAILED;
}

/**
 * 命令主体：发现 → （hub 委托 | 独立运行）→ 输出 → 计算退出码。
 *
 * 本函数**不**调用 process.exit：调用方（action）在其返回 / 抛错之后统一退出，
 * 确保独立模式的 close() 已经执行完。
 *
 * @param pathArg [path] 位置参数（undefined / 空串 = 用默认发现配置）
 * @param opts 命令选项
 * @returns 退出码（0 / 1 / 2，见 {@link exitCodeFor}）
 * @throws {HubDelegationError} hub 委托失败时
 * @throws {PackError} 发现 / 读取 / 落盘等业务失败时
 */
async function runTest(pathArg: string | undefined, opts: TestOptions): Promise<number> {
  const root = opts.root;
  const targetGuid = opts.target?.trim();
  const jsonPath = opts.json?.trim();

  // —— 1. 发现测试文件（pack.yaml tests 段不可用等只告警，不中断）——
  const pathFilter = pathArg?.trim();
  const include =
    pathFilter !== undefined && pathFilter !== ""
      ? [toIncludeGlob(pathFilter, root)]
      : undefined;
  const discoverOptions: DiscoverTestsOptions = {
    root,
    ...(include !== undefined ? { include } : {}),
    onWarning: (warning) => {
      console.error(t(`error.${warning.code}`, { msg: warning.message }));
    },
  };
  const discovered = await discoverTests(discoverOptions);

  // —— 2. 空清单：不探测 hub、不绑端口，退出 0 ——
  if (discovered.length === 0) {
    console.log(t("cli.test.no_tests_found", { root: path.resolve(root) }));
    return EXIT_OK;
  }
  const files = applyOverrides(discovered, targetGuid, opts.timeout);

  // —— 3. hub 在线走委托，离线走独立模式 ——
  const hub = await tryHubClient();
  let report: RunReport;
  if (hub !== null) {
    console.log(t("cli.test.hub_delegated", { port: HUB_CONTROL_PORT }));
    report = await delegateRun(hub, {
      root,
      ...(include !== undefined ? { include } : {}),
      ...(targetGuid !== undefined && targetGuid !== "" ? { targetGuid } : {}),
      ...(opts.timeout !== undefined ? { timeoutMs: opts.timeout } : {}),
      bail: opts.bail === true,
      bundle: opts.bundle !== false,
    });
  } else {
    report = await runStandalone(root, files, opts);
  }

  // —— 4. 输出：控制台报告（末行即结果总结）→ 可选 JSON 落盘 ——
  console.log(formatConsole(report, { color: true, verbose: opts.verbose === true }));
  if (jsonPath !== undefined && jsonPath !== "") {
    const written = await writeJsonReport(jsonPath, report);
    console.log(`json: ${written}`);
  }

  // —— 5. 退出码（错误优先于失败）；非 0 时按实际计数补 stderr 摘要 ——
  const exitCode = exitCodeFor(report);
  if (report.failed > 0) {
    console.error(t("cli.test.failed", { failed: report.failed }));
  }
  if (report.errored > 0) {
    console.error(t("cli.test.errored", { errored: report.errored }));
  }
  return exitCode;
}

// ---------------------------------------------------------------------------
// 主命令
// ---------------------------------------------------------------------------

/**
 * `tts test` 主命令：发现 → hub 委托 / 独立运行 → 报告 → 退出码（薄调用层）。
 *
 * 注册由主窗口统一加进 src/cli/index.ts（本窗口不动 CLI 入口）。
 */
export const testCommand: Command = new Command("test")
  .description(t("cli.test.description"))
  .argument("[path]", t("cli.test.argument.path"))
  .option("--root <dir>", t("cli.test.option_root"), ".")
  .option("--target <guid>", t("cli.test.option_target"))
  .option("--timeout <ms>", t("cli.test.option_timeout"), parseTimeoutMs)
  .option("--json <path>", t("cli.test.option_json"))
  .option("--bail", t("cli.test.option_bail"))
  .option("--bundle", t("cli.test.option_bundle"), true)
  // locales 没有单独的 option_no_bundle 键：bundle 的文案本身即"--no-bundle 关闭"，
  // 两个开关共用同一条描述（缺键时也不会漏出裸键名）
  .option("--no-bundle", t("cli.test.option_bundle"))
  .option("--verbose", t("cli.test.option_verbose"))
  .action(async (pathArg: string | undefined, opts: TestOptions) => {
    // process.exit 放在 try/catch 之外：既不让退出动作被自己的错误出口二次捕获
    // （否则退出码 2 会被改写成 1），也保证独立模式的 finally（close）已执行完。
    let exitCode: number;
    try {
      exitCode = await runTest(pathArg, opts);
    } catch (err) {
      exitCode = reportTestError(err);
    }
    if (exitCode !== EXIT_OK) {
      process.exit(exitCode);
    }
  });

export default testCommand;
