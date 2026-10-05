// src/mcp/tools/pack-list.ts
/**
 * MCP 工具 `tts_pack_list`：列出注册表中的图包。
 *
 * 对应 hub 控制通道路由：`GET /v1/packs`（src/hub/control.ts → readRegistry）。
 * 返回值就是注册表 JSON（`{schema_version, packs:[...]}`；.registry.yaml 不存在
 * 时 hub 侧容错返回空表，不视为错误）。结构化 JSON 英文键名，不走 t()；失败时
 * `isError: true`，错误体为 `{error:{code,message,details?}}`（见 errors.ts）。
 *
 * 本文件使用的 i18n 键：`mcp.tool.tts_pack_list.title`、
 * `mcp.tool.tts_pack_list.description`。
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { HubClient } from "../client.js";
import { t } from "../../i18n/index.js";
import { serializeError } from "./errors.js";

/**
 * 注册 `tts_pack_list` 工具。
 *
 * @param server MCP 服务器实例
 * @param client hub 控制通道客户端
 */
export function register(server: McpServer, client: HubClient): void {
  server.registerTool(
    "tts_pack_list",
    {
      title: t("mcp.tool.tts_pack_list.title"),
      description: t("mcp.tool.tts_pack_list.description"),
      inputSchema: z.object({
        packsRoot: z.string().optional(),
      }),
    },
    async (args) => {
      try {
        const result = await client.listPacks(args.packsRoot);
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
