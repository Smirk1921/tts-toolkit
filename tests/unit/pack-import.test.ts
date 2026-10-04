// tests/unit/pack-import.test.ts
/**
 * src/pack/import.ts 单元测试：素材导入清单 import.yaml 的导入器。
 *
 * 纯文件 IO（临时目录 + sharp 造图），无网络、无 TTS 依赖：
 * - dry-run：返回完整计划但不落盘（decks/ / objects/ 目录与两份 csv 都不出现）；
 * - 实落盘：卡图 / 背面复制、cards.csv 生成与更新（card_id 顺序分配、跨图集
 *   key 进位、slot 每张图集内独立编号）、objects.csv 生成与合并（asset_id 稳定、
 *   origin_asset_id 不触碰——窗口 C 裁决）、不写 deck.yaml（B2 裁决：明细唯一源是 cards.csv）；
 * - 异常路径：按 PackError.code（机器可读）断言，不依赖错误文案——文案走 t()，
 *   locales/*.json 由本阶段 locales Run 补齐，补齐前后 message 不同；warnings
 *   的文案断言用 t() 现算期望串（测试与实现同 lang，缺键与否双态一致）；
 * - 覆盖任务要求的六类场景：dry-run / 实落盘 / 坏清单报错 / CMYK 拒绝 /
 *   网格超容量自动拆分 / objects 各类型必填字段校验。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CARDS_CSV_FILENAME, readCardsCsv, writeCardsCsv, type CardRow } from '../../src/deck/cards.js';
import { OBJECTS_CSV_FILENAME, readObjectsCsv, writeObjectsCsv, type ObjectRow } from '../../src/deck/objects.js';
import { initI18n, t } from '../../src/i18n/index.js';
import { importAssets, importManifestSchema, type ImportManifest } from '../../src/pack/import.js';
import type { PackYaml } from '../../src/pack/packyaml.js';
import { PackError, writePackYaml } from '../../src/pack/packyaml.js';

/** writeManifest 的入参类型：schema 输入形态（decks / objects 可省略，缺省 []） */
type ManifestInput = z.input<typeof importManifestSchema>;

// 文案断言与实现同语言（缺键时 t() 双方都回退键名，断言仍成立）
initI18n({ lang: 'zh-CN' });

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-import-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 默认图包元数据（pack.yaml 夹具；name 与默认清单的 pack 一致，不出告警） */
const PACK_NAME = '测试包';

function packYamlFixture(name = PACK_NAME): PackYaml {
  return {
    schema_version: 1,
    name,
    workshop_id: null,
    source_mod: null,
    host: 'steamcloud',
    vcs: { lfs: 'enabled' },
    paths: { workdir: '.' },
    upload: { prefix: '' },
  };
}

/**
 * 落盘一张图片（默认 4x4 sRGB PNG；cmyk=true 输出 CMYK JPEG——文件名需 .jpg；
 * garbage=true 写入非图片字节）。
 */
async function makeImage(
  file: string,
  opts: { cmyk?: boolean; garbage?: boolean } = {},
): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  if (opts.garbage) {
    await writeFile(file, Buffer.from('this is not an image'));
    return file;
  }
  const base = sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 200, b: 10 } },
  });
  if (opts.cmyk) {
    await base.toColorspace('cmyk').jpeg({ quality: 90 }).toFile(file);
  } else {
    await base.png().toFile(file);
  }
  return file;
}

/** 在 cards_dir 里按名字造一批 sRGB PNG */
async function makeCardImages(cardsDir: string, names: string[]): Promise<void> {
  for (const name of names) {
    await makeImage(path.join(cardsDir, name));
  }
}

/** 落盘一个非图片文本文件（自动创建父目录） */
async function makeTextFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

/** 写一份 import.yaml（YAML.stringify；父目录自动创建），返回其绝对路径 */
async function writeManifest(manifest: ManifestInput, file: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(manifest), 'utf8');
  return file;
}

/** 断言 fn 抛出指定 code 的 PackError 并返回它（不解析 message 文案） */
async function expectPackError(fn: () => Promise<unknown>, code: string): Promise<PackError> {
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

/** 单卡堆最小清单（默认共用背面 ./背面.png，standardFixture 会造出该文件；用例可覆盖） */
function deckManifest(cardsDir: string, overrides: Partial<ImportManifest['decks'][number]> = {}): ImportManifest {
  return {
    schema_version: 1,
    pack: PACK_NAME,
    decks: [
      {
        name: '军争',
        back: 'common',
        back_file: './背面.png',
        cards_dir: cardsDir,
        ...overrides,
      },
    ],
    objects: [],
  };
}

/** 常规卡堆夹具：pack.yaml + 3 张卡图 + 共用背面，清单落在 root 根 */
async function standardFixture(cards = ['a.png', 'b.png', 'c.png']): Promise<string> {
  await writePackYaml(tempRoot, packYamlFixture());
  const cardsDir = path.join(tempRoot, 'cards');
  await makeCardImages(cardsDir, cards);
  await makeImage(path.join(tempRoot, '背面.png'));
  return writeManifest(deckManifest('./cards'), path.join(tempRoot, 'import.yaml'));
}

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

describe('dry-run：只规划不落盘', () => {
  it('返回完整计划（归位行 + 复制清单），但不创建 decks/ / objects/ 与任何 csv', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    const cardsDir = path.join(tempRoot, 'cards');
    await makeCardImages(cardsDir, ['a.png', 'b.png']);
    await makeImage(path.join(tempRoot, '背面.png'));
    const objImg = await makeImage(path.join(tempRoot, 'tiles', '板块.png'));
    const manifestPath = await writeManifest(
      {
        schema_version: 1,
        pack: PACK_NAME,
        decks: [{ name: '军争', back: 'common', back_file: './背面.png', cards_dir: './cards' }],
        objects: [{ type: 'tile', name: '板块A', image: './tiles/板块.png' }],
      },
      path.join(tempRoot, 'import.yaml'),
    );

    const result = await importAssets({ root: tempRoot, manifestPath, dryRun: true });

    expect(result.dryRun).toBe(true);
    // 卡堆计划完整
    expect(result.decks).toHaveLength(1);
    const deck = result.decks[0]!;
    expect(deck.cardsCsvExisted).toBe(false);
    expect(deck.addedCards).toBe(2);
    expect(deck.cards.map((row) => row.cardId)).toEqual([101, 102]);
    expect(deck.copiedFiles).toHaveLength(3); // 2 张卡图 + 1 张背面
    // 对象计划完整
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]!.copiedFiles).toEqual([
      { source: objImg, dest: path.join(tempRoot, 'objects', 'tiles', '板块A', '板块.png') },
    ]);
    expect(result.objectsCsvPath).toBe(path.join(tempRoot, 'objects', OBJECTS_CSV_FILENAME));
    // 不落盘：deck 目录、objects 目录都不存在
    expect(existsSync(path.join(tempRoot, 'decks'))).toBe(false);
    expect(existsSync(path.join(tempRoot, 'objects'))).toBe(false);
  });

  it('dry-run 不改动已有的 cards.csv 与 objects.csv', async () => {
    const manifestPath = await standardFixture();
    const deckDir = path.join(tempRoot, 'decks', '军争');
    const existing: CardRow[] = [
      { cardId: 101, face: 'old.png', sheetId: 1, slot: 1, sheetCols: 1, sheetRows: 1, sheetSource: 'old' },
    ];
    await writeCardsCsv(deckDir, existing);
    const result = await importAssets({ root: tempRoot, manifestPath, dryRun: true });
    expect(result.decks[0]!.cardsCsvExisted).toBe(true);
    // 文件保持原样
    const reread = await readCardsCsv(deckDir);
    expect(reread).toEqual(existing);
  });
});

// ---------------------------------------------------------------------------
// 实落盘：卡堆
// ---------------------------------------------------------------------------

describe('实落盘：卡堆', () => {
  it('新卡堆：复制卡图与背面、生成 cards.csv（card_id 顺序分配）、不写 deck.yaml', async () => {
    const manifestPath = await standardFixture();
    const result = await importAssets({ root: tempRoot, manifestPath });

    expect(result.dryRun).toBe(false);
    expect(result.warnings).toEqual([]);
    const deck = result.decks[0]!;
    expect(deck.name).toBe('军争');
    expect(deck.cardsCsvExisted).toBe(false);
    expect(deck.addedCards).toBe(3);

    // 卡图与背面已复制（face/back 文件名 = 源文件名）
    const deckDir = path.join(tempRoot, 'decks', '军争');
    for (const name of ['a.png', 'b.png', 'c.png', '背面.png']) {
      expect(existsSync(path.join(deckDir, name))).toBe(true);
    }
    // 明细：sheet 1、slot 1..3、自动网格 3x1（inferGrid 正方形假设的确定性结果）
    expect(deck.cards).toEqual([
      {
        cardId: 101, face: 'a.png', back: '背面.png', sheetId: 1, slot: 1,
        sheetCols: 3, sheetRows: 1, sheetSource: './cards/a.png',
      },
      {
        cardId: 102, face: 'b.png', back: '背面.png', sheetId: 1, slot: 2,
        sheetCols: 3, sheetRows: 1, sheetSource: './cards/b.png',
      },
      {
        cardId: 103, face: 'c.png', back: '背面.png', sheetId: 1, slot: 3,
        sheetCols: 3, sheetRows: 1, sheetSource: './cards/c.png',
      },
    ]);
    expect(deck.sheets).toEqual([{ sheetId: 1, cols: 3, rows: 1, cardCount: 3 }]);
    // 落盘的 csv 与结构化结果一致
    expect(await readCardsCsv(deckDir)).toEqual(deck.cards);
    // 不写 deck.yaml（B2：卡牌明细唯一源是 cards.csv）
    expect(existsSync(path.join(deckDir, 'deck.yaml'))).toBe(false);
    // 没有 objects 条目时不触碰 objects.csv
    expect(result.objectsCsvPath).toBe(null);
    expect(existsSync(path.join(tempRoot, 'objects', OBJECTS_CSV_FILENAME))).toBe(false);
  });

  it('unique 背面：按“序号_正面 ↔ 序号_背面”配对；无后缀正面按“同名_背面”找', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    const cardsDir = path.join(tempRoot, 'cards');
    await makeCardImages(cardsDir, ['001_正面.png', '001_背面.png', 'x.png', 'x_背面.png']);
    const manifestPath = await writeManifest(
      deckManifest('./cards', { back: 'unique', back_file: undefined }),
      path.join(tempRoot, 'import.yaml'),
    );

    const result = await importAssets({ root: tempRoot, manifestPath });
    const deck = result.decks[0]!;
    expect(deck.cards.map((row) => [row.face, row.back])).toEqual([
      ['001_正面.png', '001_背面.png'],
      ['x.png', 'x_背面.png'],
    ]);
    expect(deck.cards[0]!.sheetSource).toBe('./cards/001_正面.png');
    for (const name of ['001_正面.png', '001_背面.png', 'x.png', 'x_背面.png']) {
      expect(existsSync(path.join(tempRoot, 'decks', '军争', name))).toBe(true);
    }
  });

  it('none 背面：back 列留空', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    const cardsDir = path.join(tempRoot, 'cards');
    await makeCardImages(cardsDir, ['a.png']);
    const manifestPath = await writeManifest(
      deckManifest('./cards', { back: 'none', back_file: undefined }),
      path.join(tempRoot, 'import.yaml'),
    );

    const result = await importAssets({ root: tempRoot, manifestPath });
    expect(result.decks[0]!.cards[0]!.back).toBeUndefined();
  });

  it('更新已有 cards.csv：已有行原样保留（card_id 不变），新增卡另起新图集', async () => {
    const manifestPath = await standardFixture(['card-001.png', 'card-002.png']);
    const deckDir = path.join(tempRoot, 'decks', '军争');
    const existing: CardRow[] = [
      { cardId: 101, face: 'card-001.png', sheetId: 1, slot: 1, sheetCols: 1, sheetRows: 1, sheetSource: 'old-source' },
    ];
    await writeCardsCsv(deckDir, existing);

    const result = await importAssets({ root: tempRoot, manifestPath });
    const deck = result.decks[0]!;
    expect(deck.cardsCsvExisted).toBe(true);
    expect(deck.addedCards).toBe(1);
    // 已有行逐字段不变
    expect(deck.cards[0]).toEqual(existing[0]);
    // 新增卡：key 进位（maxKey 1 → 2），sheet_id 另起（maxSheetId 1 → 2），slot 回到 1
    expect(deck.cards[1]).toEqual({
      cardId: 201, face: 'card-002.png', back: '背面.png', sheetId: 2, slot: 1,
      sheetCols: 1, sheetRows: 1, sheetSource: './cards/card-002.png',
    });
    // 卡图刷新复制（同名 face 覆盖）
    expect(deck.copiedFiles.map((f) => path.basename(f.dest))).toEqual(['card-001.png', 'card-002.png', '背面.png']);
  });
});

// ---------------------------------------------------------------------------
// 坏清单与业务校验
// ---------------------------------------------------------------------------

describe('坏清单与业务校验', () => {
  it('清单文件不存在 → IMPORT_FILE_MISSING', async () => {
    await expectPackError(
      () => importAssets({ root: tempRoot, manifestPath: path.join(tempRoot, 'nope.yaml') }),
      'IMPORT_FILE_MISSING',
    );
  });

  it('清单不是合法 YAML → IMPORT_INVALID', async () => {
    const file = path.join(tempRoot, 'import.yaml');
    await mkdir(tempRoot, { recursive: true });
    await writeFile(file, 'decks: [ { name: 未闭合', 'utf8');
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath: file }), 'IMPORT_INVALID');
  });

  it('schema_version 不是 1 → IMPORT_INVALID', async () => {
    const manifestPath = await writeManifest(
      { ...deckManifest('./cards'), schema_version: 2 as unknown as 1 },
      path.join(tempRoot, 'import.yaml'),
    );
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath }), 'IMPORT_INVALID');
  });

  it('未知顶层字段（strictObject）→ IMPORT_INVALID', async () => {
    const manifestPath = await writeManifest(
      { ...deckManifest('./cards'), extra: true } as unknown as ImportManifest,
      path.join(tempRoot, 'import.yaml'),
    );
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath }), 'IMPORT_INVALID');
  });

  it('decks 条目未知字段 / 缺必填字段 / grid 越界 → IMPORT_INVALID', async () => {
    // 未知字段
    const bad1 = deckManifest('./cards');
    (bad1.decks[0] as Record<string, unknown>).card_dir = './cards'; // 拼写错误
    const p1 = await writeManifest(bad1, path.join(tempRoot, 'm1.yaml'));
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath: p1 }), 'IMPORT_INVALID');

    // 缺 cards_dir
    const bad2 = deckManifest('./cards');
    delete (bad2.decks[0] as Partial<ImportManifest['decks'][number]>).cards_dir;
    const p2 = await writeManifest(bad2, path.join(tempRoot, 'm2.yaml'));
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath: p2 }), 'IMPORT_INVALID');

    // grid.cols 越界（>10）
    const bad3 = deckManifest('./cards', { grid: { cols: 11, rows: 7 } });
    await makeCardImages(path.join(tempRoot, 'cards'), ['a.png']);
    await makeImage(path.join(tempRoot, '背面.png'));
    bad3.decks[0]!.back = 'common';
    bad3.decks[0]!.back_file = './背面.png';
    const p3 = await writeManifest(bad3, path.join(tempRoot, 'm3.yaml'));
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath: p3 }), 'IMPORT_INVALID');
  });

  it('back=common 缺 back_file / back=unique|none 多带 back_file → IMPORT_INVALID', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    await makeCardImages(path.join(tempRoot, 'cards'), ['a.png']);

    const p1 = await writeManifest(
      deckManifest('./cards', { back_file: undefined }), // back=common 而缺 back_file
      path.join(tempRoot, 'm1.yaml'),
    );
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath: p1 }), 'IMPORT_INVALID');

    await makeImage(path.join(tempRoot, '背面.png'));
    const p2 = await writeManifest(
      deckManifest('./cards', { back: 'unique', back_file: './背面.png' }),
      path.join(tempRoot, 'm2.yaml'),
    );
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath: p2 }), 'IMPORT_INVALID');
  });

  it('净化后重名的卡堆条目 → IMPORT_INVALID', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    await makeCardImages(path.join(tempRoot, 'cards'), ['a.png']);
    await makeImage(path.join(tempRoot, '背面.png'));
    const manifest: ImportManifest = {
      schema_version: 1,
      pack: PACK_NAME,
      decks: [
        { name: '军 争', back: 'common', back_file: './背面.png', cards_dir: './cards' },
        { name: '军_争', back: 'common', back_file: './背面.png', cards_dir: './cards' },
      ],
      objects: [],
    };
    const manifestPath = await writeManifest(manifest, path.join(tempRoot, 'import.yaml'));
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath }), 'IMPORT_INVALID');
  });

  it('cards_dir 不存在 → IMPORT_FILE_MISSING；cards_dir 无图片 → IMPORT_INVALID', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    const p1 = await writeManifest(deckManifest('./nope'), path.join(tempRoot, 'm1.yaml'));
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath: p1 }), 'IMPORT_FILE_MISSING');

    await mkdir(path.join(tempRoot, 'empty'), { recursive: true });
    await writeFile(path.join(tempRoot, 'empty', '说明.txt'), '不是图片', 'utf8');
    const p2 = await writeManifest(deckManifest('./empty'), path.join(tempRoot, 'm2.yaml'));
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath: p2 }), 'IMPORT_INVALID');
  });

  it('unique 背面缺失配对 → IMPORT_FILE_MISSING（指出期望的背面路径）', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    await makeCardImages(path.join(tempRoot, 'cards'), ['001_正面.png']);
    const manifestPath = await writeManifest(
      deckManifest('./cards', { back: 'unique', back_file: undefined }),
      path.join(tempRoot, 'import.yaml'),
    );
    // message 双态断言：locales 补齐后含路径，未补齐时 t() 原样回退键名
    const err = await expectPackError(
      () => importAssets({ root: tempRoot, manifestPath }),
      'IMPORT_FILE_MISSING',
    );
    expect(err.message === 'error.pack.importFileMissing' || err.message.includes(path.join(tempRoot, 'cards', '001_背面.png'))).toBe(true);
  });

  it('图像不可读（损坏文件）→ IMPORT_INVALID', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    await makeImage(path.join(tempRoot, 'cards', 'broken.png'), { garbage: true });
    const manifestPath = await writeManifest(deckManifest('./cards'), path.join(tempRoot, 'import.yaml'));
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath }), 'IMPORT_INVALID');
  });

  it('decks 与 objects 全空 → IMPORT_EMPTY', async () => {
    const manifestPath = await writeManifest(
      { schema_version: 1, pack: PACK_NAME },
      path.join(tempRoot, 'import.yaml'),
    );
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath }), 'IMPORT_EMPTY');
  });

  it('校验失败不落盘：报错后 decks/ 目录不出现', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    await makeImage(path.join(tempRoot, 'cards', 'broken.png'), { garbage: true });
    const manifestPath = await writeManifest(deckManifest('./cards'), path.join(tempRoot, 'import.yaml'));
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath }), 'IMPORT_INVALID');
    expect(existsSync(path.join(tempRoot, 'decks'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CMYK 拒绝
// ---------------------------------------------------------------------------

describe('CMYK 拒绝', () => {
  it('卡图是 CMYK JPEG → IMPORT_CMYK，且不落盘', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    await makeImage(path.join(tempRoot, 'cards', 'cmyk.jpg'), { cmyk: true });
    await makeImage(path.join(tempRoot, '背面.png'));
    const manifestPath = await writeManifest(
      { ...deckManifest('./cards'), decks: [{ name: '军争', back: 'common', back_file: './背面.png', cards_dir: './cards' }] },
      path.join(tempRoot, 'import.yaml'),
    );
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath }), 'IMPORT_CMYK');
    expect(existsSync(path.join(tempRoot, 'decks'))).toBe(false);
  });

  it('共用背面是 CMYK → IMPORT_CMYK；dry-run 同样拒绝', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    await makeCardImages(path.join(tempRoot, 'cards'), ['a.png']);
    await makeImage(path.join(tempRoot, '背面.jpg'), { cmyk: true });
    const manifestPath = await writeManifest(
      { ...deckManifest('./cards'), decks: [{ name: '军争', back: 'common', back_file: './背面.jpg', cards_dir: './cards' }] },
      path.join(tempRoot, 'import.yaml'),
    );
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath }), 'IMPORT_CMYK');
    await expectPackError(
      () => importAssets({ root: tempRoot, manifestPath, dryRun: true }),
      'IMPORT_CMYK',
    );
  });

  it('对象 image 是 CMYK → IMPORT_CMYK', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    await makeImage(path.join(tempRoot, 'tiles', '板块.jpg'), { cmyk: true });
    const manifestPath = await writeManifest(
      {
        schema_version: 1,
        pack: PACK_NAME,
        decks: [],
        objects: [{ type: 'tile', name: '板块A', image: './tiles/板块.jpg' }],
      },
      path.join(tempRoot, 'import.yaml'),
    );
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath }), 'IMPORT_CMYK');
  });
});

// ---------------------------------------------------------------------------
// 网格容量与自动拆分
// ---------------------------------------------------------------------------

describe('网格容量与自动拆分', () => {
  it('75 张卡无 grid：sheet 1 装 70 张（10x7，slot 1..70），sheet 2 装 5 张（slot 回到 1）', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    const names = Array.from({ length: 75 }, (_, i) => `f${String(i).padStart(3, '0')}.png`);
    await makeCardImages(path.join(tempRoot, 'cards'), names);
    await makeImage(path.join(tempRoot, '背面.png'));
    const manifestPath = await writeManifest(
      {
        ...deckManifest('./cards'),
        decks: [{ name: '军争', back: 'common', back_file: './背面.png', cards_dir: './cards' }],
      },
      path.join(tempRoot, 'import.yaml'),
    );

    const result = await importAssets({ root: tempRoot, manifestPath });
    const rows = result.decks[0]!.cards;
    expect(rows).toHaveLength(75);

    // sheet 1：card_id 101..170，slot 1..70，网格 10x7
    expect(rows[0]).toMatchObject({ cardId: 101, face: 'f000.png', sheetId: 1, slot: 1, sheetCols: 10, sheetRows: 7 });
    expect(rows[69]).toMatchObject({ cardId: 170, face: 'f069.png', sheetId: 1, slot: 70, sheetCols: 10, sheetRows: 7 });
    // sheet 2：key 进位 → card_id 201..205，slot 每张图集内独立编号回到 1，网格按 5 张自动选 5x1
    expect(rows[70]).toMatchObject({ cardId: 201, face: 'f070.png', sheetId: 2, slot: 1, sheetCols: 5, sheetRows: 1 });
    expect(rows[74]).toMatchObject({ cardId: 205, face: 'f074.png', sheetId: 2, slot: 5, sheetCols: 5, sheetRows: 1 });
    expect(result.decks[0]!.sheets).toEqual([
      { sheetId: 1, cols: 10, rows: 7, cardCount: 70 },
      { sheetId: 2, cols: 5, rows: 1, cardCount: 5 },
    ]);
  });

  it('显式 grid {cols:2, rows:1}：5 张卡拆成 3 张图集（容量 2），网格逐行声明', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    await makeCardImages(path.join(tempRoot, 'cards'), ['c0.png', 'c1.png', 'c2.png', 'c3.png', 'c4.png']);
    await makeImage(path.join(tempRoot, '背面.png'));
    const manifestPath = await writeManifest(
      {
        ...deckManifest('./cards'),
        decks: [{ name: '军争', back: 'common', back_file: './背面.png', cards_dir: './cards', grid: { cols: 2, rows: 1 } }],
      },
      path.join(tempRoot, 'import.yaml'),
    );

    const result = await importAssets({ root: tempRoot, manifestPath });
    const rows = result.decks[0]!.cards;
    expect(rows.map((row) => [row.cardId, row.sheetId, row.slot, row.sheetCols, row.sheetRows])).toEqual([
      [101, 1, 1, 2, 1],
      [102, 1, 2, 2, 1],
      [201, 2, 1, 2, 1],
      [202, 2, 2, 2, 1],
      [301, 3, 1, 2, 1],
    ]);
  });
});

// ---------------------------------------------------------------------------
// objects：各类型必填字段校验
// ---------------------------------------------------------------------------

describe('objects：各类型必填字段校验', () => {
  /** 造齐常用源文件，各用例按需引用 */
  async function makeObjectSources(): Promise<void> {
    await makeImage(path.join(tempRoot, 'tiles', 'a.png'));
    await makeImage(path.join(tempRoot, 'textures', 'd.png'));
    await makeTextFile(path.join(tempRoot, 'models', 'm.obj'), '# obj');
    await makeTextFile(path.join(tempRoot, 'docs', 'doc.pdf'), '%PDF-');
    await makeTextFile(path.join(tempRoot, 'audio', 'a.ogg'), 'OggS');
    await makeTextFile(path.join(tempRoot, 'bundles', 'b.unity3d'), 'UnityFS');
  }

  async function expectObjectInvalid(entry: ImportManifest['objects'][number]): Promise<void> {
    await writePackYaml(tempRoot, packYamlFixture());
    await makeObjectSources();
    const manifestPath = await writeManifest(
      { schema_version: 1, pack: PACK_NAME, decks: [], objects: [entry] },
      path.join(tempRoot, 'import.yaml'),
    );
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath }), 'IMPORT_INVALID');
  }

  it('以图为主的类型缺 image → IMPORT_INVALID', async () => {
    for (const type of ['tile', 'decal', 'notecard', 'sky', 'table', 'token', 'board', 'pawn', 'counter']) {
      await expectObjectInvalid({ type, name: `物-${type}`, diffuse: './textures/d.png' });
    }
  });

  it('模型类类型缺 mesh → IMPORT_INVALID', async () => {
    for (const type of ['figurine', 'model', 'dice']) {
      await expectObjectInvalid({ type, name: `物-${type}`, diffuse: './textures/d.png' });
    }
  });

  it('pdf / audio / assetbundle 类型缺各自文件 → IMPORT_INVALID', async () => {
    await expectObjectInvalid({ type: 'pdf', name: '规则书' });
    await expectObjectInvalid({ type: 'audio', name: '背景乐' });
    await expectObjectInvalid({ type: 'assetbundle', name: '模组' });
  });

  it('条目未提供任何文件字段 → IMPORT_INVALID', async () => {
    await expectObjectInvalid({ type: 'other', name: '空物件' });
  });

  it('开放类型（未注册）带 image 可导入：type 原样保留 + 未注册告警（文案走 t()）', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    await makeObjectSources();
    const manifestPath = await writeManifest(
      {
        schema_version: 1,
        pack: PACK_NAME,
        decks: [],
        objects: [{ type: 'mystery_type', name: '自定义物件', image: './tiles/a.png' }],
      },
      path.join(tempRoot, 'import.yaml'),
    );

    const result = await importAssets({ root: tempRoot, manifestPath });
    expect(result.objects[0]!.type).toBe('mystery_type');
    expect(result.warnings).toContain(t('import.warning.unregisteredType', { type: 'mystery_type', name: '自定义物件' }));
    const rows = await readObjectsCsv(path.join(tempRoot, 'objects'));
    expect(rows[0]!.type).toBe('mystery_type'); // 开放集合：原样保留，不改写
  });

  it('净化后重名的 (type, name) → IMPORT_INVALID', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    await makeObjectSources();
    const manifestPath = await writeManifest(
      {
        schema_version: 1,
        pack: PACK_NAME,
        decks: [],
        objects: [
          { type: 'tile', name: '板块 A', image: './tiles/a.png' },
          { type: 'tile', name: '板块_A', image: './tiles/a.png' },
        ],
      },
      path.join(tempRoot, 'import.yaml'),
    );
    await expectPackError(() => importAssets({ root: tempRoot, manifestPath }), 'IMPORT_INVALID');
  });
});

// ---------------------------------------------------------------------------
// objects：台账合并与 asset_id 稳定
// ---------------------------------------------------------------------------

describe('objects：台账合并与 asset_id 稳定', () => {
  it('新对象：落盘 objects/<type>s/<name>/、生成台账行（file / source / origin_asset_id）', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    await makeImage(path.join(tempRoot, 'tiles', 'a.png'));
    await makeTextFile(path.join(tempRoot, 'models', 'm.obj'), '# obj');
    await makeImage(path.join(tempRoot, 'textures', 'd.png'));
    const manifestPath = await writeManifest(
      {
        schema_version: 1,
        pack: PACK_NAME,
        decks: [],
        objects: [
          { type: 'tile', name: '板块A', image: './tiles/a.png' },
          { type: 'figurine', name: '船长', mesh: './models/m.obj', diffuse: './textures/d.png' },
        ],
      },
      path.join(tempRoot, 'import.yaml'),
    );

    const result = await importAssets({ root: tempRoot, manifestPath });
    expect(result.objectsCsvPath).toBe(path.join(tempRoot, 'objects', OBJECTS_CSV_FILENAME));

    // tile：主文件 → file 列；目录 = objects/tiles/板块A/
    const tile = result.objects[0]!;
    expect(existsSync(path.join(tile.dir, 'a.png'))).toBe(true);
    expect(tile.assetIdExisted).toBe(false);
    expect(tile.assetId).toMatch(/^imp-[0-9a-f]{8}$/);

    const rows = await readObjectsCsv(path.join(tempRoot, 'objects'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      assetId: tile.assetId,
      name: '板块A',
      type: 'tile',
      file: 'objects/tiles/板块A/a.png',
      source: './tiles/a.png',
    });
    expect(rows[0]!.originAssetId).toBeUndefined(); // 导入不写 origin_asset_id（窗口 C 裁决）
    expect(rows[1]).toMatchObject({
      type: 'figurine',
      name: '船长',
      file: 'objects/figurines/船长/m.obj',
      diffuse: 'objects/figurines/船长/d.png',
      source: './models/m.obj',
    });
    expect(existsSync(path.join(tempRoot, 'objects', 'figurines', '船长', 'm.obj'))).toBe(true);
    expect(existsSync(path.join(tempRoot, 'objects', 'figurines', '船长', 'd.png'))).toBe(true);
  });

  it('已有行按 (type, name) 复用 asset_id（永不改变），normal/collider 保留；导入不触碰 origin_asset_id', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    await makeImage(path.join(tempRoot, 'tiles', 'v2.png'));
    const objectsRoot = path.join(tempRoot, 'objects');
    const before: ObjectRow = {
      assetId: 'x001',
      name: '板块A',
      type: 'tile',
      file: 'objects/tiles/板块A/旧图.png',
      normal: 'old_normal.png',
      collider: 'old_collider.obj',
      source: './tiles/旧图.png',
      originAssetId: 'aaaaaaaaaaaaaaaa',
    };
    await writeObjectsCsv(objectsRoot, [before]);

    const manifestPath = await writeManifest(
      {
        schema_version: 1,
        pack: PACK_NAME,
        decks: [],
        objects: [{ type: 'tile', name: '板块A', image: './tiles/v2.png' }],
      },
      path.join(tempRoot, 'import.yaml'),
    );
    const result = await importAssets({ root: tempRoot, manifestPath });

    expect(result.objects[0]!.assetId).toBe('x001');
    expect(result.objects[0]!.assetIdExisted).toBe(true);
    const rows = await readObjectsCsv(objectsRoot);
    expect(rows).toHaveLength(1); // 合并而不是追加
    expect(rows[0]!.assetId).toBe('x001');
    expect(rows[0]!.file).toBe('objects/tiles/板块A/v2.png');
    expect(rows[0]!.source).toBe('./tiles/v2.png');
    expect(rows[0]!.normal).toBe('old_normal.png'); // 不归导入管的列原样保留
    expect(rows[0]!.collider).toBe('old_collider.obj');
    // 导入不写 origin_asset_id：已有行的旧值原样保留（...existingRow 展开），不改不重算
    expect(rows[0]!.originAssetId).toBe('aaaaaaaaaaaaaaaa');
    // 新图复制进同一目录
    expect(existsSync(path.join(tempRoot, 'objects', 'tiles', '板块A', 'v2.png'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 路径解析基准与包名提示
// ---------------------------------------------------------------------------

describe('路径解析基准与包名提示', () => {
  it('相对路径相对清单所在目录解析；源可在工作区之外；落盘在工作区内', async () => {
    const wsRoot = path.join(tempRoot, 'ws');
    await mkdir(wsRoot, { recursive: true });
    await writePackYaml(wsRoot, packYamlFixture());
    // 清单在 <temp>/plans/，素材在 <temp>/materials/（ws 之外）
    await makeCardImages(path.join(tempRoot, 'materials', 'cards'), ['a.png']);
    await makeImage(path.join(wsRoot, '背面.png'));
    const manifestPath = await writeManifest(
      {
        schema_version: 1,
        pack: PACK_NAME,
        decks: [{ name: '军争', back: 'common', back_file: '../ws/背面.png', cards_dir: '../materials/cards' }],
        objects: [],
      },
      path.join(tempRoot, 'plans', 'import.yaml'),
    );

    const result = await importAssets({ root: wsRoot, manifestPath });
    expect(result.warnings).toEqual([]);
    expect(existsSync(path.join(wsRoot, 'decks', '军争', 'a.png'))).toBe(true);
    expect(existsSync(path.join(wsRoot, 'decks', '军争', '背面.png'))).toBe(true);
    expect(result.decks[0]!.cards[0]!.sheetSource).toBe('../materials/cards/a.png');
  });

  it('pack 名与 pack.yaml 不一致 → warning（不阻断）；root 缺 pack.yaml → warning', async () => {
    // 名字不一致
    await writePackYaml(tempRoot, packYamlFixture('另一个包'));
    await makeCardImages(path.join(tempRoot, 'cards'), ['a.png']);
    const p1 = await writeManifest(
      deckManifest('./cards', { back: 'none', back_file: undefined }),
      path.join(tempRoot, 'm1.yaml'),
    );
    const r1 = await importAssets({ root: tempRoot, manifestPath: p1 });
    expect(r1.warnings).toContain(
      t('import.warning.packNameMismatch', { manifestPack: PACK_NAME, packName: '另一个包' }),
    );

    // 没有 pack.yaml
    const wsRoot = path.join(tempRoot, 'ws2');
    await mkdir(wsRoot, { recursive: true });
    const r2 = await importAssets({ root: wsRoot, manifestPath: p1 });
    expect(r2.warnings).toContain(t('import.warning.packYamlMissing', { root: wsRoot }));
  });

  it('cards_dir 里的非图片文件跳过并告警（不静默丢弃），导入继续', async () => {
    await writePackYaml(tempRoot, packYamlFixture());
    const cardsDir = path.join(tempRoot, 'cards');
    await makeCardImages(cardsDir, ['a.png']);
    await writeFile(path.join(cardsDir, 'Thumbs.db'), 'db', 'utf8');
    await mkdir(path.join(cardsDir, '子目录'), { recursive: true });
    const manifestPath = await writeManifest(
      deckManifest('./cards', { back: 'none', back_file: undefined }),
      path.join(tempRoot, 'import.yaml'),
    );

    const result = await importAssets({ root: tempRoot, manifestPath });
    expect(result.decks[0]!.skippedFiles).toEqual(['Thumbs.db', '子目录']);
    expect(result.decks[0]!.cards).toHaveLength(1);
    expect(result.warnings).toContain(
      t('import.warning.skippedFiles', { deck: '军争', files: 'Thumbs.db、子目录' }),
    );
  });
});
