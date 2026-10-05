// src/mcp/tools/errors.ts
/**
 * MCP 工具层统一错误序列化（tools/*.ts 共用，不含业务逻辑）。
 *
 * 约定：
 * - 序列化结果 `{code, message, details?}` 是结构化 JSON 载荷（英文协议文本，
 *   机器可读），随工具返回值走 `content[].text` 的 `{error:...}` 包装——按项目
 *   红线"工具返回值英文键名不走 t()"，这里不接 i18n；双语呈现只发生在工具的
 *   title / description（各自经 t() 生成，见各工具文件）；
 * - `HubNotRunningError` 必须先于 `HubError` 判断（后者是前者的父类时，顺序
 *   反了会把"hub 未运行"误报成通用 hub 错误）；
 * - 语义映射：
 *   - `HUB_NOT_RUNNING`：hub 未运行（连接 127.0.0.1:39995 被拒绝）；
 *   - `HubError.code`：hub 控制通道返回的协议错误码（HUB_* / HUB_PACK_ERROR /
 *     HUB_LUA_ERROR / HUB_CONFIRM_REQUIRED 等，透传）；
 *   - `INTERNAL_ERROR`：本地非 hub 错误（文件、网络层等）；
 *   - `UNKNOWN`：连 Error 都不是的抛出值（退化为 String）。
 */

import { HubError, HubNotRunningError } from "../client.js";

/** {@link serializeError} 的返回值结构（工具错误体的 `error` 字段）。 */
export interface SerializedError {
  /** 机器可读错误码（HUB_NOT_RUNNING / HUB_* / INTERNAL_ERROR / UNKNOWN） */
  code: string;
  /** 错误描述（协议层英文短句或底层透传文本） */
  message: string;
  /** 可选结构化细节（hub 协议错误的透传载荷；无细节时字段缺省） */
  details?: unknown;
}

/**
 * 把任意抛出值序列化为统一的错误结构（tools/*.ts 的 catch 分支统一出口）。
 *
 * @param err 工具执行过程中抛出的任意值
 * @returns `{code, message, details?}`；details 仅在存在时出现
 */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof HubNotRunningError) {
    return { code: "HUB_NOT_RUNNING", message: "hub is not running on 127.0.0.1:39995" };
  }
  if (err instanceof HubError) {
    return { code: err.code, message: err.message, details: err.details };
  }
  if (err instanceof Error) {
    return { code: "INTERNAL_ERROR", message: err.message };
  }
  return { code: "UNKNOWN", message: String(err) };
}
