// src/cli/commands/publish.ts
/**
 * `tts publish`：发布链路第二步——把 BSON 载荷发布到 Steam 创意工坊
 * （窗口 G / 阶段 7，B4 产出）。
 *
 * 三个子模式（`--check` 与 `--manual-guide` 互斥，不能同时给出）：
 * 1. `tts publish --check <id>`：调 fetchPublishedFileDetails（src/publish/metadata.ts，
 *    免 key Steam Web API）打印条目公开元数据——publishedfileid / title / description /
 *    time_updated / subscriptions / file_size（字段名是契约里的机器可读键，按原样输出）；
 * 2. `tts publish --manual-guide [--bson <path>] [--item <id>]`：调 generateManualGuide
 *    （src/publish/manual-guide.ts）生成手动上传手册、复制 BSON 路径到剪贴板并打印；
 * 3. 默认（含 --item）：发布 / 更新条目——**先 probeKpsteam()**（任务书约定）；
 *    - `--auto`：kpsteam 可用 → kpsteamUpload()（子进程调用，红线：绝不主动启动
 *      Steam / TTS）；不可用 → 报 PUBLISH_KPSTEAM_NOT_AVAILABLE 并**回退打印手册**
 *      （退出码 1）；上传成功后再调 checkItemUpdated 轮询验证 time_updated 是否
 *      变化（5 次 × 3 秒，以**上传前**的 time_updated 为基线；基线拉取失败则
 *      跳过验证只作提示）；
 *    - 非 `--auto`（默认）：直接打印手册；kpsteam 可用时附带一行提示
 *      （"可用 --auto 自动上传"）。
 *
 * BSON 路径解析：显式 `--bson` 优先（resolve 成绝对路径）；缺省用
 * `<root>/dist/<净化(pack.yaml name)>.bson`（与 pack build 的 JSON 缺省名同源——
 * readPackYaml 读 name、sanitizeName 净化；pack.yaml 读不到时按 PackError 出口报错，
 * 用户补 --bson 即可绕过）。
 *
 * 模式判定细节（防御式，测试钉住）：
 * - `--check` 与 `--manual-guide` 同时给出 → error.publish.modeConflict，退出 1；
 * - 非 --check / --manual-guide 模式缺 `--item` → error.publish.itemRequired，退出 1；
 * - `--check` 模式下多余的 `--item` 被忽略（--item 不是模式旗标，--manual-guide 也
 *   合法携带它）；`--manual-guide` 模式下多余的 `--auto` 被忽略（手册就是终态）。
 *
 * 输出约定：`--check` 的元数据行是纯数据（字段名不翻译）；其余摘要行走 t()
 * （缺键时 t() 原样输出键名，可接受）。kpsteam 的 stdout / stderr 是第三方工具
 * 原文，失败时原样打到 stderr 供诊断，不翻译。
 *
 * 错误处理：PackError 按 `` `error.${code}` `` 取文案（占位符 {msg}），其余异常走
 * `error.unknown`，两者都以退出码 1 结束（与 src/cli/commands/pack.ts 的
 * reportPackError 同款；命令层模块之间按仓库约定不互相 import，故为本地副本）。
 *
 * 本模块使用的 i18n 键（locales/*.json 由 Stage C 补两套；缺键时 t() 原样输出键名）：
 * - `cli.command.publish.description`（无参）
 * - `cli.command.publish.option.item`（无参）
 * - `cli.command.publish.option.auto`（无参）
 * - `cli.command.publish.option.root`（无参）
 * - `cli.command.publish.option.bson`（无参）
 * - `cli.command.publish.option.manualGuide`（无参）
 * - `cli.command.publish.option.check`（无参）
 * - `cli.publish.check.done`        {itemId}
 * - `cli.publish.kpsteamHint`       {version}
 * - `cli.publish.uploading`         {itemId} {bsonPath}
 * - `cli.publish.kpsteamOutput`（无参）
 * - `cli.publish.uploadOk`（无参）
 * - `cli.publish.verifyUpdated`     {timeUpdated} {attempts}
 * - `cli.publish.verifyNotUpdated`  {attempts}
 * - `cli.publish.verifySkipped`（无参）
 * - `cli.publish.clipboardOk`       {path}
 * - `cli.publish.clipboardFail`     {error}
 * 复用既有键（模块头已声明，Stage C 统一补）：
 * - `error.publish.modeConflict`（无参）——本文件新增错误码
 *   `PUBLISH_MODE_CONFLICT`（--check 与 --manual-guide 互斥）；
 * - `error.publish.itemRequired`（无参）——本文件新增错误码
 *   `PUBLISH_ITEM_REQUIRED`（发布模式缺 --item）；
 * - `error.publish.kpsteamNotAvailable` {reason}、`error.publish.uploadFailed` {code}
 *   （src/publish/kpsteam.ts 声明，错误码 PUBLISH_KPSTEAM_NOT_AVAILABLE /
 *   PUBLISH_UPLOAD_FAILED）；
 * - `error.publish.bsonNotFound` {path}（src/publish/manual-guide.ts 声明，
 *   错误码 PUBLISH_BSON_NOT_FOUND）；
 * - `error.publish.networkError` / `apiStatus` / `apiBody` / `apiResult` /
 *   `itemPrivate` / `detailsEmpty`（src/publish/metadata.ts 声明，错误码
 *   PUBLISH_NETWORK_ERROR / PUBLISH_API_ERROR / PUBLISH_ITEM_PRIVATE）；
 * - `error.unknown` {msg} 与各 PackError 模块已声明的 `error.<code>` 家族
 *   （PACK_NOT_FOUND 等）。
 */

import path from "node:path";

import { Command } from "commander";

import { t } from "../../i18n/index.js";
import { sanitizeName } from "../../pack/layout.js";
import { PackError, readPackYaml } from "../../pack/packyaml.js";
import { kpsteamUpload, probeKpsteam, type KpsteamProbe } from "../../publish/kpsteam.js";
import { generateManualGuide } from "../../publish/manual-guide.js";
import { checkItemUpdated, fetchPublishedFileDetails } from "../../publish/metadata.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 上传成功后验证 time_updated 变化的最大轮询次数（任务书：5 次） */
export const VERIFY_ATTEMPTS = 5;

/** 相邻两次轮询的间隔毫秒数（任务书：每次 3 秒） */
export const VERIFY_INTERVAL_MS = 3_000;

// ---------------------------------------------------------------------------
// 选项类型
// ---------------------------------------------------------------------------

/** `tts publish` 的选项（commander 已按 --kebab-case → camelCase 归一） */
interface PublishOptions {
  /** 工坊条目 ID（发布 / 更新模式必填；--manual-guide 可选；--check 模式忽略） */
  item?: string;
  /** 尝试用 kpsteam 自动上传（默认 false = 手动模式） */
  auto?: boolean;
  /** 图包工作区根目录（缺省 --bson 推导用，默认 "."） */
  root: string;
  /** BSON 载荷路径（缺省 `<root>/dist/<净化(pack.yaml name)>.bson`） */
  bson?: string;
  /** 只生成并打印手动手册（--manual-guide） */
  manualGuide?: boolean;
  /** 查询工坊条目元数据（--check <id>） */
  check?: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * `tts publish` 的统一错误出口（与 pack.ts 的 reportPackError 同款；命令层模块
 * 之间按仓库约定不互相 import，故为本地副本）。
 *
 * @param err 命令 action 中捕获的异常
 * @returns 建议的进程退出码（恒为 1，与 CLI 其他命令一致）
 */
function reportPublishError(err: unknown): number {
  if (err instanceof PackError) {
    console.error(t(`error.${err.code}`, { msg: err.message }));
    return 1;
  }
  console.error(t("error.unknown", { msg: err instanceof Error ? err.message : String(err) }));
  return 1;
}

/** 等待指定毫秒（轮询间隔；测试经 vi.useFakeTimers 控制） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 解析 BSON 载荷路径：显式 `--bson` 优先（resolve 成绝对路径）；缺省用
 * `<root>/dist/<净化(pack.yaml name)>.bson`——name 的取法与 pack build 的
 * JSON 缺省名同源（readPackYaml + sanitizeName，净化函数 import 自
 * src/pack/layout.ts，不复制实现）。
 *
 * @param opts 命令选项（bson / root）
 * @returns BSON 绝对路径
 * @throws PackError pack.yaml 缺失 / 损坏时原样上抛（PACK_NOT_FOUND 等）
 */
async function resolveBsonPath(opts: PublishOptions): Promise<string> {
  if (opts.bson !== undefined && opts.bson.trim() !== "") {
    return path.resolve(opts.bson);
  }
  const pack = await readPackYaml(opts.root);
  return path.join(path.resolve(opts.root), "dist", `${sanitizeName(pack.name)}.bson`);
}

/**
 * 生成并打印手动上传手册（manual-guide 模式与各回退路径共用的收尾）。
 *
 * generateManualGuide 内部会校验 BSON 文件存在（缺失抛
 * PUBLISH_BSON_NOT_FOUND，交由统一错误出口）并把 bsonPath 复制到剪贴板；
 * 剪贴板失败不阻断（手册照给，附失败原因）。
 *
 * @param bsonPath BSON 绝对路径
 * @param itemId 工坊条目 ID（可选；给定时手册列出目标条目）
 */
async function printGuide(bsonPath: string, itemId: string | undefined): Promise<void> {
  const guide = await generateManualGuide({
    bsonPath,
    ...(itemId !== undefined && itemId !== "" ? { itemId } : {}),
  });
  console.log(guide.text);
  if (guide.clipboardCopied) {
    console.log(t("cli.publish.clipboardOk", { path: bsonPath }));
  } else {
    console.log(t("cli.publish.clipboardFail", { error: guide.clipboardError ?? "" }));
  }
}

/**
 * `--check <id>`：打印条目公开元数据（字段名即 GetPublishedFileDetails 契约键，
 * 纯数据不翻译；描述可能多行，原样输出）。
 *
 * @param checkId 工坊条目 ID
 * @throws PackError 网络层 / API 层错误（PUBLISH_NETWORK_ERROR /
 *                   PUBLISH_API_ERROR / PUBLISH_ITEM_PRIVATE，metadata 模块抛出）
 */
async function runCheck(checkId: string): Promise<void> {
  const details = await fetchPublishedFileDetails({ itemId: checkId });
  console.log(t("cli.publish.check.done", { itemId: checkId }));
  console.log(`publishedfileid: ${details.publishedfileid}`);
  console.log(`title: ${details.title}`);
  console.log(`description: ${details.description}`);
  console.log(`time_updated: ${details.time_updated}`);
  console.log(`subscriptions: ${details.subscriptions}`);
  console.log(`file_size: ${details.file_size}`);
}

/**
 * 上传成功后的变更验证：轮询 checkItemUpdated 至多 {@link VERIFY_ATTEMPTS} 次、
 * 间隔 {@link VERIFY_INTERVAL_MS} 毫秒，直到 time_updated 超过上传前基线。
 *
 * 单次轮询失败（网络抖动等）不终止验证：按"本轮未更新"继续重试，全部失败才
 * 以 updated: false 收场（上传本身已成功，验证只是提醒，不影响退出码）。
 *
 * @param itemId 工坊条目 ID
 * @param baseline 上传前的 time_updated（秒）
 * @returns 是否已更新、当前 time_updated 与实际轮询次数
 */
async function waitForTimeUpdated(
  itemId: string,
  baseline: number,
): Promise<{ updated: boolean; timeUpdated: number; attempts: number }> {
  let lastTimeUpdated = 0;
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    try {
      const res = await checkItemUpdated({ itemId, sinceTimestamp: baseline });
      lastTimeUpdated = res.timeUpdated;
      if (res.updated) {
        return { updated: true, timeUpdated: res.timeUpdated, attempts: attempt };
      }
    } catch {
      // 单次查询失败按"本轮未更新"处理，继续重试（验证是提醒性质，不因查询失败中止）
    }
    if (attempt < VERIFY_ATTEMPTS) {
      await sleep(VERIFY_INTERVAL_MS);
    }
  }
  return { updated: false, timeUpdated: lastTimeUpdated, attempts: VERIFY_ATTEMPTS };
}

/**
 * `--auto` 分支：kpsteam 子进程上传 + 成功后的 time_updated 变化验证。
 *
 * 基线（上传前的 time_updated）尽力而为地取一次；取不到时跳过验证只作提示
 * （没有基线就无从比较，宁可明说也不给假结论）。上传失败时把 kpsteam 的
 * stdout / stderr 原文打到 stderr 供诊断，退出码 1。
 *
 * @param exePath probeKpsteam 探测到的 kpsteam 可执行文件（避免二次探测）
 * @param itemId 工坊条目 ID
 * @param bsonPath BSON 绝对路径
 * @throws PackError 不抛——失败全部经 process.exit(1) 表达（ kpsteam 封装本身
 *                   也不抛错，见 src/publish/kpsteam.ts）
 */
async function autoUpload(exePath: string, itemId: string, bsonPath: string): Promise<void> {
  let baseline: number | undefined;
  try {
    baseline = (await fetchPublishedFileDetails({ itemId })).time_updated;
  } catch {
    baseline = undefined;
  }

  console.log(t("cli.publish.uploading", { itemId, bsonPath }));
  const upload = await kpsteamUpload({ itemId, bsonPath, exePath });
  if (!upload.ok) {
    console.error(t("error.publish.uploadFailed", { code: upload.exitCode }));
    if (upload.stdout !== "" || upload.stderr !== "") {
      console.error(t("cli.publish.kpsteamOutput"));
      if (upload.stdout !== "") {
        console.error(upload.stdout.trimEnd());
      }
      if (upload.stderr !== "") {
        console.error(upload.stderr.trimEnd());
      }
    }
    process.exit(1);
  }
  console.log(t("cli.publish.uploadOk"));

  if (baseline === undefined) {
    console.log(t("cli.publish.verifySkipped"));
    return;
  }
  const verdict = await waitForTimeUpdated(itemId, baseline);
  if (verdict.updated) {
    console.log(t("cli.publish.verifyUpdated", { timeUpdated: verdict.timeUpdated, attempts: verdict.attempts }));
  } else {
    console.log(t("cli.publish.verifyNotUpdated", { attempts: verdict.attempts }));
  }
}

// ---------------------------------------------------------------------------
// 主命令
// ---------------------------------------------------------------------------

/** `tts publish` 主命令：--check / --manual-guide / 默认发布三模式（薄调用层） */
export const publishCommand: Command = new Command("publish")
  .description(t("cli.command.publish.description"))
  .option("--item <id>", t("cli.command.publish.option.item"))
  .option("--auto", t("cli.command.publish.option.auto"), false)
  .option("--root <dir>", t("cli.command.publish.option.root"), ".")
  .option("--bson <path>", t("cli.command.publish.option.bson"))
  .option("--manual-guide", t("cli.command.publish.option.manualGuide"), false)
  .option("--check <id>", t("cli.command.publish.option.check"))
  .action(async (opts: PublishOptions) => {
    try {
      const checkId = opts.check?.trim();
      const guideMode = opts.manualGuide === true;

      // —— 模式互斥：--check 与 --manual-guide 不能同时给出 ——
      if (checkId !== undefined && checkId !== "" && guideMode) {
        console.error(t("error.publish.modeConflict"));
        process.exit(1);
      }

      // —— 模式 1：--check <id>（多余的 --item / --auto 忽略）——
      if (checkId !== undefined && checkId !== "") {
        await runCheck(checkId);
        return;
      }

      const itemId = opts.item?.trim();

      // —— 模式 2：--manual-guide（--auto 无意义，忽略）——
      if (guideMode) {
        await printGuide(await resolveBsonPath(opts), itemId);
        return;
      }

      // —— 模式 3：默认发布 / 更新（必须给 --item）——
      if (itemId === undefined || itemId === "") {
        console.error(t("error.publish.itemRequired"));
        process.exit(1);
      }
      const bsonPath = await resolveBsonPath(opts);

      // 任务书约定：默认（含 --item）模式先探测 kpsteam
      const probe: KpsteamProbe = await probeKpsteam();
      if (opts.auto === true) {
        if (!probe.available || probe.exePath === undefined) {
          // 不可用：报错 + 回退打印手册（上传永远不能自动打开游戏 / Steam）
          console.error(t("error.publish.kpsteamNotAvailable", { reason: probe.reason ?? "NOT_FOUND" }));
          await printGuide(bsonPath, itemId);
          process.exit(1);
          return;
        }
        await autoUpload(probe.exePath, itemId, bsonPath);
        return;
      }

      // 非 --auto（默认）：直接打印手册；kpsteam 可用时附带一行提示
      if (probe.available) {
        console.log(t("cli.publish.kpsteamHint", { version: probe.version ?? "" }));
      }
      await printGuide(bsonPath, itemId);
    } catch (err) {
      process.exit(reportPublishError(err));
    }
  });

export default publishCommand;
