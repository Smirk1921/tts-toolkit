// src/cli/commands/deck.ts
/**
 * `tts deck`：图集切片 / 拼接 / 原位拼回 / 替换计划 / 校验（阶段 2B）——
 * 把 Run 1 的 5 个 deck 模块接到 CLI 上。
 *
 * 子命令一览（本文件是薄调用层，业务逻辑一律在 src/deck/ 内）：
 * - `tts deck slice --sheet <图集> --save <存档> -o <目录>`          切片（sliceAtlas）
 * - `tts deck generate --deck <deck 目录> [-o <目录>]`               重新排版拼接（generateAtlas）
 * - `tts deck inplace --deck <deck 目录> --source <目录> [-o <目录>]` 原位拼回（inplaceAtlas）
 * - `tts deck plan --save <存档> --replace <from=to>`                替换计划 dry-run（planReplace）
 * - `tts deck verify [--root <图包根>]`                              工作区校验（verifyPack）
 *
 * 边界（重要，不要越界）：
 * - 本文件是薄分发层：不 import src/deck/ 之外的业务模块，所有校验 / IO 都在
 *   各 deck 模块内完成；`src/cli/index.ts` 只加一行 addCommand；
 * - **缺省输出目录**（CLI 契约只写了 `[-o <输出目录>]`，未规定缺省值；按本仓库
 *   已有约定裁决并在帮助文案里写明）：
 *   - generate 省略 -o → `<deck 目录>/source`（src/deck/verify.ts 对本地图集的
 *     兜底位置就是 `<deckDir>/source/sheet-<id>.png`；顶层 `sheets/` 需要
 *     packRoot，而 generate 只拿得到 deckDir，不猜 packRoot）；
 *   - inplace 省略 -o → 与 --source 相同（真正的"原位"回写；想保留原图集请显式
 *     指定 -o，源图集另有 git+lfs 兜底）；
 * - 共享图集交互（slice 特有，契约要求）：CLI 在 stdin 可读时**恒注入
 *   selectCandidate**（readline，队列式提示器）；sliceAtlas 只在候选 > 1 时调用。
 *   stdin 不可读（stdio: "ignore" 等）时不注入，由 sliceAtlas 抛
 *   SLICE_AMBIGUOUS（消息内含候选清单，退出码 1），不挂死；
 * - 错误处理：PackError 按 `` `error.${err.code}` `` 取文案（占位符 {msg}），
 *   其余异常统一走 error.unknown；两者都只写 stderr 并以退出码 1 结束
 *   （与 pack.ts 的 reportPackError 分工一致）；
 * - verify 的发现结果不是异常：issue 行（纯数据）与摘要写 stdout；
 *   errorCount > 0 时以 process.exitCode = 1 结束（便于 CI / 后续 vcs verify
 *   用作门禁），warning 不阻塞通过；"校验发现 N 错 M 警"仍算命令执行成功，
 *   不走 reportDeckError。
 *
 * 输出约定：每个子命令的摘要行是唯一承载文案的行（经 t()，写 stdout，单行）；
 * plan 的受影响条目行、verify 的 issue 行是纯数据（对象路径 / 字段 / URL /
 * code / 模块内已中文化的 message），不翻译、不承载文案，格式与 pack.ts 的
 * push / diff 清单行同一风格。
 *
 * 本模块使用的 i18n 键（locales/*.json；缺键时 t() 原样输出键名）：
 * - 静态：`cli.command.deck.*`（各子命令 description 与 option）、
 *   `cli.deck.slice.done` {cards} {outDir} {shared}、`cli.deck.slice.shared` {guids}、
 *   `cli.deck.slice.candidate` {index} {guid} {nickname} {numWidth} {numHeight}、
 *   `cli.deck.slice.prompt`、`cli.deck.slice.invalidChoice` {max}、
 *   `cli.deck.slice.cancelled`、`cli.deck.generate.done` {cards} {sheetCount} {sheets}、
 *   `cli.deck.generate.doneEmpty` {cards}、`cli.deck.inplace.done` {modified} {total}、
 *   `cli.deck.plan.done` {affected} {objects}、`cli.deck.verify.done`、
 *   `cli.deck.verify.summary` {errors} {warnings}、`cli.deck.invalidNumber` {option} {value}、
 *   `cli.deck.plan.invalidReplace` {value}、`cli.deck.plan.invalidMode` {mode}、
 *   `cli.deck.inplace.invalidModified` {value}、`error.unknown` {msg}；
 * - 动态（键 = `error.` + PackError.code，占位符 {msg}）：ATLAS_TOO_MANY_CELLS /
 *   ATLAS_GRID_TOO_FINE / ATLAS_INVALID_GRID / CARDS_* / OBJECTS_* / SLICE_* /
 *   GENERATE_* / INPLACE_* / PLAN_*（完整取值见各模块头注释）。
 */

import path from "node:path";
import { createInterface } from "node:readline";

import { Command } from "commander";

import { generateAtlas, type AtlasSize } from "../../deck/generate.js";
import { inplaceAtlas } from "../../deck/inplace.js";
import { planReplace, type ReplaceRule } from "../../deck/plan.js";
import { sliceAtlas, type DeckCandidate } from "../../deck/slice.js";
import { verifyPack } from "../../deck/verify.js";
import { t } from "../../i18n/index.js";
import { PackError } from "../../pack/packyaml.js";

// ---------------------------------------------------------------------------
// 选项类型（commander 已按 --kebab-case → camelCase 归一）
// ---------------------------------------------------------------------------

/** `tts deck slice` 的选项 */
interface DeckSliceOptions {
  /** 图集大图文件路径（必填） */
  sheet: string;
  /** 存档 JSON 路径（必填，用于解析图集归属） */
  save: string;
  /** 显式指定 CustomDeck key（跳过自动解析） */
  deckKey?: string;
  /** 显式指定牌堆对象 GUID（跳过自动解析） */
  deckGuid?: string;
  /** 输出目录（必填，即 deckDir） */
  out: string;
}

/** `tts deck generate` 的选项（数字型选项保持字符串，action 内再解析校验） */
interface DeckGenerateOptions {
  /** deck 目录（含 cards.csv 与卡图） */
  deck: string;
  /** 输出目录；缺省 `<deck 目录>/source` */
  out?: string;
  /** 单格边长像素（原始字符串，缺省由 generateAtlas 取 512） */
  cellSize?: string;
  /** 图集边长（原始字符串，缺省由 generateAtlas 取 "4096"） */
  atlasSize?: string;
  /** 网格列数（原始字符串；必须与 --rows 同时给出） */
  cols?: string;
  /** 网格行数（原始字符串；必须与 --cols 同时给出） */
  rows?: string;
}

/** `tts deck inplace` 的选项 */
interface DeckInplaceOptions {
  /** deck 目录（含 cards.csv 与卡图） */
  deck: string;
  /** 源图集目录（含 sheet-<id>.png） */
  source: string;
  /** 输出目录；缺省与 --source 相同（原地回写） */
  out?: string;
  /** 单格边长像素（原始字符串；缺省从源图集推断） */
  cellSize?: string;
  /** 显式改判的 CardID 列表（逗号分隔；缺省按 mtime 判定） */
  modified?: string;
}

/** `tts deck plan` 的选项 */
interface DeckPlanOptions {
  /** 存档 JSON 路径 */
  save: string;
  /** 单条替换规则，格式 `<from>=<to>` */
  replace: string;
  /** 匹配模式（commander 缺省填 "exact"） */
  mode: string;
}

/** `tts deck verify` 的选项（--no-* 选项在 commander 里是默认 true 的布尔值） */
interface DeckVerifyOptions {
  /** 图包根目录（默认 "."） */
  root: string;
  /** 是否检查 CMYK（--no-cmyk 时 false） */
  cmyk: boolean;
  /** 是否检查图集尺寸一致性（--no-atlas-size 时 false） */
  atlasSize: boolean;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * deck 子命令的统一错误出口。
 *
 * PackError 是按错误码分支的（如 "SLICE_AMBIGUOUS" / "GENERATE_GRID_INVALID"），
 * 对应 `error.<code>` 文案（占位符 {msg}）；其余异常（入参校验、fs / sharp
 * 原生错误、readline 取消等）统一走 `error.unknown`。两者都只写 stderr，
 * 绝不向 stdout 混入错误信息。
 *
 * @param err 命令 action 中捕获的异常
 * @returns 建议的进程退出码（恒为 1，与 CLI 其他命令一致）
 */
function reportDeckError(err: unknown): number {
  if (err instanceof PackError) {
    console.error(t(`error.${err.code}`, { msg: err.message }));
    return 1;
  }
  console.error(t("error.unknown", { msg: err instanceof Error ? err.message : String(err) }));
  return 1;
}

/**
 * 解析正整数选项值（cellSize / cols / rows）。
 *
 * commander 声明里保持字符串，统一在这里收窄：非整数 / <1 立即抛中文用法
 * 错误（与 pack.ts 的 parseLfs 同风格），不把 "abc" / "1.5" 塞给模块。
 *
 * @param raw 命令行原始值
 * @param optionName 选项名（用于错误信息，如 "--cell-size"）
 * @returns 正整数
 * @throws Error 值不是正整数时
 */
function parsePositiveInt(raw: string, optionName: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(t("cli.deck.invalidNumber", { option: optionName, value: raw }));
  }
  return value;
}

/**
 * 解析 `--modified` 的逗号分隔 CardID 列表。
 *
 * 空串 / 全空白 → 空数组（sliceAtlas 语义：空数组 = mtime 模式）；任一条目
 * 不是正整数立即抛错，绝不静默丢弃。
 *
 * @param raw 命令行原始值
 * @returns 正整数 CardID 数组（可能为空）
 * @throws Error 任一条目不是正整数时
 */
function parseCardIds(raw: string): number[] {
  const parts = raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
  const ids: number[] = [];
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(t("cli.deck.inplace.invalidModified", { value: raw }));
    }
    ids.push(value);
  }
  return ids;
}

/**
 * 解析 `--replace <from>=<to>`。
 *
 * 以**第一个** `=` 分割（规则格式本身有歧义，取最常见约定；URL 里带 `=` 的
 * 查询串需要调用方自行规避）。from 为空 / 没有 `=` → 用法错误。
 *
 * @param raw 命令行原始值
 * @returns 单条替换规则（未带 mode，由 action 补齐）
 * @throws Error 格式非法时
 */
function parseReplace(raw: string): ReplaceRule {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    throw new Error(t("cli.deck.plan.invalidReplace", { value: raw }));
  }
  return { from: raw.slice(0, separator), to: raw.slice(separator + 1) };
}

/**
 * 校验 `--mode` 取值。
 * @param raw 命令行原始值
 * @returns 合法模式
 * @throws Error 不是 exact / prefix / regex 时
 */
function parseMode(raw: string): "exact" | "prefix" | "regex" {
  if (raw === "exact" || raw === "prefix" || raw === "regex") {
    return raw;
  }
  throw new Error(t("cli.deck.plan.invalidMode", { mode: raw }));
}

// ---------------------------------------------------------------------------
// 共享图集交互（slice 特有）：readline 候选选择
// ---------------------------------------------------------------------------

/** 命令内复用的交互提示器 */
interface Prompter {
  /**
   * 提问并读一行。
   * @param question 提示语（已翻译）
   * @returns 去除首尾空白的输入；EOF / 流关闭时返回空串（调用方按"取消"处理）
   */
  ask(question: string): Promise<string>;
  /** 关闭底层 readline 接口 */
  close(): void;
}

/**
 * 创建交互提示器。
 *
 * 实现要点（踩过的坑）：不能直接用 `rl.question` 逐个提问——readline 在没有
 * pending question 时会丢掉已到达的行。管道输入（`printf '2\n' | tts deck slice …`）
 * 一次性送达时第二行会被丢弃，表现为"输入无效后立刻取消"。
 * 因此这里自己维护"待消费行队列 + 等待者队列"：line 事件先喂等待者，没人等就入队，
 * 下个提问直接取队列，EOF 时统一按空串（取消）唤醒。
 *
 * （与 src/cli/commands/config.ts / src/pack/init.ts 的 createPrompter 是同一份
 * 实现；按仓库约定命令层模块之间不互相 import，三处如需调整必须同步修改。）
 *
 * @returns 提示器；调用方负责在结束时 {@link Prompter.close}
 */
function createPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  /** 已到达但尚无提问消费的行 */
  const pendingLines: string[] = [];
  /** 正在等待输入的提问回调 */
  const waiters: Array<(line: string) => void> = [];
  let closed = false;

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(trimmed);
      return;
    }
    pendingLines.push(trimmed);
  });
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter("");
    }
  });

  return {
    ask(question: string): Promise<string> {
      process.stdout.write(question);
      const buffered = pendingLines.shift();
      if (buffered !== undefined) {
        return Promise.resolve(buffered);
      }
      if (closed) {
        return Promise.resolve("");
      }
      return new Promise<string>((resolve) => {
        waiters.push(resolve);
      });
    },
    close(): void {
      rl.close();
    },
  };
}

/**
 * stdin 是否还可读（决定能否弹交互提示）。
 *
 * 不要求 isTTY：管道 / 重定向（`printf '1\n' | tts deck slice …`）也应能选编号；
 * child_process 以 stdio: "ignore" 启动时 stdin 会被销毁，此时不注入
 * selectCandidate，让 sliceAtlas 走 SLICE_AMBIGUOUS 报错而不是挂死。
 *
 * @returns stdin 可读返回 true
 */
function canPrompt(): boolean {
  return process.stdin.readable === true && process.stdin.destroyed !== true;
}

/**
 * 渲染一行候选（契约格式）：
 * `[1] GUID=a1b2c3 Nickname=军争包 (NumWidth=10, NumHeight=7)`；
 * Nickname 缺失时省略该段。
 *
 * @param candidate 候选项
 * @param index 0 基下标（显示时 +1）
 * @returns 单行候选文本
 */
function formatCandidate(candidate: DeckCandidate, index: number): string {
  const nickname = candidate.nickname === undefined ? "" : ` Nickname=${candidate.nickname}`;
  return t("cli.deck.slice.candidate", {
    index: index + 1,
    guid: candidate.guid,
    nickname,
    numWidth: candidate.numWidth,
    numHeight: candidate.numHeight,
  });
}

/**
 * 列出候选并让用户选编号（1-N），返回所选候选。
 *
 * 非法输入（非整数 / 越界）重新提问；空输入（回车 / EOF）视为取消，抛普通
 * 中文错误（由 reportDeckError 走 error.unknown，退出码 1）。
 *
 * @param prompter 命令内复用的提示器
 * @param candidates 候选项列表（sliceAtlas 保证非空且 >1）
 * @returns 用户选中的候选
 * @throws Error 用户取消时
 */
async function chooseCandidate(
  prompter: Prompter,
  candidates: readonly DeckCandidate[],
): Promise<DeckCandidate> {
  candidates.forEach((candidate, index) => {
    console.log(formatCandidate(candidate, index));
  });
  for (;;) {
    const answer = await prompter.ask(t("cli.deck.slice.prompt"));
    if (answer === "") {
      throw new Error(t("cli.deck.slice.cancelled"));
    }
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= candidates.length) {
      const chosen = candidates[index - 1];
      if (chosen !== undefined) {
        return chosen;
      }
    }
    console.log(t("cli.deck.slice.invalidChoice", { max: candidates.length }));
  }
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------

/**
 * `tts deck slice`：把图集切成卡图并按存档归属登记 cards.csv（sliceAtlas）。
 *
 * 归属解析优先级、共享检测、隐藏面 / 背面规则全部在 src/deck/slice.ts；
 * 本命令只负责把选项翻译成 SliceOptions 并在候选 >1 时用 readline 让用户选。
 * 摘要行按契约示例拼出 `（共享图集：<GUID 列表>）`（无共享时省略）。
 */
const sliceSub = new Command("slice")
  .description(t("cli.command.deck.slice.description"))
  .requiredOption("--sheet <file>", t("cli.command.deck.slice.option.sheet"))
  .requiredOption("--save <file>", t("cli.command.deck.slice.option.save"))
  .option("--deck-key <key>", t("cli.command.deck.slice.option.deckKey"))
  .option("--deck-guid <guid>", t("cli.command.deck.slice.option.deckGuid"))
  .requiredOption("-o, --out <dir>", t("cli.command.deck.slice.option.out"))
  .action(async (opts: DeckSliceOptions) => {
    // stdin 不可读时不注入 selector：由 sliceAtlas 抛 SLICE_AMBIGUOUS（含候选清单）
    const prompter = canPrompt() ? createPrompter() : undefined;
    try {
      const result = await sliceAtlas({
        sheetPath: opts.sheet,
        savePath: opts.save,
        ...(opts.deckKey === undefined ? {} : { deckKey: opts.deckKey }),
        ...(opts.deckGuid === undefined ? {} : { deckGuid: opts.deckGuid }),
        outDir: opts.out,
        ...(prompter === undefined
          ? {}
          : { selectCandidate: (candidates: DeckCandidate[]) => chooseCandidate(prompter, candidates) }),
      });
      const shared =
        result.sharedWith.length === 0
          ? ""
          : t("cli.deck.slice.shared", { guids: result.sharedWith.join(", ") });
      console.log(t("cli.deck.slice.done", { cards: result.cardsSliced, outDir: opts.out, shared }));
    } catch (err) {
      process.exit(reportDeckError(err));
    } finally {
      prompter?.close();
    }
  });

/**
 * `tts deck generate`：按 cards.csv 重新排版拼接成图集（generateAtlas）。
 *
 * 缺省输出目录 `<deck 目录>/source`（见模块头注释"缺省输出目录"）；
 * cellSize / cols / rows 在 CLI 侧收窄为正整数，atlasSize / 成对性 / 网格范围
 * 交给 generateAtlas（错误码 GENERATE_*）。
 */
const generateSub = new Command("generate")
  .description(t("cli.command.deck.generate.description"))
  .requiredOption("--deck <dir>", t("cli.command.deck.generate.option.deck"))
  .option("-o, --out <dir>", t("cli.command.deck.generate.option.out"))
  .option("--cell-size <n>", t("cli.command.deck.generate.option.cellSize"))
  .option("--atlas-size <size>", t("cli.command.deck.generate.option.atlasSize"))
  .option("--cols <n>", t("cli.command.deck.generate.option.cols"))
  .option("--rows <n>", t("cli.command.deck.generate.option.rows"))
  .action(async (opts: DeckGenerateOptions) => {
    try {
      const outDir =
        opts.out !== undefined && opts.out !== "" ? opts.out : path.join(opts.deck, "source");
      const result = await generateAtlas({
        deckDir: opts.deck,
        outDir,
        ...(opts.cellSize === undefined
          ? {}
          : { cellSize: parsePositiveInt(opts.cellSize, "--cell-size") }),
        // atlasSize 的取值校验在 generateAtlas（枚举 512/1024/2048/4096）
        ...(opts.atlasSize === undefined ? {} : { atlasSize: opts.atlasSize as AtlasSize }),
        ...(opts.cols === undefined ? {} : { columns: parsePositiveInt(opts.cols, "--cols") }),
        ...(opts.rows === undefined ? {} : { rows: parsePositiveInt(opts.rows, "--rows") }),
      });
      if (result.sheets.length === 0) {
        console.log(t("cli.deck.generate.doneEmpty", { cards: result.totalCards }));
        return;
      }
      // 每张图集拼成纯数据片段 `sheet-1.png, 10x7`，多张以 "; " 连接
      const sheets = result.sheets
        .map((sheet) => `${path.basename(sheet.filePath)}, ${sheet.columns}x${sheet.rows}`)
        .join("; ");
      console.log(
        t("cli.deck.generate.done", {
          cards: result.totalCards,
          sheetCount: result.sheets.length,
          sheets,
        }),
      );
    } catch (err) {
      process.exit(reportDeckError(err));
    }
  });

/**
 * `tts deck inplace`：把改过的卡图按 cards.csv 原位拼回源图集（inplaceAtlas）。
 *
 * 缺省输出目录与 --source 相同（真正的"原位"回写）；--modified 走显式改判模式，
 * 省略 / 空串则按卡图 mtime 严格晚于源图集判定。摘要把各图集的改 / 总数求和。
 */
const inplaceSub = new Command("inplace")
  .description(t("cli.command.deck.inplace.description"))
  .requiredOption("--deck <dir>", t("cli.command.deck.inplace.option.deck"))
  .requiredOption("--source <dir>", t("cli.command.deck.inplace.option.source"))
  .option("-o, --out <dir>", t("cli.command.deck.inplace.option.out"))
  .option("--cell-size <n>", t("cli.command.deck.inplace.option.cellSize"))
  .option("--modified <ids>", t("cli.command.deck.inplace.option.modified"))
  .action(async (opts: DeckInplaceOptions) => {
    try {
      const outDir = opts.out !== undefined && opts.out !== "" ? opts.out : opts.source;
      const result = await inplaceAtlas({
        deckDir: opts.deck,
        sourceDir: opts.source,
        outDir,
        ...(opts.cellSize === undefined
          ? {}
          : { cellSize: parsePositiveInt(opts.cellSize, "--cell-size") }),
        ...(opts.modified === undefined ? {} : { modifiedCardIds: parseCardIds(opts.modified) }),
      });
      const modified = result.sheets.reduce((sum, sheet) => sum + sheet.modifiedCount, 0);
      const total = result.sheets.reduce((sum, sheet) => sum + sheet.totalCount, 0);
      console.log(t("cli.deck.inplace.done", { modified, total }));
    } catch (err) {
      process.exit(reportDeckError(err));
    }
  });

/**
 * `tts deck plan`：预览 URL 替换计划（planReplace，dry-run 不写任何文件）。
 *
 * 每次调用只带一条规则（契约签名如此），`--mode` 作用于该规则；条目行是纯数据，
 * 逐条列出 objectPath / 字段路径 / 新旧值（后续 vcs verify 的祖先），末行摘要
 * 给出影响处数与涉及对象数（按 objectPath 去重）。
 */
const planSub = new Command("plan")
  .description(t("cli.command.deck.plan.description"))
  .requiredOption("--save <file>", t("cli.command.deck.plan.option.save"))
  .requiredOption("--replace <from=to>", t("cli.command.deck.plan.option.replace"))
  .option("--mode <mode>", t("cli.command.deck.plan.option.mode"), "exact")
  .action(async (opts: DeckPlanOptions) => {
    try {
      const rule: ReplaceRule = { ...parseReplace(opts.replace), mode: parseMode(opts.mode) };
      const result = await planReplace({ savePath: opts.save, rules: [rule] });
      for (const entry of result.entries) {
        console.log(
          `  ${entry.objectPath}  ${entry.fieldPath.join(".")}  ${entry.currentValue} → ${entry.newValue}`,
        );
      }
      const objects = new Set(result.entries.map((entry) => entry.objectPath)).size;
      console.log(t("cli.deck.plan.done", { affected: result.totalAffected, objects }));
    } catch (err) {
      process.exit(reportDeckError(err));
    }
  });

/**
 * `tts deck verify`：只读校验图包工作区（verifyPack）。
 *
 * issue 行（纯数据，message 由 verify.ts 写死中文）逐条写 stdout，末行摘要：
 * `校验通过`（ok）或 `校验发现 N 错 M 警`；有 error 时以退出码 1 结束（门禁语义），
 * warning 不阻塞。--no-cmyk / --no-atlas-size 只关掉需要读图的检查。
 */
const verifySub = new Command("verify")
  .description(t("cli.command.deck.verify.description"))
  .option("--root <dir>", t("cli.command.deck.verify.option.root"), ".")
  .option("--no-cmyk", t("cli.command.deck.verify.option.cmyk"))
  .option("--no-atlas-size", t("cli.command.deck.verify.option.atlasSize"))
  .action(async (opts: DeckVerifyOptions) => {
    try {
      const result = await verifyPack({
        packRoot: opts.root,
        checkCmyk: opts.cmyk,
        checkAtlasSize: opts.atlasSize,
      });
      for (const issue of result.issues) {
        console.log(`  [${issue.severity}] ${issue.code}  ${issue.message}  (${issue.location})`);
      }
      console.log(
        result.ok
          ? t("cli.deck.verify.done")
          : t("cli.deck.verify.summary", {
              errors: result.errorCount,
              warnings: result.warningCount,
            }),
      );
      if (!result.ok) {
        process.exitCode = 1;
      }
    } catch (err) {
      process.exit(reportDeckError(err));
    }
  });

// ---------------------------------------------------------------------------
// 主命令
// ---------------------------------------------------------------------------

/** `tts deck` 主命令：5 个子命令在上方定义后统一挂载（薄分发层，无自身 action） */
export const deckCommand: Command = new Command("deck").description(t("cli.command.deck.description"));

deckCommand.addCommand(sliceSub);
deckCommand.addCommand(generateSub);
deckCommand.addCommand(inplaceSub);
deckCommand.addCommand(planSub);
deckCommand.addCommand(verifySub);
