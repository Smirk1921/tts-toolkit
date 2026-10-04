// src/host/steamcloud.ts
/**
 * 默认图床：Steam Cloud（方案设计.md §6.3 / §6.5）。
 *
 * 上传策略（用户已定，2026-10-04）：默认就用 Steam Cloud；能程序化就自动上传，
 * 不能则降级为"工具备好文件 + 生成待上传清单 → 提示用户去游戏内
 * Cloud Manager → Upload All 点一下"。**这是可接受结果，不是失败。**
 *
 * 当前实现：程序化上传到 Steam Cloud 的唯一已知途径是游戏内 Cloud Manager 的 GUI
 * （§6.5 标注"待验证、不阻塞"），CLI 无法直接调用，因此本实现始终走人工流程：
 * - 把文件拷贝到暂存目录（opts.stagingDir，缺省 `<cwd>/.tts/steamcloud-pending`）；
 * - 在暂存目录生成 YAML 待上传清单 {@link STEAMCLOUD_PENDING_MANIFEST_FILENAME}；
 * - 每个文件返回一条 status="pending" 的 {@link UploadResult}，附操作提示
 *   （CLI 层据此提示用户，绝不当成失败处理）。
 *
 * Upload All 的额外好处（§6.5）：它会**自动重写存档里所有 URL**，省掉回写步骤。
 *
 * 接口升级路径：将来若验证出程序化上传途径，只需让 upload() 对可自动上传的文件返回
 * status="uploaded" 的结果，调用方代码不变。
 *
 * 错误码（PackError）：
 * - "HOST_INVALID_INPUT" 入参文件结构非法 / 重名 / 对象名含 ".."（校验细节见 src/host/types.ts）
 * - "HOST_UPLOAD_FAILED" 暂存文件或清单写入磁盘失败（IO 错误）
 *
 * 本模块新增的 i18n 键（locales/*.json 双语镜像）：
 * - `host.steamcloud.pendingHint` {count} {stagingDir} {manifestPath}
 * - `host.steamcloud.manifestHint` {count}
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";
import { probeHttpLiveness, parseUploadOptions, safeObjectName, validateUploadFiles } from "./types.js";
import type { File, HostCapabilities, ImageHost, Liveness, UploadOptions, UploadResult } from "./types.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 待上传清单文件名（写在暂存目录下，YAML 格式） */
export const STEAMCLOUD_PENDING_MANIFEST_FILENAME = "pending-upload.yaml";

/** 缺省暂存目录相对段（相对 process.cwd()；.tts/ 是图包工作区的工具私有区，不入 git） */
export const DEFAULT_STAGING_SEGMENTS = [".tts", "steamcloud-pending"] as const;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 待上传清单的内存结构（写盘前形态） */
interface PendingManifest {
  /** 生成时间（ISO 8601） */
  generated: string;
  /** 给用户的操作提示（已本地化） */
  hint: string;
  /** 待上传文件列表 */
  files: Array<{ name: string; bytes: number }>;
}

// ---------------------------------------------------------------------------
// 导出类
// ---------------------------------------------------------------------------

/**
 * Steam Cloud 图床（默认图床）。
 */
export class SteamCloudHost implements ImageHost {
  /** 图床 id（内置默认 "steamcloud"；配置声明重命名时为声明名） */
  readonly id: string;

  /**
   * @param options.id 图床 id（缺省 "steamcloud"）
   */
  constructor(options: { id?: string } = {}) {
    this.id = options.id ?? "steamcloud";
  }

  /**
   * 准备 Steam Cloud 手动上传：拷贝文件到暂存目录并生成待上传清单。
   *
   * @param files 待上传文件列表
   * @param opts.stagingDir 暂存目录；缺省 `<cwd>/.tts/steamcloud-pending`
   * @returns 每个文件一条 status="pending" 的结果（含暂存目录 / 清单路径 / 操作提示）
   * @throws PackError code="HOST_INVALID_INPUT" 文件结构非法 / 重名 / 含 ".." 段时
   * @throws PackError code="HOST_UPLOAD_FAILED" 文件拷贝或清单写入磁盘失败时
   */
  async upload(files: File[], opts: UploadOptions): Promise<UploadResult[]> {
    const validated = validateUploadFiles(files);
    const options = parseUploadOptions(opts);

    const stagingDir = options.stagingDir ?? path.join(process.cwd(), ...DEFAULT_STAGING_SEGMENTS);
    const entries: Array<{ name: string; bytes: number }> = [];
    const manifestPath = path.join(stagingDir, STEAMCLOUD_PENDING_MANIFEST_FILENAME);

    try {
      for (const file of validated) {
        const objectName = safeObjectName(file.name);
        const destination = path.join(stagingDir, objectName);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, file.data);
        entries.push({ name: objectName, bytes: file.data.byteLength });
      }

      const manifest: PendingManifest = {
        generated: new Date().toISOString(),
        hint: t("host.steamcloud.manifestHint", { count: entries.length }),
        files: entries,
      };
      await writeFile(manifestPath, stringifyYaml(manifest), "utf8");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new PackError(
        "HOST_UPLOAD_FAILED",
        t("error.host.uploadFailed", { host: this.id, file: entries.at(-1)?.name ?? "-", detail }),
      );
    }

    const hint = t("host.steamcloud.pendingHint", {
      count: entries.length,
      stagingDir,
      manifestPath,
    });
    return validated.map((file) => ({
      file: file.name,
      status: "pending" as const,
      pending: { hint, stagingDir, manifestPath },
    }));
  }

  /**
   * 存活检测：Steam Cloud 的图床 URL（cloud-*.steamusercontent.com 等）就是普通 http(s)
   * 资源，走通用 HTTP 探测（HEAD，必要时退化为 GET）。
   *
   * @param url 待检测 URL
   * @returns 检测结果（不抛网络错误）
   */
  async check(url: string): Promise<Liveness> {
    return probeHttpLiveness(url);
  }

  /**
   * 能力声明。
   *
   * - maxFileSize：Steam Cloud 单文件上限未见官方公开数值（每账号总量 100GB），暂不声明；
   * - deletable：CLI 没有删除 Steam Cloud 文件的途径，如实声明 false。
   */
  capabilities(): HostCapabilities {
    return { deletable: false };
  }
}
