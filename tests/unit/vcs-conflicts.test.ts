// tests/unit/vcs-conflicts.test.ts
/**
 * src/vcs/conflicts.ts 单元测试：合并冲突检测与"哪个牌堆的哪张卡"反查。
 *
 * mock 环境：os.tmpdir() + fs.mkdtemp 临时目录里真实跑 git（init / branch /
 * commit / merge / rm），冲突状态用两种手段构造：
 * - 真实 merge：双方分支改同一文件 → merge 必然冲突退出（UU / AA / DD / DU / UD）；
 * - index 注入：`git update-index --index-info` 写入 stage 2 / 3 单侧条目，
 *   构造真实 merge 难以稳定复现的 AU / UA，以及"工作区文件合法的 UU deck.yaml"。
 *
 * readCardsCsv / readObjectsCsv / readDeckManifest 用 vi.mock 做透传包装
 * （行为与原实现完全一致，仅记录调用），用于断言"同一牌堆的 cards.csv /
 * deck.yaml 与全包 objects.csv 在一次扫描中只读一次（缓存）"。
 *
 * 覆盖：
 * - analyzeConflicts：无冲突 / 非 git 仓库 / 普通改动不算冲突；
 * - 卡牌图反查（正面 / 背面 / 多卡 / deck.yaml 缺失 / 卡名缺失）；
 * - cards.csv 与 deck.yaml 冲突（cardsCsvConflictPaths / 冲突标记下的降级）；
 * - 素材反查（pack 根与 objects/ 双布局 / 未登记 / 台账缺失 / 台账带冲突标记）；
 * - 脚本与 UI 文件名反推（Global / <guid>.<name> / 名称含点 / 无法解析 / 非 .lua）；
 * - 状态码语义（UU / AA / DD / DU / AU / UA；M 与 ?? 不算冲突）；
 * - 反查失败一律 unknown 不抛错（cards.csv 缺失 / 不匹配 / 带冲突标记）；
 * - 缓存（同牌堆单次读 / 跨牌堆各读一次 / 不跨 analyzeConflicts 调用复用）；
 * - 中文牌堆名 / 中文卡名 / 中文文件名 / 目录名含空格；
 * - formatConflict：各 type 的中文模板关键字段。
 *
 * 注：本机 os.tmpdir() 路径含中文用户名，全部用例隐式覆盖中文 cwd。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readCardsCsv, writeCardsCsv, type CardRow } from '../../src/deck/cards.js';
import { readObjectsCsv, writeObjectsCsv, type ObjectRow } from '../../src/deck/objects.js';
import { readDeckManifest, writeDeckManifest } from '../../src/pack/manifest.js';
import { analyzeConflicts, formatConflict } from '../../src/vcs/conflicts.js';

// readCardsCsv / readObjectsCsv / readDeckManifest 透传包装：行为不变，仅记录调用次数
vi.mock('../../src/deck/cards.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/deck/cards.js')>();
  return { ...actual, readCardsCsv: vi.fn(actual.readCardsCsv) };
});
vi.mock('../../src/deck/objects.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/deck/objects.js')>();
  return { ...actual, readObjectsCsv: vi.fn(actual.readObjectsCsv) };
});
vi.mock('../../src/pack/manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pack/manifest.js')>();
  return { ...actual, readDeckManifest: vi.fn(actual.readDeckManifest) };
});

import { PackError } from '../../src/pack/packyaml.js';

vi.setConfig({ testTimeout: 30_000 }); // 每个 it 里要跑十来次 git 子进程，放宽超时

// ---------------------------------------------------------------------------
// 临时目录与 git 夹具
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（= 一个图包根 = 一个 git 仓库工作树） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-conflicts-'));
  vi.mocked(readCardsCsv).mockClear();
  vi.mocked(readObjectsCsv).mockClear();
  vi.mocked(readDeckManifest).mockClear();
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/**
 * 在 tempRoot 跑 git 命令，失败即抛（夹具专用，不走被测代码）。
 * @param args git 参数（不含 "git"）
 * @param input 可选 stdin（`update-index --index-info` 用）
 */
async function git(args: string[], input?: string): Promise<void> {
  const result = await execa('git', args, { cwd: tempRoot, reject: false, input });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
  }
}

/** 初始化带提交者身份、固定分支名、关闭 autocrlf 的测试仓库 */
async function initRepo(): Promise<void> {
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'test@test.local']);
  await git(['config', 'user.name', 'tester']);
  await git(['config', 'core.autocrlf', 'false']);
}

/** 写入相对 tempRoot 的文件（自动建父目录） */
async function writeFileAt(relPath: string, content: string): Promise<void> {
  const abs = path.join(tempRoot, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

/** add -A + commit（夹具提交一律全量暂存，简化场景搭建） */
async function commitAll(message: string): Promise<void> {
  await git(['add', '-A']);
  await git(['commit', '-m', message]);
}

/** 双方分支各自的改动（writes 覆盖 / 新增，deletes 删除） */
interface BranchEdit {
  writes?: Array<[relPath: string, content: string]>;
  deletes?: string[];
}

/**
 * 三段式冲突场景：base 提交 → topic 分支改 theirs → main 改 ours →
 * merge topic（必然冲突退出；干净合并说明场景搭错了，直接抛错）。
 * base 文件写入后再 commitAll，此前已写好的夹具（cards.csv 等）一并入库。
 */
async function scenario(ours: BranchEdit, theirs: BranchEdit, base: Array<[string, string]> = []): Promise<void> {
  for (const [rel, content] of base) {
    await writeFileAt(rel, content);
  }
  await commitAll('base');
  await git(['checkout', '-b', 'topic']);
  for (const [rel, content] of theirs.writes ?? []) {
    await writeFileAt(rel, content);
  }
  for (const rel of theirs.deletes ?? []) {
    await rm(path.join(tempRoot, rel));
  }
  await commitAll('theirs');
  await git(['checkout', 'main']);
  for (const [rel, content] of ours.writes ?? []) {
    await writeFileAt(rel, content);
  }
  for (const rel of ours.deletes ?? []) {
    await rm(path.join(tempRoot, rel));
  }
  await commitAll('ours');
  const merged = await execa('git', ['merge', 'topic'], { cwd: tempRoot, reject: false });
  if (merged.exitCode === 0) {
    throw new Error('预期 merge 产生冲突，但干净合并了（场景搭建错误）');
  }
}

/**
 * 用 `git update-index --index-info` 注入未合并 stage 条目（构造 AU / UA /
 * 工作区文件合法的 UU）。文件须已存在于工作区。
 * @param relPath 相对 pack 根路径（POSIX 分隔）
 * @param stages 要注入的 stage 号列表（1=base 2=ours 3=theirs）
 */
async function injectUnmergedStages(relPath: string, stages: number[]): Promise<void> {
  const hash = (await execa('git', ['hash-object', '-w', path.join(tempRoot, relPath)], { cwd: tempRoot })).stdout.trim();
  const text = stages.map((stage) => `100644 ${hash} ${stage}\t${relPath}\n`).join('');
  await git(['update-index', '--index-info'], text);
}

/** 断言 fn 抛出指定 code 的 PackError */
async function expectPackError(fn: () => Promise<unknown>, code: string): Promise<PackError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PackError);
    const packError = err as PackError;
    expect(packError.code).toBe(code);
    return packError;
  }
  throw new Error(`预期抛出 code=${code} 的 PackError，但调用成功了`);
}

// ---------------------------------------------------------------------------
// 数据夹具
// ---------------------------------------------------------------------------

/** 主牌堆目录名（git 路径里的 decks/ 下第一段） */
const DECK_DIR = '冒险牌堆';
/** 主牌堆 deck.yaml 里的显示名与 GUID */
const DECK_NAME = '冒险牌堆';
const DECK_GUID = '271fac';
/** 图集源 URL（卡表夹具缺省值） */
const SHEET_SOURCE = 'https://steamusercontent-a.akamaihd.net/ugc/AAA/';

/** 构造一张合法卡行（slot 按 1 基规则换算；sheet 10×7=70 格兜住任意 slot） */
function makeRow(cardId: number, face: string, overrides: Partial<CardRow> = {}): CardRow {
  return {
    cardId,
    face,
    back: overrides.back,
    name: overrides.name,
    nickname: overrides.nickname,
    sheetId: overrides.sheetId ?? 1,
    slot: overrides.slot ?? (cardId % 100 === 0 ? 100 : cardId % 100),
    sheetCols: overrides.sheetCols ?? 10,
    sheetRows: overrides.sheetRows ?? 7,
    sheetSource: overrides.sheetSource ?? SHEET_SOURCE,
  };
}

/** 主牌堆的卡表（两张卡：10121 迷路的旅人 / 10122 深渊行者） */
function defaultRows(): CardRow[] {
  return [
    makeRow(10121, '10121_正面.png', { name: '迷路的旅人', nickname: '旅人' }),
    makeRow(10122, '10122_正面.png', { name: '深渊行者' }),
  ];
}

/** 写一个标准牌堆目录（cards.csv + deck.yaml；deckName 缺省用目录名） */
async function setupDeck(
  deckDirName: string,
  rows: CardRow[],
  deckName: string = deckDirName,
  guid: string = DECK_GUID,
): Promise<void> {
  const deckDir = path.join(tempRoot, 'decks', deckDirName);
  await mkdir(deckDir, { recursive: true });
  await writeCardsCsv(deckDir, rows);
  await writeDeckManifest(deckDir, { schema_version: 1, name: deckName, guid, shared_with: [] });
}

/** 构造一条合法素材行（file 相对 pack 根、含 objects/ 前缀） */
function makeObjectRow(overrides: Partial<ObjectRow> = {}): ObjectRow {
  return {
    assetId: overrides.assetId ?? 'aa11bb',
    name: overrides.name,
    type: overrides.type ?? 'model',
    file: overrides.file ?? 'objects/棋子.obj',
    source: overrides.source ?? 'https://steamusercontent-a.akamaihd.net/ugc/BBB/',
  };
}

/** 找出某牌堆 cards.csv 的读取调用次数（缓存断言用） */
function cardsCsvCallCount(deckDirName: string): number {
  return vi.mocked(readCardsCsv).mock.calls.filter(([dir]) => path.basename(dir) === deckDirName).length;
}

// ---------------------------------------------------------------------------
// analyzeConflicts：整体行为
// ---------------------------------------------------------------------------

describe('analyzeConflicts：整体行为', () => {
  it('干净仓库（init 后无提交无改动）：hasConflicts=false 且各字段为空', async () => {
    await initRepo();
    const report = await analyzeConflicts(tempRoot);
    expect(report).toEqual({
      hasConflicts: false,
      conflicts: [],
      cardsCsvConflictPaths: [],
      unknownCount: 0,
    });
  });

  it('非 git 目录：透传 GIT_NOT_A_REPO', async () => {
    await expectPackError(() => analyzeConflicts(tempRoot), 'GIT_NOT_A_REPO');
  });

  it('普通修改 / 暂存 / 未跟踪不算冲突：hasConflicts=false', async () => {
    await initRepo();
    await writeFileAt('tracked.txt', 'v1\n');
    await commitAll('init');
    await writeFileAt('tracked.txt', 'v2\n'); // 工作区修改 " M"
    await writeFileAt('staged.txt', 's\n');
    await git(['add', 'staged.txt']); // 已暂存 "A "
    await writeFileAt('untracked.txt', 'u\n'); // 未跟踪 "??"
    const report = await analyzeConflicts(tempRoot);
    expect(report.hasConflicts).toBe(false);
    expect(report.conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// analyzeConflicts：卡牌图反查
// ---------------------------------------------------------------------------

describe('analyzeConflicts：卡牌图反查', () => {
  it('单卡图 UU：反查为 card-image，card 字段完整（正面）', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, defaultRows());
    await scenario(
      { writes: [['decks/冒险牌堆/10121_正面.png', 'ours-img']] },
      { writes: [['decks/冒险牌堆/10121_正面.png', 'theirs-img']] },
      [['decks/冒险牌堆/10121_正面.png', 'base-img']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts).toEqual([
      {
        type: 'card-image',
        path: 'decks/冒险牌堆/10121_正面.png',
        xy: 'UU',
        card: {
          deckName: DECK_NAME,
          deckGuid: DECK_GUID,
          cardId: 10121,
          cardName: '迷路的旅人',
          cardNickname: '旅人',
          fileName: '10121_正面.png',
          isBack: false,
          sheetId: 1,
          slot: 21,
          sheetSource: SHEET_SOURCE,
        },
      },
    ]);
    expect(report.cardsCsvConflictPaths).toEqual([]);
    expect(report.unknownCount).toBe(0);
  });

  it('多张卡图 UU：逐张反查且顺序与 git status 输出一致', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, defaultRows());
    const base: Array<[string, string]> = [
      ['decks/冒险牌堆/10121_正面.png', 'b1'],
      ['decks/冒险牌堆/10122_正面.png', 'b2'],
    ];
    await scenario(
      {
        writes: [
          ['decks/冒险牌堆/10121_正面.png', 'o1'],
          ['decks/冒险牌堆/10122_正面.png', 'o2'],
        ],
      },
      {
        writes: [
          ['decks/冒险牌堆/10121_正面.png', 't1'],
          ['decks/冒险牌堆/10122_正面.png', 't2'],
        ],
      },
      base,
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts.map((info) => info.type)).toEqual(['card-image', 'card-image']);
    expect(report.conflicts.map((info) => info.card?.cardId)).toEqual([10121, 10122]);
    expect(report.conflicts.map((info) => info.xy)).toEqual(['UU', 'UU']);
  });

  it('卡背冲突：isBack=true（face 全表未命中后由 back 列兜底命中）', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, [
      makeRow(10121, '10121_正面.png', { back: '通用_背面.png', name: '迷路的旅人' }),
    ]);
    await scenario(
      { writes: [['decks/冒险牌堆/通用_背面.png', 'ours-back']] },
      { writes: [['decks/冒险牌堆/通用_背面.png', 'theirs-back']] },
      [['decks/冒险牌堆/通用_背面.png', 'base-back']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts).toHaveLength(1);
    const card = report.conflicts[0]?.card;
    expect(report.conflicts[0]?.type).toBe('card-image');
    expect(card?.isBack).toBe(true);
    expect(card?.fileName).toBe('通用_背面.png');
    expect(card?.cardId).toBe(10121);
  });

  it('deck.yaml 缺失：card.deckGuid 为空串，deckName 回退目录名，不抛错', async () => {
    await initRepo();
    const deckDir = path.join(tempRoot, 'decks', DECK_DIR);
    await mkdir(deckDir, { recursive: true });
    await writeCardsCsv(deckDir, defaultRows()); // 只写卡表，不写 deck.yaml
    await scenario(
      { writes: [['decks/冒险牌堆/10121_正面.png', 'ours']] },
      { writes: [['decks/冒险牌堆/10121_正面.png', 'theirs']] },
      [['decks/冒险牌堆/10121_正面.png', 'base']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts[0]?.type).toBe('card-image');
    expect(report.conflicts[0]?.card?.deckGuid).toBe('');
    expect(report.conflicts[0]?.card?.deckName).toBe(DECK_DIR);
  });

  it('卡名与昵称缺失：cardName / cardNickname 为 undefined，其余字段照常', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, [makeRow(10121, '10121_正面.png')]);
    await scenario(
      { writes: [['decks/冒险牌堆/10121_正面.png', 'ours']] },
      { writes: [['decks/冒险牌堆/10121_正面.png', 'theirs']] },
      [['decks/冒险牌堆/10121_正面.png', 'base']],
    );
    const report = await analyzeConflicts(tempRoot);
    const card = report.conflicts[0]?.card;
    expect(card?.cardName).toBeUndefined();
    expect(card?.cardNickname).toBeUndefined();
    expect(card?.cardId).toBe(10121);
    expect(card?.sheetSource).toBe(SHEET_SOURCE);
  });
});

// ---------------------------------------------------------------------------
// analyzeConflicts：反查失败降级（绝不抛错）
// ---------------------------------------------------------------------------

describe('analyzeConflicts：反查失败降级', () => {
  it('cards.csv 缺失：unknown + fallbackReason 指向 cards.csv，不抛错', async () => {
    await initRepo();
    await scenario(
      { writes: [['decks/孤儿牌堆/10121_正面.png', 'ours']] },
      { writes: [['decks/孤儿牌堆/10121_正面.png', 'theirs']] },
      [['decks/孤儿牌堆/10121_正面.png', 'base']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.type).toBe('unknown');
    expect(report.conflicts[0]?.fallbackReason).toContain('cards.csv');
    expect(report.unknownCount).toBe(1);
  });

  it('face / back 都不匹配：unknown，fallbackReason 为 "cards.csv 中未找到 <文件>"', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, defaultRows());
    await scenario(
      { writes: [['decks/冒险牌堆/001_不存在.png', 'ours']] },
      { writes: [['decks/冒险牌堆/001_不存在.png', 'theirs']] },
      [['decks/冒险牌堆/001_不存在.png', 'base']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts[0]?.type).toBe('unknown');
    expect(report.conflicts[0]?.fallbackReason).toBe('cards.csv 中未找到 001_不存在.png');
  });

  it('cards.csv 本身带冲突标记时：卡图反查降级 unknown，cards.csv 仍归为 cards-csv', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, defaultRows());
    // 双方各改卡表同一行（第 2 行）的不同列 → cards.csv 必然冲突，工作区落盘后带 <<<<<<< 标记
    const oursCsv =
      'card_id,face,back,name,nickname,sheet_id,slot,sheet_cols,sheet_rows,sheet_source\n'
      + `10121,10121_正面.png,,我方版名,,1,21,10,7,${SHEET_SOURCE}\n`;
    const theirsCsv =
      'card_id,face,back,name,nickname,sheet_id,slot,sheet_cols,sheet_rows,sheet_source\n'
      + `10121,10121_正面.png,,对方版名,,1,21,10,7,${SHEET_SOURCE}\n`;
    await scenario(
      {
        writes: [
          ['decks/冒险牌堆/cards.csv', oursCsv],
          ['decks/冒险牌堆/10121_正面.png', 'ours-img'],
        ],
      },
      {
        writes: [
          ['decks/冒险牌堆/cards.csv', theirsCsv],
          ['decks/冒险牌堆/10121_正面.png', 'theirs-img'],
        ],
      },
      [['decks/冒险牌堆/10121_正面.png', 'base-img']],
    );

    const report = await analyzeConflicts(tempRoot);
    const byType = new Map(report.conflicts.map((info) => [info.type, info]));
    expect(byType.get('cards-csv')?.path).toBe('decks/冒险牌堆/cards.csv');
    expect(report.cardsCsvConflictPaths).toEqual(['decks/冒险牌堆/cards.csv']);
    expect(byType.get('unknown')?.path).toBe('decks/冒险牌堆/10121_正面.png');
    expect(byType.get('unknown')?.fallbackReason).toContain('cards.csv');
    expect(report.unknownCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// analyzeConflicts：牌堆元数据冲突
// ---------------------------------------------------------------------------

describe('analyzeConflicts：牌堆元数据冲突', () => {
  it('cards.csv UU：type=cards-csv，cardsCsvConflictPaths 收录，deck 信息来自 deck.yaml', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, defaultRows());
    await scenario(
      { writes: [['decks/冒险牌堆/cards.csv', 'ours-csv']] },
      { writes: [['decks/冒险牌堆/cards.csv', 'theirs-csv']] },
      [['decks/冒险牌堆/cards.csv', 'base-csv']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.type).toBe('cards-csv');
    expect(report.conflicts[0]?.xy).toBe('UU');
    expect(report.conflicts[0]?.deck).toEqual({ deckName: DECK_NAME, deckGuid: DECK_GUID });
    expect(report.cardsCsvConflictPaths).toEqual(['decks/冒险牌堆/cards.csv']);
    expect(report.unknownCount).toBe(0);
  });

  it('deck.yaml UU（真实 merge，工作区带冲突标记）：guid 为空串，deckName 回退目录名', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, defaultRows());
    await scenario(
      {
        writes: [
          ['decks/冒险牌堆/deck.yaml', 'schema_version: 1\nname: 我改的名\nguid: 271fac\nshared_with: []\n'],
        ],
      },
      {
        writes: [
          ['decks/冒险牌堆/deck.yaml', 'schema_version: 1\nname: 对方改的名\nguid: 271fac\nshared_with: []\n'],
        ],
      },
      // base 用整行同名内容：两侧改同一行 name → 必然冲突
      [['decks/冒险牌堆/deck.yaml', 'schema_version: 1\nname: 冒险牌堆\nguid: 271fac\nshared_with: []\n']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.type).toBe('deck-yaml');
    expect(report.conflicts[0]?.xy).toBe('UU');
    // 工作区 deck.yaml 带 <<<<<<< 标记，解析必然失败 → 目录名兜底 + guid 空串
    expect(report.conflicts[0]?.deck).toEqual({ deckName: DECK_DIR, deckGuid: '' });
    expect(report.unknownCount).toBe(0); // deck-yaml 不算反查失败
  });

  it('deck.yaml 注入未合并 stage（工作区文件合法）：deck 信息读自 deck.yaml（成功路径）', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, defaultRows());
    await git(['add', 'decks/冒险牌堆/cards.csv']);
    await git(['commit', '-m', 'cards only']); // deck.yaml 保持未跟踪，随后注入 stage
    await injectUnmergedStages('decks/冒险牌堆/deck.yaml', [1, 2, 3]);
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.type).toBe('deck-yaml');
    expect(report.conflicts[0]?.xy).toBe('UU');
    expect(report.conflicts[0]?.deck).toEqual({ deckName: DECK_NAME, deckGuid: DECK_GUID });
  });

  it('cards.csv 与 deck.yaml 同时 UU：cardsCsvConflictPaths 只收录卡表路径', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, defaultRows());
    const baseDeckYaml = 'schema_version: 1\nname: 冒险牌堆\nguid: 271fac\nshared_with: []\n';
    await scenario(
      {
        writes: [
          ['decks/冒险牌堆/cards.csv', 'ours-csv'],
          ['decks/冒险牌堆/deck.yaml', 'schema_version: 1\nname: 我方名\nguid: 271fac\nshared_with: []\n'],
        ],
      },
      {
        writes: [
          ['decks/冒险牌堆/cards.csv', 'theirs-csv'],
          ['decks/冒险牌堆/deck.yaml', 'schema_version: 1\nname: 对方名\nguid: 271fac\nshared_with: []\n'],
        ],
      },
      [['decks/冒险牌堆/cards.csv', 'base-csv'], ['decks/冒险牌堆/deck.yaml', baseDeckYaml]],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts.map((info) => info.type).sort()).toEqual(['cards-csv', 'deck-yaml']);
    expect(report.cardsCsvConflictPaths).toEqual(['decks/冒险牌堆/cards.csv']);
  });
});

// ---------------------------------------------------------------------------
// analyzeConflicts：素材反查
// ---------------------------------------------------------------------------

describe('analyzeConflicts：素材反查', () => {
  it('objects/<file> UU（台账在 pack 根）：object-asset，object 字段完整', async () => {
    await initRepo();
    await writeObjectsCsv(tempRoot, [makeObjectRow({ name: '棋子' })]);
    await scenario(
      { writes: [['objects/棋子.obj', 'ours-obj']] },
      { writes: [['objects/棋子.obj', 'theirs-obj']] },
      [['objects/棋子.obj', 'base-obj']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]).toMatchObject({
      type: 'object-asset',
      path: 'objects/棋子.obj',
      xy: 'UU',
      object: { assetId: 'aa11bb', name: '棋子', fileName: '棋子.obj' },
    });
  });

  it('objects/<file> UU（台账在 objects/ 子目录）：双布局兜底命中，且只读一次台账', async () => {
    await initRepo();
    await writeObjectsCsv(path.join(tempRoot, 'objects'), [makeObjectRow({ assetId: 'cc22dd' })]);
    await scenario(
      { writes: [['objects/棋子.obj', 'ours-obj']] },
      { writes: [['objects/棋子.obj', 'theirs-obj']] },
      [['objects/棋子.obj', 'base-obj']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts[0]?.type).toBe('object-asset');
    expect(report.conflicts[0]?.object?.assetId).toBe('cc22dd');
    // 首选布局（objects/objects.csv）直接命中 → 只读一次
    expect(vi.mocked(readObjectsCsv).mock.calls).toHaveLength(1);
  });

  it('objects 文件不在台账 / 前缀相似但不精确相等：均 unknown（不抛错）', async () => {
    await initRepo();
    // 台账里只有别的行：一行前缀相似（多一个 .bak 后缀），一行完全无关
    await writeObjectsCsv(tempRoot, [
      makeObjectRow({ file: 'objects/棋子.obj.bak' }),
      makeObjectRow({ assetId: 'ee44ff', file: 'objects/别的素材.obj' }),
    ]);
    await scenario(
      { writes: [['objects/棋子.obj', 'ours-obj']] },
      { writes: [['objects/棋子.obj', 'theirs-obj']] },
      [['objects/棋子.obj', 'base-obj']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.type).toBe('unknown');
    expect(report.conflicts[0]?.fallbackReason).toBe('objects.csv 中未找到 objects/棋子.obj');
    expect(report.unknownCount).toBe(1);
  });

  it('objects.csv 完全缺失：unknown 而不抛错', async () => {
    await initRepo();
    await scenario(
      { writes: [['objects/棋子.obj', 'ours-obj']] },
      { writes: [['objects/棋子.obj', 'theirs-obj']] },
      [['objects/棋子.obj', 'base-obj']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts[0]?.type).toBe('unknown');
    expect(report.conflicts[0]?.fallbackReason).toContain('objects.csv');
    expect(report.unknownCount).toBe(1);
  });

  it('objects.csv 本身冲突（带标记）时：素材反查降级 unknown，不抛错', async () => {
    await initRepo();
    await writeObjectsCsv(tempRoot, [makeObjectRow({ name: '棋子' })]);
    // 双方各改台账同一行（第 2 行）的不同列 → objects.csv 必然冲突，工作区带标记
    const oursCsv =
      'asset_id,name,type,file,file_secondary,diffuse,normal,collider,source,origin_asset_id,origin_pack\n'
      + 'aa11bb,我方版棋子,model,objects/棋子.obj,,,,,https://example.com/ours/,,\n';
    const theirsCsv =
      'asset_id,name,type,file,file_secondary,diffuse,normal,collider,source,origin_asset_id,origin_pack\n'
      + 'aa11bb,对方版棋子,model,objects/棋子.obj,,,,,https://example.com/theirs/,,\n';
    await scenario(
      {
        writes: [
          ['objects.csv', oursCsv],
          ['objects/棋子.obj', 'ours-obj'],
        ],
      },
      {
        writes: [
          ['objects.csv', theirsCsv],
          ['objects/棋子.obj', 'theirs-obj'],
        ],
      },
      [['objects/棋子.obj', 'base-obj']],
    );

    const report = await analyzeConflicts(tempRoot);
    const byPath = new Map(report.conflicts.map((info) => [info.path, info]));
    expect(byPath.get('objects.csv')?.type).toBe('unknown'); // 台账路径不在已知目录 → 该条冲突降级 unknown
    expect(byPath.get('objects/棋子.obj')?.type).toBe('unknown');
    expect(byPath.get('objects/棋子.obj')?.fallbackReason).toContain('objects.csv');
  });
});

// ---------------------------------------------------------------------------
// analyzeConflicts：脚本 / UI 反推
// ---------------------------------------------------------------------------

describe('analyzeConflicts：脚本 / UI 反推', () => {
  it('scripts/Global.lua UU：script={name:"Global", guid:"-1"}', async () => {
    await initRepo();
    await scenario(
      { writes: [['scripts/Global.lua', '-- ours']] },
      { writes: [['scripts/Global.lua', '-- theirs']] },
      [['scripts/Global.lua', '-- base']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts[0]?.type).toBe('script');
    expect(report.conflicts[0]?.xy).toBe('UU');
    expect(report.conflicts[0]?.script).toEqual({ name: 'Global', guid: '-1' });
  });

  it('scripts/<guid>.<name>.lua UU：反推 guid 与名称', async () => {
    await initRepo();
    await scenario(
      { writes: [['scripts/88a4b0.魔剑.lua', '-- ours']] },
      { writes: [['scripts/88a4b0.魔剑.lua', '-- theirs']] },
      [['scripts/88a4b0.魔剑.lua', '-- base']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts[0]?.type).toBe('script');
    expect(report.conflicts[0]?.script).toEqual({ name: '魔剑', guid: '88a4b0' });
  });

  it('scripts/<guid>.<名.含点>.lua：净化名可含点，名称取首个点之后整段', async () => {
    await initRepo();
    await scenario(
      { writes: [['scripts/88a4b0.魔剑.利刃.lua', '-- ours']] },
      { writes: [['scripts/88a4b0.魔剑.利刃.lua', '-- theirs']] },
      [['scripts/88a4b0.魔剑.利刃.lua', '-- base']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts[0]?.script).toEqual({ name: '魔剑.利刃', guid: '88a4b0' });
  });

  it('scripts/无点主干.lua 与 scripts/说明.txt：均降级 unknown（不抛错）', async () => {
    await initRepo();
    await scenario(
      {
        writes: [
          ['scripts/没有点.lua', '-- ours'],
          ['scripts/说明.txt', 'ours-txt'],
        ],
      },
      {
        writes: [
          ['scripts/没有点.lua', '-- theirs'],
          ['scripts/说明.txt', 'theirs-txt'],
        ],
      },
      [
        ['scripts/没有点.lua', '-- base'],
        ['scripts/说明.txt', 'base-txt'],
      ],
    );
    const report = await analyzeConflicts(tempRoot);
    const byPath = new Map(report.conflicts.map((info) => [info.path, info]));
    expect(byPath.get('scripts/没有点.lua')?.type).toBe('unknown');
    expect(byPath.get('scripts/没有点.lua')?.fallbackReason).toContain('无法从文件名解析');
    expect(byPath.get('scripts/说明.txt')?.type).toBe('unknown');
    expect(byPath.get('scripts/说明.txt')?.fallbackReason).toContain('.lua');
    expect(report.unknownCount).toBe(2);
  });

  it('ui/<guid>.<name>.xml UU：type=ui 且 script 字段反推正确', async () => {
    await initRepo();
    await scenario(
      { writes: [['ui/ab12cd.面板.xml', '<!-- ours -->']] },
      { writes: [['ui/ab12cd.面板.xml', '<!-- theirs -->']] },
      [['ui/ab12cd.面板.xml', '<!-- base -->']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts[0]?.type).toBe('ui');
    expect(report.conflicts[0]?.script).toEqual({ name: '面板', guid: 'ab12cd' });
  });

  it('ui/Global.xml UU：type=ui 且 name=Global guid=-1', async () => {
    await initRepo();
    await scenario(
      { writes: [['ui/Global.xml', '<!-- ours -->']] },
      { writes: [['ui/Global.xml', '<!-- theirs -->']] },
      [['ui/Global.xml', '<!-- base -->']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts[0]?.type).toBe('ui');
    expect(report.conflicts[0]?.script).toEqual({ name: 'Global', guid: '-1' });
  });
});

// ---------------------------------------------------------------------------
// analyzeConflicts：状态码语义
// ---------------------------------------------------------------------------

describe('analyzeConflicts：状态码语义', () => {
  it('DD（双方删除，index 注入 base stage）：type=deleted-modified，xy=DD，card 归属仍保留', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, defaultRows());
    await writeFileAt('decks/冒险牌堆/10121_正面.png', 'base-img');
    await commitAll('base');
    // 真实 merge 里"双方都删"会被 git 干净合并（两侧一致删除，不算冲突），
    // DD 作为未合并状态用 index 注入稳定构造：index 只剩 base stage（stage 1）。
    // hash 要在删文件之前算（hash-object 需要文件存在）
    const abs = path.join(tempRoot, 'decks', DECK_DIR, '10121_正面.png');
    const hash = (await execa('git', ['hash-object', '-w', abs], { cwd: tempRoot })).stdout.trim();
    await rm(abs);
    await git(['rm', '--cached', '--', 'decks/冒险牌堆/10121_正面.png']);
    await git(['update-index', '--index-info'], `100644 ${hash} 1\tdecks/冒险牌堆/10121_正面.png\n`);
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.type).toBe('deleted-modified');
    expect(report.conflicts[0]?.xy).toBe('DD');
    expect(report.conflicts[0]?.card?.cardId).toBe(10121);
    expect(report.unknownCount).toBe(0);
  });

  it('一方删除一方修改：type=deleted-modified，xy=DU（实测 git 2.55：我方删除时为 DU）', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, defaultRows());
    await scenario(
      { deletes: ['decks/冒险牌堆/10121_正面.png'] }, // 我方（main）删除
      { writes: [['decks/冒险牌堆/10121_正面.png', 'theirs-img']] }, // 对方修改
      [['decks/冒险牌堆/10121_正面.png', 'base-img']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts[0]?.type).toBe('deleted-modified');
    expect(report.conflicts[0]?.xy).toBe('DU');
  });

  it('AA（双方新增同一卡图不同内容）：type=card-image 不特化为 deleted-modified，xy=AA', async () => {
    await initRepo();
    // base 卡表里就登记着"新增卡"，但图片文件双方才各自新增 → add/add 冲突
    await setupDeck(DECK_DIR, [
      ...defaultRows(),
      makeRow(30101, '新增卡_正面.png', { name: '新增卡' }),
    ]);
    await scenario(
      { writes: [['decks/冒险牌堆/新增卡_正面.png', 'ours-new']] },
      { writes: [['decks/冒险牌堆/新增卡_正面.png', 'theirs-new']] },
      [], // base 不含该图片文件 → 双方各自新增
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.type).toBe('card-image');
    expect(report.conflicts[0]?.xy).toBe('AA');
    expect(report.conflicts[0]?.card?.cardId).toBe(30101);
  });

  it('AU / UA（index 注入单侧 stage）：按路径正常识别，xy 原样保留', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, defaultRows());
    await commitAll('base'); // 先有 HEAD，注入的 stage 才能稳定呈现 AU / UA
    await writeFileAt('decks/冒险牌堆/10121_正面.png', 'x'); // 已登记卡的正面图（base 未提交）→ 卡图可反查
    await writeFileAt('ui/ab12cd.注入.xml', '<!-- x -->');
    await injectUnmergedStages('decks/冒险牌堆/10121_正面.png', [2]); // 我方新增 → AU
    await injectUnmergedStages('ui/ab12cd.注入.xml', [3]); // 对方新增 → UA
    const report = await analyzeConflicts(tempRoot);
    const byPath = new Map(report.conflicts.map((info) => [info.path, info]));
    expect(byPath.get('decks/冒险牌堆/10121_正面.png')).toMatchObject({ type: 'card-image', xy: 'AU' });
    expect(byPath.get('ui/ab12cd.注入.xml')).toMatchObject({ type: 'ui', xy: 'UA' });
    expect(report.hasConflicts).toBe(true);
  });

  it('根目录文件冲突（pack.yaml）：unknown，fallbackReason 提示不在已知目录', async () => {
    await initRepo();
    await scenario(
      { writes: [['pack.yaml', 'ours']] },
      { writes: [['pack.yaml', 'theirs']] },
      [['pack.yaml', 'base']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts[0]?.type).toBe('unknown');
    expect(report.conflicts[0]?.fallbackReason).toContain('pack.yaml');
    expect(report.conflicts[0]?.fallbackReason).toContain('已知目录');
    expect(report.unknownCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// analyzeConflicts：混合场景与中文路径
// ---------------------------------------------------------------------------

describe('analyzeConflicts：混合场景与中文路径', () => {
  it('混合冲突：cards-csv + card-image + script + object 并存，分组字段正确', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, defaultRows());
    await writeObjectsCsv(tempRoot, [makeObjectRow({ name: '棋子' })]);
    await scenario(
      {
        writes: [
          ['decks/冒险牌堆/cards.csv', 'ours-csv'],
          ['decks/冒险牌堆/10121_正面.png', 'ours-img'],
          ['scripts/Global.lua', '-- ours'],
          ['objects/棋子.obj', 'ours-obj'],
        ],
      },
      {
        writes: [
          ['decks/冒险牌堆/cards.csv', 'theirs-csv'],
          ['decks/冒险牌堆/10121_正面.png', 'theirs-img'],
          ['scripts/Global.lua', '-- theirs'],
          ['objects/棋子.obj', 'theirs-obj'],
        ],
      },
      [
        ['decks/冒险牌堆/cards.csv', 'base-csv'],
        ['decks/冒险牌堆/10121_正面.png', 'base-img'],
        ['scripts/Global.lua', '-- base'],
        ['objects/棋子.obj', 'base-obj'],
      ],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts).toHaveLength(4);
    const byPath = new Map(report.conflicts.map((info) => [info.path, info]));
    expect(byPath.get('decks/冒险牌堆/cards.csv')?.type).toBe('cards-csv');
    expect(byPath.get('decks/冒险牌堆/10121_正面.png')?.type).toBe('unknown'); // 卡表带标记 → 卡图无法反查
    expect(byPath.get('scripts/Global.lua')?.type).toBe('script');
    expect(byPath.get('objects/棋子.obj')?.type).toBe('object-asset');
    expect(report.cardsCsvConflictPaths).toEqual(['decks/冒险牌堆/cards.csv']);
    expect(report.unknownCount).toBe(1);
  });

  it('中文牌堆名 / 中文卡名 / 中文图片文件名：完整反查', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, [
      makeRow(10121, '迷路的旅人_正面.png', { name: '迷路的旅人', nickname: '旅人' }),
    ]);
    await scenario(
      { writes: [['decks/冒险牌堆/迷路的旅人_正面.png', 'ours']] },
      { writes: [['decks/冒险牌堆/迷路的旅人_正面.png', 'theirs']] },
      [['decks/冒险牌堆/迷路的旅人_正面.png', 'base']],
    );
    const report = await analyzeConflicts(tempRoot);
    const info = report.conflicts[0];
    expect(info?.path).toBe('decks/冒险牌堆/迷路的旅人_正面.png');
    expect(info?.type).toBe('card-image');
    expect(info?.card).toMatchObject({
      deckName: '冒险牌堆',
      deckGuid: '271fac',
      cardId: 10121,
      cardName: '迷路的旅人',
      cardNickname: '旅人',
      fileName: '迷路的旅人_正面.png',
      isBack: false,
    });
  });

  it('牌堆目录名含空格：反查成功（git -z 输出路径不被拆坏）', async () => {
    await initRepo();
    await setupDeck('冒险 牌堆', [makeRow(10121, '10121_正面.png', { name: '旅人' })], '带空格的牌堆');
    await scenario(
      { writes: [['decks/冒险 牌堆/10121_正面.png', 'ours']] },
      { writes: [['decks/冒险 牌堆/10121_正面.png', 'theirs']] },
      [['decks/冒险 牌堆/10121_正面.png', 'base']],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts[0]?.path).toBe('decks/冒险 牌堆/10121_正面.png');
    expect(report.conflicts[0]?.type).toBe('card-image');
    expect(report.conflicts[0]?.card?.deckName).toBe('带空格的牌堆');
    expect(report.conflicts[0]?.card?.cardId).toBe(10121);
  });
});

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

describe('反查缓存', () => {
  it('同一牌堆两张卡图冲突：cards.csv 只读一次，deck.yaml 也只读一次', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, defaultRows());
    await scenario(
      {
        writes: [
          ['decks/冒险牌堆/10121_正面.png', 'o1'],
          ['decks/冒险牌堆/10122_正面.png', 'o2'],
        ],
      },
      {
        writes: [
          ['decks/冒险牌堆/10121_正面.png', 't1'],
          ['decks/冒险牌堆/10122_正面.png', 't2'],
        ],
      },
      [
        ['decks/冒险牌堆/10121_正面.png', 'b1'],
        ['decks/冒险牌堆/10122_正面.png', 'b2'],
      ],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts).toHaveLength(2);
    expect(cardsCsvCallCount(DECK_DIR)).toBe(1);
    const manifestCalls = vi.mocked(readDeckManifest).mock.calls.filter(([dir]) => path.basename(dir) === DECK_DIR);
    expect(manifestCalls).toHaveLength(1);
  });

  it('两个牌堆各一张卡图：各自读一次 cards.csv（共 2 次）', async () => {
    await initRepo();
    await setupDeck('冒险牌堆', [makeRow(10121, '10121_正面.png', { name: '旅人' })]);
    await setupDeck('深渊牌堆', [makeRow(20201, '20201_正面.png', { name: '触手' })], '深渊牌堆', 'bb22cc');
    await scenario(
      {
        writes: [
          ['decks/冒险牌堆/10121_正面.png', 'o1'],
          ['decks/深渊牌堆/20201_正面.png', 'o2'],
        ],
      },
      {
        writes: [
          ['decks/冒险牌堆/10121_正面.png', 't1'],
          ['decks/深渊牌堆/20201_正面.png', 't2'],
        ],
      },
      [
        ['decks/冒险牌堆/10121_正面.png', 'b1'],
        ['decks/深渊牌堆/20201_正面.png', 'b2'],
      ],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts).toHaveLength(2);
    expect(cardsCsvCallCount('冒险牌堆')).toBe(1);
    expect(cardsCsvCallCount('深渊牌堆')).toBe(1);
  });

  it('多个 object 冲突：台账一次扫描内每个候选路径只读一次（双布局探测共 2 次）', async () => {
    await initRepo();
    await writeObjectsCsv(tempRoot, [
      makeObjectRow({ assetId: 'aa11bb', file: 'objects/棋子.obj' }),
      makeObjectRow({ assetId: 'cc22dd', file: 'objects/令牌.obj', name: '令牌' }),
    ]);
    await scenario(
      {
        writes: [
          ['objects/棋子.obj', 'o1'],
          ['objects/令牌.obj', 'o2'],
        ],
      },
      {
        writes: [
          ['objects/棋子.obj', 't1'],
          ['objects/令牌.obj', 't2'],
        ],
      },
      [
        ['objects/棋子.obj', 'b1'],
        ['objects/令牌.obj', 'b2'],
      ],
    );
    const report = await analyzeConflicts(tempRoot);
    expect(report.conflicts).toHaveLength(2);
    expect(report.conflicts.every((info) => info.type === 'object-asset')).toBe(true);
    // 台账在 pack 根：先探测 objects/objects.csv（NOT_FOUND）再兜底 pack 根 → 共 2 次读取；
    // 与冲突条数无关（2 个素材冲突不会读 4 次），即 objects.csv 读取已缓存
    expect(vi.mocked(readObjectsCsv).mock.calls).toHaveLength(2);
  });

  it('缓存不跨 analyzeConflicts 调用复用：每次扫描各自重新读取', async () => {
    await initRepo();
    await setupDeck(DECK_DIR, [makeRow(10121, '10121_正面.png', { name: '旅人' })]);
    await scenario(
      { writes: [['decks/冒险牌堆/10121_正面.png', 'ours']] },
      { writes: [['decks/冒险牌堆/10121_正面.png', 'theirs']] },
      [['decks/冒险牌堆/10121_正面.png', 'base']],
    );
    await analyzeConflicts(tempRoot);
    expect(cardsCsvCallCount(DECK_DIR)).toBe(1);
    await analyzeConflicts(tempRoot);
    expect(cardsCsvCallCount(DECK_DIR)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// formatConflict
// ---------------------------------------------------------------------------

describe('formatConflict', () => {
  it('card-image：完整模板含牌堆 / GUID / 卡名 / 正背面 / 图集 / 源 URL / 双侧命令提示', () => {
    const text = formatConflict({
      type: 'card-image',
      path: 'decks/冒险牌堆/001_正面.png',
      xy: 'UU',
      card: {
        deckName: '冒险牌堆',
        deckGuid: '271fac',
        cardId: 10121,
        cardName: '迷路的旅人',
        cardNickname: '旅人',
        fileName: '001_正面.png',
        isBack: false,
        sheetId: 1,
        slot: 21,
        sheetSource: 'https://steamusercontent-a.akamaihd.net/ugc/AAA/',
      },
    });
    expect(text).toContain('卡牌图片冲突');
    expect(text).toContain('牌堆：冒险牌堆 (GUID: 271fac)');
    expect(text).toContain('卡牌：迷路的旅人 (CardID: 10121)');
    expect(text).toContain('文件：decks/冒险牌堆/001_正面.png（正面）');
    expect(text).toContain('所属图集：sheet_id=1, slot=21');
    expect(text).toContain('源 URL：https://steamusercontent-a.akamaihd.net/ugc/AAA/');
    expect(text).toContain('冲突类型：双方都修改 (UU)');
    expect(text).toContain('git checkout --ours   decks/冒险牌堆/001_正面.png');
    expect(text).toContain('git checkout --theirs decks/冒险牌堆/001_正面.png');
    expect(text).toContain('图像工具合成');
  });

  it('card-image 背面：标注（背面）；无名卡：退化为纯 CardID 展示', () => {
    const backText = formatConflict({
      type: 'card-image',
      path: 'decks/冒险牌堆/通用_背面.png',
      xy: 'UU',
      card: {
        deckName: '冒险牌堆',
        deckGuid: '271fac',
        cardId: 10121,
        fileName: '通用_背面.png',
        isBack: true,
        sheetId: 1,
        slot: 21,
        sheetSource: SHEET_SOURCE,
      },
    });
    expect(backText).toContain('（背面）');

    const unnamed = formatConflict({
      type: 'card-image',
      path: 'decks/冒险牌堆/001.png',
      xy: 'AA',
      card: {
        deckName: '冒险牌堆',
        deckGuid: '',
        cardId: 10122,
        fileName: '001.png',
        isBack: false,
        sheetId: 1,
        slot: 22,
        sheetSource: SHEET_SOURCE,
      },
    });
    expect(unnamed).toContain('卡牌：(CardID: 10122)');
    expect(unnamed).toContain('牌堆：冒险牌堆'); // guid 空串时不输出 GUID 段
    expect(unnamed).not.toContain('(GUID:');
    expect(unnamed).toContain('冲突类型：双方都新增 (AA)');
  });

  it('cards-csv 与 deck-yaml：分别提示"先解决卡表"与元数据手工合并', () => {
    const cardsCsv = formatConflict({
      type: 'cards-csv',
      path: 'decks/冒险牌堆/cards.csv',
      xy: 'UU',
      deck: { deckName: '冒险牌堆', deckGuid: '271fac' },
    });
    expect(cardsCsv).toContain('cards.csv');
    expect(cardsCsv).toContain('必须先解决');
    expect(cardsCsv).toContain('卡牌反查不可用');
    expect(cardsCsv).toContain('牌堆：冒险牌堆 (GUID: 271fac)');

    const deckYaml = formatConflict({
      type: 'deck-yaml',
      path: 'decks/冒险牌堆/deck.yaml',
      xy: 'UU',
      deck: { deckName: '冒险牌堆', deckGuid: '' },
    });
    expect(deckYaml).toContain('deck.yaml');
    expect(deckYaml).toContain('元数据');
    expect(deckYaml).toContain('手工合并');
    expect(deckYaml).toContain('文件：decks/冒险牌堆/deck.yaml');
  });

  it('object-asset：含素材名与 AssetID 及双侧命令提示', () => {
    const text = formatConflict({
      type: 'object-asset',
      path: 'objects/棋子.obj',
      xy: 'UU',
      object: { assetId: 'aa11bb', name: '棋子', fileName: '棋子.obj' },
    });
    expect(text).toContain('素材文件冲突');
    expect(text).toContain('素材：棋子 (AssetID: aa11bb)');
    expect(text).toContain('文件：objects/棋子.obj');
    expect(text).toContain('git checkout --ours   objects/棋子.obj');
    expect(text).toContain('git checkout --theirs objects/棋子.obj');
  });

  it('script 与 ui：文本合并提示，含对象名与 GUID', () => {
    const script = formatConflict({
      type: 'script',
      path: 'scripts/Global.lua',
      xy: 'UU',
      script: { name: 'Global', guid: '-1' },
    });
    expect(script).toContain('Lua 脚本冲突');
    expect(script).toContain('对象：Global (GUID: -1)');
    expect(script).toContain('<<<<<<<');
    expect(script).toContain('git add');

    const ui = formatConflict({
      type: 'ui',
      path: 'ui/ab12cd.面板.xml',
      xy: 'UU',
      script: { name: '面板', guid: 'ab12cd' },
    });
    expect(ui).toContain('UI XML 冲突');
    expect(ui).toContain('对象：面板 (GUID: ab12cd)');
  });

  it('deleted-modified：DD 提示双方都删除与 git rm；DU 提示我方删除；附卡牌归属', () => {
    const dd = formatConflict({
      type: 'deleted-modified',
      path: 'decks/冒险牌堆/10121_正面.png',
      xy: 'DD',
      card: {
        deckName: '冒险牌堆',
        deckGuid: '271fac',
        cardId: 10121,
        cardName: '迷路的旅人',
        fileName: '10121_正面.png',
        isBack: false,
        sheetId: 1,
        slot: 21,
        sheetSource: SHEET_SOURCE,
      },
    });
    expect(dd).toContain('删除/修改冲突');
    expect(dd).toContain('冲突类型：双方都删除 (DD)');
    expect(dd).toContain('git rm decks/冒险牌堆/10121_正面.png');
    expect(dd).toContain('迷路的旅人 (CardID: 10121)');

    const du = formatConflict({
      type: 'deleted-modified',
      path: 'objects/棋子.obj',
      xy: 'DU',
    });
    expect(du).toContain('一方删除、一方修改（我方删除）');
    expect(du).toContain('需人工决策');
  });

  it('unknown 与未知 xy：输出 fallbackReason 原文与文件名，未知状态码不抛错', () => {
    const unknown = formatConflict({
      type: 'unknown',
      path: 'pack.yaml',
      xy: 'UU',
      fallbackReason: '冲突路径不在 decks/、objects/、scripts/、ui/ 已知目录下：pack.yaml',
    });
    expect(unknown).toContain('未识别的冲突文件');
    expect(unknown).toContain('文件：pack.yaml');
    expect(unknown).toContain('反查失败：冲突路径不在 decks/、objects/、scripts/、ui/ 已知目录下：pack.yaml');

    const weirdXy = formatConflict({
      type: 'unknown',
      path: 'x.txt',
      xy: 'ZZ',
      fallbackReason: '任意原因',
    });
    expect(weirdXy).toContain('未知状态 (ZZ)');
  });
});
