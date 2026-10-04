// tests/unit/vcs-lfs.test.ts
/**
 * src/vcs/lfs.ts 单元测试：git-lfs 状态机。
 *
 * 覆盖（临时目录 + 真实 pack.yaml / .gitattributes 文件，git-lfs 走本机真实安装）：
 * - inspectLfs：三方（系统 git-lfs / .gitattributes / pack.yaml）一致与各种不一致组合、
 *   不是图包、pack.yaml 损坏透传、注释行不算规则；
 * - enableLfs：disabled → enabled 全流程、幂等（changed=false）、保留并追加规则、
 *   与 B1 init.ts 模板逐行一致；
 * - disableLfs：清除 lfs 行保留其他行、只剩空行/注释时删文件、幂等、注释掉的
 *   lfs 行一并清除；
 * - isLfsPointer：指针 / 真图 / 纯文本 / 标记越界 / 空文件 / 不存在；
 * - migrateLfs：未装抛 LFS_NOT_INSTALLED（mock PATH）、已装真实迁移后文件变指针。
 *
 * 注：禁用二次确认在 CLI 层，模块层不确认——本文件直接调用即验证这一点。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PACK_YAML_FILENAME, PackError, readPackYaml, writePackYaml, type PackYaml } from '../../src/pack/packyaml.js';
import { enableLfs, disableLfs, inspectLfs, isLfsPointer, migrateLfs } from '../../src/vcs/lfs.js';

// ---------------------------------------------------------------------------
// 常量（与 src/pack/init.ts 的 GITATTRIBUTES_LINES 逐行一致；改动必须同步）
// ---------------------------------------------------------------------------

/** B1 init.ts 写入 .gitattributes 的模板行（本文件兼作两处一致性的守卫） */
const INIT_TEMPLATE_LINES: readonly string[] = Object.freeze([
  '*.png filter=lfs diff=lfs merge=lfs -text',
  '*.jpg filter=lfs diff=lfs merge=lfs -text',
  '*.jpeg filter=lfs diff=lfs merge=lfs -text',
  '*.gif filter=lfs diff=lfs merge=lfs -text',
  '*.webp filter=lfs diff=lfs merge=lfs -text',
  '*.obj filter=lfs diff=lfs merge=lfs -text',
  '*.ttsmod filter=lfs diff=lfs merge=lfs -text',
]);

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-lfs-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 写一份最小合法 pack.yaml（经 writePackYaml 的 schema 校验，vcs.lfs 可指定） */
async function writePack(root: string, lfs: PackYaml['vcs']['lfs'] = 'enabled'): Promise<PackYaml> {
  const pack: PackYaml = {
    schema_version: 1,
    name: '测试图包',
    workshop_id: null,
    source_mod: null,
    vcs: { lfs },
    paths: { workdir: '.' },
    upload: { prefix: '' },
  };
  await writePackYaml(root, pack);
  return pack;
}

/** .gitattributes 的路径 */
function attributesPath(root: string): string {
  return path.join(root, '.gitattributes');
}

/** 写 .gitattributes（原始文本，用于构造各种手改文件） */
async function writeAttributes(root: string, text: string): Promise<void> {
  await writeFile(attributesPath(root), text, 'utf8');
}

/** 读 .gitattributes（不存在时 null） */
async function readAttributes(root: string): Promise<string | null> {
  try {
    return await readFile(attributesPath(root), 'utf8');
  } catch {
    return null;
  }
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
 * 临时替换 process.env.PATH 执行 fn（finally 恢复），用于 mock "git-lfs 未安装"。
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

/** 在目录里 git init + 提交身份 + 关 autocrlf（migrateLfs 用例用） */
async function initRepo(dir: string): Promise<void> {
  const git = async (args: string[]): Promise<void> => {
    const result = await execa('git', args, { cwd: dir, reject: false });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
    }
  };
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'test@test.local']);
  await git(['config', 'user.name', 'tester']);
  await git(['config', 'core.autocrlf', 'false']);
}

// ---------------------------------------------------------------------------
// inspectLfs：三方一致性
// ---------------------------------------------------------------------------

describe('inspectLfs', () => {
  it('三方一致 enabled：installed / attributesHasLfs / packYamlLfs 全对齐，consistent=true', async () => {
    await writePack(tempRoot, 'enabled');
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES.join('\n')}\n`);
    const inspection = await inspectLfs(tempRoot);
    expect(inspection.installed).toBe(true);
    expect(inspection.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(inspection.attributesHasLfs).toBe(true);
    expect(inspection.packYamlLfs).toBe('enabled');
    expect(inspection.warnings).toEqual([]);
    expect(inspection.consistent).toBe(true);
  });

  it('三方一致 disabled：无 .gitattributes，consistent=true', async () => {
    await writePack(tempRoot, 'disabled');
    const inspection = await inspectLfs(tempRoot);
    expect(inspection.installed).toBe(true);
    expect(inspection.attributesHasLfs).toBe(false);
    expect(inspection.packYamlLfs).toBe('disabled');
    expect(inspection.consistent).toBe(true);
  });

  it('disabled-no-lfs 且无规则：与 disabled 同样视为一致', async () => {
    await writePack(tempRoot, 'disabled-no-lfs');
    const inspection = await inspectLfs(tempRoot);
    expect(inspection.packYamlLfs).toBe('disabled-no-lfs');
    expect(inspection.consistent).toBe(true);
  });

  it('未装 git-lfs（mock PATH）但 .gitattributes 声明了 lfs：警告"无法正常 checkout"', async () => {
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES.join('\n')}\n`);
    await withMockedPath(tempRoot, async () => {
      const inspection = await inspectLfs(tempRoot);
      expect(inspection.installed).toBe(false);
      expect(inspection.version).toBeNull();
      expect(inspection.attributesHasLfs).toBe(true);
      expect(inspection.warnings).toHaveLength(1);
      expect(inspection.warnings[0]).toContain('未装 git-lfs');
      expect(inspection.warnings[0]).toContain('无法正常 checkout');
      expect(inspection.consistent).toBe(false);
    });
  });

  it('pack.yaml 声明 enabled 但 .gitattributes 缺规则：警告"缺规则"', async () => {
    await writePack(tempRoot, 'enabled');
    const inspection = await inspectLfs(tempRoot);
    expect(inspection.warnings).toEqual(['pack.yaml 声明启用 lfs 但 .gitattributes 缺规则']);
    expect(inspection.consistent).toBe(false);
  });

  it('pack.yaml 声明 disabled 但 .gitattributes 仍含规则：警告"仍含规则"', async () => {
    await writePack(tempRoot, 'disabled');
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES.join('\n')}\n`);
    const inspection = await inspectLfs(tempRoot);
    expect(inspection.warnings).toEqual(['pack.yaml 声明禁用 lfs 但 .gitattributes 仍含规则']);
    expect(inspection.consistent).toBe(false);
  });

  it('.gitattributes 存在但只有非 lfs 规则：attributesHasLfs=false', async () => {
    await writeAttributes(tempRoot, '*.psd -text\n*.md text\n');
    const inspection = await inspectLfs(tempRoot);
    expect(inspection.attributesHasLfs).toBe(false);
  });

  it('注释掉的 lfs 行不算规则（"# *.png filter=lfs"）', async () => {
    await writeAttributes(tempRoot, '# *.png filter=lfs diff=lfs merge=lfs -text\n');
    const inspection = await inspectLfs(tempRoot);
    expect(inspection.attributesHasLfs).toBe(false);
  });

  it('不是图包（无 pack.yaml）：packYamlLfs=null，不产生 yaml 相关警告', async () => {
    const inspection = await inspectLfs(tempRoot);
    expect(inspection.packYamlLfs).toBeNull();
    expect(inspection.attributesHasLfs).toBe(false);
    expect(inspection.warnings).toEqual([]);
    expect(inspection.consistent).toBe(true);
  });

  it('pack.yaml 损坏：透传 PACK_INVALID（PACK_YAML_INVALID 语义）', async () => {
    await writeFile(path.join(tempRoot, PACK_YAML_FILENAME), 'schema_version: 2\nname: 坏的\n', 'utf8');
    await expectPackError(() => inspectLfs(tempRoot), 'PACK_INVALID');
  });

  it('多项同时不一致：警告逐条累积', async () => {
    await writePack(tempRoot, 'disabled');
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES.join('\n')}\n`);
    await withMockedPath(tempRoot, async () => {
      const inspection = await inspectLfs(tempRoot);
      // 未装 + 声明禁用但仍有规则 → 两条
      expect(inspection.warnings).toHaveLength(2);
      expect(inspection.consistent).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// enableLfs
// ---------------------------------------------------------------------------

describe('enableLfs', () => {
  it('disabled → enabled：写模板 .gitattributes + 改 pack.yaml，changed=true', async () => {
    await writePack(tempRoot, 'disabled');
    const result = await enableLfs(tempRoot);
    expect(result).toEqual({ changed: true, attributesWritten: true, packYamlUpdated: true });

    const content = await readAttributes(tempRoot);
    const lines = (content ?? '').split('\n').filter((line) => line.trim() !== '');
    expect(lines).toEqual([...INIT_TEMPLATE_LINES]);
    expect((await readPackYaml(tempRoot)).vcs.lfs).toBe('enabled');
  });

  it('已 enabled 且规则齐全：幂等，changed=false 且不重写文件', async () => {
    await writePack(tempRoot, 'enabled');
    const original = `${INIT_TEMPLATE_LINES.join('\n')}\n`;
    await writeAttributes(tempRoot, original);
    const result = await enableLfs(tempRoot);
    expect(result).toEqual({ changed: false, attributesWritten: false, packYamlUpdated: false });
    expect(await readAttributes(tempRoot)).toBe(original);
  });

  it('已有其他规则：保留原行，模板追加在末尾', async () => {
    await writePack(tempRoot, 'disabled');
    await writeAttributes(tempRoot, '*.psd -text\n');
    const result = await enableLfs(tempRoot);
    expect(result.attributesWritten).toBe(true);

    const lines = (await readAttributes(tempRoot) ?? '').split('\n').filter((line) => line.trim() !== '');
    expect(lines[0]).toBe('*.psd -text');
    expect(lines.slice(1)).toEqual([...INIT_TEMPLATE_LINES]);
  });

  it('模板部分缺失：只补缺失行，不产生重复规则', async () => {
    await writePack(tempRoot, 'enabled');
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES[0]}\n`);
    const result = await enableLfs(tempRoot);
    expect(result.attributesWritten).toBe(true);

    const content = (await readAttributes(tempRoot)) ?? '';
    expect(content.split('\n').filter((line) => line.trim() !== '')).toEqual([...INIT_TEMPLATE_LINES]);
    // *.png 规则只出现一次
    expect(content.split('*.png filter=lfs').length - 1).toBe(1);
  });

  it('规则齐全但 yaml=disabled：只改 pack.yaml，attributesWritten=false', async () => {
    await writePack(tempRoot, 'disabled');
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES.join('\n')}\n`);
    const result = await enableLfs(tempRoot);
    expect(result).toEqual({ changed: true, attributesWritten: false, packYamlUpdated: true });
    expect((await readPackYaml(tempRoot)).vcs.lfs).toBe('enabled');
  });

  it('无 pack.yaml：抛 PACK_NOT_FOUND，不写 .gitattributes', async () => {
    await expectPackError(() => enableLfs(tempRoot), 'PACK_NOT_FOUND');
    expect(existsSync(attributesPath(tempRoot))).toBe(false);
  });

  it('写出的模板行与 B1 init.ts 逐行一致（守卫两处同步）', async () => {
    await writePack(tempRoot, 'disabled');
    await enableLfs(tempRoot);
    const lines = (await readAttributes(tempRoot) ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(lines).toEqual([
      '*.png filter=lfs diff=lfs merge=lfs -text',
      '*.jpg filter=lfs diff=lfs merge=lfs -text',
      '*.jpeg filter=lfs diff=lfs merge=lfs -text',
      '*.gif filter=lfs diff=lfs merge=lfs -text',
      '*.webp filter=lfs diff=lfs merge=lfs -text',
      '*.obj filter=lfs diff=lfs merge=lfs -text',
      '*.ttsmod filter=lfs diff=lfs merge=lfs -text',
    ]);
  });

  it('enableLfs 后 inspectLfs 一致（模块间联动）', async () => {
    await writePack(tempRoot, 'disabled-no-lfs');
    await enableLfs(tempRoot);
    const inspection = await inspectLfs(tempRoot);
    expect(inspection.packYamlLfs).toBe('enabled');
    expect(inspection.attributesHasLfs).toBe(true);
    expect(inspection.consistent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// disableLfs
// ---------------------------------------------------------------------------

describe('disableLfs', () => {
  it('enabled → disabled：清除 lfs 行、保留其他规则、pack.yaml 改 disabled', async () => {
    await writePack(tempRoot, 'enabled');
    await writeAttributes(tempRoot, '*.psd -text\n# 说明注释\n*.png filter=lfs diff=lfs merge=lfs -text\n*.jpg filter=lfs diff=lfs merge=lfs -text\n');
    const result = await disableLfs(tempRoot);
    expect(result).toEqual({ changed: true, attributesWritten: true, packYamlUpdated: true });

    const content = await readAttributes(tempRoot);
    expect(content).not.toContain('filter=lfs');
    expect(content).toContain('*.psd -text');
    expect(content).toContain('# 说明注释');
    expect((await readPackYaml(tempRoot)).vcs.lfs).toBe('disabled');
  });

  it('清空后只剩空行 / 注释：整个文件删除', async () => {
    await writePack(tempRoot, 'enabled');
    // 只有 lfs 规则 + 注释头（注释不含 filter=lfs）
    await writeAttributes(tempRoot, '# 图包素材规则\n*.png filter=lfs diff=lfs merge=lfs -text\n*.jpg filter=lfs diff=lfs merge=lfs -text\n');
    const result = await disableLfs(tempRoot);
    expect(result.attributesWritten).toBe(true);
    expect(existsSync(attributesPath(tempRoot))).toBe(false);
  });

  it('注释掉的 lfs 规则行（含 filter=lfs）也一并清除', async () => {
    await writePack(tempRoot, 'enabled');
    await writeAttributes(tempRoot, '*.psd -text\n# *.png filter=lfs diff=lfs merge=lfs -text\n');
    await disableLfs(tempRoot);
    const content = await readAttributes(tempRoot);
    expect(content).not.toContain('filter=lfs');
    expect(content).toContain('*.psd -text');
  });

  it('无 .gitattributes：attributesWritten=false，只改 pack.yaml', async () => {
    await writePack(tempRoot, 'enabled');
    const result = await disableLfs(tempRoot);
    expect(result).toEqual({ changed: true, attributesWritten: false, packYamlUpdated: true });
    expect((await readPackYaml(tempRoot)).vcs.lfs).toBe('disabled');
  });

  it('已 disabled 且无 lfs 规则：幂等，changed=false', async () => {
    await writePack(tempRoot, 'disabled');
    const result = await disableLfs(tempRoot);
    expect(result).toEqual({ changed: false, attributesWritten: false, packYamlUpdated: false });
  });

  it('有 lfs 规则但 yaml 已是 disabled：只动 .gitattributes', async () => {
    await writePack(tempRoot, 'disabled');
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES.join('\n')}\n`);
    const result = await disableLfs(tempRoot);
    expect(result).toEqual({ changed: true, attributesWritten: true, packYamlUpdated: false });
    expect(existsSync(attributesPath(tempRoot))).toBe(false);
  });

  it('vcs.lfs=disabled-no-lfs 时也改写为 "disabled"（禁用即归一为 disabled）', async () => {
    await writePack(tempRoot, 'disabled-no-lfs');
    const result = await disableLfs(tempRoot);
    expect(result.packYamlUpdated).toBe(true);
    expect((await readPackYaml(tempRoot)).vcs.lfs).toBe('disabled');
  });

  it('无 pack.yaml：抛 PACK_NOT_FOUND', async () => {
    await expectPackError(() => disableLfs(tempRoot), 'PACK_NOT_FOUND');
  });

  it('disableLfs 后 inspectLfs 一致（模块间联动）', async () => {
    await writePack(tempRoot, 'enabled');
    await writeAttributes(tempRoot, `${INIT_TEMPLATE_LINES.join('\n')}\n`);
    await disableLfs(tempRoot);
    const inspection = await inspectLfs(tempRoot);
    expect(inspection.packYamlLfs).toBe('disabled');
    expect(inspection.attributesHasLfs).toBe(false);
    expect(inspection.consistent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isLfsPointer
// ---------------------------------------------------------------------------

describe('isLfsPointer', () => {
  it('lfs 指针文件：true', async () => {
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc123\nsize 3\n';
    await writeFile(path.join(tempRoot, 'img.png'), pointer, 'utf8');
    expect(await isLfsPointer(path.join(tempRoot, 'img.png'))).toBe(true);
  });

  it('真图（二进制字节，无指针标记）：false', async () => {
    await writeFile(path.join(tempRoot, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(await isLfsPointer(path.join(tempRoot, 'img.png'))).toBe(false);
  });

  it('普通文本文件：false', async () => {
    await writeFile(path.join(tempRoot, 'a.txt'), 'version 1\n普通文本\n', 'utf8');
    expect(await isLfsPointer(path.join(tempRoot, 'a.txt'))).toBe(false);
  });

  it('标记在 100 字节之后：false（只探文件头 100 字节）', async () => {
    const content = `${'x'.repeat(100)}version https://git-lfs.github.com/spec/v1\n`;
    await writeFile(path.join(tempRoot, 'tricky.png'), content, 'utf8');
    expect(await isLfsPointer(path.join(tempRoot, 'tricky.png'))).toBe(false);
  });

  it('空文件：false', async () => {
    await writeFile(path.join(tempRoot, 'empty.png'), '', 'utf8');
    expect(await isLfsPointer(path.join(tempRoot, 'empty.png'))).toBe(false);
  });

  it('文件不存在：false（不抛错）', async () => {
    expect(await isLfsPointer(path.join(tempRoot, '不存在.png'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// migrateLfs
// ---------------------------------------------------------------------------

describe('migrateLfs', () => {
  it('未装 git-lfs（mock PATH）：抛 LFS_NOT_INSTALLED', async () => {
    await withMockedPath(tempRoot, async () => {
      const err = await expectPackError(() => migrateLfs(tempRoot), 'LFS_NOT_INSTALLED');
      expect(err.message).toContain('git-lfs');
    });
  });

  it('已装 git-lfs + 干净仓库：真实迁移，历史文件变指针，output 非空', async () => {
    await initRepo(tempRoot);
    // 含 NUL 的二进制 png，加入历史
    await writeFile(path.join(tempRoot, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));
    await execa('git', ['add', 'img.png'], { cwd: tempRoot });
    await execa('git', ['commit', '-m', 'init'], { cwd: tempRoot });

    const result = await migrateLfs(tempRoot);
    expect(result.migrated).toBe(true);
    expect(result.output.length).toBeGreaterThan(0);
    // 工作区文件已被改写为 lfs 指针
    expect(await isLfsPointer(path.join(tempRoot, 'img.png'))).toBe(true);
  });

  it('非 git 仓库目录（git-lfs 已装）：透传 GIT_COMMAND_FAILED', async () => {
    await expectPackError(() => migrateLfs(tempRoot), 'GIT_COMMAND_FAILED');
  });
});
