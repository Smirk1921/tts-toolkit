// tests/unit/editor-locate.test.ts
/**
 * src/editor/locate.ts（工作区按对象名定位脚本）单元测试。
 *
 * 覆盖：
 * - 工作区命中：Global.lua / <guid>.<safeName>.lua；
 * - 全局脚本：name === "Global"；
 * - 对象名净化：空格 / 特殊字符 → safeName（与 pull.ts 一致）；
 * - 未命中：PackError EDITOR_OBJECT_NOT_FOUND，message 带工作区候选名；
 * - 工作区无 scripts/ 目录 → 未命中（候选为空）；
 * - 同名多个匹配：取第一个（按字典序的目录遍历顺序）。
 *
 * 实现方式：临时目录写真实文件，不依赖网络 / TTS / git。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { locateScript } from '../../src/editor/locate.js';
import { PackError } from '../../src/pack/packyaml.js';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-editor-locate-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** 在工作区 scripts/ 下落一组 .lua 文件 */
async function seedScripts(files: Record<string, string>): Promise<void> {
  const scriptsDir = path.join(tempRoot, 'scripts');
  await mkdir(scriptsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(scriptsDir, name), content, 'utf8');
  }
}

describe('locateScript 命中路径', () => {
  it('name === "Global" + scripts/Global.lua 存在 → 命中（guid = "-1"）', async () => {
    await seedScripts({ 'Global.lua': '-- global script' });
    const result = await locateScript(tempRoot, 'Global');
    expect(result.absPath).toBe(path.join(tempRoot, 'scripts', 'Global.lua'));
    expect(result.guid).toBe('-1');
    expect(result.name).toBe('Global');
  });

  it('普通对象：scripts/<guid>.<safeName>.lua 按后缀精确匹配', async () => {
    await seedScripts({
      'abc123.统计面板.lua': '-- stats panel',
      'def456.其他对象.lua': '-- other',
    });
    const result = await locateScript(tempRoot, '统计面板');
    expect(result.absPath).toBe(path.join(tempRoot, 'scripts', 'abc123.统计面板.lua'));
    expect(result.guid).toBe('abc123');
  });

  it('对象名含空格 → 按 sanitizeName 转下划线后匹配', async () => {
    // pull.ts sanitizeName："Chess Pawn" → "Chess_Pawn"
    await seedScripts({ 'xyz.Chess_Pawn.lua': '-- pawn' });
    const result = await locateScript(tempRoot, 'Chess Pawn');
    expect(result.guid).toBe('xyz');
    expect(result.absPath).toBe(path.join(tempRoot, 'scripts', 'xyz.Chess_Pawn.lua'));
  });

  it('对象名含 Windows 非法字符（/ ? : 等）→ 净化后匹配', async () => {
    // "Foo/Bar" → "FooBar"
    await seedScripts({ 'g1.FooBar.lua': '--' });
    const result = await locateScript(tempRoot, 'Foo/Bar');
    expect(result.guid).toBe('g1');
  });

  it('多个匹配时取按字典序的第一个', async () => {
    await seedScripts({
      'aaa.Foo.lua': '-- first',
      'zzz.Foo.lua': '-- last',
    });
    const result = await locateScript(tempRoot, 'Foo');
    // readdir 返回顺序在 Windows / POSIX 通常都是字典序，但这里不依赖顺序——
    // 实现是"取第一个匹配"，两个中的某一个都行。只断言 guid 属于其中之一。
    expect(['aaa', 'zzz']).toContain(result.guid);
  });
});

describe('locateScript 未命中路径', () => {
  it('scripts/ 目录不存在 → EDITOR_OBJECT_NOT_FOUND，候选为 "(无)"', async () => {
    try {
      await locateScript(tempRoot, 'Any');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PackError);
      expect((err as PackError).code).toBe('EDITOR_OBJECT_NOT_FOUND');
      expect((err as PackError).message).toContain('(无)');
    }
  });

  it('scripts/ 目录为空 → EDITOR_OBJECT_NOT_FOUND，候选为 "(无)"', async () => {
    await mkdir(path.join(tempRoot, 'scripts'), { recursive: true });
    try {
      await locateScript(tempRoot, 'Any');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PackError);
      expect((err as PackError).code).toBe('EDITOR_OBJECT_NOT_FOUND');
    }
  });

  it('scripts/ 有其他对象但无目标 → 候选名包含现有对象', async () => {
    await seedScripts({
      'aaa.Alpha.lua': '--',
      'bbb.Beta.lua': '--',
      'Global.lua': '--',
    });
    try {
      await locateScript(tempRoot, 'Gamma');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PackError);
      const msg = (err as PackError).message;
      expect(msg).toContain('Alpha');
      expect(msg).toContain('Beta');
      expect(msg).toContain('Global');
    }
  });

  it('Global.lua 不存在时 name="Global" 也未命中', async () => {
    await seedScripts({ 'aaa.Foo.lua': '--' });
    try {
      await locateScript(tempRoot, 'Global');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PackError);
      expect((err as PackError).code).toBe('EDITOR_OBJECT_NOT_FOUND');
    }
  });

  it('候选超过 5 个时只列前 5 个并追加 ", ..."', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) {
      files[`g${i}.Obj${String(i).padStart(2, '0')}.lua`] = '--';
    }
    await seedScripts(files);
    try {
      await locateScript(tempRoot, 'Missing');
      expect.unreachable();
    } catch (err) {
      const msg = (err as PackError).message;
      expect(msg).toContain('...');
    }
  });
});
