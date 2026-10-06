// src/test/reporter.ts
/**
 * 阶段 7 测试运行器：运行报告格式化（控制台 + JSON）。
 *
 * 属于窗口 G（阶段 7：测试运行器 + 发布链路），由 A3 产出。
 * 输入是 runner（同目录 runner.ts）产出的 {@link RunReport}，本模块纯函数、无副作用：
 *
 * - {@link formatConsole}：中文控制台输出。opts.color=false 时完全不输出 ANSI 码
 *   （坑 16 防御：本模块保证 color=false 的输出可直接被 regex 解析；调用方解析
 *   color=true 的输出前仍应先去 ANSI 码 /\u001b\[[0-9;]*m/g）。
 * - {@link toJson}：`JSON.stringify(report, null, 2)`，用于 --json 落盘与 MCP 返回。
 *
 * 颜色约定：通过绿色、失败红色、错误黄色、信息（标题/分隔线/提示）灰色。
 */

import type { RunReport, TestResult } from "./types.js";

/** {@link formatConsole} 的可选参数 */
export interface ConsoleFormatOptions {
  /** 是否启用 ANSI 颜色（默认 true；单测 / 管道场景请显式传 false） */
  color?: boolean;
  /** 是否显示每个用例的 print 输出（默认 false） */
  verbose?: boolean;
}

/** ANSI 前景色码（color=true 时使用） */
const COLOR_CODES = {
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  gray: "\u001b[90m",
} as const;

/** ANSI 复位码 */
const RESET = "\u001b[0m";

type ColorName = keyof typeof COLOR_CODES;

/**
 * 把一条 failed/error 用例渲染成输出行（✗ 标题行 + 详情行）。
 *
 * - failed：逐条列出未通过的断言（含失败位置）；没有断言记录时回退 failureReason；
 * - error：渲染 `运行时错误: <failureReason>`。
 */
function renderCase(r: TestResult, paint: (color: ColorName, text: string) => string): string[] {
  const lines: string[] = [];
  const statusColor: ColorName = r.status === "failed" ? "red" : "yellow";
  lines.push(paint(statusColor, `✗ ${r.case.name} (${r.case.sourceFile}:${r.case.sourceLine})`));
  if (r.status === "failed") {
    const failedAsserts = r.asserts.filter((a) => !a.passed);
    if (failedAsserts.length > 0) {
      for (const a of failedAsserts) {
        const where =
          a.sourceFile !== undefined ? ` (${a.sourceFile}:${a.sourceLine ?? 0})` : "";
        lines.push(paint("red", `  断言失败: ${a.message ?? a.kind}${where}`));
      }
    } else {
      lines.push(paint("red", `  断言失败: ${r.failureReason ?? "（未提供失败信息）"}`));
    }
  } else {
    lines.push(paint("yellow", `  运行时错误: ${r.failureReason ?? "（未提供错误信息）"}`));
  }
  return lines;
}

/**
 * 把一次测试运行格式化为控制台输出（中文）。
 *
 * 结构：报告头（运行 ID / 工作区 / 开始 / 耗时）→ 结果统计 → [失败详情] →
 * [错误详情] → 总结。失败/错误为 0 时省略对应详情段。
 *
 * @param report runner 产出的运行报告
 * @param opts color 缺省 true；verbose 缺省 false
 * @returns 多行字符串（color=false 时不含任何 ANSI 码）
 */
export function formatConsole(report: RunReport, opts: ConsoleFormatOptions = {}): string {
  const useColor = opts.color ?? true;
  const verbose = opts.verbose ?? false;
  const paint = (color: ColorName, text: string): string =>
    useColor ? `${COLOR_CODES[color]}${text}${RESET}` : text;

  const lines: string[] = [];
  lines.push("测试运行报告");
  lines.push("═".repeat(15));
  lines.push(`运行 ID: ${report.runId}`);
  lines.push(`工作区: ${report.root}`);
  lines.push(`开始: ${report.startedAt}`);
  lines.push(`耗时: ${report.durationMs}ms`);
  lines.push("");
  lines.push("结果统计");
  lines.push("─".repeat(8));
  lines.push(`通过: ${paint("green", `${report.passed}/${report.total}`)}`);
  lines.push(`失败: ${paint("red", String(report.failed))}`);
  lines.push(`错误: ${paint("yellow", String(report.errored))}`);
  if (report.bailed) {
    lines.push(paint("gray", "已提前终止（--bail：出现失败后停止运行后续文件）"));
  }

  const failedResults = report.results.filter((r) => r.status === "failed");
  const erroredResults = report.results.filter((r) => r.status === "error");

  if (failedResults.length > 0) {
    lines.push("");
    lines.push(paint("gray", "[失败详情]"));
    for (const r of failedResults) {
      lines.push(...renderCase(r, paint));
    }
  }
  if (erroredResults.length > 0) {
    lines.push("");
    lines.push(paint("gray", "[错误详情]"));
    for (const r of erroredResults) {
      lines.push(...renderCase(r, paint));
    }
  }

  // verbose：独立列出所有带 print 输出的用例（含通过用例——它们不进失败/错误详情段）
  if (verbose) {
    const withPrints = report.results.filter((r) => r.prints.length > 0);
    if (withPrints.length > 0) {
      lines.push("");
      lines.push(paint("gray", "[print 输出]"));
      for (const r of withPrints) {
        const head =
          r.status === "passed"
            ? paint("green", `✓ ${r.case.name} (${r.case.sourceFile}:${r.case.sourceLine})`)
            : paint(r.status === "failed" ? "red" : "yellow", `✗ ${r.case.name} (${r.case.sourceFile}:${r.case.sourceLine})`);
        lines.push(head);
        for (const p of r.prints) {
          lines.push(paint("gray", `    | ${p}`));
        }
      }
    }
  }

  lines.push("");
  lines.push(`总结: 通过 ${report.passed} / 失败 ${report.failed} / 错误 ${report.errored}`);
  return lines.join("\n");
}

/**
 * 把运行报告序列化为格式化 JSON（两空格缩进），用于 --json 落盘与 MCP 返回。
 *
 * @param report runner 产出的运行报告
 * @returns 合法 JSON 字符串（JSON.parse 后与 report 深度相等）
 */
export function toJson(report: RunReport): string {
  return JSON.stringify(report, null, 2);
}
