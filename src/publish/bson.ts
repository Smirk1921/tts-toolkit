// src/publish/bson.ts
/**
 * BSON 载荷生成：TTS 存档 JSON → 工坊上传用 BSON 文件（发布链路第一步）。
 *
 * 属于窗口 G（阶段 7：测试运行器 + 发布链路），由 B1 产出。
 *
 * 职责：
 * - {@link buildBson}：读入 pack build 的产物（TTS 存档 JSON，参见
 *   src/pack/build.ts 的 buildSave），用 `bson` 包序列化为 Buffer，做头部长度
 *   自检后落盘；
 * - {@link verifyBsonFile}：独立自检工具——BSON 前 4 字节小端整数是否等于文件大小。
 *
 * 格式依据（参考资料/05-工坊发布/上传方式与SteamAPI.md §2.4【实测】）：TTS 工坊
 * 条目的载荷是单个 BSON 文件，实测条目 2955382975 的文件前 4 字节小端整数与文件
 * 大小完全吻合 → 与标准 BSON 兼容。`bson.serialize` 的输出头部自带该长度字段，
 * 自检通过即可直接作为上传载荷（SteamCMD / kpsteam / 游戏内手动上传通用）。
 *
 * 错误码（{@link PackError.code}，本模块新增；locales/*.json 由 Stage C 补齐）：
 * - "PUBLISH_JSON_NOT_FOUND"  输入 JSON 文件不存在
 * - "PUBLISH_JSON_INVALID"    输入不是合法 JSON，或解析结果不是对象
 *                            （TTS 存档必须是 JSON 对象；"非不存在"的读取 IO
 *                             错误也并入此码，message 带原始 detail）
 * - "PUBLISH_BSON_INVALID"    序列化产物自检失败（前 4 字节长度 != 文件大小）
 * - "PUBLISH_OUTPUT_EXISTS"   输出文件已存在且 overwrite=false
 *
 * 本模块新增的 i18n 键（只声明键名与参数，locales 由 Stage C 补两套；
 * 缺键时 t() 原样输出键名）：
 * - `error.publish.jsonNotFound`  {path}
 * - `error.publish.jsonInvalid`   {path} {detail}
 * - `error.publish.bsonInvalid`   {headerLength} {byteLength}
 * - `error.publish.outputExists`  {path}
 *
 * 边界行为（任务书未指定处，按防御式实现并在测试中钉住）：
 * - {@link verifyBsonFile} 对不足 4 字节的文件返回 `ok: false`（headerLength: 0，
 *   表示"无可读头"），不抛错——自检工具应当给出布尔结论而不是抛异常；
 * - 写输出文件时发生的 IO 错误（磁盘满、权限等）原样抛出 Node 原生错误，
 *   本模块只对上述 4 个错误码负责。
 */

import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { serialize } from "bson";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";

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

// ---------------------------------------------------------------------------
// 导出接口
// ---------------------------------------------------------------------------

/** {@link buildBson} 的入参 */
export interface BsonBuildOptions {
  /** 输入 JSON 路径（pack build 产物，TTS 存档） */
  jsonPath: string;
  /** 输出 BSON 路径 */
  outPath: string;
  /** 是否覆盖已存在的输出（默认 true） */
  overwrite?: boolean;
}

/** {@link buildBson} 的返回值 */
export interface BsonBuildResult {
  /** 输出 BSON 绝对路径 */
  outPath: string;
  /** BSON 总字节数 */
  byteLength: number;
  /** 头部 4 字节小端值（必须等于 byteLength） */
  headerLength: number;
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 把 TTS 存档 JSON 文件转换为 BSON 载荷文件。
 *
 * 流程：读入（utf-8）→ JSON.parse → `bson.serialize` → 头部 4 字节小端长度
 * 自检 →（按 overwrite 决定是否允许覆盖）→ 写出。
 *
 * @param opts 输入 / 输出路径与覆盖策略
 * @returns 输出绝对路径、总字节数与头部长度（两者恒相等，自检保证）
 * @throws PackError code="PUBLISH_JSON_NOT_FOUND" 输入 JSON 文件不存在时
 * @throws PackError code="PUBLISH_JSON_INVALID" 输入不是合法 JSON、解析结果不是
 *                                对象，或读取时发生"不存在"以外的 IO 错误时
 * @throws PackError code="PUBLISH_BSON_INVALID" 序列化产物自检失败时
 * @throws PackError code="PUBLISH_OUTPUT_EXISTS" 输出已存在且 overwrite=false 时
 */
export async function buildBson(opts: BsonBuildOptions): Promise<BsonBuildResult> {
  const outPath = path.resolve(opts.outPath);

  // 1. 读输入 JSON
  let raw: string;
  try {
    raw = await readFile(opts.jsonPath, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      throw new PackError("PUBLISH_JSON_NOT_FOUND", t("error.publish.jsonNotFound", { path: opts.jsonPath }));
    }
    throw new PackError(
      "PUBLISH_JSON_INVALID",
      t("error.publish.jsonInvalid", { path: opts.jsonPath, detail: errMessage(err) }),
    );
  }

  // 2. 解析 JSON：解析失败或结果不是对象（TTS 存档必须是对象）都算 PUBLISH_JSON_INVALID
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new PackError(
      "PUBLISH_JSON_INVALID",
      t("error.publish.jsonInvalid", { path: opts.jsonPath, detail: errMessage(err) }),
    );
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new PackError(
      "PUBLISH_JSON_INVALID",
      t("error.publish.jsonInvalid", { path: opts.jsonPath, detail: `顶层必须是 JSON 对象（收到 ${describeValue(doc)}）` }),
    );
  }

  // 3. 序列化为 BSON（bson v7 的 serialize 类型上返回 Uint8Array，运行时是 Buffer；
  //    包一层 Buffer.from 以获得 readUInt32LE 等二进制方法）
  const buf = Buffer.from(serialize(doc));

  // 4. 自检：前 4 字节小端整数 == 文件大小（§2.4 的工坊载荷格式要求）
  const headerLength = buf.readUInt32LE(0);
  if (headerLength !== buf.length) {
    throw new PackError(
      "PUBLISH_BSON_INVALID",
      t("error.publish.bsonInvalid", { headerLength, byteLength: buf.length }),
    );
  }

  // 5. 输出已存在且不允许覆盖时拒绝（默认允许覆盖）
  if (opts.overwrite === false) {
    const exists = await fileExists(outPath);
    if (exists) {
      throw new PackError("PUBLISH_OUTPUT_EXISTS", t("error.publish.outputExists", { path: outPath }));
    }
  }

  // 6. 落盘
  await writeFile(outPath, buf);

  // 7. 返回结果（outPath 已在最前面 resolve 成绝对路径）
  return { outPath, byteLength: buf.length, headerLength };
}

/**
 * 自检一个 BSON 文件：前 4 字节小端整数是否等于文件大小（§2.4 的格式要求）。
 *
 * 只做布尔结论，不抛错：文件不足 4 字节时返回 `ok: false`（headerLength: 0，
 * 表示无可读头）；文件不存在等读取错误由调用方按 Node 原生错误处理。
 *
 * @param filePath BSON 文件路径
 * @returns ok 是否通过自检，以及文件大小与头部长度
 */
export async function verifyBsonFile(
  filePath: string,
): Promise<{ ok: boolean; byteLength: number; headerLength: number }> {
  const buf = await readFile(filePath);
  if (buf.length < 4) {
    return { ok: false, byteLength: buf.length, headerLength: 0 };
  }
  const headerLength = buf.readUInt32LE(0);
  return { ok: headerLength === buf.length, byteLength: buf.length, headerLength };
}

// ---------------------------------------------------------------------------
// 仅本模块使用的辅助
// ---------------------------------------------------------------------------

/** 判断文件是否存在（access F_OK 探测，任何失败都视为不存在） */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 给 PUBLISH_JSON_INVALID 的 detail 用的值类型简述（不展开内容，避免超长 message） */
function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "数组";
  }
  return typeof value;
}
