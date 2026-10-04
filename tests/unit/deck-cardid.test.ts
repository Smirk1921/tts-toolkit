// tests/unit/deck-cardid.test.ts
/**
 * src/deck/cardid.ts 单元测试：CardID 编号规则与 1 基 slot 换算。
 *
 * 纯算术模块（无 IO / 无网络 / 无临时目录）：
 * - 正常路径：契约示例（DeckIDs [10121, 10122] → key "101"、格子 21/22）、
 *   实测实例（9606/9903/176710）、slotToCardId → cardIdToKey / cardIdToSlot 往返、
 *   slotToGrid / gridToSlot 互逆（10 列 1..70 与 5×5 全量）；
 * - 1 基 vs 0 基显式覆盖：slot=1 → (0,0)、slot=columns → (columns-1, 0)、
 *   slot=columns+1 → (0, 1)；gridToSlot(0,0,10)===1、gridToSlot(9,6,10)===70；
 * - 主窗口裁决守卫（2026-10-04）：isValidCardId 正整数即合法——100 / 10000 / 10100
 *   都合法且 slot 均换算为 100，专设用例防未来把 %100===0 误判为 slot=0 而拒绝；
 * - 边界值：slot=1、slot=70（10×7 上限）、slot=columns×rows、key "0"（CardID 1..99）、
 *   slot=100 的编码回绕（slotToCardId("101",100)===10200，key 读回 +1，编码固有性质）；
 * - 异常路径：转换函数对非法入参抛普通中文 Error（文案写死在模块内、不走 t()，
 *   可直接断言正则）；校验函数永不抛错、非法入参一律 false。
 */
import { describe, expect, it } from 'vitest';

import {
  cardIdToKey,
  cardIdToSlot,
  gridToSlot,
  isValidCardId,
  isValidSlot,
  slotToCardId,
  slotToGrid,
} from '../../src/deck/cardid.js';

// ---------------------------------------------------------------------------
// cardIdToKey
// ---------------------------------------------------------------------------

describe('cardIdToKey', () => {
  it('契约实例：10121 → 字符串 "101"（不是数字 101）', () => {
    const key = cardIdToKey(10121);
    expect(key).toBe('101');
    expect(typeof key).toBe('string');
  });

  it('实测实例：9606 → "96"、9903 → "99"、176710 → "1767"（CardID 可达 17 万，key 不可假设从 1 开始）', () => {
    expect(cardIdToKey(9606)).toBe('96');
    expect(cardIdToKey(9903)).toBe('99');
    expect(cardIdToKey(176710)).toBe('1767');
  });

  it('小 CardID：21 → "0"、100 → "1"（key "0" 合法：CardID 1..99 落在 key "0"）', () => {
    expect(cardIdToKey(21)).toBe('0');
    expect(cardIdToKey(100)).toBe('1');
  });

  it('异常：0 / 负数 / 小数 / NaN 抛中文 Error', () => {
    expect(() => cardIdToKey(0)).toThrow(/正整数/);
    expect(() => cardIdToKey(-10121)).toThrow(/正整数/);
    expect(() => cardIdToKey(10100.5)).toThrow(/正整数/);
    expect(() => cardIdToKey(Number.NaN)).toThrow(/正整数/);
  });
});

// ---------------------------------------------------------------------------
// cardIdToSlot
// ---------------------------------------------------------------------------

describe('cardIdToSlot', () => {
  it('契约实例：10121 → 21、10122 → 22（1 基，行优先）', () => {
    expect(cardIdToSlot(10121)).toBe(21);
    expect(cardIdToSlot(10122)).toBe(22);
  });

  it('%100===0 映射为 100（不是 0）：10100 / 10000 / 100 均为 slot 100', () => {
    expect(cardIdToSlot(10100)).toBe(100);
    expect(cardIdToSlot(10000)).toBe(100);
    expect(cardIdToSlot(100)).toBe(100);
  });

  it('裁决守卫（主窗口 2026-10-04）：10000 合法且 key "100" / slot 100——防未来误判 slot=0 拒绝之', () => {
    expect(isValidCardId(10000)).toBe(true);
    expect(cardIdToKey(10000)).toBe('100');
    expect(cardIdToSlot(10000)).toBe(100);
  });

  it('异常：0 / 负数 / 小数 / Infinity 抛中文 Error', () => {
    expect(() => cardIdToSlot(0)).toThrow(/正整数/);
    expect(() => cardIdToSlot(-1)).toThrow(/正整数/);
    expect(() => cardIdToSlot(10100.5)).toThrow(/正整数/);
    expect(() => cardIdToSlot(Infinity)).toThrow(/正整数/);
  });
});

// ---------------------------------------------------------------------------
// slotToCardId
// ---------------------------------------------------------------------------

describe('slotToCardId', () => {
  it('契约示例：("101", 21) → 10121；数字 key 也接受：(101, 21) → 10121', () => {
    expect(slotToCardId('101', 21)).toBe(10121);
    expect(slotToCardId(101, 21)).toBe(10121);
  });

  it('往返一致：slot 1..99 × key ["1", "96", "101", "1767"] 全量还原 key 与 slot', () => {
    const keys = ['1', '96', '101', '1767'];
    for (const key of keys) {
      for (let slot1based = 1; slot1based <= 99; slot1based++) {
        const cardId = slotToCardId(key, slot1based);
        expect(cardIdToKey(cardId)).toBe(key);
        expect(cardIdToSlot(cardId)).toBe(slot1based);
      }
    }
  });

  it('key "0" 合法：("0", 21) → 21，与 isValidCardId(21)=true 的裁决自洽', () => {
    expect(slotToCardId('0', 21)).toBe(21);
    expect(slotToCardId(0, 21)).toBe(21);
  });

  it('key 归一："007" 经 Number 归一为 "7"（与 cardIdToKey 输出形式一致）', () => {
    expect(slotToCardId('007', 21)).toBe(721);
    expect(cardIdToKey(slotToCardId('007', 21))).toBe('7');
  });

  it('slot=100 编码回绕（编码固有性质，非 bug）：("101", 100) → 10200，key 读回为 "102"', () => {
    expect(slotToCardId('101', 100)).toBe(10200);
    expect(cardIdToSlot(10200)).toBe(100);
    expect(cardIdToKey(10200)).toBe('102');
  });

  it('异常：slot 0 / -1 / 0.5 / 101 越界抛中文 Error', () => {
    expect(() => slotToCardId('101', 0)).toThrow(/slot/);
    expect(() => slotToCardId('101', -1)).toThrow(/slot/);
    expect(() => slotToCardId('101', 0.5)).toThrow(/slot/);
    expect(() => slotToCardId('101', 101)).toThrow(/slot/);
  });

  it('异常：key 非法（"abc" / "" / "-1" / "10.5" / -3 / 1.5）抛中文 Error', () => {
    expect(() => slotToCardId('abc', 21)).toThrow(/key/);
    expect(() => slotToCardId('', 21)).toThrow(/key/);
    expect(() => slotToCardId('-1', 21)).toThrow(/key/);
    expect(() => slotToCardId('10.5', 21)).toThrow(/key/);
    expect(() => slotToCardId(-3, 21)).toThrow(/key/);
    expect(() => slotToCardId(1.5, 21)).toThrow(/key/);
  });
});

// ---------------------------------------------------------------------------
// slotToGrid / gridToSlot
// ---------------------------------------------------------------------------

describe('slotToGrid / gridToSlot：1 基 slot ↔ 0 基格点', () => {
  it('1 基 vs 0 基显式覆盖：slot=1 → (0,0)；slot=columns → (columns-1, 0)；slot=columns+1 → (0, 1)', () => {
    expect(slotToGrid(1, 10)).toEqual({ col: 0, row: 0 });
    expect(slotToGrid(10, 10)).toEqual({ col: 9, row: 0 });
    expect(slotToGrid(11, 10)).toEqual({ col: 0, row: 1 });
  });

  it('契约示例：slotToGrid(70, 10) → (9, 6)；gridToSlot(0, 0, 10) === 1；gridToSlot(9, 6, 10) === 70', () => {
    expect(slotToGrid(70, 10)).toEqual({ col: 9, row: 6 });
    expect(gridToSlot(0, 0, 10)).toBe(1);
    expect(gridToSlot(9, 6, 10)).toBe(70);
  });

  it('非 10 列网格：5 列 slot=25 → (4, 4)；1 列 slot=3 → (0, 2)', () => {
    expect(slotToGrid(25, 5)).toEqual({ col: 4, row: 4 });
    expect(slotToGrid(3, 1)).toEqual({ col: 0, row: 2 });
    expect(gridToSlot(4, 4, 5)).toBe(25);
    expect(gridToSlot(0, 2, 1)).toBe(3);
  });

  it('互逆：10 列 slot 1..70 与 5×5 全量往返', () => {
    for (let slot1based = 1; slot1based <= 70; slot1based++) {
      const { col: col0based, row: row0based } = slotToGrid(slot1based, 10);
      expect(gridToSlot(col0based, row0based, 10)).toBe(slot1based);
    }
    for (let slot1based = 1; slot1based <= 25; slot1based++) {
      const { col: col0based, row: row0based } = slotToGrid(slot1based, 5);
      expect(gridToSlot(col0based, row0based, 5)).toBe(slot1based);
    }
  });

  it('异常：slotToGrid 对 slot 0 / 负数 / 小数、columns 0 抛中文 Error', () => {
    expect(() => slotToGrid(0, 10)).toThrow(/slot/);
    expect(() => slotToGrid(-5, 10)).toThrow(/slot/);
    expect(() => slotToGrid(1.5, 10)).toThrow(/slot/);
    expect(() => slotToGrid(1, 0)).toThrow(/columns/);
  });

  it('异常：gridToSlot 对 col / row 负数、columns 0 抛中文 Error', () => {
    expect(() => gridToSlot(-1, 0, 10)).toThrow(/col/);
    expect(() => gridToSlot(0, -1, 10)).toThrow(/row/);
    expect(() => gridToSlot(0, 0, 0)).toThrow(/columns/);
  });
});

// ---------------------------------------------------------------------------
// isValidCardId
// ---------------------------------------------------------------------------

describe('isValidCardId', () => {
  it('合法：正整数（含 100 的整数倍——100 / 10000 / 10100 均 true）', () => {
    expect(isValidCardId(1)).toBe(true);
    expect(isValidCardId(21)).toBe(true);
    expect(isValidCardId(100)).toBe(true);
    expect(isValidCardId(10000)).toBe(true);
    expect(isValidCardId(10100)).toBe(true);
    expect(isValidCardId(10121)).toBe(true);
    expect(isValidCardId(176710)).toBe(true);
  });

  it('非法：0 / 负数 / 小数 / NaN / ±Infinity 一律 false', () => {
    expect(isValidCardId(0)).toBe(false);
    expect(isValidCardId(-1)).toBe(false);
    expect(isValidCardId(-10121)).toBe(false);
    expect(isValidCardId(10100.5)).toBe(false);
    expect(isValidCardId(0.5)).toBe(false);
    expect(isValidCardId(Number.NaN)).toBe(false);
    expect(isValidCardId(Infinity)).toBe(false);
    expect(isValidCardId(-Infinity)).toBe(false);
  });

  it('永不抛错：非 number 运行时入参（字符串 / null）返回 false 而不是异常', () => {
    expect(isValidCardId('10121' as unknown as number)).toBe(false);
    expect(isValidCardId(null as unknown as number)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidSlot
// ---------------------------------------------------------------------------

describe('isValidSlot', () => {
  it('合法：slot=1（下界）、slot=70（10×7 上界）、5×5 的 25、1×1 的 1', () => {
    expect(isValidSlot(1, 10, 7)).toBe(true);
    expect(isValidSlot(70, 10, 7)).toBe(true);
    expect(isValidSlot(25, 5, 5)).toBe(true);
    expect(isValidSlot(1, 1, 1)).toBe(true);
  });

  it('非法：slot=0 / -1 / 71（10×7 时越界）/ 0.5 / NaN 一律 false', () => {
    expect(isValidSlot(0, 10, 7)).toBe(false);
    expect(isValidSlot(-1, 10, 7)).toBe(false);
    expect(isValidSlot(71, 10, 7)).toBe(false);
    expect(isValidSlot(0.5, 10, 7)).toBe(false);
    expect(isValidSlot(Number.NaN, 10, 7)).toBe(false);
  });

  it('永不抛错：网格参数非法（0 / 负数 / 小数）时返回 false 而不是异常', () => {
    expect(isValidSlot(5, 0, 7)).toBe(false);
    expect(isValidSlot(5, 10, 0)).toBe(false);
    expect(isValidSlot(5, -10, 7)).toBe(false);
    expect(isValidSlot(5, 10.5, 7)).toBe(false);
  });

  it('与 slotToGrid 互逆的合法性口径：10×7 内每个 slot 均合法且格点往返一致', () => {
    for (let slot1based = 1; slot1based <= 70; slot1based++) {
      expect(isValidSlot(slot1based, 10, 7)).toBe(true);
      const { col: col0based, row: row0based } = slotToGrid(slot1based, 10);
      expect(gridToSlot(col0based, row0based, 10)).toBe(slot1based);
    }
  });
});
