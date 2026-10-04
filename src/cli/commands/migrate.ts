// src/cli/commands/migrate.ts
/**
 * `tts migrate --to <图床> [--pack <路径>]`：把图包素材迁移到目标图床
 * （方案设计 §3.4 / §4.6.1 / §6.4；阶段 3，窗口 C）。
 *
 * 流程（下载 → 上传 → 改写 URL，全部复用已有模块）：
 * 1. 盘点工作区里的**存档形态 JSON**：`.tts/skeleton.json` + `decks/**`、
 *    `objects/**` 下的 `data.json`（unpack 落盘的完整对象），经
 *    src/assets/migrate.ts 的 {@link collectSaveUrls}（全仓唯一遍历器）收集
 *    去重 URL；
 * 2. 逐条迁移：{@link describeUrl} 识别形态 → {@link fetchAsset} 下载
 *    （老 Steam Cloud 域名 / Google Drive 直链 / Dropbox / paste 站 raw 等
 *    改写全在 fetch 内完成）→ 目标图床 `upload`（resolveHost 解析
 *    `--to` 指定的 id，**找不到就报错，绝不回退默认图床**）；
 * 3. 上传产物的对象名 = {@link cacheFileName}（URL 去掉非字母数字字符 + 扩展名，
 *    即 TTS 自己的缓存键），扩展名经 {@link guessExtension} 从 URL / Content-Type
 *    推断，推断不出记失败（拒绝猜扩展名）；
 * 4. 把 old → new URL 映射经 {@link applyUrlMigration} **原地**写回全部存档形态
 *    JSON（有改写的文件才落盘，格式与 unpack 一致：2 空格缩进）；同步改写
 *    `assets.yaml` 的 url 与 `objects.csv` 的 source 列（值命中映射的行）；
 * 5. 打印迁移报告；仍有 URL 未迁移（失败）时退出码 1。
 *
 * 语义边界（诚实说明，写进 --help 的描述里）：
 * - `file:` / `{lang}` / 未知形态 / Google Drive 非文件链接**不可下载**，
 *   原样跳过并在报告里列出原因（对应 §2.6.4 "需重新上传"的人工处理场景）；
 * - Steam Cloud 手动上传返回的 pending 结果不是失败：URL 未变、映射不写入，
 *   报告里给出人工完成提示；
 * - 命令只改工作区（骨架 / data.json / 台账），不改游戏目录；迁移后重新
 *   `tts pack build` 即可产出引用新 URL 的存档。
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像；缺键时 t() 原样输出键名）：
 * - 静态：`cli.command.migrate.description` / `option.to` / `option.pack`、
 *   `cli.migrate.header` {host} {urls} {files}、`cli.migrate.migrated` {url} {newUrl}、
 *   `cli.migrate.skipped` {url} {reason}、`cli.migrate.failed` {url} {reason}、
 *   `cli.migrate.pending` {url} {hint}、`cli.migrate.more` {count}、
 *   `cli.migrate.summary` {migrated} {skipped} {failed} {pending} {rewritten} {files}、
 *   `cli.migrate.empty` {root}、`assets.migrate.extUnknown` / `assets.migrate.*`、
 *   `assets.fetch.manualReason.*`（跳过原因）、`error.unknown` {msg}；
 * - 动态（键 = `error.` + PackError.code，占位符 {msg}）：HOST_NOT_FOUND /
 *   HOST_CONFIG_INVALID / HOST_UPLOAD_FAILED / ASSETS_FETCH_INVALID /
 *   ASSETS_MIGRATE_INVALID / OBJECTS_* / ASSETS_*（各模块错误码透传）。
 */

import type { Dirent } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { describeUrl, fetchAsset, guessExtension, manualReasonText } from "../../assets/fetch.js";
import { applyUrlMigration, cacheFileName, collectSaveUrls } from "../../assets/migrate.js";
import { readObjectsCsv, writeObjectsCsv } from "../../deck/objects.js";
import { resolveHost } from "../../host/command.js";
import { t } from "../../i18n/index.js";
import { decksDir, objectsDir, skeletonPath } from "../../pack/layout.js";
import { readAssetsManifest, writeAssetsManifest } from "../../pack/manifest.js";
import { PackError } from "../../pack/packyaml.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 每类报告行最多展示条数（成功 / 跳过 / 失败 / 待人工各自统计） */
const MAX_ENTRIES_LISTED = 50;

/** 工作区对象的数据文件名（与 src/pack/unpack.ts / build.ts 的约定一致） */
const OBJECT_DATA_FILE = "data.json";

// ---------------------------------------------------------------------------
// 选项类型
// ---------------------------------------------------------------------------

/** `tts migrate` 的选项 */
interface MigrateOptions {
  /** 目标图床 id（必填；resolveHost 解析，找不到直接报错） */
  to: string;
  /** 图包工作区根目录（默认 "."） */
  pack: string;
}

/** 一份待改写的存档形态 JSON（骨架或对象 data.json） */
interface LoadedSaveFile {
  /** 文件绝对路径 */
  file: string;
  /** JSON.parse 后的根（改写就地生效） */
  root: unknown;
}

// ---------------------------------------------------------------------------
// 错误出口
// ---------------------------------------------------------------------------

/**
 * migrate 子命令的统一错误出口（与 pack.ts 的 reportPackError 同一份实现）。
 * @param err 命令 action 中捕获的异常
 * @returns 建议的进程退出码（恒为 1）
 */
function reportMigrateError(err: unknown): number {
  if (err instanceof PackError) {
    console.error(t(`error.${err.code}`, { msg: err.message }));
    return 1;
  }
  console.error(t("error.unknown", { msg: err instanceof Error ? err.message : String(err) }));
  return 1;
}

// ---------------------------------------------------------------------------
// 工作区盘点
// ---------------------------------------------------------------------------

/**
 * 递归收集目录下所有 `data.json`（深度不限；目录不存在时返回空）。
 * @param dir 起点目录
 * @param out 收集器（原地追加绝对路径）
 */
async function collectDataJsonFiles(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在 / 不可读：该来源为空（工作区可能还没 unpack 过）
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectDataJsonFiles(abs, out);
    } else if (entry.isFile() && entry.name === OBJECT_DATA_FILE) {
      out.push(abs);
    }
  }
}

/**
 * 载入工作区里全部存档形态 JSON：`.tts/skeleton.json`（存在时）+ decks/、
 * objects/ 下的 data.json。文件不是合法 JSON 时抛普通 Error（走 error.unknown
 * 出口）——坏掉的 data.json 必须先修，迁移不应静默跳过。
 *
 * @param root 图包工作区根目录
 * @returns 待改写的文件列表（顺序：骨架在前，其后按目录遍历序）
 * @throws Error 任一文件读不了或不是合法 JSON 时
 */
async function loadSaveFiles(root: string): Promise<LoadedSaveFile[]> {
  const files: string[] = [];
  const skeleton = skeletonPath(root);
  try {
    if ((await stat(skeleton)).isFile()) {
      files.push(skeleton);
    }
  } catch {
    // 骨架缺失：正常（工作区可以还没 unpack）
  }
  const dataFiles: string[] = [];
  await collectDataJsonFiles(decksDir(root), dataFiles);
  await collectDataJsonFiles(objectsDir(root), dataFiles);
  files.push(...dataFiles);

  const loaded: LoadedSaveFile[] = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    loaded.push({ file, root: JSON.parse(raw) as unknown });
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------

/**
 * `tts migrate --to <图床>`：下载 → 上传 → 改写工作区 URL。
 *
 * 逐条独立：单条 URL 下载 / 上传失败只记入报告（不中断整批）；仍有失败时以
 * 退出码 1 结束，便于脚本判断"迁移是否完整"。不可下载形态（file: / {lang} /
 * 未知 / GDrive 非文件链接）只跳过并列出原因（人工处理场景）。
 */
export const migrateCommand: Command = new Command("migrate")
  .description(t("cli.command.migrate.description"))
  .requiredOption("--to <host>", t("cli.command.migrate.option.to"))
  .option("--pack <dir>", t("cli.command.migrate.option.pack"), ".")
  .action(async (opts: MigrateOptions) => {
    try {
      const host = await resolveHost(opts.to);
      const root = path.resolve(opts.pack);
      const saveFiles = await loadSaveFiles(root);

      // —— 1. 收集去重 URL（骨架 + data.json）——
      const urls = new Set<string>();
      for (const save of saveFiles) {
        for (const url of collectSaveUrls(save.root).urls) {
          urls.add(url);
        }
      }
      if (urls.size === 0) {
        console.log(t("cli.migrate.empty", { root }));
        return;
      }
      console.log(
        t("cli.migrate.header", { host: host.id, urls: urls.size, files: saveFiles.length }),
      );

      // —— 2. 逐条下载 + 上传（单条失败不中断）——
      const mapping = new Map<string, string>();
      const migrated: Array<{ url: string; newUrl: string }> = [];
      const skipped: Array<{ url: string; reason: string }> = [];
      const failed: Array<{ url: string; reason: string }> = [];
      const pending: Array<{ url: string; hint: string }> = [];

      for (const url of [...urls].sort()) {
        const desc = describeUrl(url);
        if (desc.downloadUrl === undefined) {
          skipped.push({ url, reason: manualReasonText(desc.kind) });
          continue;
        }
        const outcome = await fetchAsset(url);
        if (!outcome.ok) {
          failed.push({ url, reason: outcome.error });
          continue;
        }
        const ext = guessExtension(url, outcome.contentType);
        if (ext === undefined) {
          failed.push({ url, reason: t("assets.migrate.extUnknown") });
          continue;
        }
        let uploaded;
        try {
          uploaded = (await host.upload([{ name: cacheFileName(url, ext), data: outcome.data }], {}))[0];
        } catch (err) {
          failed.push({ url, reason: err instanceof Error ? err.message : String(err) });
          continue;
        }
        if (uploaded !== undefined && uploaded.status === "uploaded" && uploaded.url !== undefined) {
          mapping.set(url, uploaded.url);
          migrated.push({ url, newUrl: uploaded.url });
        } else if (uploaded !== undefined && uploaded.status === "pending") {
          pending.push({ url, hint: uploaded.pending?.hint ?? "" });
        } else {
          failed.push({ url, reason: t("cli.migrate.noUrl", { file: uploaded?.file ?? url }) });
        }
      }

      // —— 3. 写回：存档形态 JSON（有改写才落盘）——
      let rewritten = 0;
      let filesChanged = 0;
      if (mapping.size > 0) {
        for (const save of saveFiles) {
          const result = applyUrlMigration(save.root, mapping);
          if (result.rewritten === 0) {
            continue;
          }
          await writeFile(save.file, JSON.stringify(save.root, null, 2), "utf8");
          rewritten += result.rewritten;
          filesChanged += 1;
        }
      }

      // —— 4. 写回：assets.yaml 的 url 与 objects.csv 的 source ——
      if (mapping.size > 0) {
        const manifest = await readAssetsManifest(root);
        if (manifest !== null) {
          let changed = 0;
          const assets = manifest.assets.map((entry) => {
            const next = mapping.get(entry.url);
            if (next === undefined) {
              return entry;
            }
            changed += 1;
            return { ...entry, url: next };
          });
          if (changed > 0) {
            await writeAssetsManifest(root, { ...manifest, assets });
          }
        }

        const objectsRoot = objectsDir(root);
        try {
          const rows = await readObjectsCsv(objectsRoot);
          let changed = 0;
          for (const row of rows) {
            const next = row.source === undefined ? undefined : mapping.get(row.source);
            if (next !== undefined) {
              row.source = next;
              changed += 1;
            }
          }
          if (changed > 0) {
            await writeObjectsCsv(objectsRoot, rows);
          }
        } catch (err) {
          if (!(err instanceof PackError && err.code === "OBJECTS_NOT_FOUND")) {
            throw err;
          }
        }
      }

      // —— 5. 报告 ——
      for (const item of migrated.slice(0, MAX_ENTRIES_LISTED)) {
        console.log(t("cli.migrate.migrated", { url: item.url, newUrl: item.newUrl }));
      }
      if (migrated.length > MAX_ENTRIES_LISTED) {
        console.log(t("cli.migrate.more", { count: migrated.length - MAX_ENTRIES_LISTED }));
      }
      for (const item of skipped.slice(0, MAX_ENTRIES_LISTED)) {
        console.log(t("cli.migrate.skipped", { url: item.url, reason: item.reason }));
      }
      if (skipped.length > MAX_ENTRIES_LISTED) {
        console.log(t("cli.migrate.more", { count: skipped.length - MAX_ENTRIES_LISTED }));
      }
      for (const item of failed.slice(0, MAX_ENTRIES_LISTED)) {
        console.log(t("cli.migrate.failed", { url: item.url, reason: item.reason }));
      }
      if (failed.length > MAX_ENTRIES_LISTED) {
        console.log(t("cli.migrate.more", { count: failed.length - MAX_ENTRIES_LISTED }));
      }
      for (const item of pending.slice(0, MAX_ENTRIES_LISTED)) {
        console.log(t("cli.migrate.pending", { url: item.url, hint: item.hint }));
      }
      if (pending.length > MAX_ENTRIES_LISTED) {
        console.log(t("cli.migrate.more", { count: pending.length - MAX_ENTRIES_LISTED }));
      }

      console.log(
        t("cli.migrate.summary", {
          migrated: migrated.length,
          skipped: skipped.length,
          failed: failed.length,
          pending: pending.length,
          rewritten,
          files: filesChanged,
        }),
      );
      if (failed.length > 0) {
        process.exitCode = 1;
      }
    } catch (err) {
      process.exit(reportMigrateError(err));
    }
  });
