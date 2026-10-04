// tests/unit/assets-fetch.test.ts
/**
 * src/assets/fetch.ts 单元测试：素材下载器与素材健康报告（方案设计 §6.4）。
 *
 * 分两层：
 * - 纯函数层（describeUrl / guessExtension / 标签函数）：表格化内联夹具，
 *   覆盖 §6.4 表格的每一行——普通 HTTP(S)、老式 Steam Cloud 域名迁移、
 *   Google Drive 分享链接转直链、Dropbox dl=0 → dl=1、paste.ee / pastebin / gist
 *   的 raw 形式、Imgur（只判活死）、file: 本地路径、www. 缺协议。
 * - 健康报告四分类（checkAssetHealth）：探测函数通过 opts.probe 注入（网络边界
 *   依赖注入），离线锁死 正常 / 可迁移 / 死链 / 需人工处理 的判定与修复动作。
 * - 网络层（默认探测 + fetchAsset）：对本测试自起的 node:http localhost 服务器
 *   实测（重定向跟随、HEAD→GET 退化、重定向循环、大小上限、404 判死），
 *   全程不访问外网；测试期间清空代理环境变量避免代理干扰。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PackError } from '../../src/pack/packyaml.js';
import {
  categoryLabel,
  checkAssetHealth,
  describeUrl,
  fetchAsset,
  fixActionLabel,
  guessExtension,
  kindLabel,
  type AssetHealthEntry,
  type ProbeOutcome,
} from '../../src/assets/fetch.js';
import { initI18n } from '../../src/i18n/index.js';

// ---------------------------------------------------------------------------
// i18n 固定中文（标签断言可复现）
// ---------------------------------------------------------------------------

beforeAll(() => {
  initI18n({ lang: 'zh-CN', dev: false });
});

// ---------------------------------------------------------------------------
// describeUrl：URL 形态识别与改写计算（纯函数）
// ---------------------------------------------------------------------------

describe('describeUrl', () => {
  it('普通 HTTP(S)：原样可下载，无改写动作', () => {
    const url = 'http://example.com/atlas/face.png';
    const desc = describeUrl(url);
    expect(desc).toMatchObject({
      url,
      kind: 'plain',
      downloadUrl: url,
      needsProtocolFix: false,
      needsDirectConversion: false,
      needsMigration: false,
    });
    expect(desc.migratedUrl).toBeUndefined();
  });

  it('www. 缺协议 → 补 https://（大小写不敏感，§6.4）', () => {
    for (const raw of ['www.example.com/x.png', 'WWW.EXAMPLE.COM/x.png']) {
      const desc = describeUrl(raw);
      expect(desc.kind).toBe('plain');
      expect(desc.needsProtocolFix).toBe(true);
      // 最小改动原则：只补前缀，其余原样保留（host 大小写交给 URL 解析层归一）
      expect(desc.downloadUrl).toBe(`https://${raw}`);
    }
  });

  it('Google Drive /view 分享链接 → uc?export=download&id=<fileId>', () => {
    const desc = describeUrl('https://drive.google.com/file/d/abcdefghij1234567890/view?usp=sharing');
    expect(desc.kind).toBe('gdrive');
    expect(desc.needsDirectConversion).toBe(true);
    expect(desc.downloadUrl).toBe('https://drive.google.com/uc?export=download&id=abcdefghij1234567890');
  });

  it('Google Drive /edit 与带查询串的 /file/d/ 同样可转', () => {
    for (const raw of [
      'https://drive.google.com/file/d/abcdefghij1234567890/edit',
      'https://drive.google.com/file/d/abcdefghij1234567890/view',
      'https://drive.google.com/file/d/abcdefghij1234567890',
      'https://docs.google.com/file/d/abcdefghij1234567890/edit',
    ]) {
      const desc = describeUrl(raw);
      expect(desc.kind).toBe('gdrive');
      expect(desc.needsDirectConversion).toBe(true);
      expect(desc.downloadUrl).toBe('https://drive.google.com/uc?export=download&id=abcdefghij1234567890');
    }
  });

  it('Google Drive /open?id= → 直链；已是 /uc?export=download 不再标记转换', () => {
    const open = describeUrl('https://drive.google.com/open?id=abcdefghij1234567890');
    expect(open.needsDirectConversion).toBe(true);
    expect(open.downloadUrl).toBe('https://drive.google.com/uc?export=download&id=abcdefghij1234567890');

    const direct = describeUrl('https://docs.google.com/uc?export=download&id=abcdefghij1234567890');
    expect(direct.kind).toBe('gdrive');
    expect(direct.needsDirectConversion).toBe(false);
    expect(direct.downloadUrl).toBe('https://drive.google.com/uc?export=download&id=abcdefghij1234567890');
  });

  it('Google Drive 文件夹等非文件链接：不可下载（归入需人工）', () => {
    const desc = describeUrl('https://drive.google.com/drive/folders/abcdefghij1234567890');
    expect(desc.kind).toBe('gdrive');
    expect(desc.downloadUrl).toBeUndefined();
  });

  it('Dropbox：dl=0 → dl=1；缺省 dl 也补 1；dl=1 / raw=1 已是直链（§6.4）', () => {
    const dl0 = describeUrl('https://www.dropbox.com/s/abc123/photo.png?dl=0&rlkey=xyz');
    expect(dl0.kind).toBe('dropbox');
    expect(dl0.needsDirectConversion).toBe(true);
    expect(dl0.downloadUrl).toBe('https://www.dropbox.com/s/abc123/photo.png?dl=1&rlkey=xyz');

    const noDl = describeUrl('https://www.dropbox.com/s/abc123/photo.png?rlkey=xyz');
    expect(noDl.needsDirectConversion).toBe(true);
    expect(noDl.downloadUrl).toBe('https://www.dropbox.com/s/abc123/photo.png?rlkey=xyz&dl=1');

    for (const raw of [
      'https://www.dropbox.com/s/abc123/photo.png?dl=1',
      'https://www.dropbox.com/s/abc123/photo.png?raw=1',
    ]) {
      const desc = describeUrl(raw);
      expect(desc.needsDirectConversion).toBe(false);
      expect(desc.downloadUrl).toBe(raw);
    }
  });

  it('paste.ee：/p/<id> → /r/<id> raw 形式；/r/ 已是 raw', () => {
    const share = describeUrl('https://paste.ee/p/abc123');
    expect(share.kind).toBe('paste');
    expect(share.needsDirectConversion).toBe(true);
    expect(share.downloadUrl).toBe('https://paste.ee/r/abc123');

    const raw = describeUrl('https://paste.ee/r/abc123');
    expect(raw.needsDirectConversion).toBe(false);
    expect(raw.downloadUrl).toBe('https://paste.ee/r/abc123');
  });

  it('pastebin：/<id> → /raw/<id>；/raw/ 已是 raw；保留路径不误转', () => {
    const share = describeUrl('https://pastebin.com/abcDEF12');
    expect(share.kind).toBe('paste');
    expect(share.needsDirectConversion).toBe(true);
    expect(share.downloadUrl).toBe('https://pastebin.com/raw/abcDEF12');

    const raw = describeUrl('https://pastebin.com/raw/abcDEF12');
    expect(raw.needsDirectConversion).toBe(false);
    expect(raw.downloadUrl).toBe('https://pastebin.com/raw/abcDEF12');

    // /u/<user> 是用户主页，不是贴文：不转、不可下载
    const profile = describeUrl('https://pastebin.com/u/someuser');
    expect(profile.kind).toBe('paste');
    expect(profile.downloadUrl).toBeUndefined();
  });

  it('gist：gist.github.com/<user>/<id> → gist.githubusercontent.com raw；raw 域已是直链', () => {
    const page = describeUrl('https://gist.github.com/someuser/abc123def456');
    expect(page.kind).toBe('paste');
    expect(page.needsDirectConversion).toBe(true);
    expect(page.downloadUrl).toBe('https://gist.githubusercontent.com/someuser/abc123def456/raw');

    // 带文件名的深层路径也归一到 raw 基地址
    const deep = describeUrl('https://gist.github.com/someuser/abc123def456/9f2c1d0e/mod.lua');
    expect(deep.downloadUrl).toBe('https://gist.githubusercontent.com/someuser/abc123def456/raw');

    const rawDomain = describeUrl('https://gist.githubusercontent.com/someuser/abc123def456/raw');
    expect(rawDomain.kind).toBe('paste');
    expect(rawDomain.needsDirectConversion).toBe(false);
  });

  it('老式 Steam Cloud：cloud-<N>.steamusercontent.com → steamusercontent-a.akamaihd.net（§6.4/§6.8）', () => {
    for (const host of ['cloud-3', 'cloud-2']) {
      const url = `http://${host}.steamusercontent.com/ugc/177123/1D79ABC/`;
      const desc = describeUrl(url);
      expect(desc.kind).toBe('steam-cloud');
      expect(desc.needsMigration).toBe(true);
      expect(desc.downloadUrl).toBe(url);
      expect(desc.migratedUrl).toBe('http://steamusercontent-a.akamaihd.net/ugc/177123/1D79ABC/');
    }
  });

  it('已是 Akamai CDN 的 steamuserimages 域名：plain，不迁移', () => {
    const desc = describeUrl('https://steamuserimages-a.akamaihd.net/ugc/123/ABC.png');
    expect(desc.kind).toBe('plain');
    expect(desc.needsMigration).toBe(false);
    expect(desc.migratedUrl).toBeUndefined();
  });

  it('Imgur：只判活死，不改写（§6.4：失败标记死链）', () => {
    for (const raw of ['https://i.imgur.com/abcd123.png', 'http://imgur.com/a/abcd123']) {
      const desc = describeUrl(raw);
      expect(desc.kind).toBe('imgur');
      expect(desc.needsDirectConversion).toBe(false);
      expect(desc.needsMigration).toBe(false);
      expect(desc.downloadUrl).toBe(raw);
    }
  });

  it('file: 本地路径：不可下载（§2.6.4 实测约 6000 处，他人加载看不到）', () => {
    for (const raw of ['file:///D:/tts/x.png', 'FILE://home/user/x.png']) {
      const desc = describeUrl(raw);
      expect(desc.kind).toBe('local-file');
      expect(desc.downloadUrl).toBeUndefined();
    }
  });

  it('{lang} 语言变体：不可下载（坑 5 的值必须原样保留）', () => {
    const desc = describeUrl('{en}http://en.png{zh-cn}http://zh.png');
    expect(desc.kind).toBe('lang-variant');
    expect(desc.downloadUrl).toBeUndefined();
  });

  it('无法识别的形态：空串 / 非 http(s) 方案 / 解析失败 → unknown', () => {
    for (const raw of ['', '   ', 'ftp://example.com/x.png', 'steam://open/123', 'not a url']) {
      const desc = describeUrl(raw);
      expect(desc.kind).toBe('unknown');
      expect(desc.downloadUrl).toBeUndefined();
    }
  });

  it('url 不是字符串 → PackError（ASSETS_FETCH_INVALID）', () => {
    const err = (() => {
      try {
        describeUrl(42 as unknown as string);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(PackError);
    expect((err as PackError).code).toBe('ASSETS_FETCH_INVALID');
  });
});

// ---------------------------------------------------------------------------
// 标签函数：分类 / 源类型 / 修复动作的面向用户文案
// ---------------------------------------------------------------------------

describe('标签函数（t() 文案）', () => {
  it('四分类与修复动作均有中文文案（不回退键名）', () => {
    expect(categoryLabel('ok')).toBe('正常');
    expect(categoryLabel('migratable')).toBe('可迁移');
    expect(categoryLabel('dead')).toBe('死链');
    expect(categoryLabel('manual')).toBe('需人工处理');

    expect(kindLabel('steam-cloud')).toBe('Steam Cloud（老域名）');
    expect(kindLabel('local-file')).toBe('本地路径（file:）');

    expect(fixActionLabel('add-protocol')).toBe('补全 https:// 协议');
    expect(fixActionLabel('migrate-domain')).toContain('steamusercontent-a.akamaihd.net');
    expect(fixActionLabel('reupload')).toBe('重新上传素材并替换 URL');
  });
});

// ---------------------------------------------------------------------------
// checkAssetHealth：四分类判定（注入探测函数，离线锁死逻辑）
// ---------------------------------------------------------------------------

/** 构造注入探测函数：按 URL 查表，未命中返回"未模拟"错误 */
function probeFromTable(outcomes: Record<string, ProbeOutcome>) {
  const table = new Map(Object.entries(outcomes));
  return vi.fn(async (url: string): Promise<ProbeOutcome> => {
    const hit = table.get(url);
    if (hit !== undefined) return hit;
    return { status: 0, error: `测试未模拟该地址：${url}` };
  });
}

const GDRIVE_SHARE = 'https://drive.google.com/file/d/abcdefghij1234567890/view';
const GDRIVE_DIRECT = 'https://drive.google.com/uc?export=download&id=abcdefghij1234567890';
const CLOUD3 = 'http://cloud-3.steamusercontent.com/ugc/177123/1D79ABC/';
const CLOUD3_MIGRATED = 'http://steamusercontent-a.akamaihd.net/ugc/177123/1D79ABC/';

describe('checkAssetHealth：四分类（注入 probe）', () => {
  it('正常：2xx 且无改写动作', async () => {
    const probe = probeFromTable({ 'http://a.example.com/x.png': { status: 200 } });
    const report = await checkAssetHealth(['http://a.example.com/x.png'], { probe });
    expect(report).toMatchObject({ total: 1, ok: 1, migratable: 0, dead: 0, manual: 0 });
    expect(report.entries[0]).toMatchObject({ category: 'ok', kind: 'plain', fixActions: [], status: 200 });
    expect(report.entries[0].fixedUrl).toBeUndefined();
  });

  it('可迁移：缺协议 / 需转直链 / Steam Cloud 可迁移，各自给出 fixedUrl 与动作', async () => {
    const probe = probeFromTable({
      'https://www.b.example.com/y.png': { status: 200 },
      [GDRIVE_DIRECT]: { status: 200, contentType: 'image/png' },
      [CLOUD3]: { status: 200, contentType: 'image/png' },
    });
    const report = await checkAssetHealth(
      ['www.b.example.com/y.png', GDRIVE_SHARE, CLOUD3],
      { probe },
    );
    expect(report.ok).toBe(0);
    expect(report.migratable).toBe(3);

    const byUrl = new Map(report.entries.map((e) => [e.url, e]));
    const protocol = byUrl.get('www.b.example.com/y.png')!;
    expect(protocol.fixActions).toEqual(['add-protocol']);
    expect(protocol.fixedUrl).toBe('https://www.b.example.com/y.png');

    const gdrive = byUrl.get(GDRIVE_SHARE)!;
    expect(gdrive.fixActions).toEqual(['convert-direct']);
    expect(gdrive.fixedUrl).toBe(GDRIVE_DIRECT);

    const cloud = byUrl.get(CLOUD3)!;
    expect(cloud.fixActions).toEqual(['migrate-domain']);
    expect(cloud.fixedUrl).toBe(CLOUD3_MIGRATED);
    expect(cloud.status).toBe(200);
  });

  it('死链：非 2xx → dead + reupload，状态码与中文死因入 detail', async () => {
    const probe = probeFromTable({ 'http://dead.example.com/x.png': { status: 404 } });
    const report = await checkAssetHealth(['http://dead.example.com/x.png'], { probe });
    expect(report.dead).toBe(1);
    const entry = report.entries[0];
    expect(entry.category).toBe('dead');
    expect(entry.fixActions).toEqual(['reupload']);
    expect(entry.status).toBe(404);
    expect(entry.detail).toBe('HTTP 状态码 404（非 2xx）');
    expect(entry.fixedUrl).toBeUndefined();
  });

  it('死链但有迁移退路：原地址死、Akamai 活 → 可迁移，detail 说明死因', async () => {
    const probe = probeFromTable({
      [CLOUD3]: { status: 404 },
      [CLOUD3_MIGRATED]: { status: 200, contentType: 'image/png' },
    });
    const report = await checkAssetHealth([CLOUD3], { probe });
    expect(report.migratable).toBe(1);
    expect(report.dead).toBe(0);
    const entry = report.entries[0]!;
    expect(entry.category).toBe('migratable');
    expect(entry.fixActions).toEqual(['migrate-domain']);
    expect(entry.fixedUrl).toBe(CLOUD3_MIGRATED);
    expect(entry.detail).toBe('原地址已失效（HTTP 状态码 404（非 2xx）），但迁移到 Akamai 域名后可用，建议改写');
  });

  it('两头都死：dead，死因取更有信息量的一侧（迁移目标响应）', async () => {
    const probe = probeFromTable({
      [CLOUD3]: { status: 404 },
      [CLOUD3_MIGRATED]: { status: 410 },
    });
    const report = await checkAssetHealth([CLOUD3], { probe });
    expect(report.dead).toBe(1);
    expect(report.entries[0]).toMatchObject({ category: 'dead', status: 410, fixActions: ['reupload'] });
  });

  it('Google Drive 大文件确认页（2xx + text/html）→ 需人工处理', async () => {
    const probe = probeFromTable({ [GDRIVE_DIRECT]: { status: 200, contentType: 'text/html; charset=utf-8' } });
    const report = await checkAssetHealth([GDRIVE_SHARE], { probe });
    expect(report.manual).toBe(1);
    const entry = report.entries[0]!;
    expect(entry.category).toBe('manual');
    expect(entry.fixActions).toEqual(['convert-direct', 'manual-review']);
    expect(entry.detail).toBe('Google Drive 返回的是网页而非文件（可能是大文件病毒扫描确认页），需人工处理');
  });

  it('需人工：file: → reupload；{lang} 与未知形态 → manual-review；均不发起探测', async () => {
    const probe = probeFromTable({});
    const report = await checkAssetHealth(
      ['file:///D:/tts/x.png', '{en}http://en.png', 'ftp://example.com/x.bin'],
      { probe },
    );
    expect(report.manual).toBe(3);
    expect(probe).not.toHaveBeenCalled();
    // entries 按码元序：'file:…' < 'ftp:…' < '{en}…'
    const kinds = report.entries.map((e) => e.kind);
    expect(kinds).toEqual(['local-file', 'unknown', 'lang-variant']);
    const fixes = report.entries.map((e) => e.fixActions);
    expect(fixes).toEqual([['reupload'], ['manual-review'], ['manual-review']]);
    expect(report.entries.every((e) => e.status === undefined)).toBe(true);
  });

  it('探测拿到错误描述（网络层失败）→ dead，detail 用错误文案', async () => {
    const probe = probeFromTable({ 'http://dns.example.com/x.png': { status: 0, error: '域名解析失败' } });
    const report = await checkAssetHealth(['http://dns.example.com/x.png'], { probe });
    expect(report.dead).toBe(1);
    expect(report.entries[0]).toMatchObject({ category: 'dead', status: 0, detail: '域名解析失败' });
  });

  it('输入去重：同一 URL 只探测一次、只产出一条记录', async () => {
    const probe = probeFromTable({ 'http://a.example.com/x.png': { status: 200 } });
    const report = await checkAssetHealth(
      ['http://a.example.com/x.png', 'http://a.example.com/x.png'],
      { probe },
    );
    expect(report.total).toBe(1);
    expect(report.entries).toHaveLength(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('entries 按 URL 字典序升序（输出可复现）', async () => {
    const probe = probeFromTable({
      'http://b.example.com/1.png': { status: 200 },
      'http://a.example.com/2.png': { status: 404 },
    });
    const report = await checkAssetHealth(
      ['http://b.example.com/1.png', 'http://a.example.com/2.png'],
      { probe },
    );
    expect(report.entries.map((e) => e.url)).toEqual([
      'http://a.example.com/2.png',
      'http://b.example.com/1.png',
    ]);
  });

  it('空输入：全零报告，不调用 probe', async () => {
    const probe = probeFromTable({});
    const report = await checkAssetHealth([], { probe });
    expect(report).toEqual({ total: 0, ok: 0, migratable: 0, dead: 0, manual: 0, entries: [] });
    expect(probe).not.toHaveBeenCalled();
  });

  it('入参非法 → PackError（ASSETS_FETCH_INVALID）', async () => {
    await expect(checkAssetHealth('http://x' as unknown as string[])).rejects.toBeInstanceOf(PackError);
    await expect(
      checkAssetHealth(['http://x'], { concurrency: 0 }),
    ).rejects.toMatchObject({ code: 'ASSETS_FETCH_INVALID' });
    await expect(
      checkAssetHealth(['http://x'], { probe: 'not a function' as unknown as () => Promise<ProbeOutcome> }),
    ).rejects.toMatchObject({ code: 'ASSETS_FETCH_INVALID' });
  });
});

// ---------------------------------------------------------------------------
// 网络层：本测试自起 localhost 服务器（不访问外网；清空代理环境变量）
// ---------------------------------------------------------------------------

/** 极小 PNG 头字节（内容不重要，只要字节可比对） */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let server: Server;
let baseUrl: string;

/** 原始代理环境变量（测试后恢复） */
let savedProxy: { https_proxy?: string; HTTPS_PROXY?: string };

beforeAll(async () => {
  savedProxy = {
    https_proxy: process.env.https_proxy,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
  };
  delete process.env.https_proxy;
  delete process.env.HTTPS_PROXY;

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    switch (pathname) {
      case '/ok.png':
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG_BYTES);
        break;
      case '/missing':
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        break;
      case '/head-fallback':
        // HEAD 不支持（405）→ 默认探测退化 GET 应拿到 200
        if (req.method === 'HEAD') {
          res.writeHead(405);
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('hello');
        }
        break;
      case '/redirect':
        res.writeHead(302, { location: '/ok.png' });
        res.end();
        break;
      case '/redirect-loop':
        res.writeHead(302, { location: '/redirect-loop' });
        res.end();
        break;
      case '/html':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body>interstitial</body></html>');
        break;
      case '/small.bin':
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.alloc(16, 7));
        break;
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (savedProxy.https_proxy !== undefined) process.env.https_proxy = savedProxy.https_proxy;
  if (savedProxy.HTTPS_PROXY !== undefined) process.env.HTTPS_PROXY = savedProxy.HTTPS_PROXY;
});

describe('checkAssetHealth：默认探测（localhost 实测）', () => {
  it('2xx → ok；404 → dead（状态码记录）', async () => {
    const report = await checkAssetHealth([`${baseUrl}/ok.png`, `${baseUrl}/missing`]);
    expect(report.ok).toBe(1);
    expect(report.dead).toBe(1);
    const byUrl = new Map(report.entries.map((e) => [e.url, e]));
    expect(byUrl.get(`${baseUrl}/ok.png`)).toMatchObject({ category: 'ok', status: 200, fixActions: [] });
    expect(byUrl.get(`${baseUrl}/missing`)).toMatchObject({ category: 'dead', status: 404 });
  });

  it('3xx 重定向被手动跟随：/redirect → /ok.png 判活', async () => {
    const report = await checkAssetHealth([`${baseUrl}/redirect`]);
    expect(report.ok).toBe(1);
    expect(report.entries[0]!.status).toBe(200);
  });

  it('HEAD 不支持（405）→ 退化 GET 重试：/head-fallback 判活', async () => {
    const report = await checkAssetHealth([`${baseUrl}/head-fallback`]);
    expect(report.ok).toBe(1);
    expect(report.entries[0]!.status).toBe(200);
  });

  it('重定向循环：默认上限 5 跳后判死，detail 指向重定向上限', async () => {
    const report = await checkAssetHealth([`${baseUrl}/redirect-loop`]);
    expect(report.dead).toBe(1);
    const entry: AssetHealthEntry = report.entries[0]!;
    expect(entry.status).toBe(0);
    expect(entry.detail).toBe('重定向次数超过上限（5）');
  });
});

describe('fetchAsset（localhost 实测）', () => {
  it('2xx：字节 / Content-Type / 最终 URL', async () => {
    const outcome = await fetchAsset(`${baseUrl}/ok.png`);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(Buffer.from(outcome.data).equals(PNG_BYTES)).toBe(true);
      expect(outcome.contentType).toBe('image/png');
      expect(outcome.status).toBe(200);
      expect(outcome.finalUrl).toBe(`${baseUrl}/ok.png`);
    }
  });

  it('404 → ok:false + status', async () => {
    const outcome = await fetchAsset(`${baseUrl}/missing`);
    expect(outcome).toMatchObject({ ok: false, status: 404 });
    if (!outcome.ok) expect(outcome.error).toBe('HTTP 状态码 404（非 2xx）');
  });

  it('重定向：/redirect → 落到 /ok.png 的字节与 finalUrl', async () => {
    const outcome = await fetchAsset(`${baseUrl}/redirect`);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.finalUrl).toBe(`${baseUrl}/ok.png`);
      expect(Buffer.from(outcome.data).equals(PNG_BYTES)).toBe(true);
    }
  });

  it('重定向循环 → ok:false + 重定向上限文案', async () => {
    const outcome = await fetchAsset(`${baseUrl}/redirect-loop`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('重定向次数超过上限（5）');
  });

  it('maxBytes：响应体超限 → ok:false + 超限文案', async () => {
    const outcome = await fetchAsset(`${baseUrl}/small.bin`, { maxBytes: 8 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('响应体超过大小上限（8 字节）');
  });

  it('file: / 未知方案 → ok:false + 需人工文案（不发起网络请求）', async () => {
    const local = await fetchAsset('file:///D:/tts/x.png');
    expect(local.ok).toBe(false);
    if (!local.ok) expect(local.error).toBe('file: 本地路径指向原作者的机器，无法下载，他人加载会看不到该素材，需重新上传');

    const ftp = await fetchAsset('ftp://example.com/x.bin');
    expect(ftp.ok).toBe(false);
    if (!ftp.ok) expect(ftp.error).toBe('无法识别的 URL 形态，工具不做自动处理');
  });

  it('入参非法 → PackError（ASSETS_FETCH_INVALID）', async () => {
    await expect(fetchAsset('' as string)).rejects.toBeInstanceOf(PackError);
    await expect(fetchAsset(123 as unknown as string)).rejects.toMatchObject({
      code: 'ASSETS_FETCH_INVALID',
    });
    await expect(fetchAsset(`${baseUrl}/ok.png`, { maxBytes: 0 })).rejects.toMatchObject({
      code: 'ASSETS_FETCH_INVALID',
    });
  });
});

// ---------------------------------------------------------------------------
// guessExtension：扩展名推断（§6.8 缓存文件名的前置）
// ---------------------------------------------------------------------------

describe('guessExtension', () => {
  it('URL 路径扩展名优先（须在白名单内；大小写归一）', () => {
    expect(guessExtension('http://a.example.com/x.PNG')).toBe('png');
    expect(guessExtension('http://a.example.com/x.jpg')).toBe('jpg');
    expect(guessExtension('http://a.example.com/models/x.obj')).toBe('obj');
  });

  it('路径扩展名不在白名单 → 回退 Content-Type；映射表覆盖常见类型', () => {
    expect(guessExtension('http://a.example.com/x.foo', 'image/png')).toBe('png');
    expect(guessExtension('http://a.example.com/x', 'image/jpeg; charset=binary')).toBe('jpg');
    expect(guessExtension('http://a.example.com/x', 'application/pdf')).toBe('pdf');
    expect(guessExtension('http://a.example.com/x', 'application/octet-stream')).toBeUndefined();
    expect(guessExtension('http://a.example.com/x', 'text/plain; charset=utf-8')).toBe('txt');
  });

  it('URL 解析失败也走 Content-Type；两者都无线索 → undefined', () => {
    expect(guessExtension('not a url', 'image/webp')).toBe('webp');
    expect(guessExtension('http://a.example.com/x')).toBeUndefined();
    expect(guessExtension('http://a.example.com/x', undefined)).toBeUndefined();
  });

  it('url 不是字符串 → PackError', () => {
    expect(() => guessExtension(1 as unknown as string)).toThrowError(PackError);
  });
});
