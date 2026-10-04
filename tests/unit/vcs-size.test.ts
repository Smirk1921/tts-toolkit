// tests/unit/vcs-size.test.ts
/**
 * src/vcs/size.ts 单元测试：analyzeSize 的体积统计口径。
 *
 * 纯文件 IO（临时目录 mock 仓库），无网络、无 TTS；除一个用例用 execa 真实跑
 * `git init` 验证 .git 整体统计外，其余用例手工构造 .git / .gitattributes 固定
 * 体积，逐字节断言：
 * - 正常路径：空仓库全 0、单/多目录、嵌套递归、未知目录聚合"其他"、根散文件
 *   聚合"."、空文件与空目录、中文文件名、breakdown 降序与稳定排序；
 * - .git 口径：整体计入 gitBytes 不进 breakdown、lfs/objects 单独计量且含于
 *   gitBytes、无 .git / .git 为指针文件（worktree 布局）的边界；
 * - lfsEnabled：.gitattributes 含 filter=lfs 规则 → true，注释行 / 无规则 /
 *   缺文件 → false，CRLF 行尾可识别；
 * - 符号链接（文件符号链接与目录 junction）跳过不统计——Windows 未开启开发者
 *   模式时创建符号链接会 EPERM，用探针结果 skipIf；
 * - 错误路径：按 PackError.code（机器可读）断言，不依赖错误文案。
 */
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PackError } from '../../src/pack/packyaml.js';
import {
  analyzeSize,
  ROOT_FILES_BUCKET,
  OTHER_DIR_BUCKET,
  type DirectorySize,
  type RepoSizeReport,
} from '../../src/vcs/size.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-vcs-size-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 符号链接能力探针（模块收集期执行一次；Windows 无开发者模式时文件符号链接 EPERM）
// ---------------------------------------------------------------------------

/** 当前环境可创建的符号链接类型 */
const symlinkSupport = await (async () => {
  const support = { file: false, junction: false };
  const base = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-vcs-size-probe-'));
  try {
    await writeFile(path.join(base, 'target.txt'), 'x', 'utf8');
    try {
      await symlink('target.txt', path.join(base, 'link.txt'), 'file');
      support.file = true;
    } catch {
      support.file = false;
    }
    try {
      await mkdir(path.join(base, 'dir'));
      await symlink(path.join(base, 'dir'), path.join(base, 'dir-link'), 'junction');
      support.junction = true;
    } catch {
      support.junction = false;
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
  return support;
})();

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/**
 * 在临时仓库内写文件（自动逐级建父目录）。
 * @param relPath 相对 tempRoot 的路径（可用中文 / 多级）
 * @param sizeOrText 数字 = 文件字节数（填充 'a'）；字符串 = 原样写入（utf8）
 */
async function put(relPath: string, sizeOrText: number | string): Promise<void> {
  const abs = path.join(tempRoot, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  const content = typeof sizeOrText === 'number' ? Buffer.alloc(sizeOrText, 0x61) : sizeOrText;
  await writeFile(abs, content);
}

/** 取 breakdown 中指定桶；不存在返回 undefined */
function bucketOf(report: RepoSizeReport, dir: string): DirectorySize | undefined {
  return report.breakdown.find((bucket) => bucket.dir === dir);
}

/** breakdown 的桶名序列（已按 bytes 降序排好） */
function bucketNames(report: RepoSizeReport): string[] {
  return report.breakdown.map((bucket) => bucket.dir);
}

/**
 * 断言 fn 抛出指定 code 的 PackError，并返回该错误。
 * @param fn 待执行（预期抛 PackError）的异步函数
 * @param code 期望的机器可读错误码
 * @returns 实际抛出的 PackError
 */
async function expectSizeError(fn: () => Promise<unknown>, code: string): Promise<PackError> {
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
// analyzeSize：正常路径
// ---------------------------------------------------------------------------

describe('analyzeSize：正常路径', () => {
  it('空仓库 → 全 0 且 breakdown 为空、lfsEnabled false', async () => {
    const report = await analyzeSize(tempRoot);
    expect(report).toEqual({
      workspaceBytes: 0,
      gitBytes: 0,
      lfsObjectsBytes: 0,
      breakdown: [],
      lfsEnabled: false,
    });
  });

  it('单目录单文件 → bytes / fileCount / workspaceBytes 正确', async () => {
    await put('decks/a.png', 100);
    const report = await analyzeSize(tempRoot);
    expect(report.breakdown).toEqual([{ dir: 'decks', bytes: 100, fileCount: 1 }]);
    expect(report.workspaceBytes).toBe(100);
    expect(report.gitBytes).toBe(0);
  });

  it('嵌套目录递归计入顶层桶（decks/卡组/images/x.png）', async () => {
    await put('decks/卡组/images/x.png', 64);
    const report = await analyzeSize(tempRoot);
    expect(bucketOf(report, 'decks')).toEqual({ dir: 'decks', bytes: 64, fileCount: 1 });
    // 嵌套子目录本身不出现在 breakdown，只出现顶层桶
    expect(bucketNames(report)).toEqual(['decks']);
    expect(report.workspaceBytes).toBe(64);
  });

  it('多目录混合 → breakdown 按 bytes 降序，workspaceBytes 为总和', async () => {
    await put('decks/one.png', 100);
    await put('decks/two.png', 150);
    await put('decks/three.png', 50); // decks 3 文件 300 字节
    await put('objects/data.json', 200);
    await put('scripts/Global.lua', 100);
    await put('ui/button.xml', 1);
    const report = await analyzeSize(tempRoot);
    expect(report.breakdown).toEqual([
      { dir: 'decks', bytes: 300, fileCount: 3 },
      { dir: 'objects', bytes: 200, fileCount: 1 },
      { dir: 'scripts', bytes: 100, fileCount: 1 },
      { dir: 'ui', bytes: 1, fileCount: 1 },
    ]);
    expect(report.workspaceBytes).toBe(601);
  });

  it('未知顶层目录聚合为一个"其他"桶，不逐目录展开', async () => {
    await put('docs/readme.md', 50);
    await put('assets/近景.png', 45);
    await put('assets/远景.png', 25); // docs 50 + assets 70 = 其他 120 字节 3 文件
    const report = await analyzeSize(tempRoot);
    expect(report.breakdown).toEqual([{ dir: OTHER_DIR_BUCKET, bytes: 120, fileCount: 3 }]);
    expect(bucketOf(report, 'docs')).toBeUndefined();
    expect(bucketOf(report, 'assets')).toBeUndefined();
    expect(report.workspaceBytes).toBe(120);
  });

  it('根目录散文件（pack.yaml / .gitignore 等）聚合为"."桶', async () => {
    await put('pack.yaml', 40);
    await put('.gitignore', 10);
    const report = await analyzeSize(tempRoot);
    expect(report.breakdown).toEqual([{ dir: ROOT_FILES_BUCKET, bytes: 50, fileCount: 2 }]);
    expect(report.workspaceBytes).toBe(50);
  });

  it('.tts / source / sheets / ui 已知目录各自成桶，不进"其他"', async () => {
    await put('.tts/skeleton.json', 8);
    await put('source/原始图.psd', 7);
    await put('sheets/合并表.png', 6);
    await put('ui/panel.xml', 5);
    const report = await analyzeSize(tempRoot);
    expect(bucketNames(report)).toEqual(['.tts', 'source', 'sheets', 'ui']);
    expect(bucketOf(report, OTHER_DIR_BUCKET)).toBeUndefined();
  });

  it('空文件（0 字节）计 1 个文件 0 字节，不影响同桶其他文件', async () => {
    await put('decks/empty.bin', 0);
    await put('decks/full.bin', 5);
    const report = await analyzeSize(tempRoot);
    expect(bucketOf(report, 'decks')).toEqual({ dir: 'decks', bytes: 5, fileCount: 2 });
    expect(report.workspaceBytes).toBe(5);
  });

  it('空目录（无任何文件）也出现在 breakdown，0 字节 0 文件', async () => {
    await mkdir(path.join(tempRoot, 'sheets'));
    const report = await analyzeSize(tempRoot);
    expect(report.breakdown).toEqual([{ dir: 'sheets', bytes: 0, fileCount: 0 }]);
    expect(report.workspaceBytes).toBe(0);
  });

  it('bytes 相同的桶按目录名码元序升序，顺序稳定', async () => {
    await put('objects/x.png', 50);
    await put('decks/x.png', 50);
    const report = await analyzeSize(tempRoot);
    expect(bucketNames(report)).toEqual(['decks', 'objects']);
  });

  it('中文文件名与中文目录名正确统计（utf8 字节数）', async () => {
    const text = '卡图内容'; // 4 个汉字 × 3 字节 = 12 字节
    await put(`decks/冒险牌堆/${text}.png`, text);
    const report = await analyzeSize(tempRoot);
    expect(bucketOf(report, 'decks')).toEqual({
      dir: 'decks',
      bytes: Buffer.byteLength(text, 'utf8'),
      fileCount: 1,
    });
    expect(report.workspaceBytes).toBe(12);
  });

  it('workspaceBytes 不变量：恒等于 breakdown 各桶之和（含"."与"其他"，不含 .git）', async () => {
    await put('decks/a.png', 20);
    await put('decks/b.png', 10); // decks 30
    await put('docs/notes.txt', 20); // 其他 20
    await put('pack.yaml', 10); // "." 10
    await put('.git/HEAD', 5);
    const report = await analyzeSize(tempRoot);
    const sum = report.breakdown.reduce((total, bucket) => total + bucket.bytes, 0);
    expect(sum).toBe(report.workspaceBytes);
    expect(report.workspaceBytes).toBe(60);
    expect(report.gitBytes).toBe(5);
  });

  it('小仓库不触发大仓库 console.warn', async () => {
    await put('decks/a.png', 10);
    const warnSpy = vi.spyOn(console, 'warn');
    try {
      await analyzeSize(tempRoot);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// analyzeSize：.git 统计
// ---------------------------------------------------------------------------

describe('analyzeSize：.git 统计', () => {
  it('.git 目录整体计入 gitBytes，不进 breakdown、不进 workspaceBytes', async () => {
    await put('decks/a.png', 100);
    await put('.git/HEAD', 20);
    await put('.git/objects/ab/cdef', 30);
    const report = await analyzeSize(tempRoot);
    expect(report.gitBytes).toBe(50);
    expect(report.workspaceBytes).toBe(100);
    expect(bucketOf(report, '.git')).toBeUndefined();
  });

  it('.git/lfs/objects 单独计入 lfsObjectsBytes，且包含于 gitBytes', async () => {
    await put('.git/config', 10);
    await put('.git/lfs/objects/ab/cd1234ef', 40);
    const report = await analyzeSize(tempRoot);
    expect(report.lfsObjectsBytes).toBe(40);
    expect(report.gitBytes).toBe(50);
  });

  it('.git 无 lfs/objects（或其为空目录）→ lfsObjectsBytes 0', async () => {
    await put('.git/HEAD', 20);
    const withoutLfs = await analyzeSize(tempRoot);
    expect(withoutLfs.lfsObjectsBytes).toBe(0);
    expect(withoutLfs.gitBytes).toBe(20);
    await mkdir(path.join(tempRoot, '.git', 'lfs', 'objects'), { recursive: true });
    const withEmptyLfs = await analyzeSize(tempRoot);
    expect(withEmptyLfs.lfsObjectsBytes).toBe(0);
    expect(withEmptyLfs.gitBytes).toBe(20);
  });

  it('无 .git → gitBytes 与 lfsObjectsBytes 均为 0', async () => {
    await put('decks/a.png', 10);
    const report = await analyzeSize(tempRoot);
    expect(report.gitBytes).toBe(0);
    expect(report.lfsObjectsBytes).toBe(0);
  });

  it('.git 是指针文件（worktree 布局）→ 按单文件计入 gitBytes', async () => {
    const pointer = 'gitdir: ../main/.git\n';
    await put('decks/a.png', 10);
    await put('.git', pointer);
    const report = await analyzeSize(tempRoot);
    expect(report.gitBytes).toBe(Buffer.byteLength(pointer, 'utf8'));
    expect(report.lfsObjectsBytes).toBe(0);
    expect(bucketOf(report, '.git')).toBeUndefined();
  });

  it('真实 git init 后：.git 被整体统计（execa）', async () => {
    await put('decks/a.png', 100);
    await execa('git', ['init'], { cwd: tempRoot });
    const report = await analyzeSize(tempRoot);
    expect(report.gitBytes).toBeGreaterThan(0);
    expect(report.lfsObjectsBytes).toBe(0);
    expect(bucketOf(report, 'decks')).toEqual({ dir: 'decks', bytes: 100, fileCount: 1 });
    expect(bucketOf(report, '.git')).toBeUndefined();
    expect(report.workspaceBytes).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// analyzeSize：lfsEnabled 检测
// ---------------------------------------------------------------------------

describe('analyzeSize：lfsEnabled 检测', () => {
  it('.gitattributes 含 filter=lfs 规则 → true', async () => {
    await put('.gitattributes', '*.png filter=lfs diff=lfs merge=lfs -text\n');
    const report = await analyzeSize(tempRoot);
    expect(report.lfsEnabled).toBe(true);
  });

  it('.gitattributes 无 lfs 规则 → false', async () => {
    await put('.gitattributes', '*.md text\n*.png -text\n');
    const report = await analyzeSize(tempRoot);
    expect(report.lfsEnabled).toBe(false);
  });

  it('无 .gitattributes → false', async () => {
    await put('decks/a.png', 1);
    const report = await analyzeSize(tempRoot);
    expect(report.lfsEnabled).toBe(false);
  });

  it('注释行中的 filter=lfs 不算规则 → false', async () => {
    await put('.gitattributes', '# *.png filter=lfs（禁用前的旧规则）\n*.md text\n');
    const report = await analyzeSize(tempRoot);
    expect(report.lfsEnabled).toBe(false);
  });

  it('多条规则中仅一条含 filter=lfs → true', async () => {
    await put('.gitattributes', '*.md text\nsheets/*.psd filter=lfs -text\n*.png -text\n');
    const report = await analyzeSize(tempRoot);
    expect(report.lfsEnabled).toBe(true);
  });

  it('CRLF 行尾的规则也能识别 → true', async () => {
    await put('.gitattributes', '*.png filter=lfs\r\n');
    const report = await analyzeSize(tempRoot);
    expect(report.lfsEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// analyzeSize：符号链接跳过
// ---------------------------------------------------------------------------

describe('analyzeSize：符号链接跳过', () => {
  it.skipIf(!symlinkSupport.junction)('顶层目录 junction 链接跳过不统计（防循环）', async () => {
    await put('decks/a.png', 10);
    await put('ext/big.bin', 100);
    await symlink(path.join(tempRoot, 'ext'), path.join(tempRoot, 'linked'), 'junction');
    const report = await analyzeSize(tempRoot);
    // 链接本身不成桶；目标目录 ext 只通过真实目录计一次（聚合进"其他"）
    expect(bucketOf(report, 'linked')).toBeUndefined();
    expect(bucketOf(report, 'ext')).toBeUndefined();
    expect(bucketOf(report, OTHER_DIR_BUCKET)).toEqual({ dir: OTHER_DIR_BUCKET, bytes: 100, fileCount: 1 });
    expect(bucketOf(report, 'decks')).toEqual({ dir: 'decks', bytes: 10, fileCount: 1 });
    expect(report.workspaceBytes).toBe(110);
  });

  it.skipIf(!symlinkSupport.file)('子目录内文件符号链接跳过不统计', async () => {
    await put('outside/target.bin', 500);
    await put('decks/real.png', 10);
    await symlink(
      path.join(tempRoot, 'outside', 'target.bin'),
      path.join(tempRoot, 'decks', 'fake.png'),
      'file',
    );
    const report = await analyzeSize(tempRoot);
    // decks 桶只有真实文件；链接指向的 outside 内容计入"其他"
    expect(bucketOf(report, 'decks')).toEqual({ dir: 'decks', bytes: 10, fileCount: 1 });
    expect(bucketOf(report, OTHER_DIR_BUCKET)).toEqual({ dir: OTHER_DIR_BUCKET, bytes: 500, fileCount: 1 });
    expect(report.workspaceBytes).toBe(510);
  });
});

// ---------------------------------------------------------------------------
// analyzeSize：错误路径
// ---------------------------------------------------------------------------

describe('analyzeSize：错误路径', () => {
  it('packRoot 不存在 → PackError code="SIZE_NOT_A_PACK"', async () => {
    await expectSizeError(() => analyzeSize(path.join(tempRoot, 'no-such-pack')), 'SIZE_NOT_A_PACK');
  });

  it('packRoot 是文件而非目录 → SIZE_NOT_A_PACK', async () => {
    await put('plain.txt', 5);
    await expectSizeError(() => analyzeSize(path.join(tempRoot, 'plain.txt')), 'SIZE_NOT_A_PACK');
  });

  it('.gitattributes 是目录（读取失败）→ SIZE_READ_FAILED', async () => {
    await mkdir(path.join(tempRoot, '.gitattributes'));
    await expectSizeError(() => analyzeSize(tempRoot), 'SIZE_READ_FAILED');
  });
});
