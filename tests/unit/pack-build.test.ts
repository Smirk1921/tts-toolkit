// tests/unit/pack-build.test.ts
/**
 * src/pack/build.ts 单元测试：图包工作区 → TTS 存档 JSON（离线回路，约束 8）。
 *
 * 覆盖分两层：
 * 1. 核心测点（简化骨架：SaveName="test" + 单对象 GUID="abc123"）：
 *    - 正常路径：scripts/abc123.测试.lua（"--new"）定点替换骨架里的 "--old"，
 *      输出落在 dist/<名>.json，其余字段（GUID/Name/Transform）与骨架一致；
 *    - dryRun=true：scriptsReplaced===1 但不建 dist/、不写任何文件；
 *    - skeleton.json 不存在 → 抛 PackError("SKELETON_MISSING")；
 *    - 工作区新增 GUID（骨架没有的 xyz789.lua）→ 构建成功且 warnings 点名该孤儿。
 *    这一层不写 pack.yaml：输出名回退骨架 SaveName，一并钉住该回退行为。
 * 2. 约束 8 回归（较完整的骨架夹具，含牌堆 / 内嵌对象 / 包）：
 *    无改动时输出与骨架逐字节一致、Global 与内嵌对象的定点替换、data.json
 *    整体替换与"先整体替换再打脚本补丁"的顺序、ObjectStates 顺序保留、
 *    同 guid 多候选取字典序、孤儿对象 / 牌堆 / UI、显式 outPath、骨架非法等。
 *
 * 纯文件 IO（os.tmpdir() 下的临时目录），无网络、无 TTS、无 git 依赖：
 * - 错误按 PackError.code（机器可读）断言，不依赖错误文案——文案走 t()，
 *   locales/*.json 由 Run 2 补齐，补齐前后 message 不同；
 * - 孤儿警告文案同理：用"警告 === t(键, {file}) 的渲染结果"钉住键与参数契约
 *   （键缺失时 t() 原样输出键名，两种状态下断言都成立），并在键已补齐
 *   （模板含 {file} 插值）时进一步要求警告点名孤儿文件——文件名里带着该 GUID。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { t } from '../../src/i18n/index.js';
import { buildSave } from '../../src/pack/build.js';
import { PackError, writePackYaml } from '../../src/pack/packyaml.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-build-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 核心测点夹具：简化骨架（SaveName="test" + 单对象 GUID="abc123"）
// ---------------------------------------------------------------------------

/** 简化骨架存档（任务规定的最小结构，不必是真实 TTS 存档） */
function simpleSkeleton(): Record<string, unknown> {
  return {
    SaveName: 'test',
    ObjectStates: [{ GUID: 'abc123', Name: 'Test', LuaScript: '--old', Transform: {} }],
  };
}

/**
 * 建一个最小图包工作区：只写 .tts/skeleton.json，不写 pack.yaml——
 * buildSave 找不到清单时输出名回退骨架 SaveName（"test"）。
 * @returns 工作区根目录
 */
async function makeSimplePack(): Promise<string> {
  const root = path.join(tempRoot, 'pack');
  await mkdir(path.join(root, '.tts'), { recursive: true });
  await writeFile(path.join(root, '.tts', 'skeleton.json'), JSON.stringify(simpleSkeleton(), null, 2), 'utf8');
  return root;
}

/** 往 <root>/scripts/ 落一个脚本文件（自动建目录） */
async function writeScript(root: string, fileName: string, content: string): Promise<void> {
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'scripts', fileName), content, 'utf8');
}

// ---------------------------------------------------------------------------
// 核心测点
// ---------------------------------------------------------------------------

describe('buildSave：核心测点（简化骨架 abc123）', () => {
  it('正常路径：abc123 的脚本替换进骨架，输出 dist/test.json，其余字段与骨架一致', async () => {
    const root = await makeSimplePack();
    await writeScript(root, 'abc123.测试.lua', '--new');

    const result = await buildSave({ root, dryRun: false });

    // 无 pack.yaml → 输出名回退骨架 SaveName "test"
    const outPath = path.join(root, 'dist', 'test.json');
    expect(result.outPath).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);

    const built = JSON.parse(await readFile(outPath, 'utf8')) as {
      SaveName?: unknown;
      ObjectStates?: Array<Record<string, unknown>>;
    };
    expect(built.SaveName).toBe('test');
    expect(built.ObjectStates).toHaveLength(1);
    // LuaScript 已被工作区脚本替换；其余字段（GUID/Name/Transform）与骨架一致
    expect(built.ObjectStates?.[0]).toEqual({ GUID: 'abc123', Name: 'Test', LuaScript: '--new', Transform: {} });
    expect(result.scriptsReplaced).toBe(1);
    expect(result.warnings).toEqual([]);
  }, 30_000);

  it('dryRun=true：scriptsReplaced===1，但不建 dist/、不写任何文件', async () => {
    const root = await makeSimplePack();
    await writeScript(root, 'abc123.测试.lua', '--new');

    const result = await buildSave({ root, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.scriptsReplaced).toBe(1);
    expect(existsSync(path.join(root, 'dist'))).toBe(false);
    expect(existsSync(path.join(root, 'dist', 'test.json'))).toBe(false);
  }, 30_000);

  it('skeleton.json 不存在 → 抛 PackError("SKELETON_MISSING")', async () => {
    const root = path.join(tempRoot, 'no-skeleton');
    await mkdir(root, { recursive: true });
    const err: unknown = await buildSave({ root }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PackError);
    expect((err as PackError).code).toBe('SKELETON_MISSING');
  });

  it('工作区新增 GUID（骨架没有的 xyz789.lua）→ 构建成功且 warnings 点名该孤儿', async () => {
    const root = await makeSimplePack();
    await writeScript(root, 'xyz789.幽灵.lua', '--ghost\n');

    const result = await buildSave({ root, dryRun: false });

    // 构建照常成功：孤儿脚本不报错、不参与替换、不进输出
    expect(result.scriptsReplaced).toBe(0);
    const built = JSON.parse(await readFile(path.join(root, 'dist', 'test.json'), 'utf8')) as {
      ObjectStates?: Array<Record<string, unknown>>;
    };
    expect(built.ObjectStates?.[0]?.LuaScript).toBe('--old');

    // 唯一一条警告 = 该孤儿脚本对应的警告（键 cli.pack.build.warnScriptOrphan、参数 {file}）；
    // 文案经 t()，locales/*.json 由 Run 2 补齐，缺键时 t() 原样输出键名——两种状态都精确匹配
    const orphanFile = path.join(root, 'scripts', 'xyz789.幽灵.lua');
    const expected = t('cli.pack.build.warnScriptOrphan', { file: orphanFile });
    expect(result.warnings).toEqual([expected]);
    // 键已补齐（渲染出真实文案）时，模板含 {file} → 警告必然点名孤儿文件——文件名里带着该 GUID
    expect(expected === 'cli.pack.build.warnScriptOrphan' || expected.includes('xyz789')).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 约束 8 回归：较完整骨架夹具（pack.yaml 命名输出 + 牌堆 / 内嵌对象 / 包）
// ---------------------------------------------------------------------------

/**
 * 合成骨架存档（与 unpack 落盘的形状一致）：带脚本与内嵌卡的牌堆 /
 * 带脚本+UI 的棋子 / 带 LuaScriptState 的包。数字字段用于验证 JSON 往返无损。
 */
function buildSkeleton(): Record<string, unknown> {
  return {
    SaveName: '单元测试存档',
    LuaScript: "print('global old')\n",
    XmlUI: '<Panel>old</Panel>',
    ObjectStates: [
      {
        GUID: 'aa11bb',
        Name: 'Deck',
        Nickname: '测试牌堆',
        CustomDeck: { '1': { FaceURL: 'http://example.invalid/face.png' } },
        LuaScript: "print('deck old')\n",
        ContainedObjects: [{ GUID: 'cc22dd', Name: 'Card', Nickname: '杀', LuaScript: "print('card old')\n" }],
      },
      {
        GUID: 'dd33ee',
        Name: 'Custom_Pawn',
        Nickname: 'Pawn',
        LuaScript: "print('pawn old')\n",
        XmlUI: "<Panel id='pawn-old' />",
        Transform: { scaleX: 0.5 },
      },
      {
        GUID: 'ee44ff',
        Name: 'Bag',
        LuaScriptState: 'old-state',
      },
    ],
  };
}

/**
 * 建一个最小图包工作区：.tts/skeleton.json + pack.yaml（其余 scripts/ui/
 * objects/decks 目录按需创建）。返回工作区根目录。
 */
async function makePack(): Promise<string> {
  const root = path.join(tempRoot, 'pack');
  await mkdir(path.join(root, '.tts'), { recursive: true });
  await writeFile(
    path.join(root, '.tts', 'skeleton.json'),
    JSON.stringify(buildSkeleton(), null, 2),
    'utf8',
  );
  await writePackYaml(root, {
    schema_version: 1,
    name: '测试图包',
    workshop_id: null,
    source_mod: null,
    host: 'steamcloud',
    vcs: { lfs: 'disabled-no-lfs' },
    paths: { workdir: '.' },
    upload: { prefix: '' },
  });
  return root;
}

/** 往 <root>/<kind>/<name>/ 写 data.json（自动建目录） */
async function writeObjectData(root: string, kind: 'objects' | 'decks', name: string, data: unknown): Promise<void> {
  const dir = path.join(root, kind, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'data.json'), JSON.stringify(data, null, 2), 'utf8');
}

/** 读取构建产物并解析（defaultOutPath 依赖 pack.yaml 的 name="测试图包"） */
async function readBuilt(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, 'dist', '测试图包.json'), 'utf8')) as Record<string, unknown>;
}

describe('buildSave（约束 8：定点替换，不重新生成）', () => {
  it('工作区无改动时输出与骨架逐字节一致，计数全 0、无警告', async () => {
    const root = await makePack();
    const result = await buildSave({ root });

    expect(result.dryRun).toBe(false);
    expect(result.outPath).toBe(path.join(root, 'dist', '测试图包.json'));
    expect(result.scriptsReplaced).toBe(0);
    expect(result.uiReplaced).toBe(0);
    expect(result.decksPatched).toBe(0);
    expect(result.objectsReplaced).toBe(0);
    expect(result.warnings).toEqual([]);

    const skeletonText = await readFile(path.join(root, '.tts', 'skeleton.json'), 'utf8');
    const builtText = await readFile(result.outPath, 'utf8');
    expect(builtText).toBe(skeletonText); // 逐字节一致
    expect(JSON.parse(builtText)).toEqual(buildSkeleton());
    // 数字往返无损（防 readSave 的 floating-point 包装污染）
    const built = JSON.parse(builtText) as { ObjectStates: Array<{ Transform?: { scaleX?: number } }> };
    expect(built.ObjectStates[1].Transform?.scaleX).toBe(0.5);
  }, 30_000);

  it('定点替换：脚本 / UI 前缀匹配（名字可改）、data.json 整体替换、内嵌对象递归、顺序保留', async () => {
    const root = await makePack();

    // Global 脚本 + UI
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, 'ui'), { recursive: true });
    await writeFile(path.join(root, 'scripts', 'Global.lua'), "print('global new')\n", 'utf8');
    await writeFile(path.join(root, 'ui', 'Global.xml'), '<Panel>new</Panel>', 'utf8');

    // 棋子：脚本与 UI 文件的名字部分与 unpack 时不同（改过名），只靠 guid 前缀命中
    await writeFile(path.join(root, 'scripts', 'dd33ee.Renamed_Pawn.lua'), "print('pawn new')\n", 'utf8');
    await writeFile(path.join(root, 'ui', 'dd33ee.Renamed_Pawn.xml'), "<Panel id='pawn-new' />", 'utf8');

    // 牌堆：工作区 data.json 整体替换 + 自身脚本补丁 + 内嵌卡脚本递归补丁
    await writeObjectData(root, 'decks', 'aa11bb.测试牌堆', {
      GUID: 'aa11bb',
      Name: 'Deck',
      Nickname: '测试牌堆',
      CustomDeck: { '1': { FaceURL: 'http://example.invalid/new-face.png' } },
      LuaScript: "print('deck stale from datajson')\n",
      ContainedObjects: [{ GUID: 'cc22dd', Name: 'Card', Nickname: '杀', LuaScript: "print('card stale')\n" }],
    });
    await writeFile(path.join(root, 'scripts', 'aa11bb.测试牌堆.lua'), "print('deck new')\n", 'utf8');
    await writeFile(path.join(root, 'scripts', 'cc22dd.杀.lua'), "print('card new')\n", 'utf8');

    // 包：objects/ 整体替换（含新增字段，GUID 不变）
    await writeObjectData(root, 'objects', 'ee44ff.Bag', {
      GUID: 'ee44ff',
      Name: 'Bag',
      LuaScriptState: 'new-state',
      Description: '改过的包',
    });

    const result = await buildSave({ root });
    expect(result.warnings).toEqual([]); // 所有 guid 都在骨架里（含内嵌的 cc22dd）

    // 计数：脚本 4（Global / 牌堆 / 棋子 / 内嵌卡），UI 2（Global / 棋子），
    // 整体替换 2（decks 的牌堆 + objects 的包），deck/patch 本窗口恒 0
    expect(result.scriptsReplaced).toBe(4);
    expect(result.uiReplaced).toBe(2);
    expect(result.objectsReplaced).toBe(2);
    expect(result.decksPatched).toBe(0);

    const built = await readBuilt(root);
    const states = built.ObjectStates as Array<Record<string, unknown>>;

    // ObjectStates 原顺序保留
    expect(states.map((s) => s.GUID)).toEqual(['aa11bb', 'dd33ee', 'ee44ff']);

    // 顶层 Global：替换为新内容
    expect(built.LuaScript).toBe("print('global new')\n");
    expect(built.XmlUI).toBe('<Panel>new</Panel>');

    // 牌堆：整体替换后，自身与内嵌卡再打脚本补丁（data.json 里的旧脚本被覆盖）
    expect(states[0].CustomDeck).toEqual({ '1': { FaceURL: 'http://example.invalid/new-face.png' } });
    expect(states[0].LuaScript).toBe("print('deck new')\n");
    const contained = states[0].ContainedObjects as Array<Record<string, unknown>>;
    expect(contained[0].LuaScript).toBe("print('card new')\n");

    // 棋子：未整体替换（工作区没有 objects/dd33ee），骨架版本保留 + 脚本 / UI 补丁
    expect(states[1].Nickname).toBe('Pawn');
    expect(states[1].Transform).toEqual({ scaleX: 0.5 });
    expect(states[1].LuaScript).toBe("print('pawn new')\n");
    expect(states[1].XmlUI).toBe("<Panel id='pawn-new' />");

    // 包：整体替换为工作区版本
    expect(states[2]).toEqual({ GUID: 'ee44ff', Name: 'Bag', LuaScriptState: 'new-state', Description: '改过的包' });
  }, 30_000);

  it('工作区删除的对象保留骨架版本；骨架有而工作区没改的脚本原样保留', async () => {
    const root = await makePack();
    // 工作区完全为空（连 scripts/ui 都没有）：对象一个都不替换
    const result = await buildSave({ root });
    expect(result.objectsReplaced).toBe(0);
    const built = await readBuilt(root);
    const states = built.ObjectStates as Array<Record<string, unknown>>;
    expect(states[2]).toEqual({ GUID: 'ee44ff', Name: 'Bag', LuaScriptState: 'old-state' });
    expect(built.LuaScript).toBe("print('global old')\n"); // 无 Global.lua → 保留骨架值
  }, 30_000);

  it('同一 guid 多个脚本候选：取字典序第一个并记警告', async () => {
    const root = await makePack();
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'scripts', 'dd33ee.Bbb.lua'), "print('pawn b')\n", 'utf8');
    await writeFile(path.join(root, 'scripts', 'dd33ee.Aaa.lua'), "print('pawn a')\n", 'utf8');

    const result = await buildSave({ root });
    expect(result.warnings).toHaveLength(1);
    expect(result.scriptsReplaced).toBe(1);

    const built = await readBuilt(root);
    const states = built.ObjectStates as Array<Record<string, unknown>>;
    expect(states[1].LuaScript).toBe("print('pawn a')\n"); // 字典序 Aaa 先生效
  }, 30_000);

  it('工作区有但骨架没有的 GUID → 收进 warnings，不报错也不影响其余对象', async () => {
    const root = await makePack();
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, 'ui'), { recursive: true });
    await writeFile(path.join(root, 'scripts', 'ffffaa.幽灵.lua'), "print('ghost')\n", 'utf8');
    await writeFile(path.join(root, 'ui', 'ffffaa.幽灵.xml'), '<Panel>ghost</Panel>', 'utf8');
    await writeObjectData(root, 'objects', 'gggg11.多出的对象', { GUID: 'gggg11', Name: 'Card' });
    await writeObjectData(root, 'decks', 'hhhh22.多出的牌堆', { GUID: 'hhhh22', Name: 'Deck' });

    const result = await buildSave({ root });
    // 孤儿脚本 / 孤儿 UI / 孤儿对象 / 孤儿牌堆 各一条
    expect(result.warnings).toHaveLength(4);
    expect(result.scriptsReplaced).toBe(0);
    expect(result.objectsReplaced).toBe(0);

    // 孤儿内容不进输出
    const built = await readBuilt(root);
    const states = built.ObjectStates as Array<Record<string, unknown>>;
    expect(states.map((s) => s.GUID)).toEqual(['aa11bb', 'dd33ee', 'ee44ff']);
  }, 30_000);

  it('dryRun：照常计数与算 outPath，但不建 dist/、不写任何文件', async () => {
    const root = await makePack();
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'scripts', 'Global.lua'), "print('global new')\n", 'utf8');

    const result = await buildSave({ root, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.outPath).toBe(path.join(root, 'dist', '测试图包.json'));
    expect(result.scriptsReplaced).toBe(1);
    expect(existsSync(path.join(root, 'dist'))).toBe(false);
    expect(existsSync(result.outPath)).toBe(false);
  }, 30_000);

  it('outPath 显式指定：写到指定路径（父目录自动创建）', async () => {
    const root = await makePack();
    const outPath = path.join(tempRoot, 'elsewhere', 'custom.json');
    const result = await buildSave({ root, outPath });

    expect(result.outPath).toBe(outPath);
    expect(existsSync(path.join(root, 'dist'))).toBe(false);
    const built = JSON.parse(await readFile(outPath, 'utf8')) as Record<string, unknown>;
    expect(built).toEqual(buildSkeleton());
  }, 30_000);
});

describe('buildSave（错误路径）', () => {
  it('骨架存档不存在 → SKELETON_MISSING', async () => {
    const root = path.join(tempRoot, 'no-skeleton');
    await mkdir(root, { recursive: true });
    await expect(buildSave({ root })).rejects.toMatchObject({ code: 'SKELETON_MISSING' });
  });

  it('骨架存档非法 JSON / 缺 ObjectStates → SKELETON_INVALID', async () => {
    const root = path.join(tempRoot, 'bad-skeleton');
    await mkdir(path.join(root, '.tts'), { recursive: true });
    await writeFile(path.join(root, '.tts', 'skeleton.json'), '{ 不是 JSON', 'utf8');
    await expect(buildSave({ root })).rejects.toMatchObject({ code: 'SKELETON_INVALID' });

    const root2 = path.join(tempRoot, 'no-states');
    await mkdir(path.join(root2, '.tts'), { recursive: true });
    await writeFile(path.join(root2, '.tts', 'skeleton.json'), '{"SaveName":"缺 ObjectStates"}', 'utf8');
    await expect(buildSave({ root: root2 })).rejects.toMatchObject({ code: 'SKELETON_INVALID' });
  });

  it('root / outPath 入参非法 → 编程错误直接抛出', async () => {
    await expect(buildSave({ root: '' })).rejects.toThrow(/root/);
    await expect(buildSave({ root: path.join(tempRoot, 'x'), outPath: '' })).rejects.toThrow(/outPath/);
  });
});
