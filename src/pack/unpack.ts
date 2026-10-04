// src/pack/unpack.ts
/**
 * unpackSave：从存档 JSON 或 .ttsmod 离线建图包工作区（全程不连接 TTS）。
 *
 * 流程（与设计文档一致）：
 * 1. 输入定位：`.ttsmod`（ZIP，PK 头）先用 pwsh 调 .NET
 *    `System.IO.Compression.ZipFile::ExtractToDirectory` 解包到临时目录，
 *    取 `Mods/Workshop/*.json` 中字典序第一个作为存档 JSON，并把
 *    `Mods/Models/*` 复制到 `<outDir>/source/models/`（若有）；
 *    `.json` 输入直接作为存档 JSON。
 * 2. 读取校验：自己 `JSON.parse` 原始存档文本并校验 `ObjectStates` 是数组。
 * 3. 调 @tts-tools/savefile 的 `readSave` + `extractSave` 把存档拆分到临时目录：
 *    `<tmpExtract>/Script.ttslua`（全局 Lua）、`UI.xml`（全局 XML）、
 *    `Data.json`（Global 对象数据）、`<目录名>.<GUID>/`（每个顶层对象一目录，
 *    内含 Data.json 与可选的 Script.ttslua / UI.xml）。
 * 4. 骨架存档（约束 8）：完整原始存档 JSON（2 空格缩进）写入
 *    `<outDir>/.tts/skeleton.json`——这是 pack/build.ts 定点替换的依据，
 *    绝不入 git（由图包 .gitignore 排除）。
 * 5. 整理工作区（详见 {@link unpackSave}）。
 *
 * 三个与 @tts-tools/savefile 实测行为对齐的关键取舍（不要凭直觉"优化"掉）：
 * - `readSave` 的返回值里所有数字字段被 `">>floating-point<<…"` 字符串包装
 *   （防 JSON 精度丢失的内部机制，extractSave 只在写 Data.json 时还原）——
 *   因此骨架存档必须来自对原始文本的 JSON.parse，绝不能用 readSave 的返回值
 *   stringify，否则污染会被写进 build.ts 的替换基准；
 * - `extractSave` 会把每份 Data.json 里的 LuaScript / LuaScriptState / XmlUI /
 *   ContainedObjects / ObjectStates / States / ChildObjects 全部剥离
 *   （库内 HANDLED_KEYS），脚本与 UI 单独写成 Script.ttslua / UI.xml——
 *   因此工作区的脚本 / UI 从这两个文件读取，而不是从 Data.json 读字段；
 * - 解压产物的目录名是 `<Nickname||Name>.<GUID>`（重名追加 `.2`），其中
 *   非法字符被替换为 `-`（非 ASCII 名会被替换成 `----`）——因此绝不解析
 *   目录名，一律读目录内 Data.json 的 GUID / Name 字段；
 * - 空 GUID 对象（工坊原包尚未在游戏里存过档——实测 sample_diceset.ttsmod
 *   的 11 个对象 GUID 均为空串）：落盘主干退化为纯净化名（layout 的
 *   {@link sanitizeName}），重名依处理顺序追加 ".2" / ".3" … 去重，data.json
 *   如实保留空 GUID（不合成占位值，见 {@link materializeWorkspace}）。
 *
 * 由此 objects|decks 的 data.json 不复制解压产物的 Data.json（它不"完整"），
 * 而是按 GUID 从原始存档取完整对象（含 ContainedObjects / CustomDeck /
 * LuaScriptState 等）——阶段 2B 的共用遍历器（约束 9）才有可用的对象全量数据。
 *
 * 其他约定：
 * - pack.yaml 复用 {@link writePackYaml} 写入；vcs.lfs 固定 "disabled-no-lfs"——
 *   unpack 是非交互离线流程，约束 10（git-lfs 显式三选一）属于 tts init 命令，
 *   不在这里做；
 * - `!opts.skipGit` 且 `<outDir>/.git` 不存在时跑 git init；git 失败抛
 *   UNPACK_FAILED 显式报错（不静默降级）；.git 已存在（目录或 worktree 文件）
 *   时跳过；
 * - 只遍历 extractSave 产物第一层的对象目录（States / ContainedObjects 的嵌套
 *   目录不展开——嵌套全量数据已在 data.json 与 skeleton.json 里）；这层
 *   "每个对象一个目录（data.json + 素材）"的对称结构就是给约束 9 遍历器
 *   预留的接口；
 * - 牌堆判定：Name 含 "Deck"（不区分大小写，覆盖 Deck / DeckCustom）或含
 *   CustomDeck 字段；牌堆落 decks/ 并生成 deck.yaml 骨架（cards 为空数组）。
 *   GUID 不满足 deck.yaml 的六位十六进制约束时只落 data.json、跳过 deck.yaml
 *   （显式约定而非静默失败，避免个别 GUID 让整包解包中断）；
 * - 临时目录（.ttsmod 解包目录、extractSave 输出目录）在 finally 里 rm -rf 清理。
 *
 * 错误码（{@link PackError.code}）：
 * - "SAVE_INVALID"    存档 JSON 不存在 / 不是合法 JSON / 缺 ObjectStates
 * - "TTSMOD_INVALID"  .ttsmod 不是 ZIP / 解压失败 / 没有 Mods/Workshop/*.json
 * - "UNPACK_FAILED"   其余失败（extractSave 产物异常、写盘失败、git init 失败等）
 *
 * 本模块新增的 i18n 键（locales/*.json 由 Run 2 补齐；缺键时 t() 原样输出键名）：
 * - `error.pack.unpack.inputMissing` {path}
 * - `error.pack.unpack.saveInvalid` {path} {detail}
 * - `error.pack.unpack.ttsmodNotZip` {path}
 * - `error.pack.unpack.ttsmodExtractFailed` {path} {detail}
 * - `error.pack.unpack.ttsmodNoSave` {path}
 * - `error.pack.unpack.failed` {detail}
 *
 * zod 各字段的 issue 文案按仓库既有风格写死中文（参见 src/pack/packyaml.ts），
 * 只作为 {@link formatZodError} 摘要的数据部分出现，不单独面向用户，故不走 t()。
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { extractSave, readSave } from "@tts-tools/savefile";
import { z } from "zod";

import { t } from "../i18n/index.js";
import { GLOBAL_GUID } from "../protocol/messages.js";
import {
  decksDir,
  ensureLayout,
  objectsDir,
  sanitizeName,
  scriptsDir,
  scriptFileName,
  skeletonPath,
  uiDir,
  uiFileName,
} from "./layout.js";
import { writeDeckManifest, type DeckManifest } from "./manifest.js";
import { PackError, writePackYaml, type PackYaml } from "./packyaml.js";

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** unpackSave 的入参 */
export interface UnpackOptions {
  /** 输入：存档 JSON（.json）或 .ttsmod 包（ZIP）路径 */
  savePath: string;
  /** 输出：图包工作区根目录（不存在时创建，已存在时覆盖写入同名文件） */
  outDir: string;
  /** 图包名（pack.yaml 的 name）；缺省取存档 SaveName，两者皆空时为空字符串 */
  name?: string;
  /** 跳过 git init（默认 false：outDir 下无 .git 时执行 git init） */
  skipGit?: boolean;
}

/** unpackSave 的返回值 */
export interface UnpackResult {
  /** 图包工作区根目录（path.resolve 后的绝对路径） */
  packRoot: string;
  /** 写入 scripts/ 的 Lua 文件数（含 Global.lua） */
  scriptsWritten: number;
  /** 写入 ui/ 的 XML 文件数（含 Global.xml） */
  uiWritten: number;
  /** 写入 objects/ 与 decks/ 的对象目录数（牌堆计入其中） */
  objectsWritten: number;
  /** .tts/skeleton.json（骨架存档）是否已落盘 */
  skeletonWritten: boolean;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** ZIP 文件的魔数前缀 "PK"（.ttsmod 是 ZIP，PK\x03\x04 起头） */
const ZIP_MAGIC = [0x50, 0x4b] as const;

/**
 * deck.yaml 对 GUID 的六位十六进制约束（与 src/pack/manifest.ts 的
 * GUID_PATTERN 语义一致；manifest 未导出该常量，此处按值对齐并保持同步）。
 * 不满足的牌堆 GUID 只落 data.json、跳过 deck.yaml（见模块头注释）。
 */
const DECK_GUID_PATTERN = /^[0-9a-f]{6}$/i;

/** extractSave 产物里全局脚本文件名（库内固定写法，实测验证过） */
const GLOBAL_SCRIPT_FILE = "Script.ttslua";

/** extractSave 产物里全局 / 对象 UI 文件名（库内固定写法，实测验证过） */
const UI_FILE = "UI.xml";

/** extractSave 产物里对象数据文件名（库内固定写法，实测验证过） */
const OBJECT_DATA_FILE = "Data.json";

// ---------------------------------------------------------------------------
// zod 校验（运行时边界统一 unknown + zod，禁止 any）
// ---------------------------------------------------------------------------

/**
 * 存档 JSON 的最小结构校验（只校验解包关心的字段；完整原始存档另作骨架用，
 * 不做严格 schema——存档字段成百上千，严格校验只会误伤）。
 */
const saveLikeSchema = z.object(
  {
    SaveName: z.string({ error: "SaveName 必须是字符串" }).optional(),
    ObjectStates: z.array(z.unknown(), { error: "ObjectStates 必须是对象数组" }),
  },
  { error: "存档 JSON 必须是键值对象" },
);

/**
 * extractSave 产物中对象 Data.json 的最小结构校验
 * （只需 GUID / Name 定位与命名；其余字段在原始存档里另有完整副本）。
 */
const extractedObjectSchema = z.object(
  {
    GUID: z.string({ error: "对象的 GUID 必须是字符串" }),
    Name: z.string({ error: "对象的 Name 必须是字符串" }),
    Nickname: z.string({ error: "对象的 Nickname 必须是字符串" }).optional(),
  },
  { error: "对象的 Data.json 必须是键值对象" },
);

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** promisify 后的 execFile（.ttsmod 解包与 git init 共用） */
const execFileP = promisify(execFile);

/**
 * 将 zod 校验错误格式化为单行中文可读摘要。
 * （与 src/pack/packyaml.ts 的同名内部函数一致；各模块各自持有，不跨模块导出。）
 * @param error zod 校验错误对象
 * @returns 形如 "ObjectStates：必须是对象数组" 的描述，多个问题以"；"连接
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
 * 从 unknown 错误中取人类可读描述；子进程错误（promisify(execFile) 的产物）
 * 额外拼接 stderr，避免只留下一句 "Command failed: …" 丢失关键原因。
 * @param err 任意抛出值
 * @returns Error 取 message（含 stderr 时附加），其余用 String() 兜底
 */
function errMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && stderr.trim() !== "") {
    return `${err.message}（stderr：${stderr.trim()}）`;
  }
  return err.message;
}

/**
 * 把任意值转成 PowerShell 单引号字面量（单引号内只需把 ' 翻倍，其余字符原样）。
 * @param value 待引用的字符串（路径等）
 * @returns 形如 `'D:\a b\x.ttsmod'` 的 PS 字面量
 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 路径存在性（文件 / 目录 / worktree 的 .git 文件都算存在） */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 路径指向普通文件时返回 true（不存在或其他错误一律 false） */
async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/** 路径指向目录时返回 true（不存在或其他错误一律 false） */
async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 计算对象在工作区里的目录 / 文件名主干：`<guid>.<净化名>`（Global 为 "Global"）。
 *
 * 复用 layout 的 {@link scriptFileName} 推导：它无条件以 ".lua" 结尾，
 * 去掉这最后一段扩展名即得主干；{@link uiFileName}(guid, name) 恒等于
 * 主干 + ".xml"，故 scripts / ui / objects / decks 四处的命名天然一致。
 *
 * 空 GUID 退化：工坊原包（尚未在游戏里存过档）的对象没有 GUID——实测
 * sample_diceset.ttsmod 的 11 个对象 GUID 均为空串。此时主干退化为纯净化名
 * {@link sanitizeName}(name)（不带 "guid." 前缀）；重名冲突（如包里两个都叫
 * "D8" 的骰子）由 {@link materializeWorkspace} 的 usedStems 去重兜底。
 * @param guid 对象 GUID（"-1" 表示全局，返回 "Global"；空串 / 全空白视作无 GUID）
 * @param name 对象显示名（Nickname 优先，回退 Name；内部已净化）
 * @returns 文件名主干（不含扩展名）
 */
function objectStem(guid: string, name: string): string {
  if (guid.trim() === "") {
    return sanitizeName(name);
  }
  return scriptFileName(guid, name).replace(/\.lua$/, "");
}

/**
 * 判断对象是否牌堆：Name 含 "Deck"（不区分大小写，覆盖 Deck / DeckCustom），
 * 或含 CustomDeck 字段（自定义牌堆的卡面定义，extractSave 不会剥离它）。
 * @param name 对象的 Name 字段（模板名，不是 Nickname）
 * @param raw 解析出的对象 Data.json 原始值
 * @returns 是牌堆时返回 true
 */
function isDeckLike(name: string, raw: unknown): boolean {
  if (/deck/i.test(name)) {
    return true;
  }
  return raw !== null && typeof raw === "object" && Object.hasOwn(raw, "CustomDeck");
}

/**
 * 在原始存档的 ObjectStates 里按 GUID 找完整对象。
 * @param states 原始存档的 ObjectStates（unknown 数组，元素不信任）
 * @param guid 目标 GUID
 * @returns 命中的对象（只可能是非数组键值对象）；找不到返回 undefined
 */
function findOriginalObject(states: readonly unknown[], guid: string): Record<string, unknown> | undefined {
  for (const state of states) {
    if (state !== null && typeof state === "object" && !Array.isArray(state)) {
      const record = state as Record<string, unknown>;
      if (record.GUID === guid) {
        return record;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 内部步骤：.ttsmod 解包
// ---------------------------------------------------------------------------

/**
 * 校验文件确为 ZIP（读前 2 字节比对 "PK" 魔数）。
 * @param file .ttsmod 文件路径
 * @throws PackError code="TTSMOD_INVALID" 文件不存在（inputMissing 文案）、
 *   无法读取或缺少 PK 头（ttsmodNotZip 文案）时
 */
async function assertZipFile(file: string): Promise<void> {
  let buffer: Buffer;
  try {
    const handle = await open(file, "r");
    try {
      buffer = Buffer.alloc(2);
      await handle.read(buffer, 0, 2, 0);
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      throw new PackError("TTSMOD_INVALID", t("error.pack.unpack.inputMissing", { path: file }));
    }
    throw new PackError("TTSMOD_INVALID", t("error.pack.unpack.ttsmodNotZip", { path: file }));
  }
  if (buffer.length < 2 || buffer[0] !== ZIP_MAGIC[0] || buffer[1] !== ZIP_MAGIC[1]) {
    throw new PackError("TTSMOD_INVALID", t("error.pack.unpack.ttsmodNotZip", { path: file }));
  }
}

/**
 * 用 pwsh 调 .NET ZipFile 把 .ttsmod 解包到目标目录（约定走 pwsh 7，
 * 见全局 AGENTS 约定；路径经 {@link psQuote} 引用，防空格 / 引号注入）。
 * @param modPath .ttsmod 文件路径
 * @param destDir 解包目标目录（须为已存在的空目录，mkdtemp 产物满足）
 * @throws PackError code="TTSMOD_INVALID" pwsh 不存在或解压失败时
 */
async function extractTtsmod(modPath: string, destDir: string): Promise<void> {
  const script =
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
    `[System.IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(modPath)}, ${psQuote(destDir)})`;
  try {
    await execFileP("pwsh", ["-NoProfile", "-Command", script]);
  } catch (err) {
    throw new PackError(
      "TTSMOD_INVALID",
      t("error.pack.unpack.ttsmodExtractFailed", { path: modPath, detail: errMessage(err) }),
    );
  }
}

/**
 * 递归收集解包目录下所有 Mods/Workshop/*.json（相对路径按 / 归一后匹配，
 * 兼容 ZIP 条目里可能出现的反斜杠目录分隔）。
 * @param base 解包根目录
 * @returns 命中文件按字典序排序后的绝对路径列表（保证多命中时结果确定）
 */
async function findWorkshopSaves(base: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = path.relative(base, full).split(path.sep).join("/");
      if (/^Mods\/Workshop\/[^/]+\.json$/i.test(rel)) {
        found.push(full);
      }
    }
  };
  await walk(base);
  return found.sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// 内部步骤：读原始存档
// ---------------------------------------------------------------------------

/** 原始存档解析结果（骨架与完整对象数据的唯一可信来源） */
interface OriginalSave {
  /** 完整原始存档（JSON.parse 原文，未做任何字段包装） */
  raw: Record<string, unknown>;
  /** SaveName（缺失或非字符串时为空串） */
  saveName: string;
  /** ObjectStates（已保证是数组） */
  states: readonly unknown[];
}

/**
 * 读取并解析存档 JSON（不经 readSave——其返回值带 floating-point 包装，
 * 见模块头注释），校验最小结构后原样返回。
 * @param saveJsonPath 存档 JSON 路径（.ttsmod 输入时位于临时解包目录内）
 * @returns 解析结果
 * @throws PackError code="SAVE_INVALID" 文件不存在、读取失败、JSON 非法或
 *   缺 ObjectStates 数组时
 */
async function readOriginalSave(saveJsonPath: string): Promise<OriginalSave> {
  let text: string;
  try {
    text = await readFile(saveJsonPath, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      throw new PackError("SAVE_INVALID", t("error.pack.unpack.inputMissing", { path: saveJsonPath }));
    }
    throw new PackError(
      "SAVE_INVALID",
      t("error.pack.unpack.saveInvalid", { path: saveJsonPath, detail: errMessage(err) }),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PackError(
      "SAVE_INVALID",
      t("error.pack.unpack.saveInvalid", { path: saveJsonPath, detail: errMessage(err) }),
    );
  }

  const checked = saveLikeSchema.safeParse(parsed);
  if (!checked.success) {
    throw new PackError(
      "SAVE_INVALID",
      t("error.pack.unpack.saveInvalid", { path: saveJsonPath, detail: formatZodError(checked.error) }),
    );
  }

  // safeParse 通过即保证 parsed 是非空键值对象且 ObjectStates 是数组；
  // 这里保留"原始 parsed"而非 schema 输出（后者会剥离未知字段）
  const raw = parsed as Record<string, unknown>;
  const saveName = typeof raw.SaveName === "string" ? raw.SaveName : "";
  return { raw, saveName, states: raw.ObjectStates as unknown[] };
}

// ---------------------------------------------------------------------------
// 内部步骤：整理 extractSave 产物到工作区
// ---------------------------------------------------------------------------

/** 工作区落盘计数 */
interface WorkspaceCounts {
  scripts: number;
  ui: number;
  objects: number;
}

/**
 * 把 extractSave 产物整理进图包工作区（模块头注释第 5 步的完整实现）：
 * - 全局脚本 / UI（extractDir 根的 Script.ttslua / UI.xml）→ scripts/Global.lua、
 *   ui/Global.xml；
 * - extractDir 第一层的每个对象目录（含 Data.json）：
 *   Script.ttslua → scripts/<主干>.lua；UI.xml → ui/<主干>.xml；
 *   完整对象 JSON（按 GUID 从原始存档取）→ objects|decks/<主干>/data.json；
 *   牌堆另生成 deck.yaml 骨架。
 * - 主干（{@link objectStem}）全对象唯一：预占 "Global"（全局脚本 / UI 命名
 *   空间），重复时追加 ".2" / ".3" …（与 extractSave 产物目录名的重名追加
 *   约定一致）——空 GUID 重名对象（工坊原包，如两个都叫 "D8" 的骰子）因此
 *   不会互相覆盖。
 *
 * @param outDir 图包根目录（布局必须已由 ensureLayout 创建）
 * @param extractDir extractSave 的输出目录
 * @param states 原始存档的 ObjectStates（完整对象数据来源）
 * @returns 落盘计数
 * @throws PackError code="UNPACK_FAILED" 对象 Data.json 缺失字段 / 非法 JSON、
 *   或写盘失败时
 */
async function materializeWorkspace(
  outDir: string,
  extractDir: string,
  states: readonly unknown[],
): Promise<WorkspaceCounts> {
  const counts: WorkspaceCounts = { scripts: 0, ui: 0, objects: 0 };
  // scripts / ui 是全对象共享目录，objects 与 decks 的子目录同样不允许重名：
  // 主干占用表（预占 "Global"，防止空 GUID 对象恰好叫 "Global" 时覆盖全局脚本）
  const usedStems = new Set<string>(["Global"]);

  // —— 全局脚本 / UI（Global，GUID=-1；缺失时不生成空文件，与 tts pull 一致）——
  const globalScriptSrc = path.join(extractDir, GLOBAL_SCRIPT_FILE);
  if (await isFile(globalScriptSrc)) {
    await writeFile(
      path.join(scriptsDir(outDir), scriptFileName(GLOBAL_GUID, "Global")),
      await readFile(globalScriptSrc, "utf8"),
      "utf8",
    );
    counts.scripts += 1;
  }
  const globalUiSrc = path.join(extractDir, UI_FILE);
  if (await isFile(globalUiSrc)) {
    await writeFile(
      path.join(uiDir(outDir), uiFileName(GLOBAL_GUID, "Global")),
      await readFile(globalUiSrc, "utf8"),
      "utf8",
    );
    counts.ui += 1;
  }

  // —— 第一层对象目录（States / ContainedObjects 的嵌套目录不展开）——
  const entries = await readdir(extractDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const objectDir = path.join(extractDir, entry.name);
    const dataFile = path.join(objectDir, OBJECT_DATA_FILE);
    if (!(await isFile(dataFile))) {
      continue; // 非对象目录（extractSave 产物里理论上不会出现，防御性跳过）
    }

    // 解析产物 Data.json 只为拿 GUID / Name 与牌堆判定（脚本等字段已被库剥离）
    let rawObject: unknown;
    try {
      rawObject = JSON.parse(await readFile(dataFile, "utf8"));
    } catch (err) {
      throw new PackError(
        "UNPACK_FAILED",
        t("error.pack.unpack.failed", { detail: `${dataFile}：${errMessage(err)}` }),
      );
    }
    const parsedObject = extractedObjectSchema.safeParse(rawObject);
    if (!parsedObject.success) {
      throw new PackError(
        "UNPACK_FAILED",
        t("error.pack.unpack.failed", { detail: `${dataFile}：${formatZodError(parsedObject.error)}` }),
      );
    }
    const guid = parsedObject.data.GUID;
    const displayName =
      typeof parsedObject.data.Nickname === "string" && parsedObject.data.Nickname.length > 0
        ? parsedObject.data.Nickname
        : parsedObject.data.Name;
    // 主干去重：正常 GUID 天然唯一（循环一次都不进），空 GUID 重名对象依
    // 处理顺序追加 ".2" / ".3" …（readdir 顺序不定，不假设具体哪个拿原名）
    const baseStem = objectStem(guid, displayName);
    let stem = baseStem;
    let suffix = 2;
    while (usedStems.has(stem)) {
      stem = `${baseStem}.${suffix}`;
      suffix += 1;
    }
    usedStems.add(stem);

    // 完整对象 JSON：按 GUID 从原始存档取（产物 Data.json 缺 LuaScript /
    // ContainedObjects 等关键字段）；按构造必能命中，命中失败时退回产物文本
    const original = findOriginalObject(states, guid);
    const dataText =
      original !== undefined ? JSON.stringify(original, null, 2) : await readFile(dataFile, "utf8");

    const isDeck = isDeckLike(parsedObject.data.Name, rawObject);
    const targetDir = path.join(isDeck ? decksDir(outDir) : objectsDir(outDir), stem);
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, "data.json"), dataText, "utf8");
    counts.objects += 1;

    // 脚本 / UI（缺文件不生成空文件，与 tts pull 一致）：用去重后的主干命名，
    // 与 data.json 所在子目录严格同主干（guid 正常时等价于 scriptFileName /
    // uiFileName 的结果，空 GUID 时避免了它们的空 guid 抛错）
    const scriptSrc = path.join(objectDir, GLOBAL_SCRIPT_FILE);
    if (await isFile(scriptSrc)) {
      await writeFile(
        path.join(scriptsDir(outDir), `${stem}.lua`),
        await readFile(scriptSrc, "utf8"),
        "utf8",
      );
      counts.scripts += 1;
    }
    const uiSrc = path.join(objectDir, UI_FILE);
    if (await isFile(uiSrc)) {
      await writeFile(
        path.join(uiDir(outDir), `${stem}.xml`),
        await readFile(uiSrc, "utf8"),
        "utf8",
      );
      counts.ui += 1;
    }

    // deck.yaml 骨架（GUID 不满足六位十六进制约束时跳过，见模块头注释）
    if (isDeck && DECK_GUID_PATTERN.test(guid)) {
      const deckManifest: DeckManifest = {
        schema_version: 1,
        name: displayName,
        guid,
        shared_with: [],
        cards: [],
      };
      await writeDeckManifest(targetDir, deckManifest);
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 从存档 JSON 或 .ttsmod 离线建图包工作区（流程与取舍见模块头注释）。
 *
 * @param opts 入参（savePath / outDir 必填）
 * @returns 落盘结果（packRoot 为 resolve 后的绝对路径；skeletonWritten 恒为
 *   true——骨架写失败会抛错而不是带 false 返回）
 * @throws PackError code="SAVE_INVALID" 存档 JSON 不存在 / 非法 / 缺
 *   ObjectStates 时
 * @throws PackError code="TTSMOD_INVALID" .ttsmod 不是 ZIP / 解压失败 /
 *   没有 Mods/Workshop/*.json 时
 * @throws PackError code="UNPACK_FAILED" extractSave 产物异常、写盘失败、
 *   git init 失败等其余错误时
 * @throws Error savePath / outDir 不是非空字符串时（调用方编程错误）
 */
export async function unpackSave(opts: UnpackOptions): Promise<UnpackResult> {
  if (typeof opts?.savePath !== "string" || opts.savePath.trim() === "") {
    throw new Error("unpack 入参无效：savePath 必须是非空字符串");
  }
  if (typeof opts?.outDir !== "string" || opts.outDir.trim() === "") {
    throw new Error("unpack 入参无效：outDir 必须是非空字符串");
  }

  const savePath = path.resolve(opts.savePath);
  const outDir = path.resolve(opts.outDir);
  const isTtsmod = /\.ttsmod$/i.test(savePath);

  let zipDir: string | undefined;
  let extractDir: string | undefined;
  try {
    // —— 1. 输入定位：.ttsmod 先解包取存档 JSON ——
    let saveJsonPath = savePath;
    let modelsDir: string | undefined;
    if (isTtsmod) {
      await assertZipFile(savePath);
      zipDir = await mkdtemp(path.join(os.tmpdir(), "tts-toolkit-ttsmod-"));
      await extractTtsmod(savePath, zipDir);
      const candidates = await findWorkshopSaves(zipDir);
      if (candidates.length === 0) {
        throw new PackError("TTSMOD_INVALID", t("error.pack.unpack.ttsmodNoSave", { path: savePath }));
      }
      saveJsonPath = candidates[0];
      const models = path.join(zipDir, "Mods", "Models");
      if (await isDirectory(models)) {
        modelsDir = models;
      }
    }

    // —— 2. 读原始存档（校验 + 骨架与完整对象数据的来源）——
    const original = await readOriginalSave(saveJsonPath);

    // —— 3. readSave + extractSave 拆分到临时目录（库的正规入口，负责 unbundle）——
    extractDir = await mkdtemp(path.join(os.tmpdir(), "tts-toolkit-unpack-"));
    try {
      extractSave(readSave(saveJsonPath), { output: extractDir });
    } catch (err) {
      throw new PackError(
        "UNPACK_FAILED",
        t("error.pack.unpack.failed", { detail: `extractSave：${errMessage(err)}` }),
      );
    }

    // —— 4. 布局 + 骨架存档（约束 8：完整原始存档，build.ts 定点替换的依据）——
    await ensureLayout(outDir);
    await writeFile(skeletonPath(outDir), JSON.stringify(original.raw, null, 2), "utf8");

    // —— 5. 整理产物到工作区 ——
    const counts = await materializeWorkspace(outDir, extractDir, original.states);

    // —— 6. .ttsmod 自带的模型素材 → source/models ——
    if (modelsDir !== undefined) {
      await cp(modelsDir, path.join(outDir, "source", "models"), { recursive: true });
    }

    // —— 7. pack.yaml（lfs 固定 disabled-no-lfs：unpack 不做约束 10 的交互）——
    const packName = (opts.name ?? "").trim() || original.saveName.trim();
    const packYaml: PackYaml = {
      schema_version: 1,
      name: packName,
      workshop_id: null,
      source_mod: null,
      host: "steamcloud",
      vcs: { lfs: "disabled-no-lfs" },
      paths: { workdir: "." },
      upload: { prefix: "" },
    };
    await writePackYaml(outDir, packYaml);

    // —— 8. git init（.git 已存在时跳过；失败显式报错不静默降级）——
    if (opts.skipGit !== true && !(await pathExists(path.join(outDir, ".git")))) {
      try {
        await execFileP("git", ["init"], { cwd: outDir });
      } catch (err) {
        throw new PackError(
          "UNPACK_FAILED",
          t("error.pack.unpack.failed", { detail: `git init：${errMessage(err)}` }),
        );
      }
    }

    return {
      packRoot: outDir,
      scriptsWritten: counts.scripts,
      uiWritten: counts.ui,
      objectsWritten: counts.objects,
      skeletonWritten: true,
    };
  } catch (err) {
    if (err instanceof PackError) {
      throw err;
    }
    throw new PackError("UNPACK_FAILED", t("error.pack.unpack.failed", { detail: errMessage(err) }));
  } finally {
    // 临时目录用完即清（recursive + force：不存在也不报错）
    if (extractDir !== undefined) {
      await rm(extractDir, { recursive: true, force: true });
    }
    if (zipDir !== undefined) {
      await rm(zipDir, { recursive: true, force: true });
    }
  }
}
