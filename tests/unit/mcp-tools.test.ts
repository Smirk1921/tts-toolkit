// tests/unit/mcp-tools.test.ts
/**
 * src/mcp/tools/*.ts（10 个 MCP 工具）与 src/mcp/tools/errors.ts 单元测试。
 *
 * 覆盖场景（对应任务 C1 清单第 6 条）：
 * - 10 个工具全部注册且名字齐全（tts_status … tts_push）；
 * - 每个工具的 inputSchema zod 校验（合法 / 非法参数）；
 * - tts_push 的 confirm 必须是字面量 true（z.literal(true)）——传 false / 不传 /
 *   传字符串都被拒（与 hub 侧 HUB_CONFIRM_REQUIRED 门对齐）；
 * - 直接调用 register 注册的 callback（用 fake McpServer 捕获，不引
 *   InMemoryTransport）：成功路径 structuredContent 透传控制通道 JSON；失败路径
 *   isError:true + {error: serializeError(err)}；
 * - serializeError 各分支：HubNotRunningError / HubError / Error / 非 Error。
 *
 * fake McpServer / fake HubClient 均为结构化替身（不 mock 模块）：
 * HubClient 替身按 HubClient 的公开方法逐个以 vi.fn() 实现。
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { HubClient, HubError, HubNotRunningError } from '../../src/mcp/client.js';
import { register as registerAssets } from '../../src/mcp/tools/assets.js';
import { register as registerDeckPlan } from '../../src/mcp/tools/deck-plan.js';
import { register as registerDeckSlice } from '../../src/mcp/tools/deck-slice.js';
import { register as registerDiff } from '../../src/mcp/tools/diff.js';
import { register as registerExec } from '../../src/mcp/tools/exec.js';
import { register as registerImport } from '../../src/mcp/tools/import.js';
import { register as registerPackList } from '../../src/mcp/tools/pack-list.js';
import { register as registerPull } from '../../src/mcp/tools/pull.js';
import { register as registerPush } from '../../src/mcp/tools/push.js';
import { register as registerStatus } from '../../src/mcp/tools/status.js';
import { serializeError } from '../../src/mcp/tools/errors.js';

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

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 构造 fake McpServer：捕获 registerTool 的名称 / 配置 / 回调。
 * @returns server（可直接传给各 register）与 tools 注册表
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
 * 构造 fake HubClient：公开方法逐个 vi.fn()（返回值由测试逐个编排）。
 * @returns stub（保留各 vi.fn 的类型化引用）与可传给 register 的 client
 */
function makeClientStub(): { stub: Record<string, ReturnType<typeof vi.fn>>; client: HubClient } {
  const stub: Record<string, ReturnType<typeof vi.fn>> = {
    status: vi.fn(),
    pullScripts: vi.fn(),
    saveAndPlay: vi.fn(),
    exec: vi.fn(),
    assetsCheck: vi.fn(),
    listPacks: vi.fn(),
    deckSlice: vi.fn(),
    deckPlan: vi.fn(),
    importAssets: vi.fn(),
    diff: vi.fn(),
    push: vi.fn(),
    shutdown: vi.fn(),
  };
  return { stub, client: stub as unknown as HubClient };
}

/** 按名取工具；缺失即测试失败 */
function getTool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
  const tool = tools.get(name);
  if (tool === undefined) {
    throw new Error(`tool ${name} not registered`);
  }
  return tool;
}

/** inputSchema 的 safeParse 便捷封装 */
function parseInput(tool: RegisteredTool, args: unknown): { ok: boolean } {
  const schema = tool.config.inputSchema as z.ZodType;
  return { ok: schema.safeParse(args).success };
}

/** 直接调用工具回调并断言返回结构（MCP CallToolResult 子集） */
async function callTool(tool: RegisteredTool, args: unknown): Promise<ToolResult> {
  return (await tool.callback(args, {})) as ToolResult;
}

describe('工具注册：名字与元信息', () => {
  it('10 个工具全部注册且名字齐全', () => {
    const { server, tools } = captureTools();
    const { client } = makeClientStub();
    registerStatus(server, client);
    registerPull(server, client);
    registerExec(server, client);
    registerAssets(server, client);
    registerPackList(server, client);
    registerDeckSlice(server, client);
    registerDeckPlan(server, client);
    registerImport(server, client);
    registerDiff(server, client);
    registerPush(server, client);

    expect([...tools.keys()].sort()).toEqual(
      [
        'tts_status',
        'tts_pull',
        'tts_exec',
        'tts_assets',
        'tts_pack_list',
        'tts_deck_slice',
        'tts_deck_plan',
        'tts_import',
        'tts_diff',
        'tts_push',
      ].sort(),
    );
  });

  it('每个工具的 title / description 是非空字符串（经 t() 生成）', () => {
    const { server, tools } = captureTools();
    const { client } = makeClientStub();
    registerStatus(server, client);
    registerPull(server, client);
    registerExec(server, client);
    registerAssets(server, client);
    registerPackList(server, client);
    registerDeckSlice(server, client);
    registerDeckPlan(server, client);
    registerImport(server, client);
    registerDiff(server, client);
    registerPush(server, client);

    for (const tool of tools.values()) {
      expect(typeof tool.config.title).toBe('string');
      expect(tool.config.title?.toString().length).toBeGreaterThan(0);
      expect(typeof tool.config.description).toBe('string');
      expect(tool.config.description?.toString().length).toBeGreaterThan(0);
    }
  });
});

describe('inputSchema zod 校验', () => {
  // 每个工具的（合法, 非法）参数样例；工具名与 src/mcp/tools/*.ts 一一对应
  const suites: ReadonlyArray<{
    name: string;
    register: (server: McpServer, client: HubClient) => void;
    valid: unknown[];
    invalid: unknown[];
  }> = [
    {
      name: 'tts_status',
      register: registerStatus,
      valid: [{}],
      invalid: ['not-an-object', null],
    },
    {
      name: 'tts_pull',
      register: registerPull,
      valid: [{ root: 'D:\\pack' }],
      invalid: [{}, { root: 1 }],
    },
    {
      name: 'tts_exec',
      register: registerExec,
      valid: [
        { lua: '1+1' },
        { lua: '1+1', guid: 'abc', timeoutMs: 100 },
      ],
      invalid: [{}, { lua: 1 }, { lua: 'x', timeoutMs: 0 }, { lua: 'x', timeoutMs: -5 }, { lua: 'x', timeoutMs: 1.5 }],
    },
    {
      name: 'tts_assets',
      register: registerAssets,
      valid: [{ urls: ['u1'] }, { urls: ['u1'], timeoutMs: 100 }],
      invalid: [{}, { urls: [] }, { urls: 'u1' }, { urls: ['u1'], timeoutMs: 0 }],
    },
    {
      name: 'tts_pack_list',
      register: registerPackList,
      valid: [{}, { packsRoot: 'D:\\packs' }],
      invalid: [{ packsRoot: 5 }],
    },
    {
      name: 'tts_deck_slice',
      register: registerDeckSlice,
      valid: [
        { sheetPath: 's', savePath: 'v', outDir: 'o' },
        { sheetPath: 's', savePath: 'v', outDir: 'o', deckKey: 'k', deckGuid: 'g' },
      ],
      invalid: [{}, { sheetPath: 's', savePath: 'v' }, { sheetPath: 's', savePath: 'v', outDir: 'o', deckKey: 1 }],
    },
    {
      name: 'tts_deck_plan',
      register: registerDeckPlan,
      valid: [
        { savePath: 'p.json', rules: [] },
        { savePath: {}, rules: [] },
      ],
      invalid: [{}, { savePath: 5, rules: [] }, { savePath: 'p.json' }],
    },
    {
      name: 'tts_import',
      register: registerImport,
      valid: [
        { root: 'r', manifestPath: 'm' },
        { root: 'r', manifestPath: 'm', dryRun: true },
      ],
      invalid: [{}, { root: 'r' }, { root: 'r', manifestPath: 'm', dryRun: 'yes' }],
    },
    {
      name: 'tts_diff',
      register: registerDiff,
      valid: [{ root: 'D:\\pack' }],
      invalid: [{}, { root: 1 }],
    },
    {
      name: 'tts_push',
      register: registerPush,
      valid: [{ root: 'D:\\pack', confirm: true }],
      invalid: [
        { root: 'D:\\pack', confirm: false }, // 显式 false 必须被拒
        { root: 'D:\\pack' }, // 缺 confirm 必须被拒
        { root: 'D:\\pack', confirm: 'true' }, // 字符串 "true" 也必须被拒
        { confirm: true }, // 缺 root
      ],
    },
  ];

  for (const suite of suites) {
    describe(suite.name, () => {
      it('合法参数全部通过校验', () => {
        const { server, tools } = captureTools();
        const { client } = makeClientStub();
        suite.register(server, client);
        const tool = getTool(tools, suite.name);
        for (const args of suite.valid) {
          expect(parseInput(tool, args), JSON.stringify(args)).toEqual({ ok: true });
        }
      });

      it('非法参数全部被拒', () => {
        const { server, tools } = captureTools();
        const { client } = makeClientStub();
        suite.register(server, client);
        const tool = getTool(tools, suite.name);
        for (const args of suite.invalid) {
          expect(parseInput(tool, args), JSON.stringify(args)).toEqual({ ok: false });
        }
      });
    });
  }
});

describe('工具 callback（直接调用，不经 InMemoryTransport）', () => {
  it('tts_push 成功：confirm:true 透传给 client.push，structuredContent 原样返回', async () => {
    const { server, tools } = captureTools();
    const { stub, client } = makeClientStub();
    stub.push.mockResolvedValue({ ok: true, items: 3 });
    registerPush(server, client);

    const result = await callTool(getTool(tools, 'tts_push'), {
      root: 'D:\\pack',
      confirm: true,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true, items: 3 });
    expect(result.content[0]?.text).toBe(JSON.stringify({ ok: true, items: 3 }));
    expect(stub.push).toHaveBeenCalledOnce();
    expect(stub.push).toHaveBeenCalledWith('D:\\pack', true);
  });

  it('tts_push 失败（hub 未运行）：isError:true + HUB_NOT_RUNNING 错误体', async () => {
    const { server, tools } = captureTools();
    const { stub, client } = makeClientStub();
    stub.push.mockRejectedValue(new HubNotRunningError());
    registerPush(server, client);

    const result = await callTool(getTool(tools, 'tts_push'), {
      root: 'D:\\pack',
      confirm: true,
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text ?? '') as {
      error?: { code?: string };
    };
    expect(parsed.error?.code).toBe('HUB_NOT_RUNNING');
  });

  it('tts_status 成功：控制通道 JSON 原样进 structuredContent', async () => {
    const { server, tools } = captureTools();
    const { stub, client } = makeClientStub();
    stub.status.mockResolvedValue({
      ok: true,
      hub: { editor: true },
      tts: { connected: false },
    });
    registerStatus(server, client);

    const result = await callTool(getTool(tools, 'tts_status'), {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      ok: true,
      hub: { editor: true },
      tts: { connected: false },
    });
  });

  it('tts_exec 失败（HubError 协议错误）：错误体透传 code / details', async () => {
    const { server, tools } = captureTools();
    const { stub, client } = makeClientStub();
    stub.exec.mockRejectedValue(
      new HubError(400, 'HUB_LUA_ERROR', 'lua failed', { guid: 'abc', line: 3 }),
    );
    registerExec(server, client);

    const result = await callTool(getTool(tools, 'tts_exec'), { lua: 'error("x")' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text ?? '') as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    expect(parsed.error?.code).toBe('HUB_LUA_ERROR');
    expect(parsed.error?.message).toBe('lua failed');
    expect(parsed.error?.details).toEqual({ guid: 'abc', line: 3 });
  });

  it('tts_exec 成功：guid / timeoutMs 仅在提供时透传', async () => {
    const { server, tools } = captureTools();
    const { stub, client } = makeClientStub();
    stub.exec.mockResolvedValue({ result: 1 });
    registerExec(server, client);
    const tool = getTool(tools, 'tts_exec');

    await callTool(tool, { lua: '1+1' });
    expect(stub.exec).toHaveBeenCalledWith('1+1', {});
    await callTool(tool, { lua: '1+1', guid: 'g', timeoutMs: 10 });
    expect(stub.exec).toHaveBeenCalledWith('1+1', { guid: 'g', timeoutMs: 10 });
  });

  it('tts_pull / tts_diff：root 透传给对应 client 方法', async () => {
    const { server, tools } = captureTools();
    const { stub, client } = makeClientStub();
    stub.pullScripts.mockResolvedValue({ scripts: [] });
    stub.diff.mockResolvedValue({ changed: [] });
    registerPull(server, client);
    registerDiff(server, client);

    await callTool(getTool(tools, 'tts_pull'), { root: 'D:\\pack' });
    expect(stub.pullScripts).toHaveBeenCalledWith('D:\\pack');
    await callTool(getTool(tools, 'tts_diff'), { root: 'D:\\pack' });
    expect(stub.diff).toHaveBeenCalledWith('D:\\pack');
  });

  it('tts_deck_slice 失败（业务 PackError → HUB_PACK_ERROR）：details.packCode 透传', async () => {
    const { server, tools } = captureTools();
    const { stub, client } = makeClientStub();
    stub.deckSlice.mockRejectedValue(
      new HubError(400, 'HUB_PACK_ERROR', 'ambiguous', { packCode: 'SLICE_AMBIGUOUS' }),
    );
    registerDeckSlice(server, client);

    const result = await callTool(getTool(tools, 'tts_deck_slice'), {
      sheetPath: 's',
      savePath: 'v',
      outDir: 'o',
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text ?? '') as {
      error?: { code?: string; details?: { packCode?: string } };
    };
    expect(parsed.error?.code).toBe('HUB_PACK_ERROR');
    expect(parsed.error?.details?.packCode).toBe('SLICE_AMBIGUOUS');
  });

  it('tts_assets：urls / timeoutMs 透传给 client.assetsCheck', async () => {
    const { server, tools } = captureTools();
    const { stub, client } = makeClientStub();
    stub.assetsCheck.mockResolvedValue({ total: 1, alive: 1, dead: 0, deadUrls: [] });
    registerAssets(server, client);

    await callTool(getTool(tools, 'tts_assets'), { urls: ['u1'], timeoutMs: 250 });
    expect(stub.assetsCheck).toHaveBeenCalledWith(['u1'], 250);
  });
});

describe('serializeError：分支映射', () => {
  it('HubNotRunningError → HUB_NOT_RUNNING（先于 HubError 判断）', () => {
    const result = serializeError(new HubNotRunningError());
    expect(result.code).toBe('HUB_NOT_RUNNING');
    expect(typeof result.message).toBe('string');
  });

  it('HubError → 透传 code / message / details', () => {
    const err = new HubError(400, 'HUB_PACK_ERROR', 'bad pack', { packCode: 'PACK_INVALID' });
    const result = serializeError(err);
    expect(result).toEqual({
      code: 'HUB_PACK_ERROR',
      message: 'bad pack',
      details: { packCode: 'PACK_INVALID' },
    });
  });

  it('普通 Error → INTERNAL_ERROR', () => {
    const result = serializeError(new Error('file not found'));
    expect(result).toEqual({ code: 'INTERNAL_ERROR', message: 'file not found' });
  });

  it('非 Error 抛出值 → UNKNOWN（String 退化）', () => {
    const result = serializeError('plain string failure');
    expect(result).toEqual({ code: 'UNKNOWN', message: 'plain string failure' });
  });
});
