// src/test/index.ts
/**
 * src/test/ 桶文件（坑 18：后续 CLI 命令 / MCP 工具一律从这里 import，
 * 不要深层路径耦合，避免"模块存在但没被任何入口引用"被构建历史重演）。
 *
 * 属于窗口 G（阶段 7：测试运行器 + 发布链路），由 A3 建立；A1/A2/A4 的产出
 * （types / assert / discover / bundle）在此一并转出。
 */

// A1：公共类型 + 内置断言库源码
export * from "./types.js";
export { LUA_ASSERT_LIBRARY } from "./assert.js";

// A2：测试文件发现
export {
  DEFAULT_TARGET_GUID,
  DEFAULT_TEST_GLOB,
  DEFAULT_TIMEOUT_MS,
  discoverTests,
  type DiscoverTestsOptions,
} from "./discover.js";

// A4：多文件 Lua 打包
export { bundleTests, type BundleOptions, type BundleResult } from "./bundle.js";

// A3：执行引擎 + 报告格式化
export { TestRunner, synthesizeBundleEntry } from "./runner.js";
export { formatConsole, toJson, type ConsoleFormatOptions } from "./reporter.js";
