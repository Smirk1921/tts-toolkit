// tests/unit/test-bundle.test.ts
/**
 * src/test/bundle.ts 的单元测试（窗口 G 阶段 7，A4 产出）。
 *
 * 覆盖：单文件入口恒等打包（无行号映射回退）、单/多层 require、内置模块注入
 * （"tts.assert" 可 require、点号转路径、优先于项目内同名文件）、行号映射正确性
 * （含 CRLF 行尾与入口模块自身）、缺失模块 / 入口不存在的 PackError 错误码、
 * 临时目录清理（成功与失败路径）、moduleSources 完整性、重复 require 只注册一次、
 * 多搜索目录解析、BOM 容错。
 *
 * 夹具：mkdtemp 在 os.tmpdir() 下造临时 Lua 项目目录，afterEach 清理；
 * 全部为纯文件系统操作，不依赖运行中的 TTS。
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PackError } from "../../src/pack/packyaml.js";
import { bundleTests } from "../../src/test/bundle.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "tts-toolkit-bundle-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/** 在临时项目目录下写文件（自动建父目录），segments 相对 projectDir，返回绝对路径 */
async function touch(segments: string[], content: string): Promise<string> {
  const full = path.join(projectDir, ...segments);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
  return full;
}

/** 捕获 promise 的拒绝原因（用例内断言错误码/消息用） */
function catchOf(p: Promise<unknown>): Promise<unknown> {
  return p.catch((err: unknown) => err);
}

describe("bundleTests（多文件 Lua 打包）", () => {
  it("单文件入口（无 require）：原样返回源码，回退为无行号映射模式", async () => {
    const source = "-- 单文件测试\nreturn 42\n";
    const entry = await touch(["solo.lua"], source);

    const result = await bundleTests({ entryPath: entry });

    expect(result.code).toBe(source);
    expect(result.lineMap.size).toBe(0);
    expect([...result.moduleSources.keys()]).toEqual(["__root"]);
    expect(result.moduleSources.get("__root")).toBe(entry);
  });

  it("单 require（mod_a）：打包成功且模块来源指向真实文件", async () => {
    const entry = await touch(["entry.lua"], 'require("mod_a")\n');
    const modA = await touch(["mod_a.lua"], "return 1\n");

    const result = await bundleTests({ entryPath: entry, searchPaths: [projectDir] });

    expect(result.code).toContain('__bundle_register("mod_a"');
    expect(result.code).toContain("return 1");
    expect(result.moduleSources.get("mod_a")).toBe(modA);
    expect(result.lineMap.size).toBeGreaterThan(0);
  });

  it("多层级 require（a→b→c）：全链路打包", async () => {
    const entry = await touch(["entry.lua"], 'require("mod_a")\n');
    await touch(["mod_a.lua"], 'local b = require("mod_b")\nreturn b + 1\n');
    await touch(["mod_b.lua"], 'local c = require("mod_c")\nreturn c + 1\n');
    const modC = await touch(["mod_c.lua"], "return 1\n");

    const result = await bundleTests({ entryPath: entry, searchPaths: [projectDir] });

    for (const name of ["mod_a", "mod_b", "mod_c"]) {
      expect(result.code).toContain(`__bundle_register("${name}"`);
    }
    expect(result.moduleSources.get("mod_c")).toBe(modC);
  });

  it("builtinModules 注入：tts.assert 可被 require 并进入打包结果", async () => {
    const entry = await touch(["entry.lua"], 'local lib = require("tts.assert")\n');
    const lib = "-- 内置断言库\nreturn { assert_eq = function() end }\n";

    const result = await bundleTests({ entryPath: entry, builtinModules: { "tts.assert": lib } });

    expect(result.code).toContain('__bundle_register("tts.assert"');
    expect(result.code).toContain("-- 内置断言库");
    expect(result.moduleSources.has("tts.assert")).toBe(true);
  });

  it("模块名点号转路径分隔符：tts.assert → .tts-test-bundle/b<随机>/tts/assert.lua", async () => {
    const entry = await touch(["entry.lua"], 'require("tts.assert")\n');

    const result = await bundleTests({ entryPath: entry, builtinModules: { "tts.assert": "return {}\n" } });

    const builtinPath = result.moduleSources.get("tts.assert");
    expect(builtinPath).toBeDefined();
    const parts = path.relative(projectDir, builtinPath!).split(path.sep);
    expect(parts[0]).toBe(".tts-test-bundle");
    expect(parts[1]).toMatch(/^b[0-9a-f]+$/);
    expect(parts.slice(2)).toEqual(["tts", "assert.lua"]);
  });

  it("行号映射：bundle 行号回映射到源文件与原始行号（含入口模块自身）", async () => {
    const entry = await touch(["entry.lua"], 'require("mod_a")\n');
    const modA = await touch(
      ["mod_a.lua"],
      ["-- mod_a 第 1 行", "local marker_xyz = 1", "return marker_xyz", ""].join("\n"),
    );

    const result = await bundleTests({ entryPath: entry, searchPaths: [projectDir] });
    const lines = result.code.split("\n");

    // mod_a 内的标记行：bundle 第 N 行 → mod_a.lua 第 2 行
    const markerBundleLine = lines.findIndex((l) => l.includes("local marker_xyz = 1")) + 1;
    expect(markerBundleLine).toBeGreaterThan(0);
    expect(result.lineMap.get(markerBundleLine)).toEqual({ sourceFile: modA, sourceLine: 2 });

    // 入口模块自身的行号也映射回 entry
    const requireBundleLine = lines.findIndex((l) => l.includes('require("mod_a")')) + 1;
    expect(result.lineMap.get(requireBundleLine)).toEqual({ sourceFile: entry, sourceLine: 1 });

    // 映射表之外的行号查不到（调用方按契约回退 bundle 行号本身）
    expect(result.lineMap.get(99_999)).toBeUndefined();
  });

  it("CRLF 行尾源文件的行号映射同样正确", async () => {
    const entry = await touch(["entry.lua"], 'require("mod_a")\n');
    const modA = await touch(["mod_a.lua"], "-- c1\r\nlocal marker_crlf = 1\r\nreturn marker_crlf\r\n");

    const result = await bundleTests({ entryPath: entry, searchPaths: [projectDir] });
    const markerBundleLine = result.code.split("\n").findIndex((l) => l.includes("local marker_crlf = 1")) + 1;

    expect(markerBundleLine).toBeGreaterThan(0);
    expect(result.lineMap.get(markerBundleLine)).toEqual({ sourceFile: modA, sourceLine: 2 });
  });

  it("缺失模块：抛 PackError TEST_BUNDLE_FAILED，消息含模块名", async () => {
    const entry = await touch(["entry.lua"], 'require("ghost_mod")\n');

    const err = await catchOf(bundleTests({ entryPath: entry, searchPaths: [projectDir] }));

    expect(err).toBeInstanceOf(PackError);
    expect((err as PackError).code).toBe("TEST_BUNDLE_FAILED");
    expect((err as PackError).message).toContain("ghost_mod");
  });

  it("入口文件不存在：抛 PackError TEST_ENTRY_NOT_FOUND", async () => {
    const missing = path.join(projectDir, "no-such-entry.lua");

    const err = await catchOf(bundleTests({ entryPath: missing }));

    expect(err).toBeInstanceOf(PackError);
    expect((err as PackError).code).toBe("TEST_ENTRY_NOT_FOUND");
    expect((err as PackError).message).toContain("no-such-entry.lua");
  });

  it("临时目录在 bundle 完成后被清理", async () => {
    const entry = await touch(["entry.lua"], 'require("tts.assert")\n');

    await bundleTests({ entryPath: entry, builtinModules: { "tts.assert": "return {}\n" } });

    // 整个 .tts-test-bundle 都不在了（本次调用的随机子目录被删，父目录已空被顺手移除）
    await expect(stat(path.join(projectDir, ".tts-test-bundle"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("打包失败时临时目录同样被清理（finally 路径）", async () => {
    const entry = await touch(["entry.lua"], 'require("tts.assert")\nrequire("ghost_mod")\n');

    const err = await catchOf(
      bundleTests({
        entryPath: entry,
        searchPaths: [projectDir],
        builtinModules: { "tts.assert": "return {}\n" },
      }),
    );

    expect(err).toBeInstanceOf(PackError);
    await expect(stat(path.join(projectDir, ".tts-test-bundle"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("moduleSources 包含所有被 bundle 的模块（含入口）且路径真实存在", async () => {
    const entry = await touch(["entry.lua"], 'require("mod_a")\n');
    await touch(["mod_a.lua"], 'local b = require("mod_b")\nreturn b + 1\n');
    const modB = await touch(["mod_b.lua"], "return 2\n");

    const result = await bundleTests({ entryPath: entry, searchPaths: [projectDir] });

    expect([...result.moduleSources.keys()].sort()).toEqual(["__root", "mod_a", "mod_b"]);
    for (const file of result.moduleSources.values()) {
      await expect(stat(file)).resolves.toBeTruthy();
    }
    expect(result.moduleSources.get("mod_b")).toBe(modB);
  });

  it("重复 require 同一模块：只注册一次", async () => {
    const entry = await touch(["entry.lua"], 'require("mod_a")\nrequire("mod_a")\n');
    await touch(["mod_a.lua"], "return 1\n");

    const result = await bundleTests({ entryPath: entry, searchPaths: [projectDir] });

    expect(result.code.split('__bundle_register("mod_a"').length - 1).toBe(1);
  });

  it("入口带 BOM：容错去除后正常打包", async () => {
    // 用 fromCharCode 构造 BOM，避免在源码里放不可见字符
    const bom = String.fromCharCode(0xfeff);
    const entry = await touch(["entry.lua"], `${bom}require("mod_a")\n`);
    await touch(["mod_a.lua"], "return 1\n");

    const result = await bundleTests({ entryPath: entry, searchPaths: [projectDir] });

    expect(result.code).not.toContain(bom);
    expect(result.code).toContain('__bundle_register("mod_a"');
  });

  it("内置模块优先于项目内同名文件（搜索模式最前）", async () => {
    const entry = await touch(["entry.lua"], 'require("tts.assert")\n');
    await touch(["tts", "assert.lua"], "-- 项目内同名文件\nreturn {}\n");

    const result = await bundleTests({
      entryPath: entry,
      searchPaths: [projectDir],
      builtinModules: { "tts.assert": "-- 内置版本\nreturn {}\n" },
    });

    expect(result.code).toContain("-- 内置版本");
    expect(result.code).not.toContain("-- 项目内同名文件");
    expect(result.moduleSources.get("tts.assert")!.startsWith(path.join(projectDir, ".tts-test-bundle"))).toBe(true);
  });

  it("多个搜索目录：后续目录中的模块也能解析", async () => {
    const dirA = path.join(projectDir, "a");
    const dirB = path.join(projectDir, "b");
    const entry = await touch(["a", "entry.lua"], 'require("mod_a")\nrequire("mod_b")\n');
    await touch(["a", "mod_a.lua"], "return 1\n");
    const modB = await touch(["b", "mod_b.lua"], "return 2\n");

    const result = await bundleTests({ entryPath: entry, searchPaths: [dirA, dirB] });

    expect(result.moduleSources.get("mod_a")).toBe(path.join(dirA, "mod_a.lua"));
    expect(result.moduleSources.get("mod_b")).toBe(modB);
  });
});
