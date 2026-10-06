// tests/unit/publish-bson.test.ts
/**
 * src/publish/bson.ts 单元测试：TTS 存档 JSON → 工坊上传用 BSON 载荷（窗口 G 阶段 7，B1 产出）。
 *
 * 覆盖：
 * - buildBson 正常路径：简单 JSON、含中文（UTF-8）、嵌套 ObjectStates 大对象；
 *   返回值契约（outPath 绝对路径、byteLength === headerLength）与落盘内容
 *   （前 4 字节小端整数 == 文件大小，§2.4 实测格式）；
 * - 错误路径：输入不存在 / 非法 JSON / 顶层不是对象 → PUBLISH_JSON_NOT_FOUND /
 *   PUBLISH_JSON_INVALID；输出已存在 + overwrite=false → PUBLISH_OUTPUT_EXISTS；
 *   overwrite=true 与缺省（默认 true）时正常覆盖；
 * - verifyBsonFile：合法 BSON ok:true；伪造（头部与大小不符）ok:false；
 *   不足 4 字节 ok:false；
 * - 往返等价：buildBson → bson.deserialize 深度等于原 JSON。
 *
 * 纯文件 IO（os.tmpdir() 下的临时目录，mkdtemp 造夹具），无网络、无 TTS：
 * 错误按 PackError.code（机器可读）断言，不依赖错误文案——文案走 t()，
 * locales/*.json 由 Stage C 补齐，缺键时 t() 原样输出键名。
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { deserialize } from 'bson';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildBson, verifyBsonFile } from '../../src/publish/bson.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-bson-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具辅助
// ---------------------------------------------------------------------------

/** 写一个 JSON 文件到临时目录，返回其路径 */
async function writeJson(fileName: string, doc: unknown): Promise<string> {
  const filePath = path.join(tempRoot, fileName);
  await writeFile(filePath, JSON.stringify(doc, null, 2), 'utf8');
  return filePath;
}

/** 写一段（非法）文本文件到临时目录，返回其路径 */
async function writeText(fileName: string, content: string): Promise<string> {
  const filePath = path.join(tempRoot, fileName);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

/** 简单 TTS 存档形状的对象（SaveName + 单对象） */
function simpleSave(): Record<string, unknown> {
  return {
    SaveName: 'test',
    ObjectStates: [{ GUID: 'abc123', Name: 'Card', Transform: { posX: 1.5 } }],
  };
}

/**
 * 伪造一个"前 4 字节与文件大小不符"的 BSON：头部声称 1 字节，实际 5 字节。
 * @returns 伪造文件的路径
 */
async function writeForgedBson(): Promise<string> {
  const filePath = path.join(tempRoot, 'forged.bson');
  await writeFile(filePath, Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00]));
  return filePath;
}

// ---------------------------------------------------------------------------
// buildBson：正常路径
// ---------------------------------------------------------------------------

describe('buildBson 正常路径', () => {
  it('简单 JSON → BSON 成功：返回绝对路径、byteLength === headerLength、文件落盘', async () => {
    const jsonPath = await writeJson('save.json', simpleSave());
    const outPath = path.join(tempRoot, 'out.bson');

    const result = await buildBson({ jsonPath, outPath });

    expect(result.outPath).toBe(path.resolve(outPath));
    expect(result.byteLength).toBe(result.headerLength);
    expect(result.byteLength).toBeGreaterThan(0);
    // 文件确实落盘且大小与返回值一致
    const info = await stat(result.outPath);
    expect(info.size).toBe(result.byteLength);
  });

  it('生成的 BSON 前 4 字节小端整数 == 文件大小（§2.4 格式自检，直接读盘验证）', async () => {
    const jsonPath = await writeJson('save.json', simpleSave());
    const outPath = path.join(tempRoot, 'header.bson');

    const result = await buildBson({ jsonPath, outPath });
    const buf = await readFile(outPath);

    expect(buf.length).toBe(result.byteLength);
    expect(buf.readUInt32LE(0)).toBe(buf.length);
  });

  it('序列化包含中文的 JSON：UTF-8 往返无损', async () => {
    const doc = {
      SaveName: '测试图包',
      ObjectStates: [{ GUID: 'abc123', Name: '牌堆', Description: '中文描述——含标点，' }],
    };
    const jsonPath = await writeJson('zh.json', doc);

    const result = await buildBson({ jsonPath, outPath: path.join(tempRoot, 'zh.bson') });
    const buf = await readFile(result.outPath);
    const roundTripped = deserialize(buf) as Record<string, unknown>;

    expect((roundTripped.SaveName as string)).toBe('测试图包');
    const obj = (roundTripped.ObjectStates as Array<Record<string, unknown>>)[0];
    expect(obj.Name).toBe('牌堆');
    expect(obj.Description).toBe('中文描述——含标点，');
  });

  it('序列化大对象（嵌套 ObjectStates 数组）：字节数与深度往返正确', async () => {
    const bigObjectStates = Array.from({ length: 500 }, (_, i) => ({
      GUID: `guid-${i}`,
      Name: `Card ${i}`,
      // posZ 取 -(i+1)：避开 i=0 时的 -0（JSON.stringify(-0) 落盘变 "0"，而
      // toEqual 按 Object.is 区分 -0 与 0，会造成夹具自身的假差异）
      Transform: { posX: i * 1.5, posY: 0, posZ: -(i + 1), rotX: 0, rotY: i % 360, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
      LuaScript: `-- script for ${i}`,
      ContainedObjects: [{ GUID: `child-${i}-a`, Name: 'Inner' }],
    }));
    const doc = { SaveName: 'big', ObjectStates: bigObjectStates };
    const jsonPath = await writeJson('big.json', doc);

    const result = await buildBson({ jsonPath, outPath: path.join(tempRoot, 'big.bson') });

    // 500 个对象的存档体量在数万字节量级（守住"确实序列化了全部内容"的下限）
    expect(result.byteLength).toBeGreaterThan(10_000);
    const buf = await readFile(result.outPath);
    const roundTripped = deserialize(buf) as { ObjectStates: unknown[] };
    expect(roundTripped.ObjectStates).toHaveLength(500);
    expect(roundTripped).toEqual(doc);
  });
});

// ---------------------------------------------------------------------------
// buildBson：错误路径
// ---------------------------------------------------------------------------

describe('buildBson 错误路径', () => {
  it('JSON 文件不存在时抛 PackError("PUBLISH_JSON_NOT_FOUND")', async () => {
    const missing = path.join(tempRoot, 'no-such-file.json');

    await expect(buildBson({ jsonPath: missing, outPath: path.join(tempRoot, 'out.bson') })).rejects.toMatchObject({
      name: 'PackError',
      code: 'PUBLISH_JSON_NOT_FOUND',
    });
  });

  it('JSON 非法时抛 PackError("PUBLISH_JSON_INVALID")', async () => {
    const bad = await writeText('bad.json', 'not json {{{');

    await expect(buildBson({ jsonPath: bad, outPath: path.join(tempRoot, 'out.bson') })).rejects.toMatchObject({
      name: 'PackError',
      code: 'PUBLISH_JSON_INVALID',
    });
  });

  it('JSON 顶层不是对象（null / 数组 / 字符串）时抛 PackError("PUBLISH_JSON_INVALID")', async () => {
    for (const [fileName, content] of [
      ['null.json', 'null'],
      ['array.json', '[1,2,3]'],
      ['string.json', '"just a string"'],
    ] as const) {
      const filePath = await writeText(fileName, content);
      await expect(
        buildBson({ jsonPath: filePath, outPath: path.join(tempRoot, 'out.bson') }),
      ).rejects.toMatchObject({ code: 'PUBLISH_JSON_INVALID' });
    }
  });

  it('outPath 已存在 + overwrite=false 时抛 PackError("PUBLISH_OUTPUT_EXISTS")，且原文件未被改动', async () => {
    const jsonPath = await writeJson('save.json', simpleSave());
    const outPath = path.join(tempRoot, 'keep.bson');
    await writeFile(outPath, Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]));

    await expect(
      buildBson({ jsonPath, outPath, overwrite: false }),
    ).rejects.toMatchObject({ name: 'PackError', code: 'PUBLISH_OUTPUT_EXISTS' });

    // 原文件内容保持不变（拒绝发生在写入之前）
    const untouched = await readFile(outPath);
    expect([...untouched]).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it('outPath 已存在 + overwrite=true 时正常覆盖', async () => {
    const jsonPath = await writeJson('save.json', simpleSave());
    const outPath = path.join(tempRoot, 'over.bson');
    await writeFile(outPath, Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00]));

    const result = await buildBson({ jsonPath, outPath, overwrite: true });

    expect(result.byteLength).toBe(result.headerLength);
    const buf = await readFile(outPath);
    expect(buf.readUInt32LE(0)).toBe(buf.length);
    expect((deserialize(buf) as Record<string, unknown>).SaveName).toBe('test');
  });

  it('outPath 已存在 + 缺省 overwrite（默认 true）时正常覆盖', async () => {
    const jsonPath = await writeJson('save.json', simpleSave());
    const outPath = path.join(tempRoot, 'default.bson');
    await writeFile(outPath, 'stale content');

    const result = await buildBson({ jsonPath, outPath });

    const buf = await readFile(outPath);
    expect(result.byteLength).toBe(buf.length);
    expect(buf.readUInt32LE(0)).toBe(buf.length);
  });
});

// ---------------------------------------------------------------------------
// verifyBsonFile
// ---------------------------------------------------------------------------

describe('verifyBsonFile', () => {
  it('对 buildBson 产出的合法 BSON 返回 ok: true', async () => {
    const jsonPath = await writeJson('save.json', simpleSave());
    const { outPath } = await buildBson({ jsonPath, outPath: path.join(tempRoot, 'ok.bson') });

    const verdict = await verifyBsonFile(outPath);

    expect(verdict.ok).toBe(true);
    expect(verdict.byteLength).toBe(verdict.headerLength);
    expect(verdict.byteLength).toBeGreaterThan(0);
  });

  it('对伪造的（前 4 字节与文件大小不符）BSON 返回 ok: false，并如实报告两个长度', async () => {
    const forged = await writeForgedBson();

    const verdict = await verifyBsonFile(forged);

    expect(verdict.ok).toBe(false);
    expect(verdict.headerLength).toBe(1);
    expect(verdict.byteLength).toBe(5);
  });

  it('对不足 4 字节的文件返回 ok: false（无可读头，不抛错）', async () => {
    const tiny = await writeText('tiny.bson', 'ab');

    const verdict = await verifyBsonFile(tiny);

    expect(verdict.ok).toBe(false);
    expect(verdict.byteLength).toBe(2);
    expect(verdict.headerLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 往返等价
// ---------------------------------------------------------------------------

describe('往返等价', () => {
  it('buildBson → deserialize 深度等于原 JSON', async () => {
    const doc = {
      SaveName: 'round-trip',
      SaveVersion: 1,
      Rules: '',
      TabStates: { LuaScript: '', Ui: '' },
      ObjectStates: [
        { GUID: 'abc123', Name: 'Deck', Transform: { posX: -2.5, scaleZ: 1 }, ContainedObjects: [] },
        { GUID: 'def456', Name: 'Card', Nickname: '带中文的牌' },
      ],
    };
    const jsonPath = await writeJson('rt.json', doc);

    const { outPath } = await buildBson({ jsonPath, outPath: path.join(tempRoot, 'rt.bson') });
    const buf = await readFile(outPath);
    const roundTripped = deserialize(buf);

    expect(roundTripped).toEqual(doc);
  });
});
