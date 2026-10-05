// src/cli/commands/watch.ts
/**
 * `tts watch [root]`：监听图包工作区 scripts/ + ui/ 文件变化，防抖后自动 push。
 *
 * 阶段 5「写入路径」的 watch 模式（施工流程 5.7）：把 `tts pack push` 的完整安全
 * 流水线（pushSaveAndPlay：素材改动拦截 → 基线冲突检测 → 过滤 → 备份 → 写回 →
 * 回读校验 → 更新基线）挂到文件监听上，改完即推。
 *
 * ## 监听范围
 * - 只监听 `<root>/scripts`（.lua）与 `<root>/ui`（.xml）两个目录的
 *   add / change / unlink 文件事件；`decks/` 与 `objects/` **根本不在监听列表里**——
 *   素材改动本来就该被 push 拦截（约束 7：push 协议 messageID 1 不接收素材字段），
 *   监听它们只会白白触发注定失败的 push；
 * - 事件回调里再做一次扩展名过滤（双保险），非 .lua / .xml 的事件直接丢弃；
 * - ⚠️ chokidar 4 已移除 glob 支持：传 "scripts" 加 glob 通配（如 scripts 加
 *   两个星斜杠的 .lua 模式）会被当成字面路径而永远收不到事件，因此这里传
 *   **目录** + `ignored` 过滤函数（目录不忽略、非 .lua/.xml 的文件忽略）。
 *
 * ## 防抖与重入
 * - 手写 setTimeout 防抖（不引 lodash）：每次事件 clearTimeout + setTimeout，
 *   静默 {@link DEFAULT_DEBOUNCE_MS}（可 --debounce 调整）后才触发一轮 push，
 *   防抖窗口内的多个事件合批为一次 push；
 * - push 进行中（备份 + 写回 + 回读可能要数秒）再来的事件不会并发第二个 push：
 *   记一个 rerun 标记，本轮结束后自动再排一轮，保证最后一轮改动不丢。
 *
 * ## dry-run 语义（默认安全）
 * - 不带 --yes → dryRun=true：每轮只做检测（素材 / 基线 / 差异计数），不写游戏；
 * - 带 --yes → dryRun=false：静默期结束后自动实写。**--yes 就是本命令的确认门**
 *   （启动时已显式给出；事件级交互确认会让 watch 失去意义），独立模式把
 *   `confirm: async () => true` 传给 pushSaveAndPlay；
 * - `--dry-run` 与 `--yes` 同时给出时 --yes 优先（与 `tts pack push` 一致）。
 *
 * ## hub 委托（Stage C 裁决：与 pack-cli-hub 的调用形状对齐）
 * 每轮 push 前现探 hub（{@link tryHubClient} 每次重探、不缓存，契约见 src/cli/_shared.ts）：
 * - hub 在线 → `hub.push(root, true, { dryRun, forceScriptsOnly, backupRetention })`
 *   委托（hub 进程内持 39998 独占绑定，经坑 17 注入 server 走同一 pushSaveAndPlay
 *   流水线）；委托失败打印 cli.watch.pushFailed 并**继续 watch（不退出、不回退
 *   独立模式**——hub 在线时独立模式必然绑不上 39998，与 pull/exec/status 同款）；
 *   HubClient.push 的三参签名由 pack-cli-hub 窗口同步升级进 src/mcp/client.ts
 *   （本文件按该形状以类型断言调用，另做运行时形状窄化）；
 * - dryRun 回显校验：响应体 `dryRun` 与请求不一致（老 hub / 老客户端不识别新字段，
 *   可能已按实写执行）→ 打印 cli.watch.dryRunMismatch，本轮按失败处理，绝不显示
 *   成功摘要；
 * - hub 离线 → 独立模式：本地 {@link pushSaveAndPlay}（withEditorServer 临时绑
 *   39998，用完即走）。
 *
 * ## 错误处理
 * - 启动即 {@link readPackYaml} 校验工作区：非图包目录立即失败退出（不等第一次
 *   文件事件才报 PACK_NOT_FOUND）；
 * - push 轮内任何失败（PackError / 网络 / 端口 / 协议超时）→ stderr 打印
 *   cli.watch.pushFailed {code} {message} 后**继续 watch**——watch 是长驻命令，
 *   一次失败（例如 TTS 正在加载存档）不该终止监听；
 * - SIGINT → 打印 cli.watch.stopped → watcher.close() → process.exit(0)。
 *
 * ## 错误码
 * 本命令**不新增** PackError 错误码：轮内错误来自 pushSaveAndPlay 及其下游
 * （PACK_NOT_FOUND / PACK_INVALID / PACK_READ_FAILED / PUSH_ASSET_CHANGES_DETECTED /
 * BASELINE_CONFLICT / PUSH_ABORTED / PUSH_VERIFY_FAILED / PUSH_FAILED /
 * BASELINE_* / BACKUP_* 等），在 cli.watch.pushFailed 的 {code} 里原样透出；
 * 非 PackError（网络 / 端口 / 协议层）透出 Node 风格 err.code 或 "WATCH_PUSH_UNKNOWN"。
 *
 * ## i18n 键（locales/*.json 由 Run 2 补齐；缺键时 t() 原样输出键名）
 * - `cli.command.watch.description`
 * - `cli.command.watch.argument.root`
 * - `cli.command.watch.option.dryRun` / `.yes` / `.debounce` / `.forceScriptsOnly` / `.backupRetention`
 * - `cli.watch.started` {root} {dryRun}      —— 启动横幅
 * - `cli.watch.watching`                     —— 持续监听中提示
 * - `cli.watch.viaHub`                       —— hub 委托提示（无参）
 * - `cli.watch.pushing`                      —— 每轮 push 开始（无参）
 * - `cli.watch.pushOk` {pushed} {skipped} {backupDir}   —— 实写成功摘要（无备份时 backupDir 传 "-"）
 * - `cli.watch.dryRunSummary` {pushed} {skipped}        —— dry-run 摘要
 * - `cli.watch.dryRunMismatch` {expected} {actual}      —— hub dry-run 回显不一致
 * - `cli.watch.pushFailed` {code} {message}  —— 轮内失败（继续 watch）
 * - `cli.watch.stopped`                      —— SIGINT 退出提示
 * - `cli.watch.invalidDebounce` {value}      —— --debounce 非正整数
 * - `cli.watch.invalidBackupRetention` {value} —— --backup-retention 非 1..100 整数
 */

import { watch } from "chokidar";
import { Command } from "commander";
import path from "node:path";

import { t } from "../../i18n/index.js";
import { scriptsDir, uiDir } from "../../pack/layout.js";
import { PackError, readPackYaml } from "../../pack/packyaml.js";
import { pushSaveAndPlay } from "../../pack/push.js";
import { tryHubClient } from "../_shared.js";
import { describeError, red } from "../with-server.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 脚本文件扩展名（与 layout.scriptFileName / collectPushItems 的约定一致） */
const LUA_EXT = ".lua" as const;

/** UI 文件扩展名（与 layout.uiFileName / collectPushItems 的约定一致） */
const XML_EXT = ".xml" as const;

/** 防抖延迟缺省值（毫秒）——命令默认值，与任务约定一致 */
const DEFAULT_DEBOUNCE_MS = 300;

/** 备份保留份数缺省值（与 pushSaveAndPlay / pack.yaml push.backup_retention 的缺省一致） */
const DEFAULT_BACKUP_RETENTION = 20;

/** 备份保留份数上限（与 pack.yaml push.backup_retention 的 zod 约束一致） */
const MAX_BACKUP_RETENTION = 100;

/** awaitWriteFinish 的写稳定阈值（毫秒）——编辑器保存时的多次落盘合并为一个事件 */
const AWF_STABILITY_THRESHOLD_MS = 200;

/** awaitWriteFinish 的轮询间隔（毫秒） */
const AWF_POLL_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// hub 委托的调用形状（Stage C 裁决）
// ---------------------------------------------------------------------------

/**
 * hub /v1/push 委托的响应体形状（与 pack-cli-hub 窗口升级后的 handlePush 对齐：
 * `{ok:true, dryRun, pushed, skipped, backupDir?, baselineConflicts?, assetChanges?, items}`）。
 * 本命令只消费其中 dryRun / pushed / skipped / backupDir 四个字段。
 */
interface HubPushBody {
  /** 固定 true */
  ok: true;
  /** hub 侧 pushSaveAndPlay 实际执行的 dryRun（回显校验用） */
  dryRun: boolean;
  /** 写入（dry-run 下为"将写入"）的对象数 */
  pushed: number;
  /** 无变化而跳过的对象数 */
  skipped: number;
  /** 备份目录（dry-run 下缺省） */
  backupDir?: string;
}

/**
 * {@link import("../../mcp/client.js").HubClient.push} 升级后的三参调用形状。
 *
 * 当前 src/mcp/client.ts 的 push 只有 (root, confirm) 两参（阶段 4 骨架）；
 * pack-cli-hub 窗口会同步升级签名与响应体（Stage C 裁决）。本文件在其落地前
 * 先按目标形状以断言调用——升级后无需改动本文件。
 */
type HubPushWithOptions = (
  root: string,
  confirm: true,
  opts?: { dryRun?: boolean; forceScriptsOnly?: boolean; backupRetention?: number },
) => Promise<HubPushBody>;

/** hub push 响应窄化后的摘要（dryRun 可为 undefined：老版响应不回显该字段） */
interface HubPushSummary {
  /** 回显的 dryRun；老版响应缺失时为 undefined（调用方按回显不一致处理） */
  dryRun: boolean | undefined;
  /** 写入（dry-run 下为"将写入"）的对象数；老版响应回退 items */
  pushed: number;
  /** 无变化而跳过的对象数；老版响应缺省按 0 */
  skipped: number;
  /** 备份目录；dry-run 或老版响应缺省 */
  backupDir?: string;
}

/**
 * hub push 代理响应的运行时窄化（与 pull.ts 的 asPullCounts 同款防御式解析）。
 *
 * 输入理论上是 {@link HubPushBody}，但老版 hub / 客户端可能只回 `{ok, items}`：
 * - pushed 缺失时回退 items（老版语义为"写回条数"）；
 * - dryRun 非 boolean 时置 undefined——调用方据此判定回显不一致并告警，
 *   绝不把它当成功摘要展示；
 * - skipped 缺失按 0、backupDir 非 string 按缺省处理。
 *
 * @param body 控制通道 JSON 响应体
 * @returns 形状可解析时返回摘要；完全不合形状（非对象 / ok!==true / 计数字段全缺）时 undefined
 */
function asHubPushBody(body: unknown): HubPushSummary | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (record.ok !== true) {
    return undefined;
  }
  const pushed =
    typeof record.pushed === "number"
      ? record.pushed
      : typeof record.items === "number"
        ? record.items
        : undefined;
  if (pushed === undefined) {
    return undefined;
  }
  return {
    dryRun: typeof record.dryRun === "boolean" ? record.dryRun : undefined,
    pushed,
    skipped: typeof record.skipped === "number" ? record.skipped : 0,
    ...(typeof record.backupDir === "string" ? { backupDir: record.backupDir } : {}),
  };
}

/**
 * 从 unknown 错误中取 Node 风格 code（如 ECONNREFUSED），避免 any。
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
 * 解析正整数选项值（--debounce 用）。
 * @param value commander 传入的原始字符串
 * @returns 合法时返回正整数；非数字 / 非正 / 带小数时 undefined
 */
function parsePositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && String(parsed) === value.trim() ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// 命令定义
// ---------------------------------------------------------------------------

/** watch 命令的选项形状（commander 解析结果，camelCase） */
interface WatchCommandOptions {
  /** --dry-run（缺省 true；最终 dryRun 以 !yes 为准） */
  dryRun: boolean;
  /** --yes（缺省 false） */
  yes: boolean;
  /** --debounce <ms>（字符串，自行解析校验） */
  debounce: string;
  /** --force-scripts-only（缺省 false） */
  forceScriptsOnly: boolean;
  /** --backup-retention <n>（字符串，自行解析校验） */
  backupRetention: string;
}

/** watch 轮内摘要的统一出口（dry-run 与实写共用一套键位布局） */
function printPushSummary(dryRun: boolean, pushed: number, skipped: number, backupDir: string | undefined): void {
  if (dryRun) {
    console.log(t("cli.watch.dryRunSummary", { pushed, skipped }));
  } else {
    console.log(t("cli.watch.pushOk", { pushed, skipped, backupDir: backupDir ?? "-" }));
  }
}

export const watchCommand = new Command("watch")
  .description(t("cli.command.watch.description"))
  .argument("[root]", t("cli.command.watch.argument.root"), ".")
  .option("--dry-run", t("cli.command.watch.option.dryRun"), true)
  .option("--yes", t("cli.command.watch.option.yes"), false)
  .option("--debounce <ms>", t("cli.command.watch.option.debounce"), String(DEFAULT_DEBOUNCE_MS))
  .option("--force-scripts-only", t("cli.command.watch.option.forceScriptsOnly"), false)
  .option("--backup-retention <n>", t("cli.command.watch.option.backupRetention"), String(DEFAULT_BACKUP_RETENTION))
  .action(async (rootArgument: string, opts: WatchCommandOptions) => {
    // —— 1. 选项校验（非法立即退出，不启动 watcher）——
    const debounceMs = parsePositiveInt(opts.debounce);
    if (debounceMs === undefined) {
      console.error(t("cli.watch.invalidDebounce", { value: opts.debounce }));
      process.exit(1);
    }
    const backupRetentionRaw = Number.parseInt(opts.backupRetention, 10);
    const backupRetentionValid =
      Number.isInteger(backupRetentionRaw) &&
      backupRetentionRaw >= 1 &&
      backupRetentionRaw <= MAX_BACKUP_RETENTION &&
      String(backupRetentionRaw) === opts.backupRetention.trim();
    if (!backupRetentionValid) {
      console.error(t("cli.watch.invalidBackupRetention", { value: opts.backupRetention }));
      process.exit(1);
    }
    const backupRetention = backupRetentionValid ? backupRetentionRaw : DEFAULT_BACKUP_RETENTION;

    const root = path.resolve(rootArgument);
    const dryRun = !opts.yes; // --yes 优先：给了 --yes 就实写，否则恒为 dry-run
    const forceScriptsOnly = opts.forceScriptsOnly === true;

    // —— 2. 启动即校验工作区（非图包目录立刻失败，不等第一次文件事件才报）——
    try {
      await readPackYaml(root);
    } catch (err) {
      if (err instanceof PackError) {
        console.error(red(err.message));
      } else {
        console.error(t("error.generic", { message: describeError(err) }));
      }
      process.exit(1);
    }

    console.log(t("cli.watch.started", { root, dryRun }));
    console.log(t("cli.watch.watching"));

    // —— 3. 防抖 + 重入状态 ——
    let debounceTimer: NodeJS.Timeout | undefined;
    let pushing = false;
    let rerunAfterPush = false;

    /**
     * 排一轮 push：静默 debounceMs 后触发。窗口内每个新事件都会重置计时器，
     * 从而把连发的 add/change/unlink 合批为一次 push。
     */
    const schedulePush = (): void => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        void runPushCycle();
      }, debounceMs);
    };

    /**
     * 执行一轮 push（hub 委托或独立模式），失败打印 pushFailed 并继续 watch。
     * push 进行中再被触发时只记 rerun 标记，本轮结束后自动补一轮。
     */
    const runPushCycle = async (): Promise<void> => {
      if (pushing) {
        rerunAfterPush = true;
        return;
      }
      pushing = true;
      try {
        console.log(t("cli.watch.pushing"));
        const hub = await tryHubClient();
        if (hub !== null) {
          // —— hub 委托路径（Stage C 裁决：与 pack-cli-hub 的调用形状对齐）——
          console.log(t("cli.watch.viaHub"));
          const pushWithOpts = hub.push.bind(hub) as unknown as HubPushWithOptions;
          const body = await pushWithOpts(root, true, { dryRun, forceScriptsOnly, backupRetention });
          const summary = asHubPushBody(body);
          if (summary === undefined) {
            throw new Error("/v1/push response is not the expected {ok:true,pushed:number} shape");
          }
          // dryRun 回显校验：老 hub / 老客户端不识别新字段时可能已按实写执行，
          // 绝不能把这种轮次当成功展示（也不退出 watch）
          if (summary.dryRun !== dryRun) {
            console.error(t("cli.watch.dryRunMismatch", { expected: dryRun, actual: summary.dryRun }));
            return;
          }
          printPushSummary(summary.dryRun, summary.pushed, summary.skipped, summary.backupDir);
        } else {
          // —— 独立模式（hub 不在线）：本地 pushSaveAndPlay 全流水线 ——
          // 确认门即启动时的 --yes（事件级确认会让 watch 失去意义），dry-run 下
          // 该门不会被走到（pushSaveAndPlay 在确认前就返回）
          const result = await pushSaveAndPlay({
            root,
            dryRun,
            forceScriptsOnly,
            backupRetention,
            confirm: async () => true,
          });
          printPushSummary(result.dryRun, result.pushed, result.skipped, result.backupDir);
        }
      } catch (err) {
        const code = err instanceof PackError ? err.code : (errCode(err) ?? "WATCH_PUSH_UNKNOWN");
        console.error(t("cli.watch.pushFailed", { code, message: describeError(err) }));
      } finally {
        pushing = false;
        if (rerunAfterPush) {
          rerunAfterPush = false;
          schedulePush();
        }
      }
    };

    // —— 4. 文件监听：只听 scripts/ + ui/ 的 .lua / .xml，不听 decks/ / objects/ ——
    const isWatchedFile = (filePath: string): boolean => {
      const ext = path.extname(filePath).toLowerCase();
      return ext === LUA_EXT || ext === XML_EXT;
    };
    const onFileEvent = (filePath: string): void => {
      if (isWatchedFile(filePath)) {
        schedulePush();
      }
    };
    const fileWatcher = watch([scriptsDir(root), uiDir(root)], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: AWF_STABILITY_THRESHOLD_MS, pollInterval: AWF_POLL_INTERVAL_MS },
      // 只忽略"非 .lua/.xml 的文件"；目录放行（stats 判空防御：事件路径可能不带 stats）
      ignored: (candidate, stats) => stats?.isFile() === true && !isWatchedFile(candidate),
    });
    fileWatcher.on("add", onFileEvent).on("change", onFileEvent).on("unlink", onFileEvent);

    // —— 5. SIGINT 优雅退出：stopped → watcher.close() → exit(0) ——
    let stopRequested = false;
    let resolveStopped: (() => void) | undefined;
    process.once("SIGINT", () => {
      if (stopRequested) {
        return;
      }
      stopRequested = true;
      console.log(t("cli.watch.stopped"));
      void fileWatcher
        .close()
        .then(() => {
          resolveStopped?.();
          process.exit(0);
        })
        // 测试里 process.exit 会被 mock 成抛错；真实运行时 exit 不会抛
        .catch(() => undefined);
    });

    // 挂起至 SIGINT：commander 会 await 本 action；测试据此等待优雅退出完成
    await new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
  });
