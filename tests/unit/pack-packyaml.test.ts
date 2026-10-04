// tests/unit/pack-packyaml.test.ts
/**
 * src/pack/packyaml.ts 单元测试：pack.yaml 的读取 / 校验 / 写入。
 *
 * 纯文件 IO（临时目录），无网络、无 TTS、无 git 依赖：
 * - 正常路径：最小合法清单读取时填充缺省值（host → steamcloud、
 *   paths.workdir → "."、upload.prefix → ""），write → read 往返一致；
 * - 异常路径：按 PackError.code（机器可读）断言，不依赖错误文案——
 *   文案走 t()，locales/*.json 由 Run 2 补齐，补齐前后 message 不同
 *   （补齐前 t() 原样返回键名，补齐后含插值摘要，故 message 断言写成双态）；
 * - schema 严格性：缺 schema_version / 未知字段 / vcs.lfs 无默认值（约束 10）等
 *   一律 PACK_INVALID；写前校验不过则绝不落盘。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PACK_HOSTS,
  PACK_LFS_MODES,
  PACK_YAML_FILENAME,
  PackError,
  packYamlPath,
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
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-packyaml-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** 字段齐全的合法清单（各可选字段都显式给出，覆盖非默认取值） */
const fullPack: PackYaml = {
  schema_version: 1,
  name: '完整图包',
  workshop_id: 1234567,
  source_mod: 7654321,
  host: 'imgur',
  editor: { adapter: 'vscode' },
  vcs: { lfs: 'disabled-no-lfs' },
  paths: { workdir: '.' },
  upload: { prefix: 'https://img.example.com/tts/' },
};

/**
 * 只含必填字段的最小合法 YAML（workshop_id 允许 null；host 走缺省值；
 * paths / upload 这两个外层对象本身必填——与 init.ts / unpack.ts 的写法一致——
 * 但空对象时内层 workdir / prefix 由 schema 缺省值填充）。
 */
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

/**
 * 断言 fn 抛出指定 code 的 PackError，并返回该错误。
 * @param fn 待执行（预期抛 PackError）的异步函数
 * @param code 期望的机器可读错误码
 * @returns 实际抛出的 PackError（可对 message 做进一步断言）
 */
async function expectPackError(fn: () => Promise<unknown>, code: string): Promise<PackError> {
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

/** 在图包根目录直接写一份 pack.yaml（绕过 writePackYaml，用于构造"手改的坏文件"） */
async function writeRawPackYaml(root: string, text: string): Promise<void> {
  await writeFile(path.join(root, PACK_YAML_FILENAME), text, 'utf8');
}

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

describe('常量', () => {
  it('PACK_YAML_FILENAME 为 pack.yaml；PACK_HOSTS / PACK_LFS_MODES 枚举取值正确', () => {
    expect(PACK_YAML_FILENAME).toBe('pack.yaml');
    expect([...PACK_HOSTS]).toEqual(['steamcloud', 'imgur', 'gdrive', 'dropbox', 'custom']);
    // 约束 10：lfs 三选一（装 / 禁用二次确认 / 取消），没有第四种"静默降级"取值
    expect([...PACK_LFS_MODES]).toEqual(['enabled', 'disabled', 'disabled-no-lfs']);
  });

  it('packYamlPath 拼出 <root>/pack.yaml', () => {
    expect(packYamlPath(path.join('some', 'pack'))).toBe(path.join('some', 'pack', 'pack.yaml'));
  });
});

// ---------------------------------------------------------------------------
// readPackYaml
// ---------------------------------------------------------------------------

describe('readPackYaml：正常路径', () => {
  it('最小合法清单读取成功，缺省字段填充默认值', async () => {
    await writeRawPackYaml(tempRoot, minimalYaml);
    const pack = await readPackYaml(tempRoot);
    expect(pack).toEqual({
      schema_version: 1,
      name: '最小图包',
      workshop_id: null,
      source_mod: null,
      host: 'steamcloud',
      vcs: { lfs: 'enabled' },
      paths: { workdir: '.' },
      upload: { prefix: '' },
    });
    // editor 未提供 → 保持 undefined（不填充）
    expect(pack.editor).toBeUndefined();
  });

  it('workshop_id / source_mod 为数字时原样保留', async () => {
    await writeRawPackYaml(
      tempRoot,
      [
        'schema_version: 1',
        'name: x',
        'workshop_id: 2169435168',
        'source_mod: null',
        'vcs:',
        '  lfs: enabled',
        'paths: {}',
        'upload: {}',
        '',
      ].join('\n'),
    );
    const pack = await readPackYaml(tempRoot);
    expect(pack.workshop_id).toBe(2169435168);
    expect(pack.source_mod).toBeNull();
  });
});

describe('readPackYaml：错误路径', () => {
  it('pack.yaml 不存在 → PackError code="PACK_NOT_FOUND"', async () => {
    const err = await expectPackError(() => readPackYaml(path.join(tempRoot, 'no-such-pack')), 'PACK_NOT_FOUND');
    // 文案走 t()：locales 键由 Run 2 补齐——补齐前 message 是键名原样输出，
    // 补齐后应含文件名。断言两种状态都接受（错误码已由 expectPackError 断言）。
    expect(err.message === 'error.pack.notFound' || err.message.includes(PACK_YAML_FILENAME)).toBe(true);
  });

  it('不是合法 YAML（语法错误）→ PACK_INVALID', async () => {
    await writeRawPackYaml(tempRoot, 'schema_version: 1\nname: [未闭合\n');
    await expectPackError(() => readPackYaml(tempRoot), 'PACK_INVALID');
  });

  it('根不是键值对象（数组 / 空文档）→ PACK_INVALID', async () => {
    await writeRawPackYaml(tempRoot, '- a\n- b\n');
    await expectPackError(() => readPackYaml(tempRoot), 'PACK_INVALID');
    await writeRawPackYaml(tempRoot, '');
    await expectPackError(() => readPackYaml(tempRoot), 'PACK_INVALID');
  });

  it('pack.yaml 是目录而非文件（非 ENOENT 的 IO 错误）→ PACK_READ_FAILED', async () => {
    await mkdir(path.join(tempRoot, PACK_YAML_FILENAME));
    await expectPackError(() => readPackYaml(tempRoot), 'PACK_READ_FAILED');
  });

  it('缺 schema_version → PACK_INVALID（任务点名场景）', async () => {
    await writeRawPackYaml(
      tempRoot,
      ['name: x', 'workshop_id: null', 'source_mod: null', 'vcs:', '  lfs: enabled', ''].join('\n'),
    );
    const err = await expectPackError(() => readPackYaml(tempRoot), 'PACK_INVALID');
    // 补齐前 message 是键名原样输出；补齐后问题摘要含字段路径 "schema_version"
    expect(err.message === 'error.pack.invalid' || err.message.includes('schema_version')).toBe(true);
  });

  const badPacks: Array<[string, string]> = [
    ['schema_version 是 2', 'schema_version: 2\nname: x\nworkshop_id: null\nsource_mod: null\nvcs:\n  lfs: enabled'],
    ['缺 name', 'schema_version: 1\nworkshop_id: null\nsource_mod: null\nvcs:\n  lfs: enabled'],
    ['name 不是字符串', 'schema_version: 1\nname: 3\nworkshop_id: null\nsource_mod: null\nvcs:\n  lfs: enabled'],
    ['缺 workshop_id', 'schema_version: 1\nname: x\nsource_mod: null\nvcs:\n  lfs: enabled'],
    ['workshop_id 是字符串', 'schema_version: 1\nname: x\nworkshop_id: "123"\nsource_mod: null\nvcs:\n  lfs: enabled'],
    ['缺 source_mod', 'schema_version: 1\nname: x\nworkshop_id: null\nvcs:\n  lfs: enabled'],
    ['缺 vcs（vcs.lfs 无默认值，约束 10）', 'schema_version: 1\nname: x\nworkshop_id: null\nsource_mod: null'],
    ['缺 paths（外层对象必填）', 'schema_version: 1\nname: x\nworkshop_id: null\nsource_mod: null\nvcs:\n  lfs: enabled'],
    ['缺 upload（外层对象必填）', 'schema_version: 1\nname: x\nworkshop_id: null\nsource_mod: null\nvcs:\n  lfs: enabled\npaths: {}'],
    ['缺 vcs.lfs', 'schema_version: 1\nname: x\nworkshop_id: null\nsource_mod: null\nvcs: {}'],
    ['vcs.lfs 非法值', 'schema_version: 1\nname: x\nworkshop_id: null\nsource_mod: null\nvcs:\n  lfs: auto'],
    ['vcs 含未知字段', 'schema_version: 1\nname: x\nworkshop_id: null\nsource_mod: null\nvcs:\n  lfs: enabled\n  hook: x'],
    ['host 非法值', 'schema_version: 1\nname: x\nworkshop_id: null\nsource_mod: null\nhost: weibo\nvcs:\n  lfs: enabled'],
    ['根含未知字段（拼写错误必须被拒绝）', 'schema_version: 1\nname: x\nworkshop_id: null\nsource_mod: null\nvcs:\n  lfs: enabled\nnaem: 拼写错误'],
    ['editor.adapter 非法', 'schema_version: 1\nname: x\nworkshop_id: null\nsource_mod: null\neditor:\n  adapter: vim\nvcs:\n  lfs: enabled'],
    ['editor 含未知字段', 'schema_version: 1\nname: x\nworkshop_id: null\nsource_mod: null\neditor:\n  adapter: vscode\n  theme: dark\nvcs:\n  lfs: enabled'],
    ['paths.workdir 不是字符串', 'schema_version: 1\nname: x\nworkshop_id: null\nsource_mod: null\npaths:\n  workdir: 3\nvcs:\n  lfs: enabled'],
    ['upload 含未知字段', 'schema_version: 1\nname: x\nworkshop_id: null\nsource_mod: null\nupload:\n  prefix: ""\n  cdn: true\nvcs:\n  lfs: enabled'],
  ];

  for (const [label, yamlText] of badPacks) {
    it(`schema 违例 → PACK_INVALID：${label}`, async () => {
      await writeRawPackYaml(tempRoot, `${yamlText}\n`);
      await expectPackError(() => readPackYaml(tempRoot), 'PACK_INVALID');
    });
  }
});

// ---------------------------------------------------------------------------
// writePackYaml
// ---------------------------------------------------------------------------

describe('writePackYaml → readPackYaml 往返', () => {
  it('字段齐全的清单往返一致（含 editor / vcs / paths / upload）', async () => {
    await writePackYaml(tempRoot, fullPack);
    const read = await readPackYaml(tempRoot);
    expect(read).toEqual(fullPack);
  });

  it('root 不存在时自动逐级创建', async () => {
    const deepRoot = path.join(tempRoot, 'packs', '嵌套', '图包');
    await writePackYaml(deepRoot, fullPack);
    expect(existsSync(packYamlPath(deepRoot))).toBe(true);
  });

  it('缺 paths / upload 外层对象 → PACK_INVALID 且不落盘（与读取侧契约一致：仅内层字段有缺省值）', async () => {
    const missingBlocks = {
      schema_version: 1,
      name: '走默认值',
      workshop_id: null,
      source_mod: null,
      vcs: { lfs: 'enabled' },
    } as unknown as PackYaml;
    await expectPackError(() => writePackYaml(tempRoot, missingBlocks), 'PACK_INVALID');
    expect(existsSync(packYamlPath(tempRoot))).toBe(false);
  });

  it('落盘内容是合法 YAML 文本（含 schema_version: 1 与 name）', async () => {
    await writePackYaml(tempRoot, fullPack);
    const raw = await readFile(packYamlPath(tempRoot), 'utf8');
    expect(raw).toContain('schema_version: 1');
    expect(raw).toContain('name: 完整图包');
    expect(raw).toContain('lfs: disabled-no-lfs');
  });

  it('入参不合规 → PACK_INVALID 且不落盘', async () => {
    const bad = { ...fullPack, vcs: { lfs: 'yolo' } } as unknown as PackYaml;
    await expectPackError(() => writePackYaml(tempRoot, bad), 'PACK_INVALID');
    expect(existsSync(packYamlPath(tempRoot))).toBe(false);
  });
});
