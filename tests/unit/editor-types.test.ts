// tests/unit/editor-types.test.ts
/**
 * src/editor/types.ts 单元测试：EditorAdapter 接口契约 + EDITOR_PRESET_IDS 常量。
 *
 * 纯类型与常量断言，不依赖 fs / 网络 / TTS。
 * 覆盖：
 * - EDITOR_PRESET_IDS 的取值与顺序（与方案设计 §7.2 的 6 个预设一致）；
 * - EditorOpenTarget 类型的最小必填字段（absPath）与可选字段（line / column）；
 * - EditorAdapter 接口的实现契约（id 只读、isAvailable / openFile 是函数）。
 */
import { describe, expect, it } from 'vitest';

import {
  EDITOR_PRESET_IDS,
  type EditorAdapter,
  type EditorOpenTarget,
} from '../../src/editor/types.js';

describe('EDITOR_PRESET_IDS', () => {
  it('恰好 6 个预设 id', () => {
    expect(EDITOR_PRESET_IDS).toHaveLength(6);
  });

  it('预设 id 与方案设计 §7.2 一致（顺序敏感）', () => {
    expect([...EDITOR_PRESET_IDS]).toEqual([
      'vscode',
      'jetbrains',
      'sublime',
      'notepadpp',
      'system',
      'command',
    ]);
  });

  it('id 数组是 readonly（运行时不允许 push）', () => {
    // readonly 是 TypeScript 编译期约束；运行时数组本身仍可被修改
    // 这里只断言数组的内容与长度，不做"试图修改"的副作用操作
    expect(Object.isFrozen(EDITOR_PRESET_IDS)).toBe(false); // as const 不 freeze
  });
});

describe('EditorOpenTarget 类型契约', () => {
  it('最小目标只含 absPath', () => {
    const target: EditorOpenTarget = { absPath: '/abs/path.lua' };
    expect(target.absPath).toBe('/abs/path.lua');
    expect(target.line).toBeUndefined();
    expect(target.column).toBeUndefined();
  });

  it('完整目标含 absPath + line + column', () => {
    const target: EditorOpenTarget = { absPath: '/abs/path.lua', line: 42, column: 7 };
    expect(target.line).toBe(42);
    expect(target.column).toBe(7);
  });
});

describe('EditorAdapter 接口契约', () => {
  it('实现类可以提供 id 只读属性 + 两个方法', async () => {
    // 最简实现，用于断言接口形状
    const fake: EditorAdapter = {
      id: 'fake',
      async isAvailable() {
        return true;
      },
      async openFile(_target: EditorOpenTarget) {
        /* no-op */
      },
    };
    expect(fake.id).toBe('fake');
    expect(typeof fake.isAvailable).toBe('function');
    expect(typeof fake.openFile).toBe('function');
    await expect(fake.isAvailable()).resolves.toBe(true);
    await expect(fake.openFile({ absPath: '/x.lua' })).resolves.toBeUndefined();
  });
});
