// src/mcp/tools/diff.ts
/**
 * MCP 工具 `tts_diff`：对比本地工作区与游戏内的脚本差异。
 *
 * 对应 hub 控制通道路由：`POST /v1/diff`（src/hub/control.ts → diffWorkspace）。
 * 返回值是控制通道的 JSON 响应体（DiffResult，结构化 JSON 英文键名，不走 t()）；
 * 失败时 `isError: true`，错误体为 `{error:{code,message,details?}}`
 * （业务错误 PackError → `HUB_PACK_ERROR`，details.packCode 透传业务码；
 * 见 errors.ts）。
 *
 * 本文件使用的 i18n 键：`mcp.tool.tts_diff.title`、`mcp.tool.tts_diff.description`。
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { HubClient } from "../client.js";
import { t } from "../../i18n/index.js";
import { serializeError } from "./errors.js";

/**
 * 注册 `tts_diff` 工具。
 *
 * @param server MCP 服务器实例
 * @param client hub 控制通道客户端
 */
export function register(server: McpServer, client: HubClient): void {
  server.registerTool(
    "tts_diff",
    {
      title: t("mcp.tool.tts_diff.title"),
      description: t("mcp.tool.tts_diff.description"),
      inputSchema: z.object({ root: z.string() }),
    },
    async (args) => {
      try {
        const result = await client.diff(args.root);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: serializeError(err) }) }],
          isError: true,
        };
      }
    },
  );
}
