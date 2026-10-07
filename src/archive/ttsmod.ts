// src/archive/ttsmod.ts
/**
 * `.ttsmod` 读写：打包分发（方案设计 §12，施工流程 3B 组）。
 *
 * `.ttsmod` 就是一个普通 ZIP（Zip64），无官方 schema，内容镜像 TTS 本地
 * `Mods/` 目录结构（格式规格见 参考资料/02-数据格式/ttsmod打包格式.md，已按
 * 3 份真实样本逆向验证）。
 *
 * ## 自包含原理（全部机制）
 * 存档 JSON 里的 URL **一个字不改**；素材条目名 = TTS 自己的缓存键
 * `sanitize(url) + 扩展名`（src/archive/cachekey.ts）。接收方解压到 `Mods`
 * 的父目录后，TTS 按同样规则命中本地文件，永不访问原始 URL。扩展名由
 * src/archive/detect.ts 三级兜底推导，三级都失败时**告警并列出，绝不静默跳过**。
 *
 * ## 写（{@link exportTtsmod}）
 * 条目布局：
 * ```
 * Mods/Workshop/<id>.json                     ← 存档 JSON，逐字节原样
 * Mods/Workshop/Thumbnails/<id>.png           ← 工坊缩略图（提供时）
 * Mods/Images/<sanitized-url><ext>            ← 图片
 * Mods/Models/<sanitized-url>.obj             ← 模型（固定 .obj）
 * Mods/Assetbundles/<sanitized-url>.unity3d   ← 资源包（固定 .unity3d）
 * Mods/PDF/<sanitized-url>.PDF                ← PDF（固定 .PDF）
 * Mods/Audio/<sanitized-url><ext>             ← 音频（原工具盲区，本工具新增）
 * manifest.json                               ← 可选 manifest（根条目）
 * README*.txt                                 ← 随包说明（--readme zh|en|both）
 * ```
 * - **存档 JSON 落点**（3B.6，原工具怪癖的修正）：默认 `Mods/Workshop/`
 *   （工坊模组）；`saveJsonTarget: "saves"` 时落 `Saves/<图包名>.json`
 *   （存档备份，TTS Mod Vault 同样把它解到 Mods 父目录下的 Saves/）；
 * - **缺素材策略**（3B.8，用户已定）：默认照原工具——只打包本地已有的素材，
 *   缺的跳过，但**多一步：把跳过的列出来**（原工具静默跳过）；`strict: true`
 *   时缺任一素材即抛 {@link PackError}（code="TTSMOD_STRICT_MISSING"）不产出；
 * - **manifest.json**（3B.4）：可选（默认开），含工具名/版本/创建时间/源工坊
 *   ID/素材清单；**旧布局一个字节都不变**（manifest 是新增的根条目，旧读取器
 *   不认识就当普通文件忽略），保证与 TTS Mod Vault 互读；
 * - **随包说明**（3B.9）：`readme: "zh" | "en" | "both"`（默认 both，both 为
 *   单个双语 `README.txt`），必须写清**解压目标是 Mods 目录的父目录**；
 * - 命名约定：`<图包名> (<工坊ID>).ttsmod`（{@link ttsmodFileName}，与
 *   TTS Mod Vault 互操作；非法字符替换 `_`，存档加 `Save_` 前缀）；
 * - ZIP：deflate（收益为零的条目自动 store），启用 Zip64（条目 ≥ 4 GiB /
 *   条目数 ≥ 65535 / 中心目录越界时写 Zip64 EOCD，可 force 提前验证）。
 *
 * ## 读（{@link importTtsmod}）
 * - 条目名以 `Mods` 开头（大小写不敏感）→ 解压到 **Mods 目录的父目录**；
 *   否则 → 解压到 `ModSaveLocation`（Saves/ 等条目由此落地）；
 * - **已存在的文件不覆盖**（原工具 `DoNotOverwrite` 语义），跳过的逐个列出；
 * - 防解压逃逸（zip-slip）：条目名含 `..` 段、绝对路径、盘符的一律跳过并列出，
 *   绝不写出目标目录之外；
 * - 顺带报告 `Mods/Workshop/*.json`（工坊存档条目，供上层 unpack 复用）与
 *   `manifest.json`（如存在，JSON.parse 后原样返回，不落地）。
 *
 * ## ZIP 编解码（{@link writeZip} / {@link readZip}）
 * 自包含实现（node:zlib 的 raw deflate + zlib.crc32），不引入 zip 依赖：
 * - 读：EOCD →（escape 哨兵值时）Zip64 EOCD locator + EOCD64 → 中心目录 →
 *   本地头定位 → store / deflateRaw 解压；条目大小一律取中心目录（含 0x0001
 *   Zip64 extra 修正）——本地头在 data descriptor 场景下 size 为 0，不可信；
 * - 写：条目名统一 `/` 分隔；条目名含非 ASCII 时置 UTF-8 标志位（bit 11）；
 *   默认条目时间戳固定为 2000-01-01（不泄露本机时间，manifest 里有真实的
 *   创建时间），可用 options.timestamps 覆盖。
 *
 * 错误码（{@link PackError.code}，复用 src/pack/packyaml.ts 的 PackError）：
 * - "TTSMOD_INVALID"        输入文件不存在 / 不是 ZIP / ZIP 结构损坏或条目无法解压
 * - "TTSMOD_EXPORT_FAILED"  .ttsmod 写盘失败
 * - "TTSMOD_STRICT_MISSING" strict 模式下素材不全（message 含缺失清单）
 *
 * 本模块新增的 i18n 键（locales/*.json 双语镜像）：
 * - `error.archive.inputMissing` {path}；`error.archive.notZip` {path}；
 *   `error.archive.corrupt` {detail}；`error.archive.exportWriteFailed` {path} {detail}；
 *   `error.archive.strictMissing` {count} {list}
 * - `archive.detect.unresolvedSummary` {count}；`archive.detect.unresolvedItem` {url} {kind}
 * - `archive.export.skippedSummary` {count}；`archive.export.skippedMissing` {url} {kind}；
 *   `archive.export.skippedExt` {url} {kind}；`archive.export.duplicateEntry` {entry}
 * - `archive.import.skippedExistingSummary` {count}；
 *   `archive.import.skippedExistingItem` {path}；`archive.import.unsafeEntrySkipped` {name}；
 *   `archive.import.manifestInvalid` {name}
 * - `archive.kind.image` / `archive.kind.model` / `archive.kind.assetbundle` /
 *   `archive.kind.pdf` / `archive.kind.audio`
 * - `archive.readme.*`（随包说明全部文案，中英双语镜像，见 buildReadmeSection）
 *
 * 说明：随包说明需要**同时**产出中英两种语言文案，而 t() 只出当前语言——
 * 本模块用 {@link withLang} 在同步段落内临时切换 i18n 全局语言（用完即恢复），
 * 文案本身仍全部来自 locales/*.json，不写裸字符串。
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

import pkg from "../../package.json" with { type: "json" };
import { getLang, initI18n, t, type Lang } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";
import { cacheFileName, sanitizeUrl } from "./cachekey.js";
import {
  detectExtensions,
  scanCacheDir,
  type AssetKind,
  type CacheIndex,
  type ExtSource,
  type ExtensionDecision,
} from "./detect.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 工具名（manifest 用；与 package.json 的 name 一致） */
const TOOL_NAME = "tts-toolkit";

/** 工具版本（manifest 用；与 package.json / CLI 的 version 保持同步，import 时直接读） */
const TOOL_VERSION = pkg.version;

/** manifest 条目名（ZIP 根；旧读取器不认识根条目会当普通文件忽略，无害） */
export const MANIFEST_ENTRY = "manifest.json";

/** 素材类型 → ZIP 条目目录（§12.2 条目布局；条目名一律 `/` 分隔） */
export const ARCHIVE_ENTRY_DIRS: Readonly<Record<AssetKind, string>> = Object.freeze({
  image: "Mods/Images",
  model: "Mods/Models",
  assetbundle: "Mods/Assetbundles",
  pdf: "Mods/PDF",
  audio: "Mods/Audio",
});

/** 素材条目的固定输出次序（image → model → assetbundle → pdf → audio，与 detect 一致） */
const KIND_ORDER: readonly AssetKind[] = ["image", "model", "assetbundle", "pdf", "audio"];

/** ZIP 字段 escape 哨兵：u32 最大值（≥ 此值的字段进 Zip64 extra） */
const U32_MAX = 0xffffffff;

/** ZIP 字段 escape 哨兵：u16 最大值（条目数） */
const U16_MAX = 0xffff;

/** ZIP 常规 EOCD 魔数 */
const EOCD_SIG = 0x06054b50;
/** ZIP64 EOCD 魔数 */
const EOCD64_SIG = 0x06064b50;
/** ZIP64 EOCD locator 魔数 */
const EOCD64_LOCATOR_SIG = 0x07064b50;
/** 中心目录条目魔数 */
const CEN_SIG = 0x02014b50;
/** 本地文件头魔数 */
const LFH_SIG = 0x04034b50;

/** 默认条目时间戳：固定值（可复现、不泄露本机时间；DOS 时间最早 1980 年） */
const DEFAULT_TIMESTAMP = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

/** README 条目名：中英双语合为一个文件（readme: "both"，默认） */
const README_BOTH_ENTRY = "README.txt";
/** README 条目名：仅中文（readme: "zh"） */
const README_ZH_ENTRY = "README-zh-CN.txt";
/** README 条目名：仅英文（readme: "en"） */
const README_EN_ENTRY = "README-en-US.txt";

// ---------------------------------------------------------------------------
// ZIP 编解码
// ---------------------------------------------------------------------------

/** writeZip 的单条输入（name 用 `/` 分隔；反斜杠自动归一） */
export interface ZipEntryInput {
  /** 条目名（如 "Mods/Images/xxx.jpg"、"manifest.json"） */
  name: string;
  /** 条目字节 */
  data: Uint8Array;
}

/** readZip 的单条输出（已解压） */
export interface ZipEntry {
  /** 条目名（`/` 分隔；统一按 UTF-8 解码——真实样本条目名全 ASCII） */
  name: string;
  /** 条目字节（已解压） */
  data: Uint8Array;
}

/** writeZip 选项 */
export interface WriteZipOptions {
  /** 强制全部条目与 EOCD 走 Zip64（供离线测试 Zip64 路径，生产不需要） */
  forceZip64?: boolean;
  /** 条目时间戳（缺省固定 2000-01-01，见模块头注释） */
  timestamps?: Date;
}

/** DOS 时间（u16 × 2）；年份低于 1980 按 1980 处理 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const month = Math.min(12, Math.max(1, date.getMonth() + 1));
  const day = Math.min(31, Math.max(1, date.getDate()));
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

/** 数字 → 8 字节小端字节数组（Zip64 extra 用） */
function u64Bytes(value: number): number[] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return [...buf];
}

/**
 * 把条目序列编成 ZIP（Buffer）。
 *
 * 行为：
 * - 压缩：deflateRaw（默认级别）；压缩后不小于原字节时自动改 store（method 0）；
 * - Zip64：条目原始 / 压缩大小 ≥ 4 GiB 时该条目带 0x0001 extra（u32 基础字段写
 *   escape 哨兵、真值进 extra）；条目数 ≥ 65535、中心目录偏移 / 大小越界、
 *   或任一条目 Zip64 时追加 Zip64 EOCD + locator，常规 EOCD 相应字段写哨兵；
 *   `forceZip64` 把所有条目与 EOCD 全部按 Zip64 写（测试用）；
 * - 条目名含非 ASCII 时置 UTF-8 标志位（bit 11），写出仍为 UTF-8 字节；
 * - 同名条目**不去重**（调用方自行去重；importTtsmod 的写入侧有覆盖保护兜底）。
 *
 * @param entries 条目序列（按提供次序原样写出）
 * @param options 编码选项（全部可省略）
 * @returns ZIP 字节
 * @throws Error 条目名为空字符串时（调用方编程错误）
 */
export function writeZip(entries: readonly ZipEntryInput[], options: WriteZipOptions = {}): Buffer {
  const forceZip64 = options.forceZip64 === true;
  const { time, date } = dosDateTime(options.timestamps ?? DEFAULT_TIMESTAMP);

  const parts: Buffer[] = [];
  let offset = 0;

  /** 中心目录待用记录 */
  interface CentralRecord {
    nameBuf: Buffer;
    crc: number;
    csize: number;
    usize: number;
    method: number;
    flags: number;
    offset: number;
    zip64: boolean;
  }
  const central: CentralRecord[] = [];

  for (const entry of entries) {
    if (entry.name === "") {
      throw new Error("writeZip 入参无效：条目名必须是非空字符串");
    }
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    let method = 0;
    let payload = data;
    if (data.length > 0) {
      const deflated = deflateRawSync(data);
      if (deflated.length < data.length) {
        method = 8;
        payload = deflated;
      }
    }
    // 条目级 Zip64：任一大小触及 u32 escape 哨兵，或整体强制
    const zip64 = forceZip64 || data.length >= U32_MAX || payload.length >= U32_MAX;
    const flags = nameBuf.some((b) => b > 0x7f) ? 0x0800 : 0;
    const versionNeeded = zip64 ? 45 : 20;

    // 本地 Zip64 extra（0x0001）：原始大小 + 压缩大小（真值，各 8 字节；
    // 基础 u32 字段写哨兵）
    const localExtra = zip64
      ? Buffer.from([0x01, 0x00, 16, 0, ...u64Bytes(data.length), ...u64Bytes(payload.length)])
      : Buffer.alloc(0);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(versionNeeded, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(zip64 ? U32_MAX : payload.length, 18);
    lfh.writeUInt32LE(zip64 ? U32_MAX : data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(localExtra.length, 28);
    parts.push(lfh, nameBuf, localExtra, payload);

    central.push({
      nameBuf,
      crc,
      csize: payload.length,
      usize: data.length,
      method,
      flags,
      offset,
      zip64,
    });
    offset += lfh.length + nameBuf.length + localExtra.length + payload.length;
  }

  // —— 中心目录 ——
  const cdStart = offset;
  for (const rec of central) {
    // 中心 Zip64 extra（0x0001）：原始大小、压缩大小、本地头偏移（真值；
    // forceZip64 时三者全带，跑遍读取器的 Zip64 路径）
    const extra = rec.zip64
      ? Buffer.from([0x01, 0x00, 24, 0, ...u64Bytes(rec.usize), ...u64Bytes(rec.csize), ...u64Bytes(rec.offset)])
      : Buffer.alloc(0);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN_SIG, 0);
    cen.writeUInt16LE(45, 4); // version made by
    cen.writeUInt16LE(rec.zip64 ? 45 : 20, 6); // version needed
    cen.writeUInt16LE(rec.flags, 8);
    cen.writeUInt16LE(rec.method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(rec.crc, 16);
    cen.writeUInt32LE(rec.zip64 ? U32_MAX : rec.csize, 20);
    cen.writeUInt32LE(rec.zip64 ? U32_MAX : rec.usize, 24);
    cen.writeUInt16LE(rec.nameBuf.length, 28);
    cen.writeUInt16LE(extra.length, 30);
    cen.writeUInt16LE(0, 32); // comment len
    cen.writeUInt16LE(0, 34); // disk start
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(0, 38); // external attrs
    cen.writeUInt32LE(rec.zip64 ? U32_MAX : rec.offset, 42);
    parts.push(cen, rec.nameBuf, extra);
    offset += cen.length + rec.nameBuf.length + extra.length;
  }
  const cdSize = offset - cdStart;

  // —— EOCD（需要时前置 Zip64 EOCD + locator）——
  const anyZip64 = central.some((rec) => rec.zip64);
  const needEocd64 =
    forceZip64 || anyZip64 || central.length >= U16_MAX || cdSize >= U32_MAX || cdStart >= U32_MAX;
  if (needEocd64) {
    const eocd64Offset = offset;
    const eocd64 = Buffer.alloc(56);
    eocd64.writeUInt32LE(EOCD64_SIG, 0);
    eocd64.writeBigUInt64LE(44n, 4); // 本记录剩余大小
    eocd64.writeUInt16LE(45, 12);
    eocd64.writeUInt16LE(45, 14);
    eocd64.writeUInt32LE(0, 16); // this disk
    eocd64.writeUInt32LE(0, 20); // cd start disk
    eocd64.writeBigUInt64LE(BigInt(central.length), 24);
    eocd64.writeBigUInt64LE(BigInt(central.length), 32);
    eocd64.writeBigUInt64LE(BigInt(cdSize), 40);
    eocd64.writeBigUInt64LE(BigInt(cdStart), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(EOCD64_LOCATOR_SIG, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(eocd64Offset), 8);
    locator.writeUInt32LE(1, 16); // total disks
    parts.push(eocd64, locator);
    offset += eocd64.length + locator.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(needEocd64 ? U16_MAX : central.length, 8);
  eocd.writeUInt16LE(needEocd64 ? U16_MAX : central.length, 10);
  eocd.writeUInt32LE(needEocd64 ? U32_MAX : cdSize, 12);
  eocd.writeUInt32LE(needEocd64 ? U32_MAX : cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);

  return Buffer.concat(parts);
}

/**
 * 把 ZIP 字节解成条目序列（store / deflate / Zip64 全支持）。
 *
 * 行为（详见模块头注释"ZIP 编解码"）：
 * - EOCD 从文件尾部反向扫描（最多容 65535 字节注释）；
 * - EOCD 的条目数 / 中心目录偏移 / 大小为 escape 哨兵时，经 Zip64 EOCD
 *   locator 读 EOCD64 取真值；
 * - 条目大小一律取中心目录（含 0x0001 Zip64 extra 修正）；
 * - method 0 原样，method 8 inflateRaw；其他 method 抛错（本格式只会有这两种）；
 * - 条目名统一按 UTF-8 解码（真实样本全 ASCII；本工具写出的非 ASCII 名带
 *   UTF-8 标志位）。
 *
 * @param zip ZIP 字节
 * @returns 条目序列（按中心目录次序）
 * @throws PackError code="TTSMOD_INVALID" 结构损坏 / 不支持的压缩方法 / 解压失败时
 */
export function readZip(zip: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const corrupt = (detail: string): PackError =>
    new PackError("TTSMOD_INVALID", t("error.archive.corrupt", { detail }));

  // —— 1. EOCD 反向扫描 ——
  const scanStart = Math.max(0, buf.length - (22 + U16_MAX));
  let eocd = -1;
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw corrupt("EOCD not found");
  }
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    throw corrupt("multi-disk archive not supported");
  }
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // —— 2. Zip64 EOCD（escape 哨兵时经 locator 取真值）——
  if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    if (eocd < 20 || buf.readUInt32LE(eocd - 20) !== EOCD64_LOCATOR_SIG) {
      throw corrupt("zip64 EOCD locator not found");
    }
    const eocd64Offset = buf.readBigUInt64LE(eocd - 12);
    if (eocd64Offset > BigInt(buf.length - 56)) {
      throw corrupt("zip64 EOCD offset out of range");
    }
    const eocd64 = Number(eocd64Offset);
    if (buf.readUInt32LE(eocd64) !== EOCD64_SIG) {
      throw corrupt("zip64 EOCD signature mismatch");
    }
    count = Number(buf.readBigUInt64LE(eocd64 + 32));
    cdSize = Number(buf.readBigUInt64LE(eocd64 + 40));
    cdOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
  }

  // —— 3. 中心目录 ——
  if (cdOffset > buf.length || cdSize > buf.length - cdOffset) {
    throw corrupt("central directory out of range");
  }
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw corrupt(`central directory entry ${i} signature mismatch`);
    }
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    let lfhOffset = buf.readUInt32LE(p + 42);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const nameStart = p + 46;
    if (nameStart + nlen + elen + clen > buf.length) {
      throw corrupt(`central directory entry ${i} out of range`);
    }
    const name = buf.toString("utf8", nameStart, nameStart + nlen);

    // Zip64 extra（0x0001）：按序修正 usize / csize / lfhOffset（各字段仅当
    // 基础字段为 escape 哨兵时才在 extra 里出现）
    let extraPos = nameStart + nlen;
    const extraEnd = extraPos + elen;
    while (extraPos + 4 <= extraEnd) {
      const id = buf.readUInt16LE(extraPos);
      const size = buf.readUInt16LE(extraPos + 2);
      if (extraPos + 4 + size > extraEnd) {
        break;
      }
      if (id === 0x0001) {
        let q = extraPos + 4;
        if (usize === U32_MAX && q + 8 <= extraEnd) {
          usize = Number(buf.readBigUInt64LE(q));
          q += 8;
        }
        if (csize === U32_MAX && q + 8 <= extraEnd) {
          csize = Number(buf.readBigUInt64LE(q));
          q += 8;
        }
        if (lfhOffset === U32_MAX && q + 8 <= extraEnd) {
          lfhOffset = Number(buf.readBigUInt64LE(q));
        }
      }
      extraPos += 4 + size;
    }

    // —— 4. 本地头定位 + 解压 ——
    if (lfhOffset + 30 > buf.length || buf.readUInt32LE(lfhOffset) !== LFH_SIG) {
      throw corrupt(`local header of "${name}" not found`);
    }
    const lfhNlen = buf.readUInt16LE(lfhOffset + 26);
    const lfhElen = buf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhNlen + lfhElen;
    if (dataStart + csize > buf.length) {
      throw corrupt(`data of "${name}" out of range`);
    }
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data: Uint8Array;
    if (method === 0) {
      data = Buffer.from(raw); // 拷贝，脱离对原 buffer 的视图依赖
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw);
      } catch (err) {
        throw corrupt(`"${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      throw corrupt(`"${name}": unsupported compression method ${method}`);
    }
    entries.push({ name, data });
    p = nameStart + nlen + elen + clen;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 命名约定
// ---------------------------------------------------------------------------

/**
 * 文件名净化：Windows 非法文件名字符（`<>:"/\|?*` 与控制字符）替换 `_`，
 * 结尾的 `.` / 空格剥掉（Windows 不允许）；剥空退化为 `_`。
 * 与原工具一致（`Path.GetInvalidFileNameChars` → `_`）。
 */
function sanitizeFileName(name: string): string {
  const replaced = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  const trimmed = replaced.replace(/[. ]+$/, "");
  return trimmed === "" ? "_" : trimmed;
}

/**
 * `.ttsmod` 包文件名（命名约定：`<图包名> (<工坊ID>).ttsmod`，与 TTS Mod Vault
 * 互操作；非法字符替换 `_`）。工坊 ID 为 null / undefined 时不带 ` (<ID>)` 段
 * （未发布的图包）；`opts.save` 为 true 时加 `Save_` 前缀（原工具对存档的约定）。
 *
 * @param packName 图包显示名
 * @param workshopId 工坊 ID（未发布为 null / undefined）
 * @param opts.save 是否存档备份（加 `Save_` 前缀）
 * @returns 如 `Custom Dice Set (379104394).ttsmod`
 */
export function ttsmodFileName(
  packName: string,
  workshopId?: number | null,
  opts?: { save?: boolean },
): string {
  let stem = sanitizeFileName(packName);
  if (opts?.save === true) {
    stem = `Save_${stem}`;
  }
  const withId = workshopId === null || workshopId === undefined ? stem : `${stem} (${workshopId})`;
  return `${withId}.ttsmod`;
}

// ---------------------------------------------------------------------------
// 导出（写 .ttsmod）
// ---------------------------------------------------------------------------

/** 导出时的单条素材输入 */
export interface TtsmodAssetInput {
  /** 原始 URL（存档 JSON 中的原文；条目名由此按 TTS 缓存键推导） */
  url: string;
  /** 素材类型（决定条目目录与固定扩展名） */
  kind: AssetKind;
  /** 已在内存的素材字节（优先级最高） */
  data?: Uint8Array;
  /** 本地素材文件路径（存在时读取；data 与 localPath 都缺视为素材缺失） */
  localPath?: string;
}

/** 导出选项 */
export interface ExportTtsmodOptions {
  /** 输出文件路径（父目录不存在时自动创建；已存在时覆盖） */
  outPath: string;
  /** 图包显示名（manifest、README 与存档 JSON 条目名兜底用；包文件名由调用方用 ttsmodFileName 决定） */
  packName: string;
  /** 工坊 ID（未发布为 null；缺省 null。决定存档 JSON 条目名与 manifest/readme） */
  workshopId?: number | null;
  /** 上游模组 ID（无上游为 null；manifest/readme 用） */
  sourceModId?: number | null;
  /** 图包版本号（manifest/readme 用；缺省不写） */
  packVersion?: string;
  /** 存档 JSON 原文（string 按 UTF-8 编码；**逐字节原样入包，URL 一个字不改**） */
  saveJson: string | Uint8Array;
  /**
   * 存档 JSON 条目落点（3B.6）：`"workshop"`（默认）→ `Mods/Workshop/<id>.json`；
   * `"saves"` → `Saves/<图包名>.json`（存档备份，修正原工具"存档也写进
   * Mods/Workshop/"的怪癖）
   */
  saveJsonTarget?: "workshop" | "saves";
  /** 存档 JSON 条目文件名主干（缺省：workshop → `<工坊ID 或净化图包名>`；saves → `<净化图包名>`） */
  saveJsonName?: string;
  /** 工坊缩略图 PNG 字节（提供时写 `Mods/Workshop/Thumbnails/<主干>.png`） */
  thumbnail?: Uint8Array;
  /** 引用的素材清单（缺省空：只包存档 JSON） */
  assets?: readonly TtsmodAssetInput[];
  /** 各素材类型的本地缓存目录（扩展名推导第 2 级 + 素材字节兜底来源） */
  cacheDirs?: Partial<Record<AssetKind, string>>;
  /** 注入的 Content-Type 探测函数（扩展名推导第 3 级；缺省走 HTTP 探测） */
  probe?: (url: string) => Promise<string | undefined>;
  /** 探测超时（毫秒；缺省 10_000） */
  probeTimeoutMs?: number;
  /** strict 模式（3B.8）：缺任一素材（缺文件或扩展名推导失败）即抛错，不产出 */
  strict?: boolean;
  /** 随包说明（3B.9）：`"zh" | "en" | "both"`（默认 both）或 `"none"` 不生成 */
  readme?: "zh" | "en" | "both" | "none";
  /** 是否写 manifest.json 条目（3B.4，默认 true） */
  manifest?: boolean;
  /** 创建时间（manifest / README 用；缺省当前时间。测试可注入固定值） */
  createdAt?: Date;
  /** 告警回调（每条告警文案回调一次；告警同时原样收进返回值） */
  onWarn?: (message: string) => void;
}

/** 已打包素材（返回值用） */
export interface IncludedAsset {
  /** 原始 URL */
  url: string;
  /** 素材类型 */
  kind: AssetKind;
  /** ZIP 条目名 */
  entry: string;
  /** 扩展名（不含点） */
  ext: string;
  /** 扩展名来源（detect 的三级兜底 + 固定类型） */
  extSource: ExtSource;
}

/** 被跳过的素材（返回值用；调用方必须向用户列出） */
export interface SkippedAsset {
  /** 原始 URL */
  url: string;
  /** 素材类型 */
  kind: AssetKind;
  /** 跳过原因：缺本地文件 / 扩展名三级兜底全部失败 */
  reason: "missing-file" | "unresolved-ext";
}

/** manifest.json 的结构（3B.4；机器可读 JSON，字段名不走 i18n） */
export interface TtsmodManifest {
  /** manifest 结构版本（本格式自身演进用） */
  manifest_version: 1;
  /** 打包工具（名称 + 版本） */
  tool: { name: string; version: string };
  /** 创建时间（ISO 8601） */
  created_at: string;
  /** 图包信息 */
  pack: {
    /** 图包显示名 */
    name: string;
    /** 图包版本（调用方未提供时缺省） */
    version?: string;
    /** 工坊 ID（未发布为 null） */
    workshop_id: number | null;
    /** 上游模组 ID（无上游为 null） */
    source_mod_id: number | null;
    /** 存档 JSON 条目落点 */
    save_json_target: "workshop" | "saves";
  };
  /** 素材清单（含未打进去的——status 标明） */
  assets: Array<{
    /** 原始 URL */
    url: string;
    /** 素材类型 */
    kind: AssetKind;
    /** 打包状态 */
    status: "included" | "missing-file" | "unresolved-ext";
    /** ZIP 条目名（status 为 included 时才有） */
    entry?: string;
    /** 扩展名（status 为 included 时才有） */
    ext?: string;
    /** 扩展名来源（status 为 included 时才有） */
    ext_source?: ExtSource;
  }>;
}

/** exportTtsmod 的返回值 */
export interface ExportTtsmodResult {
  /** 输出文件路径（path.resolve 后的绝对路径） */
  outPath: string;
  /** ZIP 条目总数（含存档 JSON / 缩略图 / manifest / README） */
  entryCount: number;
  /** 输出文件字节数 */
  fileBytes: number;
  /** 已打包素材（去重后，按条目次序） */
  included: readonly IncludedAsset[];
  /** 被跳过的素材（**调用方必须向用户列出**；strict 模式不会走到这里） */
  skipped: readonly SkippedAsset[];
  /** 全部用户可见告警（t() 文案，与 onWarn 逐条一致） */
  warnings: readonly string[];
  /** manifest.json 是否已写入 */
  manifestIncluded: boolean;
  /** README 条目名（readme 为 "none" 时为空数组） */
  readmeEntries: readonly string[];
  /** 写入的 manifest（manifest 关闭时缺省） */
  manifest?: TtsmodManifest;
}

/** 素材去重键：`kind|url`（与 detectExtensions 一致） */
function assetKey(kind: AssetKind, url: string): string {
  return `${kind}|${url}`;
}

/**
 * 解析单条素材字节：data → localPath → 该类型缓存目录的命中文件；
 * 都取不到返回 undefined（单个文件读取失败视作缺失，不抛错）。
 */
async function resolveAssetBytes(
  asset: TtsmodAssetInput,
  kindIndexes: ReadonlyMap<AssetKind, CacheIndex>,
): Promise<Uint8Array | undefined> {
  if (asset.data instanceof Uint8Array) {
    return asset.data;
  }
  const candidates: string[] = [];
  if (typeof asset.localPath === "string") {
    candidates.push(asset.localPath);
  }
  const hit = kindIndexes.get(asset.kind)?.byBase.get(sanitizeUrl(asset.url).toLowerCase());
  if (hit !== undefined) {
    candidates.push(hit.file);
  }
  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch {
      // 文件消失 / 读取失败：尝试下一个候选，最终视为缺失
    }
  }
  return undefined;
}

/**
 * 把存档 JSON + 素材打包成 `.ttsmod`（写入 outPath）。
 *
 * 行为要点（详见模块头注释"写"一节）：
 * - 存档 JSON 逐字节原样入包，URL 一个字不改；
 * - 扩展名三级兜底（URL → 本地缓存 → Content-Type），固定扩展名类型直接短路；
 * - 素材字节来源优先级：data → localPath → 缓存目录命中文件；
 * - 缺素材：默认跳过并**逐条列出**（warnings / onWarn / 返回值三份），strict
 *   模式抛 PackError（code="TTSMOD_STRICT_MISSING"），不产出不完整的包；
 * - manifest / README 默认生成；旧布局（Mods/... 条目）不受影响；
 * - 条目去重：同名条目（不同 URL 撞同一个缓存键）只保留首条并列告警。
 *
 * @param opts 导出选项（outPath / packName / saveJson 必填）
 * @returns 导出结果
 * @throws Error outPath / packName / saveJson 等必填项非法时（调用方编程错误）
 * @throws PackError code="TTSMOD_STRICT_MISSING" strict 模式且素材不全时
 * @throws PackError code="TTSMOD_EXPORT_FAILED" 写盘失败时
 */
export async function exportTtsmod(opts: ExportTtsmodOptions): Promise<ExportTtsmodResult> {
  if (typeof opts.outPath !== "string" || opts.outPath.trim() === "") {
    throw new Error("exportTtsmod 入参无效：outPath 必须是非空字符串");
  }
  if (typeof opts.packName !== "string" || opts.packName.trim() === "") {
    throw new Error("exportTtsmod 入参无效：packName 必须是非空字符串");
  }
  if (typeof opts.saveJson !== "string" && !(opts.saveJson instanceof Uint8Array)) {
    throw new Error("exportTtsmod 入参无效：saveJson 必须是字符串或 Uint8Array");
  }

  const outPath = path.resolve(opts.outPath);
  const createdAt = opts.createdAt ?? new Date();
  const saveJsonTarget = opts.saveJsonTarget ?? "workshop";
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    opts.onWarn?.(message);
  };

  // —— 1. 素材去重 + 缓存目录索引（每盘只扫一次，同时服务推导与取字节）——
  const seen = new Map<string, TtsmodAssetInput>();
  for (const asset of opts.assets ?? []) {
    const key = assetKey(asset.kind, asset.url);
    if (!seen.has(key)) {
      seen.set(key, asset);
    }
  }
  const kindIndexes = new Map<AssetKind, CacheIndex>();
  if (opts.cacheDirs !== undefined && seen.size > 0) {
    for (const [kind, dir] of Object.entries(opts.cacheDirs)) {
      if (dir !== undefined) {
        kindIndexes.set(kind as AssetKind, await scanCacheDir(dir));
      }
    }
  }

  // —— 2. 扩展名推导（三级兜底；固定扩展名类型在 detect 内短路）——
  const decisions = new Map<string, ExtensionDecision>();
  if (seen.size > 0) {
    const report = await detectExtensions([...seen.values()], {
      cacheDirs: opts.cacheDirs,
      cacheIndexes: [...kindIndexes.values()],
      probe: opts.probe,
      probeTimeoutMs: opts.probeTimeoutMs,
    });
    for (const decision of report.decisions) {
      decisions.set(assetKey(decision.kind, decision.url), decision);
    }
  }

  // —— 3. 素材字节解析 + 跳过清单 ——
  const included: IncludedAsset[] = [];
  const skipped: SkippedAsset[] = [];
  const bytesByKey = new Map<string, Uint8Array>();
  for (const asset of seen.values()) {
    const key = assetKey(asset.kind, asset.url);
    const decision = decisions.get(key);
    if (decision === undefined || decision.ext === undefined) {
      skipped.push({ url: asset.url, kind: asset.kind, reason: "unresolved-ext" });
      continue;
    }
    const bytes = await resolveAssetBytes(asset, kindIndexes);
    if (bytes === undefined) {
      skipped.push({ url: asset.url, kind: asset.kind, reason: "missing-file" });
      continue;
    }
    bytesByKey.set(key, bytes);
    included.push({
      url: asset.url,
      kind: asset.kind,
      entry: `${ARCHIVE_ENTRY_DIRS[asset.kind]}/${cacheFileName(asset.url, decision.ext)}`,
      ext: decision.ext,
      extSource: decision.source!,
    });
  }

  // —— 4. 告警 / strict（3B.8：缺素材列出；strict 不产出）——
  if (skipped.length > 0) {
    const lines = [t("archive.export.skippedSummary", { count: skipped.length })];
    for (const item of skipped) {
      const kind = t(`archive.kind.${item.kind}`);
      lines.push(
        item.reason === "missing-file"
          ? t("archive.export.skippedMissing", { url: item.url, kind })
          : t("archive.export.skippedExt", { url: item.url, kind }),
      );
    }
    for (const line of lines) {
      warn(line);
    }
    if (opts.strict === true) {
      throw new PackError(
        "TTSMOD_STRICT_MISSING",
        t("error.archive.strictMissing", { count: skipped.length, list: lines.slice(1).join("\n") }),
      );
    }
  }

  // —— 5. 存档 JSON / 缩略图条目（3B.6：workshop → Mods/Workshop/，saves → Saves/）——
  const saveBytes =
    typeof opts.saveJson === "string" ? Buffer.from(opts.saveJson, "utf8") : Buffer.from(opts.saveJson);
  const stem =
    opts.saveJsonName !== undefined
      ? sanitizeFileName(opts.saveJsonName)
      : saveJsonTarget === "saves" || opts.workshopId == null
        ? sanitizeFileName(opts.packName)
        : String(opts.workshopId);
  const saveEntry =
    saveJsonTarget === "saves" ? `Saves/${stem}.json` : `Mods/Workshop/${stem}.json`;
  const thumbnailEntry = `Mods/Workshop/Thumbnails/${stem}.png`;

  const zipEntries: ZipEntryInput[] = [{ name: saveEntry, data: saveBytes }];
  const usedEntries = new Set<string>([saveEntry]);
  if (opts.thumbnail !== undefined) {
    zipEntries.push({ name: thumbnailEntry, data: opts.thumbnail });
    usedEntries.add(thumbnailEntry);
  }

  // —— 6. 素材条目（固定次序 + 条目名排序，可复现；同名去重保留首条）——
  included.sort((a, b) => {
    const ka = KIND_ORDER.indexOf(a.kind);
    const kb = KIND_ORDER.indexOf(b.kind);
    if (ka !== kb) {
      return ka - kb;
    }
    return a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0;
  });
  const uniqueIncluded: IncludedAsset[] = [];
  for (const item of included) {
    if (usedEntries.has(item.entry)) {
      warn(t("archive.export.duplicateEntry", { entry: item.entry }));
      continue;
    }
    usedEntries.add(item.entry);
    uniqueIncluded.push(item);
  }
  const itemByKey = new Map<string, IncludedAsset>();
  for (const item of uniqueIncluded) {
    itemByKey.set(assetKey(item.kind, item.url), item);
    zipEntries.push({ name: item.entry, data: bytesByKey.get(assetKey(item.kind, item.url))! });
  }

  // —— 7. manifest（3B.4；旧布局不变，多一个根条目；素材清单含未打进去的）——
  const manifestIncluded = opts.manifest !== false;
  let manifest: TtsmodManifest | undefined;
  if (manifestIncluded) {
    manifest = {
      manifest_version: 1,
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
      created_at: createdAt.toISOString(),
      pack: {
        name: opts.packName,
        ...(opts.packVersion !== undefined ? { version: opts.packVersion } : {}),
        workshop_id: opts.workshopId ?? null,
        source_mod_id: opts.sourceModId ?? null,
        save_json_target: saveJsonTarget,
      },
      assets: [...seen.values()].map((asset) => {
        const skip = skipped.find((s) => s.url === asset.url && s.kind === asset.kind);
        if (skip !== undefined) {
          return { url: asset.url, kind: asset.kind, status: skip.reason };
        }
        const item = itemByKey.get(assetKey(asset.kind, asset.url))!;
        return {
          url: asset.url,
          kind: asset.kind,
          status: "included" as const,
          entry: item.entry,
          ext: item.ext,
          ext_source: item.extSource,
        };
      }),
    };
    zipEntries.push({
      name: MANIFEST_ENTRY,
      data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    });
  }

  // —— 8. README（3B.9；--readme zh|en|both，默认 both；both 为单个双语文件）——
  const readmeMode = opts.readme ?? "both";
  const readmeEntries: string[] = [];
  if (readmeMode !== "none") {
    const readmeInfo = {
      packName: opts.packName,
      packVersion: opts.packVersion,
      workshopId: opts.workshopId ?? null,
      sourceModId: opts.sourceModId ?? null,
      kindCounts: countByKind(uniqueIncluded),
      missingCount: skipped.length,
      saveMode: saveJsonTarget === "saves",
      createdAt,
    };
    if (readmeMode === "en") {
      zipEntries.push({
        name: README_EN_ENTRY,
        data: Buffer.from(buildReadmeSection("en-US", readmeInfo), "utf8"),
      });
      readmeEntries.push(README_EN_ENTRY);
    } else {
      const name = readmeMode === "zh" ? README_ZH_ENTRY : README_BOTH_ENTRY;
      const zhSection = buildReadmeSection("zh-CN", readmeInfo);
      const text =
        readmeMode === "zh" ? zhSection : `${zhSection}\n\n${buildReadmeSection("en-US", readmeInfo)}`;
      zipEntries.push({ name, data: Buffer.from(text, "utf8") });
      readmeEntries.push(name);
    }
  }

  // —— 9. 编 ZIP 写盘 ——
  const zip = writeZip(zipEntries);
  try {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, zip);
  } catch (err) {
    throw new PackError(
      "TTSMOD_EXPORT_FAILED",
      t("error.archive.exportWriteFailed", {
        path: outPath,
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return {
    outPath,
    entryCount: zipEntries.length,
    fileBytes: zip.length,
    included: uniqueIncluded,
    skipped,
    warnings,
    manifestIncluded,
    readmeEntries,
    ...(manifest !== undefined ? { manifest } : {}),
  };
}

/** 按素材类型计数（README 内容行用；只统计已打包的，按 KIND_ORDER 次序） */
function countByKind(included: readonly IncludedAsset[]): Array<{ kind: AssetKind; count: number }> {
  const counts = new Map<AssetKind, number>();
  for (const item of included) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  return KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => ({
    kind,
    count: counts.get(kind)!,
  }));
}

// ---------------------------------------------------------------------------
// 随包说明（3B.9：中英双语，--readme zh|en|both，默认 both）
// ---------------------------------------------------------------------------

/** buildReadmeSection 的信息包 */
interface ReadmeInfo {
  packName: string;
  packVersion?: string;
  workshopId: number | null;
  sourceModId: number | null;
  kindCounts: ReadonlyArray<{ kind: AssetKind; count: number }>;
  missingCount: number;
  saveMode: boolean;
  createdAt: Date;
}

/**
 * 在指定语言下取 t()（同步段落内临时切换全局语言，用完即恢复）。
 * README 需要**同时**产出中英两份文案而 t() 只出当前语言——文案本身仍全部
 * 来自 locales/*.json（双语镜像），这里只是取两个语种各一遍，不写裸字符串。
 */
function withLang<T>(lang: Lang, fn: () => T): T {
  const prev = getLang();
  initI18n({ lang });
  try {
    return fn();
  } finally {
    initI18n({ lang: prev });
  }
}

/** 生成单个语言段的 README 文本（在 lang 的语境下取全部文案） */
function buildReadmeSection(lang: Lang, info: ReadmeInfo): string {
  return withLang(lang, () => {
    const lines: string[] = [];
    lines.push(lang === "zh-CN" ? t("archive.readme.sectionZh") : t("archive.readme.sectionEn"));
    lines.push(t("archive.readme.title", { packName: info.packName }));
    lines.push(t("archive.readme.generatedBy", { tool: TOOL_NAME, version: TOOL_VERSION }));
    lines.push(t("archive.readme.createdAt", { time: info.createdAt.toISOString() }));
    if (info.packVersion !== undefined) {
      lines.push(t("archive.readme.packVersion", { version: info.packVersion }));
    }
    lines.push(
      info.workshopId === null
        ? t("archive.readme.sourceWorkshopNone")
        : t("archive.readme.sourceWorkshop", { id: info.workshopId }),
    );
    if (info.sourceModId !== null) {
      lines.push(t("archive.readme.sourceMod", { id: info.sourceModId }));
    }
    if (info.kindCounts.length > 0) {
      lines.push(t("archive.readme.contents"));
      for (const { kind, count } of info.kindCounts) {
        lines.push(t(`archive.readme.kindCount.${kind}`, { count }));
      }
    }
    if (info.saveMode) {
      lines.push(t("archive.readme.saveNote"));
    }
    lines.push(t("archive.readme.importVault"));
    lines.push(t("archive.readme.importManual"));
    lines.push(t("archive.readme.unzipTargetWarning"));
    lines.push(t("archive.readme.modsLayout"));
    if (info.missingCount > 0) {
      lines.push(t("archive.readme.missingNote", { count: info.missingCount }));
    }
    return lines.join("\n");
  });
}

// ---------------------------------------------------------------------------
// 导入（读 .ttsmod）
// ---------------------------------------------------------------------------

/** 导入选项 */
export interface ImportTtsmodOptions {
  /** TTS 数据根目录（`Mods` 目录的**父目录**；`Mods/...` 条目解到这里） */
  modsParentDir: string;
  /** ModSaveLocation（非 `Mods/...` 条目——如 `Saves/`——解到这里） */
  modSaveLocation: string;
  /** 告警回调（每条告警文案回调一次；告警同时原样收进返回值） */
  onWarn?: (message: string) => void;
}

/** importTtsmod 的返回值 */
export interface ImportTtsmodResult {
  /** 包内文件条目总数（目录占位条目不计；含被跳过的） */
  totalEntries: number;
  /** 实际写出的文件数 */
  extracted: number;
  /** 已存在而未覆盖的文件（**调用方必须向用户列出**；归一后的条目名） */
  skippedExisting: readonly string[];
  /** 因不安全（`..` / 绝对路径 / 盘符）而跳过的条目名（原文） */
  skippedUnsafe: readonly string[];
  /** 包内的工坊存档条目落地路径（`Mods/Workshop/*.json`，供上层 unpack 复用） */
  workshopSaves: readonly string[];
  /** manifest.json 内容（JSON.parse 后原样返回；包内没有或缺省） */
  manifest?: unknown;
  /** 全部用户可见告警（t() 文案，与 onWarn 逐条一致） */
  warnings: readonly string[];
}

/**
 * 把 `.ttsmod` 导入 TTS 数据目录（原工具 Restore 的等价实现，见模块头注释"读"）。
 *
 * @param file `.ttsmod` 文件路径
 * @param opts 导入目标（modsParentDir / modSaveLocation 必填）
 * @returns 导入结果
 * @throws Error modsParentDir / modSaveLocation 非法时（调用方编程错误）
 * @throws PackError code="TTSMOD_INVALID" 文件不存在 / 不是 ZIP / 结构损坏时
 */
export async function importTtsmod(
  file: string,
  opts: ImportTtsmodOptions,
): Promise<ImportTtsmodResult> {
  if (typeof opts.modsParentDir !== "string" || opts.modsParentDir.trim() === "") {
    throw new Error("importTtsmod 入参无效：modsParentDir 必须是非空字符串");
  }
  if (typeof opts.modSaveLocation !== "string" || opts.modSaveLocation.trim() === "") {
    throw new Error("importTtsmod 入参无效：modSaveLocation 必须是非空字符串");
  }

  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    opts.onWarn?.(message);
  };

  // —— 1. 读文件 + ZIP 解码 ——
  let zipBytes: Buffer;
  try {
    zipBytes = await readFile(file);
  } catch (err) {
    if (err instanceof Error && (err as { code?: unknown }).code === "ENOENT") {
      throw new PackError("TTSMOD_INVALID", t("error.archive.inputMissing", { path: file }));
    }
    throw new PackError(
      "TTSMOD_INVALID",
      t("error.archive.corrupt", { detail: err instanceof Error ? err.message : String(err) }),
    );
  }
  if (zipBytes.length < 2 || zipBytes[0] !== 0x50 || zipBytes[1] !== 0x4b) {
    throw new PackError("TTSMOD_INVALID", t("error.archive.notZip", { path: file }));
  }
  const entries = readZip(zipBytes);

  // —— 2. 逐条目落地（Mods/ → modsParentDir，其余 → modSaveLocation；不覆盖）——
  const skippedExisting: string[] = [];
  const skippedUnsafe: string[] = [];
  const workshopSaves: string[] = [];
  let extracted = 0;
  let manifest: unknown;
  const fileEntries = entries.filter((e) => !e.name.endsWith("/"));

  for (const entry of fileEntries) {
    // 条目名归一：反斜杠 → `/`（旧工具 / .NET 写出可能用反斜杠分隔）
    const name = entry.name.replace(/\\/g, "/");
    const segments = name.split("/");
    const unsafe =
      name.startsWith("/") || /^[A-Za-z]:/.test(name) || segments.some((s) => s === "..");
    if (unsafe || segments.every((s) => s === "" || s === ".")) {
      skippedUnsafe.push(entry.name);
      warn(t("archive.import.unsafeEntrySkipped", { name: entry.name }));
      continue;
    }
    const safeSegments = segments.filter((s) => s !== "" && s !== ".");

    // manifest（根条目）特殊处理：不落地，parse 后随结果返回
    if (safeSegments.length === 1 && safeSegments[0]!.toLowerCase() === MANIFEST_ENTRY) {
      try {
        manifest = JSON.parse(Buffer.from(entry.data).toString("utf8"));
      } catch {
        warn(t("archive.import.manifestInvalid", { name: entry.name }));
      }
      continue;
    }

    const baseDir = /^mods(\/|$)/i.test(name) ? opts.modsParentDir : opts.modSaveLocation;
    const target = path.join(path.resolve(baseDir), ...safeSegments);

    // 已存在不覆盖（原工具 DoNotOverwrite 语义）
    let exists = false;
    try {
      exists = (await stat(target)).isFile();
    } catch {
      exists = false;
    }
    if (exists) {
      skippedExisting.push(name);
      continue;
    }

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.data);
    extracted += 1;

    // 工坊存档条目报告（Mods/Workshop/*.json，供上层 unpack 复用）
    if (
      safeSegments.length === 3 &&
      safeSegments[0]!.toLowerCase() === "mods" &&
      safeSegments[1]!.toLowerCase() === "workshop" &&
      safeSegments[2]!.toLowerCase().endsWith(".json")
    ) {
      workshopSaves.push(target);
    }
  }

  if (skippedExisting.length > 0) {
    warn(t("archive.import.skippedExistingSummary", { count: skippedExisting.length }));
    for (const name of skippedExisting) {
      warn(t("archive.import.skippedExistingItem", { path: name }));
    }
  }

  return {
    totalEntries: fileEntries.length,
    extracted,
    skippedExisting,
    skippedUnsafe,
    workshopSaves,
    ...(manifest !== undefined ? { manifest } : {}),
    warnings,
  };
}
