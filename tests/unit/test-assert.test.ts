// tests/unit/test-assert.test.ts
/**
 * src/test/assert.ts 单元测试：LUA_ASSERT_LIBRARY 字符串契约。
 *
 * 本模块导出的是 Lua 源码字符串（bundle 时注入为内置模块 "tts.assert"），
 * 本测试验证其内容完整性：API 齐全、M 模块表导出、pcall/print 截获等关键机制、
 * 以及无模板字符串转义残留。Lua 侧运行行为无法在本地（无 Lua 运行时）验证，
 * 由后续 TTS 实跑测试覆盖，此处不做 it.skip 占位。
 *
 * 属于窗口 G（阶段 7），由 A1 产出。
 */
import { describe, expect, it } from 'vitest';

import { LUA_ASSERT_LIBRARY } from '../../src/test/assert.js';

describe('LUA_ASSERT_LIBRARY 字符串契约', () => {
  it('是非空字符串', () => {
    expect(typeof LUA_ASSERT_LIBRARY).toBe('string');
    expect(LUA_ASSERT_LIBRARY.length).toBeGreaterThan(0);
  });

  it('包含全部断言与用例组织 API（describe/it/assert_*/expect_error/current_test_results）', () => {
    for (const keyword of [
      'describe',
      'it',
      'assert_eq',
      'assert_true',
      'assert_false',
      'assert_near',
      'assert_nil',
      'expect_error',
      'current_test_results',
    ]) {
      expect(LUA_ASSERT_LIBRARY).toContain(keyword);
    }
  });

  it('按 M 模块表模式组织并以 return M 结尾导出', () => {
    expect(LUA_ASSERT_LIBRARY).toContain('local M = {}');
    expect(LUA_ASSERT_LIBRARY.trimEnd().endsWith('return M')).toBe(true);
    // 关键 API 挂在 M 上
    expect(LUA_ASSERT_LIBRARY).toContain('function M.describe(');
    expect(LUA_ASSERT_LIBRARY).toContain('function M.it(');
    expect(LUA_ASSERT_LIBRARY).toContain('function M.assert_eq(');
    expect(LUA_ASSERT_LIBRARY).toContain('function M.expect_error(');
    expect(LUA_ASSERT_LIBRARY).toContain('function M.current_test_results()');
  });

  it('断言携带调用处行号（caller_line，debug 不可用时为 0）并登记到当前用例', () => {
    // TTS Lua 无 debug 库（实测 type(debug) == "nil"），断言库改用 caller_line 安全辅助
    expect(LUA_ASSERT_LIBRARY).toContain('local function caller_line(level)');
    expect(LUA_ASSERT_LIBRARY).toContain('caller_line(2)');
    expect(LUA_ASSERT_LIBRARY).toContain('table.insert(current_case.asserts, entry)');
    // 结果内部表与取回接口
    expect(LUA_ASSERT_LIBRARY).toContain('local results = { tests = {} }');
    expect(LUA_ASSERT_LIBRARY).toContain('return results');
  });

  it('用 pcall 捕获用例错误，并把 failed（断言失败）与 error（运行时错误）分开定级', () => {
    expect(LUA_ASSERT_LIBRARY).toContain('pcall(fn)');
    expect(LUA_ASSERT_LIBRARY).toContain('status = "passed"');
    expect(LUA_ASSERT_LIBRARY).toContain('case.status = "failed"');
    expect(LUA_ASSERT_LIBRARY).toContain('case.status = "error"');
    // 断言失败与运行时错误靠哨兵表区分
    expect(LUA_ASSERT_LIBRARY).toContain('ASSERT_SENTINEL');
  });

  it('print 截获只发生在用例执行期间：临时替换 _G.print 并在结束后恢复', () => {
    expect(LUA_ASSERT_LIBRARY).toContain('_G.print = capturing_print');
    expect(LUA_ASSERT_LIBRARY).toContain('_G.print = prev_print');
    // 截获输出进当前用例的 prints 表
    expect(LUA_ASSERT_LIBRARY).toContain('table.insert(current_case.prints, line)');
  });

  it('不含反引号与模板字符串转义残留（用 String.raw 检查）', () => {
    // String.raw 保留原始反斜杠：String.raw`\`` 是"反斜杠+反引号"两个原始字符
    const escapedBacktick = String.raw`\``;
    expect(escapedBacktick).toBe('\\`');
    // 导出的 Lua 源码既不能有裸反引号，也不能有转义残留（反斜杠+反引号）
    expect(LUA_ASSERT_LIBRARY).not.toContain('`');
    expect(LUA_ASSERT_LIBRARY).not.toContain(escapedBacktick);
  });
});
