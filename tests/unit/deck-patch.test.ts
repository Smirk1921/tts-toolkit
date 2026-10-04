// tests/unit/deck-patch.test.ts
/**
 * src/deck/patch.ts 单元测试：CustomDeck 递归遍历器（坑 4 收口）。
 *
 * 纯内存模块（无 IO / 无网络 / 无临时目录），夹具全部内联：
 * - 正常路径（覆盖契约 = 漏一个都是 bug）：
 *   · 素材字段逐字段：CustomDeck.FaceURL/BackURL（含多图集编号映射）、
 *     CustomImage 两字段、CustomMesh 四件套、CustomAssetbundle 两字段、
 *     CustomDecal.ImageURL、CustomPDF.PDFUrl（拼写锁死，非 PDFURL）、
 *     顶层 SkyURL / TableURL；
 *   · 容器键四种：ContainedObjects / ChildObjects / States（对象映射实测形状
 *     + 数组宽容形状）/ AttachedDecals，含"牌堆 + 每张 Card 复制 CustomDeck"
 *     的层面一场景与整体改写；
 *   · host / hostKey / objectPath / guid / name 的精确定位、原地写回、
 *     返回值计数、固定访问顺序、路径格式（契约样例
 *     "ObjectStates[3].ContainedObjects[5]" 原文比对、8 层嵌套）。
 * - 异常路径：畸形结构（CustomDeck 为标量/数组/规格非对象、容器键为标量、
 *   ObjectStates 元素为 null/标量）一律跳过不抛错；根不是普通对象返回 0。
 * - 边界值：空 ObjectStates、无 ObjectStates、GUID 空串/缺失/非字符串、
 *   Name 缺失/空串、空串 URL 不访问、空白 URL 仍访问（非空判定严格等于 ""）；
 *   {lang} 默认跳过不计数（坑 5）、skipLangVariants=false 照常访问可写回；
 *   autoFixProtocol 只改 visitor 看到的 currentValue 不写回；
 *   file: 触发 onLocalFile 且仍被 visitor 访问。
 * - 性能（方案设计 §2.6.6）：37,492 个存档对象（3,749 牌堆 × 10 + 2 贴图）、
 *   74,982 个 URL 字段，walkSaveUrls 须在 1 秒内完成（不做深拷贝的硬指标，
 *   常规机器远低于上限，故不 skip）。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  isLangVariant,
  isLocalFileUrl,
  isMissingProtocol,
  walkSaveUrls,
  type UrlLocation,
} from '../../src/deck/patch.js';

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 常用图集 URL */
const FACE = 'http://example.com/atlas/face.png';
const BACK = 'http://example.com/atlas/back.png';

/** visitor 抓取的 loc 快照（fieldPath 拷贝一份防意外共享，host 保留引用断言同一性） */
interface Snapshot {
  objectPath: string;
  guid: string;
  name: string | undefined;
  fieldPath: readonly string[];
  currentValue: string;
  host: Record<string, unknown>;
  hostKey: string;
}

/** 只读 visitor：抓快照、不修改任何字段 */
function recorder(): { visitor: (loc: UrlLocation) => void; snapshots: Snapshot[] } {
  const snapshots: Snapshot[] = [];
  const visitor = (loc: UrlLocation): void => {
    snapshots.push({
      objectPath: loc.objectPath,
      guid: loc.guid,
      name: loc.name,
      fieldPath: [...loc.fieldPath],
      currentValue: loc.currentValue,
      host: loc.host,
      hostKey: loc.hostKey,
    });
  };
  return { visitor, snapshots };
}

/** 快照的 "路径#字段路径" 串（用于顺序断言） */
function locKeys(snaps: readonly Snapshot[]): string[] {
  return snaps.map((s) => `${s.objectPath}#${s.fieldPath.join('.')}`);
}

/** 标准单牌堆夹具：ObjectStates[0] = Deck（CustomDeck["1"] 正反面） */
function deckFixture(): {
  root: Record<string, unknown>;
  deck: Record<string, unknown>;
  deckSpec: Record<string, unknown>;
} {
  const deckSpec: Record<string, unknown> = {
    FaceURL: FACE,
    BackURL: BACK,
    NumWidth: 10,
    NumHeight: 7,
    Type: 0,
    UniqueBack: false,
  };
  const deck: Record<string, unknown> = {
    GUID: 'aa11bb',
    Name: 'Deck',
    Nickname: 'Poker Deck',
    CustomDeck: { '1': deckSpec },
  };
  return { root: { ObjectStates: [deck] }, deck, deckSpec };
}

// ---------------------------------------------------------------------------
// isLangVariant：{lang} 形态判定（坑 5 的前置）
// ---------------------------------------------------------------------------

describe('isLangVariant', () => {
  it('含 {xx} / {xx-yy} 段即命中（任意位置、2-3 位小写、数字区域变体）', () => {
    const cases: Array<[string, boolean]> = [
      ['{en}http://en.png{zh-cn}http://zh.png', true], // 坑 5 原文样例
      ['{zh}http://x.png', true], // 2 位
      ['{eng}http://x.png', true], // 3 位
      ['{zh-cn}http://x.png', true], // 带区域
      ['{pt-br}http://x.png', true], // 带区域
      ['{es-419}http://x.png', true], // 数字区域变体
      ['http://x.com/a{de}b.png', true], // 段在中部也算
    ];
    for (const [value, expected] of cases) {
      expect(isLangVariant(value), value).toBe(expected);
    }
  });

  it('不含语言段的普通值不命中（大写 / 位数不足 / 非字母数字段都不算）', () => {
    const cases: Array<[string, boolean]> = [
      ['http://example.com/u.png', false],
      ['', false],
      ['{e}http://x.png', false], // 1 位不算
      ['{EN}http://x.png', false], // 大写不算（xx 必须小写）
      ['{zh_CN}http://x.png', false], // 下划线不算
      ['{lang}http://x.png', false], // 4 位不算
      ['{1234}http://x.png', false], // 纯数字段不算
      ['plain text', false],
    ];
    for (const [value, expected] of cases) {
      expect(isLangVariant(value), value).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// isLocalFileUrl / isMissingProtocol：形态判定
// ---------------------------------------------------------------------------

describe('isLocalFileUrl', () => {
  it('file: 协议命中（大小写不敏感；协议只认 file: 前缀）', () => {
    const cases: Array<[string, boolean]> = [
      ['file:///D:/tts/x.png', true],
      ['file://home/user/x.png', true],
      ['FILE://X.PNG', true],
      ['http://example.com/file:x', false], // file: 不是前缀
      ['files://x.png', false], // files: ≠ file:
      ['http://x.png', false],
      ['', false],
    ];
    for (const [value, expected] of cases) {
      expect(isLocalFileUrl(value), value).toBe(expected);
    }
  });
});

describe('isMissingProtocol', () => {
  it('www. 开头命中（大小写不敏感）；带协议或仅中部含 www. 不命中', () => {
    const cases: Array<[string, boolean]> = [
      ['www.example.com/a.png', true],
      ['WWW.Example.COM/a.png', true],
      ['http://www.example.com/a.png', false], // 已有协议
      ['https://example.com/x/www.b.png', false], // 中部 www. 不算开头
      ['awww.example.com/a.png', false], // 前缀不是 www.
      ['file://www.x/a.png', false], // 已有协议
      ['', false],
    ];
    for (const [value, expected] of cases) {
      expect(isMissingProtocol(value), value).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// 素材字段全覆盖（契约：漏一个都是 bug）
// ---------------------------------------------------------------------------

describe('素材字段全覆盖', () => {
  it('CustomDeck.FaceURL / BackURL：定位信息精确（objectPath / guid / name / host / hostKey）', () => {
    const { root, deckSpec } = deckFixture();
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls(root, visitor);

    expect(count).toBe(2);
    expect(snapshots).toHaveLength(2);

    const face = snapshots[0]!;
    expect(face.objectPath).toBe('ObjectStates[0]');
    expect(face.guid).toBe('aa11bb');
    expect(face.name).toBe('Deck');
    expect(face.fieldPath).toEqual(['CustomDeck', 'FaceURL']);
    expect(face.currentValue).toBe(FACE);
    expect(face.host).toBe(deckSpec); // 引用同一：无深拷贝
    expect(face.hostKey).toBe('FaceURL');

    const back = snapshots[1]!;
    expect(back.fieldPath).toEqual(['CustomDeck', 'BackURL']);
    expect(back.currentValue).toBe(BACK);
    expect(back.host).toBe(deckSpec);
    expect(back.hostKey).toBe('BackURL');
  });

  it('CustomDeck 多图集（"1" / "2" 映射）：每个规格对象的正反面都访问，host 各自独立', () => {
    const spec1 = { FaceURL: 'http://s1.example.com/face.png', BackURL: 'http://s1.example.com/back.png' };
    const spec2 = { FaceURL: 'http://s2.example.com/face.png', BackURL: 'http://s2.example.com/back.png' };
    const root = { ObjectStates: [{ GUID: 'd', Name: 'Deck', CustomDeck: { '1': spec1, '2': spec2 } }] };
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls(root, visitor);

    expect(count).toBe(4);
    expect(snapshots.map((s) => s.currentValue)).toEqual([
      'http://s1.example.com/face.png',
      'http://s1.example.com/back.png',
      'http://s2.example.com/face.png',
      'http://s2.example.com/back.png',
    ]);
    expect(snapshots[0]!.host).toBe(spec1);
    expect(snapshots[1]!.host).toBe(spec1);
    expect(snapshots[2]!.host).toBe(spec2);
    expect(snapshots[3]!.host).toBe(spec2);
    // fieldPath 恒两段：图集编号不进 fieldPath，以 host 区分
    expect(snapshots.map((s) => s.fieldPath.join('.'))).toEqual([
      'CustomDeck.FaceURL',
      'CustomDeck.BackURL',
      'CustomDeck.FaceURL',
      'CustomDeck.BackURL',
    ]);
  });

  it('CustomImage.ImageURL / ImageSecondaryURL（图块类）', () => {
    const customImage = { ImageURL: 'http://img.example.com/a.png', ImageSecondaryURL: 'http://img.example.com/b.png' };
    const root = { ObjectStates: [{ GUID: 't1', Name: 'Custom_Tile', CustomImage: customImage }] };
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls(root, visitor);

    expect(count).toBe(2);
    expect(snapshots[0]!.fieldPath).toEqual(['CustomImage', 'ImageURL']);
    expect(snapshots[0]!.objectPath).toBe('ObjectStates[0]');
    expect(snapshots[0]!.host).toBe(customImage);
    expect(snapshots[1]!.fieldPath).toEqual(['CustomImage', 'ImageSecondaryURL']);
    expect(snapshots[1]!.host).toBe(customImage);
  });

  it('CustomMesh 四件套：MeshURL / DiffuseURL / NormalURL / ColliderURL 全访问且按序', () => {
    const customMesh = {
      MeshURL: 'http://mesh.example.com/m.obj',
      DiffuseURL: 'http://mesh.example.com/d.png',
      NormalURL: 'http://mesh.example.com/n.png',
      ColliderURL: 'http://mesh.example.com/c.obj',
    };
    const root = { ObjectStates: [{ GUID: 'm1', Name: 'Custom_Model', CustomMesh: customMesh }] };
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls(root, visitor);

    expect(count).toBe(4);
    expect(snapshots.map((s) => s.fieldPath.join('.'))).toEqual([
      'CustomMesh.MeshURL',
      'CustomMesh.DiffuseURL',
      'CustomMesh.NormalURL',
      'CustomMesh.ColliderURL',
    ]);
    for (const s of snapshots) {
      expect(s.host).toBe(customMesh);
      expect(s.objectPath).toBe('ObjectStates[0]');
    }
  });

  it('CustomAssetbundle.AssetbundleURL / AssetbundleSecondaryURL', () => {
    const bundle = { AssetbundleURL: 'http://ab.example.com/main', AssetbundleSecondaryURL: 'http://ab.example.com/sec' };
    const root = { ObjectStates: [{ GUID: 'b1', Name: 'Custom_Assetbundle', CustomAssetbundle: bundle }] };
    const { visitor, snapshots } = recorder();

    expect(walkSaveUrls(root, visitor)).toBe(2);
    expect(snapshots[0]!.fieldPath).toEqual(['CustomAssetbundle', 'AssetbundleURL']);
    expect(snapshots[0]!.host).toBe(bundle);
    expect(snapshots[1]!.fieldPath).toEqual(['CustomAssetbundle', 'AssetbundleSecondaryURL']);
  });

  it('CustomDecal.ImageURL（贴花对象）', () => {
    const decal = { ImageURL: 'http://decal.example.com/d.png' };
    const root = { ObjectStates: [{ GUID: 'dc1', Name: 'CustomDecal', CustomDecal: decal }] };
    const { visitor, snapshots } = recorder();

    expect(walkSaveUrls(root, visitor)).toBe(1);
    expect(snapshots[0]!.fieldPath).toEqual(['CustomDecal', 'ImageURL']);
    expect(snapshots[0]!.currentValue).toBe('http://decal.example.com/d.png');
    expect(snapshots[0]!.host).toBe(decal);
  });

  it('CustomPDF.PDFUrl：字段名拼写就是 PDFUrl（不是 PDFURL，防 typo 回归）', () => {
    const pdf = { PDFUrl: 'http://pdf.example.com/doc.pdf' };
    const root = { ObjectStates: [{ GUID: 'p1', Name: 'Custom_PDF', CustomPDF: pdf }] };
    const { visitor, snapshots } = recorder();

    expect(walkSaveUrls(root, visitor)).toBe(1);
    expect(snapshots[0]!.fieldPath).toEqual(['CustomPDF', 'PDFUrl']);
    expect(snapshots[0]!.host).toBe(pdf);
    // 稍微拼错的 PDFURL 不应命中
    const wrongPdf = { PDFURL: 'http://pdf.example.com/doc.pdf' };
    expect(walkSaveUrls({ ObjectStates: [{ CustomPDF: wrongPdf }] }, visitor)).toBe(0);
  });

  it('顶层直接字段 SkyURL / TableURL：挂在根对象上（objectPath 为空串、guid 为空串）', () => {
    const root: Record<string, unknown> = {
      SkyURL: 'http://sky.example.com/sky.jpg',
      TableURL: 'http://sky.example.com/table.jpg',
      ObjectStates: [],
    };
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls(root, visitor);

    expect(count).toBe(2);
    expect(snapshots[0]!.fieldPath).toEqual(['SkyURL']);
    expect(snapshots[0]!.objectPath).toBe('');
    expect(snapshots[0]!.guid).toBe('');
    expect(snapshots[0]!.name).toBeUndefined();
    expect(snapshots[0]!.host).toBe(root);
    expect(snapshots[0]!.hostKey).toBe('SkyURL');
    expect(snapshots[1]!.fieldPath).toEqual(['TableURL']);
    expect(snapshots[1]!.host).toBe(root);
  });
});

// ---------------------------------------------------------------------------
// 容器键四种（坑 4：漏一个都是 bug）
// ---------------------------------------------------------------------------

describe('容器键四种（坑 4）', () => {
  it('ContainedObjects：牌堆 + 每张 Card 复制的 CustomDeck 都被访问（层面一）', () => {
    const deckSpec = { FaceURL: FACE, BackURL: BACK, NumWidth: 10, NumHeight: 7 };
    const cards = [0, 1, 2].map((i) => ({
      GUID: `card0${i}`,
      Name: 'Card',
      CardID: 100 + i + 1, // CardID 1 基：slot = CardID % 100
      CustomDeck: { '1': { FaceURL: FACE, BackURL: BACK, NumWidth: 10, NumHeight: 7 } },
    }));
    const deck = { GUID: 'deck00', Name: 'Deck', CustomDeck: { '1': deckSpec }, ContainedObjects: cards };
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls({ ObjectStates: [deck] }, visitor);

    expect(count).toBe(8); // 牌堆 2 + 3 张卡 × 2
    expect(locKeys(snapshots)).toEqual([
      'ObjectStates[0]#CustomDeck.FaceURL',
      'ObjectStates[0]#CustomDeck.BackURL',
      'ObjectStates[0].ContainedObjects[0]#CustomDeck.FaceURL',
      'ObjectStates[0].ContainedObjects[0]#CustomDeck.BackURL',
      'ObjectStates[0].ContainedObjects[1]#CustomDeck.FaceURL',
      'ObjectStates[0].ContainedObjects[1]#CustomDeck.BackURL',
      'ObjectStates[0].ContainedObjects[2]#CustomDeck.FaceURL',
      'ObjectStates[0].ContainedObjects[2]#CustomDeck.BackURL',
    ]);
    // 卡的 loc 带卡自己的 GUID / Name（当前对象 = 卡）
    expect(snapshots[2]!.guid).toBe('card00');
    expect(snapshots[2]!.name).toBe('Card');
  });

  it('ChildObjects：另一种子对象容器（实测最易漏）也被访问', () => {
    const chip = { GUID: 'chip1', Name: 'Custom_Tile', CustomImage: { ImageURL: 'http://chip.example.com/c.png' } };
    const board = { GUID: 'board1', Name: 'Custom_Board', ChildObjects: [chip] };
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls({ ObjectStates: [board] }, visitor);

    expect(count).toBe(1);
    expect(snapshots[0]!.objectPath).toBe('ObjectStates[0].ChildObjects[0]');
    expect(snapshots[0]!.guid).toBe('chip1');
    expect(snapshots[0]!.fieldPath).toEqual(['CustomImage', 'ImageURL']);
  });

  it('States 对象映射（实测形状 Record<string, TTSObject>）：状态对象作为新"当前对象"被访问', () => {
    const state = { GUID: 'st-1', Name: 'Custom_Tile', CustomImage: { ImageURL: 'http://state.example.com/s.png' } };
    const obj = { GUID: 'base1', Name: 'Custom_Token', States: { 'alt-guid-1': state } };
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls({ ObjectStates: [obj] }, visitor);

    expect(count).toBe(1);
    expect(snapshots[0]!.objectPath).toBe('ObjectStates[0].States.alt-guid-1');
    expect(snapshots[0]!.guid).toBe('st-1'); // 状态对象自己的 GUID
    expect(snapshots[0]!.name).toBe('Custom_Tile');
    expect(snapshots[0]!.fieldPath).toEqual(['CustomImage', 'ImageURL']);
  });

  it('States 为数组时宽容支持（形状防御）：照常下钻，路径用下标', () => {
    const stateA = { GUID: 'stA', Name: 'Custom_Tile', CustomImage: { ImageURL: 'http://a.example.com/s.png' } };
    const obj = { GUID: 'base1', Name: 'Custom_Token', States: [stateA] };
    const { visitor, snapshots } = recorder();

    expect(walkSaveUrls({ ObjectStates: [obj] }, visitor)).toBe(1);
    expect(snapshots[0]!.objectPath).toBe('ObjectStates[0].States[0]');
    expect(snapshots[0]!.guid).toBe('stA');
  });

  it('AttachedDecals：贴花容器（实测最易漏）下钻到元素的 CustomDecal.ImageURL', () => {
    const decal = { CustomDecal: { ImageURL: 'http://decal.example.com/x.png' } };
    const obj = { GUID: 'board1', Name: 'Custom_Board', AttachedDecals: [decal] };
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls({ ObjectStates: [obj] }, visitor);

    expect(count).toBe(1);
    expect(snapshots[0]!.objectPath).toBe('ObjectStates[0].AttachedDecals[0]');
    expect(snapshots[0]!.guid).toBe(''); // 贴花元素无 GUID → 视为无
    expect(snapshots[0]!.name).toBeUndefined();
    expect(snapshots[0]!.fieldPath).toEqual(['CustomDecal', 'ImageURL']);
  });

  it('深度混合：States 里的状态对象再带 ContainedObjects，多容器嵌套全部覆盖', () => {
    const inner = { GUID: 'inner1', Name: 'Card', CustomDeck: { '1': { FaceURL: FACE, BackURL: BACK } } };
    const state = { GUID: 'st-1', Name: 'Deck', ContainedObjects: [inner] };
    const obj = { GUID: 'bag1', Name: 'Bag', States: { 'alt': state } };
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls({ ObjectStates: [obj] }, visitor);

    expect(count).toBe(2);
    expect(locKeys(snapshots)).toEqual([
      'ObjectStates[0].States.alt.ContainedObjects[0]#CustomDeck.FaceURL',
      'ObjectStates[0].States.alt.ContainedObjects[0]#CustomDeck.BackURL',
    ]);
    expect(snapshots[0]!.guid).toBe('inner1');
  });
});

// ---------------------------------------------------------------------------
// {lang} 跳过（坑 5）
// ---------------------------------------------------------------------------

describe('{lang} 跳过（坑 5）', () => {
  const LANG_VALUE = '{en}http://en.example.com/f.png{zh-cn}http://zh.example.com/f.png';

  it('默认跳过：{lang} 值不访问、不计数，字段原样保留', () => {
    const spec = { FaceURL: LANG_VALUE, BackURL: BACK };
    const root = { ObjectStates: [{ GUID: 'd', Name: 'Deck', CustomDeck: { '1': spec } }] };
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls(root, visitor);

    expect(count).toBe(1); // 只有 BackURL
    expect(locKeys(snapshots)).toEqual(['ObjectStates[0]#CustomDeck.BackURL']);
    expect(spec.FaceURL).toBe(LANG_VALUE); // 原样保留
  });

  it('skipLangVariants=false：照常访问、计入返回值，visitor 返回值写回', () => {
    const spec = { FaceURL: LANG_VALUE, BackURL: BACK };
    const root = { ObjectStates: [{ GUID: 'd', Name: 'Deck', CustomDeck: { '1': spec } }] };

    const count = walkSaveUrls(root, (loc) => {
      if (loc.hostKey === 'FaceURL') {
        return 'http://fixed.example.com/f.png';
      }
    }, { skipLangVariants: false });

    expect(count).toBe(2);
    expect(spec.FaceURL).toBe('http://fixed.example.com/f.png');
    expect(spec.BackURL).toBe(BACK);
  });

  it('{lang} 与普通 URL 混合：只访问普通 URL，{lang} 字段即使在改写型 visitor 下也不动', () => {
    const spec = { FaceURL: LANG_VALUE, BackURL: BACK };
    const tile = { GUID: 't1', Name: 'Custom_Tile', CustomImage: { ImageURL: 'http://tile.example.com/t.png' } };
    const deck = { GUID: 'd', Name: 'Deck', CustomDeck: { '1': spec }, ContainedObjects: [tile] };
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls({ ObjectStates: [deck] }, (loc) => {
      visitor(loc);
      return 'http://rewritten.example.com/all.png'; // 无差别改写
    });

    expect(count).toBe(2); // FaceURL({lang}) 被跳过
    expect(snapshots.map((s) => s.fieldPath.join('.'))).toEqual(['CustomDeck.BackURL', 'CustomImage.ImageURL']);
    expect(spec.FaceURL).toBe(LANG_VALUE); // 无差别改写也碰不到 {lang} 字段
    expect(spec.BackURL).toBe('http://rewritten.example.com/all.png');
  });
});

// ---------------------------------------------------------------------------
// autoFixProtocol：缺协议补 https://（只改 currentValue，写回由调用方决定）
// ---------------------------------------------------------------------------

describe('autoFixProtocol', () => {
  const WWW_URL = 'www.example.com/tile.png';

  function wwwRoot(): Record<string, unknown> {
    return { ObjectStates: [{ GUID: 't', Name: 'Custom_Tile', CustomImage: { ImageURL: WWW_URL } }] };
  }

  it('默认 false：currentValue 原样', () => {
    let seen = '';
    walkSaveUrls(wwwRoot(), (loc) => {
      seen = loc.currentValue;
    });
    expect(seen).toBe(WWW_URL);
  });

  it('true：visitor 看到补全后的 currentValue，但 visitor 返回 void 时字段不变', () => {
    const root = wwwRoot();
    let seen = '';
    walkSaveUrls(root, (loc) => {
      seen = loc.currentValue;
    }, { autoFixProtocol: true });

    expect(seen).toBe('https://www.example.com/tile.png');
    const image = ((root.ObjectStates as Record<string, unknown>[])[0]!.CustomImage) as Record<string, unknown>;
    expect(image.ImageURL).toBe(WWW_URL); // 未写回
  });

  it('true + visitor 返回新值：写回补全后的值', () => {
    const root = wwwRoot();
    walkSaveUrls(root, (loc) => loc.currentValue, { autoFixProtocol: true });
    const image = ((root.ObjectStates as Record<string, unknown>[])[0]!.CustomImage) as Record<string, unknown>;
    expect(image.ImageURL).toBe('https://www.example.com/tile.png');
  });
});

// ---------------------------------------------------------------------------
// onLocalFile：file: 本地路径回调
// ---------------------------------------------------------------------------

describe('onLocalFile', () => {
  it('file: 路径触发 onLocalFile，且仍被 visitor 访问（"让 visitor 决定"）', () => {
    const root = {
      ObjectStates: [
        { GUID: 'a', Name: 'Custom_Tile', CustomImage: { ImageURL: 'file:///D:/pics/tile.png' } },
        { GUID: 'b', Name: 'Custom_Tile', CustomImage: { ImageURL: 'http://example.com/tile.png' } },
      ],
    };
    const onLocal = vi.fn();
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls(root, visitor, { onLocalFile: onLocal });

    expect(count).toBe(2); // file: 仍计数、仍访问
    expect(onLocal).toHaveBeenCalledTimes(1);
    expect(onLocal.mock.calls[0]![0].currentValue).toBe('file:///D:/pics/tile.png');
    expect(onLocal.mock.calls[0]![0].guid).toBe('a');
    expect(snapshots.map((s) => s.guid)).toEqual(['a', 'b']); // visitor 两次都收到
  });

  it('http URL 不触发 onLocalFile；未提供 onLocalFile 时 file: 也照常访问不抛错', () => {
    const httpRoot = {
      ObjectStates: [{ GUID: 'b', Name: 'Custom_Tile', CustomImage: { ImageURL: 'http://example.com/t.png' } }],
    };
    const onLocal = vi.fn();
    expect(walkSaveUrls(httpRoot, () => {}, { onLocalFile: onLocal })).toBe(1);
    expect(onLocal).not.toHaveBeenCalled();

    const fileRoot = {
      ObjectStates: [{ GUID: 'a', Name: 'Custom_Tile', CustomImage: { ImageURL: 'file:///D:/x.png' } }],
    };
    expect(walkSaveUrls(fileRoot, () => {})).toBe(1); // 无回调，不抛错
  });
});

// ---------------------------------------------------------------------------
// 原地修改与零拷贝（约束 8 的遍历侧前提）
// ---------------------------------------------------------------------------

describe('原地修改与零拷贝', () => {
  it('visitor 返回新值：host[hostKey] 原地写回，root 引用链上直接可见', () => {
    const { root, deckSpec } = deckFixture();
    const NEW = 'http://new.example.com/face.png';

    const count = walkSaveUrls(root, (loc) => {
      if (loc.hostKey === 'FaceURL') {
        return NEW;
      }
    });

    expect(count).toBe(2);
    expect(deckSpec.FaceURL).toBe(NEW);
    expect(deckSpec.BackURL).toBe(BACK);
    expect(((root.ObjectStates as Record<string, unknown>[])[0]!.CustomDeck as Record<string, unknown>)['1']!)
      .toBe(deckSpec); // root 上的对象没有被替换成副本
  });

  it('visitor 返回 void：字段不变（纯遍历）', () => {
    const { deckSpec } = deckFixture();
    walkSaveUrls({ ObjectStates: [{ CustomDeck: { '1': deckSpec } }] }, () => {});
    expect(deckSpec.FaceURL).toBe(FACE);
    expect(deckSpec.BackURL).toBe(BACK);
  });

  it('host 是原对象引用而非副本：CustomImage loc.host === 存档里的同一个对象', () => {
    const customImage = { ImageURL: FACE };
    const root = { ObjectStates: [{ CustomImage: customImage }] };
    walkSaveUrls(root, () => {});
    // recorder 的快照保留 host 引用——这里直接构造再比对
    let hostRef: unknown;
    walkSaveUrls(root, (loc) => {
      hostRef = loc.host;
    });
    expect(hostRef).toBe(customImage);
  });

  it('层面一整体改写：牌堆 + 3 张 Card 复制的 CustomDeck 的 FaceURL 全部写回新值', () => {
    const NEW_FACE = 'http://new.example.com/atlas/face.png';
    const OLD_BACK = 'http://old.example.com/atlas/back.png';
    const makeSpec = () => ({ FaceURL: 'http://old.example.com/atlas/face.png', BackURL: OLD_BACK });
    const deckSpec = makeSpec();
    const cardSpecs = [makeSpec(), makeSpec(), makeSpec()];
    const deck = {
      GUID: 'deck00',
      Name: 'Deck',
      CustomDeck: { '1': deckSpec },
      ContainedObjects: cardSpecs.map((spec, i) => ({ GUID: `card0${i}`, Name: 'Card', CustomDeck: { '1': spec } })),
    };

    const count = walkSaveUrls({ ObjectStates: [deck] }, (loc) => {
      if (loc.hostKey === 'FaceURL') {
        return NEW_FACE;
      }
    });

    expect(count).toBe(8);
    expect(deckSpec.FaceURL).toBe(NEW_FACE);
    expect(deckSpec.BackURL).toBe(OLD_BACK);
    for (const spec of cardSpecs) {
      expect(spec.FaceURL).toBe(NEW_FACE);
      expect(spec.BackURL).toBe(OLD_BACK);
    }
  });
});

// ---------------------------------------------------------------------------
// 路径格式
// ---------------------------------------------------------------------------

describe('路径格式', () => {
  it('契约样例路径原文比对："ObjectStates[3].ContainedObjects[5]"', () => {
    const contained = [0, 1, 2, 3, 4].map((i) => ({ GUID: `pad${i}`, Name: 'Card' }));
    contained.push({ GUID: 'target', Name: 'Custom_Tile', CustomImage: { ImageURL: FACE } });
    const root = {
      ObjectStates: [{ Name: 'x' }, { Name: 'x' }, { Name: 'x' }, { ContainedObjects: contained }],
    };
    const { visitor, snapshots } = recorder();

    expect(walkSaveUrls(root, visitor)).toBe(1);
    expect(snapshots[0]!.objectPath).toBe('ObjectStates[3].ContainedObjects[5]');
  });

  it('8 层嵌套（实测上限）正确下钻，路径逐级拼接', () => {
    let node: Record<string, unknown> = { Name: 'L8', CustomImage: { ImageURL: 'http://deep.example.com/x.png' } };
    for (let i = 7; i >= 1; i--) {
      node = { Name: `L${i}`, ContainedObjects: [node] };
    }
    const { visitor, snapshots } = recorder();

    expect(walkSaveUrls({ ObjectStates: [node] }, visitor)).toBe(1);

    const expectedPath = 'ObjectStates[0]' + '.ContainedObjects[0]'.repeat(7);
    expect(snapshots[0]!.objectPath).toBe(expectedPath);
    expect(snapshots[0]!.name).toBe('L8');
  });
});

// ---------------------------------------------------------------------------
// 边界与防御
// ---------------------------------------------------------------------------

describe('边界与防御', () => {
  it('空 ObjectStates：返回 0', () => {
    expect(walkSaveUrls({ ObjectStates: [] }, () => {})).toBe(0);
  });

  it('根无 ObjectStates：只有根自身直接字段被访问', () => {
    const root = { TableURL: 'http://table.example.com/t.jpg', SaveName: 'demo' };
    const { visitor, snapshots } = recorder();

    expect(walkSaveUrls(root, visitor)).toBe(1);
    expect(snapshots[0]!.fieldPath).toEqual(['TableURL']);
  });

  it('根不是普通对象（null / 字符串 / 数组 / 数字）：返回 0，不抛错', () => {
    const visitor = (): void => {};
    expect(walkSaveUrls(null, visitor)).toBe(0);
    expect(walkSaveUrls('http://x.png', visitor)).toBe(0);
    expect(walkSaveUrls([{ CustomImage: { ImageURL: FACE } }], visitor)).toBe(0);
    expect(walkSaveUrls(42, visitor)).toBe(0);
  });

  it('GUID 空串 / 缺失 / 非字符串：loc.guid 一律为空串（工坊允许空 GUID，B2 约定）', () => {
    const mk = (guid: unknown): Record<string, unknown> => {
      const obj: Record<string, unknown> = { Name: 'Custom_Tile', CustomImage: { ImageURL: FACE } };
      if (guid !== undefined) {
        obj.GUID = guid;
      }
      return obj;
    };
    for (const guid of ['', undefined, 123, null]) {
      const { visitor, snapshots } = recorder();
      const obj = mk(guid);
      walkSaveUrls({ ObjectStates: [obj] }, visitor);
      expect(snapshots[0]!.guid, `GUID=${String(guid)}`).toBe('');
    }
  });

  it('Name 缺失 → loc.name 不存在；Name 为空串 → 原样保留空串', () => {
    const noName = { GUID: 'g1', CustomImage: { ImageURL: FACE } };
    const { visitor, snapshots } = recorder();
    walkSaveUrls({ ObjectStates: [noName] }, visitor);
    expect(snapshots[0]!.name).toBeUndefined();

    const emptyName = { GUID: 'g2', Name: '', CustomImage: { ImageURL: FACE } };
    const { visitor: v2, snapshots: s2 } = recorder();
    walkSaveUrls({ ObjectStates: [emptyName] }, v2);
    expect(s2[0]!.name).toBe('');
  });

  it('URL 值边界：空串跳过、非字符串跳过、空白字符串仍访问（"非空"严格指 !== ""）', () => {
    const spec = { FaceURL: '', BackURL: BACK };
    const numeric = { Name: 'x', CustomImage: { ImageURL: 123 } };
    const blank = { Name: 'y', CustomMesh: { DiffuseURL: '   ' } };
    const root = {
      ObjectStates: [{ GUID: 'd', Name: 'Deck', CustomDeck: { '1': spec } }, numeric, blank],
    };
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls(root, visitor);

    expect(count).toBe(2); // BackURL（FaceURL 空串跳过）+ 空白 DiffuseURL（ImageURL 非字符串跳过）
    expect(locKeys(snapshots)).toEqual([
      'ObjectStates[0]#CustomDeck.BackURL',
      'ObjectStates[2]#CustomMesh.DiffuseURL',
    ]);
    expect(snapshots[1]!.currentValue).toBe('   ');
  });

  it('CustomDeck 畸形：容器为标量 / 数组 / 规格非对象时跳过，不抛错', () => {
    const visitor = (): void => {};
    expect(walkSaveUrls({ ObjectStates: [{ CustomDeck: 'http://not-an-object' }] }, visitor)).toBe(0);
    expect(walkSaveUrls({ ObjectStates: [{ CustomDeck: [{ FaceURL: FACE }] }] }, visitor)).toBe(0);
    expect(walkSaveUrls({ ObjectStates: [{ CustomDeck: { '1': 'http://scalar-spec' } }] }, visitor)).toBe(0);
    expect(walkSaveUrls({ ObjectStates: [{ CustomDeck: null }] }, visitor)).toBe(0);
  });

  it('容器键值畸形：标量 / 数字 / 布尔时跳过，不抛错', () => {
    const visitor = (): void => {};
    expect(walkSaveUrls({ ObjectStates: [{ ContainedObjects: 'nope' }] }, visitor)).toBe(0);
    expect(walkSaveUrls({ ObjectStates: [{ States: 42 }] }, visitor)).toBe(0);
    expect(walkSaveUrls({ ObjectStates: [{ AttachedDecals: true }] }, visitor)).toBe(0);
    expect(walkSaveUrls({ ObjectStates: [{ ChildObjects: null }] }, visitor)).toBe(0);
  });

  it('ObjectStates 元素含 null / 标量：跳过非对象元素，只访问合法对象', () => {
    const root = { ObjectStates: [null, 'str', 42, { GUID: 'ok', CustomImage: { ImageURL: FACE } }] };
    const { visitor, snapshots } = recorder();

    expect(walkSaveUrls(root, visitor)).toBe(1);
    expect(snapshots[0]!.guid).toBe('ok');
  });

  it('非容器键的嵌套对象（如 SaveState）不下钻：字段清单是封闭契约', () => {
    const root = {
      SaveState: { CustomImage: { ImageURL: 'http://inside-savestate.example.com/x.png' } },
      TableURL: 'http://table.example.com/t.jpg',
    };
    const { visitor, snapshots } = recorder();

    expect(walkSaveUrls(root, visitor)).toBe(1);
    expect(snapshots[0]!.fieldPath).toEqual(['TableURL']);
  });
});

// ---------------------------------------------------------------------------
// 访问顺序与计数
// ---------------------------------------------------------------------------

describe('访问顺序与计数', () => {
  it('固定访问顺序：直接字段 → 素材容器 → 容器键下钻（与对象键序无关）', () => {
    const root = {
      ObjectStates: [
        {
          ContainedObjects: [{ GUID: 'p1', Name: 'Custom_PDF', CustomPDF: { PDFUrl: 'http://pdf.example.com/x.pdf' } }],
          SkyURLDummy: 'ignored-key-not-in-contract',
          CustomImage: { ImageSecondaryURL: 'http://img.example.com/b.png', ImageURL: 'http://img.example.com/a.png' },
        },
      ],
      TableURL: 'http://table.example.com/t.jpg',
      SkyURL: 'http://sky.example.com/s.jpg',
    };
    const { visitor, snapshots } = recorder();

    const count = walkSaveUrls(root, visitor);

    expect(count).toBe(5);
    expect(locKeys(snapshots)).toEqual([
      '#SkyURL', // 根直接字段
      '#TableURL',
      'ObjectStates[0]#CustomImage.ImageURL', // 素材容器（固定次序，不随键序翻转）
      'ObjectStates[0]#CustomImage.ImageSecondaryURL',
      'ObjectStates[0].ContainedObjects[0]#CustomPDF.PDFUrl', // 容器键最后下钻
    ]);
  });

  it('返回值 === visitor 实际收到 loc 的次数', () => {
    const { root, deck } = deckFixture();
    (deck as Record<string, unknown>).ContainedObjects = [
      { GUID: 'c1', Name: 'Card', CustomDeck: { '1': { FaceURL: FACE, BackURL: BACK } } },
    ];
    let calls = 0;
    const count = walkSaveUrls(root, () => {
      calls++;
    });
    expect(count).toBe(calls);
    expect(count).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 性能基准（方案设计 §2.6.6：37,492 对象 / 116MB）
// ---------------------------------------------------------------------------

describe('性能基准', () => {
  /**
   * 构造 37,492 个存档对象：3,749 个牌堆 ×（1 牌堆 + 9 卡）+ 2 贴图。
   * 每个牌堆与卡都带 CustomDeck 复制（层面一最坏情况），共 74,982 个 URL 字段。
   */
  function buildBigSave(): { root: Record<string, unknown>; expectedUrls: number } {
    const objectStates: Record<string, unknown>[] = [];
    for (let d = 0; d < 3749; d++) {
      const faceUrl = `http://example.com/sheet-${d}/face.png`;
      const backUrl = `http://example.com/sheet-${d}/back.png`;
      const cards: Record<string, unknown>[] = [];
      for (let c = 0; c < 9; c++) {
        cards.push({
          GUID: `card-${d}-${c}`,
          Name: 'Card',
          CardID: d * 100 + c + 1, // 1 基 slot
          CustomDeck: { '1': { FaceURL: faceUrl, BackURL: backUrl, NumWidth: 10, NumHeight: 7 } },
        });
      }
      objectStates.push({
        GUID: `deck-${d}`,
        Name: 'Deck',
        CustomDeck: { '1': { FaceURL: faceUrl, BackURL: backUrl, NumWidth: 10, NumHeight: 7 } },
        ContainedObjects: cards,
      });
    }
    objectStates.push({ GUID: 'tile-1', Name: 'Custom_Tile', CustomImage: { ImageURL: 'http://example.com/t1.png' } });
    objectStates.push({ GUID: 'tile-2', Name: 'Custom_Tile', CustomImage: { ImageURL: 'http://example.com/t2.png' } });
    // 74,982 = 3,749×2（牌堆） + 3,749×9×2（卡） + 2（贴图）
    return { root: { ObjectStates: objectStates }, expectedUrls: 3749 * 2 + 3749 * 9 * 2 + 2 };
  }

  it('37,492 对象 / 74,982 个 URL 字段在 1 秒内遍历完成（不深拷贝）', () => {
    const { root, expectedUrls } = buildBigSave();

    let visited = 0;
    const started = performance.now();
    const count = walkSaveUrls(root, () => {
      visited++;
    });
    const elapsed = performance.now() - started;

    expect(count).toBe(expectedUrls);
    expect(visited).toBe(expectedUrls);
    expect(elapsed).toBeLessThan(1000);
  });
});
