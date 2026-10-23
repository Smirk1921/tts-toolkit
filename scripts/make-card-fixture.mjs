/**
 * make-card-fixture.mjs — 最小卡牌测试夹具生成器（s_cardtest.ttsmod）
 *
 * ## 用途
 * 生成一个 **自包含** 的最小 .ttsmod 卡牌夹具，供以下链路做端到端验收：
 * - `tts pack unpack`（src/pack/unpack.ts）：解包为图包工作区，
 *   牌堆对象落 `decks/<guid>.<name>/`，`data.json` 保留完整 `CustomDeck`；
 * - `tts deck slice`（src/deck/slice.ts）：从 `CustomDeck` / `DeckIDs` 读图集
 *   归属与格子，切成单卡图并写 cards.csv。
 *
 * 与 `scripts/make-fixture.mjs` 不同，本脚本 **不依赖任何私有真实样本**——
 * 存档 JSON 由本文件按 TTS 格式直接构造，二进制素材一律 1 字节占位（0x00），
 * 因此任何贡献者都能独立重跑，产物可复现（writeZip 条目时间戳固定 2000-01-01）。
 *
 * ## 用法
 * ```bash
 * cd tts-toolkit
 * node scripts/make-card-fixture.mjs
 * # 可选：指定输出路径
 * node scripts/make-card-fixture.mjs tests/fixtures/s_cardtest.ttsmod
 * ```
 * 前置条件：`npm run build`（脚本复用 `dist/archive/` 的 writeZip / readZip /
 * cacheFileName，不引入新依赖，也不重复实现 ZIP 或缓存键逻辑）。
 *
 * ## 产物
 * - `tests/fixtures/s_cardtest.ttsmod`（≤ 30 KB，默认 3 个 ZIP 条目）：
 *   ```
 *   Mods/Workshop/900000001.json                     ← 存档 JSON（UTF-8 原文）
 *   Mods/Images/httpsexamplecomcardtestsheetpng.png  ← 正面图集占位（1 字节 0x00）
 *   Mods/Images/httpsexamplecomcardtestbackpng.png   ← 背面占位（1 字节 0x00）
 *   ```
 *
 * ## 自包含原理（docs/schemas/ttsmod.md §1）
 * 存档 JSON 里的 URL **一个字不改**；条目名 = TTS 缓存键 `sanitize(url) + 扩展名`
 * （src/archive/cachekey.ts 的 cacheFileName）。接收方解压到 `Mods` 的父目录后，
 * TTS 按同样规则命中本地文件，永不访问原始 URL——所以夹具里的
 * `https://example.com/...` 不需要可达。
 *
 * ## 牌堆判定（坑 39，src/pack/unpack.ts:321-326）
 * unpack 的 isDeckLike 只认两条：`Name` 含 "Deck"（不区分大小写）或对象有
 * `CustomDeck` 字段。纯 CustomModel 不会产 cards.csv。本夹具同时满足两条：
 * `Name: "DeckCustom"` + 完整 `CustomDeck`。
 *
 * ## 规格（验收要求，测试逐条断言）
 * - 1 个 CustomDeck 对象：Name "DeckCustom"，GUID "a1b2c3"（六位十六进制，
 *   满足 deck.yaml 的 GUID 约束）；
 * - CustomDeck key "101"：NumWidth=10、NumHeight=1（10 张卡一行）、
 *   FaceURL https://example.com/cardtest/sheet.png、BackURL .../back.png、
 *   UniqueBack=false；
 * - DeckIDs [10101..10110] → cardIdToKey=101、slot 1..10（src/deck/cardid.ts）；
 * - 夹具总大小 ≤ 30 KB。
 *
 * ## 说明：为什么没有 cards.csv / 真实卡图
 * - cards.csv 由 `deck slice` 产生，**不在 unpack 时产生**（docs/schemas/cards.csv.md §1）；
 * - 图集字节是 1 字节占位，slice 会按契约报 SLICE_IMAGE_INVALID——这是
 *   "素材用占位、只验证离线解包链路" 的预期取舍，不是夹具缺陷。
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 复用 tts-toolkit 自身的 ZIP 编解码与缓存键（不引入新依赖）
import { cacheFileName } from "../dist/archive/cachekey.js";
import { readZip, writeZip } from "../dist/archive/ttsmod.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// 配置（与测试断言保持同步）
// ---------------------------------------------------------------------------

/** 项目根目录（scripts/ 的上一级） */
const REPO_ROOT = path.resolve(__dirname, "..");

/** 默认输出路径；可用 argv[2] 覆盖（相对路径按当前工作目录解析） */
const DEFAULT_OUT = path.join(REPO_ROOT, "tests", "fixtures", "s_cardtest.ttsmod");

/** 夹具大小上限：30 KB（验收硬约束） */
const MAX_FIXTURE_BYTES = 30 * 1024;

/** 存档名（pack.yaml 的 name 兜底取它，见 src/pack/unpack.ts:720） */
const SAVE_NAME = "Card Test Set";

/** 工坊 ID（决定 Mods/Workshop/<id>.json 的条目名） */
const WORKSHOP_ID = 900000001;

/** 牌堆对象 GUID（六位十六进制，满足 deck.yaml 的 GUID 约束） */
const DECK_GUID = "a1b2c3";

/** CustomDeck 的 key（字符串形式——JSON 对象键只能是字符串） */
const DECK_KEY = "101";

/** 正面图集 URL（不需要可达：.ttsmod 自包含） */
const FACE_URL = "https://example.com/cardtest/sheet.png";

/** 背面 URL（同上；UniqueBack=false 时是整副牌共用的一张背面图） */
const BACK_URL = "https://example.com/cardtest/back.png";

/** 图集网格：10 列 × 1 行（10 张卡，一行） */
const NUM_WIDTH = 10;
const NUM_HEIGHT = 1;

/** 10 张卡的 DeckID：key(101) × 100 + slot(1..10) */
const DECK_IDS = Array.from({ length: NUM_WIDTH * NUM_HEIGHT }, (_, i) => Number(DECK_KEY) * 100 + i + 1);

/**
 * 1 字节占位素材（0x00）。
 * 所有二进制素材都用它：夹具只验证"包能解开、对象能被识别"，不验证像素。
 */
const PLACEHOLDER = new Uint8Array([0x00]);

// ---------------------------------------------------------------------------
// 存档 JSON（按 TTS 存档最小结构构造）
// ---------------------------------------------------------------------------

/**
 * 构造存档对象。只保留 TTS 存档真实存在且 unpack / slice 会计入的字段：
 * - unpack 要求 `SaveName` + `ObjectStates` 数组（src/pack/unpack.ts:179-185）；
 * - @tts-tools/savefile 的 extractSave 用 `Nickname || Name` + `GUID` 命名目录，
 *   其余字段原样写进 Data.json（本夹具按 GUID 从原始存档取完整对象）；
 * - slice 从 `CustomDeck` / `DeckIDs` 读归属与格子（src/deck/slice.ts:16-87）。
 *
 * Nickname 故意留空串：目录主干退化为 `<guid>.DeckCustom`，deck.yaml 的 name
 * 回退为 Name（"DeckCustom"），断言更直观。
 * @returns 可直接 JSON.stringify 的存档对象
 */
function buildSave() {
  const deck = {
    GUID: DECK_GUID,
    Name: "DeckCustom",
    Nickname: "",
    Description: "",
    GMNotes: "",
    AltLookAngle: { x: 0, y: 0, z: 0 },
    ColorDiffuse: { r: 0.713235259, g: 0.713235259, b: 0.713235259 },
    Tags: [],
    LayoutGroupSortIndex: 0,
    Value: 0,
    Locked: false,
    Grid: true,
    Snap: true,
    IgnoreFoW: false,
    MeasureMovement: false,
    DragSelectable: true,
    Autoraise: true,
    Sticky: true,
    Tooltip: true,
    GridProjection: false,
    HideWhenFaceDown: true,
    Hands: true,
    SidewaysCard: false,
    DeckIDs: DECK_IDS,
    CustomDeck: {
      [DECK_KEY]: {
        FaceURL: FACE_URL,
        BackURL: BACK_URL,
        NumWidth: NUM_WIDTH,
        NumHeight: NUM_HEIGHT,
        BackIsHidden: true,
        UniqueBack: false,
        Type: 0,
      },
    },
    LuaScript: "",
    LuaScriptState: "",
    XmlUI: "",
    Transform: {
      posX: 0,
      posY: 0,
      posZ: 0,
      rotX: 0,
      rotY: 180,
      rotZ: 180,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    },
  };

  return {
    SaveName: SAVE_NAME,
    Date: "2026/10/23",
    VersionNumber: "v13.2",
    GameMode: "",
    GameComplexity: "",
    Table: "",
    Sky: "",
    Note: "",
    TabStates: {},
    LuaScript: "",
    LuaScriptState: "",
    XmlUI: "",
    ObjectStates: [deck],
    ObjectTags: [],
  };
}

// ---------------------------------------------------------------------------
// 组装 ZIP 条目
// ---------------------------------------------------------------------------

/**
 * 构造 .ttsmod 的条目序列（顺序固定，便于复现）。
 * 条目名严格按 docs/schemas/ttsmod.md §2 / §3.1：
 * - 存档 JSON → `Mods/Workshop/<工坊ID>.json`；
 * - 图片 → `Mods/Images/<sanitize(url)>.<ext>`（cacheFileName 单一实现）。
 * @param saveJson 存档 JSON 原文
 * @returns writeZip 的入参
 */
function buildEntries(saveJson) {
  return [
    {
      // 存档 JSON 逐字节原样入包（ttsmod.md §1 实现红线）
      name: `Mods/Workshop/${WORKSHOP_ID}.json`,
      data: Buffer.from(saveJson, "utf8"),
    },
    {
      // 正面图集（TTS 缓存键命名；载荷是 1 字节占位）
      name: `Mods/Images/${cacheFileName(FACE_URL, "png")}`,
      data: PLACEHOLDER,
    },
    {
      // 背面（同上）
      name: `Mods/Images/${cacheFileName(BACK_URL, "png")}`,
      data: PLACEHOLDER,
    },
  ];
}

// ---------------------------------------------------------------------------
// 自检（写盘前，对内存 ZIP 做一次反向读取）
// ---------------------------------------------------------------------------

/**
 * 校验内存中的 ZIP 满足夹具规格；任何一条不满足都抛错（不产出坏夹具）。
 * @param zip writeZip 产物
 * @param entries 期望的条目序列
 * @returns 自检摘要（供日志输出）
 */
function verifyZip(zip, entries) {
  const parsed = readZip(zip);
  const names = parsed.map((entry) => entry.name);

  if (parsed.length !== entries.length) {
    throw new Error(`自检失败：条目数 ${parsed.length} !== 期望 ${entries.length}`);
  }
  for (const expected of entries) {
    if (!names.includes(expected.name)) {
      throw new Error(`自检失败：缺少条目 ${expected.name}（实际：${names.join(", ")}）`);
    }
  }

  const saveEntry = parsed.find((entry) => /^Mods\/Workshop\/.+\.json$/i.test(entry.name));
  if (saveEntry === undefined) {
    throw new Error("自检失败：没有 Mods/Workshop/*.json 存档条目");
  }
  const save = JSON.parse(Buffer.from(saveEntry.data).toString("utf8"));
  if (!Array.isArray(save.ObjectStates) || save.ObjectStates.length !== 1) {
    throw new Error("自检失败：ObjectStates 必须恰好 1 个对象");
  }
  const deck = save.ObjectStates[0];
  if (deck.GUID !== DECK_GUID || deck.Name !== "DeckCustom") {
    throw new Error(`自检失败：牌堆对象 GUID/Name 不符（${deck.GUID}/${deck.Name}）`);
  }
  const customDeck = deck.CustomDeck?.[DECK_KEY];
  if (customDeck === undefined) {
    throw new Error(`自检失败：CustomDeck 缺少 key "${DECK_KEY}"`);
  }
  if (customDeck.FaceURL !== FACE_URL || customDeck.BackURL !== BACK_URL) {
    throw new Error("自检失败：FaceURL / BackURL 与规格不符");
  }
  if (customDeck.NumWidth !== NUM_WIDTH || customDeck.NumHeight !== NUM_HEIGHT) {
    throw new Error("自检失败：NumWidth / NumHeight 与规格不符");
  }
  if (customDeck.UniqueBack !== false) {
    throw new Error("自检失败：UniqueBack 必须为 false");
  }
  if (JSON.stringify(deck.DeckIDs) !== JSON.stringify(DECK_IDS)) {
    throw new Error(`自检失败：DeckIDs 与规格不符（${JSON.stringify(deck.DeckIDs)}）`);
  }

  // 占位素材：必须是 1 字节 0x00
  const images = parsed.filter((entry) => entry.name.startsWith("Mods/Images/"));
  if (images.length !== 2) {
    throw new Error(`自检失败：期望 2 个图片条目，实际 ${images.length}`);
  }
  for (const image of images) {
    if (image.data.length !== 1 || image.data[0] !== 0x00) {
      throw new Error(`自检失败：${image.name} 不是 1 字节 0x00 占位`);
    }
  }

  return {
    entryCount: parsed.length,
    entryNames: names,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const outPath = process.argv[2] !== undefined ? path.resolve(process.argv[2]) : DEFAULT_OUT;

  const save = buildSave();
  const saveJson = JSON.stringify(save, null, 2);
  const entries = buildEntries(saveJson);
  const zip = writeZip(entries);
  const summary = verifyZip(zip, entries);

  if (zip.byteLength > MAX_FIXTURE_BYTES) {
    throw new Error(
      `自检失败：夹具 ${zip.byteLength} 字节，超过上限 ${MAX_FIXTURE_BYTES} 字节（30 KB）`,
    );
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, zip);
  const written = await stat(outPath);

  console.log(`已生成卡牌夹具：${outPath}`);
  console.log(`  大小：${written.size} 字节（上限 ${MAX_FIXTURE_BYTES}）`);
  console.log(`  条目：${summary.entryCount}`);
  for (const name of summary.entryNames) {
    console.log(`    - ${name}`);
  }
  console.log(`  牌堆：GUID=${DECK_GUID} Name=DeckCustom key=${DECK_KEY} ${NUM_WIDTH}x${NUM_HEIGHT} cards=${DECK_IDS.length}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
