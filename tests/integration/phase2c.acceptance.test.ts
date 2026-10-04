// tests/integration/phase2c.acceptance.test.ts
/**
 * 阶段 2C 集成验收骨架：统一管理（多图包索引）+ git 版本控制（语义化 status / commit /
 * verify / size / lfs）。
 *
 * 风格与 phase2b.acceptance.test.ts 一致，但本文件是 **Stage 3 主窗口真实验收** 的执行清单：
 * - 默认全部 `it.skip`（用例级开关，不是 describe.skip）——`npm test` 只计为 skipped，
 *   不执行、不纳入日常 CI；
 * - Stage 3 逐个删除 `.skip` 打开用例：先按用例内 TODO 装配夹具 / 构造坏样本，再跑
 *   `npx vitest run tests/integration/phase2c.acceptance.test.ts`
 *   （或 `npm run test:integration`，会同时带上 phase1 的 describe.skip）；
 * - 每个用例体只有 TODO 与一条 `todo(...)` 守卫——**故意不写成空函数体**：未实现就打开
 *   会明确失败（抛出"尚未实现"），不会给出假绿。该 `todo` 是本文件自己的抛错函数，
 *   不是 vitest 的 todo API。
 *
 * 前置条件（缺一不可）：
 * 1. 已执行 `npm run build`（测试通过 node 子进程调用 dist/cli/index.js，不是 tsx 源码）；
 * 2. 本机有 `git`（`git --version` 可跑）；lfs 相关用例还需要 `git-lfs`
 *    （`git lfs version`，本机实测 3.7.1），未装时命中 LFS_NOT_INSTALLED 分支——
 *    那本身也是一条可断言路径，但需在每个用例里显式选择断言哪一侧；
 * 3. **不需要 TTS 运行**：阶段 2C 全部命令离线（`vcs` / `pack list|status` 都不连游戏），
 *    夹具一律在 mkdtemp 临时目录内构造，绝不改仓库内文件；
 * 4. ⚠️ `pack init` 在装了 git-lfs 的机器上会执行 `git lfs install`（src/pack/init.ts:481-483），
 *    它会写用户的**全局** git 配置（filter.lfs.*）——在共享机器上跑场景 1 前先知情。
 *
 * 断言口径：
 * - CLI 进程出口 = stdout 摘要（t() 文案，单行）/ stderr 错误 / exitCode；
 *   PackError 的可观测出口是 exitCode 1 + stderr 的 `error.<CODE>` 文案
 *   （zh-CN 键见 locales/zh-CN.json）；
 * - 语义化摘要 / commit message 由 src/vcs/semantic.ts、src/vcs/commit.ts 写死中文
 *   （不走 t()），断言按这两个模块的模板，不要照抄英文键；
 * - `pack list` / `pack status` 的数据行是契约键（dir / name / stats: … / upstream.*），
 *   按原样断言稳定前缀与关键值，不整行快照——字段顺序被 fmt 调整时不应误报失败；
 * - 造 git 夹具一律用 initGitRepo 写**仓库级** user.name / user.email（CI 没有全局配置，
 *   否则 `git commit` 会以 "Please tell me who you are" 失败）；
 * - 造 cards.csv / objects.csv 一律用正式 writer（writeCardsCsv / writeObjectsCsv），
 *   不手写表头——列序见下方常量与各模块。
 *
 * 用例 ↔ 验收标准映射：
 * 1     pack init 的 lfs 分支（已装 / 未装选装 / 未装选禁 / 未装选取消） ← 约束 10「绝不静默降级」
 * 2/3   pack list / pack list --dirty 的 dirty 实测与过滤              ← 「多图包索引一眼看全」
 * 4     pack status <dir> 全字段 + 未注册报错                          ← 注册表契约 docs/schemas/registry.yaml.md
 * 5     vcs status 语义化（换图 / 脚本行数 / 素材）                     ← 「vcs status 用图包语言说话」
 * 6     vcs commit 自动中文 message + 7 位 hash                        ← 「vcs commit 自动 message」
 * 7     vcs verify 抓未解决冲突（error 走 stderr，退出码 1）            ← 「verify 合并后必跑，CI 以退出码为准」
 * 8     vcs lfs disable 二次确认 + 三方同步                            ← 约束 10 + 「lfs 三方状态一致」
 * 9     status --conflicts 二进制冲突语义化（UU → 牌堆 / 卡号）         ← 「合并冲突要能看懂是哪个牌堆的哪张卡」
 * 10    vcs size（含 lfs 对象体积）                                    ← 「改 10 轮别把仓库搞爆」
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { afterAll, describe, expect, it } from "vitest";

import { upsertPack, type PackEntry } from "../../src/pack/registry.js";

// ---------------------------------------------------------------------------
// 夹具与进程工具
// ---------------------------------------------------------------------------

/** 项目根目录：由本文件位置回推（tests/integration → 项目根）。 */
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** CLI 调用前缀：node + 已构建的入口（先 `npm run build`）。 */
const CLI = ["node", path.join(PROJECT_ROOT, "dist", "cli", "index.js")] as const;

/** runCli 的附加选项 */
interface CliRunOptions {
  /** 写入子进程 stdin 的文本（如 lfs disable 二次确认的 "yes\n"） */
  input?: string;
  /** 显式控制 stdin；"ignore" 模拟不可交互（stdin 被销毁 → 必须 --yes 而不是挂死） */
  stdin?: "ignore" | "inherit" | "pipe";
  /** 追加 / 覆盖子进程环境变量（如给 PATH 前置夹具目录） */
  env?: Record<string, string>;
}

/**
 * 运行一次 `tts` CLI。
 *
 * 统一从项目根目录启动、utf8 输出、reject:false（非 0 退出码不抛异常，集成测试显式
 * 断言 exitCode）；timeout 放宽到 60s——vcs 命令会起多个 git 子进程，
 * size / status 在大工作区或 CI 慢盘上可能超过 vitest 默认 30s。
 *
 * @param args 子命令与参数（不含 node 与入口路径）
 * @param opts 额外选项（见 {@link CliRunOptions}）
 * @returns execa 结果对象（stdout / stderr / exitCode）
 */
function runCli(args: readonly string[], opts: CliRunOptions = {}) {
  return execa(CLI[0], [...CLI.slice(1), ...args], {
    cwd: PROJECT_ROOT,
    reject: false,
    encoding: "utf8" as const,
    timeout: 60_000,
    ...opts,
  });
}

/** 本文件创建的临时工作区（mkdtemp）；afterAll 统一递归删除。 */
const tempDirs: string[] = [];

/**
 * 建临时工作区并登记清理（所有夹具都在临时目录内构造，绝不改仓库内文件）。
 * @param prefix 目录名前缀（如 "tts-phase2c-"）
 * @returns 新建临时目录的绝对路径
 */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 跑一次 git（夹具构造用；reject:false，失败不抛，便于制造 merge 冲突等非 0 场景）。
 * @param cwd 仓库目录
 * @param args git 参数（走数组，中文 / 空格安全）
 */
async function git(cwd: string, args: readonly string[]) {
  return execa("git", [...args], { cwd, reject: false, encoding: "utf8" as const });
}

/**
 * 建一个可提交的 git 仓库（init + 仓库级 user 配置）。
 *
 * 显式写本地 user.name / user.email：不依赖运行机器的全局配置，
 * 否则 CI 上 `git commit` 会以 "Please tell me who you are" 失败。
 *
 * @param dir 仓库目录（须已存在）
 * @param branch 初始分支名（缺省 main）
 */
async function initGitRepo(dir: string, branch = "main"): Promise<void> {
  await git(dir, ["init", "-q", "-b", branch]);
  await git(dir, ["config", "user.email", "phase2c@test.local"]);
  await git(dir, ["config", "user.name", "phase2c"]);
}

/**
 * 写一个文本文件（自动建父目录）——夹具构造用。
 * @param file 目标文件绝对路径
 * @param text 文本内容（utf8）
 */
async function writeText(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

/**
 * 读回文本文件（逐字节红线断言用，如"取消后 pack.yaml 未被改动"）。
 * @param file 目标文件绝对路径
 * @returns 文件内容（utf8）
 */
function readUtf8(file: string): Promise<string> {
  return readFile(file, "utf8");
}

/**
 * 写一份最小合法 pack.yaml（字段与 src/pack/packyaml.ts 的严格 schema 对齐：
 * host / vcs.lfs 必填，paths.workdir 与 upload.prefix 有默认值可省）。
 *
 * @param dir 图包根目录
 * @param name 图包显示名
 * @param lfs vcs.lfs 取值（enabled / disabled / disabled-no-lfs）
 */
async function writePackYaml(dir: string, name: string, lfs: string): Promise<void> {
  await writeText(
    path.join(dir, "pack.yaml"),
    [
      "schema_version: 1",
      `name: ${name}`,
      "workshop_id: null",
      "source_mod: null",
      "host: steamcloud",
      "vcs:",
      `  lfs: ${lfs}`,
      "paths: {}",
      "upload: {}",
      "",
    ].join("\n"),
  );
}

/**
 * 往 packs_root 的 `.registry.yaml` 注册一条图包条目（走正式 upsertPack，不手写 YAML）。
 *
 * 严格 schema：kind / host / lfs_status 的取值必须来自 src/pack/registry.ts 的枚举
 * （{ original, localization, modification } / { steamcloud, imgur, gdrive, dropbox, custom } /
 * { enabled, disabled, disabled-no-lfs }），缺键或未知键都会 REGISTRY_INVALID。
 * `modified: ""` 表示"替换时保留原值、新增时填当天 UTC 日期"（registry.ts:617-618）。
 *
 * @param packsRoot 图包索引根目录
 * @param overrides 条目字段（dir / name 必填，其余有缺省值）
 */
async function registerPack(
  packsRoot: string,
  overrides: Partial<PackEntry> & Pick<PackEntry, "dir" | "name">,
): Promise<void> {
  await upsertPack(packsRoot, {
    kind: "original",
    upstream: null,
    branch: "main",
    host: "steamcloud",
    modified: "2026-10-05",
    stats: { decks: 1, cards: 2, scripts: 3 },
    lfs_status: "disabled-no-lfs",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 骨架守卫
// ---------------------------------------------------------------------------

/**
 * 未实现就打开用例时立即失败——防止仅含注释的函数体给出"假绿"。
 * @param scenario 场景名（用于失败信息）
 */
function todo(scenario: string): never {
  throw new Error(
    `TODO(Stage 3)：${scenario} 尚未实现——请先按用例内 TODO 装配夹具与断言，再移除本守卫。`,
  );
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("阶段 2C 集成验收：统一管理 + git 版本控制", () => {
  afterAll(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.skip("场景 1：pack init lfs 三种分支（已装/未装选装/未装选禁/未装选取消）", async () => {
    // TODO(Stage 3)：lfs 决策在 src/pack/init.ts 的 decideLfs（:471-492），优先级：
    //   显式 --lfs → skipLfsPrompt → 探测 `git lfs version` → 非 TTY 降级 → TTY 三选一菜单。
    //
    // 1) 已装 git-lfs（本机 `git lfs version` 实测 3.7.1）：
    //    `tts pack init <work>/p1 --name p1` → 探测成功 → `git lfs install`
    //    （init.ts:481-483）→ exitCode 0，stdout 含 cli.pack.init.done；断言
    //    pack.yaml 的 vcs.lfs=enabled 且 .gitattributes 含 7 条 filter=lfs 规则
    //    （模板 init.ts:91-103）。⚠️ 该分支会写用户的全局 git 配置（见文件头前置条件 4）。
    // 2) 未装 git-lfs（三选一菜单，进入条件见下方硬约束）：
    //    a) 选"现在装" → 菜单的选项 1 会**再探测一次**：已装则同 1)（"enabled"）；
    //       仍未装则只打印 cli.pack.init.lfsInstallHint 并返回 "skipped"（init.ts:440-445）
    //       ——即"选装但机器上确实没有 lfs"时**不会**写 pack.yaml，CLI 以 exitCode 1 结束；
    //    b) 选"跳过（禁用）" → 二次确认（cli.pack.init.lfsDisableConfirm，输入 y/yes 才通过）→
    //       vcs.lfs=**disabled**（init.ts:447-453）。⚠️ 任务书骨架此处写 disabled-no-lfs
    //       与实现不符：disabled-no-lfs 只出现在"未装 + 非 TTY"的降级路径（init.ts:486-488）；
    //       .gitattributes 不写，exitCode 0；
    //    c) 选"取消"（输入 3 / 直接回车 / EOF）→ "skipped"：init.ts:536-539 打印
    //       cli.pack.init.lfsCancelled 后返回 packYamlWritten=false，CLI 以 exitCode 1 收尾
    //       （pack.ts:259-263）。⚠️ 此时**目录骨架与 .git 已经建好**（ensureLayout / git init
    //       在 lfs 决策之前，init.ts:524-535），.gitignore 也不会写（init.ts:562-563 在其后）
    //       ——断言应是"没有 pack.yaml / .gitattributes"，而不是"没有仓库目录"。
    //
    // ⚠️ 让菜单真正弹出来的两个硬约束（本机 Node 24.19 / win32 实测）：
    // - 菜单只在 process.stdout.isTTY === true 时进入（init.ts:486-491）；execa 管道下
    //   isTTY 为 undefined → 直接走"未装 + 非 TTY"降级（console.warn + disabled-no-lfs）。
    //   要用真实 CLI 驱动三选一需要 pty（node-pty 不是现有依赖）；否则改为在 vitest 内
    //   直接调 initPack（src/pack/init.ts:515）并 mock process.stdout.isTTY + 伪造 stdin 流。
    // - "mock PATH 让 git lfs version 成功/失败"在 Windows 上不成立：init.ts 用
    //   node:child_process 的 execFile("git", …)（init.ts:373 / 387 / 403），实测把只含
    //   git.cmd / git.bat 的目录前置到 PATH 后，execFile("git") 仍解析到真实 git.exe
    //   （只含 .cmd 的其它命令直接 ENOENT）。可行替代：(a) 显式 `--lfs enabled|disabled`
    //   （完全跳过探测，init.ts:473-475）覆盖 enabled / disabled 两分支；(b) 在 Linux CI
    //   上用可执行的 `git` shell 脚本 shim（PATH 前置）覆盖探测与 `git lfs install` 成功
    //   / 失败两侧；(c) 非交互降级路径直接跑本机真实环境。
    todo("场景 1：pack init lfs 三种分支");
  });

  it.skip("场景 2：pack list 列出多包 + dirty 状态", async () => {
    // TODO(Stage 3)：
    // 1) 在 <work>/packs 下建 3 个图包（各自 initGitRepo + writePackYaml，或直接
    //    `tts pack init <dir> --lfs disabled` 顺带覆盖 init 路径），把 pack1 / pack3
    //    的文件 add + commit 成干净工作区；
    // 2) 用 registerPack（= upsertPack，src/pack/registry.ts:626）注册 3 条，dir 必须是
    //    相对 packs_root 的一级子目录名（不允许路径分隔符，registry.ts:114-115）；
    //    注册表文件缺失时 readRegistry 容错返回空表（registry.ts:560-581），
    //    `pack list` 打 cli.pack.list.empty 并以 0 退出（pack.ts:432-435）；
    // 3) 改 pack2 的一个文件且不 commit（新增文件 "??" 同样算 dirty）；
    // 4) `tts pack list --root <work>/packs` → exitCode 0；首行 cli.pack.list.header {count}
    //    的 count=3；数据行为 `  <dir>  <name>  <branch>  <dirty>  <lfs_status>`
    //    （pack.ts:443-447）；
    // 5) dirty 列是**实测值**（逐包跑 statusPorcelain，pack.ts:195-201），不是注册表的
    //    modified 日期：pack2=true、pack1/pack3=false；非 git 仓库的条目失败降级为 "?"
    //    （probeDirty 捕异常返回 null，pack.ts:196-200）。
    todo("场景 2：pack list + dirty");
  });

  it.skip("场景 3：pack list --dirty 只显示 dirty 包", async () => {
    // TODO(Stage 3)：同场景 2 的夹具，跑 `tts pack list --dirty --root <work>/packs`：
    // - header 的 count=1，数据行只剩 pack2 一行；
    // - 过滤条件是 `row.dirty === true`（pack.ts:441）——"?"（无法判定）与 false 都被过滤，
    //   这是刻意的"宁可不显示，也不误报有改动"（pack.ts:189-190）。
    todo("场景 3：pack list --dirty");
  });

  it.skip("场景 4：pack status <dir> 显示单包详情", async () => {
    // TODO(Stage 3)：
    // 1) 用 registerPack 注册两条：一条 upstream 三项齐全（workshop_id / last_synced /
    //    local_commit），一条 upstream: null；
    // 2) `tts pack status <dir> --root <packs>` → exitCode 0，stdout 逐行给出
    //    dir / name / kind / branch / host / modified / lfs_status 与
    //    `stats: decks=… cards=… scripts=…`（字段顺序即契约，formatPackEntry，pack.ts:218-237）；
    //    upstream 非空再补 upstream.workshop_id / upstream.last_synced / upstream.local_commit
    //    三行；upstream 为 null 时恰有一行 "upstream: -"；
    // 3) 未注册的 dir → exitCode 1，stderr 为 cli.pack.status.notFound {dir}，stdout 无输出
    //    （findPack 找不到返回 null 不抛错，registry.ts:668-671；CLI 分支 pack.ts:467-471）；
    // 4) dir 含路径分隔符（如 "a/b"）→ 精确匹配必然 null → 同样 notFound
    //    （注册表里的 dir 不可能含 /，registry.ts:114-115）。
    // 备注（保留自旧骨架）：`pack open <dir>` 走同一 findPack + 未注册报错，Windows 上会
    // 真的弹资源管理器窗口，属人肉验收项，不放进本文件。
    todo("场景 4：pack status 全字段");
  });

  it.skip("场景 5：vcs status 语义化输出（混合改动）", async () => {
    // TODO(Stage 3)：夹具（git 仓库 + 初始提交，三类改动都能被反查命中）：
    // - decks/冒险牌堆/cards.csv：用 writeCardsCsv（src/deck/cards.ts:578）写两行，
    //   CardRow 的 face 分别命中 001_正面.png / 002_正面.png（列序
    //   card_id,face,back,name,nickname,sheet_id,slot,sheet_cols,sheet_rows,sheet_source，
    //   表头必须完全一致，cards.ts:121-122）；
    // - scripts/Global.lua；objects/tile_01.png + pack 根 objects.csv（writeObjectsCsv，
    //   src/deck/objects.ts:458；file 列须是相对 pack 根的 POSIX 路径 "objects/tile_01.png"，
    //   反查逻辑 semantic.ts:363-366）；
    // 1) 改两张卡图（不 commit）→ `tts vcs status --root <pack>` → exitCode 0，stdout 含
    //    「冒险牌堆 2 张卡换图（001_正面.png, 002_正面.png）」（semantic.ts:539-543；卡面文件
    //    名最多展开 5 个，>5 才在末尾补 "…"，semantic.ts:151）；
    // 2) 再改 scripts/Global.lua（追加 10 行、删 5 行，行数来自 diffNumstat）→ 含
    //    「Global 脚本 +10/-5 行」（同一 kind+subject 聚合，semantic.ts:551-552）；
    // 3) 再改 objects/tile_01.png → 含「素材 tile_01 改动」——subject 取 objects.csv 的
    //    assetId（semantic.ts:363-366 + 549-550），夹具里 assetId 要写成 "tile_01"；
    // 4) 再在 decks/ 下放一个反查不到的文件 → 降级 unknown：「其他改动（1 个文件）」，
    //    末行 cli.vcs.status.unknownNote {count}——unknownCount 统计的是**文件数**
    //    不是分组数（semantic.ts:652-654）；
    // 5) 干净工作区 → stdout 恰为 cli.vcs.status.clean，exitCode 0。
    // 备注：多条改动的输出顺序 = git status 首次出现顺序（聚合键 kind + subject，
    // semantic.ts:593-598），不要假设按类别排序。
    todo("场景 5：vcs status 语义化");
  });

  it.skip("场景 6：vcs commit 自动生成 message", async () => {
    // TODO(Stage 3)：用场景 5 的改动（三处），跑 `tts vcs commit --root <pack>`：
    // 1) exitCode 0；stdout 匹配 cli.vcs.commit.done {hash} {message}，hash 是
    //    commitHash.slice(0,7)（vcs.ts:326-331）；
    // 2) message 由 commit.ts 的 describeChange 生成（commit.ts:125-147）：
    //    「替换 冒险牌堆 2 张卡图，修改 Global 脚本（+10/-5 行），更新素材 tile_01」
    //    ——按 KIND_PRIORITY 排序（deck-cards=1 / deck-cards-csv=2 / script=3 / ui=4 /
    //    object-asset=5 / …，commit.ts:103-113），用 "，" 连接；改动超过 3 项时末尾追加
    //    「等 N 项改动」（SUMMARY_LIMIT=3，commit.ts:97 / 156-169）；
    // 3) `git log -1 --pretty=%s` 与 stdout 里的 message 逐字一致（含中文），且
    //    `git status --porcelain` 为空（autoAdd 默认 true → git add -A，commit.ts:204-214）；
    // 4) 紧接再跑一次 → stdout 为 cli.vcs.commit.clean、exitCode 0（干净工作区返回
    //    message="" 不抛错，commit.ts:190-194 + vcs.ts:318-321）。
    // 备注（保留自旧骨架）：`--dry-run` 只打印 cli.vcs.commit.dryRunMessage 且不 add /
    // 不 commit（commit.ts:200-202）；`--no-add` 只提交已暂存内容，未暂存文件留在工作区
    // （commit.ts:204-214）——两条红线可在此用例内追加断言，但注意 commander 的
    // --no-add 不能给默认值（pack 侧注释 vcs.ts:307-309）。
    todo("场景 6：vcs commit 自动 message");
  });

  it.skip("场景 7：vcs verify 抓出未解决冲突", async () => {
    // TODO(Stage 3)：
    // 1) 夹具建议让 deck 侧保持干净（如只有 scripts/，不建 decks/），这样 issues 只来自
    //    git 检查，断言不被 deck 问题污染；
    // 2) 构造真实未解决冲突：main 与 side 分支各改同一文件后 `git merge`（夹具 git() 不抛），
    //    用 `git status --porcelain` 确认 XY 含 U（isUnmergedStatus：含 U / AA / DD，
    //    verify.ts:113-115）；
    // 3) `tts vcs verify --root <pack> --skip-cmyk --skip-atlas` → exitCode 1；
    //    VCS_UNRESOLVED_CONFLICT 是 **error 级**，CLI 把它写 **stderr**（vcs.ts:366-373），
    //    断言 stderr 含 `VCS_UNRESOLVED_CONFLICT` 与「存在未解决的合并冲突」
    //    （verify.ts:132-134）；行格式 `  [error] <CODE>  <message>`；
    // 4) 同一次运行里检测到工作区非空 → stdout 含 warning 级 VCS_UNCOMMITTED
    //    「存在未提交改动」（verify.ts:129-131）；末行 cli.vcs.verify.summary 的
    //    error/warning 计数 = deck verify 计数 + git 侧计数（verify.ts:213-216）——
    //    注意合并冲突本身也计入 VCS_UNCOMMITTED，不要把 warning 数写成 0；
    // 5) 解决冲突（git add + commit）后重跑 → stderr 不再含 VCS_UNRESOLVED_CONFLICT；
    //    工作区干净且 lfs 三方一致时 exitCode 0、末行「0 错误，0 警告」；
    // 6) 可选：`--skip-git` 时 gitIssues 恒为空（verify.ts:186-187），stderr 不应含 VCS_*；
    //    非 git 仓库目录上跑也不应报错（git 检查整体跳过，verify.ts:198-201）。
    todo("场景 7：vcs verify 未解决冲突");
  });

  it.skip("场景 8：vcs lfs disable 二次确认 + 三方同步", async () => {
    // TODO(Stage 3)：
    // 1) 夹具：git 仓库 + pack.yaml（vcs.lfs=enabled）+ .gitattributes 含 lfs 规则；
    //    先跑 `tts vcs lfs status --root <pack>` 确认三方一致：stdout 三行事实
    //    （installed / attributesHasLfs / packYamlLfs）+ cli.vcs.lfs.consistent，exitCode 0
    //    （inspectLfs，src/vcs/lfs.ts:243-272；CLI vcs.ts:429-453）；
    // 2) 二次确认（约束 10，确认在 CLI 层做——disableLfs 自己不做，lfs.ts:325-337）：
    //    a) `tts vcs lfs disable`（runCli(..., { stdin: "ignore" })：stdin 被销毁 →
    //       canPrompt()=false，vcs.ts:240-242）→ stderr 为 cli.vcs.lfs.disableNeedsYes，
    //       **exitCode 1**，仓库未被改动（pack.yaml 与 .gitattributes 逐字节不变，
    //       用 readUtf8 对比调用前后）；
    //    b) 管道输入 "no\n" → stdout 含 cli.vcs.lfs.disableWarning 与 disableConfirm，
    //       随后 cli.vcs.lfs.disableCancelled，exitCode 0，仓库仍未被改动；
    //    c) 管道输入 "yes\n" → 真正执行禁用（vcs.ts:485-506）；
    // 3) 三方同步断言（disableLfs，lfs.ts:338-369）：.gitattributes 里含 filter=lfs 的行
    //    被清空（清空后只剩空行 / 注释时**整个文件被删除**）；pack.yaml 的 vcs.lfs 写为
    //    disabled；重跑 `vcs lfs status` → 三行事实 + consistent、exitCode 0；
    // 4) `--yes` 路径：`tts vcs lfs disable --yes` 不提示直接禁用（vcs.ts:487-490）；
    //    已经是 disabled 时 CLI 仍会打印 disableDone（vcs.ts:505-506 没有 alreadyDisabled
    //    分支，changed=false 只在模块返回值里）——断言时别期待"已禁用"提示。
    todo("场景 8：vcs lfs disable 二次确认");
  });

  it.skip("场景 9：二进制冲突语义化（UU + cards.csv 反查）", async () => {
    // TODO(Stage 3)：
    // 1) 夹具：decks/冒险牌堆/{cards.csv, deck.yaml, 001_正面.png}，cards.csv 用
    //    writeCardsCsv 写一行 CardID=10121（slot=21）、face=001_正面.png、sheet_id=1、
    //    name=迷路的旅人；deck.yaml 的 name / guid 决定输出里的牌堆名与 GUID
    //    （conflicts.ts:292-301：缺 deck.yaml 时 deckName 回退目录名、GUID 为空串）；
    // 2) main 与 side 两分支各改 decks/冒险牌堆/001_正面.png，side 上 git merge main
    //    制造真实 UU（不要手写冲突标记）；
    // 3) `tts vcs status --conflicts --root <pack>` → **exitCode 2**（vcs.ts:289），
    //    stdout 含 cli.vcs.status.conflictsHeader {count}，随后是 formatConflict 的多行中文。
    //    card-image 的实际模板（conflicts.ts:548-570）——按它断言，不要照抄任务书骨架：
    //      ⚠️ 卡牌图片冲突（需人工选择）        ← ⚠️ 后只有一个空格
    //      （空行）
    //      牌堆：冒险牌堆 (GUID: <deck.yaml 的 guid>)
    //      卡牌：迷路的旅人 (CardID: 10121)     ← cards.csv 的 name 列；为空则只打 (CardID: …)
    //      文件：decks/冒险牌堆/001_正面.png（正面）
    //      所属图集：sheet_id=1, slot=21
    //      源 URL：<cards.csv 的 sheet_source>
    //      （空行）
    //      冲突类型：双方都修改 (UU)
    //      （空行）
    //      选择：
    //        git checkout --ours   <path>   # 保留当前分支版本
    //        git checkout --theirs <path>   # 用对方分支版本
    //        或手动用图像工具合成后 git add
    //    （任务书骨架的示例缺少「源 URL」「冲突类型」「选择」三行与空行，以模块模板为准。）
    // 4) 追加构造：让 cards.csv 本身也冲突 → stdout 末尾补一行
    //    cli.vcs.status.cardsCsvWarning（vcs.ts:285-287），该条冲突的模板额外提示
    //    "必须最先解决"（conflicts.ts:573-591）；
    // 5) 反例：工作区干净 + --conflicts → 只打 clean、exitCode 0（不预检冲突，vcs.ts:263-265）。
    todo("场景 9：二进制冲突语义化");
  });

  it.skip("场景 10：vcs size lfs 启用时同时报工作区体积和 lfs 体积", async () => {
    // TODO(Stage 3)：
    // 1) 夹具：git 仓库 + pack.yaml（vcs.lfs=enabled）+ .gitattributes 含 filter=lfs 规则，
    //    在 pack 根放 1 个 5 MB 随机文件、decks/ 下放 1 个 1 MB 文件；让
    //    `.git/lfs/objects/` 非空（lfs 已装时 add 一个 png 会生成真实对象；
    //    analyzeSize 只做目录统计、不解析 lfs 指针，必要时可手工建目录与文件）；
    // 2) `tts vcs size --root <pack>` → exitCode 0；stdout 依次为
    //    cli.vcs.size.workspace {bytes} / cli.vcs.size.git {bytes}，以及**仅 lfsEnabled 时**
    //    的 cli.vcs.size.lfsObjects {bytes}（src/vcs/size.ts:57-68；CLI vcs.ts:401-405）；
    //    lfsEnabled 的判据是 .gitattributes 是否含 filter=lfs（size.ts:66-67 / 80-81），
    //    不是 pack.yaml；
    // 3) cli.vcs.size.breakdownHeader 之后每行 `  <dir>  <bytes>  <fileCount>`，按 bytes
    //    降序（analyzeSize 已排序，size.ts:64-65，CLI 不重排）；dir 集合含 "."（pack 根
    //    散文件桶，size.ts:98）与 "decks"；workspaceBytes 恒等于各桶之和（size.ts:57-59），
    //    lfsObjectsBytes 包含在 gitBytes 内（size.ts:60-63）；
    // 4) formatBytes 口径（vcs.ts:148-155）：<1 KB 打 "N B"（如 "512 B"），
    //    其余按 1024 进制两位小数（如 "1.50 MB"）；
    // 5) 反例：.gitattributes 无 lfs 规则时 lfsEnabled=false，**不打** lfsObjects 行。
    todo("场景 10：vcs size");
  });
});
