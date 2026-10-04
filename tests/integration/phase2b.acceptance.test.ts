// tests/integration/phase2b.acceptance.test.ts
/**
 * 阶段 2B 端到端验收骨架（对照《施工流程》阶段 2「验收标准」第 2 / 2b / 2c / 3 / 4 / 5 项，
 * 与方案设计 §2 阶段 2 验收标准）。
 *
 * 与单元测试不同，本文件是 **Stage 3 主窗口真实验收** 的执行清单：
 * - 默认全部 `it.skip`（用例级开关，不是 describe.skip）——`npm test` 只计为
 *   skipped，不执行、不纳入日常 CI；
 * - Stage 3 逐个删除 `.skip` 打开用例：先按用例内 TODO 填真实夹具 / 构造坏样本，
 *   再跑 `npx vitest run tests/integration/phase2b.acceptance.test.ts`
 *   （或 `npm run test:integration`，会同时带上 phase1 的 describe.skip）；
 * - 每个用例体当前只有 TODO 与一条 `todo(...)` 守卫——**故意不写成空函数体**：
 *   未实现就打开会明确失败（抛出"尚未实现"），不会给出假绿。
 *
 * 前置条件（缺一不可）：
 * 1. 已执行 `npm run build`（测试通过 node 子进程调用 dist/cli/index.js，不是 tsx 源码）；
 * 2. 已准备真实夹具（纯本地文件，无网络、无 TTS 依赖，全部在 mkdtemp 临时目录内
 *    操作原始夹具的副本，绝不改夹具本身）：
 *    - 无损 PNG 图集 + 对应存档 JSON；
 *    - UniqueBack=false / true 两种牌堆的存档（按需附带背面图集文件）；
 * 3. 夹具路径填在各用例 TODO 的 `<path/to/...>` 处；坏样本（CMYK / 错网格 / 孤儿
 *    图集 / 合成存档）由用例现场构造。
 *
 * ⚠️ 夹具几何前提（Run 2 实现的硬约束，选夹具前必读）：
 * - slice 按原图集实际宽高切格：cellW = floor(W/cols)、cellH = floor(H/rows)，
 *   余数像素归最后一列 / 最后一行（src/deck/grid.ts:227-232），切出的卡图
 *   一般**不是正方形**；
 * - generate 的闸门要求卡图恰为 cellSize × cellSize 正方形
 *   （src/deck/generate.ts:377），画布恒为 atlasSize × atlasSize 正方形
 *   （src/deck/generate.ts:408-416）；
 * - inplace 要求源图集能被 cols × rows 整除且单格为正方形
 *   （src/deck/inplace.ts:210-229）。
 * - 因此"逐像素往返 / 原位拼回"的夹具必须是**单格为正方形的图集**，例如
 *   2048×2048 + 4×4（单格 512）或 4096×4096 + 4×4（单格 1024）；
 *   常见 4096×4096 + 10×7 的图集单格 409×585，slice→generate 会先报
 *   GENERATE_CELL_SIZE_MISMATCH，不可能逐像素一致。
 *
 * 断言口径：
 * - CLI 进程出口 = stdout 摘要（t() 文案，单行）/ stderr 错误 / exitCode；
 *   PackError 的可观测出口是 exitCode 1 + stderr 的 `error.<CODE>` 文案
 *   （zh-CN 键见 locales/zh-CN.json，如 INPLACE_CELL_SIZE_MISMATCH 在 :424）；
 * - 像素断言用下方 readRgba / cropRgba / expectSamePixels（sharp 解码为 srgb
 *   8bit RGBA 后逐字节比较）；
 * - 表格断言用 readCardsCsv（src/deck/cards.ts，CSV 含引号转义，不手写解析）。
 *
 * 用例 ↔ 验收标准映射：
 * 1    往返一致性      ← 施工流程「2) 图集往返一致性」
 * 2/3  原位拼回        ← 「2b) 原位拼回」
 * 4    表格自足性      ← 「2c) 表格自足性」
 * 5/6  正反面          ← 「3) 分组与正反面正确（坑 5）」
 * 7    递归替换 4 容器 ← 「4) 递归替换不漏（坑 4）」
 * 8/9  共享 / 孤儿图集 ← 「切片签名与共享图集（2B.3）」
 * 10   verify 4 类问题 ← 「5) 校验能抓出问题」
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import { cardIdToSlot } from "../../src/deck/cardid.js";
import { readCardsCsv, type CardRow } from "../../src/deck/cards.js";

// ---------------------------------------------------------------------------
// 夹具与进程工具
// ---------------------------------------------------------------------------

/** 项目根目录：由本文件位置回推（tests/integration → 项目根）。 */
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** CLI 调用前缀：node + 已构建的入口（先 `npm run build`）。 */
const CLI = ["node", path.join(PROJECT_ROOT, "dist", "cli", "index.js")] as const;

/** runCli 的附加选项 */
interface CliRunOptions {
  /** 写入子进程 stdin 的文本（如管道选择候选编号 "1\n"） */
  input?: string;
  /** 显式控制 stdin；"ignore" 模拟不可交互（触发 SLICE_AMBIGUOUS 而非挂死） */
  stdin?: "ignore" | "inherit" | "pipe";
}

/**
 * 运行一次 `tts` CLI。
 *
 * 统一从项目根目录启动、utf8 输出、reject:false（非 0 退出码不抛异常，集成
 * 测试显式断言 exitCode）；timeout 放宽到 120s——大图集 slice / inplace 要
 * 逐格解码 + PNG 往返，比 phase1 的纯协议命令慢得多。
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
 * 建临时工作区并登记清理（先复制夹具进来再改，绝不改原始文件）。
 * @param prefix 目录名前缀（如 "tts-phase2b-")
 * @returns 新建临时目录的绝对路径
 */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 像素 oracle（sharp：srgb 8bit RGBA，逐字节比较）
// ---------------------------------------------------------------------------

/** 解码后的 RGBA 原始像素 */
interface RawRgba {
  width: number;
  height: number;
  data: Buffer;
}

/** 图集上的像素矩形（与 sharp.extract 字段一致） */
interface CellRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 整图解码为 srgb 8bit RGBA（与 inplace.ts 的内部 oracle 同口径）。
 * @param file 图片路径
 * @returns 宽高 + RGBA 原始字节
 */
async function readRgba(file: string): Promise<RawRgba> {
  const { data, info } = await sharp(file)
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/**
 * 1 基 slot → 像素矩形（行优先左→右、上→下；与 src/deck/grid.ts 的 slotToRect
 * 同语义：slot = CardID % 100，%100===0 记 100；余数像素归最后一列 / 最后一行）。
 *
 * @param slot 格子序号（1 基）
 * @param columns 网格列数
 * @param rows 网格行数
 * @param imageWidth 图集实际宽度（像素）
 * @param imageHeight 图集实际高度（像素）
 * @param cellSize 单格边长（像素）
 */
function slotToCellRect(
  slot: number,
  columns: number,
  rows: number,
  imageWidth: number,
  imageHeight: number,
  cellSize: number,
): CellRect {
  const index = slot - 1;
  const column = index % columns;
  const row = Math.floor(index / columns);
  const left = column * cellSize;
  const top = row * cellSize;
  return {
    left,
    top,
    width: column === columns - 1 ? imageWidth - left : cellSize,
    height: row === rows - 1 ? imageHeight - top : cellSize,
  };
}

/**
 * 从整图 RGBA 缓冲切出一个格子（不重新解码）。
 * @param img 整图 RGBA
 * @param rect 格子矩形
 * @returns 该格子的 RGBA
 */
function cropRgba(img: RawRgba, rect: CellRect): RawRgba {
  const data = Buffer.alloc(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.top + y) * img.width + rect.left) * 4;
    img.data.copy(data, y * rect.width * 4, from, from + rect.width * 4);
  }
  return { width: rect.width, height: rect.height, data };
}

/**
 * 逐字节断言两幅 RGBA 相同；失败时给出首个不同字节偏移，便于定位。
 * @param actual 实际图
 * @param expected 期望图
 * @param label 断言标签（如 "slot 42"）
 */
function expectSamePixels(actual: RawRgba, expected: RawRgba, label: string): void {
  expect(actual.width, `${label}：宽度`).toBe(expected.width);
  expect(actual.height, `${label}：高度`).toBe(expected.height);
  let offset = -1;
  if (!actual.data.equals(expected.data)) {
    const limit = Math.min(actual.data.length, expected.data.length);
    for (let i = 0; i < limit; i++) {
      if (actual.data[i] !== expected.data[i]) {
        offset = i;
        break;
      }
    }
  }
  expect(offset, `${label}：首个不同字节偏移`).toBe(-1);
}

// ---------------------------------------------------------------------------
// 表格 oracle（cards.csv 含引号转义，复用正式解析器，不手写拆分）
// ---------------------------------------------------------------------------

/**
 * 读取 deckDir 的 cards.csv（BOM / 引号 / 全量校验由 src/deck/cards.ts 负责）。
 * @param deckDir 含 cards.csv 的 deck 目录
 */
function readDeckRows(deckDir: string): Promise<CardRow[]> {
  return readCardsCsv(deckDir);
}

/**
 * 断言每一行的 slot 与 CardID 规则一致（1 基；%100===0 记 100）。
 * @param deckDir 含 cards.csv 的 deck 目录
 */
async function expectSlotsMatchCardIds(deckDir: string): Promise<void> {
  const rows = await readDeckRows(deckDir);
  for (const row of rows) {
    expect(row.slot, `card_id ${row.cardId} 的 slot`).toBe(cardIdToSlot(row.cardId));
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

describe("阶段 2B 端到端验收", () => {
  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.skip("图集往返一致性：slice → generate → 与原图集逐像素一致", async () => {
    // TODO(Stage 3)：用真实**无损**图集 <path/to/atlas.png> + 存档 <path/to/save.json>。
    // 前置：夹具必须满足文件头的"几何前提"（单格正方形 + 方形画布 + 可整除），
    // 例如 2048×2048 + 4×4（单格 512）或 4096×4096 + 4×4（单格 1024）。
    //
    // 步骤：
    // 1. tts deck slice --sheet <atlas> --save <save> -o <work>/cards
    //    （共享图集会弹候选选择：runCli([...], { input: "1\n" }) 管道输入，
    //      或加 --deck-key / --deck-guid 跳过；见场景 8）
    // 2. tts deck generate --deck <work>/cards --cell-size <s> --atlas-size <S>
    //    --cols <k> --rows <k> -o <work>/rebuilt
    //    （四个显式参数必须与原图集几何一致，否则 generate 会重新推断布局）
    // 3. 断言两次调用 exitCode 均为 0，且 <work>/rebuilt/sheet-1.png 存在
    // 4. expectSamePixels(readRgba(rebuilt/sheet-1.png), readRgba(atlas),
    //    "slice→generate 往返") —— 宽高 + 全量像素逐字节一致
    //    （最强验证：一次覆盖 grid / slice / generate 三块逻辑）
    todo("场景 1：图集往返一致性");
  });

  it.skip("原位拼回：改 3 张卡，未改的格子逐像素一致", async () => {
    // TODO(Stage 3)：前置同场景 1（源图集单格正方形且可整除；inplace 省略
    // --cell-size 时要求 W/cols 与 H/rows 都是整数且相等，src/deck/inplace.ts:210-229）。
    //
    // 步骤：
    // 1. slice 到 <work>/cards；再把源图集复制为 <work>/cards/source/sheet-1.png
    //    （inplace 按 --source 找 sheet-<sheetId>.png；slice 不复制源图集）
    // 2. 用 sharp 改 3 张卡图并**覆盖写**原文件（如整格纯色 / 画标记；保持 cellSize²，
    //    用不透明像素避免合成时的舍入差异）
    // 3. tts deck inplace --deck <work>/cards --source <work>/cards/source
    //    --modified <cardId1,cardId2,cardId3> -o <work>/rebuilt
    //    —— 显式 --modified 保证判改确定性：默认 mtime 模式要求卡图 mtime **严格
    //    晚于**源图集（src/deck/inplace.ts:353-358），覆盖写落在同一毫秒会漏判
    // 4. 断言 exitCode 0；stdout 单行摘要含改 / 总数（cli.deck.inplace.done）
    // 5. rebuilt/sheet-1.png 与 source/sheet-1.png 同宽高；按 cards.csv 的 slot
    //    用 cropRgba 逐格断言：
    //    - 未改格子与源图集对应格子 expectSamePixels(..., `slot ${slot}`) 逐字节一致；
    //    - 3 个改过的格子与改后卡图逐字节一致（PNG 无损往返）
    todo("场景 2：原位拼回");
  });

  it.skip("原位拼回：错尺寸输入必须报错（不许静默改图集大小）", async () => {
    // TODO(Stage 3)：准备同场景 2 的 deck + source；把一张卡图 resize 成 cellSize
    // 以外的正方形（如单格 512 时用 256×256）。
    //
    // 1. tts deck inplace --deck <work>/cards --source <work>/cards/source
    //    --modified <该卡 CardID> -o <work>/rebuilt
    // 2. 断言 exitCode === 1；stderr 含 error.INPLACE_CELL_SIZE_MISMATCH 的 zh-CN
    //    文案（locales/zh-CN.json:424 "卡图尺寸与格子尺寸不符"）
    // 3. 断言 stdout 不含 cli.deck.inplace.done 摘要；<work>/rebuilt 下无
    //    sheet-1.png——错误在写盘前抛出（src/deck/inplace.ts:367-377 位于
    //    composite / mkdir 之前）
    // 备注：该错误只在卡图被判定为"改过"时触发；必须让 --modified 命中该卡，
    //       或先让卡图 mtime 显式晚于源图集。
    todo("场景 3：错尺寸输入报错");
  });

  it.skip("表格自足性：只保留 cards.csv + 卡图，删掉 deck.yaml 后能重建", async () => {
    // TODO(Stage 3)（验收 2c：至少 sheets 信息要能从 table 恢复）：
    // 1. 把夹具 deck 目录复制到 <work>/cards（若来自 unpack 工作区，目录里含
    //    deck.yaml 骨架）；确保有 cards.csv + 卡图
    // 2. 删除 <work>/cards/deck.yaml（存在才删；slice 产物本就不含 deck.yaml，
    //    所以更严格的构造是"unpack 骨架 → 放入 cards.csv → 删 deck.yaml"）
    // 3. tts deck generate --deck <work>/cards --cell-size <s> --atlas-size <S>
    //    --cols <k> --rows <k> -o <work>/rebuilt
    // 4. 断言 exitCode 0 且 rebuilt/sheet-1.png 存在——generate 只读 cards.csv 与
    //    卡图，全模块无 deck.yaml / manifest 依赖
    // 5. 断言重建图集的宽高 / 网格与 cards.csv 的 sheet_cols / sheet_rows 一致
    todo("场景 4：表格自足性");
  });

  it.skip("UniqueBack=false：切出 1 张共用背面", async () => {
    // TODO(Stage 3)：找一个 UniqueBack=false 的牌堆存档 + 图集。
    //
    // 1. tts deck slice --sheet <atlas> --save <save> -o <work>/cards → exitCode 0
    // 2. readdir(<work>/cards)：背面文件恰为 1 个且名为 back.png；不存在 back-*.png
    // 3. readDeckRows(<work>/cards)：所有行的 back 列相同（"back.png"；无 BackURL
    //    时该列为空）——UniqueBack=false 整副牌共用一张背面
    //    （src/deck/slice.ts:967-980、1010-1018）
    // 备注：BackURL != FaceURL 且同目录找不到 sanitize(BackURL) 的本地文件时，
    //       slice 按契约**静默降级为无背面**（back 列留空）而不是报错；夹具需让
    //       背面文件存在，才能断言 back.png。
    todo("场景 5：UniqueBack=false");
  });

  it.skip("UniqueBack=true：逐张配对且序号与 CardID 低位一致", async () => {
    // TODO(Stage 3)：找一个 UniqueBack=true 的牌堆存档 + 同网格背面图集
    // （背面文件名 = sanitize(BackURL)，与 --sheet 同目录；缺失会
    //  SLICE_SHEET_NOT_FOUND，UniqueBack=true 不降级，src/deck/slice.ts:76-78）。
    //
    // 1. tts deck slice --sheet <atlas> --save <save> -o <work>/cards → exitCode 0
    // 2. await expectSlotsMatchCardIds(<work>/cards)：每行 slot === cardIdToSlot(card_id)
    //    （序号与 CardID 低位一致；%100===0 记 100）
    // 3. 对每行断言 back === `back-${String(slot).padStart(3, "0")}.png`，
    //    且 readdir 中这些 back-XXX.png 全部存在（数量 = 卡片数）
    todo("场景 6：UniqueBack=true");
  });

  it.skip("递归替换：plan 列出所有受影响对象（含 4 容器键）", async () => {
    // TODO(Stage 3)：在 <work>/save.json 写一份合成存档（JSON 文本），覆盖坑 4 的
    // 四种容器键 + 不同素材字段，例如：
    //   { "ObjectStates": [
    //     { "Name": "A", "GUID": "aaaaaa",
    //       "CustomDeck": { "1": { "FaceURL": "https://old/1.png", "BackURL": "https://old/b.png" } } },
    //     { "Name": "B", "GUID": "bbbbbb",
    //       "ContainedObjects": [ { "CustomDeck": { "1": { "FaceURL": "https://old/1.png" } } } ] },
    //     { "Name": "C", "GUID": "cccccc",
    //       "ChildObjects": [ { "CustomDeck": { "1": { "FaceURL": "https://old/1.png" } } } ] },
    //     { "Name": "D", "GUID": "dddddd",
    //       "States": { "1": { "CustomDeck": { "1": { "FaceURL": "https://old/1.png" } } } } },
    //     { "Name": "E", "GUID": "eeeeee",
    //       "AttachedDecals": [ { "CustomDecal": { "ImageURL": "https://old/decal.png" } } ] }
    //   ] }
    //
    // 1. tts deck plan --save <work>/save.json --replace https://old/1.png=https://new/1.png
    // 2. exitCode 0；stdout 条目覆盖 A 的直接挂载与 B/C/D 三种容器下钻，
    //    objectPath 形如 ObjectStates[1].ContainedObjects[0]、
    //    ObjectStates[2].ChildObjects[0]、ObjectStates[3].States.1（src/deck/patch.ts:41-43）；
    //    AttachedDecals 实测挂 CustomDecal（可再跑一条 --replace 断言同样被覆盖）
    // 3. 断言命中行 fieldPath 为 CustomDeck.FaceURL / CustomDecal.ImageURL，
    //    newValue = 新 URL；末行摘要含 cli.deck.plan.done 的影响处数与对象数
    // 4. dry-run 红线：调用前后 save.json 逐字节不变
    todo("场景 7：递归替换 plan");
  });

  it.skip("共享图集：切片列出所有候选 + deck.yaml 写 shared_with", async () => {
    // TODO(Stage 3)：合成存档：两个顶层对象（GUID 不同）的 CustomDeck["1"].FaceURL
    // 指向同一 URL；图集文件名 = sanitize(FaceURL) 且放在同目录。构造后：
    //
    // 1. 不可交互环境（runCli([...], { stdin: "ignore" })）→ exitCode 1，
    //    stderr 含 error.SLICE_AMBIGUOUS 文案与候选清单（locales/zh-CN.json:413）
    // 2. 管道选择（runCli([...], { input: "1\n" })）→ exitCode 0；stdout 先逐行
    //    列出候选（cli.deck.slice.candidate），摘要行含所选 GUID 与其他共享者
    // 3. 断言 cards.csv 的 sheet_source = 所选对象的 FaceURL，且 card_id 属于所选
    //    deck 的 DeckIDs
    // 4. ⚠️ 契约核对（打开前先与主窗口裁决，勿只照标题断言）：
    //    施工流程「切片签名与共享图集」要求"选完后 deck.yaml 里写入
    //    shared_with: [<其他 GUID>]"，但 Run 2 的 sliceAtlas 只返回 / 打印
    //    sharedWith（src/deck/slice.ts:1036-1046 只写 cards.csv），全仓
    //    writeDeckManifest 仅 src/pack/unpack.ts:619 调用——当前可断言的只有
    //    stdout 摘要（cli.deck.slice.shared 含其他 GUID）。若裁决要补写 deck.yaml，
    //    需先改 slice.ts / CLI，再在本用例追加 shared_with 断言。
    todo("场景 8：共享图集");
  });

  it.skip("孤儿图集：不在存档里的图集切片报错退出", async () => {
    // TODO(Stage 3)：用一张存档里没有任何 CustomDeck 引用的图集（或复制一张改名
    // 后的图集，使文件名反推不到 URL、宽高比也匹配不上任何声明）。
    //
    // 1. tts deck slice --sheet <orphan-atlas> --save <save> -o <work>/cards
    // 2. 断言 exitCode 1；stderr 含 error.SLICE_ORPHAN_ATLAS 文案
    //    （locales/zh-CN.json:412 "存档中没有引用该图集的牌堆：{msg}"）
    // 3. 断言 <work>/cards 下不产出 cards.csv，也没有任何切片 PNG——
    //    slice 在校验全部通过前不写任何文件（src/deck/slice.ts:790-793）
    todo("场景 9：孤儿图集");
  });

  it.skip("verify 抓 4 种问题：网格不符 / CMYK / 超容量 / CardID 不匹配", async () => {
    // TODO(Stage 3)：4 个子场景各建一个最小 packRoot（<work>/caseN/），按完整布局
    // 放 decks/<name>/{deck.yaml,cards.csv,卡图...}，分别构造：
    //
    // a) 网格不符：cards.csv 声明 10×7，图集实际 2048×2048（宽/列 = 204.8 非整数）
    //    → error ATLAS_GRID_MISMATCH（src/deck/verify.ts:440-448）；图集放
    //    <deckDir>/source/sheet-1.png（sheet_source 兜底位置）或让 sheet_source
    //    指向它
    // b) CMYK：用 sharp 生成 CMYK 色彩空间的图集 / 卡图（PNG 不支持 CMYK，用
    //    TIFF/JPEG，并让 sheet_source / face / back 指向该文件）→ error
    //    ATLAS_CMYK（图集，verify.ts:437-439）或 CARD_CMYK（卡图，:479）
    // c) 超容量：同一 sheet_id 的行声明不同网格，使行数 > 最小容量（例：一行
    //    3×3 + slot 9，一行 1×1 + slot 1 → 2 张 > min(9,1)=1）→ error
    //    DECK_TOO_MANY_CARDS（verify.ts:364-371）。注意读侧会拦 slot 越界
    //    （CARDS_SLOT_OUT_OF_RANGE），所以必须借"行间最小容量"口径；该构造必然
    //    同时命中 ATLAS_GRID_MISMATCH
    // d) CardID 不匹配：cards.csv 的 slot ≠ CardID 低位 → 读侧抛
    //    CARDS_SLOT_MISMATCH，verify 映射为 error CARD_ID_MISMATCH（verify.ts:221）
    //
    // 每个子场景断言：tts deck verify --root <caseN> 的 exitCode 1、stdout 含对应
    // 机器码与中文 message（issue 行不走 stderr），且末行摘要
    // cli.deck.verify.summary 报"N 错 M 警"；warning 不阻塞通过。
    // 备注：可用 --no-cmyk / --no-atlas-size 逐项隔离读图检查。
    todo("场景 10：verify 抓 4 种问题");
  });
});
