// src/assets/inventory.ts
/**
 * 素材盘点：驱动 TTS 会话执行 Lua 全量扫描，汇总场上所有自定义对象引用的 URL。
 *
 * 职责：
 * - 调 {@link luaScanUrlsInObject}（递归扫描 getCustomObject() 里所有 http(s) 字符串）拿到原始引用；
 * - 对 Lua 返回值做 zod 校验（外部边界一律 unknown + zod，禁止 any）；
 * - 按 URL 分组统计引用次数，输出稳定排序的盘点结果，供 CLI/后续"换图""查重"使用。
 *
 * 关键约束（坑 2）：Lua 侧的字段名是 snake_case、存档 JSON 侧是 CamelCase，
 * 两者对应关系见 ./fieldmap.ts；本模块只负责把 Lua 扫描结果原样汇总，
 * 不做字段名猜测，因此扫描覆盖面取决于 luaScanUrlsInObject() 的递归实现。
 */

import { z } from "zod";
import { SessionExec } from "../session/exec.js";
import { luaScanUrlsInObject } from "../session/lua.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一条 URL 引用 */
export interface UrlRef {
  /** 引用路径，例如 "abc123.custom.Deck.face" */
  path: string;
  /** URL */
  url: string;
}

/** 单个 URL 的引用统计 */
export interface UrlStat {
  /** URL */
  url: string;
  /** 引用次数 */
  count: number;
  /** 所有引用路径 */
  refs: UrlRef[];
}

/** 素材盘点结果 */
export interface InventoryResult {
  /** 不同 URL 数 */
  distinctUrls: number;
  /** 总引用次数 */
  totalRefs: number;
  /** 按 URL 分组的统计 */
  stats: UrlStat[];
}

// ---------------------------------------------------------------------------
// zod 校验（运行时边界统一 unknown + zod，禁止 any）
// ---------------------------------------------------------------------------

/** 非空字符串（自动去除首尾空白；类型错误提示为中文） */
const nonEmptyString = z.string({ error: "必须是字符串" }).trim().min(1, "不能为空字符串");

/** 扫描结果中单条 URL 引用的结构 */
const urlRefSchema = z.object(
  {
    path: z.string({ error: "path 必须是字符串" }),
    url: z.string({ error: "url 必须是字符串" }),
  },
  { error: "每条引用必须是 { path, url } 对象" },
);

/** luaScanUrlsInObject() 的返回值结构 */
const urlRefsSchema = z.array(urlRefSchema, { error: "素材扫描结果必须是数组" });

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 将 zod 校验错误格式化为单行中文可读描述。
 * @param error zod 校验错误对象
 * @returns 形如 "0.path：path 必须是字符串" 的描述，多个问题以"；"连接
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
 * URL 字典序比较（按 UTF-16 码元逐位比较）。
 *
 * 不用 localeCompare：其排序结果依赖 ICU/区域设置，跨机器不稳定；
 * 盘点输出需要可复现（便于 diff 与人工核对），故用确定性最强的码元序。
 */
function compareUrls(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 引用路径 + URL 的比较（先 path 后 url），用于让 UrlStat.refs 顺序稳定 */
function compareRefs(a: UrlRef, b: UrlRef): number {
  const byPath = compareUrls(a.path, b.path);
  return byPath !== 0 ? byPath : compareUrls(a.url, b.url);
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 盘点当前 TTS 场上所有自定义对象引用的 URL。
 *
 * 流程：`exec.execJson(luaScanUrlsInObject())` → zod 校验 → 按 url 分组统计 → 排序。
 * 返回顺序约定：
 * - `stats` 按 url 字典序（UTF-16 码元序）升序；
 * - 每个 `stat.refs` 按 path 字典序升序（同一 URL 被多个对象/字段引用时便于核对）。
 *
 * @param exec 已连接的会话执行器（由调用方负责连接与端口占用）
 * @param opts.guid 目标对象 guid；缺省为 "-1"（TTS 全局脚本），即扫描全场
 * @returns 盘点结果：不同 URL 数、总引用次数、按 URL 分组的统计
 * @throws Error exec 不是可用的 SessionExec（缺少 execJson）时
 * @throws Error guid 提供但不是非空字符串时
 * @throws LuaError Lua 执行报错时（由 SessionExec 抛出，含 guid/行号）
 * @throws Error Lua 返回值不是合法结构（非数组 / 缺 path / 缺 url），
 *   或 TTS 未响应导致超时（由 SessionExec 抛出）时
 */
export async function collectInventory(
  exec: SessionExec,
  opts?: { guid?: string },
): Promise<InventoryResult> {
  // 运行时防御：exec 来自 JS 调用方时可能是任意值，提前给出中文错误而不是晦涩的 TypeError
  if (exec === null || exec === undefined || typeof exec.execJson !== "function") {
    throw new Error("collectInventory 入参无效：exec 必须是 SessionExec 实例");
  }

  const guid = opts?.guid;
  if (guid !== undefined) {
    const parsedGuid = nonEmptyString.safeParse(guid);
    if (!parsedGuid.success) {
      throw new Error(`collectInventory 入参无效（guid：${formatZodError(parsedGuid.error)}）`);
    }
  }

  // 泛型用 unknown：Lua 返回值属于运行时边界，必须先过 zod 才允许当成 UrlRef[] 使用
  const raw: unknown = await exec.execJson<unknown>(
    luaScanUrlsInObject(),
    guid === undefined ? {} : { guid },
  );

  const parsed = urlRefsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`素材扫描结果结构无效（${formatZodError(parsed.error)}）`);
  }

  // 按 url 分组统计（Map 保持插入序，随后统一排序，不依赖 Lua pairs 的遍历顺序）
  const byUrl = new Map<string, UrlStat>();
  for (const ref of parsed.data) {
    let stat = byUrl.get(ref.url);
    if (stat === undefined) {
      stat = { url: ref.url, count: 0, refs: [] };
      byUrl.set(ref.url, stat);
    }
    stat.count += 1;
    stat.refs.push(ref);
  }

  const stats = [...byUrl.values()];
  for (const stat of stats) {
    stat.refs.sort(compareRefs);
  }
  stats.sort((a, b) => compareUrls(a.url, b.url));

  return {
    distinctUrls: stats.length,
    totalRefs: parsed.data.length,
    stats,
  };
}
