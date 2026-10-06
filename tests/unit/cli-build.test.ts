// tests/unit/cli-build.test.ts
/**
 * src/cli/commands/build.ts · `tts build`（窗口 G / 阶段 7，B4）单元测试。
 *
 * 测试方式：真 commander（buildCommand.parseAsync），外部依赖全部 vi.mock——
 * - `src/pack/build.js` 的 buildSave → mock（真实实现需要完整工作区骨架，本层
 *   只验证命令的调用与呈现，文件 IO 全部在 mock 边界之外）；
 * - `src/publish/bson.js` 的 buildBson / verifyBsonFile → mock（真实实现会写盘）；
 * - `src/publish/manual-guide.js` 的 generateManualGuide → mock（真实实现会校验
 *   BSON 文件存在并起 clip.exe 子进程，测试绝不真碰剪贴板）；
 * - `src/pack/packyaml.js` 的 readPackYaml → mock（PackError 类保持真实现，
 *   instanceof 分支不受影响）；
 * - process.exit → mock 成抛 ExitError（parseAsync 把 action 内的异常原样
 *   reject，测试据此断言退出码）；
 * - console.log / console.error → spyOn 捕获，输出文案按 t() 契约断言（键 + 参数
 *   两侧同调 t()）。注意（Stage C 补 locales 后的修正）：**预期值里的插值参数不能放
 *   非对称匹配器**（如 expect.any(String)）——缺键时 t() 原样返回键名、断言侥幸成立；
 *   补齐译文后 t() 会把匹配器 stringify 进文案，断言必然失败。本文件改为取实际打印值
 *   做双态断言（与 tests/unit/deck-plan.test.ts 的 expectDualMessage 同款约定）。
 *   路径 / 字节数走纯数据行断言（`json:` / `bson:` / `bson_bytes:` / `bson_verify:`），
 *   与 t() 是否有译文无关。
 */
import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// —— 外部依赖 mock（hoisted：先于 import 执行）——
vi.mock('../../src/pack/build.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pack/build.js')>();
  return { ...actual, buildSave: vi.fn() };
});
vi.mock('../../src/publish/bson.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/publish/bson.js')>();
  return { ...actual, buildBson: vi.fn(), verifyBsonFile: vi.fn() };
});
vi.mock('../../src/publish/manual-guide.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/publish/manual-guide.js')>();
  return { ...actual, generateManualGuide: vi.fn() };
});
vi.mock('../../src/pack/packyaml.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pack/packyaml.js')>();
  return { ...actual, readPackYaml: vi.fn() };
});

import { buildCommand } from '../../src/cli/commands/build.js';
import { t } from '../../src/i18n/index.js';
import { buildSave } from '../../src/pack/build.js';
import { PackError, readPackYaml, type PackYaml } from '../../src/pack/packyaml.js';
import { buildBson, verifyBsonFile } from '../../src/publish/bson.js';
import { generateManualGuide } from '../../src/publish/manual-guide.js';

const buildSaveMock = vi.mocked(buildSave);
const buildBsonMock = vi.mocked(buildBson);
const verifyBsonFileMock = vi.mocked(verifyBsonFile);
const generateManualGuideMock = vi.mocked(generateManualGuide);
const readPackYamlMock = vi.mocked(readPackYaml);

// ---------------------------------------------------------------------------
// commander / stdout / exit 环境
// ---------------------------------------------------------------------------

/** process.exit 被 mock 成抛出的哨兵错误（携带退出码） */
class ExitError extends Error {
  constructor(readonly exitCode: number | undefined) {
    super(`process.exit:${exitCode}`);
  }
}

const JSON_PATH = 'D:/w/pack/dist/my-pack.json';
const BSON_PATH = 'D:/w/out/my-pack.bson';
const GUIDE_TEXT = '# 工坊手动上传手册（测试夹具）\n';

/** 构造 pack.yaml 读取结果（schema 推断类型的全部必填字段） */
function packYaml(overrides: Partial<PackYaml> = {}): PackYaml {
  return {
    schema_version: 1,
    name: 'My Pack',
    workshop_id: null,
    source_mod: null,
    host: 'steamcloud',
    vcs: { lfs: 'enabled' },
    paths: { workdir: '.' },
    upload: { prefix: '' },
    ...overrides,
  };
}

let logSpy: MockInstance;
let errSpy: MockInstance;

beforeEach(() => {
  buildSaveMock.mockReset();
  buildSaveMock.mockResolvedValue({
    outPath: JSON_PATH,
    dryRun: false,
    scriptsReplaced: 2,
    uiReplaced: 1,
    objectsReplaced: 3,
    decksPatched: 0,
    warnings: [],
  });
  buildBsonMock.mockReset();
  buildBsonMock.mockResolvedValue({ outPath: BSON_PATH, byteLength: 1234, headerLength: 1234 });
  verifyBsonFileMock.mockReset();
  verifyBsonFileMock.mockResolvedValue({ ok: true, byteLength: 1234, headerLength: 1234 });
  generateManualGuideMock.mockReset();
  generateManualGuideMock.mockResolvedValue({ text: GUIDE_TEXT, clipboardCopied: true });
  readPackYamlMock.mockReset();
  // 缺省：pack.yaml 读不到 → 手册不带条目行（workshop_id 专属用例里覆盖）
  readPackYamlMock.mockRejectedValue(new PackError('PACK_NOT_FOUND', 'pack.yaml 不存在'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 以 user 视角运行 `tts build ...` */
async function runBuild(args: string[]): Promise<void> {
  await buildCommand.parseAsync(args, { from: 'user' });
}

/** 断言命令以指定退出码结束（process.exit 被拦截为 ExitError） */
async function expectExit(run: Promise<void>, code: number): Promise<ExitError> {
  const err = await run.then(
    () => {
      throw new Error('期望命令以非 0 退出码结束，但 action 正常返回了');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ExitError);
  expect((err as ExitError).exitCode).toBe(code);
  return err as ExitError;
}

/** console.log 收到的全部文本（单行合并，便于包含性断言） */
function loggedLines(): string[] {
  return logSpy.mock.calls.map((call) => call.map((part) => String(part)).join(' '));
}

// ---------------------------------------------------------------------------
// 命令注册
// ---------------------------------------------------------------------------

describe('tts build · 命令注册', () => {
  it('命令名 build；-o/--out 是必填选项；--root 缺省 "."；有 --dry-run', () => {
    expect(buildCommand.name()).toBe('build');
    const out = buildCommand.options.find((o) => o.long === '--out');
    expect(out?.short).toBe('-o');
    expect(out?.mandatory).toBe(true);
    const root = buildCommand.options.find((o) => o.long === '--root');
    expect(root?.defaultValue).toBe('.');
    expect(buildCommand.options.some((o) => o.long === '--dry-run')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dry-run：不写真文件、不产 BSON、不碰剪贴板
// ---------------------------------------------------------------------------

describe('tts build · dry-run', () => {
  it('--dry-run：buildSave 收到 dryRun=true；不调 buildBson / verifyBsonFile / generateManualGuide', async () => {
    await runBuild(['--dry-run', '-o', 'out.bson']);

    expect(buildSaveMock).toHaveBeenCalledTimes(1);
    expect(buildSaveMock).toHaveBeenCalledWith({ root: '.', dryRun: true });
    expect(buildBsonMock).not.toHaveBeenCalled();
    expect(verifyBsonFileMock).not.toHaveBeenCalled();
    expect(generateManualGuideMock).not.toHaveBeenCalled();
  });

  it('--dry-run：显示"将生成"的 JSON / BSON 路径与计数，并附 dryRunNote', async () => {
    await runBuild(['--dry-run', '-o', 'out.bson']);

    const lines = loggedLines();
    expect(lines).toContain(`json: ${JSON_PATH}`);
    expect(lines.some((l) => l.startsWith('bson: '))).toBe(true);
    // 双态断言：locales 缺该键时 t() 原样返回键名（参数不插值），补齐后两侧插值同一组
    // 参数——因此 bsonPath 取命令实际打印的值，不能用 expect.any(String)（见文件头注释）。
    const bsonPath = lines.find((l) => l.startsWith('bson: '))?.slice('bson: '.length) ?? '';
    expect(logSpy).toHaveBeenCalledWith(
      t('cli.build.dryRun', {
        jsonPath: JSON_PATH,
        bsonPath,
        scripts: 2,
        ui: 1,
        objects: 3,
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(t('cli.build.dryRunNote'));
  });

  it('--root 透传 buildSave', async () => {
    await runBuild(['-o', 'out.bson', '--root', 'D:\\pack']);

    expect(buildSaveMock).toHaveBeenCalledWith({ root: 'D:\\pack', dryRun: false });
  });
});

// ---------------------------------------------------------------------------
// 实际运行：buildSave + buildBson + 自检 + 手册
// ---------------------------------------------------------------------------

describe('tts build · 实际运行', () => {
  it('调 buildSave(dryRun=false) + buildBson（jsonPath=buildSave 产物，outPath=--out）+ verifyBsonFile', async () => {
    await runBuild(['-o', 'out.bson']);

    expect(buildSaveMock).toHaveBeenCalledWith({ root: '.', dryRun: false });
    expect(buildBsonMock).toHaveBeenCalledTimes(1);
    expect(buildBsonMock).toHaveBeenCalledWith({ jsonPath: JSON_PATH, outPath: 'out.bson' });
    expect(verifyBsonFileMock).toHaveBeenCalledWith(BSON_PATH);
  });

  it('输出包含 JSON 路径、BSON 路径与字节数（纯数据行）及自检通过', async () => {
    await runBuild(['-o', 'out.bson']);

    const lines = loggedLines();
    expect(lines).toContain(`json: ${JSON_PATH}`);
    expect(lines).toContain(`bson: ${BSON_PATH}`);
    expect(lines).toContain('bson_bytes: 1234');
    expect(lines).toContain('bson_verify: ok');
    expect(logSpy).toHaveBeenCalledWith(t('cli.build.bsonDone', { bsonPath: BSON_PATH, bytes: 1234 }));
    expect(logSpy).toHaveBeenCalledWith(t('cli.build.verifyOk', { bytes: 1234 }));
  });

  it('完成后调 generateManualGuide（BSON 绝对路径）并打印手册文本与剪贴板状态', async () => {
    await runBuild(['-o', 'out.bson']);

    expect(generateManualGuideMock).toHaveBeenCalledTimes(1);
    expect(generateManualGuideMock).toHaveBeenCalledWith({ bsonPath: BSON_PATH });
    expect(logSpy).toHaveBeenCalledWith(GUIDE_TEXT);
    expect(logSpy).toHaveBeenCalledWith(t('cli.build.clipboardOk', { path: BSON_PATH }));
  });

  it('pack.yaml 有 workshop_id 时把手册目标条目传给 generateManualGuide', async () => {
    readPackYamlMock.mockResolvedValue(packYaml({ workshop_id: 2955382975 }));

    await runBuild(['-o', 'out.bson']);

    expect(generateManualGuideMock).toHaveBeenCalledWith({ bsonPath: BSON_PATH, itemId: 2955382975 });
  });

  it('buildSave 的 warnings 逐条缩进打印，不改变退出码', async () => {
    buildSaveMock.mockResolvedValue({
      outPath: JSON_PATH,
      dryRun: false,
      scriptsReplaced: 0,
      uiReplaced: 0,
      objectsReplaced: 0,
      decksPatched: 0,
      warnings: ['孤儿脚本 a1b2.lua'],
    });

    await runBuild(['-o', 'out.bson']);

    expect(loggedLines()).toContain('  孤儿脚本 a1b2.lua');
  });

  it('verifyBsonFile 自检不过 → PUBLISH_BSON_INVALID，退出码 1', async () => {
    verifyBsonFileMock.mockResolvedValue({ ok: false, byteLength: 10, headerLength: 0 });

    await expectExit(runBuild(['-o', 'out.bson']), 1);

    // PackError 经统一出口按 `error.<code>` 取文案（{msg} = 模块层生成的描述）；
    // error.PUBLISH_BSON_INVALID / error.publish.bsonInvalid 两侧都尚未进 locales
    // （Stage C 补），t() 缺键时原样返回键名，两侧同调断言仍成立。
    expect(errSpy).toHaveBeenCalledWith(
      t('error.PUBLISH_BSON_INVALID', {
        msg: t('error.publish.bsonInvalid', { headerLength: 0, byteLength: 10 }),
      }),
    );
    expect(generateManualGuideMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 失败出口
// ---------------------------------------------------------------------------

describe('tts build · 失败出口', () => {
  it('buildSave 抛 PackError → error.<code> 文案 + 退出码 1', async () => {
    buildSaveMock.mockRejectedValue(new PackError('SKELETON_MISSING', '骨架不存在，先跑 tts unpack'));

    await expectExit(runBuild(['-o', 'out.bson']), 1);

    expect(errSpy).toHaveBeenCalledWith(t('error.SKELETON_MISSING', { msg: '骨架不存在，先跑 tts unpack' }));
    expect(buildBsonMock).not.toHaveBeenCalled();
  });

  it('非 PackError 异常 → error.unknown 文案 + 退出码 1', async () => {
    buildBsonMock.mockRejectedValue(new Error('disk full'));

    await expectExit(runBuild(['-o', 'out.bson']), 1);

    expect(errSpy).toHaveBeenCalledWith(t('error.unknown', { msg: 'disk full' }));
    expect(generateManualGuideMock).not.toHaveBeenCalled();
  });
});
