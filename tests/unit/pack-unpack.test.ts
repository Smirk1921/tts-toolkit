// tests/unit/pack-unpack.test.ts
/**
 * src/pack/unpack.ts 单元测试：从存档 JSON / .ttsmod 离线建图包工作区。
 *
 * 纯文件 IO（临时目录）+ 本机 pwsh / git，无网络、无 TTS 依赖：
 * - 正常路径：.json 输入与 .ttsmod 输入的工作区布局、脚本 / UI 命名（与
 *   tts pull 一致）、deck.yaml 骨架、pack.yaml（lfs=disabled-no-lfs）、
 *   骨架存档保真（约束 8）、git init 与 skipGit；
 * - 真实夹具（**仓库不自带**，sample_diceset.ttsmod 来自 Steam 工坊，见下方
 *   "夹具获取"）：钉住空 GUID 对象（原包尚未进游戏存档，GUID 全为空串）的
 *   落盘行为——主干退化为净化名、重名（两个 D8）追加 ".2" 去重、data.json
 *   如实保留空 GUID；
 * - 异常路径：按 PackError.code（机器可读）断言，不依赖错误文案——
 *   文案走 t()，locales/*.json 由 Run 2 补齐，补齐前后 message 不同；
 * - 关键回归点：骨架存档不得含 readSave 的 ">>floating-point<<" 包装
 *   （unpack.ts 模块头注释的取舍 1）。
 *
 * 夹具获取：
 * - 设环境变量 `TTS_FIXTURE_DIR` 指向含 `sample_diceset.ttsmod` 的目录；或
 * - 在 `<repo>/tests/fixtures/` 下手动放置样本（目录已 gitignore）。
 * 两者皆无时，依赖真实夹具的 describe 自动 skip，合成存档用例不受影响。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readDeckManifest } from '../../src/pack/manifest.js';
import { readPackYaml } from '../../src/pack/packyaml.js';
import { unpackSave } from '../../src/pack/unpack.js';

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR_CANDIDATES = [
  process.env.TTS_FIXTURE_DIR,
  path.resolve(__dirname, '..', 'fixtures'),
].filter((p): p is string => typeof p === 'string' && p.length > 0);

const REAL_FIXTURE_PATH: string | undefined = FIXTURE_DIR_CANDIDATES.map((p) =>
  path.join(p, 'sample_diceset.ttsmod'),
).find((p) => existsSync(p));

/** 依赖真实夹具的 describe：无夹具时自动 skip */
const describeFixture = REAL_FIXTURE_PATH ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-unpack-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/**
 * 合成存档（覆盖四类顶层对象：带脚本牌堆 / 带脚本+UI 对象 / 无脚本对象 /
 * 无 Nickname 的 DeckCustom），数字字段用于 floating-point 包装回归。
 */
function buildSave(): Record<string, unknown> {
  return {
    SaveName: '单元测试存档',
    LuaScript: "print('global lua')\n",
    XmlUI: '<Panel>\n  <Button id="btn1" />\n</Panel>',
    ObjectStates: [
      {
        GUID: 'aa11bb',
        Name: 'Deck',
        Nickname: '测试牌堆',
        CustomDeck: { '1': { FaceURL: 'http://example.invalid/face.png' } },
        LuaScript: "print('deck script')\n",
        ContainedObjects: [{ GUID: 'cc22dd', Name: 'Card', Nickname: '杀' }],
      },
      {
        GUID: 'dd33ee',
        Name: 'Custom_Pawn',
        Nickname: 'Scripted Trigger',
        LuaScript: "print('pawn script')\n",
        XmlUI: '<Panel id="pawn-ui" />',
        Transform: { scaleX: 0.5 },
      },
      {
        GUID: 'ee44ff',
        Name: 'Bag',
        LuaScriptState: 'lua-state-data',
      },
      {
        GUID: 'ff55aa',
        Name: 'DeckCustom',
        CustomDeck: { '2': { FaceURL: 'http://example.invalid/2.png' } },
      },
    ],
  };
}

/** 把合成存档写入临时目录，返回存档 JSON 路径 */
async function writeSaveFile(name = 'save.json'): Promise<string> {
  const savePath = path.join(tempRoot, name);
  await writeFile(savePath, JSON.stringify(buildSave(), null, 2), 'utf8');
  return savePath;
}

/** PowerShell 单引号字面量（测试路径不含单引号，简单拼接即可） */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 用 pwsh Compress-Archive 把 srcDir 压成 zip（造 .ttsmod 夹具） */
async function makeZip(srcDir: string, destZip: string): Promise<void> {
  await execFileP('pwsh', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path ${psQuote(srcDir)} -DestinationPath ${psQuote(destZip)} -Force`,
  ]);
}

/** 造一个最小 .ttsmod 夹具（Mods/Workshop/<id>.json + Mods/Models/box.txt），返回 mod 路径 */
async function writeTtsmod(): Promise<string> {
  const src = path.join(tempRoot, 'modsrc', 'Mods');
  await mkdir(path.join(src, 'Workshop'), { recursive: true });
  await mkdir(path.join(src, 'Models'), { recursive: true });
  await writeFile(path.join(src, 'Workshop', '123456.json'), JSON.stringify(buildSave(), null, 2), 'utf8');
  await writeFile(path.join(src, 'Models', 'box.txt'), 'model-bytes', 'utf8');
  const modPath = path.join(tempRoot, 'mod.ttsmod');
  await makeZip(src, modPath);
  return modPath;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('unpackSave（.json 输入）', () => {
  it('建出完整工作区：布局 / 脚本 / UI / 对象与牌堆 / pack.yaml / 骨架', async () => {
    const savePath = await writeSaveFile();
    const outDir = path.join(tempRoot, 'pack');
    const result = await unpackSave({ savePath, outDir, skipGit: true });

    // 返回值
    expect(result.packRoot).toBe(outDir);
    expect(result.skeletonWritten).toBe(true);
    // 脚本 3：Global + 牌堆 + 棋子；UI 2：Global + 棋子；对象 4（含 2 个牌堆）
    expect(result.scriptsWritten).toBe(3);
    expect(result.uiWritten).toBe(2);
    expect(result.objectsWritten).toBe(4);

    // 布局目录（含备用目录与 .tts 子目录）
    for (const dir of ['scripts', 'ui', 'decks', 'objects', 'sheets', 'source', '.tts', '.tts/backups', '.tts/cache']) {
      expect(existsSync(path.join(outDir, ...dir.split('/'))), dir).toBe(true);
    }

    // 脚本 / UI 命名与内容（与 tts pull 同规则：<guid>.<净化名>；中文名保留）
    expect(await readFile(path.join(outDir, 'scripts', 'Global.lua'), 'utf8')).toBe("print('global lua')\n");
    expect(await readFile(path.join(outDir, 'scripts', 'aa11bb.测试牌堆.lua'), 'utf8')).toBe(
      "print('deck script')\n",
    );
    expect(await readFile(path.join(outDir, 'scripts', 'dd33ee.Scripted_Trigger.lua'), 'utf8')).toBe(
      "print('pawn script')\n",
    );
    expect(await readFile(path.join(outDir, 'ui', 'Global.xml'), 'utf8')).toBe(
      '<Panel>\n  <Button id="btn1" />\n</Panel>',
    );
    expect(await readFile(path.join(outDir, 'ui', 'dd33ee.Scripted_Trigger.xml'), 'utf8')).toBe(
      '<Panel id="pawn-ui" />',
    );
    // 无脚本 / 无 UI 的对象不生成空文件
    expect(existsSync(path.join(outDir, 'scripts', 'ee44ff.Bag.lua'))).toBe(false);
    expect(existsSync(path.join(outDir, 'ui', 'ee44ff.Bag.xml'))).toBe(false);

    // 牌堆 → decks/，deck.yaml 骨架可通过 readDeckManifest 校验
    const deckDir = path.join(outDir, 'decks', 'aa11bb.测试牌堆');
    const deckData = JSON.parse(await readFile(path.join(deckDir, 'data.json'), 'utf8'));
    expect(deckData.ContainedObjects[0].GUID).toBe('cc22dd'); // 完整对象（未被 extractSave 剥离）
    expect(deckData.CustomDeck).toEqual({ '1': { FaceURL: 'http://example.invalid/face.png' } });
    const deckYaml = await readDeckManifest(deckDir);
    expect(deckYaml.name).toBe('测试牌堆');
    expect(deckYaml.guid).toBe('aa11bb');
    // B2 裁决：deck.yaml 不再含 cards 字段（卡牌明细由 src/deck/cards.ts 落到 cards.csv）
    expect(deckYaml.shared_with).toEqual([]);
    expect(deckYaml.atlas).toBeUndefined();

    // DeckCustom（无 Nickname）→ 名字回退 Name，同样按牌堆处理
    const deck2Dir = path.join(outDir, 'decks', 'ff55aa.DeckCustom');
    const deck2Yaml = await readDeckManifest(deck2Dir);
    expect(deck2Yaml.name).toBe('DeckCustom');
    expect(deck2Yaml.guid).toBe('ff55aa');

    // 普通对象 → objects/，data.json 是完整对象 JSON
    const pawnData = JSON.parse(await readFile(path.join(outDir, 'objects', 'dd33ee.Scripted_Trigger', 'data.json'), 'utf8'));
    expect(pawnData.LuaScript).toBe("print('pawn script')\n");
    expect(pawnData.XmlUI).toBe('<Panel id="pawn-ui" />');
    const bagData = JSON.parse(await readFile(path.join(outDir, 'objects', 'ee44ff.Bag', 'data.json'), 'utf8'));
    expect(bagData.LuaScriptState).toBe('lua-state-data');

    // pack.yaml：lfs 固定 disabled-no-lfs（unpack 不做约束 10 的交互），workshop 信息为 null
    const packYaml = await readPackYaml(outDir);
    expect(packYaml.name).toBe('单元测试存档');
    expect(packYaml.vcs.lfs).toBe('disabled-no-lfs');
    expect(packYaml.workshop_id).toBeNull();
    expect(packYaml.source_mod).toBeNull();
    expect(packYaml.host).toBe('steamcloud');

    // skipGit: true → 不创建 .git
    expect(existsSync(path.join(outDir, '.git'))).toBe(false);
  }, 30_000);

  it('骨架存档保真（约束 8）：与原始存档深度一致，且不含 floating-point 包装', async () => {
    const savePath = await writeSaveFile();
    const outDir = path.join(tempRoot, 'pack');
    await unpackSave({ savePath, outDir, skipGit: true });

    const skeletonText = await readFile(path.join(outDir, '.tts', 'skeleton.json'), 'utf8');
    // readSave 返回值里的数字被 ">>floating-point<<" 字符串包装——骨架绝不能带
    expect(skeletonText).not.toContain('>>floating-point<<');
    expect(JSON.parse(skeletonText)).toEqual(buildSave());
    // 数字仍是数字（2 空格缩进的合法 JSON）
    const skeleton = JSON.parse(skeletonText) as { ObjectStates: Array<{ Transform?: { scaleX?: number } }> };
    expect(skeleton.ObjectStates[1].Transform?.scaleX).toBe(0.5);
  }, 30_000);

  it('name 选项覆盖 SaveName；SaveName 缺失时回退 name', async () => {
    const savePath = await writeSaveFile();
    const outDir1 = path.join(tempRoot, 'pack1');
    const result1 = await unpackSave({ savePath, outDir: outDir1, name: '我的图包', skipGit: true });
    expect((await readPackYaml(outDir1)).name).toBe('我的图包');
    expect(result1.packRoot).toBe(outDir1);

    // 存档无 SaveName 时用 name
    const save2 = path.join(tempRoot, 'no-name.json');
    const raw = buildSave() as Record<string, unknown>;
    delete raw.SaveName;
    await writeFile(save2, JSON.stringify(raw, null, 2), 'utf8');
    const outDir2 = path.join(tempRoot, 'pack2');
    await unpackSave({ savePath: save2, outDir: outDir2, name: '备用名', skipGit: true });
    expect((await readPackYaml(outDir2)).name).toBe('备用名');
  }, 30_000);

  it('重复解包幂等：覆盖写入同名文件，git 已存在时不再 init', async () => {
    const savePath = await writeSaveFile();
    const outDir = path.join(tempRoot, 'pack');
    await unpackSave({ savePath, outDir });
    const result = await unpackSave({ savePath, outDir });
    expect(result.scriptsWritten).toBe(3);
    expect(existsSync(path.join(outDir, '.git'))).toBe(true);
    expect((await readPackYaml(outDir)).name).toBe('单元测试存档');
  }, 30_000);
});

describe('unpackSave（.ttsmod 输入）', () => {
  it('从 ZIP 中取 Mods/Workshop/*.json 建工作区，并复制 Mods/Models 到 source/models', async () => {
    const modPath = await writeTtsmod();
    const outDir = path.join(tempRoot, 'pack');
    const result = await unpackSave({ savePath: modPath, outDir, skipGit: true });

    expect(result.scriptsWritten).toBe(3);
    expect(result.objectsWritten).toBe(4);
    expect(await readFile(path.join(outDir, 'scripts', 'Global.lua'), 'utf8')).toBe("print('global lua')\n");
    expect(await readFile(path.join(outDir, 'source', 'models', 'box.txt'), 'utf8')).toBe('model-bytes');
    // 骨架同样保真
    expect(await readFile(path.join(outDir, '.tts', 'skeleton.json'), 'utf8')).not.toContain('>>floating-point<<');
  }, 60_000);
});

describeFixture('unpackSave（真实夹具 sample_diceset.ttsmod）', () => {
  it('解包工坊原包：骨架存档保真、objects/ 子目录齐全、空 GUID 重名对象去重、模型进 source/models', async () => {
    // 复制夹具到临时目录（不改动参考资料原件），按约定 skipGit
    const modPath = path.join(tempRoot, 'sample_diceset.ttsmod');
    await copyFile(REAL_FIXTURE_PATH!, modPath);
    const outDir = path.join(tempRoot, 'pack');
    const result = await unpackSave({ savePath: modPath, outDir, skipGit: true });

    // 骨架存档（约束 8）：落盘、SaveName="Custom Dice Set"、11 个顶层对象、
    // 无 floating-point 包装（骨架必须来自原始文本的 JSON.parse）
    expect(result.skeletonWritten).toBe(true);
    const skeletonText = await readFile(path.join(outDir, '.tts', 'skeleton.json'), 'utf8');
    expect(skeletonText).not.toContain('>>floating-point<<');
    const skeleton = JSON.parse(skeletonText) as {
      SaveName?: unknown;
      LuaScript?: unknown;
      ObjectStates?: unknown[];
    };
    expect(skeleton.SaveName).toBe('Custom Dice Set');
    expect(skeleton.ObjectStates).toHaveLength(11);

    // pack.yaml：name 缺省取存档 SaveName
    expect((await readPackYaml(outDir)).name).toBe('Custom Dice Set');

    // objects/：11 个对象各一个子目录（该夹具无牌堆，不占 decks/）
    expect(result.objectsWritten).toBe(11);
    const objectDirs = (
      await readdir(path.join(outDir, 'objects'), { withFileTypes: true })
    ).filter((e) => e.isDirectory());
    expect(objectDirs).toHaveLength(11);

    // 空 GUID 对象按净化名落盘；重名（两个 Nickname="D8"）依处理顺序追加
    // ".2" 去重（readdir 顺序不定，不假设哪个拿原名，只断言两个都在且无重名）
    const dirNames = objectDirs.map((e) => e.name);
    expect(new Set(dirNames).size).toBe(11);
    expect(dirNames.filter((n) => n === 'D8' || n === 'D8.2')).toHaveLength(2);
    for (const name of dirNames) {
      const data = JSON.parse(await readFile(path.join(outDir, 'objects', name, 'data.json'), 'utf8'));
      expect(data.Name).toBe('Custom_Model');
      expect(data.GUID).toBe(''); // 空 GUID 如实保留，不被合成占位值污染
      expect(data.CustomMesh).toBeDefined(); // data.json 是原始完整对象（CustomMesh 未被剥离）
    }

    // .ttsmod 自带的 Mods/Models 素材 → source/models/
    const models = await readdir(path.join(outDir, 'source', 'models'));
    expect(models.filter((f) => f.endsWith('.obj'))).toHaveLength(11);

    // 脚本断言按夹具实际内容自适应（原档没有非空 LuaScript 时跳过 Global 断言）：
    // 该夹具全局 LuaScript 是空串、对象均无脚本 → 不应产出空脚本文件
    const hasGlobalLua = typeof skeleton.LuaScript === 'string' && skeleton.LuaScript.trim() !== '';
    if (hasGlobalLua) {
      expect(existsSync(path.join(outDir, 'scripts', 'Global.lua'))).toBe(true);
      expect(result.scriptsWritten).toBeGreaterThanOrEqual(1);
    } else {
      expect(existsSync(path.join(outDir, 'scripts', 'Global.lua'))).toBe(false);
      expect(result.scriptsWritten).toBe(0);
    }
    expect(existsSync(path.join(outDir, '.git'))).toBe(false); // skipGit: true
  }, 120_000);
});

describe('unpackSave（错误路径）', () => {
  it('存档 JSON 非法 / 缺 ObjectStates / 文件不存在 → SAVE_INVALID', async () => {
    const badPath = path.join(tempRoot, 'bad.json');
    await writeFile(badPath, '{ 不是 JSON', 'utf8');
    await expect(unpackSave({ savePath: badPath, outDir: path.join(tempRoot, 'p1'), skipGit: true })).rejects.toMatchObject({
      code: 'SAVE_INVALID',
    });

    const noStatesPath = path.join(tempRoot, 'no-states.json');
    await writeFile(noStatesPath, '{"SaveName":"缺 ObjectStates"}', 'utf8');
    await expect(unpackSave({ savePath: noStatesPath, outDir: path.join(tempRoot, 'p2'), skipGit: true })).rejects.toMatchObject({
      code: 'SAVE_INVALID',
    });

    await expect(unpackSave({ savePath: path.join(tempRoot, 'missing.json'), outDir: path.join(tempRoot, 'p3'), skipGit: true })).rejects.toMatchObject({
      code: 'SAVE_INVALID',
    });
  });

  it('.ttsmod 不是 ZIP / 无 Mods/Workshop/*.json → TTSMOD_INVALID', async () => {
    const fakeMod = path.join(tempRoot, 'fake.ttsmod');
    await writeFile(fakeMod, '这不是 ZIP', 'utf8');
    await expect(unpackSave({ savePath: fakeMod, outDir: path.join(tempRoot, 'p4'), skipGit: true })).rejects.toMatchObject({
      code: 'TTSMOD_INVALID',
    });

    // 合法 ZIP 但没有 Mods/Workshop/*.json
    const emptySrc = path.join(tempRoot, 'emptysrc');
    await mkdir(emptySrc, { recursive: true });
    await writeFile(path.join(emptySrc, 'readme.txt'), 'no save here', 'utf8');
    const emptyMod = path.join(tempRoot, 'empty.ttsmod');
    await makeZip(emptySrc, emptyMod);
    await expect(unpackSave({ savePath: emptyMod, outDir: path.join(tempRoot, 'p5'), skipGit: true })).rejects.toMatchObject({
      code: 'TTSMOD_INVALID',
    });
  }, 60_000);

  it('.ttsmod 文件不存在 → TTSMOD_INVALID', async () => {
    await expect(unpackSave({ savePath: path.join(tempRoot, 'missing.ttsmod'), outDir: path.join(tempRoot, 'p6'), skipGit: true })).rejects.toMatchObject({
      code: 'TTSMOD_INVALID',
    });
  });
});
