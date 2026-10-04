// tests/unit/deck-types.test.ts
/**
 * src/deck/types.ts 单元测试：素材类型注册表（开放集合）。
 *
 * 纯内存查表模块（无 IO / 无网络 / 无临时目录）：
 * - 正常路径：ASSET_TYPES 完整 14 类（顺序与冻结）；createRegistry() 预注册
 *   全部内置类型，每种都能 resolve 到已注册处理器（非 defaultHandler，同一
 *   实例）；urlFields 与方案设计 §2.6.2 字段覆盖清单逐字段一致
 *   （pdf 的 PDFUrl 拼写单独防 typo 回归）；displayName 取 §5.9 类型表对象名；
 * - 异常路径：注册表本身不抛错——未知类型按开放集合走 defaultHandler
 *   （原始字符串原样保留、不归一），get() 对未注册类型返回 undefined，
 *   resolve() 不产生任何告警输出（告警由调用方按需触发）；
 * - 边界值：大小写敏感（"Card" ≠ "card"）、空字符串、含空白的类型字符串、
 *   重复注册覆盖前者（含覆盖内置类型）、list() 快照不受后续 register 影响
 *   且返回数组本身不可变更。
 *
 * 编译期类型断言（ExpectTrue / ExpectFalse，见文件底部"编译期类型断言"节）：
 * AssetType 可赋值 ASSET_TYPES 任意成员、任意字符串不可赋值给 AssetType。
 * vitest run 不做类型检查（esbuild 只擦类型），该节由 `npx tsc --noEmit`
 * 或编辑器静态检查把关——契约允许"编译期检查通过即可，不用运行时测"。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ASSET_TYPES,
  createRegistry,
  type AssetType,
  type AssetTypeHandler,
} from '../../src/deck/types.js';

// ---------------------------------------------------------------------------
// ASSET_TYPES 枚举常量
// ---------------------------------------------------------------------------

describe('ASSET_TYPES 枚举常量', () => {
  it('完整枚举 14 种类型，顺序与方案设计 §5.9 类型表一致', () => {
    expect([...ASSET_TYPES]).toEqual([
      'card', 'model', 'assetbundle', 'tile', 'figurine', 'token',
      'board', 'dice', 'notecard', 'text3d', 'pdf', 'pawn', 'counter', 'other',
    ]);
  });

  it('运行时冻结：Object.isFrozen 为真，严格模式（ESM）下 push 抛 TypeError', () => {
    expect(Object.isFrozen(ASSET_TYPES)).toBe(true);
    expect(() => (ASSET_TYPES as unknown as string[]).push('sneaky')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// createRegistry：内置注册
// ---------------------------------------------------------------------------

describe('createRegistry：内置注册', () => {
  it('全部内置类型预注册：get 命中，list 与 ASSET_TYPES 顺序一致', () => {
    const registry = createRegistry();
    for (const type of ASSET_TYPES) {
      expect(registry.get(type), `类型 ${type} 应已内置注册`).toBeDefined();
    }
    expect(registry.list().map((handler) => handler.type)).toEqual([...ASSET_TYPES]);
  });

  it('每个内置类型 resolve 返回已注册处理器本身（非 defaultHandler，同一实例）', () => {
    const registry = createRegistry();
    for (const type of ASSET_TYPES) {
      const resolved = registry.resolve(type);
      // 与 get() 同一实例 ⇒ 不是每次新建的 defaultHandler
      expect(resolved, `类型 ${type} 的 resolve 应命中注册表`).toBe(registry.get(type));
      expect(resolved.type).toBe(type);
    }
  });

  it('urlFields 覆盖清单：card → CustomDeck 正反两面；model → CustomMesh 四件套；assetbundle → 主/次 URL', () => {
    const registry = createRegistry();
    expect(registry.resolve('card').urlFields).toEqual([
      ['CustomDeck', 'FaceURL'],
      ['CustomDeck', 'BackURL'],
    ]);
    expect(registry.resolve('model').urlFields).toEqual([
      ['CustomMesh', 'MeshURL'],
      ['CustomMesh', 'DiffuseURL'],
      ['CustomMesh', 'NormalURL'],
      ['CustomMesh', 'ColliderURL'],
    ]);
    expect(registry.resolve('assetbundle').urlFields).toEqual([
      ['CustomAssetbundle', 'AssetbundleURL'],
      ['CustomAssetbundle', 'AssetbundleSecondaryURL'],
    ]);
  });

  it('urlFields 覆盖清单：tile / figurine / token / board / pawn / counter 共用 CustomImage 主/次图', () => {
    const registry = createRegistry();
    const expected = [
      ['CustomImage', 'ImageURL'],
      ['CustomImage', 'ImageSecondaryURL'],
    ];
    for (const type of ['tile', 'figurine', 'token', 'board', 'pawn', 'counter'] as const) {
      expect(registry.resolve(type).urlFields, `类型 ${type}`).toEqual(expected);
    }
  });

  it('urlFields 覆盖清单：dice 只有 ImageURL；notecard / text3d / other 无 URL 字段', () => {
    const registry = createRegistry();
    expect(registry.resolve('dice').urlFields).toEqual([['CustomImage', 'ImageURL']]);
    expect(registry.resolve('notecard').urlFields).toEqual([]);
    expect(registry.resolve('text3d').urlFields).toEqual([]);
    expect(registry.resolve('other').urlFields).toEqual([]);
  });

  it('pdf 的字段名是 PDFUrl 而不是 PDFURL（TTS 字段实测拼写，防 typo 回归）', () => {
    const registry = createRegistry();
    expect(registry.resolve('pdf').urlFields).toEqual([['CustomPDF', 'PDFUrl']]);
    // 全注册表扫描：任何字段路径都不允许出现大小写敏感的 "PDFURL"
    for (const handler of registry.list()) {
      for (const field of handler.urlFields) {
        expect(field.join('.')).not.toContain('PDFURL');
      }
    }
  });

  it('displayName 取方案设计 §5.9 类型表的存档对象名（诊断输出用）', () => {
    const registry = createRegistry();
    // card 一行在设计文档中对应 CustomDeck / Deck / Card 三种，此处取牌堆对象名 "Deck"
    const expected: Record<AssetType, string> = {
      card: 'Deck',
      model: 'Custom_Model',
      assetbundle: 'Custom_Assetbundle',
      tile: 'Custom_Tile',
      figurine: 'Figurine_Custom',
      token: 'Custom_Token',
      board: 'Custom_Board',
      dice: 'Custom_Dice',
      notecard: 'Notecard',
      text3d: '3DText',
      pdf: 'Custom_PDF',
      pawn: 'PlayerPawn',
      counter: 'Counter',
      other: 'Other',
    };
    for (const type of ASSET_TYPES) {
      expect(registry.resolve(type).displayName, `类型 ${type}`).toBe(expected[type]);
    }
  });

  it('内置处理器深冻结：urlFields 与其路径数组均不可变', () => {
    const registry = createRegistry();
    const handler = registry.resolve('pdf');
    expect(Object.isFrozen(handler)).toBe(true);
    expect(Object.isFrozen(handler.urlFields)).toBe(true);
    const firstField = handler.urlFields[0]!;
    expect(Object.isFrozen(firstField)).toBe(true);
    expect(() => (firstField as unknown as string[]).push('X')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// createRegistry：defaultHandler（开放集合兜底）
// ---------------------------------------------------------------------------

describe('createRegistry：defaultHandler（开放集合兜底）', () => {
  it('未注册类型 resolve 返回 defaultHandler：type / displayName 原样等于传入字符串，urlFields 为空', () => {
    const registry = createRegistry();
    const resolved = registry.resolve('custom_decal');
    expect(registry.get('custom_decal')).toBeUndefined(); // 未注册
    expect(resolved.type).toBe('custom_decal');
    expect(resolved.displayName).toBe('custom_decal');
    expect(resolved.urlFields).toEqual([]);
  });

  it('不做归一：大小写敏感（"Card" 不命中内置 card），空白原样保留', () => {
    const registry = createRegistry();
    expect(registry.get('card')).toBeDefined(); // 内置不受影响

    const upper = registry.resolve('Card');
    expect(registry.get('Card')).toBeUndefined();
    expect(upper.type).toBe('Card');
    expect(upper.displayName).toBe('Card');
    expect(upper.urlFields).toEqual([]);

    const spaced = registry.resolve('  card ');
    expect(spaced.type).toBe('  card ');
    expect(spaced.displayName).toBe('  card ');
  });

  it('空字符串也走 defaultHandler（不抛错）：type / displayName 均为空串', () => {
    const registry = createRegistry();
    const resolved = registry.resolve('');
    expect(resolved.type).toBe('');
    expect(resolved.displayName).toBe('');
    expect(resolved.urlFields).toEqual([]);
  });

  it('resolve 未注册类型不告警（重复 resolve 也不告警——告警由调用方按需触发）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const registry = createRegistry();
      registry.resolve('mystery_type');
      registry.resolve('mystery_type');
      registry.resolve('another_mystery');
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// createRegistry：register 注册行为
// ---------------------------------------------------------------------------

describe('createRegistry：register 注册行为', () => {
  it('注册新类型后 get / resolve 命中同一处理器，list 在尾部追加（内置顺序不变）', () => {
    const registry = createRegistry();
    const custom: AssetTypeHandler = {
      type: 'custom_decal',
      urlFields: [['AttachedDecals', 'CustomDecal', 'ImageURL']],
      displayName: 'CustomDecal',
    };
    registry.register(custom);

    expect(registry.get('custom_decal')).toBe(custom);
    expect(registry.resolve('custom_decal')).toBe(custom);

    const types = registry.list().map((handler) => handler.type);
    expect(types).toHaveLength(ASSET_TYPES.length + 1);
    expect(types.slice(0, ASSET_TYPES.length)).toEqual([...ASSET_TYPES]);
    expect(types[types.length - 1]).toBe('custom_decal');
  });

  it('重复注册同一 type 覆盖前者（list 中该类型只出现一次）', () => {
    const registry = createRegistry();
    const first: AssetTypeHandler = { type: 'token', urlFields: [], displayName: '第一版' };
    const second: AssetTypeHandler = {
      type: 'token',
      urlFields: [['CustomImage', 'ImageURL']],
      displayName: '第二版',
    };
    registry.register(first);
    registry.register(second);

    expect(registry.get('token')).toBe(second);
    expect(registry.resolve('token')).toBe(second);
    const tokens = registry.list().filter((handler) => handler.type === 'token');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toBe(second);
  });

  it('覆盖内置类型同样生效（开放集合允许替换内置处理器），其他内置类型不受影响', () => {
    const registry = createRegistry();
    const patched: AssetTypeHandler = {
      type: 'card',
      urlFields: [['CustomDeck', 'FaceURL']],
      displayName: 'DeckCustom',
    };
    registry.register(patched);

    expect(registry.resolve('card')).toBe(patched);
    expect(registry.resolve('dice').urlFields).toEqual([['CustomImage', 'ImageURL']]);
  });

  it('list() 返回快照：返回数组冻结不可变更，后续 register 不影响先前取得的快照', () => {
    const registry = createRegistry();
    const snapshot = registry.list();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() =>
      (snapshot as unknown as AssetTypeHandler[]).push({ type: 'x', urlFields: [], displayName: 'x' }),
    ).toThrow(TypeError);

    registry.register({ type: 'late_type', urlFields: [], displayName: 'late' });
    expect(snapshot.map((handler) => handler.type)).not.toContain('late_type');
    expect(registry.list().map((handler) => handler.type)).toContain('late_type');
  });
});

// ---------------------------------------------------------------------------
// 编译期类型断言（无运行时行为；由 npx tsc --noEmit / 编辑器静态检查把关）
// ---------------------------------------------------------------------------

type ExpectTrue<T extends true> = T;
type ExpectFalse<T extends false> = T;
// 元组包裹阻止分布式条件类型（裸类型参数会对联合逐成员求值，得到 boolean 而非 true/false）
type Extends<A, B> = [A] extends [B] ? true : false;

// AssetType 可赋值：ASSET_TYPES 的任意成员都是合法 AssetType
type _MemberCard = ExpectTrue<Extends<'card', AssetType>>;
type _MemberPdf = ExpectTrue<Extends<'pdf', AssetType>>;
type _MemberOther = ExpectTrue<Extends<'other', AssetType>>;
// 联合自身互赋成立；AssetType ⊂ string 方向成立
type _SelfAssignable = ExpectTrue<Extends<AssetType, AssetType>>;
type _SubsetOfString = ExpectTrue<Extends<AssetType, string>>;
// 任意字符串不可赋值给 AssetType（契约点名 "unknown_type"；联合也不是单一成员）
type _StringNotAssignable = ExpectFalse<Extends<string, AssetType>>;
type _UnknownTypeNotAssignable = ExpectFalse<Extends<'unknown_type', AssetType>>;
type _UnionNotSingleMember = ExpectFalse<Extends<AssetType, 'card'>>;

export {};
