// src/cli/commands/pack.ts
/**
 * `tts pack`：图包工作区管理（阶段 2A）——把 6 个 pack 模块接到 CLI 上。
 *
 * 子命令一览（本文件是薄调用层，业务逻辑一律在 src/pack/ 内）：
 * - `tts pack init <dir>`    新建工作区（initPack）
 * - `tts pack unpack <save>` 从存档 JSON / .ttsmod 离线建工作区（unpackSave）
 * - `tts pack pull`          从运行中的 TTS 拉脚本 / UI（pullFromGame，只读）
 * - `tts pack push`          安全写回运行中的 TTS（pushSaveAndPlay，阶段 5 写入路径：
 *                            默认 dry-run、--yes 实写；push 前自动备份 + 基线冲突
 *                            检测 + 素材改动拦截；hub 在线时委托 hub 执行）
 * - `tts pack diff`          工作区 ↔ 游戏差异（diffWorkspace，只读；--unified 时
 *                            modified 条目附逐行 unified hunks）
 * - `tts pack build`         合成 TTS 可加载的存档 JSON（buildSave，含 --dry-run）
 * - `tts pack list`          列出 .registry.yaml 里注册的全部图包（readRegistry）
 * - `tts pack status <dir>`  单个注册图包的详细信息（findPack）
 * - `tts pack open <dir>`    用系统文件管理器打开图包目录（findPack + explorer）
 * - `tts pack export <图包> -o <文件.ttsmod>`  工作区 → 自包含 .ttsmod（exportTtsmod）
 * - `tts pack import <文件.ttsmod> [--into <Mods父目录>]`  解压 .ttsmod 到 Mods
 *   父目录（importTtsmod；与既有 `pack unpack` 的区别：unpack 建工作区，import
 *   直接往游戏数据目录铺文件，已存在文件不覆盖）
 * - `tts pack import <工坊ID> --as-upstream`  把上游快照落到 upstream 分支
 *   （importAsUpstream；**同一 import 子命令按参数形态分流**：位置参数是
 *   .ttsmod 文件 → archive，是工坊 ID 且带 --as-upstream → upstream）
 * - `tts pack sync-upstream [--pack <路径>]`  拉上游新快照并合并回当前分支
 *   （syncUpstream；冲突只报告不选边）
 *
 * 边界（重要，不要越界）：
 * - 本文件**不直接 import src/session/ 或 src/protocol/**：需要 TTS 会话的子命令由
 *   pack 模块内部经 src/cli/with-server.ts 完成（端口占用 / 未连接 / 超时等异常
 *   由各模块原样上抛，此处统一按错误码出口呈现）；
 * - 约束 7：push（messageID 1）只接收脚本 / UI，不接收素材字段。本文件不为 push
 *   提供任何素材相关选项，也不读 / 改素材 URL；素材改动只能走 `pack build` 的
 *   离线回路（约束 8）。push 流水线的安全闸（备份 / 基线 / 素材检测 / 强制带 ui）
 *   全部在 src/pack/push.ts 的 pushSaveAndPlay 内实现，命令层只负责旗标与确认；
 * - `pack push` 的双路（阶段 5）：hub 在线（tryHubClient 命中）→ 委托 hub 控制通道
 *   /v1/push（hub 进程持有编辑器端口，绝不在 CLI 进程再绑 39998；委托失败报错退
 *   出 1，不回退独立模式）；hub 离线 → 独立模式直接调 pushSaveAndPlay。默认
 *   dry-run（只报告将推送多少、不写游戏），--yes 才实写（备份照做）；交互确认门
 *   confirmPush 作为防御性二次闸注入（当前旗标决策下实写必带 --yes，该门不会
 *   触发询问，保留为将来旗标语义变化的兜底）；
 * - 错误处理：PackError 按 `` `error.${code}` `` 取文案（占位符 {msg}），其余异常
 *   统一走 `error.unknown`，两者都以退出码 1 结束。与 src/cli/with-server.ts 的
 *   reportError 分工不同：pack 模块抛的是带机器可读 code 的 PackError，
 *   不需要按 message 文本猜分类。
 * - list / status / open 三个子命令属于阶段 2C 的多图包索引层：只读 .registry.yaml
 *   （src/pack/registry.ts），不改任何条目；`pack open` 在 Windows 上调 explorer
 *   打开目录（非 Windows 只打印绝对路径）。
 *
 * 输出约定：每个子命令只在成功时向 stdout 打一行中文摘要（经 t()）；push / diff 的
 * 清单行是纯数据（guid / 名字 / 路径），不承载文案，故不翻译。list / status 的表格行
 * 同理：字段名（dir / kind / stats / upstream.* 等）是契约里的机器可读键，按原样输出，
 * 只把 notFound / empty / done 这类界面文案走 t()。
 *
 * 本模块使用的 i18n 键（locales/*.json 由本地化步骤补齐；缺键时 t() 原样输出键名）：
 * - 静态：`cli.command.pack.*`（已存在）、`cli.pack.init.done` {dir}、
 *   `cli.pack.unpack.done` {save} {outDir} {scripts} {ui} {objects}、
 *   `cli.pack.pull.done` {scripts} {ui} {skipped}、`cli.pack.push.note`、
 *   `cli.pack.diff.summary` {added} {modified} {deleted}、`cli.pack.build.done`
 *   {outPath} {scripts} {ui} {objects}、`cli.pack.build.dryRunNote`；
 * - 阶段 5 push / diff 新增：`cli.command.pack.push.option.dryRun`、
 *   `cli.command.pack.push.option.yes`、`cli.command.pack.push.option.forceScriptsOnly`、
 *   `cli.command.pack.push.option.noBackup`、`cli.command.pack.push.option.noBaselineCheck`、
 *   `cli.command.pack.push.option.backupRetention`、`cli.command.pack.diff.option.unified`、
 *   `cli.pack.push.viaHub`、`cli.pack.push.dryRunSummary` {pushed} {skipped}、
 *   `cli.pack.push.pushedSummary` {pushed} {skipped} {backupDir}、
 *   `cli.pack.push.confirmMessage` {count}、`error.cli.invalidBackupRetention`；
 *   `cli.pack.list.empty`、`cli.pack.list.header` {count}、
 *   `cli.pack.status.notFound` {dir}、`cli.pack.open.notFound` {dir}、
 *   `cli.pack.open.done` {path}、`cli.pack.export.*`（done / readme / skipped /
 *   warning / invalidReadme / noDatadirNote）、`cli.pack.importFile.*`（done /
 *   skippedExisting / skippedExistingItem / skippedUnsafe / workshopSaves /
 *   workshopSaveItem / unpackHint / warning / needTarget / numericTarget）、
 *   `cli.pack.upstream.*`（imported / importedNoChange / synced / syncedNoChange /
 *   merged / mergeSkipped / conflictsHeader / conflictHint / needWorkshopId）、
 *   `error.unknown` {msg}、`error.archive.*` 等；
 * - 动态（键 = `error.` + PackError.code，占位符 {msg}）：PACK_NOT_FOUND /
 *   PACK_INVALID / PACK_READ_FAILED / PACK_EXISTS / GIT_INIT_FAILED /
 *   GIT_LFS_INSTALL_FAILED / TTSMOD_INVALID / TTSMOD_EXPORT_FAILED /
 *   TTSMOD_STRICT_MISSING / SAVE_INVALID / UNPACK_FAILED / PULL_FAILED /
 *   PUSH_FAILED / DIFF_FAILED / SKELETON_MISSING / SKELETON_INVALID /
 *   PACK_WRITE_FAILED / BUILD_FAILED / REGISTRY_INVALID / REGISTRY_READ_FAILED /
 *   REGISTRY_CONFLICT / UPSTREAM_* 等（各模块错误码的完整取值见其模块头注释）。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";
import { execa } from "execa";

import {
  ARCHIVE_ENTRY_DIRS,
  exportTtsmod,
  importTtsmod,
  ttsmodFileName,
  type TtsmodAssetInput,
} from "../../archive/ttsmod.js";
import type { AssetKind } from "../../archive/detect.js";
import { locateDatadir } from "../../datadir/locate.js";
import { walkSaveUrls } from "../../deck/patch.js";
import { t } from "../../i18n/index.js";
import { buildSave } from "../../pack/build.js";
import { diffWorkspace, type DiffHunk } from "../../pack/diff.js";
import { initPack } from "../../pack/init.js";
import { PackError, readPackYaml } from "../../pack/packyaml.js";
import { pullFromGame } from "../../pack/pull.js";
import { collectPushItems, pushSaveAndPlay, type PushItem } from "../../pack/push.js";
import { findPack, readRegistry, type PackEntry } from "../../pack/registry.js";
import { unpackSave } from "../../pack/unpack.js";
import { importAsUpstream, syncUpstream } from "../../pack/upstream.js";
import { confirmPush } from "../../safety/confirm.js";
import { formatConflict } from "../../vcs/conflicts.js";
import { statusPorcelain } from "../../vcs/git.js";
import { tryHubClient } from "../_shared.js";
import { describeError } from "../with-server.js";

// ---------------------------------------------------------------------------
// 选项类型
// ---------------------------------------------------------------------------

/** `tts pack init` 的选项（commander 已按 --kebab-case → camelCase 归一） */
interface PackInitOptions {
  /** 图包名（缺省取目录名，由 initPack 决定） */
  name?: string;
  /** 显式 lfs 决策；只接受 "enabled" / "disabled" */
  lfs?: string;
  /** 跳过 git init */
  skipGit?: boolean;
}

/** `tts pack unpack` 的选项 */
interface PackUnpackOptions {
  /** 输出目录；缺省 `./packs/<name || "unnamed">` */
  out?: string;
  /** 图包名（缺省取存档 SaveName） */
  name?: string;
}

/** 只带 --root 的子命令（pull / push / diff）的选项 */
interface PackRootOptions {
  /** 工作区根目录（默认 "."，由 commander 的默认值填入） */
  root: string;
}

/** `tts pack push` 的选项（阶段 5 写入路径；backupRetention 由 commander 保留为字符串） */
interface PackPushOptions extends PackRootOptions {
  /**
   * 试运行旗标（--dry-run，默认 true）。注意：**实际决策只用 {@link yes}**——
   * dryRun = !yes（--yes 是唯一的实写入口），本旗标仅用于 --help 展示缺省行为。
   */
  dryRun: boolean;
  /** 实写确认（--yes）：唯一把 dryRun 置 false 的入口 */
  yes: boolean;
  /** 素材有改动时仍强制只推脚本（--force-scripts-only，用户自担风险） */
  forceScriptsOnly: boolean;
  /** push 前自动备份（--no-backup 关闭；commander 布尔取反，默认 true） */
  backup: boolean;
  /** 基线冲突检测（--no-baseline-check 跳过；commander 布尔取反，默认 true） */
  baselineCheck: boolean;
  /** 备份保留份数（--backup-retention，1-100；commander 原始字符串，本命令解析） */
  backupRetention: string;
}

/** `tts pack diff` 的选项（--unified 时 modified 条目附逐行 hunks） */
interface PackDiffOptions extends PackRootOptions {
  /** 输出逐行 unified diff hunks（-u / --unified，默认 false） */
  unified: boolean;
}

/** `tts pack build` 的选项 */
interface PackBuildOptions extends PackRootOptions {
  /** 只统计与生成摘要，不写文件 */
  dryRun?: boolean;
  /** 输出 JSON 路径（缺省 `<root>/dist/<净化(pack.yaml name)>.json`） */
  out?: string;
}

/** `tts pack list` 的选项 */
interface PackListOptions extends PackRootOptions {
  /** 只显示有未提交改动的图包（无法判定 git 状态的条目视为不脏，不显示） */
  dirty: boolean;
}

/** `tts pack export` 的选项（--datadir 由全局选项经 optsWithGlobals 取，不在此声明） */
interface PackExportOptions {
  /** 输出 .ttsmod 路径（缺省 `<图包名> (<工坊ID>).ttsmod`，写当前目录） */
  out?: string;
  /** strict 模式：缺任一素材即报错，不产出不完整的包 */
  strict?: boolean;
  /** 随包说明语言："zh" / "en" / "both"（默认）/ "none" */
  readme?: string;
}

/**
 * `tts pack import` 的选项（两种形态共用一份）：
 * - `<文件.ttsmod>` → importTtsmod（--into / --saves）；
 * - `<工坊ID> --as-upstream` → importAsUpstream（--pack / --snapshot / --packs-root）。
 */
interface PackImportOptions {
  /** 走上游分支导入形态（位置参数解释为工坊 ID） */
  asUpstream?: boolean;
  /** .ttsmod 形态：Mods 目录的**父目录**（解压目标，默认 "."） */
  into: string;
  /** .ttsmod 形态：ModSaveLocation（非 Mods/ 条目——如 Saves/——的解压目标；缺省 <into>/Saves） */
  saves?: string;
  /** upstream 形态：图包工作区根目录（默认 "."） */
  pack: string;
  /** upstream 形态：显式快照文件（存档 JSON / .ttsmod；优于按工坊 ID 探测） */
  snapshot?: string;
  /** upstream 形态：.registry.yaml 所在的 packs_root（缺省图包根的父目录） */
  packsRoot?: string;
}

/** `tts pack sync-upstream` 的选项 */
interface PackSyncUpstreamOptions {
  /** 图包工作区根目录（默认 "."） */
  pack: string;
  /** 显式快照文件（存档 JSON / .ttsmod；优于按工坊 ID 探测） */
  snapshot?: string;
  /** .registry.yaml 所在的 packs_root（缺省图包根的父目录） */
  packsRoot?: string;
}

/** 全局选项中上游子命令需要的一项（--datadir 在 program 级声明） */
interface GlobalDatadirOption {
  /** 显式 TTS Mods 目录（未给时按 src/datadir/locate.ts 探测） */
  datadir?: string;
}

/** pack list 的一行：注册表条目 + 实测的 git 脏标志（null = 无法判定，如不是 git 仓库） */
interface PackListRow {
  entry: PackEntry;
  dirty: boolean | null;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** diff 清单的分组顺序（与 src/pack/diff.ts 的 status 取值一一对应） */
const DIFF_STATUSES = ["added", "modified", "deleted"] as const;

/**
 * pack 子命令的统一错误出口。
 *
 * PackError 是按错误码分支的（如 "PACK_NOT_FOUND" / "DIFF_FAILED"），
 * 对应 `error.<code>` 文案；其余异常（含 pack 模块的入参校验、fs 错误、
 * 协议 / 会话层的未包装异常）统一走 `error.unknown`。两者都只写 stderr，
 * 绝不向 stdout 混入错误信息。
 *
 * @param err 命令 action 中捕获的异常
 * @returns 建议的进程退出码（恒为 1，与 CLI 其他命令一致）
 */
function reportPackError(err: unknown): number {
  if (err instanceof PackError) {
    console.error(t(`error.${err.code}`, { msg: err.message }));
    return 1;
  }
  console.error(t("error.unknown", { msg: err instanceof Error ? err.message : String(err) }));
  return 1;
}

/**
 * 校验并收窄 `--lfs` 的取值。
 *
 * 不合法时立即抛中文用法错误（与 pack 模块的入参校验风格一致），
 * 而不是把它塞给 initPack 让 zod 报错——zod 的文案面向调用方，
 * 命令行用户需要看到"--lfs 只接受…"。
 *
 * @param value 命令行传入的原始值；未指定时 undefined
 * @returns 合法取值；未指定时 undefined（交给 initPack 走探测 / 交互三选一）
 * @throws Error 值不是 "enabled" / "disabled" 时
 */
function parseLfs(value: string | undefined): "enabled" | "disabled" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "enabled" || value === "disabled") {
    return value;
  }
  throw new Error(`--lfs 只接受 enabled 或 disabled（收到 ${value}）`);
}

/**
 * 取 unpack 的缺省输出目录：`./packs/<name || "unnamed">`。
 * @param name `--name` 的值（未指定或空串时用 "unnamed" 占位）
 * @returns 缺省输出目录（相对当前工作目录，由 unpackSave 负责 resolve）
 */
function defaultUnpackOutDir(name: string | undefined): string {
  return `./packs/${name !== undefined && name !== "" ? name : "unnamed"}`;
}

/**
 * 把一条待推送清单渲染成一行纯数据文本。
 * 格式：`  <guid>  <name>  <脚本路径>  <UI 路径>`（缺哪边就少哪段）。
 * @param item collectPushItems 产出的清单条目
 * @returns 单行文本（不含换行）
 */
function formatPushItem(item: PushItem): string {
  const files = [item.scriptPath, item.uiPath].filter((file): file is string => file !== undefined);
  return `  ${item.guid}  ${item.name}  ${files.join("  ")}`;
}

/**
 * 把一条 modified 差异的逐行 hunks 渲染成多行文本（`pack diff --unified`）。
 *
 * 每块先输出头行 `` @@ -<localStart>,+<localLines.length> @@ ``（任务书约定的
 * 简化 unified 头：本地起始行号 + 本地行数），随后 `- ` 前缀列出本地工作区行、
 * `+ ` 前缀列出游戏侧行（方向与 diff.ts 的 status 语义一致：游戏侧相对本地，
 * `+` 表示游戏里有而本地尚未落盘的内容；上下文行在两侧数组各出现一次，故
 * 以两种前缀各显示一遍）。整块缩进两格，行内容缩进四格。
 *
 * @param hunks diffWorkspace（includeHunks: true）填充的 hunk 列表；缺省视为空
 * @returns 每行一条的文本列表（不含换行；无 hunks 时为空数组）
 */
function formatHunkLines(hunks: readonly DiffHunk[] | undefined): string[] {
  const lines: string[] = [];
  for (const hunk of hunks ?? []) {
    lines.push(`  @@ -${hunk.localStart},${hunk.localLines.length} +${hunk.remoteStart},${hunk.remoteLines.length} @@`);
    for (const line of hunk.localLines) {
      lines.push(`    - ${line}`);
    }
    for (const line of hunk.remoteLines) {
      lines.push(`    + ${line}`);
    }
  }
  return lines;
}

/**
 * 打印 push 摘要（hub 委托与独立模式共用一行输出契约）。
 * dry-run 打 `cli.pack.push.dryRunSummary` {pushed} {skipped}；实写打
 * `cli.pack.push.pushedSummary` {pushed} {skipped} {backupDir}（无备份目录时 "-" 占位）。
 * @param dryRun 是否试运行
 * @param pushed 已写入（或将写入）的对象数
 * @param skipped 无变化跳过的对象数
 * @param backupDir 备份目录（dry-run / skipBackup 时缺省）
 */
function printPushSummary(
  dryRun: boolean,
  pushed: number,
  skipped: number,
  backupDir: string | undefined,
): void {
  if (dryRun) {
    console.log(t("cli.pack.push.dryRunSummary", { pushed, skipped }));
    return;
  }
  console.log(t("cli.pack.push.pushedSummary", { pushed, skipped, backupDir: backupDir ?? "-" }));
}

/**
 * 探测单个注册图包的 git 脏状态（`pack list` 的 dirty 列）。
 *
 * 单个包探测失败（不是 git 仓库 / git 不在 PATH / 目录被删）不影响整张列表：
 * 返回 null，呈现为 "?"，`--dirty` 过滤时按"不脏"处理（宁可不显示，也不误报有改动）。
 *
 * @param packsRoot 图包索引根目录（`--root`）
 * @param entry 注册表条目（dir 是相对 packsRoot 的一级子目录名）
 * @returns 有未提交改动 true / 干净 false / 无法判定 null
 */
async function probeDirty(packsRoot: string, entry: PackEntry): Promise<boolean | null> {
  try {
    return (await statusPorcelain(path.resolve(packsRoot, entry.dir))).length > 0;
  } catch {
    return null;
  }
}

/**
 * git 脏标志的表格呈现：true / false / "?"（无法判定）。布尔字面量是纯数据不翻译。
 * @param dirty probeDirty 的结果
 * @returns 单元格文本
 */
function formatDirtyFlag(dirty: boolean | null): string {
  return dirty === null ? "?" : String(dirty);
}

/**
 * 把一条注册表条目渲染成多行纯数据文本（字段名即契约键，不翻译；嵌套块用 "块.字段"）。
 *
 * @param entry findPack / readRegistry 产出的条目
 * @returns 每行一条的文本列表（upstream 为 null 时只有一行 "upstream: -"）
 */
function formatPackEntry(entry: PackEntry): string[] {
  const lines = [
    `dir: ${entry.dir}`,
    `name: ${entry.name}`,
    `kind: ${entry.kind}`,
    `branch: ${entry.branch}`,
    `host: ${entry.host}`,
    `modified: ${entry.modified}`,
    `lfs_status: ${entry.lfs_status}`,
    `stats: decks=${entry.stats.decks} cards=${entry.stats.cards} scripts=${entry.stats.scripts}`,
  ];
  if (entry.upstream === null) {
    lines.push("upstream: -");
  } else {
    lines.push(`upstream.workshop_id: ${entry.upstream.workshop_id}`);
    lines.push(`upstream.last_synced: ${entry.upstream.last_synced}`);
    lines.push(`upstream.local_commit: ${entry.upstream.local_commit}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 内部工具：pack export / import / sync-upstream
// ---------------------------------------------------------------------------

/** 字节数换算单位（从大到小依次试探；不足 1 KB 时直接输出字节） */
const BYTE_UNITS: ReadonlyArray<{ limit: number; suffix: string }> = [
  { limit: 1024 ** 4, suffix: "TB" },
  { limit: 1024 ** 3, suffix: "GB" },
  { limit: 1024 ** 2, suffix: "MB" },
  { limit: 1024, suffix: "KB" },
];

/**
 * 把字节数格式化成人可读文本（与 src/cli/commands/vcs.ts 的同名函数一致；
 * 命令层模块之间按仓库约定不互相 import，此处为副本）。
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
 * 素材字段路径 → .ttsmod 素材类型。
 *
 * 映射依据 TTS 的 UrlFileType 语义（src/deck/patch.ts 的访问清单）：
 * - CustomMesh.MeshURL → model（TTS 的模型固定 .obj）；
 * - CustomAssetbundle.* → assetbundle；CustomPDF.PDFUrl → pdf；
 * - 其余（CustomDeck 正反面 / CustomImage / CustomDecal / Mesh 的贴图字段 /
 *   SkyURL / TableURL）都是位图 → image。
 *
 * @param fieldPath walkSaveUrls 给的字段路径（[容器键, 字段名] 或 [字段名]）
 * @returns 素材类型
 */
function assetKindOfField(fieldPath: readonly string[]): AssetKind {
  const container = fieldPath[0];
  const field = fieldPath[1];
  if (container === "CustomMesh" && field === "MeshURL") {
    return "model";
  }
  if (container === "CustomAssetbundle") {
    return "assetbundle";
  }
  if (container === "CustomPDF") {
    return "pdf";
  }
  return "image";
}

/**
 * 从 TTS Mods 目录推出各素材类型的本地缓存目录（扩展名推导第 2 级 + 素材字节
 * 来源）。目录名从 {@link ARCHIVE_ENTRY_DIRS} 派生（契约里的 `Mods/<目录>`），
 * 不硬编码字符串。
 *
 * @param modsDir Mods 目录（datadir）
 * @returns kind → 缓存目录绝对路径
 */
function cacheDirsFromDatadir(modsDir: string): Partial<Record<AssetKind, string>> {
  const dirs: Partial<Record<AssetKind, string>> = {};
  for (const [kind, entry] of Object.entries(ARCHIVE_ENTRY_DIRS)) {
    dirs[kind as AssetKind] = path.join(modsDir, entry.replace(/^Mods[/\\]/, ""));
  }
  return dirs;
}

/**
 * 解析导出用的 Mods 目录：优先全局 --datadir，其次 locateDatadir 的推荐值；
 * 都拿不到时返回 undefined（扩展名推导退化为 URL 路径 + 联网探测，仍可用）。
 * @param explicit 全局 --datadir 的值（可省略）
 * @returns Mods 目录绝对路径；无法确定时 undefined
 */
async function resolveModsDir(explicit: string | undefined): Promise<string | undefined> {
  if (explicit !== undefined && explicit.trim() !== "") {
    return path.resolve(explicit);
  }
  try {
    const located = await locateDatadir();
    return located.recommended;
  } catch {
    // 探测失败（配置损坏等）不是导出阻塞项：没有缓存目录也能靠 URL / 联网推导扩展名
    return undefined;
  }
}

/**
 * 从构建好的存档 JSON 里收集全部待打包素材（URL + 类型，按 kind|url 去重）。
 * {lang} 语言变体由 walkSaveUrls 按契约跳过；file: 等不可下载形态照常收集，
 * 由 exportTtsmod 在"缺本地文件"时跳过并告警（不静默）。
 *
 * @param saveJson 存档 JSON（字符串）
 * @returns 去重后的素材清单（顺序 = 遍历顺序）
 */
function collectExportAssets(saveJson: string): TtsmodAssetInput[] {
  const parsed: unknown = JSON.parse(saveJson);
  const seen = new Set<string>();
  const assets: TtsmodAssetInput[] = [];
  walkSaveUrls(parsed, (loc) => {
    const kind = assetKindOfField(loc.fieldPath);
    const key = `${kind}|${loc.currentValue}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    assets.push({ url: loc.currentValue, kind });
  });
  return assets;
}

/** 校验 `--readme` 的取值（不合法时打印用法错误并以退出码 1 结束） */
function parseReadme(value: string | undefined): "zh" | "en" | "both" | "none" {
  const raw = value ?? "both";
  if (raw === "zh" || raw === "en" || raw === "both" || raw === "none") {
    return raw;
  }
  console.error(t("cli.pack.export.invalidReadme", { value: raw }));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------

/**
 * `tts pack init <dir>`：新建图包工作区（目录骨架 + pack.yaml + git + lfs 三选一）。
 *
 * lfs 三选一被用户取消时 initPack 正常返回但 packYamlWritten=false（它已自行
 * 打印取消原因）——此时不再打"已创建"，改以退出码 1 标记本次未完成，便于脚本判断。
 */
const initSub = new Command("init")
  .description(t("cli.command.pack.init.description"))
  .argument("<dir>", t("cli.command.pack.init.argument.dir"))
  .option("--name <n>", t("cli.command.pack.init.option.name"))
  .option("--lfs <choice>", t("cli.command.pack.init.option.lfs"))
  .option("--skip-git", t("cli.command.pack.init.option.skipGit"))
  .action(async (dir: string, opts: PackInitOptions) => {
    try {
      const lfs = parseLfs(opts.lfs);
      const result = await initPack({ dir, name: opts.name, lfs, skipGit: opts.skipGit });
      if (!result.packYamlWritten) {
        // 取消路径：init.ts 已输出取消说明；这里只标记"未完成"，不重复打扰用户
        process.exitCode = 1;
        return;
      }
      console.log(t("cli.pack.init.done", { dir: result.packRoot }));
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

/**
 * `tts pack unpack <save>`：从存档 JSON 或 .ttsmod 离线建工作区（不需要游戏运行）。
 *
 * 输出目录缺省 `./packs/<name || "unnamed">`；未给 --name 时工作区名由 unpackSave
 * 回退到存档的 SaveName。摘要里的 outDir 用返回值 packRoot（resolve 后的绝对路径）。
 */
const unpackSub = new Command("unpack")
  .description(t("cli.command.pack.unpack.description"))
  .argument("<save>", t("cli.command.pack.unpack.argument.save"))
  .option("--out <dir>", t("cli.command.pack.unpack.option.out"))
  .option("--name <n>", t("cli.command.pack.unpack.option.name"))
  .action(async (save: string, opts: PackUnpackOptions) => {
    try {
      const outDir = opts.out !== undefined && opts.out !== "" ? opts.out : defaultUnpackOutDir(opts.name);
      const result = await unpackSave({ savePath: save, outDir, name: opts.name });
      console.log(
        t("cli.pack.unpack.done", {
          save,
          outDir: result.packRoot,
          scripts: result.scriptsWritten,
          ui: result.uiWritten,
          objects: result.objectsWritten,
        }),
      );
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

/**
 * `tts pack pull`：把运行中 TTS 的脚本 / UI 拉到工作区（在线回路，只读 TTS）。
 *
 * skipped 计数是"内容与本地一致、未覆写"的文件数，不是错误：工作区刚同步过时
 * 该值等于全部文件数，下次游戏内改动后重跑即可看到写入数。
 */
const pullSub = new Command("pull")
  .description(t("cli.command.pack.pull.description"))
  .option("--root <dir>", t("cli.command.pack.pull.option.root"), ".")
  .action(async (opts: PackRootOptions) => {
    try {
      const result = await pullFromGame({ root: opts.root });
      console.log(
        t("cli.pack.pull.done", {
          scripts: result.scriptsWritten,
          ui: result.uiWritten,
          skipped: result.skippedNoChange,
        }),
      );
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

/**
 * `tts pack push`：把本地工作区的脚本 / UI 改动安全地写回运行中的 TTS（阶段 5）。
 *
 * 安全语义（默认 dry-run）：
 * - 默认（无 --yes）是试运行：走完整检测流水线（素材改动 → 基线冲突 → 无变化
 *   过滤），只报告"将推送多少 / 跳过多少"，**不备份、不确认、不写游戏、不写基线**；
 * - `--yes` 是唯一实写入口（dryRun = !yes）：实写前先自动备份游戏内全部
 *   scriptStates（--no-backup 可关，--backup-retention 控制保留份数 1-100）；
 * - `--no-baseline-check` 跳过基线冲突检测、`--force-scripts-only` 在素材有改动
 *   时强制只推脚本（两者都是用户显式自担风险）；
 * - 交互确认门 confirmPush 作为防御性二次闸注入 pushSaveAndPlay：当前旗标决策
 *   （实写必带 --yes）下该门不会触发询问，保留为将来旗标语义变化的兜底。
 *
 * 双路（约束 7：push 协议只接收 scriptStates，命令层不提供任何素材选项）：
 * - hub 在线（tryHubClient 命中）→ 委托 hub 控制通道 /v1/push（hub 进程持有编辑
 *   端口 39998；confirm:true 由 CLI 显式给出，选项逐项透传）；委托失败输出
 *   error.hub.delegateFailed 并退出 1，**不回退独立模式**；
 * - hub 离线 → 独立模式直接调 pushSaveAndPlay（内部一次 withEditorServer）。
 *
 * 两种路径的摘要输出一致：dry-run 打 `cli.pack.push.dryRunSummary`，实写打
 * `cli.pack.push.pushedSummary`（backupDir 缺省时以 "-" 占位）。
 */
const pushSub = new Command("push")
  .description(t("cli.command.pack.push.description"))
  .option("--root <dir>", t("cli.command.pack.push.option.root"), ".")
  .option("--dry-run", t("cli.command.pack.push.option.dryRun"), true)
  .option("--yes", t("cli.command.pack.push.option.yes"), false)
  .option("--force-scripts-only", t("cli.command.pack.push.option.forceScriptsOnly"), false)
  .option("--no-backup", t("cli.command.pack.push.option.noBackup"))
  .option("--no-baseline-check", t("cli.command.pack.push.option.noBaselineCheck"))
  .option("--backup-retention <n>", t("cli.command.pack.push.option.backupRetention"), "20")
  .action(async (opts: PackPushOptions) => {
    // —— 决策（任务书 §1.1）：--yes 优先；--yes 时 dryRun=false，否则恒为 true ——
    const dryRun = !opts.yes;
    const backupRetention = parseInt(opts.backupRetention, 10);
    if (Number.isNaN(backupRetention) || backupRetention < 1 || backupRetention > 100) {
      console.error(t("error.cli.invalidBackupRetention"));
      process.exit(1);
    }

    const hub = await tryHubClient();
    if (hub !== null) {
      // —— hub 委托路径：推送在 hub 进程内执行（它持有编辑器端口 39998）——
      console.log(t("cli.pack.push.viaHub"));
      try {
        const body = await hub.push(opts.root, true /* confirm */, {
          dryRun,
          forceScriptsOnly: opts.forceScriptsOnly,
          skipBackup: !opts.backup,
          skipBaselineCheck: !opts.baselineCheck,
          backupRetention,
        });
        printPushSummary(body.dryRun, body.pushed, body.skipped, body.backupDir);
      } catch (err) {
        console.error(t("error.hub.delegateFailed", { message: describeError(err) }));
        process.exit(1);
      }
      return;
    }

    // —— 独立模式（hub 不在线）：直接调 pushSaveAndPlay（内部一次 withEditorServer）——
    try {
      const result = await pushSaveAndPlay({
        root: opts.root,
        dryRun,
        forceScriptsOnly: opts.forceScriptsOnly,
        skipBackup: !opts.backup,
        skipBaselineCheck: !opts.baselineCheck,
        backupRetention,
        confirm: async () => {
          // 实写模式且非 --yes → 交互确认（当前旗标决策下不可达，兜底保留）；
          // --yes 或 dryRun 都直接通过。确认清单现取 collectPushItems（懒执行，
          // dry-run 路径零开销）。
          if (!dryRun && !opts.yes) {
            const collected = await collectPushItems({ root: opts.root });
            return await confirmPush({
              message: t("cli.pack.push.confirmMessage", { count: collected.items.length }),
              details: collected.items.map((item) => formatPushItem(item).trimStart()),
              assumeYes: opts.yes,
            });
          }
          return true;
        },
      });
      printPushSummary(result.dryRun, result.pushed, result.skipped, result.backupDir);
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

/**
 * `tts pack diff`：对比工作区与运行中 TTS 当前存档的脚本 / UI。
 *
 * 条目按 status 分组输出（added → modified → deleted），组内顺序沿用
 * diffWorkspace 的排序（GUID 升序，同一 GUID 内 script 在 ui 之前）；
 * 条目行是纯数据，行尾的中文摘要（`cli.pack.diff.summary`）给出三个计数。
 *
 * `-u, --unified`（阶段 5）：把 includeHunks 传给 diffWorkspace，modified 条目
 * 额外携带逐行 unified hunks，紧跟在条目行后逐块打印（格式见
 * {@link formatHunkLines}）；added / deleted 及归一化后超过 5000 行的条目无
 * hunks，静默跳过。
 */
const diffSub = new Command("diff")
  .description(t("cli.command.pack.diff.description"))
  .option("--root <dir>", t("cli.command.pack.diff.option.root"), ".")
  .option("-u, --unified", t("cli.command.pack.diff.option.unified"), false)
  .action(async (opts: PackDiffOptions) => {
    try {
      const result = await diffWorkspace({ root: opts.root, includeHunks: opts.unified });
      for (const status of DIFF_STATUSES) {
        const group = result.entries.filter((entry) => entry.status === status);
        if (group.length === 0) {
          continue;
        }
        console.log(`${status}:`);
        for (const entry of group) {
          const local = entry.localPath === undefined ? "" : `  ${entry.localPath}`;
          console.log(`  ${entry.guid}  ${entry.name}  ${entry.kind}${local}`);
          if (opts.unified) {
            for (const line of formatHunkLines(entry.hunks)) {
              console.log(line);
            }
          }
        }
      }
      console.log(
        t("cli.pack.diff.summary", {
          added: result.added,
          modified: result.modified,
          deleted: result.deleted,
        }),
      );
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

/**
 * `tts pack build`：读骨架 + 工作区合成 TTS 可加载的存档 JSON（离线回路，约束 8）。
 *
 * --dry-run 只统计不写文件：先打 done 摘要（含"将会写入"的路径），再补一行
 * dryRunNote 明示没有落盘。buildSave 返回的 warnings 是已翻译的中文提示
 * （如"工作区有但骨架没有的 GUID"），逐条缩进打印，不改变退出码。
 */
const buildSub = new Command("build")
  .description(t("cli.command.pack.build.description"))
  .option("--root <dir>", t("cli.command.pack.build.option.root"), ".")
  .option("--dry-run", t("cli.command.pack.build.option.dryRun"))
  .option("--out <path>", t("cli.command.pack.build.option.out"))
  .action(async (opts: PackBuildOptions) => {
    try {
      const result = await buildSave({ root: opts.root, dryRun: opts.dryRun, outPath: opts.out });
      console.log(
        t("cli.pack.build.done", {
          outPath: result.outPath,
          scripts: result.scriptsReplaced,
          ui: result.uiReplaced,
          objects: result.objectsReplaced,
        }),
      );
      if (result.dryRun) {
        console.log(t("cli.pack.build.dryRunNote"));
      }
      for (const warning of result.warnings) {
        console.log(`  ${warning}`);
      }
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

// ---------------------------------------------------------------------------
// 子命令：多图包索引（list / status / open，阶段 2C）
// ---------------------------------------------------------------------------

/**
 * `tts pack list`：列出 `.registry.yaml` 里注册的全部图包（readRegistry）。
 *
 * 表格列：dir / name / branch / dirty / lfs_status。dirty 是**实测**值（逐包跑
 * statusPorcelain，经 src/vcs/git.ts），不是注册表里的 modified 日期；探测失败的
 * 包显示 "?"，`--dirty` 时被过滤掉。注册表不存在时 readRegistry 容错返回空表，
 * 这里按"没有已注册图包"提示并以 0 退出。
 */
const listSub = new Command("list")
  .description(t("cli.command.pack.list.description"))
  .option("--root <dir>", t("cli.command.pack.list.option.root"), ".")
  .option("--dirty", t("cli.command.pack.list.option.dirty"), false)
  .action(async (opts: PackListOptions) => {
    try {
      const registry = await readRegistry(opts.root);
      if (registry.packs.length === 0) {
        console.log(t("cli.pack.list.empty"));
        return;
      }
      const rows: PackListRow[] = [];
      for (const entry of registry.packs) {
        rows.push({ entry, dirty: await probeDirty(opts.root, entry) });
      }
      const shown = opts.dirty ? rows.filter((row) => row.dirty === true) : rows;
      console.log(t("cli.pack.list.header", { count: shown.length }));
      for (const row of shown) {
        console.log(
          `  ${row.entry.dir}  ${row.entry.name}  ${row.entry.branch}  ${formatDirtyFlag(row.dirty)}  ${row.entry.lfs_status}`,
        );
      }
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

/**
 * `tts pack status <dir>`：显示单个注册图包的详细信息（findPack）。
 *
 * 输出条目的全部字段（dir / name / kind / branch / host / modified / lfs_status /
 * stats，以及 upstream 展开的 workshop_id / last_synced / local_commit）——字段名即
 * `.registry.yaml` 的契约键，纯数据不翻译。找不到 dir 时只写 stderr 并以退出码 1 结束
 * （不是 PackError，findPack 对"找不到"返回 null）。
 */
const packStatusSub = new Command("status")
  .description(t("cli.command.pack.status.description"))
  .argument("<dir>", t("cli.command.pack.status.argument.dir"))
  .option("--root <dir>", t("cli.command.pack.status.option.root"), ".")
  .action(async (dir: string, opts: PackRootOptions) => {
    try {
      const entry = await findPack(opts.root, dir);
      if (entry === null) {
        console.error(t("cli.pack.status.notFound", { dir }));
        process.exit(1);
      }
      for (const line of formatPackEntry(entry)) {
        console.log(line);
      }
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

/**
 * `tts pack open <dir>`：用系统文件管理器打开图包目录（findPack + explorer）。
 *
 * Windows 上经 execa 调 `explorer <绝对路径>`（explorer.exe 成功时也可能返回非 0，
 * 故 reject: false 忽略退出码——打不开时由资源管理器自己提示）；其他平台只把绝对
 * 路径打出来，由用户自行打开，绝不猜测平台专属的打开命令。无论哪种情况都以
 * `cli.pack.open.done` {path} 收尾，脚本可以从中取路径。
 */
const openSub = new Command("open")
  .description(t("cli.command.pack.open.description"))
  .argument("<dir>", t("cli.command.pack.open.argument.dir"))
  .option("--root <dir>", t("cli.command.pack.open.option.root"), ".")
  .action(async (dir: string, opts: PackRootOptions) => {
    try {
      const entry = await findPack(opts.root, dir);
      if (entry === null) {
        console.error(t("cli.pack.open.notFound", { dir }));
        process.exit(1);
      }
      const absolutePath = path.resolve(opts.root, entry.dir);
      if (process.platform === "win32") {
        await execa("explorer", [absolutePath], { reject: false });
      }
      console.log(t("cli.pack.open.done", { path: absolutePath }));
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

// ---------------------------------------------------------------------------
// 子命令：打包分发（export / import，阶段 3B）
// ---------------------------------------------------------------------------

/**
 * `tts pack export <图包> -o <名>.ttsmod`：把工作区打成自包含 `.ttsmod`。
 *
 * 流程：buildSave 合成存档 JSON（写到临时文件，导出后删除；不污染 dist/）→
 * walkSaveUrls 收集素材（URL + 类型）→ exportTtsmod 打包（扩展名三级兜底、
 * manifest / README、缺素材列出或 --strict 中止）。
 *
 * 素材本地缓存目录来自 `--datadir`（全局选项）或 locateDatadir 的探测结果；
 * 拿不到时仍可导出（扩展名走 URL 路径 / 联网探测），只多一行提示。
 * `-o` 缺省用 ttsmodFileName 的约定名 `<图包名> (<工坊ID>).ttsmod`（写当前目录）。
 */
const exportSub = new Command("export")
  .description(t("cli.command.pack.export.description"))
  .argument("<pack>", t("cli.command.pack.export.argument.pack"))
  .option("-o, --out <file>", t("cli.command.pack.export.option.out"))
  .option("--strict", t("cli.command.pack.export.option.strict"), false)
  .option("--readme <lang>", t("cli.command.pack.export.option.readme"), "both")
  .action(async function (this: Command, packDir: string, opts: PackExportOptions) {
    try {
      const globals = this.optsWithGlobals<GlobalDatadirOption>();
      const readme = parseReadme(opts.readme);
      const packRoot = path.resolve(packDir);
      const pack = await readPackYaml(packRoot);
      const modsDir = await resolveModsDir(globals.datadir);
      if (modsDir === undefined) {
        console.log(t("cli.pack.export.noDatadirNote"));
      }
      const cacheDirs = modsDir === undefined ? undefined : cacheDirsFromDatadir(modsDir);

      // —— 建存档 JSON 到临时文件（export 的产物只有 .ttsmod）——
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "tts-toolkit-export-"));
      let saveJson: string;
      try {
        const tempSave = path.join(tempDir, "save.json");
        await buildSave({ root: packRoot, outPath: tempSave });
        saveJson = await readFile(tempSave, "utf8");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }

      const assets = collectExportAssets(saveJson);
      const outPath =
        opts.out !== undefined && opts.out !== ""
          ? opts.out
          : ttsmodFileName(pack.name, pack.workshop_id);
      const result = await exportTtsmod({
        outPath,
        packName: pack.name,
        workshopId: pack.workshop_id,
        sourceModId: pack.source_mod,
        saveJson,
        assets,
        ...(cacheDirs === undefined ? {} : { cacheDirs }),
        ...(opts.strict === true ? { strict: true } : {}),
        readme,
      });

      console.log(
        t("cli.pack.export.done", {
          outPath: result.outPath,
          entries: result.entryCount,
          size: formatBytes(result.fileBytes),
          included: result.included.length,
          skipped: result.skipped.length,
        }),
      );
      if (result.readmeEntries.length > 0) {
        console.log(t("cli.pack.export.readme", { entries: result.readmeEntries.join("、") }));
      }
      if (result.skipped.length > 0) {
        console.log(t("cli.pack.export.skippedHeader", { count: result.skipped.length }));
      }
      for (const warning of result.warnings) {
        console.log(t("cli.pack.export.warning", { message: warning }));
      }
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

/**
 * `tts pack import`：两种形态分流（见模块头注释）。
 *
 * - `<文件.ttsmod>`：importTtsmod 解压到 `--into`（Mods 的**父目录**）；非
 *   `Mods/` 条目（如 `Saves/`）解到 `--saves`（缺省 `<into>/Saves`）。已存在
 *   文件不覆盖（原工具语义），跳过的逐个列出。
 * - `<工坊ID> --as-upstream`：importAsUpstream 把上游快照落到 `upstream` 分支
 *   （`--pack` 工作区、`--snapshot` 显式快照、`--datadir` 全局选项探测
 *   `Mods/Workshop/<id>.json`）。
 */
const importSub = new Command("import")
  .description(t("cli.command.pack.import.description"))
  .argument("[target]", t("cli.command.pack.import.argument.target"))
  .option("--as-upstream", t("cli.command.pack.import.option.asUpstream"), false)
  .option("--into <dir>", t("cli.command.pack.import.option.into"), ".")
  .option("--saves <dir>", t("cli.command.pack.import.option.saves"))
  .option("--pack <dir>", t("cli.command.pack.import.option.pack"), ".")
  .option("--snapshot <file>", t("cli.command.pack.import.option.snapshot"))
  .option("--packs-root <dir>", t("cli.command.pack.import.option.packsRoot"))
  .action(async function (this: Command, target: string | undefined, opts: PackImportOptions) {
    try {
      if (opts.asUpstream === true) {
        if (target === undefined || !/^[0-9]+$/.test(target)) {
          console.error(t("cli.pack.upstream.needWorkshopId"));
          process.exit(1);
        }
        const workshopId = Number(target);
        if (!Number.isSafeInteger(workshopId) || workshopId <= 0) {
          console.error(t("cli.pack.upstream.needWorkshopId"));
          process.exit(1);
        }
        const globals = this.optsWithGlobals<GlobalDatadirOption>();
        const result = await importAsUpstream({
          root: opts.pack,
          workshopId,
          ...(opts.snapshot === undefined ? {} : { snapshotPath: opts.snapshot }),
          ...(globals.datadir === undefined ? {} : { datadir: globals.datadir }),
          ...(opts.packsRoot === undefined ? {} : { packsRoot: opts.packsRoot }),
        });
        console.log(
          t("cli.pack.upstream.imported", {
            snapshot: result.snapshotPath,
            branch: result.branch,
            commit: result.upstreamCommit.slice(0, 7),
          }),
        );
        if (!result.committed) {
          console.log(t("cli.pack.upstream.importedNoChange"));
        }
        return;
      }

      if (target === undefined || target.trim() === "") {
        console.error(t("cli.pack.importFile.needTarget"));
        process.exit(1);
      }
      if (/^[0-9]+$/.test(target.trim())) {
        // 纯数字只可能是工坊 ID：提示补 --as-upstream（或给 .ttsmod 文件路径）
        console.error(t("cli.pack.importFile.numericTarget", { target }));
        process.exit(1);
      }

      const into = path.resolve(opts.into);
      const savesDir =
        opts.saves !== undefined && opts.saves !== ""
          ? path.resolve(opts.saves)
          : path.join(into, "Saves");
      const result = await importTtsmod(target, {
        modsParentDir: into,
        modSaveLocation: savesDir,
      });
      console.log(
        t("cli.pack.importFile.done", {
          file: target,
          into,
          extracted: result.extracted,
          total: result.totalEntries,
        }),
      );
      if (result.skippedExisting.length > 0) {
        console.log(t("cli.pack.importFile.skippedExisting", { count: result.skippedExisting.length }));
        for (const name of result.skippedExisting) {
          console.log(t("cli.pack.importFile.skippedExistingItem", { path: name }));
        }
      }
      if (result.skippedUnsafe.length > 0) {
        console.log(t("cli.pack.importFile.skippedUnsafe", { count: result.skippedUnsafe.length }));
      }
      if (result.workshopSaves.length > 0) {
        console.log(t("cli.pack.importFile.workshopSaves", { count: result.workshopSaves.length }));
        for (const save of result.workshopSaves) {
          console.log(t("cli.pack.importFile.workshopSaveItem", { path: save }));
        }
        console.log(t("cli.pack.importFile.unpackHint", { path: result.workshopSaves[0] as string }));
      }
      for (const warning of result.warnings) {
        console.log(t("cli.pack.importFile.warning", { message: warning }));
      }
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

/**
 * `tts pack sync-upstream [--pack <路径>]`：拉上游新快照 → commit 到 upstream
 * 分支 → 合并回当前分支（syncUpstream）。
 *
 * 合并冲突时**只报告不选边**：逐条打印 formatConflict 的语义化报告（哪个牌堆
 * 的哪张卡 / 哪个对象），merge 保持进行中的现场，退出码 1 待用户解决后自行
 * `git add` / `git commit`；干净合并（含 already up to date）正常 0。
 */
const syncUpstreamSub = new Command("sync-upstream")
  .description(t("cli.command.pack.syncUpstream.description"))
  .option("--pack <dir>", t("cli.command.pack.syncUpstream.option.pack"), ".")
  .option("--snapshot <file>", t("cli.command.pack.syncUpstream.option.snapshot"))
  .option("--packs-root <dir>", t("cli.command.pack.syncUpstream.option.packsRoot"))
  .action(async function (this: Command, opts: PackSyncUpstreamOptions) {
    try {
      const globals = this.optsWithGlobals<GlobalDatadirOption>();
      const result = await syncUpstream({
        root: opts.pack,
        ...(opts.snapshot === undefined ? {} : { snapshotPath: opts.snapshot }),
        ...(globals.datadir === undefined ? {} : { datadir: globals.datadir }),
        ...(opts.packsRoot === undefined ? {} : { packsRoot: opts.packsRoot }),
      });
      console.log(
        t("cli.pack.upstream.synced", {
          snapshot: result.snapshotPath,
          branch: result.branch,
          commit: result.upstreamCommit.slice(0, 7),
        }),
      );
      if (!result.committed) {
        console.log(t("cli.pack.upstream.syncedNoChange"));
      }
      if (!result.mergeAttempted) {
        console.log(t("cli.pack.upstream.mergeSkipped"));
        return;
      }
      if (result.merged) {
        console.log(t("cli.pack.upstream.merged", { branch: result.branch }));
        return;
      }
      const conflicts = result.conflicts;
      if (conflicts !== null && conflicts.hasConflicts) {
        console.log(t("cli.pack.upstream.conflictsHeader", { count: conflicts.conflicts.length }));
        for (const info of conflicts.conflicts) {
          console.log(formatConflict(info));
        }
        if (conflicts.cardsCsvConflictPaths.length > 0) {
          console.log(t("cli.pack.upstream.cardsCsvWarning"));
        }
        console.log(t("cli.pack.upstream.conflictHint"));
        process.exitCode = 1;
      }
    } catch (err) {
      process.exit(reportPackError(err));
    }
  });

// ---------------------------------------------------------------------------
// 主命令
// ---------------------------------------------------------------------------

/** `tts pack` 主命令：12 个子命令在上方定义后统一挂载（薄分发层，无自身 action） */
export const packCommand: Command = new Command("pack").description(t("cli.command.pack.description"));

packCommand.addCommand(initSub);
packCommand.addCommand(unpackSub);
packCommand.addCommand(pullSub);
packCommand.addCommand(pushSub);
packCommand.addCommand(diffSub);
packCommand.addCommand(buildSub);
packCommand.addCommand(listSub);
packCommand.addCommand(packStatusSub);
packCommand.addCommand(openSub);
packCommand.addCommand(exportSub);
packCommand.addCommand(importSub);
packCommand.addCommand(syncUpstreamSub);
