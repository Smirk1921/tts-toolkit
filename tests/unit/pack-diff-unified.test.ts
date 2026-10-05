// tests/unit/pack-diff-unified.test.ts
/**
 * src/pack/diff.ts 逐行 unified diff 扩展的单元测试（阶段 5 任务 5.3）。
 *
 * 三块覆盖：
 * - computeHunks：LCS / Hirschberg 算法本体（纯函数，直接构造文本，无 IO）——
 *   增 / 删 / 改、多 hunk 拆分、上下文 3 行扩与边界截断、间隔 ≤6 合并、
 *   空文件、尾随换行、空行、中文 / emoji、重复行的确定性；
 * - normalizeContent：导出后的归一化语义（CRLF / CR → LF、结尾空白 trimEnd、
 *   行内空白保留）——push / baseline 复用的契约；
 * - diffWorkspace 集成：includeHunks 缺省 / false 不产生 hunks 字段（向后兼容）、
 *   true 时仅 modified 条目带 hunks（added / deleted / 一致不受影响）、
 *   UI 条目同样计算、5000 行保护（>5000 跳过字段缺省、恰 5000 仍计算）。
 *
 * 不依赖运行中的 TTS：src/cli/with-server.ts 被 vi.mock 替换（同 tests/unit/pack-diff.test.ts）。
 * 错误 / 结构断言走机器可读契约（DiffHunk 字段、字段存在性），不依赖文案。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 会话层 getScripts 的替身（vi.hoisted 保证在 vi.mock 工厂中可用）。 */
const mockGetScripts = vi.hoisted(() => vi.fn());

/** 被 mock 的 withEditorServer 收到的会话上下文（本模块只用到 scripts）。 */
interface MockSession {
  scripts: { getScripts: typeof mockGetScripts };
}

// with-server 是唯一需要打桩的外部依赖：协议 / 会话层不在本测试范围内
vi.mock('../../src/cli/with-server.js', () => ({
  withEditorServer: async (fn: (session: MockSession) => Promise<unknown>) =>
    fn({ scripts: { getScripts: mockGetScripts } }),
}));

import { computeHunks, diffWorkspace, normalizeContent } from '../../src/pack/diff.js';
import type { DiffEntry } from '../../src/pack/diff.js';
import { writePackYaml } from '../../src/pack/packyaml.js';

// ---------------------------------------------------------------------------
// 临时目录管理（仅 diffWorkspace 集成用例需要）
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-diff-unified-'));
  mockGetScripts.mockReset();
  mockGetScripts.mockResolvedValue([]);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具辅助
// ---------------------------------------------------------------------------

/**
 * 建一个带合法 pack.yaml 的工作区根目录（不建 scripts/ ui/，按用例自行落文件）。
 * @returns 工作区根目录
 */
async function makePackRoot(): Promise<string> {
  const root = path.join(tempRoot, 'pack');
  await writePackYaml(root, {
    schema_version: 1,
    name: '逐行差异测试图包',
    workshop_id: null,
    source_mod: null,
    host: 'steamcloud',
    vcs: { lfs: 'disabled-no-lfs' },
    paths: { workdir: '.' },
    upload: { prefix: '' },
  });
  return root;
}

/** 往 <root>/scripts/ 落一个脚本文件（自动建目录） */
async function writeScript(root: string, fileName: string, content: string): Promise<string> {
  const dir = path.join(root, 'scripts');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  await writeFile(file, content, 'utf8');
  return file;
}

/** 往 <root>/ui/ 落一个 UI 文件（自动建目录） */
async function writeUi(root: string, fileName: string, content: string): Promise<string> {
  const dir = path.join(root, 'ui');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  await writeFile(file, content, 'utf8');
  return file;
}

/**
 * 生成 1 基编号的行数组：lineN(i) = `line-${i + 1}`。
 * @param n 行数
 * @returns ["line-1", ..., "line-n"]
 */
function numberedLines(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `line-${i + 1}`);
}

/** 从 diffWorkspace 结果里取唯一的 modified 条目（没有则让断言失败） */
function findModified(entries: DiffEntry[]): DiffEntry {
  const entry = entries.find((e) => e.status === 'modified');
  if (entry === undefined) {
    throw new Error(`预期存在 modified 条目，实际 entries=${JSON.stringify(entries)}`);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// computeHunks：算法本体
// ---------------------------------------------------------------------------

describe('computeHunks（LCS 逐行差异）', () => {
  it('完全相同的多行文本 → hunks=[]', () => {
    expect(computeHunks('a\nb\nc', 'a\nb\nc')).toEqual([]);
  });

  it('空文本 vs 空文本 → hunks=[]', () => {
    expect(computeHunks('', '')).toEqual([]);
  });

  it('新增 1 行在开头：local 侧只剩上下文行，remote 多出新行', () => {
    expect(computeHunks('a', 'x\na')).toEqual([
      { localStart: 1, localLines: ['a'], remoteStart: 1, remoteLines: ['x', 'a'] },
    ]);
  });

  it('新增 1 行在中间：两侧各带满上下文', () => {
    expect(computeHunks('a\nb', 'a\nx\nb')).toEqual([
      { localStart: 1, localLines: ['a', 'b'], remoteStart: 1, remoteLines: ['a', 'x', 'b'] },
    ]);
  });

  it('新增 1 行在结尾', () => {
    expect(computeHunks('a', 'a\nx')).toEqual([
      { localStart: 1, localLines: ['a'], remoteStart: 1, remoteLines: ['a', 'x'] },
    ]);
  });

  it('删除 1 行在开头', () => {
    expect(computeHunks('x\na', 'a')).toEqual([
      { localStart: 1, localLines: ['x', 'a'], remoteStart: 1, remoteLines: ['a'] },
    ]);
  });

  it('删除 1 行在中间', () => {
    expect(computeHunks('a\nx\nb', 'a\nb')).toEqual([
      { localStart: 1, localLines: ['a', 'x', 'b'], remoteStart: 1, remoteLines: ['a', 'b'] },
    ]);
  });

  it('删除 1 行在结尾', () => {
    expect(computeHunks('a\nx', 'a')).toEqual([
      { localStart: 1, localLines: ['a', 'x'], remoteStart: 1, remoteLines: ['a'] },
    ]);
  });

  it('修改 1 行 = 同位置的删 + 增，两侧行按位置一一对应', () => {
    expect(computeHunks('a\nb\nc', 'a\nX\nc')).toEqual([
      { localStart: 1, localLines: ['a', 'b', 'c'], remoteStart: 1, remoteLines: ['a', 'X', 'c'] },
    ]);
  });

  it('整块替换多行：del 行在前、add 行在后，同位置对应', () => {
    const hunks = computeHunks('a\nb\nc\nd', 'a\nX\nY\nd');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toEqual({
      localStart: 1,
      localLines: ['a', 'b', 'c', 'd'],
      remoteStart: 1,
      remoteLines: ['a', 'X', 'Y', 'd'],
    });
    expect(hunks[0].localLines.slice(1, 3)).toEqual(['b', 'c']);
    expect(hunks[0].remoteLines.slice(1, 3)).toEqual(['X', 'Y']);
  });

  it('两处相距很远的修改 → 拆成 2 个 hunk，起始行号各自正确', () => {
    const local = numberedLines(20);
    const remote = [...local];
    remote[1] = 'line-2-改';
    remote[18] = 'line-19-改';
    const hunks = computeHunks(local.join('\n'), remote.join('\n'));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toEqual({
      localStart: 1,
      localLines: ['line-1', 'line-2', 'line-3', 'line-4', 'line-5'],
      remoteStart: 1,
      remoteLines: ['line-1', 'line-2-改', 'line-3', 'line-4', 'line-5'],
    });
    expect(hunks[1]).toEqual({
      localStart: 16,
      localLines: ['line-16', 'line-17', 'line-18', 'line-19', 'line-20'],
      remoteStart: 16,
      remoteLines: ['line-16', 'line-17', 'line-18', 'line-19-改', 'line-20'],
    });
  });

  it('上下文恰好 3 行：30 行文件改第 10 行 → hunk 覆盖 7..13', () => {
    const local = numberedLines(30);
    const remote = [...local];
    remote[9] = 'line-10-改';
    const hunks = computeHunks(local.join('\n'), remote.join('\n'));
    expect(hunks).toEqual([
      {
        localStart: 7,
        localLines: ['line-7', 'line-8', 'line-9', 'line-10', 'line-11', 'line-12', 'line-13'],
        remoteStart: 7,
        remoteLines: [
          'line-7',
          'line-8',
          'line-9',
          'line-10-改',
          'line-11',
          'line-12',
          'line-13',
        ],
      },
    ]);
  });

  it('上下文在文件开头截断：改第 1 行 → hunk 从第 1 行开始只带后文', () => {
    const local = numberedLines(10);
    const remote = [...local];
    remote[0] = 'line-1-改';
    const hunks = computeHunks(local.join('\n'), remote.join('\n'));
    expect(hunks).toEqual([
      {
        localStart: 1,
        localLines: ['line-1', 'line-2', 'line-3', 'line-4'],
        remoteStart: 1,
        remoteLines: ['line-1-改', 'line-2', 'line-3', 'line-4'],
      },
    ]);
  });

  it('上下文在文件结尾截断：改最后一行 → hunk 只带前文 3 行', () => {
    const local = numberedLines(10);
    const remote = [...local];
    remote[9] = 'line-10-改';
    const hunks = computeHunks(local.join('\n'), remote.join('\n'));
    expect(hunks).toEqual([
      {
        localStart: 7,
        localLines: ['line-7', 'line-8', 'line-9', 'line-10'],
        remoteStart: 7,
        remoteLines: ['line-7', 'line-8', 'line-9', 'line-10-改'],
      },
    ]);
  });

  it('间隔恰好 6 行的两处改动 → 合并为 1 个 hunk', () => {
    const local = numberedLines(20);
    const remote = [...local];
    remote[4] = 'line-5-改'; // 第 5 行
    remote[11] = 'line-12-改'; // 第 12 行，与上一处之间夹 6 行未改（6..11）
    const hunks = computeHunks(local.join('\n'), remote.join('\n'));
    expect(hunks).toHaveLength(1);
    expect(hunks[0].localStart).toBe(2);
    expect(hunks[0].remoteStart).toBe(2);
    expect(hunks[0].localLines).toHaveLength(14); // line-2..line-15
    expect(hunks[0].localLines).toContain('line-5');
    expect(hunks[0].localLines).toContain('line-12');
    expect(hunks[0].remoteLines).toContain('line-5-改');
    expect(hunks[0].remoteLines).toContain('line-12-改');
  });

  it('间隔 7 行的两处改动 → 不合并，2 个 hunk', () => {
    const local = numberedLines(20);
    const remote = [...local];
    remote[4] = 'line-5-改'; // 第 5 行
    remote[12] = 'line-13-改'; // 第 13 行，之间夹 7 行未改（6..12）
    const hunks = computeHunks(local.join('\n'), remote.join('\n'));
    expect(hunks).toHaveLength(2);
    expect(hunks[0].localStart).toBe(2); // 改动在第 5 行 − 3 行前文
    expect(hunks[1].localStart).toBe(10); // 改动在第 13 行 − 3 行前文
    expect(hunks[1].remoteStart).toBe(10);
    expect(hunks[1].localLines).toContain('line-13');
    expect(hunks[1].remoteLines).toContain('line-13-改');
  });

  it('纯新增块在文件顶部且本地非空：localLines 只剩后文上下文，起点仍为 1', () => {
    expect(computeHunks('a\nb', 'x\ny\na\nb')).toEqual([
      { localStart: 1, localLines: ['a', 'b'], remoteStart: 1, remoteLines: ['x', 'y', 'a', 'b'] },
    ]);
  });

  it('空文件 vs 非空：localLines 为空数组、localStart 落在插入点（1）', () => {
    expect(computeHunks('', 'x\ny')).toEqual([
      { localStart: 1, localLines: [], remoteStart: 1, remoteLines: ['x', 'y'] },
    ]);
  });

  it('非空 vs 空文件：remoteLines 为空数组、remoteStart 落在插入点（1）', () => {
    expect(computeHunks('x\ny', '')).toEqual([
      { localStart: 1, localLines: ['x', 'y'], remoteStart: 1, remoteLines: [] },
    ]);
  });

  it('仅尾随换行差异 → hunks=[]（末尾 \\n 是终止符不是新行）', () => {
    expect(computeHunks('a\n', 'a')).toEqual([]);
    expect(computeHunks('a', 'a\n')).toEqual([]);
  });

  it('空行是内容行：删除空行会产生含 "" 的 hunk', () => {
    expect(computeHunks('a\n\nb', 'a\nb')).toEqual([
      { localStart: 1, localLines: ['a', '', 'b'], remoteStart: 1, remoteLines: ['a', 'b'] },
    ]);
  });

  it('中文与 emoji 行内容逐字保留', () => {
    expect(computeHunks('你好\n🎮 牌堆', '你好\n新行 🀄\n🎮 牌堆')).toEqual([
      {
        localStart: 1,
        localLines: ['你好', '🎮 牌堆'],
        remoteStart: 1,
        remoteLines: ['你好', '新行 🀄', '🎮 牌堆'],
      },
    ]);
  });

  it('重复行（LCS 有多种对齐）→ 结果确定：两次调用完全一致', () => {
    const first = computeHunks('x\nx\nx\nx', 'x\nx');
    const second = computeHunks('x\nx\nx\nx', 'x\nx');
    expect(first).toEqual(second);
    expect(first).toEqual([
      { localStart: 1, localLines: ['x', 'x', 'x', 'x'], remoteStart: 1, remoteLines: ['x', 'x'] },
    ]);
  });

  it('中部插入且前文恰有 3 行：上下文向前收满 3 行、hunk 从第 1 行开始', () => {
    expect(computeHunks('l1\nl2\nl3\nl4', 'l1\nl2\nl3\nX\nl4')).toEqual([
      {
        localStart: 1,
        localLines: ['l1', 'l2', 'l3', 'l4'],
        remoteStart: 1,
        remoteLines: ['l1', 'l2', 'l3', 'X', 'l4'],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// normalizeContent：导出契约
// ---------------------------------------------------------------------------

describe('normalizeContent（导出供 push / baseline 复用）', () => {
  it('CRLF 与单独 CR 都折成 LF，结尾换行 / 空白被 trimEnd', () => {
    expect(normalizeContent('a\r\nb\rc\n')).toBe('a\nb\nc');
    expect(normalizeContent('a\r\nb\r\nc\n\nd\n\n\n')).toBe('a\nb\nc\n\nd');
  });

  it('行内空白与缩进保持原样；空串与纯换行归一为空串', () => {
    expect(normalizeContent('x = 1   \n  y = 2\t\n')).toBe('x = 1   \n  y = 2');
    expect(normalizeContent('')).toBe('');
    expect(normalizeContent('\r\n')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// diffWorkspace 集成：includeHunks 选项
// ---------------------------------------------------------------------------

describe('diffWorkspace includeHunks（工作区 ↔ 游戏，逐行 hunks）', () => {
  it('缺省 includeHunks → modified 条目没有 hunks 字段（向后兼容）', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'abc.测试.lua', '-- 本地\nlocal x = 1\nprint(x)\n');
    mockGetScripts.mockResolvedValue([
      { guid: 'abc', name: '测试', script: '-- 游戏\nlocal x = 1\nprint(x)' },
    ]);

    const result = await diffWorkspace({ root });
    const entry = findModified(result.entries);

    expect('hunks' in entry).toBe(false);
    expect(result).toMatchObject({ modified: 1 });
  }, 30_000);

  it('includeHunks: false → 同样没有 hunks 字段', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'abc.测试.lua', '-- 本地\nprint(1)');
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '-- 游戏\nprint(1)' }]);

    const result = await diffWorkspace({ root, includeHunks: false });
    const entry = findModified(result.entries);

    expect('hunks' in entry).toBe(false);
  }, 30_000);

  it('includeHunks: true → modified 条目带 hunks；localLines 来自本地文件、remoteLines 来自游戏侧', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'abc.测试.lua', '-- 本地\nlocal x = 1\nprint(x)\n');
    mockGetScripts.mockResolvedValue([
      { guid: 'abc', name: '测试', script: '-- 游戏\nlocal x = 1\nprint(x)' },
    ]);

    const result = await diffWorkspace({ root, includeHunks: true });
    const entry = findModified(result.entries);

    expect(entry.hunks).toEqual([
      {
        localStart: 1,
        localLines: ['-- 本地', 'local x = 1', 'print(x)'],
        remoteStart: 1,
        remoteLines: ['-- 游戏', 'local x = 1', 'print(x)'],
      },
    ]);
  }, 30_000);

  it('includeHunks: true → added 条目不产生 hunks 字段', async () => {
    const root = await makePackRoot();
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--s' }]);

    const result = await diffWorkspace({ root, includeHunks: true });
    const entry = result.entries.find((e) => e.status === 'added');

    expect(entry).toBeDefined();
    expect('hunks' in (entry as DiffEntry)).toBe(false);
  }, 30_000);

  it('includeHunks: true → deleted 条目不产生 hunks 字段', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'xyz.测试.lua', '--old');
    mockGetScripts.mockResolvedValue([]);

    const result = await diffWorkspace({ root, includeHunks: true });
    const entry = result.entries.find((e) => e.status === 'deleted');

    expect(entry).toBeDefined();
    expect('hunks' in (entry as DiffEntry)).toBe(false);
  }, 30_000);

  it('includeHunks: true → 两边一致仍不产生条目（不因 hunks 选项报错）', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'abc.测试.lua', '--same');
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--same' }]);

    const result = await diffWorkspace({ root, includeHunks: true });

    expect(result.entries).toEqual([]);
    expect(result).toMatchObject({ added: 0, modified: 0, deleted: 0 });
  }, 30_000);

  it('includeHunks: true → UI 条目同样计算 hunks（guid="-1"）', async () => {
    const root = await makePackRoot();
    await writeUi(root, 'Global.xml', '<Panel>\n  <Text>旧</Text>\n</Panel>');
    mockGetScripts.mockResolvedValue([
      { guid: '-1', name: 'Global', ui: '<Panel>\n  <Text>新</Text>\n</Panel>' },
    ]);

    const result = await diffWorkspace({ root, includeHunks: true });
    const entry = findModified(result.entries);

    expect(entry).toMatchObject({ guid: '-1', kind: 'ui', status: 'modified' });
    expect(entry.hunks).toEqual([
      {
        localStart: 1,
        localLines: ['<Panel>', '  <Text>旧</Text>', '</Panel>'],
        remoteStart: 1,
        remoteLines: ['<Panel>', '  <Text>新</Text>', '</Panel>'],
      },
    ]);
  }, 30_000);

  it('游戏侧超过 5000 行 → 跳过 hunks（字段缺省），条目仍为 modified', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'abc.测试.lua', '-- 本地\nprint(1)');
    const bigScript = Array.from({ length: 5001 }, (_, i) => `-- 第${i + 1}行`).join('\n');
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: bigScript }]);

    const result = await diffWorkspace({ root, includeHunks: true });
    const entry = findModified(result.entries);

    expect('hunks' in entry).toBe(false);
  }, 30_000);

  it('游戏侧恰好 5000 行（保护边界，含）→ 仍计算 hunks', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'abc.测试.lua', '-- 本地\nprint(1)');
    const script5000 = Array.from({ length: 5000 }, (_, i) =>
      i === 0 ? '-- 远端' : `游戏行${i + 1}`,
    ).join('\n');
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: script5000 }]);

    const result = await diffWorkspace({ root, includeHunks: true });
    const entry = findModified(result.entries);

    expect(entry.hunks).toHaveLength(1);
    expect(entry.hunks?.[0].localLines).toEqual(['-- 本地', 'print(1)']);
    expect(entry.hunks?.[0].remoteLines).toHaveLength(5000);
    expect(entry.hunks?.[0]).toMatchObject({ localStart: 1, remoteStart: 1 });
  }, 30_000);
});
