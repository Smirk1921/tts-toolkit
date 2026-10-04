// tests/unit/review-config.test.ts
/**
 * src/review/config.ts 单元测试：approval.config.json 的构建 / 写入 / 读回。
 *
 * 纯文件 IO（临时目录），无网络、无子进程、无审批工具依赖：
 * - 正常路径：buildApprovalConfig 的 data_dir 缺省落 `<packRoot>/.tts/approval/data`
 *   （方案设计 §13.2：不让审批工具往它自己仓库写）、源根目录绝对化、
 *   pair=basename / items_from=b / recurse=false（素材 id 恒为纯文件名）；
 *   write → read 往返一致；tags 显式给出才写出（缺省交给审批工具默认标签）；
 * - 异常路径：按 PackError.code（机器可读）断言，不依赖错误文案——
 *   文案走 t()（locales 已补 error.review.*，此处仍只断言 code，防文案改动破坏测试）；
 * - schema 严格性：未知字段 / port 越界 / sets 缺失 一律 REVIEW_CONFIG_INVALID；
 * - approvalSetFromDeck：从 deck.yaml 取显示名（DECK_NOT_FOUND 透传）、
 *   id 缺省取目录名、根目录必填。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeDeckManifest } from '../../src/pack/manifest.js';
import { PackError } from '../../src/pack/packyaml.js';
import {
  APPROVAL_IMAGE_EXCLUDE,
  APPROVAL_IMAGE_INCLUDE,
  approvalConfigPath,
  approvalDataDir,
  approvalSetFromDeck,
  buildApprovalConfig,
  isValidSetId,
  readApprovalConfig,
  readApprovalConfigStrict,
  writeApprovalConfig,
  type ApprovalSetSpec,
  type BuildApprovalConfigOptions,
} from '../../src/review/config.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-review-config-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 源A / 源B 目录（存在与否不重要，只拼进配置） */
const aRoot = () => path.join(tempRoot, 'decks', '旧版');
const bRoot = () => path.join(tempRoot, 'render', '新版');

const spec = (overrides: Partial<ApprovalSetSpec> = {}): ApprovalSetSpec => ({
  id: 'demo_cards',
  name: '演示·单卡对照',
  aRoot: aRoot(),
  bRoot: bRoot(),
  ...overrides,
});

/**
 * 断言同步函数抛出指定 code 的 PackError（按 code 断言，不依赖错误文案——
 * 文案走 t()，可能与 locales 补齐时点相关）。
 */
function expectPackErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PackError);
    expect((err as PackError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 PackError(${code})，但什么都没抛`);
}

// ---------------------------------------------------------------------------
// 路径换算与 setId
// ---------------------------------------------------------------------------

describe('路径换算', () => {
  it('approvalConfigPath / approvalDataDir 落在 .tts/approval/ 下', () => {
    expect(approvalConfigPath('P')).toBe(path.join('P', '.tts', 'approval', 'approval.config.json'));
    expect(approvalDataDir('P')).toBe(path.join('P', '.tts', 'approval', 'data'));
  });
});

describe('isValidSetId', () => {
  it.each([
    ['demo_cards', true],
    ['卡堆-01', true],
    ['', false],
    ['.', false],
    ['..', false],
    ['a/b', false],
    ['a\\b', false],
    ['a:b', false],
    ['a*b', false],
    ['a?b', false],
    ['a"b', false],
    ['a<b', false],
    ['a|b', false],
    ['a\nb', false],
  ])('%j → %j', (id, expected) => {
    expect(isValidSetId(id)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// buildApprovalConfig（纯构建）
// ---------------------------------------------------------------------------

describe('buildApprovalConfig', () => {
  it('缺省值：host/port/open_browser、data_dir 缺省落工作区内、根目录绝对化', () => {
    const cfg = buildApprovalConfig(tempRoot, { sets: spec() });
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(8765);
    expect(cfg.open_browser).toBe(false);
    expect(cfg.data_dir).toBe(path.resolve(tempRoot, '.tts', 'approval', 'data'));
    expect(cfg.sets).toHaveLength(1);
    const set = cfg.sets[0]!;
    expect(set.id).toBe('demo_cards');
    expect(set.type).toBe('image');
    expect(set.pair).toBe('basename');
    expect(set.items_from).toBe('b');
    expect(set.recurse).toBe(false);
    expect(set.a.root).toBe(path.resolve(aRoot()));
    expect(set.b.root).toBe(path.resolve(bRoot()));
    expect(set.a.label).toBe('');
    expect(set.include).toEqual([...APPROVAL_IMAGE_INCLUDE]);
    expect(set.exclude).toEqual([...APPROVAL_IMAGE_EXCLUDE]);
    // tags 未给 → 属性整个不出现（审批工具回退自己的默认标签）
    expect('tags' in cfg).toBe(false);
  });

  it('显式覆盖：host / port / dataDir / labels / tags（拷贝，不共享引用）', () => {
    const tags = ['文字溢出', '术语错'];
    const cfg = buildApprovalConfig(tempRoot, {
      sets: spec({ aLabel: '旧图', bLabel: '新图' }),
      tags,
      host: '0.0.0.0',
      port: 9999,
      dataDir: path.join(tempRoot, 'custom-data'),
    });
    tags.push('运行时改不动配置');
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.port).toBe(9999);
    expect(cfg.data_dir).toBe(path.resolve(tempRoot, 'custom-data'));
    expect(cfg.sets[0]!.a.label).toBe('旧图');
    expect(cfg.sets[0]!.b.label).toBe('新图');
    expect(cfg.tags).toEqual(['文字溢出', '术语错']);
  });

  it('sets 支持单对象或数组；数组顺序保持', () => {
    const cfg = buildApprovalConfig(tempRoot, { sets: [spec({ id: 's1' }), spec({ id: 's2' })] });
    expect(cfg.sets.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  // 用例入参用工厂惰性构造：it.each 的表在收集期求值，那时 tempRoot 还没建
  it.each([
    ['sets 为空数组', (): BuildApprovalConfigOptions => ({ sets: [] })],
    ['id 含路径分隔符', (): BuildApprovalConfigOptions => ({ sets: [spec({ id: 'a/b' })] })],
    ['id 为空', (): BuildApprovalConfigOptions => ({ sets: [spec({ id: '' })] })],
    ['name 为空', (): BuildApprovalConfigOptions => ({ sets: [spec({ name: '' })] })],
    ['aRoot 为空', (): BuildApprovalConfigOptions => ({ sets: [spec({ aRoot: '' })] })],
    ['bRoot 为空', (): BuildApprovalConfigOptions => ({ sets: [spec({ bRoot: '   ' })] })],
    ['tags 显式空数组', (): BuildApprovalConfigOptions => ({ sets: [spec()], tags: [] })],
  ])('入参不合法 → PackError REVIEW_CONFIG_INVALID：%s', (_label, makeOpts) => {
    // buildApprovalConfig 是同步函数：抛错而非 reject
    expectPackErrorCode(() => buildApprovalConfig(tempRoot, makeOpts()), 'REVIEW_CONFIG_INVALID');
  });
});

// ---------------------------------------------------------------------------
// writeApprovalConfig / readApprovalConfig（IO 往返）
// ---------------------------------------------------------------------------

describe('writeApprovalConfig', () => {
  it('写出合法 JSON；父目录自动创建；返回 configPath 与 dataDir', async () => {
    const { configPath, dataDir } = await writeApprovalConfig(tempRoot, { sets: spec() });
    expect(configPath).toBe(approvalConfigPath(tempRoot));
    expect(dataDir).toBe(path.resolve(tempRoot, '.tts', 'approval', 'data'));
    expect(existsSync(configPath)).toBe(true);

    const raw = await readFile(configPath, 'utf8');
    const data: Record<string, unknown> = JSON.parse(raw);
    expect(data['pair']).toBeUndefined(); // pair 在 sets 条目里，不在根上
    const sets = data['sets'] as Array<Record<string, unknown>>;
    expect(sets[0]!['pair']).toBe('basename');
    expect(sets[0]!['items_from']).toBe('b');
    // 2 空格缩进 + 末尾换行
    expect(raw).toContain('\n  "host"');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('write → read 往返一致（含 tags）', async () => {
    await writeApprovalConfig(tempRoot, { sets: spec(), tags: ['文字溢出'] });
    const readBack = await readApprovalConfig(approvalConfigPath(tempRoot));
    expect(readBack.sets[0]!.id).toBe('demo_cards');
    expect(readBack.tags).toEqual(['文字溢出']);
  });
});

describe('readApprovalConfig', () => {
  it('缺省值填充：host / port / open_browser / include / exclude / recurse / label', async () => {
    const configPath = path.join(tempRoot, 'cfg.json');
    await writeFile(
      configPath,
      JSON.stringify({
        data_dir: path.join(tempRoot, 'd'),
        sets: [{ id: 's', name: 'n', type: 'image', pair: 'basename', items_from: 'b', a: { root: 'A' }, b: { root: 'B' } }],
      }),
      'utf8',
    );
    const cfg = await readApprovalConfig(configPath);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(8765);
    expect(cfg.open_browser).toBe(false);
    expect(cfg.sets[0]!.include).toEqual([...APPROVAL_IMAGE_INCLUDE]);
    expect(cfg.sets[0]!.a.label).toBe('');
  });

  it('文件不存在 → REVIEW_CONFIG_NOT_FOUND', async () => {
    await expect(readApprovalConfig(path.join(tempRoot, 'absent.json'))).rejects.toMatchObject({
      code: 'REVIEW_CONFIG_NOT_FOUND',
    } satisfies Partial<PackError>);
  });

  it('不是合法 JSON → REVIEW_CONFIG_INVALID', async () => {
    const configPath = path.join(tempRoot, 'bad.json');
    await writeFile(configPath, '{not json', 'utf8');
    await expect(readApprovalConfig(configPath)).rejects.toMatchObject({
      code: 'REVIEW_CONFIG_INVALID',
    } satisfies Partial<PackError>);
  });

  it('未知字段 → REVIEW_CONFIG_INVALID（严格 schema，防拼写错误静默生效）', async () => {
    const configPath = path.join(tempRoot, 'unknown.json');
    await writeFile(
      configPath,
      JSON.stringify({ data_dir: 'd', typo_field: 1, sets: [] }),
      'utf8',
    );
    await expect(readApprovalConfig(configPath)).rejects.toMatchObject({
      code: 'REVIEW_CONFIG_INVALID',
    } satisfies Partial<PackError>);
  });

  it('port 越界 / sets 条目缺 pair → REVIEW_CONFIG_INVALID', async () => {
    const configPath = path.join(tempRoot, 'badport.json');
    await writeFile(
      configPath,
      JSON.stringify({ data_dir: 'd', port: 70000, sets: [] }),
      'utf8',
    );
    await expect(readApprovalConfig(configPath)).rejects.toMatchObject({
      code: 'REVIEW_CONFIG_INVALID',
    } satisfies Partial<PackError>);

    const configPath2 = path.join(tempRoot, 'nopair.json');
    await writeFile(
      configPath2,
      JSON.stringify({
        data_dir: 'd',
        sets: [{ id: 's', name: 'n', type: 'image', items_from: 'b', a: { root: 'A' }, b: { root: 'B' } }],
      }),
      'utf8',
    );
    await expect(readApprovalConfig(configPath2)).rejects.toMatchObject({
      code: 'REVIEW_CONFIG_INVALID',
    } satisfies Partial<PackError>);
  });

  it('sets 为空数组：宽松读允许，strict 读拒绝', async () => {
    const configPath = path.join(tempRoot, 'empty-sets.json');
    await writeFile(configPath, JSON.stringify({ data_dir: 'd', sets: [] }), 'utf8');
    await expect(readApprovalConfig(configPath)).resolves.toMatchObject({ sets: [] });
    await expect(readApprovalConfigStrict(configPath)).rejects.toMatchObject({
      code: 'REVIEW_CONFIG_INVALID',
    } satisfies Partial<PackError>);
  });
});

// ---------------------------------------------------------------------------
// approvalSetFromDeck（deck.yaml → 素材集条目）
// ---------------------------------------------------------------------------

describe('approvalSetFromDeck', () => {
  it('显示名缺省取 deck.yaml 的 name，id 缺省取目录名', async () => {
    const deckDir = path.join(tempRoot, '探索卡');
    await mkdir(deckDir, { recursive: true });
    await writeDeckManifest(deckDir, {
      schema_version: 1,
      name: '探索卡牌堆',
      guid: 'a1b2c3',
      shared_with: [],
    });
    const setSpec = await approvalSetFromDeck(deckDir, { aRoot: aRoot(), bRoot: bRoot() });
    expect(setSpec).toEqual({
      id: '探索卡',
      name: '探索卡牌堆',
      aRoot: aRoot(),
      bRoot: bRoot(),
    });
  });

  it('显式 id / name 覆盖 deck.yaml', async () => {
    const deckDir = path.join(tempRoot, 'deck-x');
    await mkdir(deckDir, { recursive: true });
    await writeDeckManifest(deckDir, {
      schema_version: 1,
      name: '旧名',
      guid: 'ffffff',
      shared_with: [],
    });
    const setSpec = await approvalSetFromDeck(deckDir, {
      id: 'custom-id',
      name: '自定义名',
      aRoot: aRoot(),
      bRoot: bRoot(),
    });
    expect(setSpec.id).toBe('custom-id');
    expect(setSpec.name).toBe('自定义名');
  });

  it('deck.yaml 不存在 → 透传 DECK_NOT_FOUND', async () => {
    const deckDir = path.join(tempRoot, 'no-deck');
    await mkdir(deckDir, { recursive: true });
    await expect(approvalSetFromDeck(deckDir, { aRoot: aRoot(), bRoot: bRoot() })).rejects.toMatchObject({
      code: 'DECK_NOT_FOUND',
    } satisfies Partial<PackError>);
  });

  it('根目录为空 → REVIEW_CONFIG_INVALID', async () => {
    const deckDir = path.join(tempRoot, 'deck-y');
    await mkdir(deckDir, { recursive: true });
    await writeDeckManifest(deckDir, { schema_version: 1, name: 'n', guid: 'abcdef', shared_with: [] });
    await expect(
      approvalSetFromDeck(deckDir, { aRoot: '', bRoot: bRoot() }),
    ).rejects.toMatchObject({ code: 'REVIEW_CONFIG_INVALID' } satisfies Partial<PackError>);
    await expect(
      approvalSetFromDeck(deckDir, { aRoot: aRoot(), bRoot: '' }),
    ).rejects.toMatchObject({ code: 'REVIEW_CONFIG_INVALID' } satisfies Partial<PackError>);
  });
});
