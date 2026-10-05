// src/editor/resolve.ts
/**
 * 三层编辑器配置解析（阶段 6 / 6A 轻量层）。
 *
 * 优先级（高 → 低）：
 * 1. CLI 参数 `--adapter <id>` / `--command <tpl>`（本函数的 cliOptions 入参）
 * 2. pack.yaml 的 `editor.adapter`（schema 当前只允许 "vscode"；缺省 undefined）
 * 3. 环境变量 `TTS_EDITOR_ADAPTER` / `TTS_EDITOR_COMMAND`
 *
 * 全部缺省时回退到 `"vscode"`（最常见场景，与 pack.yaml schema 的唯一允许值一致）。
 *
 * 校验规则：
 * - `--adapter` / `TTS_EDITOR_ADAPTER` 必须是 6 个预设 id 之一，否则 PackError "EDITOR_ADAPTER_UNKNOWN"
 * - `--adapter command` 必须同时给 `--command <tpl>`（或 TTS_EDITOR_COMMAND），否则 PackError "EDITOR_COMMAND_REQUIRED"
 * - 用户自定义模板必须包含 `{file}` 占位符（CommandEditorAdapter 构造时已校验，
 *   这里在解析层就提前报，保证错误信息带 i18n）
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像）：
 * - `error.editor.adapterUnknown` {adapter}
 * - `error.editor.commandRequired`
 */

import { t } from "../i18n/index.js";
import { PackError, type PackYaml } from "../pack/packyaml.js";

import { createPresetAdapter } from "./presets.js";
import { EDITOR_PRESET_IDS, type EditorAdapter, type EditorPresetId } from "./types.js";

/** CLI 层传入的编辑器相关选项（与 commander 选项一一对应）。 */
export interface EditorCliOptions {
  /** `--adapter <id>`；undefined 表示未指定 */
  adapter?: string;
  /** `--command <tpl>`；undefined 表示未指定；仅当 adapter === "command" 时生效 */
  command?: string;
}

/**
 * 判定字符串是否为合法预设 id。
 * @param value 待判定字符串
 * @returns 是 6 个预设 id 之一时返回 true（类型窄化为 EditorPresetId）
 */
function isPresetId(value: string): value is EditorPresetId {
  return (EDITOR_PRESET_IDS as readonly string[]).includes(value);
}

/**
 * 三层合并解析出 EditorAdapter 实例。
 *
 * 合并顺序（命中即返回，不继续向下）：
 * 1. cliOptions.adapter → 优先；command 模板取 cliOptions.command ?? env.TTS_EDITOR_COMMAND
 * 2. packYaml.editor?.adapter（schema 限定 "vscode"）→ 直接用
 * 3. process.env.TTS_EDITOR_ADAPTER → 模板取 process.env.TTS_EDITOR_COMMAND
 * 4. 默认 "vscode"
 *
 * @param packYaml 已读取的 pack.yaml（可以没有 editor 字段）
 * @param cliOptions CLI 层 `--adapter` / `--command` 的原始值
 * @returns 适配器实例
 * @throws PackError code="EDITOR_ADAPTER_UNKNOWN" adapter id 不是 6 个预设之一
 * @throws PackError code="EDITOR_COMMAND_REQUIRED" adapter=command 但未提供模板
 * @throws PackError code="EDITOR_TEMPLATE_INVALID" 自定义模板缺 `{file}` 占位符
 */
export function resolveAdapter(
  packYaml: PackYaml,
  cliOptions: EditorCliOptions,
): EditorAdapter {
  // 第 1 层：CLI 显式指定
  if (cliOptions.adapter !== undefined) {
    return buildAdapter(cliOptions.adapter, cliOptions.command ?? process.env.TTS_EDITOR_COMMAND);
  }
  // 第 2 层：pack.yaml
  if (packYaml.editor !== undefined) {
    return buildAdapter(packYaml.editor.adapter, undefined);
  }
  // 第 3 层：环境变量
  if (process.env.TTS_EDITOR_ADAPTER !== undefined) {
    return buildAdapter(process.env.TTS_EDITOR_ADAPTER, process.env.TTS_EDITOR_COMMAND);
  }
  // 第 4 层：默认 vscode
  return buildAdapter("vscode", undefined);
}

/**
 * 内部助手：把字符串 adapter id + 可选模板转成 EditorAdapter。
 * 集中处理"未知 id / command 缺模板 / 模板缺 file"三种错误。
 */
function buildAdapter(adapterId: string, customTemplate: string | undefined): EditorAdapter {
  if (!isPresetId(adapterId)) {
    throw new PackError(
      "EDITOR_ADAPTER_UNKNOWN",
      t("error.editor.adapterUnknown", { adapter: adapterId }),
    );
  }
  if (adapterId === "command" && (customTemplate === undefined || customTemplate === "")) {
    throw new PackError("EDITOR_COMMAND_REQUIRED", t("error.editor.commandRequired"));
  }
  return createPresetAdapter(adapterId, customTemplate);
}
