// tests/unit/deck-cards.test.ts
/**
 * src/deck/cards.ts 单元测试：cards.csv 的读 / 写 / 校验。
 *
 * 纯文件 IO（临时目录），无网络、无 TTS、无 git 依赖：
 * - 正常路径：write → read 往返一致（全字段 / 可选字段省略 / 中文）、
 *   0 行（只写表头）、70 行满图集（10×7，slot 1..70）、71 行跨两张图集
 *   （sheet_id 1、2）、write → read → write 逐字节幂等；
 * - 编码细节：写出以 BOM（\ufeff）开头、LF 换行、全篇无 \r、总有 trailing
 *   newline；读侧对 BOM 有无、CRLF / LF、trailing newline 有无全部容忍；
 * - CSV 转义：含逗号 / 双引号 / 换行的字段写出加引号、内部双引号转义 ""，
 *   普通字段保持裸（git diff 友好），往返后还原（首列 face、末列 sheet_source
 *   含特殊字符也覆盖）；
 * - 校验（writeCardsCsv 与 readCardsCsv 双向都做；PackError 一律按 .code 断言、
 *   不断言 message——locales/*.json 由 Run 2 补齐，缺键时 t() 原样输出键名）：
 *   CARDS_DUPLICATE_ID / CARDS_SLOT_MISMATCH / CARDS_SLOT_OUT_OF_RANGE /
 *   CARDS_INVALID_GRID / CARDS_DUPLICATE_SLOT / CARDS_INVALID；
 *   1 基守卫：card_id %100===0 → slot 换算为 100（不是 0），100 超出
 *   10×7=70 容量上限，报 CARDS_SLOT_OUT_OF_RANGE 而非 MISMATCH；
 * - 异常路径：文件不存在 CARDS_NOT_FOUND；空文件 / 表头列名或列序不符 /
 *   数据行列数错误 / 数值列非整数字面量 → CARDS_INVALID；write 校验失败
 *   绝不落盘（连目录都不创建）；路径是目录等 IO 异常 → CARDS_READ_FAILED /
 *   CARDS_WRITE_FAILED。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CARDS_CSV_FILENAME,
  readCardsCsv,
  writeCardsCsv,
  type CardRow,
} from '../../src/deck/cards.js';
import { PackError } from '../../src/pack/packyaml.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-deck-cards-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 契约表头（裸文本形式） */
const HEADER_LINE = 'card_id,face,back,name,nickname,sheet_id,slot,sheet_cols,sheet_rows,sheet_source';

/** deckDir 内 cards.csv 的完整路径 */
function cardsPath(deckDir: string): string {
  return path.join(deckDir, CARDS_CSV_FILENAME);
}

/**
 * 构造一条合法的卡牌条目（默认值对应契约实例 CardID 10121 = key "101" 第 21 格，
 * 10×7 满规格图集）；各字段都可单独覆盖以构造违规样本。
 */
function row(overrides: Partial<CardRow> = {}): CardRow {
  return {
    cardId: 10121,
    face: 'card_10121.png',
    sheetId: 1,
    slot: 21,
    sheetCols: 10,
    sheetRows: 7,
    sheetSource: 'https://img.example.com/sheet-101.png',
    ...overrides,
  };
}

/**
 * 用裸数据行拼出完整 CSV 文件文本（BOM + 表头 + 数据行，每行 \n 结尾）。
 * 无数据行时即"只有表头 + trailing newline"。
 */
function csvText(...dataLines: string[]): string {
  const body = dataLines.length > 0 ? dataLines.join('\n') + '\n' : '';
  return '\ufeff' + HEADER_LINE + '\n' + body;
}

/** 直接落盘一份手改的 cards.csv（绕过 writeCardsCsv，构造"手改的坏文件"） */
async function writeRawCsv(deckDir: string, content: string): Promise<void> {
  await writeFile(cardsPath(deckDir), content, 'utf8');
}

/** 把裸数据行转成 CRLF 版本（其余不变） */
function crlf(text: string): string {
  return text.replace(/\n/g, '\r\n');
}

/**
 * 断言 fn 抛出指定 code 的 PackError，并返回该错误。
 * 只断言 code 与 message 非空，不断言 message 文案（locales 由 Run 2 补齐，
 * 缺键时 t() 原样输出键名，补齐前后 message 不同）。
 */
async function expectCardsError(fn: () => Promise<unknown>, code: string): Promise<PackError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PackError);
    const packError = err as PackError;
    expect(packError.code).toBe(code);
    expect(packError.message.length).toBeGreaterThan(0);
    return packError;
  }
  throw new Error(`预期抛出 code=${code} 的 PackError，但调用成功了`);
}

/**
 * 校验规则双向断言：同一违规既从 writeCardsCsv 的内存入参触发，
 * 也从手改落盘后 readCardsCsv 触发，两边抛同一 code。
 * @param rows 违规条目（write 侧）
 * @param rawLines 对应的裸数据行（read 侧，自动包 BOM + 表头）
 * @param code 期望错误码
 */
async function expectViolationBothWays(rows: CardRow[], rawLines: string[], code: string): Promise<void> {
  await expectCardsError(() => writeCardsCsv(tempRoot, rows), code);
  await writeRawCsv(tempRoot, csvText(...rawLines));
  await expectCardsError(() => readCardsCsv(tempRoot), code);
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

describe('常量', () => {
  it('CARDS_CSV_FILENAME 为 cards.csv，读写都落在 <deckDir>/cards.csv', async () => {
    expect(CARDS_CSV_FILENAME).toBe('cards.csv');
    await writeCardsCsv(tempRoot, [row()]);
    expect(existsSync(cardsPath(tempRoot))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 写出格式（BOM / LF / 列序 / 引号）
// ---------------------------------------------------------------------------

describe('写出格式', () => {
  it('以 \\ufeff 开头、LF 换行、全篇无 \\r、总有 trailing newline（Excel 兼容）', async () => {
    await writeCardsCsv(tempRoot, [row()]);
    const text = await readFile(cardsPath(tempRoot), 'utf8');
    expect(text.startsWith('\ufeff')).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.includes('\r')).toBe(false);
    expect(text.split('\n')).toHaveLength(3); // 表头 + 数据行 + 末尾换行后的空串
  });

  it('列严格按契约顺序：裸值数据行与手工拼接的期望串逐字节一致', async () => {
    const plain = row({
      cardId: 10121,
      face: 'card_10121.png',
      back: 'back_101.png',
      name: '钢铁侠',
      nickname: 'Tony',
      sheetId: 1,
      slot: 21,
      sheetCols: 10,
      sheetRows: 7,
      sheetSource: 'https://img.example.com/sheet-101.png',
    });
    await writeCardsCsv(tempRoot, [plain]);
    const text = await readFile(cardsPath(tempRoot), 'utf8');
    const expected = '\ufeff' + HEADER_LINE + '\n'
      + '10121,card_10121.png,back_101.png,钢铁侠,Tony,1,21,10,7,https://img.example.com/sheet-101.png\n';
    expect(text).toBe(expected);
  });

  it('只对含特殊字符的字段加引号（普通字段裸）；内部双引号转义为 ""', async () => {
    await writeCardsCsv(tempRoot, [row({ face: 'a,b.png', name: '说"你好"' })]);
    const text = await readFile(cardsPath(tempRoot), 'utf8');
    const expectedLine = '10121,"a,b.png",,"说""你好""",,1,21,10,7,https://img.example.com/sheet-101.png';
    expect(text.split('\n')[1]).toBe(expectedLine);
  });

  it('可选字段省略时写出空字段（不写占位文本）', async () => {
    await writeCardsCsv(tempRoot, [row()]); // back / name / nickname 全省略
    const text = await readFile(cardsPath(tempRoot), 'utf8');
    expect(text.split('\n')[1]).toBe('10121,card_10121.png,,,,1,21,10,7,https://img.example.com/sheet-101.png');
  });
});

// ---------------------------------------------------------------------------
// 读入解析（BOM / 换行 / trailing newline 容忍）
// ---------------------------------------------------------------------------

describe('读入解析', () => {
  it('带 BOM 的文件正常解析', async () => {
    await writeRawCsv(tempRoot, csvText('10121,a.png,,名,别,1,21,10,7,src'));
    const rows = await readCardsCsv(tempRoot);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('名');
  });

  it('不带 BOM 的文件也能解析', async () => {
    await writeRawCsv(tempRoot, HEADER_LINE + '\n10121,a.png,,名,别,1,21,10,7,src\n');
    const rows = await readCardsCsv(tempRoot);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.face).toBe('a.png');
  });

  it('CRLF 换行的文件正常解析', async () => {
    await writeRawCsv(tempRoot, crlf(csvText('10121,a.png,,,别,1,21,10,7,src', '10122,b.png,,,别2,1,22,10,7,src')));
    const rows = await readCardsCsv(tempRoot);
    expect(rows.map((r) => r.cardId)).toEqual([10121, 10122]);
  });

  it('无 trailing newline 的文件正常解析（末行字段不丢）', async () => {
    await writeRawCsv(tempRoot, csvText('10121,a.png,,,别,1,21,10,7,src').replace(/\n$/, ''));
    const rows = await readCardsCsv(tempRoot);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sheetSource).toBe('src');
  });

  it('BOM + CRLF + 无 trailing newline 组合正常解析', async () => {
    await writeRawCsv(tempRoot, crlf(csvText('10121,a.png,,,别,1,21,10,7,src')).replace(/\r\n$/, ''));
    const rows = await readCardsCsv(tempRoot);
    expect(rows.map((r) => r.slot)).toEqual([21]);
  });

  it('表头字段带引号（Excel 风格）也能解析', async () => {
    const quotedHeader = HEADER_LINE.split(',').map((name) => `"${name}"`).join(',');
    await writeRawCsv(tempRoot, '\ufeff' + quotedHeader + '\n10121,a.png,,,别,1,21,10,7,src\n');
    const rows = await readCardsCsv(tempRoot);
    expect(rows).toHaveLength(1);
  });

  it('只有表头（无数据行）返回空数组，不是错误', async () => {
    await writeRawCsv(tempRoot, csvText());
    expect(await readCardsCsv(tempRoot)).toEqual([]);
  });

  it('数据行之间的空行被容忍跳过（不报错、不占行号）', async () => {
    await writeRawCsv(tempRoot, csvText() + '\n' + '10121,a.png,,名1,,1,21,10,7,src\n\n10122,b.png,,名2,,1,22,10,7,src\n');
    const rows = await readCardsCsv(tempRoot);
    expect(rows.map((r) => r.cardId)).toEqual([10121, 10122]);
  });
});

// ---------------------------------------------------------------------------
// 往返一致性
// ---------------------------------------------------------------------------

describe('往返一致性', () => {
  it('全字段往返：write → read 深度还原（含中文显示名与别名）', async () => {
    const rows = [
      row({ back: 'back_101.png', name: '钢铁侠', nickname: 'Tony Stark' }),
      row({ cardId: 10122, slot: 22, face: 'card_10122.png', name: '马克战甲' }),
    ];
    await writeCardsCsv(tempRoot, rows);
    const readBack = await readCardsCsv(tempRoot);
    expect(readBack).toEqual(rows);
  });

  it('可选字段省略往返：读回是 undefined 而非空字符串', async () => {
    await writeCardsCsv(tempRoot, [row()]);
    const [first] = await readCardsCsv(tempRoot);
    expect(first?.back).toBeUndefined();
    expect(first?.name).toBeUndefined();
    expect(first?.nickname).toBeUndefined();
    expect(Object.hasOwn(first ?? {}, 'back')).toBe(false);
  });

  it('0 行：只写表头 + trailing newline，读回空数组', async () => {
    await writeCardsCsv(tempRoot, []);
    const text = await readFile(cardsPath(tempRoot), 'utf8');
    expect(text).toBe('\ufeff' + HEADER_LINE + '\n');
    expect(await readCardsCsv(tempRoot)).toEqual([]);
  });

  it('70 行满图集（10×7，slot 1..70）往返还原', async () => {
    const rows = Array.from({ length: 70 }, (_, i) => row({
      cardId: 10101 + i,
      face: `card_${10101 + i}.png`,
      slot: i + 1, // 1 基：第 1..70 格
    }));
    await writeCardsCsv(tempRoot, rows);
    const readBack = await readCardsCsv(tempRoot);
    expect(readBack).toEqual(rows);
    expect(readBack[69]?.slot).toBe(70); // 10×7 的最后一格
  });

  it('71 行跨两张图集（sheet_id 1、2）往返还原；跨图集同 slot 合法', async () => {
    const rows = [
      ...Array.from({ length: 70 }, (_, i) => row({
        cardId: 10101 + i,
        face: `s1_${i + 1}.png`,
        sheetId: 1,
        slot: i + 1,
      })),
      row({ cardId: 10201, face: 's2_1.png', sheetId: 2, slot: 1, sheetSource: 'https://img.example.com/sheet-102.png' }),
    ];
    await writeCardsCsv(tempRoot, rows);
    const readBack = await readCardsCsv(tempRoot);
    expect(readBack).toEqual(rows);
    expect(readBack).toHaveLength(71);
    expect(readBack[70]?.sheetId).toBe(2);
    // sheet 1 与 sheet 2 各有自己的 slot 1——不触发 CARDS_DUPLICATE_SLOT
    expect(readBack[0]?.slot).toBe(1);
  });

  it('write → read → write 逐字节幂等（含转义字段与中文）', async () => {
    const rows = [
      row({ face: 'a,b.png', name: '说"你好"\n第二行', nickname: '中文,别名' }),
      row({ cardId: 10201, slot: 1, face: 'b.png', sheetId: 2, sheetSource: 'src,with"quote"' }),
    ];
    await writeCardsCsv(tempRoot, rows);
    const first = await readFile(cardsPath(tempRoot), 'utf8');
    const readBack = await readCardsCsv(tempRoot);
    await writeCardsCsv(tempRoot, readBack);
    const second = await readFile(cardsPath(tempRoot), 'utf8');
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// CSV 转义
// ---------------------------------------------------------------------------

describe('CSV 转义', () => {
  it('name 含逗号 / 双引号 / 换行 / 三者组合都能往返还原', async () => {
    const rows = [
      row({ cardId: 10101, slot: 1, face: 'a.png', name: '甲,乙' }),
      row({ cardId: 10102, slot: 2, face: 'b.png', name: '说"你好"' }),
      row({ cardId: 10103, slot: 3, face: 'c.png', name: '第一行\n第二行' }),
      row({ cardId: 10104, slot: 4, face: 'd.png', name: '混"合,内\n容' }),
    ];
    await writeCardsCsv(tempRoot, rows);
    expect(await readCardsCsv(tempRoot)).toEqual(rows);
  });

  it('首列 face 与末列 sheet_source 含特殊字符也能往返还原', async () => {
    const rows = [
      row({ face: 'front, back.png', sheetSource: 'https://x.test/a?q=1,2' }),
      row({ cardId: 10122, slot: 22, face: 'say"hi".png', sheetSource: 'D:\\图集\\"新版".png' }),
    ];
    await writeCardsCsv(tempRoot, rows);
    expect(await readCardsCsv(tempRoot)).toEqual(rows);
  });

  it('读手写的引号 CSV：引号内含逗号、LF、"" 转义，解析正确', async () => {
    // 末列 sheet_source 的引号字段里同时有 LF 与 "" 转义（跨物理行的一条数据）
    await writeRawCsv(
      tempRoot,
      '\ufeff' + HEADER_LINE + '\n'
        + '10121,"a,""b"".png",,名,别,1,21,10,7,"src1\nsrc2,含""引号"""\n',
    );
    const rows = await readCardsCsv(tempRoot);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.face).toBe('a,"b".png');
    expect(rows[0]?.name).toBe('名');
    expect(rows[0]?.sheetSource).toBe('src1\nsrc2,含"引号"');
  });
});

// ---------------------------------------------------------------------------
// readCardsCsv 异常路径
// ---------------------------------------------------------------------------

describe('readCardsCsv 异常路径', () => {
  it('文件不存在 → CARDS_NOT_FOUND', async () => {
    await expectCardsError(() => readCardsCsv(tempRoot), 'CARDS_NOT_FOUND');
  });

  it('路径是目录（读非文件）→ CARDS_READ_FAILED', async () => {
    await mkdir(cardsPath(tempRoot)); // 用目录冒充 cards.csv，触发非 ENOENT 的 IO 错误
    await expectCardsError(() => readCardsCsv(tempRoot), 'CARDS_READ_FAILED');
  });

  it('空文件（0 字节，连表头都没有）→ CARDS_INVALID', async () => {
    await writeRawCsv(tempRoot, '');
    await expectCardsError(() => readCardsCsv(tempRoot), 'CARDS_INVALID');
  });

  it('表头列名错误 → CARDS_INVALID', async () => {
    await writeRawCsv(tempRoot, csvText().replace('card_id', 'id'));
    await expectCardsError(() => readCardsCsv(tempRoot), 'CARDS_INVALID');
  });

  it('表头列顺序颠倒 → CARDS_INVALID（即使列名齐全）', async () => {
    await writeRawCsv(tempRoot, csvText().replace('face,back', 'back,face'));
    await expectCardsError(() => readCardsCsv(tempRoot), 'CARDS_INVALID');
  });

  it('数据行 9 列 / 11 列 → CARDS_INVALID', async () => {
    await writeRawCsv(tempRoot, csvText('10121,a.png,,名,别,1,21,10,7')); // 少 sheet_source
    await expectCardsError(() => readCardsCsv(tempRoot), 'CARDS_INVALID');

    await writeRawCsv(tempRoot, csvText('10121,a.png,,名,别,1,21,10,7,src,多余'));
    await expectCardsError(() => readCardsCsv(tempRoot), 'CARDS_INVALID');
  });

  it('card_id 非数字 / 负数 / 小数 → CARDS_INVALID', async () => {
    await writeRawCsv(tempRoot, csvText('abc,a.png,,名,别,1,21,10,7,src'));
    await expectCardsError(() => readCardsCsv(tempRoot), 'CARDS_INVALID');

    await writeRawCsv(tempRoot, csvText('-10121,a.png,,名,别,1,21,10,7,src'));
    await expectCardsError(() => readCardsCsv(tempRoot), 'CARDS_INVALID');

    await writeRawCsv(tempRoot, csvText('10121.5,a.png,,名,别,1,21,10,7,src'));
    await expectCardsError(() => readCardsCsv(tempRoot), 'CARDS_INVALID');
  });

  it('数值列（slot）非整数 / 十六进制形式 → CARDS_INVALID', async () => {
    await writeRawCsv(tempRoot, csvText('10121,a.png,,名,别,1,abc,10,7,src'));
    await expectCardsError(() => readCardsCsv(tempRoot), 'CARDS_INVALID');

    await writeRawCsv(tempRoot, csvText('10121,a.png,,名,别,1,0x15,10,7,src'));
    await expectCardsError(() => readCardsCsv(tempRoot), 'CARDS_INVALID');
  });
});

// ---------------------------------------------------------------------------
// 校验规则（writeCardsCsv 与 readCardsCsv 双向一致）
// ---------------------------------------------------------------------------

describe('校验规则（双向）', () => {
  it('重复 card_id → CARDS_DUPLICATE_ID（双向）', async () => {
    // 第二行 slot 同为 21（card_id 相同 slot 必相同），保证只有"主键重复"一条违规；
    // 注意 per-row 规则先于跨行查重，read 侧夹具若给 slot=22 会先命中 CARDS_SLOT_MISMATCH
    await expectViolationBothWays(
      [row(), row({ face: 'b.png' })],
      ['10121,a.png,,名1,,1,21,10,7,src', '10121,b.png,,名2,,1,21,10,7,src'],
      'CARDS_DUPLICATE_ID',
    );
  });

  it('slot ≠ card_id%100 → CARDS_SLOT_MISMATCH（双向）', async () => {
    // CardID 10121 的 1 基 slot 应为 21，给 22 → 不匹配
    await expectViolationBothWays(
      [row({ slot: 22 })],
      ['10121,a.png,,名1,,1,22,10,7,src'],
      'CARDS_SLOT_MISMATCH',
    );
  });

  it('slot=0（0 基写法）→ CARDS_SLOT_MISMATCH（1 基守卫：slot 从 1 开始，没有 0 基）', async () => {
    await expectCardsError(() => writeCardsCsv(tempRoot, [row({ slot: 0 })]), 'CARDS_SLOT_MISMATCH');
  });

  it('%100===0 守卫：card_id 10100 / slot 100 符合 1 基规则但超 10×7 上限 → CARDS_SLOT_OUT_OF_RANGE', async () => {
    // slot 换算为 100（不是 0），与 MISMATCH 规则先匹配通过，再卡在容量上限 70
    await expectViolationBothWays(
      [row({ cardId: 10100, slot: 100 })],
      ['10100,x.png,,名,,1,100,10,7,src'],
      'CARDS_SLOT_OUT_OF_RANGE',
    );
  });

  it('slot 超出 sheet_cols×sheet_rows（小网格 3×1 给 slot 5）→ CARDS_SLOT_OUT_OF_RANGE（双向）', async () => {
    // CardID 10105 的 1 基 slot = 5，与 %100 规则一致，但 3×1=3 容不下第 5 格
    await expectViolationBothWays(
      [row({ cardId: 10105, slot: 5, sheetCols: 3, sheetRows: 1 })],
      ['10105,x.png,,名,,1,5,3,1,src'],
      'CARDS_SLOT_OUT_OF_RANGE',
    );
  });

  it('sheet_cols=11 / sheet_cols=0 / sheet_rows=8 → CARDS_INVALID_GRID（双向）', async () => {
    await expectCardsError(() => writeCardsCsv(tempRoot, [row({ sheetCols: 11 })]), 'CARDS_INVALID_GRID');
    await expectCardsError(() => writeCardsCsv(tempRoot, [row({ sheetCols: 0 })]), 'CARDS_INVALID_GRID');
    await expectViolationBothWays(
      [row({ sheetRows: 8 })],
      ['10121,x.png,,名,,1,21,10,8,src'],
      'CARDS_INVALID_GRID',
    );
  });

  it('同一 sheet_id 内 slot 重复 → CARDS_DUPLICATE_SLOT（双向）', async () => {
    // 两行 slot 都是 21（不同 CardID：key "101" 与 key "102"），同 sheet_id → 重复
    await expectViolationBothWays(
      [row(), row({ cardId: 10221, face: 'b.png' })],
      ['10121,a.png,,名1,,1,21,10,7,src', '10221,b.png,,名2,,1,21,10,7,src'],
      'CARDS_DUPLICATE_SLOT',
    );
  });

  it('face 为空字符串 → CARDS_INVALID（双向）', async () => {
    await expectViolationBothWays(
      [row({ face: '' })],
      ['10121,,back.png,名,别,1,21,10,7,src'],
      'CARDS_INVALID',
    );
  });

  it('sheet_source 为空字符串 → CARDS_INVALID（双向）', async () => {
    await expectViolationBothWays(
      [row({ sheetSource: '' })],
      ['10121,a.png,,名,别,1,21,10,7,'],
      'CARDS_INVALID',
    );
  });

  it('card_id = 0 / 负数 / 小数 / NaN（内存入参）→ CARDS_INVALID（write 侧）', async () => {
    await expectCardsError(() => writeCardsCsv(tempRoot, [row({ cardId: 0 })]), 'CARDS_INVALID');
    await expectCardsError(() => writeCardsCsv(tempRoot, [row({ cardId: -10121 })]), 'CARDS_INVALID');
    await expectCardsError(() => writeCardsCsv(tempRoot, [row({ cardId: 10121.5 })]), 'CARDS_INVALID');
    await expectCardsError(() => writeCardsCsv(tempRoot, [row({ cardId: Number.NaN })]), 'CARDS_INVALID');
  });

  it('sheet_id = 0 / 非整数（内存入参）→ CARDS_INVALID（write 侧）', async () => {
    await expectCardsError(() => writeCardsCsv(tempRoot, [row({ sheetId: 0 })]), 'CARDS_INVALID');
    await expectCardsError(() => writeCardsCsv(tempRoot, [row({ sheetId: 1.5 })]), 'CARDS_INVALID');
  });

  it('write 校验失败时绝不落盘（连 deckDir 都不创建）', async () => {
    const deckDir = path.join(tempRoot, 'decks', 'deck1');
    await expectCardsError(() => writeCardsCsv(deckDir, [row(), row({ face: 'b.png' })]), 'CARDS_DUPLICATE_ID');
    expect(existsSync(deckDir)).toBe(false);
    expect(existsSync(cardsPath(deckDir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeCardsCsv IO
// ---------------------------------------------------------------------------

describe('writeCardsCsv IO', () => {
  it('deckDir 不存在时自动逐级创建父目录并写成功', async () => {
    const deckDir = path.join(tempRoot, 'decks', 'nested', 'deck1');
    const rows = [row(), row({ cardId: 10201, slot: 1, face: 'b.png', sheetId: 2 })];
    await writeCardsCsv(deckDir, rows);
    expect(await readCardsCsv(deckDir)).toEqual(rows);
  });

  it('重复写同一文件覆盖旧内容', async () => {
    await writeCardsCsv(tempRoot, [row()]);
    await writeCardsCsv(tempRoot, []);
    expect(await readCardsCsv(tempRoot)).toEqual([]);
  });

  it('目标路径是已存在的目录（cards.csv 是目录）→ CARDS_WRITE_FAILED', async () => {
    await mkdir(cardsPath(tempRoot)); // 用目录占位，writeFile 必然失败
    await expectCardsError(() => writeCardsCsv(tempRoot, [row()]), 'CARDS_WRITE_FAILED');
  });
});
