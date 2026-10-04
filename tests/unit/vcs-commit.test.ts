// tests/unit/vcs-commit.test.ts
/**
 * src/vcs/commit.ts 单元测试：语义化提交。
 *
 * 真实 git 子进程（execa 在 os.tmpdir() 的临时目录里跑 git init / config / add /
 * commit），用 writeCardsCsv / writeObjectsCsv 造合法卡表与素材台账，覆盖：
 * - 无改动（空仓库 / 干净仓库 / 非 git 目录透传 GIT_NOT_A_REPO）；
 * - autoSummary 模板：deck-cards（单卡 / 多卡 / 多 deck）、deck-cards-csv、
 *   deck-yaml、script、ui、object-asset、pack-yaml、metadata、unknown；
 * - 优先级排序（素材先出现但脚本排前）与"等 N 项改动"截断（恰好 3 条不加、
 *   4 / 5 条加且 N 为总条数）；
 * - userMessage 拼接（首尾空白 trim、纯空白视为未提供、自带全角冒号原样拼接）；
 * - dryRun（不 add 不 commit、工作区保持未暂存）、实际提交（commitHash 与
 *   git log %B / %H 回读一致、工作区干净）、autoAdd=false（只提交已暂存、
 *   未暂存改动残留、暂存区为空时 VCS_COMMIT_FAILED）；
 * - 错误路径（未配置提交者身份 → VCS_COMMIT_FAILED；嵌套未注册仓库 →
 *   VCS_ADD_FAILED，且均未产生提交）；
 * - 中文牌堆 / 卡名 / 文件名 + 中文 userMessage 的 message 往返（提交后 %B
 *   精确回读，验证编码无损）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCardsCsv, writeCardsCsv } from '../../src/deck/cards.js';
import type { CardRow } from '../../src/deck/cards.js';
import { writeObjectsCsv } from '../../src/deck/objects.js';
import type { ObjectRow } from '../../src/deck/objects.js';
import { PackError } from '../../src/pack/packyaml.js';
import { vcsCommit } from '../../src/vcs/commit.js';
import { headCommit, statusPorcelain } from '../../src/vcs/git.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-commit-'));
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

/**
 * 初始化一个固定分支名、关闭 autocrlf 的测试仓库。
 * @param dir 仓库目录，默认 tempRoot
 * @param opts.identity 是否配置提交者身份（默认配置；传 false 时不配置，
 *   供"未配置 user → commit 失败"用例使用）
 */
async function initRepo(dir: string = tempRoot, opts: { identity?: boolean } = {}): Promise<void> {
  await git(['init', '-b', 'main'], dir);
  await git(['config', 'core.autocrlf', 'false'], dir);
  if (opts.identity !== false) {
    await git(['config', 'user.email', 'test@test.local'], dir);
    await git(['config', 'user.name', 'tester'], dir);
  }
}

/** git add -A + commit（提交当前全部改动） */
async function commitAll(message: string, dir: string = tempRoot): Promise<void> {
  await git(['add', '-A'], dir);
  await git(['commit', '-m', message], dir);
}

/** 读取最近一次提交的完整 message（git log -1 --format=%B，去掉末尾换行——%B 自带一个、format 再补一个） */
async function lastCommitMessage(dir: string = tempRoot): Promise<string> {
  const result = await execa('git', ['log', '-1', '--format=%B'], { cwd: dir, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`git log 失败：${result.stderr}`);
  }
  return result.stdout.replace(/\r?\n+$/, '');
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

/** 在临时仓库里写一个文本文件（脚本 / UI / pack.yaml 等通用） */
async function writeText(relPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(tempRoot, relPath)), { recursive: true });
  await writeFile(path.join(tempRoot, relPath), content, 'utf8');
}

/** 写 pack.yaml（简化内容，语义分析只认路径不解析内容） */
async function writePackYamlFile(content: string): Promise<void> {
  await writeText('pack.yaml', content);
}

/**
 * 基线夹具：initRepo + 单卡牌堆（冒险牌堆 / 001_正面.png）已提交；
 * 随后把该卡图换成 PNG_B（工作区出现 1 张卡换图）。
 */
async function setupSingleCardChange(): Promise<void> {
  await initRepo();
  await writeDeck('冒险牌堆', [{ cardId: 101, face: '001_正面.png' }]);
  await commitAll('init');
  await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '001_正面.png'), PNG_B);
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
// 无改动与错误透传
// ---------------------------------------------------------------------------

describe('无改动与错误透传', () => {
  it('刚 init 的空仓库：不提交，message/autoSummary 为空，commitHash 为 null', async () => {
    await initRepo();
    const result = await vcsCommit({ packRoot: tempRoot });
    expect(result).toEqual({
      message: '',
      committed: false,
      commitHash: null,
      autoSummary: '',
      status: { dirty: false, changes: [], unknownCount: 0 },
    });
  });

  it('全部提交后的干净仓库：同样不提交，userMessage 被忽略', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [{ cardId: 101, face: '001_正面.png' }]);
    await writePackYamlFile('schema_version: 1\nname: 测试包\n');
    await commitAll('init');

    const result = await vcsCommit({ packRoot: tempRoot, userMessage: '手动消息' });
    expect(result.message).toBe('');
    expect(result.autoSummary).toBe('');
    expect(result.committed).toBe(false);
    expect(result.commitHash).toBeNull();
    expect(result.status.dirty).toBe(false);
    expect(result.status.changes).toEqual([]);
  });

  it('非 git 目录：透传 GIT_NOT_A_REPO，不映射成 VCS_*', async () => {
    const err = await expectPackError(() => vcsCommit({ packRoot: tempRoot }), 'GIT_NOT_A_REPO');
    expect(err.message).toContain('不是 git 仓库工作树');
  });
});

// ---------------------------------------------------------------------------
// autoSummary：各类改动的模板
// ---------------------------------------------------------------------------

describe('autoSummary：各类改动的模板', () => {
  it('单 deck 单卡改动：替换 <deck> 1 张卡图', async () => {
    await setupSingleCardChange();

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe('替换 冒险牌堆 1 张卡图');
    expect(result.message).toBe('替换 冒险牌堆 1 张卡图');
    expect(result.committed).toBe(false);
    expect(result.commitHash).toBeNull();
  });

  it('单 deck 多卡改动：替换 <deck> N 张卡图', async () => {
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

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe('替换 冒险牌堆 3 张卡图');
  });

  it('两个 deck 都换图：同 kind 按状态输出顺序并列，不加"等"', async () => {
    await initRepo();
    await writeDeck('牌堆A', [{ cardId: 101, face: '001_正面.png' }]);
    await writeDeck('牌堆B', [{ cardId: 101, face: '001_正面.png' }]);
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '牌堆A', '001_正面.png'), PNG_B);
    await writeFile(path.join(tempRoot, 'decks', '牌堆B', '001_正面.png'), PNG_B);

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe('替换 牌堆A 1 张卡图，替换 牌堆B 1 张卡图');
  });

  it('脚本改动：修改 <subject> 脚本（+X/-Y 行）', async () => {
    await initRepo();
    await writeText('scripts/Global.lua', 'a\nb\n');
    await commitAll('init');
    await writeText('scripts/Global.lua', 'a\nc\nd\n');

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe('修改 Global 脚本（+2/-1 行）');
  });

  it('UI 改动：修改 <subject> UI（+X/-Y 行）', async () => {
    await initRepo();
    await writeText('ui/Global.xml', '<UI>\n');
    await commitAll('init');
    await writeText('ui/Global.xml', '<UI>\n<Panel />\n');

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe('修改 Global UI（+1/-0 行）');
  });

  it('卡表改动：调整 <deck> 卡表', async () => {
    await initRepo();
    const deckDir = await writeDeck('冒险牌堆', [
      { cardId: 101, face: '001_正面.png', name: '旧名' },
      { cardId: 102, face: '002_正面.png' },
    ]);
    await commitAll('init');
    const rows = await readCardsCsv(deckDir);
    rows[0].name = '新名';
    await writeCardsCsv(deckDir, rows);

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe('调整 冒险牌堆 卡表');
  });

  it('deck.yaml 改动：调整 <deck> 元数据', async () => {
    await initRepo();
    const deckDir = await writeDeck('冒险牌堆', [{ cardId: 101, face: '001_正面.png' }]);
    await commitAll('init');
    await writeFile(path.join(deckDir, 'deck.yaml'), 'schema_version: 1\nname: 冒险牌堆改\nguid: ab12cd\n', 'utf8');

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe('调整 冒险牌堆 元数据');
  });

  it('pack.yaml 改动：调整图包配置', async () => {
    await initRepo();
    await writePackYamlFile('schema_version: 1\nname: 测试包\n');
    await commitAll('init');
    await writePackYamlFile('schema_version: 1\nname: 测试包\nworkshop_id: null\n');

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe('调整图包配置');
  });

  it('素材改动：更新素材 <assetId>', async () => {
    await initRepo();
    await writeObjectsLedger([{ assetId: 'obj_chess', file: 'objects/chess.png' }]);
    await writeObjectFile('objects/chess.png');
    await commitAll('init');
    await writeObjectFile('objects/chess.png', PNG_B);

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe('更新素材 obj_chess');
  });

  it('元数据改动（.gitattributes）：调整元数据', async () => {
    await initRepo();
    await writeText('.gitattributes', '*.png filter=lfs\n');
    await commitAll('init');
    await writeText('.gitattributes', '*.png filter=lfs\n*.jpg filter=lfs\n');

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe('调整元数据');
  });

  it('孤儿牌堆图片（cards.csv 缺失反查失败）：其他改动', async () => {
    await initRepo();
    const deckDir = path.join(tempRoot, 'decks', '孤儿牌堆');
    await mkdir(deckDir, { recursive: true });
    await writeFile(path.join(deckDir, '001_正面.png'), PNG_A);
    await commitAll('init');
    await writeFile(path.join(deckDir, '001_正面.png'), PNG_B);

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe('其他改动');
  });
});

// ---------------------------------------------------------------------------
// 优先级排序与"等 N 项改动"
// ---------------------------------------------------------------------------

describe('优先级排序与"等 N 项改动"', () => {
  it('素材 + 脚本同时改动：按优先级脚本在前（状态输出里素材先出现）', async () => {
    await initRepo();
    await writeObjectsLedger([{ assetId: 'obj_chess', file: 'objects/chess.png' }]);
    await writeObjectFile('objects/chess.png');
    await writeText('scripts/Global.lua', 'a\nb\n');
    await commitAll('init');
    await writeObjectFile('objects/chess.png', PNG_B);
    await writeText('scripts/Global.lua', 'a\nc\n');

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe('修改 Global 脚本（+1/-1 行），更新素材 obj_chess');
    // 状态输出的首次出现顺序确为素材在前，证明摘要确实按优先级重排过
    expect(result.status.changes[0]?.kind).toBe('object-asset');
    expect(result.status.changes[1]?.kind).toBe('script');
  });

  it('混合改动（卡图 + 脚本）：替换…，修改…', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [
      { cardId: 101, face: '001_正面.png' },
      { cardId: 102, face: '002_正面.png' },
    ]);
    await writeText('scripts/Global.lua', 'a\nb\n');
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '001_正面.png'), PNG_B);
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '002_正面.png'), PNG_B);
    await writeText('scripts/Global.lua', 'a\nc\nd\n');

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe('替换 冒险牌堆 2 张卡图，修改 Global 脚本（+2/-1 行）');
  });

  it('恰好 3 条改动：取前 3 条，不加"等"', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [{ cardId: 101, face: '001_正面.png' }]);
    await writeText('scripts/Global.lua', 'a\nb\n');
    await writePackYamlFile('schema_version: 1\nname: 测试包\n');
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '001_正面.png'), PNG_B);
    await writeText('scripts/Global.lua', 'a\nb\nc\n');
    await writePackYamlFile('schema_version: 1\nname: 测试包\nworkshop_id: null\n');

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe(
      '替换 冒险牌堆 1 张卡图，修改 Global 脚本（+1/-0 行），调整图包配置',
    );
  });

  it('4 条改动：取优先级前 3 条，末尾加"等 4 项改动"（N 为总条数）', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [{ cardId: 101, face: '001_正面.png' }]);
    await writeText('scripts/Global.lua', 'a\nb\n');
    await writePackYamlFile('schema_version: 1\nname: 测试包\n');
    await writeText('.gitattributes', '*.png filter=lfs\n');
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '001_正面.png'), PNG_B);
    await writeText('scripts/Global.lua', 'a\nb\nc\n');
    await writePackYamlFile('schema_version: 1\nname: 测试包\nworkshop_id: null\n');
    await writeText('.gitattributes', '*.png filter=lfs\n*.jpg filter=lfs\n');

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe(
      '替换 冒险牌堆 1 张卡图，修改 Global 脚本（+1/-0 行），调整图包配置等 4 项改动',
    );
    expect(result.status.changes).toHaveLength(4);
  });

  it('5 条改动：取优先级前 3 条（deck-cards / deck-cards-csv / script），末尾加"等 5 项改动"', async () => {
    await initRepo();
    const deckDir = await writeDeck('冒险牌堆', [
      { cardId: 101, face: '001_正面.png', name: '旧名' },
      { cardId: 102, face: '002_正面.png', name: '旧名二' },
    ]);
    await writeText('scripts/Global.lua', 'a\nb\n');
    await writeText('ui/Global.xml', '<UI>\n');
    await commitAll('init');
    await writeFile(path.join(deckDir, '001_正面.png'), PNG_B);
    await writeFile(path.join(deckDir, '002_正面.png'), PNG_B);
    const rows = await readCardsCsv(deckDir);
    rows[0].name = '新名';
    rows[1].name = '新名二';
    await writeCardsCsv(deckDir, rows);
    await writeFile(path.join(deckDir, 'deck.yaml'), 'schema_version: 1\nname: 冒险牌堆改\nguid: ab12cd\n', 'utf8');
    await writeText('scripts/Global.lua', 'a\nc\nd\n');
    await writeText('ui/Global.xml', '<UI>\n<Panel />\n');

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.autoSummary).toBe(
      '替换 冒险牌堆 2 张卡图，调整 冒险牌堆 卡表，修改 Global 脚本（+2/-1 行）等 5 项改动',
    );
    expect(result.status.changes).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// userMessage 拼接
// ---------------------------------------------------------------------------

describe('userMessage 拼接', () => {
  it('有 userMessage："<userMessage>：<autoSummary>"，autoSummary 不含用户部分', async () => {
    await setupSingleCardChange();

    const result = await vcsCommit({ packRoot: tempRoot, userMessage: '汉化冒险牌堆', dryRun: true });
    expect(result.message).toBe('汉化冒险牌堆：替换 冒险牌堆 1 张卡图');
    expect(result.autoSummary).toBe('替换 冒险牌堆 1 张卡图');
  });

  it('userMessage 首尾空白被去除后再拼接', async () => {
    await setupSingleCardChange();

    const result = await vcsCommit({ packRoot: tempRoot, userMessage: '  修复卡图  ', dryRun: true });
    expect(result.message).toBe('修复卡图：替换 冒险牌堆 1 张卡图');
  });

  it('userMessage 为纯空白：视为未提供，message 就是 autoSummary', async () => {
    await setupSingleCardChange();

    const result = await vcsCommit({ packRoot: tempRoot, userMessage: '   ', dryRun: true });
    expect(result.message).toBe('替换 冒险牌堆 1 张卡图');
    expect(result.autoSummary).toBe('替换 冒险牌堆 1 张卡图');
  });

  it('userMessage 本身含全角冒号：原样拼接不转义', async () => {
    await setupSingleCardChange();

    const result = await vcsCommit({ packRoot: tempRoot, userMessage: 'v2：重点修复', dryRun: true });
    expect(result.message).toBe('v2：重点修复：替换 冒险牌堆 1 张卡图');
  });
});

// ---------------------------------------------------------------------------
// dryRun 与实际提交
// ---------------------------------------------------------------------------

describe('dryRun 与实际提交', () => {
  it('dryRun=true：message 已生成，但不 add 不 commit，工作区保持未暂存', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [{ cardId: 101, face: '001_正面.png' }]);
    await writeText('scripts/Global.lua', 'a\nb\n');
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '001_正面.png'), PNG_B);
    await writeText('scripts/Global.lua', 'a\nc\n');

    const baselineHash = await headCommit(tempRoot);

    const result = await vcsCommit({ packRoot: tempRoot, dryRun: true });
    expect(result.committed).toBe(false);
    expect(result.commitHash).toBeNull();
    expect(result.autoSummary).toBe('替换 冒险牌堆 1 张卡图，修改 Global 脚本（+1/-1 行）');
    expect(result.status.dirty).toBe(true);

    // autoAdd 未执行：改动仍是未暂存状态（" M"），且没有新提交产生
    const entries = await statusPorcelain(tempRoot);
    expect(entries.map((entry) => [entry.xy, entry.path])).toEqual([
      [' M', 'decks/冒险牌堆/001_正面.png'],
      [' M', 'scripts/Global.lua'],
    ]);
    await expect(headCommit(tempRoot)).resolves.toBe(baselineHash);
  });

  it('默认参数（autoAdd=true, dryRun=false）：实际提交，hash 非空，%B 与 message 一致，工作区干净', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [{ cardId: 101, face: '001_正面.png' }]);
    await writeText('scripts/Global.lua', 'a\nb\n');
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '001_正面.png'), PNG_B);
    await writeText('scripts/Global.lua', 'a\nc\nd\n');

    const result = await vcsCommit({ packRoot: tempRoot });
    expect(result.committed).toBe(true);
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.message).toBe('替换 冒险牌堆 1 张卡图，修改 Global 脚本（+2/-1 行）');
    expect(result.message).toBe(result.autoSummary);
    // status 是提交前的快照
    expect(result.status.dirty).toBe(true);
    expect(result.status.changes).toHaveLength(2);

    expect(await lastCommitMessage()).toBe(result.message);
    await expect(headCommit(tempRoot)).resolves.toBe(result.commitHash);
    await expect(statusPorcelain(tempRoot)).resolves.toEqual([]);
  });

  it('autoAdd=false：只提交已暂存内容，未暂存改动留在工作区', async () => {
    await initRepo();
    await writeText('scripts/Global.lua', 'a\n');
    await writeText('scripts/Other.lua', 'x\n');
    await commitAll('init');
    await writeText('scripts/Global.lua', 'a\nb\n');
    await writeText('scripts/Other.lua', 'x\ny\n');
    await git(['add', 'scripts/Global.lua']);

    const result = await vcsCommit({ packRoot: tempRoot, autoAdd: false });
    expect(result.committed).toBe(true);
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
    // message 仍按提交前的全部分动生成（两个脚本都在摘要里）。
    // 已暂存的 Global.lua 在 git diff（工作区 vs 暂存区）中无记录，行数走
    // semantic.ts 的兜底规则：按工作区现存文件行数记 added（2 行文件 → +2/-0）。
    expect(result.autoSummary).toBe('修改 Global 脚本（+2/-0 行），修改 Other 脚本（+1/-0 行）');
    expect(await lastCommitMessage()).toBe(result.message);

    // Other.lua 未被提交，仍以未暂存状态留在工作区
    const entries = await statusPorcelain(tempRoot);
    expect(entries.map((entry) => [entry.xy, entry.path])).toEqual([[' M', 'scripts/Other.lua']]);
  });

  it('autoAdd=false 且暂存区为空：git commit 失败 → VCS_COMMIT_FAILED', async () => {
    await initRepo();
    await writeText('scripts/Global.lua', 'a\nb\n');
    await commitAll('init');
    await writeText('scripts/Global.lua', 'a\nc\n');

    const err = await expectPackError(
      () => vcsCommit({ packRoot: tempRoot, autoAdd: false }),
      'VCS_COMMIT_FAILED',
    );
    expect(err.message).toContain('git commit');
  });
});

// ---------------------------------------------------------------------------
// 错误路径：真实 git 失败 → VCS_* 错误码
// ---------------------------------------------------------------------------

describe('错误路径：真实 git 失败 → VCS_* 错误码', () => {
  it('未配置提交者身份：git commit 失败 → VCS_COMMIT_FAILED，且没有产生提交', async () => {
    await initRepo(tempRoot, { identity: false });
    // 本地空身份覆盖可能存在的全局配置，保证"未配置 user"的失败可复现
    await git(['config', 'user.email', ''], tempRoot);
    await git(['config', 'user.name', ''], tempRoot);
    await writeText('scripts/Global.lua', 'a\n');

    const err = await expectPackError(() => vcsCommit({ packRoot: tempRoot }), 'VCS_COMMIT_FAILED');
    expect(err.message).toContain('git commit');
    await expect(headCommit(tempRoot)).resolves.toBeNull();
  });

  it('git add 失败（嵌套未注册仓库）：VCS_ADD_FAILED，且没有产生提交', async () => {
    await initRepo();
    const subDir = path.join(tempRoot, 'sub');
    await mkdir(subDir, { recursive: true });
    await git(['init'], subDir); // 嵌套仓库：git add -A 报 "does not have a commit checked out"
    await writeText('a.txt', 'a\n');

    const err = await expectPackError(() => vcsCommit({ packRoot: tempRoot }), 'VCS_ADD_FAILED');
    expect(err.message).toContain('git add');
    await expect(headCommit(tempRoot)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 中文与 message 往返
// ---------------------------------------------------------------------------

describe('中文与 message 往返', () => {
  it('中文牌堆 / 卡名 / 文件名 + 中文 userMessage：提交后 %B 精确回读', async () => {
    await initRepo();
    await writeDeck('武侠 牌堆', [{ cardId: 7, face: '01_剑客.png', name: '剑客' }]);
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '武侠 牌堆', '01_剑客.png'), PNG_B);

    const result = await vcsCommit({ packRoot: tempRoot, userMessage: '汉化：第一批' });
    expect(result.committed).toBe(true);
    expect(result.message).toBe('汉化：第一批：替换 武侠 牌堆 1 张卡图');
    expect(await lastCommitMessage()).toBe('汉化：第一批：替换 武侠 牌堆 1 张卡图');
  });

  it('混合改动 + userMessage 的完整 message（含全角括号与行数），提交后回读一致', async () => {
    await initRepo();
    await writeDeck('冒险牌堆', [
      { cardId: 101, face: '001_正面.png' },
      { cardId: 102, face: '002_正面.png' },
    ]);
    await writeText('scripts/Global.lua', 'a\nb\n');
    await commitAll('init');
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '001_正面.png'), PNG_B);
    await writeFile(path.join(tempRoot, 'decks', '冒险牌堆', '002_正面.png'), PNG_B);
    await writeText('scripts/Global.lua', 'a\nc\nd\n');

    const result = await vcsCommit({ packRoot: tempRoot, userMessage: '汉化冒险牌堆' });
    expect(result.message).toBe('汉化冒险牌堆：替换 冒险牌堆 2 张卡图，修改 Global 脚本（+2/-1 行）');
    expect(await lastCommitMessage()).toBe(result.message);
    await expect(statusPorcelain(tempRoot)).resolves.toEqual([]);
  });
});
