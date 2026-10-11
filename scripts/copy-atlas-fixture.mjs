/**
 * copy-atlas-fixture.mjs — 真实图集夹具入库脚本（窗口 v9-1 / A3）
 *
 * 把 TTS 客户端自带的 SettingsCat.png 复制为
 * tests/fixtures/atlas/settings-cat-2232x1920.png，供 v9-1 deck slice POC 使用。
 *
 * 仅维护者本机使用：依赖 D:\工具\TTS\SettingsCat.png（贡献者无需跑，产物已入库）。
 *
 * 用法：
 *   cd tts-toolkit
 *   node scripts/copy-atlas-fixture.mjs
 */

import { access, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCE = "D:\\工具\\TTS\\SettingsCat.png";
const TOOLKIT_ROOT = path.resolve(__dirname, "..");
const ATLAS_DIR = path.join(TOOLKIT_ROOT, "tests", "fixtures", "atlas");
const FIXTURE_NAME = "settings-cat-2232x1920.png";
const FIXTURE_PATH = path.join(ATLAS_DIR, FIXTURE_NAME);
const README_PATH = path.join(ATLAS_DIR, "README.md");

const EXPECTED_WIDTH = 2232;
const EXPECTED_HEIGHT = 1920;

function readPngSize(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error("not a valid PNG file");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function main() {
  console.log("[copy-atlas-fixture] starting...");
  console.log(`[copy-atlas-fixture] source: ${SOURCE}`);
  console.log(`[copy-atlas-fixture] target: ${FIXTURE_PATH}`);

  await access(SOURCE).catch(() => {
    console.error("D:\\工具\\TTS\\SettingsCat.png not found");
    process.exit(1);
  });

  const [sourceStat, sourceBytes] = await Promise.all([stat(SOURCE), readFile(SOURCE)]);
  const { width, height } = readPngSize(sourceBytes);
  if (width !== EXPECTED_WIDTH || height !== EXPECTED_HEIGHT) {
    console.error(
      `[copy-atlas-fixture] ❌ 源图尺寸 ${width}x${height} ≠ 期望 ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}，文件名与内容不符`,
    );
    process.exit(1);
  }
  console.log(`[copy-atlas-fixture] ✅ 源图为有效 PNG，${width}x${height}，${sourceStat.size} 字节`);

  await mkdir(ATLAS_DIR, { recursive: true });
  await copyFile(SOURCE, FIXTURE_PATH);

  const fixtureStat = await stat(FIXTURE_PATH);
  if (fixtureStat.size !== sourceStat.size) {
    console.error(
      `[copy-atlas-fixture] ❌ 复制后大小 ${fixtureStat.size} ≠ 源大小 ${sourceStat.size}`,
    );
    process.exit(1);
  }

  const sizeMB = (fixtureStat.size / 1_000_000).toFixed(1);
  const readme = `# 真实图集夹具

## ${FIXTURE_NAME}

- **尺寸**：${width} x ${height}
- **大小**：${fixtureStat.size} 字节（~${sizeMB} MB）
- **来源**：TTS 官方资源（SettingsCat.png，TTS 客户端自带）
- **版权**：TTS 官方资源，无版权问题
- **用途**：v9-1 POC 验收 - tts deck slice 真实切图测试
- **网格**：可按 10x7 网格切 70 张卡图（223.2 x 274.3 per card）
`;
  await writeFile(README_PATH, readme, "utf8");

  console.log(`[copy-atlas-fixture] ✅ 夹具已入库：${FIXTURE_PATH}`);
  console.log(`[copy-atlas-fixture] ✅ README 已写入：${README_PATH}`);
  console.log(`[copy-atlas-fixture] 📦 夹具大小：${fixtureStat.size} 字节（~${sizeMB} MB）`);
}

main().catch((e) => {
  console.error(`[copy-atlas-fixture] ❌ 失败：${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
