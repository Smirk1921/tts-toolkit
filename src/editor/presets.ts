// src/editor/presets.ts
/**
 * 6 个内置编辑器预设（阶段 6 / 6A 轻量层）。
 *
 * 每个预设 = adapter id + 命令行模板 + 平台特定的 system 实现。
 *
 * | id        | 模板（Windows / POSIX 同模板）                        | 备注 |
 * |-----------|------------------------------------------------------|------|
 * | vscode    | `code --goto {file}:{line}:{column}`                 | 主流 |
 * | jetbrains | `idea --line {line} {file}`                          | IDEA 系 |
 * | sublime   | `subl {file}:{line}:{column}`                        | |
 * | notepadpp | `notepad++ -n{line} {file}`                          | Windows 专属 |
 * | system    | 平台相关（见 systemAdapter）                          | 系统默认程序 |
 * | command   | 用户自定义模板                                        | 需配 --command |
 *
 * 本模块只负责"给出预设的 CommandEditorAdapter 实例"，不负责优先级解析；
 * 三层解析见 resolve.ts。
 */

import { CommandEditorAdapter } from "./command.js";
import type { EditorAdapter, EditorOpenTarget, EditorPresetId } from "./types.js";

/**
 * system 预设的适配器：调用操作系统默认程序打开文件。
 *
 * 平台行为：
 * - Windows: `cmd /c start "" "<file>"`（title 必须给空字符串，否则含空格的路径会被当 title）
 * - macOS:   `open "<file>"`
 * - Linux:   `xdg-open "<file>"`
 *
 * 注意：system 预设**不支持定位行列**——`start`/`open`/`xdg-open` 都没有行列参数，
 * openFile 的 line / column 字段被静默忽略（这是文档化的行为差异，见 docs/editor.md）。
 */
class SystemEditorAdapter implements EditorAdapter {
  readonly id = "system";

  /** system 预设总是可用（依赖系统自带命令）。 */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * 用系统默认程序打开文件（忽略 line / column）。
   *
   * 通过 CommandEditorAdapter 复用 spawn 逻辑：构造一个"平台特定的命令模板"，
   * 把 absPath 填进 `{file}` 占位符后 spawn。line / column 在本适配器中被丢弃。
   */
  async openFile(target: EditorOpenTarget): Promise<void> {
    let template: string;
    if (process.platform === "win32") {
      // cmd /c start "" "<file>"：title 空字符串是 start 的固定语法
      template = `cmd /c start "" "{file}"`;
    } else if (process.platform === "darwin") {
      template = `open "{file}"`;
    } else {
      template = `xdg-open "{file}"`;
    }
    const inner = new CommandEditorAdapter(this.id, template);
    // 忽略 line / column，直接透传 absPath
    const noLineCol: EditorOpenTarget = { absPath: target.absPath };
    await inner.openFile(noLineCol);
  }
}

/** 各预设的命令模板（不含 system——system 走 SystemEditorAdapter）。 */
const PRESET_TEMPLATES: Readonly<Record<Exclude<EditorPresetId, "system" | "command">, string>> = {
  vscode: "code --goto {file}:{line}:{column}",
  jetbrains: "idea --line {line} {file}",
  sublime: "subl {file}:{line}:{column}",
  notepadpp: "notepad++ -n{line} {file}",
};

/**
 * 取一个内置预设的适配器实例。
 *
 * @param id 预设 id
 * @param customTemplate 当 id === "command" 时必传的用户自定义模板；其他 id 时忽略
 * @returns 适配器实例
 * @throws Error 当 id === "command" 且 customTemplate 未提供时（调用方保证；正常路径不会走到）
 */
export function createPresetAdapter(
  id: EditorPresetId,
  customTemplate?: string,
): EditorAdapter {
  if (id === "system") {
    return new SystemEditorAdapter();
  }
  if (id === "command") {
    if (customTemplate === undefined || customTemplate === "") {
      // 由 resolve.ts 在三层合并时提前校验并报 i18n 错误；
      // 走到这里说明调用方跳过了 resolve.ts，属于编程错误
      throw new Error("createPresetAdapter: id=command requires customTemplate");
    }
    return new CommandEditorAdapter("command", customTemplate);
  }
  return new CommandEditorAdapter(id, PRESET_TEMPLATES[id]);
}
