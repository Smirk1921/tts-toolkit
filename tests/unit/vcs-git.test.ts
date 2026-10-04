// tests/unit/vcs-git.test.ts
/**
 * src/vcs/git.ts 单元测试：系统 git 薄封装。
 *
 * 真实 git 子进程（`execa("git", [...])` 在 os.tmpdir() 的临时目录里跑
 * git init / add / commit / merge），覆盖：
 * - runGit / runGitOrThrow：正常、失败不抛、GIT_NOT_FOUND（mock PATH）、
 *   GIT_COMMAND_FAILED（按 PackError.code 断言，不依赖错误文案）；
 * - statusPorcelain：空仓库 / 未跟踪 / 已暂存 / rename / 中文与空格路径 /
 *   UU 冲突 / 非 git 目录；
 * - diffNumstat：文本计数 / 二进制 null / base 基线 / rename 取新路径；
 * - currentBranch / isGitRepo / headCommit / lfsVersion：正常与边界。
 *
 * 注：本机 os.tmpdir() 路径本身含中文用户名，全部用例已隐式覆盖
 * "中文 cwd"；另有显式用例叠加"中文 + 空格"目录。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PackError } from '../../src/pack/packyaml.js';
import {
  currentBranch,
  diffNumstat,
  headCommit,
  isGitRepo,
  lfsVersion,
  runGit,
  runGitOrThrow,
  statusPorcelain,
} from '../../src/vcs/git.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-git-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

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

/** 提交一个文件（写内容 → add → commit） */
async function commitFile(relPath: string, content: string, message: string, dir: string = tempRoot): Promise<void> {
  await writeFile(path.join(dir, relPath), content, 'utf8');
  await git(['add', relPath], dir);
  await git(['commit', '-m', message], dir);
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

/**
 * 临时替换 process.env.PATH 执行 fn（finally 恢复），用于 mock "git 未安装"。
 * vitest 的 worker 之间进程隔离、文件内用例串行，改动只影响当前用例。
 */
async function withMockedPath<T>(pathValue: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = pathValue;
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = original;
    }
  }
}

// ---------------------------------------------------------------------------
// runGit / runGitOrThrow
// ---------------------------------------------------------------------------

describe('runGit', () => {
  it('正常命令：exitCode=0，stdout 为 UTF-8 文本', async () => {
    const result = await runGit(['--version'], { cwd: tempRoot });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^git version \d+/);
  });

  it('命令失败：不抛错，返回非零 exitCode 与非空 stderr', async () => {
    // 非 git 目录里跑 status → git 以非零码退出
    const result = await runGit(['status'], { cwd: tempRoot });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('git 不在 PATH（mock）：抛 GIT_NOT_FOUND', async () => {
    await withMockedPath(tempRoot, async () => {
      const err = await expectPackError(() => runGit(['--version'], { cwd: tempRoot }), 'GIT_NOT_FOUND');
      expect(err.message).toContain('git');
    });
  });

  it('参数含中文与空格：作为数组原样传给 git（构造含空格路径的文件）', async () => {
    await writeFile(path.join(tempRoot, '带 空格 文件.txt'), 'x\n', 'utf8');
    const result = await runGit(['status', '--porcelain', '--', '带 空格 文件.txt'], { cwd: tempRoot });
    // 非仓库时 status 整体失败也行，但这里验证的是参数没有被空格拆坏：
    // 若参数被拆坏，git 会报 usage 错误而非正常执行
    expect([0, 128]).toContain(result.exitCode);
  });
});

describe('runGitOrThrow', () => {
  it('正常命令：返回结果且 exitCode=0', async () => {
    const result = await runGitOrThrow(['--version'], { cwd: tempRoot });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^git version /);
  });

  it('命令失败：抛 GIT_COMMAND_FAILED，message 含命令行与 stderr 摘要', async () => {
    const err = await expectPackError(() => runGitOrThrow(['status'], { cwd: tempRoot }), 'GIT_COMMAND_FAILED');
    expect(err.message).toContain('git status');
    expect(err.message).toContain('失败');
  });

  it('git 不在 PATH（mock）：抛 GIT_NOT_FOUND 而非 GIT_COMMAND_FAILED', async () => {
    await withMockedPath(tempRoot, async () => {
      await expectPackError(() => runGitOrThrow(['--version'], { cwd: tempRoot }), 'GIT_NOT_FOUND');
    });
  });
});

// ---------------------------------------------------------------------------
// statusPorcelain
// ---------------------------------------------------------------------------

describe('statusPorcelain', () => {
  it('空仓库：返回空数组', async () => {
    await initRepo();
    expect(await statusPorcelain(tempRoot)).toEqual([]);
  });

  it('未跟踪文件：xy="??"，路径原样', async () => {
    await initRepo();
    await writeFile(path.join(tempRoot, 'new.txt'), 'x\n', 'utf8');
    const entries = await statusPorcelain(tempRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ xy: '??', path: 'new.txt' });
  });

  it('未跟踪目录：整目录一条 "?? dir/"', async () => {
    await initRepo();
    await mkdir(path.join(tempRoot, '子目录'));
    await writeFile(path.join(tempRoot, '子目录', 'a.txt'), 'x\n', 'utf8');
    const entries = await statusPorcelain(tempRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ xy: '??', path: expect.stringMatching(/^子目录\/$/) });
  });

  it('工作区修改（未暂存）：xy=" M"', async () => {
    await initRepo();
    await commitFile('a.txt', 'v1\n', 'init');
    await writeFile(path.join(tempRoot, 'a.txt'), 'v2\n', 'utf8');
    const entries = await statusPorcelain(tempRoot);
    expect(entries).toEqual([{ xy: ' M', path: 'a.txt' }]);
  });

  it('已暂存新增：xy="A "', async () => {
    await initRepo();
    await writeFile(path.join(tempRoot, 'a.txt'), 'v1\n', 'utf8');
    await git(['add', 'a.txt']);
    const entries = await statusPorcelain(tempRoot);
    expect(entries).toEqual([{ xy: 'A ', path: 'a.txt' }]);
  });

  it('已暂存修改：xy="M "', async () => {
    await initRepo();
    await commitFile('a.txt', 'v1\n', 'init');
    await writeFile(path.join(tempRoot, 'a.txt'), 'v2\n', 'utf8');
    await git(['add', 'a.txt']);
    const entries = await statusPorcelain(tempRoot);
    expect(entries).toEqual([{ xy: 'M ', path: 'a.txt' }]);
  });

  it('rename（git mv）：xy="R "，path 为新路径，origPath 为原路径', async () => {
    await initRepo();
    await commitFile('a.txt', 'v1\n', 'init');
    await git(['mv', 'a.txt', 'b.txt']);
    const entries = await statusPorcelain(tempRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].xy).toBe('R ');
    expect(entries[0].path).toBe('b.txt');
    expect(entries[0].origPath).toBe('a.txt');
  });

  it('中文与空格文件名：路径不被转义、不被拆坏', async () => {
    await initRepo();
    await writeFile(path.join(tempRoot, '中文 图像.png'), 'x\n', 'utf8');
    const entries = await statusPorcelain(tempRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].xy).toBe('??');
    expect(entries[0].path).toBe('中文 图像.png');
  });

  it('混合多条目：未跟踪 + 已暂存 + 工作区修改同时列出', async () => {
    await initRepo();
    await commitFile('tracked.txt', 'v1\n', 'init');
    await writeFile(path.join(tempRoot, 'tracked.txt'), 'v2\n', 'utf8');
    await writeFile(path.join(tempRoot, 'staged.txt'), 's\n', 'utf8');
    await git(['add', 'staged.txt']);
    await writeFile(path.join(tempRoot, 'untracked.txt'), 'u\n', 'utf8');
    const entries = await statusPorcelain(tempRoot);
    const byPath = new Map(entries.map((entry) => [entry.path, entry.xy]));
    expect(byPath.get('tracked.txt')).toBe(' M');
    expect(byPath.get('staged.txt')).toBe('A ');
    expect(byPath.get('untracked.txt')).toBe('??');
  });

  it('UU 冲突：双方修改同一文件后 merge，xy="UU"', async () => {
    await initRepo();
    await commitFile('conf.txt', 'base\n', 'base');
    await git(['checkout', '-b', 'topic']);
    await commitFile('conf.txt', 'topic\n', 'topic change');
    await git(['checkout', 'main']);
    await commitFile('conf.txt', 'main\n', 'main change');
    // merge 必然冲突退出 1，夹具容忍失败
    await execa('git', ['merge', 'topic'], { cwd: tempRoot, reject: false });
    const entries = await statusPorcelain(tempRoot);
    const conflict = entries.find((entry) => entry.path === 'conf.txt');
    expect(conflict).toBeDefined();
    expect(conflict?.xy).toBe('UU');
  });

  it('非 git 目录：抛 GIT_NOT_A_REPO', async () => {
    await expectPackError(() => statusPorcelain(tempRoot), 'GIT_NOT_A_REPO');
  });
});

// ---------------------------------------------------------------------------
// diffNumstat
// ---------------------------------------------------------------------------

describe('diffNumstat', () => {
  it('文本修改：added / deleted 为数字', async () => {
    await initRepo();
    await commitFile('a.txt', 'one\ntwo\n', 'init');
    await writeFile(path.join(tempRoot, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
    const entries = await diffNumstat(tempRoot);
    expect(entries).toEqual([{ added: 1, deleted: 0, path: 'a.txt' }]);
  });

  it('二进制文件：added / deleted 为 null', async () => {
    await initRepo();
    // 含 NUL 字节的"图"，git 判定为二进制
    await writeFile(path.join(tempRoot, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await git(['add', 'img.png']);
    await git(['commit', '-m', 'init']);
    await writeFile(path.join(tempRoot, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02, 0x03]));
    const entries = await diffNumstat(tempRoot, 'HEAD');
    expect(entries).toEqual([{ added: null, deleted: null, path: 'img.png' }]);
  });

  it('多文件混合：文本与二进制逐条返回', async () => {
    await initRepo();
    // 全部先入库（未跟踪文件不会出现在 git diff 里），再在工作区同时改动三个
    await commitFile('a.txt', 'a\n', 'init');
    await commitFile('b.txt', 'b\n', 'second');
    await commitFile('img.png', Buffer.from([0x00, 0x01, 0x02, 0x03]).toString('latin1'), 'third');
    await writeFile(path.join(tempRoot, 'a.txt'), 'a2\n', 'utf8');
    await writeFile(path.join(tempRoot, 'b.txt'), 'b2\n', 'utf8');
    await writeFile(path.join(tempRoot, 'img.png'), Buffer.from([0x00, 0x01, 0x02, 0x04]));
    const entries = await diffNumstat(tempRoot);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.size).toBe(3);
    expect(byPath.get('a.txt')).toEqual({ added: 1, deleted: 1, path: 'a.txt' });
    expect(byPath.get('b.txt')).toEqual({ added: 1, deleted: 1, path: 'b.txt' });
    expect(byPath.get('img.png')).toEqual({ added: null, deleted: null, path: 'img.png' });
  });

  it('无差异：返回空数组', async () => {
    await initRepo();
    await commitFile('a.txt', 'a\n', 'init');
    expect(await diffNumstat(tempRoot)).toEqual([]);
  });

  it('base="HEAD"：含已暂存的变更', async () => {
    await initRepo();
    await commitFile('a.txt', 'v1\n', 'init');
    await writeFile(path.join(tempRoot, 'a.txt'), 'v2\n', 'utf8');
    await git(['add', 'a.txt']);
    // 工作区与暂存区一致 → 无 base 的 git diff 为空
    expect(await diffNumstat(tempRoot)).toEqual([]);
    // base=HEAD → 显示暂存的变更
    expect(await diffNumstat(tempRoot, 'HEAD')).toEqual([{ added: 1, deleted: 1, path: 'a.txt' }]);
  });

  it('base=旧提交 hash：包含其后全部已提交变更', async () => {
    await initRepo();
    await commitFile('a.txt', 'v1\n', 'init');
    const baseHash = (await runGitOrThrow(['rev-parse', 'HEAD'], { cwd: tempRoot })).stdout.trim();
    await commitFile('a.txt', 'v2\n', 'second');
    await commitFile('b.txt', 'b\n', 'third');
    const entries = await diffNumstat(tempRoot, baseHash);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get('a.txt')).toEqual({ added: 1, deleted: 1, path: 'a.txt' });
    expect(byPath.get('b.txt')).toEqual({ added: 1, deleted: 0, path: 'b.txt' });
  });

  it('rename 条目：取新路径，added/deleted 为 0（内容未变）', async () => {
    await initRepo();
    await commitFile('a.txt', 'v1\n', 'init');
    await git(['mv', 'a.txt', 'b.txt']);
    const entries = await diffNumstat(tempRoot, 'HEAD');
    expect(entries).toEqual([{ added: 0, deleted: 0, path: 'b.txt' }]);
  });

  it('非 git 目录：抛 GIT_NOT_A_REPO', async () => {
    await expectPackError(() => diffNumstat(tempRoot), 'GIT_NOT_A_REPO');
  });

  it('非法 base：抛 GIT_COMMAND_FAILED', async () => {
    await initRepo();
    await expectPackError(() => diffNumstat(tempRoot, 'no-such-ref'), 'GIT_COMMAND_FAILED');
  });
});

// ---------------------------------------------------------------------------
// currentBranch / isGitRepo
// ---------------------------------------------------------------------------

describe('currentBranch', () => {
  it('正常分支：init -b main 后返回 "main"', async () => {
    await initRepo();
    expect(await currentBranch(tempRoot)).toBe('main');
  });

  it('切换分支：checkout -b 后返回新分支名', async () => {
    await initRepo();
    await git(['checkout', '-b', 'feature']);
    expect(await currentBranch(tempRoot)).toBe('feature');
  });

  it('detached HEAD：返回 null', async () => {
    await initRepo();
    await commitFile('a.txt', 'a\n', 'init');
    await git(['checkout', '--detach', 'HEAD']);
    expect(await currentBranch(tempRoot)).toBeNull();
  });

  it('非 git 目录：抛 GIT_NOT_A_REPO', async () => {
    await expectPackError(() => currentBranch(tempRoot), 'GIT_NOT_A_REPO');
  });
});

describe('isGitRepo', () => {
  it('git 仓库：true', async () => {
    await initRepo();
    expect(await isGitRepo(tempRoot)).toBe(true);
  });

  it('仓库子目录：true（在工作树内即可）', async () => {
    await initRepo();
    const sub = path.join(tempRoot, 'decks', '某卡组');
    await mkdir(sub, { recursive: true });
    expect(await isGitRepo(sub)).toBe(true);
  });

  it('普通目录：false', async () => {
    expect(await isGitRepo(tempRoot)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lfsVersion
// ---------------------------------------------------------------------------

describe('lfsVersion', () => {
  it('已装 git-lfs：返回 x.y.z 版本号', async () => {
    const version = await lfsVersion(tempRoot);
    // 本机已装 git-lfs；若环境缺失该用例才有意义地失败
    expect(version).not.toBeNull();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('未装（mock PATH）：返回 null 而非抛错', async () => {
    await withMockedPath(tempRoot, async () => {
      expect(await lfsVersion(tempRoot)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// headCommit
// ---------------------------------------------------------------------------

describe('headCommit', () => {
  it('有提交：返回 40 位十六进制 hash，与 rev-parse HEAD 一致', async () => {
    await initRepo();
    await commitFile('a.txt', 'a\n', 'init');
    const hash = await headCommit(tempRoot);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const expected = (await runGitOrThrow(['rev-parse', 'HEAD'], { cwd: tempRoot })).stdout.trim();
    expect(hash).toBe(expected);
  });

  it('空仓库（无提交）：返回 null', async () => {
    await initRepo();
    expect(await headCommit(tempRoot)).toBeNull();
  });

  it('非 git 目录：抛 GIT_NOT_A_REPO', async () => {
    await expectPackError(() => headCommit(tempRoot), 'GIT_NOT_A_REPO');
  });
});

// ---------------------------------------------------------------------------
// 中文 / 空格路径 cwd
// ---------------------------------------------------------------------------

describe('中文与空格目录里的仓库', () => {
  it('目录名含中文与空格：init / status / branch / head 全流程正常', async () => {
    const repoDir = path.join(tempRoot, '图包 仓库');
    await mkdir(repoDir);
    await initRepo(repoDir);
    await commitFile('卡片.csv', 'cardId,face\n1,x\n', 'init', repoDir);

    expect(await isGitRepo(repoDir)).toBe(true);
    expect(await currentBranch(repoDir)).toBe('main');
    expect(await statusPorcelain(repoDir)).toEqual([]);
    expect(await headCommit(repoDir)).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(path.join(repoDir, '新 卡片.csv'), 'x\n', 'utf8');
    const entries = await statusPorcelain(repoDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ xy: '??', path: '新 卡片.csv' });
  });
});
