// tests/unit/pack-layout.test.ts
/**
 * src/pack/layout.ts 单元测试：图包工作区目录布局与脚本 / UI 命名规则。
 *
 * 纯内存 / 纯文件 IO（临时目录），无网络、无 TTS、无 git 依赖：
 * - ensureLayout：目录齐全、幂等（重复调用不报错）、.gitkeep 归零、
 *   不碰已有文件、不越界创建 pack.yaml / .git 等本模块不负责的产物；
 * - scriptFileName / uiFileName：Global 特例（GUID=-1）、中文与净化规则
 *   （空格 → 下划线、非法字符删除、首尾点 / 下划线 / 空格修剪、全非法名回退 "object"）；
 * - 路径换算与入参校验（空 root / 空 guid / 非字符串 name 抛中文错误）。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PACK_DIRS,
  PACK_LAYOUT_VERSION,
  decksDir,
  ensureLayout,
  objectsDir,
  scriptFileName,
  scriptsDir,
  skeletonPath,
  uiDir,
  uiFileName,
} from '../../src/pack/layout.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-layout-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** 在临时目录下取一个尚未创建的图包根路径（支持多级路径片段） */
function packRoot(...segments: string[]): string {
  return path.join(tempRoot, ...segments);
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

describe('布局常量', () => {
  it('PACK_DIRS 覆盖全部 9 个标准目录（含 .tts 及其 backups / cache 子目录）', () => {
    expect([...PACK_DIRS]).toEqual([
      'scripts',
      'ui',
      'decks',
      'objects',
      'sheets',
      'source',
      '.tts',
      '.tts/backups',
      '.tts/cache',
    ]);
  });

  it('PACK_LAYOUT_VERSION 为 1', () => {
    expect(PACK_LAYOUT_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ensureLayout
// ---------------------------------------------------------------------------

describe('ensureLayout', () => {
  it('在全新的嵌套根目录下创建全部标准目录与 .tts/.gitkeep 占位文件', async () => {
    const root = packRoot('packs', '新图包');
    await ensureLayout(root);

    for (const rel of PACK_DIRS) {
      expect(existsSync(path.join(root, ...rel.split('/'))), `缺少目录 ${rel}`).toBe(true);
    }
    // 嵌套父级也要一并创建（mkdir recursive 语义）
    expect(existsSync(packRoot('packs'))).toBe(true);
    const gitkeep = await readFile(path.join(root, '.tts', '.gitkeep'), 'utf8');
    expect(gitkeep).toBe('');
  });

  it('幂等：连续调用两次不报错，目录与占位文件保持就绪', async () => {
    const root = packRoot('p');
    await ensureLayout(root);
    await expect(ensureLayout(root)).resolves.toBeUndefined();
    for (const rel of PACK_DIRS) {
      expect(existsSync(path.join(root, ...rel.split('/')))).toBe(true);
    }
    expect(await readFile(path.join(root, '.tts', '.gitkeep'), 'utf8')).toBe('');
  });

  it('幂等细节：意外非空的 .gitkeep 会被重新归零', async () => {
    const root = packRoot('p');
    await ensureLayout(root);
    await writeFile(path.join(root, '.tts', '.gitkeep'), '被污染的内容', 'utf8');
    await ensureLayout(root);
    expect(await readFile(path.join(root, '.tts', '.gitkeep'), 'utf8')).toBe('');
  });

  it('不删除 / 不改写已有文件：预置的 pack.yaml 与 scripts/ 下的文件原样保留', async () => {
    const root = packRoot('p');
    await ensureLayout(root);
    await writeFile(path.join(root, 'pack.yaml'), 'name: 预置\n', 'utf8');
    await writeFile(path.join(root, 'scripts', 'abc123.旧对象.lua'), '-- 旧脚本\n', 'utf8');

    await ensureLayout(root);

    expect(await readFile(path.join(root, 'pack.yaml'), 'utf8')).toBe('name: 预置\n');
    expect(await readFile(path.join(root, 'scripts', 'abc123.旧对象.lua'), 'utf8')).toBe('-- 旧脚本\n');
  });

  it('边界：不创建本模块职责之外的产物（pack.yaml / .git / .gitattributes / .gitignore）', async () => {
    const root = packRoot('p');
    await ensureLayout(root);
    expect(existsSync(path.join(root, 'pack.yaml'))).toBe(false);
    expect(existsSync(path.join(root, '.git'))).toBe(false);
    expect(existsSync(path.join(root, '.gitattributes'))).toBe(false);
    expect(existsSync(path.join(root, '.gitignore'))).toBe(false);
    // .tts/ 下只应有布局自带的占位文件与 backups / cache 子目录
    // （skeleton.json 由 unpack / pull 流程负责，本模块不写）
    expect((await readdir(path.join(root, '.tts'))).sort()).toEqual(['.gitkeep', 'backups', 'cache']);
  });

  it('root 为空串 / 纯空白 → 抛中文错误（调用方编程错误）', async () => {
    await expect(ensureLayout('')).rejects.toThrow(/root 必须是非空字符串/);
    await expect(ensureLayout('   ')).rejects.toThrow(/root 必须是非空字符串/);
  });
});

// ---------------------------------------------------------------------------
// 路径换算
// ---------------------------------------------------------------------------

describe('路径换算', () => {
  it('scriptsDir / uiDir / decksDir / objectsDir 拼出对应子目录', () => {
    const root = path.join('some', 'pack');
    expect(scriptsDir(root)).toBe(path.join(root, 'scripts'));
    expect(uiDir(root)).toBe(path.join(root, 'ui'));
    expect(decksDir(root)).toBe(path.join(root, 'decks'));
    expect(objectsDir(root)).toBe(path.join(root, 'objects'));
  });

  it('skeletonPath 指向 .tts/skeleton.json（约束 8：路径只由本模块提供，绝不入 git）', () => {
    const root = path.join('some', 'pack');
    expect(skeletonPath(root)).toBe(path.join(root, '.tts', 'skeleton.json'));
  });

  it('路径换算对空 root 抛中文错误', () => {
    expect(() => scriptsDir('')).toThrow(/root 必须是非空字符串/);
    expect(() => uiDir(' ')).toThrow(/root 必须是非空字符串/);
    expect(() => decksDir('')).toThrow(/root 必须是非空字符串/);
    expect(() => objectsDir('')).toThrow(/root 必须是非空字符串/);
    expect(() => skeletonPath('')).toThrow(/root 必须是非空字符串/);
  });
});

// ---------------------------------------------------------------------------
// scriptFileName / uiFileName 命名规则
// ---------------------------------------------------------------------------

describe('scriptFileName', () => {
  it('普通对象：<guid>.<原名>.lua（中文名原样保留）', () => {
    expect(scriptFileName('abc123', '我的图包')).toBe('abc123.我的图包.lua');
  });

  it('全局脚本：guid="-1" 时文件名固定为 Global.lua（name 为空串）', () => {
    expect(scriptFileName('-1', '')).toBe('Global.lua');
  });

  it('全局脚本：guid="-1" 时忽略 name（非空名也输出 Global.lua）', () => {
    expect(scriptFileName('-1', 'Chess Pawn')).toBe('Global.lua');
  });

  it('空格转下划线（含连续空白与 tab）', () => {
    expect(scriptFileName('abc123', 'Chess Pawn')).toBe('abc123.Chess_Pawn.lua');
    expect(scriptFileName('abc123', 'a  b\tc')).toBe('abc123.a_b_c.lua');
  });

  it('删除 Windows 非法字符（斜杠 / 反斜杠 / 问号 / 星号 / 冒号 / 竖线 / 引号 / 尖括号 / 百分号）', () => {
    expect(scriptFileName('abc123', 'a/b\\c')).toBe('abc123.abc.lua');
    expect(scriptFileName('abc123', 'what?*name:|"<x>%')).toBe('abc123.whatnamex.lua');
  });

  it('修剪首尾的点 / 下划线 / 空格（Windows 会静默截断结尾的点与空格）', () => {
    expect(scriptFileName('abc123', '..hidden')).toBe('abc123.hidden.lua');
    expect(scriptFileName('abc123', '_private_')).toBe('abc123.private.lua');
    expect(scriptFileName('abc123', 'name. ')).toBe('abc123.name.lua');
  });

  it('名字为空 / 全部非法字符时回退 "object"', () => {
    expect(scriptFileName('abc123', '')).toBe('abc123.object.lua');
    expect(scriptFileName('abc123', '///')).toBe('abc123.object.lua');
    expect(scriptFileName('abc123', '   ')).toBe('abc123.object.lua');
  });

  it('guid 为空串 / 纯空白 → 抛中文错误', () => {
    expect(() => scriptFileName('', 'x')).toThrow(/guid 必须是非空字符串/);
    expect(() => scriptFileName('  ', 'x')).toThrow(/guid 必须是非空字符串/);
  });

  it('name 非字符串 → 抛中文错误（运行时防御，绕过编译期类型）', () => {
    const unsafe = scriptFileName as unknown as (guid: unknown, name: unknown) => string;
    expect(() => unsafe('abc123', 42)).toThrow(/name 必须是字符串/);
    expect(() => unsafe('abc123', null)).toThrow(/name 必须是字符串/);
  });
});

describe('uiFileName', () => {
  it('普通对象：<guid>.<原名>.xml；全局 UI：guid="-1" → Global.xml', () => {
    expect(uiFileName('abc123', '我的图包')).toBe('abc123.我的图包.xml');
    expect(uiFileName('-1', '')).toBe('Global.xml');
  });

  it('与 scriptFileName 共用同一套净化规则（空格 / 非法字符 / 回退 object）', () => {
    expect(uiFileName('abc123', 'Chess Pawn')).toBe('abc123.Chess_Pawn.xml');
    expect(uiFileName('abc123', 'a/b')).toBe('abc123.ab.xml');
    expect(uiFileName('abc123', '')).toBe('abc123.object.xml');
  });

  it('guid 为空串 → 抛中文错误', () => {
    expect(() => uiFileName('', 'x')).toThrow(/guid 必须是非空字符串/);
  });
});
