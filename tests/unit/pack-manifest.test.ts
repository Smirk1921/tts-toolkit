// tests/unit/pack-manifest.test.ts
/**
 * src/pack/manifest.ts 单元测试：deck.yaml / assets.yaml 的读写与校验。
 *
 * 纯文件 IO（临时目录），无网络、无 TTS 依赖：
 * - 正常路径：write → read 往返一致，缺省字段填充（shared_with → []）；
 * - 异常路径：按 PackError.code（机器可读）断言，不依赖错误文案——
 *   文案走 t()，locales/*.json 由 Run 2 补齐，补齐前后 message 不同；
 * - 边界值：id 0/68、columns 1/10、rows 1/7、guid 大小写。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ASSETS_YAML_FILENAME,
  DECK_YAML_FILENAME,
  readAssetsManifest,
  readDeckManifest,
  writeAssetsManifest,
  writeDeckManifest,
  type AssetsManifest,
  type DeckManifest,
} from '../../src/pack/manifest.js';
import { PackError } from '../../src/pack/packyaml.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-manifest-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 合法且字段齐全的 deck 清单（各字段覆盖：shared_with 非空、atlas 存在、可选字段齐全） */
const fullDeck: DeckManifest = {
  schema_version: 1,
  name: '军争包',
  guid: 'a1b2c3',
  shared_with: ['d4e5f6', '0f1e2d'],
  cards: [
    { id: 0, face: 'card-000.png', back: 'back-custom.png', name: '杀', nickname: 'Slash' },
    { id: 68, face: 'card-068.png' },
  ],
  atlas: { size: '1024', columns: 10, rows: 7 },
};

/** 合法且字段齐全的 assets 清单 */
const fullAssets: AssetsManifest = {
  schema_version: 1,
  assets: [
    { file: 'decks/军争包/card-000.png', url: 'https://example.com/a.png', sha256: 'deadbeef', host: 'imgur' },
    { file: 'objects/chess/board.png', url: 'https://example.com/b.jpg' },
  ],
};

/**
 * 断言 fn 抛出指定 code 的 PackError，并返回该错误。
 * @param fn 待执行（预期抛 PackError）的异步函数
 * @param code 期望的机器可读错误码
 * @returns 实际抛出的 PackError（可对 message 做进一步断言）
 */
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

/** 在 deck 子目录直接写一份 YAML（绕过 writeDeckManifest，用于构造"手改的坏文件"） */
async function writeRawDeckYaml(deckDir: string, text: string): Promise<void> {
  await mkdir(deckDir, { recursive: true });
  await writeFile(path.join(deckDir, DECK_YAML_FILENAME), text, 'utf8');
}

/** 在图包根目录直接写一份 assets.yaml */
async function writeRawAssetsYaml(text: string): Promise<void> {
  await writeFile(path.join(tempRoot, ASSETS_YAML_FILENAME), text, 'utf8');
}

// ---------------------------------------------------------------------------
// deck.yaml
// ---------------------------------------------------------------------------

describe('deck.yaml 常量与类型', () => {
  it('导出 DECK_YAML_FILENAME / ASSETS_YAML_FILENAME', () => {
    expect(DECK_YAML_FILENAME).toBe('deck.yaml');
    expect(ASSETS_YAML_FILENAME).toBe('assets.yaml');
  });

  it('DeckManifest 类型：shared_with 必填（读取时才由缺省值填充）', () => {
    // 编译通过即代表输出类型里 shared_with 是必填字段
    const m: DeckManifest = { schema_version: 1, name: 'x', guid: 'aabbcc', shared_with: [], cards: [] };
    expect(m.shared_with).toEqual([]);
    expect(m.atlas).toBeUndefined();
  });

  it('AssetsManifest 类型：sha256 / host 可缺省', () => {
    const m: AssetsManifest = { schema_version: 1, assets: [{ file: 'a.png', url: 'https://e.com/a.png' }] };
    expect(m.assets[0]?.sha256).toBeUndefined();
    expect(m.assets[0]?.host).toBeUndefined();
  });
});

describe('writeDeckManifest → readDeckManifest 往返', () => {
  it('字段齐全的清单往返一致（含 atlas / back / nickname / shared_with）', async () => {
    const deckDir = path.join(tempRoot, 'decks', '军争包');
    await writeDeckManifest(deckDir, fullDeck);
    const read = await readDeckManifest(deckDir);
    expect(read).toEqual(fullDeck);
  });

  it('deckDir 不存在时自动逐级创建', async () => {
    const deepDir = path.join(tempRoot, 'decks', '嵌套', '层级', 'deck');
    await writeDeckManifest(deepDir, fullDeck);
    expect(existsSync(path.join(deepDir, DECK_YAML_FILENAME))).toBe(true);
  });

  it('可选字段为 undefined 时不落盘（不会写出 back: null）', async () => {
    const deckDir = path.join(tempRoot, 'decks', 'd');
    const withUndefined: DeckManifest = {
      schema_version: 1,
      name: 'x',
      guid: 'aabbcc',
      shared_with: [],
      cards: [{ id: 1, face: 'a.png', back: undefined, nickname: undefined }],
    };
    await writeDeckManifest(deckDir, withUndefined);
    const read = await readDeckManifest(deckDir);
    expect(read.cards[0]?.back).toBeUndefined();
    expect(read.cards[0]?.nickname).toBeUndefined();
    const raw = await readFile(path.join(deckDir, DECK_YAML_FILENAME), 'utf8');
    expect(raw).not.toContain('null');
  });
});

describe('readDeckManifest：缺省值与边界值', () => {
  it('YAML 缺省 shared_with / atlas / back 时填充缺省值（shared_with → []）', async () => {
    const deckDir = path.join(tempRoot, 'decks', 'd');
    await writeRawDeckYaml(
      deckDir,
      ['schema_version: 1', 'name: 基础牌堆', "guid: 'a1b2c3'", 'cards:', '  - id: 3', '    face: c3.png', ''].join('\n'),
    );
    const m = await readDeckManifest(deckDir);
    expect(m.shared_with).toEqual([]);
    expect(m.atlas).toBeUndefined();
    expect(m.cards[0]?.back).toBeUndefined();
    expect(m.cards[0]?.name).toBeUndefined();
  });

  it('guid 大写十六进制合法（不区分大小写，原样保留）', async () => {
    const deckDir = path.join(tempRoot, 'decks', 'd');
    await writeRawDeckYaml(
      deckDir,
      ['schema_version: 1', 'name: x', 'guid: A1B2C3', 'shared_with: []', 'cards: []', ''].join('\n'),
    );
    const m = await readDeckManifest(deckDir);
    expect(m.guid).toBe('A1B2C3');
  });

  it('id / columns / rows 的合法边界值（0、68 / 1、10 / 1、7）', async () => {
    const deckDir = path.join(tempRoot, 'decks', 'd');
    await writeDeckManifest(deckDir, {
      schema_version: 1,
      name: '边界',
      guid: 'aabbcc',
      shared_with: [],
      cards: [{ id: 0, face: 'a.png' }, { id: 68, face: 'b.png' }],
      atlas: { size: '4096', columns: 1, rows: 1 },
    });
    await expect(readDeckManifest(deckDir)).resolves.toMatchObject({
      cards: [{ id: 0 }, { id: 68 }],
      atlas: { size: '4096', columns: 1, rows: 1 },
    });
    await writeDeckManifest(deckDir, {
      ...fullDeck,
      atlas: { size: '512', columns: 10, rows: 7 },
    });
    await expect(readDeckManifest(deckDir)).resolves.toMatchObject({
      atlas: { size: '512', columns: 10, rows: 7 },
    });
  });
});

describe('readDeckManifest：错误路径', () => {
  it('deck.yaml 不存在 → PackError code="DECK_NOT_FOUND"', async () => {
    const err = await expectPackError(() => readDeckManifest(path.join(tempRoot, 'no-such-deck')), 'DECK_NOT_FOUND');
    // 文案走 t()：locales 键由 Run 2 补齐——补齐前 message 是键名原样输出，
    // 补齐后应含文件名。断言两种状态都接受（错误码已由 expectPackError 断言）。
    expect(err.message === 'error.pack.deckNotFound' || err.message.includes(DECK_YAML_FILENAME)).toBe(true);
  });

  it('不是合法 YAML → DECK_INVALID', async () => {
    const deckDir = path.join(tempRoot, 'd');
    await writeRawDeckYaml(deckDir, 'schema_version: 1\nname: [未闭合\n');
    await expectPackError(() => readDeckManifest(deckDir), 'DECK_INVALID');
  });

  it('根不是键值对象（数组 / 空）→ DECK_INVALID', async () => {
    const deckDir = path.join(tempRoot, 'd');
    await writeRawDeckYaml(deckDir, '- a\n- b\n');
    await expectPackError(() => readDeckManifest(deckDir), 'DECK_INVALID');
    await writeRawDeckYaml(deckDir, '');
    await expectPackError(() => readDeckManifest(deckDir), 'DECK_INVALID');
  });

  const badDecks: Array<[string, string]> = [
    ['schema_version 不是 1', 'schema_version: 2\nname: x\nguid: a1b2c3\ncards: []'],
    ['guid 非十六进制', 'schema_version: 1\nname: x\nguid: xyzabc\ncards: []'],
    ['guid 位数不足', 'schema_version: 1\nname: x\nguid: abc12\ncards: []'],
    ['缺 name', 'schema_version: 1\nguid: a1b2c3\ncards: []'],
    ['缺 cards', 'schema_version: 1\nname: x\nguid: a1b2c3'],
    ['cards 不是数组', 'schema_version: 1\nname: x\nguid: a1b2c3\ncards: 3'],
    ['卡牌 id 超上限', 'schema_version: 1\nname: x\nguid: a1b2c3\ncards:\n  - id: 69\n    face: a.png'],
    ['卡牌 id 为负', 'schema_version: 1\nname: x\nguid: a1b2c3\ncards:\n  - id: -1\n    face: a.png'],
    ['卡牌 id 非整数', 'schema_version: 1\nname: x\nguid: a1b2c3\ncards:\n  - id: 1.5\n    face: a.png'],
    ['卡牌缺 face', 'schema_version: 1\nname: x\nguid: a1b2c3\ncards:\n  - id: 1'],
    ['根含未知字段', 'schema_version: 1\nname: x\nguid: a1b2c3\ncards: []\nnaem: 拼写错误'],
    ['卡牌条目含未知字段', 'schema_version: 1\nname: x\nguid: a1b2c3\ncards:\n  - id: 1\n    face: a.png\n    font: x'],
    ['atlas.size 是数字而非字符串', 'schema_version: 1\nname: x\nguid: a1b2c3\ncards: []\natlas:\n  size: 1024\n  columns: 1\n  rows: 1'],
    ['atlas.size 非法值', 'schema_version: 1\nname: x\nguid: a1b2c3\ncards: []\natlas:\n  size: "256"\n  columns: 1\n  rows: 1'],
    ['atlas.columns 超上限', 'schema_version: 1\nname: x\nguid: a1b2c3\ncards: []\natlas:\n  size: "512"\n  columns: 11\n  rows: 1'],
    ['atlas.columns 为 0', 'schema_version: 1\nname: x\nguid: a1b2c3\ncards: []\natlas:\n  size: "512"\n  columns: 0\n  rows: 1'],
    ['atlas.rows 超上限', 'schema_version: 1\nname: x\nguid: a1b2c3\ncards: []\natlas:\n  size: "512"\n  columns: 1\n  rows: 8'],
    ['atlas.rows 为 0', 'schema_version: 1\nname: x\nguid: a1b2c3\ncards: []\natlas:\n  size: "512"\n  columns: 1\n  rows: 0'],
    ['atlas 含未知字段', 'schema_version: 1\nname: x\nguid: a1b2c3\ncards: []\natlas:\n  size: "512"\n  columns: 1\n  rows: 1\n  dpi: 300'],
  ];

  for (const [label, yamlText] of badDecks) {
    it(`schema 违例 → DECK_INVALID：${label}`, async () => {
      const deckDir = path.join(tempRoot, 'd');
      await writeRawDeckYaml(deckDir, `${yamlText}\n`);
      const err = await expectPackError(() => readDeckManifest(deckDir), 'DECK_INVALID');
      // 问题摘要应含字段路径（如 cards.0.id），便于定位手改 YAML 的错误
      expect(err.message.length).toBeGreaterThan(0);
    });
  }

  it('deckDir 入参为空串 → 普通 Error（编程错误，非 PackError）', async () => {
    await expect(readDeckManifest('')).rejects.toThrow(/必须是非空字符串路径/);
    await expect(writeDeckManifest('', fullDeck)).rejects.toThrow(/必须是非空字符串路径/);
  });
});

describe('writeDeckManifest：写前校验', () => {
  it('入参不合规 → DECK_INVALID 且不落盘', async () => {
    const deckDir = path.join(tempRoot, 'd');
    const bad = { ...fullDeck, guid: 'not-hex' } as unknown as DeckManifest;
    await expectPackError(() => writeDeckManifest(deckDir, bad), 'DECK_INVALID');
    expect(existsSync(path.join(deckDir, DECK_YAML_FILENAME))).toBe(false);
  });

  it('落盘内容是合法 YAML 文本（含 schema_version: 1 与 guid）', async () => {
    const deckDir = path.join(tempRoot, 'd');
    await writeDeckManifest(deckDir, fullDeck);
    const raw = await readFile(path.join(deckDir, DECK_YAML_FILENAME), 'utf8');
    expect(raw).toContain('schema_version: 1');
    expect(raw).toContain('guid: a1b2c3');
    expect(raw).toContain('name: 军争包');
  });
});

// ---------------------------------------------------------------------------
// assets.yaml
// ---------------------------------------------------------------------------

describe('readAssetsManifest', () => {
  it('文件不存在 → 返回 null（不抛错）', async () => {
    await expect(readAssetsManifest(tempRoot)).resolves.toBeNull();
  });

  it('字段齐全的清单往返一致（含 sha256 / host；host 缺省时为 undefined）', async () => {
    await writeAssetsManifest(tempRoot, fullAssets);
    const read = await readAssetsManifest(tempRoot);
    expect(read).toEqual(fullAssets);
    expect(read?.assets[1]?.sha256).toBeUndefined();
    expect(read?.assets[1]?.host).toBeUndefined();
  });

  it('不是合法 YAML → ASSETS_INVALID', async () => {
    await writeRawAssetsYaml('assets: [未闭合\n');
    await expectPackError(() => readAssetsManifest(tempRoot), 'ASSETS_INVALID');
  });

  const badAssets: Array<[string, string]> = [
    ['schema_version 不是 1', 'schema_version: 2\nassets: []'],
    ['缺 assets', 'schema_version: 1'],
    ['assets 不是数组', 'schema_version: 1\nassets: 3'],
    ['url 非法', 'schema_version: 1\nassets:\n  - file: a.png\n    url: not-a-url'],
    ['host 非法', 'schema_version: 1\nassets:\n  - file: a.png\n    url: https://e.com/a.png\n    host: weibo'],
    ['缺 file', 'schema_version: 1\nassets:\n  - url: https://e.com/a.png'],
    ['缺 url', 'schema_version: 1\nassets:\n  - file: a.png'],
    ['条目含未知字段', 'schema_version: 1\nassets:\n  - file: a.png\n    url: https://e.com/a.png\n    sha: xx'],
    ['根含未知字段', 'schema_version: 1\nassets: []\nasset: 拼写错误'],
  ];

  for (const [label, yamlText] of badAssets) {
    it(`schema 违例 → ASSETS_INVALID：${label}`, async () => {
      await writeRawAssetsYaml(`${yamlText}\n`);
      await expectPackError(() => readAssetsManifest(tempRoot), 'ASSETS_INVALID');
    });
  }

  it('assets 为空数组合法', async () => {
    await writeRawAssetsYaml('schema_version: 1\nassets: []\n');
    await expect(readAssetsManifest(tempRoot)).resolves.toEqual({ schema_version: 1, assets: [] });
  });

  it('root 入参为空串 → 普通 Error（编程错误，非 PackError）', async () => {
    await expect(readAssetsManifest('')).rejects.toThrow(/必须是非空字符串路径/);
    await expect(writeAssetsManifest('', fullAssets)).rejects.toThrow(/必须是非空字符串路径/);
  });
});

describe('writeAssetsManifest', () => {
  it('root 不存在时自动逐级创建，落盘文本含 schema_version: 1', async () => {
    const root = path.join(tempRoot, 'packs', '新图包');
    await writeAssetsManifest(root, fullAssets);
    const raw = await readFile(path.join(root, ASSETS_YAML_FILENAME), 'utf8');
    expect(raw).toContain('schema_version: 1');
    expect(raw).toContain('assets:');
  });

  it('入参不合规 → ASSETS_INVALID 且不落盘', async () => {
    const root = path.join(tempRoot, 'p');
    const bad = { ...fullAssets, assets: [{ file: 'a.png', url: 'nope' }] } as unknown as AssetsManifest;
    await expectPackError(() => writeAssetsManifest(root, bad), 'ASSETS_INVALID');
    expect(existsSync(path.join(root, ASSETS_YAML_FILENAME))).toBe(false);
  });
});
