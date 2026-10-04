// tests/unit/archive-ttsmod.test.ts
/**
 * src/archive/ttsmod.ts 单元测试：`.ttsmod` 读写（ZIP + Zip64）往返。
 *
 * 往返目标（施工流程 3B 组）：
 * - **正向**：本工具产出的 `.ttsmod` 能被第三方 ZIP 读取器读取——用本机 pwsh
 *   调 .NET `System.IO.Compression.ZipFile`（与 TTS Mod Vault 同族解析器）实测；
 * - **反向**：用本工具导入 `D:\工具\TTS\research\` 下 3 个真实 `.ttsmod` 样本
 *   （仓库内参考资料副本，md5 一致）全部成功；样本字节经 readZip 解压后与
 *   预先解包的 `research\x\` 目录逐字节一致。
 *
 * 覆盖面：
 * - ZIP 编解码：store/deflate 往返、非 ASCII 条目名（UTF-8 标志位）、确定性输出、
 *   Zip64（forceZip64 走 EOCD64 + locator + 0x0001 extra 全路径）、损坏输入报错；
 * - 命名约定：`<图包名> (<工坊ID>).ttsmod`、非法字符 `_`、`Save_` 前缀；
 * - 导出：条目布局（Mods/Workshop、Thumbnails、Images/Models/Assetbundles/PDF/Audio）、
 *   存档 JSON 逐字节保真（URL 一个字不改）、saves 落点（3B.6）、manifest（3B.4）、
 *   双语 README（3B.9）、缺素材跳过+列出 / --strict 报错不产出（3B.8）、同名条目去重；
 * - 导入：Mods 前缀条目 → Mods 父目录、其余 → ModSaveLocation、已存在不覆盖、
 *   zip-slip 防护、manifest 回读。
 *
 * 全程离线：扩展名推导第 3 级的探测函数一律注入假实现，绝不联网。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheFileName, sanitizeUrl } from '../../src/archive/cachekey.js';
import { exportTtsmod, importTtsmod, readZip, ttsmodFileName, writeZip } from '../../src/archive/ttsmod.js';
import { PackError } from '../../src/pack/packyaml.js';
import { initI18n } from '../../src/i18n/index.js';

const execFileP = promisify(execFile);

/**
 * 真实夹具（仓库外参考资料 `D:\工具\TTS\research\` 的副本，md5 一致，见夹具 README）
 * 与其预先解包的目录（research\x\）：
 * - s_dial.ttsmod：51 条目（Mods/Images ×1 + Mods/Models ×48 + Workshop json + 缩略图）；
 * - s_hex.ttsmod：4 条目（工坊存档是 .cjc 后缀）；
 * - sample_diceset.ttsmod：13 条目（Mods/Models ×11 + Workshop json + 缩略图）。
 */
const FIXTURE_DIR = 'D:/Codex/TTS图包制作维护工具/参考资料/测试夹具';
const EXTRACTED_DIR = 'D:/工具/TTS/research/x';

/** 每个用例独立的临时根目录 */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'tts-toolkit-ttsmod-'));
  initI18n({ lang: 'zh-CN', dev: false });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** 永远返回 undefined 的假探测（模拟无网络；防止单测触碰真实 HTTP） */
const probeNone = vi.fn(async () => undefined);

/** 固定创建时间（确定性输出断言用） */
const FIXED_TIME = new Date('2026-01-02T03:04:05.000Z');

// ---------------------------------------------------------------------------
// ZIP 编解码
// ---------------------------------------------------------------------------

describe('writeZip / readZip 往返', () => {
  it('多条目往返：可压缩（deflate）与不可压缩（store）数据都逐字节还原', () => {
    const zip = writeZip([
      { name: 'Mods/Workshop/379104394.json', data: Buffer.from('{"SaveName":"Custom Dice Set"}') },
      { name: 'Mods/Images/big.png', data: Buffer.alloc(4096, 0x5a) }, // 高度可压缩 → deflate
      { name: 'Mods/Workshop/Thumbnails/t.png', data: Buffer.from([0x89, 0x50]) }, // 极小 → store
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([
      'Mods/Workshop/379104394.json',
      'Mods/Images/big.png',
      'Mods/Workshop/Thumbnails/t.png',
    ]);
    expect(Buffer.from(entries[0]!.data).toString()).toBe('{"SaveName":"Custom Dice Set"}');
    expect(Buffer.compare(Buffer.from(entries[1]!.data), Buffer.alloc(4096, 0x5a))).toBe(0);
    expect([...entries[2]!.data]).toEqual([0x89, 0x50]);
  });

  it('非 ASCII 条目名（UTF-8 标志位）往返不乱码', () => {
    const zip = writeZip([{ name: 'Saves/测试图包.json', data: Buffer.from('x') }]);
    expect(readZip(zip)[0]!.name).toBe('Saves/测试图包.json');
  });

  it('反斜杠条目名写出时归一为正斜杠（旧工具风格防御）', () => {
    const zip = writeZip([{ name: 'Mods\\Images\\a.png', data: Buffer.from('x') }]);
    expect(readZip(zip)[0]!.name).toBe('Mods/Images/a.png');
  });

  it('确定性：同样输入（默认固定时间戳）产出逐字节相同的 ZIP', () => {
    const entries = [
      { name: 'Mods/Workshop/1.json', data: Buffer.from('a') },
      { name: 'Mods/Images/2.png', data: Buffer.alloc(100, 1) },
    ];
    expect(Buffer.compare(writeZip(entries), writeZip(entries))).toBe(0);
  });

  it('forceZip64：Zip64 EOCD + locator 全路径往返（小文件也能走 Zip64）', () => {
    const zip = writeZip(
      [
        { name: 'Mods/Workshop/1.json', data: Buffer.from('a') },
        { name: 'Mods/Images/2.png', data: Buffer.alloc(100, 1) },
      ],
      { forceZip64: true },
    );
    // 倒数 22 字节是常规 EOCD，其前 20 字节是 Zip64 EOCD locator
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt32LE(zip.length - 42)).toBe(0x07064b50);
    const entries = readZip(zip);
    expect(entries).toHaveLength(2);
    expect(Buffer.from(entries[1]!.data)).toEqual(Buffer.alloc(100, 1));
  });

  it('非法入参：空条目名抛错（调用方编程错误）', () => {
    expect(() => writeZip([{ name: '', data: Buffer.alloc(0) }])).toThrow(/条目名/);
  });

  it('损坏输入：无 EOCD / 条目越界 → PackError code=TTSMOD_INVALID', () => {
    expect(() => readZip(Buffer.from('this is not a zip file at all............'))).toThrowError(
      expect.objectContaining({ code: 'TTSMOD_INVALID' }) as Error,
    );
    // 有 EOCD 魔数但中心目录偏移越界
    const fake = Buffer.alloc(22);
    fake.writeUInt32LE(0x06054b50, 0);
    fake.writeUInt16LE(1, 10); // 1 个条目
    fake.writeUInt32LE(999999, 16); // cd offset 越界
    expect(() => readZip(fake)).toThrowError(expect.objectContaining({ code: 'TTSMOD_INVALID' }) as Error);
  });
});

// ---------------------------------------------------------------------------
// .NET 互操作（TTS Mod Vault 同族解析器的本机代理验证）
// ---------------------------------------------------------------------------

describe('正向互操作：本工具产物可被 .NET ZipFile 读取（pwsh）', () => {
  /** 用 pwsh 调 .NET ZipFile 列出条目并读第一个条目内容 */
  async function readWithDotNet(file: string): Promise<{ count: number; first: string; names: string[] }> {
    const psPath = file.replace(/'/g, "''");
    const script =
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
      `$z = [System.IO.Compression.ZipFile]::OpenRead('${psPath}'); ` +
      '$count = $z.Entries.Count; ' +
      "$names = ($z.Entries | ForEach-Object { $_.FullName }) -join '|'; " +
      '$r = New-Object System.IO.StreamReader($z.Entries[0].Open()); $content = $r.ReadToEnd(); $r.Close(); $z.Dispose(); ' +
      'Write-Output $count; Write-Output $names; Write-Output $content';
    const { stdout } = await execFileP('pwsh', ['-NoProfile', '-Command', script]);
    const lines = stdout.split('\n').map((l) => l.replace(/\r$/, ''));
    const count = Number(lines[0]);
    const names = lines[1] === '' ? [] : lines[1]!.split('|');
    const first = lines.slice(2).join('\n').replace(/\n$/, '');
    return { count, names, first };
  }

  it('常规导出与 forceZip64 产物都能被 .NET 打开，条目名与内容一致', async () => {
    const out = path.join(tempRoot, 'netcheck.ttsmod');
    await exportTtsmod({
      outPath: out,
      packName: 'Net Check',
      workshopId: 1234567,
      saveJson: '{"SaveName":"NetCheck"}',
      assets: [
        { url: 'http://example.com/mesh', kind: 'model', data: Buffer.alloc(2048, 7) },
        { url: 'http://example.com/face.png', kind: 'image', data: Buffer.from('png-bytes') },
      ],
      probe: probeNone,
      readme: 'none',
      manifest: false,
      createdAt: FIXED_TIME,
    });
    const normal = await readWithDotNet(out);
    expect(normal.count).toBe(3); // 存档 json + 2 素材
    expect(normal.names).toContain('Mods/Models/httpexamplecommesh.obj');
    expect(normal.first).toBe('{"SaveName":"NetCheck"}');

    const zip64Out = path.join(tempRoot, 'netcheck-zip64.ttsmod');
    const zip64File = writeZip(
      [{ name: 'Mods/Workshop/7.json', data: Buffer.from('zip64-content') }],
      { forceZip64: true },
    );
    await writeFile(zip64Out, zip64File);
    const forced = await readWithDotNet(zip64Out);
    expect(forced.count).toBe(1);
    expect(forced.names).toEqual(['Mods/Workshop/7.json']);
    expect(forced.first).toBe('zip64-content');
  });
});

// ---------------------------------------------------------------------------
// 反向互操作：读取 3 个真实 .ttsmod 样本
// ---------------------------------------------------------------------------

describe('反向互操作：readZip 读取 3 个真实样本', () => {
  const samples = [
    { file: 's_dial.ttsmod', count: 51, workshopJson: 'Mods/Workshop/882532068.json' },
    { file: 's_hex.ttsmod', count: 4, workshopJson: 'Mods/Workshop/333845772.cjc' },
    { file: 'sample_diceset.ttsmod', count: 13, workshopJson: 'Mods/Workshop/379104394.json' },
  ] as const;

  it.each(samples)('$file：$count 条目、工坊存档与缩略图齐全', async ({ file, count, workshopJson }) => {
    const zip = readZip(await readFile(path.join(FIXTURE_DIR, file)));
    expect(zip).toHaveLength(count);
    expect(zip.some((e) => e.name === workshopJson)).toBe(true);
    const thumbnail = workshopJson.replace('.json', '.png').replace('.cjc', '.png');
    expect(zip.some((e) => e.name === `Mods/Workshop/Thumbnails/${path.basename(thumbnail)}`)).toBe(true);
    expect(zip.every((e) => e.name.startsWith('Mods/'))).toBe(true);
  });

  it('sample_diceset：解压字节与预先解包的 research\\x\\ 目录逐字节一致（JSON 与 store 的 PNG）', async () => {
    // research\x\ 是 sample_diceset.ttsmod 的预先解包目录（379104394）
    const zip = readZip(await readFile(path.join(FIXTURE_DIR, 'sample_diceset.ttsmod')));
    const jsonEntry = zip.find((e) => e.name === 'Mods/Workshop/379104394.json')!;
    const pngEntry = zip.find((e) => e.name === 'Mods/Workshop/Thumbnails/379104394.png')!;
    const jsonOnDisk = await readFile(path.join(EXTRACTED_DIR, 'Mods', 'Workshop', '379104394.json'));
    const pngOnDisk = await readFile(path.join(EXTRACTED_DIR, 'Mods', 'Workshop', 'Thumbnails', '379104394.png'));
    expect(Buffer.compare(Buffer.from(jsonEntry.data), jsonOnDisk)).toBe(0);
    expect(Buffer.compare(Buffer.from(pngEntry.data), pngOnDisk)).toBe(0);
    // 素材（deflate 压缩的 .obj）同样逐字节一致
    const objEntry = zip.find((e) => e.name === 'Mods/Models/httppastebincomrawphpirkZ3Fkt7.obj')!;
    const objOnDisk = await readFile(path.join(EXTRACTED_DIR, 'Mods', 'Models', 'httppastebincomrawphpirkZ3Fkt7.obj'));
    expect(Buffer.compare(Buffer.from(objEntry.data), objOnDisk)).toBe(0);
  });

  it('样本条目名 = sanitize(url) + 固定扩展名（模型 .obj 无条件追加）', async () => {
    const zip = readZip(await readFile(path.join(FIXTURE_DIR, 's_dial.ttsmod')));
    // URL 以 .obj 结尾，TTS 仍无条件再追加 .obj（实测条目 ...MSHobj.obj）
    expect(zip.some((e) => e.name === `Mods/Models/${cacheFileName('https://raw.githubusercontent.com/DasUmlaut/TTSLibrary/master/dials/dial-12-0_00.MSH.obj', 'obj')}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 命名约定
// ---------------------------------------------------------------------------

describe('ttsmodFileName 命名约定', () => {
  it('<图包名> (<工坊ID>).ttsmod（与真实样本命名一致）', () => {
    expect(ttsmodFileName('Custom Dice Set', 379104394)).toBe('Custom Dice Set (379104394).ttsmod');
  });

  it('工坊 ID 为 null 时不带 ID 段（未发布图包）', () => {
    expect(ttsmodFileName('My Pack', null)).toBe('My Pack.ttsmod');
  });

  it('存档备份加 Save_ 前缀（原工具约定）', () => {
    expect(ttsmodFileName('My Pack', 1234567, { save: true })).toBe('Save_My Pack (1234567).ttsmod');
  });

  it('非法文件名字符替换 _、结尾点空格剥掉（Windows 约定）', () => {
    expect(ttsmodFileName('a<b>c:d"e/f\\g|h?i*j', 1)).toBe('a_b_c_d_e_f_g_h_i_j (1).ttsmod');
    expect(ttsmodFileName('trailing dots...', 1)).toBe('trailing dots (1).ttsmod');
  });
});

// ---------------------------------------------------------------------------
// 导出：exportTtsmod
// ---------------------------------------------------------------------------

describe('exportTtsmod 条目布局与保真', () => {
  it('标准工坊模组：Mods/Workshop/<id>.json + Thumbnails + 五类素材条目', async () => {
    const out = path.join(tempRoot, 'Test Pack (1234567).ttsmod');
    const result = await exportTtsmod({
      outPath: out,
      packName: 'Test Pack',
      workshopId: 1234567,
      saveJson: '{"SaveName":"Test","ObjectStates":[{"CustomDeck":{"1":{"FaceURL":"http://example.com/face.jpg"}}}]}',
      thumbnail: Buffer.from('thumb-png'),
      assets: [
        { url: 'http://example.com/face.jpg', kind: 'image', data: Buffer.from('img') },
        { url: 'http://example.com/mesh', kind: 'model', data: Buffer.from('mesh') },
        { url: 'http://example.com/bundle', kind: 'assetbundle', data: Buffer.from('bundle') },
        { url: 'http://example.com/doc', kind: 'pdf', data: Buffer.from('pdf') },
        { url: 'http://example.com/sound.mp3', kind: 'audio', data: Buffer.from('audio') },
      ],
      probe: probeNone,
      createdAt: FIXED_TIME,
    });

    const zip = readZip(await readFile(out));
    const names = zip.map((e) => e.name);
    expect(names).toContain('Mods/Workshop/1234567.json');
    expect(names).toContain('Mods/Workshop/Thumbnails/1234567.png');
    expect(names).toContain('Mods/Images/httpexamplecomfacejpg.jpg');
    expect(names).toContain('Mods/Models/httpexamplecommesh.obj');
    expect(names).toContain('Mods/Assetbundles/httpexamplecombundle.unity3d');
    expect(names).toContain('Mods/PDF/httpexamplecomdoc.PDF');
    expect(names).toContain('Mods/Audio/httpexamplecomsoundmp3.mp3');
    expect(result.entryCount).toBe(9); // 存档 + 缩略图 + 5 素材 + manifest + README
    expect(result.included).toHaveLength(5);
    expect(result.skipped).toHaveLength(0);

    // 自包含的全部原理：存档 JSON 逐字节原样，URL 一个字不改
    const savedJson = zip.find((e) => e.name === 'Mods/Workshop/1234567.json')!;
    expect(Buffer.from(savedJson.data).toString()).toBe(
      '{"SaveName":"Test","ObjectStates":[{"CustomDeck":{"1":{"FaceURL":"http://example.com/face.jpg"}}}]}',
    );
  });

  it('存档落点 saves 模式（3B.6）：JSON 进 Saves/ 而非 Mods/Workshop/（原工具怪癖修正）', async () => {
    const out = path.join(tempRoot, 'save.ttsmod');
    const result = await exportTtsmod({
      outPath: out,
      packName: 'My Save',
      saveJson: '{"SaveName":"My Save"}',
      saveJsonTarget: 'saves',
      readme: 'none',
      manifest: false,
      probe: probeNone,
    });
    const names = readZip(await readFile(out)).map((e) => e.name);
    expect(names).toEqual(['Saves/My Save.json']);
    expect(result.entryCount).toBe(1);
  });

  it('工坊 ID 为 null 时存档 JSON 用净化图包名命名', async () => {
    const out = path.join(tempRoot, 'unpublished.ttsmod');
    await exportTtsmod({
      outPath: out,
      packName: '未发布包',
      saveJson: '{}',
      readme: 'none',
      manifest: false,
      probe: probeNone,
    });
    const names = readZip(await readFile(out)).map((e) => e.name);
    expect(names).toContain('Mods/Workshop/未发布包.json');
  });
});

describe('exportTtsmod 素材字节来源与扩展名三级兜底', () => {
  it('data 直传 + URL 扩展名（source=url-path）', async () => {
    const out = path.join(tempRoot, 'a.ttsmod');
    const result = await exportTtsmod({
      outPath: out,
      packName: 'A',
      saveJson: '{}',
      readme: 'none',
      manifest: false,
      probe: probeNone,
      assets: [{ url: 'http://example.com/pic.PNG', kind: 'image', data: Buffer.from('x') }],
    });
    expect(result.included[0]).toMatchObject({
      entry: 'Mods/Images/httpexamplecompicPNG.png', // URL 的 ".PNG" 点被 sanitize 去掉，扩展名取自推导
      ext: 'png',
      extSource: 'url-path',
    });
  });

  it('localPath 文件读取（URL 无扩展名时扩展名可来自缓存目录）', async () => {
    const meshFile = path.join(tempRoot, 'source', 'models', 'mesh.obj');
    await mkdir(path.dirname(meshFile), { recursive: true });
    await writeFile(meshFile, 'mesh-bytes');
    const out = path.join(tempRoot, 'b.ttsmod');
    const result = await exportTtsmod({
      outPath: out,
      packName: 'B',
      saveJson: '{}',
      readme: 'none',
      manifest: false,
      probe: probeNone,
      assets: [{ url: 'http://example.com/mesh', kind: 'model', localPath: meshFile }],
    });
    expect(result.included).toHaveLength(1);
    const zip = readZip(await readFile(out));
    expect(Buffer.from(zip.find((e) => e.name === 'Mods/Models/httpexamplecommesh.obj')!.data).toString()).toBe('mesh-bytes');
  });

  it('缓存目录兜底：URL 无扩展名 + 缓存有 sanitize(url).jpg → 扩展名与字节都来自缓存', async () => {
    const cacheDir = path.join(tempRoot, 'Mods', 'Images');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, 'httpexamplecomface.jpg'), 'cached-jpg-bytes');
    const out = path.join(tempRoot, 'c.ttsmod');
    const result = await exportTtsmod({
      outPath: out,
      packName: 'C',
      saveJson: '{}',
      readme: 'none',
      manifest: false,
      probe: probeNone,
      cacheDirs: { image: cacheDir },
      assets: [{ url: 'http://example.com/face', kind: 'image' }],
    });
    expect(result.included[0]).toMatchObject({ ext: 'jpg', extSource: 'cache-dir' });
    const zip = readZip(await readFile(out));
    expect(Buffer.from(zip.find((e) => e.name === 'Mods/Images/httpexamplecomface.jpg')!.data).toString()).toBe('cached-jpg-bytes');
  });

  it('Content-Type 兜底（注入探测）：URL 与缓存都无扩展名时 source=content-type', async () => {
    const out = path.join(tempRoot, 'd.ttsmod');
    const result = await exportTtsmod({
      outPath: out,
      packName: 'D',
      saveJson: '{}',
      readme: 'none',
      manifest: false,
      probe: async () => 'image/webp',
      assets: [{ url: 'http://example.com/pic', kind: 'image', data: Buffer.from('x') }],
    });
    expect(result.included[0]).toMatchObject({ ext: 'webp', extSource: 'content-type' });
    expect(result.included[0]!.entry).toBe('Mods/Images/httpexamplecompic.webp');
  });
});

describe('exportTtsmod 缺素材策略（3B.8）与条目去重', () => {
  it('默认：缺失素材跳过并逐条列出（onWarn 与返回值一致），不抛错', async () => {
    const out = path.join(tempRoot, 'e.ttsmod');
    const onWarn = vi.fn();
    const result = await exportTtsmod({
      outPath: out,
      packName: 'E',
      saveJson: '{}',
      probe: probeNone,
      readme: 'none',
      manifest: false,
      onWarn,
      assets: [
        { url: 'http://example.com/gone.png', kind: 'image' }, // 缺文件（有 URL 扩展名）
        { url: 'http://example.com/noext', kind: 'image', data: Buffer.from('x') }, // 三级全失败
        { url: 'http://example.com/ok.png', kind: 'image', data: Buffer.from('ok') },
      ],
    });
    expect(result.skipped).toEqual([
      { url: 'http://example.com/gone.png', kind: 'image', reason: 'missing-file' },
      { url: 'http://example.com/noext', kind: 'image', reason: 'unresolved-ext' },
    ]);
    expect(result.included.map((i) => i.url)).toEqual(['http://example.com/ok.png']);
    expect(result.warnings).toHaveLength(3); // 汇总 1 + 逐条 2
    expect(onWarn).toHaveBeenCalledTimes(3);
    expect(result.warnings[0]).toContain('2');
    expect(result.warnings[1]).toContain('缺少本地文件');
    expect(result.warnings[2]).toContain('扩展名推导失败');
    expect(result.warnings.slice(1).join('\n')).toBe(result.warnings.join('\n').split('\n').slice(1).join('\n'));
    expect(existsSync(out)).toBe(true); // 非 strict 照常产出
  });

  it('strict：缺任一素材即抛 PackError（code=TTSMOD_STRICT_MISSING），不产出文件', async () => {
    const out = path.join(tempRoot, 'f.ttsmod');
    const promise = exportTtsmod({
      outPath: out,
      packName: 'F',
      saveJson: '{}',
      probe: probeNone,
      readme: 'none',
      strict: true,
      assets: [{ url: 'http://example.com/gone.png', kind: 'image' }],
    });
    await expect(promise).rejects.toThrowError(expect.objectContaining({ code: 'TTSMOD_STRICT_MISSING' }) as Error);
    await promise.catch((err: Error) => {
      expect(err.message).toContain('http://example.com/gone.png');
    });
    expect(existsSync(out)).toBe(false);
  });

  it('不同 URL 撞同一缓存键时同名条目去重（保留首条）并列告警', async () => {
    const out = path.join(tempRoot, 'g.ttsmod');
    const result = await exportTtsmod({
      outPath: out,
      packName: 'G',
      saveJson: '{}',
      probe: probeNone,
      readme: 'none',
      manifest: false,
      assets: [
        { url: 'http://a.com/x.png', kind: 'image', data: Buffer.from('first') },
        { url: 'http://a-com/x.png', kind: 'image', data: Buffer.from('second') }, // sanitize 同为 httpacomxpng
      ],
    });
    expect(result.included).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('Mods/Images/httpacomxpng.png'))).toBe(true);
    const zip = readZip(await readFile(out));
    expect(zip.filter((e) => e.name === 'Mods/Images/httpacomxpng.png')).toHaveLength(1);
    expect(Buffer.from(zip.find((e) => e.name === 'Mods/Images/httpacomxpng.png')!.data).toString()).toBe('first');
  });

  it('同输入同 createdAt 两次导出逐字节一致（可复现）；重复导出覆盖旧文件', async () => {
    const opts = {
      packName: 'Repro',
      workshopId: 42,
      saveJson: '{"a":1}',
      probe: probeNone,
      readme: 'none' as const,
      manifest: false,
      createdAt: FIXED_TIME,
      assets: [{ url: 'http://example.com/x.png', kind: 'image' as const, data: Buffer.from('x') }],
    };
    const first = await exportTtsmod({ ...opts, outPath: path.join(tempRoot, 'h1.ttsmod') });
    const second = await exportTtsmod({ ...opts, outPath: path.join(tempRoot, 'h2.ttsmod') });
    const bytes1 = await readFile(first.outPath);
    const bytes2 = await readFile(second.outPath);
    expect(Buffer.compare(bytes1, bytes2)).toBe(0);
    // 覆盖导出（同路径再写一次）
    const again = await exportTtsmod({ ...opts, outPath: first.outPath });
    expect(again.outPath).toBe(first.outPath);
  });
});

describe('exportTtsmod manifest（3B.4）与 README（3B.9）', () => {
  it('manifest 默认生成：工具名/版本/时间/工坊 ID/素材清单（含缺失素材的 status）', async () => {
    const out = path.join(tempRoot, 'i.ttsmod');
    const result = await exportTtsmod({
      outPath: out,
      packName: 'M Pack',
      workshopId: 777,
      sourceModId: 555,
      packVersion: '1.2.0',
      saveJson: '{}',
      probe: probeNone,
      readme: 'none',
      createdAt: FIXED_TIME,
      assets: [
        { url: 'http://example.com/ok.png', kind: 'image', data: Buffer.from('x') },
        { url: 'http://example.com/gone.png', kind: 'image' },
      ],
    });
    expect(result.manifestIncluded).toBe(true);
    expect(result.manifest).toMatchObject({
      manifest_version: 1,
      tool: { name: 'tts-toolkit', version: '0.1.0' },
      created_at: FIXED_TIME.toISOString(),
      pack: { name: 'M Pack', version: '1.2.0', workshop_id: 777, source_mod_id: 555, save_json_target: 'workshop' },
    });
    expect(result.manifest!.assets).toEqual([
      expect.objectContaining({
        url: 'http://example.com/ok.png',
        status: 'included',
        entry: 'Mods/Images/httpexamplecomokpng.png',
        ext: 'png',
        ext_source: 'url-path',
      }),
      expect.objectContaining({ url: 'http://example.com/gone.png', status: 'missing-file' }),
    ]);
    // manifest 条目在包内可读回
    const zip = readZip(await readFile(out));
    const manifestEntry = zip.find((e) => e.name === 'manifest.json')!;
    expect(JSON.parse(Buffer.from(manifestEntry.data).toString('utf8'))).toMatchObject({ manifest_version: 1 });
  });

  it('manifest: false 时不写 manifest 条目，旧布局不受影响', async () => {
    const out = path.join(tempRoot, 'j.ttsmod');
    const result = await exportTtsmod({
      outPath: out,
      packName: 'J',
      saveJson: '{}',
      probe: probeNone,
      readme: 'none',
      manifest: false,
    });
    expect(result.manifestIncluded).toBe(false);
    expect(result.manifest).toBeUndefined();
    expect(readZip(await readFile(out)).some((e) => e.name === 'manifest.json')).toBe(false);
  });

  it('readme 默认 both：单个双语 README.txt，中英段落都写清解压目标是 Mods 父目录', async () => {
    const out = path.join(tempRoot, 'k.ttsmod');
    const result = await exportTtsmod({
      outPath: out,
      packName: 'K Pack',
      workshopId: 9,
      saveJson: '{}',
      probe: probeNone,
      manifest: false,
      assets: [{ url: 'http://example.com/ok.png', kind: 'image', data: Buffer.from('x') }],
    });
    expect(result.readmeEntries).toEqual(['README.txt']);
    const zip = readZip(await readFile(out));
    const readme = Buffer.from(zip.find((e) => e.name === 'README.txt')!.data).toString('utf8');
    expect(readme).toContain('—— 中文说明 ——');
    expect(readme).toContain('—— English ——');
    expect(readme).toContain('K Pack');
    expect(readme).toContain('Mods 目录的父目录');
    expect(readme).toContain('PARENT directory of the Mods folder');
    expect(readme).toContain('图片素材 1 条');
    expect(readme).toContain('1 image asset(s)');
    expect(readme).toContain('TTS Mod Vault');
  });

  it.each([
    ['zh', 'README-zh-CN.txt', '中文说明', 'Mods 目录的父目录'],
    ['en', 'README-en-US.txt', 'English', 'PARENT directory of the Mods folder'],
  ] as const)('readme: %s → 只生成 %s，且写清解压目标', async (mode, entryName, marker, target) => {
    const out = path.join(tempRoot, `l-${mode}.ttsmod`);
    const result = await exportTtsmod({
      outPath: out,
      packName: 'L',
      saveJson: '{}',
      probe: probeNone,
      manifest: false,
      readme: mode,
    });
    expect(result.readmeEntries).toEqual([entryName]);
    const zip = readZip(await readFile(out));
    const readme = Buffer.from(zip.find((e) => e.name === entryName)!.data).toString('utf8');
    expect(readme).toContain(marker);
    expect(readme).toContain(target);
  });
});

// ---------------------------------------------------------------------------
// 导入：importTtsmod
// ---------------------------------------------------------------------------

describe('importTtsmod：3 个真实样本全部导入成功（反向往返）', () => {
  const samples = [
    { file: 's_dial.ttsmod', files: 51, workshopJson: 'Mods/Workshop/882532068.json' },
    { file: 's_hex.ttsmod', files: 4, workshopJson: 'Mods/Workshop/333845772.cjc' },
    { file: 'sample_diceset.ttsmod', files: 13, workshopJson: 'Mods/Workshop/379104394.json' },
  ] as const;

  it.each(samples)('$file：$files 个文件全部落地，不覆盖、manifest 如实缺省', async ({ file, files, workshopJson }) => {
    const modsParent = path.join(tempRoot, 'tts-root');
    const saves = path.join(tempRoot, 'save-location');
    const result = await importTtsmod(path.join(FIXTURE_DIR, file), { modsParentDir: modsParent, modSaveLocation: saves });
    expect(result.totalEntries).toBe(files);
    expect(result.extracted).toBe(files);
    expect(result.skippedExisting).toHaveLength(0);
    expect(result.skippedUnsafe).toHaveLength(0);
    // 工坊存档条目（.json）被报告；.cjc 工坊存档不算 .json
    expect(result.workshopSaves).toEqual(
      workshopJson.endsWith('.json') ? [path.join(path.resolve(modsParent), ...workshopJson.split('/'))] : [],
    );
    // 落地文件真实存在
    expect(existsSync(path.join(modsParent, ...workshopJson.split('/')))).toBe(true);
    expect(result.manifest).toBeUndefined(); // 真实样本没有 manifest
    expect(result.warnings).toHaveLength(0);

    // 二次导入：已存在的文件一律不覆盖（原工具 DoNotOverwrite 语义），逐条列出
    const again = await importTtsmod(path.join(FIXTURE_DIR, file), { modsParentDir: modsParent, modSaveLocation: saves });
    expect(again.extracted).toBe(0);
    expect(again.skippedExisting).toHaveLength(files);
    expect(again.warnings.length).toBe(files + 1); // 汇总 1 + 逐条 files
  });
});

describe('importTtsmod 条目路由与安全', () => {
  it('Mods/ 前缀条目 → Mods 父目录；其余（Saves/）→ ModSaveLocation', async () => {
    const out = path.join(tempRoot, 'routed.ttsmod');
    await writeFile(
      out,
      writeZip([
        { name: 'Mods/Images/httpexamplecomapng.png', data: Buffer.from('mod-asset') },
        { name: 'Mods/Workshop/42.json', data: Buffer.from('{}') },
        { name: 'Saves/My Save.json', data: Buffer.from('save-data') },
      ]),
    );
    const modsParent = path.join(tempRoot, 'root-a');
    const saves = path.join(tempRoot, 'root-b');
    const result = await importTtsmod(out, { modsParentDir: modsParent, modSaveLocation: saves });
    expect(result.extracted).toBe(3);
    expect(
      await readFile(path.join(modsParent, 'Mods', 'Images', 'httpexamplecomapng.png'), 'utf8'),
    ).toBe('mod-asset');
    expect(await readFile(path.join(saves, 'Saves', 'My Save.json'), 'utf8')).toBe('save-data');
    expect(result.workshopSaves).toEqual([path.join(path.resolve(modsParent), 'Mods', 'Workshop', '42.json')]);
  });

  it('zip-slip 防护：.. 段 / 绝对路径 / 盘符条目一律跳过并列出，绝不写出目标之外', async () => {
    const out = path.join(tempRoot, 'evil.ttsmod');
    await writeFile(
      out,
      writeZip([
        { name: '../evil.txt', data: Buffer.from('x') },
        { name: '/abs.txt', data: Buffer.from('x') },
        { name: 'C:/win.ini', data: Buffer.from('x') },
        { name: 'Mods/../evil2.txt', data: Buffer.from('x') },
        { name: 'Mods/Workshop/ok.json', data: Buffer.from('{}') },
      ]),
    );
    const modsParent = path.join(tempRoot, 'root');
    const result = await importTtsmod(out, { modsParentDir: modsParent, modSaveLocation: path.join(tempRoot, 'saves') });
    expect(result.skippedUnsafe).toEqual(['../evil.txt', '/abs.txt', 'C:/win.ini', 'Mods/../evil2.txt']);
    expect(result.extracted).toBe(1);
    // 逃逸目标一个都不存在
    expect(existsSync(path.join(tempRoot, 'evil.txt'))).toBe(false);
    expect(existsSync(path.join(tempRoot, 'root', 'evil2.txt'))).toBe(false);
  });

  it('导出 → 导入往返：manifest 回读、条目全部落地', async () => {
    const out = path.join(tempRoot, 'round.ttsmod');
    await exportTtsmod({
      outPath: out,
      packName: 'Round Trip',
      workshopId: 31415926,
      saveJson: '{"SaveName":"RoundTrip"}',
      probe: probeNone,
      createdAt: FIXED_TIME,
      assets: [{ url: 'http://example.com/face.jpg', kind: 'image', data: Buffer.from('face-bytes') }],
    });
    const modsParent = path.join(tempRoot, 'root');
    const result = await importTtsmod(out, { modsParentDir: modsParent, modSaveLocation: path.join(tempRoot, 'saves') });
    expect(result.manifest).toMatchObject({ manifest_version: 1, pack: { name: 'Round Trip', workshop_id: 31415926 } });
    expect(result.workshopSaves).toHaveLength(1);
    expect(
      await readFile(path.join(modsParent, 'Mods', 'Images', 'httpexamplecomfacejpg.jpg'), 'utf8'),
    ).toBe('face-bytes');
  });

  it('错误路径：不是 ZIP / 文件不存在 → PackError code=TTSMOD_INVALID（按码断言，不依赖文案）', async () => {
    const garbage = path.join(tempRoot, 'garbage.ttsmod');
    await writeFile(garbage, 'definitely not a zip');
    await expect(importTtsmod(garbage, { modsParentDir: tempRoot, modSaveLocation: tempRoot })).rejects.toThrowError(
      expect.objectContaining({ code: 'TTSMOD_INVALID' }) as Error,
    );
    await expect(
      importTtsmod(path.join(tempRoot, 'no-such.ttsmod'), { modsParentDir: tempRoot, modSaveLocation: tempRoot }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'TTSMOD_INVALID' }) as Error);
  });

  it('manifest 条目不落地（只回读）；损坏的 manifest 记告警不致命', async () => {
    const bad = path.join(tempRoot, 'bad-manifest.ttsmod');
    await writeFile(
      bad,
      writeZip([
        { name: 'manifest.json', data: Buffer.from('{not-json') },
        { name: 'Mods/Workshop/1.json', data: Buffer.from('{}') },
      ]),
    );
    const result = await importTtsmod(bad, { modsParentDir: tempRoot, modSaveLocation: tempRoot });
    expect(result.manifest).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('manifest.json'))).toBe(true);
    expect(result.extracted).toBe(1);
    expect(existsSync(path.join(tempRoot, 'manifest.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 缓存键与打包的端到端一致性（防 sanitize 漂移回归）
// ---------------------------------------------------------------------------

describe('端到端一致性：导出条目名 = TTS 缓存键约定', () => {
  it('s_dial 已知 URL 经 exportTtsmod 产出的条目名与真实样本条目完全一致', async () => {
    const url = 'https://raw.githubusercontent.com/DasUmlaut/TTSLibrary/master/dials/dial-12-0.jpg';
    const out = path.join(tempRoot, 'dial.ttsmod');
    await exportTtsmod({
      outPath: out,
      packName: 'Dial',
      saveJson: '{}',
      readme: 'none',
      manifest: false,
      probe: probeNone,
      assets: [{ url, kind: 'image', data: Buffer.from('dial-jpg-bytes') }],
    });
    const names = readZip(await readFile(out)).map((e) => e.name);
    expect(names).toContain(`Mods/Images/${sanitizeUrl(url)}.jpg`);
    // 与真实样本（s_dial.ttsmod）里的实测条目逐字符相同
    expect(names).toContain('Mods/Images/httpsrawgithubusercontentcomDasUmlautTTSLibrarymasterdialsdial120jpg.jpg');
  });
});
