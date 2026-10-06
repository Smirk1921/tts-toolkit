// tests/integration/phase3.acceptance.test.ts
/**
 * 阶段 3 集成验收骨架：素材导入（import.yaml）+ 图床（host / assets upload / fetch / migrate）
 * + 打包分发（.ttsmod 导出导入 / 上游同步）+ 审批门禁（review gate）。
 *
 * 对照《施工流程》阶段 3「验收标准」（施工流程.md:535-558）与窗口 C 契约文档
 * （docs/schemas/import.yaml.md、docs/schemas/host.md、docs/schemas/ttsmod.md）。
 *
 * 风格与 phase2b / phase2c 一致，但本文件是 **Stage 3 主窗口真实验收** 的执行清单：
 * - 默认全部 `it.skip`（用例级开关，不是 describe.skip）——`npm test` 只计为 skipped，
 *   不执行、不纳入日常 CI；
 * - Stage 3 逐个删除 `.skip` 打开用例：先按用例内 TODO 装配夹具 / 构造坏样本，再跑
 *   `npx vitest run tests/integration/phase3.acceptance.test.ts`
 *   （或 `npm run test:integration`，会同时带上 phase1 的 describe.skip）；
 * - 每个用例体只有 TODO 与一条 `todo(...)` 守卫——**故意不写成空函数体**：未实现就打开
 *   会明确失败（抛出"尚未实现"），不会给出假绿。该 `todo` 是本文件自己的抛错函数，
 *   不是 vitest 的 todo API。
 *
 * 前置条件（缺一不可）：
 * 1. 已执行 `npm run build`（测试通过 node 子进程调用 dist/cli/index.js，不是 tsx 源码）；
 * 2. **场景 1-4、6-9、11、12 完全离线**：夹具一律在 mkdtemp 临时目录内构造，不连 TTS、
 *    不改仓库内文件；
 * 3. **场景 5（migrate）与场景 12 的 `review status` 需要额外条件**：migrate 的源素材
 *    要真实下载（HTTP），且 `tts migrate --to <id>` / `assets upload` 的图床必须由
 *    **真实全局配置**（`%APPDATA%\tts-toolkit\config.yaml` 的 `hosts`）声明——CLI 没有
 *    `--config` 覆盖入口（`src/host/command.ts:363-366` 的默认路径；`resolveHost` 只认
 *    `listHosts()` 的结果）。测试自身**不修改用户全局配置**：场景 5/10 在配置里找不到
 *    可用图床时应 `console.warn` 后跳过对应断言，而不是写用户的配置；
 * 4. 场景 8 需要 3 份第三方真实样本（s_dial.ttsmod / s_hex.ttsmod /
 *    sample_diceset.ttsmod，仓库不自带）；场景 9 需要 `git`；场景 12 的 `status`
 *    需要审批工具仓库（含 agent.py）或运行中的审批服务（gate 本身只读文件，不需要）。
 *
 * 断言口径：
 * - CLI 进程出口 = stdout 摘要（t() 文案，单行）/ stderr 错误 / exitCode；
 *   PackError 的可观测出口是 exitCode 1 + stderr 的 `error.<CODE>` 文案
 *   （zh-CN 键见 locales/zh-CN.json，如 IMPORT_FILE_MISSING 在 error 段）；
 * - `.ttsmod` 是 ZIP：布局断言用 `readZip`（src/archive/ttsmod.ts），**不要调外部 unzip**
 *   ——Windows 环境不保证有 unzip，且 readZip 就是本工具的读取契约本身；
 * - 存档 JSON 的"逐字节原样"用 Buffer 比较（`Buffer.compare` / `equals`），不做 JSON 语义
 *   归一化——自包含原理依赖 URL 一个字不改；
 * - 图片夹具用 sharp 现场生成（与 phase2b 同一约定），CMYK 坏样本的造法见场景 2 TODO；
 * - cards.csv / objects.csv 一律用正式 writer 读写（writeCardsCsv / readCardsCsv /
 *   readObjectsCsv），不手写表头。
 *
 * 用例 ↔ 验收标准映射：
 * 1     import --dry-run / 实落盘                 ← 「正确预览归位结果，不落盘」「落盘，结构与 deck.yaml 一致」
 * 2     坏清单报错（缺文件 / CMYK / schema）      ← 「明确报错（缺文件 / CMYK / 网格超容量）」
 * 3     host list（内置 / 配置 / 插件）            ← 「列出可用图床，标出默认」
 * 4     host check（骨架 + 台账两来源，死链门禁）  ← 「全量素材存活检测，报告死链」
 * 5     migrate --to（递归改写无遗漏）             ← 「迁移后 URL 全部更新，且递归无遗漏」
 * 6     pack export 布局与自包含                   ← 「用 unzip 检查布局」「Mod Vault 能导入」（后者人肉）
 * 7     扩展名推导三兜底 / 全失败告警              ← 「必须能推导出来」「必须告警并列出，不能静默跳过」
 * 8     pack import 真实样本                      ← 「反向：导入 3 个真实样本必须成功」「已存在文件不被覆盖」
 * 9     pack import --as-upstream + sync-upstream ← 阶段 3B 上游同步（合并冲突只报告不选边）
 * 10    assets upload（台账 / sha256 / pending）   ← 3B 的素材上传回写链路
 * 11    review prepare + gate（全 pass 才放行）    ← 3C.3 「全 pass 才允许打包 / 上传」
 * 12    review status（HTTP / python 选路）        ← 3C.2 调用审批工具
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import { cacheFileName } from "../../src/archive/cachekey.js";
import { ARCHIVE_ENTRY_DIRS, readZip, type ZipEntry } from "../../src/archive/ttsmod.js";
import { readCardsCsv, writeCardsCsv, type CardRow } from "../../src/deck/cards.js";
import { readObjectsCsv, type ObjectRow } from "../../src/deck/objects.js";

// ---------------------------------------------------------------------------
// 夹具与进程工具
// ---------------------------------------------------------------------------

/** 项目根目录：由本文件位置回推（tests/integration → 项目根）。 */
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** CLI 调用前缀：node + 已构建的入口（先 `npm run build`）。 */
const CLI = ["node", path.join(PROJECT_ROOT, "dist", "cli", "index.js")] as const;

/** 阶段 3 真实样本目录（施工流程「测试夹具」）。 */
const RESEARCH_DIR = "D:\\工具\\TTS\\research";

/** 3 个真实 `.ttsmod` 样本（已实测存在；s_dial / s_hex 较小，sample_diceset 含 11 对象）。 */
const REAL_SAMPLES = ["s_dial.ttsmod", "s_hex.ttsmod", "sample_diceset.ttsmod"] as const;

/** runCli 的附加选项 */
interface CliRunOptions {
  /** 写入子进程 stdin 的文本（review / 交互时用） */
  input?: string;
  /** 显式控制 stdin；"ignore" 模拟不可交互 */
  stdin?: "ignore" | "inherit" | "pipe";
  /** 追加 / 覆盖子进程环境变量 */
  env?: Record<string, string>;
}

/**
 * 运行一次 `tts` CLI。
 *
 * 统一从项目根目录启动、utf8 输出、reject:false（非 0 退出码不抛异常，集成测试显式
 * 断言 exitCode）；timeout 放宽到 120s——export / import 要读写素材文件，慢盘上
 * 可能超过 vitest 默认 30s。
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
    timeout: 120_000,
    ...opts,
  });
}

/** 本文件创建的临时工作区（mkdtemp）；afterAll 统一递归删除。 */
const tempDirs: string[] = [];

/**
 * 建临时工作区并登记清理（所有夹具都在临时目录内构造，绝不改仓库内文件）。
 * @param prefix 目录名前缀（如 "tts-phase3-"）
 * @returns 新建临时目录的绝对路径
 */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 写文本文件（自动建父目录）——夹具构造用。
 * @param file 目标文件绝对路径
 * @param text 文本内容（utf8）
 */
async function writeText(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

/**
 * 生成纯色 PNG（图片夹具；与 phase2b 同一约定，避免往仓库放二进制夹具）。
 * @param width 宽（像素）
 * @param height 高（像素）
 * @param color 纯色（sharp create 的 background）
 * @returns PNG 字节
 */
function makePng(
  width: number,
  height: number,
  color: { r: number; g: number; b: number; alpha: number },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: color } })
    .png()
    .toBuffer();
}

/**
 * 写一份最小合法 pack.yaml（字段与 src/pack/packyaml.ts 的严格 schema 对齐：
 * host / vcs.lfs 必填，paths.workdir 与 upload.prefix 有默认值可省）。
 *
 * @param dir 图包根目录
 * @param name 图包显示名
 * @param workshopId 工坊 ID（未发布为 null；决定 export 的存档条目名与包名）
 * @param host pack.yaml.host 取值（默认 steamcloud；见 docs/schemas/host.md §1.1）
 */
async function writePackYaml(
  dir: string,
  name: string,
  workshopId: number | null = null,
  host = "steamcloud",
): Promise<void> {
  await writeText(
    path.join(dir, "pack.yaml"),
    [
      "schema_version: 1",
      `name: ${name}`,
      `workshop_id: ${workshopId === null ? "null" : workshopId}`,
      "source_mod: null",
      `host: ${host}`,
      "vcs:",
      "  lfs: disabled-no-lfs",
      "paths: {}",
      "upload: {}",
      "",
    ].join("\n"),
  );
}

/**
 * 写一份最小存档骨架（buildSave 只要求 `ObjectStates` 是数组，
 * src/pack/build.ts:236-243；其余字段随便给）。
 * @param root 图包工作区根目录
 * @param objects 顶层对象数组
 * @param saveName 存档名（缺省 "集成测试图包"）
 */
async function writeSkeleton(
  root: string,
  objects: ReadonlyArray<Record<string, unknown>>,
  saveName = "集成测试图包",
): Promise<void> {
  await writeText(
    path.join(root, ".tts", "skeleton.json"),
    `${JSON.stringify({ SaveName: saveName, LuaScript: "", XmlUI: "", ObjectStates: objects }, null, 2)}\n`,
  );
}

/**
 * 往 TTS 缓存目录写一个"命中缓存键"的素材文件（扩展名推导第 2 级 + 素材字节来源）。
 * 目录名从 {@link ARCHIVE_ENTRY_DIRS} 派生（`Mods/<目录>`），不硬编码。
 *
 * @param modsDir 伪 TTS Mods 目录
 * @param kind 素材类型
 * @param url 原始 URL（缓存键由 cacheFileName 按 TTS 规则算）
 * @param ext 扩展名（不带点）
 * @param data 文件字节
 * @returns 写出的文件绝对路径
 */
async function writeCacheFile(
  modsDir: string,
  kind: keyof typeof ARCHIVE_ENTRY_DIRS,
  url: string,
  ext: string,
  data: Uint8Array,
): Promise<string> {
  const dir = path.join(modsDir, ARCHIVE_ENTRY_DIRS[kind].replace(/^Mods[/\\]/, ""));
  const file = path.join(dir, cacheFileName(url, ext));
  await mkdir(dir, { recursive: true });
  await writeFile(file, data);
  return file;
}

/**
 * 读 `.ttsmod` 的全部条目（布局断言用；`readZip` 即本工具的读取契约）。
 * @param file .ttsmod 文件路径
 * @returns 条目序列（按中心目录次序）
 */
async function readTtsmodEntries(file: string): Promise<ZipEntry[]> {
  return readZip(await readFile(file));
}

/**
 * 按条目名找一条 `.ttsmod` 条目。
 * @param entries readTtsmodEntries 的结果
 * @param name 条目名
 * @returns 命中的条目；没有则 undefined
 */
function entryNamed(entries: readonly ZipEntry[], name: string): ZipEntry | undefined {
  return entries.find((entry) => entry.name === name);
}

/**
 * 写一份含指定卡面的 cards.csv（夹具用；必须走正式 writer，不手写表头）。
 * @param deckDir deck 目录
 * @param rows 卡牌行（sheet_source 等列按 cards.csv 契约填）
 */
async function writeDeckFixture(deckDir: string, rows: readonly CardRow[]): Promise<void> {
  await mkdir(deckDir, { recursive: true });
  await writeCardsCsv(deckDir, rows);
}

/**
 * 读回 deck 目录的 cards.csv（断言用）。
 * @param deckDir deck 目录
 * @returns 卡牌行
 */
function readDeckRows(deckDir: string): Promise<CardRow[]> {
  return readCardsCsv(deckDir);
}

/**
 * 读回工作区的 objects.csv（断言用；文件不存在时 readObjectsCsv 抛 OBJECTS_NOT_FOUND）。
 * @param root 图包工作区根目录
 * @returns 素材行
 */
function readObjectRows(root: string): Promise<ObjectRow[]> {
  return readObjectsCsv(path.join(root, "objects"));
}

/**
 * 文件是否存在且是普通文件（"不覆盖 / 没落盘"类断言用）。
 * @param file 目标路径
 * @returns 存在且是文件返回 true
 */
async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
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

describe("阶段 3 集成验收：素材导入 + 图床 + 打包分发", () => {
  afterAll(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.skip("场景 1：tts import --dry-run 与实落盘（cards.csv / objects.csv 契约）", async () => {
    // TODO(Stage 3)：夹具（全离线，临时目录）：
    //  - <work>/cards/{001_正面.png, 001_背面.png, 002_正面.png, 002_背面.png}（makePng 现场生成）；
    //  - <work>/tiles/地图板块A.png；
    //  - <work>/import.yaml：schema_version 1 / pack 名与 pack.yaml.name 一致 /
    //    decks: [{name: 冒险牌堆, back: unique, cards_dir: ./cards}] /
    //    objects: [{type: tile, name: 地图板块A, image: tiles/地图板块A.png}]；
    //  - 工作区 <work>/pack 用 writePackYaml 写最小 pack.yaml（vcs.lfs 必须显式三选一）。
    //
    // 1) `tts import <work>/import.yaml --pack <work>/pack --dry-run`：
    //    - exitCode 0；stdout 含 cli.import.done {decks:1, cards:2, objects:1, files:5}
    //      与 cli.import.dryRunNote（`cli.import.*` 见 locales/zh-CN.json；CLI 输出见
    //      src/cli/commands/import.ts:85-128）；
    //    - **未落盘**：assert !(await fileExists(<pack>/decks/冒险牌堆/cards.csv))，
    //      objects/ 下也没有 地图板块A/（dryRun 跳过落盘，src/pack/import.ts:1145-1165）。
    // 2) 同一命令去掉 --dry-run：
    //    - 卡图 / 背面复制进 <pack>/decks/冒险牌堆/（源文件名原样）；
    //    - readDeckRows(<pack>/decks/冒险牌堆) 应为 2 行：card_id 101 / 102
    //      （新 deck 从 key=1、slot=1 起，slotToCardId 见 src/deck/cardid.ts），
    //      sheet_id=1，slot=1/2，sheet_cols/sheet_rows 为 inferGrid(1,1,2) 的推断值，
    //      sheet_source = "./cards/001_正面.png" / "./cards/002_正面.png"（清单原样引用），
    //      back = "001_背面.png" / "002_背面.png"（unique 配对，src/pack/import.ts:725-747）；
    //    - readObjectRows(<pack>) 应有 1 行：type=tile、name=地图板块A、
    //      asset_id 匹配 /^imp-[0-9a-f]{8}$/（(type,name) 的 sha256 前 8 位，
    //      src/pack/import.ts:989-1001）、file="objects/tiles/地图板块A/地图板块A.png"、
    //      source="tiles/地图板块A.png"（清单原样路径）；origin_asset_id 列**不存在**
    //      （2026-10-05 裁决，import.yaml.md §4）。
    // 3) 再跑一次同一命令（幂等性）：addedCards=0、cards.csv 不变（已有行原样保留，
    //    src/pack/import.ts:782-797）。
    todo("场景 1：import dry-run 与实落盘");
  });

  it.skip("场景 2：坏清单明确报错（缺文件 / CMYK / schema / back 组合）", async () => {
    // TODO(Stage 3)：每类坏样本一条命令，断言 exitCode 1 + stderr 含 `error.<CODE>`
    // （CLI 错误出口 src/cli/commands/import.ts:64-71）：
    // 1) 缺源文件：cards_dir 指向一个只有部分卡图的目录（或 back_file 指向不存在的文件）
    //    → `IMPORT_FILE_MISSING`（error.pack.importFileMissing {path}，message 含具体路径）；
    // 2) CMYK：造一张 CMYK 图像。**造法提示**：sharp 常规 create 只出 sRGB；可试
    //    `sharp(input).toColourspace("cmyk").jpeg().toFile(...)`，若本机 sharp 版本产不出
    //    真 CMYK（无 ICC 会失败或回落），改用 `tests/unit/pack-import.test.ts` 里同一套
    //    CMYK 夹具的生成函数（单测已覆盖该分支）——不要为此往仓库塞二进制样本。
    //    期望 `IMPORT_CMYK`（error.pack.importCmyk，判定 space === "cmyk"，与 deck/verify 同口径）；
    // 3) schema：decks[].back 写 "both"、根加未知键、缺 cards_dir → `IMPORT_INVALID`
    //    （error.pack.importManifestInvalid，message 含 zod 摘要）；
    // 4) back 组合：back: none + back_file 同时出现 → `IMPORT_INVALID`
    //    （error.pack.importBackFileForbidden）；back: common 缺 back_file →
    //    `IMPORT_INVALID`（error.pack.importBackFileRequired）；
    // 5) ⚠️ **"网格超容量"的实际语义已核对**：显式 grid 10×7 + 71 张卡不会报
    //    IMPORT_GRID_OVERFLOW，而是**自动拆成 2 张图集**（sheet_id=1 收 70 张、sheet_id=2
    //    收 1 张，key 递增），src/pack/import.ts:799-831；IMPORT_GRID_OVERFLOW 是
    //    inferGrid 抛 ATLAS_TOO_MANY_CELLS 时的防御性兜底（常规输入不可达）。验收断言应
    //    改为"自动拆分正确 + 每张 sheet 的 row 数与 slot 编号正确"，不要硬造不可达错误。
    // 6) 坏清单文件名用 "坏清单.yaml" 即可（施工流程原文），路径任意。
    todo("场景 2：坏清单报错");
  });

  it.skip("场景 3：tts host list（内置默认 + 配置声明 + 插件；坏配置绝不静默回退）", async () => {
    // TODO(Stage 3)：分两层断言：
    // 1) CLI 层（只读当前机器真实配置，安全）：
    //    `tts host list` → exitCode 0；首行 cli.host.list.header {count}；第一项必为
    //    `  steamcloud  内置（默认）`（RESERVED_DEFAULT_HOST_ID，src/host/command.ts:150）；
    //    能力行 cli.host.list.caps（可删除 / 单文件上限 / 格式；steamcloud 为 否 / 不限 / -）。
    //    本机 2026-10-05 实测输出：
    //      可用图床 1 个：
    //        steamcloud  内置（默认）
    //          可删除：否  单文件上限：不限  格式：-
    // 2) 配置 / 插件层：CLI 没有 `--config` / `--hosts-dir` 覆盖入口（host.ts 调
    //    `listHosts()` 无参）——**不要写用户的真实 %APPDATA% 配置**；改为在 vitest 内
    //    直接调模块函数（集成语义：真实文件系统 + 真实动态 import）：
    //      - `loadDeclaredHosts(<tmp>/config.yaml)`：写 `hosts: {my-local: {type: local, dir: ...}}`
    //        → 返回 1 个 LocalHost；把 `hosts: {steamcloud: {...}}` 或未知字段 / 未知 type
    //        写进去 → 抛 `HOST_CONFIG_INVALID`（error.host.reservedId / configInvalid），
    //        **绝不静默回退默认图床**（docs/schemas/host.md §3）；
    //      - `loadPluginHosts(<tmp>/hosts)`：写 `my-host.js`（ESM default 导出 id/upload/check/
    //        capabilities）→ 返回 1 个；写缺 `check` 的模块 → `HOST_PLUGIN_INVALID`；
    //        目录不存在 → 空数组（不是错误）；
    //      - `listHosts({configPath, hostsDir})`：配置与插件声明同名 id → `HOST_CONFIG_INVALID`
    //        （duplicateId，含冲突双方来源）。
    todo("场景 3：host list 与配置 / 插件加载");
  });

  it.skip("场景 4：tts host check --pack（骨架 + 台账两来源；死链退出码 1）", async () => {
    // TODO(Stage 3)：
    // 1) 夹具：工作区 <work>/pack；
    //    - .tts/skeleton.json（writeSkeleton）里放两个对象，各带 CustomImage.ImageURL：
    //      a) "http://127.0.0.1:<未监听端口>/dead.png"（**保证死链且不依赖外网**：端口没人
    //         监听 → ECONNREFUSED，checkUrls 报不存活）；
    //      b) 一条 file: URL 或 http URL（按要断言的分类选择）。
    //    - assets.yaml 再放一条与骨架重复的 URL + 一条新 URL（验证"两处合并去重"，
    //      src/cli/commands/host.ts:121-167）。
    // 2) `tts host check --pack <work>/pack` → exitCode 1（有死链时的门禁语义，
    //    host.ts:280-282）；stdout 含 cli.host.check.header {count, host, skeleton, ledger}
    //    与死链行 cli.host.check.dead {url, detail}、summary {total, alive, dead}；
    //    死链超过 50 条只展示前 50 并打 cli.host.check.more（MAX_DEAD_LISTED）。
    // 3) `--host <不存在的id>` → exitCode 1 + stderr `error.HOST_NOT_FOUND`
    //    （绝不静默回退默认图床；host.ts:248 + command.ts:750-761）。
    // 4) 空工作区（无 skeleton、无 assets.yaml）→ exitCode 0 + cli.host.check.empty
    //    （"空不是失败"，host.ts:244-247）。
    todo("场景 4：host check 死链门禁");
  });

  it.skip("场景 5：tts migrate --to（下载 → 上传 → 递归改写，无遗漏）", async () => {
    // TODO(Stage 3)：⚠️ 前置：在真实全局配置 `%APPDATA%\tts-toolkit\config.yaml` 里声明一个
    // 可用图床（推荐 `type: local`，dir 指向临时目录；见 docs/schemas/host.md §3）；
    // 测试**不替用户写全局配置**——用 `process.env.TTS_PHASE3_HOST`（如 my-local）读取，
    // 未设置或 resolveHost 报 HOST_NOT_FOUND 时打印跳过原因并 return。
    // 1) 夹具（本地 HTTP 源，避免外网依赖）：用 node:http 起一个临时服务器，在
    //    /img/hero.png 提供一张 makePng 图片；工作区里放：
    //    - .tts/skeleton.json：两个对象分别引用 http://127.0.0.1:<port>/img/hero.png
    //      与 http://127.0.0.1:<port>/img/noext（**无扩展名** URL，扩展名须从
    //      Content-Type 推出来，guessExtension 见 src/assets/fetch.ts）；
    //    - decks/<牌堆>/data.json + objects/<type>s/<name>/data.json：各引用同一 URL
    //      （验证递归遍历覆盖骨架 + data.json，src/cli/commands/migrate.ts:142-163）；
    //    - assets.yaml 与 objects.csv 里各有一条该 URL（验证台账 / source 列同步改写）。
    // 2) `tts migrate --to $TTS_PHASE3_HOST --pack <work>/pack` → exitCode 0；
    //    stdout 含 cli.migrate.header / migrated / summary；随后逐文件断言：
    //    - skeleton.json 与每个 data.json 里的 URL 全部替换为 local 图床的 file:// URL，
    //      且**递归无遗漏**（重新用 collectSaveUrls 遍历，旧 URL 计数为 0）；
    //    - assets.yaml 的 url、objects.csv 的 source 列同步更新（migrate.ts:256-292）；
    //    - 上传产物的对象名 = cacheFileName（sanitize(url)+扩展名，与 TTS 缓存键一致）。
    // 3) 不可下载形态：往骨架加 "file:///C:/x.png" 与形如 "{lang}..." 的变体 →
    //    报告中列出 skipped + 原因（assets.fetch.manualReason.*），且**不中断**整批；
    // 4) 仍有失败 URL 时 exitCode 1（migrate.ts:331-333）。
    todo("场景 5：migrate 全量改写");
  });

  it.skip("场景 6：tts pack export 布局与自包含（.ttsmod）", async () => {
    // TODO(Stage 3)：
    // 1) 夹具：工作区 <work>/pack（writePackYaml name="演示图包" workshop_id=379104394，
    //    但导出的包名约定要按 <图包名> (<工坊ID>).ttsmod 断言）；writeSkeleton 放一个对象
    //    引用 "https://example.com/images/hero"（**无扩展名**）；用 writeCacheFile 往
    //    <work>/mods/Images 写 httpsexamplecomimageshero.png（第 2 级推导 + 字节来源）。
    // 2) `tts pack export <work>/pack -o <work>/out.ttsmod --datadir <work>/mods` → exitCode 0；
    //    stdout 含 cli.pack.export.done {outPath, entries, size, included, skipped=0} 与
    //    cli.pack.export.readme（默认 README.txt）。
    // 3) 用 readTtsmodEntries 断言条目布局（docs/schemas/ttsmod.md §2）：
    //    - `Mods/Workshop/379104394.json`（工坊 ID 非 null → 主干 = 工坊 ID）；
    //    - `Mods/Images/httpsexamplecomimageshero.png`；
    //    - `manifest.json`（§5 字段：manifest_version=1 / tool.name / pack.workshop_id /
    //      assets[0].status="included"、ext="png"、ext_source="cache-dir"）；
    //    - `README.txt`（both 模式单文件，含"解压目标是 Mods 目录的父目录"的中英两段）。
    //    ⚠️ 不要用外部 unzip（Windows 不保证有）；readZip 就是读取契约。
    // 4) 自包含：`Mods/Workshop/379104394.json` 的字节与 buildSave 产物**逐字节相同**
    //    （Buffer.equals；URL 一个字不改）。
    // 5) `--readme zh|en|none` 三种取值各跑一次，条目名分别为 README-zh-CN.txt /
    //    README-en-US.txt / 无；`--readme bogus` → exitCode 1 + cli.pack.export.invalidReadme。
    // 6) `--strict`：把缓存文件挪走再导出 → exitCode 1 + stderr `error.TTSMOD_STRICT_MISSING`
    //    （message 含缺失清单）；不产出不完整的包（outPath 不存在）。
    //    默认（非 strict）同一夹具 → exitCode 0，stdout 的 cli.pack.export.skippedHeader +
    //    逐条 warning **必须列出**跳过的素材（不静默跳过）。
    // 7) 缺省 -o：在 cwd 下按 ttsmodFileName 生成 `演示图包 (379104394).ttsmod`——
    //    测试应显式给 -o 或断言后清理，避免污染仓库。
    // 8) 人肉验收（不放进自动断言）：用 TTS Mod Vault 打开产出的包必须能导入；
    //    再用 `tts pack unpack <out.ttsmod> --out <work>/ws2` 反向建工作区做自洽检查。
    todo("场景 6：pack export 布局");
  });

  it.skip("场景 7：扩展名推导三兜底与未解析告警（含固定扩展名）", async () => {
    // TODO(Stage 3)：本场景优先直接调 `detectExtensions`（src/archive/detect.ts，
    // 全部可离线；probe 可注入，不联网）：
    // 1) 第 1 级 url-path：URL 以 .jpg/.png 结尾 → decision.source="url-path"；
    //    白名单外（如 ".txt"）不采信，继续下一级；
    // 2) 第 2 级 cache-dir：URL 无扩展名，但 cacheDirs 里按 cacheFileName/sanitize(url)
    //    有命中文件 → source="cache-dir"（命中多个扩展名时按 CACHE_EXTENSION_PRIORITY）；
    // 3) 第 3 级 content-type：URL 无扩展名且无缓存命中，注入 `probe: async () => "image/webp"`
    //    → source="content-type"；探测函数抛错 / 返回 undefined → 仍 unresolved；
    // 4) 固定扩展名：model→obj / assetbundle→unity3d / pdf→PDF，source="fixed"，
    //    即使 URL 自带 .obj 也照样固定（ConvertModelURL 语义）；
    // 5) 三级全失败：decision.ext 为 undefined 且出现在 report.unresolved 里，
    //    detectWarnings 生成可展示文案（archive.detect.unresolvedSummary / Item）——
    //    **绝不静默跳过**（原工具的失败教训，方案设计 §12.4）。
    // 6) CLI 端到端：export 一条全失败素材（非 strict）→ stdout 列出跳过项；
    //    strict → exitCode 1 + TTSMOD_STRICT_MISSING（与场景 6.6 同口径）。
    todo("场景 7：扩展名三兜底");
  });

  it.skip("场景 8：tts pack import 真实样本（3 个 .ttsmod）", async () => {
    // TODO(Stage 3)：夹具 = 3 份第三方真实样本（s_dial.ttsmod / s_hex.ttsmod /
    // sample_diceset.ttsmod，仓库不自带；**只读**；测试不修改样本本身）。对每个样本：
    // 1) `tts pack import <样本> --into <work>/restore` → exitCode 0；
    //    stdout 含 cli.pack.importFile.done {file, into, extracted, total}；
    //    - 解压位置正确：`Mods/...` 条目落在 <work>/restore/Mods/...（into 是 Mods 的
    //      **父目录**）；包内工坊存档被报告为 workshopSaves 并给 unpackHint
    //      （src/cli/commands/pack.ts:859-886）；
    //    - 逐个条目对照 readZip 的清单确认文件真实存在；
    //    - sample_diceset.ttsmod 的 11 个对象 / 旧版 .cjc 结构按实际样本断言（原工具
    //      反编译参考另存）。
    // 2) 不覆盖：紧接再导入一次 → stdout 含 cli.pack.importFile.skippedExisting {count}
    //    与逐条 skippedExistingItem；**文件 mtime / 内容不变**（src/archive/ttsmod.ts:1160-1171）。
    // 3) 不安全条目不逃逸：构造一个 ZIP（writeZip 即可）含 `../evil.txt`、`/abs.txt`、
    //    `C:/evil.txt` 条目 → import 后这些条目出现在 skippedUnsafe（原文）、目标目录
    //    之外**没有任何文件被写出**；`manifest.json` 若损坏只告警不落地。
    // 4) 反向自洽：`tts pack unpack <样本> --out <work>/ws` → 能从样本建出工作区
    //    （unpack 取 Mods/Workshop/*.json 字典序第一个，src/pack/unpack.ts）。
    todo("场景 8：pack import 真实样本");
  });

  it.skip("场景 9：pack import --as-upstream + pack sync-upstream（冲突只报告不选边）", async () => {
    // TODO(Stage 3)：全离线（git 夹具在临时目录，需本机有 git；仓库级 user 配置）：
    // 1) `tts pack init <work>/pack --name 上游包 --lfs disabled`（或 initGitRepo + writePackYaml）；
    // 2) 写两个"上游快照"存档 JSON（v1 与 v2：v2 改一个对象的 CustomImage.ImageURL），
    //    `tts pack import 379104394 --as-upstream --pack <work>/pack --snapshot <v1>`；
    //    - 断言 stdout cli.pack.upstream.imported {snapshot, branch="upstream", commit}，
    //      `git branch` 含 upstream（src/cli/commands/pack.ts:824-841）；
    // 3) 在本地区分支改一个文件并提交 → `tts pack sync-upstream --pack <work>/pack --snapshot <v2>`
    //    → exitCode 0，stdout cli.pack.upstream.synced + merged（快照 commit 到 upstream 后
    //    合并回当前分支，src/pack/upstream.ts）；
    // 4) 冲突：让本地区分支与 v2 修改**同一个文件的不同内容**后再 sync →
    //    exitCode 1、stdout 打印 conflictsHeader + formatConflict 的多行中文报告 +
    //    conflictHint，**merge 保持进行中现场、工具不替用户选边**（pack.ts:935-946）；
    //    用 `git status --porcelain` 确认仍有 UU，再人工解决（git add + commit）后重跑
    //    sync → 正常 0；
    // 5) 快照缺省探测：不给 --snapshot / --datadir 且 <Mods>/Workshop/<id>.json 不存在 →
    //    stderr `error.UPSTREAM_SNAPSHOT_NOT_FOUND`；工作区有未提交改动 →
    //    `UPSTREAM_DIRTY_WORKTREE`（upstream.ts 保护，先 commit 再同步）。
    todo("场景 9：上游导入与同步");
  });

  it.skip("场景 10：tts assets upload（sha256 跳过 / 台账回写 / pending 不是失败）", async () => {
    // TODO(Stage 3)：前置同场景 5（需要全局配置声明一个图床；用 TTS_PHASE3_HOST 读取，
    // 缺失则跳过）。推荐 `type: local`（check / upload 全离线可断言）。
    // 1) 夹具：工作区 pack.yaml（host: steamcloud 或 custom）+ decks/<牌堆>/卡片图 +
    //    objects/<type>s/<name>/素材 + objects/objects.csv（file 列指向上传清单里的
    //    相对路径，src/cli/commands/assets.ts:441-453）；assets.yaml 空或只有旧条目；
    // 2) `tts assets upload --pack <work>/pack --host $TTS_PHASE3_HOST` → exitCode 0；
    //    stdout 含 hostSelected / scan {candidates, skipped} / uploaded / ledger / done；
    //    - assets.yaml 出现 `file → url/sha256/host` 条目（host 列受限枚举：非内置 id 写
    //      "custom"，assets.ts:286-288）；
    //    - objects.csv 的 source 列被写成新 URL；
    // 3) 再跑一次 → 全部 skipped（sha256 一致跳过；台账无 sha256 的旧条目**视为变化**，
    //    宁可多传不静默漏传，assets.ts:392-396）；
    // 4) 改一个文件 → 只有该文件 candidates=1 并重新上传；
    // 5) steamcloud 图床（若用内置默认）：upload 返回 pending → stdout 按 pending 报告
    //    （**可接受结果，不是失败**，assets.ts:413-415 + error 出口只在 failed>0 时 1）。
    todo("场景 10：assets upload");
  });

  it.skip("场景 11：tts review prepare + review gate（全 pass 才放行）", async () => {
    // TODO(Stage 3)：gate 只读文件，可全离线：
    // 1) 夹具：<work>/pack/decks/冒险牌堆/{001_正面.png,002_正面.png} + cards.csv
    //    （writeDeckFixture，face 文件名即素材 id）；<work>/render 放同名成品文件
    //    （源B）；deck.yaml（name/guid）供 prepare 取显示名；
    // 2) `tts review prepare --pack <work>/pack --deck 冒险牌堆 --b <work>/render`
    //    → exitCode 0；写出 <pack>/.tts/approval/approval.config.json
    //    （data_dir 指向工作区内 <pack>/.tts/approval/data，sets[0] 的 a.root=<deck 目录>、
    //    b.root=<work>/render，pair: "basename"、recurse: false；src/review/config.ts）；
    // 3) 结果文件：写 `<data_dir>/results/<setId>.json`（set_id 必须与请求一致；
    //    items 的键 = 素材 id = 文件名）。先写 "只有 1 个 pass、另一个缺失" →
    //    `tts review gate --pack <work>/pack --set 冒险牌堆` → exitCode 1，
    //    stdout 含 gate.summary {total, pass, reject, flag, unreviewed, stale} +
    //    blockersHeader + blocker {item: "002_正面.png", reason: unreviewed}
    //    （reason 文案键 cli.review.gate.reason.*）；
    // 4) 全 pass 但 src 指纹过期 → stale blocker（src = hex(mtime_ns)+hex(size)，
    //    修改成品文件后重跑即可制造；老结果没有 src 时**不判过期**）；
    //    成品文件缺失 → fileMissing；status=reject → reject；flag → flag（存疑同样拦）；
    // 5) 全部 pass 且指纹一致 → exitCode 0 + cli.review.gate.allowed（"全 pass 才允许
    //    打包 / 上传"；gate.ts 的 blocker 优先级每素材至多一条）；
    // 6) 多素材集且未给 --set → exitCode 1 + cli.review.gate.needSet；--set 不存在 →
    //    setNotFound；结果文件缺失 → stderr `error.REVIEW_RESULT_NOT_FOUND`。
    todo("场景 11：review gate 门禁");
  });

  it.skip("场景 12：review status 调审批工具（HTTP / python 选路）", async () => {
    // TODO(Stage 3)：需要审批工具环境（含 agent.py 的 approval-tool 仓库，或服务在跑）：
    // 1) 用场景 11 的 approval.config.json；`tts review status --pack <work>/pack
    //    --approval-root "<approval_tool_root>"` → exitCode 0，stdout 是 agent 返回的
    //    JSON（机器可读、**不翻译**；字段语义见审批工具 docs/agent-接口.md）；
    // 2) `--offline` 强制 CLI 直连文件（给 agent.py 传 --offline）；`--server http://127.0.0.1:8765`
    //    时不需要 python（此时可省 --approval-root）；两者都给且缺 --approval-root →
    //    exitCode 1 + cli.review.status.needApprovalRoot（review.ts:257-260）；
    // 3) 审批工具缺失 / 调用失败 → stderr `error.REVIEW_APP_MISSING` / `REVIEW_CALL_FAILED`；
    // 4) 选路（HTTP 在跑走 HTTP、没跑走文件）由 src/review/client.ts 内部处理，本用例
    //    只断言两种入口都能返回同一份 JSON 结构。
    todo("场景 12：review status");
  });
});
