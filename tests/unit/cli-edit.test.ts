// tests/unit/cli-edit.test.ts
/**
 * src/cli/commands/edit.ts 单元测试：`tts edit <name>` 在工作区定位脚本并用编辑器打开。
 *
 * 无真 spawn / 无真 TTS / 无真网络：
 * - `src/editor/locate.js` 的 locateScript 被 vi.mock（按用例注入命中结果或 PackError）；
 * - `src/editor/resolve.js` 的 resolveAdapter 被 vi.mock（按用例注入适配器 stub）；
 * - `src/i18n/index.js` 的 t 被 mock 成确定性渲染（键 + 排序参数 JSON），断言不依赖 locales；
 * - `src/pack/packyaml.js` 的 readPackYaml 用真实实现（写 pack.yaml 到临时目录）；
 * - process.exit 被 mock 成抛 ExitSignal（阻断 action 后续执行）；
 * - console.log / console.error 用 vi.spyOn 捕获输出。
 *
 * 覆盖：
 * - 命令注册（editCommand 名称 / 描述 / 选项）；
 * - 完整成功路径：定位 → 解析适配器 → 检查可用 → 打开 → 输出 opened；
 * - --line / --column 透传；
 * - 适配器不可用 → adapterUnavailable + exit(1)；
 * - openFile 抛 PackError → 输出 message + exit(1)；
 * - locateScript 抛 PackError "EDITOR_OBJECT_NOT_FOUND" → 输出 message + exit(1)；
 * - resolveAdapter 抛 PackError → 输出 message + exit(1)；
 * - --line 非正整数 → PackError "EDITOR_LINE_COLUMN_INVALID" + exit(1)；
 * - readPackYaml 抛 PackError（工作区无 pack.yaml）→ reportError 出口。
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// ---------------------------------------------------------------------------
// 模块 mock（先于被测模块导入）
// ---------------------------------------------------------------------------

/** locateScript mock：按用例注入返回值或抛 PackError */
vi.mock('../../src/editor/locate.js', () => ({ locateScript: vi.fn() }));

/** resolveAdapter mock：按用例注入适配器 stub 或抛 PackError */
vi.mock('../../src/editor/resolve.js', () => ({ resolveAdapter: vi.fn() }));

/** i18n mock：t 渲染成「键 + 排序参数 JSON」 */
vi.mock('../../src/i18n/index.js', () => ({
  t: (key: string, params?: Record<string, unknown>): string =>
    params === undefined
      ? key
      : `${key} ${JSON.stringify(Object.keys(params).sort().map((name) => [name, params[name]]))}`,
  initI18n: (): void => undefined,
  getLang: (): string => 'zh-CN',
}));

import { locateScript } from '../../src/editor/locate.js';
import { resolveAdapter } from '../../src/editor/resolve.js';
import { editCommand } from '../../src/cli/commands/edit.js';
import type { EditorAdapter } from '../../src/editor/types.js';
import { PackError, writePackYaml } from '../../src/pack/packyaml.js';

// ---------------------------------------------------------------------------
// 夹具与工具
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录 */
let tempRoot: string;

/** 当前用例的 process.exit spy（mock 成抛 ExitSignal） */
let exitSpy: MockInstance;

/** console.log / console.error 捕获 */
let logSpy: MockInstance;
let errorSpy: MockInstance;

/** process.exit 抛出的信号 */
class ExitSignal extends Error {
  constructor(readonly exitCode: number | string | null | undefined) {
    super(`process.exit(${String(exitCode)})`);
  }
}

const locateMock = vi.mocked(locateScript);
const resolveMock = vi.mocked(resolveAdapter);

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-cli-edit-'));
  locateMock.mockReset();
  resolveMock.mockReset();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
    throw new ExitSignal(code);
  }) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempRoot, { recursive: true, force: true });
});

/** 建一个最小合法的工作区（含 pack.yaml 与 scripts/） */
async function makeWorkspace(): Promise<string> {
  await writePackYaml(tempRoot, {
    schema_version: 1,
    name: '测试',
    workshop_id: null,
    source_mod: null,
    host: 'steamcloud',
    vcs: { lfs: 'disabled-no-lfs' },
    paths: { workdir: '.' },
    upload: { prefix: '' },
  });
  await mkdir(path.join(tempRoot, 'scripts'), { recursive: true });
  return tempRoot;
}

/** 适配器 stub：记录 openFile 调用，可注入 isAvailable 与 openFile 行为 */
function makeAdapterStub(overrides?: Partial<EditorAdapter>): EditorAdapter & {
  openFileCalls: Array<{ absPath: string; line?: number; column?: number }>;
} {
  const openFileCalls: Array<{ absPath: string; line?: number; column?: number }> = [];
  return {
    id: 'stub',
    openFileCalls,
    isAvailable: vi.fn(async () => true),
    openFile: vi.fn(async (target) => {
      openFileCalls.push({
        absPath: target.absPath,
        line: target.line,
        column: target.column,
      });
    }),
    ...overrides,
  } as EditorAdapter & { openFileCalls: typeof openFileCalls };
}

/** 调 editCommand（通过 commander 的 parseAsync 触发 action） */
async function runEdit(name: string, opts: Record<string, unknown>): Promise<void> {
  const argv: string[] = [name];
  if (opts.line !== undefined) argv.push('--line', String(opts.line));
  if (opts.column !== undefined) argv.push('--column', String(opts.column));
  if (opts.adapter !== undefined) argv.push('--adapter', String(opts.adapter));
  if (opts.command !== undefined) argv.push('--command', String(opts.command));
  argv.push('--root', tempRoot);
  // parseAsync 在 action 抛错时也会向上传播（commander 不会自己捕获 action 的异常）
  await editCommand.parseAsync(argv, { from: 'user' });
}

// ---------------------------------------------------------------------------
// 命令注册
// ---------------------------------------------------------------------------

describe('editCommand 注册', () => {
  it('命令名是 edit', () => {
    expect(editCommand.name()).toBe('edit');
  });

  it('有 --line / --column / --adapter / --command / --root 五个选项', () => {
    const flags = editCommand.options.map((o) => o.long);
    expect(flags).toContain('--line');
    expect(flags).toContain('--column');
    expect(flags).toContain('--adapter');
    expect(flags).toContain('--command');
    expect(flags).toContain('--root');
  });
});

// ---------------------------------------------------------------------------
// 成功路径
// ---------------------------------------------------------------------------

describe('tts edit 成功路径', () => {
  it('定位 → 解析 → 检查可用 → 打开 → 输出 opened', async () => {
    await makeWorkspace();
    const adapter = makeAdapterStub();
    locateMock.mockResolvedValue({ absPath: '/abs/统计面板.lua', name: '统计面板', guid: 'abc' });
    resolveMock.mockReturnValue(adapter);

    await runEdit('统计面板', {});

    expect(locateMock).toHaveBeenCalledWith(tempRoot, '统计面板');
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(adapter.isAvailable).toHaveBeenCalled();
    expect(adapter.openFileCalls).toEqual([
      { absPath: '/abs/统计面板.lua', line: undefined, column: undefined },
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('cli.edit.opened'),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--line 42 --column 7 → 透传到 openFile', async () => {
    await makeWorkspace();
    const adapter = makeAdapterStub();
    locateMock.mockResolvedValue({ absPath: '/abs/x.lua', name: 'X', guid: 'g' });
    resolveMock.mockReturnValue(adapter);

    await runEdit('X', { line: '42', column: '7' });

    expect(adapter.openFileCalls).toEqual([{ absPath: '/abs/x.lua', line: 42, column: 7 }]);
  });

  it('缺省 --line/--column → openFile 收到 undefined（由适配器填 1）', async () => {
    await makeWorkspace();
    const adapter = makeAdapterStub();
    locateMock.mockResolvedValue({ absPath: '/abs/x.lua', name: 'X', guid: 'g' });
    resolveMock.mockReturnValue(adapter);

    await runEdit('X', {});

    expect(adapter.openFileCalls[0].line).toBeUndefined();
    expect(adapter.openFileCalls[0].column).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 适配器不可用
// ---------------------------------------------------------------------------

describe('tts edit 适配器不可用', () => {
  it('isAvailable 返回 false → 输出 adapterUnavailable + exit(1)', async () => {
    await makeWorkspace();
    const adapter = makeAdapterStub({ isAvailable: vi.fn(async () => false) });
    locateMock.mockResolvedValue({ absPath: '/abs/x.lua', name: 'X', guid: 'g' });
    resolveMock.mockReturnValue(adapter);

    try {
      await runEdit('X', {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ExitSignal);
      expect((err as ExitSignal).exitCode).toBe(1);
    }
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('cli.edit.adapterUnavailable'));
  });
});

// ---------------------------------------------------------------------------
// PackError 出口
// ---------------------------------------------------------------------------

describe('tts edit PackError 出口', () => {
  it('locateScript 抛 EDITOR_OBJECT_NOT_FOUND → 输出 message + exit(1)', async () => {
    await makeWorkspace();
    locateMock.mockRejectedValue(new PackError('EDITOR_OBJECT_NOT_FOUND', '工作区中未找到对象 "X"'));

    try {
      await runEdit('X', {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ExitSignal);
      expect((err as ExitSignal).exitCode).toBe(1);
    }
    expect(errorSpy).toHaveBeenCalledWith('工作区中未找到对象 "X"');
  });

  it('resolveAdapter 抛 EDITOR_ADAPTER_UNKNOWN → 输出 message + exit(1)', async () => {
    await makeWorkspace();
    locateMock.mockResolvedValue({ absPath: '/abs/x.lua', name: 'X', guid: 'g' });
    resolveMock.mockImplementation(() => {
      throw new PackError('EDITOR_ADAPTER_UNKNOWN', '未知适配器');
    });

    try {
      await runEdit('X', {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ExitSignal);
      expect((err as ExitSignal).exitCode).toBe(1);
    }
    expect(errorSpy).toHaveBeenCalledWith('未知适配器');
  });

  it('openFile 抛 EDITOR_SPAWN_FAILED → 输出 message + exit(1)', async () => {
    await makeWorkspace();
    const adapter = makeAdapterStub({
      openFile: vi.fn(async () => {
        throw new PackError('EDITOR_SPAWN_FAILED', '启动编辑器失败');
      }),
    });
    locateMock.mockResolvedValue({ absPath: '/abs/x.lua', name: 'X', guid: 'g' });
    resolveMock.mockReturnValue(adapter);

    try {
      await runEdit('X', {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ExitSignal);
      expect((err as ExitSignal).exitCode).toBe(1);
    }
    expect(errorSpy).toHaveBeenCalledWith('启动编辑器失败');
  });

  it('--line 非正整数 → PackError EDITOR_LINE_COLUMN_INVALID + exit(1)', async () => {
    await makeWorkspace();
    locateMock.mockResolvedValue({ absPath: '/abs/x.lua', name: 'X', guid: 'g' });
    resolveMock.mockReturnValue(makeAdapterStub());

    try {
      await runEdit('X', { line: 'abc' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ExitSignal);
      expect((err as ExitSignal).exitCode).toBe(1);
    }
    // t() 被 mock 成 "key + 参数 JSON"，断言包含键名即可
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('error.editor.lineColumnInvalid'));
  });

  it('--line 0 → 同上（边界）', async () => {
    await makeWorkspace();
    locateMock.mockResolvedValue({ absPath: '/abs/x.lua', name: 'X', guid: 'g' });
    resolveMock.mockReturnValue(makeAdapterStub());

    try {
      await runEdit('X', { line: '0' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ExitSignal);
    }
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('error.editor.lineColumnInvalid'));
  });

  it('--column 负数 → 同上', async () => {
    await makeWorkspace();
    locateMock.mockResolvedValue({ absPath: '/abs/x.lua', name: 'X', guid: 'g' });
    resolveMock.mockReturnValue(makeAdapterStub());

    try {
      await runEdit('X', { column: '-5' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ExitSignal);
    }
  });
});

// ---------------------------------------------------------------------------
// 非 PackError 出口（reportError）
// ---------------------------------------------------------------------------

describe('tts edit reportError 出口', () => {
  it('工作区无 pack.yaml → readPackYaml 抛 PackError → 也按 PackError 出口（message 直输）', async () => {
    // 不建 pack.yaml，临时目录保持空
    try {
      await runEdit('X', {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ExitSignal);
      expect((err as ExitSignal).exitCode).toBe(1);
    }
    // PACK_NOT_FOUND 的 message 来自 t()，被 mock 成 "error.pack.notFound + 参数 JSON"
    expect(errorSpy).toHaveBeenCalled();
  });
});
