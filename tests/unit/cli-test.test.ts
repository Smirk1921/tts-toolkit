// tests/unit/cli-test.test.ts
/**
 * src/cli/commands/test.ts · `tts test`（窗口 G / 阶段 7，C1）单元测试。
 *
 * 测试方式：真 commander（testCommand.parseAsync），外部依赖全部 vi.mock——
 * - `src/cli/_shared.js` 的 tryHubClient → mock（真实实现会探测 127.0.0.1:39995，
 *   测试绝不发真实网络请求）；
 * - `src/protocol/editor-server.js` 的 EditorServer → mock（真实实现会独占绑定
 *   39998，测试绝不真起端口）；
 * - `src/test/index.js` 桶文件的 discoverTests / TestRunner / formatConsole → mock
 *   （真实实现要读工作区、经 SessionExec 打 TTS；toJson 保持真实现——--json
 *   落盘用例据此校验文件内容）；
 * - process.exit → mock 成抛 ExitError（parseAsync 把 action 的异常原样 reject，
 *   测试据此断言退出码；与 cli-build.test.ts 同款）；
 * - console.log / console.error → spyOn 捕获，输出文案按 t() 契约断言（键 +
 *   参数两侧同调 t()；cli.test.* 的 locales 尚未补齐（Stage C 补），缺键时 t()
 *   两侧都返回键名本身，断言不受影响）。`json: <路径>` 是纯数据行，按原文断言。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// —— 外部依赖 mock（hoisted：先于 import 执行）——
vi.mock('../../src/cli/_shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/_shared.js')>();
  return { ...actual, tryHubClient: vi.fn() };
});
vi.mock('../../src/protocol/editor-server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/protocol/editor-server.js')>();
  return { ...actual, EditorServer: vi.fn() };
});
vi.mock('../../src/test/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/test/index.js')>();
  return { ...actual, discoverTests: vi.fn(), TestRunner: vi.fn(), formatConsole: vi.fn() };
});

import { tryHubClient } from '../../src/cli/_shared.js';
import { testCommand } from '../../src/cli/commands/test.js';
import { t } from '../../src/i18n/index.js';
import type { HubClient } from '../../src/mcp/client.js';
import { PackError } from '../../src/pack/packyaml.js';
import { EditorServer } from '../../src/protocol/editor-server.js';
import {
  discoverTests,
  formatConsole,
  TestRunner,
  type DiscoveredTest,
  type RunOptions,
  type RunReport,
} from '../../src/test/index.js';

const tryHubClientMock = vi.mocked(tryHubClient);
const discoverTestsMock = vi.mocked(discoverTests);
const formatConsoleMock = vi.mocked(formatConsole);
const EditorServerMock = EditorServer as unknown as MockInstance<() => Record<string, unknown>>;
const TestRunnerMock = TestRunner as unknown as MockInstance<() => Record<string, unknown>>;

// commander 的解析期报错（--timeout 非法值等）写 process.stderr 而不经 console.error：
// 测试里静默，避免刷屏（不影响被断言的行为）。
testCommand.configureOutput({ writeErr: () => undefined });

// ---------------------------------------------------------------------------
// 夹具与环境
// ---------------------------------------------------------------------------

const ROOT = 'D:\\pack';
const REPORT_TEXT = '<formatConsole 输出（mock）>';

/** process.exit 被 mock 成抛出的哨兵错误（携带退出码） */
class ExitError extends Error {
  constructor(readonly exitCode: number | undefined) {
    super(`process.exit:${exitCode}`);
  }
}

/** 构造一条 DiscoveredTest（A2 discover 的返回元素） */
function discovered(relativePath: string, overrides: Partial<DiscoveredTest> = {}): DiscoveredTest {
  return {
    filePath: `D:/pack/${relativePath}`,
    relativePath,
    targetGuid: '-1',
    timeoutMs: 30_000,
    ...overrides,
  };
}

/** 构造一份 RunReport（字段齐全，可安全 JSON 往返） */
function makeReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: 'run-1',
    root: 'D:/pack',
    startedAt: '2026-10-06T00:00:00.000Z',
    endedAt: '2026-10-06T00:00:01.000Z',
    durationMs: 1000,
    total: 2,
    passed: 2,
    failed: 0,
    errored: 0,
    bailed: false,
    results: [],
    ...overrides,
  };
}

const FILE_A = discovered('tests/a.test.lua');
const FILE_B = discovered('tests/b.test.lua');

let logSpy: MockInstance;
let errSpy: MockInstance;
let exitSpy: MockInstance;
let runnerRunMock: MockInstance;
let serverStartMock: MockInstance;
let serverCloseMock: MockInstance;
let tmpDir: string | undefined;

beforeEach(() => {
  runnerRunMock = vi.fn();
  serverStartMock = vi.fn().mockResolvedValue(undefined);
  serverCloseMock = vi.fn().mockResolvedValue(undefined);

  TestRunnerMock.mockReset();
  TestRunnerMock.mockImplementation(() => ({ run: runnerRunMock }));
  EditorServerMock.mockReset();
  EditorServerMock.mockImplementation(() => ({
    start: serverStartMock,
    close: serverCloseMock,
    find: vi.fn(() => []),
  }));

  tryHubClientMock.mockReset();
  tryHubClientMock.mockResolvedValue(null); // 缺省：hub 离线 → 独立模式
  discoverTestsMock.mockReset();
  discoverTestsMock.mockResolvedValue([FILE_A, FILE_B]);
  formatConsoleMock.mockReset();
  formatConsoleMock.mockReturnValue(REPORT_TEXT);

  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tmpDir !== undefined) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

/** 以 user 视角运行 `tts test ...` */
async function runTest(args: string[]): Promise<void> {
  await testCommand.parseAsync(args, { from: 'user' });
}

/** 断言命令以指定退出码结束（process.exit 被拦截为 ExitError） */
async function expectExit(run: Promise<void>, code: number): Promise<ExitError> {
  const err = await run.then(
    () => {
      throw new Error('期望命令以非 0 退出码结束，但 action 正常返回了');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ExitError);
  expect((err as ExitError).exitCode).toBe(code);
  return err as ExitError;
}

/** console.log 收到的全部文本（单行合并，便于包含性断言） */
function loggedLines(): string[] {
  return logSpy.mock.calls.map((call) => call.map((part) => String(part)).join(' '));
}

/** 构造一个只带 testRun 的 HubClient 替身（C2d 的真实方法不在本测试范围内） */
function fakeHub(testRun: MockInstance): HubClient {
  return { testRun } as unknown as HubClient;
}

// ---------------------------------------------------------------------------
// 命令注册
// ---------------------------------------------------------------------------

describe('tts test · 命令注册', () => {
  it('命令名 test；有可选位置参数 [path]；--root/--target/--timeout/--json/--bail/--bundle/--no-bundle/--verbose 齐全', () => {
    expect(testCommand.name()).toBe('test');

    const args = testCommand.registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0]?.name()).toBe('path');
    expect(args[0]?.required).toBe(false);

    const longs = testCommand.options.map((option) => option.long);
    for (const flag of [
      '--root',
      '--target',
      '--timeout',
      '--json',
      '--bail',
      '--bundle',
      '--no-bundle',
      '--verbose',
    ]) {
      expect(longs).toContain(flag);
    }
    expect(testCommand.options.find((option) => option.long === '--root')?.defaultValue).toBe('.');
    expect(testCommand.options.find((option) => option.long === '--bundle')?.defaultValue).toBe(true);
  });

  it('--bail 与 --no-bundle 都是无参 boolean flag（flags 不含取值占位符；--no-bundle 是取反开关）', () => {
    const bail = testCommand.options.find((option) => option.long === '--bail');
    expect(bail?.flags).toBe('--bail');
    expect(bail?.required).toBe(false);
    expect(bail?.optional).toBe(false);

    const noBundle = testCommand.options.find((option) => option.long === '--no-bundle');
    expect(noBundle?.flags).toBe('--no-bundle');
    expect(noBundle?.negate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

describe('tts test · 参数解析', () => {
  it('缺省：bundle=true / bail=false 透传 runner.run；--no-bundle / --bail 分别改写为 false / true', async () => {
    runnerRunMock.mockResolvedValue(makeReport());

    await runTest([]);
    const defaults = runnerRunMock.mock.calls[0]?.[0] as RunOptions;
    expect(defaults.bundle).toBe(true);
    expect(defaults.bail).toBe(false);

    runnerRunMock.mockClear();
    await runTest(['--no-bundle', '--bail']);
    const negated = runnerRunMock.mock.calls[0]?.[0] as RunOptions;
    expect(negated.bundle).toBe(false);
    expect(negated.bail).toBe(true);
  });

  it('--timeout 必须正整数：非法值被 commander 拒绝（退出码 1），不进运行层', async () => {
    await expectExit(runTest(['--timeout', 'abc']), 1);

    expect(TestRunnerMock).not.toHaveBeenCalled();
    expect(EditorServerMock).not.toHaveBeenCalled();
  });

  it('--root 透传 discoverTests；无 [path] 时不带 include（走 pack.yaml tests 段 / 内置默认）', async () => {
    runnerRunMock.mockResolvedValue(makeReport());

    await runTest(['--root', ROOT]);

    expect(discoverTestsMock).toHaveBeenCalledWith({ root: ROOT, onWarning: expect.any(Function) });
    expect(discoverTestsMock.mock.calls[0]?.[0].include).toBeUndefined();
  });

  it('[path] 是目录 → include 为 <dir>/ 下任意深度的 *.test.lua；是 .lua 文件 → 原样作 include', async () => {
    runnerRunMock.mockResolvedValue(makeReport());

    await runTest(['tests/unit', '--root', ROOT]);
    expect(discoverTestsMock.mock.calls[0]?.[0]).toEqual({
      root: ROOT,
      include: ['tests/unit/**/*.test.lua'],
      onWarning: expect.any(Function),
    });

    discoverTestsMock.mockClear();
    await runTest(['tests/a.test.lua', '--root', ROOT]);
    expect(discoverTestsMock.mock.calls[0]?.[0]).toEqual({
      root: ROOT,
      include: ['tests/a.test.lua'],
      onWarning: expect.any(Function),
    });
  });

  it('--target / --timeout 覆盖每个发现条目（原条目上的 pack.yaml 值被替换）', async () => {
    runnerRunMock.mockResolvedValue(makeReport());

    await runTest(['--target', 'obj-9', '--timeout', '1234']);

    const runArg = runnerRunMock.mock.calls[0]?.[0] as RunOptions;
    expect(runArg.files).toEqual([
      {
        filePath: 'D:/pack/tests/a.test.lua',
        relativePath: 'tests/a.test.lua',
        targetGuid: 'obj-9',
        timeoutMs: 1234,
      },
      {
        filePath: 'D:/pack/tests/b.test.lua',
        relativePath: 'tests/b.test.lua',
        targetGuid: 'obj-9',
        timeoutMs: 1234,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 空清单
// ---------------------------------------------------------------------------

describe('tts test · 空测试清单', () => {
  it('未发现测试文件：打印 cli.test.no_tests_found 并退出 0（不探测 hub、不绑端口、不算退出码）', async () => {
    discoverTestsMock.mockResolvedValue([]);

    await runTest([]);

    expect(logSpy).toHaveBeenCalledWith(
      t('cli.test.no_tests_found', { root: path.resolve('.') }),
    );
    expect(tryHubClientMock).not.toHaveBeenCalled();
    expect(EditorServerMock).not.toHaveBeenCalled();
    expect(TestRunnerMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// hub 在线：委托模式
// ---------------------------------------------------------------------------

describe('tts test · hub 在线（委托模式）', () => {
  it('client.testRun 收到 root/targetGuid/timeoutMs/bail/bundle；不打 EditorServer，按响应报告输出', async () => {
    const report = makeReport();
    const testRun = vi.fn().mockResolvedValue(report);
    tryHubClientMock.mockResolvedValue(fakeHub(testRun));

    await runTest([
      '--root',
      ROOT,
      '--target',
      'obj-7',
      '--timeout',
      '1500',
      '--bail',
      '--no-bundle',
    ]);

    expect(testRun).toHaveBeenCalledTimes(1);
    expect(testRun).toHaveBeenCalledWith({
      root: ROOT,
      targetGuid: 'obj-7',
      timeoutMs: 1500,
      bail: true,
      bundle: false,
    });
    expect(logSpy).toHaveBeenCalledWith(t('cli.test.hub_delegated', { port: 39995 }));
    expect(EditorServerMock).not.toHaveBeenCalled();
    expect(TestRunnerMock).not.toHaveBeenCalled();
    expect(formatConsoleMock).toHaveBeenCalledWith(report, { color: true, verbose: false });
  });

  it('[path] 折算出的 include 一并委托给 hub（否则 hub 在线时位置参数会被无声忽略）', async () => {
    const testRun = vi.fn().mockResolvedValue(makeReport());
    tryHubClientMock.mockResolvedValue(fakeHub(testRun));

    await runTest(['tests/unit', '--root', ROOT]);

    expect(testRun).toHaveBeenCalledWith({
      root: ROOT,
      include: ['tests/unit/**/*.test.lua'],
      bail: false,
      bundle: true,
    });
  });

  it('响应体是 {report: RunReport} 包装时同样能解出报告', async () => {
    const report = makeReport({ total: 1, passed: 1 });
    const testRun = vi.fn().mockResolvedValue({ ok: true, report });
    tryHubClientMock.mockResolvedValue(fakeHub(testRun));

    await runTest([]);

    expect(formatConsoleMock).toHaveBeenCalledWith(report, { color: true, verbose: false });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('委托失败（网络层 / 协议层抛错）→ error.hub.delegateFailed + 退出 1，不回退独立模式', async () => {
    const testRun = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:39995'));
    tryHubClientMock.mockResolvedValue(fakeHub(testRun));

    await expectExit(runTest([]), 1);

    expect(errSpy).toHaveBeenCalledWith(
      t('error.hub.delegateFailed', { message: 'connect ECONNREFUSED 127.0.0.1:39995' }),
    );
    expect(EditorServerMock).not.toHaveBeenCalled();
    expect(formatConsoleMock).not.toHaveBeenCalled();
  });

  it('响应不是 RunReport 形状 → 委托失败 + 退出 1（不用半截数据编报告）', async () => {
    const testRun = vi.fn().mockResolvedValue({ ok: true, whatever: 1 });
    tryHubClientMock.mockResolvedValue(fakeHub(testRun));

    await expectExit(runTest([]), 1);

    expect(errSpy).toHaveBeenCalledWith(
      t('error.hub.delegateFailed', {
        message: '/v1/test/run 响应不是 RunReport 形状（缺 results / total 字段）',
      }),
    );
    expect(formatConsoleMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// hub 离线：独立模式
// ---------------------------------------------------------------------------

describe('tts test · hub 离线（独立模式）', () => {
  it('EditorServer.start → new TestRunner(server).run(RunOptions) → server.close（finally）', async () => {
    const report = makeReport();
    runnerRunMock.mockResolvedValue(report);

    await runTest(['--root', ROOT]);

    expect(EditorServerMock).toHaveBeenCalledTimes(1);
    expect(serverStartMock).toHaveBeenCalledTimes(1);
    const serverInstance = EditorServerMock.mock.results[0]?.value;
    expect(TestRunnerMock).toHaveBeenCalledWith(serverInstance);

    expect(runnerRunMock).toHaveBeenCalledTimes(1);
    const runArg = runnerRunMock.mock.calls[0]?.[0] as RunOptions;
    expect(runArg.root).toBe(ROOT);
    expect(runArg.server).toBe(serverInstance);
    expect(runArg.bundle).toBe(true);
    expect(runArg.bail).toBe(false);
    expect(runArg.files).toEqual([FILE_A, FILE_B]);
    expect(serverCloseMock).toHaveBeenCalledTimes(1);
    expect(formatConsoleMock).toHaveBeenCalledWith(report, { color: true, verbose: false });
  });

  it('runner.run 抛错 → error.unknown + 退出 1，且 finally 里 server.close 仍执行', async () => {
    runnerRunMock.mockRejectedValue(new Error('boom'));

    await expectExit(runTest([]), 1);

    expect(errSpy).toHaveBeenCalledWith(t('error.unknown', { msg: 'boom' }));
    expect(serverCloseMock).toHaveBeenCalledTimes(1);
  });

  it('discoverTests 抛 PackError → error.<code> + 退出 1（不起 EditorServer）', async () => {
    discoverTestsMock.mockRejectedValue(new PackError('TEST_ENTRY_NOT_FOUND', '工作区根不存在'));

    await expectExit(runTest([]), 1);

    expect(errSpy).toHaveBeenCalledWith(
      t('error.TEST_ENTRY_NOT_FOUND', { msg: '工作区根不存在' }),
    );
    expect(EditorServerMock).not.toHaveBeenCalled();
  });

  it('discoverTests 的 onWarning 走 error.<code> 键打印（只告警，不中断运行）', async () => {
    runnerRunMock.mockResolvedValue(makeReport());

    await runTest([]);

    const discoverOptions = discoverTestsMock.mock.calls[0]?.[0];
    discoverOptions?.onWarning?.(new PackError('TEST_DISCOVER_PACK_YAML_INVALID', 'tests 段不符合约定'));
    expect(errSpy).toHaveBeenCalledWith(
      t('error.TEST_DISCOVER_PACK_YAML_INVALID', { msg: 'tests 段不符合约定' }),
    );
    expect(logSpy).toHaveBeenCalledWith(REPORT_TEXT);
  });
});

// ---------------------------------------------------------------------------
// 退出码
// ---------------------------------------------------------------------------

describe('tts test · 退出码', () => {
  it('全过 → 0（不调 process.exit）', async () => {
    runnerRunMock.mockResolvedValue(makeReport({ total: 3, passed: 3 }));

    await runTest([]);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(REPORT_TEXT);
  });

  it('有失败 → 1，并在 stderr 补一行 cli.test.failed', async () => {
    const report = makeReport({ total: 2, passed: 1, failed: 1 });
    runnerRunMock.mockResolvedValue(report);

    await expectExit(runTest([]), 1);

    expect(formatConsoleMock).toHaveBeenCalledWith(report, { color: true, verbose: false });
    expect(errSpy).toHaveBeenCalledWith(t('cli.test.failed', { failed: 1 }));
    expect(errSpy).not.toHaveBeenCalledWith(t('cli.test.errored', { errored: 0 }));
  });

  it('有错误 → 2（错误优先于失败），stderr 分别按 failed / errored 实际计数打印', async () => {
    runnerRunMock.mockResolvedValue(makeReport({ total: 3, passed: 1, failed: 1, errored: 1 }));

    await expectExit(runTest([]), 2);

    expect(errSpy).toHaveBeenCalledWith(t('cli.test.failed', { failed: 1 }));
    expect(errSpy).toHaveBeenCalledWith(t('cli.test.errored', { errored: 1 }));
  });

  it('委托模式下同样按 hub 返回的报告算退出码（有错误 → 2）', async () => {
    const testRun = vi
      .fn()
      .mockResolvedValue(makeReport({ total: 1, passed: 0, failed: 0, errored: 1 }));
    tryHubClientMock.mockResolvedValue(fakeHub(testRun));

    await expectExit(runTest([]), 2);

    expect(EditorServerMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// JSON 报告与 --verbose
// ---------------------------------------------------------------------------

describe('tts test · 输出', () => {
  it('--json：报告写入指定路径（内容与 toJson(report) 一致），并打印 json: 纯数据行', async () => {
    const report = makeReport({
      total: 1,
      passed: 1,
      results: [
        {
          case: { name: '断言通过', sourceFile: 'tests/a.test.lua', sourceLine: 3 },
          status: 'passed',
          asserts: [{ kind: 'assert_eq', passed: true, sourceFile: 'tests/a.test.lua', sourceLine: 4 }],
          durationMs: 12,
          prints: ['hello'],
        },
      ],
    });
    runnerRunMock.mockResolvedValue(report);

    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tts-cli-test-'));
    const outPath = path.join(tmpDir, 'nested', 'report.json');

    await runTest(['--json', outPath]);

    const text = await readFile(outPath, 'utf8');
    expect(JSON.parse(text)).toEqual(report);
    expect(loggedLines()).toContain(`json: ${outPath}`);
  });

  it('--verbose 透传 formatConsole（color 恒为 true）', async () => {
    const report = makeReport();
    runnerRunMock.mockResolvedValue(report);

    await runTest(['--verbose']);

    expect(formatConsoleMock).toHaveBeenCalledWith(report, { color: true, verbose: true });
  });

  it('不给 --verbose 时 verbose=false，且不写 JSON 文件', async () => {
    const report = makeReport();
    runnerRunMock.mockResolvedValue(report);

    await runTest([]);

    expect(formatConsoleMock).toHaveBeenCalledWith(report, { color: true, verbose: false });
    expect(loggedLines().some((line) => line.startsWith('json: '))).toBe(false);
  });
});
