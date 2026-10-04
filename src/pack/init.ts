// src/pack/init.ts
/**
 * tts pack init 的核心逻辑：图包工作区初始化（{@link initPack}）。
 *
 * 执行流程（与设计一致；注意 pack.yaml 的 vcs.lfs 取值来自 lfs 决策，
 * 且 `git lfs install` 需要先有 git 仓库才能装上仓库级钩子，故实际写盘顺序是
 * 目录骨架 → git init → lfs 决策 → pack.yaml → .gitattributes → .gitignore）：
 *
 * 1. 入参校验（unknown + zod；dir 下已存在 pack.yaml 时抛 PACK_EXISTS——
 *    "取消后重跑补完"的前提正是上次没有写出 pack.yaml）；
 * 2. {@link ensureLayout} 建目录骨架（scripts/ui/decks/objects/sheets/source/.tts + .gitkeep）；
 * 3. git init（skipGit=true 跳过；失败抛 GIT_INIT_FAILED）；
 * 4. git-lfs 三选一决策（约束 10：绝不静默降级，见 {@link decideLfs}）：
 *    - opts.lfs 显式给定（"enabled" / "disabled"）→ 直接采用，不探测不安装；
 *    - opts.skipLfsPrompt → "disabled-no-lfs"（测试 / 管道等非交互场景）；
 *    - 否则探测 `git lfs version`：已装 → `git lfs install` → "enabled"；
 *      未装且 stdout 是 TTY → 交互菜单（安装 / 禁用需二次确认 / 取消）；
 *      未装且非 TTY → console.warn 后记 "disabled-no-lfs"；
 * 5. 用户取消（菜单选 3 / 直接回车 / EOF / 二次确认拒绝 / 选安装但仍未装）→
 *    返回 lfsChoice="skipped"：不写 pack.yaml（vcs.lfs 必填且无默认值），
 *    也不写 .gitattributes / .gitignore；目录骨架与 git 仓库已建出，重新运行即可续完；
 * 6. 写 pack.yaml（经 {@link writePackYaml} 落盘：schema_version=1 / name /
 *    workshop_id=null / source_mod=null / host="steamcloud" / vcs.lfs=决策值 /
 *    paths.workdir="." / upload.prefix=""）；
 * 7. lfs="enabled" 时写 .gitattributes（图片 / obj / ttsmod 走 lfs filter）；
 *    .gitignore 无论 lfs 与否都写（约束 8：.tts/skeleton.json 绝不入 git）。
 *
 * 错误码（{@link PackError.code}）：
 * - "PACK_EXISTS"            目标目录已存在 pack.yaml（已是图包工作区）
 * - "GIT_INIT_FAILED"        git init 失败（git 未安装、权限不足等）
 * - "GIT_LFS_INSTALL_FAILED" 检测到 git-lfs 已装但 `git lfs install` 失败
 * - 其余 fs 错误（目录创建 / .gitattributes / .gitignore 写入）原样向上抛，
 *   由 CLI 层呈现（与 src/pack/layout.ts 的错误契约一致）。
 *
 * 本模块新增的 i18n 键（locales/*.json 由 Run 2 补齐；缺键时 t() 原样输出键名。
 * 括号内是应填入 locales/zh-CN.json 的文案，供 Run 2 照抄）：
 * - `cli.pack.init.lfsPromptTitle`    「未检测到 git-lfs。图包图片是二进制，不用 lfs 改 10 轮可能几十 GB。」
 * - `cli.pack.init.lfsOptionInstall`  「  1. 安装 git-lfs（推荐）：{url}」
 * - `cli.pack.init.lfsOptionDisable`  「  2. 禁用 lfs（不推荐）」
 * - `cli.pack.init.lfsOptionCancel`   「  3. 取消」
 * - `cli.pack.init.lfsPrompt`         「请输入编号后回车（1-3，直接回车取消）：」
 * - `cli.pack.init.lfsInvalidChoice`  「输入无效：请输入 1 到 {max} 之间的编号」
 * - `cli.pack.init.lfsDisableConfirm` 「确定禁用？改 10 轮可能几十 GB (y/N)」
 * - `cli.pack.init.lfsInstallHint`    「请先安装 git-lfs（{url}），然后重新运行 tts pack init 完成初始化」
 * - `cli.pack.init.lfsCancelled`      「已取消：图包初始化未完成（尚未写入 pack.yaml），重新运行 tts pack init 可继续」
 * - `cli.pack.init.lfsNonInteractive` 「未检测到 git-lfs，且当前不是交互式终端：已按 disabled-no-lfs 禁用 lfs。图包图片是二进制，不用 lfs 改 10 轮可能几十 GB，建议安装 git-lfs（{url}）后重新初始化」
 * - `error.pack.exists`               「初始化目标已是图包工作区（已存在 pack.yaml）：{path}」
 * - `error.pack.gitInitFailed`        「git 仓库初始化失败：{detail}」
 * - `error.pack.lfsInstallFailed`     「git lfs install 失败：{detail}」
 *
 * 设计边界：
 * - 本模块不 import src/cli/commands/*：交互提示器与 src/cli/commands/config.ts
 *   的实现是同款（队列式 readline，防"管道输入先到、问题后问被丢掉"），按仓库
 *   惯例复制粘贴维护，两处如需调整必须同步修改；
 * - initPack 不打印"初始化完成"之类的汇总信息（CLI 层负责），只输出 lfs 决策
 *   必需的菜单 / 警告 / 取消说明；
 * - 显式 opts.lfs 时不再探测 / 安装 git-lfs：调用方自行保证环境与选择一致，
 *   pack.yaml 如实记录用户的显式决定（这是约束 10"显式三选一"的本意）；
 * - skipGit 只跳过 git init，不影响 lfs 决策（lfs 探测 / 安装照常进行）。
 */

import { execFile } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { z } from "zod";

import { t } from "../i18n/index.js";
import { ensureLayout } from "./layout.js";
import { PackError, packYamlPath, writePackYaml, type PackYaml } from "./packyaml.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** promisify 后的 execFile：git / git-lfs 子进程统一入口 */
const execFileAsync = promisify(execFile);

/** git-lfs 官网地址（安装菜单与提示文案里出现） */
const LFS_INSTALL_URL = "https://git-lfs.github.com/";

/** .gitattributes 文件名（lfs=enabled 时写在图包根） */
const GITATTRIBUTES_FILENAME = ".gitattributes";

/** .gitignore 文件名（无论 lfs 与否都写在图包根） */
const GITIGNORE_FILENAME = ".gitignore";

/**
 * .gitattributes 的各行内容（lfs=enabled 时写入）。
 * 覆盖图包里全部二进制素材：图片（png/jpg/jpeg/gif/webp）、3D 模型（obj）、
 * TTS 模组包（.ttsmod，本身是 ZIP）。
 */
const GITATTRIBUTES_LINES: readonly string[] = Object.freeze([
  "*.png filter=lfs diff=lfs merge=lfs -text",
  "*.jpg filter=lfs diff=lfs merge=lfs -text",
  "*.jpeg filter=lfs diff=lfs merge=lfs -text",
  "*.gif filter=lfs diff=lfs merge=lfs -text",
  "*.webp filter=lfs diff=lfs merge=lfs -text",
  "*.obj filter=lfs diff=lfs merge=lfs -text",
  "*.ttsmod filter=lfs diff=lfs merge=lfs -text",
]);

/**
 * .gitignore 的各行内容（无论 lfs 与否都写入）。
 * 约束 8：骨架存档 .tts/skeleton.json 是离线回路关键中间产物，绝不入 git；
 * .tts/.gitkeep 不在排除之列（它是保住 .tts/ 目录结构的占位文件，应当入库）。
 */
const GITIGNORE_LINES: readonly string[] = Object.freeze([
  ".tts/skeleton.json",
  ".tts/baseline.json",
  ".tts/cache/",
  ".tts/backups/",
  "node_modules/",
  "dist/",
]);

/** .gitattributes 落盘内容（LF 换行 + 末尾换行） */
const GITATTRIBUTES_CONTENT = `${GITATTRIBUTES_LINES.join("\n")}\n`;

/** .gitignore 落盘内容（LF 换行 + 末尾换行） */
const GITIGNORE_CONTENT = `${GITIGNORE_LINES.join("\n")}\n`;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * git-lfs 三选一的决策结果（{@link InitResult.lfsChoice} 的取值）。
 *
 * - "enabled"         启用 lfs（已探测安装，或用户显式指定）
 * - "disabled"        用户在交互菜单里显式选择禁用（经二次确认），或显式传 opts.lfs="disabled"
 * - "disabled-no-lfs" 未装 git-lfs 的非交互降级：非 TTY / skipLfsPrompt
 * - "skipped"         用户取消了 lfs 三选一：初始化中止，pack.yaml 未写出，可重跑续完
 */
export type LfsChoice = "enabled" | "disabled" | "disabled-no-lfs" | "skipped";

/** initPack 入参 */
export interface InitOptions {
  /** 目标目录（不存在则创建；目录下已有 pack.yaml 时抛 PACK_EXISTS） */
  dir: string;
  /** 图包名；缺省取 `basename(resolve(dir))`（显式给出空串 / 全空白时同样回退） */
  name?: string;
  /** 显式指定 lfs 决策并跳过探测与交互（约束 10 的非交互出口之一） */
  lfs?: "enabled" | "disabled";
  /** 跳过 git init（测试用；不影响 lfs 决策） */
  skipGit?: boolean;
  /** 跳过 lfs 探测与交互，等价 lfs="disabled-no-lfs"（测试 / 非交互管道） */
  skipLfsPrompt?: boolean;
}

/** initPack 结果 */
export interface InitResult {
  /** 图包根目录（path.resolve 后的绝对路径） */
  packRoot: string;
  /** pack.yaml 是否已写出（lfsChoice="skipped" 时为 false） */
  packYamlWritten: boolean;
  /** 是否执行了 git init（skipGit=true 时为 false） */
  gitInitialized: boolean;
  /** git-lfs 三选一决策结果（约束 10；"skipped" 表示被取消，初始化未完成） */
  lfsChoice: LfsChoice;
}

// ---------------------------------------------------------------------------
// zod 校验（initPack 入参来自 CLI / 外部调用方，按约束 unknown + zod 校验）
// ---------------------------------------------------------------------------

/**
 * initPack 入参根 schema 的中文化 error 定制（与 packyaml.ts 的 strictObjectError
 * 同款考虑：error 传静态字符串会让 unrecognized_keys 也显示根消息，必须用函数区分）。
 * @param issue zod 原始 issue
 * @returns 中文错误描述
 */
function initOptionsError(issue: z.core.$ZodRawIssue): string {
  // unrecognized_keys 类 issue 携带 keys: PropertyKey[]；其余（根类型错误）没有
  const keys = (issue as { keys?: unknown }).keys;
  if (Array.isArray(keys)) {
    return `initPack 入参含有无法识别的字段：${keys.map((key) => String(key)).join("、")}`;
  }
  return "initPack 入参必须是键值对象";
}

/** initPack 入参结构 schema（严格模式：未知键一律拒绝，防拼写错误静默生效） */
const initOptionsSchema = z.strictObject(
  {
    dir: z.string({ error: "dir 必须是非空字符串路径" }),
    name: z.string({ error: "name 必须是字符串" }).optional(),
    lfs: z.enum(["enabled", "disabled"], {
      error: "lfs 必须是 enabled 或 disabled（disabled-no-lfs 只能由非交互路径产生）",
    }).optional(),
    skipGit: z.boolean({ error: "skipGit 必须是布尔值" }).optional(),
    skipLfsPrompt: z.boolean({ error: "skipLfsPrompt 必须是布尔值" }).optional(),
  },
  { error: initOptionsError },
);

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 将 zod 校验错误格式化为单行中文可读摘要。
 * （与 src/pack/packyaml.ts 的同名内部函数一致。）
 * @param error zod 校验错误对象
 * @returns 形如 "lfs：必须是 enabled 或 disabled" 的描述，多个问题以"；"连接
 */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const segments = issue.path.map((seg) => (typeof seg === "symbol" ? seg.toString() : String(seg)));
      const where = segments.length > 0 ? segments.join(".") : "(根)";
      return `${where}：${issue.message}`;
    })
    .join("；");
}

/**
 * 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT），避免 any。
 * @param err 任意抛出值
 * @returns 字符串形式的 code；取不到时返回 undefined
 */
function errCode(err: unknown): string | undefined {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

/**
 * 从 unknown 错误中提取适合放进错误信息的细节（优先子进程 stderr）。
 * @param err 任意抛出值（通常是 execFile 的失败）
 * @returns 有 stderr 时返回去首尾空白后的 stderr，否则返回 message / String()
 */
function execDetail(err: unknown): string {
  if (err instanceof Error) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim() !== "") {
      return stderr.trim();
    }
    return err.message;
  }
  return String(err);
}

/**
 * 校验并规范化 initPack 入参（类型 + 空串防御）。
 * @param options 调用方传入的原始入参
 * @returns 校验通过的入参（原值，不做拷贝 / 改写）
 * @throws options 不符合 {@link initOptionsSchema}，或 dir 是空串 / 全空白时
 *   抛出中文 Error（调用方编程错误，按仓库惯例不走 PackError）
 */
function parseInitOptions(options: InitOptions): InitOptions {
  const parsed = initOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new Error(`initPack 入参无效（${formatZodError(parsed.error)}）`);
  }
  if (parsed.data.dir.trim() === "") {
    throw new Error("initPack 入参无效：dir 必须是非空字符串路径");
  }
  return parsed.data;
}

/**
 * 判断目录下是否已存在 pack.yaml（PACK_EXISTS 的判据）。
 * @param root 图包根目录
 * @returns pack.yaml 已存在时 true
 * @throws stat 抛出 ENOENT / ENOTDIR 以外的错误时原样向上抛
 *   （ENOENT = 不存在；ENOTDIR = root 本身是文件，同样视作"没有 pack.yaml"，
 *   后续 ensureLayout 会以原始 fs 错误失败）
 */
async function packYamlExists(root: string): Promise<boolean> {
  try {
    await stat(packYamlPath(root));
    return true;
  } catch (err) {
    const code = errCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 交互提示器（与 src/cli/commands/config.ts 的 createPrompter 同款）
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
 * pending question 时会丢掉已到达的行。管道输入（`printf '2\ny\n' | tts pack init`）
 * 一次性送达两行时，第二行会被丢弃，表现为"输入无效后立刻取消"。
 * 因此这里自己维护"待消费行队列 + 等待者队列"：line 事件先喂等待者，没人等就入队，
 * 下个提问直接取队列，EOF 时统一按空串（取消）唤醒。
 *
 * （与 src/cli/commands/config.ts 的 createPrompter 是同一份实现；本模块按约定
 * 不 import 命令层代码，两处如需调整必须同步修改。）
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

// ---------------------------------------------------------------------------
// git / git-lfs 子进程
// ---------------------------------------------------------------------------

/**
 * 探测 git-lfs 是否已安装（`git lfs version` 能跑通即视为已装）。
 * @param cwd 工作目录（须已存在；探测本身与是否在 git 仓库内无关）
 * @returns 已安装时 true；命令失败 / git 未安装时 false（探测失败不算错误）
 */
async function isGitLfsInstalled(cwd: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["lfs", "version"], { cwd, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 在当前仓库执行 `git lfs install`（装全局 filter 配置 + 仓库级钩子）。
 * @param cwd 图包根目录（此时 git init 已完成，是一个 git 仓库）
 * @throws PackError code="GIT_LFS_INSTALL_FAILED" 命令失败时
 */
async function runGitLfsInstall(cwd: string): Promise<void> {
  try {
    await execFileAsync("git", ["lfs", "install"], { cwd, windowsHide: true });
  } catch (err) {
    throw new PackError(
      "GIT_LFS_INSTALL_FAILED",
      t("error.pack.lfsInstallFailed", { detail: execDetail(err) }),
    );
  }
}

/**
 * 在图包根目录执行 `git init`。
 * @param dir 图包根目录（ensureLayout 之后必然存在）
 * @throws PackError code="GIT_INIT_FAILED" git 未安装或命令失败时
 */
async function runGitInit(dir: string): Promise<void> {
  try {
    await execFileAsync("git", ["init"], { cwd: dir, windowsHide: true });
  } catch (err) {
    throw new PackError("GIT_INIT_FAILED", t("error.pack.gitInitFailed", { detail: execDetail(err) }));
  }
}

// ---------------------------------------------------------------------------
// git-lfs 三选一决策（约束 10）
// ---------------------------------------------------------------------------

/**
 * 交互菜单：未检测到 git-lfs 时的三选一（装 / 禁用二次确认 / 取消）。
 *
 * 选项语义：
 * - 1（安装）：此刻重新探测一次（可能已在别的终端装好）——已装则 `git lfs install`
 *   并返回 "enabled"；仍未装则打印官网地址并返回 "skipped"（重跑本命令续完）；
 * - 2（禁用）：二次确认（y/N）通过返回 "disabled"，未通过返回 "skipped"；
 * - 3（取消）/ 直接回车 / EOF：返回 "skipped"；
 * - 其他输入：提示后重新提问（循环直到得到有效选择或取消）。
 *
 * @param dir 图包根目录（探测 / 安装 lfs 的工作目录）
 * @returns 决策结果（不会返回 "disabled-no-lfs"——那是非交互路径的取值）
 */
async function promptLfsChoice(dir: string): Promise<LfsChoice> {
  const prompter = createPrompter();
  try {
    console.log(t("cli.pack.init.lfsPromptTitle"));
    console.log(t("cli.pack.init.lfsOptionInstall", { url: LFS_INSTALL_URL }));
    console.log(t("cli.pack.init.lfsOptionDisable"));
    console.log(t("cli.pack.init.lfsOptionCancel"));
    for (;;) {
      const answer = await prompter.ask(t("cli.pack.init.lfsPrompt"));
      // 直接回车 / EOF（流关闭）：按取消处理，绝不静默替用户做决定
      if (answer === "") {
        return "skipped";
      }
      if (answer === "1") {
        if (await isGitLfsInstalled(dir)) {
          await runGitLfsInstall(dir);
          return "enabled";
        }
        console.log(t("cli.pack.init.lfsInstallHint", { url: LFS_INSTALL_URL }));
        return "skipped";
      }
      if (answer === "2") {
        // 约束 10：禁用必须二次确认，未通过视同取消
        const confirm = (await prompter.ask(t("cli.pack.init.lfsDisableConfirm"))).toLowerCase();
        if (confirm === "y" || confirm === "yes") {
          return "disabled";
        }
        return "skipped";
      }
      if (answer === "3") {
        return "skipped";
      }
      console.log(t("cli.pack.init.lfsInvalidChoice", { max: 3 }));
    }
  } finally {
    prompter.close();
  }
}

/**
 * git-lfs 三选一决策（约束 10 的实现，决策优先级见模块头注释）。
 * @param dir 图包根目录（探测 / 安装 lfs 的工作目录）
 * @param opts 已校验的 initPack 入参
 * @returns 决策结果；"skipped" 表示用户取消，调用方应中止初始化
 */
async function decideLfs(dir: string, opts: InitOptions): Promise<LfsChoice> {
  // 1) 显式指定：直接采用（不探测、不安装）
  if (opts.lfs !== undefined) {
    return opts.lfs;
  }
  // 2) 跳过交互（测试 / 非交互管道）
  if (opts.skipLfsPrompt === true) {
    return "disabled-no-lfs";
  }
  // 3) 探测 git-lfs：已装即安装钩子并启用
  if (await isGitLfsInstalled(dir)) {
    await runGitLfsInstall(dir);
    return "enabled";
  }
  // 4) 未装 + 非 TTY：无法交互，降级为 disabled-no-lfs，但必须发出警告
  if (process.stdout.isTTY !== true) {
    console.warn(t("cli.pack.init.lfsNonInteractive", { url: LFS_INSTALL_URL }));
    return "disabled-no-lfs";
  }
  // 5) 未装 + TTY：三选一交互菜单
  return promptLfsChoice(dir);
}

// ---------------------------------------------------------------------------
// 导出函数：initPack
// ---------------------------------------------------------------------------

/**
 * 初始化图包工作区（`tts pack init` 的核心逻辑，流程见模块头注释）。
 *
 * 可重入性：
 * - dir 下已有 pack.yaml → PACK_EXISTS（防止覆盖已有图包的元数据）；
 * - 上次运行在 lfs 三选一处被取消（lfsChoice="skipped"）→ pack.yaml 未写出，
 *   重跑不会命中 PACK_EXISTS，目录骨架 / git 仓库按幂等语义补齐后续步骤。
 *
 * @param opts 初始化选项（见 {@link InitOptions}）
 * @returns 初始化结果（见 {@link InitResult}）；被取消时 packYamlWritten=false
 * @throws Error opts 不符合 schema，或 dir 是空串 / 全空白时（调用方编程错误）
 * @throws PackError code="PACK_EXISTS" dir 下已存在 pack.yaml 时
 * @throws PackError code="GIT_INIT_FAILED" git init 失败时（skipGit=true 不触发）
 * @throws PackError code="GIT_LFS_INSTALL_FAILED" 探测到 git-lfs 但安装失败时
 * @throws fs 错误（ensureLayout 建目录 / .gitattributes / .gitignore 写入失败）
 *   原样向上抛出，由 CLI 层决定如何呈现
 */
export async function initPack(opts: InitOptions): Promise<InitResult> {
  const options = parseInitOptions(opts);
  const packRoot = path.resolve(options.dir);

  // 1. 已是图包工作区 → 拒绝（判据：pack.yaml 已存在）
  if (await packYamlExists(packRoot)) {
    throw new PackError("PACK_EXISTS", t("error.pack.exists", { path: packRoot }));
  }

  // 2. 目录骨架（幂等）
  await ensureLayout(packRoot);

  // 3. git init（skipGit=true 跳过；先于 lfs 决策，`git lfs install` 需要仓库）
  let gitInitialized = false;
  if (options.skipGit !== true) {
    await runGitInit(packRoot);
    gitInitialized = true;
  }

  // 4. git-lfs 三选一（约束 10）
  const lfsChoice = await decideLfs(packRoot, options);
  if (lfsChoice === "skipped") {
    // 用户取消：pack.yaml（vcs.lfs 必填无默认值）与后续文件一律不写，留待重跑
    console.log(t("cli.pack.init.lfsCancelled"));
    return { packRoot, packYamlWritten: false, gitInitialized, lfsChoice };
  }

  // 5. pack.yaml（此处 lfsChoice 已收窄为 pack.yaml schema 允许的三值）
  const manifest: PackYaml = {
    schema_version: 1,
    name: options.name !== undefined && options.name.trim() !== ""
      ? options.name
      : path.basename(packRoot),
    workshop_id: null,
    source_mod: null,
    host: "steamcloud",
    vcs: { lfs: lfsChoice },
    paths: { workdir: "." },
    upload: { prefix: "" },
  };
  await writePackYaml(packRoot, manifest);

  // 6. .gitattributes（仅 lfs=enabled）
  if (lfsChoice === "enabled") {
    await writeFile(path.join(packRoot, GITATTRIBUTES_FILENAME), GITATTRIBUTES_CONTENT, "utf8");
  }

  // 7. .gitignore（无论 lfs 与否；约束 8：骨架存档绝不入 git）
  await writeFile(path.join(packRoot, GITIGNORE_FILENAME), GITIGNORE_CONTENT, "utf8");

  return { packRoot, packYamlWritten: true, gitInitialized, lfsChoice };
}
