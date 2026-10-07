// src/mcp/server.ts
/**
 * tts-toolkit MCP 服务器入口（stdio 传输，阶段 4）。
 *
 * 职责（{@link main}）：
 * 1. 解析 `--lang` 参数并初始化 i18n（优先级：--lang > 全局配置文件 >
 *    系统 locale > zh-CN，与 src/i18n/index.ts 的解析链一致）；
 * 2. 安装进程级致命错误兜底（uncaughtException / unhandledRejection →
 *    stderr JSON Lines 英文一行 → exit 1）；
 * 3. 创建 hub 控制通道客户端（HubClient，缺省 127.0.0.1:39995）；
 * 4. 注册 12 个工具（src/mcp/tools/*.ts，每个文件一个 register()）；
 * 5. `await server.connect(new StdioServerTransport())`——main 随之 resolve，
 *    进程由传输层事件循环保持常驻。
 *
 * 约定：
 * - stdout 是 MCP 协议通道，本模块不向 stdout 写任何非协议内容；诊断只走
 *   stderr 且为 JSON Lines 英文（与 hub 日志同口径，消费方是运维与 MCP 客户端
 *   日志面板）；
 * - 工具内部绝不调用 process.exit（错误一律以 isError:true 的工具结果返回）；
 *   只有进程级兜底处理器可以 exit 1；
 * - `--lang` 只接受字面 "zh-CN" / "en-US"（i18n 模块对显式 lang 不做猜测）。
 *   非法值不阻塞 MCP 会话启动：写一条 stderr 告警后回退默认解析链（全局配置 >
 *   系统 locale > zh-CN）；
 * - 工具的 title / description 经 t() 双语（键缺翻译时 t() 自行回退/输出键名）；
 *   工具返回值是结构化 JSON（英文键名），不走 t()。
 *
 * i18n key 清单（本模块与 tools/*.ts 使用的全部键；zh-CN / en-US 双语镜像由
 * locales/*.json 提供，键缺失时 t() 按其自身规则回退）：
 * - `mcp.tool.tts_status.title`      / `mcp.tool.tts_status.description`
 * - `mcp.tool.tts_pull.title`        / `mcp.tool.tts_pull.description`
 * - `mcp.tool.tts_exec.title`        / `mcp.tool.tts_exec.description`
 * - `mcp.tool.tts_assets.title`      / `mcp.tool.tts_assets.description`
 * - `mcp.tool.tts_pack_list.title`   / `mcp.tool.tts_pack_list.description`
 * - `mcp.tool.tts_deck_slice.title`  / `mcp.tool.tts_deck_slice.description`
 * - `mcp.tool.tts_deck_plan.title`   / `mcp.tool.tts_deck_plan.description`
 * - `mcp.tool.tts_import.title`      / `mcp.tool.tts_import.description`
 * - `mcp.tool.tts_diff.title`        / `mcp.tool.tts_diff.description`
 * - `mcp.tool.tts_push.title`        / `mcp.tool.tts_push.description`
 * - `mcp.tool.tts_test_run.title`    / `mcp.tool.tts_test_run.description`
 * - `mcp.tool.tts_pack_build.title`  / `mcp.tool.tts_pack_build.description`
 */

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import pkg from "../../package.json" with { type: "json" };
import { initI18n, type Lang } from "../i18n/index.js";
import { HubClient } from "./client.js";
import { register as registerAssets } from "./tools/assets.js";
import { register as registerDeckPlan } from "./tools/deck-plan.js";
import { register as registerDeckSlice } from "./tools/deck-slice.js";
import { register as registerDiff } from "./tools/diff.js";
import { register as registerExec } from "./tools/exec.js";
import { register as registerImport } from "./tools/import.js";
import { register as registerPackBuild } from "./tools/pack-build.js";
import { register as registerPackList } from "./tools/pack-list.js";
import { register as registerPull } from "./tools/pull.js";
import { register as registerPush } from "./tools/push.js";
import { register as registerStatus } from "./tools/status.js";
import { register as registerTestRun } from "./tools/test-run.js";

/** MCP 服务器名（MCP 客户端 initialize 时可见）。 */
const SERVER_NAME = "tts-toolkit";

/** MCP 服务器版本（与 package.json 的 version 保持一致，import 时直接读）。 */
const SERVER_VERSION = pkg.version;

/** `--lang` 参数的合法字面值（i18n 模块对显式 lang 不做猜测，只认全称）。 */
function isSupportedLang(value: string | undefined): value is Lang {
  return value === "zh-CN" || value === "en-US";
}

/** {@link parseLangArg} 的结果（三态：未提供 / 合法 / 非法）。 */
type LangArgResult =
  | { kind: "none" }
  | { kind: "ok"; lang: Lang }
  | { kind: "invalid"; value: string };

/**
 * 从命令行参数解析 `--lang`（支持 `--lang zh-CN` 与 `--lang=zh-CN` 两种写法；
 * 只扫第一个出现的 --lang，其余忽略）。不使用 commander：MCP 服务器是独立
 * stdio 入口，参数面刻意保持最小。
 *
 * @param argv 命令行参数（含 node 与脚本路径）
 * @returns 未提供 → none；合法 → ok；提供但值非法/缺值 → invalid
 */
function parseLangArg(argv: readonly string[]): LangArgResult {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--lang") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { kind: "invalid", value: "(missing)" };
      }
      return isSupportedLang(next) ? { kind: "ok", lang: next } : { kind: "invalid", value: next };
    }
    if (arg.startsWith("--lang=")) {
      const value = arg.slice("--lang=".length);
      return isSupportedLang(value) ? { kind: "ok", lang: value } : { kind: "invalid", value };
    }
  }
  return { kind: "none" };
}

/**
 * 向 stderr 写一行 JSON Lines（英文诊断；stderr 不可写时静默放弃——诊断通道
 * 自身的失败不能再触发进程级错误处理，否则会递归）。
 *
 * @param payload 诊断载荷（键为英文约定：level / type / message / stack）
 */
function writeStderrLine(payload: Record<string, string>): void {
  try {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // 诊断通道失败无路可报，吞掉
  }
}

/**
 * 安装进程级致命错误兜底：uncaughtException / unhandledRejection 各写一条
 * stderr JSON Lines（英文）后 exit 1。
 *
 * 只在 {@link main} 里调用一次；工具运行期错误不经过这里（工具层自己捕获并
 * 转成 isError 结果），走到这里的已经是服务器本体无法继续的异常。
 */
function installFatalHandlers(): void {
  process.on("uncaughtException", (err: Error) => {
    writeStderrLine({
      level: "fatal",
      type: "uncaughtException",
      message: err.message,
      stack: err.stack ?? "",
    });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    writeStderrLine({
      level: "fatal",
      type: "unhandledRejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? (reason.stack ?? "") : "",
    });
    process.exit(1);
  });
}

/**
 * MCP 服务器入口：初始化 i18n → 安装致命错误兜底 → 创建 HubClient → 注册
 * 10 个工具 → 挂 stdio 传输。connect 完成后本函数 resolve，进程随传输层的
 * 事件循环常驻，直到客户端断开或致命错误触发 exit 1。
 *
 * @returns connect 完成即 resolve 的 Promise（此后由传输层维持会话）
 * @throws McpServer.connect 失败（如传输初始化异常）时向上抛——该失败不属于
 *   工具调用，调用方（bin 入口 / tts mcp 命令）决定如何呈现
 */
export async function main(): Promise<void> {
  installFatalHandlers();

  const langArg = parseLangArg(process.argv);
  if (langArg.kind === "invalid") {
    writeStderrLine({
      level: "warn",
      message: `unsupported --lang value ${JSON.stringify(langArg.value)}; expected "zh-CN" or "en-US"; falling back to global config / system locale / zh-CN`,
    });
  }
  initI18n(langArg.kind === "ok" ? { lang: langArg.lang } : {});

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const client = new HubClient();

  registerStatus(server, client);
  registerPull(server, client);
  registerExec(server, client);
  registerAssets(server, client);
  registerPackList(server, client);
  registerDeckSlice(server, client);
  registerDeckPlan(server, client);
  registerImport(server, client);
  registerDiff(server, client);
  registerPush(server, client);

  // 阶段 7（窗口 G）：测试运行器 + 发布链路（hub 路由 /v1/test/run、/v1/pack/build）
  registerTestRun(server, client);
  registerPackBuild(server, client);

  await server.connect(new StdioServerTransport());
}
