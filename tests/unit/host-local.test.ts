// tests/unit/host-local.test.ts
/**
 * src/host/local.ts 单元测试：本地图床（仅本机测试用）。
 *
 * 纯文件 IO（无网络）：
 * - 上传 = 写入配置目录（自动建目录、保持相对路径结构）+ 返回 file:// URL；
 * - check 只认 file:// URL 与本地路径：存在 → 存活；不存在 / 其他协议 → 不存活 +
 *   错误描述（不抛错）；Windows 盘符路径（C:\…）不误判为"带协议"；
 * - 构造校验：dir 缺失 → HOST_CONFIG_INVALID。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PackError } from '../../src/pack/packyaml.js';
import { LocalHost } from '../../src/host/local.js';
import type { File } from '../../src/host/types.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'tts-toolkit-local-host-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** 断言 fn 抛出指定 code 的 PackError */
async function expectHostError(fn: () => Promise<unknown> | unknown, code: string): Promise<PackError> {
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
// 用例
// ---------------------------------------------------------------------------

describe('LocalHost 构造', () => {
  it('dir 缺失 / 空串 → HOST_CONFIG_INVALID', async () => {
    await expectHostError(() => new LocalHost({ dir: '' }), 'HOST_CONFIG_INVALID');
    await expectHostError(() => new LocalHost({ dir: undefined } as unknown as { dir: string }), 'HOST_CONFIG_INVALID');
  });

  it('相对路径解析为绝对路径；id 缺省 local，可被声明名覆盖', () => {
    const host = new LocalHost({ dir: tempRoot });
    expect(host.id).toBe('local');
    expect(host.dir).toBe(path.resolve(tempRoot));
    expect(new LocalHost({ dir: tempRoot, id: 'my-local' }).id).toBe('my-local');
  });
});

describe('LocalHost.upload', () => {
  it('写入目录（含子目录）并返回 file:// URL，内容与入参一致', async () => {
    const host = new LocalHost({ dir: path.join(tempRoot, 'out') });
    const files: File[] = [
      { name: 'atlas.png', data: Buffer.from('atlas-bytes') },
      { name: 'decks/hero.png', data: Buffer.from('hero-bytes') },
    ];

    const results = await host.upload(files, {});

    expect(results).toHaveLength(2);
    for (const [index, result] of results.entries()) {
      expect(result.file).toBe(files[index]?.name);
      expect(result.status).toBe('uploaded');
      expect(result.url?.startsWith('file://')).toBe(true);
      const localPath = fileURLToPath(result.url ?? '');
      expect(existsSync(localPath)).toBe(true);
      expect(localPath.startsWith(path.resolve(tempRoot, 'out'))).toBe(true);
    }
    await expect(readFile(path.join(tempRoot, 'out', 'atlas.png'))).resolves.toEqual(Buffer.from('atlas-bytes'));
    await expect(readFile(path.join(tempRoot, 'out', 'decks', 'hero.png'))).resolves.toEqual(
      Buffer.from('hero-bytes'),
    );
  });

  it('重名 / 对象名含 ".." → HOST_INVALID_INPUT；写盘失败 → HOST_UPLOAD_FAILED', async () => {
    const host = new LocalHost({ dir: tempRoot });

    await expectHostError(
      () => host.upload(
        [
          { name: 'same.png', data: Buffer.from('1') },
          { name: 'same.png', data: Buffer.from('2') },
        ],
        {},
      ),
      'HOST_INVALID_INPUT',
    );
    await expectHostError(() => host.upload([{ name: '../x.png', data: Buffer.from('1') }], {}), 'HOST_INVALID_INPUT');

    // dir 是一个已存在文件 → mkdir 失败 → HOST_UPLOAD_FAILED
    const filePath = path.join(tempRoot, 'occupied');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, 'not-a-dir');
    await expectHostError(
      () => new LocalHost({ dir: filePath }).upload([{ name: 'a.png', data: Buffer.from('1') }], {}),
      'HOST_UPLOAD_FAILED',
    );
  });
});

describe('LocalHost.check', () => {
  it('file:// URL：存在的文件存活；缺失的文件不存活 + 错误描述', async () => {
    const host = new LocalHost({ dir: tempRoot });
    const filePath = path.join(tempRoot, 'exists.png');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, 'x');

    const alive = await host.check(pathToFileURL(filePath).href);
    expect(alive.alive).toBe(true);
    expect(alive.error).toBeUndefined();

    const missingPath = path.join(tempRoot, 'missing.png');
    const dead = await host.check(pathToFileURL(missingPath).href);
    expect(dead.alive).toBe(false);
    expect(dead.error).toContain(missingPath);
  });

  it('本地路径（不带协议）与 Windows 盘符路径按本地路径处理', async () => {
    const host = new LocalHost({ dir: tempRoot });
    const filePath = path.join(tempRoot, 'exists2.png');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, 'x');

    await expect(host.check(filePath)).resolves.toMatchObject({ alive: true });
    // 盘符冒号（C:\…）不算"带协议"，按本地路径处理 → 不存活（文件不存在，报缺失路径）
    const windowsPath = 'C:\\definitely\\missing.png';
    const result = await host.check(windowsPath);
    expect(result.alive).toBe(false);
    expect(result.error).toContain(windowsPath);
  });

  it('http(s):// 等其他协议 → 不存活并提示 local 只认 file://', async () => {
    const host = new LocalHost({ dir: tempRoot });
    for (const url of ['https://cdn.example.com/a.png', 'http://127.0.0.1:9/x', 'ftp://x/y']) {
      const result = await host.check(url);
      expect(result.alive).toBe(false);
      expect(result.error).toContain(url);
    }
  });
});

describe('LocalHost.capabilities', () => {
  it('可删除、不声明大小 / 格式限制', () => {
    expect(new LocalHost({ dir: tempRoot }).capabilities()).toEqual({ deletable: true });
  });
});
