// src/mcp/tools/assets.ts
/**
 * MCP 工具 `tts_assets`：素材 URL 存活检测。
 *
 * 对应 hub 控制通道路由：`POST /v1/assets/check`（src/hub/control.ts →
 * checkUrls）。返回值是控制通道的 JSON 响应体（CheckSummary：total / alive /
 * dead / deadUrls / results，结构化 JSON 英文键名，不走 t()）；失败时
 * `isError: true`，错误体为 `{error:{code,message,details?}}`（见 errors.ts）。
 *
 * 本文件使用的 i18n 键：`mcp.tool.tts_assets.title`、`mcp.tool.tts_assets.description`。
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { HubClient } from "../client.js";
import { t } from "../../i18n/index.js";
import { serializeError } from "./errors.js";

/**
 * 注册 `tts_assets` 工具。
 *
 * @param server MCP 服务器实例
 * @param client hub 控制通道客户端
 */
export function register(server: McpServer, client: HubClient): void {
  server.registerTool(
    "tts_assets",
    {
      title: t("mcp.tool.tts_assets.title"),
      description: t("mcp.tool.tts_assets.description"),
      inputSchema: z.object({
        urls: z.array(z.string()).min(1),
        timeoutMs: z.number().int().positive().optional(),
      }),
    },
    async (args) => {
      try {
        const result = await client.assetsCheck(args.urls, args.timeoutMs);
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
