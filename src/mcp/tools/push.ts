// src/mcp/tools/push.ts
/**
 * MCP 工具 `tts_push`：把本地工作区的脚本写回游戏并重载（危险操作）。
 *
 * 对应 hub 控制通道路由：`POST /v1/push`（src/hub/control.ts →
 * collectPushItems + saveAndPlay）。确认门在 hub 侧：body.confirm 不严格等于
 * true 时返回 400 `HUB_CONFIRM_REQUIRED`；本工具的 inputSchema 用
 * `confirm: z.literal(true)` 在调用侧就挡掉无确认的调用（模型必须显式传
 * confirm: true 才能触发写回），两层防线一致。
 *
 * 返回值是控制通道的 JSON 响应体（`{ok:true, dryRun, pushed, skipped,
 * backupDir?, baselineConflicts?, assetChanges?, items}`——`items` 是
 * `pushed + skipped` 的向后兼容别名；结构化 JSON 英文键名，不走 t()）；失败时
 * `isError: true`，错误体为 `{error:{code,message,details?}}`（见 errors.ts）。
 * 注意写回语义：scriptStates 缺 script / ui 字段时 TTS 会删除对应内容
 * （协议语义，见 src/session/scripts.ts）。
 *
 * 本文件使用的 i18n 键：`mcp.tool.tts_push.title`、`mcp.tool.tts_push.description`。
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { HubClient } from "../client.js";
import { t } from "../../i18n/index.js";
import { serializeError } from "./errors.js";

/**
 * 注册 `tts_push` 工具。
 *
 * @param server MCP 服务器实例
 * @param client hub 控制通道客户端
 */
export function register(server: McpServer, client: HubClient): void {
  server.registerTool(
    "tts_push",
    {
      title: t("mcp.tool.tts_push.title"),
      description: t("mcp.tool.tts_push.description"),
      inputSchema: z.object({
        root: z.string(),
        confirm: z.literal(true),
      }),
    },
    async (args) => {
      try {
        const result = await client.push(args.root, args.confirm);
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
