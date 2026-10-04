// src/pack/upstream.ts
/**
 * 上游分支模型：`pack import --as-upstream` 与 `pack sync-upstream` 的数据层
 * （方案设计 §4.10 分支模型；施工流程 2C.3，B3 跳过、C 窗口补上）。
 *
 * 分支模型（方案设计 §4.10）：
 * ```
 * main        ← 稳定版
 * ├─ upstream ← 跟踪上游原始图包，只读快照，用于合并（仅魔改/汉化场景）
 * └─ zh-cn    ← 用户自己的分支，基于 upstream 开；上游更新后 git merge upstream
 * ```
 * - {@link importAsUpstream}：把上游工坊快照（存档 JSON / .ttsmod）经
 *   {@link unpackSave} 拆成标准工作区布局，落到（新建或既有的）`upstream` 分支上
 *   并提交；结束切回原分支。**不做合并**——初次导入时用户分支通常还没有基于
 *   upstream 的改动，合并由用户在开自己的分支后按需进行；
 * - {@link syncUpstream}：拉上游新快照并 commit 到 `upstream` 分支（内容无变化则
 *   不产生新提交），然后把 `upstream` 合并回调用时所在的分支（等价于用户手跑
 *   `git merge upstream`，C 窗口主窗口 2026-10-05 裁决：合并由本模块执行）；
 *   **merge 出冲突时只报告、绝不替用户选边**——沿用 src/vcs/conflicts.ts 的反查
 *   能力列出"哪个牌堆的哪张卡 / 哪个对象的哪个脚本"，merge 保持进行中的现场，
 *   交由用户按 `git checkout --ours/--theirs` 或编辑器自行解决，本模块不出现任何
 *   自动 --ours/--theirs 流程（B3 铁律）。
 *
 * ── 上游快照的来源（C 窗口主窗口 2026-10-05 裁决：显式入参优先，datadir 兜底）──
 * - 显式 `snapshotPath`（存档 JSON 或 .ttsmod，与 `tts pack unpack` 同一输入口径）
 *   存在时直接使用；
 * - 未指定时按工坊 ID 找 TTS 数据目录里的 `Mods/Workshop/<工坊ID>.json`：给了
 *   `datadir`（显式 Mods 目录，对应 CLI 的 --datadir）就只探测该目录；否则经
 *   src/datadir/locate.ts 的 {@link locateDatadir} 按优先级（explicit > config >
 *   install-dir > documents）探测全部候选逐个找；syncUpstream 的工坊 ID 取
 *   .registry.yaml 该包条目的 `upstream.workshop_id`，没有时回退 pack.yaml 的
 *   `source_mod`（两处语义相同：上游模组 ID）；
 * - 全部落空 → PackError code="UPSTREAM_SNAPSHOT_NOT_FOUND"，报清楚找过哪些位置，
 *   绝不静默。
 *
 * ── upstream 分支内容的取舍（重要，别"优化"掉）────────────────────────────
 * - 快照经 {@link unpackSave}（skipGit）拆到临时目录，再把**除去 `.git` 与 `.tts`
 *   的全部产物**复制进工作区——`.tts/skeleton.json` 是用户当前分支的离线回路替换
 *   基准（约束 8：绝不入 git），既不覆盖也不提交；
 * - 同理，工作区基础设施文件**只保留、不替换、不提交删除**：`.gitignore` /
 *   `.gitattributes` / `pack.yaml` / `.tts/.gitkeep` 在切到 upstream 分支后不从
 *   磁盘删除，快照产物也不覆盖它们。pack.yaml 是用户工作区的元数据清单，快照
 *   自带的 pack.yaml 只是 unpackSave 的样板（name=SaveName、lfs=disabled-no-lfs、
 *   工坊 ID 为 null），把上游分支排除在 pack.yaml 的变更之外，可以避免每次合并
 *   都在 pack.yaml 上产生无意义冲突、甚至让干净合并悄悄改掉用户的清单；
 * - upstream 分支上先删除全部已跟踪文件再复制快照产物（`git add -A` 尊重被保留
 *   的 .gitignore），因此"上游删了某文件"会如实体现为 upstream 分支上的删除；
 * - 失败恢复：切到 upstream 分支之后的任何步骤失败，尽力 `git checkout -f` 回原
 *   分支（`-f` 丢弃 upstream 分支上的半成品工作区；未跟踪的被忽略文件——如
 *   `.tts/skeleton.json`——不受影响），再抛出原错误。
 *
 * ── 同步前置检查（顺序即实现顺序）────────────────────────────────────────
 * 1. `<root>/pack.yaml` 必须存在且合规（readPackYaml，PACK_* 错误原样透传）；
 * 2. 工作区必须干净：`git status --porcelain -z` 无任何条目（含未跟踪文件——
 *    未跟踪文件会在 upstream 分支的 add -A 里被误提交、切回时被删，必须先提交
 *    或加入 .gitignore）；刚 init 的空包请先 `tts vcs commit` 初始内容；
 * 3. 仓库至少有一个提交、且不在 detached HEAD（否则无从切回原分支）；
 * 4. （syncUpstream）`upstream` 分支必须已存在（没有就先 import）；
 * 5. lfs 三方一致（src/vcs/lfs.ts 的 {@link inspectLfs}，C 窗口约定 5）：
 *    系统 git-lfs / .gitattributes / pack.yaml 的 vcs.lfs 任何一方漂移都拒绝，
 *    否则分支切换后图片可能 checkout 出指针或裸文件。
 *
 * ── .registry.yaml 的读写（docs/schemas/registry.yaml.md §4.1）──────────────
 * upstream 分支产生（或确认无新）提交后，把该包条目的 `upstream` 刷新为
 * `{ workshop_id, last_synced: 今天(UTC), local_commit: upstream 分支当前提交 }`
 * （{@link upsertPack}，带乐观锁）。约定：
 * - packsRoot 缺省取图包根的**父目录**（注册表在 packs_root 级，可用 packsRoot
 *   入参显式指定）；条目不存在时跳过（登记是 init/list 层的职责，本模块不发明
 *   条目）；merge 冲突时同样刷新——记录的是 upstream 分支的事实状态；
 * - 注册表写入失败（REGISTRY_* 等）原样上抛，git 侧的成果不回滚。
 *
 * 错误码（{@link PackError.code}；既有码透传：PACK_* / GIT_* / REGISTRY_* /
 * LFS_ATTRIBUTES_FAILED / SAVE_INVALID / TTSMOD_INVALID / UNPACK_FAILED）：
 * - "UPSTREAM_SNAPSHOT_NOT_FOUND"  快照不存在：显式路径缺失、无法确定工坊 ID、
 *                                  或所有候选数据目录下都没有 Mods/Workshop/<id>.json
 * - "UPSTREAM_DIRTY_WORKTREE"      工作区有未提交 / 未跟踪改动，拒绝同步
 * - "UPSTREAM_STATE_INVALID"       仓库状态不允许（无任何提交 / detached HEAD）
 * - "UPSTREAM_NOT_IMPORTED"        syncUpstream 时 upstream 分支还不存在
 * - "UPSTREAM_LFS_INCONSISTENT"    lfs 三方不一致（inspectLfs 拦截，message 带警告明细）
 * - "UPSTREAM_MERGE_FAILED"        git merge 因冲突以外的原因失败（如 unrelated histories）
 *
 * 本模块新增的 i18n 键（locales/*.json 由本阶段的 locales Run 补齐；缺键时 t()
 * 原样输出键名，测试按 PackError.code 断言——见 tests/unit/pack-upstream.test.ts）：
 * - `error.pack.upstream.dirtyWorktree` {path} {detail}      → UPSTREAM_DIRTY_WORKTREE
 * - `error.pack.upstream.lfsInconsistent` {detail}           → UPSTREAM_LFS_INCONSISTENT
 * - `error.pack.upstream.snapshotNotFound` {detail}          → UPSTREAM_SNAPSHOT_NOT_FOUND
 * - `error.pack.upstream.notImported` {branch}               → UPSTREAM_NOT_IMPORTED
 * - `error.pack.upstream.stateInvalid` {detail}              → UPSTREAM_STATE_INVALID
 * - `error.pack.upstream.mergeFailed` {detail}               → UPSTREAM_MERGE_FAILED
 *
 * 其他约定：
 * - git 子命令全部经 src/vcs/git.ts 的 runGit / runGitOrThrow（参数走数组），
 *   绝不直接 execa("git", ...)（B3 铁律）；
 * - upstream 分支上的提交 message 为固定中文模板（"导入/同步上游工坊快照
 *   （workshop <id>）"），与 src/vcs/commit.ts 的自动模板同一约定（git 提交
 *   message 不走 t()）；
 * - 本模块离线：不 import 命令层 / with-server.ts / session/*；
 *   locateDatadir 只在未显式给 datadir 时调用（探测失败包装为
 *   UPSTREAM_SNAPSHOT_NOT_FOUND，不向调用方泄漏非 PackError）。
 */

import type { Dirent } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, rmdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { t } from "../i18n/index.js";
import { locateDatadir, type DatadirCandidate } from "../datadir/locate.js";
import { analyzeConflicts, type ConflictsReport } from "../vcs/conflicts.js";
import { currentBranch, headCommit, runGit, runGitOrThrow, statusPorcelain } from "../vcs/git.js";
import { inspectLfs } from "../vcs/lfs.js";

import { PackError, readPackYaml } from "./packyaml.js";
import { findPack, upsertPack } from "./registry.js";
import { unpackSave } from "./unpack.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 上游快照分支名（方案设计 §4.10 的分支模型；CLI 层提示与测试都用这个常量）。
 */
export const UPSTREAM_BRANCH = "upstream";

/**
 * 切到 upstream 分支后**不从磁盘删除**的已跟踪文件（相对仓库根的 POSIX 路径）。
 * 这些是用户工作区的基础设施 / 元数据：upstream 分支原样继承它们（通常与基线
 * 提交一致，不产生 diff），快照产物也不会覆盖——保证后续 `git merge upstream`
 * 永远不碰 pack.yaml / 忽略规则 / lfs 规则（理由见模块头注释"内容取舍"）。
 */
const PRESERVED_REL_PATHS: ReadonlySet<string> = new Set([
  ".gitignore",
  ".gitattributes",
  "pack.yaml",
  ".tts/.gitkeep",
]);

/**
 * 复制快照工作区到图包根时**跳过的顶层条目**：
 * - ".git"：skipGit 的 unpack 不会产生，防御性排除；
 * - ".tts"：约束 8——骨架存档绝不入 git，也绝不覆盖用户当前分支的替换基准；
 * - "pack.yaml"：快照自带的只是 unpackSave 的样板（name=SaveName、工坊 ID 为
 *   null、lfs=disabled-no-lfs），绝不覆盖用户的清单（与 {@link PRESERVED_REL_PATHS}
 *   的"不删除"配套——只不删不覆盖，才真正保证 upstream 分支不携带 pack.yaml 变更）。
 */
const COPY_EXCLUDED_TOP_ENTRIES: ReadonlySet<string> = new Set([".git", ".tts", "pack.yaml"]);

/** 快照解包临时目录的前缀（mkdtemp） */
const TEMP_WORKSPACE_PREFIX = "tts-toolkit-upstream-";

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** {@link importAsUpstream} 的入参 */
export interface ImportUpstreamOptions {
  /** 图包工作区根目录（必须是 git 仓库工作树，绝对 / 相对均可，内部会 resolve） */
  root: string;
  /** 上游创意工坊 ID（正整数）；未显式给 snapshotPath 时用它到 TTS 数据目录找 Mods/Workshop/<id>.json */
  workshopId: number;
  /** 上游快照文件路径（存档 JSON 或 .ttsmod）；显式给出时优先于工坊 ID 探测 */
  snapshotPath?: string;
  /** 显式 TTS Mods 目录（对应 CLI --datadir）；给出时跳过 locateDatadir 探测，只在该目录下找 Workshop/<id>.json */
  datadir?: string;
  /** .registry.yaml 所在的 packs_root；缺省取图包根的父目录 */
  packsRoot?: string;
}

/** {@link syncUpstream} 的入参（工坊 ID 从 .registry.yaml / pack.yaml.source_mod 解析，不显式给） */
export interface SyncUpstreamOptions {
  /** 图包工作区根目录（必须是 git 仓库工作树） */
  root: string;
  /** 上游快照文件路径（存档 JSON 或 .ttsmod）；显式给出时优先于工坊 ID 探测 */
  snapshotPath?: string;
  /** 显式 TTS Mods 目录；给出时跳过 locateDatadir 探测 */
  datadir?: string;
  /** .registry.yaml 所在的 packs_root；缺省取图包根的父目录 */
  packsRoot?: string;
}

/** {@link importAsUpstream} / {@link syncUpstream} 的结构化返回（不依赖 stdout 文案） */
export interface UpstreamSyncResult {
  /** 实际使用的上游快照文件（绝对路径） */
  snapshotPath: string;
  /** 上游工坊 ID（import 为入参；sync 为解析值，registry 与 pack.yaml 都没有时 null） */
  workshopId: number | null;
  /** 调用前所在分支（结束时会切回；upstream 分支上的合并动作也发生在它上面） */
  branch: string;
  /** upstream 分支当前的完整提交 hash（本次产生或既有） */
  upstreamCommit: string;
  /** 本次是否在 upstream 分支上产生了新提交（快照内容与现状一致时为 false） */
  committed: boolean;
  /** 是否尝试了把 upstream 合并回原分支（import 恒 false；原分支就是 upstream 时也 false） */
  mergeAttempted: boolean;
  /** 合并是否干净完成（未尝试合并或合并冲突时为 false） */
  merged: boolean;
  /**
   * 合并冲突报告（analyzeConflicts 的结果；已把冲突反查到牌堆 / 卡牌 / 正反面 /
   * sheet_id / slot / source）。**只报告不选边**：merge 保持进行中的现场，由用户
   * 决定 `git checkout --ours/--theirs` 或手工合并；未尝试合并 / 干净合并时 null。
   */
  conflicts: ConflictsReport | null;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 从 unknown 错误中取人类可读描述。
 * @param err 任意抛出值
 * @returns Error 取 message，其余用 String() 兜底
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 当天 UTC 日期（YYYY-MM-DD；registry.ts 的 resolveModified 同一口径）。 */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 校验并 resolve root 入参（编程错误 → 普通 Error，仓库惯例）。
 * @param root 调用方传入的 root
 * @param fnName 函数名（错误消息用）
 * @returns resolve 后的绝对路径
 */
function assertRoot(root: unknown, fnName: string): string {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error(`${fnName} 入参无效：root 必须是非空字符串路径`);
  }
  return path.resolve(root);
}

/**
 * 校验正整数工坊 ID（编程错误 → 普通 Error）。
 * @param workshopId 待校验值
 * @param fnName 函数名（错误消息用）
 */
function assertWorkshopId(workshopId: unknown, fnName: string): void {
  if (typeof workshopId !== "number" || !Number.isSafeInteger(workshopId) || workshopId <= 0) {
    throw new Error(`${fnName} 入参无效：workshopId 必须是正整数`);
  }
}

/**
 * 同步前置检查 1-3（模块头注释"前置检查"）：工作区干净 → 有提交 → 不在 detached
 * HEAD。不是 git 仓库时 statusPorcelain 抛 GIT_NOT_A_REPO（透传）。
 * @param root 图包根（git 仓库工作树）
 * @returns 调用前所在分支名（detached 已在内部拒绝，恒非 null）
 * @throws PackError code="UPSTREAM_DIRTY_WORKTREE" 工作区有未提交 / 未跟踪条目时
 * @throws PackError code="UPSTREAM_STATE_INVALID" 无任何提交 / detached HEAD 时
 * @throws PackError code="GIT_NOT_A_REPO" / "GIT_NOT_FOUND" 等 git 层错误透传
 */
async function assertSyncableWorktree(root: string): Promise<string> {
  const entries = await statusPorcelain(root);
  if (entries.length > 0) {
    // 取前 5 条给用户定位（XY 状态 + 相对路径），多了以"…等 N 条"收尾
    const sample = entries
      .slice(0, 5)
      .map((entry) => `${entry.xy} ${entry.path}`)
      .join("；");
    const detail =
      entries.length > 5 ? `${sample}…等 ${entries.length} 条` : sample;
    throw new PackError(
      "UPSTREAM_DIRTY_WORKTREE",
      t("error.pack.upstream.dirtyWorktree", { path: root, detail }),
    );
  }
  if ((await headCommit(root)) === null) {
    throw new PackError(
      "UPSTREAM_STATE_INVALID",
      t("error.pack.upstream.stateInvalid", {
        detail: "仓库还没有任何提交，请先提交当前工作区内容（tts vcs commit）再同步上游",
      }),
    );
  }
  const branch = await currentBranch(root);
  if (branch === null) {
    throw new PackError(
      "UPSTREAM_STATE_INVALID",
      t("error.pack.upstream.stateInvalid", {
        detail: "当前处于 detached HEAD 状态，无法确定同步后要切回的分支",
      }),
    );
  }
  return branch;
}

/**
 * 同步前置检查 5：lfs 三方一致（系统 git-lfs / .gitattributes / pack.yaml）。
 * @param root 图包根
 * @throws PackError code="UPSTREAM_LFS_INCONSISTENT" 三方不一致时（message 带全部警告）
 * @throws PackError inspectLfs 的既有错误透传（LFS_ATTRIBUTES_FAILED / GIT_NOT_FOUND 等）
 */
async function assertLfsConsistent(root: string): Promise<void> {
  const inspection = await inspectLfs(root);
  if (!inspection.consistent) {
    throw new PackError(
      "UPSTREAM_LFS_INCONSISTENT",
      t("error.pack.upstream.lfsInconsistent", { detail: inspection.warnings.join("；") }),
    );
  }
}

/**
 * 判断路径存在且是普通文件（其余一律 false，不抛错）。
 * @param filePath 待判定路径
 */
async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析上游快照文件（模块头注释"快照来源"）：显式 snapshotPath 优先，其次按工坊
 * ID 到 TTS 数据目录找 Mods/Workshop/<id>.json。
 * @param opts snapshotPath / workshopId / datadir（workshopId 为 null 表示无法按 ID 探测）
 * @returns 快照文件绝对路径
 * @throws PackError code="UPSTREAM_SNAPSHOT_NOT_FOUND" 显式路径不存在 / 无工坊 ID /
 *                   所有候选目录都没有 Mods/Workshop/<id>.json / datadir 探测失败时
 */
async function resolveSnapshotFile(opts: {
  snapshotPath?: string;
  workshopId: number | null;
  datadir?: string;
}): Promise<string> {
  // —— 显式路径优先 ——
  if (opts.snapshotPath !== undefined) {
    const abs = path.resolve(opts.snapshotPath);
    if (!(await isFile(abs))) {
      throw new PackError(
        "UPSTREAM_SNAPSHOT_NOT_FOUND",
        t("error.pack.upstream.snapshotNotFound", { detail: `显式指定的快照不存在：${abs}` }),
      );
    }
    return abs;
  }

  // —— 按工坊 ID 走 TTS 数据目录 ——
  if (opts.workshopId === null) {
    throw new PackError(
      "UPSTREAM_SNAPSHOT_NOT_FOUND",
      t("error.pack.upstream.snapshotNotFound", {
        detail:
          "无法确定上游工坊 ID（.registry.yaml 条目与 pack.yaml 的 source_mod 都没有记录），也未显式指定 snapshotPath",
      }),
    );
  }

  const relative = path.join("Workshop", `${opts.workshopId}.json`);

  // 显式 datadir：只探测该目录（不碰 locateDatadir 的机器探测，测试可离线注入）
  if (opts.datadir !== undefined) {
    const modsDir = path.resolve(opts.datadir);
    const hit = path.join(modsDir, relative);
    if (await isFile(hit)) {
      return hit;
    }
    throw new PackError(
      "UPSTREAM_SNAPSHOT_NOT_FOUND",
      t("error.pack.upstream.snapshotNotFound", {
        detail: `在显式 TTS 数据目录 ${modsDir} 下没有找到 ${relative}`,
      }),
    );
  }

  // 未显式给 datadir：按 locateDatadir 的优先级探测全部候选（存在者），逐个找
  let candidates: DatadirCandidate[];
  try {
    candidates = (await locateDatadir()).candidates.filter((candidate) => candidate.exists);
  } catch (err) {
    throw new PackError(
      "UPSTREAM_SNAPSHOT_NOT_FOUND",
      t("error.pack.upstream.snapshotNotFound", {
        detail: `TTS 数据目录探测失败：${errMessage(err)}`,
      }),
    );
  }
  const searched: string[] = [];
  for (const candidate of candidates) {
    const hit = path.join(candidate.path, relative);
    if (await isFile(hit)) {
      return hit;
    }
    searched.push(hit);
  }
  throw new PackError(
    "UPSTREAM_SNAPSHOT_NOT_FOUND",
    t("error.pack.upstream.snapshotNotFound", {
      detail: `按工坊 ID ${opts.workshopId} 在以下位置都没有找到 Mods/Workshop/${opts.workshopId}.json：${
        searched.length > 0 ? searched.join("；") : "（没有探测到任何存在的 TTS 数据目录候选）"
      }`,
    }),
  );
}

/**
 * 递归复制目录。excludeTop 只作用于**本次调用的这一层**（即 src 的顶层），递归
 * 下去不再排除；符号链接等其他类型跳过（unpack 产物只有普通文件与目录）。
 * @param src 源目录
 * @param dest 目标目录（不存在时自动创建）
 * @param excludeTop 本层要跳过的条目名（null 表示不排除）
 */
async function copyDir(src: string, dest: string, excludeTop: ReadonlySet<string> | null): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (excludeTop !== null && excludeTop.has(entry.name)) {
      continue;
    }
    const source = path.join(src, entry.name);
    const target = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(source, target, null);
    } else if (entry.isFile()) {
      await copyFile(source, target);
    }
  }
}

/**
 * 自底向上删除空目录（只清"已跟踪文件被删光后"留下的空壳，让 upstream 分支的
 * 树与快照一致；目录里还有任何东西——包括被忽略的未跟踪文件——都不动）。
 * `.git` 与 `.tts` 整棵跳过；root 本身绝不删。
 * @param dir 当前目录
 * @param root 图包根（递归终止边界）
 */
async function removeEmptyDirs(dir: string, root: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 目录已不在（并发或竞态），无需处理
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git" || entry.name === ".tts") {
      continue;
    }
    await removeEmptyDirs(path.join(dir, entry.name), root);
  }
  if (dir === root) {
    return;
  }
  const rest = await readdir(dir).catch(() => ["(读取失败，按非空处理)"]);
  if (rest.length === 0) {
    await rmdir(dir).catch(() => undefined);
  }
}

/**
 * upstream 分支提交 message（固定中文模板，与 src/vcs/commit.ts 同一约定不走 t()）。
 * @param prefix "导入上游工坊快照" / "同步上游工坊快照"
 * @param workshopId 工坊 ID（null 时不带 workshop 尾注）
 */
function upstreamCommitMessage(prefix: string, workshopId: number | null): string {
  return workshopId === null ? prefix : `${prefix}（workshop ${workshopId}）`;
}

/**
 * 把快照工作区落到 upstream 分支并提交（模块头注释"内容取舍"的完整实现）：
 * 切到（新建或既有）upstream 分支 → 删除已跟踪文件（保留
 * {@link PRESERVED_REL_PATHS}，未跟踪 / 被忽略文件不受影响）→ 清空壳目录 →
 * 复制快照产物（跳过 .git / .tts）→ add -A → 有差异才 commit → 取 upstream
 * 提交 hash → 切回原分支。
 *
 * 切过去之后的任何步骤失败都会尽力 `git checkout -f` 回原分支再抛原错误
 * （`-f` 丢弃 upstream 分支上的半成品；被忽略的未跟踪文件不受影响）。
 *
 * @param root 图包根（git 仓库工作树，工作区已确认干净）
 * @param tempWorkspace unpackSave 产出的快照工作区（临时目录）
 * @param originalBranch 调用前所在分支（结束切回；就是 upstream 时跳过切回）
 * @param message 提交 message（upstreamCommitMessage 的产物）
 * @returns committed：是否产生新提交；upstreamCommit：upstream 分支当前提交 hash
 * @throws PackError code="GIT_COMMAND_FAILED" 等 git 层错误透传（恢复现场后原样上抛）
 */
async function materializeUpstreamBranch(
  root: string,
  tempWorkspace: string,
  originalBranch: string,
  message: string,
): Promise<{ committed: boolean; upstreamCommit: string }> {
  // upstream 分支是否已存在（--quiet：不存在时 exitCode 1 且无输出）
  const probe = await runGit(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${UPSTREAM_BRANCH}`],
    { cwd: root },
  );
  const branchExists = probe.exitCode === 0 && probe.stdout.trim() !== "";

  let switchedBack = false;
  try {
    await runGitOrThrow(
      branchExists ? ["checkout", UPSTREAM_BRANCH] : ["checkout", "-b", UPSTREAM_BRANCH],
      { cwd: root },
    );

    // 删除 upstream 分支上的全部已跟踪文件（保留基础设施；被忽略的未跟踪文件不动）
    const listed = await runGitOrThrow(["ls-files", "-z"], { cwd: root });
    for (const rel of listed.stdout.split("\0")) {
      if (rel === "" || PRESERVED_REL_PATHS.has(rel)) {
        continue;
      }
      // ls-files -z 输出 POSIX 相对路径，原样按 "/" 切段后再按平台拼接
      await rm(path.join(root, ...rel.split("/")), { force: true });
    }
    await removeEmptyDirs(root, root);

    // 复制快照产物（跳过 .git / .tts：约束 8，骨架存档不覆盖也不入库）
    await copyDir(tempWorkspace, root, COPY_EXCLUDED_TOP_ENTRIES);

    await runGitOrThrow(["add", "-A"], { cwd: root });

    // 快照与 upstream 分支现状一致时不产生空提交
    const staged = await statusPorcelain(root);
    let committed = false;
    if (staged.length > 0) {
      await runGitOrThrow(["commit", "-m", message], { cwd: root });
      committed = true;
    }

    const rev = await runGitOrThrow(["rev-parse", `refs/heads/${UPSTREAM_BRANCH}`], { cwd: root });
    const upstreamCommit = rev.stdout.trim();

    if (originalBranch !== UPSTREAM_BRANCH) {
      await runGitOrThrow(["checkout", originalBranch], { cwd: root });
    }
    switchedBack = true;
    return { committed, upstreamCommit };
  } catch (err) {
    if (!switchedBack) {
      // 尽力恢复现场：强制回原分支（upstream 分支上的半成品工作区被丢弃；
      // 未跟踪的被忽略文件——如 .tts/skeleton.json——不受 -f 影响）。恢复失败
      // 不掩盖原错误。
      await runGit(["checkout", "-f", originalBranch], { cwd: root }).catch(() => undefined);
    }
    throw err;
  }
}

/**
 * 把 upstream 合并回当前分支，并区分三种结局：
 * - 干净合并（含 fast-forward / already up to date）→ merged=true；
 * - 内容冲突 → **保持 merge 进行中的现场**，返回 analyzeConflicts 的报告，绝不
 *   替用户选边、绝不自动 abort（用户按提示解决后自行 git add / git commit）；
 * - 冲突以外的失败（如 unrelated histories）→ UPSTREAM_MERGE_FAILED。
 * @param root 图包根
 * @throws PackError code="UPSTREAM_MERGE_FAILED" merge 因冲突以外原因失败时
 * @throws PackError analyzeConflicts 的仓库级错误透传（GIT_* 等）
 */
async function mergeUpstreamIntoCurrentBranch(
  root: string,
): Promise<{ merged: boolean; conflicts: ConflictsReport | null }> {
  const result = await runGit(["merge", "--no-edit", UPSTREAM_BRANCH], { cwd: root });
  if (result.exitCode === 0) {
    return { merged: true, conflicts: null };
  }
  const report = await analyzeConflicts(root);
  if (report.hasConflicts) {
    return { merged: false, conflicts: report };
  }
  throw new PackError(
    "UPSTREAM_MERGE_FAILED",
    t("error.pack.upstream.mergeFailed", {
      detail: result.stderr.trim() === "" ? "(无 stderr)" : result.stderr.trim(),
    }),
  );
}

/**
 * 把本次同步事实写入 .registry.yaml 的该包条目（模块头注释"registry 读写"）：
 * upstream 刷新为 `{ workshop_id, last_synced: 今天(UTC), local_commit }`，branch
 * 刷新为调用前所在分支。条目不存在时跳过（不发明条目）；工坊 ID 无从确定且条目
 * 也没有 upstream 时同样跳过（upstream.workshop_id 必须是正整数，不写占位值）。
 * @param packsRoot packs_root（注册表所在目录）
 * @param dir 图包子目录名（注册表条目的 dir 键）
 * @param workshopId 本次解析到的工坊 ID（可为 null）
 * @param upstreamCommit upstream 分支当前提交 hash
 * @param branch 调用前所在分支
 * @throws PackError REGISTRY_* 透传（含乐观锁冲突 REGISTRY_CONFLICT）
 */
async function recordUpstreamSync(
  packsRoot: string,
  dir: string,
  workshopId: number | null,
  upstreamCommit: string,
  branch: string,
): Promise<void> {
  const entry = await findPack(packsRoot, dir);
  if (entry === null) {
    return;
  }
  const resolvedId = entry.upstream?.workshop_id ?? workshopId;
  if (typeof resolvedId !== "number" || !Number.isSafeInteger(resolvedId) || resolvedId <= 0) {
    return;
  }
  await upsertPack(packsRoot, {
    ...entry,
    branch,
    upstream: {
      workshop_id: resolvedId,
      last_synced: todayIso(),
      local_commit: upstreamCommit,
    },
  });
}

// ---------------------------------------------------------------------------
// 导出主流程
// ---------------------------------------------------------------------------

/**
 * `pack import --as-upstream`：把上游工坊快照落到 `upstream` 分支（只读快照，
 * 用于后续合并；不做合并）。
 *
 * 流程：前置检查（pack.yaml → 工作区干净 → 有提交 → 非 detached HEAD → lfs 三方
 * 一致）→ 解析快照文件（snapshotPath 优先，否则按 workshopId 找
 * Mods/Workshop/<id>.json）→ unpackSave（skipGit）拆到临时目录 → 切到（新建或
 * 既有）upstream 分支，整树替换为快照产物后提交 → 切回原分支 → 刷新
 * .registry.yaml 的 upstream 字段。upstream 分支已存在时按快照整树覆盖（该分支
 * 的语义就是"上游现状快照"）。
 *
 * @param opts 入参（见 {@link ImportUpstreamOptions}）
 * @returns 结构化结果（见 {@link UpstreamSyncResult}；mergeAttempted / merged 恒
 *   false、conflicts 恒 null——合并由用户在自己分支上按需进行）
 * @throws Error root / workshopId 编程错误（非非空字符串 / 非正整数）时
 * @throws PackError code="PACK_NOT_FOUND" / "PACK_INVALID" root 不是图包工作区时（透传）
 * @throws PackError code="UPSTREAM_DIRTY_WORKTREE" / "UPSTREAM_STATE_INVALID" /
 *                   "UPSTREAM_LFS_INCONSISTENT" / "UPSTREAM_SNAPSHOT_NOT_FOUND" 前置检查失败时
 * @throws PackError code="SAVE_INVALID" / "TTSMOD_INVALID" / "UNPACK_FAILED" 快照不合法时（unpackSave 透传）
 * @throws PackError code="REGISTRY_*" 注册表刷新失败时（git 侧成果不回滚）
 * @throws PackError git 层错误（GIT_NOT_A_REPO / GIT_NOT_FOUND / GIT_COMMAND_FAILED）透传
 */
export async function importAsUpstream(opts: ImportUpstreamOptions): Promise<UpstreamSyncResult> {
  const root = assertRoot(opts?.root, "importAsUpstream");
  assertWorkshopId(opts?.workshopId, "importAsUpstream");
  const workshopId = opts.workshopId;

  await readPackYaml(root); // 工作区合法性（PACK_NOT_FOUND / PACK_INVALID 透传）
  const originalBranch = await assertSyncableWorktree(root);
  await assertLfsConsistent(root);
  const snapshotAbs = await resolveSnapshotFile({
    snapshotPath: opts.snapshotPath,
    workshopId,
    datadir: opts.datadir,
  });

  const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), TEMP_WORKSPACE_PREFIX));
  try {
    await unpackSave({ savePath: snapshotAbs, outDir: tempWorkspace, skipGit: true });
    const { committed, upstreamCommit } = await materializeUpstreamBranch(
      root,
      tempWorkspace,
      originalBranch,
      upstreamCommitMessage("导入上游工坊快照", workshopId),
    );
    const packsRoot = path.resolve(opts.packsRoot ?? path.dirname(root));
    await recordUpstreamSync(packsRoot, path.basename(root), workshopId, upstreamCommit, originalBranch);
    return {
      snapshotPath: snapshotAbs,
      workshopId,
      branch: originalBranch,
      upstreamCommit,
      committed,
      mergeAttempted: false,
      merged: false,
      conflicts: null,
    };
  } finally {
    await rm(tempWorkspace, { recursive: true, force: true });
  }
}

/**
 * `pack sync-upstream`：拉上游新快照并 commit 到 `upstream` 分支（内容无变化则
 * 不产生新提交），然后把 `upstream` 合并回调用时所在的分支。
 *
 * 流程：前置检查（同 import，外加 `upstream` 分支必须已存在）→ 解析工坊 ID
 * （.registry.yaml 该包条目的 upstream.workshop_id，回退 pack.yaml 的 source_mod）
 * 与快照文件 → unpackSave 拆到临时目录 → upstream 分支整树替换、按需提交 →
 * 切回原分支 → `git merge upstream`（**冲突时只报告不选边**，merge 保持进行中）
 * → 刷新 .registry.yaml 的 upstream 字段（merge 冲突时同样刷新：记录的是
 * upstream 分支的事实状态）。
 *
 * @param opts 入参（见 {@link SyncUpstreamOptions}）
 * @returns 结构化结果（见 {@link UpstreamSyncResult}；conflicts 非 null 表示合并
 *   冲突待人工解决——冲突的牌堆 / 卡牌 / 正反面 / sheet_id / slot / source 见报告）
 * @throws Error root 编程错误（非非空字符串）时
 * @throws PackError code="PACK_NOT_FOUND" / "PACK_INVALID" root 不是图包工作区时（透传）
 * @throws PackError code="UPSTREAM_NOT_IMPORTED" upstream 分支不存在时
 * @throws PackError code="UPSTREAM_DIRTY_WORKTREE" / "UPSTREAM_STATE_INVALID" /
 *                   "UPSTREAM_LFS_INCONSISTENT" / "UPSTREAM_SNAPSHOT_NOT_FOUND" 前置检查失败时
 * @throws PackError code="SAVE_INVALID" / "TTSMOD_INVALID" / "UNPACK_FAILED" 快照不合法时（unpackSave 透传）
 * @throws PackError code="UPSTREAM_MERGE_FAILED" merge 因冲突以外的原因失败时
 * @throws PackError code="REGISTRY_*" 注册表刷新失败时（git 侧成果不回滚）
 * @throws PackError git 层错误（GIT_NOT_A_REPO / GIT_NOT_FOUND / GIT_COMMAND_FAILED）透传
 */
export async function syncUpstream(opts: SyncUpstreamOptions): Promise<UpstreamSyncResult> {
  const root = assertRoot(opts?.root, "syncUpstream");

  const pack = await readPackYaml(root); // 工作区合法性 + source_mod 回退来源
  const originalBranch = await assertSyncableWorktree(root);

  // upstream 分支必须已存在（import 先行；--quiet：不存在时 exitCode 1 且无输出）
  const probe = await runGit(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${UPSTREAM_BRANCH}`],
    { cwd: root },
  );
  if (!(probe.exitCode === 0 && probe.stdout.trim() !== "")) {
    throw new PackError(
      "UPSTREAM_NOT_IMPORTED",
      t("error.pack.upstream.notImported", { branch: originalBranch }),
    );
  }

  await assertLfsConsistent(root);

  // 工坊 ID：注册表条目的 upstream.workshop_id 优先，回退 pack.yaml 的 source_mod
  const packsRoot = path.resolve(opts.packsRoot ?? path.dirname(root));
  const dir = path.basename(root);
  const entry = await findPack(packsRoot, dir);
  let workshopId: number | null = entry?.upstream?.workshop_id ?? null;
  if (workshopId === null) {
    const sourceMod = pack.source_mod;
    if (typeof sourceMod === "number" && Number.isSafeInteger(sourceMod) && sourceMod > 0) {
      workshopId = sourceMod;
    }
  }

  const snapshotAbs = await resolveSnapshotFile({
    snapshotPath: opts.snapshotPath,
    workshopId,
    datadir: opts.datadir,
  });

  const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), TEMP_WORKSPACE_PREFIX));
  try {
    await unpackSave({ savePath: snapshotAbs, outDir: tempWorkspace, skipGit: true });
    const { committed, upstreamCommit } = await materializeUpstreamBranch(
      root,
      tempWorkspace,
      originalBranch,
      upstreamCommitMessage("同步上游工坊快照", workshopId),
    );

    let mergeAttempted = false;
    let merged = false;
    let conflicts: ConflictsReport | null = null;
    if (originalBranch !== UPSTREAM_BRANCH) {
      mergeAttempted = true;
      const merge = await mergeUpstreamIntoCurrentBranch(root);
      merged = merge.merged;
      conflicts = merge.conflicts;
    }

    await recordUpstreamSync(packsRoot, dir, workshopId, upstreamCommit, originalBranch);
    return {
      snapshotPath: snapshotAbs,
      workshopId,
      branch: originalBranch,
      upstreamCommit,
      committed,
      mergeAttempted,
      merged,
      conflicts,
    };
  } finally {
    await rm(tempWorkspace, { recursive: true, force: true });
  }
}
