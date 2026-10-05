// tests/unit/pack-packyaml-push.test.ts
/**
 * pack.yaml 的 push 子节点单元测试（阶段 5 写入路径）。
 *
 * push 子节点（z.strictObject，整体 optional）：
 * - backup_retention  整数 1~100，缺省 20（push 自动备份的保留数量）；
 * - baseline_check    布尔，缺省 true（push 前基线冲突检测开关）。
 *
 * 向后兼容：pack.yaml 不写 push（旧清单 / init 初始模板）必须合法，
 * 读取结果 push 为 undefined，push 子系统按缺省 {backup_retention: 20,
 * baseline_check: true} 对待；节点出现时内层字段自动填默认值。
 *
 * 纯文件 IO（临时目录）+ schema 直测，无网络、无 TTS。错误按 PackError.code
 * （机器可读）断言，不断言 message（i18n 文案会变）。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PACK_YAML_FILENAME,
  PackError,
  packYamlPath,
  packYamlSchema,
  readPackYaml,
  writePackYaml,
  type PackYaml,
} from '../../src/pack/packyaml.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-packyaml-push-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 只含必填字段、不含 push 节点的最小合法 YAML（旧清单形态） */
const minimalYaml = [
  'schema_version: 1',
  'name: 最小图包',
  'workshop_id: null',
  'source_mod: null',
  'vcs:',
  '  lfs: enabled',
  'paths: {}',
  'upload: {}',
  '',
].join('\n');

/** 在图包根目录直接写一份 pack.yaml（绕过 writePackYaml，构造"手写的清单"） */
async function writeRawPackYaml(root: string, text: string): Promise<void> {
  await writeFile(path.join(root, PACK_YAML_FILENAME), text, 'utf8');
}

/** 字段齐全、带 push 子节点的合法清单 */
const fullPackWithPush: PackYaml = {
  schema_version: 1,
  name: '完整图包',
  workshop_id: null,
  source_mod: null,
  host: 'steamcloud',
  vcs: { lfs: 'disabled-no-lfs' },
  paths: { workdir: '.' },
  upload: { prefix: '' },
  push: { backup_retention: 10, baseline_check: false },
};

/**
 * 断言 fn 抛出指定 code 的 PackError。
 * @param fn 待执行（预期抛 PackError）的异步函数
 * @param code 期望的机器可读错误码
 */
async function expectPackError(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PackError);
    expect((err as PackError).code).toBe(code);
    return;
  }
  throw new Error(`预期抛出 code=${code} 的 PackError，但调用成功了`);
}

// ---------------------------------------------------------------------------
// 向后兼容：缺 push 节点
// ---------------------------------------------------------------------------

describe('缺 push 节点（向后兼容）', () => {
  it('readPackYaml：旧清单不含 push → 合法，push 保持 undefined（不填默认值）', async () => {
    await writeRawPackYaml(tempRoot, minimalYaml);
    const pack = await readPackYaml(tempRoot);
    expect(pack.push).toBeUndefined();
  });

  it('schema 直测：缺 push → 解析成功且 data.push 为 undefined', () => {
    const parsed = packYamlSchema.safeParse({
      schema_version: 1,
      name: 'x',
      workshop_id: null,
      source_mod: null,
      vcs: { lfs: 'enabled' },
      paths: {},
      upload: {},
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.push).toBeUndefined();
    }
  });

  it('push: {}（空节点）→ 内层默认值填充为 backup_retention=20 / baseline_check=true', async () => {
    await writeRawPackYaml(tempRoot, `${minimalYaml}push: {}\n`);
    const pack = await readPackYaml(tempRoot);
    expect(pack.push).toEqual({ backup_retention: 20, baseline_check: true });
  });
});

// ---------------------------------------------------------------------------
// 字段校验
// ---------------------------------------------------------------------------

describe('push.backup_retention', () => {
  it('合法值 10 → 原样保留', async () => {
    await writeRawPackYaml(tempRoot, `${minimalYaml}push:\n  backup_retention: 10\n`);
    const pack = await readPackYaml(tempRoot);
    expect(pack.push).toEqual({ backup_retention: 10, baseline_check: true });
  });

  it('0 拒绝（低于下界）→ PACK_INVALID', async () => {
    await writeRawPackYaml(tempRoot, `${minimalYaml}push:\n  backup_retention: 0\n`);
    await expectPackError(() => readPackYaml(tempRoot), 'PACK_INVALID');
  });

  it('101 拒绝（高于上界）→ PACK_INVALID', async () => {
    await writeRawPackYaml(tempRoot, `${minimalYaml}push:\n  backup_retention: 101\n`);
    await expectPackError(() => readPackYaml(tempRoot), 'PACK_INVALID');
  });

  it('2.5 拒绝（必须是整数）→ PACK_INVALID', async () => {
    await writeRawPackYaml(tempRoot, `${minimalYaml}push:\n  backup_retention: 2.5\n`);
    await expectPackError(() => readPackYaml(tempRoot), 'PACK_INVALID');
  });
});

describe('push.baseline_check 与节点形态', () => {
  it('push.baseline_check: false 合法（显式关闭基线检测）', async () => {
    await writeRawPackYaml(tempRoot, `${minimalYaml}push:\n  baseline_check: false\n`);
    const pack = await readPackYaml(tempRoot);
    expect(pack.push).toEqual({ backup_retention: 20, baseline_check: false });
  });

  it('push.baseline_check 非布尔值 → PACK_INVALID', async () => {
    await writeRawPackYaml(tempRoot, `${minimalYaml}push:\n  baseline_check: "yes"\n`);
    await expectPackError(() => readPackYaml(tempRoot), 'PACK_INVALID');
  });

  it('push 含未知字段（拼写错误必须被拒绝）→ PACK_INVALID', async () => {
    await writeRawPackYaml(
      tempRoot,
      `${minimalYaml}push:\n  backup_retention: 10\n  retention: 5\n`,
    );
    await expectPackError(() => readPackYaml(tempRoot), 'PACK_INVALID');
  });

  it('push 不是键值对象（字符串 / 数组）→ PACK_INVALID', async () => {
    await writeRawPackYaml(tempRoot, `${minimalYaml}push: "no"\n`);
    await expectPackError(() => readPackYaml(tempRoot), 'PACK_INVALID');
    await writeRawPackYaml(tempRoot, `${minimalYaml}push:\n  - 1\n`);
    await expectPackError(() => readPackYaml(tempRoot), 'PACK_INVALID');
  });
});

// ---------------------------------------------------------------------------
// 写入侧（writePackYaml）
// ---------------------------------------------------------------------------

describe('writePackYaml 与 push 节点', () => {
  it('带 push 的清单 write → read 往返一致', async () => {
    await writePackYaml(tempRoot, fullPackWithPush);
    const read = await readPackYaml(tempRoot);
    expect(read).toEqual(fullPackWithPush);
  });

  it('不含 push 的 PackYaml 写入成功（init 初始模板无需包含 push），落盘文本无 push 键', async () => {
    const withoutPush: PackYaml = { ...fullPackWithPush };
    delete withoutPush.push; // push 在 PackYaml 上是可选键，允许删除
    await writePackYaml(tempRoot, withoutPush);
    expect(existsSync(packYamlPath(tempRoot))).toBe(true);
    const read = await readPackYaml(tempRoot);
    expect(read.push).toBeUndefined();
    const raw = await readFile(packYamlPath(tempRoot), 'utf8');
    expect(raw).not.toContain('push');
  });

  it('入参带非法 push（backup_retention: 0）→ PACK_INVALID 且不落盘', async () => {
    const bad = {
      ...fullPackWithPush,
      push: { backup_retention: 0, baseline_check: true },
    } as unknown as PackYaml;
    await expectPackError(() => writePackYaml(tempRoot, bad), 'PACK_INVALID');
    expect(existsSync(packYamlPath(tempRoot))).toBe(false);
  });
});
