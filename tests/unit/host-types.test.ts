// tests/unit/host-types.test.ts
/**
 * src/host/types.ts 单元测试：ImageHost 契约的共享运行时助手。
 *
 * 纯内存校验（无网络、无文件 IO）：
 * - validateUploadFiles：合法文件透传、结构非法 / 空列表 / 重名（含归一化后重名）
 *   一律抛 PackError("HOST_INVALID_INPUT")——按机器可读 code 断言，不依赖错误文案；
 * - safeObjectName：反斜杠归一化、"." 段丢弃、"."/".." 拒绝；
 * - parseUploadOptions：字段可选，类型 / 范围非法报错；
 * - probeHttpLiveness 不在本文件测（走网络），由 host-steamcloud / host-command 的
 *   check 用例借本地 HTTP 服务器覆盖。
 */
import { describe, expect, it } from 'vitest';

import { PackError } from '../../src/pack/packyaml.js';
import {
  BUILTIN_HOST_IDS,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  parseUploadOptions,
  safeObjectName,
  validateUploadFiles,
} from '../../src/host/types.js';
import type { File } from '../../src/host/types.js';

/**
 * 断言 fn 抛出指定 code 的 PackError，并返回该错误。
 * @param fn 待执行（预期抛 PackError）的函数
 * @param code 期望的机器可读错误码
 * @returns 实际抛出的 PackError
 */
function expectHostError(fn: () => unknown, code: string): PackError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PackError);
    const packError = err as PackError;
    expect(packError.code).toBe(code);
    expect(packError.message.length).toBeGreaterThan(0);
    return packError;
  }
  throw new Error(`预期抛出 code=${code} 的 PackError，但调用成功了`);
}

/** 与 expectHostError 对应的异步版本 */
async function expectHostErrorAsync(fn: () => Promise<unknown> | unknown, code: string): Promise<PackError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PackError);
    const packError = err as PackError;
    expect(packError.code).toBe(code);
    expect(packError.message.length).toBeGreaterThan(0);
    return packError;
  }
  throw new Error(`预期抛出 code=${code} 的 PackError，但调用成功了`);
}

describe('常量', () => {
  it('BUILTIN_HOST_IDS 为内置四种图床类型；DEFAULT_UPLOAD_TIMEOUT_MS 为 120 秒', () => {
    expect([...BUILTIN_HOST_IDS]).toEqual(['steamcloud', 's3', 'local', 'command']);
    expect(DEFAULT_UPLOAD_TIMEOUT_MS).toBe(120_000);
  });
});

describe('validateUploadFiles', () => {
  it('合法文件透传（Buffer 可作 data；name 去首尾空白）', () => {
    const files: File[] = [
      { name: '  atlas.png  ', data: Buffer.from('png-bytes'), mime: 'image/png' },
      { name: 'decks/hero.png', data: Buffer.from([1, 2, 3]) },
    ];
    const validated = validateUploadFiles(files);
    expect(validated).toHaveLength(2);
    expect(validated[0]?.name).toBe('atlas.png');
    expect(validated[0]?.data).toBeInstanceOf(Uint8Array);
    expect(validated[1]?.mime).toBeUndefined();
  });

  it('非数组 / 空数组 → HOST_INVALID_INPUT', async () => {
    await expectHostErrorAsync(() => validateUploadFiles('nope' as unknown as File[]), 'HOST_INVALID_INPUT');
    await expectHostErrorAsync(() => validateUploadFiles([]), 'HOST_INVALID_INPUT');
  });

  it('缺 name / name 为空 / data 非 Uint8Array → HOST_INVALID_INPUT', async () => {
    await expectHostErrorAsync(
      () => validateUploadFiles([{ data: Buffer.from('x') } as unknown as File]),
      'HOST_INVALID_INPUT',
    );
    await expectHostErrorAsync(
      () => validateUploadFiles([{ name: '   ', data: Buffer.from('x') }]),
      'HOST_INVALID_INPUT',
    );
    await expectHostErrorAsync(
      () => validateUploadFiles([{ name: 'a.png', data: 'not-bytes' } as unknown as File]),
      'HOST_INVALID_INPUT',
    );
  });

  it('未知字段拒绝（严格模式，防拼写错误静默生效）', async () => {
    await expectHostErrorAsync(
      () => validateUploadFiles([{ name: 'a.png', data: Buffer.from('x'), filename: 'a.png' } as unknown as File]),
      'HOST_INVALID_INPUT',
    );
  });

  it('重名拒绝（含首尾空白 / 反斜杠归一化后的重名）', async () => {
    await expectHostErrorAsync(
      () => validateUploadFiles([
        { name: 'a.png', data: Buffer.from('1') },
        { name: 'a.png', data: Buffer.from('2') },
      ]),
      'HOST_INVALID_INPUT',
    );
    await expectHostErrorAsync(
      () => validateUploadFiles([
        { name: 'a/b.png', data: Buffer.from('1') },
        { name: 'a\\b.png', data: Buffer.from('2') },
      ]),
      'HOST_INVALID_INPUT',
    );
  });
});

describe('safeObjectName', () => {
  it('反斜杠归一化为 /，丢弃空段与 "." 段', () => {
    expect(safeObjectName('a\\b.png')).toBe('a/b.png');
    expect(safeObjectName('/x/./y/')).toBe('x/y');
    expect(safeObjectName('plain.png')).toBe('plain.png');
  });

  it('".." 段与空结果 → HOST_INVALID_INPUT（防目录穿越）', () => {
    expectHostError(() => safeObjectName('../etc/passwd'), 'HOST_INVALID_INPUT');
    expectHostError(() => safeObjectName('a/../b'), 'HOST_INVALID_INPUT');
    expectHostError(() => safeObjectName(''), 'HOST_INVALID_INPUT');
    expectHostError(() => safeObjectName('.'), 'HOST_INVALID_INPUT');
  });
});

describe('parseUploadOptions', () => {
  it('undefined 与空对象 → 空选项', () => {
    expect(parseUploadOptions(undefined)).toEqual({});
    expect(parseUploadOptions({})).toEqual({});
  });

  it('合法字段透传（timeoutMs / stagingDir / signal）', () => {
    const signal = new AbortController().signal;
    const opts = parseUploadOptions({ timeoutMs: 5_000, stagingDir: 'D:/tmp/stage', signal });
    expect(opts.timeoutMs).toBe(5_000);
    expect(opts.stagingDir).toBe('D:/tmp/stage');
    expect(opts.signal).toBe(signal);
  });

  it('timeoutMs 非正整数 / stagingDir 空串 / signal 类型错 → HOST_INVALID_INPUT', async () => {
    await expectHostErrorAsync(() => parseUploadOptions({ timeoutMs: 0 }), 'HOST_INVALID_INPUT');
    await expectHostErrorAsync(() => parseUploadOptions({ timeoutMs: 1.5 }), 'HOST_INVALID_INPUT');
    await expectHostErrorAsync(() => parseUploadOptions({ stagingDir: '' }), 'HOST_INVALID_INPUT');
    await expectHostErrorAsync(
      () => parseUploadOptions({ signal: 'not-a-signal' } as unknown as Parameters<typeof parseUploadOptions>[0]),
      'HOST_INVALID_INPUT',
    );
  });
});
