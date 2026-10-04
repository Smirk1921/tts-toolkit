// src/deck/patch.ts
/**
 * CustomDeck 递归遍历器（坑 4 收口，方案设计 §2.6.1 / §2.6.6）。
 *
 * 职责（**遍历逻辑全仓只此一份实现**——plan / apply / verify 一律走本模块，
 * 不得在各自模块里手写 ContainedObjects 递归）：
 * - {@link walkSaveUrls}：深度优先遍历整份 TTS 存档 JSON 的全部 URL 素材字段，
 *   对每个非空 URL 字段调用 visitor；visitor 返回新字符串时**原地**写回
 *   （`host[hostKey] = 新值`）。绝不做深拷贝——37,492 对象 / 116MB 的存档
 *   一旦 JSON.parse(JSON.stringify(...)) 内存与耗时都不可接受（性能红线）；
 * - {@link isLangVariant} / {@link isLocalFileUrl} / {@link isMissingProtocol}：
 *   URL 形态判定（{lang} 多语言值、file: 本地路径、缺协议）。
 *
 * 覆盖范围（**这是契约，漏一个都是 bug**；字段清单按方案设计 §2.6.1 + §5.5
 * 与参考资料《存档结构与素材字段》实测）：
 * - 容器键（递归下钻）：ObjectStates / ContainedObjects / ChildObjects /
 *   States / AttachedDecals。其中 States 实测为对象映射
 *   `Record<string, TTSObject>`（@tts-tools/savefile 模型 + 参考资料 §三
 *   `{1: {...}, 2: {...}}`），其余为数组；本实现对数组与对象映射两种形状
 *   都支持（宽容处理，形状不符则跳过不抛错）；
 * - 素材字段：CustomDeck.FaceURL / BackURL（CustomDeck 是"图集编号 → 规格对象"
 *   的映射，每个规格对象各有一对正反 URL）、CustomImage.ImageURL /
 *   ImageSecondaryURL、CustomMesh.MeshURL / DiffuseURL / NormalURL /
 *   ColliderURL、CustomAssetbundle.AssetbundleURL / AssetbundleSecondaryURL、
 *   CustomDecal.ImageURL、CustomPDF.PDFUrl（拼写就是 PDFUrl）、
 *   直接字段 SkyURL / TableURL。
 *
 * 设计决定：
 * - **字段清单在本模块内固化**，不从 src/deck/types.ts 的注册表推导：注册表
 *   urlFields 按"类型 → 字段"组织，未知/兜底类型的 urlFields 为空，且
 *   CustomDecal.ImageURL 与 SkyURL / TableURL 不在任何内置类型的 urlFields
 *   里，按类型推导必然漏字段；本清单 ⊇ 注册表并集，一致性由 deck-patch
 *   测试逐字段锁死；
 * - **固定访问顺序**：直接字段（SkyURL → TableURL）→ 素材容器（CustomDeck →
 *   CustomPDF 固定次序，CustomDeck 内按图集编号）→ 容器键（ObjectStates →
 *   AttachedDecals 固定次序），与对象自身键序无关；同一存档两次遍历产出
 *   逐 loc 一致（下游 plan / apply 的快照测试依赖确定性）；
 * - **fieldPath 恒为两段** [容器键, 字段名]（直接字段为一段 [字段名]），与
 *   契约示例 ["CustomDeck", "FaceURL"] 及 src/deck/types.ts 的 urlFields 形状
 *   一致；CustomDeck 的图集编号不进 fieldPath——多个图集时以 host 引用区分；
 * - **objectPath 指向"当前对象"**（GUID / Name 的宿主）：根对象为 ""，数组
 *   下标拼 `键[i]`、对象映射拼 `键.子键`，如 "ObjectStates[3].ContainedObjects[5]"、
 *   "ObjectStates[0].States.<状态键>"；素材容器不改变 objectPath；
 * - **guid / name 取当前对象自身**：进入容器键的每个元素都是新的"当前对象"
 *   （其 GUID 为空串 / 缺失 / 非字符串时 guid 为 ""——工坊允许空 GUID；
 *   Name 缺失或非字符串时 name 为 undefined）；非容器键下的嵌套对象
 *   （如 SaveState）不下钻；
 * - **{lang} 形式默认跳过**（skipLangVariants 默认 true）：值含 {xx} / {xx-yy}
 *   语言段（如 "{en}http://a.png{zh-cn}http://b.png"）的必须原样保留（坑 5），
 *   跳过的不访问、不计入返回值；skipLangVariants=false 时照常访问，处理方式
 *   由调用方决定；
 * - **autoFixProtocol 只改 visitor 看到的 currentValue**（补 "https://" 前缀），
 *   不直接写回字段——补丁由调用方经 visitor 返回值决定；
 * - **file: 本地路径**先触发 onLocalFile（如提供）再调用 visitor，两次拿到
 *   同一个 loc；不提供 onLocalFile 时照常访问（"仍访问，让 visitor 决定"）；
 * - 假定 root 来自 JSON.parse（无循环引用）；遍历期间新增的键不进入本轮
 *   （子键列表在进入对象时快照）。
 *
 * 本模块是纯遍历模块：无 IO、无 i18n、自身不抛错
 * （visitor / onLocalFile 抛出的异常原样向上传）。
 */

// ---------------------------------------------------------------------------
// 覆盖清单（契约数据：漏一个都是 bug）
// ---------------------------------------------------------------------------

/** 直接挂在对象（含根对象）上的 URL 字段（方案设计 §2.6.1"顶层字段"） */
const DIRECT_URL_FIELDS: readonly string[] = ["SkyURL", "TableURL"];

/**
 * 素材容器键 → 该容器内的 URL 字段（方案设计 §2.6.1 + §5.5 实测清单）。
 *
 * - CustomDeck 是"图集编号 → 规格对象"的映射（如 `{"1": {FaceURL, …}}`），
 *   每个规格对象内的 URL 字段都要访问；
 * - 字段名严格按实测拼写（PDFUrl **不是** PDFURL，防 typo 回归由测试锁死）。
 */
const MATERIAL_URL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  CustomDeck: ["FaceURL", "BackURL"],
  CustomImage: ["ImageURL", "ImageSecondaryURL"],
  CustomMesh: ["MeshURL", "DiffuseURL", "NormalURL", "ColliderURL"],
  CustomAssetbundle: ["AssetbundleURL", "AssetbundleSecondaryURL"],
  CustomDecal: ["ImageURL"],
  CustomPDF: ["PDFUrl"],
};

/** 素材容器键的固定访问次序（与对象自身键序无关，保证遍历确定性） */
const MATERIAL_KEYS: readonly string[] = [
  "CustomDeck",
  "CustomImage",
  "CustomMesh",
  "CustomAssetbundle",
  "CustomDecal",
  "CustomPDF",
];

/**
 * 容器键（坑 4：四种容器键 + 顶层 ObjectStates；漏一个都会"改了 URL 没生效"）。
 * 数组（ContainedObjects / ChildObjects / AttachedDecals）与对象映射（States）
 * 两种形状都支持；固定访问次序。
 */
const CONTAINER_KEYS: readonly string[] = [
  "ObjectStates",
  "ContainedObjects",
  "ChildObjects",
  "States",
  "AttachedDecals",
];

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** 素材字段位置（指认某个对象的某个字段含 URL） */
export interface UrlLocation {
  /** 对象在存档里的路径（用于诊断），如 "ObjectStates[3].ContainedObjects[5]"；根对象为 "" */
  objectPath: string;
  /** 对象 GUID（如有；空字符串 / 缺失 / 非字符串视为无 → ""） */
  guid: string;
  /** 对象 Name（如有；缺失或非字符串时本属性不存在） */
  name?: string;
  /** 字段路径，如 ["CustomDeck", "FaceURL"]（素材字段恒两段，直接字段一段） */
  fieldPath: readonly string[];
  /** 当前字段值（本记录只在字段存在且为非空字符串时出现） */
  currentValue: string;
  /** 该字段的宿主对象（可变引用，写入即生效——避免深拷贝） */
  host: Record<string, unknown>;
  /** 字段在 host 上的最后一级键 */
  hostKey: string;
}

/** 访问器：返回 void 表示"只读"；返回新字符串表示"替换该字段为新值" */
export type UrlVisitor = (loc: UrlLocation) => string | void;

/** 遍历选项 */
export interface WalkOptions {
  /** 疑似 {lang} 形式的值（如 "{en}...{zh-cn}..."）原样跳过不访问；默认 true */
  skipLangVariants?: boolean;
  /** file: 协议本地路径触发 onLocalFile 回调（默认仅记录，不跳过，visitor 仍被调用） */
  onLocalFile?: (loc: UrlLocation) => void;
  /** www. 开头缺协议时是否自动补 https://（默认 false；只改 visitor 看到的 currentValue，写回由调用方决定） */
  autoFixProtocol?: boolean;
}

// ---------------------------------------------------------------------------
// URL 形态判定
// ---------------------------------------------------------------------------

/**
 * {lang} 语言段：{xx} 或 {xx-yy}，xx 为 2-3 位小写字母，yy 为 2-8 位小写字母
 * 或数字（覆盖 zh-cn / pt-br / es-419 等实测变体）。
 * 不带 g 标志（无 lastIndex 状态，可安全复用）。
 */
const LANG_SEGMENT_RE = /\{[a-z]{2,3}(?:-[a-z0-9]{2,8})?\}/;

/** file: 协议前缀（协议大小写不敏感，URL scheme 本就不区分大小写） */
const LOCAL_FILE_RE = /^file:/i;

/** www. 开头（缺协议；大小写不敏感——真实图床数据里 WWW. 也会出现） */
const MISSING_PROTOCOL_RE = /^www\./i;

/**
 * 判断一个字符串是否是 {lang} 形式（含 {xx} 或 {xx-yy} 段，xx 为 2-3 位小写字母）。
 * 段出现在值中任意位置都算（实测样例 "{en}http://a.png{zh-cn}http://b.png"）。
 */
export function isLangVariant(value: string): boolean {
  return LANG_SEGMENT_RE.test(value);
}

/** 判断一个字符串是否是 file: 协议本地路径（大小写不敏感，仅认 file: 前缀） */
export function isLocalFileUrl(value: string): boolean {
  return LOCAL_FILE_RE.test(value);
}

/** 判断一个字符串是否缺协议（以 www. 开头，大小写不敏感） */
export function isMissingProtocol(value: string): boolean {
  return MISSING_PROTOCOL_RE.test(value);
}

// ---------------------------------------------------------------------------
// 内部遍历实现
// ---------------------------------------------------------------------------

/** walkSaveUrls 的遍历上下文（选项归一后的只读快照） */
interface WalkContext {
  visitor: UrlVisitor;
  skipLang: boolean;
  autoFix: boolean;
  onLocalFile?: (loc: UrlLocation) => void;
}

/**
 * 宿主对象判定：可挂 URL 字段的普通对象（JSON.parse 产物）。
 * 数组是容器序列不是宿主；null / 原子值一律排除。
 */
function isHostObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 数组下标路径拼接：parent 为 ""（根）时不带前导点 */
function joinArrayPath(parent: string, key: string, index: number): string {
  return parent === "" ? `${key}[${index}]` : `${parent}.${key}[${index}]`;
}

/** 对象映射子键路径拼接（如 States.<键>）：parent 为 ""（根）时不带前导点 */
function joinMapPath(parent: string, key: string, subKey: string): string {
  return parent === "" ? `${key}.${subKey}` : `${parent}.${key}.${subKey}`;
}

/**
 * 访问单个 URL 字段：非空字符串 →（可选 {lang} 跳过）→ 构造 loc →
 * （file: 触发 onLocalFile）→ visitor →（返回字符串则原地写回）。
 * @returns 本次实际访问数（0 或 1）
 */
function visitField(
  ctx: WalkContext,
  host: Record<string, unknown>,
  hostKey: string,
  fieldPath: readonly string[],
  objectPath: string,
  guid: string,
  name: string | undefined,
): number {
  const raw = host[hostKey];
  if (typeof raw !== "string" || raw === "") {
    return 0;
  }
  if (ctx.skipLang && isLangVariant(raw)) {
    return 0;
  }
  const currentValue = ctx.autoFix && isMissingProtocol(raw) ? `https://${raw}` : raw;
  const loc: UrlLocation = { objectPath, guid, fieldPath, currentValue, host, hostKey };
  if (name !== undefined) {
    loc.name = name;
  }
  if (ctx.onLocalFile !== undefined && isLocalFileUrl(raw)) {
    ctx.onLocalFile(loc);
  }
  const replacement = ctx.visitor(loc);
  if (typeof replacement === "string") {
    host[hostKey] = replacement;
  }
  return 1;
}

/**
 * 遍历一个"当前对象"：先访问直接字段与素材容器，再下钻容器键。
 * @param obj 当前对象（GUID / Name 的宿主）
 * @param objectPath 当前对象的路径（根为 ""）
 * @returns 本子树访问的 URL 总数
 */
function walkObject(ctx: WalkContext, obj: Record<string, unknown>, objectPath: string): number {
  const guidRaw = obj["GUID"];
  const guid = typeof guidRaw === "string" ? guidRaw : "";
  const nameRaw = obj["Name"];
  const name = typeof nameRaw === "string" ? nameRaw : undefined;

  let count = 0;

  // 1. 直接字段（SkyURL / TableURL——根对象即"顶层字段"的宿主）
  for (const field of DIRECT_URL_FIELDS) {
    count += visitField(ctx, obj, field, [field], objectPath, guid, name);
  }

  // 2. 素材容器（CustomDeck 特殊：图集编号 → 规格对象的映射）
  for (const key of MATERIAL_KEYS) {
    const sub = obj[key];
    if (!isHostObject(sub)) {
      continue;
    }
    const fields = MATERIAL_URL_FIELDS[key]!;
    if (key === "CustomDeck") {
      for (const deckId of Object.keys(sub)) {
        const spec = sub[deckId];
        if (!isHostObject(spec)) {
          continue;
        }
        for (const field of fields) {
          count += visitField(ctx, spec, field, [key, field], objectPath, guid, name);
        }
      }
    } else {
      for (const field of fields) {
        count += visitField(ctx, sub, field, [key, field], objectPath, guid, name);
      }
    }
  }

  // 3. 容器键下钻（坑 4：四种容器键，一种都不能漏）
  for (const key of CONTAINER_KEYS) {
    const val = obj[key];
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        const child = val[i];
        if (!isHostObject(child)) {
          continue;
        }
        count += walkObject(ctx, child, joinArrayPath(objectPath, key, i));
      }
    } else if (isHostObject(val)) {
      // 对象映射形状（States 实测为 Record<string, TTSObject>）
      for (const subKey of Object.keys(val)) {
        const child = val[subKey];
        if (!isHostObject(child)) {
          continue;
        }
        count += walkObject(ctx, child, joinMapPath(objectPath, key, subKey));
      }
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 遍历整份存档 JSON 的所有 URL 字段，对每个非空 URL 调用 visitor。
 *
 * 覆盖范围与行为细节见模块头注释（覆盖清单是契约，漏一个都是 bug）。
 * 要点：
 * - 容器键：ObjectStates / ContainedObjects / ChildObjects / States /
 *   AttachedDecals（数组与对象映射两种形状都支持）；
 * - {lang} 形式的值默认跳过（不访问、不计数）；
 * - file: 协议先触发 onLocalFile（如提供）再调用 visitor（"仍访问"）；
 * - autoFixProtocol=true 时 visitor 看到的 currentValue 已补 https://，
 *   字段本身的写回只发生在 visitor 返回字符串时；
 * - 原地 mutate 传入的 root，绝不做深拷贝；
 * - root 不是普通对象（null / 数组 / 原子值）时返回 0。
 *
 * @param root 存档 JSON（通常为 JSON.parse 后的存档根对象）
 * @param visitor 访问器（返回字符串即替换该字段）
 * @param opts 遍历选项（全部可省略）
 * @returns 访问的 URL 总数（被跳过的 {lang} 不计入）
 */
export function walkSaveUrls(root: unknown, visitor: UrlVisitor, opts: WalkOptions = {}): number {
  if (!isHostObject(root)) {
    return 0;
  }
  const ctx: WalkContext = {
    visitor,
    skipLang: opts.skipLangVariants !== false,
    autoFix: opts.autoFixProtocol === true,
    onLocalFile: opts.onLocalFile,
  };
  return walkObject(ctx, root, "");
}
