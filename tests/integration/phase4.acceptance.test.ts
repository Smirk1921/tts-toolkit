// tests/integration/phase4.acceptance.test.ts
/**
 * 阶段 4 集成验收骨架：hub 守护进程（39998 入站独占 + 39997 TCP / 39996 WS 扇出
 * + 39995 S2 控制通道）+ CLI 委托自动切换 + MCP stdio 服务。
 *
 * 对照《施工流程》阶段 4「验收标准」与窗口 D 契约文档
 * （docs/schemas/hub-control.md；README §10 是使用方视角的同一份事实）。
 *
 * 风格与 phase2b / phase2c / phase3 一致，但本文件是 **Stage 4 主窗口真实验收** 的
 * 执行清单：
 * - 默认全部 `it.skip`（用例级开关，不是 describe.skip）——`npm test` 只计为 skipped，
 *   不执行、不纳入日常 CI；
 * - Stage 4 逐个删除 `.skip` 打开用例：先按用例内 TODO 装配夹具 / 构造坏样本，再跑
 *   `npx vitest run tests/integration/phase4.acceptance.test.ts`
 *   （或 `npm run test:integration`，会同时带上 phase1 的 describe.skip）；
 * - 每个用例体只有 TODO 与一条 `todo(...)` 守卫——**故意不写成空函数体**：未实现就
 *   打开会明确失败（抛出"尚未实现"），不会给出假绿。该 `todo` 是本文件自己的抛错
 *   函数，不是 vitest 的 todo API。
 *
 * 前置条件（缺一不可）：
 * 1. 已执行 `npm run build`（测试通过 node 子进程调用 dist/cli/index.js、
 *    dist/cli/hub-main.js、dist/mcp/main.js，不是 tsx 源码）；
 * 2. **端口必须空闲**：场景 1-6、8、10 需要控制通道缺省端口 39995（CLI / MCP 客户端
 *    没有端口覆盖入口：`src/cli/_shared.ts` 与 `src/mcp/client.ts` 的缺省值固定
 *    39995）。凡涉及 `tts status` 或 `tts-mcp` 的场景，必须保证 39995 空闲且由本测试
 *    启动的 hub 独占；hub 四个缺省端口（39995-39998）在对应场景运行期间不得被外部
 *    程序占用（`checkExclusive` 是唯一合法探测口径，见 src/protocol/ports.ts）；
 * 3. **TTS 不是全部场景的前置**：场景 1、4、7、8、9、10 完全离线可测（TTS 未运行是
 *    合法状态，GET /v1/status 仍 200 且 tts.connected=false）；场景 2、3、5 的"收到
 *    数据"分支用**假 TTS**（net.connect(39998) 推合法入站 JSON；消息 schema 见
 *    src/protocol/messages.ts）驱动，无需真实游戏；只有标注「需 TTS」的可选分支才
 *    需要游戏运行并处于编辑器模式（39999 可达），缺失时应 console.warn 后跳过该
 *    分支，而不是伪造成功；
 * 4. 测试自身**不改仓库内文件、不改用户全局配置**：夹具一律在 mkdtemp 临时目录内
 *    构造；所有后台 hub / MCP 子进程必须在 afterAll 或用例 finally 中收干净
 *    （shutdown 优先、超时兜底 kill），绝不留下占用 39995-39998 的孤儿进程。
 *
 * 断言口径：
 * - 端口独占一律用 `checkExclusive`（src/protocol/ports.ts；带 Windows SO_REUSEADDR
 *   双绑防护）——"39998 被 hub 独占 / 退出后释放"都以它的返回值为准；
 * - HTTP 控制面用 `fetch`（Node 内置）直连 `http://127.0.0.1:<port>/v1`：断言
 *   status / `content-type` / 错误体 `{error:{code,message,details?}}` 的 code 分支，
 *   **不解析 message**（协议层英文；业务错误的 message 不属契约）；
 * - CLI 进程出口 = stdout 摘要（t() 文案，单行）/ stderr 错误 / exitCode；文案键与
 *   期望值以 locales/zh-CN.json 为准（如 `cli.status.connectedViaHub` /
 *   `cli.status.hubOnlineTtsOffline` / `cli.status.notRunning`），断言用"包含键对应
 *   文案的稳定片段"而不是整行（{placeholder} 值随端口 / 路径变化）；
 * - hub 常驻进程按日志行同步：等 stdout 出现 `control server listening on
 *   127.0.0.1:<port>`（src/hub/control.ts）或本地化 `cli.hub.started`；停止优先
 *   POST `/v1/hub/shutdown`（先断言 200 `{ok:true}`、再等进程 exitCode 0 与
 *   `cli.hub.stopped` 收尾）；
 * - MCP 走 stdio：stdout 是协议通道（只允许 JSON-RPC），诊断只应出现在 stderr
 *   （JSON Lines 英文）；断言 initialize 的 serverInfo 与工具清单，不解析展示文案。
 *
 * 用例 ↔ 验收标准映射（10 个场景）：
 * 1     hub 启动后独占 39998，外部 checkExclusive(39998) 失败
 * 2     39997 TCP 转发：假 TTS 连 39998 推消息 → TCP 客户端收到同样的 JSON
 * 3     39996 WS 广播：WS 握手 → 假 TTS 推消息 → WS 收到文本帧
 * 4     39995 控制通道 12 条路由都通（至少 GET /v1/status 200）
 * 5     GET /v1/events SSE 事件流
 * 6     hub 在线时 tts status 走委托模式（不占 39998）
 * 7     hub 不在线时 tts status 走独立模式（临时绑 39998）
 * 8     POST /v1/push 不带 confirm:true → 400 HUB_CONFIRM_REQUIRED
 * 9     tts-mcp 通过 stdio 启动后能响应 MCP initialize 握手
 * 10    hub 优雅退出（SIGINT 或 POST /v1/hub/shutdown）后 39998 释放
 */

import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa, type ResultPromise } from "execa";
import { afterAll, describe, expect, it } from "vitest";

import { EDITOR_PORT, HUB_TCP_PORT, HUB_WS_PORT, checkExclusive } from "../../src/protocol/ports.js";

// ---------------------------------------------------------------------------
// 常量与夹具
// ---------------------------------------------------------------------------

/** 项目根目录：由本文件位置回推（tests/integration → 项目根）。 */
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** CLI 入口（先 `npm run build`）。 */
const CLI_ENTRY = path.join(PROJECT_ROOT, "dist", "cli", "index.js");

/** `tts-hub` bin 入口（无选项薄启动层；src/cli/hub-main.ts）。 */
const HUB_MAIN_ENTRY = path.join(PROJECT_ROOT, "dist", "cli", "hub-main.js");

/** `tts-mcp` bin 入口（stdio，MCP 协议；src/mcp/main.ts）。 */
const MCP_MAIN_ENTRY = path.join(PROJECT_ROOT, "dist", "mcp", "main.js");

/**
 * 控制通道缺省端口。CLI / MCP 客户端没有端口覆盖入口（`src/cli/_shared.ts` 与
 * `src/mcp/client.ts` 的缺省值），凡涉及委托 / MCP 的场景必须使用本端口。
 */
const CONTROL_PORT = 39995;

/** 编辑器入站缺省端口（hub 运行期独占；src/protocol/ports.ts）。 */
const EDITOR = EDITOR_PORT;

/** TCP 扇出缺省端口（fanout.ts：下游连入后原样收 JSON 串）。 */
const TCP_FANOUT = HUB_TCP_PORT;

/** WS 扇出缺省端口（daemon.ts：手写 RFC6455，下游只收文本帧）。 */
const WS_FANOUT = HUB_WS_PORT;

/** 控制通道请求 / 探测的等待上限（probeHub 固定 800ms，这里给足 CI 余量）。 */
const HTTP_TIMEOUT_MS = 10_000;

/** hub 启动 / 停止的等待上限。 */
const HUB_BOOT_TIMEOUT_MS = 15_000;
const HUB_STOP_TIMEOUT_MS = 10_000;

/** runCli 的附加选项。 */
interface CliRunOptions {
  /** 追加 / 覆盖子进程环境变量 */
  env?: Record<string, string>;
}

/**
 * 运行一次 `tts` CLI（前台、等到退出）。
 *
 * 统一从项目根目录启动、utf8 输出、reject:false（非 0 退出码不抛异常，集成测试显式
 * 断言 exitCode）。
 *
 * @param args 子命令与参数（不含 node 与入口路径）
 * @param opts 额外选项（见 {@link CliRunOptions}）
 * @returns execa 结果对象（stdout / stderr / exitCode）
 */
function runCli(args: readonly string[], opts: CliRunOptions = {}) {
  return execa("node", [CLI_ENTRY, ...args], {
    cwd: PROJECT_ROOT,
    reject: false,
    encoding: "utf8" as const,
    timeout: 120_000,
    ...opts,
  });
}

/** 后台 hub 句柄（startHub / stopHub 的载体）。 */
interface HubHandle {
  /** hub 子进程（长驻；reject:false，退出码由用例断言） */
  proc: ResultPromise;
  /** 本次 hub 的控制通道端口 */
  controlPort: number;
  /** 已收到的 stdout 文本（拼接，用于日志断言） */
  stdout: () => string;
  /** 已收到的 stderr 文本 */
  stderr: () => string;
}

/**
 * 后台启动 `tts hub` 并等控制通道可服务。
 *
 * 同步信号：等 stdout 出现 `control server listening on 127.0.0.1:<port>`
 * （control.ts:568 的控制通道日志行）或本地化 `cli.hub.started`；两者任一出现后再
 * 探一次 GET /v1/status 确认可服务。
 *
 * @param args 追加给 `tts hub` 的选项（如 `["--port", "40095", "--editor-port", "40098"]`）
 * @returns hub 句柄（afterAll / finally 必须 stopHub）
 */
async function startHub(args: readonly string[] = []): Promise<HubHandle> {
  const proc = execa("node", [CLI_ENTRY, "hub", ...args], {
    cwd: PROJECT_ROOT,
    reject: false,
    encoding: "utf8",
    buffer: false,
  });
  let out = "";
  let err = "";
  proc.stdout?.on("data", (chunk: string) => {
    out += chunk;
  });
  proc.stderr?.on("data", (chunk: string) => {
    err += chunk;
  });
  // TODO(Stage 4)：轮询 out 里的 `control server listening on` 并解析端口；超时
  // （HUB_BOOT_TIMEOUT_MS）抛错并 kill 子进程。随后 GET /v1/status 探活成功再返回。
  return { proc, controlPort: CONTROL_PORT, stdout: () => out, stderr: () => err };
}

/**
 * 优雅停止 hub（先 POST /v1/hub/shutdown，失败再 kill）。
 *
 * @param hub startHub 的返回值
 */
async function stopHub(hub: HubHandle): Promise<void> {
  // TODO(Stage 4)：POST http://127.0.0.1:<port>/v1/hub/shutdown（断言 {ok:true}）→
  // await 子进程（HUB_STOP_TIMEOUT_MS）；超时 / 异常时 hub.proc.kill() 兜底。
  void hub;
}

/**
 * 发一次控制通道请求。
 *
 * @param port 控制通道端口
 * @param method HTTP 方法
 * @param route /v1 下的路径（如 "/status"）
 * @param body 可选请求体（对象时自动 JSON.stringify + application/json）
 * @returns 状态码 / 响应头 / 已解析 JSON（解析失败时为原始文本）
 */
async function httpJson(
  port: number,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const init: RequestInit = { method, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch(`http://127.0.0.1:${port}/v1${route}`, init);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 保留原始文本（SSE / 非 JSON 响应）
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

/** 本文件创建的临时工作区（mkdtemp）；afterAll 统一递归删除。 */
const tempDirs: string[] = [];

/**
 * 建临时工作区并登记清理（所有夹具都在临时目录内构造，绝不改仓库内文件）。
 * @param prefix 目录名前缀（如 "tts-phase4-"）
 * @returns 新建临时目录的绝对路径
 */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 检查本机某端口是否可绑定（前置条件守卫 / 找空闲端口用；正式断言端口独占仍用
 * {@link checkExclusive}）。
 * @param port 端口号
 * @returns 可绑定返回 true
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

// ---------------------------------------------------------------------------
// 骨架守卫
// ---------------------------------------------------------------------------

/**
 * 未实现就打开用例时立即失败——防止仅含注释的函数体给出"假绿"。
 * @param scenario 场景名（用于失败信息）
 */
function todo(scenario: string): never {
  throw new Error(
    `TODO(Stage 4)：${scenario} 尚未实现——请先按用例内 TODO 装配夹具与断言，再移除本守卫。`,
  );
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("阶段 4 集成验收：hub 守护进程 + S2 控制通道 + CLI 委托 + MCP", () => {
  afterAll(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.skip("场景 1：tts hub 启动后独占 39998（外部 checkExclusive(39998) 失败）", async () => {
    // TODO(Stage 4)（全离线；39995-39998 需空闲）：
    // 1) 前置：startHub([])（缺省四端口）或先取空闲端口再 startHub(["--port", …,
    //    "--editor-port", …, "--tcp-port", …, "--ws-port", …])（选项见 hub.ts:95-99）；
    // 2) 启动信号：stdout 出现 `control server listening on 127.0.0.1:<port>`
    //    （control.ts:568，纯英文日志行）与 JSON Lines `{"level":"info","msg":"hub
    //    started","port":…}`（lifecycle.ts:198），随后 `cli.hub.started` 文案（含
    //    {controlPort}{editorPort}{tcpPort}{wsPort} 四个端口，hub.ts:128）；
    // 3) **本场景核心**：在本测试进程直接调 checkExclusive(EDITOR_PORT)（导入自
    //    src/protocol/ports.js）→ 断言 `{ok:false}`（39998 被 hub 独占；Windows 下
    //    reason 含占用 PID）；
    // 4) 交叉验证：GET /v1/status → 200 且 `hub.editor === true`（响应形见
    //    control.ts:743-787），证明端口持有者就是 hub 本身，而不是别的进程；
    // 5) 收尾 stopHub；释放断言留给场景 10。
    todo("场景 1：hub 独占 39998");
  });

  it.skip("场景 2：39997 TCP 转发（假 TTS 连 39998 推消息 → TCP 客户端收到同样 JSON）", async () => {
    // TODO(Stage 4)（全离线；用假 TTS 驱动，不需要真实游戏）：
    // 1) startHub([])；net.connect(TCP_FANOUT) 作为 TCP 下游（连入即注册，fanout.ts:1-15）；
    // 2) 假 TTS：net.connect(EDITOR_PORT) 后写入一条合法入站消息，如
    //    `{"messageID":2,"message":"phase4-hello"}`（InboundId.Print=2，schema 见
    //    src/protocol/messages.ts:17-34 / :79-82），随后保持连接不关；
    // 3) 断言 TCP 下游收到的字节 === 原始 JSON 串（**原样、无换行分隔符、无包装**；
    //    fanout.ts 模块头的 TCP 约定）；
    // 4) 断开下游 socket → 再 GET /v1/status，断言 `hub.tcpClients` 减 1（断开自动摘除，
    //    无轮询探活）；
    // 5) 收尾：关闭假 TTS / 下游连接，stopHub。
    todo("场景 2：39997 TCP 转发");
  });

  it.skip("场景 3：39996 WS 广播（握手 → 假 TTS 推消息 → WS 收到文本帧）", async () => {
    // TODO(Stage 4)（全离线）：
    // 1) startHub([])；按 RFC6455 手写握手：GET / + `Upgrade: websocket` +
    //    `Sec-WebSocket-Key` → 断言 101 与 `Sec-WebSocket-Accept` 计算正确
    //    （daemon.ts 的 computeSecWebSocketAccept，魔术 GUID 258EAFA5-…）；
    //    普通 GET /（无 Upgrade）→ 426（daemon.ts 模块头 :9-13）；WS 上行只处理
    //    Ping/Close，数据帧一律忽略（下游只收）；
    // 2) 假 TTS 同场景 2 推 `{"messageID":2,"message":"phase4-hello"}` → 断言 WS 收到
    //    **文本帧**，解码后的载荷为同一份 JSON 串；
    // 3) 断开 WS 连接 → GET /v1/status 的 `hub.wsClients` 减 1（close/error 自动摘除）；
    // 4) 帧编解码可用 daemon.ts 导出的 encodeWsFrame / WsFrameDecoder（纯函数，已单测），
    //    不要为此引入 ws 依赖。
    todo("场景 3：39996 WS 广播");
  });

  it.skip("场景 4：39995 控制通道 12 条路由都通（至少 GET /v1/status 200）", async () => {
    // TODO(Stage 4)（离线；TTS 不在线时多数业务路由以 4xx/5xx 表达"无会话"，不算不通）：
    // 1) 路由清单 = S2 路由表（docs/schemas/hub-control.md §4/§5；实现表
    //    control.ts:519-533）——12 条路由 + SSE：
    //      GET  /v1/status、/v1/packs；SSE：/v1/events（单独场景 5）
    //      POST /v1/scripts/pull、/v1/scripts/save-and-play、/v1/exec、
    //           /v1/assets/check、/v1/deck/slice、/v1/deck/plan、/v1/import、
    //           /v1/diff、/v1/push、/v1/hub/shutdown（**会停 hub，放最后单独处理**，
    //           见场景 10）；
    // 2) 逐条请求：断言"路由存在"——方法用对时不出现 404 HUB_NOT_FOUND /
    //    405 HUB_METHOD_NOT_ALLOWED；缺 TTS / 缺夹具时的 4xx/5xx 业务错误
    //    （HUB_BAD_REQUEST / HUB_PACK_ERROR / HUB_INTERNAL_ERROR…）是合法应答；
    // 3) 离线基线：GET /v1/status → 200 + `{ok:true}`（S2 约定：TTS 离线不是路由错误）；
    //    `hub.tcpClients / wsClients / inprocClients` 为 number、`uptimeMs >= 0`；
    // 4) 错误体形一律 `{error:{code,message,details?}}`，Content-Type
    //    application/json; charset=utf-8（control.ts 的 sendError）。
    todo("场景 4：控制通道路由表可达");
  });

  it.skip("场景 5：GET /v1/events SSE 事件流", async () => {
    // TODO(Stage 4)：
    // 1) startHub([])；建立 SSE 长连接（fetch + ReadableStream，或 node:http），断言
    //    响应头 `text/event-stream; charset=utf-8` 与第一帧 `:connected\n\n`
    //    （control.ts:812-818）；
    // 2) 假 TTS 推 `{"messageID":2,"message":"phase4-hello"}` → 断言收到
    //    `data: {"messageID":2,…}\n\n`（消息对象原样 JSON；只有转发集合内的 messageID
    //    会被推送——GameLoaded/Print/Error/CustomMessage/GameSaved/ObjectCreated，
    //    不含 PushNewObject 与 ReturnValue，control.ts:93-106 / :824-827）；
    // 3) 对照：推一条 ReturnValue（messageID=5）→ SSE **收不到**该帧（协议噪声不转发）；
    // 4) 主动断开（AbortController / destroy）后 hub 不崩溃：后续 GET /v1/status 仍 200；
    // 5) 帧里无 id / event / retry 字段、无回放（契约 docs/schemas/hub-control.md §5）。
    todo("场景 5：SSE 事件流");
  });

  it.skip("场景 6：hub 在线时 tts status 走委托模式（不占 39998）", async () => {
    // TODO(Stage 4)（39995 必须空闲并由本用例的 hub 独占；CLI 探测固定 39995，见
    // src/cli/_shared.ts 的 tryHubClient：每次现探、零异常、无端口覆盖入口）：
    // 1) startHub([])；runCli(["status"])：
    //    - TTS 离线分支：exitCode 1 + stderr 含 `cli.status.hubOnlineTtsOffline`
    //      （status.ts:54-57；**不是**独立模式的 notRunning——文案本身就证明走了委托路径）；
    //    - TTS 在线分支（可选，console.warn 守卫）：exitCode 0 + 首行
    //      `cli.status.connectedViaHub`（含 127.0.0.1:39995）+ `cli.status.version` /
    //      `cli.status.objects`（status.ts:44-53）；
    // 2) **不占 39998 的证明**：runCli 前后与运行期间调 checkExclusive(EDITOR_PORT)
    //    始终 `{ok:false}`（39998 由 hub 独占）；CLI 若回退独立模式会先撞
    //    error.portInUse 而不是输出 hub 文案；
    // 3) 收尾 stopHub。
    todo("场景 6：hub 在线委托模式");
  });

  it.skip("场景 7：hub 不在线时 tts status 走独立模式（临时绑 39998）", async () => {
    // TODO(Stage 4)（全离线；确保 39995 无人监听、39998 空闲——用 checkExclusive 前置断言）：
    // 1) 前置：checkExclusive(CONTROL_PORT) → ok:true（hub 不在线）；
    //    checkExclusive(EDITOR_PORT) → ok:true（39998 空闲）；
    // 2) runCli(["status"]) → 走独立路径（status.ts:68-90）：checkExclusive(39998) 通过 →
    //    withEditorServer **临时绑 39998** → 连 39999 失败 → exitCode 1 + stderr
    //    `cli.status.notRunning`（status.ts:83-86）；
    // 3) 断言命令结束后 39998 已释放（checkExclusive(EDITOR_PORT) → ok:true），
    //    39995 仍无监听；
    // 4) 可选（需协议级假 TTS，console.warn 守卫）：在 39999 起能应答 `_VERSION` 与
    //    `#getObjects()` 的假 TTS → exitCode 0 + `cli.status.connected` 分支；缺该夹具
    //    时跳过该分支，不伪造成功。
    todo("场景 7：离线独立模式");
  });

  it.skip("场景 8：POST /v1/push 不带 confirm:true → 400 HUB_CONFIRM_REQUIRED", async () => {
    // TODO(Stage 4)（全离线；startHub([])）：
    // 1) 夹具：makeTempDir 建一个临时工作区（push 只做本地清单收集，不需要真实图包）；
    // 2) POST /v1/push，body `{"root": "<临时工作区>"}` → 400 +
    //    `{error:{code:"HUB_CONFIRM_REQUIRED"}}`。**root 必须是合法字符串**：confirm 门
    //    在 root 校验之后（control.ts:1022-1026），body 缺 root 会先得到 HUB_BAD_REQUEST；
    // 3) 顺序守卫对照：body `{}` / 非法 JSON → HUB_BAD_REQUEST，证明 8.2 的 400 确实来自
    //    confirm 门而不是别的校验；
    // 4) 正向对照：`{"root": …, "confirm": true}` 时**不得**再出现 HUB_CONFIRM_REQUIRED
    //    （无 TTS 时后续业务失败是 500 HUB_INTERNAL_ERROR / 400 HUB_PACK_ERROR，按
    //    "不是 HUB_CONFIRM_REQUIRED"断言即可）；
    // 5) MCP 侧的同名门（src/mcp/tools/push.ts 的 input schema 要求 confirm 字面量 true）
    //    属 Stage 4 可选交叉断言，不作为本场景门禁。
    todo("场景 8：push confirm 门");
  });

  it.skip("场景 9：tts-mcp 通过 stdio 启动后能响应 MCP initialize 握手", async () => {
    // TODO(Stage 4)（不需要 TTS；注册工具不发请求，也不需要 hub）：
    // 1) spawn `node dist/mcp/main.js`（可加 `--lang zh-CN`；server.ts 只认
    //    "zh-CN"/"en-US"，非法值 stderr 告警后回退，见 server.ts:82-98 / :155-160）；
    // 2) 按 MCP stdio 协议写 initialize（protocolVersion / capabilities / clientInfo）
    //    → 读响应，断言 `serverInfo.name === "tts-toolkit"`、`version === pkg.version`
    //    （与 package.json 同步；server.ts 从 pkg.version 读，不写死字符串）；
    //    可用 @modelcontextprotocol/server 的客户端 SDK（stdio 传输；InMemoryTransport
    //    亦可）或手写 JSON-RPC 行协议；
    // 3) 断言 stdout **只有协议 JSON**（无日志行），诊断只在 stderr（JSON Lines 英文，
    //    server.ts:15-25）；
    // 4) （可选）追加 tools/list → 断言恰为 10 个工具（server.ts:166-175 的注册清单）；
    // 5) 收尾：关闭子进程 stdin / kill，断言退出且无端口残留。
    todo("场景 9：MCP initialize 握手");
  });

  it.skip("场景 10：hub 优雅退出后 39998 释放（外部 checkExclusive(39998) 通过）", async () => {
    // TODO(Stage 4)（全离线）：
    // 1) startHub([])；前置断言 checkExclusive(EDITOR_PORT) → `{ok:false}`（hub 持有 39998）；
    // 2) 优雅退出：POST http://127.0.0.1:<port>/v1/hub/shutdown → 先收到 200 `{ok:true}`
    //    （control.ts:1045-1056）→ await 子进程，断言 exitCode 0，stdout 收尾
    //    `cli.hub.stopped`（hub.ts:137-139）；
    // 3) **本场景核心**：退出完成后在本进程调 checkExclusive(EDITOR_PORT) → `{ok:true}`
    //    （编辑器端口释放）；TCP / WS / 控制端口同样释放（net.connect 被拒）；
    // 4) 备选路径 SIGINT：Windows 下 kill("SIGINT") 不保证信号语义（execa 直接终止
    //    进程），Stage 4 实跑以 shutdown 路线为准；若要用 Ctrl+C 事件验证，需
    //    GenerateConsoleCtrlEvent 之类的原生手段，不作为本场景门禁；
    // 5) 收尾 stopHub（若尚未执行）。
    todo("场景 10：优雅退出与端口释放");
  });
});
