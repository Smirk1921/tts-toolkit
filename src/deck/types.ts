// src/deck/types.ts
/**
 * 素材类型注册表：完整枚举（开放集合）+ 处理器注册（方案设计 §5.9）。
 *
 * 职责：
 * - {@link ASSET_TYPES}：素材类型的完整枚举（`as const` + `Object.freeze`
 *   双重冻结：编译期收窄为只读字面量元组，运行时不可变），覆盖方案设计
 *   §5.9 类型表实测的全部 14 种类型；
 * - {@link AssetTypeHandler} / {@link AssetTypeRegistry} / {@link createRegistry}：
 *   注册表模式——`createRegistry()` 预注册全部内置类型的处理器，每种类型的
 *   urlFields 按方案设计 §2.6.2 全量扫描实测填写（这是 B2 patch.ts 的字段
 *   覆盖清单）；新类型只需 `register()` 注册处理器，**不改核心代码**。
 *
 * 开放集合约定（§5.9 用户要求：未知值原样保留、不报错、不丢弃，只告警）：
 * - type 字符串是标识符而非封闭枚举；遇到未注册的类型字符串时，
 *   {@link AssetTypeRegistry.resolve} 返回 defaultHandler 兜底——
 *   type / displayName 等于调用方传入的原始字符串（**不做大小写归一、
 *   不 trim**），urlFields 为空数组（未知类型不知道该查哪些字段）；
 * - resolve() 返回 defaultHandler 时**不告警**：告警由调用方按需触发
 *   （调用方可先用 {@link AssetTypeRegistry.get} 判断是否已注册，
 *   避免同一未知类型在多次 resolve 时重复告警）；
 * - 允许 register() 覆盖内置处理器（包括内置类型本身）——重复注册同一
 *   type 以最后一次为准。
 *
 * 字段取值依据（均为方案设计实测，本模块不发明字段名）：
 * - urlFields：方案设计 §2.6.2"素材字段全清单"；其中 pdf 的字段名是
 *   **PDFUrl**（不是 PDFURL，TTS 字段如此，防 typo 回归由测试锁死）；
 * - displayName：方案设计 §5.9 类型表"对应 TTS 对象"列的存档对象 Name；
 *   card 一行对应 CustomDeck / Deck / Card 三种，此处取牌堆对象的 Name
 *   "Deck" 作默认（单张散卡为 "Card" / "CardCustom"）——displayName 仅用于
 *   诊断输出，不用于对象识别。
 *
 * 内置注册的完备性在编译期锁死：BUILTIN_SPECS 用 `Record<AssetType, …>`
 * 声明，新增 ASSET_TYPES 成员而漏填规格时直接编译错误。
 *
 * 本模块是纯数据 / 查表模块：无 IO、不抛错、不依赖 i18n 与 PackError。
 */

// ---------------------------------------------------------------------------
// 类型枚举
// ---------------------------------------------------------------------------

/**
 * 素材类型的完整枚举（方案设计 §5.9 类型表，按表中顺序排列）。
 *
 * 运行时冻结：意外 push / 赋值在严格模式（ESM）下直接抛 TypeError；
 * 编译期 `as const`：{@link AssetType} 即其成员的字面量联合类型。
 */
export const ASSET_TYPES = Object.freeze([
  "card", "model", "assetbundle", "tile", "figurine", "token",
  "board", "dice", "notecard", "text3d", "pdf", "pawn", "counter", "other",
] as const);

/** 素材类型（ASSET_TYPES 的成员；注册表在运行时也接受任意新类型字符串——开放集合） */
export type AssetType = (typeof ASSET_TYPES)[number];

// ---------------------------------------------------------------------------
// 处理器与注册表
// ---------------------------------------------------------------------------

/** 类型处理器：每种类型可选注册；未注册的类型走 defaultHandler（开放集合兜底） */
export interface AssetTypeHandler {
  /** 类型标识（对应 ASSET_TYPES 之一，或新类型字符串） */
  readonly type: string;
  /** 该类型在存档 JSON 中对应的字段路径（用于 patch.ts 的字段覆盖检查），如 ["CustomDeck", "FaceURL"] */
  readonly urlFields: readonly (readonly string[])[];
  /** 该类型在容器中的默认对象名（用于诊断输出） */
  readonly displayName: string;
}

/** 注册表：按类型字符串查找处理器；未注册的类型走 defaultHandler */
export interface AssetTypeRegistry {
  register(handler: AssetTypeHandler): void;
  get(type: string): AssetTypeHandler | undefined;
  /** 永远返回非空处理器：未注册类型返回 defaultHandler */
  resolve(type: string): AssetTypeHandler;
  list(): readonly AssetTypeHandler[];
}

// ---------------------------------------------------------------------------
// 内置处理器
// ---------------------------------------------------------------------------

/**
 * 冻结一份字段路径清单（外层数组与每个路径数组都不可变）。
 * @param fields 字段路径清单（如 [["CustomDeck", "FaceURL"], …]）
 * @returns 深冻结后的只读清单
 */
function freezeUrlFields(fields: readonly (readonly string[])[]): readonly (readonly string[])[] {
  return Object.freeze(fields.map((field) => Object.freeze([...field])));
}

/**
 * tile / figurine / token / board / pawn / counter 六种类型共用的字段路径
 * （方案设计 §2.6.2：CustomImage 主图 + 次图）。
 */
const CUSTOM_IMAGE_URL_FIELDS = freezeUrlFields([
  ["CustomImage", "ImageURL"],
  ["CustomImage", "ImageSecondaryURL"],
]);

/** 内置处理器规格（不含 type 键——type 由 ASSET_TYPES 枚举提供） */
interface BuiltinSpec {
  /** 该类型在容器中的默认对象名（方案设计 §5.9 类型表"对应 TTS 对象"列） */
  readonly displayName: string;
  /** 该类型在存档 JSON 中的 URL 字段路径（方案设计 §2.6.2 实测清单） */
  readonly urlFields: readonly (readonly string[])[];
}

/**
 * 内置类型的处理器规格表。
 *
 * 用 `Readonly<Record<AssetType, BuiltinSpec>>` 强制覆盖 {@link ASSET_TYPES}
 * 的全部成员：新增枚举成员而忘记填规格时直接编译错误（完备性编译期锁死）。
 *
 * urlFields 是 B2 patch.ts 的字段覆盖清单（方案设计 §2.6.2 全量扫描实测）：
 * - card：图集正反面两字段（CustomDeck 的 key 是图集编号，URL 在其下）；
 * - model：模型四件套（网格 / 漫反射 / 法线 / 碰撞体）；
 * - assetbundle：资源包主 / 次 URL；
 * - tile / figurine / token / board / pawn / counter：CustomImage 主 / 次图；
 * - dice：只有一张图（无 ImageSecondaryURL）；
 * - notecard / text3d：纯文本，无 URL 字段；
 * - pdf：注意字段名是 PDFUrl（**不是** PDFURL）；
 * - other：兜底类型，无固定字段。
 */
const BUILTIN_SPECS: Readonly<Record<AssetType, BuiltinSpec>> = {
  card: {
    displayName: "Deck",
    urlFields: freezeUrlFields([["CustomDeck", "FaceURL"], ["CustomDeck", "BackURL"]]),
  },
  model: {
    displayName: "Custom_Model",
    urlFields: freezeUrlFields([
      ["CustomMesh", "MeshURL"],
      ["CustomMesh", "DiffuseURL"],
      ["CustomMesh", "NormalURL"],
      ["CustomMesh", "ColliderURL"],
    ]),
  },
  assetbundle: {
    displayName: "Custom_Assetbundle",
    urlFields: freezeUrlFields([
      ["CustomAssetbundle", "AssetbundleURL"],
      ["CustomAssetbundle", "AssetbundleSecondaryURL"],
    ]),
  },
  tile: { displayName: "Custom_Tile", urlFields: CUSTOM_IMAGE_URL_FIELDS },
  figurine: { displayName: "Figurine_Custom", urlFields: CUSTOM_IMAGE_URL_FIELDS },
  token: { displayName: "Custom_Token", urlFields: CUSTOM_IMAGE_URL_FIELDS },
  board: { displayName: "Custom_Board", urlFields: CUSTOM_IMAGE_URL_FIELDS },
  dice: { displayName: "Custom_Dice", urlFields: freezeUrlFields([["CustomImage", "ImageURL"]]) },
  notecard: { displayName: "Notecard", urlFields: freezeUrlFields([]) },
  text3d: { displayName: "3DText", urlFields: freezeUrlFields([]) },
  pdf: { displayName: "Custom_PDF", urlFields: freezeUrlFields([["CustomPDF", "PDFUrl"]]) },
  pawn: { displayName: "PlayerPawn", urlFields: CUSTOM_IMAGE_URL_FIELDS },
  counter: { displayName: "Counter", urlFields: CUSTOM_IMAGE_URL_FIELDS },
  other: { displayName: "Other", urlFields: freezeUrlFields([]) },
};

/**
 * 内置处理器（按 ASSET_TYPES 顺序逐个冻结构造，保证 list() 顺序与枚举一致）。
 * 处理器对象与 urlFields 均冻结：调用方不得原地修改内置清单。
 */
const BUILTIN_HANDLERS: readonly AssetTypeHandler[] = ASSET_TYPES.map((type) =>
  Object.freeze({
    type,
    displayName: BUILTIN_SPECS[type].displayName,
    urlFields: BUILTIN_SPECS[type].urlFields,
  }),
);

// ---------------------------------------------------------------------------
// 注册表工厂
// ---------------------------------------------------------------------------

/**
 * 创建素材类型注册表，并预注册全部 {@link ASSET_TYPES} 内置类型的处理器。
 *
 * - 查找为**精确匹配**（大小写敏感，不归一、不 trim）；
 * - list() 顺序：内置类型按 ASSET_TYPES 顺序在前，后注册的类型依次追加；
 *   重复 register 同一 type 覆盖前者且保持首次出现的位置；
 * - list() 返回冻结的快照数组，后续 register 不影响已取得的快照。
 *
 * @returns 新的注册表实例（各次调用互不影响）
 */
export function createRegistry(): AssetTypeRegistry {
  // Map 保持插入序：内置类型按 ASSET_TYPES 顺序在前，后注册的依次追加
  const handlers = new Map<string, AssetTypeHandler>();
  for (const handler of BUILTIN_HANDLERS) {
    handlers.set(handler.type, handler);
  }

  return {
    register(handler: AssetTypeHandler): void {
      handlers.set(handler.type, handler);
    },

    get(type: string): AssetTypeHandler | undefined {
      return handlers.get(type);
    },

    resolve(type: string): AssetTypeHandler {
      const registered = handlers.get(type);
      if (registered !== undefined) {
        return registered;
      }
      // defaultHandler：开放集合兜底——原始字符串原样保留（不归一 / 不 trim），
      // 不告警（告警由调用方按需触发，避免同一未知类型重复告警）
      return Object.freeze({
        type,
        displayName: type,
        urlFields: Object.freeze([]),
      });
    },

    list(): readonly AssetTypeHandler[] {
      return Object.freeze([...handlers.values()]);
    },
  };
}
