// src/editor/command.ts
/**
 * 命令行模板适配器（6A 轻量层的核心实现）。
 *
 * 把"打开文件并定位"翻译成一个 shell 命令模板：
 *   "code --goto {file}:{line}:{column}"
 *
 * 占位符（在 spawn 之前替换）：
 * - `{file}`   文件绝对路径（必需；缺这个占位符时构造抛 PackError）
 * - `{line}`   1-based 行号（可选；缺省且未提供时填 1）
 * - `{column}` 1-based 列号（可选；缺省且未提供时填 1）
 *
 * 安全约束：
 * - 模板按"shell 风格空白切分"得到 argv 数组，**shell: false** spawn，杜绝 shell 注入；
 * - 文件路径中的双引号 / 反斜杠不做额外转义——子进程拿到的是 argv 数组不是字符串；
 * - `isAvailable()` 用 `where` (Windows) / `which` (POSIX) 探测，不实际执行编辑器；
 * - `openFile()` detached + stdio ignore，CLI 立即返回不等编辑器。
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像）：
 * - `error.editor.templateInvalid` {template}
 * - `error.editor.spawnFailed` {command} {detail}
 */

import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";

import type { EditorAdapter, EditorOpenTarget } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * 命令行模板适配器。
 *
 * 模板字符串按空白切分成 argv 数组（不支持引号包围的多词参数——
 * 如需复杂命令，用户应自行包装成 shell 脚本再走 adapter id `"command"`）。
 */
export class CommandEditorAdapter implements EditorAdapter {
  readonly id: string;
  private readonly template: string;

  /**
   * @param id 适配器 id（用于 i18n 报错）
   * @param template 命令行模板；必须包含 `{file}` 占位符
   * @throws PackError code="EDITOR_TEMPLATE_INVALID" 模板缺 `{file}` 占位符
   */
  constructor(id: string, template: string) {
    if (!template.includes("{file}")) {
      throw new PackError(
        "EDITOR_TEMPLATE_INVALID",
        t("error.editor.templateInvalid", { template }),
      );
    }
    this.id = id;
    this.template = template;
  }

  /**
   * 取模板的可执行文件名（argv[0]）。
   * 用于 `isAvailable()` 的 PATH 探测。
   */
  private executableName(): string {
    const trimmed = this.template.trim();
    const firstSpace = trimmed.search(/\s/);
    return firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  }

  /**
   * 把模板渲染成 argv 数组。
   *
   * 占位符替换规则：
   * - `{file}` → 目标文件绝对路径（原样）
   * - `{line}` → 目标行号（1-based；target.line 缺省时填 1）
   * - `{column}` → 目标列号（1-based；target.column 缺省时填 1）
   *
   * 替换后按空白切分成数组；空段被丢弃（多个连续空格视为一个）。
   */
  private renderArgv(target: EditorOpenTarget): string[] {
    const line = target.line ?? 1;
    const column = target.column ?? 1;
    const rendered = this.template
      .replace(/\{file\}/g, target.absPath)
      .replace(/\{line\}/g, String(line))
      .replace(/\{column\}/g, String(column));
    return rendered.split(/\s+/).filter((seg) => seg.length > 0);
  }

  /**
   * 探测可执行文件是否在 PATH 中。
   *
   * - Windows: `where.exe <name>`（退出码 0 = 找到）
   * - POSIX:   `which <name>`   （退出码 0 = 找到）
   *
   * 任何失败（命令不存在 / PATH 未命中 / 其他 IO 错误）都返回 false，不抛错。
   */
  async isAvailable(): Promise<boolean> {
    const name = this.executableName();
    if (name === "") {
      return false;
    }
    const probeCmd = process.platform === "win32" ? "where.exe" : "which";
    try {
      await execFileAsync(probeCmd, [name], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 打开文件并定位。
   *
   * 实现：spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", shell: false })。
   * - shell: false 保证 argv 数组语义，杜绝 shell 注入；
   * - detached + stdio ignore 让 CLI 立即返回，不等编辑器；
   * - 子进程立即报错（如 ENOENT）会触发 'error' 事件，本方法在该事件触发时 reject；
   * - 子进程成功 spawn 后，本方法立即 resolve，不等子进程退出。
   *
   * @param target 文件 + 可选行列
   * @throws PackError code="EDITOR_SPAWN_FAILED" spawn 立即失败（命令不存在等）
   */
  async openFile(target: EditorOpenTarget): Promise<void> {
    const argv = this.renderArgv(target);
    if (argv.length === 0) {
      throw new PackError(
        "EDITOR_TEMPLATE_INVALID",
        t("error.editor.templateInvalid", { template: this.template }),
      );
    }
    const [cmd, ...args] = argv;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
        shell: false,
      });
      child.once("error", (err) => {
        reject(
          new PackError(
            "EDITOR_SPAWN_FAILED",
            t("error.editor.spawnFailed", { command: cmd, detail: err.message }),
          ),
        );
      });
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
}
