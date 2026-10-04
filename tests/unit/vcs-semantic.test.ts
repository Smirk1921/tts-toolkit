// tests/unit/vcs-semantic.test.ts
/**
 * src/vcs/semantic.ts 单元测试：语义化状态分析。
 *
 * 真实 git 子进程（execa 在 os.tmpdir() 的临时目录里跑 git init / add / commit /
 * mv），用 writeCardsCsv / writeObjectsCsv 造合法卡表与素材台账，覆盖：
 * - 空仓库 / 干净仓库 / 非 git 目录；
 * - deck-cards 反查（单卡、多卡截断、背面、多牌堆、中文空格文件名、
 *   cards.csv 缺失 / 表头损坏 / 文件不在表中 → unknown 降级）；
 * - deck-cards-csv / deck-yaml；
 * - script / ui（Global 与 <guid>.<name>、行数 numstat 与兜底、删除、rename、散落文件）；
 * - object-asset（命中 / 未命中 / objects.csv 缺失）；
 * - pack-yaml / metadata；
 * - 未跟踪目录展开、xy 合并、unknownCount 口径、大改动量（50 / 1001 个文件）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readCardsCsv, writeCardsCsv } from '../../src/deck/cards.js';
import type { CardRow } from '../../src/deck/cards.js';
import { writeObjectsCsv } from '../../src/deck/objects.js';
import type { ObjectRow } from '../../src/deck/objects.js';
import { PackError } from '../../src/pack/packyaml.js';
import { analyzeStatus } from '../../src/vcs/semantic.js';
import type { SemanticChange, SemanticChangeKind, SemanticStatus } from '../../src/vcs/semantic.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-semantic-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 两个内容不同的"伪 PNG"字节串（git 视为二进制，足以让工作区修改被识别） */
const PNG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const PNG_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x02]);

/**
 * 在指定目录跑 git 命令，失败即抛（测试夹具自身用，不走被测代码）。
 * @param args git 参数（不含 "git"）
 * @param cwd 工作目录，默认 tempRoot
 */
async function git(args: string[], cwd: string = tempRoot): Promise<void> {
  const result = await execa('git', args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
  }
}

/** 初始化一个带提交者身份、固定分支名、关闭 autocrlf 的测试仓库 */
async function initRepo(dir: string = tempRoot): Promise<void> {
  await git(['init', '-b', 'main'], dir);
  await git(['config', 'user.email', 'test@test.local'], dir);
  await git(['config', 'user.name', 'tester'], dir);
  await git(['config', 'core.autocrlf', 'false'], dir);
}

/** git add -A + commit（提交当前全部改动） */
async function commitAll(message: string, dir: string = tempRoot): Promise<void> {
  await git(['add', '-A'], dir);
  await git(['commit', '-m', message], dir);
}

/** 卡牌夹具规格 */
interface CardSpec {
  cardId: number;
  face: string;
  back?: string;
  name?: string;
}

/** 把卡牌规格转成合法 CardRow（slot === cardId % 100，10×7 图集） */
function cardRow(spec: CardSpec): CardRow {
  const row: CardRow = {
    cardId: spec.cardId,
    face: spec.face,
    sheetId: 1,
    slot: spec.cardId % 100 === 0 ? 100 : spec.cardId % 100,
    sheetCols: 10,
    sheetRows: 7,
    sheetSource: 'http://example.invalid/sheet1.png',
  };
  if (spec.back !== undefined) {
    row.back = spec.back;
  }
  if (spec.name !== undefined) {
    row.name = spec.name;
  }
  return row;
}

/**
 * 写一个完整牌堆目录：deck.yaml + cards.csv + 每张卡的正面（及背面）图片。
 * @param deckName 牌堆目录名
 * @param cards 卡牌列表
 * @returns 牌堆目录绝对路径
 */
async function writeDeck(deckName: string, cards: CardSpec[]): Promise<string> {
  const deckDir = path.join(tempRoot, 'decks', deckName);
  await mkdir(deckDir, { recursive: true });
  await writeFile(
    path.join(deckDir, 'deck.yaml'),
    `schema_version: 1\nname: ${deckName}\nguid: ab12cd\nshared_with: []\n`,
    'utf8',
  );
  await writeCardsCsv(deckDir, cards.map(cardRow));
  for (const card of cards) {
    await writeFile(path.join(deckDir, card.face), PNG_A);
    if (card.back !== undefined) {
      await writeFile(path.join(deckDir, card.back), PNG_A);
    }
  }
  return deckDir;
}

/**
 * 写 pack 根 objects.csv（素材台账）。
 * @param rows 素材列表（file 为相对 pack 根路径，如 "objects/chess.png"）
 */
async function writeObjectsLedger(rows: Array<{ assetId: string; file: string }>): Promise<void> {
  const objectRows: ObjectRow[] = rows.map((row) => ({
    assetId: row.assetId,
    type: 'piece',
    file: row.file,
    source: 'http://example.invalid/obj',
  }));
  await writeObjectsCsv(tempRoot, objectRows);
}

/** 写一个对象素材文件（伪 PNG 二进制） */
async function writeObjectFile(relPath: string, bytes: Buffer = PNG_A): Promise<void> {
  await mkdir(path.dirname(path.join(tempRoot, relPath)), { recursive: true });
  await writeFile(path.join(tempRoot, relPath), bytes);
}

/** 在临时仓库里写一个 Lua 脚本文件 */
async function writeScript(relPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(tempRoot, relPath)), { recursive: true });
  await writeFile(path.join(tempRoot, relPath), content, 'utf8');
}

/**
 * 从语义化结果里按 kind + subject 找一条改动。
 * @param status analyzeStatus 结果
 * @param kind 类别
 * @param subject 主体；省略时要求 subject 为 undefined（如 metadata / pack-yaml）
 */
function changeOf(
  status: SemanticStatus,
  kind: SemanticChangeKind,
  subject?: string,
): SemanticChange {
  const found = status.changes.find(
    (change) => change.kind === kind && (subject === undefined ? change.subject === undefined : change.subject === subject),
  );
  expect(found).toBeDefined();
  return found as SemanticChange;
}

/** 断言 fn 抛出指定 code 的 PackError，并返回该错误供进一步断言 */
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

// ---------------------------------------------------------------------------
// 空仓库与错误路径
// ---------------------------------------------------------------------------

describe('空仓库与错误路径', () => {
  it('刚 init 的空仓库：dirty=false，changes=[]，unknownCount=0', async () => {
    await initRepo();
    const status = await analyzeStatus(tempRoot);
    expect(status).toEqual({ dirty: false, changes: [], unknownCount: 0 });
  });

  it('干净仓库（全部提交后）：dirty=false，changes=[]', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [{ cardId: 101, face: '001_正面.png' }]);
    await writeObjectsLedger([{ assetId: 'obj001', file: 'objects/chess.png' }]);
    await writeObjectFile('objects/chess.png');
    await writeFile(path.join(tempRoot, 'pack.yaml'), 'schema_version: 1\nname: 测试包\n', 'utf8');
    await commitAll('init');
    const status = await analyzeStatus(tempRoot);
    expect(status.dirty).toBe(false);
    expect(status.changes).toEqual([]);
    expect(status.unknownCount).toBe(0);
  });

  it('非 git 目录：抛 PackError code=GIT_NOT_A_REPO', async () => {
    await expectPackError(() => analyzeStatus(tempRoot), 'GIT_NOT_A_REPO');
  });
});

// ---------------------------------------------------------------------------
// deck-cards：卡牌换图反查
// ---------------------------------------------------------------------------

describe('deck-cards：卡牌换图反查', () => {
  it('单 deck 单卡改动：kind/subject/cardCount/summary/xy 齐全', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [
      { cardId: 101, face: '001_正面.png' },
      { cardId: 102, face: '002_正面.png' },
    ]);
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '002_正面.png'), PNG_B);

    const status = await analyzeStatus(tempRoot);
    expect(status.dirty).toBe(true);
    expect(status.changes).toHaveLength(1);
    const change = changeOf(status, 'deck-cards', '冒险牌堆');
    expect(change.cardCount).toBe(1);
    expect(change.cardFiles).toEqual(['002_正面.png']);
    expect(change.paths).toEqual(['decks/冒险牌堆/002_正面.png']);
    expect(change.xy).toBe(' M');
    expect(change.summary).toBe('冒险牌堆 1 张卡换图（002_正面.png）');
    // 二进制改动：不数行
    expect(change.added).toBeUndefined();
    expect(change.deleted).toBeUndefined();
    expect(status.unknownCount).toBe(0);
  });

  it('单 deck 多卡改动：cardCount 汇总，summary 列出全部无省略号', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [
      { cardId: 101, face: '001_正面.png' },
      { cardId: 102, face: '002_正面.png' },
      { cardId: 103, face: '003_正面.png' },
    ]);
    await commitAll('init');
    for (const name of ['001_正面.png', '002_正面.png', '003_正面.png']) {
      await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', name), PNG_B);
    }

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(1);
    const change = changeOf(status, 'deck-cards', '冒险牌堆');
    expect(change.cardCount).toBe(3);
    expect(change.cardFiles).toEqual(['001_正面.png', '002_正面.png', '003_正面.png']);
    expect(change.summary).toBe('冒险牌堆 3 张卡换图（001_正面.png, 002_正面.png, 003_正面.png）');
  });

  it('单 deck 6 卡改动：cardFiles 截断到 5 个，summary 以 … 结尾且计数为 6', async () => {
    await initRepo();
    const faces = ['001_正面.png', '002_正面.png', '003_正面.png', '004_正面.png', '005_正面.png', '006_正面.png'];
    await writeDeck('冒险牌堆', faces.map((face, i) => ({ cardId: 101 + i, face })));
    await commitAll('init');
    for (const name of faces) {
      await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', name), PNG_B);
    }

    const status = await analyzeStatus(tempRoot);
    const change = changeOf(status, 'deck-cards', '冒险牌堆');
    expect(change.cardCount).toBe(6);
    expect(change.cardFiles).toEqual(faces.slice(0, 5));
    expect(change.summary).toBe(
      `冒险牌堆 6 张卡换图（${faces.slice(0, 5).join(', ')}…）`,
    );
  });

  it('多 deck 混合改动：各自汇总，互不串组', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [{ cardId: 101, face: '001_正面.png' }]);
    await writeDeck('技能牌堆', [{ cardId: 101, face: '001_正面.png' }]);
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '001_正面.png'), PNG_B);
    await writeFile(path.join(tempRoot, 'decks', '技能牌堆', '001_正面.png'), PNG_B);

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(2);
    expect(changeOf(status, 'deck-cards', '冒险牌堆').cardCount).toBe(1);
    expect(changeOf(status, 'deck-cards', '技能牌堆').cardCount).toBe(1);
    expect(status.unknownCount).toBe(0);
  });

  it('背面图片改动（back 列命中）：也算卡牌换图', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [{ cardId: 101, face: '001_正面.png', back: '001_背面.png' }]);
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '001_背面.png'), PNG_B);

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(1);
    const change = changeOf(status, 'deck-cards', '冒险牌堆');
    expect(change.cardFiles).toEqual(['001_背面.png']);
    expect(change.summary).toBe('冒险牌堆 1 张卡换图（001_背面.png）');
  });

  it('cards.csv 缺失：图片改动降级 unknown，不抛错', async () => {
    await initRepo();
    const deckDir = path.join(tempRoot, 'decks', '孤儿牌堆');
    await mkdir(deckDir, { recursive: true });
    await writeFile(path.join(deckDir, '001_正面.png'), PNG_A);
    await commitAll('init');
    await writeFile(path.join(deckDir, '001_正面.png'), PNG_B);

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(1);
    const change = changeOf(status, 'unknown');
    expect(change.paths).toEqual(['decks/孤儿牌堆/001_正面.png']);
    expect(change.summary).toBe('其他改动（1 个文件）');
    expect(status.unknownCount).toBe(1);
  });

  it('cards.csv 存在但 face/back 都不含该文件：unknown', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [{ cardId: 101, face: '001_正面.png' }]);
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '999_其他.png'), PNG_B);

    const status = await analyzeStatus(tempRoot);
    expect(changeOf(status, 'unknown').paths).toEqual(['decks/冒险牌堆/999_其他.png']);
    expect(status.unknownCount).toBe(1);
  });

  it('cards.csv 表头损坏（解析失败）：降级 unknown 不抛错', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [{ cardId: 101, face: '001_正面.png' }]);
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', 'cards.csv'), 'id,image\n1,x.png\n', 'utf8');
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '001_正面.png'), PNG_B);

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(2); // 图片 → unknown；cards.csv 本身 → deck-cards-csv
    expect(changeOf(status, 'unknown').paths).toEqual(['decks/冒险牌堆/001_正面.png']);
    expect(changeOf(status, 'deck-cards-csv', '冒险牌堆')).toBeDefined();
    expect(status.unknownCount).toBe(1);
  });

  it('中文与空格文件名：cardFiles 与 paths 原样保留', async () => {
    await initRepo();
    await writeDeck('技能 牌堆', [{ cardId: 101, face: '闪卡 01 正面.png' }]);
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '技能 牌堆', '闪卡 01 正面.png'), PNG_B);

    const status = await analyzeStatus(tempRoot);
    const change = changeOf(status, 'deck-cards', '技能 牌堆');
    expect(change.cardFiles).toEqual(['闪卡 01 正面.png']);
    expect(change.paths).toEqual(['decks/技能 牌堆/闪卡 01 正面.png']);
    expect(change.summary).toBe('技能 牌堆 1 张卡换图（闪卡 01 正面.png）');
  });

  it('不同 deck 的同名卡面文件：按 deckName 分成两条', async () => {
    await initRepo();
    await writeDeck('甲牌堆', [{ cardId: 101, face: '001_正面.png' }]);
    await writeDeck('乙牌堆', [{ cardId: 101, face: '001_正面.png' }]);
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '甲牌堆', '001_正面.png'), PNG_B);
    await writeFile(path.join(tempRoot, 'decks', '乙牌堆', '001_正面.png'), PNG_B);

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(2);
    expect(changeOf(status, 'deck-cards', '甲牌堆').cardFiles).toEqual(['001_正面.png']);
    expect(changeOf(status, 'deck-cards', '乙牌堆').cardFiles).toEqual(['001_正面.png']);
  });
});

// ---------------------------------------------------------------------------
// deck-cards-csv / deck-yaml / 未跟踪目录展开
// ---------------------------------------------------------------------------

describe('deck-cards-csv、deck-yaml 与未跟踪目录展开', () => {
  it('cards.csv 内容改动：deck-cards-csv，带 numstat 行数', async () => {
    await initRepo();
    const deckDir = await writeDeck('冒险牌堆', [
      { cardId: 101, face: '001_正面.png', name: '旧名' },
      { cardId: 102, face: '002_正面.png' },
    ]);
    await commitAll('init');
    const rows = await readCardsCsv(deckDir);
    rows[0].name = '新名';
    await writeCardsCsv(deckDir, rows);

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(1);
    const change = changeOf(status, 'deck-cards-csv', '冒险牌堆');
    expect(change.paths).toEqual(['decks/冒险牌堆/cards.csv']);
    expect(change.summary).toBe('冒险牌堆 卡表改动');
    expect(change.added).toBe(1);
    expect(change.deleted).toBe(1);
    expect(change.xy).toBe(' M');
  });

  it('deck.yaml 改动：deck-yaml', async () => {
    await initRepo();
    const deckDir = await writeDeck('冒险牌堆', [{ cardId: 101, face: '001_正面.png' }]);
    await commitAll('init');
    await writeFile(path.join(deckDir, 'deck.yaml'), 'schema_version: 1\nname: 冒险牌堆改\nguid: ab12cd\n', 'utf8');

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(1);
    const change = changeOf(status, 'deck-yaml', '冒险牌堆');
    expect(change.paths).toEqual(['decks/冒险牌堆/deck.yaml']);
    expect(change.summary).toBe('冒险牌堆 元数据改动');
    expect(change.xy).toBe(' M');
  });

  it('整体未跟踪的新牌堆目录：展开后按文件分类（卡片 / 卡表 / 元数据）', async () => {
    await initRepo();
    await writeDeck('新牌堆', [
      { cardId: 101, face: '001_正面.png' },
      { cardId: 102, face: '002_正面.png' },
    ]);
    // 不 add：git status 折叠成 "?? decks/新牌堆/"

    const status = await analyzeStatus(tempRoot);
    expect(status.dirty).toBe(true);
    expect(status.changes).toHaveLength(3);
    expect(changeOf(status, 'deck-cards', '新牌堆')).toMatchObject({
      subject: '新牌堆',
      cardCount: 2,
      xy: '??',
    });
    expect(changeOf(status, 'deck-cards-csv', '新牌堆').xy).toBe('??');
    expect(changeOf(status, 'deck-yaml', '新牌堆').xy).toBe('??');
    expect(status.unknownCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// script / ui
// ---------------------------------------------------------------------------

describe('script 与 ui', () => {
  it('scripts/Global.lua 工作区修改：subject=Global，numstat 行数进摘要', async () => {
    await initRepo();
    await writeScript('scripts/Global.lua', 'a\nb\n');
    await commitAll('init');
    await writeScript('scripts/Global.lua', 'a\nc\nd\n');

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(1);
    const change = changeOf(status, 'script', 'Global');
    expect(change.added).toBe(2);
    expect(change.deleted).toBe(1);
    expect(change.summary).toBe('Global 脚本 +2/-1 行');
    expect(change.xy).toBe(' M');
  });

  it('scripts/<guid>.<name>.lua：subject 取首个点之后的名字段', async () => {
    await initRepo();
    await writeScript('scripts/ab12cd.Chess_Pawn.lua', 'x\ny\n');
    await commitAll('init');
    await writeScript('scripts/ab12cd.Chess_Pawn.lua', 'x\nz\n');

    const status = await analyzeStatus(tempRoot);
    const change = changeOf(status, 'script', 'Chess_Pawn');
    expect(change.summary).toBe('Chess_Pawn 脚本 +1/-1 行');
  });

  it('ui/Global.xml：kind=ui，subject=Global', async () => {
    await initRepo();
    await writeScript('ui/Global.xml', '<UI>\n</UI>\n');
    await commitAll('init');
    await writeScript('ui/Global.xml', '<UI>\n<Panel />\n</UI>\n');

    const status = await analyzeStatus(tempRoot);
    const change = changeOf(status, 'ui', 'Global');
    expect(change.added).toBe(1);
    expect(change.deleted).toBe(0);
    expect(change.summary).toBe('Global UI +1/-0 行');
  });

  it('ui/<guid>.<name>.xml：kind=ui，subject=名字段', async () => {
    await initRepo();
    await writeScript('ui/ab12cd.Chess_Pawn.xml', '<a />\n');
    await commitAll('init');
    await writeScript('ui/ab12cd.Chess_Pawn.xml', '<b />\n');

    const status = await analyzeStatus(tempRoot);
    expect(changeOf(status, 'ui', 'Chess_Pawn').summary).toBe('Chess_Pawn UI +1/-1 行');
  });

  it('未跟踪的新脚本：git diff 无记录，按工作区行数记 added', async () => {
    await initRepo();
    await writeScript('scripts/Global.lua', 'x\ny\nz\n');
    // 不 add：xy 为 "??"

    const status = await analyzeStatus(tempRoot);
    const change = changeOf(status, 'script', 'Global');
    expect(change.xy).toBe('??');
    expect(change.added).toBe(3);
    expect(change.deleted).toBe(0);
    expect(change.summary).toBe('Global 脚本 +3/-0 行');
  });

  it('已暂存的新脚本（A ）：numstat 无记录，按工作区行数记 added', async () => {
    await initRepo();
    await writeScript('scripts/Global.lua', 'p\nq\n');
    await git(['add', 'scripts/Global.lua']);

    const status = await analyzeStatus(tempRoot);
    const change = changeOf(status, 'script', 'Global');
    expect(change.xy).toBe('A ');
    expect(change.added).toBe(2);
    expect(change.deleted).toBe(0);
    expect(change.summary).toBe('Global 脚本 +2/-0 行');
  });

  it('工作区删除脚本（ D）：numstat 计删除行数', async () => {
    await initRepo();
    await writeScript('scripts/Global.lua', 'l1\nl2\nl3\nl4\nl5\n');
    await commitAll('init');
    await rm(path.join(tempRoot, 'scripts', 'Global.lua'));

    const status = await analyzeStatus(tempRoot);
    const change = changeOf(status, 'script', 'Global');
    expect(change.xy).toBe(' D');
    expect(change.added).toBe(0);
    expect(change.deleted).toBe(5);
    expect(change.summary).toBe('Global 脚本 +0/-5 行');
  });

  it('同一对象的脚本与 UI 同时改动：分成 script / ui 两条', async () => {
    await initRepo();
    await writeScript('scripts/ab12cd.Chess_Pawn.lua', 'a\n');
    await writeScript('ui/ab12cd.Chess_Pawn.xml', '<a />\n');
    await commitAll('init');
    await writeScript('scripts/ab12cd.Chess_Pawn.lua', 'a\nb\n');
    await writeScript('ui/ab12cd.Chess_Pawn.xml', '<b />\n');

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(2);
    expect(changeOf(status, 'script', 'Chess_Pawn').summary).toBe('Chess_Pawn 脚本 +1/-0 行');
    expect(changeOf(status, 'ui', 'Chess_Pawn').summary).toBe('Chess_Pawn UI +1/-1 行');
  });

  it('git mv 脚本（R ）：subject 取新名，paths 含新 / 原两个路径', async () => {
    await initRepo();
    await writeScript('scripts/ab12cd.Old_Name.lua', 'a\nb\nc\n');
    await commitAll('init');
    await git(['mv', 'scripts/ab12cd.Old_Name.lua', 'scripts/ab12cd.New_Name.lua']);

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(1);
    const change = changeOf(status, 'script', 'New_Name');
    expect(change.xy).toBe('R ');
    expect(change.paths).toHaveLength(2);
    expect(change.paths).toContain('scripts/ab12cd.New_Name.lua');
    expect(change.paths).toContain('scripts/ab12cd.Old_Name.lua');
  });

  it('scripts 下无点前缀的散落文件：subject 用去扩展名的文件名', async () => {
    await initRepo();
    await writeScript('scripts/Global.lua', 'a\n');
    await commitAll('init');
    await writeScript('scripts/README.md', '# 说明\n');

    const status = await analyzeStatus(tempRoot);
    const change = changeOf(status, 'script', 'README');
    expect(change.xy).toBe('??');
    expect(change.added).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// object-asset
// ---------------------------------------------------------------------------

describe('object-asset：素材反查', () => {
  it('objects/ 文件在 objects.csv：subject=assetId，二进制不数行', async () => {
    await initRepo();
    await writeObjectsLedger([{ assetId: 'obj_chess', file: 'objects/chess.png' }]);
    await writeObjectFile('objects/chess.png');
    await commitAll('init');
    await writeObjectFile('objects/chess.png', PNG_B);

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(1);
    const change = changeOf(status, 'object-asset', 'obj_chess');
    expect(change.paths).toEqual(['objects/chess.png']);
    expect(change.summary).toBe('素材 obj_chess 改动');
    expect(change.added).toBeUndefined();
    expect(change.deleted).toBeUndefined();
    expect(status.unknownCount).toBe(0);
  });

  it('objects/ 文件不在 objects.csv：unknown', async () => {
    await initRepo();
    await writeObjectsLedger([{ assetId: 'obj_chess', file: 'objects/chess.png' }]);
    await writeObjectFile('objects/ghost.png');
    await commitAll('init');
    await writeObjectFile('objects/ghost.png', PNG_B);

    const status = await analyzeStatus(tempRoot);
    expect(changeOf(status, 'unknown').paths).toEqual(['objects/ghost.png']);
    expect(status.unknownCount).toBe(1);
  });

  it('objects.csv 缺失：素材反查降级 unknown，不抛错', async () => {
    await initRepo();
    await writeObjectFile('objects/chess.png');
    await commitAll('init');
    await writeObjectFile('objects/chess.png', PNG_B);

    const status = await analyzeStatus(tempRoot);
    expect(changeOf(status, 'unknown').paths).toEqual(['objects/chess.png']);
    expect(status.unknownCount).toBe(1);
  });

  it('objects.csv 本身改动：归为 metadata', async () => {
    await initRepo();
    await writeObjectsLedger([{ assetId: 'obj_chess', file: 'objects/chess.png' }]);
    await commitAll('init');
    await writeObjectsLedger([
      { assetId: 'obj_chess', file: 'objects/chess.png' },
      { assetId: 'obj_ghost', file: 'objects/ghost.png' },
    ]);

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(1);
    const change = changeOf(status, 'metadata');
    expect(change.paths).toEqual(['objects.csv']);
    expect(change.summary).toBe('元数据改动（1 个文件）');
  });
});

// ---------------------------------------------------------------------------
// pack.yaml 与 metadata
// ---------------------------------------------------------------------------

describe('pack.yaml 与 metadata', () => {
  it('pack.yaml 改动：kind=pack-yaml，numstat 行数', async () => {
    await initRepo();
    await writeFile(path.join(tempRoot, 'pack.yaml'), 'schema_version: 1\nname: 测试包\n', 'utf8');
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'pack.yaml'), 'schema_version: 1\nname: 测试包\nworkshop_id: null\n', 'utf8');

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(1);
    const change = changeOf(status, 'pack-yaml');
    expect(change.paths).toEqual(['pack.yaml']);
    expect(change.summary).toBe('pack.yaml 改动');
    expect(change.added).toBe(1);
    expect(change.deleted).toBe(0);
  });

  it('.gitattributes 改动：metadata', async () => {
    await initRepo();
    await writeFile(path.join(tempRoot, '.gitattributes'), '*.png filter=lfs\n', 'utf8');
    await commitAll('init');
    await writeFile(path.join(tempRoot, '.gitattributes'), '*.png filter=lfs\n*.jpg filter=lfs\n', 'utf8');

    const status = await analyzeStatus(tempRoot);
    expect(changeOf(status, 'metadata').paths).toEqual(['.gitattributes']);
  });

  it('source/ 与 sheets/ 下的多文件改动：合并为一条 metadata，计数 2', async () => {
    await initRepo();
    await mkdir(path.join(tempRoot, 'source'), { recursive: true });
    await mkdir(path.join(tempRoot, 'sheets'), { recursive: true });
    await writeFile(path.join(tempRoot, 'source', 'a.txt'), 'a\n', 'utf8');
    await writeFile(path.join(tempRoot, 'sheets', 'b.txt'), 'b\n', 'utf8');
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'source', 'a.txt'), 'a2\n', 'utf8');
    await writeFile(path.join(tempRoot, 'sheets', 'b.txt'), 'b2\n', 'utf8');

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(1);
    const change = changeOf(status, 'metadata');
    expect(change.paths).toHaveLength(2);
    expect(change.paths).toContain('source/a.txt');
    expect(change.paths).toContain('sheets/b.txt');
    expect(change.summary).toBe('元数据改动（2 个文件）');
  });
});

// ---------------------------------------------------------------------------
// 聚合、计数与大规模
// ---------------------------------------------------------------------------

describe('聚合、计数与大规模', () => {
  it('同 deck 的 M 与 ?? 卡面混合：合并一条，cardCount=2，xy 含两个状态码', async () => {
    await initRepo();
    // cards.csv 提交时即登记 f1（已在库）与 f2（尚未落盘）
    await writeDeck('冒险牌堆', [
      { cardId: 101, face: '001_正面.png' },
      { cardId: 102, face: '002_正面.png' },
    ]);
    await rm(path.join(tempRoot, 'decks', '冒险牌堆', '002_正面.png'));
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '001_正面.png'), PNG_B); //  M
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '002_正面.png'), PNG_A); // ??

    const status = await analyzeStatus(tempRoot);
    const others = status.changes.filter((change) => change.kind !== 'deck-cards');
    expect(others).toEqual([]);
    const change = changeOf(status, 'deck-cards', '冒险牌堆');
    expect(change.cardCount).toBe(2);
    expect(change.cardFiles).toEqual(['001_正面.png', '002_正面.png']);
    expect(change.summary).toBe('冒险牌堆 2 张卡换图（001_正面.png, 002_正面.png）');
    const codes = change.xy.split('/');
    expect(codes).toContain(' M');
    expect(codes).toContain('??');
  });

  it('unknownCount 统计文件数而非分组数：3 个未知文件合 1 组，计数 3', async () => {
    await initRepo();
    // 两个无 cards.csv 的牌堆图片 + 一个 objects.csv 未登记的素材
    const deckA = path.join(tempRoot, 'decks', '甲');
    const deckB = path.join(tempRoot, 'decks', '乙');
    await mkdir(deckA, { recursive: true });
    await mkdir(deckB, { recursive: true });
    await writeFile(path.join(deckA, 'a.png'), PNG_A);
    await writeFile(path.join(deckB, 'b.png'), PNG_A);
    await writeObjectsLedger([{ assetId: 'obj_chess', file: 'objects/chess.png' }]);
    await writeObjectFile('objects/ghost.png');
    await commitAll('init');
    await writeFile(path.join(deckA, 'a.png'), PNG_B);
    await writeFile(path.join(deckB, 'b.png'), PNG_B);
    await writeObjectFile('objects/ghost.png', PNG_B);

    const status = await analyzeStatus(tempRoot);
    const unknownChanges = status.changes.filter((change) => change.kind === 'unknown');
    expect(unknownChanges).toHaveLength(1);
    expect(unknownChanges[0].paths).toHaveLength(3);
    expect(status.unknownCount).toBe(3);
  });

  it('卡面与卡表同时改动：deck-cards 与 deck-cards-csv 分成两条', async () => {
    await initRepo();
    const deckDir = await writeDeck('冒险牌堆', [{ cardId: 101, face: '001_正面.png', name: '旧名' }]);
    await commitAll('init');
    await writeFile(path.join(deckDir, '001_正面.png'), PNG_B);
    const rows = await readCardsCsv(deckDir);
    rows[0].name = '新名';
    await writeCardsCsv(deckDir, rows);

    const status = await analyzeStatus(tempRoot);
    expect(status.changes).toHaveLength(2);
    expect(changeOf(status, 'deck-cards', '冒险牌堆').cardCount).toBe(1);
    expect(changeOf(status, 'deck-cards-csv', '冒险牌堆')).toBeDefined();
  });

  it('两次调用结果一致（反查缓存按调用隔离，不产生顺序差异）', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [
      { cardId: 101, face: '001_正面.png' },
      { cardId: 102, face: '002_正面.png' },
    ]);
    await writeScript('scripts/Global.lua', 'a\n');
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '001_正面.png'), PNG_B);
    await writeScript('scripts/Global.lua', 'a\nb\n');

    const first = await analyzeStatus(tempRoot);
    const second = await analyzeStatus(tempRoot);
    expect(second).toEqual(first);
    expect(first.changes).toHaveLength(2);
  });

  it('大改动量（两个新牌堆共 50+ 文件，未跟踪目录折叠）：正常分析不降级', async () => {
    await initRepo();
    for (const deckName of ['大批量甲', '大批量乙']) {
      const cards: CardSpec[] = [];
      for (let i = 1; i <= 25; i++) {
        cards.push({ cardId: 100 + i, face: `卡_${String(i).padStart(2, '0')}.png` });
      }
      await writeDeck(deckName, cards);
    }
    // 不 add：git status 折叠成两条 "?? decks/<名>/"

    const status = await analyzeStatus(tempRoot);
    expect(status.dirty).toBe(true);
    expect(status.changes).toHaveLength(6); // 每堆：卡面 + 卡表 + deck.yaml
    expect(changeOf(status, 'deck-cards', '大批量甲').cardCount).toBe(25);
    expect(changeOf(status, 'deck-cards', '大批量乙').cardCount).toBe(25);
    expect(status.unknownCount).toBe(0);
  });

  it('超过 1000 个文件：console.warn 提示但仍完整分析', async () => {
    await initRepo();
    const deckDir = path.join(tempRoot, 'decks', '海量牌堆');
    await mkdir(deckDir, { recursive: true });
    for (let i = 1; i <= 1001; i++) {
      await writeFile(path.join(deckDir, `卡_${String(i).padStart(4, '0')}.png`), PNG_A);
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const status = await analyzeStatus(tempRoot);
      expect(status.dirty).toBe(true);
      expect(status.unknownCount).toBe(1001); // 无 cards.csv，全部降级 unknown
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('1001'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
