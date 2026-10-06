// src/mcp/tools/pack-build.ts
/**
 * MCP 工具 `tts_pack_build`：从图包工作区产出工坊上传用 BSON 载荷。
 *
 * 属于窗口 G（阶段 7：测试运行器 + 发布链路），由 C2 产出。
 *
 * 对应 hub 控制通道路由：`POST /v1/pack/build`（src/hub/control.ts → handlePackBuild）。
 * 路由内部是纯本地文件流水线，**不依赖 daemon.server**（不碰 39998 / 39999）：
 * 1. {@link buildSave}（src/pack/build.ts）：工作区 → TTS 存档 JSON（缺省
 *    `<root>/dist/<净化(pack.yaml name)>.json`）；
 * 2. {@link buildBson}（src/publish/bson.ts）：JSON → BSON，内部做"前 4 字节小端
 *    整数 == 文件大小"自检。
 *
 * 参数与返回值：
 * - 参数 `{root, outPath?, dryRun?}`：outPath 是**输出 BSON 载荷路径**（缺省与
 *   中间 JSON 同目录同名，扩展名换成 .bson）；dryRun=true 时只统计不写任何文件；
 * - 返回值是结构化 JSON **英文键名，不走 t()**：核心三字段即 BsonBuildResult
 *   `{outPath(BSON 绝对路径), byteLength, headerLength}`（自检保证两者相等），
 *   另附诊断字段 `dryRun` / `jsonPath` / `warnings[]` / `scriptsReplaced` /
 *   `uiReplaced` / `objectsReplaced` / `decksPatched`；dryRun 下 byteLength 与
 *   headerLength 恒为 0（没有产物，不做虚报）。
 * - 失败经 serializeError 统一为 `{error:{code,message,details?}}` 且 `isError: true`：
 *   hub 未运行 → HUB_NOT_RUNNING；业务错误经 400 HUB_PACK_ERROR 透传
 *   （details.packCode ∈ SKELETON_MISSING / SKELETON_INVALID / GUID_MISMATCH /
 *   BUILD_FAILED / PUBLISH_JSON_NOT_FOUND / PUBLISH_JSON_INVALID /
 *   PUBLISH_BSON_INVALID / PUBLISH_OUTPUT_EXISTS 等）；非 hub 错误 → INTERNAL_ERROR。
 *
 * 红线：本工具只产出本地文件，绝不自动打开游戏 / Steam，也不发起任何上传。
 *
 * 本文件使用的 i18n 键（locales/*.json 由 Stage C 补两套；缺键时 t() 原样输出键名）：
 * `mcp.tool.tts_pack_build.title`、`mcp.tool.tts_pack_build.description`。
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { HubClient } from "../client.js";
import { t } from "../../i18n/index.js";
import { serializeError } from "./errors.js";

/** {@link HubClient.packBuild} 的入参（与 hub 路由 POST /v1/pack/build 的请求体同构）。 */
interface PackBuildOpts {
  /** 图包工作区根目录（绝对路径；hub 侧 resolve） */
  root: string;
  /** 输出 BSON 载荷路径；缺省与中间 JSON 同目录同名（扩展名 .bson） */
  outPath?: string;
  /** 只统计与生成摘要，不写 JSON / BSON 文件（缺省 false） */
  dryRun?: boolean;
}

/**
 * 注册 `tts_pack_build` 工具。
 *
 * @param server MCP 服务器实例
 * @param client hub 控制通道客户端
 */
export function register(server: McpServer, client: HubClient): void {
  server.registerTool(
    "tts_pack_build",
    {
      title: t("mcp.tool.tts_pack_build.title"),
      description: t("mcp.tool.tts_pack_build.description"),
      inputSchema: z.object({
        root: z.string(),
        outPath: z.string().optional(),
        dryRun: z.boolean().optional(),
      }),
    },
    async (args) => {
      try {
        // 逐字段条件拼装：未提供的字段不出现在请求体里，缺省语义全由 hub 侧决定
        const opts: PackBuildOpts = { root: args.root };
        if (args.outPath !== undefined) {
          opts.outPath = args.outPath;
        }
        if (args.dryRun !== undefined) {
          opts.dryRun = args.dryRun;
        }
        const result = await client.packBuild(opts);
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
