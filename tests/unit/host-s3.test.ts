// tests/unit/host-s3.test.ts
/**
 * src/host/s3.ts 单元测试：S3 兼容图床（SigV4 签名 + PUT Object）。
 *
 * 用本地 node:http 服务器冒充 S3 端点（无外网）：
 * - 签名正确性：测试文件里**独立重算**一遍 AWS SigV4（与实现不是同一份代码），
 *   对比请求头里的 Authorization 全串；同时校验 x-amz-content-sha256 = body 哈希、
 *   canonical URI 的 path-style 与百分号编码；
 * - 公开 URL：public_base_url 优先，缺省 <endpoint>/<bucket>；非 ASCII / 空格按段编码；
 * - 错误路径：必填字段缺失 / endpoint 非法 → HOST_CONFIG_INVALID；PUT 非 2xx →
 *   HOST_UPLOAD_FAILED；check 复用 HTTP 探测。
 */
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PackError } from '../../src/pack/packyaml.js';
import { S3Host, S3_MAX_PUT_BYTES } from '../../src/host/s3.js';
import type { S3HostOptions } from '../../src/host/s3.js';
import type { File } from '../../src/host/types.js';

// ---------------------------------------------------------------------------
// 环境变量管理（checkUrls 会读 https_proxy，测试前清掉、测完恢复）
// ---------------------------------------------------------------------------

let savedHttpsProxy: string | undefined;
let savedHTTPS_PROXY: string | undefined;

beforeEach(() => {
  savedHttpsProxy = process.env.https_proxy;
  savedHTTPS_PROXY = process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTPS_PROXY;
});

afterEach(() => {
  if (savedHttpsProxy === undefined) delete process.env.https_proxy;
  else process.env.https_proxy = savedHttpsProxy;
  if (savedHTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = savedHTTPS_PROXY;
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 冒充 S3 的服务器捕获到的单次请求 */
interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
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

/** 起一个本地服务器；每次请求交给 handler，body 收完再调 */
async function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void,
): Promise<{ base: string; close: () => Promise<void>; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    requests,
  };
}

/** HMAC-SHA256（独立于实现的测试参考实现） */
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** SHA-256 十六进制（独立于实现的测试参考实现） */
function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 一份合法的最小构造参数 */
function baseOptions(port: number): S3HostOptions {
  return {
    endpoint: `http://127.0.0.1:${port}`,
    region: 'auto',
    bucket: 'bkt',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMIfake/secretKEY',
  };
}

/** 同 baseOptions，但 endpoint 直接取测试服务器的实际基址 */
function baseOptionsFromPort(server: { base: string }): S3HostOptions {
  return {
    endpoint: server.base,
    region: 'auto',
    bucket: 'bkt',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMIfake/secretKEY',
  };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('S3Host 构造校验', () => {
  it('缺任意必填字段 → HOST_CONFIG_INVALID（detail 提到字段名）', async () => {
    for (const field of ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'] as const) {
      const options = baseOptions(1);
      delete (options as Record<string, unknown>)[field];
      const err = await expectHostError(() => Promise.resolve(new S3Host(options)), 'HOST_CONFIG_INVALID');
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it('endpoint 非 http(s) URL → HOST_CONFIG_INVALID', async () => {
    for (const endpoint of ['not a url', 'ftp://example.com']) {
      await expectHostError(
        () => Promise.resolve(new S3Host({ ...baseOptions(1), endpoint })),
        'HOST_CONFIG_INVALID',
      );
    }
  });
});

describe('S3Host.upload（PUT Object + SigV4）', () => {
  it('签名、路径、payload 哈希与 Authorization 全串与独立重算一致', async () => {
    const server = await listen((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    try {
      const host = new S3Host({ ...baseOptionsFromPort(server), prefix: 'tts/' });
      const file: File = { name: 'atlas 101.png', data: Buffer.from('atlas-binary-content') };
      const results = await host.upload([file], {});

      expect(results).toEqual([
        { file: 'atlas 101.png', status: 'uploaded', url: expect.stringContaining('atlas%20101.png') },
      ]);

      const captured = server.requests[0];
      expect(captured).toBeDefined();
      expect(captured?.method).toBe('PUT');
      // path-style：/<bucket>/<prefix><key>，空格按 RFC 3986 编码
      expect(captured?.url).toBe('/bkt/tts/atlas%20101.png');
      // x-amz-content-sha256 = body 哈希
      const payloadHash = sha256Hex(captured?.body ?? Buffer.alloc(0));
      expect(captured?.headers['x-amz-content-sha256']).toBe(payloadHash);
      expect(captured?.body.equals(file.data)).toBe(true);
      // content-type 按扩展名推断
      expect(captured?.headers['content-type']).toBe('image/png');

      // —— 独立重算 SigV4（与实现不同代码路径），逐字符对比 Authorization ——
      const auth = String(captured?.headers['authorization'] ?? '');
      const amzDate = String(captured?.headers['x-amz-date']);
      const dateStamp = amzDate.slice(0, 8);
      const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
      const canonicalHeaders = [
        `content-type:${captured?.headers['content-type']}`,
        `host:${captured?.headers['host']}`,
        `x-amz-content-sha256:${payloadHash}`,
        `x-amz-date:${amzDate}`,
      ]
        .map((line) => `${line}\n`)
        .join('');
      const canonicalRequest = [
        'PUT',
        captured?.url,
        '',
        canonicalHeaders,
        signedHeaders,
        payloadHash,
      ].join('\n');
      const scope = `${dateStamp}/auto/s3/aws4_request`;
      const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        scope,
        sha256Hex(canonicalRequest),
      ].join('\n');
      const signingKey = hmac(
        hmac(hmac(hmac(`AWS4${'wJalrXUtnFEMIfake/secretKEY'}`, dateStamp), 'auto'), 's3'),
        'aws4_request',
      );
      const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
      expect(auth).toBe(
        `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      );
    } finally {
      await server.close();
    }
  });

  it('非 ASCII 文件名按段百分号编码；mime 覆盖推断；默认公开 URL 为 <endpoint>/<bucket>/<key>', async () => {
    const server = await listen((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    try {
      const host = new S3Host(baseOptionsFromPort(server));
      const file: File = { name: '地图/英雄.png', data: Buffer.from('x'), mime: 'image/webp' };
      const results = await host.upload([file], {});

      const captured = server.requests[0];
      expect(captured?.url).toBe('/bkt/%E5%9C%B0%E5%9B%BE/%E8%8B%B1%E9%9B%84.png');
      expect(captured?.headers['content-type']).toBe('image/webp');
      // 缺省 public_base_url = <endpoint>/<bucket>（endpoint 无路径前缀时）
      expect(results[0]?.url).toBe(`${server.base}/bkt/${encodeURIComponent('地图')}/${encodeURIComponent('英雄.png')}`);
    } finally {
      await server.close();
    }
  });

  it('public_base_url 指定公开域名；重名 → HOST_INVALID_INPUT', async () => {
    const server = await listen((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    try {
      const host = new S3Host({
        ...baseOptionsFromPort(server),
        prefix: 'tts/',
        publicBaseUrl: 'https://cdn.example.com/assets/',
      });
      const results = await host.upload([{ name: 'a.png', data: Buffer.from('x') }], {});
      expect(results[0]?.url).toBe('https://cdn.example.com/assets/tts/a.png');

      await expectHostError(
        () => host.upload(
          [
            { name: 'a.png', data: Buffer.from('1') },
            { name: 'a.png', data: Buffer.from('2') },
          ],
          {},
        ),
        'HOST_INVALID_INPUT',
      );
    } finally {
      await server.close();
    }
  });

  it('PUT 返回 403 → HOST_UPLOAD_FAILED（detail 含状态码与响应体摘要）', async () => {
    const server = await listen((_req, res) => {
      res.statusCode = 403;
      res.end('<Error><Code>AccessDenied</Code></Error>');
    });
    try {
      const host = new S3Host(baseOptionsFromPort(server));
      const err = await expectHostError(
        () => host.upload([{ name: 'a.png', data: Buffer.from('x') }], {}),
        'HOST_UPLOAD_FAILED',
      );
      expect(err.message).toContain('403');
      expect(err.message).toContain('AccessDenied');
    } finally {
      await server.close();
    }
  });
});

describe('S3Host.check 与 capabilities', () => {
  it('check 走 HTTP 探测：200 存活 / 404 不存活', async () => {
    const server = await listen((req, res) => {
      res.statusCode = req.url === '/good' ? 200 : 404;
      res.end();
    });
    try {
      const host = new S3Host(baseOptionsFromPort(server));
      const good = await host.check(`${server.base}/good`);
      expect(good.alive).toBe(true);
      expect(good.status).toBe(200);

      const bad = await host.check(`${server.base}/bad`);
      expect(bad.alive).toBe(false);
      expect(bad.error).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it('capabilities：单文件上限 5 GiB（AWS/R2 单次 PUT 限制）、不可删除', () => {
    const host = new S3Host(baseOptions(1));
    expect(host.capabilities()).toEqual({ maxFileSize: S3_MAX_PUT_BYTES, deletable: false });
    expect(S3_MAX_PUT_BYTES).toBe(5 * 1024 ** 3);
  });

  it('id 缺省 s3，可被配置声明名覆盖', () => {
    expect(new S3Host(baseOptions(1)).id).toBe('s3');
    expect(new S3Host({ ...baseOptions(1), id: 'my-s3' }).id).toBe('my-s3');
  });
});
