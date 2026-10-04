// tests/unit/assets-migrate.test.ts
/**
 * src/assets/migrate.ts 单元测试：图床迁移 / 死链修复 + 离线缓存预置。
 *
 * 覆盖：
 * - collectSaveUrls / applyUrlMigration：**遍历一律复用 deck/patch.ts 的 walkSaveUrls**
 *   （本套测试用含全部容器键与素材字段的存档夹具锁死这一点：改写必须原地生效、
 *   {lang} 语言变体永不触碰（红线）、file: 只计数不改写）；
 * - cacheFileName：§6.8 规则——URL 去掉所有非字母数字字符 + 扩展名；
 * - presetOfflineCache：写入 `<modsDir>/Images/`，data 直供（纯离线）与注入 fetchFn
 *   两条路径；文件名按传入 URL 原文计算；扩展名无线索时拒绝猜测；单条失败不中断整批；
 * - 默认 fetchFn（fetchAsset）对 localhost 服务器实测一次真实下载落盘。
 */
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyUrlMigration,
  cacheFileName,
  collectSaveUrls,
  presetOfflineCache,
  TTS_IMAGES_DIRNAME,
  type PresetEntry,
  type PresetFetcher,
} from '../../src/assets/migrate.js';
import { PackError } from '../../src/pack/packyaml.js';
import { initI18n } from '../../src/i18n/index.js';

// ---------------------------------------------------------------------------
// i18n 固定中文
// ---------------------------------------------------------------------------

beforeAll(() => {
  initI18n({ lang: 'zh-CN', dev: false });
});

// ---------------------------------------------------------------------------
// 存档夹具（容器键四种 + 素材容器全覆盖，形状与 deck-patch.test.ts 同源）
// ---------------------------------------------------------------------------

interface Fixture {
  root: Record<string, unknown>;
  deckSpec: Record<string, unknown>;
  imageSpec: Record<string, unknown>;
  childSpec: Record<string, unknown>;
  stateSpec: Record<string, unknown>;
}

const FACE = 'http://example.com/atlas/face.png';
const BACK = 'http://example.com/atlas/back.png';
const IMG_URL = 'https://i.imgur.com/abcd123.png';
const IMG_SECONDARY = 'file:///D:/tts/local.png';
const CHILD_MESH = 'https://drive.google.com/file/d/abcdefghij1234567890/view';
const STATE_SKY = 'https://steamuserimages-a.akamaihd.net/ugc/123/ABC.png';
const LANG_VALUE = '{en}http://en.example.com/a.png{zh-cn}http://zh.example.com/a.png';

/**
 * 构造标准夹具：牌堆（CustomDeck + ContainedObjects）+ 贴图（含 file: 副本 URL）+
 * 独立对象（CustomImage.ImageURL + {lang} 变体的 SkyURL）+ 顶层 SkyURL（同一 URL 复用）。
 */
function makeFixture(): Fixture {
  const deckSpec: Record<string, unknown> = { FaceURL: FACE, BackURL: BACK, NumWidth: 10, NumHeight: 7 };
  const imageSpec: Record<string, unknown> = { ImageURL: IMG_URL, ImageSecondaryURL: IMG_SECONDARY };
  const childSpec: Record<string, unknown> = {
    GUID: 'cc22dd',
    Name: 'Custom_Tile',
    CustomMesh: { MeshURL: CHILD_MESH, DiffuseURL: '' },
  };
  const stateSpec: Record<string, unknown> = {
    GUID: 'ee44ff',
    Name: 'Custom_Image',
    CustomImage: { ImageURL: STATE_SKY },
    // 语言变体：遍历器默认跳过，迁移永不触碰（坑 5 / 红线）
    Description: LANG_VALUE,
    SkyURL: LANG_VALUE,
  };
  const deck = {
    GUID: 'aa11bb',
    Name: 'Deck',
    CustomDeck: { '1': deckSpec },
    ContainedObjects: [childSpec],
  };
  const root: Record<string, unknown> = {
    ObjectStates: [deck, { GUID: 'bb22cc', Name: 'Custom_Image', CustomImage: imageSpec }, stateSpec],
    SkyURL: STATE_SKY,
  };
  return { root, deckSpec, imageSpec, childSpec, stateSpec };
}

// ---------------------------------------------------------------------------
// collectSaveUrls：只读盘点（走 walkSaveUrls）
// ---------------------------------------------------------------------------

describe('collectSaveUrls', () => {
  it('盘点全部 URL：去重 + 码元序升序 + file: 计数；{lang} 变体不计入', () => {
    const { root } = makeFixture();
    const inv = collectSaveUrls(root);
    // 访问数：Face/Back + Image/ImageSecondary(file:) + Mesh + State.Image + Sky 顶层
    //         = 2 + 2 + 1 + 1 + 1 = 7（{lang} 两处被跳过，不计）
    expect(inv.visited).toBe(7);
    expect(inv.localFiles).toBe(1);
    expect(inv.urls).toEqual([
      BACK,
      CHILD_MESH,
      FACE,
      IMG_SECONDARY,
      IMG_URL,
      STATE_SKY,
    ].sort());
    expect(inv.urls).not.toContain(LANG_VALUE);
  });

  it('空存档 / 无 ObjectStates：0 访问 0 URL（合法）', () => {
    expect(collectSaveUrls({})).toEqual({ visited: 0, urls: [], localFiles: 0 });
  });

  it('root 不是普通对象 → PackError（ASSETS_MIGRATE_INVALID）', async () => {
    for (const bad of [null, undefined, 42, 'save', [], true]) {
      await expect(
        Promise.resolve().then(() => collectSaveUrls(bad)),
      ).rejects.toMatchObject({ code: 'ASSETS_MIGRATE_INVALID' });
    }
  });
});

// ---------------------------------------------------------------------------
// applyUrlMigration：批量改写（走 walkSaveUrls，原地写回）
// ---------------------------------------------------------------------------

describe('applyUrlMigration', () => {
  it('按映射原地改写：同一对象引用被变更、changes 记录精确位置', () => {
    const fx = makeFixture();
    const newFace = 'http://steamusercontent-a.akamaihd.net/ugc/999/NEW/';
    const result = applyUrlMigration(
      fx.root,
      new Map([
        [FACE, newFace],
        [CHILD_MESH, 'https://drive.google.com/uc?export=download&id=abcdefghij1234567890'],
      ]),
    );

    // 原地写回（同一 spec 对象引用，不是深拷贝产物）
    expect(fx.deckSpec.FaceURL).toBe(newFace);
    expect(fx.deckSpec.BackURL).toBe(BACK); // 未命中的字段不动
    expect(fx.childSpec.CustomMesh && (fx.childSpec.CustomMesh as Record<string, unknown>).MeshURL).toBe(
      'https://drive.google.com/uc?export=download&id=abcdefghij1234567890',
    );

    expect(result.visited).toBe(7);
    expect(result.rewritten).toBe(2);
    expect(result.localFiles).toBe(1);
    expect(result.changes).toHaveLength(2);

    const faceChange = result.changes.find((c) => c.from === FACE)!;
    expect(faceChange).toMatchObject({
      objectPath: 'ObjectStates[0]',
      guid: 'aa11bb',
      fieldPath: ['CustomDeck', 'FaceURL'],
      to: newFace,
    });
    const meshChange = result.changes.find((c) => c.from === CHILD_MESH)!;
    expect(meshChange).toMatchObject({
      objectPath: 'ObjectStates[0].ContainedObjects[0]',
      guid: 'cc22dd',
      fieldPath: ['CustomMesh', 'MeshURL'],
    });
  });

  it('同一 URL 多处引用：逐处改写、逐处记录（素材容器 + 顶层直接字段）', () => {
    const fx = makeFixture();
    const newSky = 'https://cdn.example.com/sky.png';
    const result = applyUrlMigration(fx.root, new Map([[STATE_SKY, newSky]]));
    // ObjectStates[2].CustomImage.ImageURL + 顶层 SkyURL
    expect(result.rewritten).toBe(2);
    const stateImage = fx.stateSpec.CustomImage as Record<string, unknown>;
    expect(stateImage.ImageURL).toBe(newSky);
    expect(fx.root.SkyURL).toBe(newSky);
    expect(result.changes.map((c) => c.objectPath).sort()).toEqual(['', 'ObjectStates[2]']);
    expect(result.changes.map((c) => c.fieldPath).map((f) => f.join('.'))).toEqual(
      expect.arrayContaining(['CustomImage.ImageURL', 'SkyURL']),
    );
  });

  it('{lang} 语言变体永不改写（红线）：即使映射表包含完整变体串', () => {
    const fx = makeFixture();
    const result = applyUrlMigration(fx.root, new Map([[LANG_VALUE, 'http://replaced.example.com/x.png']]));
    // 语言变体不进入遍历 → 不改写、不计 visited（stateSpec.SkyURL 是 {lang} 值）
    expect(result.rewritten).toBe(0);
    expect(fx.stateSpec.SkyURL).toBe(LANG_VALUE);
    expect(result.changes).toHaveLength(0);
  });

  it('file: 原文可被显式映射改写（§4.6.1 fix-local 流程）；localFiles 计数不受影响', () => {
    const fx = makeFixture();
    const result = applyUrlMigration(fx.root, { [IMG_SECONDARY]: 'http://x.example.com/secondary.png' });
    expect(result.rewritten).toBe(1);
    expect(result.localFiles).toBe(1);
    expect(fx.imageSpec.ImageSecondaryURL).toBe('http://x.example.com/secondary.png');
    expect(result.changes[0]).toMatchObject({
      objectPath: 'ObjectStates[1]',
      fieldPath: ['CustomImage', 'ImageSecondaryURL'],
    });

    const result2 = applyUrlMigration(
      fx.root,
      new Map([[IMG_URL, 'http://x.example.com/primary.png']]),
    );
    expect(result2.rewritten).toBe(1);
    expect(fx.imageSpec.ImageURL).toBe('http://x.example.com/primary.png');
  });

  it('from === to 的映射忽略；空映射只盘点不改写', () => {
    const fx = makeFixture();
    const result = applyUrlMigration(fx.root, new Map([[FACE, FACE]]));
    expect(result.rewritten).toBe(0);
    expect(result.changes).toHaveLength(0);
    expect(result.visited).toBe(7);

    const result2 = applyUrlMigration(fx.root, new Map());
    expect(result2).toMatchObject({ visited: 7, rewritten: 0, localFiles: 1 });
  });

  it('非法入参 → PackError（ASSETS_MIGRATE_INVALID）：root / 映射形态 / 映射值', () => {
    const fx = makeFixture();
    // root 非对象
    expect(() => applyUrlMigration(null, new Map())).toThrowError(PackError);
    expect(() => applyUrlMigration([1, 2], new Map())).toThrowError(PackError);
    // 映射既不是 Map 也不是普通对象
    expect(() => applyUrlMigration(fx.root, 'http://x' as unknown as Map<string, string>)).toThrowError(
      PackError,
    );
    // 值为空串
    expect(() => applyUrlMigration(fx.root, new Map([[FACE, '']]))).toThrowError(PackError);
    // 键为空串
    expect(() => applyUrlMigration(fx.root, new Map([['', FACE]]))).toThrowError(PackError);
    // 值非字符串
    expect(() => applyUrlMigration(fx.root, { [FACE]: 42 as unknown as string })).toThrowError(PackError);
  });
});

// ---------------------------------------------------------------------------
// cacheFileName：§6.8 缓存文件名规则
// ---------------------------------------------------------------------------

describe('cacheFileName', () => {
  it('URL 去掉所有非字母数字字符 + 扩展名（保留大小写与数字，§6.8 样例形态）', () => {
    expect(cacheFileName('http://cloud-3.steamusercontent.com/ugc/177123/1D79ABC/', 'png')).toBe(
      'httpcloud3steamusercontentcomugc1771231D79ABC.png',
    );
  });

  it('ext 带前导点等价；空 ext 不追加扩展名', () => {
    expect(cacheFileName('http://a.example.com/x.png', '.png')).toBe(
      cacheFileName('http://a.example.com/x.png', 'png'),
    );
    expect(cacheFileName('http://a.example.com/x.png', '')).toBe('httpaexamplecomxpng');
  });

  it('非 ASCII 字符同样剥去（只保留 [A-Za-z0-9]）', () => {
    expect(cacheFileName('http://例え.com/a.png', 'png')).toBe('httpcomapng.png');
  });

  it('产出天然文件名安全（无路径分隔符 / 空白 / 点）', () => {
    const name = cacheFileName('https://a.b/c\\d e/f?g=1&h=2#i', 'jpg');
    expect(name).toMatch(/^[A-Za-z0-9]+\.jpg$/);
  });

  it('非法入参 → PackError（ASSETS_MIGRATE_INVALID）：url 剥空 / 非字符串', () => {
    expect(() => cacheFileName(':///', 'png')).toThrowError(PackError);
    expect(() => cacheFileName('http://x', 1 as unknown as string)).toThrowError(PackError);
    expect(() => cacheFileName(undefined as unknown as string, 'png')).toThrowError(PackError);
  });
});

// ---------------------------------------------------------------------------
// presetOfflineCache：离线预置到 <modsDir>/Images/
// ---------------------------------------------------------------------------

/** 每条用例独立的临时 Mods 目录 */
let modsRoot: string;

beforeAll(async () => {
  modsRoot = await mkdtemp(path.join(tmpdir(), 'tts-migrate-'));
});

afterAll(async () => {
  await rm(modsRoot, { recursive: true, force: true });
});

/** 建一个空 Mods 目录 */
async function makeModsDir(name: string): Promise<string> {
  const dir = path.join(modsRoot, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

const BYTES_A = new Uint8Array([1, 2, 3, 4]);
const BYTES_B = new Uint8Array([9, 8, 7]);

describe('presetOfflineCache：data 直供（纯离线路径）', () => {
  it('写入 <modsDir>/Images/<cacheFileName>：目录自动创建、字节与内容一致', async () => {
    const modsDir = await makeModsDir('direct');
    const url = 'http://cloud-3.steamusercontent.com/ugc/177123/1D79ABC/';
    const result = await presetOfflineCache({
      modsDir: path.join(modsDir, 'deep', 'nested'), // 深层不存在：recursive mkdir
      entries: [{ url, data: BYTES_A, ext: 'png' }],
    });

    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.written).toHaveLength(1);
    const written = result.written[0]!;
    expect(written.url).toBe(url);
    expect(written.bytes).toBe(BYTES_A.byteLength);
    expect(written.file).toBe(
      path.join(modsDir, 'deep', 'nested', TTS_IMAGES_DIRNAME, cacheFileName(url, 'png')),
    );
    await expect(readFile(written.file)).resolves.toEqual(Buffer.from(BYTES_A));
    await expect(stat(path.join(modsDir, 'deep', 'nested', TTS_IMAGES_DIRNAME))).resolves.toBeTruthy();
  });

  it('ext 缺省时按 URL 路径推断；同名文件覆盖为最新字节', async () => {
    const modsDir = await makeModsDir('ext-and-overwrite');
    const url = 'https://steamuserimages-a.akamaihd.net/ugc/123/ABC.png';
    const target = path.join(modsDir, TTS_IMAGES_DIRNAME, cacheFileName(url, 'png'));

    const first = await presetOfflineCache({ modsDir, entries: [{ url, data: BYTES_A }] });
    expect(first.written[0]!.file).toBe(target);
    await expect(readFile(target)).resolves.toEqual(Buffer.from(BYTES_A));

    const second = await presetOfflineCache({ modsDir, entries: [{ url, data: BYTES_B }] });
    expect(second.failed).toEqual([]);
    await expect(readFile(target)).resolves.toEqual(Buffer.from(BYTES_B));
  });

  it('不可下载形态 → skipped（file: / {lang}），不给任何写入', async () => {
    const modsDir = await makeModsDir('skipped');
    const result = await presetOfflineCache({
      modsDir,
      entries: [
        { url: 'file:///D:/tts/x.png', data: BYTES_A, ext: 'png' },
        { url: '{en}http://en.png', data: BYTES_A, ext: 'png' },
      ],
    });
    expect(result.written).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]!.reason).toBe('file: 本地路径指向原作者的机器，无法下载，他人加载会看不到该素材，需重新上传');
    expect(result.skipped[1]!.reason).toBe('语言变体 URL（值内含语言分段）不做自动处理，请人工确认');
  });

  it('扩展名无线索（URL 无扩展名 + data 直供无 Content-Type）→ failed，拒绝猜测', async () => {
    const modsDir = await makeModsDir('no-ext');
    const url = 'https://cdn.example.com/assets/abc123';
    const result = await presetOfflineCache({ modsDir, entries: [{ url, data: BYTES_A }] });
    expect(result.written).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.url).toBe(url);
    expect(result.failed[0]!.reason).toBe('无法确定文件扩展名（URL 路径与 Content-Type 都未提供线索），请用 ext 显式指定');
  });
});

describe('presetOfflineCache：注入 fetchFn（下载路径）', () => {
  it('按 downloadUrl 下载（分享链接自动转直链）、按 Content-Type 定扩展名', async () => {
    const modsDir = await makeModsDir('fetcher');
    const shareUrl = 'https://www.dropbox.com/s/abc123/photo?dl=0';
    const directUrl = 'https://www.dropbox.com/s/abc123/photo?dl=1';

    // fetchFn 收到的是"转直链后"的地址；返回的 Content-Type 决定扩展名
    const fetchFn: PresetFetcher = async (url) => {
      expect(url).toBe(directUrl);
      return {
        ok: true,
        url: directUrl,
        finalUrl: directUrl,
        status: 200,
        contentType: 'image/jpeg',
        data: BYTES_A,
      };
    };

    const result = await presetOfflineCache({ modsDir, entries: [{ url: shareUrl }], fetchFn });
    expect(result.failed).toEqual([]);
    expect(result.written).toHaveLength(1);
    const written = result.written[0]!;
    // 文件名按**传入 URL 原文**计算（TTS 按存档中的 URL 查缓存，见模块头注释）
    expect(path.basename(written.file)).toBe(cacheFileName(shareUrl, 'jpg'));
    expect(path.basename(written.file)).not.toBe(cacheFileName(directUrl, 'jpg'));
  });

  it('下载失败 → failed + 中文原因，后续条目继续（单条失败不中断整批）', async () => {
    const modsDir = await makeModsDir('fetch-fail');
    const bad = 'https://dead.example.com/a.png';
    const good = 'https://alive.example.com/b.png';
    const fetchFn: PresetFetcher = async (url) => {
      if (url === bad) return { ok: false, url: bad, status: 404, error: 'HTTP 状态码 404（非 2xx）' };
      return { ok: true, url, finalUrl: url, status: 200, contentType: 'image/png', data: BYTES_B };
    };
    const result = await presetOfflineCache({ modsDir, entries: [{ url: bad }, { url: good }], fetchFn });
    expect(result.failed).toEqual([{ url: bad, reason: 'HTTP 状态码 404（非 2xx）' }]);
    expect(result.written).toHaveLength(1);
    expect(result.written[0]!.url).toBe(good);
  });
});

describe('presetOfflineCache：默认 fetchFn（localhost 实测，同 assets-fetch 的服务器模式）', () => {
  it('真实下载 → 落盘字节一致', async () => {
    const { createServer } = await import('node:http');
    type HttpServer = Awaited<ReturnType<typeof createServer>>;
    let server: HttpServer | undefined;
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    try {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(payload);
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const port = (server!.address() as { port: number }).port;

      const modsDir = await makeModsDir('live-fetch');
      const result = await presetOfflineCache({
        modsDir,
        entries: [{ url: `http://127.0.0.1:${port}/ok.png` } as PresetEntry],
      });
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.written).toHaveLength(1);
      await expect(readFile(result.written[0]!.file)).resolves.toEqual(payload);
    } finally {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });
});

describe('presetOfflineCache：入参校验', () => {
  it('非法入参 → PackError（ASSETS_PRESET_INVALID）', async () => {
    const modsDir = await makeModsDir('invalid');
    await expect(presetOfflineCache({ modsDir: '', entries: [{ url: 'http://x', data: BYTES_A, ext: 'png' }] })).rejects.toMatchObject(
      { code: 'ASSETS_PRESET_INVALID' },
    );
    await expect(presetOfflineCache({ modsDir, entries: [] })).rejects.toMatchObject({ code: 'ASSETS_PRESET_INVALID' });
    await expect(
      presetOfflineCache({ modsDir, entries: [{ data: BYTES_A } as unknown as PresetEntry] }),
    ).rejects.toMatchObject({ code: 'ASSETS_PRESET_INVALID' });
    await expect(
      presetOfflineCache({ modsDir, entries: [{ url: 'http://x', data: 'nope' as unknown as Uint8Array, ext: 'png' }] }),
    ).rejects.toMatchObject({ code: 'ASSETS_PRESET_INVALID' });
    await expect(
      presetOfflineCache({ modsDir, entries: [{ url: 'http://x', data: BYTES_A, ext: 'png' }], fetchFn: 'x' as unknown as PresetFetcher }),
    ).rejects.toMatchObject({ code: 'ASSETS_PRESET_INVALID' });
  });

  it('modsDir 是文件（不可创建目录）→ PackError（ASSETS_PRESET_WRITE_FAILED）', async () => {
    const filePath = path.join(modsRoot, 'not-a-dir');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, 'x');
    await expect(
      presetOfflineCache({ modsDir: filePath, entries: [{ url: 'http://x', data: BYTES_A, ext: 'png' }] }),
    ).rejects.toMatchObject({ code: 'ASSETS_PRESET_WRITE_FAILED' });
  });
});
