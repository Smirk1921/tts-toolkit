// src/deck/slice.ts
/**
 * 图集切片：把一张图集大图切成小卡图，并按卡堆归属、正反面规则登记 cards.csv
 * （方案设计 §5.10，`tts deck slice --sheet <图集> --save <存档> -o <输出目录>`）。
 *
 * 职责：
 * - {@link sliceAtlas}：主入口——解析存档 → 解析图集归属（优先级见下）→
 *   共享检测 → sharp 按网格切片（正面 + 背面）→ 写 cards.csv；
 * - {@link sanitizeAtlasUrl}：URL → 本地文件名基名的净化函数（本工具链约定，
 *   供"文件名反推 URL"与背面图集的本地查找使用；generate.ts 下载图集时应
 *   用同一函数命名，保证反推闭环）；
 * - {@link DeckCandidate} / {@link SliceOptions} / {@link SliceResult}：契约类型。
 *
 * ── 归属解析（按优先级，找到即停）─────────────────────────────────────────
 * 1. 显式 deckKey / deckGuid（SliceOptions）：直接用，跳过自动解析；
 *    只给其一且产生多个候选时同样走 selector（CustomDeck 的 key 是每副牌堆
 *    相对编号，多副牌堆都有 key "1" 是常态）；
 * 2. 图集文件名 = sanitize(URL) 反推 URL：到存档查引用该 URL（FaceURL）的
 *    CustomDeck（文件名大小写不敏感，扩展名不计入比较）；
 * 3. 图集宽高比 + NumWidth×NumHeight 匹配：见下"格子几何校验"；
 * 4. 多候选：调用方传入 {@link SliceOptions.selectCandidate} 让用户选
 *    （CLI 用 readline；单测注入 mock）；多候选而未提供 selector → SLICE_AMBIGUOUS；
 * 5. 找不到：SLICE_ORPHAN_ATLAS，不产出孤儿 cards.csv。
 *
 * ── CustomDeck 遍历与"副本折叠"（坑 4）───────────────────────────────────
 * 存档里每个卡堆对象（Deck）下每张 Card 子对象都完整复制了一份 CustomDeck
 * （坑 4 层面一），容器键有 ContainedObjects / ChildObjects / States /
 * AttachedDecals 四种（层面二）。本模块的遍历器对两者都处理：
 * - 递归走全部四种容器键（States / AttachedDecals 兼容数组与键值对象两种形态）；
 * - 副本折叠：某对象的 CustomDeck 条目若与某个**祖先对象**的同 key 条目
 *   规范序列化后逐字节相同（stableStringify：键排序后序列化，防手改存档
 *   调换键序导致漏判），视为副本不登记——卡堆对象才产生候选/共享记录，
 *   70 张卡不会变成 70 个候选；
 * - 空 GUID 对象不建索引（坑 7，与 src/pack/build.ts 的约定一致），
 *   但其子对象照常遍历；
 * - GUID 读取时不做大小写归一（B2 约定 5），deckGuid 精确匹配。
 *
 * 遍历器目前在本模块内实现（collectDeckOwners，私有）。按 B2 坑 4 的要求，
 * URL 改写遍历的唯一实现应收口在 src/deck/patch.ts；patch.ts 落地后本模块
 * 应改为复用其遍历器，此处保留一份只读扫描是过渡态（已与契约确认）。
 *
 * ── 格子几何校验（优先级 3 与 SLICE_GRID_MISMATCH 共用）───────────────────
 * 图集宽高比与 NumWidth×NumHeight 的"匹配"按**单格几何**判定：把图片按声明
 * 网格切分后，单格宽高比 (W/C)/(H/R) 必须落在 [0.5, 1.0]——TTS 卡牌都是
 * 竖卡或正方形（实测 5:7 ≈ 0.714 最常见），格子横宽（>1.0）几乎必然是
 * 列/行写反或声明错误，格子过扁（<0.5，如正方形图配 NumWidth=10、
 * NumHeight=1）同理。两个边界值（含）都放行；1×1 网格豁免（单卡对象
 * 可以是任意横竖的图）。注意正方形图 + 10×7 这类"压扁卡"工作坊图集
 * （单格 0.7）是放行的——只拦几何上说不通的声明。
 *
 * ── DeckIDs 与 1 基 slot（B2 坑 1）──────────────────────────────────────
 * slot 全程 **1 基**（CardID % 100，%100===0 表示第 100 格），复用
 * cardid.ts 的 {@link cardIdToKey} / {@link cardIdToSlot} / {@link slotToCardId}，
 * 不发明 0 基索引。切片范围由 DeckIDs 决定：只切 cardIdToKey(id) === 所选
 * key 的 DeckID（多图集牌堆切 key=101 时不碰 102 块）；DeckIDs 缺失（散卡）
 * 时切全部 C×R 格。card_id 一律取 DeckID 原值（无 DeckIDs 时才用
 * slotToCardId 合成）。
 *
 * ── 隐藏面（行为契约 8）──────────────────────────────────────────────────
 * DeckIDs 有效条数 === C×R − 1 时，最后一格（slot = C×R，10×7 即 70）是
 * 隐藏面：不切、cards.csv 不写该行（BackURL==FaceURL 时它正是卡背，
 * 见下）。这是 TTS "有隐藏面的牌堆 DeckIDs 少一格" 的直接实现。
 *
 * ── 背面（坑 5：UniqueBack 先判断再切）──────────────────────────────────
 * - UniqueBack=false：整副牌共用一张背面（BackURL 是单张图）。
 *   - BackURL == FaceURL：背面用图集**最后一格**（隐藏面通常就在这），
 *     切出 1 张 back.png；
 *   - BackURL 不同：离线切片拿不到远程 URL，按本工具链命名约定在同目录
 *     找 sanitize(BackURL) 对应的本地文件；找到 → 整图转 PNG 存 back.png；
 *     找不到 → 降级为无自定义背面（cards.csv back 列留空，回退牌堆默认
 *     背面），不报错、不中断（契约未为此定义错误码，静默降级优于卡死）；
 *   - 无 BackURL：不切背面，cards.csv back 列留空。
 * - UniqueBack=true：背面本身是同网格图集，每张卡的背面在对应 slot，
 *   切 N 张 back-XXX.png：
 *   - BackURL == FaceURL：正反面同图，直接从本图集按 slot 切；
 *   - BackURL 不同：同目录找 sanitize(BackURL) 本地图集，缺失 →
 *     SLICE_SHEET_NOT_FOUND（UniqueBack=true 的背面是必要数据，不降级）；
 *   背面图集同样做格子几何校验（不过 → SLICE_GRID_MISMATCH）。
 *
 * ── 产物命名与 cards.csv ─────────────────────────────────────────────────
 * - 正面：`card-<slot:03d>.png`（slot 1 基）；背面：`back.png`（共用）或
 *   `back-<slot:03d>.png`（UniqueBack=true）；全部直接落在 outDir
 *   （即 deckDir）下，无子目录；
 * - cards.csv 复用 cards.ts 的 {@link writeCardsCsv}（单一实现：BOM + LF +
 *   契约列序 + 写前校验），每行 card_id / face / back / sheet_id=1 / slot /
 *   sheet_cols=NumWidth / sheet_rows=NumHeight / sheet_source=FaceURL；
 *   sheet_source 原样保留 FaceURL 字符串（坑 5：{lang} 形式的值不做任何解析）。
 *
 * 错误码（{@link PackError.code}）：
 * - "SLICE_SHEET_NOT_FOUND"  图集文件不存在
 * - "SLICE_SAVE_INVALID"     存档读取 / JSON 解析失败，或存档结构非法
 *                            （缺 ObjectStates、DeckIDs 与声明矛盾等）
 * - "SLICE_ORPHAN_ATLAS"     在存档里找不到引用此图集的 CustomDeck
 * - "SLICE_AMBIGUOUS"        多候选且未提供 selectCandidate
 * - "SLICE_DECK_NOT_FOUND"   显式 deckKey / deckGuid 在存档里找不到
 * - "SLICE_GRID_MISMATCH"    图集宽高比与 NumWidth×NumHeight 不匹配
 * - "SLICE_IMAGE_INVALID"    sharp 读不出图集（损坏 / CMYK / 不支持的格式）
 *
 * 本模块新增的 i18n 键（locales/*.json 待补占位键；缺键时 t() 原样输出键名）：
 * - `error.pack.sliceSheetNotFound` {path}
 * - `error.pack.sliceBackSheetNotFound` {path}
 * - `error.pack.sliceSaveInvalid` {path} {detail}
 * - `error.pack.sliceSaveInconsistent` {detail}
 * - `error.pack.sliceOrphanAtlas` {sheet}
 * - `error.pack.sliceAmbiguous` {count} {candidates}
 * - `error.pack.sliceDeckNotFound` {target}
 * - `error.pack.sliceGridMismatch` {imageWidth} {imageHeight} {columns} {rows}
 * - `error.pack.sliceImageInvalid` {path} {detail}
 */

import { access, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";

import { CARDS_CSV_FILENAME, writeCardsCsv, type CardRow } from "./cards.js";
import { cardIdToKey, cardIdToSlot, isValidCardId, slotToCardId } from "./cardid.js";
import { slotToRect } from "./grid.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 网格列数上限（与 grid.ts 的 MAX_COLUMNS 同口径；本模块独立声明避免跨模块耦合） */
const MAX_COLUMNS = 10;

/** 网格行数上限（与 grid.ts 的 MAX_ROWS 同口径） */
const MAX_ROWS = 7;

/** 单格宽高比合法下界（竖卡下限 1:2，含） */
const CELL_ASPECT_MIN = 0.5;

/** 单格宽高比合法上界（正方形，含；横宽格子视为列/行写反） */
const CELL_ASPECT_MAX = 1.0;

/** 宽高比边界比较容差（浮点除法噪声） */
const ASPECT_EPS = 1e-9;

/** sanitize(URL) 文件名的最大长度（Windows MAX_PATH 保护；超长截断） */
const ATLAS_URL_FILENAME_MAX = 120;

/** 本地背面图集的候选扩展名（URL 不带扩展名时逐个尝试） */
const LOCAL_IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"] as const;

/** 文件名匹配的图片扩展名（反推 URL 与本地查找时从基名上剥除） */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

// ---------------------------------------------------------------------------
// 契约类型
// ---------------------------------------------------------------------------

/** 切片的一个候选：存档里某个引用该图集的 CustomDeck 条目 */
export interface DeckCandidate {
  /** 拥有该 CustomDeck 的存档对象 GUID（原样保留，不归一） */
  guid: string;
  /** 拥有者的 Nickname（空串省略） */
  nickname?: string;
  /** CustomDeck 的 key（图集编号，字符串形式，与存档一致） */
  deckKey: string;
  /** 该图集的 FaceURL（原样保留） */
  faceUrl: string;
  /** 声明的列数（NumWidth） */
  numWidth: number;
  /** 声明的行数（NumHeight） */
  numHeight: number;
  /** 是否每张卡有独立背面 */
  uniqueBack: boolean;
}

/** sliceAtlas 的入参 */
export interface SliceOptions {
  /** 图集图片绝对路径 */
  sheetPath: string;
  /** 存档 JSON 绝对路径（用于解析归属 + 读 CustomDeck） */
  savePath: string;
  /** 显式指定 deck key（跳过自动解析） */
  deckKey?: string;
  /** 显式指定 deck GUID（跳过自动解析） */
  deckGuid?: string;
  /** 输出目录（即 deckDir，如 packs/<name>/decks/<deckname>/） */
  outDir: string;
  /**
   * 多候选选择器（CLI 注入 readline 交互；测试注入 mock）；必须返回候选项之一。
   * 仅在候选数 > 1 时被调用。
   */
  selectCandidate?: (candidates: DeckCandidate[]) => Promise<DeckCandidate>;
}

/** sliceAtlas 的结果 */
export interface SliceResult {
  /** 切出的卡数 */
  cardsSliced: number;
  /** 实际选中的 deck */
  deck: DeckCandidate;
  /** 是否有共享图集（其他 CustomDeck 也引用同一 FaceURL；除自己外的 GUID 列表） */
  sharedWith: string[];
  /** cards.csv 路径 */
  cardsCsvPath: string;
  /** 切出的卡图路径列表（相对 outDir） */
  cardFiles: string[];
  /** 切出的背面图路径列表（相对 outDir；UniqueBack=false 时只 1 张；无背面为空） */
  backFiles: string[];
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT），避免 any。
 * （与 packyaml.ts / manifest.ts / cards.ts 的同名内部函数一致。）
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

/**
 * 判定值是否为普通键值对象（非 null、非数组）。
 * @param value 待判定值
 * @returns 是普通对象时返回 true
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 规范序列化：键排序后的 JSON 文本（副本折叠用——卡牌副本与牌堆对象的
 * CustomDeck 条目应逐字节相同，手改存档调换键序也要能判等）。
 * @param value 任意 JSON 值
 * @returns 规范化的 JSON 文本
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * 把 CustomDeck 的 key 归一为规范字符串（"101" 原样、"007" → "7"）。
 * 非纯数字的 key 在条目收集时就被丢弃，本函数只在已收集的 key 与
 * 显式入参之间比较时使用。
 * @param key CustomDeck 的 key
 * @returns 规范化字符串
 */
function normalizeDeckKey(key: string): string {
  return /^\d+$/.test(key) ? String(Number(key)) : key;
}

/**
 * URL → 本地文件名基名（本工具链约定，反推 URL 与背面本地查找共用）：
 * 剥协议头，非 [A-Za-z0-9._~-] 字符替换为 "_"，超长截断到 120，尾部点/空格
 * 删除（Windows 文件名限制）。**不做**大小写归一（比较时才小写化）。
 * @param url 原始 URL（{lang} 形式的多语言值会整体净化，不会撞出有意义的匹配）
 * @returns 净化后的基名（可能含 URL 自带的 ".png" 等扩展名）
 */
export function sanitizeAtlasUrl(url: string): string {
  const withoutProtocol = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const sanitized = withoutProtocol.replace(/[^A-Za-z0-9._~-]/g, "_");
  const truncated =
    sanitized.length > ATLAS_URL_FILENAME_MAX ? sanitized.slice(0, ATLAS_URL_FILENAME_MAX) : sanitized;
  return truncated.replace(/[. ]+$/, "");
}

/**
 * 剥除基名尾部的图片扩展名（".png" / ".jpg" / …；大小写不敏感）。
 * @param name 文件名或基名
 * @returns 剥除扩展名后的基名
 */
function stripImageExt(name: string): string {
  return name.replace(IMAGE_EXT_RE, "");
}

// ---------------------------------------------------------------------------
// 存档扫描：收集 CustomDeck 拥有者（副本折叠 + 空 GUID 跳过）
// ---------------------------------------------------------------------------

/** 收集到的一个 CustomDeck 条目（已做过类型裁剪，可直接切片） */
interface AtlasEntry {
  /** CustomDeck 的 key（规范字符串形式） */
  key: string;
  /** FaceURL（非空字符串） */
  faceUrl: string;
  /** BackURL（缺失 / 非字符串 / 空串 → undefined） */
  backUrl?: string;
  /** 声明列数（[1,10] 整数） */
  numWidth: number;
  /** 声明行数（[1,7] 整数） */
  numHeight: number;
  /** UniqueBack（缺失按 false） */
  uniqueBack: boolean;
}

/** 一个 CustomDeck 拥有者对象（卡堆 / 散卡；卡牌副本已折叠） */
interface DeckOwner {
  /** 对象 GUID（非空，原样保留） */
  guid: string;
  /** Nickname（空串省略） */
  nickname?: string;
  /** 对象上的 DeckIDs 原始值（未裁剪，取用时再校验） */
  rawDeckIds: unknown;
  /** 该对象名下的 CustomDeck 条目（副本不计） */
  entries: AtlasEntry[];
}

/**
 * 从存档对象的 CustomDeck 字段裁剪出可切片的条目。
 * 丢弃：非纯数字 key、FaceURL 非非空字符串、NumWidth/NumHeight 不是
 * [1,10]×[1,7] 整数的条目——它们在几何上不可切片，保留只会产生垃圾候选。
 * @param obj 存档对象
 * @returns 裁剪后的条目数组（无 CustomDeck / 全部不可用时为空数组）
 */
function entriesOf(obj: Record<string, unknown>): AtlasEntry[] {
  const customDeck = obj.CustomDeck;
  if (!isPlainObject(customDeck)) {
    return [];
  }
  const entries: AtlasEntry[] = [];
  for (const [rawKey, rawEntry] of Object.entries(customDeck)) {
    if (!/^\d+$/.test(rawKey) || !isPlainObject(rawEntry)) {
      continue;
    }
    const faceUrl = typeof rawEntry.FaceURL === "string" ? rawEntry.FaceURL : "";
    const numWidth = typeof rawEntry.NumWidth === "number" ? rawEntry.NumWidth : Number.NaN;
    const numHeight = typeof rawEntry.NumHeight === "number" ? rawEntry.NumHeight : Number.NaN;
    if (faceUrl === "" || !Number.isInteger(numWidth) || !Number.isInteger(numHeight)) {
      continue;
    }
    if (numWidth < 1 || numWidth > MAX_COLUMNS || numHeight < 1 || numHeight > MAX_ROWS) {
      continue;
    }
    const backUrlRaw = rawEntry.BackURL;
    const entry: AtlasEntry = {
      key: normalizeDeckKey(rawKey),
      faceUrl,
      numWidth,
      numHeight,
      uniqueBack: rawEntry.UniqueBack === true,
    };
    if (typeof backUrlRaw === "string" && backUrlRaw !== "") {
      entry.backUrl = backUrlRaw;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * 存档对象的容器子对象清单（坑 4 层面二：ContainedObjects / ChildObjects /
 * States / AttachedDecals 四种容器键；States / AttachedDecals 兼容数组与
 * 键值对象两种形态）。
 * @param obj 存档对象
 * @returns 全部子对象（顺序：数组序 / 键序）
 */
function childrenOf(obj: Record<string, unknown>): Record<string, unknown>[] {
  const children: Record<string, unknown>[] = [];
  const takeValue = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isPlainObject(item)) {
          children.push(item);
        }
      }
    } else if (isPlainObject(value)) {
      for (const item of Object.values(value)) {
        if (isPlainObject(item)) {
          children.push(item);
        }
      }
    }
  };
  takeValue(obj.ContainedObjects);
  takeValue(obj.ChildObjects);
  takeValue(obj.States);
  takeValue(obj.AttachedDecals);
  return children;
}

/**
 * 深度优先遍历存档对象树，收集 CustomDeck 拥有者。
 *
 * - 副本折叠：对象条目若与某祖先对象的同 key 条目规范序列化相同 → 跳过
 *   （坑 4 层面一：每张 Card 完整复制了一份 CustomDeck）；
 * - 空 GUID / 缺 GUID 对象不登记（坑 7），子对象照常遍历；
 * - 同一对象可持有多个条目（多图集牌堆），条目按存档键序排列。
 *
 * @param save 已 JSON.parse 的存档（根须为对象，ObjectStates 由调用方校验）
 * @returns 按遍历序的拥有者清单
 */
function collectDeckOwners(save: Record<string, unknown>): DeckOwner[] {
  const owners: DeckOwner[] = [];

  const visit = (obj: Record<string, unknown>, ancestors: Map<string, string>): void => {
    const entries = entriesOf(obj);
    const guid = typeof obj.GUID === "string" ? obj.GUID : "";
    // 副本折叠 + 空 GUID 跳过：两者都不登记，但条目仍要下传给子对象
    if (guid !== "" && entries.length > 0) {
      const isCopy = entries.every((entry) => {
        const raw = (obj.CustomDeck as Record<string, unknown>)[entry.key];
        const serialized = stableStringify(raw);
        const ancestorSerialized = ancestors.get(entry.key);
        return ancestorSerialized !== undefined && ancestorSerialized === serialized;
      });
      if (!isCopy) {
        const owner: DeckOwner = { guid, rawDeckIds: obj.DeckIDs, entries };
        if (typeof obj.Nickname === "string" && obj.Nickname !== "") {
          owner.nickname = obj.Nickname;
        }
        owners.push(owner);
      }
    }

    const childAncestors = new Map(ancestors);
    for (const entry of entries) {
      const raw = (obj.CustomDeck as Record<string, unknown>)[entry.key];
      childAncestors.set(entry.key, stableStringify(raw));
    }
    for (const child of childrenOf(obj)) {
      visit(child, childAncestors);
    }
  };

  const roots = Array.isArray(save.ObjectStates) ? save.ObjectStates : [];
  for (const root of roots) {
    if (isPlainObject(root)) {
      visit(root, new Map());
    }
  }
  return owners;
}

// ---------------------------------------------------------------------------
// 候选解析
// ---------------------------------------------------------------------------

/**
 * 由拥有者 + 条目构造候选。
 * @param owner 拥有者对象
 * @param entry 条目
 * @returns 候选
 */
function toCandidate(owner: DeckOwner, entry: AtlasEntry): DeckCandidate {
  return {
    guid: owner.guid,
    nickname: owner.nickname,
    deckKey: entry.key,
    faceUrl: entry.faceUrl,
    numWidth: entry.numWidth,
    numHeight: entry.numHeight,
    uniqueBack: entry.uniqueBack,
  };
}

/**
 * 判定"图集宽高比 + NumWidth×NumHeight"是否匹配（格子几何校验，见模块头注释）。
 * 1×1 网格豁免（单卡对象横竖皆可）。
 * @param imageWidth 图集实际宽
 * @param imageHeight 图集实际高
 * @param columns 声明列数
 * @param rows 声明行数
 * @returns 匹配返回 true
 */
function cellAspectOk(imageWidth: number, imageHeight: number, columns: number, rows: number): boolean {
  if (columns * rows === 1) {
    return true;
  }
  const cellAspect = imageWidth / columns / (imageHeight / rows);
  return cellAspect >= CELL_ASPECT_MIN - ASPECT_EPS && cellAspect <= CELL_ASPECT_MAX + ASPECT_EPS;
}

/**
 * 按文件名反推：找 FaceURL 净化基名与图集文件基名一致（大小写不敏感、
 * 扩展名不计）的 (owner, entry) 对。
 * @param owners 拥有者清单
 * @param sheetBase 图集文件基名（已剥扩展名）
 * @returns (owner, entry) 对列表（按遍历序）
 */
function matchByUrlBase(
  owners: readonly DeckOwner[],
  sheetBase: string,
): Array<{ owner: DeckOwner; entry: AtlasEntry }> {
  const wanted = stripImageExt(sheetBase).toLowerCase();
  const matches: Array<{ owner: DeckOwner; entry: AtlasEntry }> = [];
  for (const owner of owners) {
    for (const entry of owner.entries) {
      if (stripImageExt(sanitizeAtlasUrl(entry.faceUrl)).toLowerCase() === wanted) {
        matches.push({ owner, entry });
      }
    }
  }
  return matches;
}

/**
 * 按格子几何匹配：找声明网格切本图集能得到合法单格几何的 (owner, entry) 对。
 * @param owners 拥有者清单
 * @param imageWidth 图集实际宽
 * @param imageHeight 图集实际高
 * @returns (owner, entry) 对列表（按遍历序）
 */
function matchByCellAspect(
  owners: readonly DeckOwner[],
  imageWidth: number,
  imageHeight: number,
): Array<{ owner: DeckOwner; entry: AtlasEntry }> {
  const matches: Array<{ owner: DeckOwner; entry: AtlasEntry }> = [];
  for (const owner of owners) {
    for (const entry of owner.entries) {
      if (cellAspectOk(imageWidth, imageHeight, entry.numWidth, entry.numHeight)) {
        matches.push({ owner, entry });
      }
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// DeckIDs → 切片 slot 集合
// ---------------------------------------------------------------------------

/**
 * 由所选拥有者 + 条目算出要切的 slot 集合（1 基、升序）及 slot → CardID 映射。
 *
 * - DeckIDs 非空数组：只取 cardIdToKey(id) === 所选 key 的条目（多图集牌堆
 *   按块过滤）；条目必须是正整数（否则 SLICE_SAVE_INVALID）；同一 slot 重复、
 *   或 slot 超出 [1, columns*rows] → SLICE_SAVE_INVALID；
 *   有效条数 === columns*rows − 1 → 最后一格是隐藏面，剔除（行为契约 8）；
 * - DeckIDs 缺失 / 空数组（散卡）：切全部 columns*rows 格，CardID 用
 *   slotToCardId 合成。
 *
 * @param owner 所选拥有者
 * @param entry 所选条目
 * @returns 升序 slot 数组与 slot → CardID 映射
 * @throws PackError code="SLICE_SAVE_INVALID" DeckIDs 与声明矛盾时
 */
function resolveSlots(
  owner: DeckOwner,
  entry: AtlasEntry,
): { slots: number[]; cardIdBySlot: Map<number, number> } {
  const total = entry.numWidth * entry.numHeight;
  const raw = owner.rawDeckIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    const slots: number[] = [];
    const cardIdBySlot = new Map<number, number>();
    for (let slot = 1; slot <= total; slot++) {
      slots.push(slot);
      cardIdBySlot.set(slot, slotToCardId(entry.key, slot));
    }
    return { slots, cardIdBySlot };
  }

  const cardIdBySlot = new Map<number, number>();
  for (const item of raw) {
    if (typeof item !== "number" || !isValidCardId(item)) {
      throw new PackError(
        "SLICE_SAVE_INVALID",
        t("error.pack.sliceSaveInconsistent", {
          detail: `GUID ${owner.guid} 的 DeckIDs 含非法 CardID（${String(item)}），必须是正整数`,
        }),
      );
    }
    if (cardIdToKey(item) !== entry.key) {
      continue; // 属于其他图集块（多图集牌堆），切本图集时不碰
    }
    const slot = cardIdToSlot(item);
    if (slot > total) {
      throw new PackError(
        "SLICE_SAVE_INVALID",
        t("error.pack.sliceSaveInconsistent", {
          detail: `GUID ${owner.guid} 的 CardID ${item} 对应 slot ${slot}，超出图集容量 ${total}（${entry.numWidth}x${entry.numHeight}）`,
        }),
      );
    }
    const seen = cardIdBySlot.get(slot);
    if (seen !== undefined) {
      throw new PackError(
        "SLICE_SAVE_INVALID",
        t("error.pack.sliceSaveInconsistent", {
          detail: `GUID ${owner.guid} 的 DeckIDs 中 CardID ${seen} 与 ${item} 指向同一 slot ${slot}`,
        }),
      );
    }
    cardIdBySlot.set(slot, item);
  }

  if (cardIdBySlot.size === 0) {
    throw new PackError(
      "SLICE_SAVE_INVALID",
      t("error.pack.sliceSaveInconsistent", {
        detail: `GUID ${owner.guid} 的 DeckIDs 与 CustomDeck key "${entry.key}" 无交集（声明与数据矛盾）`,
      }),
    );
  }

  // 隐藏面：有效格数恰好比图集容量少 1 → 最后一格是隐藏面，不切（行为契约 8）
  if (cardIdBySlot.size === total - 1) {
    cardIdBySlot.delete(total);
  }
  return { slots: [...cardIdBySlot.keys()].sort((a, b) => a - b), cardIdBySlot };
}

// ---------------------------------------------------------------------------
// 背面源解析
// ---------------------------------------------------------------------------

/** 背面来源：同图集按 slot 切 / 单张整图 / 无背面 */
type BackSource =
  | { kind: "sameSheet" }
  | { kind: "lastCell" }
  | { kind: "file"; filePath: string }
  | { kind: "none" };

/**
 * 解析背面来源（见模块头注释"背面"一节）。
 * @param entry 所选条目
 * @param sheetPath 正面图集路径（同目录查找背面本地文件）
 * @returns 背面来源
 * @throws PackError code="SLICE_SHEET_NOT_FOUND" UniqueBack=true 且背面图集本地缺失时
 */
async function resolveBackSource(entry: AtlasEntry, sheetPath: string): Promise<BackSource> {
  const backUrl = entry.backUrl;
  if (backUrl === undefined) {
    return { kind: "none" };
  }
  if (backUrl === entry.faceUrl) {
    return entry.uniqueBack ? { kind: "sameSheet" } : { kind: "lastCell" };
  }
  const local = await findLocalSheet(backUrl, path.dirname(sheetPath));
  if (local !== undefined) {
    return { kind: "file", filePath: local };
  }
  if (entry.uniqueBack) {
    throw new PackError(
      "SLICE_SHEET_NOT_FOUND",
      t("error.pack.sliceBackSheetNotFound", {
        path: path.join(path.dirname(sheetPath), sanitizeAtlasUrl(backUrl)),
      }),
    );
  }
  // UniqueBack=false：背面是装饰性共用图，本地缺失降级为无自定义背面
  return { kind: "none" };
}

/**
 * 按 URL 在目录里找本地文件：先精确匹配 sanitize(URL)，URL 自带扩展名时
 * 依次尝试常见图片扩展名（URL 无扩展名的图床场景）。
 * @param url 素材 URL
 * @param dir 查找目录
 * @returns 找到的文件路径；找不到返回 undefined
 */
async function findLocalSheet(url: string, dir: string): Promise<string | undefined> {
  const base = sanitizeAtlasUrl(url);
  const candidates = [base];
  if (!IMAGE_EXT_RE.test(base)) {
    for (const ext of LOCAL_IMAGE_EXTS) {
      candidates.push(base + ext);
    }
  }
  let dirEntries: string[];
  try {
    dirEntries = await readdir(dir);
  } catch {
    return undefined;
  }
  const wanted = candidates.map((candidate) => candidate.toLowerCase());
  for (const name of dirEntries) {
    if (wanted.includes(name.toLowerCase())) {
      return path.join(dir, name);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 图片 IO
// ---------------------------------------------------------------------------

/**
 * 读取图集元数据（尺寸 + 色彩空间），失败 / CMYK / 尺寸非法一律 SLICE_IMAGE_INVALID。
 * @param filePath 图片路径
 * @param label 错误信息里的图片角色描述（如 "图集"、"背面图集"）
 * @returns 实际宽高（正整数像素）
 * @throws PackError code="SLICE_IMAGE_INVALID" sharp 读不出 / CMYK / 尺寸非法时
 */
async function readImageSize(filePath: string, label: string): Promise<{ width: number; height: number }> {
  let meta;
  try {
    meta = await sharp(filePath).metadata();
  } catch (err) {
    throw new PackError(
      "SLICE_IMAGE_INVALID",
      t("error.pack.sliceImageInvalid", { path: filePath, detail: `${label}：${errMessage(err)}` }),
    );
  }
  if (meta.space === "cmyk") {
    throw new PackError(
      "SLICE_IMAGE_INVALID",
      t("error.pack.sliceImageInvalid", { path: filePath, detail: `${label}：CMYK 色彩空间不受支持` }),
    );
  }
  const { width, height } = meta;
  if (typeof width !== "number" || !Number.isInteger(width) || width <= 0
    || typeof height !== "number" || !Number.isInteger(height) || height <= 0) {
    throw new PackError(
      "SLICE_IMAGE_INVALID",
      t("error.pack.sliceImageInvalid", {
        path: filePath,
        detail: `${label}：图片尺寸非法（${String(width)}x${String(height)}）`,
      }),
    );
  }
  return { width, height };
}

/**
 * 按格子几何校验声明网格与实际尺寸，不符抛 SLICE_GRID_MISMATCH。
 * @param imageWidth 实际宽
 * @param imageHeight 实际高
 * @param columns 声明列数
 * @param rows 声明行数
 * @throws PackError code="SLICE_GRID_MISMATCH" 单格几何不合法时
 */
function assertGridFits(imageWidth: number, imageHeight: number, columns: number, rows: number): void {
  if (!cellAspectOk(imageWidth, imageHeight, columns, rows)) {
    throw new PackError(
      "SLICE_GRID_MISMATCH",
      t("error.pack.sliceGridMismatch", { imageWidth, imageHeight, columns, rows }),
    );
  }
}

/**
 * 切出单格并写 PNG 文件。
 * @param sheetPath 图集路径
 * @param rect 提取矩形（slotToRect 产物，整数像素）
 * @param destPath 目标 PNG 路径
 */
async function extractCell(
  sheetPath: string,
  rect: { left: number; top: number; width: number; height: number },
  destPath: string,
): Promise<void> {
  await sharp(sheetPath).extract(rect).png().toFile(destPath);
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 断言入参是非空字符串路径（调用方编程错误，按仓库惯例抛普通中文 Error）。
 * @param value 待校验值
 * @param argName 入参名
 * @throws value 不是非空字符串时
 */
function assertPathArg(value: unknown, argName: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`切片入参无效：${argName} 必须是非空字符串路径`);
  }
}

/**
 * 图集切片主入口（行为契约见模块头注释）。
 *
 * 全部校验（归属、网格、DeckIDs、背面来源与背面图集元数据）都发生在
 * **写任何文件之前**——失败时不产出部分切片，也不产出孤儿 cards.csv。
 *
 * @param opts 切片入参
 * @returns 切片结果（卡数、选中 deck、共享列表、cards.csv 与图片文件清单）
 * @throws PackError（code 见模块头注释"错误码"）
 * @throws Error 入参不是非空字符串路径、或 selector 返回了候选之外的对象时
 *   （调用方编程错误）
 */
export async function sliceAtlas(opts: SliceOptions): Promise<SliceResult> {
  assertPathArg(opts.sheetPath, "sheetPath");
  assertPathArg(opts.savePath, "savePath");
  assertPathArg(opts.outDir, "outDir");

  // ---- 图集存在性（先于一切解析） ----------------------------------------
  try {
    await access(opts.sheetPath);
  } catch (err) {
    throw new PackError(
      "SLICE_SHEET_NOT_FOUND",
      t("error.pack.sliceSheetNotFound", { path: opts.sheetPath }),
    );
  }

  // ---- 解析存档 ----------------------------------------------------------
  let saveText: string;
  try {
    saveText = await readFile(opts.savePath, "utf8");
  } catch (err) {
    throw new PackError(
      "SLICE_SAVE_INVALID",
      t("error.pack.sliceSaveInvalid", { path: opts.savePath, detail: errMessage(err) }),
    );
  }
  let save: unknown;
  try {
    save = JSON.parse(saveText);
  } catch (err) {
    throw new PackError(
      "SLICE_SAVE_INVALID",
      t("error.pack.sliceSaveInvalid", { path: opts.savePath, detail: errMessage(err) }),
    );
  }
  if (!isPlainObject(save) || !Array.isArray(save.ObjectStates)) {
    throw new PackError(
      "SLICE_SAVE_INVALID",
      t("error.pack.sliceSaveInvalid", {
        path: opts.savePath,
        detail: "存档根必须是键值对象且含 ObjectStates 数组",
      }),
    );
  }

  // ---- 读图集元数据（归属解析的宽高比匹配需要实际尺寸） ------------------
  const sheetSize = await readImageSize(opts.sheetPath, "图集");

  // ---- 归属解析（优先级见模块头注释） ------------------------------------
  const owners = collectDeckOwners(save);
  let matched: Array<{ owner: DeckOwner; entry: AtlasEntry }>;

  const deckGuid = typeof opts.deckGuid === "string" ? opts.deckGuid : undefined;
  const deckKey = typeof opts.deckKey === "string" ? opts.deckKey : undefined;
  if (deckGuid !== undefined || deckKey !== undefined) {
    // 优先级 1：显式指定，跳过自动解析
    if (deckGuid !== undefined && deckKey !== undefined) {
      const owner = owners.find((candidate) => candidate.guid === deckGuid);
      const entry = owner?.entries.find((candidate) => candidate.key === normalizeDeckKey(deckKey));
      if (owner === undefined || entry === undefined) {
        throw new PackError(
          "SLICE_DECK_NOT_FOUND",
          t("error.pack.sliceDeckNotFound", { target: `GUID ${deckGuid} + key ${deckKey}` }),
        );
      }
      matched = [{ owner, entry }];
    } else if (deckGuid !== undefined) {
      const owner = owners.find((candidate) => candidate.guid === deckGuid);
      if (owner === undefined || owner.entries.length === 0) {
        throw new PackError(
          "SLICE_DECK_NOT_FOUND",
          t("error.pack.sliceDeckNotFound", { target: `GUID ${deckGuid}` }),
        );
      }
      matched = owner.entries.map((entry) => ({ owner, entry }));
    } else {
      const wantedKey = normalizeDeckKey(deckKey as string);
      matched = owners.flatMap((owner) =>
        owner.entries.filter((entry) => entry.key === wantedKey).map((entry) => ({ owner, entry })),
      );
      if (matched.length === 0) {
        throw new PackError(
          "SLICE_DECK_NOT_FOUND",
          t("error.pack.sliceDeckNotFound", { target: `key ${deckKey}` }),
        );
      }
    }
  } else {
    // 优先级 2：文件名反推 URL
    matched = matchByUrlBase(owners, path.basename(opts.sheetPath));
    // 优先级 3：图集宽高比 + NumWidth×NumHeight 匹配
    if (matched.length === 0) {
      matched = matchByCellAspect(owners, sheetSize.width, sheetSize.height);
    }
    if (matched.length === 0) {
      // 优先级 5：孤儿图集
      throw new PackError(
        "SLICE_ORPHAN_ATLAS",
        t("error.pack.sliceOrphanAtlas", { sheet: opts.sheetPath }),
      );
    }
  }

  // ---- 多候选 → selector（优先级 4） -------------------------------------
  let chosen: { owner: DeckOwner; entry: AtlasEntry };
  if (matched.length === 1) {
    chosen = matched[0];
  } else {
    const candidates = matched.map((pair) => toCandidate(pair.owner, pair.entry));
    if (opts.selectCandidate === undefined) {
      const summary = candidates
        .map((candidate) =>
          `${candidate.guid}${candidate.nickname === undefined ? "" : ` (${candidate.nickname})`} key=${candidate.deckKey}`,
        )
        .join("、");
      throw new PackError(
        "SLICE_AMBIGUOUS",
        t("error.pack.sliceAmbiguous", { count: candidates.length, candidates: summary }),
      );
    }
    const picked = await opts.selectCandidate(candidates);
    const hit = matched.find((pair) => {
      const candidate = toCandidate(pair.owner, pair.entry);
      return candidate === picked
        || (candidate.guid === picked.guid
          && candidate.deckKey === picked.deckKey
          && candidate.faceUrl === picked.faceUrl);
    });
    if (hit === undefined) {
      throw new Error("切片入参无效：selectCandidate 必须返回候选项之一");
    }
    chosen = hit;
  }

  const { owner, entry } = chosen;
  const candidate = toCandidate(owner, entry);

  // ---- 网格几何校验（写文件之前） ----------------------------------------
  assertGridFits(sheetSize.width, sheetSize.height, entry.numWidth, entry.numHeight);

  // ---- 切片范围（DeckIDs → 1 基 slot；隐藏面在此剔除） -------------------
  const { slots, cardIdBySlot } = resolveSlots(owner, entry);

  // ---- 背面来源（背面图集的元数据与网格校验也在写文件之前） --------------
  // UniqueBack=true 的背面是同网格图集 → 校验元数据与格子几何；
  // UniqueBack=false 的背面是单张装饰图 → 不做网格校验（原样转 PNG）。
  const backSource = await resolveBackSource(entry, opts.sheetPath);
  let backSheetSize: { width: number; height: number } | undefined;
  if (backSource.kind === "file" && entry.uniqueBack) {
    backSheetSize = await readImageSize(backSource.filePath, "背面图集");
    assertGridFits(backSheetSize.width, backSheetSize.height, entry.numWidth, entry.numHeight);
  }

  // ---- 共享检测：所有引用同一 FaceURL 的其他 CustomDeck 拥有者 -----------
  const sharedWith: string[] = [];
  for (const other of owners) {
    if (other.guid === owner.guid) {
      continue;
    }
    if (other.entries.some((otherEntry) => otherEntry.faceUrl === entry.faceUrl)
      && !sharedWith.includes(other.guid)) {
      sharedWith.push(other.guid);
    }
  }

  // ---- 落盘 --------------------------------------------------------------
  await mkdir(opts.outDir, { recursive: true });

  const cardName = (slot: number): string => `card-${String(slot).padStart(3, "0")}.png`;
  const backName = (slot: number): string => `back-${String(slot).padStart(3, "0")}.png`;
  const total = entry.numWidth * entry.numHeight;

  const cardFiles: string[] = [];
  for (const slot of slots) {
    const dest = path.join(opts.outDir, cardName(slot));
    await extractCell(opts.sheetPath, slotToRect(slot, sheetSize.width, sheetSize.height, entry.numWidth, entry.numHeight), dest);
    cardFiles.push(cardName(slot));
  }

  const backFiles: string[] = [];
  if (backSource.kind === "lastCell") {
    // UniqueBack=false 且 BackURL==FaceURL：背面用图集最后一格（隐藏面就在这）
    const rect = slotToRect(total, sheetSize.width, sheetSize.height, entry.numWidth, entry.numHeight);
    await extractCell(opts.sheetPath, rect, path.join(opts.outDir, "back.png"));
    backFiles.push("back.png");
  } else if (backSource.kind === "sameSheet") {
    // UniqueBack=true 且 BackURL==FaceURL：正反面同图集，按 slot 切背面
    for (const slot of slots) {
      const rect = slotToRect(slot, sheetSize.width, sheetSize.height, entry.numWidth, entry.numHeight);
      await extractCell(opts.sheetPath, rect, path.join(opts.outDir, backName(slot)));
      backFiles.push(backName(slot));
    }
  } else if (backSource.kind === "file") {
    if (entry.uniqueBack) {
      // UniqueBack=true：背面图集同网格，按 slot 切（尺寸已在前面校验）
      const size = backSheetSize as { width: number; height: number };
      for (const slot of slots) {
        const rect = slotToRect(slot, size.width, size.height, entry.numWidth, entry.numHeight);
        await extractCell(backSource.filePath, rect, path.join(opts.outDir, backName(slot)));
        backFiles.push(backName(slot));
      }
    } else {
      // UniqueBack=false：单张背面整图转 PNG
      await sharp(backSource.filePath).png().toFile(path.join(opts.outDir, "back.png"));
      backFiles.push("back.png");
    }
  }
  // backSource.kind === "none"：无背面，cards.csv back 列留空

  // ---- cards.csv（复用 cards.ts：BOM + LF + 写前校验，单一实现） ----------
  const backFor = (slot: number): string | undefined => {
    switch (backSource.kind) {
      case "lastCell":
        return "back.png";
      case "sameSheet":
        return backName(slot);
      case "file":
        return entry.uniqueBack ? backName(slot) : "back.png";
      default:
        return undefined;
    }
  };
  const rows: CardRow[] = slots.map((slot) => {
    const row: CardRow = {
      cardId: cardIdBySlot.get(slot) ?? slotToCardId(entry.key, slot),
      face: cardName(slot),
      sheetId: 1,
      slot,
      sheetCols: entry.numWidth,
      sheetRows: entry.numHeight,
      sheetSource: entry.faceUrl,
    };
    const back = backFor(slot);
    if (back !== undefined) {
      row.back = back;
    }
    return row;
  });
  const cardsCsvPath = path.join(opts.outDir, CARDS_CSV_FILENAME);
  await writeCardsCsv(opts.outDir, rows);

  return {
    cardsSliced: rows.length,
    deck: candidate,
    sharedWith,
    cardsCsvPath,
    cardFiles,
    backFiles,
  };
}
