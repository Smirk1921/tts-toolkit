// tests/unit/host-steamcloud.test.ts
/**
 * src/host/steamcloud.ts 单元测试：Steam Cloud 默认图床的手动上传流程。
 *
 * 纯文件 IO + 本地 HTTP 服务器（无外网）：
 * - 上传 = 暂存 + 待上传清单：文件按对象名写入暂存目录（含子目录），清单 YAML 可解析回
 *   文件清单；结果 status="pending"、无 url、提示含暂存目录与清单路径 —— 手动流程是
 *   "可接受结果"，绝不当失败；
 * - check 走 HTTP 探测：本地服务器 200 → 存活；404 / 连不上 → 不存活（不抛网络错误）；
 * - checkUrls 会读 https_proxy 环境变量，测试前清掉、测完恢复，保证探测直连本地端口。
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { PackError } from '../../src/pack/packyaml.js';
import { SteamCloudHost } from '../../src/host/steamcloud.js';
import type { File } from '../../src/host/types.js';

// ---------------------------------------------------------------------------
// 临时目录 / 环境变量 / HTTP 服务器管理
// ---------------------------------------------------------------------------

let tempRoot: string;
let savedHttpsProxy: string | undefined;
let savedHTTPS_PROXY: string | undefined;

beforeEach(() => {
  tempRoot = '';
  savedHttpsProxy = process.env.https_proxy;
  savedHTTPS_PROXY = process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTPS_PROXY;
});

afterEach(async () => {
  if (savedHttpsProxy === undefined) delete process.env.https_proxy;
  else process.env.https_proxy = savedHttpsProxy;
  if (savedHTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = savedHTTPS_PROXY;
  if (tempRoot !== '') await rm(tempRoot, { recursive: true, force: true });
});

/** 起一个本地 HTTP 服务器，返回基址与关闭函数 */
async function listen(handler: http.RequestListener): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 断言 fn 抛出指定 code 的 PackError */
async function expectHostError(fn: () => Promise<unknown>, code: string): Promise<PackError> {
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

/** 建一个一次性暂存根目录 */
async function makeStagingRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tts-toolkit-steamcloud-test-'));
  tempRoot = dir;
  return dir;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('SteamCloudHost.upload（手动上传准备）', () => {
  it('文件写入暂存目录（含子目录），返回 status=pending 的结果', async () => {
    const staging = await makeStagingRoot();
    const host = new SteamCloudHost();
    const files: File[] = [
      { name: 'atlas-101.png', data: Buffer.from('atlas-bytes') },
      { name: 'decks/hero.png', data: Buffer.from('hero-bytes') },
    ];

    const results = await host.upload(files, { stagingDir: staging });

    expect(results).toHaveLength(2);
    for (const [index, result] of results.entries()) {
      expect(result.file).toBe(files[index]?.name);
      expect(result.status).toBe('pending');
      expect(result.url).toBeUndefined();
      expect(result.pending?.stagingDir).toBe(staging);
      expect(result.pending?.manifestPath).toBe(path.join(staging, 'pending-upload.yaml'));
      // 提示里带上了暂存目录与清单路径（插值生效），且非空
      expect(result.pending?.hint).toContain(staging);
      expect(result.pending?.hint).toContain('pending-upload.yaml');
      expect(result.pending?.hint.length).toBeGreaterThan(0);
    }

    await expect(stat(path.join(staging, 'atlas-101.png'))).resolves.toBeTruthy();
    await expect(stat(path.join(staging, 'decks', 'hero.png'))).resolves.toBeTruthy();
    await expect(readFile(path.join(staging, 'atlas-101.png'))).resolves.toEqual(Buffer.from('atlas-bytes'));
  });

  it('待上传清单 YAML 可解析回文件清单（name / bytes），hint 非空', async () => {
    const staging = await makeStagingRoot();
    const host = new SteamCloudHost();
    const files: File[] = [
      { name: 'a.png', data: Buffer.from('12345') },
      { name: 'b/c.jpg', data: Buffer.from('123456') },
    ];

    await host.upload(files, { stagingDir: staging });

    const manifestText = await readFile(path.join(staging, 'pending-upload.yaml'), 'utf8');
    const manifest = parseYaml(manifestText) as {
      generated: string;
      hint: string;
      files: Array<{ name: string; bytes: number }>;
    };
    expect(manifest.files).toEqual([
      { name: 'a.png', bytes: 5 },
      { name: 'b/c.jpg', bytes: 6 },
    ]);
    expect(typeof manifest.hint).toBe('string');
    expect(manifest.hint.length).toBeGreaterThan(0);
    expect(manifest.generated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('重名 / 对象名含 ".." → HOST_INVALID_INPUT（不写盘）', async () => {
    const staging = await makeStagingRoot();
    const host = new SteamCloudHost();

    await expectHostError(
      () => host.upload(
        [
          { name: 'a.png', data: Buffer.from('1') },
          { name: 'a.png', data: Buffer.from('2') },
        ],
        { stagingDir: staging },
      ),
      'HOST_INVALID_INPUT',
    );
    await expectHostError(
      () => host.upload([{ name: '../escape.png', data: Buffer.from('x') }], { stagingDir: staging }),
      'HOST_INVALID_INPUT',
    );
  });
});

describe('SteamCloudHost.check', () => {
  it('HTTP 200 → 存活（带状态码）；404 → 不存活 + 错误描述', async () => {
    const server = await listen((req, res) => {
      res.statusCode = req.url === '/good' ? 200 : 404;
      res.end();
    });
    try {
      const host = new SteamCloudHost();
      const good = await host.check(`${server.base}/good`);
      expect(good.alive).toBe(true);
      expect(good.status).toBe(200);
      expect(good.error).toBeUndefined();

      const bad = await host.check(`${server.base}/bad`);
      expect(bad.alive).toBe(false);
      expect(bad.status).toBe(404);
      expect(bad.error).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it('连不上的端口 → 不存活（不抛网络错误）', async () => {
    const host = new SteamCloudHost();
    const result = await host.check('http://127.0.0.1:1/anything');
    expect(result.alive).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('SteamCloudHost 其他契约', () => {
  it('id 为 steamcloud；capabilities 不声明大小限制、不可删除', () => {
    const host = new SteamCloudHost();
    expect(host.id).toBe('steamcloud');
    expect(host.capabilities()).toEqual({ deletable: false });
  });

  it('配置声明重命名后 id 跟随声明名', () => {
    expect(new SteamCloudHost({ id: 'my-cloud' }).id).toBe('my-cloud');
  });
});
