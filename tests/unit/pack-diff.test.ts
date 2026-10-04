// tests/unit/pack-diff.test.ts
/**
 * src/pack/diff.ts 单元测试：工作区 ↔ 游戏侧脚本 / UI 差异（只读操作）。
 *
 * 不依赖运行中的 TTS：src/cli/with-server.ts 被 vi.mock 替换为固定会话
 * （getScripts 由用例注入 scriptStates）；pack.yaml 校验与本地 scripts/ ui/
 * 扫描走真实文件 IO（os.tmpdir() 下的临时目录，mkdtemp + rm -rf）。
 *
 * 状态方向以「游戏侧相对本地工作区」为准（模块头注释）：
 * - added：游戏有本地无；
 * - deleted：本地有游戏无；
 * - modified：两边都有但归一化后内容不同；
 * - 一致：两边都有且内容相同 → 不产生条目。
 * 另覆盖换行 / 结尾空白归一化（CRLF vs LF 不误报 modified）与 UI 条目。
 *
 * 错误按机器可读契约断言（DiffResult 字段 / PackError.code），不依赖错误文案。
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

import { writePackYaml } from '../../src/pack/packyaml.js';
import { diffWorkspace } from '../../src/pack/diff.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-diff-'));
  mockGetScripts.mockReset();
  mockGetScripts.mockResolvedValue([]);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/**
 * 建一个带合法 pack.yaml 的工作区根目录（不建 scripts/ ui/，按用例自行落文件）。
 * @returns 工作区根目录
 */
async function makePackRoot(): Promise<string> {
  const root = path.join(tempRoot, 'pack');
  await writePackYaml(root, {
    schema_version: 1,
    name: '差异测试图包',
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

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('diffWorkspace（工作区 ↔ 游戏）', () => {
  it('added：游戏有 guid=abc 的脚本、本地无 → status="added"', async () => {
    const root = await makePackRoot();
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--s' }]);

    const result = await diffWorkspace({ root });

    expect(result.entries).toContainEqual({ guid: 'abc', name: '测试', kind: 'script', status: 'added' });
    expect(result).toMatchObject({ added: 1, modified: 0, deleted: 0 });
  }, 30_000);

  it('deleted：本地有 guid=xyz 的脚本、游戏无 → status="deleted" 并带 localPath', async () => {
    const root = await makePackRoot();
    const file = await writeScript(root, 'xyz.测试.lua', '--old');
    mockGetScripts.mockResolvedValue([]); // 游戏侧没有该 guid

    const result = await diffWorkspace({ root });

    expect(result.entries).toContainEqual({
      guid: 'xyz',
      name: '测试', // 游戏侧没有 → 用文件名重建的展示名
      kind: 'script',
      status: 'deleted',
      localPath: file,
    });
    expect(result).toMatchObject({ added: 0, modified: 0, deleted: 1 });
  }, 30_000);

  it('modified：两边都有但内容不同 → status="modified"', async () => {
    const root = await makePackRoot();
    const file = await writeScript(root, 'abc.测试.lua', '--local');
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--game' }]);

    const result = await diffWorkspace({ root });

    expect(result.entries).toContainEqual({
      guid: 'abc',
      name: '测试',
      kind: 'script',
      status: 'modified',
      localPath: file,
    });
    expect(result).toMatchObject({ added: 0, modified: 1, deleted: 0 });
  }, 30_000);

  it('一致：两边都有且内容相同 → 不产生任何条目、三个计数全 0', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'abc.测试.lua', '--same');
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--same' }]);

    const result = await diffWorkspace({ root });

    expect(result.entries).toEqual([]);
    expect(result).toMatchObject({ added: 0, modified: 0, deleted: 0 });
  }, 30_000);

  it('归一化：CRLF / 结尾空行差异不算 modified', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'abc.测试.lua', '--same\n\n');
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--same\r\n' }]);

    const result = await diffWorkspace({ root });

    expect(result.entries).toEqual([]);
    expect(result).toMatchObject({ added: 0, modified: 0, deleted: 0 });
  }, 30_000);

  it('UI 条目：Global.xml 内容不同 → modified，kind="ui"、guid="-1"', async () => {
    const root = await makePackRoot();
    const file = await writeUi(root, 'Global.xml', '<Panel />');
    mockGetScripts.mockResolvedValue([{ guid: '-1', name: 'Global', ui: '<Panel id="x" />' }]);

    const result = await diffWorkspace({ root });

    expect(result.entries).toContainEqual({
      guid: '-1',
      name: 'Global',
      kind: 'ui',
      status: 'modified',
      localPath: file,
    });
    expect(result).toMatchObject({ added: 0, modified: 1, deleted: 0 });
  }, 30_000);
});
