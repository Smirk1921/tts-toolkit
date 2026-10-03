// src/datadir/locate.ts
/**
 * TTS（Tabletop Simulator）数据目录定位模块。
 *
 * 职责：
 * - 按优先级探测 TTS 数据目录（Mods 目录）的所有可能位置，绝不写死唯一路径；
 * - 通过关键子目录（Workshop / Images / Saves）计数判断候选是否"有效"；
 * - 读写全局配置文件 config.yaml 的 datadir 字段，持久化用户的选择。
 *
 * 探测优先级（从高到低）：
 * 1. 显式指定（CLI --datadir）
 * 2. 全局配置文件 %APPDATA%\tts-toolkit\config.yaml 的 datadir 字段
 * 3. 注册表 / 游戏内 ConfigMods\Location（本阶段 TODO，未实现）
 * 4. 安装目录 <安装目录>\Tabletop Simulator_Data\Mods
 *    （安装目录依次来自环境变量 TTS_INSTALL_DIR 与三个常见 Steam 库位置）
 * 5. %USERPROFILE%\Documents\My Games\Tabletop Simulator\Mods
 * 6. macOS / Linux 对应路径（本阶段仅留 hook，未实现）
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 判定候选"有效"所需的最少关键子目录数 */
const MIN_VALID_SUBDIRS = 1;

/** 用于判定数据目录是否"有效"的关键子目录名（存在即计数） */
const VALID_SUBDIR_NAMES: readonly string[] = ["Workshop", "Images", "Saves"];

/** 从安装目录到 Mods 目录的固定相对层级：<安装目录>\Tabletop Simulator_Data\Mods */
const INSTALL_TO_MODS_SEGMENTS = ["Tabletop Simulator_Data", "Mods"] as const;

/** 未设置 TTS_INSTALL_DIR 时依次尝试的 Windows Steam 库安装目录 */
const DEFAULT_INSTALL_ROOTS: readonly string[] = [
  "D:\\SteamLibrary\\steamapps\\common\\Tabletop Simulator",
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Tabletop Simulator",
  "C:\\SteamLibrary\\steamapps\\common\\Tabletop Simulator",
];

// ---------------------------------------------------------------------------
// zod 校验（运行时边界统一 unknown + zod，禁止 any）
// ---------------------------------------------------------------------------

/** 非空字符串（自动去除首尾空白；类型错误提示为中文） */
const nonEmptyString = z.string({ error: "必须是字符串" }).trim().min(1, "不能为空字符串");

/** 全局配置文件结构（现阶段仅约定 datadir 字段；未知字段由调用方原样保留） */
const configSchema = z.object(
  { datadir: nonEmptyString.nullish() },
  { error: "配置必须是键值对象" },
);

/** locateDatadir 入参结构 */
const locateOptsSchema = z.object(
  {
    explicitPath: nonEmptyString.optional(),
    configPath: nonEmptyString.optional(),
  },
  { error: "入参必须是键值对象" },
);

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 数据目录候选（每个候选对应一个可能的 Mods 目录位置） */
export interface DatadirCandidate {
  /** 候选来源 */
  source: "explicit" | "config" | "registry" | "install-dir" | "documents" | "macos" | "linux";
  /** 候选路径（Mods 目录的绝对路径） */
  path: string;
  /** 是否存在 */
  exists: boolean;
  /** 子目录统计（存在的子目录数，用于判断"有效"） */
  validSubdirs: number;
}

/** locateDatadir 的返回结果 */
export interface LocateResult {
  /** 所有探测到的候选（按探测优先级从高到低排列，已按路径去重） */
  candidates: DatadirCandidate[];
  /** 是否需要用户选择（找到多个有效位置时为 true） */
  requiresChoice: boolean;
  /** 推荐选择（仅当恰好一个有效时填入） */
  recommended?: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 将 zod 校验错误格式化为单行中文可读描述。
 * @param error - zod 校验错误对象
 * @returns 形如 "datadir：不能为空字符串" 的描述，多个问题以"；"连接
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
 * 校验可选的路径参数（如 configPath / 显式路径）。
 * @param value - 待校验值（运行时可能来自 JS 调用方，按 unknown 处理）
 * @param name - 参数名（用于错误信息）
 * @returns 校验通过的字符串；value 为 undefined 时返回 undefined
 * @throws value 非 undefined 且不是非空字符串时抛出中文错误
 */
function assertOptionalPath(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = nonEmptyString.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${name} 无效（${formatZodError(parsed.error)}）`);
  }
  return parsed.data;
}

/**
 * 生成候选路径的去重键。
 * Windows 路径大小写不敏感，统一转小写比较；其他平台保留原始大小写。
 * @param modsPath - 候选 Mods 目录路径
 * @returns 规范化后的去重键
 */
function dedupeKey(modsPath: string): string {
  const resolved = path.resolve(modsPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 探测单个候选路径的存在性与关键子目录数。
 * @param modsPath - 候选 Mods 目录路径
 * @returns exists：目录是否存在；validSubdirs：关键子目录（Workshop/Images/Saves）中实际存在的数量
 */
function probeCandidate(modsPath: string): { exists: boolean; validSubdirs: number } {
  if (!existsSync(modsPath)) {
    return { exists: false, validSubdirs: 0 };
  }
  let validSubdirs = 0;
  for (const name of VALID_SUBDIR_NAMES) {
    try {
      if (statSync(path.join(modsPath, name)).isDirectory()) {
        validSubdirs += 1;
      }
    } catch {
      // stat 失败（权限等）视作该子目录不存在
    }
  }
  return { exists: true, validSubdirs };
}

/**
 * 判断候选是否"有效"：目录存在且关键子目录数达到 {@link MIN_VALID_SUBDIRS}。
 * @param candidate - 待判断的候选
 * @returns 有效返回 true
 */
function isValidCandidate(candidate: DatadirCandidate): boolean {
  return candidate.exists && candidate.validSubdirs >= MIN_VALID_SUBDIRS;
}

/**
 * 解析全局配置文件的默认路径。
 * Windows 下为 %APPDATA%\tts-toolkit\config.yaml；
 * 其他平台（APPDATA 未设置时）回退为 ~/.config/tts-toolkit/config.yaml。
 * @returns 配置文件绝对路径
 */
function defaultConfigPath(): string {
  const base = process.env.APPDATA ?? path.join(os.homedir(), ".config");
  return path.join(base, "tts-toolkit", "config.yaml");
}

/**
 * 从原始内容解析配置对象（不校验，保留未知字段；供 writeConfig 合并用）。
 * @param raw - 配置文件原文
 * @param filePath - 文件路径（用于错误信息）
 * @returns 合并基对象（普通对象时）；数组等非法顶层结构返回空对象
 * @throws YAML 解析失败时抛出中文错误
 */
function parseRawConfig(raw: string, filePath: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new Error(`配置文件不是合法 YAML：${filePath}（${err instanceof Error ? err.message : String(err)}）`);
  }
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>) };
  }
  return {};
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 读取全局配置文件（YAML）。
 *
 * @param configPath - 配置文件路径；缺省为 %APPDATA%\tts-toolkit\config.yaml
 *   （非 Windows 平台回退为 ~/.config/tts-toolkit/config.yaml）
 * @returns 配置内容；文件不存在或为空文件时返回 {}；`datadir: null` 视作未设置；
 *   未知字段被忽略
 * @throws configPath 非法、文件读取失败、内容不是合法 YAML，
 *   或 datadir 字段不是非空字符串时抛出中文错误
 */
export async function readConfig(configPath?: string): Promise<{ datadir?: string }> {
  const filePath = assertOptionalPath(configPath, "configPath") ?? defaultConfigPath();
  if (!existsSync(filePath)) {
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`读取配置文件失败：${filePath}（${err instanceof Error ? err.message : String(err)}）`);
  }
  // 空文件经 YAML 解析为 null，视作空配置
  if (raw.trim() === "") {
    return {};
  }
  let data: unknown;
  try {
    data = parseYaml(raw) ?? {};
  } catch (err) {
    // yaml 库抛出的 YAMLParseError 为英文，包装为中文错误（保留原始诊断信息）
    throw new Error(`配置文件不是合法 YAML：${filePath}（${err instanceof Error ? err.message : String(err)}）`);
  }
  const parsed = configSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`配置文件格式无效：${filePath}（${formatZodError(parsed.error)}）`);
  }
  const result: { datadir?: string } = {};
  if (parsed.data.datadir != null) {
    result.datadir = parsed.data.datadir;
  }
  return result;
}

/**
 * 写入全局配置文件（YAML），持久化 datadir 等字段。
 *
 * 合并语义：保留文件中已有的其他字段（含未来新增的未知字段）；
 * cfg.datadir 为 undefined 时表示清除 datadir 字段。目录不存在时自动创建。
 *
 * @param cfg - 要写入的配置（现阶段仅支持 datadir 字段）
 * @param configPath - 配置文件路径；缺省同 {@link readConfig}
 * @throws cfg 为 undefined / 字段类型非法，或已有配置文件不是合法 YAML
 *   （此时不覆盖原文件）时抛出中文错误
 */
export async function writeConfig(cfg: { datadir?: string }, configPath?: string): Promise<void> {
  if (cfg === undefined) {
    throw new Error("writeConfig 入参无效：cfg 不能为 undefined");
  }
  const parsed = configSchema.safeParse(cfg);
  if (!parsed.success) {
    throw new Error(`writeConfig 入参无效（${formatZodError(parsed.error)}）`);
  }
  const filePath = assertOptionalPath(configPath, "configPath") ?? defaultConfigPath();

  // 读取已有配置作为合并基（原样保留未知字段，不经过 schema 过滤）
  let merged: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      throw new Error(`读取配置文件失败：${filePath}（${err instanceof Error ? err.message : String(err)}）`);
    }
    merged = raw.trim() === "" ? {} : parseRawConfig(raw, filePath);
  }

  if (parsed.data.datadir != null) {
    merged.datadir = parsed.data.datadir;
  } else {
    delete merged.datadir;
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, stringifyYaml(merged), "utf8");
}

/**
 * 探测 TTS 数据目录（Mods 目录），返回全部候选与选择建议。
 *
 * 探测优先级与结果语义见模块头注释。要点：
 * - 候选按优先级从高到低排列，并按路径去重（Windows 下大小写不敏感），
 *   同一路径保留优先级更高的来源；
 * - "有效"= 目录存在且 Workshop / Images / Saves 中至少一个存在；
 * - 去重后有效候选 ≥ 2 → requiresChoice = true（必须由用户确认）；
 * - 恰好 1 个有效 → recommended = 该路径，requiresChoice = false；
 * - 0 个有效 → requiresChoice = false，不填 recommended。
 * requiresChoice 为 true 时，调用方可按数组顺序预选首个有效候选。
 *
 * @param opts - explicitPath：显式指定的 Mods 目录（对应 CLI --datadir）；
 *   configPath：覆盖全局配置文件路径（主要用于测试）
 * @returns 探测结果（含全部候选）
 * @throws opts / configPath 非法，或配置文件读取、解析、格式校验失败时抛出中文错误
 */
export async function locateDatadir(opts?: {
  explicitPath?: string;
  configPath?: string;
}): Promise<LocateResult> {
  const parsedOpts = locateOptsSchema.safeParse(opts ?? {});
  if (!parsedOpts.success) {
    throw new Error(`locateDatadir 入参无效（${formatZodError(parsedOpts.error)}）`);
  }
  const configPath = assertOptionalPath(parsedOpts.data.configPath, "configPath");
  const explicitPath = assertOptionalPath(parsedOpts.data.explicitPath, "explicitPath");

  const found: DatadirCandidate[] = [];
  const addCandidate = (source: DatadirCandidate["source"], modsPath: string): void => {
    const { exists, validSubdirs } = probeCandidate(modsPath);
    found.push({ source, path: modsPath, exists, validSubdirs });
  };

  // a. 显式指定（--datadir CLI 参数），优先级最高
  if (explicitPath !== undefined) {
    addCandidate("explicit", path.resolve(explicitPath));
  }

  // b. 全局配置文件的 datadir 字段
  const cfg = await readConfig(configPath);
  if (cfg.datadir !== undefined) {
    addCandidate("config", path.resolve(cfg.datadir));
  }

  // c. TODO(阶段后续): 读取注册表 / 游戏内 ConfigMods\Location 字段，
  //    作为 source: "registry" 候选追加到 explicit/config 之后。
  //    可行路线：子进程调用 `reg query`（Node 24.19 无 node:registry 内置模块）。
  //    本阶段不实现。

  // d. 安装目录：优先环境变量 TTS_INSTALL_DIR；未设置时依次尝试常见 Steam 库位置
  const envInstallRoot = process.env.TTS_INSTALL_DIR?.trim();
  if (envInstallRoot !== undefined && envInstallRoot !== "") {
    // 环境变量来自本机用户，使用宿主平台的 path.join 拼接
    addCandidate("install-dir", path.join(envInstallRoot, ...INSTALL_TO_MODS_SEGMENTS));
  } else {
    for (const root of DEFAULT_INSTALL_ROOTS) {
      // 固定的 Windows 库路径，统一用 path.win32.join 拼接，避免宿主平台差异
      addCandidate("install-dir", path.win32.join(root, ...INSTALL_TO_MODS_SEGMENTS));
    }
  }

  // e. 用户文档目录（Windows 惯例位置）
  const userBase = process.env.USERPROFILE?.trim() || os.homedir();
  addCandidate("documents", path.win32.join(userBase, "Documents", "My Games", "Tabletop Simulator", "Mods"));

  // f. HOOK(macos): 待实现——追加 source: "macos" 候选
  //    （常见位置 ~/Library/Application Support/Tabletop Simulator/Mods，以官方文档为准）。
  // HOOK(linux): 待实现——追加 source: "linux" 候选
  //    （常见位置为 Steam Proton 前缀内
  //    compatdata/286160/pfx/drive_c/users/<user>/Documents/My Games/Tabletop Simulator/Mods）。

  // 按路径去重（Windows 大小写不敏感），保留优先级更高（更早出现）的候选
  const seen = new Set<string>();
  const candidates: DatadirCandidate[] = [];
  for (const candidate of found) {
    const key = dedupeKey(candidate.path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(candidate);
  }

  const validPaths = candidates.filter(isValidCandidate).map((candidate) => candidate.path);
  const result: LocateResult = {
    candidates,
    requiresChoice: validPaths.length >= 2,
  };
  if (validPaths.length === 1) {
    result.recommended = validPaths[0];
  }
  return result;
}
