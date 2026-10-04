// src/cli/commands/fetch.ts
/**
 * `tts fetch <清单或URL> [--pack <路径>]`：素材健康报告（方案设计 §6.4；阶段 3，窗口 C）。
 *
 * 一步到位地体检一批素材 URL：src/assets/fetch.ts 的 {@link checkAssetHealth}
 * 负责形态识别（老 Steam Cloud 域名迁移 / Google Drive 转直链 / Dropbox、
 * paste 站 raw 形式 / 缺协议补全）+ 并发探测，输出四分类：
 * 正常 ok / 可迁移 migratable / 死链 dead / 需人工处理 manual，并给修复动作。
 *
 * URL 来源（可叠加，去重后统一体检）：
 * - `<清单或URL>` 位置参数：
 *   · 指向**已存在文件**时按其内容取 URL——`.json` 用存档骨架同款遍历器
 *     （src/assets/migrate.ts 的 collectSaveUrls，{lang} 变体按契约跳过）；
 *     其他扩展名按纯文本清单处理（一行一个 URL，`#` 开头与空行忽略）；
 *   · 不是文件时按单个 URL 处理（www. 缺协议等形态由 describeUrl 识别）；
 * - `--pack <路径>`：额外并入图包工作区盘点的 URL（`.tts/skeleton.json` +
 *   `assets.yaml`，与 `tts host check` 同一来源口径）。
 *
 * 退出码：全部正常 / 可迁移 / 需人工 → 0；存在死链或一条 URL 都没取到 → 1
 * （用户明确要求体检却没取到 URL 几乎一定是清单给错了；死链是健康问题，CI
 * 可直接拿退出码当门禁）。错误（清单读不了 / 骨架损坏）同样 1。
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像；缺键时 t() 原样输出键名）：
 * - 静态：`cli.command.fetch.description` / `argument.source` / `option.pack`、
 *   `cli.fetch.fromFile` {path} {count}、`cli.fetch.header` {total} {ok}
 *   {migratable} {dead} {manual}、`cli.fetch.groupHeader` {category} {count}、
 *   `cli.fetch.entry` {url} {kind} {actions}、`cli.fetch.fixed` {url}、
 *   `cli.fetch.detail` {detail}、`cli.fetch.more` {count}、`cli.fetch.empty`
 *   {source}、`cli.fetch.deadNote`、`error.unknown` {msg}；
 * - 动态（键 = `error.` + PackError.code，占位符 {msg}）：ASSETS_FETCH_INVALID
 *   （以及 collectSaveUrls / assets.yaml 透传的 ASSETS_* / SKELETON_INVALID 等）。
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { checkAssetHealth, categoryLabel, fixActionLabel, kindLabel, type AssetCategory, type AssetHealthEntry } from "../../assets/fetch.js";
import { collectSaveUrls } from "../../assets/migrate.js";
import { t } from "../../i18n/index.js";
import { skeletonPath } from "../../pack/layout.js";
import { readAssetsManifest } from "../../pack/manifest.js";
import { PackError } from "../../pack/packyaml.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 每个分类最多展示条数（超过只报数量） */
const MAX_ENTRIES_LISTED = 50;

/** 需要逐条展示的分类（ok 只计数——它是绝大多数，列出来只会刷屏） */
const LISTED_CATEGORIES: readonly AssetCategory[] = ["migratable", "dead", "manual"];

// ---------------------------------------------------------------------------
// 选项类型
// ---------------------------------------------------------------------------

/** `tts fetch` 的选项 */
interface FetchOptions {
  /** 额外并入的图包工作区根目录（可选） */
  pack?: string;
}

// ---------------------------------------------------------------------------
// 错误出口
// ---------------------------------------------------------------------------

/**
 * fetch 子命令的统一错误出口（与 pack.ts 的 reportPackError 同一份实现）。
 * @param err 命令 action 中捕获的异常
 * @returns 建议的进程退出码（恒为 1）
 */
function reportFetchError(err: unknown): number {
  if (err instanceof PackError) {
    console.error(t(`error.${err.code}`, { msg: err.message }));
    return 1;
  }
  console.error(t("error.unknown", { msg: err instanceof Error ? err.message : String(err) }));
  return 1;
}

// ---------------------------------------------------------------------------
// URL 收集
// ---------------------------------------------------------------------------

/** 是否是"文件不存在"的 IO 错误 */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * 判断位置参数是否指向一个已存在的普通文件。
 * @param source 位置参数原文
 * @returns 存在且是文件返回 true
 */
async function isExistingFile(source: string): Promise<boolean> {
  try {
    return (await stat(source)).isFile();
  } catch {
    return false;
  }
}

/**
 * 从清单文件取 URL：
 * - `.json`（大小写不敏感）→ JSON.parse 后经 collectSaveUrls 遍历（存档 / 骨架；
 *   非键值对象时抛 ASSETS_MIGRATE_INVALID）；
 * - 其他扩展名按纯文本清单：一行一个 URL，去首尾空白，忽略空行与 `#` 注释行。
 *
 * @param file 清单文件路径
 * @returns 文件里的 URL 列表（保持出现顺序，调用方统一去重）
 * @throws PackError code="ASSETS_MIGRATE_INVALID" JSON 清单不是键值对象时
 * @throws Error 文件读不了时（IO 错误原样上抛，走 error.unknown 出口）
 */
async function readUrlsFromFile(file: string): Promise<string[]> {
  const raw = await readFile(file, "utf8");
  if (path.extname(file).toLowerCase() === ".json") {
    const parsed: unknown = JSON.parse(raw);
    return collectSaveUrls(parsed).urls;
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * 盘点图包工作区的素材 URL（`.tts/skeleton.json` + `assets.yaml`）。
 *
 * （与 src/cli/commands/host.ts 的同名实现是同一份逻辑；命令层模块之间按仓库
 * 约定不互相 import，此处为第二份副本，两处如需调整必须同步修改。）
 *
 * @param root 图包工作区根目录
 * @returns 去重后的 URL（码元序升序）
 * @throws PackError code="SKELETON_INVALID" 骨架不是合法 JSON 时
 * @throws PackError code="ASSETS_MIGRATE_INVALID" 骨架不是键值对象时
 */
async function collectPackUrls(root: string): Promise<string[]> {
  const urls = new Set<string>();
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
    for (const url of collectSaveUrls(parsed).urls) {
      urls.add(url);
    }
  }
  const manifest = await readAssetsManifest(root);
  for (const entry of manifest?.assets ?? []) {
    urls.add(entry.url);
  }
  return [...urls].sort();
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

/**
 * 逐条打印一个分类下的健康记录（url / 类型 / 修复动作 / 建议 URL / 说明）。
 * @param entry checkAssetHealth 的单条记录
 */
function printEntry(entry: AssetHealthEntry): void {
  const actions =
    entry.fixActions.length === 0 ? "-" : entry.fixActions.map((action) => fixActionLabel(action)).join("、");
  console.log(
    t("cli.fetch.entry", { url: entry.url, kind: kindLabel(entry.kind), actions }),
  );
  if (entry.fixedUrl !== undefined) {
    console.log(t("cli.fetch.fixed", { url: entry.fixedUrl }));
  }
  if (entry.detail !== undefined) {
    console.log(t("cli.fetch.detail", { detail: entry.detail }));
  }
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------

/**
 * `tts fetch <清单或URL>`：素材健康报告（四分类 + 修复动作）。
 *
 * 位置参数可以是 URL、存档 / 骨架 JSON、或一行一个 URL 的纯文本清单；
 * `--pack` 额外并入工作区盘点的 URL。检查走真实网络（代理读
 * https_proxy / HTTPS_PROXY，与 src/assets/check.ts 同一约定）。
 */
export const fetchCommand: Command = new Command("fetch")
  .description(t("cli.command.fetch.description"))
  .argument("<source>", t("cli.command.fetch.argument.source"))
  .option("--pack <dir>", t("cli.command.fetch.option.pack"))
  .action(async (source: string, opts: FetchOptions) => {
    try {
      const urls = new Set<string>();
      if (await isExistingFile(source)) {
        const fromFile = await readUrlsFromFile(source);
        console.log(t("cli.fetch.fromFile", { path: source, count: fromFile.length }));
        for (const url of fromFile) {
          urls.add(url);
        }
      } else {
        urls.add(source);
      }
      if (opts.pack !== undefined && opts.pack !== "") {
        for (const url of await collectPackUrls(opts.pack)) {
          urls.add(url);
        }
      }

      if (urls.size === 0) {
        console.error(t("cli.fetch.empty", { source }));
        process.exit(1);
      }

      const report = await checkAssetHealth([...urls]);
      console.log(
        t("cli.fetch.header", {
          total: report.total,
          ok: report.ok,
          migratable: report.migratable,
          dead: report.dead,
          manual: report.manual,
        }),
      );

      for (const category of LISTED_CATEGORIES) {
        const entries = report.entries.filter((entry) => entry.category === category);
        if (entries.length === 0) {
          continue;
        }
        console.log(t("cli.fetch.groupHeader", { category: categoryLabel(category), count: entries.length }));
        for (const entry of entries.slice(0, MAX_ENTRIES_LISTED)) {
          printEntry(entry);
        }
        if (entries.length > MAX_ENTRIES_LISTED) {
          console.log(t("cli.fetch.more", { count: entries.length - MAX_ENTRIES_LISTED }));
        }
      }

      if (report.dead > 0) {
        console.log(t("cli.fetch.deadNote"));
        process.exitCode = 1;
      }
    } catch (err) {
      process.exit(reportFetchError(err));
    }
  });
