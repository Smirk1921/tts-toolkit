// tests/integration/phase5.acceptance.test.ts
/**
 * 阶段 5 集成验收骨架：写入路径（push 流水线 + baseline + 备份 + watch + 离线回路）。
 *
 * 对照《施工流程》阶段 5「验收标准」（10 个场景，顺序与任务书一致）与窗口 E 契约文档
 * （docs/schemas/baseline.json.md；README §11 是使用方视角的同一份事实）。
 *
 * 风格与 phase2b / phase2c / phase3 / phase4 一致，但本文件是 **Stage 5 主窗口真实验收**
 * 的执行清单：
 * - 默认全部 `it.skip`（用例级开关，不是 describe.skip）——`npm test` 只计为 skipped，
 *   不执行、不纳入日常 CI；
 * - Stage 5 逐个删除 `.skip` 打开用例：先按用例内 TODO 装配夹具 / 构造坏样本，再跑
 *   `npx vitest run tests/integration/phase5.acceptance.test.ts`
 *   （或 `npm run test:integration`，会同时带上 phase1 的 describe.skip）；
 * - 每个用例体只有 TODO 与一条 `todo(...)` 守卫——**故意不写成空函数体**：未实现就
 *   打开会明确失败（抛出"尚未实现"），不会给出假绿。该 `todo` 是本文件自己的抛错
 *   函数，不是 vitest 的 todo API。
 *
 * 前置条件（缺一不可）：
 * 1. 已执行 `npm run build`（测试通过 node 子进程调用 dist/cli/index.js，不是 tsx 源码）；
 * 2. **场景 1 全离线**（不需要 TTS）；**场景 2-9 需要 TTS 运行中且已加载目标存档**
 *    （39999 可达；独立模式还要 39998 空闲）；**场景 10 需要 30 秒以上的稳定窗口**；
 * 3. 测试自身**不改仓库内文件、不改用户全局配置**：夹具一律在 mkdtemp 临时目录内
 *    构造（工作区用 `tts pack init` / `tts pack unpack` 现建，脚本内容用 `tts pull`
 *    或直接写文件）；长驻子进程（watch / hub）必须在 afterAll 或用例 finally 中收
 *    干净，绝不留下占用 39998 / 39995 的孤儿进程；
 * 4. 端口口径与 phase4 相同：独立 push 会临时独占 39998 用完即放；hub 在线时改走
 *    `POST /v1/push` 委托（hub 进程持有 39998，坑 17 注入 server、绝不二次绑定——
 *    src/hub/control.ts:1087）。涉及 hub 委托的分支要么先起 hub，要么 console.warn
 *    后跳过，不伪造成功。
 *
 * 断言口径：
 * - CLI 进程出口 = stdout 摘要（t() 文案，单行）/ stderr 错误 / exitCode；文案键以
 *   locales/zh-CN.json 为准（`cli.pack.push.*` / `cli.watch.*` / `error.push.*`），
 *   断言用"包含键对应文案的稳定片段"而不是整行（{placeholder} 值随路径 / 计数变化）；
 * - `push` 的实写门是 `--yes`（dryRun = !yes，src/cli/commands/pack.ts:648）：dry-run
 *   路径**不备份、不确认、不发送、不写 baseline**（src/pack/push.ts:681-690）；
 * - baseline.json 断言的唯一口径是 `readBaseline(root)`（src/safety/baseline.ts:458），
 *   不手写 JSON 夹具；落盘要求 2 空格缩进 JSON + 末尾换行（同 :351-362）；
 * - 备份断言：`<root>/.tts/backups/<时间戳>/`（scripts/ + ui/ + manifest.json），
 *   manifest 用 `listBackups(root)` 读（src/safety/backup.ts:513）；
 * - "零副作用"用逐字节比较（`Buffer.compare` / `equals`）：原样回写要求游戏侧内容与
 *   回写前逐字节一致，不做 JSON 语义归一化（换行归一化只用于"无变化"判定，不用于
 *   副作用断言）；
 * - push 拦截类场景（场景 7 / 9）断言 exitCode 1 + stderr 含对应错误码文案
 *   （PUSH_ASSET_CHANGES_DETECTED / BASELINE_CONFLICT）与冲突对象名，不解析整行；
 * - hub 响应体形（场景 3 / 4 / 8 / 9 的委托分支）：`{ok:true, dryRun, pushed, skipped,
 *   items(=pushed+skipped), backupDir?, baselineConflicts?, assetChanges?}`（契约见
 *   docs/schemas/hub-control.md §4.11）。
 *
 * 用例 ↔ 验收标准映射（10 个场景）：
 * 1     离线 build→unpack 回路不破坏约束 8（骨架逐字节 / 定点替换）
 * 2     pull 自动写 baseline.json（entries / assetFiles / updatedAt）
 * 3     push --dry-run 报告差异但不写不备（无新备份，baseline 原样）
 * 4     push --yes 完整流程：备份→基线校验→发送→回读→更新 baseline
 * 5     push 原样回写零副作用（拉回与回写前逐字节一致；不可跳步）
 * 6     真实修改一脚本 → marker print 确认生效
 * 7     push 检测素材改动（cards.csv 改一行）→ 拒绝
 * 8     push --force-scripts-only 绕过素材检测
 * 9     基线冲突：游戏内手动改脚本 → push 拒绝并指出冲突对象
 * 10    watch 模式 30 秒实跑（改一脚本 → 自动 push）
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { afterAll, describe, it } from "vitest";

import { listBackups, type BackupManifest } from "../../src/safety/backup.js";
import { readBaseline, type Baseline } from "../../src/safety/baseline.js";

// ---------------------------------------------------------------------------
// 夹具与进程工具
// ---------------------------------------------------------------------------

/** 项目根目录：由本文件位置回推（tests/integration → 项目根）。 */
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** CLI 入口（先 `npm run build`）。 */
const CLI_ENTRY = path.join(PROJECT_ROOT, "dist", "cli", "index.js");

/** 本文件创建的临时工作区（mkdtemp）；afterAll 统一递归删除。 */
const tempDirs: string[] = [];

/**
 * 建临时工作区并登记清理（所有夹具都在临时目录内构造，绝不改仓库内文件）。
 * @param prefix 目录名前缀（如 "tts-phase5-"）
 * @returns 新建临时目录的绝对路径
 */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 运行一次 `tts` CLI（前台、等到退出）。
 *
 * 统一从项目根目录启动、utf8 输出、reject:false（非 0 退出码不抛异常，集成测试显式
 * 断言 exitCode）。
 *
 * @param args 子命令与参数（不含 node 与入口路径）
 * @param opts 额外选项（cwd / timeout 等覆盖项）
 * @returns execa 结果对象（stdout / stderr / exitCode）
 */
function runCli(args: readonly string[], opts: { timeout?: number; cwd?: string } = {}) {
  return execa("node", [CLI_ENTRY, ...args], {
    cwd: PROJECT_ROOT,
    reject: false,
    encoding: "utf8" as const,
    timeout: opts.timeout ?? 120_000,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
}

/**
 * 读 `<root>/.tts/baseline.json`（缺失 / 损坏返回 null；断言口径与实现一致）。
 * @param root 图包工作区根目录
 * @returns 基线对象或 null
 */
async function readBaselineFile(root: string): Promise<Baseline | null> {
  return readBaseline(root);
}

/**
 * 读备份清单（按 createdAt 新→旧；只认 manifest.json 可解析的有效备份）。
 * @param root 图包工作区根目录
 * @returns 备份 manifest 列表
 */
async function readBackups(root: string): Promise<BackupManifest[]> {
  return listBackups(root);
}

/**
 * 读文件原始字节（逐字节比较用，不做任何归一化）。
 * @param filePath 文件完整路径
 * @returns 文件内容 Buffer
 */
async function readBytes(filePath: string): Promise<Buffer> {
  return readFile(filePath);
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
    `TODO(Stage 5)：${scenario} 尚未实现——请先按用例内 TODO 装配夹具与断言，再移除本守卫。`,
  );
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("阶段 5 集成验收：写入路径（push / baseline / backup / watch / 离线回路）", () => {
  afterAll(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.skip("场景 1：离线 build→unpack 回路不破坏约束 8", async () => {
    // TODO(Stage 5)（全离线；不需要 TTS、不需要端口）：
    // 1) 夹具：makeTempDir 建临时目录，用已有 .ttsmod / 存档 JSON 样本（或最小手工
    //    存档：ObjectStates 数组 + 一个带 LuaScript 的对象）跑
    //    `tts pack unpack <save> --out <ws>`；断言 `.tts/skeleton.json` 存在且为
    //    原始存档的 2 空格 JSON（约束 8 的定点替换基准，src/pack/unpack.ts:20-24）；
    // 2) 基准：不改工作区直接 `tts pack build --root <ws> --dry-run` 与实写各一次，
    //    实写输出（默认 <ws>/dist/*.json，src/pack/build.ts:64-67）应与骨架**逐字节
    //    一致**（Buffer.compare）——这是约束 8「未改动部分逐字节保持」的最强断言；
    // 3) 改动：在 <ws>/scripts/Global.lua 追加一行（如 `-- phase5-offline-marker`）
    //    再 build，断言输出仍是 2 空格 JSON、对应节点的 LuaScript 已定点替换、
    //    其余对象与骨架深比较相等（JSON.parse 后 deep-equal，忽略被替换字段）；
    // 4) 回路闭合：对 build 输出再跑一次 `tts pack unpack <输出> --out <ws2>`，
    //    断言 <ws2>/scripts/Global.lua 含 marker——离线回路（约束 8）在阶段 5 后
    //    仍然成立，且 build 绝不触碰 `.tts/baseline.json` / `.tts/backups`
    //    （对照拉取 baseline 快照：build 前后文件不存在 / 字节不变）；
    // 5) 对照约束 7：本场景不经过 push；素材改动只能走本离线回路（场景 7 / 8 验证
    //    push 侧拦截），此处只断言 build 不读不写任何素材 URL（可选：断言输出中
    //    CustomDeck / CustomImage 与原存档逐字节一致）。
    todo("场景 1：离线 build→unpack 回路");
  });

  it.skip("场景 2：pull 自动写 baseline.json", async () => {
    // TODO(Stage 5)（需要 TTS；独立模式要 39998 空闲，或先起 hub 走委托）：
    // 1) 夹具：makeTempDir + `tts pack init <dir>`（或对场景 1 的工作区直接复用）；
    //    记录 pull 前 `.tts/baseline.json`（应不存在或为旧值）；
    // 2) `tts pack pull --root <ws>`（或顶层 `tts pull <ws>`）→ exitCode 0；
    //    断言 `<ws>/.tts/baseline.json` 已生成（src/pack/pull.ts:391 的 writeBaseline）；
    // 3) 结构断言（用 readBaselineFile，不手写 JSON）：
    //    - version === 1、packRoot === path.resolve(ws)、updatedAt 可被 Date.parse；
    //    - entries 与本次 getScripts 快照一一对应：guid / name（Global 固定 "Global"，
    //      其余 sanitizeName）；scriptHash / uiHash 与落盘文件内容按「CRLF/CR→LF +
    //      trimEnd 后 sha256」重算一致（归一化口径见 src/pack/diff.ts:320；baseline 直接导入同一份）；
    //    - assetFiles 的 key 为 `decks/<卡堆>/cards.csv` / `deck.yaml` /
    //      `objects/objects.csv`（相对 root 正斜杠），hash 为 64 位小写 hex；
    //    - 首次 pull 无 lastPushAt；若先做过成功 push 再 pull，则 lastPushAt 保留
    //      （writeBaseline 只保留不设置，src/safety/baseline.ts:533-546）；
    // 4) 幂等：连续两次 pull（无游戏侧改动）→ entries / assetFiles 不变，updatedAt
    //    更新（内容相同不等于跳过写盘）；
    // 5) hub 委托分支（可选，需 39995）：起 hub 后再跑 `tts pack pull`，断言落盘与
    //    baseline 与独立模式一致（hub 委托同样在 hub 进程内调 pullFromGame）。
    todo("场景 2：pull 自动写 baseline.json");
  });

  it.skip("场景 3：push --dry-run 报告差异但不写不备", async () => {
    // TODO(Stage 5)（需要 TTS；先用场景 2 的 pull 建好 baseline 与工作区）：
    // 1) 夹具：pull 后改动一个脚本（追加一行）——制造 1 个 pushed；记录前态：
    //    baseline.json 原始字节、`.tts/backups` 目录清单（readBackups）、游戏侧快照
    //    （hub /v1/push 前先 GET /v1/status 或再 pull 一次比对）；
    // 2) `tts pack push --root <ws>`（默认 dry-run；显式 `--dry-run` 等价）→ exitCode 0；
    //    stdout 含 `cli.pack.push.dryRunSummary` 文案片段（含 pushed / skipped 两个数）；
    //    断言 pushed=1、skipped=未改动对象数（src/pack/push.ts:681-690）；
    // 3) **不写不备**：`.tts/backups` 无新增目录（readBackups 长度不变）、baseline.json
    //    字节不变、游戏侧脚本 / UI 逐字节不变（再 getScripts / pull 到第二个临时目录
    //    比较 Buffer）；
    // 4) 差异报告本身可用：`tts pack diff --root <ws> --unified` 应列出该脚本为
    //    modified 并附逐行 hunks（本地行带 `- ` 前缀，src/cli/commands/pack.ts:307-326），
    //    证明 dry-run 基于真实差异，而不是空报告；
    // 5) hub 委托分支（可选）：hub 在线时 `tts pack push` 走 `POST /v1/push`，body
    //    含 dryRun:true，响应 `{ok:true, dryRun:true, pushed, skipped, items}` 且
    //    **不携带 backupDir**（dry-run 不备份）。
    todo("场景 3：push --dry-run");
  });

  it.skip("场景 4：push --yes 完整流程：备份→基线校验→发送→回读→更新 baseline", async () => {
    // TODO(Stage 5)（需要 TTS；这是本阶段的主验收场景，逐步断言不许跳步）：
    // 1) 夹具：pull 建 baseline → 改一个脚本（记录改后内容）；
    // 2) `tts pack push --root <ws> --yes` → exitCode 0；stdout 含
    //    `cli.pack.push.pushedSummary` {pushed}{skipped}{backupDir}；backupDir 非 "-"；
    // 3) 备份断言：readBackups(ws) 新增 1 条，manifest.reason === "push"、
    //    timestamp 与目录名一致、scripts/ + ui/ 文件名与 pull 命名规则一致；
    //    备份内容 = **push 前**的游戏侧快照（改动前的内容，src/pack/push.ts:693-702
    //    在 confirm 之前、saveAndPlay 之前执行）；
    // 4) 发送 / 回读：pushed 数 = 有变化对象数；push 后 pull 到第二个临时目录，
    //    与被推送的本地内容逐字节一致（回读校验已由 pushSaveAndPlay 做，
    //    这里做端到端复核；不一致时实现会抛 PUSH_VERIFY_FAILED，src/pack/push.ts:716-720）；
    // 5) baseline 更新：readBaselineFile 的 entries 对应 hash === 回读快照 hash、
    //    lastPushAt 为 ISO 且 >= 本次开始时刻、updatedAt 更新（src/pack/push.ts:723-724）；
    // 6) 对照：同一夹具改第二个脚本后加 `--no-backup` 再 push → pushedSummary 的
    //    backupDir 为 "-"，readBackups 不再新增；baseline 照常更新；
    // 7) hub 委托分支（可选）：hub 在线时同场景走 /v1/push（confirm:true），响应
    //    `{ok:true, dryRun:false, pushed, skipped, items, backupDir}`，items =
    //    pushed + skipped（docs/schemas/hub-control.md §4.11）。
    todo("场景 4：push --yes 完整流程");
  });

  it.skip("场景 5：push 原样回写零副作用（不可跳步）", async () => {
    // TODO(Stage 5)（需要 TTS；对应 e2e 第 5 步的"不可跳步"口径）：
    // 1) 夹具：pull 到临时工作区后**不改任何文件**；记录 scripts/ + ui/ 全部文件字节、
    //    `.tts/baseline.json` 字节、游戏侧快照（再 pull 到第二个临时目录做基准）；
    // 2) `tts pack push --root <ws>`（dry-run）→ stdout 摘要 pushed=0 / skipped=全部
    //    对象（无变化过滤，src/pack/push.ts:550-605）；
    // 3) `tts pack push --root <ws> --yes` → exitCode 0，pushed=0；
    // 4) 零副作用断言（逐字节，不做 JSON 归一化）：
    //    - 游戏侧脚本 / UI 与步骤 1 的基准逐字节一致（push 发送的是"无变化对象全部
    //      剔除后的空集合 + 原样补齐内容"，不得引入换行 / 结尾空白变化）；
    //    - 工作区 scripts/ + ui/ 文件字节不变；
    //    - `.tts/baseline.json` 只有 updatedAt / lastPushAt 变化（entries / assetFiles
    //      深比较相等）——成功 push 更新基线是**设计语义**，不算副作用；
    // 5) 不可跳步反证：步骤 3 即使 pushed=0 也必须完成 备份 → 确认 → saveAndPlay →
    //    回读 → 更新 baseline 全链路（备份目录新增 + lastPushAt 更新即为证据）；
    //    对照 `--no-backup` 不产生备份目录。
    todo("场景 5：push 原样回写零副作用");
  });

  it.skip("场景 6：真实修改一脚本 → marker print 确认生效", async () => {
    // TODO(Stage 5)（需要 TTS + hub 事件通道；用可观测的 print 闭环）：
    // 1) 夹具：pull 后改动 Global.lua（追加 `print("[phase5-marker] <随机串>")`）——
    //    Save & Play 会重载存档并执行全局脚本，print 以入站 messageID 2（Print）回来；
    // 2) 订阅事件：起 hub 后连 `GET /v1/events`（SSE）或 `127.0.0.1:39997`（TCP 扇出），
    //    先确认通道活（SSE 首帧 `:connected`）；再 `tts pack push --root <ws> --yes`；
    // 3) 断言在超时窗口内收到 `data: {"messageID":2,...}` 且 message 含该随机 marker
    //    ——证明脚本真的在游戏内执行，而不是只落盘 / 只进回读快照；
    // 4) 反证：push 前通道不应出现该 marker（订阅先于 push，用随机串保证不被历史
    //    消息污染）；push 后 `tts pack pull` 拉回的 Global.lua 含 marker；
    // 5) 收尾：关闭 SSE / TCP 连接与 hub；把所有改动恢复（重新 pull 或删除临时工作区，
    //    绝不把 marker 留在用户存档里——若本次 push 已改游戏侧，必须再 push 一次
    //    恢复原文并断言 marker 消失）。
    todo("场景 6：marker print 确认生效");
  });

  it.skip("场景 7：push 检测素材改动（cards.csv 改一行）→ 拒绝", async () => {
    // TODO(Stage 5)（需要 TTS；先用场景 2 的 pull 建好 baseline）：
    // 1) 夹具：选 `<ws>/decks/<卡堆>/cards.csv` 真改一行（如改一个 card_id 或
    //    nickname 字段）；同时改一个脚本（证明拒绝来自素材检测而不是"无变化"）；
    //    记录游戏侧快照与 baseline 字节；
    // 2) `tts pack push --root <ws> --yes` → exitCode 1；stderr 含
    //    `error.push.assetChangesDetected` 文案片段 + 被改文件相对路径 + 四步修复
    //    引导（assets upload → pack build → 加载存档 → 再 push）与
    //    `--force-scripts-only` 提示（src/pack/push.ts:661-666）；
    // 3) **拒绝要彻底**：游戏侧逐字节不变（重新 pull 比对）、`.tts/backups` 无新增
    //    （素材检测在备份之前）、baseline.json 字节不变；
    // 4) 边界对照（内容 hash 口径，src/pack/diff.ts:320）：只把 cards.csv
    //    换行改成 CRLF（内容归一化后等价）→ 不应拦截；改回真改一行 → 拦截；
    // 5) 首跑口径：删除 `.tts/baseline.json` 后（无基线）所有素材都算 added →
    //    同样拦截（src/safety/baseline.ts:647-649）；
    // 6) hub 委托分支（可选）：POST /v1/push 返回 400 `HUB_PACK_ERROR` +
    //    `details.packCode === "PUSH_ASSET_CHANGES_DETECTED"`。
    todo("场景 7：素材改动拒绝");
  });

  it.skip("场景 8：push --force-scripts-only 绕过素材检测", async () => {
    // TODO(Stage 5)（需要 TTS；夹具与场景 7 相同——cards.csv 改一行 + 脚本改一行）：
    // 1) `tts pack push --root <ws> --yes --force-scripts-only` → exitCode 0；
    //    脚本改动生效（push 后 pull 比对），且本次**不再**抛 PUSH_ASSET_CHANGES_DETECTED；
    // 2) 素材改动被如实记录：CLI 摘要不打印 assetChanges，改用 hub /v1/push 分支
    //    （或直接调 pushSaveAndPlay）断言结果携带 `assetChanges.changed` 含该文件
    //    （src/pack/push.ts:659-666 / :726-733）；
    // 3) 约束 7 的正向证据：游戏侧素材引用（CustomDeck / CustomImage URL）逐字节不变
    //    ——push 协议只收 scriptStates，素材改动永远不会被 push 带到游戏里；
    // 4) baseline 语义：成功 push 后用**回读快照 + 当前磁盘素材 hash** 重写基线
    //    （src/pack/push.ts:723），因此再次 push（不带 --force-scripts-only）时
    //    同一素材改动不再拦截——断言第二次 push 成功；
    // 5) 对照：不带 --force-scripts-only 的同夹具必拒（复用场景 7 断言，证明旗标是
    //    唯一放行条件，不是检测失效）。
    todo("场景 8：--force-scripts-only 绕过");
  });

  it.skip("场景 9：基线冲突：游戏内手动改脚本 → push 拒绝并指出冲突对象", async () => {
    // TODO(Stage 5)（需要 TTS；模拟"别人改了游戏内脚本"）：
    // 1) 夹具：pull 建 baseline；用**绕过基线的通路**改游戏侧一个对象脚本：
    //    经 hub `POST /v1/scripts/save-and-play` 直接写一份不同内容（或 `tts exec`
    //    修改目标对象的 LuaScript 后保存），随后确认游戏侧 hash 与基线不一致；
    // 2) `tts pack push --root <ws> --yes` → exitCode 1；stderr 含
    //    `error.push.baselineConflict` 文案 + 冲突对象名 / guid / kind 与两侧 hash
    //    前 12 位（前 10 条，src/pack/push.ts:668-675 / :534-543）；
    // 3) **拒绝要彻底**：游戏侧与工作区都不变、`.tts/backups` 无新增（基线检测在备份
    //    之前）、baseline.json 字节不变；随后 `tts pack pull` 对账后冲突消失；
    // 4) 冲突方向覆盖（单元级规则见 docs/schemas/baseline.json.md §9）：基线有 / 远端
    //    整 guid 缺失也算冲突；远端新增 guid 不算冲突；CRLF 差异不算冲突；
    // 5) `--no-baseline-check` 放行：响应 / 结果携带 `baselineConflicts`（CLI 摘要不
    //    打印，用 hub /v1/push 或直接调 pushSaveAndPlay 断言）且本次写入成功——
    //    证明旗标只跳过检测、不篡改记录；
    // 6) 收尾：恢复游戏侧原始内容（重新 pull + push 或直接 save-and-play 原文），
    //    避免污染用户存档。
    todo("场景 9：基线冲突拒绝");
  });

  it.skip("场景 10：watch 模式 30 秒实跑（改一脚本 → 自动 push）", async () => {
    // TODO(Stage 5)（需要 TTS；用例自身 timeout 需放宽到 >= 60s——开启时给 it.skip
    // 传第三个参数 { timeout: 60_000 } 或改用 it.skip(..., { timeout }, fn) 形状）：
    // 1) 夹具：pull 建 baseline；后台 spawn `node dist/cli/index.js watch <ws> --yes
    //    --debounce 300`（stdout 接线累积文本）；等 stdout 出现 `cli.watch.started`
    //    （含 root 与 dryRun:false）与 `cli.watch.watching`（src/cli/commands/watch.ts:294-295）；
    // 2) 触发：改一个脚本（追加 marker 行）→ 等 stdout 出现 `cli.watch.pushOk`
    //    {pushed}{skipped}{backupDir}（防抖 300ms 后自动 push，:304-314 / :344-356）；
    // 3) 断言：游戏侧生效（push 后 pull 比对 / SSE marker）、`.tts/backups` 新增 1 条、
    //    baseline 的 lastPushAt 更新；连续快速改两次只应触发一轮 push 或"最后一轮不丢"
    //    （重入 rerun 语义，:320-368）；
    // 4) dry-run 对照：另起 `watch <ws>`（不带 --yes）改脚本 → stdout 只出现
    //    `cli.watch.dryRunSummary`，无新备份、游戏侧不变；
    // 5) hub 在线分支（可选，需 39995）：起 hub 后再 watch，stdout 含 `cli.watch.viaHub`，
    //    且 dryRun 回显与请求一致（不一致走 cli.watch.dryRunMismatch，:339-343）；
    // 6) 收尾：Windows 下无 POSIX 信号语义，`child.kill("SIGINT")` 不保证走
    //    `cli.watch.stopped` 优雅分支（phase4 场景 10 同款注意）——优先断言进程退出与
    //    39998 无残留（checkExclusive），强杀可接受（watch 无状态，备份 / 回读已保证
    //    安全）；然后恢复游戏侧脚本。
    todo("场景 10：watch 自动 push");
  });
});
