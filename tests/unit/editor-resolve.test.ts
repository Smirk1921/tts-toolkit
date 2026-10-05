// tests/unit/editor-resolve.test.ts
/**
 * src/editor/resolve.ts（三层配置合并）单元测试。
 *
 * 覆盖：
 * - 优先级：CLI --adapter > pack.yaml editor.adapter > 环境变量 TTS_EDITOR_ADAPTER > 默认 vscode；
 * - --adapter command 必须给 --command（PackError EDITOR_COMMAND_REQUIRED）；
 * - 未知 adapter id（PackError EDITOR_ADAPTER_UNKNOWN）；
 * - 模板缺 {file} 占位符（PackError EDITOR_TEMPLATE_INVALID，由 CommandEditorAdapter 抛出）；
 * - 环境变量 TTS_EDITOR_COMMAND 可作为 --command 的回退。
 *
 * 实现方式：直接调 resolveAdapter，用环境变量存根模拟各层；不起进程、不写文件。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommandEditorAdapter } from '../../src/editor/command.js';
import { resolveAdapter } from '../../src/editor/resolve.js';
import { PackError, type PackYaml } from '../../src/pack/packyaml.js';

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** 最小合法 pack.yaml（无 editor 字段） */
const minimalPack: PackYaml = {
  schema_version: 1,
  name: '测试',
  workshop_id: null,
  source_mod: null,
  host: 'steamcloud',
  vcs: { lfs: 'disabled-no-lfs' },
  paths: { workdir: '.' },
  upload: { prefix: '' },
};

/** 带 editor.adapter = "vscode" 的 pack.yaml */
const packWithVscode: PackYaml = {
  ...minimalPack,
  editor: { adapter: 'vscode' },
};

/** 暂存环境变量，afterEach 还原 */
const ENV_KEYS = ['TTS_EDITOR_ADAPTER', 'TTS_EDITOR_COMMAND'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
});

// ---------------------------------------------------------------------------
// 默认行为
// ---------------------------------------------------------------------------

describe('resolveAdapter 默认值', () => {
  it('CLI / pack.yaml / 环境变量都未指定 → 默认 vscode', () => {
    const adapter = resolveAdapter(minimalPack, {});
    expect(adapter).toBeInstanceOf(CommandEditorAdapter);
    expect(adapter.id).toBe('vscode');
  });
});

// ---------------------------------------------------------------------------
// 第 1 层：CLI 选项
// ---------------------------------------------------------------------------

describe('resolveAdapter 第 1 层（CLI --adapter）', () => {
  it('CLI 指定 jetbrains → 用 jetbrains（覆盖 pack.yaml 与环境变量）', () => {
    process.env.TTS_EDITOR_ADAPTER = 'sublime';
    const adapter = resolveAdapter(packWithVscode, { adapter: 'jetbrains' });
    expect(adapter.id).toBe('jetbrains');
  });

  it('CLI 指定 system → 用 system（不是 CommandEditorAdapter）', () => {
    const adapter = resolveAdapter(minimalPack, { adapter: 'system' });
    expect(adapter.id).toBe('system');
  });

  it('CLI --adapter command + --command 模板 → 用自定义模板', () => {
    const adapter = resolveAdapter(minimalPack, {
      adapter: 'command',
      command: 'myed {file}:{line}',
    });
    expect(adapter.id).toBe('command');
  });

  it('CLI --adapter command 但未给 --command 且 TTS_EDITOR_COMMAND 未设 → EDITOR_COMMAND_REQUIRED', () => {
    try {
      resolveAdapter(minimalPack, { adapter: 'command' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PackError);
      expect((err as PackError).code).toBe('EDITOR_COMMAND_REQUIRED');
    }
  });

  it('CLI --adapter command + TTS_EDITOR_COMMAND 环境变量回退 → 用环境变量模板', () => {
    process.env.TTS_EDITOR_COMMAND = 'enved {file}';
    const adapter = resolveAdapter(minimalPack, { adapter: 'command' });
    expect(adapter.id).toBe('command');
  });

  it('CLI --adapter 未知 id → EDITOR_ADAPTER_UNKNOWN', () => {
    try {
      resolveAdapter(minimalPack, { adapter: 'emacs' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PackError);
      expect((err as PackError).code).toBe('EDITOR_ADAPTER_UNKNOWN');
    }
  });

  it('CLI --command 模板缺 {file} 占位符 → EDITOR_TEMPLATE_INVALID', () => {
    try {
      resolveAdapter(minimalPack, { adapter: 'command', command: 'myed {line}' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PackError);
      expect((err as PackError).code).toBe('EDITOR_TEMPLATE_INVALID');
    }
  });
});

// ---------------------------------------------------------------------------
// 第 2 层：pack.yaml
// ---------------------------------------------------------------------------

describe('resolveAdapter 第 2 层（pack.yaml editor.adapter）', () => {
  it('pack.yaml editor.adapter = vscode → 用 vscode', () => {
    const adapter = resolveAdapter(packWithVscode, {});
    expect(adapter.id).toBe('vscode');
  });

  it('CLI 未给 --adapter 但环境变量有值时，pack.yaml 优先于环境变量', () => {
    process.env.TTS_EDITOR_ADAPTER = 'jetbrains';
    const adapter = resolveAdapter(packWithVscode, {});
    // pack.yaml 限定 vscode，覆盖环境变量
    expect(adapter.id).toBe('vscode');
  });
});

// ---------------------------------------------------------------------------
// 第 3 层：环境变量
// ---------------------------------------------------------------------------

describe('resolveAdapter 第 3 层（TTS_EDITOR_ADAPTER 环境变量）', () => {
  it('TTS_EDITOR_ADAPTER = sublime + pack.yaml 无 editor → 用 sublime', () => {
    process.env.TTS_EDITOR_ADAPTER = 'sublime';
    const adapter = resolveAdapter(minimalPack, {});
    expect(adapter.id).toBe('sublime');
  });

  it('TTS_EDITOR_ADAPTER = command + TTS_EDITOR_COMMAND → 用自定义', () => {
    process.env.TTS_EDITOR_ADAPTER = 'command';
    process.env.TTS_EDITOR_COMMAND = 'enved {file}:{line}:{column}';
    const adapter = resolveAdapter(minimalPack, {});
    expect(adapter.id).toBe('command');
  });

  it('TTS_EDITOR_ADAPTER = 未知 id → EDITOR_ADAPTER_UNKNOWN', () => {
    process.env.TTS_EDITOR_ADAPTER = 'vim';
    try {
      resolveAdapter(minimalPack, {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PackError);
      expect((err as PackError).code).toBe('EDITOR_ADAPTER_UNKNOWN');
    }
  });
});

// ---------------------------------------------------------------------------
// 优先级综合
// ---------------------------------------------------------------------------

describe('resolveAdapter 优先级综合', () => {
  it('CLI > pack.yaml > env > 默认', () => {
    process.env.TTS_EDITOR_ADAPTER = 'sublime';
    // 全部指定时 CLI 获胜
    const adapter = resolveAdapter(packWithVscode, { adapter: 'notepadpp' });
    expect(adapter.id).toBe('notepadpp');
  });

  it('无 CLI 时 pack.yaml 获胜', () => {
    process.env.TTS_EDITOR_ADAPTER = 'sublime';
    const adapter = resolveAdapter(packWithVscode, {});
    expect(adapter.id).toBe('vscode'); // pack.yaml 的 vscode 覆盖 env 的 sublime
  });

  it('无 CLI 且无 pack.yaml 时 env 获胜', () => {
    process.env.TTS_EDITOR_ADAPTER = 'sublime';
    const adapter = resolveAdapter(minimalPack, {});
    expect(adapter.id).toBe('sublime');
  });
});
