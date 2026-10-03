// src/cli/commands/assets.ts
/**
 * `tts assets [--check] [--sample N]`：盘点存档内的素材 URL，可联网做存活检测。
 *
 * 流程：
 * 1. 会话内执行 Lua 全量扫描（src/assets/inventory.ts，
 *    坑 2：Lua 字段名 snake_case，不照存档 CamelCase 字段名去找）；
 * 2. 不带 --check → 打印不同 URL 数 / 总引用次数，并按域名分组；
 * 3. 带 --check → 调 checkUrls（src/assets/check.ts，HEAD→GET、并发池、代理），
 *    打印有效 / 失效数量并列出最多 20 条死链。
 */

import { Command } from "commander";

import { checkUrls, type CheckSummary } from "../../assets/check.js";
import { collectInventory, type InventoryResult, type UrlStat } from "../../assets/inventory.js";
import { t } from "../../i18n/index.js";
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
