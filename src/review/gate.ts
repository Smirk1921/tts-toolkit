// src/review/gate.ts
/**
 * 发布门禁：读「图包审批工具」的审批结果，全 pass 才允许打包 / 上传
 * （方案设计 §13.2 集成层 ③、§13.3 闭环的最后一道闸）。
 *
 * 结果文件 schema **冻结**在审批工具的 docs/审批结果字段说明.md（本模块
 * 不发明字段、不改语义）：
 * - `data/results/<set_id>.json`：主文件，`items` 里**只有被操作过的素材**，
 *   没出现的就是「未审」；
 * - `annotations[]` 圈选：相对比例 0~1 + `side: "a"|"b"`，像素 = 比例 ×
 *   对应侧图片宽/高（`side` 决定用哪一侧的尺寸换算——两侧分辨率可能不同）；
 * - `src`：审批那一刻源B（成品）文件的指纹 = `hex(mtime_ns) + hex(size)`
 *   （实测其文档第五节的 current_stamp），用于判断结果是否已过期；
 *   老结果可能没有 `src`，约定**不判过期**（宁可放过不误判）。
 *
 * 门禁规则（"全 pass 才允许"）：
 * | 情形 | blocker 理由 |
 * |---|---|
 * | 素材不在 results.items 里，或 status 无法识别 | `unreviewed` |
 * | status = reject | `reject` |
 * | status = flag | `flag`（存疑 = 拿不准，同样不能发布） |
 * | status = pass 但给了 bRoot 且源B文件已不存在 | `fileMissing` |
 * | status = pass 但 src 指纹与当前文件不符（或文件缺失后重新出现） | `stale` |
 *
 * 每个素材至多记**一条** blocker（按上表优先级取首个命中），stale 计数另给。
 * 门禁不过（allowed=false）是**正常业务结果**（返回结构化 blockers，不抛错）；
 * 抛 PackError 只用于结果文件读不了 / 不合法等基础设施问题。
 *
 * 圈选坐标换算：{@link annotationPixelBoxes} 纯函数，尺寸由调用方给出
 * （sharp 读图属调用方职责）。S9 已明确：**二次修图自动化 out of scope**，
 * 本模块只把比例换算成像素框（round），产出交给下游，不做任何修图动作。
 *
 * 错误码（{@link PackError.code}）：
 * - "REVIEW_GATE_INPUT_INVALID"  门禁入参不合法（setId 非法 / expectedIds 与
 *                                deckDir 同时给出 / 待审清单为空等）
 * - "REVIEW_RESULT_NOT_FOUND"    结果文件不存在（`<dataDir>/results/<setId>.json`）
 * - "REVIEW_RESULT_READ_FAILED"  读取结果文件的其他 IO 错误
 * - "REVIEW_RESULT_INVALID"      JSON 解析失败 / 不符合冻结 schema /
 *                                set_id 与请求不符
 * （deckDir 侧读 cards.csv 的 DECK / CARDS_* 错误码原样透传。）
 *
 * 本模块新增的 i18n 键（locales/*.json 双语镜像；缺键时 t() 原样输出键名）：
 * - `error.review.gateInputInvalid` {detail}
 * - `error.review.resultNotFound` {path}
 * - `error.review.resultReadFailed` {path} {detail}
 * - `error.review.resultInvalid` {path} {detail}
 *
 * zod 各字段的 issue 文案写死中文（仓库既有风格），只作为 resultInvalid 摘要
 * 的数据部分出现，不单独面向用户，故不走 t()。
 */

import { readFile, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { t } from "../i18n/index.js";
import { readCardsCsv } from "../deck/cards.js";
import { PackError } from "../pack/packyaml.js";
import { isValidSetId } from "./config.js";

// ---------------------------------------------------------------------------
// 冻结 schema（宽松解析：外部文件向后兼容，未知字段剥除、缺省字段补默认）
// ---------------------------------------------------------------------------

/** 单条圈选区域（相对比例 0~1；side 决定像素换算用哪一侧图片的尺寸） */
export interface ApprovalAnnotation {
  /** 圈在哪侧：a = 源A（原图），b = 源B（成品） */
  side: "a" | "b";
  /** 相对比例：左上角 x */
  x: number;
  /** 相对比例：左上角 y */
  y: number;
  /** 相对比例：宽 */
  w: number;
  /** 相对比例：高 */
  h: number;
  /** 这一处的问题说明 */
  note: string;
  /** 可选，单条圈选的标签 */
  tag?: string;
}

/** 单个素材的审批记录（字段名保持审批工具的 snake_case，与冻结契约同构） */
export interface ApprovalItemRecord {
  /** pass / reject / flag；空串或未知值按未审处理（工具支持写 "" 清回未审） */
  status: string;
  /** 问题标签 */
  tags: string[];
  /** 备注 */
  note: string;
  /** 圈选区域 */
  annotations: ApprovalAnnotation[];
  /** 最后一次操作时间（YYYY-MM-DD HH:MM:SS） */
  reviewed_at?: string;
  /** 这条结果是在第几轮做的 */
  round?: number;
  /** 审批那一刻源B（成品）文件的指纹；老结果可能没有——没有不判过期 */
  src?: string;
  /** 可选，审批人（工具当前留空） */
  reviewer?: string;
}

/** 审批结果主文件（`data/results/<set_id>.json`） */
export interface ApprovalResult {
  /** 素材集 id（与请求不符时按结果文件不合法处理） */
  set_id: string;
  /** 素材集显示名 */
  set_name?: string;
  /** 当前轮次（点「归档本轮」会 +1） */
  round?: number;
  /** 本文件最后写入时间 */
  updated_at?: string;
  /** 素材 id → 审批记录；只有被操作过的素材才出现，没出现的就是「未审」 */
  items: Record<string, ApprovalItemRecord>;
}

const annotationSchema = z.object({
  side: z.enum(["a", "b"], { error: 'annotations[].side 必须是 "a" 或 "b"' }),
  x: z.number({ error: "annotations[].x 必须是数字" }),
  y: z.number({ error: "annotations[].y 必须是数字" }),
  w: z.number({ error: "annotations[].w 必须是数字" }),
  h: z.number({ error: "annotations[].h 必须是数字" }),
  note: z.string({ error: "annotations[].note 必须是字符串" }).default(""),
  tag: z.string({ error: "annotations[].tag 必须是字符串" }).optional(),
});

const itemRecordSchema = z.object({
  status: z.string({ error: "status 必须是字符串" }),
  tags: z.array(z.string({ error: "tags 条目必须是字符串" }), { error: "tags 必须是字符串数组" }).default([]),
  note: z.string({ error: "note 必须是字符串" }).default(""),
  annotations: z.array(annotationSchema, { error: "annotations 必须是数组" }).default([]),
  reviewed_at: z.string({ error: "reviewed_at 必须是字符串" }).optional(),
  round: z.number({ error: "round 必须是数字" }).int("round 必须是整数").optional(),
  src: z.string({ error: "src 必须是字符串" }).optional(),
  reviewer: z.string({ error: "reviewer 必须是字符串" }).optional(),
});

const approvalResultSchema = z.object({
  set_id: z.string({ error: "set_id 必须是字符串" }),
  set_name: z.string({ error: "set_name 必须是字符串" }).optional(),
  round: z.number({ error: "round 必须是数字" }).int("round 必须是整数").optional(),
  updated_at: z.string({ error: "updated_at 必须是字符串" }).optional(),
  items: z.record(z.string(), itemRecordSchema, { error: "items 必须是 素材id → 审批记录 的键值对象" }),
});

// ---------------------------------------------------------------------------
// 内部工具（与 packyaml.ts 的同名内部函数一致，按约定复制粘贴）
// ---------------------------------------------------------------------------

/**
 * 将 zod 校验错误格式化为单行中文可读摘要。
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
 * 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT），避免 any。
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
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** REVIEW_GATE_INPUT_INVALID 的统一构造 */
function gateInputInvalid(detail: string): PackError {
  return new PackError("REVIEW_GATE_INPUT_INVALID", t("error.review.gateInputInvalid", { detail }));
}

// ---------------------------------------------------------------------------
// 结果文件读取
// ---------------------------------------------------------------------------

/**
 * 计算审批结果主文件的路径。
 * @param dataDir 审批数据目录（approval.config.json 的 data_dir）
 * @param setId 素材集 id
 * @returns `<dataDir>/results/<setId>.json`
 */
export function approvalResultPath(dataDir: string, setId: string): string {
  return path.join(dataDir, "results", `${setId}.json`);
}

/**
 * 读取并校验一份审批结果主文件（schema 冻结在审批工具
 * docs/审批结果字段说明.md；宽松解析，未知字段剥除）。
 *
 * @param dataDir 审批数据目录
 * @param setId 素材集 id（同时校验 id 本身的合法性，防路径穿越）
 * @returns 解析后的审批结果
 * @throws PackError code="REVIEW_GATE_INPUT_INVALID" setId 不合法时
 * @throws PackError code="REVIEW_RESULT_NOT_FOUND" 结果文件不存在时
 * @throws PackError code="REVIEW_RESULT_READ_FAILED" 其他 IO 错误时
 * @throws PackError code="REVIEW_RESULT_INVALID" JSON 解析失败 / 不符合
 *   schema / 文件内 set_id 与请求不符时
 */
export async function readApprovalResult(dataDir: string, setId: string): Promise<ApprovalResult> {
  if (!isValidSetId(setId)) {
    throw gateInputInvalid(`素材集 id 不合法（不能为空，且不得包含路径分隔符或文件名非法字符）：${JSON.stringify(setId)}`);
  }
  const filePath = approvalResultPath(dataDir, setId);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      throw new PackError("REVIEW_RESULT_NOT_FOUND", t("error.review.resultNotFound", { path: filePath }));
    }
    throw new PackError(
      "REVIEW_RESULT_READ_FAILED",
      t("error.review.resultReadFailed", { path: filePath, detail: errMessage(err) }),
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new PackError(
      "REVIEW_RESULT_INVALID",
      t("error.review.resultInvalid", { path: filePath, detail: errMessage(err) }),
    );
  }

  const parsed = approvalResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new PackError(
      "REVIEW_RESULT_INVALID",
      t("error.review.resultInvalid", { path: filePath, detail: formatZodError(parsed.error) }),
    );
  }
  if (parsed.data.set_id !== setId) {
    throw new PackError(
      "REVIEW_RESULT_INVALID",
      t("error.review.resultInvalid", {
        path: filePath,
        detail: `文件内 set_id 为 ${JSON.stringify(parsed.data.set_id)}，与请求的 ${JSON.stringify(setId)} 不符`,
      }),
    );
  }
  return parsed.data as ApprovalResult;
}

// ---------------------------------------------------------------------------
// 源文件指纹（结果过期判定）
// ---------------------------------------------------------------------------

/**
 * 计算当前文件的指纹，口径与审批工具文档第五节一致：
 * `hex(mtime_ns) + hex(size)`（图片取成品文件的 mtime + size）。
 *
 * mtimeNs 只在 bigint stat 模式下存在（Node 约定），且已在本机实测与
 * Python `f"{st.st_mtime_ns:x}{st.st_size:x}"` 逐字符一致
 * （同一文件 Node `18db6996facd29744d2` === Python `18db6996facd29744d2`）。
 *
 * @param filePath 源B（成品）文件路径
 * @returns 指纹字符串；文件 stat 失败（不存在等）时返回 undefined
 */
export async function currentFileStamp(filePath: string): Promise<string | undefined> {
  let st: BigIntStats;
  try {
    st = await stat(filePath, { bigint: true });
  } catch {
    return undefined;
  }
  return `${st.mtimeNs.toString(16)}${st.size.toString(16)}`;
}

/**
 * 判断一条审批结果是否已过期（源B文件在审批之后被改过）。
 *
 * 口径与审批工具一致：记录没有 `src` 字段（老结果）**不判过期**；
 * 文件已不存在也不在此判过期（门禁里由 fileMissing 单独报告）。
 *
 * @param record 审批记录
 * @param sourceBPath 该素材源B（成品）文件的当前路径
 * @returns 已过期返回 true
 */
export async function isResultStale(record: ApprovalItemRecord, sourceBPath: string): Promise<boolean> {
  if (record.src === undefined || record.src === "") {
    return false;
  }
  const current = await currentFileStamp(sourceBPath);
  return current !== undefined && current !== record.src;
}

// ---------------------------------------------------------------------------
// 待审清单
// ---------------------------------------------------------------------------

/**
 * 从一个 deck 目录推导待审清单：cards.csv 全部行的 face + back 文件名
 * （去重，保持首次出现顺序）。审批素材 id 就是文件名（pair: basename），
 * 所以这份清单就是 gate 的 expectedIds 缺省来源。
 *
 * @param deckDir deck 子目录（含 cards.csv）
 * @returns 文件名清单（非空）
 * @throws PackError 透传 readCardsCsv 的 CARDS_* / DECK_* 错误码；
 *   推导结果为空时 code="REVIEW_GATE_INPUT_INVALID"（空 deck 过门禁没有意义，
 *   多半是 deckDir 给错了）
 */
export async function expectedItemIds(deckDir: string): Promise<string[]> {
  const rows = await readCardsCsv(deckDir);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const name of [row.face, row.back]) {
      if (name === undefined || name === "" || seen.has(name)) {
        continue;
      }
      seen.add(name);
      ids.push(name);
    }
  }
  if (ids.length === 0) {
    throw gateInputInvalid(`从 cards.csv 推导的待审清单为空（deckDir：${deckDir}）`);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 门禁评估
// ---------------------------------------------------------------------------

/** blocker 理由（门禁不过的原因，按命中优先级排列见模块头注释的表） */
export type GateBlockerReason = "unreviewed" | "reject" | "flag" | "stale" | "fileMissing";

/** 单个素材的门禁拦截项 */
export interface GateBlocker {
  /** 素材 id（= 文件名） */
  itemId: string;
  /** 拦截理由 */
  reason: GateBlockerReason;
}

/** 门禁评估结果（allowed=false 是正常业务结果，不抛错） */
export interface GateResult {
  /** 素材集 id */
  setId: string;
  /** true = 全部 pass 且无过期 / 缺文件，可以打包 / 上传 */
  allowed: boolean;
  /** 待审素材总数（expectedIds 去重后） */
  total: number;
  /** 结论计数（pass 含已过期者——它们另被 stale / blockers 拦下） */
  counts: {
    pass: number;
    reject: number;
    flag: number;
    unreviewed: number;
    /** src 指纹不匹配（结果过期）的条数 */
    stale: number;
  };
  /** 拦截清单（顺序 = 待审清单顺序；每个素材至多一条） */
  blockers: GateBlocker[];
  /** 结果已过期的素材 id（blockers 里 reason="stale" 的子集，便于直接喂给重新审批流程） */
  staleIds: string[];
}

/** {@link evaluateGate} 的入参 */
export interface GateOptions {
  /** 审批数据目录（approval.config.json 的 data_dir） */
  dataDir: string;
  /** 素材集 id */
  setId: string;
  /**
   * 待审清单（素材 id = 文件名）。缺省时必须给 deckDir，从 cards.csv 推导
   * （face + back，去重）。与 deckDir 同时给出视为矛盾入参，直接报错。
   */
  expectedIds?: string[];
  /** deck 目录（用于从 cards.csv 推导待审清单；expectedIds 缺省时必填） */
  deckDir?: string;
  /**
   * 源B（成品）根目录。给出时对每条 pass 记录做文件存在性（fileMissing）
   * 与指纹过期（stale）检查；不给则跳过这两类检查（发布闸退化为纯状态闸）。
   */
  bRoot?: string;
}

/**
 * 评估发布门禁：读审批结果，逐素材核对，全 pass 且无过期 / 缺文件才放行。
 *
 * 门禁不过返回 allowed=false + blockers（不抛错）；结果文件读不了 / 不合法
 * 才抛 PackError。bRoot 下的存在性 / 指纹检查按素材串行 stat（文件系统调用
 * 已是必要成本；一次 stat 拿 mtimeNs + size，不做冗余读）。
 *
 * @param opts 门禁入参
 * @returns 结构化门禁结果
 * @throws PackError code="REVIEW_GATE_INPUT_INVALID" setId 不合法 /
 *   expectedIds 与 deckDir 同时给出 / 待审清单为空时
 * @throws PackError code="REVIEW_RESULT_*" 结果文件缺失 / 不可读 / 不合法时
 *   （错误码见 {@link readApprovalResult}）
 * @throws PackError deckDir 推导清单时透传 CARDS_* 错误码
 */
export async function evaluateGate(opts: GateOptions): Promise<GateResult> {
  if (opts.expectedIds !== undefined && opts.deckDir !== undefined) {
    throw gateInputInvalid("expectedIds 与 deckDir 不能同时给出：待审清单只有一个来源");
  }

  let expected: string[];
  if (opts.expectedIds !== undefined) {
    expected = [...new Set(opts.expectedIds)];
    if (expected.length === 0) {
      throw gateInputInvalid("expectedIds 去重后为空：门禁对零个素材的素材集没有意义");
    }
  } else if (opts.deckDir !== undefined) {
    expected = await expectedItemIds(opts.deckDir);
  } else {
    throw gateInputInvalid("必须给出 expectedIds 或 deckDir 之一作为待审清单来源");
  }

  const result = await readApprovalResult(opts.dataDir, opts.setId);

  const counts = { pass: 0, reject: 0, flag: 0, unreviewed: 0, stale: 0 };
  const blockers: GateBlocker[] = [];
  const staleIds: string[] = [];

  for (const itemId of expected) {
    const record: ApprovalItemRecord | undefined = result.items[itemId];
    if (record === undefined) {
      counts.unreviewed += 1;
      blockers.push({ itemId, reason: "unreviewed" });
      continue;
    }
    if (record.status === "reject") {
      counts.reject += 1;
      blockers.push({ itemId, reason: "reject" });
      continue;
    }
    if (record.status === "flag") {
      counts.flag += 1;
      blockers.push({ itemId, reason: "flag" });
      continue;
    }
    if (record.status !== "pass") {
      // ""（写 "" 清回未审）或其他无法识别的值：按未审处理
      counts.unreviewed += 1;
      blockers.push({ itemId, reason: "unreviewed" });
      continue;
    }
    counts.pass += 1;

    if (opts.bRoot === undefined) {
      continue;
    }
    const sourceBPath = path.join(opts.bRoot, itemId);
    const current = await currentFileStamp(sourceBPath);
    if (current === undefined) {
      blockers.push({ itemId, reason: "fileMissing" });
      continue;
    }
    if (record.src !== undefined && record.src !== "" && current !== record.src) {
      counts.stale += 1;
      staleIds.push(itemId);
      blockers.push({ itemId, reason: "stale" });
    }
  }

  return {
    setId: opts.setId,
    allowed: blockers.length === 0,
    total: expected.length,
    counts,
    blockers,
    staleIds,
  };
}

// ---------------------------------------------------------------------------
// 圈选坐标换算（比例 → 像素）
// ---------------------------------------------------------------------------

/** 图片尺寸（调用方用 sharp 等读取后传入） */
export interface ImageSize {
  width: number;
  height: number;
}

/** 圈选区域的像素框（round 后的整数像素） */
export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一条圈选的换算结果（比例与像素都保留；对应侧尺寸缺失时 pixel 省略） */
export interface AnnotationPixelBox {
  /** 圈在哪侧：a = 源A（原图），b = 源B（成品） */
  side: "a" | "b";
  /** 相对比例原值（0~1） */
  relative: { x: number; y: number; w: number; h: number };
  /** 像素框（px = round(比例 × 该侧图片宽/高)）；该侧尺寸未提供时省略 */
  pixel?: PixelBox;
  /** 这一处的问题说明 */
  note: string;
  /** 可选，单条圈选的标签 */
  tag?: string;
}

/**
 * 把圈选区域（相对比例）换算成像素框。
 *
 * 口径与审批工具文档完全一致（`px = round(x * image_width)` 等），且 **side
 * 决定用哪一侧图片的尺寸**——原图和成品分辨率可能不同。某一侧尺寸未提供时，
 * 该侧圈选只保留比例（pixel 省略），不猜尺寸、不报错（与工具导出 CSV 时
 * "图片读不到像素列留空，百分比照样可用"的行为对齐）。
 *
 * 取整用 JS Math.round（半值向上）；Python round 在恰好 .5 的边界上走
 * 银行家舍入，两者可能差 1——实际比例值是多位小数，不会命中该边界。
 *
 * S9 约定：二次修图自动化 out of scope——本函数只做坐标换算，产出交给下游。
 *
 * @param annotations 圈选数组（来自 ApprovalItemRecord.annotations）
 * @param sizes 两侧图片尺寸（哪侧给哪侧；两侧都给则全部圈选都带像素框）
 * @returns 逐条换算结果（顺序 = 入参顺序）
 */
export function annotationPixelBoxes(
  annotations: ApprovalAnnotation[],
  sizes: { a?: ImageSize; b?: ImageSize },
): AnnotationPixelBox[] {
  return annotations.map((ann) => {
    const size = ann.side === "a" ? sizes.a : sizes.b;
    const box: AnnotationPixelBox = {
      side: ann.side,
      relative: { x: ann.x, y: ann.y, w: ann.w, h: ann.h },
      note: ann.note,
      ...(ann.tag === undefined ? {} : { tag: ann.tag }),
    };
    if (size !== undefined) {
      box.pixel = {
        x: Math.round(ann.x * size.width),
        y: Math.round(ann.y * size.height),
        w: Math.round(ann.w * size.width),
        h: Math.round(ann.h * size.height),
      };
    }
    return box;
  });
}
