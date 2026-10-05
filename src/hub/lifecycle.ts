// src/hub/lifecycle.ts
/**
 * hub 进程生命周期编排：组装 {@link HubDaemon} 与 S2 控制通道（HTTP+JSON），
 * 接管信号与优雅退出，供 src/cli/commands/hub.ts 调用。
 *
 * 职责与行为约束：
 * - {@link HubProcess.start}：先 daemon.start()（编辑器端口 + TCP/WS 扇出），
 *   再 control.start()（控制通道，缺省 39995，只绑 127.0.0.1）；任一步失败
 *   回滚已启动资源并抛原错（不吞错、不换错）；
 * - {@link HubProcess.stop}：先关 control（拒新连接）→ 再关 daemon → 关日志
 *   文件流；幂等（SIGINT 与 /v1/hub/shutdown 同时触发时共享同一次停止流程）；
 * - SIGINT/SIGTERM 用 process.once 注册，各只触发一次 stop()；
 *   /v1/hub/shutdown 路由的 onShutdown 回调走同一 {@link HubProcess.stop}；
 * - 日志：JSON Lines 英文 `{"ts":...,"level":"info|warn|error","msg":"...",...}`；
 *   opts.logFile 提供时同时写 stdout 与文件（追加）；日志文件不可用时降级为
 *   仅 stdout（日志路径问题不阻塞 hub 启动，降级事件以 warn 记录）。
 *
 * 本模块不产出面向用户的文案：CLI 文案在 src/cli/commands/hub.ts 走 t()；
 * 这里的日志是运维用 JSON Lines（英文），与协议层（src/protocol）一致不引入 i18n。
 */

import { createWriteStream, type WriteStream } from "node:fs";

import { createControlServer } from "./control.js";
import { HubDaemon } from "./daemon.js";

/** 控制通道缺省端口（S2 方案：HTTP+JSON on http://127.0.0.1:39995/v1）。 */
const DEFAULT_CONTROL_PORT = 39995;

/** 控制通道只绑回环地址（S2 安全约束：不向局域网暴露）。 */
const CONTROL_HOST = "127.0.0.1";

/** JSON Lines 日志的 level 取值。 */
type LogLevel = "info" | "warn" | "error";

/** 控制通道服务器（src/hub/control.ts createControlServer 的返回类型别名）。 */
type ControlServer = ReturnType<typeof createControlServer>;

/**
 * 把任意错误值转成单行文本（日志用；非 Error 退化为 String）。
 * @param err 任意错误值
 * @returns 错误描述文本
 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** {@link runHubProcess} 的选项。 */
export interface HubProcessOptions {
  /** 编辑器侧监听端口（TTS 主动连过来）；缺省由 HubDaemon 决定（39998）。 */
  editorPort?: number;
  /** hub TCP 扇出端口；缺省由 HubDaemon 决定（39997）。 */
  tcpPort?: number;
  /** hub WebSocket 扇出端口；缺省由 HubDaemon 决定（39996）。 */
  wsPort?: number;
  /** S2 控制通道端口；缺省 39995。 */
  controlPort?: number;
  /** 日志文件路径（追加写）；缺省只写 stdout。 */
  logFile?: string;
}

/** 一个已组装、可启动的 hub 进程句柄（{@link runHubProcess} 的返回值）。 */
export interface HubProcess {
  /**
   * 启动：先 daemon.start()，再 control.start()；任一失败回滚已启动资源并抛原错。
   * @throws {PortInUseError} 编辑器端口 / 扇出端口 / 控制通道任一被占用
   * @throws {Error} 重复启动，或其他启动失败原因（原样向上传递）
   */
  start(): Promise<void>;

  /**
   * 优雅停止：先关 control（拒新连接）→ 再关 daemon → 关日志文件流。
   * 幂等：重复 / 并发调用共享同一次停止流程；组件级停止失败只记 error 日志，
   * 不向上抛（保证信号路径与 onShutdown 路径都不会产生未处理的 rejection）。
   */
  stop(): Promise<void>;

  /**
   * 实际绑定的控制通道端口。
   * @returns start 完成后为控制服务器报告的绑定端口；start 之前为配置值
   *          （opts.controlPort 或缺省 39995）
   */
  controlPort(): number;

  /**
   * hub 完全停止后 resolve 的 promise（SIGINT / SIGTERM / /v1/hub/shutdown
   * 任一路径触发停止完成后 resolve；start 失败时也 resolve，以免调用方悬挂）。
   * CLI 常驻等待它来决定打印 stopped 与退出时机。
   */
  stopped(): Promise<void>;
}

/**
 * {@link HubProcess} 实现：组合 daemon 与 control，持有信号处理器与日志文件流。
 *
 * 状态（phase）：idle → starting → running → stopped；start 失败直接落 stopped。
 * start 与 stop 不承诺"交错并发"安全（CLI 的调用顺序是先 await start 再
 * stop / stopped，不会交错）；stop 自身的重复 / 并发调用是安全的（幂等）。
 */
class HubProcessImpl implements HubProcess {
  private readonly editorPort: number | undefined;
  private readonly tcpPort: number | undefined;
  private readonly wsPort: number | undefined;
  private readonly configuredControlPort: number;
  private readonly logFile: string | undefined;

  /** stopped() 返回的 promise；构造时创建，停止完成（或 start 失败）时 resolve。 */
  private readonly stoppedPromise: Promise<void>;
  /** stoppedPromise 的 resolver（构造函数里同步赋值，之后不再变更）。 */
  private resolveStopped!: () => void;

  /** 生命周期阶段。 */
  private phase: "idle" | "starting" | "running" | "stopped" = "idle";
  /** 已启动的 daemon（运行期间持有；停止后置 undefined）。 */
  private daemon: HubDaemon | undefined;
  /** 已启动的控制通道服务器（运行期间持有；停止后置 undefined）。 */
  private control: ControlServer | undefined;
  /** 控制服务器报告的实际绑定端口（start 完成后赋值）。 */
  private boundControlPort: number | undefined;
  /** 进行中 / 已完成的停止流程（stop 幂等的依据）。 */
  private stopPromise: Promise<void> | undefined;
  /** 日志文件流（logFile 提供且打开成功时非 undefined）。 */
  private logStream: WriteStream | undefined;
  /** 日志文件流是否可用（打开失败 / 出错后降级为仅 stdout）。 */
  private logStreamOk = false;

  /** SIGINT / SIGTERM 共用的信号处理器（once 注册，各只触发一次 stop）。 */
  private readonly onSignal = (signal: NodeJS.Signals): void => {
    this.log("info", `signal ${signal} received, stopping hub`);
    void this.stop();
  };

  /**
   * @param opts runHubProcess 的原始选项（undefined 按各字段缺省值处理）
   */
  constructor(opts: HubProcessOptions | undefined) {
    this.editorPort = opts?.editorPort;
    this.tcpPort = opts?.tcpPort;
    this.wsPort = opts?.wsPort;
    this.configuredControlPort = opts?.controlPort ?? DEFAULT_CONTROL_PORT;
    this.logFile = opts?.logFile;
    this.stoppedPromise = new Promise<void>((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  /** @inheritdoc */
  async start(): Promise<void> {
    if (this.phase !== "idle") {
      throw new Error(
        `hub 进程已${this.phase === "stopped" ? "停止" : "在启动/运行中"}，请勿重复启动。`,
      );
    }
    this.phase = "starting";

    // 日志文件流先开：打开失败只降级为仅 stdout，不阻塞启动
    this.openLogFile();

    const daemon = new HubDaemon({
      editorPort: this.editorPort,
      tcpPort: this.tcpPort,
      wsPort: this.wsPort,
      log: (line: string) => this.writeLine(line),
    });
    try {
      await daemon.start();
    } catch (err) {
      this.log("error", `hub start failed at daemon.start: ${errorText(err)}`);
      await this.closeLogFile();
      this.markStopped();
      throw err;
    }
    this.daemon = daemon;

    const control = createControlServer(daemon, {
      port: this.configuredControlPort,
      host: CONTROL_HOST,
      log: (line: string) => this.writeLine(line),
      onShutdown: () => this.stop(),
    });
    try {
      await control.start();
    } catch (err) {
      this.log("error", `hub start failed at control.start: ${errorText(err)}`);
      await this.rollbackDaemon(daemon);
      await this.closeLogFile();
      this.markStopped();
      throw err;
    }
    this.control = control;
    this.boundControlPort = control.boundPort();
    this.phase = "running";

    // process.once：SIGINT / SIGTERM 各只触发一次 stop()
    process.once("SIGINT", this.onSignal);
    process.once("SIGTERM", this.onSignal);

    this.log("info", "hub started", this.boundControlPort);
  }

  /** @inheritdoc */
  stop(): Promise<void> {
    this.stopPromise ??= this.doStop();
    return this.stopPromise;
  }

  /** @inheritdoc */
  controlPort(): number {
    return this.boundControlPort ?? this.configuredControlPort;
  }

  /** @inheritdoc */
  stopped(): Promise<void> {
    return this.stoppedPromise;
  }

  /**
   * 停止流程本体：control（拒新连接）→ daemon → 日志文件流。
   * 每一步的失败都只记 error 日志，不向上抛——本方法承诺永不 reject，
   * 信号路径与 onShutdown 路径都不会因此产生未处理的 rejection。
   */
  private async doStop(): Promise<void> {
    this.log("info", "hub stopping");

    // 1. 先关控制通道：停止接受新连接（/v1/hub/shutdown 的响应仍可写回）
    const control = this.control;
    this.control = undefined;
    if (control !== undefined) {
      try {
        await control.stop();
      } catch (err) {
        this.log("error", `control server stop failed: ${errorText(err)}`);
      }
    }

    // 2. 再关 daemon：编辑器端口 + TCP/WS 扇出全部摘除
    const daemon = this.daemon;
    this.daemon = undefined;
    if (daemon !== undefined) {
      try {
        await daemon.stop();
      } catch (err) {
        this.log("error", `daemon stop failed: ${errorText(err)}`);
      }
    }

    // 3. 摘除信号处理器：停止完成后再按 Ctrl+C 走默认终止（强制退出兜底）
    process.off("SIGINT", this.onSignal);
    process.off("SIGTERM", this.onSignal);

    this.log("info", "hub stopped");
    await this.closeLogFile();
    this.markStopped();
  }

  /**
   * start 失败的回滚：尽力停掉已启动的 daemon（失败只记 warn，不掩盖原错）。
   * @param daemon 已成功 start 的 daemon 实例
   */
  private async rollbackDaemon(daemon: HubDaemon): Promise<void> {
    try {
      await daemon.stop();
    } catch (err) {
      this.log("warn", `daemon rollback failed: ${errorText(err)}`);
    }
  }

  /** 落到 stopped 状态并放行 stopped()（停止完成 / start 失败路径使用）。 */
  private markStopped(): void {
    this.phase = "stopped";
    this.resolveStopped();
  }

  /**
   * 写一条结构化日志（JSON Lines）。
   * @param level 日志级别
   * @param msg 英文消息文本
   * @param port 关联端口（无关时省略该字段）
   */
  private log(level: LogLevel, msg: string, port?: number): void {
    const entry: { ts: string; level: LogLevel; msg: string; port?: number } = {
      ts: new Date().toISOString(),
      level,
      msg,
    };
    if (port !== undefined) {
      entry.port = port;
    }
    this.writeLine(JSON.stringify(entry));
  }

  /**
   * 写一行到 stdout 与日志文件（若已启用）。
   * 行尾统一补一个换行：daemon / control 的 log 回调传入的行可能自带行尾，
   * 归一化避免出现空行。
   * @param line 单行文本（不含行尾时自动补 "\n"）
   */
  private writeLine(line: string): void {
    const text = line.endsWith("\n") ? line : `${line}\n`;
    process.stdout.write(text);
    if (this.logStreamOk) {
      this.logStream?.write(text);
    }
  }

  /** 打开日志文件流（追加模式）；失败时降级为仅 stdout 并记一条 warn。 */
  private openLogFile(): void {
    if (this.logFile === undefined) {
      return;
    }
    try {
      const stream = createWriteStream(this.logFile, { flags: "a" });
      stream.on("error", (err: Error) => {
        this.logStreamOk = false;
        this.log("warn", `log file unavailable, fallback to stdout only: ${errorText(err)}`);
      });
      this.logStream = stream;
      this.logStreamOk = true;
    } catch (err) {
      this.logStreamOk = false;
      this.log("warn", `log file unavailable, fallback to stdout only: ${errorText(err)}`);
    }
  }

  /** 关闭日志文件流（等待 close；未启用 / 已不可用时立即返回）。 */
  private async closeLogFile(): Promise<void> {
    const stream = this.logStream;
    this.logStream = undefined;
    this.logStreamOk = false;
    if (stream === undefined) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      stream.end(() => finish());
      stream.once("close", () => finish());
    });
  }
}

/**
 * 启动一个 hub 进程：组合 HubDaemon + S2 控制通道；监听 SIGINT/SIGTERM；
 * /v1/hub/shutdown 路由触发的 onShutdown 走同一退出流程。
 *
 * 返回后调用方应让进程常驻：cli/commands/hub.ts 通过 `await hub.stopped()`
 * （等价于等待一个直到 SIGINT/SIGTERM/shutdown 才 resolve 的 promise）
 * 决定打印 stopped 与退出时机。
 *
 * @param opts 进程选项（端口与日志文件；缺省见 {@link HubProcessOptions}）
 * @returns hub 进程句柄（尚未启动；调用 start() 才开始监听）
 */
export function runHubProcess(opts?: HubProcessOptions): HubProcess {
  return new HubProcessImpl(opts);
}
