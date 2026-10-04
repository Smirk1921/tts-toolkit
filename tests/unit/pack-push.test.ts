// tests/unit/pack-push.test.ts
/**
 * src/pack/push.ts 单元测试：收集"将推回 TTS"的脚本 / UI 清单（骨架实现）。
 *
 * 纯文件 IO（os.tmpdir() 下的临时目录，mkdtemp + rm -rf），无网络、无 TTS：
 * collectPushItems 只读 pack.yaml 与工作区文件，不连 39998、不调 saveAndPlay
 * （约束 7：push 协议不接收素材字段，本骨架只收集 .lua / .xml，不碰任何 URL）。
 *
 * 覆盖：
 * - 必备夹具（scripts/Global.lua + scripts/abc.测试.lua + ui/Global.xml）：
 *   items 恰好 2 条，Global 排最前且 guid="-1" 同时带 scriptPath / uiPath，
 *   abc 带 scriptPath 而 uiPath 缺省（没有 ui/abc.测试.xml）；note 与 t() 契约一致；
 * - 合并规则：同一 guid 的 .lua 与 .xml 合成一条；name 取先扫描的 scripts/；
 *   名字段允许含点（Deck.v2）；散落文件 / 非法 guid 形状 / 其他扩展名静默跳过；
 * - 边界与错误：空工作区（没有 scripts/ ui/）→ 空清单；缺 pack.yaml → PACK_NOT_FOUND。
 *
 * 错误按 PackError.code（机器可读）断言，不依赖错误文案。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { t } from '../../src/i18n/index.js';
import { writePackYaml } from '../../src/pack/packyaml.js';
import { collectPushItems } from '../../src/pack/push.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-push-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/**
 * 建一个带合法 pack.yaml 的工作区根目录（不建 scripts/ ui/，按用例自行落文件）。
 * @returns 工作区根目录
 */
async function makePackRoot(): Promise<string> {
  const root = path.join(tempRoot, 'pack');
  await writePackYaml(root, {
    schema_version: 1,
    name: '推送测试图包',
    workshop_id: null,
    source_mod: null,
    host: 'steamcloud',
    vcs: { lfs: 'disabled-no-lfs' },
    paths: { workdir: '.' },
    upload: { prefix: '' },
  });
  return root;
}

/** 往 <root>/scripts/ 落一个脚本文件（自动建目录） */
async function writeScript(root: string, fileName: string, content: string): Promise<string> {
  const dir = path.join(root, 'scripts');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  await writeFile(file, content, 'utf8');
  return file;
}

/** 往 <root>/ui/ 落一个 UI 文件（自动建目录） */
async function writeUi(root: string, fileName: string, content: string): Promise<string> {
  const dir = path.join(root, 'ui');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  await writeFile(file, content, 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('collectPushItems（清单收集）', () => {
  it('必备夹具：items 恰 2 条，Global 最前且 guid="-1"，abc 无 UI 时 uiPath 缺省', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global');
    await writeScript(root, 'abc.测试.lua', '--abc');
    await writeUi(root, 'Global.xml', '<Panel id="global" />');

    const result = await collectPushItems({ root });

    expect(result.items).toHaveLength(2);
    expect(result.wouldPush).toBe(2);
    // note 是 t() 的渲染结果：钉住键与 {count} 参数契约（键缺失时两侧同为键名，断言也成立）
    expect(result.note).toBe(t('cli.pack.push.note', { count: 2 }));

    // Global（guid "-1"）排最前，脚本 + UI 记在同一条（绝对路径）
    const [globalItem, abcItem] = result.items;
    expect(globalItem).toEqual({
      guid: '-1',
      name: 'Global',
      scriptPath: path.join(root, 'scripts', 'Global.lua'),
      uiPath: path.join(root, 'ui', 'Global.xml'),
    });

    // abc：只有脚本；没有 ui/abc.测试.xml → uiPath 未设置
    expect(abcItem).toEqual({
      guid: 'abc',
      name: '测试',
      scriptPath: path.join(root, 'scripts', 'abc.测试.lua'),
    });
    expect(abcItem.uiPath).toBeUndefined();
  }, 30_000);

  it('合并规则：同 guid 的 .lua/.xml 合成一条；name 取 scripts；散落文件静默跳过', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'aa11bb.棋子.lua', '--pawn');
    await writeUi(root, 'aa11bb.棋子.xml', '<Panel id="pawn" />');
    await writeScript(root, 'cc22dd.Deck.v2.lua', '--deck'); // 名字段可含点 → name = "Deck.v2"
    await writeScript(root, 'noguid.lua', '--orphan'); // guid 形状不符：跳过
    await writeFile(path.join(root, 'ui', 'readme.txt'), 'not ui', 'utf8'); // 扩展名不符：跳过

    const result = await collectPushItems({ root });

    expect(result.items).toHaveLength(2);
    // 两条都是普通 guid（无 Global）：按 guid 字典序
    expect(result.items.map((item) => item.guid)).toEqual(['aa11bb', 'cc22dd']);

    const merged = result.items[0];
    expect(merged.name).toBe('棋子'); // 先扫 scripts/，ui/ 只补路径不改 name
    expect(merged.scriptPath).toBe(path.join(root, 'scripts', 'aa11bb.棋子.lua'));
    expect(merged.uiPath).toBe(path.join(root, 'ui', 'aa11bb.棋子.xml'));

    const dotted = result.items[1];
    expect(dotted.name).toBe('Deck.v2');
    expect(dotted.scriptPath).toBe(path.join(root, 'scripts', 'cc22dd.Deck.v2.lua'));
    expect(dotted.uiPath).toBeUndefined();
  }, 30_000);

  it('空工作区：没有 scripts/ 与 ui/ 目录 → 空清单、wouldPush=0，不报错', async () => {
    const root = await makePackRoot();

    const result = await collectPushItems({ root });

    expect(result.items).toEqual([]);
    expect(result.wouldPush).toBe(0);
    expect(result.note).toBe(t('cli.pack.push.note', { count: 0 }));
  }, 30_000);

  it('错误路径：缺 pack.yaml → PackError code="PACK_NOT_FOUND"', async () => {
    const missing = path.join(tempRoot, 'not-a-pack');

    await expect(collectPushItems({ root: missing })).rejects.toMatchObject({ code: 'PACK_NOT_FOUND' });
  });
});
