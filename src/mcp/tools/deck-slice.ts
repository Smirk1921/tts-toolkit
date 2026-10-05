// src/mcp/tools/deck-slice.ts
/**
 * MCP 工具 `tts_deck_slice`：把牌堆图集按网格切片成单卡图。
 *
 * 对应 hub 控制通道路由：`POST /v1/deck/slice`（src/hub/control.ts →
 * sliceAtlas）。body 就是 SliceOptions 本身（sheetPath / savePath / outDir 必填，
 * deckKey / deckGuid 可选；不注入 selectCandidate——HTTP 场景无交互，多候选时
 * hub 侧抛 SLICE_AMBIGUOUS，调用方应先用 deckKey / deckGuid 消歧后重试）。
 *
 * 返回值是控制通道的 JSON 响应体（SliceResult，结构化 JSON 英文键名，不走 t()）；
 * 失败时 `isError: true`，错误体为 `{error:{code,message,details?}}`
 * （业务错误 PackError → `HUB_PACK_ERROR`，details.packCode 透传业务码）。
 *
 * 本文件使用的 i18n 键：`mcp.tool.tts_deck_slice.title`、
 * `mcp.tool.tts_deck_slice.description`。
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { HubClient } from "../client.js";
import { t } from "../../i18n/index.js";
import { serializeError } from "./errors.js";

/**
 * 注册 `tts_deck_slice` 工具。
 *
 * @param server MCP 服务器实例
 * @param client hub 控制通道客户端
 */
export function register(server: McpServer, client: HubClient): void {
  server.registerTool(
    "tts_deck_slice",
    {
      title: t("mcp.tool.tts_deck_slice.title"),
      description: t("mcp.tool.tts_deck_slice.description"),
      inputSchema: z.object({
        sheetPath: z.string(),
        savePath: z.string(),
        outDir: z.string(),
        deckKey: z.string().optional(),
        deckGuid: z.string().optional(),
      }),
    },
    async (args) => {
      try {
        const result = await client.deckSlice(args);
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
