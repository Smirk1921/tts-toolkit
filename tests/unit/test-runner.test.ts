// tests/unit/test-runner.test.ts
/**
 * src/test/runner.ts 单元测试（A3 产出，窗口 G 阶段 7）。
 *
 * 不依赖运行中的 TTS / 真实 39998 端口：
 * - `src/session/exec.js` 的 SessionExec 被 vi.mock（保留真实 LuaError 类，
 *   保证 runner 的 instanceof 判定与测试构造的错误对象一致）；
 * - EditorServer 用只实现 find() 的最小 stub 顶替（runner 仅用 find 做 Print 快照/差分）；
 * - `src/test/bundle.js` 被 vi.mock（A4 并行开发，任务书禁止等待其落盘）：mock 实现
 *   按 runner 真实调用形态"回显"——读合成入口定位测试模块名，把测试文件源码内联到
 *   bundle 第 2 行起并生成对应 lineMap，从而让 bundle 模式的 marker 用例与行号映射
 *   用例在没有真实 bundle.ts 的情况下也确定可测；bundle.ts 落盘后 mock 继续生效，
 *   测试行为不变。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** mock 状态（vi.hoisted 保证在 mock 工厂中可用） */
const testState = vi.hoisted(() => ({
  exec: vi.fn(),
  /** 记录 SessionExec 构造函数收到的 server（校验 opts.server 优先级） */
  constructed: [] as unknown[],
  /** bundleTests 的 mock（A4 的 bundle.js 未落盘也要可注册、可拦截 runner 的动态 import） */
  bundleTests: vi.fn(),
}));

// 只替换 SessionExec；LuaError 等其余导出保留真实实现（runner 用 instanceof 判定）
vi.mock('../../src/session/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/session/exec.js')>();
  class MockSessionExec {
    public exec = testState.exec;
    public constructor(server: unknown) {
      testState.constructed.push(server);
    }
  }
  return { ...actual, SessionExec: MockSessionExec as unknown as typeof actual.SessionExec };
});

// bundle.ts 由 A4 并行开发：工厂 mock 按说明符注册，runner 的动态 import 会被拦截
vi.mock('../../src/test/bundle.js', () => ({ bundleTests: testState.bundleTests }));

import { LuaError } from '../../src/session/exec.js';
import { TestRunner } from '../../src/test/runner.js';
import { InboundId, type InboundMessage } from '../../src/protocol/messages.js';
import type { EditorServer } from '../../src/protocol/editor-server.js';
import type { DiscoveredTest, RunReport } from '../../src/test/types.js';

const execMock = testState.exec;
const bundleTestsMock = testState.bundleTests;

/** runner 调 bundleTests 的入参视图（结构对齐 runner.ts 的 BundleOptionsView） */
interface BundleOptsView {
  entryPath: string;
  searchPaths?: string[];
  builtinModules?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** bundle/直跑通用的通过用例文件（内容会被原样打进 bundle，故用可检索的标记） */
const SIMPLE_LUA = [
  '-- 简单通过用例',
  'describe("math", function()',
  '  it("1+1=2", function()',
  '    assert_eq(1 + 1, 2)',
  '  end)',
  'end)',
  '',
].join('\n');

/** 行号映射用例文件：标记行位于文件第 4 行 */
const MARKER_LUA = [
  '-- 行号映射用例',
  'describe("mapping", function()',
  '  it("marks", function()',
  '    assert_eq(1111 + 1111, 2222)',
  '  end)',
  'end)',
  '',
].join('\n');

const MARKER_ASSERT = 'assert_eq(1111 + 1111, 2222)';
const MARKER_ASSERT_FILE_LINE = 4;

/** 直跑行号用例文件：标记行位于文件第 4 行 */
const DIRECT_LUA = [
  '-- 直跑行号用例',
  'describe("direct", function()',
  '  it("fails", function()',
  '    assert_true(false)',
  '  end)',
  'end)',
  '',
].join('\n');

const DIRECT_MARKER = 'assert_true(false)';
const DIRECT_MARKER_FILE_LINE = 4;

/** 只实现 find() 的 EditorServer stub（runner 仅用 find 做 Print 快照/差分） */
function makeServer(messages: InboundMessage[] = []): { server: EditorServer; messages: InboundMessage[] } {
  const server = {
    find: (predicate: (m: InboundMessage) => boolean): InboundMessage[] => messages.filter(predicate),
  } as unknown as EditorServer;
  return { server, messages };
}

/** 写一个 Lua 测试文件到临时工作区 */
async function writeLua(root: string, rel: string, content: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

/** 构造 DiscoveredTest 条目 */
function discovered(root: string, rel: string, overrides: Partial<DiscoveredTest> = {}): DiscoveredTest {
  return {
    filePath: path.resolve(root, rel),
    relativePath: rel.replaceAll('\\', '/'),
    targetGuid: '-1',
    timeoutMs: 30_000,
    ...overrides,
  };
}

/** 构造 Lua 侧 current_test_results() 经 JSON.encode 回传的字符串 */
function luaResults(cases: unknown[]): string {
  return JSON.stringify({ tests: cases });
}

/** 一个通过用例的 Lua 侧条目（source_line 用映射表之外的行号，走回退分支） */
function passedCase(name: string): Record<string, unknown> {
  return {
    name,
    source_line: 99_999,
    status: 'passed',
    asserts: [{ kind: 'assert_eq', passed: true, line: 99_999 }],
    prints: [],
  };
}

let root = '';

beforeEach(async () => {
  execMock.mockReset();
  testState.constructed.length = 0;
  // bundleTests mock：按 runner 的真实调用形态"回显"打包——
  // 读合成入口取最后一个 require 的模块名（第一个是 tts.assert），
  // 把测试文件源码内联为 bundle 第 2 行起，并生成 行号 = 源行号 + 1 的 lineMap
  bundleTestsMock.mockReset();
  bundleTestsMock.mockImplementation(async (opts: BundleOptsView) => {
    const entry = await readFile(opts.entryPath, 'utf8');
    const requires = [...entry.matchAll(/require\("([^"]+)"\)/g)];
    const moduleName = requires[requires.length - 1]![1]!;
    const rel = moduleName.replaceAll('.', '/');
    const sourcePath = path.join(opts.searchPaths?.[0] ?? '', `${rel}.lua`);
    const source = (await readFile(sourcePath, 'utf8')).replace(/^\uFEFF/, '');
    const lineMap = new Map<number, { sourceFile: string; sourceLine: number }>();
    source.split('\n').forEach((_, i) => {
      lineMap.set(i + 2, { sourceFile: `${rel}.lua`, sourceLine: i + 1 });
    });
    return {
      code: `-- mock bundle: ${moduleName}\n${source}`,
      lineMap,
      moduleSources: new Map([[moduleName, `${rel}.lua`]]),
    };
  });
  root = await mkdtemp(path.join(os.tmpdir(), 'tts-runner-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('TestRunner.run', () => {
  it('单文件通过：默认 bundle 模式，产出 passed 用例与自洽计数', async () => {
    await writeLua(root, 'tests/simple_test.lua', SIMPLE_LUA);
    execMock.mockResolvedValue(luaResults([passedCase('math :: adds')]));

    const { server } = makeServer();
    const runner = new TestRunner(server);
    const report = await runner.run({ root, files: [discovered(root, 'tests/simple_test.lua')], server });

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.errored).toBe(0);
    expect(report.bailed).toBe(false);
    expect(report.results[0]).toMatchObject({
      status: 'passed',
      case: { name: 'math :: adds', sourceFile: 'tests/simple_test.lua' },
    });
    expect(report.results[0]!.asserts[0]).toMatchObject({ kind: 'assert_eq', passed: true });
  });

  it('断言失败：Lua 侧 failed 用例映射为 failed；未映射行号回退为相对路径 + 原始行号', async () => {
    await writeLua(root, 'tests/simple_test.lua', SIMPLE_LUA);
    execMock.mockResolvedValue(
      luaResults([
        {
          name: 'math :: fails',
          source_line: 99_999,
          status: 'failed',
          failure_reason: 'assert_eq 失败：期望 3，实际 2',
          asserts: [
            { kind: 'assert_eq', passed: false, message: 'assert_eq 失败：期望 3，实际 2', line: 99_999 },
          ],
          prints: [],
        },
      ]),
    );

    const { server } = makeServer();
    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/simple_test.lua')],
      server,
    });

    expect(report.failed).toBe(1);
    expect(report.passed).toBe(0);
    const result = report.results[0]!;
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('assert_eq 失败：期望 3，实际 2');
    // 99999 不在 lineMap 内 → 回退 { relativePath, 原始行号 }
    expect(result.case.sourceFile).toBe('tests/simple_test.lua');
    expect(result.case.sourceLine).toBe(99_999);
    expect(result.asserts[0]).toMatchObject({
      passed: false,
      sourceFile: 'tests/simple_test.lua',
      sourceLine: 99_999,
    });
  });

  it('运行时错误（LuaError 无行号）：合成 error 条目且不抛出', async () => {
    await writeLua(root, 'tests/simple_test.lua', SIMPLE_LUA);
    execMock.mockRejectedValue(
      new LuaError({
        guid: '-1',
        prefix: 'Error in Global Script: ',
        error: 'chunk_0:(12,1-4): attempt to call a nil value',
      }),
    );

    const { server } = makeServer();
    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/simple_test.lua')],
      server,
    });

    expect(report.errored).toBe(1);
    expect(report.results[0]!.status).toBe('error');
    expect(report.results[0]!.failureReason).toContain('attempt to call a nil value');
    expect(report.results[0]!.case.sourceLine).toBe(0);
  });

  it('多文件按传入顺序逐个独立 ExecuteLua 执行', async () => {
    await writeLua(root, 'tests/aaa_test.lua', '-- ALPHA_MARKER_7351\nreturn nil\n');
    await writeLua(root, 'tests/bbb_test.lua', '-- BETA_MARKER_8462\nreturn nil\n');
    execMock.mockImplementation(async (lua: string) =>
      lua.includes('ALPHA_MARKER_7351')
        ? luaResults([passedCase('alpha-case')])
        : luaResults([passedCase('beta-case')]),
    );

    const { server } = makeServer();
    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/aaa_test.lua'), discovered(root, 'tests/bbb_test.lua')],
      server,
    });

    expect(execMock).toHaveBeenCalledTimes(2);
    expect(String(execMock.mock.calls[0]![0])).toContain('ALPHA_MARKER_7351');
    expect(String(execMock.mock.calls[1]![0])).toContain('BETA_MARKER_8462');
    expect(report.results.map((r) => r.case.name)).toEqual(['alpha-case', 'beta-case']);
  });

  it('bail=true：首个含失败用例的文件跑完即停，不再执行后续文件', async () => {
    await writeLua(root, 'tests/aaa_test.lua', '-- ALPHA_MARKER_7351\nreturn nil\n');
    await writeLua(root, 'tests/bbb_test.lua', '-- BETA_MARKER_8462\nreturn nil\n');
    execMock.mockImplementation(async (lua: string) =>
      lua.includes('ALPHA_MARKER_7351')
        ? luaResults([
            {
              name: 'alpha-case',
              source_line: 99_999,
              status: 'failed',
              failure_reason: '断言失败',
              asserts: [],
              prints: [],
            },
          ])
        : luaResults([passedCase('beta-case')]),
    );

    const { server } = makeServer();
    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/aaa_test.lua'), discovered(root, 'tests/bbb_test.lua')],
      server,
      bail: true,
    });

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(report.bailed).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.status).toBe('failed');
  });

  it('bail 缺省 false：失败后继续跑完剩余文件', async () => {
    await writeLua(root, 'tests/aaa_test.lua', '-- ALPHA_MARKER_7351\nreturn nil\n');
    await writeLua(root, 'tests/bbb_test.lua', '-- BETA_MARKER_8462\nreturn nil\n');
    execMock.mockImplementation(async (lua: string) =>
      lua.includes('ALPHA_MARKER_7351')
        ? luaResults([
            {
              name: 'alpha-case',
              source_line: 99_999,
              status: 'failed',
              failure_reason: '断言失败',
              asserts: [],
              prints: [],
            },
          ])
        : luaResults([passedCase('beta-case')]),
    );

    const { server } = makeServer();
    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/aaa_test.lua'), discovered(root, 'tests/bbb_test.lua')],
      server,
    });

    expect(execMock).toHaveBeenCalledTimes(2);
    expect(report.bailed).toBe(false);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
  });

  it('bundle 与直跑模式生成不同的 Lua：直跑注入 IIFE 内联断言库，bundle 无此前缀', async () => {
    await writeLua(root, 'tests/simple_test.lua', SIMPLE_LUA);
    execMock.mockResolvedValue(luaResults([]));
    const { server } = makeServer();
    const files = [discovered(root, 'tests/simple_test.lua')];

    await new TestRunner(server).run({ root, files, server, bundle: false });
    const directLua = String(execMock.mock.calls[0]![0]);
    execMock.mockClear();
    await new TestRunner(server).run({ root, files, server, bundle: true });
    const bundledLua = String(execMock.mock.calls[0]![0]);

    // 直跑：runner 注入 IIFE 内联断言库 + 文件内容原样内联 + 结果取回尾句
    // （TTS Lua 无 require，package.preload 不工作；改为 (function() ... end)() 内联，窗口 G / Stage D 修复）
    expect(directLua).toContain('(function()');
    expect(directLua).not.toContain('package.preload["tts.assert"]');
    expect(directLua).toContain('describe("math", function()');
    expect(directLua).toContain('return JSON.encode(current_test_results())');
    // bundle：无直跑前缀签名；文件内容被打包进单文件；mock 的 bundle 结果原样发出
    // （真实 bundle 末尾的 return __bundle_require("__root") 会把入口里
    //   return JSON.encode(current_test_results()) 的值作为整个 chunk 的返回值，
    //   见 runner.ts synthesizeBundleEntry 的注释——窗口 G / Stage D 实测）
    expect(bundledLua).not.toContain('(function()\n-- tts.assert');
    expect(bundledLua).toContain('assert_eq(1 + 1, 2)');
  });

  it('直跑模式 LuaError 行号回映射到源文件行号', async () => {
    await writeLua(root, 'tests/direct_test.lua', DIRECT_LUA);
    execMock.mockImplementation(async (lua: string) => {
      const lines = lua.split('\n');
      // 文件第 2 行（describe 行）在 chunk 中的行号 → 反推直跑前缀偏移
      const describeChunkLine = lines.findIndex((l) => l.includes('describe("direct", function()')) + 1;
      const offset = describeChunkLine - 2;
      const errorChunkLine = offset + DIRECT_MARKER_FILE_LINE;
      throw new LuaError({
        guid: '-1',
        prefix: 'Error in Global Script: ',
        error: `chunk_0:(${errorChunkLine},5-15): attempt to index a nil value`,
        line: errorChunkLine,
        col: 5,
        endCol: 15,
      });
    });

    const { server } = makeServer();
    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/direct_test.lua')],
      server,
      bundle: false,
    });

    expect(report.results[0]!.status).toBe('error');
    expect(report.results[0]!.case.sourceFile).toBe('tests/direct_test.lua');
    expect(report.results[0]!.case.sourceLine).toBe(DIRECT_MARKER_FILE_LINE);
  });

  it('全局超时（globalTimeoutMs=0）：所有文件合成"未执行"error 条目且不执行 Lua', async () => {
    const { server } = makeServer();
    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/aaa_test.lua'), discovered(root, 'tests/bbb_test.lua')],
      server,
      globalTimeoutMs: 0,
    });

    expect(execMock).not.toHaveBeenCalled();
    expect(report.bailed).toBe(false);
    expect(report.errored).toBe(2);
    expect(report.results).toHaveLength(2);
    for (const r of report.results) {
      expect(r.status).toBe('error');
      expect(r.failureReason).toContain('全局超时');
    }
  });

  it('targetGuid 与 timeoutMs 透传给 SessionExec.exec', async () => {
    await writeLua(root, 'tests/simple_test.lua', SIMPLE_LUA);
    execMock.mockResolvedValue(luaResults([]));

    const { server } = makeServer();
    await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/simple_test.lua', { targetGuid: '65333', timeoutMs: 1234 })],
      server,
    });

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0]![1]).toEqual({ guid: '65333', timeoutMs: 1234 });
  });

  it('RunReport 字段完整且统计自洽', async () => {
    await writeLua(root, 'tests/simple_test.lua', SIMPLE_LUA);
    execMock.mockResolvedValue(luaResults([passedCase('math :: adds')]));

    const { server } = makeServer();
    const report: RunReport = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/simple_test.lua')],
      server,
    });

    expect(typeof report.runId).toBe('string');
    expect(report.runId.length).toBeGreaterThan(0);
    expect(report.root).toBe(path.resolve(root));
    expect(Number.isNaN(Date.parse(report.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(report.endedAt))).toBe(false);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.total).toBe(report.passed + report.failed + report.errored);
    expect(report.total).toBe(report.results.length);
    expect(report.bailed).toBe(false);
    const result = report.results[0]!;
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.asserts)).toBe(true);
    expect(Array.isArray(result.prints)).toBe(true);
    expect(typeof result.case.sourceLine).toBe('number');
  });

  it('执行期间新增的 Print 消息追加到最后一个用例的 prints', async () => {
    await writeLua(root, 'tests/simple_test.lua', SIMPLE_LUA);
    const { server, messages } = makeServer();
    execMock.mockImplementation(async () => {
      // 模拟 TTS 在执行期间把 print 推到编辑器服务器
      messages.push({ messageID: InboundId.Print, message: 'print-during-exec' });
      return luaResults([passedCase('math :: adds')]);
    });

    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/simple_test.lua')],
      server,
    });

    expect(report.results[0]!.prints).toContain('print-during-exec');
  });

  it('Print 与 Lua 侧已捕获 prints 按文本去重，不重复追加', async () => {
    await writeLua(root, 'tests/simple_test.lua', SIMPLE_LUA);
    const { server, messages } = makeServer();
    execMock.mockImplementation(async () => {
      // "dup" 已被 Lua 侧捕获；"fresh-top-level" 是 it() 之外的顶层 print，仅出现在 Print 消息里
      messages.push({ messageID: InboundId.Print, message: 'dup' });
      messages.push({ messageID: InboundId.Print, message: 'fresh-top-level' });
      const passed = passedCase('math :: adds');
      passed.prints = ['dup'];
      return luaResults([passed]);
    });

    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/simple_test.lua')],
      server,
    });

    expect(report.results[0]!.prints).toEqual(['dup', 'fresh-top-level']);
  });

  it('bundle 行号映射：failed 断言行号经 lineMap 映射回源文件', async () => {
    await writeLua(root, 'tests/marker_test.lua', MARKER_LUA);
    execMock.mockImplementation(async (lua: string) => {
      // 从 runner 实际执行的打包 Lua 里定位标记所在 bundle 行号，
      // 让 Lua 侧结果引用该行号，检验 runner 能否映射回源文件第 4 行
      const bundleLine = lua.split('\n').findIndex((l) => l.includes(MARKER_ASSERT)) + 1;
      return luaResults([
        {
          name: 'mapping :: marks',
          source_line: bundleLine,
          status: 'failed',
          failure_reason: 'assert_eq 失败：期望 2222，实际 2223',
          asserts: [
            {
              kind: 'assert_eq',
              passed: false,
              message: 'assert_eq 失败：期望 2222，实际 2223',
              line: bundleLine,
            },
          ],
          prints: [],
        },
      ]);
    });

    const { server } = makeServer();
    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/marker_test.lua')],
      server,
    });

    const result = report.results[0]!;
    expect(result.case.sourceFile).toBe('tests/marker_test.lua');
    expect(result.case.sourceLine).toBe(MARKER_ASSERT_FILE_LINE);
    expect(result.asserts[0]!.sourceFile).toBe('tests/marker_test.lua');
    expect(result.asserts[0]!.sourceLine).toBe(MARKER_ASSERT_FILE_LINE);
  });

  it('直跑模式断言行号经前缀偏移映射回源文件行号', async () => {
    await writeLua(root, 'tests/direct_test.lua', DIRECT_LUA);
    execMock.mockImplementation(async (lua: string) => {
      const lines = lua.split('\n');
      const describeChunkLine = lines.findIndex((l) => l.includes('describe("direct", function()')) + 1;
      const offset = describeChunkLine - 2;
      const chunkLine = offset + DIRECT_MARKER_FILE_LINE;
      return luaResults([
        {
          name: 'direct :: fails',
          source_line: chunkLine,
          status: 'failed',
          failure_reason: 'assert_true 失败：期望真值，实际 false',
          asserts: [
            { kind: 'assert_true', passed: false, message: 'assert_true 失败：期望真值，实际 false', line: chunkLine },
          ],
          prints: [],
        },
      ]);
    });

    const { server } = makeServer();
    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/direct_test.lua')],
      server,
      bundle: false,
    });

    const result = report.results[0]!;
    expect(result.case.sourceFile).toBe('tests/direct_test.lua');
    expect(result.case.sourceLine).toBe(DIRECT_MARKER_FILE_LINE);
    expect(result.asserts[0]!.sourceLine).toBe(DIRECT_MARKER_FILE_LINE);
  });

  it('exec 返回非字符串：合成 error 条目', async () => {
    await writeLua(root, 'tests/simple_test.lua', SIMPLE_LUA);
    execMock.mockResolvedValue(42);

    const { server } = makeServer();
    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/simple_test.lua')],
      server,
    });

    expect(report.errored).toBe(1);
    expect(report.results[0]!.status).toBe('error');
    expect(report.results[0]!.failureReason).toContain('JSON 字符串');
  });

  it('exec 返回非法 JSON：合成 error 条目', async () => {
    await writeLua(root, 'tests/simple_test.lua', SIMPLE_LUA);
    execMock.mockResolvedValue('not-json{{');

    const { server } = makeServer();
    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/simple_test.lua')],
      server,
    });

    expect(report.errored).toBe(1);
    expect(report.results[0]!.status).toBe('error');
    expect(report.results[0]!.failureReason).toContain('不是合法 JSON');
  });

  it('返回值 JSON 缺少 tests 数组：合成 error 条目', async () => {
    await writeLua(root, 'tests/simple_test.lua', SIMPLE_LUA);
    execMock.mockResolvedValue(JSON.stringify({ nope: true }));

    const { server } = makeServer();
    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/simple_test.lua')],
      server,
    });

    expect(report.errored).toBe(1);
    expect(report.results[0]!.status).toBe('error');
    expect(report.results[0]!.failureReason).toContain('tests 数组');
  });

  it('空 files：零报告且不执行 Lua', async () => {
    const { server } = makeServer();
    const report = await new TestRunner(server).run({ root, files: [], server });

    expect(execMock).not.toHaveBeenCalled();
    expect(report.total).toBe(0);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.errored).toBe(0);
    expect(report.results).toEqual([]);
    expect(report.bailed).toBe(false);
  });

  it('直跑模式文件不可读：合成 error 条目', async () => {
    const { server } = makeServer();
    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/ghost_test.lua')],
      server,
      bundle: false,
    });

    expect(report.errored).toBe(1);
    expect(report.results[0]!.status).toBe('error');
    expect(report.results[0]!.failureReason).toContain('读取测试文件');
  });

  it('bundle 模式打包失败（文件不存在）：合成 error 条目', async () => {
    const { server } = makeServer();
    const report = await new TestRunner(server).run({
      root,
      files: [discovered(root, 'tests/ghost_test.lua')],
      server,
      bundle: true,
    });

    expect(report.errored).toBe(1);
    expect(report.results[0]!.status).toBe('error');
    expect(report.results[0]!.failureReason).toBeTruthy();
  });

  it('opts.server 优先于构造函数注入的 server（hub 委托预留）', async () => {
    const { server: ctorServer } = makeServer();
    const { server: optsServer } = makeServer();
    execMock.mockResolvedValue(luaResults([]));

    await new TestRunner(ctorServer).run({ root, files: [], server: optsServer });
    expect(testState.constructed[0]).toBe(optsServer);

    // 仅构造函数注入时回退到构造 server（运行时允许 opts.server 缺省，类型上必填）
    await new TestRunner(ctorServer).run({
      root,
      files: [],
      server: undefined as unknown as EditorServer,
    });
    expect(testState.constructed[1]).toBe(ctorServer);
  });
});
