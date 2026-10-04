// src/assets/migrate.ts
/**
 * 图床迁移 / 死链修复 + 离线缓存预置（方案设计 §6.4 / §6.8 / §4.6.1）。
 *
 * 职责（与 fetch.ts 的分工：fetch 负责"识别与探测"，migrate 负责"改写与落地"）：
 * - {@link collectSaveUrls}：遍历存档 JSON 收集全部 URL（**只读**）；
 * - {@link applyUrlMigration}：按 URL 映射表批量改写存档（**原地写回，绝不做深拷贝**）；
 * - {@link cacheFileName}：§6.8 缓存文件名规则（URL 去掉所有非字母数字字符 + 扩展名）；
 * - {@link presetOfflineCache}：把素材预置到 `<Mods>/Images/`，TTS 命中缓存后不再联网下载
 *   ——对死链素材是"不迁移也能玩"的兜底修复；对慢速图床是离线加速。
 *
 * 遍历器红线：**URL 的读取与改写一律复用 src/deck/patch.ts 的 {@link walkSaveUrls}
 * （全仓唯一遍历器），本模块绝不重写递归**（§4.6.1："objects 不另起炉灶"）。
 * {lang} 语言变体沿用 walkSaveUrls 默认跳过语义——迁移永不触碰语言变体值。
 *
 * 缓存文件名契约（§6.8 实测）：
 * - 文件名 = **存档里写的那个 URL** 去掉所有非字母数字字符 + 扩展名
 *   （例：`http://cloud-3.steamusercontent.com/ugc/177.../1D79.../` →
 *   `httpcloud3steamusercontentcomugc177...1D79....png`）；
 * - 因此 {@link presetOfflineCache} 必须按**调用方传入的 URL 原文**命名——
 *   TTS 按它自己请求的 URL（即存档中的值）查缓存；若先迁移存档再预置，
 *   请用迁移后的新 URL 作为传入值，否则 TTS 命中不了；
 * - 与 TTS 行为一致，不做长度截断。
 *
 * 错误：入参非法抛 {@link PackError}（code 见各函数注释）；单个素材下载 / 写盘失败
 * 不中断整批，记录进结果（与 fetch.ts 的批量语义一致）。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ProxyAgent } from "undici";
import { z } from "zod";

import { walkSaveUrls } from "../deck/patch.js";
import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";
import {
  describeUrl,
  fetchAsset,
  guessExtension,
  manualReasonText,
  type FetchOutcome,
} from "./fetch.js";

/** TTS 离线缓存子目录名（§6.8：素材缓存在 `Mods\Images\`；datadir 即 Mods 目录） */
export const TTS_IMAGES_DIRNAME = "Images";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 存档 URL 盘点结果（collectSaveUrls 的产物，只读） */
export interface SaveUrlInventory {
  /** 访问到的 URL 字段总数（{lang} 变体不计入） */
  visited: number;
  /** 去重后的 URL（按字典序——UTF-16 码元序——升序，含 file: 本地路径） */
  urls: string[];
  /** file: 本地路径引用数（§2.6.4：他人加载看不到，需重新上传） */
  localFiles: number;
}

/** 单处 URL 改写记录（applyUrlMigration 的产物，用于 diff 与人工核对） */
export interface UrlChange {
  /** 对象在存档里的路径（与 walkSaveUrls 的 loc.objectPath 一致） */
  objectPath: string;
  /** 对象 GUID（缺失时为 ""） */
  guid: string;
  /** 字段路径（素材字段两段、直接字段一段，与 walkSaveUrls 契约一致） */
  fieldPath: readonly string[];
  /** 原值 */
  from: string;
  /** 新值 */
  to: string;
}

/** URL 迁移结果 */
export interface MigrationResult {
  /** 访问到的 URL 字段总数（{lang} 变体不计入） */
  visited: number;
  /** 实际改写处数 */
  rewritten: number;
  /** file: 本地路径引用数（不参与映射改写，只计数） */
  localFiles: number;
  /** 逐处改写记录（按遍历顺序） */
  changes: UrlChange[];
}

/** 离线预置的单条输入 */
export interface PresetEntry {
  /** 素材 URL——**必须与存档中实际写的 URL 完全一致**（文件名按它计算，见模块头注释） */
  url: string;
  /** 已有字节（离线场景直接提供，跳过下载） */
  data?: Uint8Array;
  /** 显式扩展名（如 "png"）；缺省时按 URL 路径 / Content-Type 推断 */
  ext?: string;
}

/** 单条下载函数（presetOfflineCache 的网络边界，可注入替换用于离线测试） */
export type PresetFetcher = (url: string) => Promise<FetchOutcome>;

/** presetOfflineCache 选项 */
export interface PresetOptions {
  /**
   * Mods 目录绝对路径（即 datadir——src/datadir/locate.ts 的产物）。
   * 缓存写入 `<modsDir>/Images/`（§6.8）。
   */
  modsDir: string;
  /** 预置条目（至少一条） */
  entries: readonly PresetEntry[];
  /** 自定义下载函数（默认 fetchAsset）；传入后用于全部需要下载的条目 */
  fetchFn?: PresetFetcher;
  /** 下载单请求超时毫秒数，默认 10000（仅默认 fetchFn 生效） */
  timeoutMs?: number;
  /** 下载响应体大小上限字节数（仅默认 fetchFn；默认不限） */
  maxBytes?: number;
}

/** 单条预置成功记录 */
export interface PresetWritten {
  /** 素材 URL（传入原文） */
  url: string;
  /** 落盘绝对路径 */
  file: string;
  /** 字节数 */
  bytes: number;
}

/** 单条失败记录（下载失败 / 扩展名无法判断 / 写盘失败） */
export interface PresetFailure {
  url: string;
  /** 中文原因 */
  reason: string;
}

/** 单条跳过记录（不可下载形态：file: / {lang} / 未知 / Google Drive 非文件链接） */
export interface PresetSkip {
  url: string;
  /** 中文原因 */
  reason: string;
}

/** 离线预置结果 */
export interface PresetResult {
  /** 实际写入的缓存目录（`<modsDir>/Images`） */
  imagesDir: string;
  /** 成功写入 */
  written: PresetWritten[];
  /** 失败 */
  failed: PresetFailure[];
  /** 跳过（不可下载形态） */
  skipped: PresetSkip[];
}

// ---------------------------------------------------------------------------
// zod 校验（运行时边界统一 unknown + zod，禁止 any）
// ---------------------------------------------------------------------------

/** 非空字符串 */
const nonEmptyString = z.string({ error: "必须是字符串" }).trim().min(1, "不能为空字符串");

/** presetOfflineCache 入参结构 */
const presetOptsSchema = z.object(
  {
    modsDir: nonEmptyString,
    entries: z
      .array(
        z.object(
          {
            url: z.string({ error: "url 必须是字符串" }),
            data: z.instanceof(Uint8Array, { error: "data 必须是 Uint8Array" }).optional(),
            ext: nonEmptyString.optional(),
          },
          { error: "每个条目必须是 { url, data?, ext? } 对象" },
        ),
        { error: "entries 必须是条目数组" },
      )
      .min(1, "entries 不能为空"),
    fetchFn: z.custom<PresetFetcher>((value) => typeof value === "function", {
      error: "fetchFn 必须是函数",
    }).optional(),
    timeoutMs: z
      .number({ error: "timeoutMs 必须是数字" })
      .int("timeoutMs 必须是整数")
      .min(1, "timeoutMs 必须 ≥ 1")
      .optional(),
    maxBytes: z
      .number({ error: "maxBytes 必须是数字" })
      .int("maxBytes 必须是整数")
      .min(1, "maxBytes 必须 ≥ 1")
      .optional(),
  },
  { error: "opts 必须是键值对象" },
);

/** 将 zod 校验错误格式化为单行中文可读描述（仓库各模块同款实现） */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const segments = issue.path.map((seg) => (typeof seg === "symbol" ? seg.toString() : String(seg)));
      const where = segments.length > 0 ? segments.join(".") : "(根)";
      return `${where}：${issue.message}`;
    })
    .join("；");
}

/** 入参非法时统一抛出的 PackError（code 固定 ASSETS_MIGRATE_INVALID） */
function invalidMigrate(detail: string): PackError {
  return new PackError("ASSETS_MIGRATE_INVALID", t("error.assets.migrateInvalid", { detail }));
}

/** 入参非法时统一抛出的 PackError（code 固定 ASSETS_PRESET_INVALID） */
function invalidPreset(detail: string): PackError {
  return new PackError("ASSETS_PRESET_INVALID", t("error.assets.presetInvalid", { detail }));
}

/** 宿主对象判定（与 deck/patch.ts 同款：JSON.parse 产物，数组与 null 排除） */
function isHostObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验存档根对象；不合格直接抛错（不静默当作"无 URL"，避免用户误以为迁移成功） */
function assertRootObject(root: unknown): void {
  if (!isHostObject(root)) {
    throw invalidMigrate(
      t("error.assets.migrateRoot", { detail: `typeof root = ${typeof root}` }),
    );
  }
}

/**
 * 归一化映射表：接受 ReadonlyMap 或纯对象（JSON 友好），校验键值均为非空字符串。
 * @param mapping URL 映射（from → to）
 * @returns 键值对数组（保持插入序）
 * @throws PackError（code="ASSETS_MIGRATE_INVALID"）形态或值非法时
 */
function normalizeMapping(
  mapping: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): Array<[string, string]> {
  const entries =
    mapping instanceof Map
      ? [...mapping.entries()]
      : isHostObject(mapping)
        ? Object.entries(mapping)
        : undefined;
  if (entries === undefined) {
    throw invalidMigrate(t("error.assets.migrateMapping", { detail: t("error.assets.migrateMappingKind") }));
  }
  for (const [from, to] of entries) {
    if (typeof from !== "string" || from === "") {
      throw invalidMigrate(t("error.assets.migrateMapping", { detail: `key: ${String(from)}` }));
    }
    if (typeof to !== "string" || to === "") {
      throw invalidMigrate(t("error.assets.migrateMapping", { detail: `value of "${from}": ${String(to)}` }));
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 存档 URL 盘点与迁移（全部走 walkSaveUrls——全仓唯一遍历器）
// ---------------------------------------------------------------------------

/**
 * 盘点存档 JSON 引用的全部 URL（只读，不改任何字段）。
 *
 * 内部即 {@link walkSaveUrls} 的只读用法：{lang} 语言变体按默认语义跳过
 * （不访问、不计数）；file: 本地路径照常访问并单独计数。
 *
 * @param root 存档 JSON（通常为 JSON.parse 后的存档根对象）
 * @returns 访问总数 / 去重 URL（码元序升序）/ file: 引用数
 * @throws PackError（code="ASSETS_MIGRATE_INVALID"）root 不是普通对象时
 */
export function collectSaveUrls(root: unknown): SaveUrlInventory {
  assertRootObject(root);
  const urls = new Set<string>();
  let localFiles = 0;
  const visited = walkSaveUrls(
    root,
    (loc) => {
      urls.add(loc.currentValue);
    },
    {
      skipLangVariants: true,
      onLocalFile: () => {
        localFiles += 1;
      },
    },
  );
  return { visited, urls: [...urls].sort(), localFiles };
}

/**
 * 按 URL 映射表批量改写存档（原地写回，绝不做深拷贝——性能红线见 walkSaveUrls 注释）。
 *
 * - 匹配规则：**原文精确匹配**（walkSaveUrls 的 currentValue 即存档原文；
 *   健康报告 entries 的 url 字段就是原文，可直接当映射键）；
 * - {lang} 语言变体永远跳过（遍历器默认语义，本函数不提供关闭选项——红线）；
 * - file: 本地路径**可以**被显式映射改写（§4.6.1 的 `tts assets fix-local` 流程
 *   就是"复制 → 上传 → 把 file: 原文映射为新 URL"）；`localFiles` 计数仅供盘点；
 * - 值 unchanged（from === to）的映射忽略，不计入 rewritten。
 *
 * @param root 存档 JSON（会被原地修改）
 * @param mapping URL 映射：from → to（ReadonlyMap 或纯对象）
 * @returns 迁移结果（改写处数 + 逐处记录）
 * @throws PackError（code="ASSETS_MIGRATE_INVALID"）root 不是普通对象、mapping 形态或值非法时
 */
export function applyUrlMigration(
  root: unknown,
  mapping: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): MigrationResult {
  assertRootObject(root);
  const entries = normalizeMapping(mapping);
  const lookup = new Map(entries);

  let rewritten = 0;
  let localFiles = 0;
  const changes: UrlChange[] = [];

  const visited = walkSaveUrls(
    root,
    (loc) => {
      const to = lookup.get(loc.currentValue);
      if (to === undefined || to === loc.currentValue) {
        return;
      }
      loc.host[loc.hostKey] = to;
      rewritten += 1;
      changes.push({
        objectPath: loc.objectPath,
        guid: loc.guid,
        fieldPath: [...loc.fieldPath],
        from: loc.currentValue,
        to,
      });
    },
    {
      skipLangVariants: true,
      onLocalFile: () => {
        localFiles += 1;
      },
    },
  );

  return { visited, rewritten, localFiles, changes };
}

// ---------------------------------------------------------------------------
// 离线缓存预置（§6.8）
// ---------------------------------------------------------------------------

/**
 * 计算离线缓存文件名（§6.8 规则）：URL 去掉所有非字母数字字符 + 扩展名。
 *
 * 例：`http://cloud-3.steamusercontent.com/ugc/177.../1D79ABC/` + `png` →
 * `httpcloud3steamusercontentcomugc1771D79ABC.png`（保留大小写，与实测缓存一致）。
 * 结果只含 [A-Za-z0-9.]，天然 Windows / macOS / Linux 安全。
 *
 * @param url 素材 URL（存档原文）
 * @param ext 扩展名（带不带前导点皆可，如 "png" / ".png"；空串表示不加扩展名）
 * @returns 缓存文件名
 * @throws PackError（code="ASSETS_MIGRATE_INVALID"）url / ext 不是字符串，或剥去非字母数字后为空时
 */
export function cacheFileName(url: string, ext: string): string {
  if (typeof url !== "string") {
    throw invalidMigrate(t("error.assets.invalidUrl", { detail: `typeof url = ${typeof url}` }));
  }
  if (typeof ext !== "string") {
    throw invalidMigrate(t("error.assets.invalidExt", { detail: `typeof ext = ${typeof ext}` }));
  }
  const stripped = url.replace(/[^A-Za-z0-9]/g, "");
  if (stripped === "") {
    throw invalidMigrate(
      t("error.assets.invalidUrl", { detail: t("error.assets.urlAllStripped") }),
    );
  }
  const suffix = ext.replace(/^\./, "");
  return suffix === "" ? stripped : `${stripped}.${suffix}`;
}

/**
 * 把素材批量预置到 `<modsDir>/Images/`（§6.8：TTS 命中缓存后不再联网下载）。
 *
 * 处理流程（逐条独立，单条失败不中断整批）：
 * 1. {@link describeUrl} 识别形态；不可下载（file: / {lang} / 未知 / Google Drive
 *    非文件链接）→ skipped（原因见 assets.fetch.manualReason.*）；
 * 2. 取字节：条目自带 data 时直接用（完全离线），否则用 fetchFn 下载
 *    （默认 {@link fetchAsset}，自动走分享链接转直链与代理）；
 * 3. 定扩展名：显式 ext → URL 路径 / Content-Type 推断（{@link guessExtension}）；
 *    两者都无结论 → failed（拒绝猜测——写错扩展名 TTS 一样加载不出来）；
 * 4. 文件名 = {@link cacheFileName}(传入 URL 原文, ext)，写入 `<modsDir>/Images/`；
 *    同名文件直接覆盖（预置的正确字节优先于可能损坏的旧缓存）。
 *
 * @param opts.modsDir Mods 目录（datadir）；`Images` 子目录不存在时自动创建
 * @param opts.entries 预置条目（url 必须与存档中的 URL 一致，见模块头注释）
 * @param opts.fetchFn 自定义下载函数（离线测试注入；默认 fetchAsset）
 * @param opts.timeoutMs 下载超时毫秒数，默认 10000（仅默认 fetchFn）
 * @param opts.maxBytes 下载大小上限字节数（仅默认 fetchFn）
 * @returns 预置结果：written / failed / skipped 三组
 * @throws PackError（code="ASSETS_PRESET_INVALID"）opts 字段非法时
 * @throws PackError（code="ASSETS_PRESET_WRITE_FAILED"）Images 目录创建失败时
 */
export async function presetOfflineCache(opts: PresetOptions): Promise<PresetResult> {
  const parsed = presetOptsSchema.safeParse(opts);
  if (!parsed.success) {
    throw invalidPreset(formatZodError(parsed.error));
  }
  const { modsDir, entries } = parsed.data;

  const imagesDir = path.join(modsDir, TTS_IMAGES_DIRNAME);
  try {
    await mkdir(imagesDir, { recursive: true });
  } catch (err) {
    const detail = err instanceof Error ? `${err.message}（${imagesDir}）` : String(err);
    throw new PackError(
      "ASSETS_PRESET_WRITE_FAILED",
      t("error.assets.presetWriteFailed", { detail }),
    );
  }

  // 下载调度器按需惰性创建：全部条目自带 data（纯离线）时不碰网络资源
  let dispatcher: ProxyAgent | undefined;
  const ensureDispatcher = () => {
    if (dispatcher === undefined) {
      dispatcher = resolveProxyAgent();
    }
    return dispatcher;
  };
  const defaultFetchFn: PresetFetcher = (url) =>
    fetchAsset(url, {
      timeoutMs: parsed.data.timeoutMs,
      maxBytes: parsed.data.maxBytes,
      dispatcher: ensureDispatcher(),
    });
  const fetchFn = parsed.data.fetchFn ?? defaultFetchFn;

  const result: PresetResult = { imagesDir, written: [], failed: [], skipped: [] };
  try {
    for (const entry of entries) {
      const desc = describeUrl(entry.url);
      if (desc.downloadUrl === undefined) {
        result.skipped.push({ url: entry.url, reason: manualReasonText(desc.kind) });
        continue;
      }

      let data: Uint8Array | undefined = entry.data;
      let contentType: string | undefined;
      if (data === undefined) {
        const outcome = await fetchFn(desc.downloadUrl);
        if (!outcome.ok) {
          result.failed.push({ url: entry.url, reason: outcome.error });
          continue;
        }
        data = outcome.data;
        contentType = outcome.contentType;
      }

      const ext = entry.ext ?? guessExtension(entry.url, contentType);
      if (ext === undefined) {
        result.failed.push({ url: entry.url, reason: t("assets.migrate.extUnknown") });
        continue;
      }

      // 文件名按传入 URL 原文计算（TTS 按存档中的 URL 查缓存；见模块头注释）
      const fileName = cacheFileName(entry.url, ext);
      const filePath = path.join(imagesDir, fileName);
      try {
        await writeFile(filePath, data);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        result.failed.push({ url: entry.url, reason: t("assets.migrate.writeFailed", { detail }) });
        continue;
      }
      result.written.push({ url: entry.url, file: filePath, bytes: data.byteLength });
    }
    return result;
  } finally {
    await closeProxyAgent(dispatcher);
  }
}

// ---------------------------------------------------------------------------
// fetch.ts 的代理调度器（本模块仅在需要下载时使用；逻辑与 fetch.ts 同源）
// ---------------------------------------------------------------------------

/**
 * 创建代理调度器（读取 https_proxy / HTTPS_PROXY；未设置返回 undefined）。
 * 实现与 fetch.ts 同源约定，见其模块头注释。
 */
function resolveProxyAgent(): ProxyAgent | undefined {
  const raw = process.env.https_proxy?.trim() || process.env.HTTPS_PROXY?.trim();
  return raw === undefined || raw === "" ? undefined : new ProxyAgent(raw);
}

/** 关闭代理调度器（超时兜底 + destroy 回退，避免 keep-alive 连接拖住进程） */
async function closeProxyAgent(dispatcher: ProxyAgent | undefined): Promise<void> {
  if (dispatcher === undefined) {
    return;
  }
  await Promise.race([
    dispatcher.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 2_000).unref();
    }),
  ]);
  await dispatcher.destroy().catch(() => undefined);
}
