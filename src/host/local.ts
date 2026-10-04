// src/host/local.ts
/**
 * 本地图床：把文件写进本地目录，以 file:// URL 表示（方案设计.md §6.3）。
 *
 * **仅本机测试用** —— 别人加载不到 file:// URL，正式图包请用 steamcloud / s3 / command。
 * 用途：开发调试时验证"上传 → 拿 URL → 存档引用"的整条链路，不需要网络。
 *
 * 全局配置声明（config.yaml 的 hosts 字段，由 src/host/command.ts 解析并构造本类）：
 *
 * ```yaml
 * hosts:
 *   my-local:
 *     type: local
 *     dir: D:/tts-cdn-test   # 输出目录（不存在时自动创建）
 * ```
 *
 * 错误码（PackError）：
 * - "HOST_CONFIG_INVALID" 构造参数 dir 为空
 * - "HOST_INVALID_INPUT"  入参文件结构非法 / 重名 / 对象名含 ".."（校验细节见 src/host/types.ts）
 * - "HOST_UPLOAD_FAILED"  写盘失败（IO 错误）
 *
 * check 不抛错：URL 不是 file:// 协议、文件不存在等情况都以 alive=false + error 描述返回。
 *
 * 本模块新增的 i18n 键（locales/*.json 双语镜像）：
 * - `error.host.checkNotLocal` {url}
 * - `error.host.localFileMissing` {path}
 * （error.host.uploadFailed / error.host.config* 见 steamcloud.ts、command.ts）
 */

import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";
import { parseUploadOptions, safeObjectName, validateUploadFiles } from "./types.js";
import type { File, HostCapabilities, ImageHost, Liveness, UploadOptions, UploadResult } from "./types.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** LocalHost 构造参数 */
export interface LocalHostOptions {
  /** 图床 id（配置声明时为声明名；直接构造时缺省 "local"） */
  readonly id?: string;
  /** 输出目录（绝对 / 相对路径均可；上传时自动创建） */
  readonly dir: string;
}

// ---------------------------------------------------------------------------
// 导出类
// ---------------------------------------------------------------------------

/**
 * 本地图床（仅本机测试用）。
 */
export class LocalHost implements ImageHost {
  /** 图床 id */
  readonly id: string;

  /** 输出目录（绝对路径，上传时自动创建） */
  readonly dir: string;

  /**
   * @param options 构造参数
   * @throws PackError code="HOST_CONFIG_INVALID" dir 不是非空字符串时
   */
  constructor(options: LocalHostOptions) {
    if (typeof options.dir !== "string" || options.dir.trim() === "") {
      throw new PackError(
        "HOST_CONFIG_INVALID",
        t("error.host.configInvalid", {
          name: options.id ?? "local",
          detail: t("error.host.config.missingLocalDir"),
        }),
      );
    }
    this.id = options.id ?? "local";
    this.dir = path.resolve(options.dir.trim());
  }

  /**
   * 上传：把文件写入配置的目录（保持对象名的相对路径结构），返回 file:// URL。
   *
   * @param files 待上传文件列表
   * @returns 与入参同序的上传结果
   * @throws PackError code="HOST_INVALID_INPUT" 文件结构非法 / 重名 / 含 ".." 段时
   * @throws PackError code="HOST_UPLOAD_FAILED" 写盘失败时
   */
  async upload(files: File[], opts: UploadOptions): Promise<UploadResult[]> {
    const validated = validateUploadFiles(files);
    parseUploadOptions(opts); // 本实现无可选行为，仍校验 opts 以统一各实现的入参契约

    const results: UploadResult[] = [];
    for (const file of validated) {
      const objectName = safeObjectName(file.name);
      const destination = path.join(this.dir, objectName);
      try {
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, file.data);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new PackError(
          "HOST_UPLOAD_FAILED",
          t("error.host.uploadFailed", { host: this.id, file: file.name, detail }),
        );
      }
      results.push({ file: file.name, status: "uploaded", url: pathToFileURL(destination).href });
    }
    return results;
  }

  /**
   * 存活检测：只认 file:// URL 或本地路径（本地图床没有 HTTP 服务）。
   *
   * - `file://` URL → 解析为本地路径，存在且是文件则存活；
   * - 其他协议（http:// 等）→ 不存活，error 提示 local 图床只认 file://；
   * - 文件不存在 → 不存活，error 含本地路径。
   *
   * @param url file:// URL 或本地路径
   * @returns 检测结果（不抛错）
   */
  async check(url: string): Promise<Liveness> {
    if (typeof url !== "string" || url.trim() === "") {
      return { alive: false, error: t("error.host.checkNotLocal", { url: String(url) }) };
    }
    const trimmed = url.trim();

    let filePath: string;
    if (trimmed.startsWith("file:")) {
      try {
        filePath = fileURLToPath(trimmed);
      } catch {
        return { alive: false, error: t("error.host.checkNotLocal", { url: trimmed }) };
      }
    } else if (/^[a-z][a-z0-9+.-]+:/i.test(trimmed)) {
      // 其他协议（http:、https:、ftp:、mailto: …）一律不存活并提示。
      // scheme 按 RFC 3986 至少两个字符（{1,} 量词）：Windows 盘符（"C:\…"，单字母）不会
      // 命中，落到下方按本地路径处理。
      return { alive: false, error: t("error.host.checkNotLocal", { url: trimmed }) };
    } else {
      filePath = trimmed;
    }

    try {
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        return { alive: true };
      }
    } catch {
      // stat 失败（权限等）按不存在处理，落到下方统一返回
    }
    return { alive: false, error: t("error.host.localFileMissing", { path: filePath }) };
  }

  /**
   * 能力声明：无大小 / 格式限制；本地文件可直接删除，如实声明 true。
   */
  capabilities(): HostCapabilities {
    return { deletable: true };
  }
}
