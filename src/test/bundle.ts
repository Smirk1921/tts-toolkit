// src/test/bundle.ts
/**
 * 阶段 7 测试运行器的多文件 Lua 打包（bundle）模块。
 *
 * 属于窗口 G（阶段 7：测试运行器 + 发布链路），由 A4 产出。
 * 依赖 luabundle@^1.7（CJS 包，经 node:module 的 createRequire 引入；ESM 下
 * 直接 import 其命名空间不可靠，包内 .d.ts 转出的类型也与运行时不完全一致，
 * 故在文件底部按实际行为声明最小接口，见 {@link LuabundleApi}）。
 *
 * 用途：把"入口 + require 依赖树"的多文件 Lua 项目打包成单文件 LuaScript，
 * 供 runner（A3）经 SessionExec 一次 ExecuteLua 执行；同时产出 bundle 行号 →
 * 源文件行号的映射表，用于把 Lua 报错/断言行号回映射到源码位置。
 *
 * 行号映射策略：
 * 1. luabundle 把每个模块包成 `__bundle_register("name", function(...)\n<内容>\nend)`，
 *    模块内容从 register 行的下一行开始；
 * 2. 打包后用 unbundleString(code) 反解出每个模块在 bundle 中的 [start.line, end.line]
 *    （1-based、含端点；区间末尾可能多出一个空行——源文件末尾换行的占位，映射无害）；
 * 3. 模块名 → 源文件路径：bundle 前按 luabundle 的解析规则（bundle/process.ts 的
 *    resolveModule：模块名点号 ↔ 路径分隔符、代入模式中的 ?、首个命中优先）预扫描
 *    各搜索模式前缀目录下的 .lua 文件建立映射；入口模块（metadata.rootModuleName，
 *    缺省 "__root"）映射到 entryPath，内置模块映射到注入用的临时文件路径；
 * 4. sourceLine = bundleLine - start.line + 1（1-based）。
 *
 * 内置模块注入：builtinModules 的每个模块写成临时文件
 * `<entryDir>/.tts-test-bundle/b<随机>/tts/assert.lua`（模块名点号转路径分隔符），
 * 对应搜索模式 `<...>/b<随机>/?.lua` 放在所有模式最前（显式注入优先于项目内同名
 * 文件）；随机子目录保证并发调用互不干扰；bundle 结束后在 finally 中清理
 * （尽力而为：只递归删本次调用的子目录，父目录仅在已空时顺手移除）。
 *
 * 已知限制（调用方需知）：
 * - 入口无 require 时 luabundle 原样返回源码（force=false、不含 metadata），
 *   unbundleString 抛 NoBundleMetadataError → 按契约回退"无行号映射"模式：
 *   lineMap 为空 Map，moduleSources 仅含入口模块（名用 luabundle 缺省根模块名）；
 * - 模块内的 require 调用会被 luabundle 规范化为 require("name")，单行写法行号
 *   不变；跨多行的 require 调用会使该模块后续行号错位（测试代码应避免）；
 * - lineMap 查不到的行号（如调用方在 bundle 末尾追加的取回语句）由调用方回退为
 *   bundle 行号本身（见 types.ts 的 runner 契约）；
 * - 源文件名自带点号（如 foo.bar.lua）经 ? 模式不可被 require 命中（luabundle
 *   语义如此），预扫描会跳过这类文件，其模块走行号映射回退分支。
 *
 * 本模块声明的 PackError 错误码（locales 两套键由 Stage C 补齐，代码内只 new PackError）：
 * - "TEST_ENTRY_NOT_FOUND"  打包入口 Lua 文件不存在
 * - "TEST_BUNDLE_FAILED"    打包失败（依赖模块解析失败 / Lua 语法错误 /
 *                           读入口失败 / 内置模块名不合法 / 反解打包结果失败）
 */

import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { PackError } from "../pack/packyaml.js";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// luabundle 最小接口声明（按实际运行时行为，见本文件头注释）
// ---------------------------------------------------------------------------

/** unbundle 反解出的模块位置（1-based 行号；见 luabundle/unbundle/module.d.ts） */
interface LuabundleModulePosition {
  index: number;
  line: number;
  column: number;
}

/** unbundle 反解出的单个模块：内容占据 bundle 的 [start.line, end.line]（含端点） */
interface LuabundleUnbundledModule {
  name: string;
  content: string;
  start: LuabundleModulePosition;
  end: LuabundleModulePosition;
}

/** 本模块实际用到的 luabundle API 子集 */
interface LuabundleApi {
  bundleString(lua: string, options?: { paths?: string[]; metadata?: boolean }): string;
  unbundleString(lua: string): {
    modules: Record<string, LuabundleUnbundledModule>;
    metadata: { rootModuleName: string };
  };
}

const luabundle = require("luabundle") as LuabundleApi;

/**
 * 识别"无 metadata 的打包结果"（单模块入口被原样返回时）：用包内错误类做
 * instanceof，比匹配错误消息文本更稳（luabundle 无 exports 封禁，
 * "luabundle/errors" 为包内固定子路径导出）。
 */
const { NoBundleMetadataError } = require("luabundle/errors") as {
  NoBundleMetadataError: new () => Error;
};

// ---------------------------------------------------------------------------
// 公共类型（src/test/index.ts 转出的契约）
// ---------------------------------------------------------------------------

/** bundleTests 的返回值：单文件 Lua + 行号映射 + 模块来源 */
export interface BundleResult {
  /** 打包后的单文件 Lua 源码 */
  code: string;
  /** 行号映射：bundle 行号 → { 源文件绝对路径, 源文件行号（1-based） } */
  lineMap: Map<number, { sourceFile: string; sourceLine: number }>;
  /**
   * 模块名 → 实际参与打包的文件路径（绝对路径）。
   * 入口模块 → entryPath；普通模块 → 搜索路径下命中的源文件；
   * 内置模块 → 注入用的临时文件路径（bundle 结束后该文件已被清理）。
   */
  moduleSources: Map<string, string>;
}

/** bundleTests 的入参 */
export interface BundleOptions {
  /** 入口 Lua 文件（绝对路径；相对路径会先 path.resolve） */
  entryPath: string;
  /** 额外的 require 搜索目录（每个目录展开为 `<dir>/?.lua` 模式） */
  searchPaths?: string[];
  /** 内置模块表：模块名 → Lua 源码（用于注入 "tts.assert"） */
  builtinModules?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 常量与小工具
// ---------------------------------------------------------------------------

/** 内置模块临时目录名（entryDir 下的隐藏目录） */
const BUILTIN_DIR_NAME = ".tts-test-bundle";

/** luabundle 缺省根模块名（单模块回退路径下拿不到 metadata，用缺省值命名入口模块） */
const DEFAULT_ROOT_MODULE_NAME = "__root";

/** 从 unknown 错误取人类可读描述 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 内置模块的临时文件路径：模块名点号转路径分隔符，如 "tts.assert" → <dir>/tts/assert.lua */
function builtinFilePath(builtinDir: string, name: string): string {
  return `${path.join(builtinDir, ...name.split("."))}.lua`;
}

/**
 * 内置模块名合法性：点号分段后每段不得为空、不得含路径分隔符
 * （防临时文件被写出 builtinDir 之外；分段为 ".." 的穿越同样被拦下）。
 */
function validateBuiltinName(name: string): void {
  const bad = name === "" || name.split(".").some((part) => part === "" || /[\\/]/.test(part) || part === "..");
  if (bad) {
    throw new PackError(
      "TEST_BUNDLE_FAILED",
      `内置模块名不合法：${JSON.stringify(name)}（点号分段后不得为空，不得包含路径分隔符或 ".."）`,
    );
  }
}

/**
 * 预扫描：按 luabundle 的 require 解析规则建立 模块名 → 文件路径 映射。
 *
 * luabundle 的解析（bundle/process.ts 的 resolveModule）：把模块名的点号换成路径
 * 分隔符后代入每个模式里的 ?，首个 existsSync 命中的文件即被加载。据此对每个
 * `<前缀>?<后缀>` 模式递归枚举前缀目录下的文件：文件相对前缀路径去掉后缀、分隔符
 * 转点号得到候选模块名，仅当把候选名按 luabundle 规则还原后仍命中同一文件时才
 * 收录（文件名自带点号时无法还原，说明该文件不可作为 require 目标，跳过）。
 * 同一模块名先出现的模式优先（与 resolveModule 的首中即停一致）。
 */
async function scanModuleMap(patterns: readonly string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const pattern of patterns) {
    const q = pattern.indexOf("?");
    if (q < 0) {
      continue; // 不含 ? 的模式（直接文件路径）无法枚举候选模块名
    }
    const prefix = pattern.slice(0, q);
    const suffix = pattern.slice(q + 1);
    let entries: Dirent[];
    try {
      entries = await readdir(prefix, { withFileTypes: true, recursive: true });
    } catch {
      continue; // 前缀目录不存在/不可读：与 resolveModule 的"文件不存在"同义，跳过
    }
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const file = path.join(entry.parentPath, entry.name);
      if (!file.endsWith(suffix)) {
        continue;
      }
      const relNoSuffix = path.relative(prefix, file).slice(0, -suffix.length);
      if (relNoSuffix === "") {
        continue; // 文件名恰为后缀本身（如 ".lua"）时模块名为空串，不可 require
      }
      const name = relNoSuffix.split(path.sep).join(".");
      if (name.replaceAll(".", path.sep) !== relNoSuffix) {
        continue; // 反验失败：该文件不可经此模式被 require 命中（如文件名自带点号）
      }
      if (!map.has(name)) {
        map.set(name, file);
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 把多文件 Lua 项目打包成单文件 LuaScript，并返回行号映射表。
 *
 * @param opts 入口路径 + 搜索目录 + 内置模块表
 * @returns 打包后源码、行号映射（bundle 行号 → 源文件绝对路径 + 1-based 行号）、
 *          模块名 → 实际参与打包的文件路径
 * @throws {PackError} TEST_ENTRY_NOT_FOUND（入口不存在）/
 *                     TEST_BUNDLE_FAILED（解析失败、语法错误、读入口失败等）
 */
export async function bundleTests(opts: BundleOptions): Promise<BundleResult> {
  const entryPath = path.resolve(opts.entryPath);
  const entryDir = path.dirname(entryPath);
  const builtinModules = opts.builtinModules ?? {};
  const builtinNames = Object.keys(builtinModules).sort();

  // 1. 读入口源码（存在性检查 + 去 BOM：luaparse 遇 BOM 直接语法错误）
  let entrySource: string;
  try {
    entrySource = await readFile(entryPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PackError("TEST_ENTRY_NOT_FOUND", `打包测试的入口 Lua 文件不存在：${entryPath}`);
    }
    throw new PackError("TEST_BUNDLE_FAILED", `读取打包入口 ${entryPath} 失败：${messageOf(err)}`);
  }
  entrySource = entrySource.replace(/^\uFEFF/, "");

  // 2. 内置模块写入临时目录（每次调用一个随机子目录，并发调用互不干扰）
  const wroteBuiltin = builtinNames.length > 0;
  const builtinDir = path.join(entryDir, BUILTIN_DIR_NAME, `b${randomBytes(6).toString("hex")}`);
  if (wroteBuiltin) {
    for (const name of builtinNames) {
      validateBuiltinName(name);
    }
    await mkdir(builtinDir, { recursive: true });
    for (const name of builtinNames) {
      const file = builtinFilePath(builtinDir, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, builtinModules[name]!, "utf8");
    }
  }

  // 搜索模式：内置模块目录最前（显式注入优先于项目内同名文件），其后为各搜索目录
  const patterns = [
    ...(wroteBuiltin ? [path.join(builtinDir, "?.lua")] : []),
    ...(opts.searchPaths ?? []).map((dir) => path.join(path.resolve(dir), "?.lua")),
  ];

  const lineMap = new Map<number, { sourceFile: string; sourceLine: number }>();
  const moduleSources = new Map<string, string>();

  try {
    // 3. 预扫描建立 模块名 → 文件路径（bundle 之前做，文件系统状态与打包时一致）
    const scanned = await scanModuleMap(patterns);
    for (const name of builtinNames) {
      scanned.set(name, builtinFilePath(builtinDir, name));
    }

    // 4. 打包（用 bundleString 而非 bundle(path)：入口内容已在手，可去 BOM，语义等价）
    let bundled: string;
    try {
      bundled = luabundle.bundleString(entrySource, { paths: patterns, metadata: true });
    } catch (err) {
      throw new PackError("TEST_BUNDLE_FAILED", `打包 Lua 测试入口 ${entryPath} 失败：${messageOf(err)}`);
    }

    // 5. 反解 metadata 与各模块的行号范围，构造映射；单模块入口无 metadata → 回退
    try {
      const unbundled = luabundle.unbundleString(bundled);
      const rootModuleName = unbundled.metadata.rootModuleName;

      // 6. 行号映射：模块内容占据 bundle 的 [start.line, end.line]（1-based 含端点）
      for (const [name, mod] of Object.entries(unbundled.modules)) {
        const sourceFile = name === rootModuleName ? entryPath : scanned.get(name);
        if (sourceFile === undefined) {
          continue; // 映射缺失：调用方对查不到的行号回退 bundle 行号本身（契约）
        }
        moduleSources.set(name, sourceFile);
        for (let line = mod.start.line; line <= mod.end.line; line += 1) {
          lineMap.set(line, { sourceFile, sourceLine: line - mod.start.line + 1 });
        }
      }
    } catch (err) {
      if (!(err instanceof NoBundleMetadataError)) {
        throw new PackError("TEST_BUNDLE_FAILED", `反解打包结果失败（${entryPath}）：${messageOf(err)}`);
      }
      // 单模块入口（无 require）：luabundle 原样返回源码 → 回退"无行号映射"模式
      moduleSources.set(DEFAULT_ROOT_MODULE_NAME, entryPath);
    }

    return { code: bundled, lineMap, moduleSources };
  } finally {
    // 7. 清理内置模块临时目录：只删本次调用的随机子目录；父目录仅在已空时顺手移除
    if (wroteBuiltin) {
      await rm(builtinDir, { recursive: true, force: true }).catch(() => {});
      try {
        await rmdir(path.join(entryDir, BUILTIN_DIR_NAME));
      } catch {
        // 非空（并发调用的子目录仍在）或已被清理：忽略
      }
    }
  }
}
