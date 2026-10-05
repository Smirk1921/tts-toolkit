// src/mcp/tools/status.ts
/**
 * MCP 工具 `tts_status`：查询 hub 健康 + TTS 连接状态。
 *
 * 对应 hub 控制通道路由：`GET /v1/status`（src/hub/control.ts）。返回值就是
 * 控制通道的 JSON 响应体（`{ok, hub:{...}, tts:{connected, version?, objects?}}`，
 * 结构化 JSON 英文键名，不走 t()）；失败时 `isError: true`，错误体为
 * `{error:{code,message,details?}}`（见 errors.ts）。
 *
 * 本文件使用的 i18n 键：`mcp.tool.tts_status.title`、`mcp.tool.tts_status.description`。
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { HubClient } from "../client.js";
import { t } from "../../i18n/index.js";
import { serializeError } from "./errors.js";

/**
 * 注册 `tts_status` 工具（无入参）。
 *
 * @param server MCP 服务器实例
 * @param client hub 控制通道客户端
 */
export function register(server: McpServer, client: HubClient): void {
  server.registerTool(
    "tts_status",
    {
      title: t("mcp.tool.tts_status.title"),
      description: t("mcp.tool.tts_status.description"),
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const result = await client.status();
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
