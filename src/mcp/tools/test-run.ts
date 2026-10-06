// src/mcp/tools/test-run.ts
/**
 * MCP 工具 `tts_test_run`：在 TTS 中运行图包工作区的 Lua 测试并拿回 RunReport。
 *
 * 属于窗口 G（阶段 7：测试运行器 + 发布链路），由 C2 产出。
 *
 * 对应 hub 控制通道路由：`POST /v1/test/run`（src/hub/control.ts → handleTestRun）。
 * 路由内部：`discoverTests`（src/test/discover.ts，pack.yaml tests.include 或内置
 * `tests/**\/*.test.lua`）→ 把请求里的 targetGuid / timeoutMs 覆盖到每个发现条目 →
 * `new TestRunner(daemon.server).run({..., server: daemon.server})`——坑 17：hub 侧
 * 注入自己已绑定的编辑器端口 39998，本工具层不接触任何端口。
 *
 * 参数与返回值：
 * - 参数 `{root, targetGuid?, timeoutMs?, bail?, bundle?}`（root 必填；其余缺省由
 *   hub 侧按 discover / runner 的缺省值处理：targetGuid="-1"、timeoutMs=30000、
 *   bail=false、bundle=true）；
 * - 返回值是 RunReport（src/test/types.ts）的结构化 JSON **英文键名，不走 t()**：
 *   `{runId, root, startedAt, endedAt, durationMs, total, passed, failed, errored,
 *   bailed, results:[{case:{name,sourceFile,sourceLine}, status, failureReason?,
 *   asserts:[...], durationMs, prints:[...]}]}`——结果原样放进 structuredContent 与
 *   content[0].text（与 tts_exec / tts_push 同款：控制通道 JSON 直接透传）。
 *   工作区没有测试文件时不是错误：hub 侧返回 total=0 的空报告，退出码由 CLI 决定。
 * - 失败经 serializeError 统一为 `{error:{code,message,details?}}` 且 `isError: true`：
 *   hub 未运行 → HUB_NOT_RUNNING；打包 / 执行 / 发现类业务错误经 400
 *   HUB_PACK_ERROR 透传（details.packCode ∈ TEST_RUN_BUNDLE_FAILED /
 *   TEST_RUN_FILE_UNREADABLE / TEST_RUN_FILE_TIMEOUT / TEST_RUN_EXEC_FAILED /
 *   TEST_RUN_RESULTS_MALFORMED / TEST_RUN_GLOBAL_TIMEOUT 等）；非 hub 错误 →
 *   INTERNAL_ERROR。
 *
 * 本文件使用的 i18n 键（locales/*.json 由 Stage C 补两套；缺键时 t() 原样输出键名）：
 * `mcp.tool.tts_test_run.title`、`mcp.tool.tts_test_run.description`。
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { HubClient } from "../client.js";
import { t } from "../../i18n/index.js";
import { serializeError } from "./errors.js";

/** {@link HubClient.testRun} 的入参（与 hub 路由 POST /v1/test/run 的请求体同构）。 */
interface TestRunOpts {
  /** 图包工作区根目录（绝对路径；hub 侧 resolve） */
  root: string;
  /** 目标对象 guid 覆盖；缺省取 pack.yaml tests.target_guid（无则 "-1" 全局脚本） */
  targetGuid?: string;
  /** 单文件超时毫秒数覆盖；缺省取 pack.yaml tests.timeout（无则 30000） */
  timeoutMs?: number;
  /** 首个失败即停（粒度是文件）；缺省 false */
  bail?: boolean;
  /** 是否启用 luabundle 打包（缺省 true；false 时逐文件直跑） */
  bundle?: boolean;
}

/**
 * 注册 `tts_test_run` 工具。
 *
 * @param server MCP 服务器实例
 * @param client hub 控制通道客户端
 */
export function register(server: McpServer, client: HubClient): void {
  server.registerTool(
    "tts_test_run",
    {
      title: t("mcp.tool.tts_test_run.title"),
      description: t("mcp.tool.tts_test_run.description"),
      inputSchema: z.object({
        root: z.string(),
        targetGuid: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        bail: z.boolean().optional(),
        bundle: z.boolean().optional(),
      }),
    },
    async (args) => {
      try {
        // 逐字段条件拼装：未提供的字段不出现在请求体里，缺省语义全由 hub 侧决定
        const opts: TestRunOpts = { root: args.root };
        if (args.targetGuid !== undefined) {
          opts.targetGuid = args.targetGuid;
        }
        if (args.timeoutMs !== undefined) {
          opts.timeoutMs = args.timeoutMs;
        }
        if (args.bail !== undefined) {
          opts.bail = args.bail;
        }
        if (args.bundle !== undefined) {
          opts.bundle = args.bundle;
        }
        const result = await client.testRun(opts);
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
