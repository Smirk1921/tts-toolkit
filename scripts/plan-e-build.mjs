/**
 * plan-e-build.mjs — 方案 E 打包流水线（窗口 v9-1，任务 A2）
 *
 * ## 用途
 * 把 tts-toolkit 打成独立可执行产物 product/：dist/ + node_modules（production 裁剪）
 * + locales + docs/schemas + bin/*.cmd 启动器 + bin/native（sharp 原生 DLL 兜底）。
 * runtime/node.exe 由维护者手动放置（脚本不下载）。
 *
 * ## 副作用（运行前必读）
 * - 第 1 步清场会杀掉所有 node.exe（含驻留 hub，释放 libvips-42.dll 锁），但排除
 *   脚本自身 PID 与父进程 PID（经 npm run 调用时是 npm 的 node）——否则脚本自杀
 *   （已获主窗口批准的偏离：字面 `Stop-Process -Name node` 会无差别命中自身）。
 * - 第 4 步 `npm prune --production` 会原地裁剪 node_modules（移除 devDependencies），
 *   恢复需重新 `npm ci` / `npm install`，脚本运行中会再次警告。
 *
 * ## 用法
 * ```bash
 * cd tts-toolkit
 * npm run plan:e                                   # 正式打包
 * PLAN_E_DRY_RUN=1 node scripts/plan-e-build.mjs   # 演练：跳过清场 / build / prune
 *                                                  # 三个副作用步骤，产物输出到
 *                                                  # product-dry-run/，其余全量执行
 * ```
 */

import { execa } from "execa";
import { copyFile, cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DRY_RUN = process.env.PLAN_E_DRY_RUN === "1";
const TOTAL_STEPS = 14;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const productDirName = DRY_RUN ? "product-dry-run" : "product";
const productRoot = path.join(projectRoot, productDirName);

const BIN_LAUNCHERS = [
  { file: "tts.cmd", entry: "dist/cli/index.js" },
  { file: "tts-hub.cmd", entry: "dist/cli/hub-main.js" },
  { file: "tts-mcp.cmd", entry: "dist/mcp/main.js" },
];

const SHARP_NATIVE_SRC = path.join(projectRoot, "node_modules", "@img", "sharp-win32-x64", "lib");

const step = (n, message) => {
  console.log(`[plan-e-build] step ${n}/${TOTAL_STEPS}: ${message}`);
};

const warn = (message) => {
  console.warn(`[plan-e-build] WARNING: ${message}`);
};

const skipInDryRun = () => {
  console.log("[plan-e-build]   (dry-run) 跳过");
};

async function copyDir(src, dest, label) {
  let srcStat;
  try {
    srcStat = await stat(src);
  } catch {
    throw new Error(`${label} 不存在，打包中止: ${src}`);
  }
  if (!srcStat.isDirectory()) {
    throw new Error(`${label} 不是目录，打包中止: ${src}`);
  }
  await cp(src, dest, { recursive: true });
}

async function copyDirIfExists(src, dest, label) {
  try {
    await stat(src);
  } catch {
    warn(`${label} 不存在，跳过: ${src}`);
    return;
  }
  await cp(src, dest, { recursive: true });
}

async function runNpm(command) {
  await execa("pwsh", ["-NoProfile", "-Command", command], { cwd: projectRoot, stdio: "inherit" });
}

async function killStaleNodeProcesses() {
  const excludePids = [process.pid, process.ppid].filter((pid) => Number.isFinite(pid));
  const command =
    `Get-Process node -ErrorAction SilentlyContinue | ` +
    `Where-Object { @(${excludePids.join(",")}) -notcontains $_.Id } | ` +
    `Stop-Process -Force -ErrorAction SilentlyContinue`;
  try {
    await execa("pwsh", ["-NoProfile", "-Command", command]);
  } catch (error) {
    warn(`清场命令未执行成功（无 pwsh 或进程已自行退出时可忽略）: ${error.shortMessage ?? error.message}`);
  }
}

async function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await dirSize(full);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      bytes += (await stat(full)).size;
      files += 1;
    }
  }
  return { bytes, files };
}

const formatMB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function cmdLauncherContent(entry) {
  const entryPath = entry.replaceAll("/", "\\");
  return `@echo off\r\n"%~dp0..\\runtime\\node.exe" "%~dp0..\\${entryPath}" %*\r\n`;
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("plan-e 产物面向 Windows（.cmd 启动器 + pwsh 清场），请在 Windows 上运行");
  }
  console.log("[plan-e-build] starting...");
  if (DRY_RUN) {
    warn(`DRY RUN：跳过清场 / npm run build / npm prune 三个副作用步骤，产物输出到 ${productDirName}/`);
  }

  step(1, "清场：杀掉所有 node.exe（排除自身与父进程，释放 sharp DLL 锁）");
  if (DRY_RUN) {
    skipInDryRun();
  } else {
    await killStaleNodeProcesses();
  }

  step(2, `清理 ${productDirName}/ 目录（递归删除）`);
  await rm(productRoot, { recursive: true, force: true });

  step(3, "npm run build（tsc 编译 src/ → dist/）");
  if (DRY_RUN) {
    skipInDryRun();
  } else {
    await runNpm("npm run build");
  }

  step(4, "npm prune --production（裁剪 node_modules）");
  if (DRY_RUN) {
    skipInDryRun();
  } else {
    warn("npm prune --production 会原地裁剪 node_modules（移除 devDependencies），恢复需重新 npm ci / npm install");
    await runNpm("npm prune --production");
  }

  step(5, "复制 dist/ → product/dist/");
  await copyDir(path.join(projectRoot, "dist"), path.join(productRoot, "dist"), "dist/");

  step(6, "复制 node_modules/ → product/node_modules/（最大的一步，请耐心等待）");
  await copyDir(path.join(projectRoot, "node_modules"), path.join(productRoot, "node_modules"), "node_modules/");

  step(7, "复制 package.json → product/");
  await copyFile(path.join(projectRoot, "package.json"), path.join(productRoot, "package.json"));

  step(8, "复制 locales/ → product/locales/");
  await copyDir(path.join(projectRoot, "locales"), path.join(productRoot, "locales"), "locales/");

  step(9, "复制 docs/schemas/ → product/docs/schemas/（如存在）");
  await copyDirIfExists(
    path.join(projectRoot, "docs", "schemas"),
    path.join(productRoot, "docs", "schemas"),
    "docs/schemas/",
  );

  step(10, "创建 product/bin/");
  await mkdir(path.join(productRoot, "bin"), { recursive: true });

  step(11, "写入 3 个 .cmd 启动器（tts / tts-hub / tts-mcp）");
  for (const { file, entry } of BIN_LAUNCHERS) {
    const target = path.join(productRoot, "bin", file);
    await writeFile(target, cmdLauncherContent(entry));
    console.log(`[plan-e-build]   ${path.join(productDirName, "bin", file)} → %~dp0..\\${entry.replaceAll("/", "\\")}`);
  }

  step(12, "创建 product/runtime/（不下载 node.exe）");
  await mkdir(path.join(productRoot, "runtime"), { recursive: true });
  console.log("[plan-e-build]   请手动放置 node.exe（>=24.19.0 win-x64）到 product/runtime/node.exe");

  step(13, "复制 sharp 原生库 @img/sharp-win32-x64/lib → product/bin/native/");
  const nativeDest = path.join(productRoot, "bin", "native");
  await copyDir(SHARP_NATIVE_SRC, nativeDest, "sharp 原生库 @img/sharp-win32-x64/lib");
  const nativeFiles = (await readdir(nativeDest)).sort();
  console.log(`[plan-e-build]   ${nativeFiles.length} 个文件: ${nativeFiles.join(", ")}`);

  step(14, `统计 ${productDirName}/ 总大小`);
  const { bytes, files } = await dirSize(productRoot);
  console.log(`[plan-e-build]   ${productDirName}/ 总大小 ${formatMB(bytes)}（${files} 个文件）`);

  console.log(`[plan-e-build] done${DRY_RUN ? " (dry-run)" : ""}: ${productRoot}`);
}

main().catch((error) => {
  console.error("[plan-e-build] FAILED:", error?.message ?? error);
  process.exit(1);
});
