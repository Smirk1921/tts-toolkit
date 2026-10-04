// tests/unit/deck-plan.test.ts
/**
 * src/deck/plan.ts 单元测试：URL 替换计划（dry-run 预览）。
 *
 * 临时目录（只写存档 JSON），无网络、无 sharp、无 TTS。覆盖维度：
 * - 正常路径：
 *   · 三种匹配模式：exact（含 mode 缺省等价于 "exact"）/ prefix（命中前缀被
 *     替换、余下后缀保留、前缀不符不命中）/ regex（捕获组 $1 引用、无 g 标志
 *     只替换首个匹配、不命中）；
 *   · 规则优先级：第一条命中后不再尝试后续规则（同 URL 双规则取第一条）、
 *     第一条不中落到第二条（exact 不中 → prefix 中）、三种模式混合规则表
 *     各命中各自的 URL 且 stats 分组计数互不串；
 *   · stats 与共享图集：按规则分组计数（键 = from）、同一 URL 出现 3 次
 *     （牌堆 + 2 张卡，层面一）→ stats["shared:<url>"] = 3、出现 2 次 → 标记 2、
 *     出现 1 次 → 不标记、totalAffected === entries.length；
 *   · 防御：{lang} 值跳过（坑 5，正则会命中其片段也不出条目、字段原样保留）、
 *     file: 本地路径不报错也不被 http 规则误匹配、规则显式针对 file: 时正常命中；
 *   · 覆盖：容器键四种（坑 4：ContainedObjects / ChildObjects / States 对象映射 /
 *     AttachedDecals，借用 patch.ts 的测试夹具形状）+ 全部素材字段
 *     （SkyURL / TableURL / CustomDeck 两字段 / CustomImage 两字段 /
 *     CustomMesh 四件套 / CustomAssetbundle 两字段 / CustomDecal.ImageURL /
 *     CustomPDF.PDFUrl）共 14 处一次遍历齐全；
 *   · 输入形式与 dry-run 免改写：savePath 传路径（文件字节前后不变）/ 传已解析
 *     对象（对象内容前后不变）/ 空规则数组 → 空计划不报错；entries 顺序 =
 *     walkSaveUrls 固定顺序（根直接字段 → 牌堆素材 → 容器下钻）；空 GUID /
 *     缺 Name 照常出条目（guid ""、无 name 属性）。
 * - 异常路径：存档不存在 / 存档非法 JSON / savePath 形态非法（数组、数字）→
 *   PLAN_SAVE_INVALID；regex 语法错误（且规则先于存档校验：savePath 也不存在
 *   时仍报规则错）/ mode 非法值 / from 非字符串 / rules 非数组 / 规则非对象 →
 *   PLAN_RULE_INVALID。
 * - PackError 一律按 .code 断言，不断言完整 message；message 双态断言
 *   （locales 尚无 error.pack.plan* 键时 t() 原样输出键名，补齐后含插值摘要）。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { planReplace, type PlanResult, type ReplaceRule } from '../../src/deck/plan.js';
import { PackError } from '../../src/pack/packyaml.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-deck-plan-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 常用图集 URL（牌堆正反面） */
const FACE = 'http://old.example.com/atlas/face.png';
const BACK = 'http://old.example.com/atlas/back.png';

/** 标准单牌堆夹具：ObjectStates[0] = Deck（CustomDeck["1"] 正反面） */
function deckFixture(): { root: Record<string, unknown>; deckSpec: Record<string, unknown> } {
  const deckSpec: Record<string, unknown> = {
    FaceURL: FACE,
    BackURL: BACK,
    NumWidth: 10,
    NumHeight: 7,
    Type: 0,
    UniqueBack: false,
  };
  const deck = { GUID: 'deck00', Name: 'Deck', Nickname: 'Poker Deck', CustomDeck: { '1': deckSpec } };
  return { root: { ObjectStates: [deck] }, deckSpec };
}

/** 把存档对象写进临时目录，返回文件路径 */
async function writeSave(name: string, save: unknown): Promise<string> {
  const filePath = path.join(tempRoot, name);
  await writeFile(filePath, JSON.stringify(save), 'utf8');
  return filePath;
}

/** 条目的 "路径#字段路径" 串（用于顺序断言，与 deck-patch 测试同构） */
function locKeys(entries: readonly { objectPath: string; fieldPath: readonly string[] }[]): string[] {
  return entries.map((e) => `${e.objectPath}#${e.fieldPath.join('.')}`);
}

/** 双态 message 断言：locales 尚无该键时 message === 键名；补齐后含插值片段 */
function expectDualMessage(err: PackError, key: string, fragment: string): void {
  expect(err.message === key || err.message.includes(fragment)).toBe(true);
}

/** 断言 promise 以指定 code 的 PackError reject，返回该错误供进一步断言 */
async function expectPlanError(
  promise: Promise<PlanResult>,
  code: 'PLAN_SAVE_INVALID' | 'PLAN_RULE_INVALID',
  key: string,
  fragment: string,
): Promise<PackError> {
  const err: unknown = await promise.then(
    () => {
      throw new Error(`期望抛出 PackError ${code}，但成功返回了`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PackError);
  const packErr = err as PackError;
  expect(packErr.code).toBe(code);
  expectDualMessage(packErr, key, fragment);
  return packErr;
}

// ---------------------------------------------------------------------------
// exact 模式
// ---------------------------------------------------------------------------

describe('exact 模式', () => {
  it('命中：PlanEntry 定位信息完整（objectPath / guid / name / fieldPath / matchedRule），newValue = to', async () => {
    const { root } = deckFixture();
    const savePath = await writeSave('save.json', root);

    const result = await planReplace({
      savePath,
      rules: [{ from: FACE, to: 'http://new.example.com/face.png' }],
    });

    expect(result.totalAffected).toBe(1);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.objectPath).toBe('ObjectStates[0]');
    expect(entry.guid).toBe('deck00');
    expect(entry.name).toBe('Deck');
    expect(entry.fieldPath).toEqual(['CustomDeck', 'FaceURL']);
    expect(entry.currentValue).toBe(FACE);
    expect(entry.newValue).toBe('http://new.example.com/face.png');
    expect(entry.matchedRule).toBe(FACE);
    expect(result.stats).toEqual({ [FACE]: 1 });
  });

  it('不命中：空计划（entries / stats 为空、totalAffected 0），不报错', async () => {
    const { root } = deckFixture();
    const savePath = await writeSave('save.json', root);

    const result = await planReplace({
      savePath,
      rules: [{ from: 'http://other.example.com/x.png', to: 'y' }],
    });

    expect(result.entries).toEqual([]);
    expect(result.stats).toEqual({});
    expect(result.totalAffected).toBe(0);
  });

  it('mode 缺省按 exact：与显式 mode: "exact" 的结果完全一致', async () => {
    const { root } = deckFixture();
    const savePath = await writeSave('save.json', root);

    const implicit = await planReplace({ savePath, rules: [{ from: FACE, to: 'http://n.example.com/f.png' }] });
    const explicit = await planReplace({
      savePath,
      rules: [{ from: FACE, to: 'http://n.example.com/f.png', mode: 'exact' }],
    });

    expect(implicit.entries).toEqual(explicit.entries);
    expect(implicit.entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// prefix 模式
// ---------------------------------------------------------------------------

describe('prefix 模式', () => {
  it('命中前缀被替换、余下后缀保留（换域名保留文件名）', async () => {
    const { root } = deckFixture();
    const savePath = await writeSave('save.json', root);

    const result = await planReplace({
      savePath,
      rules: [{ from: 'http://old.example.com/atlas', to: 'https://new.example.com/atlas', mode: 'prefix' }],
    });

    expect(result.totalAffected).toBe(2); // 正反面都命中
    expect(result.entries.map((e) => e.newValue)).toEqual([
      'https://new.example.com/atlas/face.png',
      'https://new.example.com/atlas/back.png',
    ]);
    expect(result.entries.every((e) => e.matchedRule === 'http://old.example.com/atlas')).toBe(true);
  });

  it('前缀不符不命中（scheme 不同 / 中部子串不算前缀）', async () => {
    const { root } = deckFixture();
    const savePath = await writeSave('save.json', root);

    const wrongScheme = await planReplace({
      savePath,
      rules: [{ from: 'https://old.example.com/atlas', to: 'X', mode: 'prefix' }],
    });
    const midSubstring = await planReplace({
      savePath,
      rules: [{ from: 'example.com/atlas', to: 'X', mode: 'prefix' }],
    });

    expect(wrongScheme.totalAffected).toBe(0);
    expect(midSubstring.totalAffected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// regex 模式
// ---------------------------------------------------------------------------

describe('regex 模式', () => {
  it('命中 + 捕获组 $1 引用（JS replace 语义）', async () => {
    const { root } = deckFixture();
    const savePath = await writeSave('save.json', root);

    const result = await planReplace({
      savePath,
      rules: [
        { from: '^http://old\\.example\\.com/(.+)$', to: 'https://new.example.com/$1', mode: 'regex' },
      ],
    });

    expect(result.entries.map((e) => e.newValue)).toEqual([
      'https://new.example.com/atlas/face.png',
      'https://new.example.com/atlas/back.png',
    ]);
  });

  it('无 g 标志只替换首个匹配（test 与 replace 用同一编译实例，结果确定）', async () => {
    const { root } = deckFixture();
    const savePath = await writeSave('save.json', root);

    const result = await planReplace({
      savePath,
      rules: [{ from: 'old', to: 'NEW', mode: 'regex' }],
    });

    // "http://old.example.com/atlas/face.png" 只把第一处 "old" 换掉
    expect(result.entries.map((e) => e.newValue)).toEqual([
      'http://NEW.example.com/atlas/face.png',
      'http://NEW.example.com/atlas/back.png',
    ]);
  });

  it('不命中 → 无条目', async () => {
    const { root } = deckFixture();
    const savePath = await writeSave('save.json', root);

    const result = await planReplace({
      savePath,
      rules: [{ from: '^https://', to: 'X', mode: 'regex' }],
    });

    expect(result.totalAffected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 规则优先级（先命中先生效）
// ---------------------------------------------------------------------------

describe('规则优先级', () => {
  it('第一条命中后不再尝试后续规则（同 URL 两条规则都匹配，取第一条）', async () => {
    const { root } = deckFixture();
    const savePath = await writeSave('save.json', root);

    const result = await planReplace({
      savePath,
      rules: [
        { from: FACE, to: 'http://first.example.com/f.png' },
        { from: FACE, to: 'http://second.example.com/f.png' },
      ],
    });

    expect(result.totalAffected).toBe(1);
    expect(result.entries[0]!.newValue).toBe('http://first.example.com/f.png');
    expect(result.entries[0]!.matchedRule).toBe(FACE);
    expect(result.stats).toEqual({ [FACE]: 1 }); // 只记第一条的命中
  });

  it('第一条不命中落到第二条（exact 不中 → prefix 中）', async () => {
    const { root } = deckFixture();
    const savePath = await writeSave('save.json', root);

    const result = await planReplace({
      savePath,
      rules: [
        { from: 'http://nope.example.com/x.png', to: 'A' },
        { from: 'http://old.example.com', to: 'https://new.example.com', mode: 'prefix' },
      ],
    });

    expect(result.totalAffected).toBe(2);
    expect(result.entries[0]!.matchedRule).toBe('http://old.example.com');
    expect(result.entries[0]!.newValue).toBe('https://new.example.com/atlas/face.png');
  });

  it('三种模式混合规则表：各命中各自的 URL，stats 分组计数互不串', async () => {
    const root: Record<string, unknown> = {
      ObjectStates: [
        deckFixture().root,
        { GUID: 'tile1', Name: 'Custom_Tile', CustomImage: { ImageURL: 'file:///D:/pics/tile.png' } },
        { GUID: 'pdf1', Name: 'Custom_PDF', CustomPDF: { PDFUrl: 'http://docs.example.com/rules.pdf' } },
      ].flat(),
    };
    const savePath = await writeSave('save.json', root);

    const result = await planReplace({
      savePath,
      rules: [
        { from: 'file:///D:/pics/tile.png', to: 'http://hosted.example.com/tile.png' },
        { from: 'http://old.example.com/atlas', to: 'https://new.example.com/atlas', mode: 'prefix' },
        { from: '^http://docs\\.example\\.com/(.+)$', to: 'http://mirror.example.com/$1', mode: 'regex' },
      ],
    });

    expect(result.totalAffected).toBe(4); // face + back（prefix）、tile（exact）、pdf（regex）
    expect(result.stats).toEqual({
      'file:///D:/pics/tile.png': 1,
      'http://old.example.com/atlas': 2,
      '^http://docs\\.example\\.com/(.+)$': 1,
    });
    const byField = new Map(result.entries.map((e) => [e.fieldPath.join('.'), e]));
    expect(byField.get('CustomImage.ImageURL')!.newValue).toBe('http://hosted.example.com/tile.png');
    expect(byField.get('CustomPDF.PDFUrl')!.newValue).toBe('http://mirror.example.com/rules.pdf');
    expect(byField.get('CustomDeck.FaceURL')!.newValue).toBe('https://new.example.com/atlas/face.png');
  });
});

// ---------------------------------------------------------------------------
// stats 与共享图集检测（坑 2 的 dry-run 预览）
// ---------------------------------------------------------------------------

describe('stats 与共享图集检测', () => {
  it('同一 URL 出现 3 次（牌堆 + 2 张 Card 复制的 CustomDeck）→ stats 标记 shared:<url>: 3', async () => {
    const mkSpec = (): Record<string, unknown> => ({ FaceURL: FACE, BackURL: BACK, NumWidth: 10, NumHeight: 7 });
    const deck = {
      GUID: 'deck00',
      Name: 'Deck',
      CustomDeck: { '1': mkSpec() },
      ContainedObjects: [
        { GUID: 'card01', Name: 'Card', CustomDeck: { '1': mkSpec() } },
        { GUID: 'card02', Name: 'Card', CustomDeck: { '1': mkSpec() } },
      ],
    };
    const savePath = await writeSave('save.json', { ObjectStates: [deck] });

    const result = await planReplace({
      savePath,
      rules: [{ from: FACE, to: 'http://new.example.com/face.png' }],
    });

    expect(result.totalAffected).toBe(3); // 牌堆 FaceURL + 2 张卡的 FaceURL
    expect(result.stats).toEqual({ [FACE]: 3, [`shared:${FACE}`]: 3 });
    // BACK 未命中：无条目、无 shared 标记
    expect(result.entries.every((e) => e.currentValue === FACE)).toBe(true);
    expect(`shared:${BACK}` in result.stats).toBe(false);
  });

  it('出现 1 次不标记 shared；出现 2 次标记 shared = 2', async () => {
    const URL_A = 'http://tiles.example.com/a.png';
    const single = { ObjectStates: [{ GUID: 't1', Name: 'Custom_Tile', CustomImage: { ImageURL: URL_A } }] };
    const double = {
      ObjectStates: [
        { GUID: 't1', Name: 'Custom_Tile', CustomImage: { ImageURL: URL_A } },
        { GUID: 't2', Name: 'Custom_Tile', CustomImage: { ImageURL: URL_A } },
      ],
    };

    const once = await planReplace({
      savePath: await writeSave('once.json', single),
      rules: [{ from: URL_A, to: 'X' }],
    });
    const twice = await planReplace({
      savePath: await writeSave('twice.json', double),
      rules: [{ from: URL_A, to: 'X' }],
    });

    expect(once.stats).toEqual({ [URL_A]: 1 }); // 无 shared 键
    expect(twice.stats).toEqual({ [URL_A]: 2, [`shared:${URL_A}`]: 2 });
  });

  it('totalAffected 恒等于 entries.length', async () => {
    const { root } = deckFixture();
    const savePath = await writeSave('save.json', root);

    const hit = await planReplace({ savePath, rules: [{ from: FACE, to: 'X', mode: 'prefix' }] });
    expect(hit.totalAffected).toBe(hit.entries.length);
    expect(hit.totalAffected).toBe(1);

    const miss = await planReplace({ savePath, rules: [{ from: 'http://none.example.com/', to: 'X', mode: 'prefix' }] });
    expect(miss.totalAffected).toBe(miss.entries.length);
    expect(miss.totalAffected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// {lang} 与 file: 防御（坑 5）
// ---------------------------------------------------------------------------

describe('{lang} 与 file: 防御', () => {
  it('{lang} 值跳过：正则会命中其片段也不出条目，字段原样保留（坑 5）', async () => {
    const LANG_VALUE = '{en}http://en.example.com/f.png{zh-cn}http://zh.example.com/f.png';
    const spec: Record<string, unknown> = { FaceURL: LANG_VALUE, BackURL: BACK };
    const root: Record<string, unknown> = { ObjectStates: [{ GUID: 'd', Name: 'Deck', CustomDeck: { '1': spec } }] };

    const result = await planReplace({
      savePath: root, // 对象形式：可直接断言字段未被改动
      rules: [{ from: 'png', to: 'X', mode: 'regex' }], // 会命中 {lang} 值里的 "png" 片段
    });

    expect(result.totalAffected).toBe(1); // 只有 BackURL
    expect(result.entries[0]!.currentValue).toBe(BACK);
    expect(result.entries[0]!.fieldPath).toEqual(['CustomDeck', 'BackURL']);
    expect(spec.FaceURL).toBe(LANG_VALUE); // 原样保留，未做任何替换
  });

  it('file: 本地路径不报错，也不被 http 规则误匹配', async () => {
    const FILE_URL = 'file:///D:/pics/tile.png';
    const root: Record<string, unknown> = {
      ObjectStates: [
        { GUID: 't1', Name: 'Custom_Tile', CustomImage: { ImageURL: FILE_URL } },
        ...((deckFixture().root['ObjectStates']) as Record<string, unknown>[]),
      ],
    };
    const savePath = await writeSave('save.json', root);

    const result = await planReplace({
      savePath,
      rules: [{ from: 'http://', to: 'https://', mode: 'prefix' }],
    });

    expect(result.totalAffected).toBe(2); // 牌堆正反面（http）；file: 不报错也不误匹配
    expect(result.entries.every((e) => e.currentValue !== FILE_URL)).toBe(true);
    expect(result.entries.map((e) => e.currentValue)).toEqual([FACE, BACK]);
  });

  it('规则显式针对 file: 路径时正常命中', async () => {
    const FILE_URL = 'file:///D:/pics/tile.png';
    const root: Record<string, unknown> = {
      ObjectStates: [{ GUID: 't1', Name: 'Custom_Tile', CustomImage: { ImageURL: FILE_URL } }],
    };

    const result = await planReplace({
      savePath: root,
      rules: [{ from: FILE_URL, to: 'http://hosted.example.com/tile.png' }],
    });

    expect(result.totalAffected).toBe(1);
    expect(result.entries[0]!.currentValue).toBe(FILE_URL);
    expect(result.entries[0]!.newValue).toBe('http://hosted.example.com/tile.png');
  });
});

// ---------------------------------------------------------------------------
// 容器键四种（坑 4）与素材字段覆盖
// ---------------------------------------------------------------------------

describe('容器键四种与素材字段覆盖', () => {
  it('容器键 4 种全部遍历到（借用 patch.ts 夹具形状），objectPath / guid 正确', async () => {
    const mkSpec = (): Record<string, unknown> => ({
      FaceURL: 'http://shared.example.com/face.png',
      BackURL: 'http://shared.example.com/back.png',
    });
    const root: Record<string, unknown> = {
      ObjectStates: [
        {
          GUID: 'deck00',
          Name: 'Deck',
          CustomDeck: { '1': mkSpec() },
          ContainedObjects: [{ GUID: 'card01', Name: 'Card', CustomDeck: { '1': mkSpec() } }],
        },
        {
          GUID: 'board1',
          Name: 'Custom_Board',
          ChildObjects: [{ GUID: 'chip1', Name: 'Custom_Tile', CustomImage: { ImageURL: 'http://chip.example.com/c.png' } }],
        },
        {
          GUID: 'bag1',
          Name: 'Bag',
          States: {
            alt: { GUID: 'st1', Name: 'Custom_Token', CustomMesh: { DiffuseURL: 'http://state.example.com/d.png' } },
          },
        },
        {
          GUID: 'tbl1',
          Name: 'Custom_Board',
          AttachedDecals: [{ CustomDecal: { ImageURL: 'http://decal.example.com/x.png' } }],
        },
      ],
    };
    const savePath = await writeSave('save.json', root);

    const result = await planReplace({
      savePath,
      rules: [{ from: 'example\\.com', to: 'X', mode: 'regex' }], // 全部 URL 都含 example.com
    });

    expect(result.totalAffected).toBe(7);
    expect(locKeys(result.entries)).toEqual([
      'ObjectStates[0]#CustomDeck.FaceURL',
      'ObjectStates[0]#CustomDeck.BackURL',
      'ObjectStates[0].ContainedObjects[0]#CustomDeck.FaceURL',
      'ObjectStates[0].ContainedObjects[0]#CustomDeck.BackURL',
      'ObjectStates[1].ChildObjects[0]#CustomImage.ImageURL',
      'ObjectStates[2].States.alt#CustomMesh.DiffuseURL',
      'ObjectStates[3].AttachedDecals[0]#CustomDecal.ImageURL',
    ]);
    expect(result.entries.map((e) => e.guid)).toEqual([
      'deck00', 'deck00', 'card01', 'card01', 'chip1', 'st1', '',
    ]);
  });

  it('全部素材字段（14 处）一次遍历齐全，fieldPath 顺序 = walkSaveUrls 固定顺序', async () => {
    const u = (rest: string): string => `http://x.example.com/${rest}`;
    const root: Record<string, unknown> = {
      SkyURL: u('sky.jpg'),
      TableURL: u('table.jpg'),
      ObjectStates: [
        {
          GUID: 'all1',
          Name: 'Custom_Model',
          CustomDeck: { '1': { FaceURL: u('deck/face'), BackURL: u('deck/back') } },
          CustomImage: { ImageURL: u('img/a'), ImageSecondaryURL: u('img/b') },
          CustomMesh: { MeshURL: u('mesh/m'), DiffuseURL: u('mesh/d'), NormalURL: u('mesh/n'), ColliderURL: u('mesh/c') },
          CustomAssetbundle: { AssetbundleURL: u('ab/main'), AssetbundleSecondaryURL: u('ab/sec') },
          CustomDecal: { ImageURL: u('decal/d') },
          CustomPDF: { PDFUrl: u('pdf/doc') },
        },
      ],
    };
    const savePath = await writeSave('save.json', root);

    const result = await planReplace({
      savePath,
      rules: [{ from: 'http://x.example.com/', to: 'https://y.example.com/', mode: 'prefix' }],
    });

    expect(result.totalAffected).toBe(14);
    expect(result.entries.map((e) => e.fieldPath.join('.'))).toEqual([
      'SkyURL',
      'TableURL',
      'CustomDeck.FaceURL',
      'CustomDeck.BackURL',
      'CustomImage.ImageURL',
      'CustomImage.ImageSecondaryURL',
      'CustomMesh.MeshURL',
      'CustomMesh.DiffuseURL',
      'CustomMesh.NormalURL',
      'CustomMesh.ColliderURL',
      'CustomAssetbundle.AssetbundleURL',
      'CustomAssetbundle.AssetbundleSecondaryURL',
      'CustomDecal.ImageURL',
      'CustomPDF.PDFUrl',
    ]);
    expect(result.stats).toEqual({ 'http://x.example.com/': 14 });
  });
});

// ---------------------------------------------------------------------------
// 顺序、输入形式与 dry-run 免改写
// ---------------------------------------------------------------------------

describe('顺序、输入形式与 dry-run 免改写', () => {
  it('entries 顺序 = walkSaveUrls 固定顺序：根直接字段 → 牌堆素材 → 容器下钻', async () => {
    const root: Record<string, unknown> = {
      SkyURL: 'http://s.example.com/sky.jpg',
      TableURL: 'http://s.example.com/table.jpg',
      ObjectStates: [
        {
          GUID: 'deck00',
          Name: 'Deck',
          CustomDeck: { '1': { FaceURL: 'http://s.example.com/atlas/face.png', BackURL: 'http://s.example.com/atlas/back.png' } },
          ContainedObjects: [
            { GUID: 'card01', Name: 'Card', CustomDeck: { '1': { FaceURL: 'http://s.example.com/atlas/face.png', BackURL: 'http://s.example.com/atlas/back.png' } } },
          ],
        },
      ],
    };

    const result = await planReplace({
      savePath: root,
      rules: [{ from: 'http://s.example.com/', to: 'https://t.example.com/', mode: 'prefix' }],
    });

    expect(locKeys(result.entries)).toEqual([
      '#SkyURL',
      '#TableURL',
      'ObjectStates[0]#CustomDeck.FaceURL',
      'ObjectStates[0]#CustomDeck.BackURL',
      'ObjectStates[0].ContainedObjects[0]#CustomDeck.FaceURL',
      'ObjectStates[0].ContainedObjects[0]#CustomDeck.BackURL',
    ]);
  });

  it('savePath 传已解析对象：正常出计划，对象内容前后不变（dry-run）', async () => {
    const { root } = deckFixture();
    const before = JSON.stringify(root);

    const result = await planReplace({
      savePath: root,
      rules: [{ from: FACE, to: 'http://new.example.com/face.png' }],
    });

    expect(result.totalAffected).toBe(1);
    expect(JSON.stringify(root)).toBe(before); // 对象没有被 mutate
  });

  it('savePath 传路径：文件字节前后不变（不写盘）', async () => {
    const { root } = deckFixture();
    const savePath = await writeSave('save.json', root);
    const before = await readFile(savePath, 'utf8');

    await planReplace({ savePath, rules: [{ from: FACE, to: 'http://new.example.com/face.png' }] });

    expect(await readFile(savePath, 'utf8')).toBe(before);
  });

  it('空规则数组：空计划不报错', async () => {
    const { root } = deckFixture();

    const result = await planReplace({ savePath: root, rules: [] });

    expect(result.entries).toEqual([]);
    expect(result.stats).toEqual({});
    expect(result.totalAffected).toBe(0);
  });

  it('空 GUID / 缺 Name 照常出条目（guid 为 ""、entry 上无 name 属性）', async () => {
    const root: Record<string, unknown> = {
      ObjectStates: [{ CustomImage: { ImageURL: FACE } }], // 无 GUID、无 Name（工坊合法形态）
    };

    const result = await planReplace({
      savePath: root,
      rules: [{ from: FACE, to: 'X' }],
    });

    expect(result.totalAffected).toBe(1);
    expect(result.entries[0]!.guid).toBe('');
    expect('name' in result.entries[0]!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 错误路径
// ---------------------------------------------------------------------------

describe('错误路径：PLAN_SAVE_INVALID', () => {
  it('存档不存在 → PLAN_SAVE_INVALID（message 双态：键名或含路径）', async () => {
    const missing = path.join(tempRoot, 'no-such-save.json');

    const err = await expectPlanError(
      planReplace({ savePath: missing, rules: [{ from: FACE, to: 'X' }] }),
      'PLAN_SAVE_INVALID',
      'error.pack.planSaveInvalid',
      'no-such-save.json',
    );
    expect(err instanceof PackError).toBe(true);
  });

  it('存档非法 JSON → PLAN_SAVE_INVALID', async () => {
    const badPath = path.join(tempRoot, 'bad.json');
    await writeFile(badPath, '{oops', 'utf8');

    await expectPlanError(
      planReplace({ savePath: badPath, rules: [{ from: FACE, to: 'X' }] }),
      'PLAN_SAVE_INVALID',
      'error.pack.planSaveInvalid',
      'bad.json',
    );
  });

  it('savePath 形态非法（数组 / 数字）→ PLAN_SAVE_INVALID', async () => {
    await expectPlanError(
      planReplace({ savePath: [1, 2] as unknown as string, rules: [] }),
      'PLAN_SAVE_INVALID',
      'error.pack.planSaveInvalid',
      'savePath',
    );
    await expectPlanError(
      planReplace({ savePath: 42 as unknown as string, rules: [] }),
      'PLAN_SAVE_INVALID',
      'error.pack.planSaveInvalid',
      'savePath',
    );
  });
});

describe('错误路径：PLAN_RULE_INVALID', () => {
  it('regex 语法错误 → PLAN_RULE_INVALID；规则先于存档校验（savePath 也不存在时仍报规则错）', async () => {
    const missing = path.join(tempRoot, 'never-read.json');

    await expectPlanError(
      planReplace({ savePath: missing, rules: [{ from: '(', to: 'X', mode: 'regex' }] }),
      'PLAN_RULE_INVALID',
      'error.pack.planRuleInvalid',
      '正则语法错误',
    );
  });

  it('mode 非法值 / from 非字符串 → PLAN_RULE_INVALID', async () => {
    await expectPlanError(
      planReplace({ savePath: {}, rules: [{ from: FACE, to: 'X', mode: 'glob' } as unknown as ReplaceRule] }),
      'PLAN_RULE_INVALID',
      'error.pack.planRuleInvalid',
      'mode',
    );
    await expectPlanError(
      planReplace({ savePath: {}, rules: [{ from: 42, to: 'X' } as unknown as ReplaceRule] }),
      'PLAN_RULE_INVALID',
      'error.pack.planRuleInvalid',
      'from',
    );
  });

  it('rules 非数组 / 规则非对象 → PLAN_RULE_INVALID', async () => {
    await expectPlanError(
      planReplace({ savePath: {}, rules: 42 as unknown as ReplaceRule[] }),
      'PLAN_RULE_INVALID',
      'error.pack.planRuleInvalid',
      'rules',
    );
    await expectPlanError(
      planReplace({ savePath: {}, rules: [null as unknown as ReplaceRule] }),
      'PLAN_RULE_INVALID',
      'error.pack.planRuleInvalid',
      '键值对象',
    );
  });
});
