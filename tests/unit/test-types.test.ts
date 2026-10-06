// tests/unit/test-types.test.ts
/**
 * src/test/types.ts 单元测试：阶段 7 测试运行器的公共类型契约。
 *
 * 纯类型文件（无运行时导出），验证方式：
 * - 编译期：用各 interface 构造最小/完整合法值（typecheck 覆盖字段名与必填性）；
 * - 运行时：验证 import type 不抛错、status 联合类型取值、命名空间无运行时导出值。
 *
 * 属于窗口 G（阶段 7），由 A1 产出。
 */
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { EditorServer } from '../../src/protocol/editor-server.js';
import * as typesModule from '../../src/test/types.js';
import type {
  AssertResult,
  DiscoveredTest,
  DiscoverOptions,
  RunOptions,
  RunReport,
  TestCase,
  TestResult,
} from '../../src/test/types.js';

describe('TestCase / AssertResult / TestResult 类型契约', () => {
  it('TestCase：最小合法用例（name / sourceFile / sourceLine）', () => {
    const c: TestCase = { name: '加法', sourceFile: 'tests/add.test.lua', sourceLine: 12 };
    expect(c.name).toBe('加法');
    expect(c.sourceFile).toBe('tests/add.test.lua');
    expect(c.sourceLine).toBe(12);
  });

  it('AssertResult：最小形态只有 kind+passed，完整形态含 message/sourceFile/sourceLine', () => {
    const ok: AssertResult = { kind: 'assert_eq', passed: true };
    expect(ok.passed).toBe(true);
    expect(ok.message).toBeUndefined();
    expect(ok.sourceFile).toBeUndefined();
    expect(ok.sourceLine).toBeUndefined();

    const failed: AssertResult = {
      kind: 'assert_eq',
      passed: false,
      message: 'assert_eq 失败：期望 2，实际 3',
      sourceFile: 'tests/add.test.lua',
      sourceLine: 15,
    };
    expect(failed.message).toContain('期望');
    expect(failed.sourceFile).toBe('tests/add.test.lua');
    expect(failed.sourceLine).toBe(15);
  });

  it('TestResult：status 只允许 passed/failed/error，且必含 asserts/prints/durationMs', () => {
    // 编译期联合类型覆盖：三个取值都能作为 status 使用
    const statuses: TestResult['status'][] = ['passed', 'failed', 'error'];
    expect(statuses).toEqual(['passed', 'failed', 'error']);

    const r: TestResult = {
      case: { name: '加法', sourceFile: 'tests/add.test.lua', sourceLine: 12 },
      status: 'failed',
      failureReason: 'assert_eq 失败：期望 2，实际 3',
      asserts: [{ kind: 'assert_eq', passed: false, message: 'boom' }],
      durationMs: 3,
      prints: ['hello from lua'],
    };
    expect(statuses).toContain(r.status);
    expect(r.asserts).toHaveLength(1);
    expect(r.prints).toEqual(['hello from lua']);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('RunReport / DiscoverOptions / DiscoveredTest 类型契约', () => {
  it('RunReport：完整报告字段（统计自洽 + bailed 标志 + results 数组）', () => {
    const report: RunReport = {
      runId: '20261006T000000-ab12cd34',
      root: path.resolve('packs/demo'),
      startedAt: '2026-10-06T00:00:00.000Z',
      endedAt: '2026-10-06T00:00:01.000Z',
      durationMs: 1000,
      total: 2,
      passed: 1,
      failed: 1,
      errored: 0,
      bailed: false,
      results: [],
    };
    expect(report.total).toBe(report.passed + report.failed + report.errored);
    expect(report.bailed).toBe(false);
    expect(Array.isArray(report.results)).toBe(true);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('DiscoverOptions：root 必填，include/exclude 可选', () => {
    const minimal: DiscoverOptions = { root: path.resolve('packs/demo') };
    expect(minimal.include).toBeUndefined();
    expect(minimal.exclude).toBeUndefined();

    const full: DiscoverOptions = {
      root: minimal.root,
      include: ['tests/**/*.test.lua'],
      exclude: ['**/tmp/**'],
    };
    expect(full.include).toEqual(['tests/**/*.test.lua']);
    expect(full.exclude).toEqual(['**/tmp/**']);
  });

  it('DiscoveredTest：绝对路径 + 相对路径 + 默认 guid "-1" + 默认超时 30000', () => {
    const t: DiscoveredTest = {
      filePath: path.resolve('packs/demo/tests/add.test.lua'),
      relativePath: 'tests/add.test.lua',
      targetGuid: '-1',
      timeoutMs: 30_000,
    };
    expect(path.isAbsolute(t.filePath)).toBe(true);
    expect(t.relativePath).toBe('tests/add.test.lua');
    expect(t.targetGuid).toBe('-1');
    expect(t.timeoutMs).toBe(30_000);
  });
});

describe('RunOptions 类型契约与纯类型文件约束', () => {
  it('RunOptions：必填 root/files/server，可选项 bundle/bail/globalTimeoutMs', () => {
    const files: DiscoveredTest[] = [
      {
        filePath: path.resolve('packs/demo/tests/add.test.lua'),
        relativePath: 'tests/add.test.lua',
        targetGuid: '-1',
        timeoutMs: 30_000,
      },
    ];
    const opts: RunOptions = {
      root: path.resolve('packs/demo'),
      files,
      // 运行器注入点：单测不真启 EditorServer，仅验证该字段可承载该类型
      server: {} as EditorServer,
      bundle: true,
      bail: false,
      globalTimeoutMs: 300_000,
    };
    expect(opts.files).toHaveLength(1);
    expect(opts.server).toBeDefined();
    expect(opts.bundle).toBe(true);
    expect(opts.bail).toBe(false);
    expect(opts.globalTimeoutMs).toBe(300_000);
  });

  it('types.ts 是纯类型文件：运行时命名空间没有任何导出值', () => {
    // 只导出 interface/type 时，编译产物是空模块，命名空间上不应挂任何键
    expect(Object.keys(typesModule)).toHaveLength(0);
  });
});
