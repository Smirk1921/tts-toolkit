// tests/unit/mcp-test-run.test.ts
/**
 * src/mcp/tools/test-run.ts（MCP 工具 `tts_test_run`）单元测试。
 *
 * 覆盖场景（对应任务 C2 清单第 7 条）：
 * - 工具注册名 `tts_test_run`，title / description 是非空字符串（经 t() 生成；
 *   locales 键由 Stage C 补，缺键时 t() 原样输出键名，仍是非空字符串）；
 * - inputSchema zod 校验：root 必填，targetGuid / timeoutMs / bail / bundle 可选
 *   且类型受限（timeoutMs 必须正整数）；
 * - 成功路径：参数逐项透传给 `client.testRun`（可选字段缺省时**不出现**在实参里，
 *   缺省语义全交给 hub 侧），控制通道返回的 RunReport JSON 原样进 structuredContent
 *   与 content[0].text；
 * - 失败路径：serializeError 三分支（HubNotRunningError / HubError / 普通 Error）
 *   统一为 `{error:{code,message,details?}}` 且 `isError:true`；
 * - 契约锚点（坑 21 四方同步）：文件头注释必须提及对应 hub 路由
 *   `POST /v1/test/run`——control.ts / client.ts / tools/*.ts / hub-control.md 同批改。
 *
 * fake McpServer / fake HubClient 均为结构化替身（不 mock 模块），与
 * tests/unit/mcp-tools.test.ts 同款。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { HubError, HubNotRunningError, type HubClient } from '../../src/mcp/client.js';
import { register as registerTestRun } from '../../src/mcp/tools/test-run.js';

/** fake server 捕获到的一条工具注册 */
interface RegisteredTool {
  name: string;
  config: {
    title?: unknown;
    description?: unknown;
    inputSchema?: unknown;
  };
  callback: (args: unknown, extra: unknown) => Promise<unknown>;
}

/** 工具回调的返回结构（MCP CallToolResult 子集） */
interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** 任务书钉住的 RunReport 样例（结构即 src/test/types.ts 的 RunReport） */
const RUN_REPORT = {
  runId: 'md4k2p1a-deadbeef',
  root: 'D:/packs/第七大陆',
  startedAt: '2026-10-06T00:00:00.000Z',
  endedAt: '2026-10-06T00:00:01.234Z',
  durationMs: 1234,
  total: 2,
  passed: 1,
  failed: 1,
  errored: 0,
  bailed: false,
  results: [
    {
      case: { name: '切片网格', sourceFile: 'tests/deck.test.lua', sourceLine: 3 },
      status: 'passed',
      asserts: [{ kind: 'assert_eq', passed: true }],
      durationMs: 12,
      prints: ['hello'],
    },
    {
      case: { name: '素材 URL', sourceFile: 'tests/deck.test.lua', sourceLine: 9 },
      status: 'failed',
      failureReason: 'assert_eq 失败：期望 2，实际 3',
      asserts: [
        { kind: 'assert_eq', passed: false, message: '期望 2，实际 3', sourceFile: 'tests/deck.test.lua', sourceLine: 10 },
      ],
      durationMs: 8,
      prints: [],
    },
  ],
};

/** 工具源文件路径（文件头注释的契约锚点断言用） */
const TOOL_SOURCE = fileURLToPath(new URL('../../src/mcp/tools/test-run.ts', import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 构造 fake McpServer：捕获 registerTool 的名称 / 配置 / 回调。
 * @returns server（可直接传给 register）与工具注册表
 */
function captureTools(): { server: McpServer; tools: Map<string, RegisteredTool> } {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (
      name: string,
      config: RegisteredTool['config'],
      callback: RegisteredTool['callback'],
    ) => {
      tools.set(name, { name, config, callback });
    },
  } as unknown as McpServer;
  return { server, tools };
}

/**
 * 构造 fake HubClient：本工具只用到 testRun，其余方法不提供。
 * @returns stub（testRun 的 vi.fn 引用）与可传给 register 的 client
 */
function makeClientStub(): { stub: { testRun: ReturnType<typeof vi.fn> }; client: HubClient } {
  const stub = { testRun: vi.fn() };
  return { stub, client: stub as unknown as HubClient };
}

/** 注册工具并返回唯一的那一条（名字不对就直接失败） */
function registerTool(): { tool: RegisteredTool; stub: { testRun: ReturnType<typeof vi.fn> } } {
  const { server, tools } = captureTools();
  const { stub, client } = makeClientStub();
  registerTestRun(server, client);
  const tool = tools.get('tts_test_run');
  if (tool === undefined) {
    throw new Error('tts_test_run 未注册');
  }
  return { tool, stub };
}

/** inputSchema 的 safeParse 结果 */
function parseInput(tool: RegisteredTool, args: unknown): boolean {
  const schema = tool.config.inputSchema as z.ZodType;
  return schema.safeParse(args).success;
}

/** 直接调用工具回调并断言返回结构（MCP CallToolResult 子集） */
async function callTool(tool: RegisteredTool, args: unknown): Promise<ToolResult> {
  return (await tool.callback(args, {})) as ToolResult;
}

describe('tts_test_run：注册与元信息', () => {
  it('注册名为 tts_test_run，title / description 非空（经 t()）', () => {
    const { server, tools } = captureTools();
    const { client } = makeClientStub();
    registerTestRun(server, client);

    const tool = tools.get('tts_test_run');
    expect(tool).toBeDefined();
    expect([...tools.keys()]).toEqual(['tts_test_run']);
    expect(typeof tool?.config.title).toBe('string');
    expect(String(tool?.config.title).length).toBeGreaterThan(0);
    expect(typeof tool?.config.description).toBe('string');
    expect(String(tool?.config.description).length).toBeGreaterThan(0);
  });
});

describe('tts_test_run：inputSchema zod 校验', () => {
  it('缺 root 被拒绝；只给 root 合法', () => {
    const { tool } = registerTool();
    expect(parseInput(tool, {})).toBe(false);
    expect(parseInput(tool, { root: '' })).toBe(true); // 空串是 zod 层的合法 string，hub 侧才判空白
    expect(parseInput(tool, { root: 'D:/packs/第七大陆' })).toBe(true);
    expect(parseInput(tool, null)).toBe(false);
    expect(parseInput(tool, 'D:/packs')).toBe(false);
    expect(parseInput(tool, { root: 1 })).toBe(false);
  });

  it('可选字段类型受限：timeoutMs 必须正整数，targetGuid / bail / bundle 类型固定', () => {
    const { tool } = registerTool();
    const root = 'D:/packs/第七大陆';
    expect(parseInput(tool, { root, targetGuid: '-1', timeoutMs: 1000, bail: true, bundle: false })).toBe(true);
    expect(parseInput(tool, { root, timeoutMs: 0 })).toBe(false);
    expect(parseInput(tool, { root, timeoutMs: -5 })).toBe(false);
    expect(parseInput(tool, { root, timeoutMs: 1.5 })).toBe(false);
    expect(parseInput(tool, { root, timeoutMs: '1000' })).toBe(false);
    expect(parseInput(tool, { root, targetGuid: 1 })).toBe(false);
    expect(parseInput(tool, { root, bail: 'yes' })).toBe(false);
    expect(parseInput(tool, { root, bundle: 0 })).toBe(false);
  });
});

describe('tts_test_run：调用 client.testRun', () => {
  it('全字段逐项透传（一次调用、实参完全等于入参）', async () => {
    const { tool, stub } = registerTool();
    stub.testRun.mockResolvedValue(RUN_REPORT);

    const args = {
      root: 'D:/packs/第七大陆',
      targetGuid: '-1',
      timeoutMs: 60000,
      bail: true,
      bundle: false,
    };
    await callTool(tool, args);

    expect(stub.testRun).toHaveBeenCalledTimes(1);
    expect(stub.testRun).toHaveBeenCalledWith(args);
  });

  it('可选字段缺省时不出现在实参里（缺省语义交给 hub 侧）', async () => {
    const { tool, stub } = registerTool();
    stub.testRun.mockResolvedValue(RUN_REPORT);

    await callTool(tool, { root: 'D:/packs/第七大陆' });

    expect(stub.testRun).toHaveBeenCalledWith({ root: 'D:/packs/第七大陆' });
    const passed = stub.testRun.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(passed)).toEqual(['root']);
  });
});

describe('tts_test_run：RunReport 返回值', () => {
  it('structuredContent 与 content[0].text 都是控制通道返回的 RunReport', async () => {
    const { tool, stub } = registerTool();
    stub.testRun.mockResolvedValue(RUN_REPORT);

    const result = await callTool(tool, { root: 'D:/packs/第七大陆' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(RUN_REPORT);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(RUN_REPORT);
  });

  it('报告的关键字段齐备（total / passed / failed / errored / bailed / results）', async () => {
    const { tool, stub } = registerTool();
    stub.testRun.mockResolvedValue(RUN_REPORT);

    const result = await callTool(tool, { root: 'D:/packs/第七大陆' });
    const report = result.structuredContent as Record<string, unknown>;

    for (const key of ['runId', 'root', 'startedAt', 'endedAt', 'durationMs', 'total', 'passed', 'failed', 'errored', 'bailed', 'results']) {
      expect(report).toHaveProperty(key);
    }
    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(Array.isArray(report.results)).toBe(true);
    expect((report.results as Array<{ status: string }>).map((r) => r.status)).toEqual(['passed', 'failed']);
    // 失败用例必须带源文件与行号（unbundle 行号映射的产物）
    const failedCase = (report.results as Array<{ case: { sourceFile: string; sourceLine: number } }>)[1];
    expect(failedCase.case.sourceFile).toBe('tests/deck.test.lua');
    expect(failedCase.case.sourceLine).toBe(9);
  });

  it('没有测试文件（total=0 空报告）不是错误', async () => {
    const { tool, stub } = registerTool();
    const empty = { ...RUN_REPORT, total: 0, passed: 0, failed: 0, errored: 0, results: [] };
    stub.testRun.mockResolvedValue(empty);

    const result = await callTool(tool, { root: 'D:/packs/第七大陆' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(empty);
  });
});

describe('tts_test_run：错误经 serializeError 统一', () => {
  it('HubNotRunningError → HUB_NOT_RUNNING + isError:true', async () => {
    const { tool, stub } = registerTool();
    stub.testRun.mockRejectedValue(new HubNotRunningError('connection refused (127.0.0.1:39995)'));

    const result = await callTool(tool, { root: 'D:/packs/第七大陆' });
    const body = JSON.parse(result.content[0].text) as { error: { code: string; message: string } };

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(body.error.code).toBe('HUB_NOT_RUNNING');
    expect(body.error.message).toContain('127.0.0.1:39995');
  });

  it('HubError（400 HUB_PACK_ERROR）→ 透传 code / message / details.packCode', async () => {
    const { tool, stub } = registerTool();
    stub.testRun.mockRejectedValue(
      new HubError(400, 'HUB_PACK_ERROR', '打包测试文件失败：模块不可读', { packCode: 'TEST_RUN_BUNDLE_FAILED' }),
    );

    const result = await callTool(tool, { root: 'D:/packs/第七大陆' });
    const body = JSON.parse(result.content[0].text) as {
      error: { code: string; message: string; details?: { packCode?: string } };
    };

    expect(result.isError).toBe(true);
    expect(body.error.code).toBe('HUB_PACK_ERROR');
    expect(body.error.message).toBe('打包测试文件失败：模块不可读');
    expect(body.error.details?.packCode).toBe('TEST_RUN_BUNDLE_FAILED');
  });

  it('普通 Error → INTERNAL_ERROR', async () => {
    const { tool, stub } = registerTool();
    stub.testRun.mockRejectedValue(new Error('boom'));

    const result = await callTool(tool, { root: 'D:/packs/第七大陆' });
    const body = JSON.parse(result.content[0].text) as { error: { code: string; message: string } };

    expect(result.isError).toBe(true);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('boom');
  });
});

describe('tts_test_run：契约锚点（坑 21）', () => {
  it('文件头注释提及对应 hub 路由 POST /v1/test/run 与所属窗口 / 阶段', () => {
    const source = readFileSync(TOOL_SOURCE, 'utf8');

    expect(source).toContain('POST /v1/test/run');
    expect(source).toContain('tts_test_run');
    expect(source).toContain('阶段 7');
    // i18n 键必须在文件头声明（Stage C 补两套 locales 时以此为准）
    expect(source).toContain('mcp.tool.tts_test_run.title');
    expect(source).toContain('mcp.tool.tts_test_run.description');
  });
});
