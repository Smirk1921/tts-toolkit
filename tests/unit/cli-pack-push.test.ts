// tests/unit/cli-pack-push.test.ts
/**
 * src/cli/commands/pack.ts · `tts pack push`（阶段 5 重写）与 `tts pack diff --unified`
 * 单元测试。
 *
 * 测试方式：真 commander（packCommand.parseAsync），外部依赖全部 vi.mock——
 * - `src/cli/_shared.js` 的 tryHubClient → mock（null = 离线独立模式 / mock 客户端
 *   = hub 在线委托），绝不探测真实 127.0.0.1:39995；
 * - `src/pack/push.js` 的 pushSaveAndPlay → mock（collectPushItems 保持真实实现，
 *   但本测试不触发它——它只在确认门的懒分支里被调用）；流水线内部的文件 IO /
 *   TTS 连接全部在 mock 边界之外；
 * - `src/safety/confirm.js` 的 confirmPush → mock（避免真实 stdin / TTY 交互）；
 * - `src/pack/diff.js` 的 diffWorkspace → mock（真实实现会绑 39998 连 TTS）；
 * - process.exit → mock 成抛 ExitError（commander parseAsync 会把 action 内的
 *   异常原样 reject，测试据此断言退出码）；
 * - console.log / console.error → spyOn 捕获，输出文案按 t() 契约断言（键 + 参数
 *   两侧同调 t()，locales 是否已补不影响断言，与 pack-push.test.ts 同款）。
 *
 * 覆盖：
 * - push 旗标决策（--yes 是唯一实写入口：dryRun = !yes）、各旗标到
 *   pushSaveAndPlay / hub.push 的透传、--backup-retention 的 1-100 边界与非法值
 *   出口（error.cli.invalidBackupRetention + 退出 1）；
 * - push 双路：hub 在线 → hub.push 三参委托 + viaHub 提示 + 委托失败不回退独立
 *   模式；hub 离线 → pushSaveAndPlay 独立执行 + PackError / 未知错误出口；
 * - 确认门回调的可达性：当前旗标决策（实写必带 --yes）下回调恒直接放行且
 *   confirmPush 不被调用（防御性闸门的兜底语义按任务书锁定）；
 * - diff --unified：includeHunks 透传、hunks 的 `@@ -<localStart>,<localLines.length> +<remoteStart>,<remoteLines.length> @@`
 *   渲染与 -/+ 行前缀、无 hunks 条目静默跳过。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// —— 外部依赖 mock（hoisted：先于 import 执行）——
vi.mock('../../src/cli/_shared.js', () => ({ tryHubClient: vi.fn() }));
vi.mock('../../src/safety/confirm.js', () => ({ confirmPush: vi.fn() }));
vi.mock('../../src/pack/push.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pack/push.js')>();
  return { ...actual, pushSaveAndPlay: vi.fn() };
});
vi.mock('../../src/pack/diff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pack/diff.js')>();
  return { ...actual, diffWorkspace: vi.fn() };
});

import { packCommand } from '../../src/cli/commands/pack.js';
import { tryHubClient } from '../../src/cli/_shared.js';
import { t } from '../../src/i18n/index.js';
import { diffWorkspace, type DiffResult } from '../../src/pack/diff.js';
import { pushSaveAndPlay } from '../../src/pack/push.js';
import { PackError } from '../../src/pack/packyaml.js';
import { confirmPush } from '../../src/safety/confirm.js';
import { HubClient, HubError } from '../../src/mcp/client.js';

const tryHubClientMock = vi.mocked(tryHubClient);
const pushSaveAndPlayMock = vi.mocked(pushSaveAndPlay);
const diffWorkspaceMock = vi.mocked(diffWorkspace);
const confirmPushMock = vi.mocked(confirmPush);

// ---------------------------------------------------------------------------
// commander / stdout / exit 环境
// ---------------------------------------------------------------------------

/** process.exit 被 mock 成抛出的哨兵错误（携带退出码） */
class ExitError extends Error {
  constructor(readonly exitCode: number | undefined) {
    super(`process.exit:${exitCode}`);
  }
}

let logSpy: MockInstance;
let errSpy: MockInstance;

beforeEach(() => {
  tryHubClientMock.mockReset();
  tryHubClientMock.mockResolvedValue(null); // 缺省：hub 离线 → 独立模式
  pushSaveAndPlayMock.mockReset();
  pushSaveAndPlayMock.mockResolvedValue({ dryRun: true, pushed: 1, skipped: 0, note: '' });
  diffWorkspaceMock.mockReset();
  confirmPushMock.mockReset();
  confirmPushMock.mockResolvedValue(true);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 以 user 视角运行 `tts pack push ...` */
async function runPush(args: string[] = []): Promise<void> {
  await packCommand.parseAsync(['push', ...args], { from: 'user' });
}

/** 以 user 视角运行 `tts pack diff ...` */
async function runDiff(args: string[] = []): Promise<void> {
  await packCommand.parseAsync(['diff', ...args], { from: 'user' });
}

/** pushSaveAndPlay 收到的第一个入参（未调用时断言失败） */
function pushOpts(): Record<string, unknown> {
  expect(pushSaveAndPlayMock).toHaveBeenCalledTimes(1);
  return pushSaveAndPlayMock.mock.calls[0][0] as unknown as Record<string, unknown>;
}

/** 构造一个 mock 的 hub 客户端（只实现 push 用到的成员） */
function mockHubClient(pushImpl: ReturnType<typeof vi.fn>): HubClient {
  return { push: pushImpl } as unknown as HubClient;
}

// ---------------------------------------------------------------------------
// push · 旗标决策与透传（hub 离线 → pushSaveAndPlay）
// ---------------------------------------------------------------------------

describe('pack push · 旗标决策（hub 离线 → pushSaveAndPlay）', () => {
  it('默认（无旗标）：dryRun=true（默认 dry-run）、各开关 false、retention=20、confirm 函数已注入', async () => {
    await runPush();

    const opts = pushOpts();
    expect(opts.root).toBe('.');
    expect(opts.dryRun).toBe(true);
    expect(opts.forceScriptsOnly).toBe(false);
    expect(opts.skipBackup).toBe(false);
    expect(opts.skipBaselineCheck).toBe(false);
    expect(opts.backupRetention).toBe(20);
    expect(typeof opts.confirm).toBe('function');
    expect(logSpy).toHaveBeenCalledWith(t('cli.pack.push.dryRunSummary', { pushed: 1, skipped: 0 }));
  });

  it('--root 透传 pushSaveAndPlay', async () => {
    await runPush(['--root', 'D:\\pack']);

    expect(pushOpts().root).toBe('D:\\pack');
  });

  it('--yes 是唯一实写入口：dryRun=false，输出 pushedSummary（无备份目录时 "-" 占位）', async () => {
    pushSaveAndPlayMock.mockResolvedValue({ dryRun: false, pushed: 1, skipped: 0, note: '' });
    await runPush(['--root', 'D:\\pack', '--yes']);

    expect(pushOpts().dryRun).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      t('cli.pack.push.pushedSummary', { pushed: 1, skipped: 0, backupDir: '-' }),
    );
  });

  it('--yes 且结果带 backupDir → pushedSummary 渲染备份目录', async () => {
    pushSaveAndPlayMock.mockResolvedValue({
      dryRun: false,
      pushed: 3,
      skipped: 1,
      backupDir: 'D:\\pack\\.tts\\backups\\t1',
      note: '',
    });
    await runPush(['--yes']);

    expect(logSpy).toHaveBeenCalledWith(
      t('cli.pack.push.pushedSummary', { pushed: 3, skipped: 1, backupDir: 'D:\\pack\\.tts\\backups\\t1' }),
    );
  });

  it('--no-backup → skipBackup:true', async () => {
    await runPush(['--yes', '--no-backup']);

    expect(pushOpts().skipBackup).toBe(true);
  });

  it('--no-baseline-check → skipBaselineCheck:true', async () => {
    await runPush(['--yes', '--no-baseline-check']);

    expect(pushOpts().skipBaselineCheck).toBe(true);
  });

  it('--force-scripts-only → forceScriptsOnly:true', async () => {
    await runPush(['--yes', '--force-scripts-only']);

    expect(pushOpts().forceScriptsOnly).toBe(true);
  });

  it('--backup-retention 7 → backupRetention:7（数字）', async () => {
    await runPush(['--backup-retention', '7']);

    expect(pushOpts().backupRetention).toBe(7);
  });

  it('--backup-retention 边界值 1 与 100 都放行', async () => {
    await runPush(['--backup-retention', '1']);
    expect(pushOpts().backupRetention).toBe(1);

    await runPush(['--backup-retention', '100']);
    expect(pushSaveAndPlayMock.mock.calls[1]?.[0]).toMatchObject({ backupRetention: 100 });
  });

  it.each(['abc', '0', '-3', '101'])('--backup-retention %s → error.cli.invalidBackupRetention + 退出 1，不探测 hub、不推送', async (bad) => {
    await expect(runPush(['--backup-retention', bad])).rejects.toMatchObject({ exitCode: 1 });

    expect(errSpy).toHaveBeenCalledWith(t('error.cli.invalidBackupRetention'));
    expect(tryHubClientMock).not.toHaveBeenCalled();
    expect(pushSaveAndPlayMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// push · 确认门回调（防御性二次闸：当前旗标决策下不触发询问）
// ---------------------------------------------------------------------------

describe('pack push · 确认门回调（confirmPush 防御性注入）', () => {
  it('dry-run 下回调直接放行，confirmPush 不被调用', async () => {
    await runPush();

    const confirm = pushOpts().confirm as () => Promise<boolean>;
    await expect(confirm()).resolves.toBe(true);
    expect(confirmPushMock).not.toHaveBeenCalled();
  });

  it('--yes（实写）下回调直接放行，confirmPush 不被调用（assumeYes 决策在旗标层完成）', async () => {
    await runPush(['--yes']);

    const confirm = pushOpts().confirm as () => Promise<boolean>;
    await expect(confirm()).resolves.toBe(true);
    expect(confirmPushMock).not.toHaveBeenCalled();
  });

  it('完整 --yes 实写流程全程不触发交互确认（confirmPush 零调用）', async () => {
    await runPush(['--yes']);

    expect(pushSaveAndPlayMock).toHaveBeenCalledTimes(1);
    expect(confirmPushMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// push · hub 委托路径
// ---------------------------------------------------------------------------

describe('pack push · hub 在线委托', () => {
  it('hub 在线 → 首行 viaHub，hub.push 收到 (root, true, 逐项透传的选项)，pushSaveAndPlay 不被调用', async () => {
    const pushFn = vi.fn().mockResolvedValue({ ok: true, dryRun: true, pushed: 2, skipped: 1, items: 3 });
    tryHubClientMock.mockResolvedValue(mockHubClient(pushFn));

    await runPush(['--root', 'D:\\pack']);

    expect(logSpy).toHaveBeenCalledWith(t('cli.pack.push.viaHub'));
    expect(pushFn).toHaveBeenCalledWith('D:\\pack', true, {
      dryRun: true,
      forceScriptsOnly: false,
      skipBackup: false,
      skipBaselineCheck: false,
      backupRetention: 20,
    });
    expect(pushSaveAndPlayMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(t('cli.pack.push.dryRunSummary', { pushed: 2, skipped: 1 }));
  });

  it('hub 在线 + 全旗标 → dryRun:false、skipBackup/skipBaselineCheck/forceScriptsOnly/retention 逐项透传', async () => {
    const pushFn = vi.fn().mockResolvedValue({
      ok: true,
      dryRun: false,
      pushed: 4,
      skipped: 0,
      items: 4,
      backupDir: 'D:\\pack\\.tts\\backups\\t2',
    });
    tryHubClientMock.mockResolvedValue(mockHubClient(pushFn));

    await runPush([
      '--root', 'D:\\pack',
      '--yes',
      '--no-backup',
      '--no-baseline-check',
      '--force-scripts-only',
      '--backup-retention', '9',
    ]);

    expect(pushFn).toHaveBeenCalledWith('D:\\pack', true, {
      dryRun: false,
      forceScriptsOnly: true,
      skipBackup: true,
      skipBaselineCheck: true,
      backupRetention: 9,
    });
    expect(logSpy).toHaveBeenCalledWith(
      t('cli.pack.push.pushedSummary', { pushed: 4, skipped: 0, backupDir: 'D:\\pack\\.tts\\backups\\t2' }),
    );
  });

  it('hub.push 抛 HubError → error.hub.delegateFailed + 退出 1，不回退独立模式', async () => {
    const pushFn = vi.fn().mockRejectedValue(new HubError(400, 'HUB_PACK_ERROR', 'hub-down', undefined));
    tryHubClientMock.mockResolvedValue(mockHubClient(pushFn));

    await expect(runPush(['--root', 'D:\\pack'])).rejects.toMatchObject({ exitCode: 1 });

    expect(errSpy).toHaveBeenCalledWith(t('error.hub.delegateFailed', { message: 'hub-down' }));
    expect(pushSaveAndPlayMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// push · 独立模式错误出口
// ---------------------------------------------------------------------------

describe('pack push · 独立模式错误出口', () => {
  it('pushSaveAndPlay 抛 PackError → reportPackError 按 error.<code> 出口 + 退出 1', async () => {
    pushSaveAndPlayMock.mockRejectedValue(new PackError('PACK_NOT_FOUND', 'no-pack-yaml'));
    await expect(runPush(['--root', 'D:\\pack'])).rejects.toMatchObject({ exitCode: 1 });

    expect(errSpy).toHaveBeenCalledWith(t('error.PACK_NOT_FOUND', { msg: 'no-pack-yaml' }));
  });

  it('pushSaveAndPlay 抛普通 Error → error.unknown 出口 + 退出 1', async () => {
    pushSaveAndPlayMock.mockRejectedValue(new Error('boom'));
    await expect(runPush()).rejects.toMatchObject({ exitCode: 1 });

    expect(errSpy).toHaveBeenCalledWith(t('error.unknown', { msg: 'boom' }));
  });
});

// ---------------------------------------------------------------------------
// diff · --unified
// ---------------------------------------------------------------------------

/** 构造 DiffResult 的便捷函数 */
function diffResult(entries: DiffResult['entries'], counts: { added: number; modified: number; deleted: number }): DiffResult {
  return { entries, ...counts };
}

describe('pack diff · --unified', () => {
  it('默认：diffWorkspace 收到 includeHunks:false，输出分组与 summary（现状不变）', async () => {
    diffWorkspaceMock.mockResolvedValue(
      diffResult(
        [{ guid: '-1', name: 'Global', kind: 'script', status: 'modified', localPath: 'D:\\pack\\scripts\\Global.lua' }],
        { added: 0, modified: 1, deleted: 0 },
      ),
    );
    await runDiff(['--root', 'D:\\pack']);

    expect(diffWorkspaceMock).toHaveBeenCalledWith({ root: 'D:\\pack', includeHunks: false });
    expect(logSpy).toHaveBeenCalledWith(t('cli.pack.diff.summary', { added: 0, modified: 1, deleted: 0 }));
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('@@'));
  });

  it('--unified：diffWorkspace 收到 includeHunks:true，hunks 按 @@ -localStart,localLines.length +remoteStart,remoteLines.length @@ 渲染，- 为本地行 + 为游戏侧行', async () => {
    diffWorkspaceMock.mockResolvedValue(
      diffResult(
        [
          {
            guid: 'aa11bb',
            name: '棋盘',
            kind: 'script',
            status: 'modified',
            localPath: 'D:\\pack\\scripts\\aa11bb.棋盘.lua',
            hunks: [
              { localStart: 2, localLines: ['ctx', 'local-new'], remoteStart: 2, remoteLines: ['ctx', 'remote-old'] },
            ],
          },
        ],
        { added: 0, modified: 1, deleted: 0 },
      ),
    );
    await runDiff(['--root', 'D:\\pack', '--unified']);

    expect(diffWorkspaceMock).toHaveBeenCalledWith({ root: 'D:\\pack', includeHunks: true });
    const logged = logSpy.mock.calls.map((call) => call.join(' '));
    expect(logged).toContain('  @@ -2,2 +2,2 @@');
    expect(logged).toContain('    - ctx');
    expect(logged).toContain('    - local-new');
    expect(logged).toContain('    + ctx');
    expect(logged).toContain('    + remote-old');
  });

  it('-u 是 --unified 的短旗标', async () => {
    diffWorkspaceMock.mockResolvedValue(diffResult([], { added: 0, modified: 0, deleted: 0 }));
    await runDiff(['-u']);

    expect(diffWorkspaceMock).toHaveBeenCalledWith({ root: '.', includeHunks: true });
  });

  it('--unified 但条目无 hunks（added / deleted / 超 5000 行）→ 不打印 @@，不报错', async () => {
    diffWorkspaceMock.mockResolvedValue(
      diffResult(
        [
          { guid: 'aa11bb', name: '棋盘', kind: 'script', status: 'added' },
          { guid: 'cc22dd', name: '牌堆', kind: 'ui', status: 'deleted', localPath: 'D:\\pack\\ui\\cc22dd.牌堆.xml' },
        ],
        { added: 1, modified: 0, deleted: 1 },
      ),
    );
    await runDiff(['--unified']);

    const logged = logSpy.mock.calls.map((call) => call.join(' '));
    expect(logged.some((line) => line.includes('@@'))).toBe(false);
  });

  it('diffWorkspace 抛 PackError → reportPackError 出口 + 退出 1', async () => {
    diffWorkspaceMock.mockRejectedValue(new PackError('PACK_NOT_FOUND', 'no-pack-yaml'));
    await expect(runDiff(['--root', 'D:\\pack'])).rejects.toMatchObject({ exitCode: 1 });

    expect(errSpy).toHaveBeenCalledWith(t('error.PACK_NOT_FOUND', { msg: 'no-pack-yaml' }));
  });
});
