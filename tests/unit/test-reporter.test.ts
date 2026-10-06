// tests/unit/test-reporter.test.ts
/**
 * src/test/reporter.ts 单元测试（A3 产出，窗口 G 阶段 7）。
 *
 * 纯函数测试：不依赖 EditorServer / SessionExec，直接构造 RunReport 夹具校验
 * formatConsole 的中文输出结构与颜色开关（坑 16：color=false 必须无 ANSI 码）、
 * 以及 toJson 的往返一致性。
 */
import { describe, expect, it } from 'vitest';

import { formatConsole, toJson } from '../../src/test/reporter.js';
import type { RunReport } from '../../src/test/types.js';

/** 构造一份覆盖三种状态（passed/failed/error）的 RunReport 夹具 */
function makeReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: 'run-abc123',
    root: 'D:\\packs\\demo',
    startedAt: '2026-10-06T00:00:00.000Z',
    endedAt: '2026-10-06T00:00:01.500Z',
    durationMs: 1500,
    total: 3,
    passed: 1,
    failed: 1,
    errored: 1,
    bailed: false,
    results: [
      {
        case: { name: 'math :: adds', sourceFile: 'tests/a_test.lua', sourceLine: 5 },
        status: 'passed',
        asserts: [{ kind: 'assert_eq', passed: true }],
        durationMs: 12,
        prints: [],
      },
      {
        case: { name: 'math :: fails', sourceFile: 'tests/a_test.lua', sourceLine: 9 },
        status: 'failed',
        failureReason: 'assert_eq 失败：期望 3，实际 2',
        asserts: [
          {
            kind: 'assert_eq',
            passed: false,
            message: 'assert_eq 失败：期望 3，实际 2',
            sourceFile: 'tests/a_test.lua',
            sourceLine: 9,
          },
        ],
        durationMs: 10,
        prints: [],
      },
      {
        case: { name: 'boom', sourceFile: 'tests/b_test.lua', sourceLine: 0 },
        status: 'error',
        failureReason: 'attempt to index a nil value',
        asserts: [],
        durationMs: 3,
        prints: [],
      },
    ],
    ...overrides,
  };
}

describe('formatConsole', () => {
  it('输出包含报告头关键字段（运行 ID / 工作区 / 开始 / 耗时）', () => {
    const out = formatConsole(makeReport(), { color: false });
    expect(out).toContain('运行 ID: run-abc123');
    expect(out).toContain('工作区: D:\\packs\\demo');
    expect(out).toContain('开始: 2026-10-06T00:00:00.000Z');
    expect(out).toContain('耗时: 1500ms');
  });

  it('输出包含统计与总结行（通过 X/Y、失败、错误、总结）', () => {
    const out = formatConsole(makeReport(), { color: false });
    expect(out).toContain('结果统计');
    expect(out).toContain('通过: 1/3');
    expect(out).toContain('失败: 1');
    expect(out).toContain('错误: 1');
    expect(out).toContain('总结: 通过 1 / 失败 1 / 错误 1');
  });

  it('包含中文标题与分隔线', () => {
    const out = formatConsole(makeReport(), { color: false });
    expect(out).toContain('测试运行报告');
    expect(out).toContain('═══════════════');
    expect(out).toContain('────────');
  });

  it('color=false 时完全不输出 ANSI 码（坑 16 防御）', () => {
    const out = formatConsole(makeReport(), { color: false });
    expect(out).not.toMatch(/\u001b\[/);
  });

  it('color=true 时输出 ANSI 颜色码', () => {
    const out = formatConsole(makeReport(), { color: true });
    expect(out).toMatch(/\u001b\[/);
    // 通过用绿色渲染
    expect(out).toContain('\u001b[32m');
    // 失败用红色渲染
    expect(out).toContain('\u001b[31m');
    // 错误用黄色渲染
    expect(out).toContain('\u001b[33m');
  });

  it('color 缺省为 true（不传 opts 也带颜色）', () => {
    const out = formatConsole(makeReport());
    expect(out).toMatch(/\u001b\[/);
  });

  it('失败详情列出用例位置与断言失败消息', () => {
    const out = formatConsole(makeReport(), { color: false });
    expect(out).toContain('[失败详情]');
    expect(out).toContain('✗ math :: fails (tests/a_test.lua:9)');
    expect(out).toContain('断言失败: assert_eq 失败：期望 3，实际 2');
  });

  it('错误详情列出运行时错误原因', () => {
    const out = formatConsole(makeReport(), { color: false });
    expect(out).toContain('[错误详情]');
    expect(out).toContain('✗ boom (tests/b_test.lua:0)');
    expect(out).toContain('运行时错误: attempt to index a nil value');
  });

  it('bailed=true 时输出提前终止提示', () => {
    const out = formatConsole(makeReport({ bailed: true }), { color: false });
    expect(out).toContain('已提前终止');
  });

  it('verbose=true 时显示用例的 print 输出，缺省不显示', () => {
    const report = makeReport();
    report.results[0]!.prints = ['lua debug line'];
    const plain = formatConsole(report, { color: false });
    expect(plain).not.toContain('lua debug line');
    const verbose = formatConsole(report, { color: false, verbose: true });
    expect(verbose).toContain('lua debug line');
    expect(verbose).toContain('[print 输出]');
  });

  it('空报告（0 用例）也能正常格式化', () => {
    const out = formatConsole(
      makeReport({ total: 0, passed: 0, failed: 0, errored: 0, results: [] }),
      { color: false },
    );
    expect(out).toContain('通过: 0/0');
    expect(out).toContain('总结: 通过 0 / 失败 0 / 错误 0');
    expect(out).not.toContain('[失败详情]');
    expect(out).not.toContain('[错误详情]');
  });
});

describe('toJson', () => {
  it('产出合法 JSON 且字段完整', () => {
    const report = makeReport();
    const parsed = JSON.parse(toJson(report)) as RunReport;
    expect(parsed.runId).toBe('run-abc123');
    expect(parsed.root).toBe('D:\\packs\\demo');
    expect(parsed.durationMs).toBe(1500);
    expect(parsed.total).toBe(3);
    expect(parsed.passed).toBe(1);
    expect(parsed.failed).toBe(1);
    expect(parsed.errored).toBe(1);
    expect(parsed.bailed).toBe(false);
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results[1]).toMatchObject({
      status: 'failed',
      case: { name: 'math :: fails', sourceFile: 'tests/a_test.lua', sourceLine: 9 },
    });
  });

  it('JSON 往返深度等于原报告（无函数/undefined 字段丢失语义）', () => {
    const report = makeReport();
    expect(JSON.parse(toJson(report))).toEqual(report);
  });
});
