// src/safety/confirm.ts
/**
 * safety.confirm：写回 TTS 前的 CLI 交互式确认门（阶段 5"写入路径"的安全闸）。
 *
 * 用途：
 * push（工作区 → 运行中的 TTS）属于"改游戏内状态"的危险操作，执行前必须把
 * "将要写什么"亮给用户看，并拿到明确同意。本模块把这件事收敛为一个纯函数
 * {@link confirmPush}：给摘要与逐条差异，返回"是否放行"（boolean），不抛错、
 * 不自己执行任何写入——是否写、写什么，仍由调用方（阶段 5 的 push 命令）决定。
 *
 * 决策树（顺序固定，测试按此锁定）：
 * 1. 先无条件打印 message + details（包括 assumeYes 分支——调用方/日志必须能
 *    看到"已放行了什么"，这是 --yes 也绕不过的知情权）；
 * 2. `assumeYes === true`（--yes / -y）→ 打印后直接返回 true，不再询问；
 * 3. `nonInteractive === true` 或 stdout 不是 TTY（管道 / 重定向 / 守护进程）→
 *    打印非交互提示并返回 false——**写入路径宁可误拒，不猜默认值**；
 * 4. TTY 交互：打印提示语等待一行输入，`y` / `yes`（大小写不敏感、容忍首尾
 *    空白）→ true 并打印确认文案；其余（含空输入 / EOF）→ false 并打印取消文案。
 *
 * 注意分支 3 检测的是 **stdout** 的 isTTY：`printf 'yes\n' | tts push` 这种管道
 * 场景下 stdout 已不是终端，交互确认既不可见也不可信，必须走 nonInteractive
 * 取消（显式传 `assumeYes: true` 才能放行）。这与 src/cli/commands/vcs.ts 的
 * prompter（stdin 有数据即可答）刻意不同：vcs 的二次确认挡的是交互操作，这里
 * 挡的是写回游戏，门槛更高。
 *
 * readline 约定（沿袭 src/cli/commands/vcs.ts 的 createPrompter 模式）：
 * - 不用 `rl.question`——readline 在无 TTY / 管道输入下行为不一致（丢行），
 *   改为自挂 `line` 事件；本模块只问一句，"待消费行队列"退化为"先到先答"，
 *   即：问题抛出前已缓冲的行（用户提前敲入 / 管道送达）直接作为答案消费掉
 *   （等价于问题前的缓冲清理），答案之后的行全部丢弃，绝不漏给下一个提问者；
 * - rl 的生命周期用 try/finally 兜底关闭，EOF / 流关闭按空串（取消）结算，
 *   不让交互层把调用方挂死。
 *
 * 输出去向：全部走 `process.stdout.write`（不用 console.log，便于测试以
 * Object.defineProperty 替换 process.stdout 捕获输出；console 的内部绑定对
 * 运行时替换不保证可见）。
 *
 * 约束：
 * - 本模块只做"问与答"，不 import push / scripts 等写入模块（保持依赖方向：
 *   写入路径 → 安全门，反向依赖会造成环）；
 * - 不抛错：任何输入形状（空 message、undefined details、stdin 异常关闭）都
 *   归约为"打印 + 返回布尔"，写回流程的失败语义由调用方统一处理；
 * - details 展示上限 {@link MAX_DETAILS}（10 条），超出的折叠为一行计数提示，
 *   避免大图包（数百个对象）把确认屏刷成滚屏。
 *
 * 错误码：无（本模块不抛 PackError；所有分支都以 boolean 结算）。
 *
 * 本模块新增的 i18n 键（locales/*.json 由本地化步骤统一补齐；缺键时 t() 原样
 * 输出键名）：
 * - `cli.safety.confirm.prompt`        默认提示语（期望形如"确认执行以上写入？[y/N]"）
 * - `cli.safety.confirm.proceed`       用户答 y/yes 后的确认文案（期望形如"已确认，开始写入"）
 * - `cli.safety.confirm.aborted`       用户拒绝 / EOF 后的取消文案（期望形如"已取消，未写入任何内容"）
 * - `cli.safety.confirm.nonInteractive` 非交互环境下的取消提示
 * - `cli.safety.confirm.more` {count}  details 超过 10 条时的折叠行
 *   （期望形如"... 还有 {count} 条"；渲染时由本模块统一加两格缩进前缀）
 */

import { createInterface } from "node:readline";

import { t } from "../i18n/index.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** {@link confirmPush} 的入参 */
export interface ConfirmOptions {
  /** 摘要（多少对象、多少脚本、多少 UI），任何分支都会先原样打印这一行 */
  message: string;
  /** 逐条差异预览（每项一行）；缺省视为空列表，最多展示前 {@link MAX_DETAILS} 条 */
  details?: string[];
  /** --yes / -y：打印摘要后跳过询问直接放行（返回 true） */
  assumeYes?: boolean;
  /** 非交互环境显式声明：返回 false 并输出非交互提示（stdout 非 TTY 时即使不传也同效） */
  nonInteractive?: boolean;
  /** 自定义提示语；缺省用 `cli.safety.confirm.prompt` 的译文 */
  promptText?: string;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** details 展示上限：最多显示前 10 条，超出的折叠为一行计数提示 */
export const MAX_DETAILS = 10;

/** 用户确认接受的答案（比较前小写归一；y / yes 及其任意大小写形式） */
const ACCEPTED_ANSWERS: ReadonlySet<string> = new Set(["y", "yes"]);

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 向 stdout 写一行（自动补换行）。
 *
 * 用 `process.stdout?.write` 而非 console.log：守护进程等极端环境下 stdout
 * 可能为 null，此时静默丢输出也不该让确认门崩溃。
 * @param text - 行内容（不带换行符）
 */
function writeLine(text: string): void {
  process.stdout?.write(`${text}\n`);
}

/**
 * 打印摘要 + 逐条差异预览（决策树所有分支共用）。
 * @param message - 摘要行
 * @param details - 差异明细；超过 {@link MAX_DETAILS} 条时折叠
 */
function printSummary(message: string, details: readonly string[]): void {
  writeLine(message);
  for (const line of details.slice(0, MAX_DETAILS)) {
    writeLine(`  - ${line}`);
  }
  if (details.length > MAX_DETAILS) {
    writeLine(`  ${t("cli.safety.confirm.more", { count: details.length - MAX_DETAILS })}`);
  }
}

/**
 * 读一行用户输入（TTY 交互分支专用）。
 *
 * 实现（与 src/cli/commands/vcs.ts 的 createPrompter 同源，针对"只问一句"简化）：
 * - createInterface 绑定 `process.stdin` / `process.stdout`，自挂 `line` / `close`
 *   事件，不使用 `rl.question`（无 TTY 时行为不一致）；
 * - 先到先答：问题抛出前已缓冲的行直接作为答案（等价于问题前的缓冲清理）；
 *   答案确定后的后续行一律丢弃，不会漏给别的消费者；
 * - EOF / 流关闭 → 空串（调用方按"取消"结算），绝不悬挂；
 * - try/finally 保证 rl 无论哪条路径退出都会关闭。
 *
 * @param prompt - 提示语（不带换行，写在与用户输入同一行）
 * @returns 去除首尾空白的一行输入；EOF 时为空串
 */
async function askLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      let settled = false;
      rl.on("line", (line: string) => {
        if (settled) {
          return; // 答案已定：丢弃多余缓冲行
        }
        settled = true;
        resolve(line.trim());
      });
      rl.on("close", () => {
        if (!settled) {
          settled = true;
          resolve(""); // EOF / 流关闭：按空答案（取消）结算
        }
      });
      process.stdout?.write(prompt);
    });
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 交互式确认门：打印摘要与差异预览，按模块头注释的决策树返回"是否放行"。
 *
 * @param opts - 摘要 / 差异 / 交互选项，见 {@link ConfirmOptions}
 * @returns true = 调用方可以执行写回；false = 取消（用户拒绝 / 非交互环境）
 * @throws 不抛错——所有输入形状都归约为 boolean 结果
 */
export async function confirmPush(opts: ConfirmOptions): Promise<boolean> {
  // 1) 任何分支都先让用户（或日志）看到将要发生什么——--yes 也绕不过知情权
  printSummary(opts.message, opts.details ?? []);

  // 2) 显式 --yes：跳过询问直接放行
  if (opts.assumeYes === true) {
    return true;
  }

  // 3) 非交互：显式声明，或 stdout 不是 TTY（管道 / 重定向 / 守护进程）。
  //    写回路径宁可误拒：这里绝不猜默认值。
  if (opts.nonInteractive === true || process.stdout?.isTTY !== true) {
    writeLine(t("cli.safety.confirm.nonInteractive"));
    return false;
  }

  // 4) TTY 交互：y / yes（大小写不敏感、容忍首尾空白）放行，其余（含空 / EOF）取消
  const prompt = opts.promptText ?? t("cli.safety.confirm.prompt");
  const answer = await askLine(prompt);
  if (ACCEPTED_ANSWERS.has(answer.trim().toLowerCase())) {
    writeLine(t("cli.safety.confirm.proceed"));
    return true;
  }
  writeLine(t("cli.safety.confirm.aborted"));
  return false;
}
