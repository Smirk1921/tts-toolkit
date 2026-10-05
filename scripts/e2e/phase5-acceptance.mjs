// Stage 4 实跑验收：阶段 5 写入路径
// 主窗口手动执行，不在 vitest 内
// 前置：TTS 运行中，加载第七大陆全扩（或类似存档）
// 用法：node scripts/e2e/phase5-acceptance.mjs [--step 1|2|3|...|all]

import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const CLI = path.join(ROOT, "dist/cli/index.js");

const step = process.argv.find((a) => a.startsWith("--step"))?.split("=")[1] ?? process.argv[process.argv.indexOf("--step") + 1] ?? "all";

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function ok(name) { console.log(`  ✅ ${name}`); }
function fail(name, reason) { console.error(`  ❌ ${name}: ${reason}`); process.exitCode = 1; }

function runCli(args, opts = {}) {
  const r = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"], ...opts });
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    r.stdout.on("data", (d) => { stdout += d; });
    r.stderr.on("data", (d) => { stderr += d; });
    r.on("exit", (code) => resolve({ code, stdout, stderr }));
    r.on("error", reject);
  });
}

async function step1() {
  log("=== 第 1 步：离线 build→unpack 回路（不依赖 TTS） ===");
  // TODO: 实现
  ok("待 Run 1 完成后实跑");
}

async function step2() {
  log("=== 第 2 步：pull 自动写 baseline.json ===");
  // TODO: 实现
  ok("待 Run 1 完成后实跑");
}

async function step3() {
  log("=== 第 3 步：push --dry-run 报告差异但不写不备 ===");
  // TODO: 实现
  ok("待 Run 1 完成后实跑");
}

async function step4() {
  log("=== 第 4 步：push --yes 完整流程：备份→基线校验→发送→回读→更新 baseline ===");
  // TODO: 实现
  ok("待 Run 1 完成后实跑");
}

async function step5() {
  log("=== 第 5 步：push 原样回写零副作用（不可跳步！） ===");
  // pull → push --dry-run 报"无差异" → push --yes → 再次 pull 与回写前逐字节比对
  // TODO: 实现
  ok("待 Run 1 完成后实跑");
}

async function step6() {
  log("=== 第 6 步：真实修改一脚本 → marker print 确认生效 ===");
  // TODO: 实现
  ok("待 Run 1 完成后实跑");
}

async function step7() {
  log("=== 第 7 步：push 检测素材改动（cards.csv 改一行）→ 拒绝 ===");
  // TODO: 实现
  ok("待 Run 1 完成后实跑");
}

async function step8() {
  log("=== 第 8 步：push --force-scripts-only 绕过素材检测 ===");
  // TODO: 实现
  ok("待 Run 1 完成后实跑");
}

async function step9() {
  log("=== 第 9 步：基线冲突：游戏内手动改脚本 → push 拒绝并指出冲突对象 ===");
  // TODO: 实现
  ok("待 Run 1 完成后实跑");
}

async function step10() {
  log("=== 第 10 步：watch 模式 30 秒实跑（改一脚本 → 自动 push） ===");
  // TODO: 实现
  ok("待 Run 1 完成后实跑");
}

const steps = { "1": step1, "2": step2, "3": step3, "4": step4, "5": step5, "6": step6, "7": step7, "8": step8, "9": step9, "10": step10 };

async function main() {
  log(`阶段 5 实跑验收（step=${step}）`);
  log(`工作目录: ${ROOT}`);
  if (step === "all") {
    for (const k of Object.keys(steps)) await steps[k]();
  } else if (steps[step]) {
    await steps[step]();
  } else {
    console.error(`未知 step: ${step}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
