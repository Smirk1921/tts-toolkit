#!/usr/bin/env node
/**
 * esbuild-bundle.mjs — 方案 A bundle 流水线（窗口 v9-1，D1）
 *
 * ## 用途
 * 把 dist/ 下 3 个 ESM 入口（cli/index、cli/hub-main、mcp/main）连同其依赖打成
 * 自包含单文件 bundle，输出到 dist-bundle/，供 @yao-pkg/pkg 打成独立可执行文件。
 *
 * ## 关键配置（含两处已裁定的偏离）
 * - `format: "esm"` + `outExtension: { ".js": ".mjs" }`：3 个入口都用顶层 await
 *   （src/cli/index.ts:249、src/cli/hub-main.ts:61/65、src/mcp/main.ts:26），
 *   esbuild 对 cjs 输出格式的顶层 await 是生成期硬错误（`supported:
 *   { "top-level-await": true }` 与 banner/footer IIFE 均无法绕过），故按主窗口
 *   裁定走 ESM 产物，不改写 src/。
 * - `external: ["sharp", ...builtinModules]`：sharp 保持外置，由
 *   src/sharp-loader.ts 运行期动态加载（pkg 环境下从 exe 同级 native/ 注入 PATH）。
 *
 * ## 顶层 await 与 shebang
 * esbuild 会保留入口自带的 hashbang，banner 又会再加一行，输出第 2 行成为
 * `#!`（Node 仅在文件第 0 字节接受 hashbang，第 2 行会 SyntaxError）。因此这里用
 * strip-entry-hashbang 插件剥掉入口源码首行 hashbang，再统一由 banner 补回。
 *
 * ## CJS 依赖的 require
 * ESM 产物里 CJS 依赖（yaml 等）经 esbuild 的 __require 垫片调用 require，垫片只在
 * 存在顶层 require 绑定时才放行，否则运行期抛 `Dynamic require of "process" is not
 * supported`。故 banner 用 createRequire(import.meta.url) 注入真 require；src/test/
 * bundle.ts 自带的 createRequire 会被 esbuild 改名为 require2，无重名冲突。
 *
 * ## 用法
 * ```bash
 * cd tts-toolkit
 * npm run bundle          # 等价于 node scripts/esbuild-bundle.mjs
 * ```
 * 前置：`npm run build`（tsc → dist/）。脚本末尾附 pkg 目标平台探测（只读，不影响产物）。
 */

import { build } from "esbuild";
import { execa } from "execa";
import { builtinModules } from "node:module";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const OUT_DIR = "dist-bundle";
const ENTRIES = [
  { in: "dist/cli/index.js", out: "tts" },
  { in: "dist/cli/hub-main.js", out: "tts-hub" },
  { in: "dist/mcp/main.js", out: "tts-mcp" },
];

const HASHBANG_RE = /^#![^\n]*\n/;

/**
 * CJS 依赖（yaml / bson / undici 等）在 ESM 产物里会走 esbuild 的 __require 垫片，
 * 垫片只在存在顶层 require 绑定时才生效，否则抛 `Dynamic require of "process" is
 * not supported`。这里用 createRequire 注入真 require（banner 内联，import 会被提升到文件顶部）。
 */
const BANNER = [
  "#!/usr/bin/env node",
  'import { createRequire as __ttsCreateRequire } from "node:module";',
  "const require = __ttsCreateRequire(import.meta.url);",
].join("\n");
const PKG_TARGETS_TO_PROBE = ["node22-win-x64", "node24-win-x64"];
/** 基线清单文件：官方 pkg 用 expected.js，@yao-pkg/pkg fork 用 expected-shas.json。 */
const PKG_TOOLS = [
  { name: "pkg", pkgFetch: ["node_modules", "pkg-fetch", "lib-es5", "expected.js"] },
  { name: "@yao-pkg/pkg", pkgFetch: ["node_modules", "@yao-pkg", "pkg-fetch", "lib-es5", "expected-shas.json"] },
];

const log = (message) => {
  console.log(`[esbuild-bundle] ${message}`);
};

const warn = (message) => {
  console.warn(`[esbuild-bundle] WARNING: ${message}`);
};

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** 剥掉 3 个入口源码首行的 hashbang，避免与 banner 叠成两行（第 2 行 `#!` 会 SyntaxError）。 */
function stripEntryHashbang() {
  const entryPaths = new Set(ENTRIES.map((entry) => path.resolve(projectRoot, entry.in).toLowerCase()));
  return {
    name: "strip-entry-hashbang",
    setup(buildContext) {
      buildContext.onLoad({ filter: /\.js$/ }, async (args) => {
        if (!entryPaths.has(path.resolve(args.path).toLowerCase())) {
          return null;
        }
        const source = await readFile(args.path, "utf8");
        if (!HASHBANG_RE.test(source)) {
          return null;
        }
        return { contents: source.replace(HASHBANG_RE, ""), loader: "js" };
      });
    },
  };
}

async function runBundle() {
  const started = Date.now();
  log("starting...");
  for (const entry of ENTRIES) {
    log(`entry: ${entry.in} → ${OUT_DIR}/${entry.out}.mjs`);
  }

  await rm(path.join(projectRoot, OUT_DIR), { recursive: true, force: true });

  const result = await build({
    absWorkingDir: projectRoot,
    entryPoints: ENTRIES.map((entry) => ({ in: entry.in, out: entry.out })),
    outdir: OUT_DIR,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external: ["sharp", ...builtinModules],
    supported: { "import-attributes": true },
    loader: { ".json": "json" },
    banner: { js: BANNER },
    sourcemap: false,
    minify: false,
    logLevel: "silent",
    metafile: true,
    plugins: [stripEntryHashbang()],
  });

  for (const warning of result.warnings) {
    warn(`${warning.location?.file ?? "?"}:${warning.location?.line ?? "?"} ${warning.text}`);
  }

  for (const entry of ENTRIES) {
    const target = path.join(projectRoot, OUT_DIR, `${entry.out}.mjs`);
    const { size } = await stat(target);
    log(`✅ ${entry.out}.mjs: ${formatBytes(size)}`);
  }

  return { elapsedMs: Date.now() - started, warnings: result.warnings.length };
}

/** 探测 pkg 系列工具的目标平台支持；只读，任何失败都只告警不中断。 */
async function probePkgTargets() {
  log(`probing pkg targets: ${PKG_TARGETS_TO_PROBE.join(" / ")}`);
  const helpText = await readPkgHelp(PKG_TOOLS[0].name);
  for (const target of PKG_TARGETS_TO_PROBE) {
    log(`  ${target} in \`npx ${PKG_TOOLS[0].name} --help\` output: ${helpText?.includes(target) ? "yes" : "no"}`);
  }
  if (helpText !== null && !PKG_TARGETS_TO_PROBE.some((target) => helpText.includes(target))) {
    log("  note: pkg --help 不打印 target 列表（只有 node12/node14 示例），该探测对目标平台无判别力");
  }
  for (const tool of PKG_TOOLS) {
    log(`  ${tool.name} installed: ${await readInstalledVersion(tool.name)}`);
    log(`  ${tool.name} win-x64 base binaries: ${await readPkgFetchVersions(tool.pkgFetch)}`);
  }
}

async function readPkgFetchVersions(pkgFetchPath) {
  try {
    const source = await readFile(path.join(projectRoot, ...pkgFetchPath), "utf8");
    const versions = [...new Set(source.match(/node-v\d+\.\d+\.\d+-win-x64/g) ?? [])].sort();
    return versions.length > 0 ? versions.join(", ") : "未在清单中找到 win-x64 基线";
  } catch {
    return "pkg-fetch 未安装";
  }
}

async function readPkgHelp(pkgTool) {
  try {
    const { stdout } = await execa("pwsh", ["-NoProfile", "-Command", `npx ${pkgTool} --help`], {
      cwd: projectRoot,
      reject: false,
    });
    return stdout;
  } catch (error) {
    warn(`pkg --help 探测失败（不影响 bundle）: ${error.shortMessage ?? error.message}`);
    return null;
  }
}

async function readInstalledVersion(tool) {
  try {
    const raw = await readFile(path.join(projectRoot, "node_modules", ...tool.split("/"), "package.json"), "utf8");
    return JSON.parse(raw).version;
  } catch {
    return "not installed";
  }
}

async function main() {
  const { elapsedMs } = await runBundle();
  try {
    await probePkgTargets();
  } catch (error) {
    warn(`pkg 目标平台探测异常（不影响 bundle）: ${error.message}`);
  }
  log(`done in ${(elapsedMs / 1000).toFixed(2)}s`);
}

main().catch((error) => {
  console.error("[esbuild-bundle] FAILED:", error?.message ?? error);
  for (const detail of error?.errors ?? []) {
    console.error(`[esbuild-bundle]   ${detail.location?.file ?? "?"}:${detail.location?.line ?? "?"} ${detail.text}`);
  }
  process.exit(1);
});
