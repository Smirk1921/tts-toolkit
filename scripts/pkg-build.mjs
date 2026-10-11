#!/usr/bin/env node
/**
 * pkg-build.mjs — 方案 A 打包流水线第二步（窗口 v9-1，D2）
 *
 * ## 用途
 * 把 dist-bundle/ 下 3 个自包含 bundle 打成独立 .exe 到 dist-pkg/，并铺好
 * 运行期需要的 native 资产与资源目录。
 *
 * ## 与任务书的三处偏离（均为实测裁定，非猜测）
 * 1. 入口是 `.mjs` 而不是 `.cjs`：D1（scripts/esbuild-bundle.mjs:122-127）因 3 个入口
 *    都有顶层 await，esbuild 的 cjs 输出格式是生成期硬错误，故产物为 ESM。本脚本
 *    两者都接受，优先 `.mjs`。ESM 入口要求工具是 `@yao-pkg/pkg`（官方 pkg 5.8 只
 *    解析 CJS），实测见下一条。
 * 2. 工具是 `@yao-pkg/pkg`（fork）而不是 `pkg`：官方 `pkg@5.8.1` 的 pkg-fetch 只
 *    到 node18（`node_modules/pkg-fetch/lib-es5/expected.js`），`--targets
 *    node22-win-x64` 直接报 `Error! No available node version satisfies 'node22'`。
 *    fork 的 pkg-fetch 3.6 清单含 `node-v22.23.2-win-x64`。脚本先用清单探测本地
 *    pkg 是否覆盖目标平台，覆盖才用它，否则走 npx fork；可用 TTS_PKG_TOOL 覆盖。
 * 3. 基线二进制预热：pkg-fetch 从 GitHub Releases 取基线，本机 github.com 直连不通
 *    （需代理，且代理不稳），而 npmmirror 的 pkg-fetch 镜像可直连（同样的发布资产）。
 *    故缓存缺失时先从镜像预热 + 校验 sha256，再交给 pkg。镜像可用 TTS_PKG_MIRROR 覆盖。
 *
 * ## 失败语义
 * 按任务书要求不 process.exit(1)：任何一步失败都打印 `[pkg-build] ❌ failed: ...`
 * 后正常返回（退出码 0），由主窗口决定如何处理。
 *
 * ## 用法
 * ```bash
 * cd tts-toolkit
 * npm run bundle && npm run pkg:build     # 等价于 node scripts/pkg-build.mjs
 * ```
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const BUNDLE_DIR = "dist-bundle";
const OUT_DIR = "dist-pkg";
const NATIVE_DIR = path.posix.join(OUT_DIR, "native");
const ENTRIES = ["tts", "tts-hub", "tts-mcp"];
const TARGET = process.env.TTS_PKG_TARGET ?? "node22-win-x64";
const YAO_PKG = "@yao-pkg/pkg@6.23.0";
const LOCAL_PKG = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "pkg.cmd" : "pkg");
const LOCAL_PKG_FETCH_MANIFESTS = [
  ["node_modules", "pkg-fetch", "lib-es5", "expected.js"],
  ["node_modules", "@yao-pkg", "pkg-fetch", "lib-es5", "expected-shas.json"],
];
const SHARP_LIB_DIR = ["node_modules", "@img", "sharp-win32-x64", "lib"];
const NATIVE_ASSETS = ["libvips-42.dll", "libvips-cpp-8.18.7.dll", "sharp-win32-x64-0.35.5.node"];
/** [项目内源目录, dist-pkg 内目标目录] */
const RESOURCE_DIRS = [
  ["locales", "locales"],
  ["docs/schemas", path.posix.join("docs", "schemas")],
];
const MIRROR_BASE = process.env.TTS_PKG_MIRROR ?? "https://registry.npmmirror.com/-/binary/pkg-fetch";
const BASE_BINARY = { tag: "v3.6", name: "node-v22.23.2-win-x64" };
const REMOTE_NOT_FOUND_RE = /Not found in remote cache:\s*(\{[^}]*\})/;
/** 单次打包上限：正常 6~10s，出现过 pkg 写盘后卡死（外部环境因素），故给 5 分钟 + 超时重试一次。 */
const PKG_TIMEOUT_MS = 5 * 60 * 1000;

const log = (message) => {
  console.log(`[pkg-build] ${message}`);
};

const warn = (message) => {
  console.warn(`[pkg-build] WARNING: ${message}`);
};

const ANSI_RE = /\u001B\[[0-9;]*m/g;

/** pkg 的告警只走 stdout，成功时也要转出来（例如 sharp 的 build/Release、vendor/lib 目录告警）。 */
function surfaceWarnings(output) {
  const lines = output.replace(ANSI_RE, "").split(/\r?\n/);
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const head = lines[index].trim();
    if (!/warning/i.test(head)) {
      continue;
    }
    const block = [head.replace(/^>\s*/, "")];
    let next = index + 1;
    while (next < lines.length) {
      const line = lines[next].trim();
      if (line === "" || line.startsWith(">")) {
        break;
      }
      block.push(line);
      next += 1;
    }
    const text = block.join(" / ");
    if (!seen.has(text)) {
      seen.add(text);
      warn(text);
    }
    index = next - 1;
  }
}

/** @returns {Promise<boolean>} */
async function fileExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 入口优先 `.mjs`（D1 实际产物），退回任务书写的 `.cjs`。 @returns {Promise<{in:string,out:string}[]>} */
async function resolveEntries() {
  const resolved = [];
  const missing = [];
  for (const name of ENTRIES) {
    const candidates = [`${name}.mjs`, `${name}.cjs`];
    let found = null;
    for (const candidate of candidates) {
      if (await fileExists(path.join(projectRoot, BUNDLE_DIR, candidate))) {
        found = candidate;
        break;
      }
    }
    if (found === null) {
      missing.push(`${BUNDLE_DIR}/${candidates.join(" | ")}`);
      continue;
    }
    resolved.push({ in: path.posix.join(BUNDLE_DIR, found), out: path.posix.join(OUT_DIR, `${name}.exe`) });
  }
  return { resolved, missing };
}

/** 读本地 pkg 的 pkg-fetch 基线清单，判断是否含目标 node 大版本的 win-x64 基线。 @returns {Promise<boolean>} */
async function localPkgCoversTarget() {
  const major = /^node(\d+)/.exec(TARGET)?.[1];
  if (major === undefined) {
    return false;
  }
  const pattern = new RegExp(`node-v${major}\\.\\d+\\.\\d+-win-x64`);
  for (const manifest of LOCAL_PKG_FETCH_MANIFESTS) {
    try {
      const text = await readFile(path.join(projectRoot, ...manifest), "utf8");
      if (pattern.test(text)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/** 选 pkg 执行器：本地 pkg 能覆盖目标平台才用它，否则用 npx 上的 fork。 @returns {Promise<{label:string,command:string}>} */
async function resolvePkgRunner() {
  const override = process.env.TTS_PKG_TOOL;
  if (override !== undefined && override.trim() !== "") {
    return { label: override.trim(), command: override.trim() };
  }
  if ((await fileExists(LOCAL_PKG)) && (await localPkgCoversTarget())) {
    return { label: `pkg (local, ${TARGET} in pkg-fetch manifest)`, command: `"${LOCAL_PKG}"` };
  }
  return { label: `npx --yes ${YAO_PKG} (fork: 官方 pkg 基线不支持 ${TARGET} / ESM 入口)`, command: `npx --yes ${YAO_PKG}` };
}

/** @returns {string} 缓存文件路径，命名同 pkg-fetch places.js 的 `fetched-<node>-<platform>-<arch>`。 */
function baseBinaryPath(tag, name) {
  const cachePath = process.env.PKG_CACHE_PATH ?? path.join(homedir(), ".pkg-cache");
  return path.join(cachePath, tag, `fetched-${name.replace(/^node-/, "")}`);
}

/** 从镜像预热一个 pkg-fetch 基线二进制（sha256 校验通过才落盘）。 @returns {Promise<string>} */
async function warmBaseBinary(tag, name) {
  const dest = baseBinaryPath(tag, name);
  const url = `${MIRROR_BASE}/${tag}/${name}`;
  const sha256 = await fetch(`${url}.sha256sum`);
  if (!sha256.ok) {
    throw new Error(`mirror sha256sum HTTP ${sha256.status}`);
  }
  const expected = (await sha256.text()).trim().split(/\s+/)[0];
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`mirror HTTP ${response.status} for ${url}`);
  }
  await mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const bytes = await readFile(partial);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    await unlink(partial);
    throw new Error(`sha256 mismatch: ${actual} != ${expected}`);
  }
  await rename(partial, dest);
  return dest;
}

/** pkg 走 GitHub Releases 取基线；缓存缺失时先预热，避免走到「从源码编译」那条死路。 @returns {Promise<void>} */
async function ensureBaseBinary() {
  const cached = baseBinaryPath(BASE_BINARY.tag, BASE_BINARY.name);
  if (await fileExists(cached)) {
    log(`base binary cached: ${cached}`);
    return;
  }
  try {
    const dest = await warmBaseBinary(BASE_BINARY.tag, BASE_BINARY.name);
    const { size } = await stat(dest);
    log(`base binary warmed: ${dest} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  } catch (error) {
    warn(`base binary warm-up failed (${error.message}); pkg 将自行下载基线`);
  }
}

/** 跑一次 pkg。 @returns {Promise<{ok:boolean,output:string,timedOut:boolean,exitCode:number|null}>} */
async function runPkg(command, entry) {
  const line = `${command} ${entry.in.replace(/\\/g, "/")} --targets ${TARGET} --output ${entry.out}`;
  const result = await execa("pwsh", ["-NoProfile", "-Command", line], {
    cwd: projectRoot,
    reject: false,
    timeout: PKG_TIMEOUT_MS,
    all: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.exitCode === 0, output, timedOut: result.timedOut === true, exitCode: result.exitCode ?? null };
}

/** 从 pkg 失败输出里解析远端基线坐标，命中则预热并重试一次。 @returns {Promise<{ok:boolean,output:string,timedOut:boolean,exitCode:number|null}>} */
async function packageEntry(command, entry) {
  const first = await runPkg(command, entry);
  if (first.ok) {
    return first;
  }
  const remote = REMOTE_NOT_FOUND_RE.exec(first.output);
  if (remote === null) {
    return first;
  }
  let remotePlace;
  try {
    remotePlace = JSON.parse(remote[1]);
  } catch {
    return first;
  }
  log(`base binary missing upstream (${remotePlace.tag}/${remotePlace.name}); warming from mirror...`);
  try {
    const dest = await warmBaseBinary(remotePlace.tag, remotePlace.name);
    log(`base binary warmed: ${dest}`);
  } catch (error) {
    return { ok: false, output: `${first.output}\nwarm-up failed: ${error.message}`, timedOut: false, exitCode: first.exitCode };
  }
  return runPkg(command, entry);
}

/** @returns {string} 失败原因行，pkg 无输出时退回超时/退出码描述。 */
function describeFailure(result) {
  const text = result.output
    .replace(ANSI_RE, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-3)
    .join(" | ");
  if (text !== "") {
    return text;
  }
  return result.timedOut ? `pkg timed out after ${PKG_TIMEOUT_MS / 60000} min` : `pkg exited with code ${result.exitCode}`;
}

/** @returns {Promise<void>} */
async function copyNativeAssets() {
  log("copying native assets...");
  await mkdir(path.join(projectRoot, NATIVE_DIR), { recursive: true });
  for (const asset of NATIVE_ASSETS) {
    const from = path.join(projectRoot, ...SHARP_LIB_DIR, asset);
    const to = path.join(projectRoot, NATIVE_DIR, asset);
    if (!(await fileExists(from))) {
      warn(`native asset missing: ${path.posix.join(...SHARP_LIB_DIR, asset)}`);
      continue;
    }
    await cp(from, to);
    const { size } = await stat(to);
    log(`  ${asset}: ${(size / 1024 / 1024).toFixed(2)} MB`);
  }
}

/** @returns {Promise<void>} */
async function copyResourceDirs() {
  for (const [from, to] of RESOURCE_DIRS) {
    const source = path.join(projectRoot, from);
    if (!(await fileExists(source))) {
      warn(`resource dir missing, skipped: ${from}`);
      continue;
    }
    await cp(source, path.join(projectRoot, OUT_DIR, to), { recursive: true });
    log(`  ${from} → ${path.posix.join(OUT_DIR, to)}`);
  }
}

/** 清掉上一轮的单件产物，避免陈旧文件被误判成本次成功。 @returns {Promise<void>} */
async function clearOutput(relative) {
  try {
    await rm(path.join(projectRoot, relative), { force: true });
  } catch (error) {
    warn(`cannot remove stale ${relative} (${error.code ?? error.message})`);
  }
}

/** 清空 dist-pkg/：目录可能被外部句柄占用（EBUSY），重试后逐个清理产物。 @returns {Promise<void>} */
async function prepareOutDir() {
  const outDir = path.join(projectRoot, OUT_DIR);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await rm(outDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 5) {
        warn(`cannot remove ${OUT_DIR} (${error.code ?? error.message}); 改为逐个清理产物`);
        for (const name of [...ENTRIES.map((entry) => `${entry}.exe`), "native", "locales", path.posix.join("docs", "schemas")]) {
          await clearOutput(path.posix.join(OUT_DIR, name));
        }
        break;
      }
      await delay(2000);
    }
  }
  await mkdir(outDir, { recursive: true });
}

/** @returns {Promise<string>} 打包摘要（成功/失败各自的收尾行） */
async function summarize(built, failures) {
  let total = 0;
  for (const entry of built) {
    const target = path.join(projectRoot, entry.out);
    if (!(await fileExists(target))) {
      warn(`missing output: ${entry.out}`);
      continue;
    }
    const { size } = await stat(target);
    const mb = size / 1024 / 1024;
    total += mb;
    log(`✅ ${path.basename(entry.out)}: ${mb.toFixed(2)} MB`);
  }
  if (failures.length > 0) {
    return `❌ failed: ${failures.join("; ")}`;
  }
  log(`total: ${total.toFixed(2)} MB`);
  return "✅ done";
}

/** @returns {Promise<void>} */
async function main() {
  log("starting...");

  const { resolved, missing } = await resolveEntries();
  if (missing.length > 0) {
    log(`❌ failed: bundle missing (${missing.join(", ")}); run \`npm run bundle\` first`);
    return;
  }

  const runner = await resolvePkgRunner();
  log(`pkg runner: ${runner.label}`);
  await ensureBaseBinary();

  await prepareOutDir();

  const built = [];
  const failures = [];
  for (const entry of resolved) {
    log(`packaging ${path.basename(entry.in)} → ${entry.out}`);
    await clearOutput(entry.out);
    let result = await packageEntry(runner.command, entry);
    if (!result.ok && result.timedOut) {
      log(`⚠ ${path.basename(entry.out)}: pkg 无响应，重试一次`);
      result = await packageEntry(runner.command, entry);
    }
    if (result.ok) {
      surfaceWarnings(result.output);
      built.push(entry);
      continue;
    }
    const reason = describeFailure(result);
    log(`❌ ${path.basename(entry.out)}: ${reason}`);
    failures.push(`${path.basename(entry.out)}: ${reason}`);
  }

  if (built.length > 0) {
    await copyNativeAssets();
    await copyResourceDirs();
  }

  log(await summarize(built, failures));
}

main().catch((error) => {
  log(`❌ failed: ${error?.message ?? error}`);
});
