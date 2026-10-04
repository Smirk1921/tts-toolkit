// tests/unit/pack-registry.test.ts
/**
 * src/pack/registry.ts 单元测试：多图包索引 .registry.yaml 的读 / 写 / upsert / remove / find。
 *
 * 纯文件 IO（临时目录），无网络、无 TTS、无 git 依赖：
 * - 正常路径：文件不存在容错返回空表、write → read 往返一致、
 *   upsert 的替换 / 追加 / modified 保留语义、中文与含空格目录名全流程；
 * - 异常路径：按 PackError.code（机器可读）断言，不依赖错误文案——
 *   B3 约定模块内错误消息写死中文不走 t()，故 message 内容可直接断言；
 * - 乐观锁（S6）：read 之后用 fs.utimes 改 mtime 模拟并发写，upsert / remove
 *   必须抛 REGISTRY_CONFLICT 且文件一个字节都不变；
 * - schema 严格性：未知字段 / 缺必填字段 / 非法枚举 / 非法 dir 一律 REGISTRY_INVALID
 *   且绝不落盘。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PACK_KINDS,
  REGISTRY_FILENAME,
  findPack,
  readRegistry,
  registryPath,
  removePack,
  upsertPack,
  writeRegistry,
  type PackEntry,
  type Registry,
} from '../../src/pack/registry.js';
import { PackError } from '../../src/pack/packyaml.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时 packs 根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-pack-registry-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 默认注册表文件完整路径 */
function regPath(): string {
  return registryPath(tempRoot);
}

/** 字段齐全的合法条目（upstream 指向工坊；测试用它做各种覆盖变体） */
function makeEntry(overrides: Partial<PackEntry> = {}): PackEntry {
  return {
    dir: '第七大陆全扩',
    name: '第七大陆全扩（脚本汉化）',
    kind: 'localization',
    upstream: { workshop_id: 1234567, last_synced: '2026-09-20', local_commit: 'a1b2c3d' },
    branch: 'zh-cn',
    host: 'steamcloud',
    modified: '2026-10-04',
    stats: { decks: 60, cards: 3010, scripts: 34 },
    lfs_status: 'enabled',
    ...overrides,
  };
}

/** 字段齐全的合法注册表（两条：有 upstream 与 upstream: null 各一） */
const fullRegistry: Registry = {
  schema_version: 1,
  packs: [
    makeEntry(),
    makeEntry({
      dir: 'origin-lab',
      name: '原创实验室',
      kind: 'original',
      upstream: null,
      branch: 'main',
      host: 'imgur',
      modified: '2026-10-01',
      stats: { decks: 2, cards: 40, scripts: 3 },
      lfs_status: 'disabled-no-lfs',
    }),
  ],
};

/** 单条目的合法 YAML（手写文本，覆盖变体从这里 replace 生成） */
const validEntryYaml = [
  '  - dir: 第七大陆全扩',
  '    name: 第七大陆全扩（脚本汉化）',
  '    kind: localization',
  '    upstream:',
  '      workshop_id: 1234567',
  '      last_synced: "2026-09-20"',
  '      local_commit: a1b2c3d',
  '    branch: zh-cn',
  '    host: steamcloud',
  '    modified: "2026-10-04"',
  '    stats:',
  '      decks: 60',
  '      cards: 3010',
  '      scripts: 34',
  '    lfs_status: enabled',
].join('\n');

/** 单条目合法注册表的完整 YAML 文本 */
const validRegistryYaml = `schema_version: 1\npacks:\n${validEntryYaml}\n`;

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

/** 在 packs 根目录直接写一份 .registry.yaml（绕过 writeRegistry，用于构造"手改的坏文件"） */
async function writeRawRegistry(text: string): Promise<void> {
  await writeFile(regPath(), text, 'utf8');
}

/** 把 mtime 改到一个明显不同的时间点（+10 分钟，避开文件系统 mtime 粒度） */
async function bumpMtime(): Promise<void> {
  const future = new Date(Date.now() + 600_000);
  await utimes(regPath(), future, future);
}

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

describe('常量与路径', () => {
  it('REGISTRY_FILENAME 为 .registry.yaml；PACK_KINDS 枚举取值正确', () => {
    expect(REGISTRY_FILENAME).toBe('.registry.yaml');
    expect([...PACK_KINDS]).toEqual(['original', 'localization', 'modification']);
  });

  it('registryPath 拼出 <packsRoot>/.registry.yaml', () => {
    expect(registryPath(path.join('some', 'packs'))).toBe(path.join('some', 'packs', '.registry.yaml'));
  });
});

// ---------------------------------------------------------------------------
// readRegistry
// ---------------------------------------------------------------------------

describe('readRegistry：正常路径', () => {
  it('文件不存在 → 容错返回空注册表，且不创建文件', async () => {
    const reg = await readRegistry(tempRoot);
    expect(reg).toEqual({ schema_version: 1, packs: [] });
    expect(existsSync(regPath())).toBe(false);
  });

  it('空 packs 表（packs: []）正常读取', async () => {
    await writeRawRegistry('schema_version: 1\npacks: []\n');
    const reg = await readRegistry(tempRoot);
    expect(reg.schema_version).toBe(1);
    expect(reg.packs).toEqual([]);
  });

  it('完整注册表读取：含 upstream 与 upstream: null 两种条目，字段逐项一致', async () => {
    await writeRawRegistry(validRegistryYaml);
    const reg = await readRegistry(tempRoot);
    expect(reg).toEqual({
      schema_version: 1,
      packs: [makeEntry()],
    });
  });
});

describe('readRegistry：错误路径', () => {
  it('不是合法 YAML（语法错误）→ REGISTRY_INVALID', async () => {
    await writeRawRegistry('schema_version: 1\npacks: [未闭合\n');
    await expectPackError(() => readRegistry(tempRoot), 'REGISTRY_INVALID');
  });

  it('根不是键值对象（数组 / 空文档）→ REGISTRY_INVALID', async () => {
    await writeRawRegistry('- a\n- b\n');
    await expectPackError(() => readRegistry(tempRoot), 'REGISTRY_INVALID');
    await writeRawRegistry('');
    await expectPackError(() => readRegistry(tempRoot), 'REGISTRY_INVALID');
  });

  it('.registry.yaml 是目录而非文件（非 ENOENT 的 IO 错误）→ REGISTRY_READ_FAILED', async () => {
    await mkdir(regPath());
    const err = await expectPackError(() => readRegistry(tempRoot), 'REGISTRY_READ_FAILED');
    expect(err.message.includes(REGISTRY_FILENAME)).toBe(true);
  });

  const badRegistries: Array<[string, string]> = [
    ['缺 packs', 'schema_version: 1\n'],
    ['packs 不是数组', 'schema_version: 1\npacks: not-a-list\n'],
    [
      '条目含未知字段（拼写错误必须被拒绝）',
      `schema_version: 1\npacks:\n${validEntryYaml}\n    extra: x\n`,
    ],
    ['kind 非法值', validRegistryYaml.replace('kind: localization', 'kind: fork')],
    ['lfs_status 非法值', validRegistryYaml.replace('lfs_status: enabled', 'lfs_status: auto')],
    [
      'modified 不是 ISO 日期',
      validRegistryYaml.replace('modified: "2026-10-04"', 'modified: 2026/10/04'),
    ],
    ['dir 含路径分隔符', validRegistryYaml.replace('dir: 第七大陆全扩', 'dir: ../escape')],
    ['upstream.workshop_id 不是正整数', validRegistryYaml.replace('workshop_id: 1234567', 'workshop_id: 0')],
  ];

  for (const [label, yamlText] of badRegistries) {
    it(`schema 违例 → REGISTRY_INVALID：${label}`, async () => {
      await writeRawRegistry(yamlText);
      const err = await expectPackError(() => readRegistry(tempRoot), 'REGISTRY_INVALID');
      // B3 模块错误消息写死中文：摘要里应含字段路径或中文说明
      expect(err.message.includes('schema') || err.message.includes('YAML')).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// writeRegistry
// ---------------------------------------------------------------------------

describe('writeRegistry', () => {
  it('正常写入 → readRegistry 往返一致', async () => {
    await writeRegistry(tempRoot, fullRegistry);
    const read = await readRegistry(tempRoot);
    expect(read).toEqual(fullRegistry);
  });

  it('packsRoot 不存在时自动逐级创建', async () => {
    const deepRoot = path.join(tempRoot, 'collections', '主线包');
    await writeRegistry(deepRoot, fullRegistry);
    expect(existsSync(registryPath(deepRoot))).toBe(true);
    const read = await readRegistry(deepRoot);
    expect(read.packs).toHaveLength(2);
  });

  it('根含未知字段 → REGISTRY_INVALID 且不落盘', async () => {
    const bad = { ...fullRegistry, extra: true } as unknown as Registry;
    await expectPackError(() => writeRegistry(tempRoot, bad), 'REGISTRY_INVALID');
    expect(existsSync(regPath())).toBe(false);
  });

  it('条目缺必填字段（缺 branch）→ REGISTRY_INVALID 且不落盘', async () => {
    const { branch: _branch, ...rest } = makeEntry();
    const bad = { schema_version: 1, packs: [rest] } as unknown as Registry;
    await expectPackError(() => writeRegistry(tempRoot, bad), 'REGISTRY_INVALID');
    expect(existsSync(regPath())).toBe(false);
  });

  it('落盘内容是合法 YAML 文本（含 schema_version: 1、dir 与 upstream: null）', async () => {
    await writeRegistry(tempRoot, fullRegistry);
    const raw = await readFile(regPath(), 'utf8');
    expect(raw).toContain('schema_version: 1');
    expect(raw).toContain('dir: 第七大陆全扩');
    expect(raw).toContain('upstream: null');
  });
});

// ---------------------------------------------------------------------------
// upsertPack
// ---------------------------------------------------------------------------

describe('upsertPack', () => {
  it('注册表文件不存在时新增 → 创建文件并追加一条', async () => {
    const entry = makeEntry();
    await upsertPack(tempRoot, entry);
    expect(existsSync(regPath())).toBe(true);
    const reg = await readRegistry(tempRoot);
    expect(reg.packs).toEqual([entry]);
  });

  it('已有表追加新条目 → 原条目保留、新条目在末尾', async () => {
    await upsertPack(tempRoot, makeEntry());
    const second = makeEntry({ dir: 'origin-lab', name: '原创实验室', kind: 'original', upstream: null });
    await upsertPack(tempRoot, second);
    const reg = await readRegistry(tempRoot);
    expect(reg.packs).toHaveLength(2);
    expect(reg.packs[0].dir).toBe('第七大陆全扩');
    expect(reg.packs[1]).toEqual(second);
  });

  it('替换已存在 dir 的整行 → name / stats 更新生效，条数不变', async () => {
    await upsertPack(tempRoot, makeEntry());
    const replacement = makeEntry({
      name: '第七大陆全扩（重命名）',
      stats: { decks: 61, cards: 3020, scripts: 35 },
      upstream: null,
    });
    await upsertPack(tempRoot, replacement);
    const reg = await readRegistry(tempRoot);
    expect(reg.packs).toHaveLength(1);
    expect(reg.packs[0]).toEqual(replacement);
  });

  it('替换时 modified 传 "" → 保留原条目的 modified', async () => {
    await upsertPack(tempRoot, makeEntry());
    await upsertPack(tempRoot, makeEntry({ modified: '', stats: { decks: 62, cards: 3030, scripts: 36 } }));
    const entry = await findPack(tempRoot, '第七大陆全扩');
    expect(entry?.modified).toBe('2026-10-04');
    expect(entry?.stats).toEqual({ decks: 62, cards: 3030, scripts: 36 });
  });

  it('替换时显式传入新 modified → 覆盖原值', async () => {
    await upsertPack(tempRoot, makeEntry());
    await upsertPack(tempRoot, makeEntry({ modified: '2026-11-01' }));
    const entry = await findPack(tempRoot, '第七大陆全扩');
    expect(entry?.modified).toBe('2026-11-01');
  });

  it('新增时 modified 传 "" → 自动填当天 UTC 日期', async () => {
    await upsertPack(tempRoot, makeEntry({ modified: '' }));
    const entry = await findPack(tempRoot, '第七大陆全扩');
    expect(entry?.modified).toBe(new Date().toISOString().slice(0, 10));
  });

  it('并发冲突：读取后 mtime 被改动（fs.utimes）→ REGISTRY_CONFLICT 且文件内容未被改动', async () => {
    await upsertPack(tempRoot, makeEntry());
    await readRegistry(tempRoot); // 任务点名的"先 read"
    await bumpMtime();
    const err = await expectPackError(
      () => upsertPack(tempRoot, makeEntry({ stats: { decks: 99, cards: 9999, scripts: 99 } })),
      'REGISTRY_CONFLICT',
    );
    expect(err.message.includes(tempRoot) || err.message.includes('.registry.yaml')).toBe(true);
    const reg = await readRegistry(tempRoot);
    expect(reg.packs[0].stats).toEqual({ decks: 60, cards: 3010, scripts: 34 });
  });

  it('dir 含路径分隔符 → REGISTRY_INVALID 且文件未被改动', async () => {
    await upsertPack(tempRoot, makeEntry());
    await expectPackError(() => upsertPack(tempRoot, makeEntry({ dir: '../escape' })), 'REGISTRY_INVALID');
    const reg = await readRegistry(tempRoot);
    expect(reg.packs).toHaveLength(1);
    expect(reg.packs[0].dir).toBe('第七大陆全扩');
  });

  it('入参 host 非法 → REGISTRY_INVALID 且文件未被改动', async () => {
    await upsertPack(tempRoot, makeEntry());
    await expectPackError(
      () => upsertPack(tempRoot, makeEntry({ dir: '另一个包', host: 'weibo' as PackEntry['host'] })),
      'REGISTRY_INVALID',
    );
    const reg = await readRegistry(tempRoot);
    expect(reg.packs).toHaveLength(1);
    expect(reg.packs[0].dir).toBe('第七大陆全扩');
  });
});

// ---------------------------------------------------------------------------
// removePack
// ---------------------------------------------------------------------------

describe('removePack', () => {
  it('正常删除：目标条目移除，其余保留', async () => {
    await writeRegistry(tempRoot, fullRegistry);
    await removePack(tempRoot, '第七大陆全扩');
    const reg = await readRegistry(tempRoot);
    expect(reg.packs).toHaveLength(1);
    expect(reg.packs[0].dir).toBe('origin-lab');
  });

  it('删除最后一条 → packs 变为空数组', async () => {
    await upsertPack(tempRoot, makeEntry());
    await removePack(tempRoot, '第七大陆全扩');
    const reg = await readRegistry(tempRoot);
    expect(reg.packs).toEqual([]);
  });

  it('dir 不存在 → REGISTRY_PACK_NOT_FOUND（含注册表文件不存在的情况）', async () => {
    await upsertPack(tempRoot, makeEntry());
    const err = await expectPackError(() => removePack(tempRoot, '不存在的包'), 'REGISTRY_PACK_NOT_FOUND');
    expect(err.message.includes('不存在的包')).toBe(true);
    // 注册表文件本身不存在时同样报此错（空表里当然没有）
    const emptyRoot = path.join(tempRoot, 'empty');
    await expectPackError(() => removePack(emptyRoot, '第七大陆全扩'), 'REGISTRY_PACK_NOT_FOUND');
  });

  it('并发冲突：读取后 mtime 被改动 → REGISTRY_CONFLICT 且条目未被删除', async () => {
    await upsertPack(tempRoot, makeEntry());
    await bumpMtime();
    await expectPackError(() => removePack(tempRoot, '第七大陆全扩'), 'REGISTRY_CONFLICT');
    const reg = await readRegistry(tempRoot);
    expect(reg.packs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// findPack
// ---------------------------------------------------------------------------

describe('findPack', () => {
  it('找到 → 返回完整条目', async () => {
    await writeRegistry(tempRoot, fullRegistry);
    const found = await findPack(tempRoot, 'origin-lab');
    expect(found).toEqual(fullRegistry.packs[1]);
  });

  it('找不到 → 返回 null（不抛错）', async () => {
    await writeRegistry(tempRoot, fullRegistry);
    expect(await findPack(tempRoot, '不存在的包')).toBeNull();
  });

  it('注册表文件不存在 → 容错返回 null', async () => {
    expect(await findPack(tempRoot, '第七大陆全扩')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 中文与空格目录名
// ---------------------------------------------------------------------------

describe('中文与空格目录名', () => {
  it('中文目录名 upsert → find → remove 全流程', async () => {
    const entry = makeEntry({ dir: '雾锁王国整合', name: '雾锁王国整合包' });
    await upsertPack(tempRoot, entry);
    expect(await findPack(tempRoot, '雾锁王国整合')).toEqual(entry);
    await removePack(tempRoot, '雾锁王国整合');
    expect(await findPack(tempRoot, '雾锁王国整合')).toBeNull();
  });

  it('含空格目录名 upsert → find → remove 全流程', async () => {
    const entry = makeEntry({ dir: 'My Pack 集合', name: '带空格的包' });
    await upsertPack(tempRoot, entry);
    expect(await findPack(tempRoot, 'My Pack 集合')).toEqual(entry);
    await removePack(tempRoot, 'My Pack 集合');
    expect(await findPack(tempRoot, 'My Pack 集合')).toBeNull();
  });

  it('中英混合与含点 / 连字符目录名可以并存（只有纯 . 与 .. 被禁止）', async () => {
    const entryA = makeEntry({ dir: 'v1.2-beta测试', name: '版本号目录' });
    const entryB = makeEntry({ dir: '第七大陆全扩', name: '中文目录' });
    await upsertPack(tempRoot, entryA);
    await upsertPack(tempRoot, entryB);
    expect(await findPack(tempRoot, 'v1.2-beta测试')).toEqual(entryA);
    expect(await findPack(tempRoot, '第七大陆全扩')).toEqual(entryB);
    const raw = await readFile(regPath(), 'utf8');
    expect(raw).toContain('dir: v1.2-beta测试');
    expect(raw).toContain('dir: 第七大陆全扩');
  });
});
