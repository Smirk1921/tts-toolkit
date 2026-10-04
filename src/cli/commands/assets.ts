// src/cli/commands/assets.ts
/**
 * `tts assets [--check] [--sample N]`：盘点存档内的素材 URL，可联网做存活检测。
 * `tts assets upload [--pack <路径>] [--host <id>]`：把工作区里改动的素材
 * 上传到图床并回写台账（阶段 3，窗口 C 新增）。
 *
 * 盘点流程：
 * 1. 会话内执行 Lua 全量扫描（src/assets/inventory.ts，
 *    坑 2：Lua 字段名 snake_case，不照存档 CamelCase 字段名去找）；
 * 2. 不带 --check → 打印不同 URL 数 / 总引用次数，并按域名分组；
 * 3. 带 --check → 调 checkUrls（src/assets/check.ts，HEAD→GET、并发池、代理），
 *    打印有效 / 失效数量并列出最多 20 条死链。
 *
 * 上传流程（`assets upload`，不连游戏；复用 src/host/ + src/pack/manifest.ts +
 * src/deck/objects.ts，命令层只做编排）：
 * 1. 读 pack.yaml 选图床（`--host` 覆盖 pack.yaml 的 host；自定义图床用配置里
 *    声明的 id），gitee/imgur 之类非注册图床名报 HOST_NOT_FOUND 并提示 --host；
 * 2. 扫 `decks/`、`objects/` 下的素材文件（扩展名白名单），逐个算 sha256，
 *    与 assets.yaml 台账比对：**只上传新增或内容变化的文件**（台账无 sha256
 *    的旧条目视为变化，宁可多传不静默漏传）；
 * 3. 逐个调 `host.upload`；对象名 = `pack.yaml.upload.prefix` + 工作区相对路径，
 *    Steam Cloud 的 pending 结果（需人工上传）不是失败，按 pending 报告；
 * 4. 成功上传的回写 assets.yaml（url / sha256 / host）与 objects.csv 的
 *    `source` 列（file 命中上传清单的行）；**首次推送**（`.tts/lfs-cost-warning-shown`
 *    不存在且 pack.yaml 的 vcs.lfs=enabled）打印一次 lfs 远端额度成本提示并落标记
 *    （方案设计 §4.11.2；提示一次，不重复打扰）。
 *
 * 上传的退出码：全部成功 / 无需上传 → 0；有失败 → 1（脚本可按退出码判断）。
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像；缺键时 t() 原样输出键名）：
 * - 盘点侧：`cli.command.assets.*`、`cli.assets.*`（既有）；
 * - 上传侧：`cli.command.assets.upload.description` / `option.pack` / `option.host`、
 *   `cli.assets.upload.hostSelected` {host} {declared}、`cli.assets.upload.hostNotResolvable`
 *   {host}、`cli.assets.upload.scan` {count}、`cli.assets.upload.nothing`、
 *   `cli.assets.upload.uploaded` {file} {url}、`cli.assets.upload.pending` {file} {hint}、
 *   `cli.assets.upload.failed` {file} {reason}、`cli.assets.upload.more` {count}、
 *   `cli.assets.upload.done` {uploaded} {skipped} {pending} {failed}、`cli.assets.upload.ledger`
 *   {path}、`cli.assets.upload.costWarning` {estimate}、`error.unknown` {msg}；
 * - 动态（键 = `error.` + PackError.code，占位符 {msg}）：PACK_NOT_FOUND /
 *   PACK_INVALID / HOST_* / ASSETS_* / OBJECTS_*（各模块错误码透传）。
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { checkUrls, type CheckSummary } from "../../assets/check.js";
import { collectInventory, type InventoryResult, type UrlStat } from "../../assets/inventory.js";
import { readObjectsCsv, writeObjectsCsv } from "../../deck/objects.js";
import { resolveHost } from "../../host/command.js";
import { t } from "../../i18n/index.js";
import { decksDir, objectsDir } from "../../pack/layout.js";
import { readAssetsManifest, writeAssetsManifest } from "../../pack/manifest.js";
import { PackError, readPackYaml } from "../../pack/packyaml.js";
import { analyzeSize } from "../../vcs/size.js";
import { reportError, withEditorServer } from "../with-server.js";

/** 死链列表最多展示条数 */
const MAX_DEAD_LISTED = 20;

/** assets 命令选项 */
interface AssetsOptions {
  /** 是否联网检查存活 */
  check?: boolean;
  /** 抽样数量（字符串形式，来自命令行） */
  sample?: string;
}

/** 按域名聚合后的统计 */
interface DomainGroup {
  /** 域名（无法解析时为 domainUnknown 文案） */
  domain: string;
  /** 该域名下不同 URL 数 */
  urls: number;
  /** 该域名下总引用次数 */
  refs: number;
}

/**
 * 取 URL 的域名（hostname）。
 * @param url 素材 URL
 * @returns 域名；URL 非法或没有 hostname 时返回 domainUnknown 文案
 */
function domainOf(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host === "" ? t("cli.assets.domainUnknown") : host;
  } catch {
    return t("cli.assets.domainUnknown");
  }
}

/**
 * 按域名聚合引用统计（域名升序，保证输出可复现）。
 * @param stats 单 URL 统计列表
 * @returns 域名分组列表
 */
function groupByDomain(stats: readonly UrlStat[]): DomainGroup[] {
  const groups = new Map<string, DomainGroup>();
  for (const stat of stats) {
    const domain = domainOf(stat.url);
    let group = groups.get(domain);
    if (group === undefined) {
      group = { domain, urls: 0, refs: 0 };
      groups.set(domain, group);
    }
    group.urls += 1;
    group.refs += stat.count;
  }
  return [...groups.values()].sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
}

/**
 * 校验 --sample 选项：必须为 ≥ 1 的整数。
 * @param raw 命令行原始值（可能为 undefined）
 * @returns 解析后的抽样数量；未提供时 undefined
 */
function parseSample(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(t("cli.assets.invalidSample", { value: raw }));
    process.exit(1);
  }
  return value;
}

/**
 * 打印盘点结果（不联网）。
 * @param inventory collectInventory 的结果
 */
function printInventory(inventory: InventoryResult): void {
  console.log(
    t("cli.assets.inventory", { urls: inventory.distinctUrls, refs: inventory.totalRefs }),
  );
  if (inventory.stats.length === 0) {
    console.log(t("cli.assets.empty"));
    return;
  }
  console.log(t("cli.assets.byDomain"));
  for (const group of groupByDomain(inventory.stats)) {
    console.log(
      t("cli.assets.domain", { domain: group.domain, urls: group.urls, refs: group.refs }),
    );
  }
}

/**
 * 打印联网检测结果：有效 / 失效数量 + 最多 {@link MAX_DEAD_LISTED} 条死链。
 * 单独导出便于单元测试直接校验文案与截断行为（CLI 在 runCheck 中调用）。
 *
 * @param summary checkUrls 的汇总结果
 */
export function printCheckSummary(summary: CheckSummary): void {
  console.log(t("cli.assets.aliveCount", { count: summary.alive }));
  console.log(t("cli.assets.deadCount", { count: summary.dead }));

  if (summary.deadUrls.length === 0) {
    return;
  }
  const shown = summary.deadUrls.slice(0, MAX_DEAD_LISTED);
  console.log(t("cli.assets.deadList", { shown: shown.length }));
  for (const dead of shown) {
    console.log(t("cli.assets.dead", { url: dead.url }));
    const detail = dead.error ?? (dead.status !== 0 ? `HTTP ${dead.status}` : "");
    if (detail !== "") {
      console.log(t("cli.assets.deadDetail", { detail }));
    }
  }
  if (summary.deadUrls.length > shown.length) {
    console.log(t("cli.assets.deadMore", { count: summary.deadUrls.length - shown.length }));
  }
}

/**
 * 联网检查 URL 存活并打印结果。
 * @param stats 单 URL 统计列表（取其 url 作为检测目标）
 * @param sample 抽样数量；undefined 表示全量检测
 */
async function runCheck(stats: readonly UrlStat[], sample: number | undefined): Promise<void> {
  const urls = stats.map((stat) => stat.url);
  const total = urls.length;
  const sampled = sample !== undefined && sample < total ? sample : undefined;
  console.log(
    sampled === undefined
      ? t("cli.assets.checking")
      : t("cli.assets.checkingDetail", { total, sampled }),
  );

  const summary = await checkUrls(urls, sampled === undefined ? {} : { sample: sampled });
  printCheckSummary(summary);
}

// ---------------------------------------------------------------------------
// 子命令：upload（工作区素材 → 图床，阶段 3 / 窗口 C）
// ---------------------------------------------------------------------------

/** 上传白名单：只传素材（位图 / 模型 / 资源包 / PDF / 音频），台账与元数据不传 */
const UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tga", ".tif", ".tiff", ".avif",
  ".obj", ".unity3d", ".pdf",
  ".mp3", ".ogg", ".wav", ".mp4",
]);

/** 上传报告每类最多展示条数 */
const MAX_UPLOAD_LINES = 50;

/** `tts assets upload` 的选项 */
interface AssetsUploadOptions {
  /** 图包工作区根目录（默认 "."） */
  pack: string;
  /** 图床 id 覆盖（缺省用 pack.yaml 的 host 字段） */
  host?: string;
}

/** 字节数换算单位（与 src/cli/commands/vcs.ts / pack.ts 的同名常量一致；本文件为副本） */
const BYTE_UNITS: ReadonlyArray<{ limit: number; suffix: string }> = [
  { limit: 1024 ** 4, suffix: "TB" },
  { limit: 1024 ** 3, suffix: "GB" },
  { limit: 1024 ** 2, suffix: "MB" },
  { limit: 1024, suffix: "KB" },
];

/**
 * 把字节数格式化成人可读文本（lfs 成本提示里的估算值用）。
 * @param bytes 字节数（非负整数）
 * @returns 如 "512 B" / "1.50 MB"
 */
function formatBytes(bytes: number): string {
  for (const unit of BYTE_UNITS) {
    if (bytes >= unit.limit) {
      return `${(bytes / unit.limit).toFixed(2)} ${unit.suffix}`;
    }
  }
  return `${bytes} B`;
}

/**
 * upload 子命令的错误出口（与 pack.ts 的 reportPackError 同一份实现）。
 * @param err 命令 action 中捕获的异常
 * @returns 建议的进程退出码（恒为 1）
 */
function reportUploadError(err: unknown): number {
  if (err instanceof PackError) {
    console.error(t(`error.${err.code}`, { msg: err.message }));
    return 1;
  }
  console.error(t("error.unknown", { msg: err instanceof Error ? err.message : String(err) }));
  return 1;
}

/**
 * 递归收集目录下的素材文件（白名单扩展名；目录不存在时静默为空——
 * 工作区可以只有 decks 没有 objects）。
 * @param dir 起点目录
 * @param out 收集器（原地追加绝对路径）
 */
async function walkAssetFiles(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkAssetFiles(abs, out);
    } else if (entry.isFile() && UPLOAD_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(abs);
    }
  }
}

/** 工作区相对路径统一成 POSIX 形式（assets.yaml / objects.csv 的契约写法） */
function relativePosix(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** assets.yaml 的 host 字段是受限枚举；自定义 / s3 / command 图床写 "custom" */
function ledgerHostField(hostId: string): "steamcloud" | "imgur" | "gdrive" | "dropbox" | "custom" {
  return hostId === "imgur" || hostId === "gdrive" || hostId === "dropbox" ? hostId : hostId === "steamcloud" ? "steamcloud" : "custom";
}

/**
 * 首次推送的 lfs 成本提示（方案设计 §4.11.2）：pack.yaml 的 vcs.lfs=enabled
 * 且 `<root>/.tts/lfs-cost-warning-shown` 不存在时打印一次，并落标记文件
 * （内容为 ISO 时间戳，机器可读）。提示失败（目录不可写）不影响上传。
 *
 * @param root 图包工作区根目录
 * @param lfsEnabled pack.yaml 的 vcs.lfs 是否 enabled
 */
async function maybeShowLfsCostWarning(root: string, lfsEnabled: boolean): Promise<void> {
  if (!lfsEnabled) {
    return;
  }
  const marker = path.join(root, ".tts", "lfs-cost-warning-shown");
  try {
    await stat(marker);
    return; // 已提示过：不重复打扰
  } catch {
    // 标记不存在（或不可读）：按首次推送处理
  }

  let estimate = "-";
  try {
    estimate = formatBytes((await analyzeSize(root)).lfsObjectsBytes);
  } catch {
    // 体积统计失败不影响上传：提示里估算值显示 "-"
  }
  console.log(t("cli.assets.upload.costWarning", { estimate }));
  try {
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, `${new Date().toISOString()}\n`, "utf8");
  } catch {
    // 标记落盘失败最多导致下次再提示一次；绝不因它中断上传
  }
}

/**
 * `tts assets upload [--pack <路径>] [--host <id>]`：把工作区里改动的素材传到图床。
 *
 * 图床：`--host` 覆盖 pack.yaml 的 host 字段；`pack.yaml.host` 里的
 * imgur/gdrive/dropbox 不是本工具注册的 ImageHost id，会命中 HOST_NOT_FOUND
 * ——此时明确提示改用 `--host` 指定配置声明的图床（绝不静默回退默认图床）。
 *
 * 改动检测：assets.yaml 台账按 `file` 记 url / sha256；sha256 与当前文件一致的
 * 跳过，其余（新文件 / 内容变化 / 台账无 sha256）上传。上传成功后回写台账
 * 与 objects.csv 的 source 列；Steam Cloud 的 pending 结果按"待人工上传"报告。
 */
const uploadSub = new Command("upload")
  .description(t("cli.command.assets.upload.description"))
  .option("--pack <dir>", t("cli.command.assets.upload.option.pack"), ".")
  .option("--host <id>", t("cli.command.assets.upload.option.host"))
  .action(async (opts: AssetsUploadOptions) => {
    try {
      const root = path.resolve(opts.pack);
      const pack = await readPackYaml(root);

      const declared = opts.host ?? pack.host;
      let host;
      try {
        host = await resolveHost(declared);
      } catch (err) {
        if (err instanceof PackError && err.code === "HOST_NOT_FOUND") {
          console.error(t("cli.assets.upload.hostNotResolvable", { host: declared }));
          process.exit(1);
        }
        throw err;
      }
      console.log(t("cli.assets.upload.hostSelected", { host: host.id, declared: pack.host }));

      await maybeShowLfsCostWarning(root, pack.vcs.lfs === "enabled");

      // —— 1. 候选文件 + sha256 比对台账 ——
      const files: string[] = [];
      await walkAssetFiles(decksDir(root), files);
      await walkAssetFiles(objectsDir(root), files);
      const manifest = await readAssetsManifest(root);
      const ledger = new Map<string, { url: string; sha256?: string }>();
      for (const entry of manifest?.assets ?? []) {
        ledger.set(entry.file.replace(/\\/g, "/"), entry);
      }
      const prefix =
        pack.upload.prefix === ""
          ? ""
          : pack.upload.prefix.endsWith("/")
            ? pack.upload.prefix
            : `${pack.upload.prefix}/`;

      // —— 2. 逐文件上传（单文件失败不中断整批）——
      const uploaded: Array<{ file: string; url: string; sha256: string }> = [];
      const pending: Array<{ file: string; hint: string }> = [];
      const failed: Array<{ file: string; reason: string }> = [];
      let skipped = 0;
      let candidates = 0;
      for (const abs of files) {
        const rel = relativePosix(root, abs);
        let data: Buffer;
        try {
          data = await readFile(abs);
        } catch (err) {
          failed.push({ file: rel, reason: err instanceof Error ? err.message : String(err) });
          continue;
        }
        const sha256 = createHash("sha256").update(data).digest("hex");
        const known = ledger.get(rel);
        if (known !== undefined && known.sha256 === sha256) {
          skipped += 1;
          continue;
        }
        candidates += 1;
        let result;
        try {
          // stagingDir 固定在工作区 .tts/ 下（steamcloud 的待上传暂存；其他图床忽略该选项），
          // 不给它就会落到 process.cwd()（换了目录跑命令会撒两个暂存点）
          result = (
            await host.upload([{ name: `${prefix}${rel}`, data }], {
              stagingDir: path.join(root, ".tts", "steamcloud-pending"),
            })
          )[0];
        } catch (err) {
          failed.push({ file: rel, reason: err instanceof Error ? err.message : String(err) });
          continue;
        }
        if (result !== undefined && result.status === "uploaded" && result.url !== undefined) {
          uploaded.push({ file: rel, url: result.url, sha256 });
        } else if (result !== undefined && result.status === "pending") {
          pending.push({ file: rel, hint: result.pending?.hint ?? "" });
        } else {
          failed.push({ file: rel, reason: t("cli.assets.upload.noUrl", { file: result?.file ?? rel }) });
        }
      }
      console.log(t("cli.assets.upload.scan", { candidates, skipped }));

      // —— 3. 回写台账（assets.yaml）与 objects.csv 的 source ——
      if (uploaded.length > 0) {
        const byFile = new Map(uploaded.map((item) => [item.file, item]));
        const hostField = ledgerHostField(host.id);
        const next = (manifest?.assets ?? []).map((entry) => {
          const item = byFile.get(entry.file.replace(/\\/g, "/"));
          if (item === undefined) {
            return entry;
          }
          byFile.delete(item.file);
          return { file: entry.file, url: item.url, sha256: item.sha256, host: hostField };
        });
        for (const item of uploaded) {
          if (byFile.has(item.file)) {
            next.push({ file: item.file, url: item.url, sha256: item.sha256, host: hostField });
          }
        }
        await writeAssetsManifest(root, { schema_version: 1, assets: next });
        console.log(t("cli.assets.upload.ledger", { path: path.join(root, "assets.yaml") }));

        try {
          const rows = await readObjectsCsv(objectsDir(root));
          let changed = 0;
          const urlByFile = new Map(uploaded.map((item) => [item.file, item.url]));
          for (const row of rows) {
            const url = row.file === undefined ? undefined : urlByFile.get(row.file.replace(/\\/g, "/"));
            if (url !== undefined) {
              row.source = url;
              changed += 1;
            }
          }
          if (changed > 0) {
            await writeObjectsCsv(objectsDir(root), rows);
          }
        } catch (err) {
          if (!(err instanceof PackError && err.code === "OBJECTS_NOT_FOUND")) {
            throw err;
          }
        }
      }

      // —— 4. 报告 ——
      for (const item of uploaded.slice(0, MAX_UPLOAD_LINES)) {
        console.log(t("cli.assets.upload.uploaded", { file: item.file, url: item.url }));
      }
      if (uploaded.length > MAX_UPLOAD_LINES) {
        console.log(t("cli.assets.upload.more", { count: uploaded.length - MAX_UPLOAD_LINES }));
      }
      for (const item of pending.slice(0, MAX_UPLOAD_LINES)) {
        console.log(t("cli.assets.upload.pending", { file: item.file, hint: item.hint }));
      }
      for (const item of failed.slice(0, MAX_UPLOAD_LINES)) {
        console.log(t("cli.assets.upload.failed", { file: item.file, reason: item.reason }));
      }
      console.log(
        t("cli.assets.upload.done", {
          uploaded: uploaded.length,
          skipped,
          pending: pending.length,
          failed: failed.length,
        }),
      );
      if (failed.length > 0) {
        process.exitCode = 1;
      }
    } catch (err) {
      process.exit(reportUploadError(err));
    }
  });

export const assetsCommand = new Command("assets")
  .description(t("cli.command.assets.description"))
  .option("--check", t("cli.command.assets.option.check"))
  .option("--sample <n>", t("cli.command.assets.option.sample"))
  .action(async (opts: AssetsOptions) => {
    const sample = parseSample(opts.sample);
    try {
      await withEditorServer(async ({ exec }) => {
        const inventory = await collectInventory(exec);
        if (opts.check !== true) {
          printInventory(inventory);
          return;
        }
        await runCheck(inventory.stats, sample);
      });
    } catch (err) {
      process.exit(reportError(err, "cli.assets.notConnected"));
    }
  });

// 上传子命令：主命令既有盘点 action 保持不变（`tts assets` / `--check` 照旧）；
// 挂上 upload 后 `tts assets upload` 只跑子命令（commander 的分发语义）。
assetsCommand.addCommand(uploadSub);
