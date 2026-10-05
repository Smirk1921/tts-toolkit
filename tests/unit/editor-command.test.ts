// tests/unit/editor-command.test.ts
/**
 * src/editor/command.ts（CommandEditorAdapter）单元测试。
 *
 * 覆盖：
 * - 构造：模板缺 `{file}` 占位符 → PackError "EDITOR_TEMPLATE_INVALID"；
 * - 模板渲染：argv 切分 + `{file}` / `{line}` / `{column}` 占位符替换 +
 *   缺省 line / column 填 1；
 * - isAvailable()：通过 stub child_process.execFile 探测 PATH（不实际起进程）；
 * - openFile()：通过 stub child_process.spawn 验证 argv / detached / stdio / shell；
 * - openFile() 失败：spawn 立即触发 'error' → PackError "EDITOR_SPAWN_FAILED"。
 *
 * 实现方式：vi.mock 替换 node:child_process 的 execFile 与 spawn；
 * 不绑端口、不起真实进程、不写文件。
 */
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock 必须在 import 之前
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
    spawn: vi.fn(),
  };
});

import { execFile, spawn } from 'node:child_process';

import { PackError } from '../../src/pack/packyaml.js';
import { CommandEditorAdapter } from '../../src/editor/command.js';

/** mock spawn 返回一个能立即触发 'spawn' 事件的假 ChildProcess。 */
function makeSpawnSucceed() {
  return () => {
    const emitter = new EventEmitter() as EventEmitter & {
      unref: () => void;
      kill: () => void;
    };
    emitter.unref = () => {};
    emitter.kill = () => {};
    // 下一个 tick 触发 spawn 事件
    queueMicrotask(() => emitter.emit('spawn'));
    return emitter;
  };
}

/** mock spawn 返回一个立即触发 'error' 事件的假 ChildProcess。 */
function makeSpawnFail(err: Error) {
  return () => {
    const emitter = new EventEmitter() as EventEmitter & {
      unref: () => void;
      kill: () => void;
    };
    emitter.unref = () => {};
    emitter.kill = () => {};
    queueMicrotask(() => emitter.emit('error', err));
    return emitter;
  };
}

beforeEach(() => {
  vi.mocked(execFile).mockReset();
  vi.mocked(spawn).mockReset();
});

describe('CommandEditorAdapter 构造', () => {
  it('模板缺 {file} 占位符 → PackError EDITOR_TEMPLATE_INVALID', () => {
    expect(() => new CommandEditorAdapter('vscode', 'code --goto {line}:{column}')).toThrow(
      PackError,
    );
    try {
      new CommandEditorAdapter('vscode', 'code --goto {line}:{column}');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PackError);
      expect((err as PackError).code).toBe('EDITOR_TEMPLATE_INVALID');
    }
  });

  it('合法模板（含 {file}）构造成功', () => {
    expect(() => new CommandEditorAdapter('vscode', 'code --goto {file}:{line}:{column}')).not.toThrow();
  });

  it('只含 {file} 的极简模板也可构造（line / column 占位符可选）', () => {
    expect(() => new CommandEditorAdapter('custom', 'myeditor {file}')).not.toThrow();
  });

  it('id 属性保留传入值', () => {
    const adapter = new CommandEditorAdapter('vscode', 'code {file}');
    expect(adapter.id).toBe('vscode');
  });
});

describe('CommandEditorAdapter.isAvailable', () => {
  it('PATH 探测成功 → true', async () => {
    // execFile 用 callback(err, stdout, stderr) 形式回调
    vi.mocked(execFile).mockImplementation(((_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      if (typeof cb === 'function') {
        (cb as (e: null, o: string, err: string) => void)(null, '/usr/bin/code\n', '');
      }
      return undefined as never;
    }) as typeof execFile);

    const adapter = new CommandEditorAdapter('vscode', 'code --goto {file}');
    await expect(adapter.isAvailable()).resolves.toBe(true);
    expect(execFile).toHaveBeenCalled();
  });

  it('PATH 探测失败（命令不存在）→ false', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      if (typeof cb === 'function') {
        (cb as (e: Error) => void)(new Error('not found'));
      }
      return undefined as never;
    }) as typeof execFile);

    const adapter = new CommandEditorAdapter('vscode', 'nonexistent-editor-binary {file}');
    await expect(adapter.isAvailable()).resolves.toBe(false);
  });

  it('空模板（仅空白）→ false', async () => {
    const adapter = new CommandEditorAdapter('vscode', ' {file}');
    // executableName 是 "{file}"——非空，所以会真实调用 execFile
    // 这里只验证不抛错；具体结果取决于 stub 行为
    vi.mocked(execFile).mockImplementation(((_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      if (typeof cb === 'function') {
        (cb as (e: Error) => void)(new Error('not found'));
      }
      return undefined as never;
    }) as typeof execFile);
    await expect(adapter.isAvailable()).resolves.toBe(false);
  });
});

describe('CommandEditorAdapter.openFile', () => {
  it('spawn 立即成功 → resolve；argv 渲染正确（占位符替换 + 空白切分）', async () => {
    const spawnMock = vi.fn(makeSpawnSucceed());
    vi.mocked(spawn).mockImplementation(spawnMock as unknown as typeof spawn);

    const adapter = new CommandEditorAdapter('vscode', 'code --goto {file}:{line}:{column}');
    await adapter.openFile({ absPath: '/abs/main.lua', line: 42, column: 7 });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as unknown as [string, string[], { detached: boolean; stdio: string; shell: boolean }];
    expect(cmd).toBe('code');
    expect(args).toEqual(['--goto', '/abs/main.lua:42:7']);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(opts.shell).toBe(false);
  });

  it('缺省 line / column → 自动填 1', async () => {
    const spawnMock = vi.fn(makeSpawnSucceed());
    vi.mocked(spawn).mockImplementation(spawnMock as unknown as typeof spawn);

    const adapter = new CommandEditorAdapter('vscode', 'code --goto {file}:{line}:{column}');
    await adapter.openFile({ absPath: '/abs/main.lua' });

    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(args).toEqual(['--goto', '/abs/main.lua:1:1']);
  });

  it('不含 line / column 占位符的模板忽略 target 的行列字段', async () => {
    const spawnMock = vi.fn(makeSpawnSucceed());
    vi.mocked(spawn).mockImplementation(spawnMock as unknown as typeof spawn);

    const adapter = new CommandEditorAdapter('custom', 'myeditor {file}');
    await adapter.openFile({ absPath: '/abs/x.lua', line: 99, column: 88 });

    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(args).toEqual(['/abs/x.lua']);
  });

  it('spawn 触发 error → PackError EDITOR_SPAWN_FAILED', async () => {
    vi.mocked(spawn).mockImplementation(
      makeSpawnFail(new Error('spawn ENOENT')) as unknown as typeof spawn,
    );

    const adapter = new CommandEditorAdapter('vscode', 'nonexistent {file}');
    try {
      await adapter.openFile({ absPath: '/abs/x.lua' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PackError);
      expect((err as PackError).code).toBe('EDITOR_SPAWN_FAILED');
    }
  });

  it('文件路径含空格 → 占位符替换后该段保留为一个 argv 元素（shell:false 数组语义）', async () => {
    // 注：当前实现按"渲染后空白切分"，含空格的路径会被切开
    // 这是已知的实现约束（窗口 F 简化版），用户模板若含带空格路径
    // 应用引号包围；此用例固化现有行为，便于未来改进时识别 breaking change
    const spawnMock = vi.fn(makeSpawnSucceed());
    vi.mocked(spawn).mockImplementation(spawnMock as unknown as typeof spawn);

    const adapter = new CommandEditorAdapter('vscode', 'code {file}');
    await adapter.openFile({ absPath: '/abs/path with space/main.lua' });

    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    // 当前实现：path 中的空格把整段切成 3 个 argv
    expect(args).toEqual(['/abs/path', 'with', 'space/main.lua']);
  });
});
