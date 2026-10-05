// src/mcp/tools/exec.ts
/**
 * MCP 工具 `tts_exec`：在 TTS 内执行 Lua 并拿回 JSON 结果。
 *
 * 对应 hub 控制通道路由：`POST /v1/exec`（src/hub/control.ts →
 * HubDaemon.exec.execJson）。返回值是控制通道的 JSON 响应体（`{result:...}`，
 * 结果本身为 JSON-Lua 的返回值；结构化 JSON 英文键名，不走 t()）；Lua 运行时
 * 错误映射为 `HUB_LUA_ERROR`（details 携带 guid / line / col / endCol，见
 * src/hub/control.ts 的 respondError）；其余 hub 侧失败（超时 / 未连接等）以
 * HubError 的协议错误码透传。所有失败经 serializeError 统一为
 * `{error:{code,message,details?}}` 且 `isError: true`。
 *
 * 本文件使用的 i18n 键：`mcp.tool.tts_exec.title`、`mcp.tool.tts_exec.description`。
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { HubClient } from "../client.js";
import { t } from "../../i18n/index.js";
import { serializeError } from "./errors.js";

/** {@link client.exec} 的可选执行参数（与 session 层 ExecOptions 同构）。 */
interface ExecOpts {
  /** 目标对象 guid；缺省由 hub 侧补 "-1"（全局脚本） */
  guid?: string;
  /** 超时毫秒数；缺省由 hub 侧决定（30000） */
  timeoutMs?: number;
}

/**
 * 注册 `tts_exec` 工具。
 *
 * @param server MCP 服务器实例
 * @param client hub 控制通道客户端
 */
export function register(server: McpServer, client: HubClient): void {
  server.registerTool(
    "tts_exec",
    {
      title: t("mcp.tool.tts_exec.title"),
      description: t("mcp.tool.tts_exec.description"),
      inputSchema: z.object({
        lua: z.string(),
        guid: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      }),
    },
    async (args) => {
      try {
        const opts: ExecOpts = {};
        if (args.guid !== undefined) {
          opts.guid = args.guid;
        }
        if (args.timeoutMs !== undefined) {
          opts.timeoutMs = args.timeoutMs;
        }
        const result = await client.exec(args.lua, opts);
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
