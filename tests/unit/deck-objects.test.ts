// tests/unit/deck-objects.test.ts
/**
 * src/deck/objects.ts 单元测试：objects.csv（非卡牌素材台账）的读写与校验。
 *
 * 纯文件 IO（临时目录），无网络、无 TTS、无 git 依赖。覆盖维度：
 * - 正常路径：write → read 往返一致（全字段 / 仅必填字段）、0 行、表头与编码
 *   （UTF-8 BOM + LF + 恰一个 trailing newline + 列名严格按契约顺序）、
 *   多行混合类型（model / pdf / assetbundle / 未知类型）往返；
 * - 转义：含逗号 / 双引号（"" 翻倍）/ 内嵌换行的字段写出加引号、读回原值；
 *   读路径宽容：BOM、CRLF（Excel 存盘）、缺 trailing newline、数据行间空行；
 * - 校验：asset_id 重复（读 / 写两条路径）、必填字段空（asset_id / type /
 *   file / source）、非字符串字段、表头不符（列名错 / 列序错 / 缺列）、
 *   列数不符（不足 / 超出）——一律按 PackError.code 断言，message 双态断言
 *   （locales 尚无 error.objects.* 键时 t() 原样输出键名，补齐后含插值摘要）；
 * - 开放集合：type = "unknown_custom_type" 不报错且原样保留（守卫：该字符串
 *   确实不在 ASSET_TYPES 中）；不 trim（前后空格保留）；asset_id 大小写敏感；
 * - 异常路径：文件不存在（OBJECTS_NOT_FOUND）、objects.csv 是目录（读 →
 *   OBJECTS_READ_FAILED / 写 → OBJECTS_WRITE_FAILED）、空文件 / 仅 BOM
 *   （OBJECTS_INVALID）、写前校验不过绝不落盘。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OBJECTS_CSV_COLUMNS,
  OBJECTS_CSV_FILENAME,
  objectsCsvPath,
  readObjectsCsv,
  writeObjectsCsv,
  type ObjectRow,
} from '../../src/deck/objects.js';
import { ASSET_TYPES } from '../../src/deck/types.js';
import { PackError } from '../../src/pack/packyaml.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-deck-objects-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** CSV 表头行（由导出的列常量拼出，避免测试里手抄列名漂移） */
const HEADER = OBJECTS_CSV_COLUMNS.join(',');

/** UTF-8 BOM 字符（与写出的文件头一致） */
const BOM = '\uFEFF';

/** 字段齐全的合法行（覆盖全部可选字段） */
const fullRow: ObjectRow = {
  assetId: 'tile-001',
  name: '拼图地块',
  type: 'tile',
  file: 'objects/tile-001.png',
  fileSecondary: 'objects/tile-001-secondary.png',
  diffuse: 'objects/tile-001-diffuse.png',
  normal: 'objects/tile-001-normal.png',
  collider: 'objects/tile-001-collider.obj',
  source: 'https://steamusercontent.com/tile-001.png',
  originAssetId: 'AB12CD',
  originPack: '旧图包',
};

/** 只含必填字段的最小合法行（可选字段全部缺省 → 键被摘除） */
const minimalRow: ObjectRow = {
  assetId: 'x',
  type: 'other',
  file: 'a.txt',
  source: 'u',
};

/** 最小行对应的 CSV 数据行文本（可选字段为空串占位） */
const minimalLine = 'x,,other,a.txt,,,,,u,,';

/**
 * 把任意文本直接写为 tempRoot 下的 objects.csv（手写 fixture 用）。
 * @param content 文件原始文本（含 BOM 与否由用例自定）
 */
async function writeRaw(content: string): Promise<void> {
  await writeFile(objectsCsvPath(tempRoot), content, 'utf8');
}

/**
 * 读取 tempRoot 下 objects.csv 的原始文本。
 * @returns 文件原始文本（含 BOM）
 */
async function readRaw(): Promise<string> {
  return readFile(objectsCsvPath(tempRoot), 'utf8');
}

/**
 * 断言 fn 抛出指定 code 的 PackError，并返回该错误。
 * @param fn 待执行（预期抛 PackError）的异步函数
 * @param code 期望的机器可读错误码
 * @returns 实际抛出的 PackError（可对 message 做进一步双态断言）
 */
async function expectPackError(fn: () => Promise<unknown>, code: string): Promise<PackError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PackError);
    expect((err as PackError).code).toBe(code);
    return err as PackError;
  }
  throw new Error(`预期抛出 PackError（code=${code}），但未抛错`);
}

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

describe('常量与路径', () => {
  it('OBJECTS_CSV_FILENAME 固定为 "objects.csv"', () => {
    expect(OBJECTS_CSV_FILENAME).toBe('objects.csv');
  });

  it('objectsCsvPath 按平台分隔符拼接 root 与文件名', () => {
    expect(objectsCsvPath('some-root')).toBe(path.join('some-root', 'objects.csv'));
  });
});

// ---------------------------------------------------------------------------
// writeObjectsCsv：编码 / 转义 / 写前校验
// ---------------------------------------------------------------------------

describe('writeObjectsCsv', () => {
  it('编码：UTF-8 BOM 开头 + LF 换行 + 末尾恰一个 trailing newline + 表头严格按契约顺序', async () => {
    await writeObjectsCsv(tempRoot, [minimalRow]);
    const raw = await readRaw();
    expect(raw).toBe(`${BOM}${HEADER}\n${minimalLine}\n`);
    expect(raw.startsWith(BOM)).toBe(true);
    expect(raw.includes('\r')).toBe(false); // 全程 LF，无 CRLF
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.endsWith('\n\n')).toBe(false); // 恰一个 trailing newline
    // 表头列名与顺序锁死（防列漂移）
    expect(raw.slice(BOM.length, raw.indexOf('\n'))).toBe(
      'asset_id,name,type,file,file_secondary,diffuse,normal,collider,source,origin_asset_id,origin_pack',
    );
  });

  it('0 行：只写 BOM + 表头 + trailing newline，读回空数组', async () => {
    await writeObjectsCsv(tempRoot, []);
    expect(await readRaw()).toBe(`${BOM}${HEADER}\n`);
    expect(await readObjectsCsv(tempRoot)).toEqual([]);
  });

  it('转义：含逗号 / 双引号 / 内嵌换行的字段整体加引号且双引号翻倍，读回原值', async () => {
    const row: ObjectRow = {
      assetId: 'a,1',
      name: '含"引号"',
      type: 'model',
      file: 'a\nb.obj',
      source: 'http://x',
    };
    await writeObjectsCsv(tempRoot, [row]);
    await expect(readRaw()).resolves.toBe(
      `${BOM}${HEADER}\n"a,1","含""引号""",model,"a\nb.obj",,,,,http://x,,\n`,
    );
    await expect(readObjectsCsv(tempRoot)).resolves.toEqual([row]);
  });

  it('可选字段缺省写空串占位（绝不写 undefined / null 字面量）', async () => {
    const row: ObjectRow = {
      assetId: 'x',
      name: undefined,
      type: 'other',
      file: 'a.txt',
      source: 'u',
      originPack: null,
    } as unknown as ObjectRow;
    await writeObjectsCsv(tempRoot, [row]);
    // null / undefined 的可选字段统一按空串占位（?? ""），读回即缺省
    await expect(readObjectsCsv(tempRoot)).resolves.toEqual([minimalRow]);
  });

  it('父目录不存在时自动创建', async () => {
    const deepRoot = path.join(tempRoot, 'a', 'b');
    await writeObjectsCsv(deepRoot, [minimalRow]);
    expect(existsSync(objectsCsvPath(deepRoot))).toBe(true);
  });

  it('写前校验：重复 asset_id → OBJECTS_DUPLICATE_ID，且绝不落盘', async () => {
    const err = await expectPackError(
      () => writeObjectsCsv(tempRoot, [minimalRow, { ...minimalRow }]),
      'OBJECTS_DUPLICATE_ID',
    );
    expect(err.message === 'error.objects.duplicateId' || err.message.includes('x')).toBe(true);
    expect(existsSync(objectsCsvPath(tempRoot))).toBe(false);
  });

  it('写前校验：必填字段空（asset_id / type / file / source）→ OBJECTS_INVALID，且绝不落盘', async () => {
    for (const key of ['assetId', 'type', 'file', 'source'] as const) {
      const broken = { ...minimalRow, [key]: '' };
      await expectPackError(() => writeObjectsCsv(tempRoot, [broken]), 'OBJECTS_INVALID');
    }
    // 四次都失败之后依然一个字节都没落盘
    expect(existsSync(objectsCsvPath(tempRoot))).toBe(false);
  });

  it('写前校验：字段不是字符串（如 assetId 给数字）→ OBJECTS_INVALID', async () => {
    const broken = { ...minimalRow, assetId: 123 } as unknown as ObjectRow;
    const err = await expectPackError(() => writeObjectsCsv(tempRoot, [broken]), 'OBJECTS_INVALID');
    expect(err.message === 'error.objects.invalid' || err.message.includes('asset_id')).toBe(true);
  });

  it('objects.csv 是目录 → OBJECTS_WRITE_FAILED', async () => {
    await mkdir(objectsCsvPath(tempRoot));
    await expectPackError(() => writeObjectsCsv(tempRoot, [minimalRow]), 'OBJECTS_WRITE_FAILED');
  });
});

// ---------------------------------------------------------------------------
// readObjectsCsv：往返 / 宽容读取 / 校验
// ---------------------------------------------------------------------------

describe('readObjectsCsv 往返', () => {
  it('往返一致：全字段行 write → read 深度相等', async () => {
    await writeObjectsCsv(tempRoot, [fullRow]);
    await expect(readObjectsCsv(tempRoot)).resolves.toEqual([fullRow]);
  });

  it('往返一致：仅必填字段行读回后可选键被摘除（"name" 不在对象上）', async () => {
    await writeObjectsCsv(tempRoot, [minimalRow]);
    const rows = await readObjectsCsv(tempRoot);
    expect(rows).toEqual([minimalRow]);
    expect('name' in rows[0]).toBe(false);
    expect('diffuse' in rows[0]).toBe(false);
    expect('originPack' in rows[0]).toBe(false);
  });

  it('多行混合类型（model / pdf / assetbundle / 未知类型）往返一致且保持文件顺序', async () => {
    const rows: ObjectRow[] = [
      {
        assetId: 'model-01',
        type: 'model',
        file: 'objects/model-01.obj',
        diffuse: 'objects/model-01-diffuse.png',
        normal: 'objects/model-01-normal.png',
        collider: 'objects/model-01-collider.obj',
        source: 'http://m',
      },
      { assetId: 'pdf-01', type: 'pdf', file: 'objects/pdf-01.pdf', source: 'http://p' },
      { assetId: 'bundle-01', type: 'assetbundle', file: 'objects/b-01.unity3d', source: 'http://b' },
      { assetId: 'weird-01', type: 'unknown_custom_type', file: 'objects/w.bin', source: 'http://w' },
    ];
    await writeObjectsCsv(tempRoot, rows);
    await expect(readObjectsCsv(tempRoot)).resolves.toEqual(rows);
  });
});

describe('readObjectsCsv 宽容读取', () => {
  it('手写 BOM + LF 文件正常解析', async () => {
    await writeRaw(`${BOM}${HEADER}\n${minimalLine}\n`);
    await expect(readObjectsCsv(tempRoot)).resolves.toEqual([minimalRow]);
  });

  it('CRLF + BOM（Excel 存盘风格）正常解析', async () => {
    await writeRaw(`${BOM}${HEADER}\r\n${minimalLine}\r\n`);
    await expect(readObjectsCsv(tempRoot)).resolves.toEqual([minimalRow]);
  });

  it('引号转义读回：逗号 / 双引号（"" 还原）/ 内嵌换行', async () => {
    await writeRaw(`${BOM}${HEADER}\n"a,1","含""引号""",model,"a\nb.obj",,,,,http://x,,\n`);
    await expect(readObjectsCsv(tempRoot)).resolves.toEqual([
      { assetId: 'a,1', name: '含"引号"', type: 'model', file: 'a\nb.obj', source: 'http://x' },
    ]);
  });

  it('数据行之间的空行跳过（含末尾多余换行）', async () => {
    await writeRaw(`${BOM}${HEADER}\n\n${minimalLine}\n\n`);
    await expect(readObjectsCsv(tempRoot)).resolves.toEqual([minimalRow]);
  });

  it('缺 trailing newline 宽容读取', async () => {
    await writeRaw(`${BOM}${HEADER}\n${minimalLine}`);
    await expect(readObjectsCsv(tempRoot)).resolves.toEqual([minimalRow]);
  });
});

describe('readObjectsCsv 校验', () => {
  it('表头列名错误 → OBJECTS_INVALID', async () => {
    await writeRaw(`${BOM}${HEADER.replace('type', 'typ')}\n${minimalLine}\n`);
    const err = await expectPackError(() => readObjectsCsv(tempRoot), 'OBJECTS_INVALID');
    expect(err.message === 'error.objects.invalid' || err.message.includes('表头')).toBe(true);
  });

  it('表头列序错误（交换两列）→ OBJECTS_INVALID', async () => {
    const swapped = HEADER.replace('name,type', 'type,name');
    await writeRaw(`${BOM}${swapped}\nx,other,,a.txt,,,,,u,,\n`);
    await expectPackError(() => readObjectsCsv(tempRoot), 'OBJECTS_INVALID');
  });

  it('表头缺列（10 列）→ OBJECTS_INVALID', async () => {
    await writeRaw(`${BOM}${HEADER.replace(',origin_pack', '')}\n${minimalLine}\n`);
    await expectPackError(() => readObjectsCsv(tempRoot), 'OBJECTS_INVALID');
  });

  it('数据行列数不足（10 列）→ OBJECTS_INVALID', async () => {
    await writeRaw(`${BOM}${HEADER}\n${minimalLine.replace(',,,', ',,')}\n`);
    const err = await expectPackError(() => readObjectsCsv(tempRoot), 'OBJECTS_INVALID');
    expect(err.message === 'error.objects.invalid' || err.message.includes('列')).toBe(true);
  });

  it('数据行列数超出（12 列）→ OBJECTS_INVALID', async () => {
    await writeRaw(`${BOM}${HEADER}\n${minimalLine},extra\n`);
    await expectPackError(() => readObjectsCsv(tempRoot), 'OBJECTS_INVALID');
  });

  it('读路径：asset_id 重复 → OBJECTS_DUPLICATE_ID', async () => {
    await writeRaw(`${BOM}${HEADER}\n${minimalLine}\ndup-1,,other,a.txt,,,,,u,,\ndup-1,,tile,b.png,,,,,v,,\n`);
    const err = await expectPackError(() => readObjectsCsv(tempRoot), 'OBJECTS_DUPLICATE_ID');
    expect(err.message === 'error.objects.duplicateId' || err.message.includes('dup-1')).toBe(true);
  });

  it('读路径：必填 asset_id / type 为空 → OBJECTS_INVALID', async () => {
    await writeRaw(`${BOM}${HEADER}\n,,other,a.txt,,,,,u,,\n`);
    await expectPackError(() => readObjectsCsv(tempRoot), 'OBJECTS_INVALID');

    await writeRaw(`${BOM}${HEADER}\nx,,a.txt,,,,,u,,\n`); // type 列空
    await expectPackError(() => readObjectsCsv(tempRoot), 'OBJECTS_INVALID');
  });

  it('读路径：必填 file / source 为空 → OBJECTS_INVALID', async () => {
    await writeRaw(`${BOM}${HEADER}\nx,,other,,,,,,u,,\n`); // file 列空
    await expectPackError(() => readObjectsCsv(tempRoot), 'OBJECTS_INVALID');

    await writeRaw(`${BOM}${HEADER}\nx,,other,a.txt,,,,,,,\n`); // source 列空
    await expectPackError(() => readObjectsCsv(tempRoot), 'OBJECTS_INVALID');
  });

  it('文件不存在 → OBJECTS_NOT_FOUND', async () => {
    const err = await expectPackError(() => readObjectsCsv(tempRoot), 'OBJECTS_NOT_FOUND');
    expect(err.message === 'error.objects.notFound' || err.message.includes('objects.csv')).toBe(true);
  });

  it('空文件（0 字节）→ OBJECTS_INVALID', async () => {
    await writeRaw('');
    await expectPackError(() => readObjectsCsv(tempRoot), 'OBJECTS_INVALID');
  });

  it('仅 BOM 无内容 → OBJECTS_INVALID', async () => {
    await writeRaw(BOM);
    await expectPackError(() => readObjectsCsv(tempRoot), 'OBJECTS_INVALID');
  });

  it('objects.csv 是目录 → OBJECTS_READ_FAILED', async () => {
    await mkdir(objectsCsvPath(tempRoot));
    await expectPackError(() => readObjectsCsv(tempRoot), 'OBJECTS_READ_FAILED');
  });
});

// ---------------------------------------------------------------------------
// 开放集合与原样保留
// ---------------------------------------------------------------------------

describe('开放集合与原样保留', () => {
  it('type = "unknown_custom_type" 不报错且原样保留（守卫：确实不在 ASSET_TYPES 中）', async () => {
    expect([...ASSET_TYPES]).not.toContain('unknown_custom_type');
    const row: ObjectRow = { assetId: 'w-1', type: 'unknown_custom_type', file: 'w.bin', source: 'http://w' };
    await writeObjectsCsv(tempRoot, [row]);
    await expect(readObjectsCsv(tempRoot)).resolves.toEqual([row]);
  });

  it('不 trim：字段值前后空格原样保留', async () => {
    const row: ObjectRow = { assetId: ' sp ', name: '  x  ', type: 'other', file: ' f ', source: ' u ' };
    await writeObjectsCsv(tempRoot, [row]);
    await expect(readObjectsCsv(tempRoot)).resolves.toEqual([row]);
  });

  it('asset_id 大小写敏感："abc" 与 "ABC" 是两个不同 ID（不归一）', async () => {
    const rows: ObjectRow[] = [
      { assetId: 'abc', type: 'other', file: 'a.txt', source: 'u1' },
      { assetId: 'ABC', type: 'other', file: 'b.txt', source: 'u2' },
    ];
    await writeObjectsCsv(tempRoot, rows);
    await expect(readObjectsCsv(tempRoot)).resolves.toEqual(rows);
  });
});
