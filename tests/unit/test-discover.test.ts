// tests/unit/test-discover.test.ts
/**
 * src/test/discover.ts 的单元测试（窗口 G 阶段 7，A2 产出）。
 *
 * 覆盖 S4 混合发现语义的三级优先级（opts > pack.yaml tests 段 > 内置默认）、
 * 自实现 glob 子集（`*` / `**` / `?`）、递归扫描与跳过规则、排序与去重、
 * 以及全部告警路径（pack.yaml tests 段不可用、目录不可读、候选文件断链）。
 *
 * 夹具：mkdtemp 在 os.tmpdir() 下造临时 pack 目录，afterEach 清理；
 * 告警断言通过 onWarning 回调收集（避免污染 stderr），不依赖运行中的 TTS。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PackError } from "../../src/pack/packyaml.js";
import {
  DEFAULT_TARGET_GUID,
  DEFAULT_TEST_GLOB,
  DEFAULT_TIMEOUT_MS,
  discoverTests,
  type DiscoverTestsOptions,
} from "../../src/test/discover.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "tts-toolkit-discover-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** 在临时 pack 根下写文件（自动建父目录），segments 相对 tempRoot */
async function touch(segments: string[], content = "-- test\n"): Promise<void> {
  const full = path.join(tempRoot, ...segments);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

/** 在临时 pack 根下写 pack.yaml 原文（discover 只取 tests 段，无需完整合法清单） */
async function writePackYamlFixture(text: string): Promise<void> {
  await writeFile(path.join(tempRoot, "pack.yaml"), text, "utf8");
}

/** 收集 onWarning 上报的 PackError，供告警断言使用 */
function collectWarnings(): {
  warnings: PackError[];
  onWarning: DiscoverTestsOptions["onWarning"];
} {
  const warnings: PackError[] = [];
  return { warnings, onWarning: (warning) => warnings.push(warning) };
}

describe("discoverTests（S4 混合发现）", () => {
  it("导出常量符合契约（DEFAULT_TEST_GLOB / DEFAULT_TIMEOUT_MS / DEFAULT_TARGET_GUID）", () => {
    expect(DEFAULT_TEST_GLOB).toBe("tests/**/*_test.lua");
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_TARGET_GUID).toBe("-1");
  });

  it("空 tests/ 目录返回 []，且缺 pack.yaml 不产生告警", async () => {
    await mkdir(path.join(tempRoot, "tests"), { recursive: true });
    const { warnings, onWarning } = collectWarnings();
    const found = await discoverTests({ root: tempRoot, onWarning });
    expect(found).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("tests/ 目录不存在返回 []", async () => {
    const { warnings, onWarning } = collectWarnings();
    const found = await discoverTests({ root: tempRoot, onWarning });
    expect(found).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("root 不存在返回 [] 并以 TEST_DISCOVER_FILE_UNREADABLE 告警", async () => {
    const missing = path.join(tempRoot, "no-such-root");
    const { warnings, onWarning } = collectWarnings();
    const found = await discoverTests({ root: missing, onWarning });
    expect(found).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("TEST_DISCOVER_FILE_UNREADABLE");
  });

  it("单一 _test.lua 文件被发现，字段带默认值且路径正确", async () => {
    await touch(["tests", "a_test.lua"]);
    const found = await discoverTests({ root: tempRoot });
    expect(found).toHaveLength(1);
    expect(found[0].relativePath).toBe("tests/a_test.lua");
    expect(found[0].filePath).toBe(path.join(tempRoot, "tests", "a_test.lua"));
    expect(found[0].targetGuid).toBe(DEFAULT_TARGET_GUID);
    expect(found[0].timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("嵌套子目录递归发现", async () => {
    await touch(["tests", "unit", "a_test.lua"]);
    await touch(["tests", "integration", "deep", "b_test.lua"]);
    const found = await discoverTests({ root: tempRoot });
    expect(found.map((entry) => entry.relativePath)).toEqual([
      "tests/integration/deep/b_test.lua",
      "tests/unit/a_test.lua",
    ]);
  });

  it("非 _test.lua 文件与同名目录被忽略", async () => {
    await touch(["tests", "a.lua"]);
    await touch(["tests", "b.test.txt"]);
    await touch(["tests", "readme.md"]);
    await touch(["tests", "keep_test.lua"]);
    await mkdir(path.join(tempRoot, "tests", "notadir_test.lua"), { recursive: true });
    const found = await discoverTests({ root: tempRoot });
    expect(found.map((entry) => entry.relativePath)).toEqual(["tests/keep_test.lua"]);
  });

  it("自定义 include glob 覆盖默认（可发现 tests/ 之外的文件）", async () => {
    await touch(["tests", "a_test.lua"]);
    await touch(["lua", "b_test.lua"]);
    const found = await discoverTests({ root: tempRoot, include: ["lua/**/*_test.lua"] });
    expect(found.map((entry) => entry.relativePath)).toEqual(["lua/b_test.lua"]);
  });

  it("exclude 排除命中文件", async () => {
    await touch(["tests", "a_test.lua"]);
    await touch(["tests", "fixtures", "fix_test.lua"]);
    const found = await discoverTests({ root: tempRoot, exclude: ["tests/fixtures/**"] });
    expect(found.map((entry) => entry.relativePath)).toEqual(["tests/a_test.lua"]);
  });

  it("显式空数组 include 表示匹配空集（undefined 才沿用下一优先级）", async () => {
    await touch(["tests", "a_test.lua"]);
    const found = await discoverTests({ root: tempRoot, include: [] });
    expect(found).toEqual([]);
  });

  it("pack.yaml tests.include 覆盖默认", async () => {
    await touch(["tests", "a_test.lua"]);
    await touch(["lua", "b_test.lua"]);
    await writePackYamlFixture('name: demo\ntests:\n  include:\n    - "lua/**/*_test.lua"\n');
    const found = await discoverTests({ root: tempRoot });
    expect(found.map((entry) => entry.relativePath)).toEqual(["lua/b_test.lua"]);
  });

  it("pack.yaml tests.exclude 生效", async () => {
    await touch(["tests", "a_test.lua"]);
    await touch(["tests", "fixtures", "f_test.lua"]);
    await writePackYamlFixture('name: demo\ntests:\n  exclude:\n    - "tests/fixtures/**"\n');
    const found = await discoverTests({ root: tempRoot });
    expect(found.map((entry) => entry.relativePath)).toEqual(["tests/a_test.lua"]);
  });

  it("pack.yaml tests.timeout 与 tests.target_guid 透传到每个条目", async () => {
    await touch(["tests", "a_test.lua"]);
    await touch(["tests", "sub", "b_test.lua"]);
    await writePackYamlFixture(
      'name: demo\ntests:\n  timeout: 1234\n  target_guid: "654321"\n',
    );
    const found = await discoverTests({ root: tempRoot });
    expect(found).toHaveLength(2);
    for (const entry of found) {
      expect(entry.timeoutMs).toBe(1234);
      expect(entry.targetGuid).toBe("654321");
    }
  });

  it("opts.exclude 整体替换 pack.yaml tests.exclude（调用方优先级最高）", async () => {
    await touch(["tests", "fixtures", "f_test.lua"]);
    await touch(["tests", "other", "o_test.lua"]);
    await writePackYamlFixture('name: demo\ntests:\n  exclude:\n    - "tests/fixtures/**"\n');
    const found = await discoverTests({ root: tempRoot, exclude: ["tests/other/**"] });
    // pack.yaml 的 fixtures 排除被丢弃；opts 的 other 排除生效
    expect(found.map((entry) => entry.relativePath)).toEqual(["tests/fixtures/f_test.lua"]);
  });

  it("pack.yaml tests 段字段非法时回退默认并告警（不抛错）", async () => {
    await touch(["tests", "a_test.lua"]);
    await writePackYamlFixture('name: demo\ntests:\n  timeout: "abc"\n');
    const { warnings, onWarning } = collectWarnings();
    const found = await discoverTests({ root: tempRoot, onWarning });
    expect(found.map((entry) => entry.relativePath)).toEqual(["tests/a_test.lua"]);
    expect(found[0].timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(found[0].targetGuid).toBe(DEFAULT_TARGET_GUID);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("TEST_DISCOVER_PACK_YAML_INVALID");
    expect(warnings[0].message).toContain("tests.timeout");
  });

  it("pack.yaml tests 段含未知字段时（strictObject）回退默认并告警", async () => {
    await touch(["tests", "a_test.lua"]);
    await writePackYamlFixture(
      'name: demo\ntests:\n  include:\n    - "tests/**/*_test.lua"\n  unknow_field: 1\n',
    );
    const { warnings, onWarning } = collectWarnings();
    const found = await discoverTests({ root: tempRoot, onWarning });
    expect(found.map((entry) => entry.relativePath)).toEqual(["tests/a_test.lua"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("TEST_DISCOVER_PACK_YAML_INVALID");
    expect(warnings[0].message).toContain("unknow_field");
  });

  it("pack.yaml 不是合法 YAML 时回退默认并告警", async () => {
    await touch(["tests", "a_test.lua"]);
    await writePackYamlFixture("tests: [unclosed\n");
    const { warnings, onWarning } = collectWarnings();
    const found = await discoverTests({ root: tempRoot, onWarning });
    expect(found.map((entry) => entry.relativePath)).toEqual(["tests/a_test.lua"]);
    expect(found[0].timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("TEST_DISCOVER_PACK_YAML_INVALID");
  });

  it("断链的测试候选文件被跳过并以 TEST_DISCOVER_FILE_UNREADABLE 告警", async () => {
    await touch(["tests", "ok_test.lua"]);
    // junction/symlink 指向不存在的目标：readdir 报 symlink，stat 抛 ENOENT
    await symlink(
      path.join(tempRoot, "missing-target"),
      path.join(tempRoot, "tests", "broken_test.lua"),
      "junction",
    );
    const { warnings, onWarning } = collectWarnings();
    const found = await discoverTests({ root: tempRoot, onWarning });
    expect(found.map((entry) => entry.relativePath)).toEqual(["tests/ok_test.lua"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("TEST_DISCOVER_FILE_UNREADABLE");
    expect(warnings[0].message).toContain("broken_test.lua");
  });

  it("结果按 relativePath 字典序排序（与创建顺序无关）", async () => {
    await touch(["tests", "z_test.lua"]);
    await touch(["tests", "a", "nested_test.lua"]);
    await touch(["tests", "m_test.lua"]);
    const found = await discoverTests({ root: tempRoot });
    expect(found.map((entry) => entry.relativePath)).toEqual([
      "tests/a/nested_test.lua",
      "tests/m_test.lua",
      "tests/z_test.lua",
    ]);
  });

  it("重复 glob 命中同一文件只保留一条（去重）", async () => {
    await touch(["tests", "a_test.lua"]);
    await touch(["tests", "sub", "b_test.lua"]);
    const found = await discoverTests({
      root: tempRoot,
      include: ["tests/**/*_test.lua", "tests/**/*.lua"],
    });
    expect(found.map((entry) => entry.relativePath)).toEqual([
      "tests/a_test.lua",
      "tests/sub/b_test.lua",
    ]);
  });
});
