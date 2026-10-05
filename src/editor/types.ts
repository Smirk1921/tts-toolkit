// src/editor/types.ts
/**
 * 编辑器适配层类型定义（阶段 6 / 窗口 F / 6A 轻量层）。
 *
 * 两层设计中的"轻量层"：跨编辑器、配置驱动，只负责"打开文件并定位到行"。
 * 深度层（VSCode 插件）见 `vscode-ext/` 与 `docs/vscode-ext-protocol-adapter.md`。
 *
 * 本模块只导出类型，不含实现；实现见 command.ts / presets.ts / resolve.ts / locate.ts。
 */

/** 打开文件的目标位置（行 / 列均为 1-based，与 VSCode `--goto` 语义一致）。 */
export interface EditorOpenTarget {
  /** 绝对路径（Windows / POSIX 均可，适配器只透传不解析） */
  absPath: string;
  /** 1-based 行号；缺省时由编辑器自行决定（一般跳到第 1 行或上次位置） */
  line?: number;
  /** 1-based 列号；缺省时由编辑器自行决定 */
  column?: number;
}

/**
 * 编辑器适配器接口。
 *
 * 任何"能打开文件并定位"的编辑器都可以通过实现这个接口接入：
 * - 内置 6 个预设（vscode / jetbrains / sublime / notepadpp / system / command）
 * - 用户通过 pack.yaml `editor.adapter` 或 CLI `--adapter` 选择 id
 * - 自定义命令模板通过 adapter id `"command"` + 模板字符串使用
 */
export interface EditorAdapter {
  /** 适配器 id（用于 i18n 报错与日志） */
  readonly id: string;

  /**
   * 探测当前环境是否可用（命令在 PATH 中 / 平台支持）。
   *
   * @returns 可用返回 true；不可用返回 false（不抛错——不可用是正常业务分支）
   */
  isAvailable(): Promise<boolean>;

  /**
   * 打开文件并定位到指定行列。
   *
   * 实现要求：
   * - 必须异步 spawn 子进程，不能阻塞 CLI 主流程
   * - 子进程 stdio 必须 ignore + detached，避免编辑器把 CLI 的 stdout 当终端
   * - 打开失败（命令不存在 / 立即退出非 0）应抛 PackError code="EDITOR_SPAWN_FAILED"
   *
   * @param target 文件 + 可选行列
   * @throws PackError 打开失败时
   */
  openFile(target: EditorOpenTarget): Promise<void>;
}

/** 内置预设 id 列表（与 presets.ts 中的顺序一致；同时是 zod 可枚举值）。 */
export const EDITOR_PRESET_IDS = [
  "vscode",
  "jetbrains",
  "sublime",
  "notepadpp",
  "system",
  "command",
] as const;

/** 内置预设 id 的联合类型。 */
export type EditorPresetId = (typeof EDITOR_PRESET_IDS)[number];
