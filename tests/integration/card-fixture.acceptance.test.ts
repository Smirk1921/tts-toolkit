// tests/integration/card-fixture.acceptance.test.ts
/**
 * 卡牌夹具 `s_cardtest.ttsmod` 端到端验收。
 *
 * 夹具由 `scripts/make-card-fixture.mjs` 生成（`node scripts/make-card-fixture.mjs`），
 * 特点：**不依赖私有真实样本**，存档 JSON 由脚本按 TTS 格式构造，二进制素材
 * 一律 1 字节 0x00 占位，因此任何环境都能独立重跑。
 *
 * 本文件验证的链路（全部真实执行，不是 mock）：
 * 1. 夹具结构（§1）：≤ 30 KB；ZIP 条目名 = TTS 缓存键 `sanitize(url) + 扩展名`
 *    （docs/schemas/ttsmod.md §1 / §3.1）；素材 1 字节占位；存档内 CustomDeck
 *    规格与验收要求逐字段一致；
 * 2. `unpackSave`（§2）：直接调用 src/pack/unpack.ts 的公开入口
 *    `unpackSave({ savePath, outDir })`——这是验收要求 1 的字面断言，
 *    不依赖 CLI 或构建产物；unpack 内部走 pwsh + .NET ZipFile 解包 +
 *    @tts-tools/savefile 的 extractSave。断言
 *    - `decks/` 存在且恰好 1 个牌堆子目录（不在 `objects/` 下——即被识别为
 *      牌堆，src/pack/unpack.ts:321-326 的 isDeckLike 分支）；
 *    - `<deckDir>/data.json` 保留**完整**对象（含 CustomDeck / DeckIDs），
 *      证明 unpack 按 GUID 从原始存档取全量对象，而不是用被库剥离过的产物；
 *    - `deck.yaml` 存在且 guid === "a1b2c3"（GUID 六位十六进制 →
 *      src/pack/unpack.ts:612-620）；
 *    - `cards.csv` **不存在**：cards.csv 由 `deck slice` 产生，不在 unpack 时产生
 *      （docs/schemas/cards.csv.md §1、src/pack/unpack.ts:611-616）。
 * 3. `tts pack unpack`（§3）：真实子进程调用 `dist/cli/index.js`，补齐命令行
 *    到 library 的接线（注意 CLI 只定义了 `--out`，没有 `-o` 短选项，
 *    见 src/cli/commands/pack.ts:571）。
 *
 * 为什么本文件不跑 deck slice：
 * - 夹具约定所有二进制素材是 1 字节 0x00 占位（≤ 30 KB 硬约束），sharp 必然
 *   报 SLICE_IMAGE_INVALID——这是夹具的既定取舍，不是实现缺陷；
 * - slice 链路的图集夹具在 phase2b.acceptance.test.ts 用真实 PNG 覆盖。
 *
 * 前置条件：§2 直接导入 src（vitest 转译，无需构建）；§3 需要先执行
 * `npm run build`（通过 node 子进程调用 dist/cli/index.js，与
 * phase*.acceptance.test.ts 的口径一致）。
 */

import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { afterAll, describe, expect, it } from "vitest";

import { cacheFileName } from "../../src/archive/cachekey.js";
import { readZip } from "../../src/archive/ttsmod.js";
import { readDeckManifest } from "../../src/pack/manifest.js";
import { unpackSave } from "../../src/pack/unpack.js";

// ---------------------------------------------------------------------------
// 常量（与 scripts/make-card-fixture.mjs 的规格保持一致）
// ---------------------------------------------------------------------------

/** 项目根目录：由本文件位置回推（tests/integration → 项目根） */
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** 夹具路径（入库文件，测试只读，不修改） */
const FIXTURE_PATH = path.join(PROJECT_ROOT, "tests", "fixtures", "s_cardtest.ttsmod");

/** CLI 入口（必须先在仓库根执行 npm run build） */
const CLI_ENTRY = path.join(PROJECT_ROOT, "dist", "cli", "index.js");

/** 夹具大小上限：30 KB（任务验收硬约束） */
const MAX_FIXTURE_BYTES = 30 * 1024;

/** 牌堆对象规格 */
const DECK_GUID = "a1b2c3";
const DECK_NAME = "DeckCustom";
const DECK_KEY = "101";
const FACE_URL = "https://example.com/cardtest/sheet.png";
const BACK_URL = "https://example.com/cardtest/back.png";
const NUM_WIDTH = 10;
const NUM_HEIGHT = 1;

/** 10 张卡的 DeckID（key 101 × 100 + slot 1..10） */
const DECK_IDS = [10101, 10102, 10103, 10104, 10105, 10106, 10107, 10108, 10109, 10110];

/** 本文件创建的临时目录；afterAll 统一递归删除 */
const tempDirs: string[] = [];

/**
 * 建临时工作区并登记清理。
 * @param prefix 目录名前缀
 * @returns 新建临时目录的绝对路径
 */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. 夹具结构
// ---------------------------------------------------------------------------

describe("s_cardtest.ttsmod 夹具结构", () => {
  it("≤ 30 KB，条目名 = sanitize(url)+扩展名，素材是 1 字节 0x00 占位", async () => {
    const info = await stat(FIXTURE_PATH);
    expect(info.isFile()).toBe(true);
    expect(info.size).toBeLessThanOrEqual(MAX_FIXTURE_BYTES);

    const entries = readZip(await readFile(FIXTURE_PATH));
    const names = entries.map((entry) => entry.name);

    // 存档条目：unpack 只认 Mods/Workshop/*.json（src/pack/unpack.ts:404-422）
    const saveEntries = entries.filter((entry) => /^Mods\/Workshop\/[^/]+\.json$/i.test(entry.name));
    expect(saveEntries).toHaveLength(1);

    // 图片条目名必须由 TTS 缓存键规则得出（docs/schemas/ttsmod.md §3.1）
    expect(names).toContain(`Mods/Images/${cacheFileName(FACE_URL, "png")}`);
    expect(names).toContain(`Mods/Images/${cacheFileName(BACK_URL, "png")}`);

    // 二进制素材一律 1 字节 0x00 占位（自包含原理不要求字节真实）
    const images = entries.filter((entry) => entry.name.startsWith("Mods/Images/"));
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.data.length).toBe(1);
      expect(image.data[0]).toBe(0x00);
    }
  });

  it("存档内 CustomDeck 规格：key 101、10×1、UniqueBack=false、10 个 DeckID", async () => {
    const entries = readZip(await readFile(FIXTURE_PATH));
    const saveEntry = entries.find((entry) => /^Mods\/Workshop\/[^/]+\.json$/i.test(entry.name));
    expect(saveEntry).toBeDefined();

    const save = JSON.parse(Buffer.from(saveEntry!.data).toString("utf8")) as {
      SaveName: string;
      ObjectStates: Array<Record<string, unknown>>;
    };

    // unpack 的最小结构要求：ObjectStates 必须是数组（src/pack/unpack.ts:179-185）
    expect(Array.isArray(save.ObjectStates)).toBe(true);
    expect(save.ObjectStates).toHaveLength(1);

    const deck = save.ObjectStates[0];
    expect(deck.GUID).toBe(DECK_GUID);
    expect(deck.Name).toBe(DECK_NAME);

    // 坑 39：Name 含 "Deck" + CustomDeck 字段双保险
    const customDeck = deck.CustomDeck as Record<string, Record<string, unknown>>;
    expect(customDeck).toBeDefined();
    const sheet = customDeck[DECK_KEY];
    expect(sheet).toBeDefined();
    expect(sheet.FaceURL).toBe(FACE_URL);
    expect(sheet.BackURL).toBe(BACK_URL);
    expect(sheet.NumWidth).toBe(NUM_WIDTH);
    expect(sheet.NumHeight).toBe(NUM_HEIGHT);
    expect(sheet.UniqueBack).toBe(false);

    expect(deck.DeckIDs).toEqual(DECK_IDS);
  });
});

// ---------------------------------------------------------------------------
// 2. unpackSave 端到端（验收要求 1 的字面断言）
// ---------------------------------------------------------------------------

/**
 * 断言 unpack 产物满足牌堆契约（验收要求 2–5）：
 * - `decks/` 存在且有子目录；
 * - 子目录 `data.json` 有 CustomDeck，key "101" 的 NumWidth=10 / NumHeight=1；
 * - `deck.yaml` 存在且 guid === "a1b2c3"。
 * 另外断言对象没有被误判成普通对象、且 unpack 不产 cards.csv。
 * @param outDir unpack 的输出根目录
 * @returns 牌堆子目录的绝对路径（供调用方追加断言）
 */
async function assertDeckWorkspace(outDir: string): Promise<string> {
  // —— 验收要求 2：decks/ 存在且至少 1 个牌堆子目录（走了 isDeckLike 分支）——
  const decksRoot = path.join(outDir, "decks");
  const deckDirs = (await readdir(decksRoot, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  expect(deckDirs.length, "decks/ 下必须至少有 1 个牌堆子目录").toBeGreaterThanOrEqual(1);
  expect(deckDirs).toHaveLength(1);

  // —— 验收要求 3/4：data.json 是原始存档里的完整对象，CustomDeck 原样保留 ——
  const deckDir = path.join(decksRoot, deckDirs[0].name);
  const data = JSON.parse(await readFile(path.join(deckDir, "data.json"), "utf8")) as Record<
    string,
    unknown
  >;
  expect(data.GUID).toBe(DECK_GUID);
  expect(data.Name).toBe(DECK_NAME);

  const customDeck = data.CustomDeck as Record<string, Record<string, unknown>>;
  expect(customDeck).toBeDefined();
  expect(Object.hasOwn(customDeck, DECK_KEY)).toBe(true);
  expect(customDeck[DECK_KEY].FaceURL).toBe(FACE_URL);
  expect(customDeck[DECK_KEY].BackURL).toBe(BACK_URL);
  expect(customDeck[DECK_KEY].NumWidth).toBe(NUM_WIDTH);
  expect(customDeck[DECK_KEY].NumHeight).toBe(NUM_HEIGHT);
  expect(customDeck[DECK_KEY].UniqueBack).toBe(false);
  expect(data.DeckIDs).toEqual(DECK_IDS);

  // —— 验收要求 5：deck.yaml 存在且 guid === "a1b2c3" ——
  const manifest = await readDeckManifest(deckDir);
  expect(manifest.guid).toBe(DECK_GUID);
  expect(manifest).toEqual({
    schema_version: 1,
    name: DECK_NAME,
    guid: DECK_GUID,
    shared_with: [],
  });

  // —— 没有被误判成普通对象 ——
  const objectDirs = (await readdir(path.join(outDir, "objects"), { withFileTypes: true })).filter(
    (entry) => entry.isDirectory(),
  );
  expect(objectDirs).toHaveLength(0);

  // —— cards.csv 由 deck slice 产生，不在 unpack 时产生 ——
  // （docs/schemas/cards.csv.md §1；src/pack/unpack.ts:611-616）
  await expect(stat(path.join(deckDir, "cards.csv"))).rejects.toMatchObject({ code: "ENOENT" });

  return deckDir;
}

describe("unpackSave 直接调用识别牌堆", () => {
  it("unpackSave({savePath, outDir}) 成功返回，decks/ 有子目录，data.json 含 CustomDeck，deck.yaml guid=a1b2c3", async () => {
    const outDir = await makeTempDir("tts-card-fixture-fn-");

    // 验收要求 1：公开入口直接调用（不经过 CLI / 构建产物）
    const result = await unpackSave({ savePath: FIXTURE_PATH, outDir });
    expect(result.packRoot).toBe(path.resolve(outDir));
    expect(result.objectsWritten).toBe(1);
    expect(result.skeletonWritten).toBe(true);

    await assertDeckWorkspace(outDir);
  });
});

// ---------------------------------------------------------------------------
// 3. CLI 端到端（unpack 命令接线）
// ---------------------------------------------------------------------------

describe("tts pack unpack 识别牌堆", () => {
  it("dist/cli/index.js pack unpack --out 成功，产物满足同一牌堆契约", async () => {
    const outDir = await makeTempDir("tts-card-fixture-");

    // CLI 只提供 --out（src/cli/commands/pack.ts:571），没有 -o 短选项
    const result = await execa("node", [CLI_ENTRY, "pack", "unpack", FIXTURE_PATH, "--out", outDir], {
      cwd: PROJECT_ROOT,
      reject: false,
      encoding: "utf8" as const,
      timeout: 120_000,
    });
    expect(result.exitCode, `unpack 失败，stderr：${result.stderr}`).toBe(0);

    await assertDeckWorkspace(outDir);
  });
});
