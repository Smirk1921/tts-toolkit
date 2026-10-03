// src/cli/commands/pull.ts
/**
 * `tts pull <dir>`：把当前存档的全部脚本与 UI 落盘到指定目录。
 *
 * 命名规则（与设计一致）：
 * - guid 为 "-1"（全局脚本）→ `Global.lua` / `Global.xml`；
 * - 其他对象 → `<guid>.<净化后的对象名>.lua` / `.xml`；
 * - 对象缺 script / ui 字段时跳过对应文件（不生成空文件）。
 *
 * 只读操作：仅调 SessionScripts.getScripts()（出站 messageID 0），
 * 不触碰 push 协议（设计约束 7：本阶段 CLI 不暴露 push）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { t } from "../../i18n/index.js";
import { GLOBAL_GUID } from "../../protocol/messages.js";
import type { ScriptState } from "../../session/scripts.js";
import { reportError, withEditorServer } from "../with-server.js";

/** Windows 文件名非法字符（`/ \ ? % * : | " < >`） */
const INVALID_FILENAME_CHARS = /[/\\?%*:|"<>]/g;

/** Windows 文件名同样不允许的控制字符 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * 把对象名净化成安全的文件名片段。
 *
 * 规则（顺序有讲究）：
 * 1. 连续空白（含 tab / 换行）转单个下划线——必须在删控制字符之前做，
 *    否则 tab 会被当控制字符删掉而丢掉词边界；
 * 2. 删除剩余控制字符；
 * 3. 删除 Windows 非法字符 `/ \ ? % * : | " < >`；
 * 4. 去掉前导的点 / 下划线与结尾的点 / 空格（Windows 会静默截断结尾的点与空格）；
 * 5. 结果为空时回退 "object"（保证永远能得到可用文件名）。
 *
 * @param raw 对象原始名称（如 "Chess Pawn"）
 * @returns 可安全用于文件名的片段（如 "Chess_Pawn"）
 */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, "_")
    .replace(CONTROL_CHARS, "")
    .replace(INVALID_FILENAME_CHARS, "")
    .replace(/^[._]+/, "")
    .replace(/[._ ]+$/, "");
  return cleaned === "" ? "object" : cleaned;
}

/**
 * 单个对象的落盘文件名主干（不含扩展名）。
 * @param state 对象脚本状态
 * @returns "Global" 或 "<guid>.<净化名>"
 */
function fileBaseName(state: ScriptState): string {
  return state.guid === GLOBAL_GUID ? "Global" : `${state.guid}.${sanitizeName(state.name)}`;
}

export const pullCommand = new Command("pull")
  .description(t("cli.command.pull.description"))
  .argument("<dir>", t("cli.command.pull.argument.dir"))
  .action(async (dir: string) => {
    const outDir = path.resolve(dir);
    let scriptCount = 0;
    let uiCount = 0;

    try {
      mkdirSync(outDir, { recursive: true });
      console.log(t("cli.pull.target", { dir: outDir }));

      await withEditorServer(async ({ scripts }) => {
        const states = await scripts.getScripts();
        for (const state of states) {
          const base = path.join(outDir, fileBaseName(state));
          if (state.script !== undefined) {
            writeFileSync(`${base}.lua`, state.script, "utf8");
            scriptCount += 1;
          }
          if (state.ui !== undefined) {
            writeFileSync(`${base}.xml`, state.ui, "utf8");
            uiCount += 1;
          }
        }
      });
    } catch (err) {
      process.exit(reportError(err, "cli.pull.notConnected"));
    }

    if (scriptCount + uiCount === 0) {
      console.log(t("cli.pull.empty"));
      return;
    }
    console.log(t("cli.pull.done", { scripts: scriptCount, ui: uiCount }));
  });
