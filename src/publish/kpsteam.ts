// src/publish/kpsteam.ts
/**
 * kpsteam（KP-Steam）子进程封装 —— 窗口 G / 阶段 7，B2 产出。
 *
 * 把"自动上传 BSON 载荷到 Steam 创意工坊"委托给第三方工具 kpsteam
 * （https://github.com/KillahPotatoes/KP-Steam，C#，最后提交 2020-05-11）。
 * 两个入口：
 * - {@link probeKpsteam}：探测本机是否可用（找可执行文件 + `--version` 自检）；
 * - {@link kpsteamUpload}：执行 `upload` 子命令，返回 exit code 与输出全文。
 *
 * 命令形态（参考 `参考资料/05-工坊发布/上传方式与SteamAPI.md` §1.2 的实测 CI 配置）：
 *   kpsteam upload --legacy --app 286160 --item <ITEM_ID> --path <BSON>
 * 其中 --legacy 必须带（TTS 工坊条目是 legacy 单文件格式）；appId 固定 286160（TTS）。
 *
 * 红线：本模块**只以子进程方式调用用户机器上已安装的 kpsteam 可执行文件**，
 * 绝不主动启动 Steam 或 Tabletop Simulator，绝不代替用户登录任何账号。
 * kpsteam 自身依赖"Steam 客户端已在运行且登录拥有 TTS 的作者账号"这一前提
 * （参考文档 §1.2"硬性前提"），该前提是否满足由用户保证，本模块不做任何干预。
 *
 * 失败表达：**本模块不抛错**——探测失败 / 上传失败全部通过返回值表达
 * （probe.reason、result.ok=false + exitCode/stderr），CLI 层再决定是否把
 * 失败翻译成 PUBLISH_KPSTEAM_NOT_AVAILABLE / PUBLISH_UPLOAD_FAILED（见下）。
 *
 * 安全约束：
 * - 一律 node:child_process 的 spawn（缺省 shell: false），参数走 argv 数组，
 *   不拼命令字符串——路径含空格 / 中文也不会被 shell 二次解析，杜绝注入；
 * - stdout / stderr 全量捕获后随返回值交还调用方，CLI 决定如何展示。
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像；缺键时 t() 原样输出键名）：
 * - `error.publish.kpsteamNotAvailable` {reason}
 * - `error.publish.uploadFailed` {code}
 *
 * 新增错误码（声明；本模块不抛，供 CLI 层使用，locales 由 Stage C 补）：
 * - `PUBLISH_KPSTEAM_NOT_AVAILABLE`：kpsteam 不可用（NOT_WINDOWS / NOT_FOUND / VERSION_FAILED）；
 * - `PUBLISH_UPLOAD_FAILED`：kpsteam upload 以非 0 退出码结束。
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import { t } from "../i18n/index.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** Tabletop Simulator 的 Steam AppID（固定值） */
export const TTS_APP_ID = 286160;

/** kpsteam 默认安装位置（优先级低于 KPSTEAM_PATH，高于 PATH 探测） */
const DEFAULT_INSTALL_PATHS = [
  "C:\\Program Files (x86)\\kpsteam\\kpsteam.exe",
  "C:\\Program Files\\kpsteam\\kpsteam.exe",
];

/** kpsteam 可执行文件名（PATH 目录扫描用） */
const EXE_NAME = "kpsteam.exe";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** kpsteam 探测结果 */
export interface KpsteamProbe {
  /** kpsteam 可执行文件绝对路径（找到时） */
  exePath?: string;
  /** 是否可用（--version 能跑通） */
  available: boolean;
  /** 版本字符串（如果可用） */
  version?: string;
  /** 不可用的原因（"NOT_FOUND" | "VERSION_FAILED" | "NOT_WINDOWS"） */
  reason?: string;
}

/** kpsteam upload 参数 */
export interface KpsteamUploadOptions {
  /** TTS appid，固定 286160 */
  appId?: number;
  /** 工坊条目 ID（数字或字符串形式） */
  itemId: string | number;
  /** BSON 文件绝对路径 */
  bsonPath: string;
  /** kpsteam 可执行文件路径（缺省用 probeKpsteam 探测到的） */
  exePath?: string;
  /** 是否 --legacy 模式（默认 true；TTS 必须 legacy） */
  legacy?: boolean;
}

/** kpsteam upload 结果 */
export interface KpsteamUploadResult {
  /** 是否成功（exit code 0） */
  ok: boolean;
  /** exit code；-1 = 子进程根本没跑起来（spawn error / 探测失败） */
  exitCode: number;
  /** kpsteam stdout 全文 */
  stdout: string;
  /** kpsteam stderr 全文 */
  stderr: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 一次性 spawn 捕获结果 */
interface SpawnCapture {
  /** 退出码；null = 被信号终止；undefined 语义用 spawnError 表达 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** spawn 本身失败（如 ENOENT、权限不足） */
  spawnError?: Error;
}

/**
 * spawn 子进程并全量捕获 stdout / stderr，等待退出。
 * 永不 reject：spawn 失败也通过 spawnError 字段返回。
 */
function spawnCapture(exePath: string, args: string[]): Promise<SpawnCapture> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    let settled = false;

    const child = spawn(exePath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err: Error) => {
      spawnError = err;
      // spawn 失败时 Node 不会触发 close，这里直接落定，避免悬挂
      if (!settled) {
        settled = true;
        resolve({ exitCode: null, stdout, stderr, spawnError });
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        resolve({ exitCode: code, stdout, stderr, spawnError });
      }
    });
  });
}

/** 判定路径存在且是文件 */
async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** 把候选路径加入列表（Windows 文件系统大小写不敏感，按小写去重） */
function pushCandidate(list: string[], seen: Set<string>, p: string): void {
  const key = p.toLowerCase();
  if (key.length > 0 && !seen.has(key)) {
    seen.add(key);
    list.push(p);
  }
}

/** 按优先级枚举 kpsteam 候选可执行文件路径（env → 默认安装位置 → PATH 扫描） */
function candidatePaths(): string[] {
  const list: string[] = [];
  const seen = new Set<string>();
  const envPath = process.env.KPSTEAM_PATH?.trim();
  if (envPath) {
    pushCandidate(list, seen, envPath);
  }
  for (const p of DEFAULT_INSTALL_PATHS) {
    pushCandidate(list, seen, p);
  }
  // PATH 扫描（等价于 `where kpsteam`，但不额外起子进程）
  for (const dir of (process.env.PATH ?? "").split(";")) {
    const trimmed = dir.trim();
    if (trimmed) {
      pushCandidate(list, seen, `${trimmed}\\${EXE_NAME}`);
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 探测本机 kpsteam 是否可用。
 *
 * Windows-only：非 win32 平台直接返回 NOT_WINDOWS，不做任何探测。
 * 探测顺序：`KPSTEAM_PATH` → 默认安装位置（两处）→ PATH 目录逐个扫描。
 * 对每个实际存在的候选执行 `--version`：exit 0 即视为可用（取第一个成功者）；
 * 全部失败时若至少存在一个候选文件则报 VERSION_FAILED（附第一个候选路径），
 * 一个都没有则报 NOT_FOUND。
 */
export async function probeKpsteam(): Promise<KpsteamProbe> {
  if (process.platform !== "win32") {
    return { available: false, reason: "NOT_WINDOWS" };
  }
  let firstFound: string | undefined;
  for (const exePath of candidatePaths()) {
    if (!(await isFile(exePath))) {
      continue;
    }
    firstFound ??= exePath;
    const run = await spawnCapture(exePath, ["--version"]);
    if (!run.spawnError && run.exitCode === 0) {
      const version = (run.stdout.trim() || run.stderr.trim()) || undefined;
      return { available: true, exePath, version };
    }
  }
  if (firstFound) {
    return { available: false, exePath: firstFound, reason: "VERSION_FAILED" };
  }
  return { available: false, reason: "NOT_FOUND" };
}

/**
 * 执行 `kpsteam upload`。
 *
 * - opts.exePath 未提供时先 {@link probeKpsteam}；不可用则返回
 *   ok=false / exitCode=-1 / stderr=错误文案（不抛错，错误码
 *   PUBLISH_KPSTEAM_NOT_AVAILABLE 由 CLI 层按需抛出）；
 * - 参数固定为 argv 数组：upload [--legacy] --app <id> --item <id> --path <bson>；
 * - 本函数只等待 kpsteam 退出并回收输出，绝不主动启动 Steam / TTS（红线）。
 */
export async function kpsteamUpload(opts: KpsteamUploadOptions): Promise<KpsteamUploadResult> {
  let exePath = opts.exePath;
  if (!exePath) {
    const probe = await probeKpsteam();
    if (!probe.available || !probe.exePath) {
      return {
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: t("error.publish.kpsteamNotAvailable", { reason: probe.reason ?? "NOT_FOUND" }),
      };
    }
    exePath = probe.exePath;
  }

  const legacy = opts.legacy ?? true;
  const appId = opts.appId ?? TTS_APP_ID;
  const args = ["upload"];
  if (legacy) {
    args.push("--legacy");
  }
  args.push("--app", String(appId), "--item", String(opts.itemId), "--path", opts.bsonPath);

  const run = await spawnCapture(exePath, args);
  if (run.spawnError) {
    return {
      ok: false,
      exitCode: -1,
      stdout: run.stdout,
      stderr: run.stderr || run.spawnError.message,
    };
  }
  const exitCode = run.exitCode ?? -1;
  return { ok: exitCode === 0, exitCode, stdout: run.stdout, stderr: run.stderr };
}
