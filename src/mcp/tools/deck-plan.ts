// src/mcp/tools/deck-plan.ts
/**
 * MCP 工具 `tts_deck_plan`：替换计划 dry-run（列出存档中受替换规则影响的 URL）。
 *
 * 对应 hub 控制通道路由：`POST /v1/deck/plan`（src/hub/control.ts →
 * planReplace）。body 就是 PlanOptions 本身：savePath 是存档 JSON 的路径字符串
 * 或已解析的键值对象；rules 是规则数组（元素结构由 hub 侧 planReplace 深度校验，
 * 非法规则以 PLAN_RULE_INVALID 的 PackError 透传为 `HUB_PACK_ERROR`）。
 *
 * 返回值是控制通道的 JSON 响应体（PlanResult：entries / stats / totalAffected，
 * 结构化 JSON 英文键名，不走 t()）；失败时 `isError: true`，错误体为
 * `{error:{code,message,details?}}`（见 errors.ts）。
 *
 * 本文件使用的 i18n 键：`mcp.tool.tts_deck_plan.title`、
 * `mcp.tool.tts_deck_plan.description`。
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { HubClient } from "../client.js";
import type { PlanOptions } from "../../deck/plan.js";
import { t } from "../../i18n/index.js";
import { serializeError } from "./errors.js";

/**
 * 注册 `tts_deck_plan` 工具。
 *
 * @param server MCP 服务器实例
 * @param client hub 控制通道客户端
 */
export function register(server: McpServer, client: HubClient): void {
  server.registerTool(
    "tts_deck_plan",
    {
      title: t("mcp.tool.tts_deck_plan.title"),
      description: t("mcp.tool.tts_deck_plan.description"),
      inputSchema: z.object({
        savePath: z.union([z.string(), z.record(z.string(), z.unknown())]),
        rules: z.array(z.unknown()),
      }),
    },
    async (args) => {
      try {
        // JSON 传输边界上规则元素不携带静态类型（inputSchema 按 S2 契约只约束
        // "数组"）；元素合法性由 hub 侧 planReplace 深度校验，非法规则以
        // PLAN_RULE_INVALID 的 PackError 透传——与 src/hub/control.ts 的
        // asPlanOptions 同一收口方式，不在此重复校验。
        const body: PlanOptions = {
          savePath: args.savePath,
          rules: args.rules as PlanOptions["rules"],
        };
        const result = await client.deckPlan(body);
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
