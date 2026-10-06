/**
 * make-fixture.mjs — 自制 .ttsmod 夹具生成器（窗口 v8-2）
 *
 * ## 用途
 * 从 D:\工具\TTS\research\ 真实 .ttsmod 样本裁剪 + 匿名化，产出 3 个入库夹具 + 1 个
 * 预先解包的 extracted/ 目录，让 13 个 describeFixture / describeExtracted 测试在本地
 * 激活（CI 上仍 skip）。
 *
 * ## 仅维护者本机使用
 * 本脚本依赖 D:\工具\TTS\research\ 私有真实样本，**贡献者无需跑**——产物已入库
 * （tests/fixtures/*.ttsmod 与 tests/fixtures/extracted/），git clone 即得。
 * 仅当需要重新生成（比如真实样本更新或匿名化规则调整）时维护者才执行。
 *
 * ## 用法
 * ```bash
 * cd tts-toolkit
 * node scripts/make-fixture.mjs
 * # 或：npm run make-fixture
 * ```
 *
 * ## 产物（入库）
 * - tests/fixtures/s_dial.ttsmod          (~50KB，51 个 ZIP 条目)
 * - tests/fixtures/s_hex.ttsmod           (~20KB，4 个 ZIP 条目，Workshop 用 .cjc)
 * - tests/fixtures/sample_diceset.ttsmod  (~20KB，13 个 ZIP 条目)
 * - tests/fixtures/extracted/Mods/...    (13 个文件，sample_diceset 解包结果)
 *
 * ## 13 个测试期望（精确）
 *
 * ### tests/unit/archive-cachekey.test.ts（4 个 fixture 用例 + 8 个纯函数已绿）
 * 激活条件：候选目录含 s_dial.ttsmod（archive-cachekey.test.ts:31-41）
 *
 * | # | 用例 | 期望 | 来源 |
 * |---|---|---|---|
 * | 1 | s_dial 图片条目 dial-12-0.jpg | sanitizeUrl 后 = "httpsrawgithubusercontentcomDasUmlautTTSLibrarymasterdialsdial120jpg" | L44-49 |
 * | 2 | s_hex 图片条目 UV.png（大写 UV 保留） | "httpnikulaswebscomUVpng" | L51-54 |
 * | 3 | sample_diceset 模型条目 pastebin 查询串（?i= 全去除） | "httppastebincomrawphpicDn7Eum6" | L56-61 |
 * | 4 | 缓存键 + 扩展名拼出的条目名存在于真实 ZIP | Mods/Images/<cacheFileName(...,"jpg")> 在 s_dial ZIP 中 | L63-70 |
 *
 * 纯函数（已绿，不影响夹具）：L73-113 覆盖 : / ? # [ ] @ ! $ & ' ( ) * + , ; = ~ % . - _ 全去除
 * + 中文 + 空格去除 + 幂等。
 *
 * ### tests/unit/archive-ttsmod.test.ts（8 个 fixture 用例）
 * 激活条件：候选目录含 s_dial.ttsmod（L50-65）；describeExtracted 还需 TTS_EXTRACTED_DIR
 *
 * | # | describe | 用例数 | 期望 |
 * |---|---|---|---|
 * | 5 | describeFixture 反向互操作：readZip 读取 3 个真实样本（L219） | 3 (it.each) | 条目数 = 51/4/13；含 Mods/Workshop/{882532068.json,333845772.cjc,379104394.json} + Thumbnails/{id}.png；所有条目以 Mods/ 开头 |
 * | 6 | （嵌于上）样本条目名 = sanitize(url) + 固定扩展名（L235） | 1 | s_dial 含 Mods/Models/<cacheFileName(...,"obj")> |
 * | 7 | describeExtracted 与预先解包目录逐字节一致（L242） | 1 | sample_diceset 的 JSON / PNG / OBJ Buffer.compare === 0 |
 * | 8 | describeFixture importTtsmod：3 个真实样本全部导入成功（L627） | 3 (it.each) | extracted === totalEntries、skippedExisting === []、二次导入 extracted === 0 |
 *
 * ### tests/unit/pack-unpack.test.ts（1 个 fixture 用例）
 * 激活条件：候选目录含 sample_diceset.ttsmod（L41-51）
 *
 * | # | 用例 | 期望 |
 * |---|---|---|
 * | 9 | unpackSave（真实夹具 sample_diceset.ttsmod） | .tts/skeleton.json 落盘、SaveName === 'Custom Dice Set'、ObjectStates 长度 = 11、objects/ 下 11 个子目录、source/models/ 下 11 个 .obj |
 *
 * ## URL 特殊字符来源（生成器必须保留）
 *
 * | 字符 | 来源测试用例 | 真实样本中的 URL |
 * |---|---|---|
 * | `?` `=` | archive-cachekey.test.ts:56-61 | http://pastebin.com/raw.php?i=cDn7Eum6（sample_diceset） |
 * | 大写字母 | archive-cachekey.test.ts:51-54 | http://nikulas.webs.com/UV.png（s_hex） |
 * | `/` `:` | archive-cachekey.test.ts:44-49 | https://raw.githubusercontent.com/DasUmlaut/...（s_dial） |
 *
 * ## 匿名化规则（施工方案-v0.8.0 §6.5 + 实测修正）
 *
 * | 原内容 | 替换为 | 保留 |
 * |---|---|---|
 * | URL 主机（https://cloud-3.steamusercontent.com/ugc/...） | https://example.com/ | **路径中的所有特殊字符** |
 * | Description | `占位文本 N`（N 为序号） | 字段存在性 |
 * | 图片/模型/PDF 二进制 | 1 字节占位（0x00） | 文件扩展名与 sanitize 文件名一致性 |
 * | Nickname / SaveName / LuaScript / GUID / CardID / CustomDeck key | **保留原值** | — |
 *
 * **实测修正**（2026-10-07 主窗口跑测试发现）：
 * - Nickname 不能匿名化——pack-unpack.test.ts:315 断言两个 Nickname === 'D8' 重名追加 .2
 * - SaveName 不能匿名化——pack-unpack.test.ts:298 断言 SaveName === 'Custom Dice Set'
 * - LuaScript 不能替换为 print("fixture")——pack-unpack.test.ts:329 断言空字符串（保持空）
 * - .cjc 不是 JSON 是二进制——不能 JSON.parse，原样保留字节即可（archive-ttsmod.test.ts:222-228 仅断言存在）
 *
 * ## 实现要点
 *
 * - 不引入新依赖：复用 src/archive/ttsmod.ts 的 writeZip / readZip（Node 内置 node:zlib）
 * - 递归遍历 ObjectStates：5 种容器键 ObjectStates / ContainedObjects / ChildObjects /
 *   States / AttachedDecals 全处理（坑 4，参考 src/deck/patch.ts:103-106）
 * - URL 替换正则：`/^https?:\/\/[^\/]+/` → `https://example.com`（保留路径全部）
 * - 自检：脚本末尾断言 3 个输出 .ttsmod 条目数 = 51/4/13
 * - 跨平台：path.join
 * - s_hex.ttsmod 的 Workshop 存档必须是 .cjc 扩展名（不改名）
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// 复用 tts-toolkit 自身的 ZIP 编解码（不引入新依赖）
import { writeZip, readZip } from "../dist/archive/ttsmod.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---- 配置 ----
const REPO_ROOT = path.resolve(__dirname, "..");
const RESEARCH_DIR = "D:\\工具\\TTS\\research";
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures");
const EXTRACTED_DIR = path.join(FIXTURE_DIR, "extracted");

const SAMPLES = [
  { name: "s_dial.ttsmod", expectedEntries: 51 },
  { name: "s_hex.ttsmod", expectedEntries: 4 },
  { name: "sample_diceset.ttsmod", expectedEntries: 13 },
];

// 需要解包到 extracted/ 的样本
const EXTRACT_SAMPLE = "sample_diceset.ttsmod";

// ---- 匿名化：URL 主机替换 ----
function anonymizeUrl(url) {
  if (typeof url !== "string") return url;
  // 保留路径全部（含 ? = & % + 空格 中文 等特殊字符）
  return url.replace(/^https?:\/\/[^\/]+/i, "https://example.com");
}

// ---- 匿名化：递归遍历存档 JSON ----
// 坑 4：5 种容器键 ObjectStates / ContainedObjects / ChildObjects / States / AttachedDecals
// 参考 src/deck/patch.ts:103-106
const CONTAINER_KEYS = ["ObjectStates", "ContainedObjects", "ChildObjects", "States", "AttachedDecals"];

let placeholderCounter = 0;
function nextPlaceholder() {
  placeholderCounter += 1;
  return `占位文本 ${placeholderCounter}`;
}

function anonymizeObject(obj) {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) anonymizeObject(item);
    return;
  }

  // 处理当前对象的字段
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      // URL 字段：以 http:// 或 https:// 开头的字符串
      if (/^https?:\/\//i.test(value)) {
        obj[key] = anonymizeUrl(value);
      }
      // Description：替换为占位（仅这个字段做内容匿名化）
      // 注意：Nickname / SaveName / LuaScript 必须**保留原值**——
      // pack-unpack.test.ts:298 断言 SaveName === 'Custom Dice Set'，
      // pack-unpack.test.ts:315 断言两个 Nickname === 'D8' 重名追加 .2，
      // pack-unpack.test.ts:329 断言 LuaScript 空字符串（保持空）
      else if (key === "Description") {
        obj[key] = nextPlaceholder();
      }
      // GUID / CardID / CustomDeck key / Nickname / SaveName / LuaScript：保留原值（不动）
    } else if (typeof value === "object" && value !== null) {
      // 递归下钻容器键
      if (CONTAINER_KEYS.includes(key)) {
        anonymizeObject(value);
      } else {
        // 其他对象/数组字段也递归（比如 CustomDeck 是映射）
        anonymizeObject(value);
      }
    }
  }
}

// ---- 匿名化：单个 .ttsmod ----
async function anonymizeTtsmod(inputPath, outputPath) {
  const zipBytes = await readFile(inputPath);
  const entries = readZip(zipBytes);

  const newEntries = [];
  for (const entry of entries) {
    const name = entry.name;
    const data = Buffer.from(entry.data);

    // Workshop 存档 .json：解析 + 匿名化 + 重新序列化
    if (/^Mods\/Workshop\/\d+\.json$/.test(name)) {
      const text = data.toString("utf8");
      let saveObj;
      try {
        saveObj = JSON.parse(text);
      } catch (e) {
        throw new Error(`存档 JSON 解析失败：${name} in ${inputPath}：${e.message}`);
      }
      anonymizeObject(saveObj);
      const newText = JSON.stringify(saveObj, null, 2);
      newEntries.push({ name, data: Buffer.from(newText, "utf8") });
    }
    // Workshop 存档 .cjc：TTS 缓存的二进制格式（不是 JSON！），原样保留字节
    // 测试仅断言条目存在（archive-ttsmod.test.ts:222-228），不解析内容
    else if (/^Mods\/Workshop\/\d+\.cjc$/.test(name)) {
      newEntries.push({ name, data });
    }
    // 缩略图 / 素材二进制：替换为 1 字节
    else if (/^Mods\/(Workshop\/Thumbnails|Images|Models|Assetbundles|PDF|Audio)\//.test(name)) {
      newEntries.push({ name, data: Buffer.from([0x00]) });
    }
    // 其他条目（如果有）：保留原字节（防御性，实际样本不应有）
    else {
      newEntries.push({ name, data });
    }
  }

  const newZip = writeZip(newEntries);
  await writeFile(outputPath, newZip);
  return { entryCount: newEntries.length, outputSize: newZip.length };
}

// ---- 解包到 extracted/ ----
async function extractTtsmod(inputPath, outputDir) {
  const zipBytes = await readFile(inputPath);
  const entries = readZip(zipBytes);

  let fileCount = 0;
  for (const entry of entries) {
    const name = entry.name;
    // 跳过目录条目（TTS .ttsmod 实际没有，防御）
    if (name.endsWith("/")) continue;
    const filePath = path.join(outputDir, name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from(entry.data));
    fileCount += 1;
  }
  return fileCount;
}

// ---- 主流程 ----
async function main() {
  console.log(`[make-fixture] 真实样本目录：${RESEARCH_DIR}`);
  console.log(`[make-fixture] 夹具输出目录：${FIXTURE_DIR}`);
  console.log(`[make-fixture] extracted 目录：${EXTRACTED_DIR}`);

  // 检查真实样本存在
  for (const { name } of SAMPLES) {
    const inputPath = path.join(RESEARCH_DIR, name);
    try {
      await readFile(inputPath);
    } catch {
      console.error(`[make-fixture] ❌ 真实样本缺失：${inputPath}`);
      console.error(`[make-fixture] 请确保 D:\\工具\\TTS\\research\\ 下有以下文件：`);
      SAMPLES.forEach(({ name: n }) => console.error(`  - ${n}`));
      process.exit(1);
    }
  }

  // 建输出目录
  await mkdir(FIXTURE_DIR, { recursive: true });
  await mkdir(EXTRACTED_DIR, { recursive: true });

  // 逐样本匿名化
  const results = [];
  for (const { name, expectedEntries } of SAMPLES) {
    const inputPath = path.join(RESEARCH_DIR, name);
    const outputPath = path.join(FIXTURE_DIR, name);
    const { entryCount, outputSize } = await anonymizeTtsmod(inputPath, outputPath);

    const sizeKB = (outputSize / 1024).toFixed(1);
    console.log(`[make-fixture] ✅ ${name}: ${entryCount} 条目, ${sizeKB} KB`);

    // 自检：条目数
    if (entryCount !== expectedEntries) {
      console.error(`[make-fixture] ❌ ${name} 条目数 ${entryCount} ≠ 期望 ${expectedEntries}`);
      process.exit(1);
    }
    // 自检：≤ 100KB
    if (outputSize > 100 * 1024) {
      console.error(`[make-fixture] ❌ ${name} 大小 ${sizeKB} KB 超过 100KB 上限`);
      process.exit(1);
    }
    results.push({ name, entryCount, outputSize });
  }

  // 解包 sample_diceset 到 extracted/
  // 注意：必须解包**匿名化后**的 .ttsmod（不是真实样本原包），否则
  // archive-ttsmod.test.ts:243 的 Buffer.compare === 0 断言会失败
  // （fixture .ttsmod 内是匿名化后的 JSON/1字节占位，extracted/ 必须字节一致）
  const extractInput = path.join(FIXTURE_DIR, EXTRACT_SAMPLE);
  const fileCount = await extractTtsmod(extractInput, EXTRACTED_DIR);
  console.log(`[make-fixture] ✅ extracted/: ${fileCount} 文件（来自匿名化后 ${EXTRACT_SAMPLE}）`);

  if (fileCount !== 13) {
    console.error(`[make-fixture] ❌ extracted/ 文件数 ${fileCount} ≠ 期望 13`);
    process.exit(1);
  }

  // 自检：s_hex.ttsmod 的 Workshop 必须是 .cjc
  const hexBytes = await readFile(path.join(FIXTURE_DIR, "s_hex.ttsmod"));
  const hexEntries = readZip(hexBytes);
  const hasCjc = hexEntries.some((e) => e.name === "Mods/Workshop/333845772.cjc");
  if (!hasCjc) {
    console.error(`[make-fixture] ❌ s_hex.ttsmod 缺 Mods/Workshop/333845772.cjc`);
    process.exit(1);
  }
  console.log(`[make-fixture] ✅ s_hex.ttsmod 含 .cjc 扩展名（保留原样）`);

  // 自检：每个 .ttsmod 的 Workshop JSON 可解析（.cjc 是二进制，跳过 parse）
  for (const { name } of SAMPLES) {
    const bytes = await readFile(path.join(FIXTURE_DIR, name));
    const entries = readZip(bytes);
    const workshopJson = entries.find((e) => /^Mods\/Workshop\/\d+\.json$/.test(e.name));
    const workshopCjc = entries.find((e) => /^Mods\/Workshop\/\d+\.cjc$/.test(e.name));
    if (!workshopJson && !workshopCjc) {
      console.error(`[make-fixture] ❌ ${name} 缺 Workshop 存档条目（.json 或 .cjc）`);
      process.exit(1);
    }
    if (workshopJson) {
      try {
        JSON.parse(Buffer.from(workshopJson.data).toString("utf8"));
      } catch (e) {
        console.error(`[make-fixture] ❌ ${name} Workshop 存档 JSON 解析失败：${e.message}`);
        process.exit(1);
      }
    }
  }
  console.log(`[make-fixture] ✅ Workshop 存档条目齐备（.json 可解析 / .cjc 二进制保留）`);

  console.log(`\n[make-fixture] 🎉 完工：`);
  console.log(`  - ${results.length} 个 .ttsmod（总 ${(results.reduce((s, r) => s + r.outputSize, 0) / 1024).toFixed(1)} KB）`);
  console.log(`  - extracted/ ${fileCount} 文件`);
  console.log(`\n[make-fixture] 下一步：`);
  console.log(`  cd tts-toolkit && npm test   # 期望 2037 passed / 69 skipped / 0 failed`);
}

main().catch((e) => {
  console.error(`[make-fixture] ❌ 失败：${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
