// src/cli/commands/import.ts
/**
 * `tts import <清单路径> [--dry-run]`：按 import.yaml 把素材归位到工作区（阶段 3，窗口 C）。
 *
 * 本文件是薄调用层：全部校验 / 规划 / 落盘逻辑在 src/pack/import.ts 的
 * {@link importAssets}（契约见 docs/schemas/import.yaml.md）；这里只做三件事：
 * 解析命令行 → 调 importAssets → 用 t() 打印结构化结果。
 *
 * 路径基准（重要）：清单里声明的相对路径**相对 import.yaml 所在目录**解析
 * （src/pack/import.ts 的契约），工作区根由 `--pack` 给出（默认当前目录）——
 * 因此从任意目录都能跑 `tts import <清单> --pack <工作区>`。
 *
 * 输出约定：
 * - 每个卡堆 / 素材一行纯数据行（name / dir / 计数 / asset_id），行内标签走 t()；
 * - 末行摘要与 dry-run 提示走 t()；warnings 是 importAssets 已翻译好的中文，
 *   逐条缩进打印（不改变退出码——它们只是提示，不是错误）；
 * - 退出码：成功 0；PackError（IMPORT_* / CARDS_* / OBJECTS_* 透传）与其余异常
 *   统一走 reportImportError → 1。
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像；缺键时 t() 原样输出键名）：
 * - 静态：`cli.command.import.description` / `argument.manifest` /
 *   `option.pack` / `option.dryRun`、`cli.import.done` {decks} {cards} {objects} {files}、
 *   `cli.import.deck` {name} {dir} {added} {sheets} {state}、
 *   `cli.import.object` {type} {name} {assetId} {state}、
 *   `cli.import.stateCreated` / `cli.import.stateUpdated`、`cli.import.dryRunNote`、
 *   `cli.import.warning` {message}、`error.unknown` {msg}；
 * - 动态（键 = `error.` + PackError.code，占位符 {msg}）：IMPORT_INVALID /
 *   IMPORT_FILE_MISSING / IMPORT_CMYK / IMPORT_GRID_OVERFLOW / IMPORT_EMPTY /
 *   IMPORT_READ_FAILED / IMPORT_WRITE_FAILED（以及已有台账损坏时透传的
 *   CARDS_* / OBJECTS_*）。
 */

import { Command } from "commander";

import { t } from "../../i18n/index.js";
import { importAssets, type ImportResult } from "../../pack/import.js";
import { PackError } from "../../pack/packyaml.js";

// ---------------------------------------------------------------------------
// 选项类型
// ---------------------------------------------------------------------------

/** `tts import` 的选项（commander 已按 --kebab-case → camelCase 归一） */
interface ImportCliOptions {
  /** 图包工作区根目录（默认 "."，由 commander 的默认值填入） */
  pack: string;
  /** 只规划不落盘 */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// 错误出口
// ---------------------------------------------------------------------------

/**
 * import 子命令的统一错误出口（与 pack.ts 的 reportPackError 同一份实现）。
 *
 * PackError 按错误码分支（`error.<code>` 文案，占位符 {msg}）；其余异常走
 * `error.unknown`。两者都只写 stderr 并以退出码 1 结束。
 *
 * @param err 命令 action 中捕获的异常
 * @returns 建议的进程退出码（恒为 1）
 */
function reportImportError(err: unknown): number {
  if (err instanceof PackError) {
    console.error(t(`error.${err.code}`, { msg: err.message }));
    return 1;
  }
  console.error(t("error.unknown", { msg: err instanceof Error ? err.message : String(err) }));
  return 1;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

/**
 * 打印 importAssets 的结构化结果。
 *
 * 先打一行摘要（卡堆数 / 新增卡数 / 素材数 / 复制文件数），再逐卡堆、逐素材
 * 打纯数据行（新建还是更新用 t() 的 state 标签），最后是 dry-run 提示与 warnings。
 *
 * @param result importAssets 的返回值
 */
function printImportResult(result: ImportResult): void {
  const addedCards = result.decks.reduce((sum, deck) => sum + deck.addedCards, 0);
  const copiedFiles = [...result.decks, ...result.objects].reduce(
    (sum, item) => sum + item.copiedFiles.length,
    0,
  );
  console.log(
    t("cli.import.done", {
      decks: result.decks.length,
      cards: addedCards,
      objects: result.objects.length,
      files: copiedFiles,
    }),
  );

  for (const deck of result.decks) {
    console.log(
      t("cli.import.deck", {
        name: deck.name,
        dir: deck.deckDir,
        added: deck.addedCards,
        sheets: deck.sheets.length,
        state: t(deck.cardsCsvExisted ? "cli.import.stateUpdated" : "cli.import.stateCreated"),
      }),
    );
  }
  for (const object of result.objects) {
    console.log(
      t("cli.import.object", {
        type: object.type,
        name: object.name,
        assetId: object.assetId,
        state: t(object.assetIdExisted ? "cli.import.stateUpdated" : "cli.import.stateCreated"),
      }),
    );
  }

  if (result.dryRun) {
    console.log(t("cli.import.dryRunNote"));
  }
  for (const warning of result.warnings) {
    console.log(t("cli.import.warning", { message: warning }));
  }
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------

/**
 * `tts import <清单路径>`：调 importAssets 完成素材导入（--dry-run 只规划）。
 *
 * 清单路径必填；--pack 给出工作区根（缺省 "."，与在该工作区内直接执行等价）。
 * 全部业务错误（清单不合法 / 源文件缺失 / CMYK / 网格超容量…）由 importAssets
 * 抛 PackError，本层按错误码出口呈现（退出码 1）。
 */
export const importCommand: Command = new Command("import")
  .description(t("cli.command.import.description"))
  .argument("<manifest>", t("cli.command.import.argument.manifest"))
  .option("--pack <dir>", t("cli.command.import.option.pack"), ".")
  .option("--dry-run", t("cli.command.import.option.dryRun"), false)
  .action(async (manifest: string, opts: ImportCliOptions) => {
    try {
      const result = await importAssets({
        root: opts.pack,
        manifestPath: manifest,
        dryRun: opts.dryRun,
      });
      printImportResult(result);
    } catch (err) {
      process.exit(reportImportError(err));
    }
  });
