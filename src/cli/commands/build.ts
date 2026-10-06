// src/cli/commands/build.ts
/**
 * `tts build -o <out.bson> [--root <pack_root>] [--dry-run]`：发布链路第一步——
 * 图包工作区 → TTS 存档 JSON → 工坊上传用 BSON 载荷（窗口 G / 阶段 7，B4 产出）。
 *
 * 流程（薄调用层，业务逻辑全在 src/pack/ 与 src/publish/ 内）：
 * 1. {@link buildSave}（src/pack/build.ts）合成存档 JSON（缺省
 *    `<root>/dist/<净化(pack.yaml name)>.json`）；`--dry-run` 只统计不写文件；
 * 2. 非 dry-run 时 {@link buildBson}（src/publish/bson.ts）把 JSON 转成 BSON，
 *    内部含"前 4 字节小端长度 == 文件大小"自检；这里再补一次
 *    {@link verifyBsonFile} 独立自检，双保险后才开始引导上传；
 * 3. 完成后 {@link generateManualGuide}（src/publish/manual-guide.ts）生成手动
 *    上传手册并**把 BSON 绝对路径复制到剪贴板**（dry-run 没有产物，跳过此步）。
 *    图包 pack.yaml 里有 workshop_id 时一并传给手册（尽力而为，读不到不阻塞）；
 * 4. 红线：本命令绝不自动打开游戏或 Steam——上传动作永远由用户手动完成。
 *
 * 输出约定（与 pack.ts 一致：清单行是纯数据不翻译，摘要行走 t()）：
 * - 纯数据行：`json: <路径>`、`bson: <路径>`、`bson_bytes: <字节数>`、
 *   `bson_verify: ok`——脚本可直接取用；dry-run 下 json / bson 行是"将生成"的路径；
 * - 摘要行走 i18n（缺键时 t() 原样输出键名，可接受）；
 * - buildSave 的 warnings 逐条缩进打印（中文、经 t()，不改退出码）。
 *
 * 错误处理：PackError 按 `` `error.${code}` `` 取文案（占位符 {msg}），其余异常走
 * `error.unknown`，两者都以退出码 1 结束（与 src/cli/commands/pack.ts 的
 * reportPackError 同款；命令层模块之间按仓库约定不互相 import，故为本地副本）。
 *
 * 本模块使用的 i18n 键（locales/*.json 由 Stage C 补两套；缺键时 t() 原样输出键名）：
 * - `cli.command.build.description`（无参）
 * - `cli.command.build.option.out`（无参）
 * - `cli.command.build.option.root`（无参）
 * - `cli.command.build.option.dryRun`（无参）
 * - `cli.build.dryRun`   {jsonPath} {bsonPath} {scripts} {ui} {objects}
 * - `cli.build.dryRunNote`（无参）
 * - `cli.build.jsonDone` {jsonPath} {scripts} {ui} {objects}
 * - `cli.build.bsonDone` {bsonPath} {bytes}
 * - `cli.build.verifyOk` {bytes}
 * - `cli.build.clipboardOk` {path}
 * - `cli.build.clipboardFail` {error}
 * 复用既有键：`error.unknown` {msg}；`error.publish.bsonInvalid` {headerLength} {byteLength}
 * （verifyBsonFile 失败时用作 PackError 的 message，src/publish/bson.ts 声明），
 * 以及各 PackError 模块已声明的 `error.<code>` 家族——CLI 出口按 `` `error.${code}` ``
 * 取文案（占位符 {msg}），本命令可达的码：SKELETON_MISSING / SKELETON_INVALID /
 * BUILD_FAILED / GUID_MISMATCH / PUBLISH_JSON_NOT_FOUND / PUBLISH_JSON_INVALID /
 * PUBLISH_BSON_INVALID / PUBLISH_OUTPUT_EXISTS / PUBLISH_BSON_NOT_FOUND /
 * PACK_NOT_FOUND 等（locales 由 Stage C 补齐缺失的 PUBLISH_* 码）。
 */

import path from "node:path";

import { Command } from "commander";

import { t } from "../../i18n/index.js";
import { buildSave } from "../../pack/build.js";
import { PackError, readPackYaml } from "../../pack/packyaml.js";
import { buildBson, verifyBsonFile } from "../../publish/bson.js";
import { generateManualGuide } from "../../publish/manual-guide.js";

// ---------------------------------------------------------------------------
// 选项类型
// ---------------------------------------------------------------------------

/** `tts build` 的选项（commander 已按 --kebab-case → camelCase 归一） */
interface BuildCommandOptions {
  /** 输出 BSON 路径（必填，-o / --out） */
  out: string;
  /** 图包工作区根目录（默认 "."） */
  root: string;
  /** 只统计与生成摘要，不写 JSON / BSON 文件（--dry-run） */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * `tts build` 的统一错误出口（与 pack.ts 的 reportPackError 同款；命令层模块
 * 之间按仓库约定不互相 import，故为本地副本）。
 *
 * PackError 是按错误码分支的，对应 `error.<code>` 文案；其余异常统一走
 * `error.unknown`。两者都只写 stderr，绝不向 stdout 混入错误信息。
 *
 * @param err 命令 action 中捕获的异常
 * @returns 建议的进程退出码（恒为 1，与 CLI 其他命令一致）
 */
function reportBuildError(err: unknown): number {
  if (err instanceof PackError) {
    console.error(t(`error.${err.code}`, { msg: err.message }));
    return 1;
  }
  console.error(t("error.unknown", { msg: err instanceof Error ? err.message : String(err) }));
  return 1;
}

/**
 * 生成手动手册并复制 BSON 路径到剪贴板（build 收尾步骤）。
 *
 * pack.yaml 里登记了 workshop_id 时把它作为目标条目传给手册（手册会列出
 * "要更新哪个条目"）；pack.yaml 缺失 / 损坏不阻塞——手册少了条目行照样可用。
 *
 * @param bsonPath BSON 绝对路径（generateManualGuide 会校验文件存在）
 * @param root 图包工作区根目录（读 pack.yaml 用）
 * @returns 手册文本与剪贴板复制结果
 */
async function buildGuide(bsonPath: string, root: string) {
  let itemId: string | number | undefined;
  try {
    itemId = (await readPackYaml(root)).workshop_id ?? undefined;
  } catch {
    // pack.yaml 读不到（未 init / 损坏）不是收尾步骤的阻塞项：手册照给，只是缺条目行
  }
  return generateManualGuide({ bsonPath, ...(itemId !== undefined ? { itemId } : {}) });
}

// ---------------------------------------------------------------------------
// 主命令
// ---------------------------------------------------------------------------

/** `tts build` 主命令：buildSave → buildBson → 自检 → 手动手册（薄调用层） */
export const buildCommand: Command = new Command("build")
  .description(t("cli.command.build.description"))
  .requiredOption("-o, --out <path>", t("cli.command.build.option.out"))
  .option("--root <dir>", t("cli.command.build.option.root"), ".")
  .option("--dry-run", t("cli.command.build.option.dryRun"))
  .action(async (opts: BuildCommandOptions) => {
    try {
      const dryRun = opts.dryRun === true;

      // —— 1. pack build：工作区 → TTS 存档 JSON（dryRun 只统计不写盘）——
      const built = await buildSave({ root: opts.root, dryRun });
      for (const warning of built.warnings) {
        console.log(`  ${warning}`);
      }
      console.log(`json: ${built.outPath}`);

      if (dryRun) {
        // —— dry-run：只显示"将生成"的路径与计数，不写任何文件、不碰剪贴板 ——
        const bsonPath = path.resolve(opts.out);
        console.log(`bson: ${bsonPath}`);
        console.log(
          t("cli.build.dryRun", {
            jsonPath: built.outPath,
            bsonPath,
            scripts: built.scriptsReplaced,
            ui: built.uiReplaced,
            objects: built.objectsReplaced,
          }),
        );
        console.log(t("cli.build.dryRunNote"));
        return;
      }

      // —— 2. JSON → BSON（buildBson 内部已做头部长度自检并落盘）——
      const bson = await buildBson({ jsonPath: built.outPath, outPath: opts.out });
      console.log(`bson: ${bson.outPath}`);
      console.log(`bson_bytes: ${bson.byteLength}`);
      console.log(
        t("cli.build.jsonDone", {
          jsonPath: built.outPath,
          scripts: built.scriptsReplaced,
          ui: built.uiReplaced,
          objects: built.objectsReplaced,
        }),
      );
      console.log(t("cli.build.bsonDone", { bsonPath: bson.outPath, bytes: bson.byteLength }));

      // —— 3. 独立自检：前 4 字节小端长度 == 文件大小（§2.4 工坊载荷格式）——
      const verify = await verifyBsonFile(bson.outPath);
      if (!verify.ok || verify.headerLength !== bson.byteLength) {
        throw new PackError(
          "PUBLISH_BSON_INVALID",
          t("error.publish.bsonInvalid", { headerLength: verify.headerLength, byteLength: verify.byteLength }),
        );
      }
      console.log(`bson_verify: ok`);
      console.log(t("cli.build.verifyOk", { bytes: bson.byteLength }));

      // —— 4. 手动上传手册 + 复制 BSON 路径到剪贴板（绝不自动打开游戏 / Steam）——
      const guide = await buildGuide(bson.outPath, opts.root);
      console.log(guide.text);
      if (guide.clipboardCopied) {
        console.log(t("cli.build.clipboardOk", { path: bson.outPath }));
      } else {
        console.log(t("cli.build.clipboardFail", { error: guide.clipboardError ?? "" }));
      }
    } catch (err) {
      process.exit(reportBuildError(err));
    }
  });

export default buildCommand;
