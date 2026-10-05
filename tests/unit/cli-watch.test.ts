// tests/unit/cli-watch.test.ts
/**
 * src/cli/commands/watch.ts 单元测试：`tts watch` 监听 + 防抖 + 自动 push。
 *
 * 无真网络 / 无真 TTS / 无真文件监听（约定：单测必须 mock 网络与外部事件源）：
 * - `chokidar` 被 vi.mock 成 FakeWatcher：记录 watch() 收到的路径与选项，
 *   测试用 trigger() 手工派发 add / change / unlink 事件（真 chokidar 不落盘监听）；
 * - `src/pack/push.js` 的 pushSaveAndPlay 被 vi.mock 成记录器（绝不真绑 39998、
 *   绝不真连 TTS），按用例注入成功结果 / PackError / 普通错误；
 * - `src/cli/_shared.js` 的 tryHubClient 被 vi.mock：返回 null（独立模式）或
 *   hub stub（记录 hub.push 调用与返回体），覆盖委托 / 回显不一致 / 形状非法；
 * - `src/i18n/index.js` 的 t 被 mock 成确定性渲染（键 + 排序后的参数 JSON），
 *   断言只依赖键名与参数、不依赖 locales 文案（Run 2 补齐 locales 后测试仍稳定）；
 * - 工作区用真临时目录（mkdtemp + writePackYaml）——watch 启动时的 readPackYaml
 *   校验走真文件系统；
 * - process.exit 被 mock 成抛 ExitSignal（阻止 action 在 exit 后继续执行），
 *   用 exitSpy.mock.calls 断言退出码；SIGINT 用 process.emit("SIGINT") 触发；
 * - 防抖用 vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })——
 *   只劫持防抖计时器，setImmediate 保持真实（until() 轮询用）。
 *
 * 断言约定：错误不断言 message 文案；输出断言用 mock 后的 t() 重建期望串。
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// ---------------------------------------------------------------------------
// 模块 mock（先于被测模块导入声明）
// ---------------------------------------------------------------------------

/** FakeWatcher 收集器（vi.hoisted 保证 mock 工厂可用） */
const watcherState = vi.hoisted(() => ({ created: [] as unknown[] }));

/** chokidar mock：watch() 造 FakeWatcher（记录路径 / 选项 / 处理器，close 可断言） */
vi.mock('chokidar', () => {
  interface FakeWatcherLike {
    paths: string[];
    options: unknown;
    closed: boolean;
    handlers: Map<string, Array<(filePath: string) => void>>;
    on(event: string, handler: (filePath: string) => void): FakeWatcherLike;
    close(): Promise<void>;
  }
  const createWatcher = (paths: string | string[], options: unknown): FakeWatcherLike => {
    const handlers = new Map<string, Array<(filePath: string) => void>>();
    const watcher: FakeWatcherLike = {
      paths: Array.isArray(paths) ? [...paths] : [paths],
      options,
      closed: false,
      handlers,
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return watcher;
      },
      close: async () => {
        watcher.closed = true;
        // 模拟真实 chokidar：close 之后不再向处理器派发事件
        handlers.clear();
      },
    };
    watcherState.created.push(watcher);
    return watcher;
  };
  return { watch: vi.fn(createWatcher) };
});

/** pushSaveAndPlay mock：默认 resolve 空结果，按用例覆盖 */
vi.mock('../../src/pack/push.js', () => ({ pushSaveAndPlay: vi.fn() }));

/** tryHubClient mock：默认 null（独立模式），hub 用例注入 stub */
vi.mock('../../src/cli/_shared.js', () => ({ tryHubClient: vi.fn() }));

/** i18n mock：t 渲染成「键 + 排序参数 JSON」，与 locales 状态彻底解耦 */
vi.mock('../../src/i18n/index.js', () => ({
  t: (key: string, params?: Record<string, unknown>): string =>
    params === undefined
      ? key
      : `${key} ${JSON.stringify(Object.keys(params).sort().map((name) => [name, params[name]]))}`,
  initI18n: (): void => undefined,
  getLang: (): string => 'zh-CN',
}));

// —— 被 mock 的模块按 mock 形态导入 ——
import { watch } from 'chokidar';

import { tryHubClient } from '../../src/cli/_shared.js';
import { watchCommand } from '../../src/cli/commands/watch.js';
import { t } from '../../src/i18n/index.js';
import { scriptsDir, uiDir } from '../../src/pack/layout.js';
import { writePackYaml } from '../../src/pack/packyaml.js';
import { pushSaveAndPlay } from '../../src/pack/push.js';
import type { PushSaveResult } from '../../src/pack/push.js';
import type { HubClient } from '../../src/mcp/client.js';
import { PackError } from '../../src/pack/packyaml.js';

// ---------------------------------------------------------------------------
// 夹具与工具
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录 */
let tempRoot: string;

/** 当前用例的 process.exit spy（mock 成抛 ExitSignal 阻断 action 后续执行） */
let exitSpy: MockInstance;

/** beforeEach 时已存在的 SIGINT 监听器（afterEach 只移除测试新增的） */
let sigintBefore: NodeJS.SignalsListener[];

/** pushSaveAndPlay 的 mock 句柄 */
const pushSaveAndPlayMock = vi.mocked(pushSaveAndPlay);

/** tryHubClient 的 mock 句柄 */
const tryHubClientMock = vi.mocked(tryHubClient);

/** chokidar.watch 的 mock 句柄 */
const watchMock = vi.mocked(watch);

/** process.exit 被 mock 成抛出的信号（阻止 action 在 exit 后继续跑） */
class ExitSignal extends Error {
  constructor(readonly exitCode: number | string | null | undefined) {
    super(`process.exit(${String(exitCode)})`);
  }
}

/** 独立模式 pushSaveAndPlay 的缺省成功结果（按用例覆盖） */
const PUSHED_RESULT: PushSaveResult = { dryRun: false, pushed: 2, skipped: 1, backupDir: '/tmp/backup', note: '' };

beforeEach(() => {
  tempRoot = '';
  watcherState.created.length = 0;
  pushSaveAndPlayMock.mockReset();
  pushSaveAndPlayMock.mockResolvedValue({ ...PUSHED_RESULT });
  tryHubClientMock.mockReset();
  tryHubClientMock.mockResolvedValue(null);
  watchMock.mockClear();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
    throw new ExitSignal(code);
  }) as never);
  sigintBefore = process.listeners('SIGINT');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const listener of process.listeners('SIGINT')) {
    if (!sigintBefore.includes(listener)) {
      process.removeListener('SIGINT', listener);
    }
  }
  vi.restoreAllMocks();
  if (tempRoot !== '') {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * 建一个带合法 pack.yaml 与 scripts/ + ui/ 目录的工作区根（不真建 decks/objects，
 * 需要的用例自行 mkdir）。
 */
async function makePackRoot(): Promise<string> {
  const root = path.join(tempRoot, 'pack');
  await writePackYaml(root, {
    schema_version: 1,
    name: '监听图包',
    workshop_id: null,
    source_mod: null,
    host: 'steamcloud',
    vcs: { lfs: 'disabled-no-lfs' },
    paths: { workdir: '.' },
    upload: { prefix: '' },
  });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'ui'), { recursive: true });
  return root;
}

/** 最近一次创建的 FakeWatcher（未创建时抛错，防测试静默跑空） */
function lastWatcher(): {
  paths: string[];
  options: {
    ignoreInitial?: boolean;
    awaitWriteFinish?: { stabilityThreshold: number; pollInterval: number };
    ignored?: (candidate: string, stats?: Stats) => boolean;
  };
  closed: boolean;
  handlers: Map<string, Array<(filePath: string) => void>>;
} {
  const watcher = watcherState.created.at(-1);
  if (watcher === undefined) {
    throw new Error('watcher 尚未创建');
  }
  return watcher as ReturnType<typeof lastWatcher>;
}

/** 手工派发一个 chokidar 事件（走 FakeWatcher 记录的处理器） */
function trigger(event: 'add' | 'change' | 'unlink', filePath: string): void {
  for (const handler of lastWatcher().handlers.get(event) ?? []) {
    handler(filePath);
  }
}

/** 轮询等待条件成立（setImmediate 真实计时，不受 fake timers 影响） */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!condition()) {
    throw new Error(`等待超时：${what}`);
  }
}

/**
 * 空转若干轮真实宏任务（flush 微任务链：promise 续体 / finally 块）。
 * fake timers 只劫持 setTimeout，setImmediate 保持真实，因此用它推动
 * "gate resolve → push 收尾 → 重新排程"这类纯微任务序列。
 */
async function flushMacrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * 启动 watch（不 await 完整生命周期——它要挂到 SIGINT 才返回），
 * 返回结束时需要 await 的 running promise。
 */
function startWatch(args: string[]): Promise<void> {
  return watchCommand.parseAsync(args, { from: 'user' });
}

/** 启动并等 watcher 就绪（readPackYaml 校验 + chokidar.watch 都已完成） */
async function startWatchUntilReady(args: string[]): Promise<{ root: string; running: Promise<void> }> {
  const rootArg = args[0];
  if (rootArg === undefined) {
    throw new Error('startWatchUntilReady 需要 args[0] 作为 root');
  }
  const root = path.resolve(rootArg);
  const running = startWatch(args);
  await until(() => watcherState.created.length > 0, 'watcher 创建');
  return { root, running };
}

/** 优雅收尾：发 SIGINT 并等 action 的 running promise settle */
async function stopWatch(running: Promise<void>): Promise<void> {
  process.emit('SIGINT');
  await running;
  await until(() => exitSpy.mock.calls.length > 0, 'process.exit(0)');
}

/** fakes.Stats 构造（只需要 isFile） */
function fakeStats(isFile: boolean): Stats {
  return { isFile: () => isFile } as unknown as Stats;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('watch：启动与监听范围', () => {
  it('监听 scripts/ 与 ui/ 两个目录，不监听 decks/ 与 objects/', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    await mkdir(path.join(root, 'decks'), { recursive: true });
    await mkdir(path.join(root, 'objects'), { recursive: true });

    const { running } = await startWatchUntilReady([root]);

    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(lastWatcher().paths).toEqual([scriptsDir(root), uiDir(root)]);
    await stopWatch(running);
  });

  it('chokidar 选项：ignoreInitial=true + awaitWriteFinish(200/100) + ignored 过滤函数', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();

    const { running } = await startWatchUntilReady([root]);

    const options = lastWatcher().options;
    expect(options.ignoreInitial).toBe(true);
    expect(options.awaitWriteFinish).toEqual({ stabilityThreshold: 200, pollInterval: 100 });
    expect(typeof options.ignored).toBe('function');
    await stopWatch(running);
  });

  it('ignored 过滤：非 lua/xml 文件忽略，lua/xml 与目录放行', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();

    const { running } = await startWatchUntilReady([root]);

    const ignored = lastWatcher().options.ignored;
    if (ignored === undefined) {
      throw new Error('ignored 应为函数');
    }
    expect(ignored(path.join(root, 'scripts', 'aa.Pawn.ts'), fakeStats(true))).toBe(true);
    expect(ignored(path.join(root, 'scripts', 'aa.Pawn.lua'), fakeStats(true))).toBe(false);
    expect(ignored(path.join(root, 'ui', 'aa.Pawn.xml'), fakeStats(true))).toBe(false);
    expect(ignored(path.join(root, 'ui'), fakeStats(false))).toBe(false);
    await stopWatch(running);
  });

  it('启动打印 started {root} {dryRun:true} 与 watching', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { running } = await startWatchUntilReady([root]);

    expect(logSpy).toHaveBeenCalledWith(t('cli.watch.started', { root, dryRun: true }));
    expect(logSpy).toHaveBeenCalledWith(t('cli.watch.watching'));
    await stopWatch(running);
  });

  it('非图包目录启动立即失败退出（不等第一次文件事件）', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const bare = path.join(tempRoot, 'not-a-pack');
    await mkdir(bare, { recursive: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(startWatch([bare])).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('error.pack.notFound');
    expect(watcherState.created).toHaveLength(0);
  });
});

describe('watch：选项解析', () => {
  it.each(['abc', '0', '-5', '1.5', ''])('--debounce %s 非正整数 → 退出 1 + invalidDebounce', async (value) => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(startWatch([root, '--debounce', value])).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(t('cli.watch.invalidDebounce', { value }));
    expect(watcherState.created).toHaveLength(0);
  });

  it.each(['abc', '0', '101', ''])('--backup-retention %s 非 1..100 整数 → 退出 1 + invalidBackupRetention', async (value) => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(startWatch([root, '--backup-retention', value])).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(t('cli.watch.invalidBackupRetention', { value }));
    expect(watcherState.created).toHaveLength(0);
  });
});

describe('watch：dry-run / yes 语义', () => {
  it('默认 dry-run：pushSaveAndPlay 收到 dryRun:true + confirm 函数 + 缺省选项', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 1, '首次 push');

    const opts = pushSaveAndPlayMock.mock.calls[0]?.[0];
    expect(opts).toMatchObject({ root: resolved, dryRun: true, forceScriptsOnly: false, backupRetention: 20 });
    expect(typeof opts?.confirm).toBe('function');
    await stopWatch(running);
  });

  it('--yes 触发实写：pushSaveAndPlay 收到 dryRun:false', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    pushSaveAndPlayMock.mockResolvedValue({ ...PUSHED_RESULT });

    const { root: resolved, running } = await startWatchUntilReady([root, '--yes']);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 1, '首次 push');

    expect(pushSaveAndPlayMock.mock.calls[0]?.[0]).toMatchObject({ dryRun: false });
    await stopWatch(running);
  });

  it('--dry-run 与 --yes 同时给出：--yes 优先', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();

    const { root: resolved, running } = await startWatchUntilReady([root, '--dry-run', '--yes']);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 1, '首次 push');

    expect(pushSaveAndPlayMock.mock.calls[0]?.[0]).toMatchObject({ dryRun: false });
    await stopWatch(running);
  });

  it('--force-scripts-only 与 --backup-retention 透传给 pushSaveAndPlay', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();

    const { root: resolved, running } = await startWatchUntilReady([
      root,
      '--yes',
      '--force-scripts-only',
      '--backup-retention',
      '7',
    ]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 1, '首次 push');

    expect(pushSaveAndPlayMock.mock.calls[0]?.[0]).toMatchObject({ forceScriptsOnly: true, backupRetention: 7 });
    await stopWatch(running);
  });
});

describe('watch：事件与防抖', () => {
  it('change .lua 事件：防抖 300ms，窗口内不提前触发', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));

    await vi.advanceTimersByTimeAsync(299);
    expect(pushSaveAndPlayMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 1, '防抖后 push');
    await stopWatch(running);
  });

  it.each([
    ['change', 'ui/aa11bb.Pawn.xml'],
    ['add', 'scripts/aa11bb.Pawn.lua'],
    ['unlink', 'scripts/aa11bb.Pawn.lua'],
  ] as const)('%s 事件 %s 触发 push', async (event, relPath) => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger(event, path.join(resolved, relPath));
    await vi.advanceTimersByTimeAsync(300);

    expect(pushSaveAndPlayMock).toHaveBeenCalledTimes(1);
    await stopWatch(running);
  });

  it('decks/ 与 objects/ 下的文件事件不触发 push', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger('change', path.join(resolved, 'decks', 'deck.json'));
    trigger('change', path.join(resolved, 'objects', 'object.json'));
    trigger('add', path.join(resolved, 'decks', 'other.txt'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pushSaveAndPlayMock).not.toHaveBeenCalled();
    await stopWatch(running);
  });

  it('防抖窗口内的多个事件合批为一次 push', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(100);
    trigger('change', path.join(resolved, 'ui', 'aa11bb.Pawn.xml'));
    await vi.advanceTimersByTimeAsync(100);
    trigger('change', path.join(resolved, 'scripts', 'cc2233.Deck.lua'));
    await vi.advanceTimersByTimeAsync(500);

    expect(pushSaveAndPlayMock).toHaveBeenCalledTimes(1);
    await stopWatch(running);
  });

  it('push 进行中的新事件不并发第二次 push，完成后自动补一轮', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    let releasePush!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    pushSaveAndPlayMock.mockImplementation(async () => {
      await gate;
      return { ...PUSHED_RESULT };
    });

    const { root: resolved, running } = await startWatchUntilReady([root, '--yes']);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 1, '第一轮 push 开始');

    // 第一轮还在进行中：再来一个事件 → 记补跑标记，不并发
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pushSaveAndPlayMock).toHaveBeenCalledTimes(1);

    // 释放第一轮：finally 里据补跑标记重新排程（微任务链），再走一轮完整防抖
    releasePush();
    await flushMacrotasks();
    await vi.advanceTimersByTimeAsync(300);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 2, '补跑一轮');
    await stopWatch(running);
  });
});

describe('watch：独立模式结果输出', () => {
  it('dry-run 结果打印 dryRunSummary {pushed} {skipped}', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    pushSaveAndPlayMock.mockResolvedValue({ dryRun: true, pushed: 3, skipped: 2, note: '' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 1, 'push 完成');

    expect(logSpy).toHaveBeenCalledWith(t('cli.watch.dryRunSummary', { pushed: 3, skipped: 2 }));
    expect(logSpy).not.toHaveBeenCalledWith(t('cli.watch.pushOk', { pushed: 3, skipped: 2, backupDir: '-' }));
    await stopWatch(running);
  });

  it('实写结果打印 pushOk {pushed} {skipped} {backupDir}', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    pushSaveAndPlayMock.mockResolvedValue({ ...PUSHED_RESULT, backupDir: path.join(root, '.tts', 'backups', '20260101') });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { root: resolved, running } = await startWatchUntilReady([root, '--yes']);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 1, 'push 完成');

    expect(logSpy).toHaveBeenCalledWith(
      t('cli.watch.pushOk', {
        pushed: 2,
        skipped: 1,
        backupDir: path.join(root, '.tts', 'backups', '20260101'),
      }),
    );
    await stopWatch(running);
  });

  it('backupDir 缺省时以 "-" 占位', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    pushSaveAndPlayMock.mockResolvedValue({ ...PUSHED_RESULT, backupDir: undefined });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { root: resolved, running } = await startWatchUntilReady([root, '--yes']);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 1, 'push 完成');

    expect(logSpy).toHaveBeenCalledWith(t('cli.watch.pushOk', { pushed: 2, skipped: 1, backupDir: '-' }));
    await stopWatch(running);
  });

  it('独立模式不打印 viaHub', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 1, 'push 完成');

    expect(logSpy).not.toHaveBeenCalledWith(t('cli.watch.viaHub'));
    await stopWatch(running);
  });

  it('每轮 push 前打印 pushing', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 1, 'push 完成');

    expect(logSpy).toHaveBeenCalledWith(t('cli.watch.pushing'));
    await stopWatch(running);
  });
});

describe('watch：hub 委托', () => {
  /** hub push 的 mock 句柄（每个用例自建 stub 并注入 tryHubClient） */
  function stubHubOnline(): ReturnType<typeof vi.fn> {
    const hubPush = vi.fn();
    tryHubClientMock.mockResolvedValue({ push: hubPush } as unknown as HubClient);
    return hubPush;
  }

  it('hub 在线走委托：hub.push(root, true, 选项)，本地 pushSaveAndPlay 不被调用，打印 viaHub', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    const hubPush = stubHubOnline();
    hubPush.mockResolvedValue({ ok: true, dryRun: true, pushed: 1, skipped: 2 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => hubPush.mock.calls.length === 1, 'hub 委托');

    expect(hubPush).toHaveBeenCalledWith(resolved, true, { dryRun: true, forceScriptsOnly: false, backupRetention: 20 });
    expect(pushSaveAndPlayMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(t('cli.watch.viaHub'));
    await stopWatch(running);
  });

  it('hub 在线 + --yes：dryRun:false 与选项透传', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    const hubPush = stubHubOnline();
    hubPush.mockResolvedValue({ ok: true, dryRun: false, pushed: 1, skipped: 0, backupDir: '/b' });

    const { root: resolved, running } = await startWatchUntilReady([
      root,
      '--yes',
      '--force-scripts-only',
      '--backup-retention',
      '5',
    ]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => hubPush.mock.calls.length === 1, 'hub 委托');

    expect(hubPush).toHaveBeenCalledWith(resolved, true, { dryRun: false, forceScriptsOnly: true, backupRetention: 5 });
    await stopWatch(running);
  });

  it('hub dry-run 响应打印 dryRunSummary', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    const hubPush = stubHubOnline();
    hubPush.mockResolvedValue({ ok: true, dryRun: true, pushed: 4, skipped: 1 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => hubPush.mock.calls.length === 1, 'hub 委托');

    expect(logSpy).toHaveBeenCalledWith(t('cli.watch.dryRunSummary', { pushed: 4, skipped: 1 }));
    await stopWatch(running);
  });

  it('hub 实写响应打印 pushOk（含 backupDir）', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    const hubPush = stubHubOnline();
    hubPush.mockResolvedValue({ ok: true, dryRun: false, pushed: 2, skipped: 3, backupDir: 'C:\\bk' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { root: resolved, running } = await startWatchUntilReady([root, '--yes']);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => hubPush.mock.calls.length === 1, 'hub 委托');

    expect(logSpy).toHaveBeenCalledWith(t('cli.watch.pushOk', { pushed: 2, skipped: 3, backupDir: 'C:\\bk' }));
    await stopWatch(running);
  });

  it('hub 响应缺 pushed 但带 items：按 items 计（老版兼容）', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    const hubPush = stubHubOnline();
    hubPush.mockResolvedValue({ ok: true, dryRun: false, items: 6 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { root: resolved, running } = await startWatchUntilReady([root, '--yes']);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => hubPush.mock.calls.length === 1, 'hub 委托');

    expect(logSpy).toHaveBeenCalledWith(t('cli.watch.pushOk', { pushed: 6, skipped: 0, backupDir: '-' }));
    await stopWatch(running);
  });

  it('hub dryRun 回显与请求不一致 → dryRunMismatch，不出成功摘要，watch 继续', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    const hubPush = stubHubOnline();
    hubPush.mockResolvedValueOnce({ ok: true, dryRun: false, pushed: 9, skipped: 0 }); // 请求的是 dryRun:true
    hubPush.mockResolvedValueOnce({ ok: true, dryRun: true, pushed: 1, skipped: 0 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => hubPush.mock.calls.length === 1, '第一轮委托');

    expect(errorSpy).toHaveBeenCalledWith(t('cli.watch.dryRunMismatch', { expected: true, actual: false }));
    expect(logSpy).not.toHaveBeenCalledWith(t('cli.watch.dryRunSummary', { pushed: 9, skipped: 0 }));
    expect(exitSpy).not.toHaveBeenCalled();

    // watch 未退出：下一轮事件仍触发委托
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => hubPush.mock.calls.length === 2, '第二轮委托');
    expect(logSpy).toHaveBeenCalledWith(t('cli.watch.dryRunSummary', { pushed: 1, skipped: 0 }));
    await stopWatch(running);
  });

  it('hub 响应形状非法（ok!==true）→ pushFailed，不退出', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    const hubPush = stubHubOnline();
    hubPush.mockResolvedValue({ ok: false });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => hubPush.mock.calls.length === 1, 'hub 委托');

    expect(errorSpy).toHaveBeenCalledWith(
      t('cli.watch.pushFailed', {
        code: 'WATCH_PUSH_UNKNOWN',
        message: '/v1/push response is not the expected {ok:true,pushed:number} shape',
      }),
    );
    expect(exitSpy).not.toHaveBeenCalled();
    await stopWatch(running);
  });

  it('hub 委托抛错（HubError）→ pushFailed{code,message}，不回退独立模式，不退出', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    const hubPush = stubHubOnline();
    const hubError = new Error('hub exploded');
    (hubError as { code?: string }).code = 'HUB_INTERNAL_ERROR';
    hubPush.mockRejectedValue(hubError);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => hubPush.mock.calls.length === 1, 'hub 委托');

    expect(errorSpy).toHaveBeenCalledWith(
      t('cli.watch.pushFailed', { code: 'HUB_INTERNAL_ERROR', message: 'hub exploded' }),
    );
    expect(pushSaveAndPlayMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    await stopWatch(running);
  });
});

describe('watch：错误处理（独立模式失败不退出）', () => {
  it('pushSaveAndPlay 抛 PackError → pushFailed{code,message}，不退出且 watch 继续', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    pushSaveAndPlayMock.mockRejectedValueOnce(
      new PackError('PUSH_ASSET_CHANGES_DETECTED', '素材有改动（文案由 t() 生成）'),
    );
    pushSaveAndPlayMock.mockResolvedValueOnce({ dryRun: true, pushed: 1, skipped: 0, note: '' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 1, '第一轮 push');

    expect(errorSpy).toHaveBeenCalledWith(
      t('cli.watch.pushFailed', { code: 'PUSH_ASSET_CHANGES_DETECTED', message: '素材有改动（文案由 t() 生成）' }),
    );
    expect(exitSpy).not.toHaveBeenCalled();

    // watch 未退出：下一轮事件仍触发 push 并成功
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 2, '第二轮 push');
    expect(pushSaveAndPlayMock.mock.calls[1]?.[0]).toMatchObject({ dryRun: true });
    await stopWatch(running);
  });

  it.each([
    ['带 Node code 的网络错误', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:39999'), { code: 'ECONNREFUSED' }), 'ECONNREFUSED'],
    ['无 code 的普通错误', new Error('protocol timeout'), 'WATCH_PUSH_UNKNOWN'],
  ])('%s → pushFailed 透出 code，不退出', async (_name, err, expectedCode) => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    pushSaveAndPlayMock.mockRejectedValue(err);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { root: resolved, running } = await startWatchUntilReady([root]);
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(300);
    await until(() => pushSaveAndPlayMock.mock.calls.length === 1, 'push 失败');

    expect(errorSpy).toHaveBeenCalledWith(t('cli.watch.pushFailed', { code: expectedCode, message: err.message }));
    expect(exitSpy).not.toHaveBeenCalled();
    await stopWatch(running);
  });
});

describe('watch：SIGINT 优雅退出', () => {
  it('SIGINT → stopped + watcher.close() + exit(0)', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { running } = await startWatchUntilReady([root]);
    const watcher = lastWatcher();

    process.emit('SIGINT');
    await running;
    await until(() => exitSpy.mock.calls.length > 0, 'process.exit(0)');

    expect(watcher.closed).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(t('cli.watch.stopped'));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('SIGINT 后 action 的 running promise 正常完成（parseAsync 可 await）', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();

    const running = startWatch([root]);
    await until(() => watcherState.created.length > 0, 'watcher 创建');
    process.emit('SIGINT');

    // commander 的 parseAsync resolve 值是命令实例本身（return this），
    // 能 settle 即证明 SIGINT 走完了 stopped → close → exit 的收尾链
    await expect(running).resolves.toBe(watchCommand);
  });

  it('SIGINT 后 watcher 不再响应文件事件', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-watch-'));
    const root = await makePackRoot();

    const { root: resolved, running } = await startWatchUntilReady([root]);
    await stopWatch(running);

    const callsBefore = pushSaveAndPlayMock.mock.calls.length;
    trigger('change', path.join(resolved, 'scripts', 'aa11bb.Pawn.lua'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pushSaveAndPlayMock).toHaveBeenCalledTimes(callsBefore);
  });
});
