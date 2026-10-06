// tests/unit/cli-publish.test.ts
/**
 * src/cli/commands/publish.ts · `tts publish`（窗口 G / 阶段 7，B4）单元测试。
 *
 * 测试方式：真 commander（publishCommand.parseAsync），外部依赖全部 vi.mock——
 * - `src/publish/metadata.js` 的 fetchPublishedFileDetails / checkItemUpdated →
 *   mock（真实实现会真连 Steam Web API，测试绝不发真实网络请求）；
 * - `src/publish/kpsteam.js` 的 probeKpsteam / kpsteamUpload → mock（真实实现会
 *   扫描 PATH 并起 kpsteam 子进程，测试绝不真调 kpsteam）；
 * - `src/publish/manual-guide.js` 的 generateManualGuide → mock（真实实现会校验
 *   BSON 文件存在并起 clip.exe 子进程，测试绝不真碰剪贴板）；
 * - `src/pack/packyaml.js` 的 readPackYaml → mock（PackError 类保持真实现）；
 * - process.exit → mock 成抛 ExitError；console.log / console.error → spyOn 捕获。
 *
 * 输出文案按 t() 契约断言（键 + 参数两侧同调 t()；cli.publish.* 的 locales 尚未
 * 补齐（Stage C 补），缺键时 t() 两侧都返回键名本身，断言不受影响）。--check 的
 * 元数据行是纯数据（`title:` / `time_updated:` 等），直接按原文断言。轮询验证
 * （5 次 × 3 秒）用 vi.useFakeTimers 控制 sleep，测试即时完成。
 */
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// —— 外部依赖 mock（hoisted：先于 import 执行）——
vi.mock('../../src/publish/metadata.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/publish/metadata.js')>();
  return { ...actual, fetchPublishedFileDetails: vi.fn(), checkItemUpdated: vi.fn() };
});
vi.mock('../../src/publish/kpsteam.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/publish/kpsteam.js')>();
  return { ...actual, probeKpsteam: vi.fn(), kpsteamUpload: vi.fn() };
});
vi.mock('../../src/publish/manual-guide.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/publish/manual-guide.js')>();
  return { ...actual, generateManualGuide: vi.fn() };
});
vi.mock('../../src/pack/packyaml.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pack/packyaml.js')>();
  return { ...actual, readPackYaml: vi.fn() };
});

import { publishCommand, VERIFY_ATTEMPTS, VERIFY_INTERVAL_MS } from '../../src/cli/commands/publish.js';
import { t } from '../../src/i18n/index.js';
import { sanitizeName } from '../../src/pack/layout.js';
import { PackError, readPackYaml, type PackYaml } from '../../src/pack/packyaml.js';
import { kpsteamUpload, probeKpsteam, type KpsteamProbe } from '../../src/publish/kpsteam.js';
import { generateManualGuide } from '../../src/publish/manual-guide.js';
import {
  checkItemUpdated,
  fetchPublishedFileDetails,
  type PublishedFileDetails,
} from '../../src/publish/metadata.js';

const fetchDetailsMock = vi.mocked(fetchPublishedFileDetails);
const checkItemUpdatedMock = vi.mocked(checkItemUpdated);
const probeKpsteamMock = vi.mocked(probeKpsteam);
const kpsteamUploadMock = vi.mocked(kpsteamUpload);
const generateManualGuideMock = vi.mocked(generateManualGuide);
const readPackYamlMock = vi.mocked(readPackYaml);

// ---------------------------------------------------------------------------
// 夹具与 commander / stdout / exit 环境
// ---------------------------------------------------------------------------

/** process.exit 被 mock 成抛出的哨兵错误（携带退出码） */
class ExitError extends Error {
  constructor(readonly exitCode: number | undefined) {
    super(`process.exit:${exitCode}`);
  }
}

const ITEM_ID = '2955382975';
const GUIDE_TEXT = '# 工坊手动上传手册（测试夹具）\n';
const KPSTEAM_EXE = 'C:\\Program Files (x86)\\kpsteam\\kpsteam.exe';

/** GetPublishedFileDetails 的最小夹具（time_updated=1700000000 是上传前基线） */
const DETAILS: PublishedFileDetails = {
  publishedfileid: ITEM_ID,
  creator: '76561198000000000',
  creator_app_id: 286160,
  consumer_app_id: 286160,
  filename: '',
  file_size: '4096',
  file_url: 'https://steamusercontent.com/test.bson',
  title: 'Test Deck',
  description: 'A test deck',
  time_created: 1600000000,
  time_updated: 1700000000,
  visibility: 0,
  banned: 0,
  ban_reason: '',
  subscriptions: 12,
  favorited: 5,
  lifetime_subscriptions: 30,
};

/** kpsteam 可用探测结果 */
const PROBE_OK: KpsteamProbe = { available: true, exePath: KPSTEAM_EXE, version: 'v1.2.3' };

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
  fetchDetailsMock.mockReset();
  fetchDetailsMock.mockResolvedValue(DETAILS);
  checkItemUpdatedMock.mockReset();
  checkItemUpdatedMock.mockResolvedValue({ updated: true, timeUpdated: 1700000500, details: DETAILS });
  probeKpsteamMock.mockReset();
  probeKpsteamMock.mockResolvedValue({ available: false, reason: 'NOT_FOUND' });
  kpsteamUploadMock.mockReset();
  kpsteamUploadMock.mockResolvedValue({ ok: true, exitCode: 0, stdout: 'uploaded', stderr: '' });
  generateManualGuideMock.mockReset();
  generateManualGuideMock.mockResolvedValue({ text: GUIDE_TEXT, clipboardCopied: true });
  readPackYamlMock.mockReset();
  readPackYamlMock.mockResolvedValue(packYaml());
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** 以 user 视角运行 `tts publish ...` */
async function runPublish(args: string[]): Promise<void> {
  await publishCommand.parseAsync(args, { from: 'user' });
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

/** console.error 收到的全部文本 */
function errorLines(): string[] {
  return errSpy.mock.calls.map((call) => call.map((part) => String(part)).join(' '));
}

// ---------------------------------------------------------------------------
// 命令注册与模式互斥
// ---------------------------------------------------------------------------

describe('tts publish · 命令注册', () => {
  it('命令名 publish；六个选项齐全；--auto / --manual-guide 缺省 false；--root 缺省 "."', () => {
    expect(publishCommand.name()).toBe('publish');
    const longs = publishCommand.options.map((o) => o.long);
    expect(longs).toEqual(
      expect.arrayContaining(['--item', '--auto', '--root', '--bson', '--manual-guide', '--check']),
    );
    expect(publishCommand.options.find((o) => o.long === '--auto')?.defaultValue).toBe(false);
    expect(publishCommand.options.find((o) => o.long === '--manual-guide')?.defaultValue).toBe(false);
    expect(publishCommand.options.find((o) => o.long === '--root')?.defaultValue).toBe('.');
  });

  it('三个子模式互斥：同时给 --check 与 --manual-guide → modeConflict 文案 + 退出码 1', async () => {
    await expectExit(runPublish(['--check', ITEM_ID, '--manual-guide']), 1);

    expect(errSpy).toHaveBeenCalledWith(t('error.publish.modeConflict'));
    expect(fetchDetailsMock).not.toHaveBeenCalled();
    expect(generateManualGuideMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 模式 1：--check <id>
// ---------------------------------------------------------------------------

describe('tts publish · --check <id>', () => {
  it('调 fetchPublishedFileDetails（itemId 透传）并打印元数据纯数据行', async () => {
    await runPublish(['--check', ITEM_ID]);

    expect(fetchDetailsMock).toHaveBeenCalledTimes(1);
    expect(fetchDetailsMock).toHaveBeenCalledWith({ itemId: ITEM_ID });
    expect(generateManualGuideMock).not.toHaveBeenCalled();

    const lines = loggedLines();
    expect(lines).toContain(`publishedfileid: ${ITEM_ID}`);
    expect(lines).toContain('title: Test Deck');
    expect(lines).toContain('description: A test deck');
    expect(lines).toContain('time_updated: 1700000000');
    expect(lines).toContain('subscriptions: 12');
    expect(lines).toContain('file_size: 4096');
    expect(logSpy).toHaveBeenCalledWith(t('cli.publish.check.done', { itemId: ITEM_ID }));
  });

  it('条目私有（PUBLISH_ITEM_PRIVATE）→ error.<code> 文案 + 退出码 1', async () => {
    fetchDetailsMock.mockRejectedValue(new PackError('PUBLISH_ITEM_PRIVATE', '条目私有'));

    await expectExit(runPublish(['--check', ITEM_ID]), 1);

    expect(errSpy).toHaveBeenCalledWith(t('error.PUBLISH_ITEM_PRIVATE', { msg: '条目私有' }));
  });
});

// ---------------------------------------------------------------------------
// 模式 2：--manual-guide
// ---------------------------------------------------------------------------

describe('tts publish · --manual-guide', () => {
  it('调 generateManualGuide（--bson resolve 成绝对路径）并打印手册文本', async () => {
    await runPublish(['--manual-guide', '--bson', 'x.bson']);

    expect(generateManualGuideMock).toHaveBeenCalledTimes(1);
    expect(generateManualGuideMock).toHaveBeenCalledWith({ bsonPath: path.resolve('x.bson') });
    expect(fetchDetailsMock).not.toHaveBeenCalled();
    expect(kpsteamUploadMock).not.toHaveBeenCalled();
    expect(probeKpsteamMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(GUIDE_TEXT);
    expect(logSpy).toHaveBeenCalledWith(t('cli.publish.clipboardOk', { path: path.resolve('x.bson') }));
  });

  it('--manual-guide 可带 --item（传给手册标注目标条目）', async () => {
    await runPublish(['--manual-guide', '--bson', 'x.bson', '--item', '555']);

    expect(generateManualGuideMock).toHaveBeenCalledWith({ bsonPath: path.resolve('x.bson'), itemId: '555' });
  });
});

// ---------------------------------------------------------------------------
// 模式 3：默认发布 / 更新（--item 必填）
// ---------------------------------------------------------------------------

describe('tts publish · 默认模式（--item）', () => {
  it('缺 --item 且无 --check / --manual-guide → itemRequired 文案 + 退出码 1，且不探测 kpsteam', async () => {
    await expectExit(runPublish(['--bson', 'x.bson']), 1);

    expect(errSpy).toHaveBeenCalledWith(t('error.publish.itemRequired'));
    expect(probeKpsteamMock).not.toHaveBeenCalled();
    expect(generateManualGuideMock).not.toHaveBeenCalled();
    expect(kpsteamUploadMock).not.toHaveBeenCalled();
  });

  it('缺 --bson → 用 <root>/dist/<净化(pack.yaml name)>.bson 缺省值', async () => {
    readPackYamlMock.mockResolvedValue(packYaml({ name: 'My Pack' }));

    await runPublish(['--item', ITEM_ID]);

    const expected = path.join(path.resolve('.'), 'dist', `${sanitizeName('My Pack')}.bson`);
    expect(readPackYamlMock).toHaveBeenCalledWith('.');
    expect(generateManualGuideMock).toHaveBeenCalledWith({ bsonPath: expected, itemId: ITEM_ID });
  });

  it('默认（无 --auto）→ 直接打印手册，不上传；kpsteam 可用时附带提示行', async () => {
    probeKpsteamMock.mockResolvedValue(PROBE_OK);

    await runPublish(['--item', ITEM_ID, '--bson', 'x.bson']);

    expect(probeKpsteamMock).toHaveBeenCalledTimes(1); // 任务书约定：默认模式先探测 kpsteam
    expect(kpsteamUploadMock).not.toHaveBeenCalled();
    expect(generateManualGuideMock).toHaveBeenCalledWith({ bsonPath: path.resolve('x.bson'), itemId: ITEM_ID });
    expect(logSpy).toHaveBeenCalledWith(t('cli.publish.kpsteamHint', { version: 'v1.2.3' }));
    expect(logSpy).toHaveBeenCalledWith(GUIDE_TEXT);
  });
});

// ---------------------------------------------------------------------------
// 模式 3 · --auto：kpsteam 上传
// ---------------------------------------------------------------------------

describe('tts publish · --auto', () => {
  it('kpsteam 可用 → kpsteamUpload（探测到的 exePath / itemId / bsonPath），不回退手册', async () => {
    probeKpsteamMock.mockResolvedValue(PROBE_OK);

    await runPublish(['--item', ITEM_ID, '--auto', '--bson', 'x.bson']);

    expect(kpsteamUploadMock).toHaveBeenCalledTimes(1);
    expect(kpsteamUploadMock).toHaveBeenCalledWith({
      itemId: ITEM_ID,
      bsonPath: path.resolve('x.bson'),
      exePath: KPSTEAM_EXE,
    });
    expect(generateManualGuideMock).not.toHaveBeenCalled();
  });

  it('kpsteam 不可用 → kpsteamNotAvailable 文案 + 回退打印手册 + 退出码 1', async () => {
    probeKpsteamMock.mockResolvedValue({ available: false, reason: 'NOT_FOUND' });

    await expectExit(runPublish(['--item', ITEM_ID, '--auto', '--bson', 'x.bson']), 1);

    expect(errSpy).toHaveBeenCalledWith(t('error.publish.kpsteamNotAvailable', { reason: 'NOT_FOUND' }));
    expect(kpsteamUploadMock).not.toHaveBeenCalled();
    expect(generateManualGuideMock).toHaveBeenCalledWith({ bsonPath: path.resolve('x.bson'), itemId: ITEM_ID });
    expect(logSpy).toHaveBeenCalledWith(GUIDE_TEXT);
  });

  it('上传失败（exit code 非 0）→ uploadFailed 文案 + kpsteam 原文进 stderr + 退出码 1', async () => {
    probeKpsteamMock.mockResolvedValue(PROBE_OK);
    kpsteamUploadMock.mockResolvedValue({ ok: false, exitCode: 3, stdout: 'kp boom', stderr: 'steam err' });

    await expectExit(runPublish(['--item', ITEM_ID, '--auto', '--bson', 'x.bson']), 1);

    expect(errSpy).toHaveBeenCalledWith(t('error.publish.uploadFailed', { code: 3 }));
    expect(errorLines()).toContain('kp boom');
    expect(errorLines()).toContain('steam err');
    expect(checkItemUpdatedMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 模式 3 · --auto：上传成功后的 time_updated 变化验证（轮询 5 次 × 3 秒）
// ---------------------------------------------------------------------------

describe('tts publish · --auto · 上传后验证', () => {
  it('上传成功后调 checkItemUpdated（基线 = 上传前 time_updated），首轮更新即收敛', async () => {
    probeKpsteamMock.mockResolvedValue(PROBE_OK);

    await runPublish(['--item', ITEM_ID, '--auto', '--bson', 'x.bson']);

    expect(fetchDetailsMock).toHaveBeenCalledWith({ itemId: ITEM_ID }); // 上传前取基线
    expect(checkItemUpdatedMock).toHaveBeenCalledTimes(1);
    expect(checkItemUpdatedMock).toHaveBeenCalledWith({ itemId: ITEM_ID, sinceTimestamp: 1700000000 });
    expect(logSpy).toHaveBeenCalledWith(
      t('cli.publish.verifyUpdated', { timeUpdated: 1700000500, attempts: 1 }),
    );
  });

  it('前两轮未更新、第三轮更新 → 轮询 3 次（fake timers 推进 2 个 3 秒间隔）', async () => {
    vi.useFakeTimers();
    probeKpsteamMock.mockResolvedValue(PROBE_OK);
    checkItemUpdatedMock
      .mockResolvedValueOnce({ updated: false, timeUpdated: 1700000000, details: DETAILS })
      .mockResolvedValueOnce({ updated: false, timeUpdated: 1700000000, details: DETAILS })
      .mockResolvedValue({ updated: true, timeUpdated: 1700001000, details: DETAILS });

    const run = runPublish(['--item', ITEM_ID, '--auto', '--bson', 'x.bson']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(VERIFY_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(VERIFY_INTERVAL_MS);
    await run;

    expect(checkItemUpdatedMock).toHaveBeenCalledTimes(3);
    expect(logSpy).toHaveBeenCalledWith(
      t('cli.publish.verifyUpdated', { timeUpdated: 1700001000, attempts: 3 }),
    );
  });

  it('全部 5 次都未更新 → verifyNotUpdated 提醒收场，退出码 0（上传已成功）', async () => {
    vi.useFakeTimers();
    probeKpsteamMock.mockResolvedValue(PROBE_OK);
    checkItemUpdatedMock.mockResolvedValue({ updated: false, timeUpdated: 1700000000, details: DETAILS });

    const run = runPublish(['--item', ITEM_ID, '--auto', '--bson', 'x.bson']);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < VERIFY_ATTEMPTS; i++) {
      await vi.advanceTimersByTimeAsync(VERIFY_INTERVAL_MS);
    }
    await run;

    expect(checkItemUpdatedMock).toHaveBeenCalledTimes(VERIFY_ATTEMPTS);
    expect(logSpy).toHaveBeenCalledWith(t('cli.publish.verifyNotUpdated', { attempts: VERIFY_ATTEMPTS }));
  });

  it('上传前基线拉取失败 → 跳过验证（verifySkipped），不再调 checkItemUpdated', async () => {
    probeKpsteamMock.mockResolvedValue(PROBE_OK);
    fetchDetailsMock.mockRejectedValue(new PackError('PUBLISH_NETWORK_ERROR', '网络不可达'));

    await runPublish(['--item', ITEM_ID, '--auto', '--bson', 'x.bson']);

    expect(kpsteamUploadMock).toHaveBeenCalledTimes(1); // 基线失败不阻塞上传
    expect(checkItemUpdatedMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(t('cli.publish.verifySkipped'));
  });
});
