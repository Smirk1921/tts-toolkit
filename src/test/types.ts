// src/test/types.ts
/**
 * 阶段 7 测试运行器的公共类型定义。
 *
 * 属于窗口 G（阶段 7：测试运行器 + 发布链路），由 A1 产出。
 * 本文件是 src/test/ 下所有模块（discover / runner / reporter / bundle）共同遵守的
 * 数据契约，被后续 CLI 命令与 MCP 工具消费。
 *
 * 纯类型文件：只导出 interface / type，不导出任何运行时值。
 */

import type { EditorServer } from "../protocol/editor-server.js";

/** 单个测试用例（一个 Lua 文件里可以有多条测试） */
export interface TestCase {
  /** 用例名（Lua 侧 describe/it 的第一参数） */
  name: string;
  /** 所属 Lua 源文件路径（相对 pack 根） */
  sourceFile: string;
  /** Lua 源文件里的行号（bundle 前的原始行号） */
  sourceLine: number;
}

/** 单条断言结果 */
export interface AssertResult {
  /** 断言类型（如 "assert_eq" / "assert_true" / "expect_error"） */
  kind: string;
  /** 是否通过 */
  passed: boolean;
  /** 失败时的消息（含期望值 vs 实际值） */
  message?: string;
  /** 失败时的 Lua 源文件路径（用于 unbundle 行号映射后回写） */
  sourceFile?: string;
  /** 失败时的源文件行号 */
  sourceLine?: number;
}

/** 单个测试用例的运行结果 */
export interface TestResult {
  case: TestCase;
  /** 用例结果状态：passed 通过；failed 断言失败；error 运行时错误（非断言异常） */
  status: "passed" | "failed" | "error";
  /** 失败/错误时的详细原因 */
  failureReason?: string;
  /** 该用例下所有断言的结果 */
  asserts: AssertResult[];
  /** 运行耗时（毫秒） */
  durationMs: number;
  /** Lua 侧 print 输出（调试用） */
  prints: string[];
}

/** 整个测试运行的总报告 */
export interface RunReport {
  /** 运行 ID（时间戳 + 随机后缀，用于报告文件名） */
  runId: string;
  /** 工作区根（绝对路径） */
  root: string;
  /** 运行开始时间 ISO 8601 */
  startedAt: string;
  /** 运行结束时间 ISO 8601 */
  endedAt: string;
  /** 总耗时（毫秒） */
  durationMs: number;
  /** 统计 */
  total: number;
  passed: number;
  failed: number;
  errored: number;
  /** 是否提前终止（--bail 模式下首个失败即停） */
  bailed: boolean;
  /** 各用例结果 */
  results: TestResult[];
}

/** discover 模块的入参 */
export interface DiscoverOptions {
  /** 图包工作区根 */
  root: string;
  /** 额外 glob 覆盖（默认走 pack.yaml tests.include 或内置默认） */
  include?: string[];
  /** 排除 glob（在 include 结果上排除） */
  exclude?: string[];
}

/** discover 模块的返回值 */
export interface DiscoveredTest {
  /** Lua 源文件绝对路径 */
  filePath: string;
  /** 相对 pack 根的路径（用于报告） */
  relativePath: string;
  /** 目标对象 guid（"-1" = Global；可由 pack.yaml tests.target_guid 覆盖） */
  targetGuid: string;
  /** 单文件超时（毫秒；可由 pack.yaml tests.timeout 覆盖） */
  timeoutMs: number;
}

/** runner 模块的入参 */
export interface RunOptions {
  /** 图包工作区根 */
  root: string;
  /** 已发现的测试文件清单（来自 discover） */
  files: DiscoveredTest[];
  /** 是否启用 bundle（默认 true；false 时逐文件直跑） */
  bundle?: boolean;
  /** 首个失败即停（默认 false） */
  bail?: boolean;
  /** 注入的 EditorServer（独立模式下由调用方启动并传入；hub 委托模式下由 hub 注入） */
  server: EditorServer;
  /** 全局超时（毫秒；默认 300_000） */
  globalTimeoutMs?: number;
}
