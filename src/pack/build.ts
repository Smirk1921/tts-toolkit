// src/pack/build.ts
/**
 * buildSave：图包工作区 → TTS 可加载的存档 JSON（离线回路关键模块，约束 8）。
 *
 * 核心思想（与"重新生成"相对）：**读骨架 + 按 GUID 定点替换**。
 * `<root>/.tts/skeleton.json` 是 unpack 落盘的完整原始存档（约束 8，绝不入 git）；
 * build 把工作区里"确实改过的东西"（脚本 / UI / 对象与牌堆的 data.json）按 GUID
 * 定点替换进骨架，未改动的对象直接保留骨架里的原引用——因此输出里未改动部分
 * 与骨架**逐字节一致**：骨架本就是 2 空格缩进的 JSON.stringify 产物，而
 * JSON.parse → JSON.stringify 保序（含整数样键的提升也已在上游 parse 时定型）
 * 且数字往返无损，同样的结构再 stringify 必然得到同样的文本。
 *
 * 流程：
 * 1. 读 `<root>/.tts/skeleton.json`（自己 JSON.parse，**绝不走 readSave**——
 *    readSave 会给数字字段加 ">>floating-point<<" 字符串包装，会把污染写进
 *    输出存档；见 src/pack/unpack.ts 模块头注释的取舍 1）。文件不存在抛
 *    SKELETON_MISSING（引导用户先跑 tts unpack），不可读 / 非法 / 缺
 *    ObjectStates 抛 SKELETON_INVALID。
 * 2. 索引工作区（每个目录一次 readdir，不逐对象扫描）：
 *    - scripts/：文件名为 "Global.lua"（GUID=-1）或 "<guid>.<净化名>.lua"，
 *      按 guid 前缀建索引——名字部分随时可能被改，只取首段当 guid，绝不解析
 *      名字部分；
 *    - ui/：同规则，扩展名 .xml；
 *    - objects|decks/：每个子目录读 **data.json 的 GUID 字段**建索引（与
 *      unpack 的约定一致：绝不解析目录名，一律以 data.json 的 GUID 为准——
 *      用户改的只是目录名里的"名字部分"，数据仍按 GUID 落到正确的对象上）。
 * 3. 深遍历骨架（保持 ObjectStates 原顺序，逐个对象**原地**处理，绝不深拷贝）：
 *    - 顶层 LuaScript / XmlUI（GUID=-1 的 Global）：`<root>/scripts/Global.lua`
 *      存在则读文件内容替换 skeleton.LuaScript（字段缺失时创建），否则保留
 *      骨架原值；XmlUI 同理（ui/Global.xml）；
 *    - 每个对象按 GUID：
 *      a) objects|decks/ 索引命中 → **整个对象**用工作区 data.json 替换
 *         （替换前校验 data.json 的 GUID 与骨架对象的 GUID 一致，不一致抛
 *         GUID_MISMATCH——按构造不可达，索引即以 data.json 的 GUID 为键，
 *         保留校验以兑现"GUID 一致校验"约定并防将来索引实现变更）；
 *      b) scripts/ 索引命中 → 读文件内容替换 obj.LuaScript；未命中保留原值；
 *      c) ui/ 索引命中 → 同理替换 obj.XmlUI；未命中保留原值；
 *      d) 对象含 ContainedObjects 数组 → 对每个内嵌对象递归 a~d（牌堆是主
 *         场景，同样覆盖 Bag 等任何带 ContainedObjects 的对象；States /
 *         ChildObjects 本窗口不递归，留给阶段 2B 的共用遍历器——约束 9）。
 *    - 替换顺序是**先整体替换、再打脚本 / UI 补丁**：data.json 里的 LuaScript
 *      是 unpack 时刻的旧值，scripts/<guid>.lua 才是用户编辑后的真值；两者都
 *      命中时脚本补丁必须落在替换后的对象上，否则脚本改动会被 data.json 的
 *      旧值覆盖丢失。
 * 4. dryRun=true：不写任何文件、不创建 dist/，只统计计数并返回。
 * 5. dryRun=false：确保输出目录存在后，JSON.stringify(skeleton, null, 2)
 *    写入 outPath。默认 `<root>/dist/<净化(pack.yaml name)>.json`；pack.yaml
 *    缺失（PACK_NOT_FOUND）时回退骨架 SaveName，净化后为空再回退 sanitizeName
 *    的兜底 "object"；pack.yaml 存在但损坏（PACK_INVALID / PACK_READ_FAILED）
 *    则原样抛出——那是工作区的真实问题，不静默跳过。
 *
 * 计数与警告（{@link BuildResult}）：
 * - scriptsReplaced / uiReplaced：实际读工作区文件替换 LuaScript / XmlUI 的
 *   次数（含 Global 与牌堆内嵌对象；同一对象先整体替换再打补丁会同时计入
 *   objectsReplaced 与 scriptsReplaced/uiReplaced）。计的是"执行了替换动作"：
 *   工作区文件存在即读入赋值，哪怕内容与骨架相同（刚 unpack 完就 build）也
 *   计入——此时输出仍与骨架逐字节一致；
 * - objectsReplaced：被工作区 data.json 整体替换的对象数（objects/ 与 decks/
 *   两个来源都计入）；
 * - decksPatched：留给将来的 deck/patch 流水线（deck.yaml 卡表 → 图集重建
 *   ContainedObjects / CustomDeck，阶段 2B），**本窗口恒为 0**——decks/ 的
 *   data.json 整体替换计入 objectsReplaced，不算这里；
 * - warnings：不中断构建的问题清单（中文、经 t()），例如工作区有但骨架没有
 *   的 GUID（孤儿脚本 / UI / 对象目录）、同一 guid 多个脚本 / UI 候选、
 *   data.json 不可读 / 重复等。孤儿文件不会被使用，构建照常进行。
 *
 * 错误码（{@link PackError.code}）：
 * - "SKELETON_MISSING" 骨架存档不存在（引导先跑 unpack）
 * - "SKELETON_INVALID" 骨架存档不可读 / 非法 JSON / 缺 ObjectStates
 * - "GUID_MISMATCH"    整体替换前 data.json 的 GUID 与骨架对象不一致（防御性）
 * - "BUILD_FAILED"     其余失败（脚本 / UI 读取失败、写盘失败等）
 *
 * 本模块新增的 i18n 键（locales/*.json 由 Run 2 补齐；缺键时 t() 原样输出键名）：
 * - `error.pack.build.skeletonMissing` {path}
 * - `error.pack.build.skeletonInvalid` {path} {detail}
 * - `error.pack.build.guidMismatch` {path} {expected} {actual}
 * - `error.pack.build.failed` {detail}
 * - `cli.pack.build.warnInvalidGuid` {loc}
 * - `cli.pack.build.warnScriptOrphan` {file}
 * - `cli.pack.build.warnUiOrphan` {file}
 * - `cli.pack.build.warnObjectOrphan` {path}
 * - `cli.pack.build.warnDeckOrphan` {path}
 * - `cli.pack.build.warnAmbiguousScript` {guid} {file}
 * - `cli.pack.build.warnAmbiguousUi` {guid} {file}
 * - `cli.pack.build.warnDataUnreadable` {path} {detail}
 * - `cli.pack.build.warnDataDuplicate` {guid} {path}
 *
 * zod 各字段的 issue 文案按仓库既有风格写死中文（参见 src/pack/unpack.ts），
 * 只作为错误摘要的数据部分出现，不单独面向用户，故不走 t()。
 */

import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SaveFile } from "@tts-tools/savefile";
import { z } from "zod";

import { t } from "../i18n/index.js";
import { GLOBAL_GUID } from "../protocol/messages.js";
import {
  decksDir,
  objectsDir,
  scriptsDir,
  scriptFileName,
  skeletonPath,
  uiDir,
  uiFileName,
} from "./layout.js";
import { PackError, readPackYaml } from "./packyaml.js";

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** buildSave 的入参 */
export interface BuildOptions {
  /** 图包工作区根目录（相对路径会先 resolve） */
  root: string;
  /** 只统计与生成摘要，不写文件、不创建 dist/（默认 false） */
  dryRun?: boolean;
  /** 输出 JSON 路径；缺省 `<root>/dist/<净化(pack.yaml name)>.json` */
  outPath?: string;
}

/** buildSave 的返回值 */
export interface BuildResult {
  /** 输出 JSON 路径（resolve 后的绝对路径；dryRun 下是"将会写入"的路径） */
  outPath: string;
  /** 是否 dryRun（与入参一致） */
  dryRun: boolean;
  /**
   * 实际读工作区文件替换了 LuaScript 的对象数（含 Global 与牌堆内嵌对象）。
   * 计的是"执行了替换动作"：工作区文件存在即读入并赋值——哪怕内容与骨架相同
   * （例如刚 unpack 完就 build）也计入；此时输出仍与骨架逐字节一致。
   */
  scriptsReplaced: number;
  /** 实际读工作区文件替换了 XmlUI 的对象数（计数语义同 {@link BuildResult.scriptsReplaced}） */
  uiReplaced: number;
  /** 走 deck/patch 流水线的牌堆数（阶段 2B 实现，本窗口恒为 0，见模块头注释） */
  decksPatched: number;
  /** 被工作区 data.json 整体替换的对象数（objects/ 与 decks/ 都计入） */
  objectsReplaced: number;
  /** 不中断构建的问题清单（中文、经 t()），如"工作区有但骨架没有的 GUID" */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

/** 工作区对象目录的索引条目（objects/<guid>.<名>/ 或 decks/<guid>.<名>/） */
interface WorkspaceObjectEntry {
  /** data.json 里的 GUID（索引键即它，目录名不参与定位） */
  guid: string;
  /** 对象子目录的完整路径（用于警告信息） */
  dir: string;
  /** data.json 解析出的完整对象（替换进骨架的就是它，原引用不拷贝） */
  data: Record<string, unknown>;
  /** 来源目录（objects 或 decks，用于区分孤儿警告文案） */
  kind: "objects" | "decks";
}

/** 遍历过程中的共享上下文 */
interface BuildContext {
  /** 图包根目录（resolve 后的绝对路径） */
  root: string;
  /** guid → scripts/ 下的候选文件名列表（已按字典序排序） */
  scriptIndex: Map<string, string[]>;
  /** guid → ui/ 下的候选文件名列表（已按字典序排序） */
  uiIndex: Map<string, string[]>;
  /** guid → 工作区对象目录条目（objects/ 先扫描，重复 guid 时先到先得） */
  objectIndex: Map<string, WorkspaceObjectEntry>;
  /** 累积的警告（中文、经 t()） */
  warnings: string[];
  /** 四个计数（decks 本窗口恒 0，见模块头注释） */
  counters: { scripts: number; ui: number; decks: number; objects: number };
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 工作区对象目录里的数据文件名（与 unpack 落盘约定一致） */
const OBJECT_DATA_FILE = "data.json";

/** 默认输出目录名（相对图包根） */
const DIST_DIR = "dist";

/**
 * sanitizeName：把名称净化成安全的文件名片段（用于默认输出文件名）。
 *
 * （与 src/cli/commands/pull.ts、src/pack/layout.ts 的同名函数逻辑逐字一致；
 * 按仓库约定复制粘贴、不跨模块 import 命令层实现——三处规则如需调整必须同步修改。）
 */
function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\?%*:|"<>]/g, "")
    .replace(/^[._]+/, "")
    .replace(/[._ ]+$/, "");
  return cleaned === "" ? "object" : cleaned;
}

// ---------------------------------------------------------------------------
// zod 校验（运行时边界统一 unknown + zod，禁止 any）
// ---------------------------------------------------------------------------

/**
 * 骨架存档的最小结构校验（只校验遍历关心的字段；骨架字段成百上千，
 * 严格校验只会误伤——与 unpack 的 saveLikeSchema 同一取舍）。
 */
const skeletonSchema = z.object(
  {
    ObjectStates: z.array(z.unknown(), { error: "骨架存档的 ObjectStates 必须是对象数组" }),
  },
  { error: "骨架存档 JSON 必须是键值对象" },
);

/**
 * 工作区 data.json 的最小结构校验（定位只需要 GUID；其余字段原样保留参与替换）。
 *
 * GUID 允许空串：工坊原包（.ttsmod 直接解出来的存档）里未在游戏内保存过的
 * 对象 GUID 是空字符串，这是合法状态（unpack 会照样落盘）。build 时这种对象
 * 不会出现在骨架索引里，整体走"未改对象透传"路径，不会触发 GUID_MISMATCH。
 */
const workspaceDataSchema = z.object(
  {
    GUID: z.string({ error: "data.json 的 GUID 必须是字符串" }),
  },
  { error: "data.json 必须是键值对象" },
);

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

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
 * 从 unknown 错误中取人类可读描述。
 * @param err 任意抛出值
 * @returns Error 取 message，其余用 String() 兜底
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 将 zod 校验错误格式化为单行中文可读摘要。
 * （与 packyaml.ts 等模块的同名内部函数一致；各模块各自持有，不跨模块导出。）
 * @param error zod 校验错误对象
 * @returns 形如 "GUID：不能为空" 的描述，多个问题以"；"连接
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

/** 路径指向普通文件时返回 true（不存在或其他错误一律 false） */
async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/**
 * 列出目录下（不存在时按空处理）的普通文件名，按字典序排序保证确定性。
 * @param dir 目录路径
 * @param ext 只保留该扩展名（含点，如 ".lua"）
 * @returns 排序后的文件名列表（不含目录部分）
 */
async function listFilesSorted(dir: string, ext: string): Promise<string[]> {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(ext)).map((entry) => entry.name);
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return []; // scripts/ui/objects/decks 目录缺失按空工作区处理，不算错误
    }
    throw err;
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * 从工作区脚本 / UI 文件名提取 GUID（只取首段，绝不解析名字部分）。
 * @param fileName 文件名（如 "aa11bb.测试牌堆.lua"、"Global.xml"）
 * @param ext 扩展名（含点）
 * @returns GUID；无点前缀的散落文件返回 undefined（不参与匹配也不告警）
 */
function guidFromFileName(fileName: string, ext: string): string | undefined {
  if (fileName === `Global${ext}`) {
    return GLOBAL_GUID;
  }
  const dot = fileName.indexOf(".");
  if (dot <= 0) {
    return undefined;
  }
  return fileName.slice(0, dot);
}

/**
 * 把文件名列表按 GUID 归组建索引。
 * @param dir 目录路径（用于索引值？否——索引值只存文件名，拼路径时再 join）
 * @param ext 扩展名（含点）
 * @returns guid → 文件名列表（每个列表已排序）
 */
async function indexFilesByGuid(dir: string, ext: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  for (const fileName of await listFilesSorted(dir, ext)) {
    const guid = guidFromFileName(fileName, ext);
    if (guid === undefined) {
      continue; // 散落文件（无 guid 前缀）：不属于任何对象，静默忽略
    }
    const bucket = index.get(guid);
    if (bucket === undefined) {
      index.set(guid, [fileName]);
    } else {
      bucket.push(fileName);
    }
  }
  return index;
}

/**
 * 扫描 objects/ 或 decks/ 下的对象子目录，读 data.json 的 GUID 建索引。
 *
 * 与 unpack 的约定一致：绝不解析目录名，一律以 data.json 的 GUID 字段为准。
 * 目录缺 data.json、data.json 非法 JSON 或缺有效 GUID → 记警告并跳过该目录；
 * 同一 GUID 出现在多个目录（如复制出来的试验目录）→ 记警告，先扫描到的
 * （objects/ 先于 decks/，同目录内按字典序）生效。
 *
 * @param ctx 遍历上下文（索引与警告都写进 ctx）
 * @param kind 扫描哪个目录
 */
async function indexObjectDirs(ctx: BuildContext, kind: "objects" | "decks"): Promise<void> {
  const baseDir = kind === "objects" ? objectsDir(ctx.root) : decksDir(ctx.root);
  let entries: Dirent[];
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      return; // 目录缺失按空工作区处理
    }
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue; // 散落文件不是对象目录
    }
    const dir = path.join(baseDir, entry.name);
    const dataFile = path.join(dir, OBJECT_DATA_FILE);
    if (!(await isFile(dataFile))) {
      ctx.warnings.push(t("cli.pack.build.warnDataUnreadable", { path: dataFile, detail: "文件不存在" }));
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(dataFile, "utf8"));
    } catch (err) {
      ctx.warnings.push(t("cli.pack.build.warnDataUnreadable", { path: dataFile, detail: errMessage(err) }));
      continue;
    }
    const parsed = workspaceDataSchema.safeParse(raw);
    if (!parsed.success) {
      ctx.warnings.push(
        t("cli.pack.build.warnDataUnreadable", { path: dataFile, detail: formatZodError(parsed.error) }),
      );
      continue;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      // safeParse 通过即保证是键值对象，此分支按构造不可达（防御性保留）
      continue;
    }
    const guid = parsed.data.GUID;
    if (guid === "") {
      // 空 GUID 是工坊原包的合法状态（未在游戏内保存过的对象）。这种对象
      // 不会出现在骨架索引里，整体走"未改对象透传"路径；不建索引、不告警。
      continue;
    }
    if (ctx.objectIndex.has(guid)) {
      ctx.warnings.push(t("cli.pack.build.warnDataDuplicate", { guid, path: dataFile }));
      continue; // 先到先得，保持确定性
    }
    ctx.objectIndex.set(guid, { guid, dir, data: raw as Record<string, unknown>, kind });
  }
}

/**
 * 收集骨架里出现过的全部对象 GUID（含 ContainedObjects 内嵌对象，与遍历
 * 的递归范围一致）；"-1"（Global）不收集——Global 走顶层字段，不参与孤儿判断。
 * @param states 骨架的 ObjectStates
 * @returns 骨架 GUID 集合
 */
function collectSkeletonGuids(states: readonly unknown[]): Set<string> {
  const guids = new Set<string>();
  const walk = (container: readonly unknown[]): void => {
    for (const item of container) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const record = item as Record<string, unknown>;
      if (typeof record.GUID === "string" && record.GUID !== "") {
        guids.add(record.GUID);
      }
      const contained = record.ContainedObjects;
      if (Array.isArray(contained)) {
        walk(contained);
      }
    }
  };
  walk(states);
  return guids;
}

/**
 * 按 GUID 在骨架对象上应用脚本或 UI 补丁（命中即读文件替换并计数，
 * 未命中保留对象现值；多候选时取字典序第一个并记警告）。
 * @param ctx 遍历上下文
 * @param obj 目标对象（原地修改）
 * @param guid 对象 GUID
 * @param kind "script"（LuaScript）或 "ui"（XmlUI）
 * @throws PackError code="BUILD_FAILED" 工作区文件索引存在但读取失败时
 *   （显式报错，绝不静默降级）
 */
async function applyScriptOrUiPatch(
  ctx: BuildContext,
  obj: Record<string, unknown>,
  guid: string,
  kind: "script" | "ui",
): Promise<void> {
  const index = kind === "script" ? ctx.scriptIndex : ctx.uiIndex;
  const candidates = index.get(guid);
  if (candidates === undefined || candidates.length === 0) {
    return; // 工作区没有该对象的脚本 / UI：保留骨架（或 data.json）现值
  }
  const fileName = candidates[0];
  if (candidates.length > 1) {
    ctx.warnings.push(
      t(kind === "script" ? "cli.pack.build.warnAmbiguousScript" : "cli.pack.build.warnAmbiguousUi", {
        guid,
        file: fileName,
      }),
    );
  }
  const fullPath = path.join(kind === "script" ? scriptsDir(ctx.root) : uiDir(ctx.root), fileName);
  let content: string;
  try {
    content = await readFile(fullPath, "utf8");
  } catch (err) {
    throw new PackError("BUILD_FAILED", t("error.pack.build.failed", { detail: `${fullPath}：${errMessage(err)}` }));
  }
  if (kind === "script") {
    obj.LuaScript = content;
    ctx.counters.scripts += 1;
  } else {
    obj.XmlUI = content;
    ctx.counters.ui += 1;
  }
}

/**
 * 深遍历一个对象容器（顶层 ObjectStates 或某对象的 ContainedObjects），
 * 逐个元素**原地**处理：整体替换 → 脚本 / UI 补丁 → 递归 ContainedObjects。
 *
 * 保持数组原顺序（只按下标原地赋值，从不重排 / 删除）；工作区没有对应
 * 内容的对象原样保留骨架引用（"工作区删除了的对象保留骨架版本"）。
 *
 * @param states 对象数组（会被原地修改）
 * @param loc 该容器在骨架中的位置描述（如 "ObjectStates[1].ContainedObjects"，
 *   仅用于警告信息定位）
 * @param ctx 遍历上下文
 * @throws PackError code="GUID_MISMATCH" / "BUILD_FAILED"（见各内部函数）
 */
async function processContainer(states: unknown[], loc: string, ctx: BuildContext): Promise<void> {
  for (let i = 0; i < states.length; i++) {
    const item = states[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      ctx.warnings.push(t("cli.pack.build.warnInvalidGuid", { loc: `${loc}[${i}]` }));
      continue;
    }
    const skeletonObj = item as Record<string, unknown>;
    const guid = skeletonObj.GUID;
    if (typeof guid !== "string" || guid === "") {
      ctx.warnings.push(t("cli.pack.build.warnInvalidGuid", { loc: `${loc}[${i}]` }));
      continue;
    }

    // a) 整体替换：objects|decks/<guid>/data.json 的内容替换整个对象
    const ws = ctx.objectIndex.get(guid);
    if (ws !== undefined) {
      if (ws.guid !== guid) {
        // 按构造不可达（索引即以 data.json 的 GUID 为键）；保留校验以兑现
        // "整体替换前 GUID 一致校验"的约定，并防将来索引实现变更引入偏差
        throw new PackError(
          "GUID_MISMATCH",
          t("error.pack.build.guidMismatch", {
            path: path.join(ws.dir, OBJECT_DATA_FILE),
            expected: guid,
            actual: ws.guid,
          }),
        );
      }
      states[i] = ws.data;
      ctx.counters.objects += 1;
    }

    // b/c) 脚本与 UI 补丁：落在替换后的对象上（data.json 里的脚本是旧值）
    const current = states[i] as Record<string, unknown>;
    await applyScriptOrUiPatch(ctx, current, guid, "script");
    await applyScriptOrUiPatch(ctx, current, guid, "ui");

    // d) 递归处理 ContainedObjects（牌堆 / 包的内嵌对象；States / ChildObjects
    //    本窗口不递归——约束 9 的共用遍历器在阶段 2B 实现）
    const contained = current.ContainedObjects;
    if (Array.isArray(contained)) {
      await processContainer(contained, `${loc}[${i}].ContainedObjects`, ctx);
    }
  }
}

/**
 * 把"工作区有但骨架没有"的孤儿条目收进警告（guid 为 "-1" 的 Global 与
 * 无 guid 前缀的散落文件不参与判断）。
 * @param ctx 遍历上下文（警告写进 ctx.warnings）
 * @param skeletonGuids 骨架中出现的全部对象 GUID
 */
function pushOrphanWarnings(ctx: BuildContext, skeletonGuids: ReadonlySet<string>): void {
  for (const [guid, files] of ctx.scriptIndex) {
    if (guid !== GLOBAL_GUID && !skeletonGuids.has(guid)) {
      for (const fileName of files) {
        ctx.warnings.push(t("cli.pack.build.warnScriptOrphan", { file: path.join(scriptsDir(ctx.root), fileName) }));
      }
    }
  }
  for (const [guid, files] of ctx.uiIndex) {
    if (guid !== GLOBAL_GUID && !skeletonGuids.has(guid)) {
      for (const fileName of files) {
        ctx.warnings.push(t("cli.pack.build.warnUiOrphan", { file: path.join(uiDir(ctx.root), fileName) }));
      }
    }
  }
  for (const entry of ctx.objectIndex.values()) {
    if (!skeletonGuids.has(entry.guid)) {
      const key = entry.kind === "objects" ? "cli.pack.build.warnObjectOrphan" : "cli.pack.build.warnDeckOrphan";
      ctx.warnings.push(t(key, { path: entry.dir }));
    }
  }
}

/**
 * 计算默认输出路径 `<root>/dist/<净化图包名>.json`。
 *
 * 图包名优先取 pack.yaml 的 name（PACK_NOT_FOUND 时回退骨架 SaveName；
 * pack.yaml 存在但损坏时原样抛出，不静默跳过）。
 * @param root 图包根目录
 * @param skeleton 已解析的骨架存档（SaveName 回退来源）
 * @returns 默认输出 JSON 的绝对路径
 * @throws PackError pack.yaml 存在但非法 / 不可读时（原样透传其错误码）
 */
async function defaultOutPath(root: string, skeleton: SaveFile): Promise<string> {
  let packName: string;
  try {
    packName = (await readPackYaml(root)).name;
  } catch (err) {
    if (!(err instanceof PackError) || err.code !== "PACK_NOT_FOUND") {
      throw err;
    }
    packName = typeof skeleton.SaveName === "string" ? skeleton.SaveName : "";
  }
  return path.join(root, DIST_DIR, `${sanitizeName(packName.trim())}.json`);
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 把图包工作区构建成 TTS 可加载的存档 JSON（流程、计数与取舍见模块头注释）。
 *
 * 核心保证（约束 8）：未改动的对象与骨架逐字节一致——只做"按 GUID 定点
 * 替换"，绝不深拷贝、绝不重排 ObjectStates、绝不删除工作区里已删除的对象。
 *
 * @param opts 入参（root 必填；dryRun / outPath 可选）
 * @returns 构建结果（outPath 为 resolve 后的绝对路径，dryRun 下也照常计算）
 * @throws PackError code="SKELETON_MISSING" `<root>/.tts/skeleton.json` 不存在时
 *   （message 引导用户先跑 tts unpack）
 * @throws PackError code="SKELETON_INVALID" 骨架不可读 / 非法 JSON / 缺 ObjectStates 时
 * @throws PackError code="GUID_MISMATCH" 整体替换前 GUID 校验失败时（防御性）
 * @throws PackError code="BUILD_FAILED" 脚本 / UI 读取失败、写盘失败等其余错误时
 * @throws PackError pack.yaml 存在但损坏时透传 PACK_INVALID / PACK_READ_FAILED
 *   （仅当未显式传 outPath 且默认名需要读 pack.yaml）
 * @throws Error root / outPath 入参不是合法非空字符串时（调用方编程错误）
 */
export async function buildSave(opts: BuildOptions): Promise<BuildResult> {
  if (typeof opts?.root !== "string" || opts.root.trim() === "") {
    throw new Error("build 入参无效：root 必须是非空字符串路径");
  }
  if (opts.outPath !== undefined && (typeof opts.outPath !== "string" || opts.outPath.trim() === "")) {
    throw new Error("build 入参无效：outPath 必须是非空字符串路径");
  }
  const root = path.resolve(opts.root);
  const dryRun = opts.dryRun === true;

  try {
    // —— 1. 读骨架存档（自己 JSON.parse，绝不走 readSave，见模块头注释）——
    const skeletonFile = skeletonPath(root);
    let text: string;
    try {
      text = await readFile(skeletonFile, "utf8");
    } catch (err) {
      if (errCode(err) === "ENOENT") {
        throw new PackError(
          "SKELETON_MISSING",
          t("error.pack.build.skeletonMissing", { path: skeletonFile }),
        );
      }
      throw new PackError(
        "SKELETON_INVALID",
        t("error.pack.build.skeletonInvalid", { path: skeletonFile, detail: errMessage(err) }),
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new PackError(
        "SKELETON_INVALID",
        t("error.pack.build.skeletonInvalid", { path: skeletonFile, detail: errMessage(err) }),
      );
    }
    const checked = skeletonSchema.safeParse(parsed);
    if (!checked.success) {
      throw new PackError(
        "SKELETON_INVALID",
        t("error.pack.build.skeletonInvalid", { path: skeletonFile, detail: formatZodError(checked.error) }),
      );
    }
    // schema 只做最小结构校验，这里保留原始 parsed（避免剥离骨架的未知字段）
    const skeleton = parsed as SaveFile;
    const states = skeleton.ObjectStates as unknown[];

    const ctx: BuildContext = {
      root,
      scriptIndex: new Map<string, string[]>(),
      uiIndex: new Map<string, string[]>(),
      objectIndex: new Map<string, WorkspaceObjectEntry>(),
      warnings: [],
      counters: { scripts: 0, ui: 0, decks: 0, objects: 0 },
    };

    // —— 2. 索引工作区（每目录一次 readdir）——
    ctx.scriptIndex = await indexFilesByGuid(scriptsDir(root), ".lua");
    ctx.uiIndex = await indexFilesByGuid(uiDir(root), ".xml");
    await indexObjectDirs(ctx, "objects");
    await indexObjectDirs(ctx, "decks");

    // —— 3. 孤儿警告：工作区有但骨架没有的 GUID（不报错，收进 warnings）——
    pushOrphanWarnings(ctx, collectSkeletonGuids(states));

    // —— 4. Global（GUID=-1）：顶层 LuaScript / XmlUI 定点替换 ——
    const globalScriptFile = path.join(scriptsDir(root), scriptFileName(GLOBAL_GUID, "Global"));
    if (await isFile(globalScriptFile)) {
      skeleton.LuaScript = await readFile(globalScriptFile, "utf8");
      ctx.counters.scripts += 1;
    }
    const globalUiFile = path.join(uiDir(root), uiFileName(GLOBAL_GUID, "Global"));
    if (await isFile(globalUiFile)) {
      skeleton.XmlUI = await readFile(globalUiFile, "utf8");
      ctx.counters.ui += 1;
    }

    // —— 5. 深遍历 ObjectStates（保持原顺序，原地替换，未改动对象保留引用）——
    await processContainer(states, "ObjectStates", ctx);

    // —— 6. 输出 ——
    const outPath = opts.outPath !== undefined ? path.resolve(opts.outPath) : await defaultOutPath(root, skeleton);
    if (!dryRun) {
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify(skeleton, null, 2), "utf8");
    }

    return {
      outPath,
      dryRun,
      scriptsReplaced: ctx.counters.scripts,
      uiReplaced: ctx.counters.ui,
      decksPatched: ctx.counters.decks, // deck/patch 流水线阶段 2B 实现，本窗口恒 0
      objectsReplaced: ctx.counters.objects,
      warnings: ctx.warnings,
    };
  } catch (err) {
    if (err instanceof PackError) {
      throw err;
    }
    throw new PackError("BUILD_FAILED", t("error.pack.build.failed", { detail: errMessage(err) }));
  }
}
