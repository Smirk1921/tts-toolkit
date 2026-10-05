// src/mcp/tools/pull.ts
/**
 * MCP 工具 `tts_pull`：把游戏内全部脚本拉取到图包工作区。
 *
 * 对应 hub 控制通道路由：`POST /v1/scripts/pull`（src/hub/control.ts →
 * pullFromGame）。返回值就是控制通道的 JSON 响应体（PullResult，结构化 JSON
 * 英文键名，不走 t()）；失败时 `isError: true`，错误体为
 * `{error:{code,message,details?}}`（见 errors.ts）。
 *
 * 本文件使用的 i18n 键：`mcp.tool.tts_pull.title`、`mcp.tool.tts_pull.description`。
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { HubClient } from "../client.js";
import { t } from "../../i18n/index.js";
import { serializeError } from "./errors.js";

/**
 * 注册 `tts_pull` 工具。
 *
 * @param server MCP 服务器实例
 * @param client hub 控制通道客户端
 */
export function register(server: McpServer, client: HubClient): void {
  server.registerTool(
    "tts_pull",
    {
      title: t("mcp.tool.tts_pull.title"),
      description: t("mcp.tool.tts_pull.description"),
      inputSchema: z.object({ root: z.string() }),
    },
    async (args) => {
      try {
        const result = await client.pullScripts(args.root);
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
