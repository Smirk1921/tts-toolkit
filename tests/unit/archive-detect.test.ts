// tests/unit/archive-detect.test.ts
/**
 * src/archive/detect.ts 单元测试：扩展名推导三级兜底（方案设计 §12.4）。
 *
 * 背景（实测）：本机 mods.cache 36,184 条素材里 16,714 条没有扩展名——推导
 * 失败是常态。三级兜底：① URL 路径扩展名（白名单内）→ ② 本地缓存目录已有
 * 文件 → ③ HTTP Content-Type（探测函数注入，离线可测）。
 *
 * 本套用例全部离线（probe 一律注入假函数，不碰网络）：
 * - 固定扩展名类型（model / assetbundle / pdf）短路，不查缓存不联网（probe 间谍零调用）；
 * - 三级各自命中、优先级次序（URL > 缓存 > Content-Type）、全部失败进
 *   `unresolved` 且 {@link detectWarnings} 产出告警文案（§12.4：绝不静默跳过）；
 * - 缓存目录索引：命中 / 多扩展名择优 / 目录不存在安全跳过 / 命中文件路径回传；
 * - 批量：去重、并发上限、结果排序可复现、kind 越界的明确中文报错。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  detectExtension,
  detectExtensions,
  detectWarnings,
  scanCacheDir,
  type DetectOptions,
} from '../../src/archive/detect.js';
import { initI18n } from '../../src/i18n/index.js';

/** 每个用例独立的临时根目录 */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'tts-toolkit-detect-'));
  initI18n({ lang: 'zh-CN', dev: false });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** 永远返回 undefined 的假探测（模拟网络不可达 / 无 Content-Type） */
const probeNone = vi.fn(async () => undefined);

/** 基础选项：关网络（probeNone），缓存目录按用例注入 */
function baseOpts(extra: Partial<DetectOptions> = {}): DetectOptions {
  return { probe: probeNone, ...extra };
}

// ---------------------------------------------------------------------------
// 固定扩展名类型（TTS 缓存约定，与 URL 无关）
// ---------------------------------------------------------------------------

describe('固定扩展名类型直接短路', () => {
  it.each([
    ['model', 'obj'],
    ['assetbundle', 'unity3d'],
    ['pdf', 'PDF'],
  ] as const)('%s → %s（PDF 保持实测的大写约定）', async (kind, ext) => {
    const decision = await detectExtension('http://example.com/mesh.obj', kind, baseOpts());
    expect(decision.ext).toBe(ext);
    expect(decision.source).toBe('fixed');
    expect(decision.cacheFile).toBeUndefined();
    expect(probeNone).not.toHaveBeenCalled(); // 不联网
  });

  it('URL 自带扩展名也不影响固定类型（TTS 无条件追加，实测 ...MSHobj.obj）', async () => {
    const decision = await detectExtension(
      'https://raw.githubusercontent.com/DasUmlaut/TTSLibrary/master/dials/dial-12-0_00.MSH.obj',
      'model',
      baseOpts(),
    );
    expect(decision.ext).toBe('obj');
    expect(decision.source).toBe('fixed');
  });
});

// ---------------------------------------------------------------------------
// 第 1 级：URL 路径扩展名
// ---------------------------------------------------------------------------

describe('第 1 级：URL 路径扩展名（白名单内才采信）', () => {
  it.each([
    ['http://example.com/a/b.png', 'image', 'png'],
    ['http://example.com/A/B.JPG', 'image', 'jpg'],
    ['http://example.com/x.webp', 'image', 'webp'],
    ['http://example.com/sound.mp3', 'audio', 'mp3'],
    ['http://example.com/sound.OGG', 'audio', 'ogg'],
  ] as const)('%s（%s）→ %s，source=url-path', async (url, kind, ext) => {
    const decision = await detectExtension(url, kind, baseOpts());
    expect(decision.ext).toBe(ext);
    expect(decision.source).toBe('url-path');
    expect(probeNone).not.toHaveBeenCalled(); // 第 1 级命中就不联网
  });

  it('不在白名单的路径扩展名不采信（.ashx 噪声），落到第 2/3 级', async () => {
    const decision = await detectExtension('http://example.com/img.ashx', 'image', baseOpts());
    expect(decision.ext).toBeUndefined();
    expect(decision.source).toBeUndefined();
  });

  it('查询串里的 .png 不是路径扩展名（§6.8 的 "?x.y" 噪声防御）', async () => {
    const decision = await detectExtension('http://example.com/img?p=1.png', 'image', baseOpts());
    expect(decision.ext).toBeUndefined();
  });

  it('file: 本地路径的第 1 级同样适用（file:///C:/pic/t.png → png）', async () => {
    const decision = await detectExtension('file:///C:/pic/t.png', 'image', baseOpts());
    expect(decision.ext).toBe('png');
    expect(decision.source).toBe('url-path');
  });
});

// ---------------------------------------------------------------------------
// 第 2 级：本地缓存目录已有文件
// ---------------------------------------------------------------------------

describe('第 2 级：本地缓存目录已有文件（TTS 已算好名字）', () => {
  it('URL 无扩展名 + 缓存目录有 sanitize(url).jpg → jpg，source=cache-dir，回传命中文件', async () => {
    const cacheDir = path.join(tempRoot, 'Mods', 'Images');
    await mkdir(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, 'httpexamplecomface.jpg');
    await writeFile(cached, 'x');
    const decision = await detectExtension('http://example.com/face', 'image', {
      ...baseOpts(),
      cacheDirs: { image: cacheDir },
    });
    expect(decision.ext).toBe('jpg');
    expect(decision.source).toBe('cache-dir');
    expect(decision.cacheFile?.toLowerCase()).toBe(cached.toLowerCase());
  });

  it('同一 base 命中多个扩展名时按优先序择优（.tga 与 .png 并存 → png）', async () => {
    const cacheDir = path.join(tempRoot, 'cache');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, 'httpexamplecomface.tga'), 'x');
    await writeFile(path.join(cacheDir, 'httpexamplecomface.PNG'), 'x');
    const decision = await detectExtension('http://example.com/face', 'image', {
      ...baseOpts(),
      cacheDirs: { image: cacheDir },
    });
    expect(decision.ext).toBe('png');
  });

  it('大小写不敏感匹配（Windows 缓存目录语义）', async () => {
    const cacheDir = path.join(tempRoot, 'cache');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, 'HTTPEXAMPLECOMFACE.jpg'), 'x');
    const decision = await detectExtension('http://EXAMPLE.com/FACE', 'image', {
      ...baseOpts(),
      cacheDirs: { image: cacheDir },
    });
    expect(decision.ext).toBe('jpg');
  });

  it('目录不存在时安全跳过（不抛错），落到第 3 级', async () => {
    const decision = await detectExtension('http://example.com/face', 'image', {
      ...baseOpts(),
      cacheDirs: { image: path.join(tempRoot, 'no-such-dir') },
    });
    expect(decision.ext).toBeUndefined();
  });

  it('优先级：URL 路径扩展名压过缓存目录的不同扩展名', async () => {
    const cacheDir = path.join(tempRoot, 'cache');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, 'httpexamplecompic.bmp'), 'x');
    const decision = await detectExtension('http://example.com/pic.png', 'image', {
      ...baseOpts(),
      cacheDirs: { image: cacheDir },
    });
    expect(decision.ext).toBe('png');
    expect(decision.source).toBe('url-path');
  });
});

// ---------------------------------------------------------------------------
// 第 3 级：HTTP Content-Type（注入假探测）
// ---------------------------------------------------------------------------

describe('第 3 级：HTTP Content-Type（探测函数注入）', () => {
  it('Content-Type 带参数（image/png; charset=binary）→ png，source=content-type', async () => {
    const decision = await detectExtension('http://example.com/face', 'image', {
      probe: async () => 'image/png; charset=binary',
    });
    expect(decision.ext).toBe('png');
    expect(decision.source).toBe('content-type');
  });

  it('优先级：缓存目录命中压过 Content-Type', async () => {
    const cacheDir = path.join(tempRoot, 'cache');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, 'httpexamplecomface.gif'), 'x');
    const decision = await detectExtension('http://example.com/face', 'image', {
      probe: async () => 'image/png',
      cacheDirs: { image: cacheDir },
    });
    expect(decision.ext).toBe('gif');
    expect(decision.source).toBe('cache-dir');
  });

  it('未知 Content-Type 不采信（text/html 网页）→ unresolved', async () => {
    const decision = await detectExtension('http://example.com/face', 'image', {
      probe: async () => 'text/html',
    });
    expect(decision.ext).toBeUndefined();
  });

  it('探测函数抛错不向外传（单个 URL 失败不中断批量）', async () => {
    const decision = await detectExtension('http://example.com/face', 'image', {
      probe: async () => {
        throw new Error('boom');
      },
    });
    expect(decision.ext).toBeUndefined();
  });

  it('音频 Content-Type（audio/mpeg）→ mp3', async () => {
    const decision = await detectExtension('http://example.com/track', 'audio', {
      probe: async () => 'audio/mpeg',
    });
    expect(decision.ext).toBe('mp3');
    expect(decision.source).toBe('content-type');
  });
});

// ---------------------------------------------------------------------------
// 三级全部失败：告警并列出，绝不静默跳过（§12.4）
// ---------------------------------------------------------------------------

describe('三级全部失败：进 unresolved 并产出告警文案', () => {
  it('report.unresolved 列出全部失败条目（ext/source 缺省）', async () => {
    const report = await detectExtensions(
      [
        { url: 'http://example.com/noext', kind: 'image' },
        { url: 'http://example.com/ok.png', kind: 'image' },
      ],
      baseOpts(),
    );
    expect(report.decisions).toHaveLength(2);
    expect(report.unresolved.map((d) => d.url)).toEqual(['http://example.com/noext']);
  });

  it('detectWarnings：汇总行含条数，逐条列出 [类型] url；无失败时空数组', async () => {
    const report = await detectExtensions(
      [{ url: 'http://example.com/noext', kind: 'image' }],
      baseOpts(),
    );
    const warnings = detectWarnings(report);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('1');
    expect(warnings[1]).toContain('[图片]');
    expect(warnings[1]).toContain('http://example.com/noext');
    expect(detectWarnings({ decisions: [], unresolved: [] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 批量推导：去重、排序、并发、入参防御
// ---------------------------------------------------------------------------

describe('detectExtensions 批量行为', () => {
  it('按 kind|url 去重（同一 URL 被引用多次只推导一次；不同类型不去重）', async () => {
    const probe = vi.fn(async () => 'image/png');
    const report = await detectExtensions(
      [
        { url: 'http://example.com/a', kind: 'image' },
        { url: 'http://example.com/a', kind: 'image' },
        { url: 'http://example.com/a', kind: 'audio' }, // 类型不同不去重
      ],
      { probe },
    );
    expect(report.decisions).toHaveLength(2); // image|a 与 audio|a 两个去重键
    expect(probe).toHaveBeenCalledTimes(2); // 每个去重键各探测一次
  });

  it('结果排序：kind 固定次序在前、URL 码元序在后（可复现）', async () => {
    const report = await detectExtensions(
      [
        { url: 'http://z.com/a', kind: 'audio' },
        { url: 'http://a.com/b', kind: 'pdf' },
        { url: 'http://a.com/a', kind: 'pdf' },
        { url: 'http://m.com/a', kind: 'model' },
      ],
      baseOpts(),
    );
    expect(report.decisions.map((d) => `${d.kind}:${d.url}`)).toEqual([
      'model:http://m.com/a',
      'pdf:http://a.com/a',
      'pdf:http://a.com/b',
      'audio:http://z.com/a',
    ]);
  });

  it('concurrency 上限生效（同时进行的探测不超过 limit）', async () => {
    let active = 0;
    let peak = 0;
    const report = await detectExtensions(
      Array.from({ length: 20 }, (_, i) => ({ url: `http://example.com/${i}`, kind: 'image' as const })),
      {
        concurrency: 3,
        probe: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
          return undefined;
        },
      },
    );
    expect(report.decisions).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('kind 越界（运行时脏数据）抛明确中文错误而不是深层崩溃', async () => {
    await expect(
      detectExtensions([{ url: 'http://example.com/a', kind: 'bogus' as never }], baseOpts()),
    ).rejects.toThrow(/kind/);
  });

  it('cacheIndexes 预建索引与 cacheDirs 等效（不重复扫盘）', async () => {
    const cacheDir = path.join(tempRoot, 'cache');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, 'httpexamplecomface.jpg'), 'x');
    const index = await scanCacheDir(cacheDir);
    const decision = await detectExtension('http://example.com/face', 'image', {
      ...baseOpts(),
      cacheDirs: { image: cacheDir },
      cacheIndexes: [index],
    });
    expect(decision.ext).toBe('jpg');
    expect(decision.source).toBe('cache-dir');
  });
});
