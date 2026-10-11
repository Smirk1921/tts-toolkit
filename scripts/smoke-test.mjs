/**
 * smoke-test.mjs — 统一冒烟测试（窗口 v9-1 / D3）
 *
 * ## 用途
 * 用同 3 个场景验证「方案 E（product/ 目录 + .cmd 启动器）」与「方案 A（dist-pkg/ 单文件 .exe）」
 * 两种产物是否真的可跑：CLI 版本、hub 常驻监听 39995、真实图集切片 70 张。
 *
 * ## 用法
 * ```
 * cd tts-toolkit
 * node scripts/smoke-test.mjs plan-e     # 测 product/bin/tts.cmd 等
 * node scripts/smoke-test.mjs plan-a     # 测 dist-pkg/tts.exe 等
 * ```
 *
 * ## 场景 2 的端口处理（重要）
 * - 通过标准：5s 内 39995 LISTENING；
 * - 5s~15s 才 LISTENING：按「启动慢」处理——打印 ⚠️ 但不计入失败（ask §4）；
 * - 启动前 39995 已被占用：若占用者是本工具链自己的 hub（命令行含 hub-main 或
 *   tts-hub.exe），按上次遗留进程回收（taskkill /T）后继续；否则视为失败并给出 PID，
 *   **不**杀非本项目进程；
 * - 场景结束前按 netstat 查到的 PID + taskkill /T 收掉 hub，并复核端口已释放。
 *
 * ## 场景 3 的输入（ask §4 已裁决：不新增仓库夹具）
 * `tts deck slice` 的网格来自存档里的 CustomDeck（NumWidth×NumHeight），CLI 没有
 * --rows/--cols/--output，且 --save 必填（src/cli/commands/deck.ts:404-409）。
 * 因此本脚本在 os.tmpdir() 现场合成一个最小存档：
 * GUID 必须是 6 位十六进制（否则 deck.yaml 校验失败退非 0），FaceURL 用「净化后
 * 等于夹具基名」的裸文件名（命中 src/deck/slice.ts:502 matchByUrlBase 的文件名反推路径），
 * NumWidth=10 / NumHeight=7 → 70 格。
 *
 * 输出口径：每条结果行以 `[smoke-test]` 开头，通过 `✅`、失败 `❌`、启动慢 `⚠️`；
 * 3 个场景全部跑完后汇总，任一失败以退出码 1 结束。失败的临时目录保留以便复现，
 * 全绿时删除。
 */

import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const toolkitRoot = path.resolve(scriptDir, "..");

/** 两套产物各自的 3 个入口（相对 toolkitRoot） */
const PLAN_TARGETS = {
  "plan-e": {
    tts: "product/bin/tts.cmd",
    hub: "product/bin/tts-hub.cmd",
    mcp: "product/bin/tts-mcp.cmd",
  },
  "plan-a": {
    tts: "dist-pkg/tts.exe",
    hub: "dist-pkg/tts-hub.exe",
    mcp: "dist-pkg/tts-mcp.exe",
  },
};

const HUB_PORT = 39995;
const HUB_FAST_MS = 5000;
const HUB_SLOW_MS = 15000;
const POLL_INTERVAL_MS = 100;
const KILL_GRACE_MS = 5000;

const FIXTURE_REL = "tests/fixtures/atlas/settings-cat-2232x1920.png";
const SLICE_EXPECTED_CARDS = 70;
const SLICE_SAVE_GUID = "a1b2c3";
const SLICE_NUM_WIDTH = 10;
const SLICE_NUM_HEIGHT = 7;
const SLICE_TIMEOUT_MS = 180000;

const CLI_TIMEOUT_MS = 120000;

/**
 * 读取当前 package.json 的 version。
 * @returns {Promise<string>} 版本字符串
 */
async function readPackageVersion() {
  const text = await readFile(path.join(toolkitRoot, "package.json"), "utf8");
  const parsed = JSON.parse(text);
  return typeof parsed.version === "string" ? parsed.version : "";
}

/**
 * 跑一次 CLI 并取回结果（不因非 0 退出码抛错）。
 * @param {string} binPath 入口绝对路径
 * @param {string[]} args 参数
 * @param {{timeout?: number, reject?: boolean}} [options] 可选项
 * @returns {Promise<import("execa").ExecaResult>} execa 结果
 */
async function runCli(binPath, args, options = {}) {
  return await execa(binPath, args, {
    cwd: toolkitRoot,
    reject: false,
    timeout: options.timeout ?? CLI_TIMEOUT_MS,
  });
}

/**
 * 裁剪长文本用于错误行。
 * @param {unknown} value 原始值
 * @param {number} [max] 最大长度
 * @returns {string} 单行摘要
 */
function brief(value, max = 400) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 查 39995 上的监听者（与人工排查同一条命令：netstat -ano | findstr :39995）。
 * @returns {Promise<Array<{line: string, pid: number|undefined}>>} 监听行（可能为空）
 */
async function readHubListeners() {
  const result = await execa("cmd.exe", ["/d", "/s", "/c", `netstat -ano | findstr :${HUB_PORT}`], {
    cwd: toolkitRoot,
    reject: false,
    timeout: 10000,
  });
  const lines = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const listeners = [];
  for (const line of lines) {
    if (!line.includes(`:${HUB_PORT}`) || !/\bLISTENING\b/i.test(line)) {
      continue;
    }
    const columns = line.split(/\s+/);
    const pid = Number(columns[columns.length - 1]);
    listeners.push({ line, pid: Number.isInteger(pid) ? pid : undefined });
  }
  return listeners;
}

/**
 * 查进程命令行（用于判定占用 39995 的是不是本工具链自己的 hub）。
 * @param {number} pid 进程号
 * @returns {Promise<string>} 命令行；查不到返回空串
 */
async function readProcessCommandLine(pid) {
  const command = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`;
  const result = await execa("pwsh", ["-NoProfile", "-Command", command], {
    cwd: toolkitRoot,
    reject: false,
    timeout: 15000,
  });
  return result.exitCode === 0 ? String(result.stdout ?? "").trim() : "";
}

/**
 * 判定命令行是否属于本工具链的 hub（.cmd 启动器会留下 hub-main.js，pkg 产物是 tts-hub.exe）。
 * @param {string} commandLine 进程命令行
 * @returns {boolean} 是本项目 hub 返回 true
 */
function isOurHub(commandLine) {
  return /hub-main|tts-hub(\.exe)?/i.test(commandLine);
}

/**
 * 强杀进程树。
 * @param {number} pid 进程号
 * @returns {Promise<number>} taskkill 退出码
 */
async function killProcessTree(pid) {
  const result = await execa("taskkill", ["/PID", String(pid), "/T", "/F"], {
    cwd: toolkitRoot,
    reject: false,
    timeout: 15000,
  });
  return result.exitCode ?? 1;
}

/**
 * 等端口不再 LISTENING。
 * @param {number} timeoutMs 最长等待毫秒
 * @returns {Promise<boolean>} 已释放返回 true
 */
async function waitForPortFree(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const listeners = await readHubListeners();
    if (listeners.length === 0) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/**
 * 睡眠。
 * @param {number} ms 毫秒
 * @returns {Promise<void>} 定时结束
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 场景 1：`tts --version` 输出 semver，且与 package.json 一致。
 * @param {string} ttsBin tts 入口绝对路径
 * @param {string} pkgVersion package.json 版本
 * @returns {Promise<{ok: boolean, detail: string}>} 结果
 */
async function scenarioVersion(ttsBin, pkgVersion) {
  const result = await runCli(ttsBin, ["--version"]);
  const stdout = String(result.stdout ?? "").trim();
  if (result.exitCode !== 0) {
    return {
      ok: false,
      detail: `exit=${String(result.exitCode)} stdout=${JSON.stringify(brief(stdout, 120))} stderr=${JSON.stringify(brief(result.stderr, 200))}`,
    };
  }
  const match = /\d+\.\d+\.\d+/.exec(stdout);
  if (match === null) {
    return { ok: false, detail: `stdout 未匹配 /\\d+\\.\\d+\\.\\d+/：${JSON.stringify(brief(stdout, 200))}` };
  }
  if (match[0] !== pkgVersion) {
    return { ok: false, detail: `版本漂移：产物输出 ${match[0]} ≠ package.json ${pkgVersion}` };
  }
  return { ok: true, detail: match[0] };
}

/**
 * 场景 2：启动 hub，等 39995 LISTENING，然后收掉进程并复核端口释放。
 * @param {string} hubBin hub 入口绝对路径
 * @returns {Promise<{ok: boolean, slow: boolean, detail: string, notes: string[]}>} 结果
 */
async function scenarioHub(hubBin) {
  const notes = [];

  const stale = await readHubListeners();
  if (stale.length > 0) {
    const pid = stale[0].pid;
    const commandLine = pid === undefined ? "" : await readProcessCommandLine(pid);
    if (pid !== undefined && isOurHub(commandLine)) {
      await killProcessTree(pid);
      if (!(await waitForPortFree(KILL_GRACE_MS))) {
        return { ok: false, slow: false, detail: `上次遗留的 hub（pid ${pid}）无法回收，${HUB_PORT} 仍被占用`, notes };
      }
      notes.push(`回收上次遗留的 hub（pid ${pid}）`);
    } else {
      return {
        ok: false,
        slow: false,
        detail: `启动前 ${HUB_PORT} 已被 pid ${String(pid)} 占用且不是本项目 hub（未回收）：${brief(stale[0].line, 160)}`,
        notes,
      };
    }
  }

  const startedAt = Date.now();
  const child = execa(hubBin, [], { cwd: toolkitRoot, reject: false });
  let exited = false;
  let exitCode = null;
  let output = { stdout: "", stderr: "" };
  const rememberOutput = (result) => {
    if (typeof result?.stdout === "string") {
      output = { stdout: result.stdout, stderr: String(result.stderr ?? "") };
    }
  };
  child.then(
    (result) => {
      exited = true;
      exitCode = result.exitCode;
      rememberOutput(result);
    },
    (error) => {
      exited = true;
      exitCode = typeof error?.exitCode === "number" ? error.exitCode : null;
      rememberOutput(error);
    },
  );

  let listenedAt = null;
  let listenerPid = null;
  while (Date.now() - startedAt < HUB_SLOW_MS) {
    const listeners = await readHubListeners();
    if (listeners.length > 0) {
      listenedAt = Date.now();
      listenerPid = listeners[0].pid ?? null;
      break;
    }
    if (exited) {
      break;
    }
    await delay(POLL_INTERVAL_MS);
  }

  const elapsedMs = (listenedAt ?? Date.now()) - startedAt;
  const elapsedText = (elapsedMs / 1000).toFixed(2);

  let cleanupWarning = "";
  const killTargets = [listenerPid, child.pid].filter((pid) => typeof pid === "number");
  for (const pid of killTargets) {
    await killProcessTree(pid);
  }
  if (!(await waitForPortFree(KILL_GRACE_MS))) {
    cleanupWarning = `收尾告警：hub 已 kill，但 ${HUB_PORT} 仍在 LISTENING`;
    notes.push(cleanupWarning);
  }
  if (killTargets.length === 0 && listenedAt !== null) {
    notes.push("未拿到 hub PID，仅确认端口曾 LISTENING");
  }

  if (listenedAt === null) {
    const stdout = output.stdout.trim();
    const stderr = output.stderr.trim();
    const state = exited ? `hub 已退出（exit=${exitCode === null ? "?" : String(exitCode)}）` : `等待 ${HUB_SLOW_MS / 1000}s 仍未监听`;
    return {
      ok: false,
      slow: false,
      detail: `${state}；stdout=${JSON.stringify(brief(stdout, 200))} stderr=${JSON.stringify(brief(stderr, 200))}`,
      notes,
    };
  }

  const slow = elapsedMs > HUB_FAST_MS;
  if (slow) {
    notes.push(`启动慢于 5s（${elapsedText}s），按 ask §4 不计失败`);
  }
  return { ok: true, slow, detail: elapsedText, notes };
}

/**
 * 场景 3：合成最小存档 → `tts deck slice` 真实切图 → 校验 70 张 PNG。
 * @param {string} ttsBin tts 入口绝对路径
 * @param {string} workDir 临时工作目录
 * @returns {Promise<{ok: boolean, detail: string, notes: string[]}>} 结果
 */
async function scenarioSlice(ttsBin, workDir) {
  const notes = [];
  const fixturePath = path.resolve(toolkitRoot, FIXTURE_REL);
  if (!existsSync(fixturePath)) {
    return { ok: false, detail: `夹具不存在：${fixturePath}`, notes };
  }

  const savePath = path.join(workDir, "save.json");
  const outDir = path.join(workDir, "cards");
  const sheetBase = path.basename(fixturePath);
  const save = {
    SaveName: "tts-smoke",
    ObjectStates: [
      {
        GUID: SLICE_SAVE_GUID,
        Name: "Deck",
        Nickname: "smoke-deck",
        CustomDeck: {
          1: {
            FaceURL: sheetBase,
            BackURL: "",
            NumWidth: SLICE_NUM_WIDTH,
            NumHeight: SLICE_NUM_HEIGHT,
            UniqueBack: false,
            Type: 0,
          },
        },
        ContainedObjects: [],
      },
    ],
  };
  await mkdir(workDir, { recursive: true });
  await writeFile(savePath, JSON.stringify(save), "utf8");

  const result = await runCli(
    ttsBin,
    ["deck", "slice", "--sheet", fixturePath, "--save", savePath, "-o", outDir],
    { timeout: SLICE_TIMEOUT_MS },
  );
  const stdout = String(result.stdout ?? "").trim();
  if (result.exitCode !== 0) {
    return {
      ok: false,
      detail: `exit=${String(result.exitCode)} stdout=${JSON.stringify(brief(stdout, 200))} stderr=${JSON.stringify(brief(result.stderr, 300))}`,
      notes,
    };
  }

  let entries;
  try {
    entries = await readdir(outDir, { withFileTypes: true });
  } catch (error) {
    return { ok: false, detail: `输出目录不可读：${brief(error?.message ?? error, 200)}`, notes };
  }
  const pngFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"));
  let totalBytes = 0;
  for (const entry of pngFiles) {
    totalBytes += (await stat(path.join(outDir, entry.name))).size;
  }

  if (pngFiles.length !== SLICE_EXPECTED_CARDS) {
    const names = pngFiles.map((entry) => entry.name).sort();
    return {
      ok: false,
      detail: `输出目录 PNG 数 ${pngFiles.length} ≠ ${SLICE_EXPECTED_CARDS}（${brief(names.join(", "), 300)}）`,
      notes,
    };
  }
  if (totalBytes <= 0) {
    return { ok: false, detail: `输出目录 ${pngFiles.length} 张 PNG 但总大小 0 字节`, notes };
  }

  const cardNamed = pngFiles.filter((entry) => /^card-\d{3}\.png$/.test(entry.name)).length;
  if (cardNamed !== SLICE_EXPECTED_CARDS) {
    notes.push(`命名不符合 card-NNN.png 约定的文件数：${SLICE_EXPECTED_CARDS - cardNamed}`);
  }
  const sizeText = totalBytes >= 1024 * 1024
    ? `${(totalBytes / 1024 / 1024).toFixed(1)}MB`
    : `${(totalBytes / 1024).toFixed(0)}KB`;
  return { ok: true, detail: `${pngFiles.length} cards (${sizeText})`, notes };
}

/**
 * 主流程：解析参数 → 预检入口 → 跑 3 个场景 → 汇总 → 退出码。
 * @returns {Promise<void>} 结束
 */
async function main() {
  const plan = (process.argv[2] ?? "").trim();
  const targets = PLAN_TARGETS[plan];
  if (targets === undefined) {
    console.error(`[smoke-test] ❌ 用法: node scripts/smoke-test.mjs <plan-e|plan-a>（收到 ${JSON.stringify(plan)}）`);
    process.exit(2);
  }

  const bins = {
    tts: path.resolve(toolkitRoot, targets.tts),
    hub: path.resolve(toolkitRoot, targets.hub),
    mcp: path.resolve(toolkitRoot, targets.mcp),
  };
  const pkgVersion = await readPackageVersion();
  console.log(`[smoke-test] starting... plan=${plan} version=${pkgVersion}`);
  console.log(`[smoke-test] bin: tts=${bins.tts}`);
  console.log(`[smoke-test] bin: hub=${bins.hub}`);
  console.log(`[smoke-test] bin: mcp=${bins.mcp}`);

  const results = [];
  const preflightScenarios = { tts: "tts --version", hub: "tts-hub" };
  const missing = ["tts", "hub"].filter((key) => !existsSync(bins[key]));
  if (missing.length > 0) {
    for (const key of missing) {
      const scenario = preflightScenarios[key];
      const reason = `入口不存在：${bins[key]}`;
      console.error(`[smoke-test] ❌ ${scenario}: ${reason}`);
      results.push({ scenario, ok: false, line: `❌ ${scenario}: ${reason}` });
    }
  }
  if (!existsSync(bins.mcp)) {
    console.warn(`[smoke-test] ⚠️ mcp 入口不存在（本次 3 个场景不使用，仅提示）：${bins.mcp}`);
  }

  const workDir = path.join(os.tmpdir(), `tts-smoke-${plan}-${Date.now()}`);

  if (existsSync(bins.tts)) {
    const outcome = await scenarioVersion(bins.tts, pkgVersion);
    if (outcome.ok) {
      console.log(`[smoke-test] ✅ tts --version: ${outcome.detail}`);
      results.push({ scenario: "tts --version", ok: true, line: `✅ tts --version: ${outcome.detail}` });
    } else {
      console.error(`[smoke-test] ❌ tts --version: ${outcome.detail}`);
      results.push({ scenario: "tts --version", ok: false, line: `❌ tts --version: ${outcome.detail}` });
    }
  }

  if (existsSync(bins.hub)) {
    const outcome = await scenarioHub(bins.hub);
    for (const note of outcome.notes) {
      console.warn(`[smoke-test] ⚠️ tts-hub: ${note}`);
    }
    const suffix = outcome.notes.length === 0 ? "" : `（${outcome.notes.join("；")}）`;
    if (outcome.ok) {
      console.log(`[smoke-test] ✅ tts-hub: ${HUB_PORT} LISTENING in ${outcome.detail}s`);
      results.push({ scenario: "tts-hub", ok: true, line: `✅ tts-hub: ${HUB_PORT} LISTENING in ${outcome.detail}s` });
    } else {
      console.error(`[smoke-test] ❌ tts-hub: ${outcome.detail}`);
      results.push({ scenario: "tts-hub", ok: false, line: `❌ tts-hub: ${outcome.detail}` });
    }
    if (outcome.ok && outcome.notes.length > 0) {
      results[results.length - 1].line += suffix;
    }
  }

  if (existsSync(bins.tts)) {
    const outcome = await scenarioSlice(bins.tts, workDir);
    for (const note of outcome.notes) {
      console.warn(`[smoke-test] ⚠️ tts deck slice: ${note}`);
    }
    if (outcome.ok) {
      console.log(`[smoke-test] ✅ tts deck slice: ${outcome.detail}`);
      results.push({ scenario: "tts deck slice", ok: true, line: `✅ tts deck slice: ${outcome.detail}` });
    } else {
      console.error(`[smoke-test] ❌ tts deck slice: ${outcome.detail}`);
      results.push({ scenario: "tts deck slice", ok: false, line: `❌ tts deck slice: ${outcome.detail}` });
    }
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log("[smoke-test] ---- summary ----");
  for (const entry of results) {
    console.log(`[smoke-test] ${entry.line}`);
  }

  if (failed.length === 0 && results.length === 3) {
    await rm(workDir, { recursive: true, force: true });
    console.log("[smoke-test] all passed");
    process.exit(0);
  }

  const kept = existsSync(workDir) ? `（临时目录保留：${workDir}）` : "";
  console.log(`[smoke-test] ${failed.length} scenario(s) failed${kept}`);
  process.exit(1);
}

await main();
