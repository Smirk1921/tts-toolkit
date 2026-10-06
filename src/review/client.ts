// src/review/client.ts
/**
 * 审批工具客户端：调用「图包审批工具」（方案设计 §13.2 集成层 ②）。
 *
 * 两条通路（语义一致，本模块自动选路）：
 * - CLI：`python <approvalRoot>/agent.py --config <configPath> [--offline] <子命令> …`
 *   ——每次调用输出**一个 JSON 对象**（stdout），失败时 `{"ok": false, "error": …}`
 *   且退出码非 0（实测 agent.py main() 行为）；
 * - HTTP：服务在跑时走 `<base>/api/agent/*`（与网页版共用同一份内存状态，
 *   端点清单见其 docs/agent-接口.md §四）。
 *
 * 自动选路（与审批工具 core/agent_api.py make_backend 同思路，探测方式更强）：
 * 1. 显式 `server` 选项 → 直接走 HTTP，不探测；
 * 2. 显式 `offline` → 强制 CLI 并给 agent.py 传 `--offline`（直连文件）；
 * 3. 否则探测 `http://<host>:<port>/api/config`（agent.py 同款端点；用 fetch
 *   探测比 agent_api.py 的裸 socket 更严——顺带确认那是审批工具而不是恰好
 *   占了端口的别的进程）；
 * 4. 探测落空时读 `<data_dir>/app.pid` 兜底（格式实测为 `PID\nPORT\n`，
 *   app.py write_pid_file）：记录端口 ≠ 配置端口且该端口上确有审批工具在听
 *   → 直接用那个 base 走 HTTP（审批工具对这种"非默认端口"场景只会给 CLI 一条
 *   warning 让人换 --server，我们直接走 HTTP 反而没有并发写覆盖问题）；
 * 5. 都没命中 → CLI（agent.py 自己还有一层相同的选路逻辑，双保险）。
 *
 * Windows 编码：agent.py 以 `ensure_ascii=False` 输出（实测），而 Python 子进程
 * 的 stdout 编码在管道下默认跟系统代码页（中文 Windows 常为 GBK）——spawn 时
 * 强制 `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`，保证中文标签不被转码打碎。
 *
 * 子进程走 execa 且**参数走数组**（与 src/vcs/git.ts 同一约定，绝不拼命令行
 * 字符串）；"git 统一走 src/vcs/git.ts"的红线是 git 专属收口，本模块是
 * python 调用的唯一收口，不适用该红线。
 *
 * 结果统一为 {@link AgentResult}：`ok !== true` 一律抛
 * {@link PackError}（code="REVIEW_CALL_FAILED"，message 含 agent 给出的中文
 * error）；HTTP 非 2xx 同样先解析 body 里的 `{"ok": false, "error"}` 取详情。
 *
 * 错误码（{@link PackError.code}）：
 * - "REVIEW_CONFIG_NOT_FOUND"    configPath 不存在（探测与 CLI 都需要读它）
 * - "REVIEW_CONFIG_READ_FAILED"  读取 configPath 时的其他 IO 错误
 * - "REVIEW_CONFIG_INVALID"      configPath 不是合法 JSON / 不符合 schema / sets 为空
 * - "REVIEW_APP_MISSING"         python 解释器不可得（PATH 上找不到）
 * - "REVIEW_CALL_FAILED"         CLI 退出码非 0 / 输出不是合法 JSON / 超时 /
 *                                HTTP 非 2xx / agent 返回 ok=false / 请求异常
 *
 * 本模块新增的 i18n 键（locales/*.json 双语镜像；缺键时 t() 原样输出键名）：
 * - `error.review.configNotFound` {path}
 * - `error.review.configReadFailed` {path} {detail}
 * - `error.review.configInvalid` {path} {issues}
 * - `error.review.appMissing` {detail}
 * - `error.review.callFailed` {detail}
 *
 * 可测试性：`fetchImpl` / `runImpl` 可注入（单测 mock HTTP 与 CLI，不碰真网络
 * 与真 python）；探测与请求全部经 `fetchImpl`，无裸 socket、无子进程。
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";
import { readApprovalConfigStrict, type ApprovalConfig } from "./config.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** agent.py 在审批工具仓库根的相对位置 */
const AGENT_SCRIPT = "agent.py";

/** 未显式指定时的子进程 / HTTP 请求超时（毫秒；与 src/vcs/git.ts 缺省一致） */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 服务存活探测的超时（毫秒；与审批工具 server_alive 的 1.5s 一致） */
const PROBE_TIMEOUT_MS = 1_500;

/** 写入子进程环境，强制 Python IO 用 UTF-8（见模块头注释"Windows 编码"） */
const PYTHON_UTF8_ENV: Record<string, string> = {
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
};

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** agent.py / /api/agent/* 的成功返回（恒带 ok: true；其余字段随命令而异） */
export interface AgentResult {
  ok: true;
  [key: string]: unknown;
}

/** agent 调用失败时 body 里的错误形态（`{"ok": false, "error": …}`） */
interface AgentErrorBody {
  ok?: unknown;
  error?: unknown;
}

/** 子进程执行结果（execa 结果的最小投影；exitCode 缺失 = 未正常退出） */
export interface CliRunResult {
  exitCode?: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** CLI 执行器签名（缺省实现走 execa；单测可注入替身） */
export type CliRunner = (python: string, argv: string[]) => Promise<CliRunResult>;

/** {@link ApprovalClient} 的选项 */
export interface ApprovalClientOptions {
  /** 审批工具仓库根（含 agent.py；如 `<approval_tool_root>`） */
  approvalRoot: string;
  /** approval.config.json 路径（探测与 CLI 都需要读它拿 data_dir / host / port） */
  configPath: string;
  /** python 解释器（缺省 "python"；可传绝对路径） */
  python?: string;
  /** 显式服务基址（如 http://127.0.0.1:8765）；设置后跳过探测直接走 HTTP */
  server?: string;
  /** 强制 CLI 直连文件（给 agent.py 传 --offline） */
  offline?: boolean;
  /** 子进程 / HTTP 请求超时毫秒（缺省 {@link DEFAULT_TIMEOUT_MS}；探测固定 1.5s） */
  timeoutMs?: number;
  /** fetch 注入点（缺省 globalThis.fetch；单测 mock 用） */
  fetchImpl?: typeof fetch;
  /** CLI 执行器注入点（缺省 execa 包装；单测 mock 用） */
  runImpl?: CliRunner;
}

/** {@link ApprovalClient.items} 的筛选条件（字段与 agent.py items 的选项一一对应） */
export interface ApprovalItemsFilter {
  /** 按状态筛：unreviewed / pass / reject / flag / all（也认中文） */
  status?: string;
  /** 按问题标签筛 */
  tag?: string;
  /** 按 id / 名称 / 元数据模糊搜 */
  search?: string;
  /** 按分组筛 */
  group?: string;
  /** 只看源文件已变（结果过期）的 */
  stale?: boolean;
  /** 只看没打任何标签的 */
  noTags?: boolean;
  /** 只看有圈选的 */
  annotated?: boolean;
  /** 只看有备注的 */
  noted?: boolean;
  /** 最多返回多少条 */
  limit?: number;
  /** 跳过前多少条 */
  offset?: number;
}

/** {@link ApprovalClient.review} 的写回内容 */
export interface ApprovalReviewPayload {
  /** 结论：pass / reject / flag / ""（清回未审；也认中文） */
  status: string;
  /** 问题标签 */
  tags?: string[];
  /** 备注 */
  note?: string;
  /** 圈选区域（相对比例 0~1 + side: a|b；schema 冻结在审批工具 docs/审批结果字段说明.md） */
  annotations?: { side: "a" | "b"; x: number; y: number; w: number; h: number; note?: string; tag?: string }[];
}

/** {@link ApprovalClient.clearStale} 的选项 */
export interface ApprovalClearStaleOptions {
  /** 只清这些素材 id（缺省清整个素材集的过期条目） */
  ids?: string[];
  /** 预演：只报会清哪些，不真清 */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 判断指定 python 解释器名能否解析出来（与 src/vcs/git.ts 的
 * isGitExecutableAvailable 同一算法与同一理由：execa 10 在 Windows 上对解析
 * 不到的命令回退 cmd.exe 执行，错误对象无 code，stderr 是随系统语言变化的
 * 本地化文案，只能按其解析语义自行扫描 PATH）。
 *
 * 含路径分隔符的值视为显式路径，直接 existsSync 判定（不扫 PATH）。
 *
 * @param python 解释器名或路径
 * @returns 可解析时 true
 */
function isPythonAvailable(python: string): boolean {
  if (/[/\\]/.test(python)) {
    return existsSync(python);
  }
  const searchPath = process.env.PATH ?? "";
  const names = process.platform === "win32" ? [`${python}.exe`, `${python}.cmd`, `${python}.bat`] : [python];
  for (const dir of searchPath.split(path.delimiter)) {
    // execa 的解析允许目录带引号（含空格的 PATH 条目），保持一致
    const unquoted = dir.length > 1 && dir.startsWith('"') && dir.endsWith('"') ? dir.slice(1, -1) : dir;
    if (unquoted === "") {
      continue;
    }
    for (const name of names) {
      try {
        if (existsSync(path.resolve(unquoted, name))) {
          return true;
        }
      } catch {
        // PATH 中存在非法条目（非法字符等）时跳过，不影响其余条目
      }
    }
  }
  return false;
}

/**
 * 缺省 CLI 执行器：execa 包装（UTF-8、隐藏窗口、超时、不 reject、强制 Python
 * UTF-8 IO，见模块头注释"Windows 编码"）。
 *
 * 选项必须以字面量内联传入：execa 10 的返回类型靠字面量收窄
 * （与 src/vcs/git.ts 的 execGit 同一写法），先声明成宽类型 ExecaOptions
 * 会丢掉收窄，stdout/stderr 变成宽联合。
 *
 * @param python 解释器
 * @param argv 完整参数数组（含脚本路径）
 * @param timeoutMs 超时毫秒
 */
async function defaultCliRunner(python: string, argv: string[], timeoutMs: number): Promise<CliRunResult> {
  const result = await execa(python, argv, {
    reject: false,
    timeout: timeoutMs,
    encoding: "utf8",
    windowsHide: true,
    env: { ...PYTHON_UTF8_ENV },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}

/**
 * 从 agent 返回体里取人类可读错误详情（error 字段缺失时给兜底描述）。
 */
function agentErrorDetail(body: AgentErrorBody, fallback: string): string {
  if (typeof body.error === "string" && body.error.trim() !== "") {
    return body.error;
  }
  return fallback;
}

/**
 * 解析 agent 的 stdout 为 JSON 键值对象；不是合法 JSON / 不是对象返回 undefined。
 */
function parseAgentJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  try {
    const data: unknown = JSON.parse(trimmed);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 拼接 URL 查询串（值原样 encodeURIComponent；undefined 跳过） */
function withQuery(
  base: string,
  apiPath: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    search.set(key, String(value));
  }
  const qs = search.toString();
  return `${base}${apiPath}${qs === "" ? "" : `?${qs}`}`;
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

/**
 * 审批工具客户端（自动选路：服务在跑走 HTTP，没跑走 CLI）。
 *
 * 用法：
 * ```ts
 * const client = new ApprovalClient({
 *   approvalRoot: "<approval_tool_root>",
 *   configPath: "<packRoot>/.tts/approval/approval.config.json",
 * });
 * const status = await client.status();          // AgentResult
 * await client.review("demo_cards", "102_front.png", { status: "reject", tags: ["文字溢出"] });
 * ```
 */
export class ApprovalClient {
  /** 已归一的选项（python / timeoutMs 已填缺省） */
  readonly options: ApprovalClientOptions & Required<Pick<ApprovalClientOptions, "python" | "timeoutMs">>;

  private readonly fetchImpl: typeof fetch;
  private readonly runImpl: CliRunner;

  /**
   * @param options 客户端选项（approvalRoot / configPath 必填）
   */
  constructor(options: ApprovalClientOptions) {
    this.options = {
      ...options,
      python: options.python ?? "python",
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.runImpl = options.runImpl ?? ((python, argv) => defaultCliRunner(python, argv, this.options.timeoutMs));
  }

  // -- 选路 ---------------------------------------------------------------

  /**
   * 探测审批服务是否在跑，返回可用的 base URL；不在跑返回 undefined。
   *
   * 顺序：显式 server 直接返回 → 配置 host:port 的 `/api/config` →
   * `data/app.pid` 记录的非默认端口兜底（格式 `PID\nPORT`，实测）。
   *
   * @returns 服务基址（无尾斜杠）或 undefined
   * @throws PackError code="REVIEW_CONFIG_*" 读取 / 校验配置失败时（探测需要它）
   */
  async detectServer(): Promise<string | undefined> {
    if (this.options.server !== undefined) {
      return this.options.server.replace(/\/+$/, "");
    }
    const config = await readApprovalConfigStrict(this.options.configPath);
    const base = `http://${config.host}:${config.port}`;
    if (await this.probeAlive(base)) {
      return base;
    }
    const alt = await this.serverFromPidFile(config);
    if (alt !== undefined && (await this.probeAlive(alt))) {
      return alt;
    }
    return undefined;
  }

  /**
   * 从 `<data_dir>/app.pid` 解析"服务跑在非默认端口"的兜底 base。
   * 端口与配置一致时返回 undefined（那属于"没跑"，交给上层回退 CLI）。
   */
  private async serverFromPidFile(config: ApprovalConfig): Promise<string | undefined> {
    const pidPath = path.join(config.data_dir, "app.pid");
    let raw: string;
    try {
      raw = await readFile(pidPath, "utf8");
    } catch {
      return undefined; // 文件不存在 / 读不了 = 没有兜底信息
    }
    const lines = raw.split(/\s+/).filter((s) => s !== "");
    const pid = Number.parseInt(lines[0] ?? "", 10);
    const port = Number.parseInt(lines[1] ?? "", 10);
    if (!Number.isInteger(pid) || !Number.isInteger(port) || port === config.port) {
      return undefined;
    }
    return `http://127.0.0.1:${port}`;
  }

  /**
   * 探测 base 是否为存活的审批工具服务（GET /api/config 200）。
   * 任何异常（网络错 / 超时 / 非 200）都视为不在跑。
   */
  private async probeAlive(base: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${base}/api/config`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  // -- 两条通路 -----------------------------------------------------------

  /**
   * CLI 通路：`python <approvalRoot>/agent.py <command> <args…> --config <configPath> [--offline]`。
   *
   * **全局选项必须放在子命令之后**：agent.py 的文档（docs/agent-接口.md §二）
   * 声称全局选项写在子命令前后都行，但实测（Python 3.12.7 + 其 argparse 的
   * `parser.set_defaults(config=DEFAULT_CONFIG)` 与 parents 复用的相互作用）
   * 放在子命令**之前**的 `--config` 会被静默忽略、回落到审批工具自己仓库的
   * config.json——而 `--offline` 写前写后倒都生效。统一般到子命令之后，
   * 两种实现下都正确。
   *
   * stdout 恒为一个 JSON 对象；`ok: false`、退出码非 0、超时或输出不是合法
   * JSON 都抛 REVIEW_CALL_FAILED（python 不可得时抛 REVIEW_APP_MISSING）。
   *
   * @param command agent.py 子命令（如 "status"）
   * @param args 子命令参数（数组逐项传入，绝不拼字符串）
   * @returns 解析后的返回（ok === true 已断言）
   * @throws PackError code="REVIEW_APP_MISSING" python 不可得时
   * @throws PackError code="REVIEW_CALL_FAILED" 其余一切失败时
   */
  async runCli(command: string, args: string[]): Promise<AgentResult> {
    const argv = [
      path.join(this.options.approvalRoot, AGENT_SCRIPT),
      command,
      ...args,
      "--config",
      this.options.configPath,
      ...(this.options.offline ? ["--offline"] : []),
    ];
    const run = await this.runImpl(this.options.python, argv);

    // agent.py 的失败形态：stdout 仍是 {"ok": false, "error": …}（exit 1）——
    // 先解析 stdout，能拿到 agent 的中文 error 就用它当详情
    const parsed = parseAgentJson(run.stdout);
    if (parsed !== undefined) {
      if (parsed.ok === true && run.exitCode === 0) {
        return parsed as AgentResult;
      }
      const detail =
        parsed.ok === true
          ? `agent.py ${command} 返回 ok: true 但退出码为 ${run.exitCode ?? "(未正常退出)"}`
          : `agent.py ${command}：${agentErrorDetail(parsed as AgentErrorBody, "(agent 未给出错误详情)")}`;
      throw new PackError("REVIEW_CALL_FAILED", t("error.review.callFailed", { detail }));
    }

    // 没有合法 JSON：区分"解释器都没有"与"跑起来但坏了"
    if (run.exitCode !== 0 && !isPythonAvailable(this.options.python)) {
      throw new PackError(
        "REVIEW_APP_MISSING",
        t("error.review.appMissing", { detail: `未找到可执行的 ${this.options.python}：请确认已安装并在 PATH 中` }),
      );
    }
    const detail = run.timedOut
      ? `agent.py ${command} 超过 ${this.options.timeoutMs} 毫秒未结束，已被终止`
      : `agent.py ${command} 退出码 ${run.exitCode ?? "(未正常退出)"}，输出不是合法 JSON（stderr: ${
          run.stderr.trim() === "" ? "(空)" : run.stderr.trim()
        }）`;
    throw new PackError("REVIEW_CALL_FAILED", t("error.review.callFailed", { detail }));
  }

  /**
   * HTTP 通路：调 `<base>/api/agent/*`，body / 返回均为 JSON。
   *
   * @param base 服务基址（detectServer 的返回或显式 server）
   * @param method HTTP 方法
   * @param apiPath 以 / 开头的端点路径（如 /api/agent/status）
   * @param params GET 查询参数（method=GET 时使用；undefined 值跳过）
   * @param body POST JSON 体（method=POST 时使用）
   * @returns 解析后的返回（ok === true 已断言）
   * @throws PackError code="REVIEW_CALL_FAILED" 网络异常 / 非 2xx / ok=false / 非 JSON 时
   */
  async runHttp(
    base: string,
    method: "GET" | "POST",
    apiPath: string,
    params?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
  ): Promise<AgentResult> {
    const url =
      method === "GET" && params !== undefined ? withQuery(base, apiPath, params) : `${base}${apiPath}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        ...(method === "POST"
          ? { body: JSON.stringify(body ?? {}), headers: { "Content-Type": "application/json" } }
          : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (err) {
      throw new PackError(
        "REVIEW_CALL_FAILED",
        t("error.review.callFailed", {
          detail: `请求 ${method} ${url} 失败：${err instanceof Error ? err.message : String(err)}`,
        }),
      );
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new PackError(
        "REVIEW_CALL_FAILED",
        t("error.review.callFailed", { detail: `${method} ${url} 返回的不是合法 JSON（HTTP ${res.status}）` }),
      );
    }
    if (!res.ok || (typeof data === "object" && data !== null && (data as AgentErrorBody).ok === false)) {
      const detail =
        typeof data === "object" && data !== null
          ? agentErrorDetail(data as AgentErrorBody, `HTTP ${res.status}`)
          : `HTTP ${res.status}`;
      throw new PackError(
        "REVIEW_CALL_FAILED",
        t("error.review.callFailed", { detail: `${method} ${url}：${detail}` }),
      );
    }
    if (typeof data !== "object" || data === null || (data as AgentErrorBody).ok !== true) {
      throw new PackError(
        "REVIEW_CALL_FAILED",
        t("error.review.callFailed", { detail: `${method} ${url} 返回缺少 ok: true（HTTP ${res.status}）` }),
      );
    }
    return data as AgentResult;
  }

  // -- 业务方法（每条都带 CLI / HTTP 两种形态，invoke 自动选路） -----------------

  /**
   * 调一个业务方法（自动选路核心）：
   * offline → CLI；显式 server → HTTP（无 HTTP 形态的命令回退 CLI）；
   * 否则探测 → HTTP，探测落空 → CLI。
   */
  private async invoke(
    cli: { command: string; args: string[] },
    http?: {
      method: "GET" | "POST";
      path: string;
      params?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
    },
  ): Promise<AgentResult> {
    if (this.options.offline) {
      return this.runCli(cli.command, cli.args);
    }
    if (this.options.server !== undefined) {
      if (http === undefined) {
        return this.runCli(cli.command, cli.args);
      }
      return this.runHttp(this.options.server.replace(/\/+$/, ""), http.method, http.path, http.params, http.body);
    }
    const base = await this.detectServer();
    if (base !== undefined && http !== undefined) {
      return this.runHttp(base, http.method, http.path, http.params, http.body);
    }
    return this.runCli(cli.command, cli.args);
  }

  /**
   * 总览：各素材集的条数、进度、过期数、当前轮次
   * （agent.py `status` / GET /api/agent/status）。
   */
  status(): Promise<AgentResult> {
    return this.invoke({ command: "status", args: [] }, { method: "GET", path: "/api/agent/status" });
  }

  /**
   * 列出素材（agent.py `items` / GET /api/agent/items）。
   * @param setId 素材集 id
   * @param filter 筛选条件（全部可选）
   */
  items(setId: string, filter: ApprovalItemsFilter = {}): Promise<AgentResult> {
    return this.invoke(
      { command: "items", args: buildItemsCliArgs(setId, filter) },
      { method: "GET", path: "/api/agent/items", params: buildItemsQuery(setId, filter) },
    );
  }

  /**
   * 单条详情（agent.py `item` / GET /api/agent/item）。
   * 图片素材返回 files.a / files.b 两个文件路径。
   */
  item(setId: string, itemId: string): Promise<AgentResult> {
    return this.invoke(
      { command: "item", args: ["--set", setId, "--id", itemId] },
      { method: "GET", path: "/api/agent/item", params: { set: setId, id: itemId } },
    );
  }

  /**
   * 给单条素材写审批结果（agent.py `review` / POST /api/agent/review）。
   *
   * 正常闭环里审批由人在网页上做；本方法服务两个场景：
   * 批量预处理（如把重渲过的过期条目清回未审）与测试。
   *
   * @param setId 素材集 id
   * @param itemId 素材 id（= 文件名）
   * @param payload 结论（status 必填；tags / note / annotations 可选）
   */
  review(setId: string, itemId: string, payload: ApprovalReviewPayload): Promise<AgentResult> {
    const httpBody: Record<string, unknown> = { set: setId, id: itemId, status: payload.status };
    if (payload.tags !== undefined) {
      httpBody.tags = payload.tags;
    }
    if (payload.note !== undefined) {
      httpBody.note = payload.note;
    }
    if (payload.annotations !== undefined) {
      httpBody.annotations = payload.annotations;
    }
    return this.invoke(
      { command: "review", args: buildReviewCliArgs(setId, itemId, payload) },
      { method: "POST", path: "/api/agent/review", body: httpBody },
    );
  }

  /**
   * 清掉源文件已变的过期结果（回到未审）——重渲后重新审批前的标准动作
   * （agent.py `clear-stale` / POST /api/agent/clear-stale）。
   */
  clearStale(setId: string, opts: ApprovalClearStaleOptions = {}): Promise<AgentResult> {
    const cliArgs = ["--set", setId];
    const httpBody: Record<string, unknown> = { set: setId };
    if (opts.ids !== undefined) {
      cliArgs.push("--ids", opts.ids.join(","));
      httpBody.ids = opts.ids;
    }
    if (opts.dryRun === true) {
      cliArgs.push("--dry-run");
      httpBody.dry_run = true;
    }
    return this.invoke(
      { command: "clear-stale", args: cliArgs },
      { method: "POST", path: "/api/agent/clear-stale", body: httpBody },
    );
  }
}

// ---------------------------------------------------------------------------
// 纯参数构建（导出供单测断言 CLI argv / HTTP query 的拼法）
// ---------------------------------------------------------------------------

/**
 * 构建 agent.py `items` 的子命令参数（不含子命令名与全局选项）。
 * @param setId 素材集 id
 * @param filter 筛选条件
 * @returns 参数数组（如 ["--set", "s", "--status", "reject", "--limit", "20"]）
 */
export function buildItemsCliArgs(setId: string, filter: ApprovalItemsFilter): string[] {
  const args = ["--set", setId];
  if (filter.status !== undefined) {
    args.push("--status", filter.status);
  }
  if (filter.tag !== undefined) {
    args.push("--tag", filter.tag);
  }
  if (filter.search !== undefined) {
    args.push("--search", filter.search);
  }
  if (filter.group !== undefined) {
    args.push("--group", filter.group);
  }
  if (filter.stale === true) {
    args.push("--stale");
  }
  if (filter.noTags === true) {
    args.push("--no-tags");
  }
  if (filter.annotated === true) {
    args.push("--annotated");
  }
  if (filter.noted === true) {
    args.push("--noted");
  }
  if (filter.limit !== undefined) {
    args.push("--limit", String(filter.limit));
  }
  if (filter.offset !== undefined) {
    args.push("--offset", String(filter.offset));
  }
  return args;
}

/**
 * 构建 GET /api/agent/items 的查询参数（与 buildItemsCliArgs 同源同义）。
 */
export function buildItemsQuery(
  setId: string,
  filter: ApprovalItemsFilter,
): Record<string, string | number | boolean | undefined> {
  return {
    set: setId,
    status: filter.status,
    tag: filter.tag,
    search: filter.search,
    group: filter.group,
    stale: filter.stale === true ? 1 : undefined,
    no_tags: filter.noTags === true ? 1 : undefined,
    annotated: filter.annotated === true ? 1 : undefined,
    noted: filter.noted === true ? 1 : undefined,
    limit: filter.limit,
    offset: filter.offset,
  };
}

/**
 * 构建 agent.py `review` 的子命令参数。
 *
 * 圈选走 `--annotations`（整段 JSON）而不是可重复的 `--annotate`：
 * 前者直接吃数组，不需要把 note 里的逗号靠"说明放最后"的约定规避
 * （agent-接口.md §二：--annotate 格式 `x,y,w,h[,side][,说明]`）。
 */
export function buildReviewCliArgs(setId: string, itemId: string, payload: ApprovalReviewPayload): string[] {
  const args = ["--set", setId, "--id", itemId, "--status", payload.status];
  if (payload.tags !== undefined) {
    args.push("--tags", payload.tags.join(","));
  }
  if (payload.note !== undefined) {
    args.push("--note", payload.note);
  }
  if (payload.annotations !== undefined) {
    args.push("--annotations", JSON.stringify(payload.annotations));
  }
  return args;
}
