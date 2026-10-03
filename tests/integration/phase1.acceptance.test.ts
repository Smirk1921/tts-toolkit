// tests/integration/phase1.acceptance.test.ts
/**
 * 阶段 1 验收集成测试（对照《施工流程》阶段 1 §验收标准（可执行））。
 *
 * 与单元测试不同，本文件**依赖真实运行中的 TTS**，因此默认整组 describe.skip，
 * 不纳入日常 CI；确认前置条件后再手动开启。
 *
 * 前置条件（缺一不可）：
 * 1. 已执行 `npm run build`（测试通过子进程调用 `dist/cli/index.js`，不是 tsx 源码）；
 * 2. TTS 正在运行，且已加载图包存档（39999 端口才会监听）；
 * 3. VSCode 的 TTS 插件已关闭（否则 39998 被抢占，所有命令都会报端口占用）。
 *
 * 手动开启方式：把下方 `describe.skip` 改成 `describe`，然后执行：
 *   npm run test:integration
 *
 * 基准值来源：2026-10-04 在本机对当前图包存档实测——251 个对象、36 个 .lua + 1 个 .xml、
 * 脚本总量 277,644 字符、130 个不同素材 URL / 249 次引用。存档改动后这些数字可能变化，
 * 届时按《施工流程》的验收说明更新本文件顶部常量即可。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 第三方依赖
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** 项目根目录：由本文件位置回推（tests/integration → 项目根）。 */
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** CLI 调用前缀：node + 已构建的入口（先 `npm run build`）。 */
const CLI = ["node", path.join(PROJECT_ROOT, "dist", "cli", "index.js")] as const;

/** pull 基准（《施工流程》阶段 1 验收标准）：36 个 .lua + 1 个 .xml，脚本总量约 277,644 字符。 */
const BASELINE_LUA_FILES = 36;
const BASELINE_XML_FILES = 1;
const BASELINE_SCRIPT_CHARS = 277_644;

/** 脚本字符数的相对容差：存档轻微改动（增删几条注释）时不至于直接判失败。 */
const SCRIPT_CHARS_TOLERANCE = 0.05;

/**
 * 运行一次 `tts` CLI。
 *
 * 统一从项目根目录启动，stdout/stderr 固定 utf8 字符串，并默认 `reject: false`
 * （非 0 退出码不抛异常）——集成测试要显式断言 exitCode，而不是靠 execa 抛错。
 *
 * @param args 子命令与参数（不含 node 与入口路径），如 `["exec", "return 1+1"]`
 * @param opts 额外选项：`input` 用于向子进程 stdin 写入内容并关闭（如 `""` 触发 EOF）
 * @returns execa 结果对象（stdout / stderr / exitCode）
 */
function runCli(args: readonly string[], opts: { input?: string } = {}) {
  return execa(CLI[0], [...CLI.slice(1), ...args], {
    cwd: PROJECT_ROOT,
    reject: false,
    encoding: "utf8" as const,
    timeout: 60_000,
    ...opts,
  });
}

/**
 * 统计目录内 .lua 文件的字符总数（按 UTF-8 解码后的 JS 字符串长度计，即 UTF-16 码元数）。
 * @param dir 目录路径
 * @returns 所有 .lua 文件的字符数之和
 */
function countLuaChars(dir: string): number {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".lua"))
    .reduce((sum, name) => sum + readFileSync(path.join(dir, name), "utf8").length, 0);
}

describe.skip("阶段 1 验收（需 TTS 运行，VSCode 插件已关）", () => {
  /** pull 测试的中文输出目录；beforeAll 创建，afterAll 删除。 */
  let pullDir = "";
  /** pull --lang en-US 测试的输出目录。 */
  let pullDirEn = "";

  beforeAll(() => {
    pullDir = mkdtempSync(path.join(tmpdir(), "tts-phase1-"));
    pullDirEn = mkdtempSync(path.join(tmpdir(), "tts-phase1-en-"));
  });

  afterAll(() => {
    rmSync(pullDir, { recursive: true, force: true });
    rmSync(pullDirEn, { recursive: true, force: true });
  });

  it("tts status 显示连接信息", async () => {
    const { stdout, exitCode } = await runCli(["status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("已连接");
    expect(stdout).toContain("39998");
    expect(stdout).toContain("MoonSharp");
    expect(stdout).toMatch(/当前存档对象数：\d+/);
  });

  it("tts exec 'return 1+1' => 2（不是 2.0）", async () => {
    const { stdout, exitCode } = await runCli(["exec", "return 1+1"]);
    expect(exitCode).toBe(0);
    // 数字整型化：TTS 实测回传 2.0，SessionExec 会截断为 2
    expect(stdout.trim()).toBe("2");
  });

  it("tts exec 'return #getObjects()' => 251", async () => {
    const { stdout, exitCode } = await runCli(["exec", "return #getObjects()"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("251");
  });

  it("tts exec 'return _VERSION' => MoonSharp", async () => {
    const { stdout, exitCode } = await runCli(["exec", "return _VERSION"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("MoonSharp");
  });

  it("tts exec 'return {a=1,b=\"x\"}' => 对象（坑 1 回归）", async () => {
    // 协议只回传标量，table 会静默失败；execJson 用 JSON.encode 包装后必须拿到对象而非超时
    const { stdout, exitCode } = await runCli(["exec", 'return {a=1,b="x"}']);
    expect(exitCode).toBe(0);
    const parsed: unknown = JSON.parse(stdout);
    expect(parsed).toEqual({ a: 1, b: "x" });
  });

  it("tts exec 非法函数 => Lua 错误含行列号", async () => {
    const r = await runCli(["exec", "this_is_not_a_function()"]);
    expect(r.exitCode).not.toBe(0);
    const output = r.stderr || r.stdout;
    // TTS 报错格式为 chunk_0:(行,起列-止列): ...，CLI 原样透出该文本
    expect(output).toMatch(/\(\d+,\d+-\d+\)/);
    expect(output).toContain("Lua 执行出错");
  });

  it("tts pull <临时目录> 落盘 36 个 .lua + 1 个 .xml", async () => {
    const { stdout, exitCode } = await runCli(["pull", pullDir]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("拉取完成");

    const files = readdirSync(pullDir);
    const luaFiles = files.filter((name) => name.endsWith(".lua"));
    const xmlFiles = files.filter((name) => name.endsWith(".xml"));
    expect(luaFiles).toHaveLength(BASELINE_LUA_FILES);
    expect(xmlFiles).toHaveLength(BASELINE_XML_FILES);

    const totalChars = countLuaChars(pullDir);
    const tolerance = BASELINE_SCRIPT_CHARS * SCRIPT_CHARS_TOLERANCE;
    expect(
      totalChars,
      `脚本字符数 ${totalChars} 不在基准 ${BASELINE_SCRIPT_CHARS} ±${SCRIPT_CHARS_TOLERANCE * 100}% 内`,
    ).toBeGreaterThanOrEqual(BASELINE_SCRIPT_CHARS - tolerance);
    expect(totalChars).toBeLessThanOrEqual(BASELINE_SCRIPT_CHARS + tolerance);
  });

  it("tts pull --lang en-US 输出英文（i18n 生效）", async () => {
    // 注意：《施工流程》验收标准里写作 `tts pull --lang en`，但 CLI 只接受
    // "zh-CN" / "en-US"（src/cli/index.ts 的 SUPPORTED_LANGS），`--lang en` 会以
    // 「无效的语言选项：en」退出 1。这里按实际可用的 en-US 断言。
    const { stdout, exitCode } = await runCli(["--lang", "en-US", "pull", pullDirEn]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Output directory:");
    expect(stdout).toContain("Pull complete:");
    // 输出目录路径里可能含中文用户名，故只断言对应中文文案不出现
    expect(stdout).not.toContain("输出目录");
    expect(stdout).not.toContain("拉取完成");
  });

  it("tts assets 列出 URL 统计", async () => {
    const { stdout, exitCode } = await runCli(["assets"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/共 130 个不同 URL/);
    expect(stdout).toContain("steamusercontent");
  });

  it("tts config datadir 列出多个候选", async () => {
    // input: "" 会立即关闭子进程 stdin：readline 收到 EOF 走「取消」分支，
    // 既不挂起也不会写入配置（exitCode 1 是取消的预期结果）
    const { stdout, exitCode } = await runCli(["config", "datadir"], { input: "" });
    expect(stdout).toMatch(/找到 \d+ 个 TTS 数据目录/);
    expect(stdout).toContain("Tabletop Simulator");
    expect(exitCode).toBe(1);
  });
});
