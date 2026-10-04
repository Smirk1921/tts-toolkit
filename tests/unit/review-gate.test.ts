// tests/unit/review-gate.test.ts
/**
 * src/review/gate.ts 单元测试：审批结果读取 / 源文件指纹 / 发布门禁 / 坐标换算。
 *
 * 纯文件 IO（临时目录），无网络、无子进程、无审批工具依赖：
 * - 结果文件 schema 按审批工具 docs/审批结果字段说明.md 的样例逐字段构造
 *   （status/tags/note/annotations/reviewed_at/round/src），宽松解析的缺省
 *   填充与未知字段剥除一并覆盖；
 * - 指纹口径（hex(mtime_ns)+hex(size)）已在本机与 Python 逐字符核对一致
 *   （见 currentFileStamp 的 jsdoc），这里测行为：改文件 → 过期，无 src → 不判；
 * - 门禁按 blocker 理由（机器可读枚举）断言，不依赖错误文案；
 * - 门禁不过 = 正常业务结果（allowed=false + blockers），不抛错；抛错只在
 *   结果文件缺失 / 不合法 / 入参矛盾。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeCardsCsv, type CardRow } from '../../src/deck/cards.js';
import { PackError } from '../../src/pack/packyaml.js';
import {
  annotationPixelBoxes,
  approvalResultPath,
  currentFileStamp,
  evaluateGate,
  expectedItemIds,
  isResultStale,
  readApprovalResult,
  type ApprovalAnnotation,
  type ApprovalItemRecord,
} from '../../src/review/gate.js';

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-review-gate-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

const SET_ID = 'demo_cards';

const dataDir = () => path.join(tempRoot, 'approval-data');
const bRoot = () => path.join(tempRoot, 'render');

/** 最简审批记录（只给必填语义字段，其余走解析缺省） */
const rec = (overrides: Partial<ApprovalItemRecord> = {}): ApprovalItemRecord => ({
  status: 'pass',
  tags: [],
  note: '',
  annotations: [],
  ...overrides,
});

/** 写一份结果文件（顶层 set_id 恒为 SET_ID，除非显式覆盖） */
async function writeResult(
  items: Record<string, ApprovalItemRecord>,
  opts: { setId?: string; raw?: string } = {},
): Promise<string> {
  const setId = opts.setId ?? SET_ID;
  const dir = path.join(dataDir(), 'results');
  await mkdir(dir, { recursive: true });
  const filePath = approvalResultPath(dataDir(), setId);
  const text = opts.raw ?? JSON.stringify({ set_id: setId, set_name: '演示', round: 1, items });
  await writeFile(filePath, text, 'utf8');
  return filePath;
}

/** 在源B根目录下放一个文件并返回其当前指纹 */
async function putFile(name: string, size: number): Promise<string> {
  await mkdir(bRoot(), { recursive: true });
  const filePath = path.join(bRoot(), name);
  await writeFile(filePath, Buffer.alloc(size));
  return (await currentFileStamp(filePath))!;
}

/** 一条合法 cards.csv 行 */
const cardRow = (cardId: number, face: string, back?: string): CardRow => ({
  cardId,
  face,
  ...(back === undefined ? {} : { back }),
  sheetId: 1,
  slot: cardId % 100,
  sheetCols: 5,
  sheetRows: 2,
  sheetSource: 'http://example.com/sheet1.png',
});

// ---------------------------------------------------------------------------
// readApprovalResult
// ---------------------------------------------------------------------------

describe('readApprovalResult', () => {
  it('按冻结契约解析：items / annotations 逐字段可用，缺省字段补默认', async () => {
    await writeResult({
      '102_front.png': rec({
        status: 'reject',
        tags: ['文字溢出', '术语错'],
        note: '标题串行了',
        annotations: [{ side: 'b', x: 0.269646, y: 0.338213, w: 0.46225, h: 0.231125, note: '标题与正文重叠', tag: '' }],
        reviewed_at: '2026-10-01 14:05:33',
        round: 2,
        src: '18da4b9a281e5d7482801',
        reviewer: '',
      }),
    });
    const result = await readApprovalResult(dataDir(), SET_ID);
    expect(result.set_id).toBe(SET_ID);
    expect(result.set_name).toBe('演示');
    const item = result.items['102_front.png']!;
    expect(item.status).toBe('reject');
    expect(item.tags).toEqual(['文字溢出', '术语错']);
    expect(item.annotations[0]!.side).toBe('b');
    expect(item.annotations[0]!.note).toBe('标题与正文重叠');
    expect(item.src).toBe('18da4b9a281e5d7482801');
  });

  it('宽松解析：被操作过但字段不全的记录补默认（tags/note/annotations）', async () => {
    await writeResult({ 'a.png': { status: 'pass' } as ApprovalItemRecord });
    const result = await readApprovalResult(dataDir(), SET_ID);
    expect(result.items['a.png']).toMatchObject({ status: 'pass', tags: [], note: '', annotations: [] });
  });

  it('结果文件不存在 → REVIEW_RESULT_NOT_FOUND', async () => {
    await expect(readApprovalResult(dataDir(), SET_ID)).rejects.toMatchObject({
      code: 'REVIEW_RESULT_NOT_FOUND',
    } satisfies Partial<PackError>);
  });

  it('非法 setId（路径穿越）→ REVIEW_GATE_INPUT_INVALID，且不做任何 IO', async () => {
    await expect(readApprovalResult(dataDir(), '../evil')).rejects.toMatchObject({
      code: 'REVIEW_GATE_INPUT_INVALID',
    } satisfies Partial<PackError>);
  });

  it('JSON 解析失败 / 不符合 schema / set_id 不符 → REVIEW_RESULT_INVALID', async () => {
    await writeResult({}, { raw: '{broken' });
    await expect(readApprovalResult(dataDir(), SET_ID)).rejects.toMatchObject({
      code: 'REVIEW_RESULT_INVALID',
    } satisfies Partial<PackError>);

    await writeResult({}, { raw: JSON.stringify({ set_id: 1, items: {} }) });
    await expect(readApprovalResult(dataDir(), SET_ID)).rejects.toMatchObject({
      code: 'REVIEW_RESULT_INVALID',
    } satisfies Partial<PackError>);

    await writeResult({}, { raw: JSON.stringify({ set_id: 'other', items: {} }) });
    await expect(readApprovalResult(dataDir(), SET_ID)).rejects.toMatchObject({
      code: 'REVIEW_RESULT_INVALID',
    } satisfies Partial<PackError>);
  });

  it('冻结字段被破坏（side 非法 / items 不是对象）→ REVIEW_RESULT_INVALID', async () => {
    await writeResult({
      'a.png': rec({ annotations: [{ side: 'c' as never, x: 0, y: 0, w: 0, h: 0, note: '' }] }),
    });
    await expect(readApprovalResult(dataDir(), SET_ID)).rejects.toMatchObject({
      code: 'REVIEW_RESULT_INVALID',
    } satisfies Partial<PackError>);

    await writeResult({}, { raw: JSON.stringify({ set_id: SET_ID, items: '不是对象' }) });
    await expect(readApprovalResult(dataDir(), SET_ID)).rejects.toMatchObject({
      code: 'REVIEW_RESULT_INVALID',
    } satisfies Partial<PackError>);
  });
});

// ---------------------------------------------------------------------------
// 源文件指纹与过期
// ---------------------------------------------------------------------------

describe('currentFileStamp / isResultStale', () => {
  it('指纹 = hex(mtime_ns)+hex(size)，文件没变则不过期', async () => {
    const filePath = path.join(bRoot(), '001.png');
    await mkdir(bRoot(), { recursive: true });
    await writeFile(filePath, Buffer.alloc(100));
    const stamp = await currentFileStamp(filePath);
    expect(stamp).toMatch(/^[0-9a-f]+$/);
    expect(await isResultStale(rec({ src: stamp }), filePath)).toBe(false);
  });

  it('文件被改（尺寸变化）→ src 不匹配 → 过期', async () => {
    const filePath = path.join(bRoot(), '002.png');
    await mkdir(bRoot(), { recursive: true });
    await writeFile(filePath, Buffer.alloc(100));
    const stamp = (await currentFileStamp(filePath))!;
    await writeFile(filePath, Buffer.alloc(200)); // 重渲：内容变了
    expect(await isResultStale(rec({ src: stamp }), filePath)).toBe(true);
  });

  it('老结果没有 src → 不判过期（宁可放过不误判）；文件缺失也不判过期', async () => {
    expect(await isResultStale(rec(), path.join(bRoot(), '不存在.png'))).toBe(false);
    expect(await currentFileStamp(path.join(tempRoot, '不存在.png'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// expectedItemIds（cards.csv 推导）
// ---------------------------------------------------------------------------

describe('expectedItemIds', () => {
  it('face + back 去重、保持首次出现顺序', async () => {
    const deckDir = path.join(tempRoot, 'deck');
    await mkdir(deckDir, { recursive: true });
    await writeCardsCsv(deckDir, [
      cardRow(10101, '001_正面.png'),
      cardRow(10102, '002_正面.png', '共享背面.png'),
      cardRow(10103, '003_正面.png', '共享背面.png'),
    ]);
    await expect(expectedItemIds(deckDir)).resolves.toEqual([
      '001_正面.png',
      '002_正面.png',
      '共享背面.png',
      '003_正面.png',
    ]);
  });

  it('cards.csv 不存在 → 透传 CARDS_NOT_FOUND；全空 sheet_source 不受影响', async () => {
    const deckDir = path.join(tempRoot, 'empty-deck');
    await mkdir(deckDir, { recursive: true });
    await expect(expectedItemIds(deckDir)).rejects.toMatchObject({
      code: 'CARDS_NOT_FOUND',
    } satisfies Partial<PackError>);
  });
});

// ---------------------------------------------------------------------------
// evaluateGate（发布门禁）
// ---------------------------------------------------------------------------

describe('evaluateGate', () => {
  it('全 pass 且指纹未变 → allowed=true，blockers 为空', async () => {
    const stampA = await putFile('a.png', 10);
    const stampB = await putFile('b.png', 20);
    await writeResult({
      'a.png': rec({ src: stampA }),
      'b.png': rec({ src: stampB }),
    });
    const gate = await evaluateGate({ dataDir: dataDir(), setId: SET_ID, expectedIds: ['a.png', 'b.png'], bRoot: bRoot() });
    expect(gate.allowed).toBe(true);
    expect(gate.blockers).toEqual([]);
    expect(gate.total).toBe(2);
    expect(gate.counts).toEqual({ pass: 2, reject: 0, flag: 0, unreviewed: 0, stale: 0 });
    expect(gate.staleIds).toEqual([]);
  });

  it('七种情形一次覆盖：pass/reject/flag/""→unreviewed/未审/fileMissing/stale', async () => {
    const stampA = await putFile('001_正面.png', 10);
    await putFile('005_正面.png', 30); // pass 且指纹一致
    await writeResult({
      '001_正面.png': rec({ src: stampA }), // 审后文件已变大 → stale
      '002_正面.png': rec({ status: 'reject', tags: ['文字溢出'] }),
      '003_正面.png': rec({ status: 'flag' }),
      '004_正面.png': rec({ status: '' }), // 写 "" 清回未审 → unreviewed
      '005_正面.png': rec({ src: await currentFileStamp(path.join(bRoot(), '005_正面.png')) }),
      '007_正面.png': rec(), // pass 但源B文件不存在 → fileMissing
      // 006_正面.png 不在 items 里 → unreviewed
    });
    // 让 001 审后变大（重渲）
    await mkdir(bRoot(), { recursive: true });
    await writeFile(path.join(bRoot(), '001_正面.png'), Buffer.alloc(99));

    const gate = await evaluateGate({
      dataDir: dataDir(),
      setId: SET_ID,
      expectedIds: [
        '001_正面.png', '002_正面.png', '003_正面.png', '004_正面.png',
        '005_正面.png', '006_正面.png', '007_正面.png',
      ],
      bRoot: bRoot(),
    });

    expect(gate.allowed).toBe(false);
    expect(gate.total).toBe(7);
    expect(gate.counts).toEqual({ pass: 3, reject: 1, flag: 1, unreviewed: 2, stale: 1 });
    expect(gate.staleIds).toEqual(['001_正面.png']);
    expect(gate.blockers).toEqual([
      { itemId: '001_正面.png', reason: 'stale' },
      { itemId: '002_正面.png', reason: 'reject' },
      { itemId: '003_正面.png', reason: 'flag' },
      { itemId: '004_正面.png', reason: 'unreviewed' },
      { itemId: '006_正面.png', reason: 'unreviewed' },
      { itemId: '007_正面.png', reason: 'fileMissing' },
    ]);
  });

  it('每个素材至多一条 blocker：reject 优先于 stale / fileMissing', async () => {
    const stamp = await putFile('r.png', 10);
    await writeFile(path.join(bRoot(), 'r.png'), Buffer.alloc(11)); // 既 reject 又过期
    await writeResult({ 'r.png': rec({ status: 'reject', src: stamp }) });
    const gate = await evaluateGate({ dataDir: dataDir(), setId: SET_ID, expectedIds: ['r.png'], bRoot: bRoot() });
    expect(gate.blockers).toEqual([{ itemId: 'r.png', reason: 'reject' }]);
  });

  it('不给 bRoot：退化为纯状态闸，无 stale / fileMissing 检查', async () => {
    await writeResult({
      'a.png': rec({ status: 'pass', src: '旧指纹' }),
      'b.png': rec({ status: 'reject' }),
    });
    const gate = await evaluateGate({ dataDir: dataDir(), setId: SET_ID, expectedIds: ['a.png', 'b.png'] });
    expect(gate.counts).toEqual({ pass: 1, reject: 1, flag: 0, unreviewed: 0, stale: 0 });
    expect(gate.blockers).toEqual([{ itemId: 'b.png', reason: 'reject' }]);
  });

  it('expectedIds 去重：同一文件被多行引用只审一次', async () => {
    await putFile('shared.png', 5);
    const stamp = await currentFileStamp(path.join(bRoot(), 'shared.png'));
    await writeResult({ 'shared.png': rec({ src: stamp }) });
    const gate = await evaluateGate({
      dataDir: dataDir(),
      setId: SET_ID,
      expectedIds: ['shared.png', 'shared.png'],
      bRoot: bRoot(),
    });
    expect(gate.total).toBe(1);
    expect(gate.allowed).toBe(true);
  });

  it('deckDir 来源：直接吃 cards.csv 的 face+back 清单', async () => {
    const deckDir = path.join(tempRoot, 'deck');
    await mkdir(deckDir, { recursive: true });
    await writeCardsCsv(deckDir, [cardRow(10101, '001_正面.png'), cardRow(10102, '002_正面.png')]);
    const stamp = await putFile('001_正面.png', 7);
    await writeResult({ '001_正面.png': rec({ src: stamp }) }); // 002 未审
    const gate = await evaluateGate({ dataDir: dataDir(), setId: SET_ID, deckDir, bRoot: bRoot() });
    expect(gate.total).toBe(2);
    expect(gate.blockers).toEqual([{ itemId: '002_正面.png', reason: 'unreviewed' }]);
  });

  it('结果文件缺失 → REVIEW_RESULT_NOT_FOUND（基础设施问题抛错，不算 blocker）', async () => {
    await expect(
      evaluateGate({ dataDir: dataDir(), setId: SET_ID, expectedIds: ['a.png'] }),
    ).rejects.toMatchObject({ code: 'REVIEW_RESULT_NOT_FOUND' } satisfies Partial<PackError>);
  });

  it('入参矛盾或为空 → REVIEW_GATE_INPUT_INVALID', async () => {
    await expect(
      evaluateGate({ dataDir: dataDir(), setId: SET_ID, expectedIds: ['a.png'], deckDir: tempRoot }),
    ).rejects.toMatchObject({ code: 'REVIEW_GATE_INPUT_INVALID' } satisfies Partial<PackError>);
    await expect(
      evaluateGate({ dataDir: dataDir(), setId: SET_ID, expectedIds: [] }),
    ).rejects.toMatchObject({ code: 'REVIEW_GATE_INPUT_INVALID' } satisfies Partial<PackError>);
    await expect(
      evaluateGate({ dataDir: dataDir(), setId: SET_ID }),
    ).rejects.toMatchObject({ code: 'REVIEW_GATE_INPUT_INVALID' } satisfies Partial<PackError>);
    await expect(
      evaluateGate({ dataDir: dataDir(), setId: 'a/b', expectedIds: ['a.png'] }),
    ).rejects.toMatchObject({ code: 'REVIEW_GATE_INPUT_INVALID' } satisfies Partial<PackError>);
  });
});

// ---------------------------------------------------------------------------
// annotationPixelBoxes（比例 → 像素）
// ---------------------------------------------------------------------------

describe('annotationPixelBoxes', () => {
  const ann = (overrides: Partial<ApprovalAnnotation>): ApprovalAnnotation => ({
    side: 'b',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    note: '',
    ...overrides,
  });

  it('side 决定用哪一侧的尺寸换算；两侧尺寸都给则全带像素框', () => {
    const boxes = annotationPixelBoxes(
      [
        ann({ side: 'b', x: 0.269646, y: 0.338213, w: 0.46225, h: 0.231125, note: '成品侧' }),
        ann({ side: 'a', x: 0.1, y: 0.2, w: 0.3, h: 0.4, note: '原图侧' }),
      ],
      { a: { width: 1000, height: 500 }, b: { width: 400, height: 200 } },
    );
    expect(boxes[0]!.pixel).toEqual({
      x: Math.round(0.269646 * 400),
      y: Math.round(0.338213 * 200),
      w: Math.round(0.46225 * 400),
      h: Math.round(0.231125 * 200),
    });
    expect(boxes[1]!.pixel).toEqual({ x: 100, y: 100, w: 300, h: 200 });
    // 比例原值保留
    expect(boxes[0]!.relative).toEqual({ x: 0.269646, y: 0.338213, w: 0.46225, h: 0.231125 });
  });

  it('Math.round 半值向上：0.125 × 100 = 12.5 → 13（与 Python round 的边界差异见 jsdoc）', () => {
    const [box] = annotationPixelBoxes([ann({ side: 'b', x: 0.125, y: 0.5, w: 0.25, h: 0.75 })], {
      b: { width: 100, height: 100 },
    });
    expect(box!.pixel).toEqual({ x: 13, y: 50, w: 25, h: 75 });
  });

  it('对应侧尺寸缺失 → pixel 省略（比例照旧可用，不猜尺寸）', () => {
    const boxes = annotationPixelBoxes(
      [ann({ side: 'b' }), ann({ side: 'a' })],
      { a: { width: 100, height: 100 } },
    );
    expect(boxes[0]!.pixel).toBeUndefined();
    expect(boxes[1]!.pixel).toBeDefined();
  });

  it('note / tag 透传，顺序保持', () => {
    const boxes = annotationPixelBoxes(
      [ann({ note: '标题与正文重叠' }), ann({ note: 'n2', tag: '文字溢出' })],
      {},
    );
    expect(boxes.map((b) => [b.note, b.tag])).toEqual([
      ['标题与正文重叠', undefined],
      ['n2', '文字溢出'],
    ]);
  });
});
