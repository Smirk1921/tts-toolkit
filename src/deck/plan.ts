// src/deck/plan.ts
/**
 * URL 替换计划（dry-run 预览，方案设计 §2.6.x）。
 *
 * 职责：
 * - {@link planReplace}：读入一份 TTS 存档（路径或已解析对象）+ 一组
 *   {@link ReplaceRule}，用 src/deck/patch.ts 的 {@link walkSaveUrls} 遍历全部
 *   URL 素材字段（**遍历逻辑全仓只此一份实现，本模块不重写遍历**——坑 4 收口），
 *   对每个 URL 按规则顺序匹配，**第一条命中的规则生效**，产出
 *   {@link PlanEntry} 列表（currentValue → newValue）与 {@link PlanResult.stats}；
 * - **不做任何实际替换**：visitor 恒返回 void，walkSaveUrls 不写回任何字段，
 *   存档文件字节与传入对象内容在调用前后完全不变（dry-run 红线）。
 *
 * 匹配语义（{@link ReplaceRule.mode}，默认 "exact"）：
 * - "exact"：`currentValue === rule.from`，newValue = rule.to；
 * - "prefix"：`currentValue.startsWith(rule.from)`，newValue =
 *   rule.to + currentValue.slice(rule.from.length)（命中的前缀被替换，余下后缀保留）；
 * - "regex"：`new RegExp(rule.from).test(currentValue)`（无 flags， Exactly 按契约
 *   构造），newValue = `currentValue.replace(re, rule.to)`（JS replace 语义，
 *   `to` 里可用 `$1` / `$&` 等引用捕获组；无 g 标志只替换首个匹配）。
 *
 * 规则校验（入口先于读档完成，全部规则一次校验，任何一条不合法即
 * PLAN_RULE_INVALID——包括从未命中任何 URL 的规则）：
 * - rules 必须是数组；每条必须是键值对象；from / to 必须是字符串；
 * - mode 缺省按 "exact"，出现时必须是三个值之一；
 * - mode="regex" 时 `new RegExp(rule.from)` 构造失败（语法错误等）→
 *   PLAN_RULE_INVALID（本模块特有的坑：构造必须 try/catch 收口）；
 * - from 为空串不报错（exact 永不命中——walkSaveUrls 不访问空串；
 *   prefix / 空正则匹配一切是调用方的显式选择）。
 *
 * stats 语义（{@link PlanResult.stats}，同一 Record 混放两类计数）：
 * - 按规则分组：`stats[rule.from]` = 该规则命中的位置数（键即 from，与
 *   PlanEntry.matchedRule 同构；多条规则 from 相同时计数合并——dry-run 预览
 *   只求可读，不保证键唯一）；
 * - 共享图集检测（坑 2 预览）：同一 URL 在受影响位置出现 ≥2 次时
 *   `stats["shared:<url>"]` = 出现次数（口径按"同一 URL 出现 N 次"，覆盖
 *   CustomDeck 之间共享与同一对象内正反面重复等各种形态）。
 *
 * 防御行为（与 walkSaveUrls 对齐）：
 * - {lang} 形式（坑 5）：值含 {xx} / {xx-yy} 语言段的字段被 walkSaveUrls
 *   默认跳过（skipLangVariants=true 显式传参锁死），不产生 PlanEntry、不进
 *   stats、不参与共享统计——{lang} 值必须原样保留，不能当普通 URL 替换；
 * - file: 本地路径：照常遍历、不报错；不命中任何规则时无 PlanEntry，只有
 *   规则显式针对（exact 全串 / prefix / regex）时才命中；
 * - 空 GUID（工坊合法状态）：照常产出 PlanEntry（guid 为 ""）——存档内
 *   遍历不做 GUID 过滤（"空 GUID 跳过"是 decks/ 目录遍历的约定，不适用于此）。
 *
 * 错误码（{@link PackError.code}）：
 * - "PLAN_SAVE_INVALID"  存档不可得：路径不存在 / 读取 IO 失败 / JSON 解析
 *                        失败 / savePath 既不是字符串也不是键值对象
 *                        （本模块只定义两个错误码，"拿不到合法存档"收口为此码，
 *                        与 slice.ts 的 SLICE_SAVE_INVALID 口径一致）
 * - "PLAN_RULE_INVALID"  规则不合法（结构 / 类型 / mode 取值 / regex 语法错误）
 *
 * 本模块新增的 i18n 键（locales/*.json 待补占位键；缺键时 t() 原样输出键名）：
 * - `error.pack.planSaveInvalid` {path} {detail}
 * - `error.pack.planRuleInvalid` {detail}
 *
 * 设计决定：
 * - **规则先于存档校验**：compileRules 在任何 IO 之前执行，规则有错时即使
 *   savePath 也不存在也报 PLAN_RULE_INVALID（最可行动作的错误优先）；
 * - **regex 编译一次**：入口处统一构造 RegExp 并复用（test + replace 同一实例），
 *   避免逐 URL 重复编译，也保证"构造失败"在入口一次性暴露；
 * - **entries 顺序 = walkSaveUrls 遍历顺序**（直接字段 → 素材容器 → 容器键
 *   下钻，与对象键序无关，见 patch.ts 头注释），同一存档同一规则集两次调用
 *   产出逐条一致（下游快照比对依赖确定性）；
 * - savePath 支持已解析对象（契约注释"（或已解析的对象）"）：键值对象直接
 *   遍历不落盘；字符串一律当路径读文件；其余形态 → PLAN_SAVE_INVALID；
 * - stats 内部用 Map 累计、Object.fromEntries 导出：规则 from 或 URL 恰为
 *   "__proto__" 等原型键时不会击穿原型链。
 */

import { readFile } from "node:fs/promises";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";
import { walkSaveUrls, type UrlLocation } from "./patch.js";

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** 单条替换规则 */
export interface ReplaceRule {
  /** 要匹配的 URL（精确匹配或正则） */
  from: string;
  /** 替换为 */
  to: string;
  /** 匹配模式：exact（默认）/ regex / prefix */
  mode?: "exact" | "regex" | "prefix";
}

/** 一条受影响的位置（与 UrlLocation 同构，但只读） */
export interface PlanEntry {
  /** 对象在存档里的路径（透传 walkSaveUrls，如 "ObjectStates[0].ContainedObjects[5]"） */
  objectPath: string;
  /** 对象 GUID（空串 / 缺失时为 ""——工坊允许空 GUID，不跳过） */
  guid: string;
  /** 对象 Name（缺失或非字符串时本属性不存在） */
  name?: string;
  /** 字段路径，如 ["CustomDeck", "FaceURL"]（直接字段为一段） */
  fieldPath: readonly string[];
  /** 当前字段值 */
  currentValue: string;
  /** 替换后的新值 */
  newValue: string;
  /** 命中的规则（from 字段） */
  matchedRule: string;
}

/** 替换计划入参 */
export interface PlanOptions {
  /** 存档 JSON 路径（或已解析的对象——键值对象直接遍历，不落盘） */
  savePath: string | Record<string, unknown>;
  /** 替换规则列表（按顺序应用，先命中先生效） */
  rules: ReplaceRule[];
}

/** 替换计划结果 */
export interface PlanResult {
  /** 受影响的位置列表（顺序 = walkSaveUrls 遍历顺序） */
  entries: PlanEntry[];
  /** 按规则分组的统计（键 = rule.from）+ 共享图集标记（键 = "shared:<url>"） */
  stats: Record<string, number>;
  /** 总受影响数（=== entries.length） */
  totalAffected: number;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 校验并编译后的规则（regex 模式持有一次性构造好的 RegExp 实例） */
interface CompiledRule {
  from: string;
  to: string;
  mode: "exact" | "regex" | "prefix";
  re?: RegExp;
}

/** PLAN_RULE_INVALID 的统一构造（文案键见模块头注释） */
function planRuleInvalid(detail: string): PackError {
  return new PackError("PLAN_RULE_INVALID", t("error.pack.planRuleInvalid", { detail }));
}

/** PLAN_SAVE_INVALID 的统一构造 */
function planSaveInvalid(path: string, detail: string): PackError {
  return new PackError("PLAN_SAVE_INVALID", t("error.pack.planSaveInvalid", { path, detail }));
}

/**
 * 从 unknown 错误中取人类可读描述（Error 取 message，其余 String() 兜底）。
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 键值对象判定（与 patch.ts 的宿主判定一致：排除 null 与数组） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VALID_MODES: readonly string[] = ["exact", "regex", "prefix"];

/** mode 的非空形式（ReplaceRule["mode"] 因可选而含 undefined） */
type RuleMode = NonNullable<ReplaceRule["mode"]>;

/**
 * 校验并编译全部规则（任何 IO 之前调用；见模块头注释"规则校验"）。
 * @param rules 调用方传入的规则数组（原样使用，不改写）
 * @returns 编译后的规则列表（顺序保持，先命中先生效的基础）
 * @throws PackError code="PLAN_RULE_INVALID" 结构 / 类型 / mode / regex 任一不合法时
 */
function compileRules(rules: ReplaceRule[]): CompiledRule[] {
  if (!Array.isArray(rules)) {
    throw planRuleInvalid(`rules 必须是数组（收到 ${typeof rules}）`);
  }
  const compiled: CompiledRule[] = [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const label = `第 ${i + 1} 条规则`;
    if (!isPlainObject(rule)) {
      throw planRuleInvalid(`${label}必须是键值对象（收到 ${rule === null ? "null" : typeof rule}）`);
    }
    if (typeof rule.from !== "string") {
      throw planRuleInvalid(`${label}的 from 必须是字符串（收到 ${typeof rule.from}）`);
    }
    if (typeof rule.to !== "string") {
      throw planRuleInvalid(`${label}的 to 必须是字符串（收到 ${typeof rule.to}）`);
    }
    // 类型系统已把 mode 收窄为三值之一，但调用方可能 cast 进非法值——按原始值校验
    const rawMode = (rule as { mode?: unknown }).mode;
    if (rawMode !== undefined && (typeof rawMode !== "string" || !VALID_MODES.includes(rawMode))) {
      throw planRuleInvalid(
        `${label}的 mode 必须是 ${VALID_MODES.join(" / ")} 之一（收到 ${String(rawMode)}）`,
      );
    }
    const mode: RuleMode = rawMode === undefined ? "exact" : (rawMode as RuleMode);
    const out: CompiledRule = { from: rule.from, to: rule.to, mode };
    if (mode === "regex") {
      try {
        // 契约写死 new RegExp(rule.from)：无 flags；构造失败即 PLAN_RULE_INVALID
        out.re = new RegExp(rule.from);
      } catch (err) {
        throw planRuleInvalid(`${label}的正则语法错误（/${rule.from}/）：${errMessage(err)}`);
      }
    }
    compiled.push(out);
  }
  return compiled;
}

/**
 * 判断 currentValue 是否命中规则（模式语义见模块头注释"匹配语义"）。
 */
function matchesRule(rule: CompiledRule, currentValue: string): boolean {
  if (rule.mode === "exact") {
    return currentValue === rule.from;
  }
  if (rule.mode === "prefix") {
    return currentValue.startsWith(rule.from);
  }
  return rule.re!.test(currentValue);
}

/**
 * 按命中规则计算替换后的新值（模式语义见模块头注释"匹配语义"）。
 */
function computeNewValue(rule: CompiledRule, currentValue: string): string {
  if (rule.mode === "exact") {
    return rule.to;
  }
  if (rule.mode === "prefix") {
    return rule.to + currentValue.slice(rule.from.length);
  }
  return currentValue.replace(rule.re!, rule.to);
}

/**
 * 把一个被访问的 URL 位置转成只读 PlanEntry（fieldPath 拷贝一份，
 * name 仅在存在时携带——与 UrlLocation 同构）。
 */
function toEntry(loc: UrlLocation, rule: CompiledRule): PlanEntry {
  const entry: PlanEntry = {
    objectPath: loc.objectPath,
    guid: loc.guid,
    ...(loc.name === undefined ? {} : { name: loc.name }),
    fieldPath: [...loc.fieldPath],
    currentValue: loc.currentValue,
    newValue: computeNewValue(rule, loc.currentValue),
    matchedRule: rule.from,
  };
  return entry;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 生成 URL 替换计划（dry-run）：读存档 → walkSaveUrls 遍历 → 逐 URL 按规则
 * 顺序匹配（第一条命中的规则生效）→ 产出受影响位置列表与统计。
 *
 * **绝不修改任何数据**：不写文件；visitor 恒返回 void，walkSaveUrls 不写回
 * 字段；传入已解析对象时其内容在调用前后不变。
 *
 * 处理顺序：先校验规则（全部规则一次过，regex 在此编译），再取存档
 * （字符串路径读文件 + JSON.parse，键值对象直接用），最后遍历匹配。
 *
 * @param opts 替换计划入参
 * @returns 受影响位置列表（遍历序）、按规则统计 + 共享图集标记、总受影响数
 * @throws PackError code="PLAN_RULE_INVALID" 任一规则不合法时（先于存档读取）
 * @throws PackError code="PLAN_SAVE_INVALID" 存档不存在 / 读取失败 / JSON
 *   解析失败 / savePath 形态非法时
 */
export async function planReplace(opts: PlanOptions): Promise<PlanResult> {
  // ---- 1. 规则校验与编译（先于一切 IO） ----------------------------------
  const compiled = compileRules(opts.rules);

  // ---- 2. 取存档根 -------------------------------------------------------
  let root: unknown;
  if (typeof opts.savePath === "string") {
    let saveText: string;
    try {
      saveText = await readFile(opts.savePath, "utf8");
    } catch (err) {
      throw planSaveInvalid(opts.savePath, errMessage(err));
    }
    try {
      root = JSON.parse(saveText);
    } catch (err) {
      throw planSaveInvalid(opts.savePath, errMessage(err));
    }
  } else if (isPlainObject(opts.savePath)) {
    root = opts.savePath; // 已解析对象：直接遍历（visitor 不写回，对象内容不变）
  } else {
    throw planSaveInvalid(String(opts.savePath), "savePath 必须是路径字符串或已解析的存档对象");
  }

  // ---- 3. 遍历 + 逐 URL 匹配（第一条命中的规则生效） ---------------------
  const entries: PlanEntry[] = [];
  const perRule = new Map<string, number>(); // 键 = rule.from（多条规则同 from 时合并计数）
  walkSaveUrls(
    root,
    (loc) => {
      for (const rule of compiled) {
        if (!matchesRule(rule, loc.currentValue)) {
          continue;
        }
        entries.push(toEntry(loc, rule));
        perRule.set(rule.from, (perRule.get(rule.from) ?? 0) + 1);
        break; // 先命中先生效：不再尝试后续规则
      }
      // 恒返回 void（dry-run 红线）：walkSaveUrls 不会写回任何字段
    },
    // 坑 5：{lang} 值必须原样保留——显式锁死 patch.ts 的默认跳过行为
    { skipLangVariants: true },
  );

  // ---- 4. 共享图集标记：同一 URL 出现 ≥2 次 → stats["shared:<url>"] = 次数
  const perUrl = new Map<string, number>();
  for (const entry of entries) {
    perUrl.set(entry.currentValue, (perUrl.get(entry.currentValue) ?? 0) + 1);
  }

  const stats: Record<string, number> = Object.fromEntries(perRule);
  for (const [url, count] of perUrl) {
    if (count >= 2) {
      stats[`shared:${url}`] = count;
    }
  }

  return { entries, stats, totalAffected: entries.length };
}
