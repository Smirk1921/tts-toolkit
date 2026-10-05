// src/cli/commands/pull.ts
/**
 * `tts pull <dir>`：把当前存档的全部脚本与 UI 落盘到指定目录。
 *
 * 两条路径（阶段 4 窗口 D 起）：
 * 1. **hub 委托**（{@link tryHubClient} 探测到 hub 在线时）：首行打印 viaHub，
 *    经 hub 控制通道调 HubClient.pullScripts(outDir)（hub 进程内执行
 *    pullFromGame，落盘 scripts/ + ui/），按 PullResult 计数复用 cli.pull.done /
 *    cli.pull.empty 文案；委托失败（HubError / HubNotRunningError 等）输出
 *    error.hub.delegateFailed 并退出 1——**不回退独立模式**（hub 在线时 39998
 *    被 hub 持有，回退独立模式必然绑不上端口）；
 * 2. **独立模式**（hub 不在线，返回 null 时；行为与阶段 4 之前完全一致）。
 *
 * 命名规则（与设计一致）：
 * - guid 为 "-1"（全局脚本）→ `Global.lua` / `Global.xml`；
 * - 其他对象 → `<guid>.<净化后的对象名>.lua` / `.xml`；
 * - 对象缺 script / ui 字段时跳过对应文件（不生成空文件）。
 *
 * 只读操作：仅调 SessionScripts.getScripts()（出站 messageID 0），
 * 不触碰 push 协议（设计约束 7：本阶段 CLI 不暴露 push）。
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像；缺键时 t() 原样输出键名）：
 * - 新增：`cli.pull.viaHub`（无参）、`error.hub.delegateFailed` {message}；
 * - 复用既有键：`cli.command.pull.description`、`cli.command.pull.argument.dir`、
 *   `cli.pull.target` {dir}、`cli.pull.done` {scripts} {ui}、`cli.pull.empty`、
 *   `cli.pull.notConnected` 与 `error.generic`（经 reportError 分类出口）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { t } from "../../i18n/index.js";
import { GLOBAL_GUID } from "../../protocol/messages.js";
import type { ScriptState } from "../../session/scripts.js";
import { tryHubClient } from "../_shared.js";
import { describeError, reportError, withEditorServer } from "../with-server.js";

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

/** hub 委托拉取的计数形状（hub 侧 PullResult 的子集，见 src/pack/pull.ts）。 */
interface HubPullCounts {
  /** 实际写入 scripts/ 的 Lua 文件数 */
  scriptsWritten: number;
  /** 实际写入 ui/ 的 XML 文件数 */
  uiWritten: number;
}

/**
 * 从 hub /v1/scripts/pull 的响应体中提取计数（运行时形状校验；
 * HubClient.pullScripts 的返回类型是 unknown，这里窄化为所需字段）。
 * @param body 控制通道 JSON 响应体（应为 PullResult：{scriptsWritten, uiWritten, skippedNoChange}）
 * @returns 形状合法时返回计数；形状不符时返回 undefined（调用方按委托失败处理）
 */
function asPullCounts(body: unknown): HubPullCounts | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const { scriptsWritten, uiWritten } = body as Record<string, unknown>;
  return typeof scriptsWritten === "number" && typeof uiWritten === "number"
    ? { scriptsWritten, uiWritten }
    : undefined;
}

export const pullCommand = new Command("pull")
  .description(t("cli.command.pull.description"))
  .argument("<dir>", t("cli.command.pull.argument.dir"))
  .action(async (dir: string) => {
    const outDir = path.resolve(dir);
    let scriptCount = 0;
    let uiCount = 0;

    const hub = await tryHubClient();
    if (hub !== null) {
      // —— hub 委托路径：拉取在 hub 进程内执行（它持有 39998 的独占绑定）——
      console.log(t("cli.pull.viaHub"));
      try {
        console.log(t("cli.pull.target", { dir: outDir }));
        const counts = asPullCounts(await hub.pullScripts(outDir));
        if (counts === undefined) {
          // 协议异常：响应体不是约定的 PullResult 形状，同样按委托失败处理
          throw new Error("/v1/scripts/pull response is not the expected PullResult shape");
        }
        scriptCount = counts.scriptsWritten;
        uiCount = counts.uiWritten;
      } catch (err) {
        // HubClient.pullScripts 只抛 HubError / HubNotRunningError（见 src/mcp/client.ts），
        // 任何异常都按"委托失败"处理：报错并退出，不回退独立模式
        console.error(t("error.hub.delegateFailed", { message: describeError(err) }));
        process.exit(1);
      }
    } else {
      // —— 独立模式（hub 不在线）：以下与阶段 4 之前的行为完全一致 ——
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
    }

    if (scriptCount + uiCount === 0) {
      console.log(t("cli.pull.empty"));
      return;
    }
    console.log(t("cli.pull.done", { scripts: scriptCount, ui: uiCount }));
  });
