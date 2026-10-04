// src/cli/commands/host.ts
/**
 * `tts host list` / `tts host check [--pack <路径>]`：图床注册表与素材存活检测
 * （阶段 3，窗口 C）。
 *
 * 分工（本文件是薄调用层）：
 * - `host list`：只读展示 src/host/command.ts 的 {@link listHosts} 结果
 *   （内置默认 steamcloud + 全局配置声明 + 插件目录加载，来源逐项标出）；
 * - `host check`：从图包工作区盘点素材 URL → 用所选图床的 `check(url)` 逐个
 *   做存活检测（HTTP 探测 / local 的 file:// 判定都在各实现内），报告死链。
 *
 * `--pack` 的 URL 来源（两处合并去重）：
 * 1. `<pack>/.tts/skeleton.json`（存档骨架）→ src/assets/migrate.ts 的
 *    {@link collectSaveUrls}（全仓唯一遍历器，{lang} 变体按契约跳过）；
 * 2. `<pack>/assets.yaml`（素材台账）→ 逐条 url。
 * 骨架缺失不算错误（工作区可能还没 unpack），台账缺失同理；两处都没有 URL
 * 时打印"没有可检测的素材"并以 0 退出（空不是失败）。
 *
 * 图床选择：`--host <id>`（缺省 "steamcloud"——内置默认图床，其 check 是
 * HTTP 探测）。id 不存在时 resolveHost 抛 HOST_NOT_FOUND（绝不静默回退到
 * 别的图床，见 src/host/command.ts 的安全约定）。
 *
 * 退出码：成功 0；有死链（check 返回 alive=false）时 1（门禁语义，脚本可
 * 直接当健康检查用）；错误 1。
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像；缺键时 t() 原样输出键名）：
 * - 静态：`cli.command.host.*`、`cli.host.list.*`、`cli.host.check.*`、
 *   `common.yes` / `common.no`、`error.unknown` {msg}；
 * - 动态（键 = `error.` + PackError.code，占位符 {msg}）：HOST_NOT_FOUND /
 *   HOST_CONFIG_INVALID / HOST_PLUGIN_LOAD_FAILED / HOST_PLUGIN_INVALID /
 *   HOST_INVALID_INPUT / SKELETON_INVALID / ASSETS_INVALID / ASSETS_READ_FAILED。
 */

import { readFile } from "node:fs/promises";

import { Command } from "commander";

import { collectSaveUrls } from "../../assets/migrate.js";
import { listHosts, resolveHost, RESERVED_DEFAULT_HOST_ID, type HostEntry } from "../../host/command.js";
import { t } from "../../i18n/index.js";
import { skeletonPath } from "../../pack/layout.js";
import { readAssetsManifest } from "../../pack/manifest.js";
import { PackError } from "../../pack/packyaml.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 死链列表最多展示条数（超过只报数量，避免刷屏） */
const MAX_DEAD_LISTED = 50;

/** check 并发的默认上限（与 src/assets/check.ts / fetch.ts 的缺省一致） */
const CHECK_CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// 选项类型
// ---------------------------------------------------------------------------

/** `tts host check` 的选项 */
interface HostCheckOptions {
  /** 图包工作区根目录（默认 "."，由 commander 的默认值填入） */
  pack: string;
  /** 用于检测的图床 id（缺省 steamcloud） */
  host?: string;
}

/** URL 盘点结果 */
interface PackUrlInventory {
  /** 去重后的 URL（码元序升序，可复现） */
  urls: string[];
  /** 其中来自存档骨架的条数（去重前） */
  skeletonRefs: number;
  /** 其中来自 assets.yaml 的条数 */
  ledgerRefs: number;
}

// ---------------------------------------------------------------------------
// 错误出口
// ---------------------------------------------------------------------------

/**
 * host 子命令的统一错误出口（与 pack.ts 的 reportPackError 同一份实现）。
 * @param err 命令 action 中捕获的异常
 * @returns 建议的进程退出码（恒为 1）
 */
function reportHostError(err: unknown): number {
  if (err instanceof PackError) {
    console.error(t(`error.${err.code}`, { msg: err.message }));
    return 1;
  }
  console.error(t("error.unknown", { msg: err instanceof Error ? err.message : String(err) }));
  return 1;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 是否是"文件不存在"的 IO 错误（骨架 / 台账缺失都按"没有该来源"处理） */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * 盘点图包工作区里的素材 URL：存档骨架（.tts/skeleton.json）+ assets.yaml。
 *
 * 骨架不存在 / 台账不存在都按"该来源为空"处理；骨架存在但损坏（非法 JSON
 * 或不是键值对象）时抛 PackError，绝不静默当作"没有 URL"——那会给出误导性
 * 的"全部健康"结论。
 *
 * @param root 图包工作区根目录
 * @returns 去重 URL 与两个来源的引用计数
 * @throws PackError code="SKELETON_INVALID" 骨架不是合法 JSON 时
 * @throws PackError code="ASSETS_MIGRATE_INVALID" 骨架不是键值对象时（collectSaveUrls 的入参校验）
 * @throws PackError code="ASSETS_INVALID" / "ASSETS_READ_FAILED" assets.yaml 损坏 / 不可读时
 */
async function collectPackUrls(root: string): Promise<PackUrlInventory> {
  const urls = new Set<string>();
  let skeletonRefs = 0;
  let ledgerRefs = 0;

  const skeletonFile = skeletonPath(root);
  let skeletonRaw: string | undefined;
  try {
    skeletonRaw = await readFile(skeletonFile, "utf8");
  } catch (err) {
    if (!isEnoent(err)) {
      throw new PackError(
        "SKELETON_INVALID",
        t("error.pack.build.skeletonInvalid", {
          path: skeletonFile,
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  if (skeletonRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(skeletonRaw);
    } catch (err) {
      throw new PackError(
        "SKELETON_INVALID",
        t("error.pack.build.skeletonInvalid", {
          path: skeletonFile,
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    const inventory = collectSaveUrls(parsed); // 非键值对象时抛 ASSETS_MIGRATE_INVALID
    for (const url of inventory.urls) {
      urls.add(url);
      skeletonRefs += 1;
    }
  }

  const manifest = await readAssetsManifest(root);
  for (const entry of manifest?.assets ?? []) {
    urls.add(entry.url);
    ledgerRefs += 1;
  }

  return { urls: [...urls].sort(), skeletonRefs, ledgerRefs };
}

/** 简单并发池（与 src/assets/fetch.ts 同款：queue.shift() 在单线程下原子） */
async function pLimit<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) {
        await fn(item);
      }
    }
  });
  await Promise.all(workers);
}

/** 图床来源的界面标签（builtin / config / plugin） */
function sourceLabel(source: HostEntry["source"]): string {
  return t(`cli.host.source.${source}`);
}

// ---------------------------------------------------------------------------
// 子命令：list
// ---------------------------------------------------------------------------

/**
 * `tts host list`：列出全部可用图床（内置 + 配置声明 + 插件）及其能力声明。
 *
 * 内置默认图床（steamcloud）带"默认"标记；能力行给出 deletable / 单文件上限 /
 * 支持格式（未声明上限或格式时显示 "-"）。id 冲突 / 配置非法 / 插件损坏时
 * listHosts 抛 PackError（绝不静默忽略），本层按错误码出口呈现。
 */
const listSub = new Command("list")
  .description(t("cli.command.host.list.description"))
  .action(async () => {
    try {
      const entries = await listHosts();
      console.log(t("cli.host.list.header", { count: entries.length }));
      for (const entry of entries) {
        const capabilities = entry.host.capabilities();
        const defaultMark =
          entry.host.id === RESERVED_DEFAULT_HOST_ID ? t("cli.host.list.defaultMark") : "";
        console.log(`  ${entry.host.id}  ${sourceLabel(entry.source)}${defaultMark}`);
        console.log(
          t("cli.host.list.caps", {
            deletable: capabilities.deletable ? t("common.yes") : t("common.no"),
            maxSize:
              capabilities.maxFileSize === undefined
                ? t("cli.host.list.unlimited")
                : `${capabilities.maxFileSize} ${t("cli.host.list.bytes")}`,
            formats: capabilities.formats === undefined ? "-" : capabilities.formats.join(","),
          }),
        );
      }
    } catch (err) {
      process.exit(reportHostError(err));
    }
  });

// ---------------------------------------------------------------------------
// 子命令：check
// ---------------------------------------------------------------------------

/**
 * `tts host check [--pack <路径>] [--host <id>]`：盘点工作区素材 URL 并逐个
 * 做存活检测（所选图床的 check 实现）。
 *
 * 全部存活（或无 URL）→ 0；存在死链 → 1（门禁语义）。
 */
const checkSub = new Command("check")
  .description(t("cli.command.host.check.description"))
  .option("--pack <dir>", t("cli.command.host.check.option.pack"), ".")
  .option("--host <id>", t("cli.command.host.check.option.host"))
  .action(async (opts: HostCheckOptions) => {
    try {
      const inventory = await collectPackUrls(opts.pack);
      if (inventory.urls.length === 0) {
        console.log(t("cli.host.check.empty", { root: opts.pack }));
        return;
      }
      const host = await resolveHost(opts.host ?? RESERVED_DEFAULT_HOST_ID);
      console.log(
        t("cli.host.check.header", {
          count: inventory.urls.length,
          host: host.id,
          skeleton: inventory.skeletonRefs,
          ledger: inventory.ledgerRefs,
        }),
      );

      const dead: Array<{ url: string; detail: string }> = [];
      let alive = 0;
      await pLimit(inventory.urls, CHECK_CONCURRENCY, async (url) => {
        const liveness = await host.check(url);
        if (liveness.alive) {
          alive += 1;
          return;
        }
        const detail =
          liveness.error ?? (liveness.status === undefined ? "" : `HTTP ${liveness.status}`);
        dead.push({ url, detail: detail === "" ? "-" : detail });
      });

      for (const item of dead.slice(0, MAX_DEAD_LISTED)) {
        console.log(t("cli.host.check.dead", { url: item.url, detail: item.detail }));
      }
      if (dead.length > MAX_DEAD_LISTED) {
        console.log(t("cli.host.check.more", { count: dead.length - MAX_DEAD_LISTED }));
      }
      console.log(
        t("cli.host.check.summary", { total: inventory.urls.length, alive, dead: dead.length }),
      );
      if (dead.length > 0) {
        process.exitCode = 1;
      }
    } catch (err) {
      process.exit(reportHostError(err));
    }
  });

// ---------------------------------------------------------------------------
// 主命令
// ---------------------------------------------------------------------------

/** `tts host` 主命令：list / check 两个子命令在上方定义后统一挂载 */
export const hostCommand: Command = new Command("host").description(t("cli.command.host.description"));

hostCommand.addCommand(listSub);
hostCommand.addCommand(checkSub);
