// src/test/assert.ts
/**
 * 阶段 7 测试运行器的内置 Lua 断言库源码。
 *
 * 属于窗口 G（阶段 7：测试运行器 + 发布链路），由 A1 产出。
 * LUA_ASSERT_LIBRARY 会被 bundle 模块（A4）作为内置模块 "tts.assert" 注入打包结果，
 * 脚本执行完后由 runner（A3）经 current_test_results() 取回结构化结果。
 *
 * Lua 库 API（挂在模块表 M 上，同时提升为同名全局，测试文件可直接裸调用）：
 * - describe(name, fn)                         开始一个测试组（可嵌套，用例名前缀 = 各层
 *                                              describe 名以 " :: " 连接）
 * - it(name, fn)                               定义并立即执行一个用例；pcall 捕获错误并分类
 * - assert_eq(actual, expected, msg?)          相等断言（== 语义）
 * - assert_true(v, msg?)                       真值断言（非 nil 且非 false）
 * - assert_false(v, msg?)                      假值断言（nil 或 false）
 * - assert_nil(v, msg?)                        nil 断言
 * - assert_near(actual, expected, eps?, msg?)  数值近似断言（|a-e| <= eps，eps 缺省 1e-6）
 * - expect_error(fn, msg?)                     期望 fn 抛错；不抛错则失败
 * - current_test_results()                     返回 { tests = { { name, source_line, status,
 *                                              failure_reason, asserts, prints }, ... } }
 * - reset_results()                            扩展：清空结果（同一 Lua 会话内重复运行防串扰）
 *
 * 结果条目约定：
 * - asserts 内每条为 { kind, passed, message?, line }，line 为断言调用处的 Lua 行号；
 * - status 取值 "passed" / "failed"（断言失败）/ "error"（运行时错误）；
 * - print 仅在 it 执行期间被临时截获进当前用例的 prints，结束后恢复原全局 print。
 */

/** 内置 Lua 断言库 "tts.assert" 的完整源码（bundle 时作为内置模块注入）。 */
export const LUA_ASSERT_LIBRARY: string = `
-- tts.assert：阶段 7 测试运行器内置断言库（bundle 时注入为内置模块 "tts.assert"）。
-- 提供 describe/it 用例组织 + assert_* 断言族 + expect_error + print 截获。
-- 全部结果累积在内部表 results，脚本执行完后由运行器经 current_test_results() 取回。
--
-- 结果结构：
--   results = {
--     tests = {
--       { name = "...",                        -- 用例名（describe 内时带 "组 :: 用例" 前缀）
--         source_line = N,                     -- it(...) 调用处的 Lua 行号
--         status = "passed"|"failed"|"error",  -- failed=断言失败，error=运行时错误
--         failure_reason = "...",              -- 失败/错误原因（通过时为 nil）
--         asserts = { { kind = "...", passed = true|false, message = "...", line = N }, ... },
--         prints = { "...", ... } } }          -- 用例执行期间 print 的输出

local M = {}

-- 全部测试结果（current_test_results 返回的就是这张表）
local results = { tests = {} }

-- 当前正在执行的用例；仅在 it 执行期间非 nil
local current_case = nil

-- describe 嵌套栈；用例名前缀 = 各层 describe 名以 " :: " 连接
local describe_stack = {}

-- 原始全局 print 的引用（截获结束后恢复用）
local real_print = print

-- 断言失败哨兵键：error 抛出的表带此键，it 用它区分"断言失败"与"运行时错误"
local ASSERT_SENTINEL = "__tts_assert_failure"

-- assert_near 的缺省精度
local DEFAULT_EPSILON = 1e-6

-- TTS 的 Lua 环境（MoonSharp）默认不开 debug 库（type(debug) == "nil"），
-- 统一安全获取"调用处行号"的辅助；debug 不可用时返回 0。
-- 窗口 G / Stage D 环境探测实测。
local function caller_line(level)
  if type(debug) ~= "table" or type(debug.getinfo) ~= "function" then
    return 0
  end
  local info = debug.getinfo(level or 2, "l")
  return (info and info.currentline) or 0
end

-- 值的展示形式：字符串加引号，其余 tostring（表显示为 "table: 0x..."）
local function value_repr(v)
  if type(v) == "string" then
    return string.format("%q", v)
  end
  return tostring(v)
end

-- 组装失败消息：无 msg 时为 "<kind> 失败：<detail>"；有 msg 时为 "<msg>（<kind>：<detail>）"
local function build_message(kind, msg, detail)
  if msg then
    return string.format("%s（%s：%s）", msg, kind, detail)
  end
  return string.format("%s 失败：%s", kind, detail)
end

-- 把一条断言结果登记到当前用例；不在 it 上下文时只返回不登记
local function record_assert(entry)
  if current_case ~= nil then
    table.insert(current_case.asserts, entry)
  end
  return entry
end

-- 断言失败统一出口：登记 failed 条目后抛出哨兵错误，中止当前用例。
-- TTS 的 error() 只接受字符串（实测 error({...}) 报 "bad argument #1 to 'error'
-- (string expected, got table)"），所以哨兵信息编码进字符串前缀，
-- entry 本体记录到 last_failed_entry 供 pcall 后取出。
local last_failed_entry = nil
local function fail_assert(entry)
  record_assert(entry)
  last_failed_entry = entry
  error(ASSERT_SENTINEL, 0)
end

-- 截获版 print：有当前用例时把输出追加到该用例的 prints，否则透传原始 print
local function capturing_print(...)
  local n = select("#", ...)
  local parts = {}
  for i = 1, n do
    parts[i] = tostring(select(i, ...))
  end
  local line = table.concat(parts, "\\t")
  if current_case ~= nil then
    table.insert(current_case.prints, line)
  else
    real_print(line)
  end
end

-- 当前 describe 前缀；不在任何 describe 内时为 nil
local function describe_prefix()
  if #describe_stack == 0 then
    return nil
  end
  return table.concat(describe_stack, " :: ")
end

-- 开始一个测试组：记录 describe 名（支持嵌套），执行组体，结束后弹出
function M.describe(name, fn)
  table.insert(describe_stack, name)
  fn()
  table.remove(describe_stack)
end

-- 定义并立即执行一个测试用例：pcall 捕获错误并分类记录
--   断言失败（哨兵错误）→ status = "failed"，failure_reason = 断言消息
--   其他运行时错误       → status = "error"，  failure_reason = 错误文本
function M.it(name, fn)
  -- TTS 的 Lua 环境（MoonSharp）默认不开 debug 库（type(debug) == "nil"），
  -- source_line 通过 caller_line 安全获取（debug 不可用时为 0）。
  local case = {
    name = name,
    source_line = caller_line(2),
    status = "passed",
    failure_reason = nil,
    asserts = {},
    prints = {},
  }
  local prefix = describe_prefix()
  if prefix ~= nil then
    case.name = prefix .. " :: " .. name
  end
  table.insert(results.tests, case)

  -- 临时替换全局 print 截获用例输出；结束后（含错误路径，pcall 必返回）恢复原 print
  local prev_print = _G.print
  _G.print = capturing_print
  current_case = case
  local ok, err = pcall(fn)
  current_case = nil
  _G.print = prev_print

  if not ok then
    -- 断言失败：fail_assert 已登记 entry 并把哨兵编码进字符串；pcall 抓到的是
    -- 错误消息（含位置前缀，形如 "file:line: __tts_assert_failure"）。
    if type(err) == "string" and string.find(err, ASSERT_SENTINEL, 1, true) ~= nil then
      case.status = "failed"
      local entry = last_failed_entry
      case.failure_reason = (entry and entry.message) or err
      last_failed_entry = nil
    else
      case.status = "error"
      case.failure_reason = tostring(err)
    end
  else
    -- 防御：用户代码若用自己的 pcall 吞掉断言错误，按已登记的失败条目兜底定级
    for _, a in ipairs(case.asserts) do
      if a.passed == false then
        case.status = "failed"
        case.failure_reason = a.message
        break
      end
    end
  end
  return case
end

-- 断言：实际值等于期望值（== 语义）
function M.assert_eq(actual, expected, msg)
  local line = caller_line(2)
  local entry = { kind = "assert_eq", passed = actual == expected, line = line }
  if not entry.passed then
    entry.message = build_message("assert_eq", msg,
      string.format("期望 %s，实际 %s", value_repr(expected), value_repr(actual)))
    fail_assert(entry)
  end
  record_assert(entry)
end

-- 断言：值为真（Lua 语义：非 nil 且非 false）
function M.assert_true(v, msg)
  local line = caller_line(2)
  local entry = { kind = "assert_true", passed = not not v, line = line }
  if not entry.passed then
    entry.message = build_message("assert_true", msg,
      string.format("期望真值，实际 %s", value_repr(v)))
    fail_assert(entry)
  end
  record_assert(entry)
end

-- 断言：值为假（Lua 语义：nil 或 false）
function M.assert_false(v, msg)
  local line = caller_line(2)
  local entry = { kind = "assert_false", passed = not v, line = line }
  if not entry.passed then
    entry.message = build_message("assert_false", msg,
      string.format("期望假值，实际 %s", value_repr(v)))
    fail_assert(entry)
  end
  record_assert(entry)
end

-- 断言：值为 nil
function M.assert_nil(v, msg)
  local line = caller_line(2)
  local entry = { kind = "assert_nil", passed = v == nil, line = line }
  if not entry.passed then
    entry.message = build_message("assert_nil", msg,
      string.format("期望 nil，实际 %s", value_repr(v)))
    fail_assert(entry)
  end
  record_assert(entry)
end

-- 断言：数值近似相等，|actual - expected| <= eps（eps 缺省 1e-6）
function M.assert_near(actual, expected, eps, msg)
  local line = caller_line(2)
  if type(actual) ~= "number" or type(expected) ~= "number" then
    local entry = { kind = "assert_near", passed = false, line = line }
    entry.message = build_message("assert_near", msg,
      string.format("期望数值，实际 %s 与 %s", value_repr(actual), value_repr(expected)))
    fail_assert(entry)
  end
  eps = eps or DEFAULT_EPSILON
  local diff = math.abs(actual - expected)
  local entry = { kind = "assert_near", passed = diff <= eps, line = line }
  if not entry.passed then
    entry.message = build_message("assert_near", msg,
      string.format("期望 |%s - %s| <= %s，实际差值 %s",
        tostring(actual), tostring(expected), tostring(eps), tostring(diff)))
    fail_assert(entry)
  end
  record_assert(entry)
end

-- 断言：fn 必须抛出错误才算通过；正常返回则失败
function M.expect_error(fn, msg)
  local line = caller_line(2)
  local ok = pcall(fn)
  local entry = { kind = "expect_error", passed = not ok, line = line }
  if not entry.passed then
    entry.message = build_message("expect_error", msg, "函数未抛出错误")
    fail_assert(entry)
  end
  record_assert(entry)
end

-- 返回当前已收集的全部测试结果（运行器在 bundle 脚本执行完后调用取回）
function M.current_test_results()
  return results
end

-- 清空结果与上下文（扩展接口：同一 Lua 会话内重复运行测试时由运行器调用，防串扰）
function M.reset_results()
  results = { tests = {} }
  current_case = nil
  describe_stack = {}
end

-- 把常用入口提升为同名全局（无条件覆盖：每次 bundle 执行都会重定义本库，
-- 最新实例必须胜出，否则同一 Lua 会话内重复运行会拿到上一轮的旧闭包），
-- 使测试文件可以直接写 describe/it/assert_eq(...) 而无需先 require 本模块。
_G.describe = M.describe
_G.it = M.it
_G.assert_eq = M.assert_eq
_G.assert_true = M.assert_true
_G.assert_false = M.assert_false
_G.assert_nil = M.assert_nil
_G.assert_near = M.assert_near
_G.expect_error = M.expect_error
_G.current_test_results = M.current_test_results

return M
`;
