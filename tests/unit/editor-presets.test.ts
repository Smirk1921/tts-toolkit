// tests/unit/editor-presets.test.ts
/**
 * src/editor/presets.ts（6 个内置预设）单元测试。
 *
 * 覆盖：
 * - createPresetAdapter 接受 6 个 id 并返回对应实例；
 * - vscode / jetbrains / sublime / notepadpp 预设的命令模板与方案设计 §7.2 一致；
 * - system 预设 id 是 "system"，isAvailable 恒 true，openFile 忽略 line / column；
 * - command 预设必须提供自定义模板，未提供时抛 Error（编程错误，调用方应先在
 *   resolve.ts 校验）。
 *
 * 实现方式：vi.mock node:child_process 防止真实 spawn；isAvailable / openFile
 * 的具体行为在 editor-command.test.ts 已覆盖，这里只断言预设层的模板与路由。
 */
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
    execFile: vi.fn(),
  };
});

import { spawn } from 'node:child_process';

import { CommandEditorAdapter } from '../../src/editor/command.js';
import { createPresetAdapter } from '../../src/editor/presets.js';

function makeSpawnSucceed() {
  return () => {
    const emitter = new EventEmitter() as EventEmitter & { unref: () => void };
    emitter.unref = () => {};
    queueMicrotask(() => emitter.emit('spawn'));
    return emitter;
  };
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(makeSpawnSucceed() as unknown as typeof spawn);
});

describe('createPresetAdapter 路由', () => {
  it('vscode → CommandEditorAdapter + 正确模板', async () => {
    const adapter = createPresetAdapter('vscode');
    expect(adapter).toBeInstanceOf(CommandEditorAdapter);
    expect(adapter.id).toBe('vscode');

    await adapter.openFile({ absPath: '/abs/x.lua', line: 10, column: 5 });
    const [cmd, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('code');
    expect(args).toEqual(['--goto', '/abs/x.lua:10:5']);
  });

  it('jetbrains → idea --line {line} {file}', async () => {
    const adapter = createPresetAdapter('jetbrains');
    expect(adapter.id).toBe('jetbrains');

    await adapter.openFile({ absPath: '/abs/x.lua', line: 10 });
    const [cmd, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('idea');
    expect(args).toEqual(['--line', '10', '/abs/x.lua']);
  });

  it('sublime → subl {file}:{line}:{column}', async () => {
    const adapter = createPresetAdapter('sublime');
    expect(adapter.id).toBe('sublime');

    await adapter.openFile({ absPath: '/abs/x.lua', line: 3, column: 9 });
    const [cmd, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('subl');
    expect(args).toEqual(['/abs/x.lua:3:9']);
  });

  it('notepadpp → notepad++ -n{line} {file}', async () => {
    const adapter = createPresetAdapter('notepadpp');
    expect(adapter.id).toBe('notepadpp');

    await adapter.openFile({ absPath: '/abs/x.lua', line: 20 });
    const [cmd, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('notepad++');
    expect(args).toEqual(['-n20', '/abs/x.lua']);
  });

  it('system → 平台命令；isAvailable 恒 true；行列被忽略', async () => {
    const adapter = createPresetAdapter('system');
    expect(adapter.id).toBe('system');

    await expect(adapter.isAvailable()).resolves.toBe(true);

    await adapter.openFile({ absPath: '/abs/x.lua', line: 42, column: 7 });
    const [cmd, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    // Windows: cmd /c start "" "<file>"；POSIX: open / xdg-open
    if (process.platform === 'win32') {
      expect(cmd).toBe('cmd');
      expect(args[0]).toBe('/c');
      expect(args[1]).toBe('start');
      expect(args[2]).toBe('""');
      expect(args[3]).toBe('"/abs/x.lua"');
    } else if (process.platform === 'darwin') {
      expect(cmd).toBe('open');
      expect(args).toEqual(['"/abs/x.lua"']);
    } else {
      expect(cmd).toBe('xdg-open');
      expect(args).toEqual(['"/abs/x.lua"']);
    }
    // 行列被忽略：args 中没有 42 / 7
    expect(args.join(' ')).not.toContain('42');
  });

  it('command + 自定义模板 → CommandEditorAdapter 用自定义模板', async () => {
    const adapter = createPresetAdapter('command', 'myed {file}:{line}');
    expect(adapter).toBeInstanceOf(CommandEditorAdapter);
    expect(adapter.id).toBe('command');

    await adapter.openFile({ absPath: '/abs/x.lua', line: 7, column: 99 });
    const [cmd, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('myed');
    // 模板只含 {file}:{line}，column 被忽略
    expect(args).toEqual(['/abs/x.lua:7']);
  });

  it('command 但未提供模板 → 抛 Error（编程错误；调用方应先在 resolve.ts 校验）', () => {
    expect(() => createPresetAdapter('command')).toThrow(/customTemplate/);
    expect(() => createPresetAdapter('command', '')).toThrow(/customTemplate/);
  });
});
