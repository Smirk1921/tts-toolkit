// tests/unit/pack-layout-baseline.test.ts
/**
 * src/pack/layout.ts 的 baselinePath 单元测试（阶段 5 写入路径）。
 *
 * 纯内存 / 纯文件 IO（临时目录），无网络、无 TTS：
 * - 路径拼接：`<root>/.tts/baseline.json`、中文 root、相对路径原样拼接（不 resolve）；
 * - 入参校验：空 / 空白 root 抛中文错误（与 skeletonPath 同款 assertRoot）；
 * - 与 skeletonPath 同级：同一 .tts/ 目录、不同文件名，且 ensureLayout 后目录真实存在。
 *
 * baseline.json 的读写行为（内容、错误码）归 safety/baseline.ts，
 * 由 tests/unit/safety-baseline.test.ts 覆盖；本文件只测 layout 侧的路径换算。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { baselinePath, ensureLayout, skeletonPath } from '../../src/pack/layout.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-layout-baseline-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('baselinePath', () => {
  it('拼出 <root>/.tts/baseline.json', () => {
    expect(baselinePath(path.join('some', 'pack'))).toBe(
      path.join('some', 'pack', '.tts', 'baseline.json'),
    );
  });

  it('中文 root 正确拼接', () => {
    const root = path.join(tempRoot, '冒险图包');
    expect(baselinePath(root)).toBe(path.join(root, '.tts', 'baseline.json'));
  });

  it('相对路径原样拼接（不 resolve）', () => {
    expect(baselinePath('rel/pack')).toBe(path.join('rel/pack', '.tts', 'baseline.json'));
    expect(path.isAbsolute(baselinePath('rel/pack'))).toBe(false);
  });

  it('空 / 空白 root 抛中文错误（assertRoot 入参校验）', () => {
    expect(() => baselinePath('')).toThrow('root 必须是非空字符串路径');
    expect(() => baselinePath('   ')).toThrow('root 必须是非空字符串路径');
  });

  it('与 skeletonPath 同级：同一 .tts/ 目录、文件名不同；ensureLayout 后目录真实存在', async () => {
    const root = path.join(tempRoot, 'pack');
    expect(path.dirname(baselinePath(root))).toBe(path.dirname(skeletonPath(root)));
    expect(path.basename(baselinePath(root))).toBe('baseline.json');
    expect(path.basename(skeletonPath(root))).toBe('skeleton.json');

    await ensureLayout(root); // .tts/ 目录由标准布局保证存在
    expect(existsSync(path.dirname(baselinePath(root)))).toBe(true);
  });
});
