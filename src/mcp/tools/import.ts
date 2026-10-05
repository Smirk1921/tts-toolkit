// src/mcp/tools/import.ts
/**
 * MCP 工具 `tts_import`：按 import.yaml 把素材导入图包工作区。
 *
 * 对应 hub 控制通道路由：`POST /v1/import`（src/hub/control.ts → importAssets）。
 * 返回值是控制通道的 JSON 响应体（ImportResult，结构化 JSON 英文键名，不走
 * t()）；dryRun 为 true 时只做校验与清单计算，不写文件。失败时 `isError: true`，
 * 错误体为 `{error:{code,message,details?}}`（业务错误 PackError →
 * `HUB_PACK_ERROR`，details.packCode 透传业务码；见 errors.ts）。
 *
 * 本文件使用的 i18n 键：`mcp.tool.tts_import.title`、
 * `mcp.tool.tts_import.description`。
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { HubClient } from "../client.js";
import { t } from "../../i18n/index.js";
import { serializeError } from "./errors.js";

/**
 * 注册 `tts_import` 工具。
 *
 * @param server MCP 服务器实例
 * @param client hub 控制通道客户端
 */
export function register(server: McpServer, client: HubClient): void {
  server.registerTool(
    "tts_import",
    {
      title: t("mcp.tool.tts_import.title"),
      description: t("mcp.tool.tts_import.description"),
      inputSchema: z.object({
        root: z.string(),
        manifestPath: z.string(),
        dryRun: z.boolean().optional(),
      }),
    },
    async (args) => {
      try {
        const result = await client.importAssets(args.root, args.manifestPath, args.dryRun);
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
