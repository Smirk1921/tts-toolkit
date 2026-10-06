// tests/unit/mcp-pack-build.test.ts
/**
 * src/mcp/tools/pack-build.ts（MCP 工具 `tts_pack_build`）单元测试。
 *
 * 覆盖场景（对应任务 C2 清单第 8 条）：
 * - 工具注册名 `tts_pack_build`，title / description 是非空字符串（经 t() 生成）；
 * - inputSchema zod 校验：root 必填，outPath string 可选、dryRun boolean 可选；
 * - 成功路径：参数逐项透传给 `client.packBuild`（可选字段缺省时不出现），
 *   `BsonBuildResult` JSON 原样进 structuredContent 与 content[0].text；
 * - 失败路径：serializeError（HubError → 透传 code / details.packCode；
 *   HubNotRunningError → HUB_NOT_RUNNING）；
 * - 契约锚点（坑 21 四方同步）：文件头注释必须提及对应 hub 路由
 *   `POST /v1/pack/build`。
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
import { register as registerPackBuild } from '../../src/mcp/tools/pack-build.js';

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

/** 任务书钉住的响应样例：BsonBuildResult 三字段 + hub 路由附加的诊断字段 */
const BUILD_RESULT = {
  outPath: 'D:/packs/第七大陆/dist/第七大陆.bson',
  byteLength: 4096,
  headerLength: 4096,
  dryRun: false,
  jsonPath: 'D:/packs/第七大陆/dist/第七大陆.json',
  warnings: [],
  scriptsReplaced: 2,
  uiReplaced: 1,
  objectsReplaced: 3,
  decksPatched: 1,
};

/** 工具源文件路径（文件头注释的契约锚点断言用） */
const TOOL_SOURCE = fileURLToPath(new URL('../../src/mcp/tools/pack-build.ts', import.meta.url));

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
 * 构造 fake HubClient：本工具只用到 packBuild，其余方法不提供。
 * @returns stub（packBuild 的 vi.fn 引用）与可传给 register 的 client
 */
function makeClientStub(): { stub: { packBuild: ReturnType<typeof vi.fn> }; client: HubClient } {
  const stub = { packBuild: vi.fn() };
  return { stub, client: stub as unknown as HubClient };
}

/** 注册工具并返回唯一的那一条（名字不对就直接失败） */
function registerTool(): { tool: RegisteredTool; stub: { packBuild: ReturnType<typeof vi.fn> } } {
  const { server, tools } = captureTools();
  const { stub, client } = makeClientStub();
  registerPackBuild(server, client);
  const tool = tools.get('tts_pack_build');
  if (tool === undefined) {
    throw new Error('tts_pack_build 未注册');
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

describe('tts_pack_build：注册与元信息', () => {
  it('注册名为 tts_pack_build，title / description 非空（经 t()）', () => {
    const { server, tools } = captureTools();
    const { client } = makeClientStub();
    registerPackBuild(server, client);

    const tool = tools.get('tts_pack_build');
    expect(tool).toBeDefined();
    expect([...tools.keys()]).toEqual(['tts_pack_build']);
    expect(typeof tool?.config.title).toBe('string');
    expect(String(tool?.config.title).length).toBeGreaterThan(0);
    expect(typeof tool?.config.description).toBe('string');
    expect(String(tool?.config.description).length).toBeGreaterThan(0);
  });
});

describe('tts_pack_build：inputSchema zod 校验', () => {
  it('缺 root 被拒绝；只给 root 合法', () => {
    const { tool } = registerTool();
    expect(parseInput(tool, {})).toBe(false);
    expect(parseInput(tool, { root: 'D:/packs/第七大陆' })).toBe(true);
    expect(parseInput(tool, null)).toBe(false);
    expect(parseInput(tool, ['D:/packs'])).toBe(false);
    expect(parseInput(tool, { root: 1 })).toBe(false);
  });

  it('可选字段类型受限：outPath 必须字符串，dryRun 必须布尔', () => {
    const { tool } = registerTool();
    const root = 'D:/packs/第七大陆';
    expect(parseInput(tool, { root, outPath: 'D:/out/pack.bson', dryRun: true })).toBe(true);
    expect(parseInput(tool, { root, dryRun: false })).toBe(true);
    expect(parseInput(tool, { root, outPath: 1 })).toBe(false);
    expect(parseInput(tool, { root, dryRun: 'yes' })).toBe(false);
    expect(parseInput(tool, { root, dryRun: 1 })).toBe(false);
  });
});

describe('tts_pack_build：调用 client.packBuild', () => {
  it('全字段逐项透传（一次调用、实参完全等于入参）', async () => {
    const { tool, stub } = registerTool();
    stub.packBuild.mockResolvedValue(BUILD_RESULT);

    const args = { root: 'D:/packs/第七大陆', outPath: 'D:/out/pack.bson', dryRun: true };
    await callTool(tool, args);

    expect(stub.packBuild).toHaveBeenCalledTimes(1);
    expect(stub.packBuild).toHaveBeenCalledWith(args);
  });

  it('可选字段缺省时不出现在实参里（缺省语义交给 hub 侧）', async () => {
    const { tool, stub } = registerTool();
    stub.packBuild.mockResolvedValue(BUILD_RESULT);

    await callTool(tool, { root: 'D:/packs/第七大陆' });

    expect(stub.packBuild).toHaveBeenCalledWith({ root: 'D:/packs/第七大陆' });
    const passed = stub.packBuild.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(passed)).toEqual(['root']);
  });
});

describe('tts_pack_build：BsonBuildResult 返回值', () => {
  it('structuredContent 与 content[0].text 都是控制通道返回的 JSON', async () => {
    const { tool, stub } = registerTool();
    stub.packBuild.mockResolvedValue(BUILD_RESULT);

    const result = await callTool(tool, { root: 'D:/packs/第七大陆' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(BUILD_RESULT);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(BUILD_RESULT);
  });

  it('BsonBuildResult 三字段齐备且自检口径成立（headerLength === byteLength）', async () => {
    const { tool, stub } = registerTool();
    stub.packBuild.mockResolvedValue(BUILD_RESULT);

    const result = await callTool(tool, { root: 'D:/packs/第七大陆' });
    const payload = result.structuredContent as {
      outPath: string;
      byteLength: number;
      headerLength: number;
      dryRun: boolean;
      jsonPath: string;
      warnings: string[];
    };

    expect(typeof payload.outPath).toBe('string');
    expect(payload.outPath.endsWith('.bson')).toBe(true);
    expect(typeof payload.byteLength).toBe('number');
    expect(typeof payload.headerLength).toBe('number');
    // src/publish/bson.ts 的自检口径：前 4 字节小端整数 == 文件大小
    expect(payload.headerLength).toBe(payload.byteLength);
    expect(payload.dryRun).toBe(false);
    expect(payload.jsonPath.endsWith('.json')).toBe(true);
    expect(Array.isArray(payload.warnings)).toBe(true);
  });

  it('dryRun 响应不做虚报（byteLength / headerLength 为 0）也能透传', async () => {
    const { tool, stub } = registerTool();
    const dry = { ...BUILD_RESULT, dryRun: true, byteLength: 0, headerLength: 0 };
    stub.packBuild.mockResolvedValue(dry);

    const result = await callTool(tool, { root: 'D:/packs/第七大陆', dryRun: true });
    const payload = result.structuredContent as { byteLength: number; headerLength: number; dryRun: boolean };

    expect(result.isError).toBeUndefined();
    expect(payload.dryRun).toBe(true);
    expect(payload.byteLength).toBe(0);
    expect(payload.headerLength).toBe(0);
  });
});

describe('tts_pack_build：错误经 serializeError 统一', () => {
  it('HubNotRunningError → HUB_NOT_RUNNING + isError:true', async () => {
    const { tool, stub } = registerTool();
    stub.packBuild.mockRejectedValue(new HubNotRunningError('connection refused (127.0.0.1:39995)'));

    const result = await callTool(tool, { root: 'D:/packs/第七大陆' });
    const body = JSON.parse(result.content[0].text) as { error: { code: string; message: string } };

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(body.error.code).toBe('HUB_NOT_RUNNING');
    expect(body.error.message).toContain('127.0.0.1:39995');
  });

  it('HubError（400 HUB_PACK_ERROR）→ 透传 code / message / details.packCode', async () => {
    const { tool, stub } = registerTool();
    stub.packBuild.mockRejectedValue(
      new HubError(400, 'HUB_PACK_ERROR', '骨架存档不存在', { packCode: 'SKELETON_MISSING' }),
    );

    const result = await callTool(tool, { root: 'D:/packs/第七大陆' });
    const body = JSON.parse(result.content[0].text) as {
      error: { code: string; message: string; details?: { packCode?: string } };
    };

    expect(result.isError).toBe(true);
    expect(body.error.code).toBe('HUB_PACK_ERROR');
    expect(body.error.message).toBe('骨架存档不存在');
    expect(body.error.details?.packCode).toBe('SKELETON_MISSING');
  });

  it('普通 Error → INTERNAL_ERROR', async () => {
    const { tool, stub } = registerTool();
    stub.packBuild.mockRejectedValue(new Error('disk full'));

    const result = await callTool(tool, { root: 'D:/packs/第七大陆' });
    const body = JSON.parse(result.content[0].text) as { error: { code: string; message: string } };

    expect(result.isError).toBe(true);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('disk full');
  });
});

describe('tts_pack_build：契约锚点（坑 21）', () => {
  it('文件头注释提及对应 hub 路由 POST /v1/pack/build 与所属窗口 / 阶段', () => {
    const source = readFileSync(TOOL_SOURCE, 'utf8');

    expect(source).toContain('POST /v1/pack/build');
    expect(source).toContain('tts_pack_build');
    expect(source).toContain('阶段 7');
    // i18n 键必须在文件头声明（Stage C 补两套 locales 时以此为准）
    expect(source).toContain('mcp.tool.tts_pack_build.title');
    expect(source).toContain('mcp.tool.tts_pack_build.description');
  });
});
