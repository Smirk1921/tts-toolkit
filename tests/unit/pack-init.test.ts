// tests/unit/pack-init.test.ts
/**
 * src/pack/init.ts 单元测试：图包工作区初始化（initPack）。
 *
 * 覆盖：
 * - 正常路径（显式 lfs="enabled"、skipGit=true）：返回值字段、pack.yaml 各字段、
 *   .gitattributes（lfs filter）、.gitignore 含 .tts/skeleton.json（约束 8）、
 *   目录骨架、不建 .git；
 * - 重入防护：目录已含 pack.yaml → PackError("PACK_EXISTS")，且既有清单不被覆盖；
 * - 约束 10（git-lfs 显式三选一）的非交互出口：skipLfsPrompt=true →
 *   vcs.lfs="disabled-no-lfs"；lfs="disabled" → 不写 .gitattributes；
 * - 真实 git init（不传 skipGit）：用 node:child_process.execFile 跑
 *   `git rev-parse --is-inside-work-tree` 复核 .git 确实是可用仓库。
 *
 * 纯文件 IO（os.tmpdir() 下的临时目录）+ 本机 git，无网络、无 TTS 依赖：
 * - 显式传 lfs 决策（或 skipLfsPrompt）绕开 git-lfs 探测与交互菜单——
 *   交互路径（TTY 菜单 / 二次确认）属 CLI 层行为，不在单测覆盖范围；
 * - 错误按 PackError.code（机器可读）断言，不依赖错误文案——文案走 t()，
 *   locales/*.json 由 Run 2 补齐，补齐前后 message 不同。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initPack } from '../../src/pack/init.js';
import { readPackYaml } from '../../src/pack/packyaml.js';

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-init-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('initPack', () => {
  it('正常路径（lfs=enabled、skipGit）：pack.yaml 字段正确，.gitattributes / .gitignore / 目录骨架齐备', async () => {
    // 中文目录名同时钉住 name 缺省取 basename 的行为
    const dir = path.join(tempRoot, '我的图包');
    const result = await initPack({ dir, skipGit: true, lfs: 'enabled' });

    // 返回值：packRoot 已 resolve；skipGit=true → 未执行 git init
    expect(result.packRoot).toBe(path.resolve(dir));
    expect(result.packYamlWritten).toBe(true);
    expect(result.gitInitialized).toBe(false);
    expect(result.lfsChoice).toBe('enabled');

    // pack.yaml 存在且字段正确（显式 lfs 直通 schema，name 缺省取目录名）
    const packYaml = await readPackYaml(result.packRoot);
    expect(packYaml.schema_version).toBe(1);
    expect(packYaml.name).toBe('我的图包');
    expect(packYaml.workshop_id).toBeNull();
    expect(packYaml.source_mod).toBeNull();
    expect(packYaml.host).toBe('steamcloud');
    expect(packYaml.vcs.lfs).toBe('enabled');
    expect(packYaml.paths.workdir).toBe('.');
    expect(packYaml.upload.prefix).toBe('');

    // .gitattributes：lfs=enabled 时写出（图片 / 模型 / ttsmod 走 lfs filter）
    expect(existsSync(path.join(dir, '.gitattributes'))).toBe(true);
    const attrs = await readFile(path.join(dir, '.gitattributes'), 'utf8');
    expect(attrs).toContain('*.png filter=lfs');
    expect(attrs).toContain('*.obj filter=lfs');
    expect(attrs).toContain('*.ttsmod filter=lfs');

    // .gitignore：无论 lfs 与否都写；约束 8——骨架存档绝不入 git
    const gitignore = await readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.tts/skeleton.json');

    // 目录骨架（含 .tts/ 内部状态目录）
    for (const sub of ['scripts', 'ui', 'decks', 'objects', 'sheets', 'source', '.tts']) {
      expect(existsSync(path.join(dir, ...sub.split('/'))), sub).toBe(true);
    }

    // skipGit: true → 不创建 .git
    expect(existsSync(path.join(dir, '.git'))).toBe(false);
  }, 30_000);

  it('目录已含 pack.yaml → 抛 PackError(code=PACK_EXISTS)，既有清单不被覆盖', async () => {
    const dir = path.join(tempRoot, 'already');
    await initPack({ dir, skipGit: true, lfs: 'disabled' });
    const before = await readFile(path.join(dir, 'pack.yaml'), 'utf8');

    // 重跑：判据是 pack.yaml 已存在 → 拒绝（防覆盖已有图包元数据）
    await expect(initPack({ dir, skipGit: true, lfs: 'enabled' })).rejects.toMatchObject({
      name: 'PackError',
      code: 'PACK_EXISTS',
    });

    // 既有 pack.yaml 原样保留（第二次调用显式 lfs=enabled 也不影响既有文件）
    expect(await readFile(path.join(dir, 'pack.yaml'), 'utf8')).toBe(before);
    expect((await readPackYaml(dir)).vcs.lfs).toBe('disabled');
  }, 30_000);

  it('skipLfsPrompt=true → vcs.lfs=disabled-no-lfs，不写 .gitattributes（非交互降级路径）', async () => {
    const dir = path.join(tempRoot, 'no-prompt');
    const result = await initPack({ dir, skipGit: true, skipLfsPrompt: true });

    expect(result.packYamlWritten).toBe(true);
    expect(result.lfsChoice).toBe('disabled-no-lfs');
    expect((await readPackYaml(dir)).vcs.lfs).toBe('disabled-no-lfs');

    // disabled-no-lfs 不属于 "enabled" → 不写 .gitattributes
    expect(existsSync(path.join(dir, '.gitattributes'))).toBe(false);
    // .gitignore 与 lfs 决策无关，仍然写（约束 8）
    expect(await readFile(path.join(dir, '.gitignore'), 'utf8')).toContain('.tts/skeleton.json');
  }, 30_000);

  it('lfs=disabled → 不写 .gitattributes，仍写 .gitignore（禁用是显式决定，非静默降级）', async () => {
    const dir = path.join(tempRoot, 'no-lfs');
    const result = await initPack({ dir, skipGit: true, lfs: 'disabled' });

    expect(result.lfsChoice).toBe('disabled');
    expect((await readPackYaml(dir)).vcs.lfs).toBe('disabled');
    expect(existsSync(path.join(dir, '.gitattributes'))).toBe(false);
    expect(await readFile(path.join(dir, '.gitignore'), 'utf8')).toContain('.tts/skeleton.json');
  }, 30_000);

  it('不传 skipGit 时真实执行 git init：.git 建立，git rev-parse 复核可用', async () => {
    const dir = path.join(tempRoot, 'with-git');
    const result = await initPack({ dir, lfs: 'disabled' });

    expect(result.gitInitialized).toBe(true);
    expect(existsSync(path.join(dir, '.git'))).toBe(true);

    // 真实跑 git 复核：确是可用的工作区仓库（而非仅存在名为 .git 的文件）
    const { stdout } = await execFileP('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      windowsHide: true,
    });
    expect(stdout.trim()).toBe('true');
  }, 30_000);
});
