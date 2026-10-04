// tests/unit/pack-pull.test.ts
/**
 * src/pack/pull.ts 单元测试：从运行中的 TTS 拉脚本 / UI 到工作区（在线回路，只读）。
 *
 * 不依赖运行中的 TTS：src/cli/with-server.ts 被 vi.mock 替换为固定会话
 * （getScripts 由用例注入 scriptStates）；pack.yaml 校验、目录布局与落盘 /
 * 跳过 / 删除全部走真实文件 IO（os.tmpdir() 下的临时目录，mkdtemp + rm -rf）。
 *
 * 覆盖：
 * - 正常路径：游戏侧 guid/name → scripts/<guid>.<净化名>.lua 落盘（中文名保留），
 *   全局脚本（guid "-1"）→ Global.lua / Global.xml；
 * - 删除路径：TTS 协议"缺字段即删除"——state 存在但缺 script / ui 时，本地属于
 *   该 guid 的文件（含游戏内改名后遗留的旧文件名）被删除；前缀相近的其他 guid
 *   不被误伤；
 * - 边界：guid 完全不在 scriptStates 里时不动本地文件（模块头注释的决策：
 *   否则对空存档拉取会清空工作区）；
 * - skippedNoChange：内容与本地一致时不覆写（mtime 未变）并计入跳过数。
 *
 * 计数与错误均按机器可读契约断言（PullResult 字段 / PackError.code），
 * 不依赖错误文案——文案走 t()，locales/*.json 由本地化步骤补齐。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
import { pullFromGame } from '../../src/pack/pull.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-pull-'));
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
 * 建一个带合法 pack.yaml 的工作区根目录。
 * pullFromGame 的前置校验要求 pack.yaml 存在（缺失 → PACK_NOT_FOUND）。
 * @returns 工作区根目录（未创建 scripts/ ui/，由 pullFromGame 的 ensureLayout 补齐）
 */
async function makePackRoot(): Promise<string> {
  const root = path.join(tempRoot, 'pack');
  await writePackYaml(root, {
    schema_version: 1,
    name: '拉取测试图包',
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

describe('pullFromGame（在线拉取）', () => {
  it('正常路径：游戏侧脚本落盘为 scripts/<guid>.<净化名>.lua（中文名保留）', async () => {
    const root = await makePackRoot();
    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--s' }]);

    const result = await pullFromGame({ root });

    expect(await readFile(path.join(root, 'scripts', 'abc.测试.lua'), 'utf8')).toBe('--s');
    // 游戏侧未提供 ui 字段 → 不产出 UI 文件（也无可删除的旧文件）
    expect(existsSync(path.join(root, 'ui', 'abc.测试.xml'))).toBe(false);
    expect(result).toEqual({ scriptsWritten: 1, uiWritten: 0, skippedNoChange: 0 });
    expect(mockGetScripts).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('全局脚本（guid "-1"）：落盘为 Global.lua / Global.xml，忽略 name', async () => {
    const root = await makePackRoot();
    mockGetScripts.mockResolvedValue([
      { guid: '-1', name: 'Global', script: '--global', ui: '<Panel id="global" />' },
    ]);

    const result = await pullFromGame({ root });

    expect(await readFile(path.join(root, 'scripts', 'Global.lua'), 'utf8')).toBe('--global');
    expect(await readFile(path.join(root, 'ui', 'Global.xml'), 'utf8')).toBe('<Panel id="global" />');
    expect(result).toEqual({ scriptsWritten: 1, uiWritten: 1, skippedNoChange: 0 });
  }, 30_000);

  it('删除路径：state 缺 script / ui 字段 → 本地该 guid 的文件（含改名遗留）被删除', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'xyz.旧名.lua', '--old');
    await writeScript(root, 'xyz2.lua', '--other'); // 前缀相近但不是同一 guid：不应被误删
    await writeUi(root, 'xyz.旧名.xml', '<Panel />');

    // state 存在但缺 script / ui = TTS 删除该对象的脚本 / UI（协议语义）
    mockGetScripts.mockResolvedValue([{ guid: 'xyz', name: '对象' }]);

    const result = await pullFromGame({ root });

    expect(existsSync(path.join(root, 'scripts', 'xyz.旧名.lua'))).toBe(false);
    expect(existsSync(path.join(root, 'ui', 'xyz.旧名.xml'))).toBe(false);
    expect(existsSync(path.join(root, 'scripts', 'xyz2.lua'))).toBe(true);
    expect(result).toEqual({ scriptsWritten: 0, uiWritten: 0, skippedNoChange: 0 });
  }, 30_000);

  it('边界：guid 完全不在 scriptStates 里 → 本地文件保持不动（不因空存档清空工作区）', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'xyz.测试.lua', '--keep');

    mockGetScripts.mockResolvedValue([]); // 空存档：没有任何 state

    const result = await pullFromGame({ root });

    expect(await readFile(path.join(root, 'scripts', 'xyz.测试.lua'), 'utf8')).toBe('--keep');
    expect(result).toEqual({ scriptsWritten: 0, uiWritten: 0, skippedNoChange: 0 });
  }, 30_000);

  it('skippedNoChange：内容与本地一致时不覆写（mtime 未变）', async () => {
    const root = await makePackRoot();
    const file = await writeScript(root, 'abc.测试.lua', '--same');
    // 把 mtime 拨到 60 秒前：若 pull 重写文件，mtime 会变成当前时间
    const past = new Date(Date.now() - 60_000);
    await utimes(file, past, past);
    const before = await stat(file);

    mockGetScripts.mockResolvedValue([{ guid: 'abc', name: '测试', script: '--same' }]);

    const result = await pullFromGame({ root });

    const after = await stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mtimeMs).toBeLessThan(Date.now() - 30_000); // 确认 utimes 生效，mtime 断言有意义
    expect(await readFile(file, 'utf8')).toBe('--same');
    expect(result).toEqual({ scriptsWritten: 0, uiWritten: 0, skippedNoChange: 1 });
  }, 30_000);
});
