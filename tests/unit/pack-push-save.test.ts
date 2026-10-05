// tests/unit/pack-push-save.test.ts
/**
 * src/pack/push.ts · pushSaveAndPlay 单元测试：完整 push 流水线
 * （备份 → 基线校验 → 素材检测 → 过滤 → 确认 → 发送 → 回读校验 → 更新 baseline）。
 *
 * 无真网络 / 无真 TTS（约定：单测必须 mock 网络与文件系统之外的外部依赖）：
 * - `sendToTts` 被 vi.mock 成记录器（wireLog）：断言出站消息序列与 SaveAndPlay 携带的
 *   scriptStates，绝不真连 39999；
 * - `withEditorServer` 被 vi.mock 成"用共享 stub 调回调"（stubHolder）：独立模式路径
 *   （坑 17 缺省分支）不真绑 39998；
 * - EditorServer 用最小 stub：`find` 恒空 + `waitFor` 按队列依次回推 GameLoaded
 *   （getScripts / saveAndPlay / 回读各消费一条，队空后粘住最后一条）；
 *   SessionScripts 用真实现——stub 满足它的 waitFor 协议即可；
 * - 文件系统用真临时目录（mkdtemp + rm -rf）：备份、baseline、工作区文件全部落盘断言。
 *
 * 夹具约定：
 * - 基线用真 API 造：`writeBaseline(root, 初始游戏侧 states)` 与游戏侧一致 → 无冲突；
 * - 完整流的三段回推 = [初始快照, saveAndPlay 确认, 回读快照]，由 queueFlow 组装；
 * - 错误按 PackError.code 断言（rejects.toMatchObject({ code })），不断言 message
 *   （错误 message 是 t() 产物，文案由 Run 2 补齐 locales 后才完整）；
 * - note 按 t() 渲染契约断言（键 + 参数），与文案解耦。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 出站消息记录器（vi.hoisted 保证 mock 工厂可用）：sendToTts 收到的每条消息按序追加。 */
const wireLog = vi.hoisted(() => ({ messages: [] as Array<Record<string, unknown>> }));

/** 共享 stub 容器（vi.hoisted）：withEditorServer 的 mock 用它构造会话。 */
const stubHolder = vi.hoisted(() => ({ stub: undefined as unknown }));

// —— 网络 mock：出站只记录不发送（约束 7 的协议层出口在此被拦截观察）——
vi.mock('../../src/protocol/tts-client.js', () => ({
  sendToTts: async (msg: Record<string, unknown>): Promise<void> => {
    wireLog.messages.push(msg);
  },
}));

// —— 独立模式 mock：withEditorServer 不绑 39998，直接用共享 stub 起真 SessionScripts ——
vi.mock('../../src/cli/with-server.js', async () => {
  const { SessionScripts } = await vi.importActual<typeof import('../../src/session/scripts.js')>(
    '../../src/session/scripts.js',
  );
  const withEditorServer = async (
    fn: (session: {
      server: unknown;
      exec: Record<string, never>;
      scripts: InstanceType<typeof SessionScripts>;
    }) => Promise<unknown>,
  ): Promise<unknown> => {
    if (stubHolder.stub === undefined) {
      throw new Error('独立模式用例必须先在 beforeEach 里设置 stubHolder.stub');
    }
    return await fn({
      server: stubHolder.stub,
      exec: {},
      scripts: new SessionScripts(stubHolder.stub as never),
    });
  };
  return { withEditorServer };
});

import { t } from '../../src/i18n/index.js';
import { InboundId, OutboundId } from '../../src/protocol/messages.js';
import type { EditorServer } from '../../src/protocol/editor-server.js';
import { scriptFileName } from '../../src/pack/layout.js';
import { writePackYaml } from '../../src/pack/packyaml.js';
import { pushSaveAndPlay, type PushSaveOptions } from '../../src/pack/push.js';
import { listBackups } from '../../src/safety/backup.js';
import { readBaseline, touchLastPushAt, writeBaseline } from '../../src/safety/baseline.js';
import type { ScriptState } from '../../src/session/scripts.js';

// ---------------------------------------------------------------------------
// 临时目录与 stub
// ---------------------------------------------------------------------------

/** 每个用例独立的临时根目录（beforeEach 创建，afterEach 删除） */
let tempRoot: string;

/** 当前用例的 EditorServer stub（beforeEach 重建并注入 stubHolder / 用例入参） */
let stubServer: StubEditorServer;

/** 每用例统一的等待超时（协议 stub 同步回推，正常不会触发） */
const TIMEOUT_MS = 5_000;

beforeEach(() => {
  tempRoot = '';
  stubServer = new StubEditorServer();
  stubHolder.stub = stubServer as unknown as EditorServer;
  wireLog.messages.length = 0;
});

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-toolkit-push-save-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/**
 * EditorServer 最小 stub：SessionScripts 只依赖 find（排除旧快照）与 waitFor（取新回推）。
 * 队列依次出队；队空后粘住最后一条（多余的 waitFor 不挂死）。
 */
class StubEditorServer {
  private queue: Array<{ messageID: typeof InboundId.GameLoaded; scriptStates: ScriptState[] }> = [];
  private last: { messageID: typeof InboundId.GameLoaded; scriptStates: ScriptState[] } = {
    messageID: InboundId.GameLoaded,
    scriptStates: [],
  };

  /** 追加一条 GameLoaded 回推（scriptStates 即游戏侧快照）。 */
  enqueue(states: ScriptState[]): void {
    this.queue.push({ messageID: InboundId.GameLoaded, scriptStates: states });
  }

  find(): never[] {
    return [];
  }

  async waitFor(): Promise<{ messageID: typeof InboundId.GameLoaded; scriptStates: ScriptState[] }> {
    const next = this.queue.shift();
    if (next !== undefined) {
      this.last = next;
    }
    return this.last;
  }
}

// ---------------------------------------------------------------------------
// 测试夹具与辅助
// ---------------------------------------------------------------------------

/** makePackRoot 写入的图包名（备份 manifest.packName 断言用） */
const PACK_NAME = '推送测试图包';

/**
 * 建一个带合法 pack.yaml 的工作区根目录（不建 scripts/ ui/，按用例自行落文件）。
 * @returns 工作区根目录
 */
async function makePackRoot(): Promise<string> {
  const root = path.join(tempRoot, 'pack');
  await writePackYaml(root, {
    schema_version: 1,
    name: PACK_NAME,
    workshop_id: null,
    source_mod: null,
    host: 'steamcloud',
    vcs: { lfs: 'disabled-no-lfs' },
    paths: { workdir: '.' },
    upload: { prefix: '' },
  });
  return root;
}

/** 往 <root>/scripts/ 落一个脚本文件（自动建目录） */
async function writeScript(root: string, fileName: string, content: string): Promise<void> {
  const dir = path.join(root, 'scripts');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), content, 'utf8');
}

/** 往 <root>/ui/ 落一个 UI 文件（自动建目录） */
async function writeUi(root: string, fileName: string, content: string): Promise<void> {
  const dir = path.join(root, 'ui');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), content, 'utf8');
}

/** 往 <root>/decks/<deckName>/ 落素材清单文件（素材改动检测的夹具） */
async function writeDeck(
  root: string,
  deckName: string,
  files: { cards?: string; deckYaml?: string },
): Promise<void> {
  const dir = path.join(root, 'decks', deckName);
  await mkdir(dir, { recursive: true });
  if (files.cards !== undefined) {
    await writeFile(path.join(dir, 'cards.csv'), files.cards, 'utf8');
  }
  if (files.deckYaml !== undefined) {
    await writeFile(path.join(dir, 'deck.yaml'), files.deckYaml, 'utf8');
  }
}

/** 构造一个 ScriptState（script / ui 按需给，缺省不带字段） */
function state(guid: string, name: string, fields: { script?: string; ui?: string } = {}): ScriptState {
  return { guid, name, ...fields };
}

/**
 * 组装完整流的三段回推：初始快照 ×2（getScripts + saveAndPlay 确认）+ 回读快照。
 * @param stub 目标 stub
 * @param initial push 前游戏侧快照
 * @param reread 写回后回读快照（校验通过的场景里应与发送内容一致）
 */
function queueFlow(stub: StubEditorServer, initial: ScriptState[], reread: ScriptState[]): void {
  stub.enqueue(initial);
  stub.enqueue(initial);
  stub.enqueue(reread);
}

/** 组装 pushSaveAndPlay 入参（缺省注入 stub server；测试按需覆盖） */
function pushOpts(root: string, overrides: Partial<PushSaveOptions> = {}): PushSaveOptions {
  return {
    root,
    server: stubServer as unknown as EditorServer,
    timeoutMs: TIMEOUT_MS,
    ...overrides,
  };
}

/** 已出站的 SaveAndPlay 消息携带的 scriptStates（没有 SaveAndPlay 时断言失败） */
function sentStates(): ScriptState[] {
  const save = wireLog.messages.find((m) => m.messageID === OutboundId.SaveAndPlay);
  expect(save, '预期已有一条 SaveAndPlay 出站消息').toBeDefined();
  return (save as { scriptStates: ScriptState[] }).scriptStates;
}

/** 全部出站消息的 messageID 序列 */
function outboundIds(): number[] {
  return wireLog.messages.map((m) => m.messageID as number);
}

/** 手工 seed 一份过期备份（manifest 合法可读，供 retention 清理用例计数） */
async function seedBackup(root: string, timestamp: string): Promise<void> {
  const dir = path.join(root, '.tts', 'backups', timestamp);
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await mkdir(path.join(dir, 'ui'), { recursive: true });
  const manifest = {
    createdAt: timestamp,
    reason: 'push',
    packRoot: root,
    packName: PACK_NAME,
    scriptsCount: 0,
    uiCount: 0,
  };
  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** 生成一个"过去"的备份目录名（比当前时刻早 secondsAgo 秒），格式与 createBackup 一致 */
function pastTimestamp(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/:/g, '-');
}

/** 与 baseline.ts 同款：归一化文本的 sha256（fixture 断言用；无 CRLF 时即原文 hash） */
function expectedHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n').trimEnd(), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// dryRun（默认不实写）
// ---------------------------------------------------------------------------

describe('pushSaveAndPlay · dryRun（默认不实写）', () => {
  it('默认 dryRun=true：零副作用（无 SaveAndPlay 出站、无备份目录、不写 baseline）', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    queueFlow(stubServer, [state('-1', 'Global', { script: '--global v1', ui: '<G/>' })], []);

    const result = await pushSaveAndPlay(pushOpts(root));

    expect(result.dryRun).toBe(true);
    expect(result.backupDir).toBeUndefined();
    expect(outboundIds()).toEqual([OutboundId.GetScripts]); // 只拉了快照，没有写回
    expect(existsSync(path.join(root, '.tts', 'backups'))).toBe(false);
    expect(await readBaseline(root)).toBeNull();
  });

  it('dryRun 计数：1 个有变化 + 1 个无变化 → pushed=1 skipped=1，note 为 noteDryRun 契约', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2'); // 有变化
    await writeScript(root, 'aa11.棋子.lua', '--pawn'); // 与游戏侧一致 → 跳过
    queueFlow(
      stubServer,
      [
        state('-1', 'Global', { script: '--global v1' }),
        state('aa11', '棋子', { script: '--pawn' }),
      ],
      [],
    );

    const result = await pushSaveAndPlay(pushOpts(root));

    expect(result).toMatchObject({ dryRun: true, pushed: 1, skipped: 1 });
    expect(result.note).toBe(t('cli.pack.push.noteDryRun', { pushed: 1, skipped: 1 }));
  });

  it('dryRun 不调用 confirm（确认门只属于实写路径）', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    queueFlow(stubServer, [state('-1', 'Global', { script: '--global v1' })], []);
    const confirm = vi.fn(async () => true);

    await pushSaveAndPlay(pushOpts(root, { confirm }));

    expect(confirm).not.toHaveBeenCalled();
  });

  it('dryRun=true 不改既有 baseline（updatedAt / lastPushAt 原样保留）', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    queueFlow(stubServer, initial, []);
    await writeBaseline(root, initial);
    await touchLastPushAt(root);
    const before = await readBaseline(root);

    await pushSaveAndPlay(pushOpts(root));

    expect(await readBaseline(root)).toEqual(before);
  });

  it('dryRun=true 且素材被 forceScriptsOnly 放行 → assetChanges 携带且仍无备份', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    await writeDeck(root, '牌堆A', { cards: 'id,name\n1,a\n' });
    await writeBaseline(root, [state('-1', 'Global', { script: '--global v1' })]);
    await writeDeck(root, '牌堆A', { cards: 'id,name\n1,b\n' }); // 改动素材
    queueFlow(stubServer, [state('-1', 'Global', { script: '--global v1' })], []);

    const result = await pushSaveAndPlay(pushOpts(root, { forceScriptsOnly: true }));

    expect(result.dryRun).toBe(true);
    expect(result.assetChanges).toEqual({ changed: ['decks/牌堆A/cards.csv'], added: [], deleted: [] });
    expect(result.backupDir).toBeUndefined();
    expect(outboundIds()).toEqual([OutboundId.GetScripts]);
  });

  it('dryRun=true 且基线冲突被 skipBaselineCheck 放行 → baselineConflicts 携带', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v1');
    // 基线记录的 script 与游戏侧快照不同 → 冲突
    await writeBaseline(root, [state('-1', 'Global', { script: '--别处改过' })]);
    queueFlow(stubServer, [state('-1', 'Global', { script: '--global v1' })], []);

    const result = await pushSaveAndPlay(pushOpts(root, { skipBaselineCheck: true }));

    expect(result.dryRun).toBe(true);
    expect(result.baselineConflicts).toHaveLength(1);
    expect(result.baselineConflicts?.[0]).toMatchObject({ guid: '-1', kind: 'script' });
  });
});

// ---------------------------------------------------------------------------
// 完整写回流（dryRun=false）
// ---------------------------------------------------------------------------

describe('pushSaveAndPlay · 完整写回流（dryRun=false）', () => {
  it('出站序列 GetScripts → SaveAndPlay → GetScripts；SaveAndPlay 只携带过滤后的有变化对象', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2'); // 有变化
    await writeScript(root, 'aa11.棋子.lua', '--pawn'); // 无变化 → 不发送
    const initial = [
      state('-1', 'Global', { script: '--global v1', ui: '<G/>' }),
      state('aa11', '棋子', { script: '--pawn' }),
    ];
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2', ui: '<G/>' })]);
    await writeBaseline(root, initial);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(result.dryRun).toBe(false);
    expect(outboundIds()).toEqual([OutboundId.GetScripts, OutboundId.SaveAndPlay, OutboundId.GetScripts]);
    expect(sentStates()).toEqual([{ name: 'Global', guid: '-1', script: '--global v2', ui: '<G/>' }]);
  });

  it('实写结果：backupDir 在 .tts/backups 下，note 为 noteDone 契约', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2' })]);
    await writeBaseline(root, initial);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(result.pushed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.backupDir).toBeDefined();
    expect(result.backupDir?.startsWith(path.join(root, '.tts', 'backups'))).toBe(true);
    expect(result.note).toBe(t('cli.pack.push.noteDone', { pushed: 1, skipped: 0 }));
  });

  it('备份 manifest：reason=push、packName、scriptsCount/uiCount 对齐初始游戏侧快照', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [
      state('-1', 'Global', { script: '--global v1', ui: '<G/>' }),
      state('aa11', '棋子', { script: '--pawn', ui: '<P/>' }),
      state('bb22', '无脚本对象', { ui: '<B/>' }), // 只有 UI
    ];
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2', ui: '<G/>' })]);
    await writeBaseline(root, initial);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));
    const backups = await listBackups(root);

    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({
      reason: 'push',
      packName: PACK_NAME,
      scriptsCount: 2, // Global + aa11 有 script
      uiCount: 3, // 三者都有 ui
    });
    expect(backups[0].createdAt).toBe(path.basename(result.backupDir ?? ''));
  });

  it('备份内容 = 初始游戏侧快照（文件名与 layout.scriptFileName 命名一致）', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1', ui: '<G/>' })];
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2', ui: '<G/>' })]);
    await writeBaseline(root, initial);

    await pushSaveAndPlay(pushOpts(root, { dryRun: false }));
    const backupDir = (await listBackups(root))[0];
    const backupDirPath = path.join(root, '.tts', 'backups', backupDir.createdAt);

    expect(await readFile(path.join(backupDirPath, 'scripts', 'Global.lua'), 'utf8')).toBe('--global v1');
    expect(await readFile(path.join(backupDirPath, 'ui', 'Global.xml'), 'utf8')).toBe('<G/>');
    // 工作区文件不被备份动作改写
    expect(await readFile(path.join(root, 'scripts', 'Global.lua'), 'utf8')).toBe('--global v2');
  });

  it('写回成功后 baseline 更新为回读快照，且 lastPushAt 被盖戳', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2' })]);
    await writeBaseline(root, initial);

    await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    const baseline = await readBaseline(root);
    expect(baseline).not.toBeNull();
    expect(baseline?.entries).toEqual([
      { guid: '-1', name: 'Global', scriptHash: expectedHash('--global v2') },
    ]);
    expect(typeof baseline?.lastPushAt).toBe('string');
  });

  it('confirm 返回 true → 确认门放行，流程完整走完', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2' })]);
    await writeBaseline(root, initial);
    const confirm = vi.fn(async () => true);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false, confirm }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.dryRun).toBe(false);
    expect(outboundIds()).toContain(OutboundId.SaveAndPlay);
  });

  it('缺省 confirm（CLI 不传门）→ 直接执行', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2' })]);
    await writeBaseline(root, initial);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(result.pushed).toBe(1);
    expect(outboundIds()).toEqual([OutboundId.GetScripts, OutboundId.SaveAndPlay, OutboundId.GetScripts]);
  });

  it('全部无变化 → pushed=0，仍按流程发送空 scriptStates 并更新 baseline', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v1');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    queueFlow(stubServer, initial, initial);
    await writeBaseline(root, initial);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(result).toMatchObject({ dryRun: false, pushed: 0, skipped: 1 });
    expect(sentStates()).toEqual([]);
    expect(await readBaseline(root)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 素材改动拦截（约束 7：push 协议不接收素材字段）
// ---------------------------------------------------------------------------

describe('pushSaveAndPlay · 素材改动拦截（PUSH_ASSET_CHANGES_DETECTED）', () => {
  it('changed：基线记录过的 cards.csv 内容变化 → 抛错且无 SaveAndPlay 出站', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v1');
    await writeDeck(root, '牌堆A', { cards: 'id,name\n1,a\n' });
    await writeBaseline(root, [state('-1', 'Global', { script: '--global v1' })]);
    await writeDeck(root, '牌堆A', { cards: 'id,name\n1,b\n' }); // 素材改动
    queueFlow(stubServer, [state('-1', 'Global', { script: '--global v1' })], []);

    await expect(pushSaveAndPlay(pushOpts(root, { dryRun: false }))).rejects.toMatchObject({
      code: 'PUSH_ASSET_CHANGES_DETECTED',
    });
    expect(outboundIds()).toEqual([OutboundId.GetScripts]);
  });

  it('added：基线没记录的新 deck.yaml → 抛同码', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v1');
    await writeBaseline(root, [state('-1', 'Global', { script: '--global v1' })]);
    await writeDeck(root, '新牌堆', { deckYaml: 'name: 新牌堆\n' }); // 基线之后新增
    queueFlow(stubServer, [state('-1', 'Global', { script: '--global v1' })], []);

    await expect(pushSaveAndPlay(pushOpts(root))).rejects.toMatchObject({
      code: 'PUSH_ASSET_CHANGES_DETECTED',
    });
  });

  it('deleted：基线记录过的素材文件被删除 → 抛同码', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v1');
    await writeDeck(root, '牌堆A', { cards: 'id,name\n1,a\n' });
    await writeBaseline(root, [state('-1', 'Global', { script: '--global v1' })]);
    await unlink(path.join(root, 'decks', '牌堆A', 'cards.csv')); // 素材被删
    queueFlow(stubServer, [state('-1', 'Global', { script: '--global v1' })], []);

    await expect(pushSaveAndPlay(pushOpts(root))).rejects.toMatchObject({
      code: 'PUSH_ASSET_CHANGES_DETECTED',
    });
  });

  it('首跑（无基线）且工作区有素材 → 全部记为 added，同样拦截', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v1');
    await writeDeck(root, '牌堆A', { cards: 'id,name\n1,a\n' });
    queueFlow(stubServer, [state('-1', 'Global', { script: '--global v1' })], []);

    await expect(pushSaveAndPlay(pushOpts(root))).rejects.toMatchObject({
      code: 'PUSH_ASSET_CHANGES_DETECTED',
    });
  });

  it('forceScriptsOnly=true → 放行并完成写回，结果携带三类素材改动', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    // 基线记录：cards v1 + 新牌堆不存在 + objects.csv 存在
    await writeDeck(root, '牌堆A', { cards: 'v1' });
    await mkdir(path.join(root, 'objects'), { recursive: true });
    await writeFile(path.join(root, 'objects', 'objects.csv'), 'old\n', 'utf8');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    await writeBaseline(root, initial);
    // 三类改动各一个：changed（cards 重写）/ deleted（objects.csv 删除）/ added（新 deck.yaml）
    await writeDeck(root, '牌堆A', { cards: 'v2' });
    await unlink(path.join(root, 'objects', 'objects.csv'));
    await writeDeck(root, '新牌堆', { deckYaml: 'name: 新牌堆\n' });
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2' })]);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false, forceScriptsOnly: true }));

    expect(result.dryRun).toBe(false);
    expect(result.pushed).toBe(1);
    expect(result.assetChanges).toEqual({
      changed: ['decks/牌堆A/cards.csv'],
      added: ['decks/新牌堆/deck.yaml'],
      deleted: ['objects/objects.csv'],
    });
    expect(outboundIds()).toContain(OutboundId.SaveAndPlay);
  });

  it('素材门先于基线门：素材改动 + 基线冲突同时存在 → 抛素材错误码', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v1');
    await writeDeck(root, '牌堆A', { cards: 'v1' });
    // 基线：素材记的是 cards v1，script 记的是别处改过的版本
    await writeBaseline(root, [state('-1', 'Global', { script: '--别处改过' })]);
    await writeDeck(root, '牌堆A', { cards: 'v2' });
    queueFlow(stubServer, [state('-1', 'Global', { script: '--global v1' })], []);

    await expect(pushSaveAndPlay(pushOpts(root))).rejects.toMatchObject({
      code: 'PUSH_ASSET_CHANGES_DETECTED',
    });
  });
});

// ---------------------------------------------------------------------------
// 基线冲突拦截（游戏侧被人改过 → 先 pull 对账）
// ---------------------------------------------------------------------------

describe('pushSaveAndPlay · 基线冲突拦截（BASELINE_CONFLICT）', () => {
  it('游戏侧 script 相对基线被改 → 抛错且无 SaveAndPlay 出站', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v1');
    await writeBaseline(root, [state('-1', 'Global', { script: '--global v1' })]);
    // 游戏侧快照的 script 与基线不同（别人在游戏里改过）
    queueFlow(stubServer, [state('-1', 'Global', { script: '--游戏内被改' })], []);

    await expect(pushSaveAndPlay(pushOpts(root, { dryRun: false }))).rejects.toMatchObject({
      code: 'BASELINE_CONFLICT',
    });
    expect(outboundIds()).toEqual([OutboundId.GetScripts]);
  });

  it('游戏侧 ui 被改 → 冲突 kind 为 ui（skipBaselineCheck 放行后从结果断言）', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v1');
    await writeUi(root, 'Global.xml', '<G/>');
    await writeBaseline(root, [state('-1', 'Global', { script: '--global v1', ui: '<G/>' })]);
    queueFlow(stubServer, [state('-1', 'Global', { script: '--global v1', ui: '<G 被改/>' })], []);

    const result = await pushSaveAndPlay(pushOpts(root, { skipBaselineCheck: true }));

    expect(result.baselineConflicts).toHaveLength(1);
    expect(result.baselineConflicts?.[0]).toMatchObject({ guid: '-1', kind: 'ui' });
    expect(result.baselineConflicts?.[0].baselineHash).toBe(expectedHash('<G/>'));
    expect(result.baselineConflicts?.[0].remoteHash).toBe(expectedHash('<G 被改/>'));
  });

  it('skipBaselineCheck=true → 冲突不中断，结果携带冲突清单并完成写回', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    await writeBaseline(root, [state('-1', 'Global', { script: '--基线版本' })]);
    queueFlow(stubServer, [state('-1', 'Global', { script: '--游戏内被改' })], [
      state('-1', 'Global', { script: '--global v2' }),
    ]);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false, skipBaselineCheck: true }));

    expect(result.pushed).toBe(1);
    expect(result.baselineConflicts).toHaveLength(1);
    expect(outboundIds()).toContain(OutboundId.SaveAndPlay);
  });

  it('远端有基线没有的新对象 → 不算冲突（新增不是覆盖风险）', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v1');
    await writeBaseline(root, [state('-1', 'Global', { script: '--global v1' })]);
    queueFlow(
      stubServer,
      [
        state('-1', 'Global', { script: '--global v1' }),
        state('bb22', '新对象', { script: '--new' }),
      ],
      [],
    );

    const result = await pushSaveAndPlay(pushOpts(root));

    expect(result.baselineConflicts).toBeUndefined();
  });

  it('基线记录的对象整个从游戏侧消失 → 冲突（baselineHash 有、remoteHash 无）', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v1');
    await writeBaseline(root, [
      state('-1', 'Global', { script: '--global v1' }),
      state('aa11', '消失的对象', { script: '--gone' }),
    ]);
    queueFlow(stubServer, [state('-1', 'Global', { script: '--global v1' })], []);

    const result = await pushSaveAndPlay(pushOpts(root, { skipBaselineCheck: true }));

    expect(result.baselineConflicts).toEqual([
      { guid: 'aa11', name: '消失的对象', kind: 'script', baselineHash: expectedHash('--gone') },
    ]);
  });

  it('baseline 不存在（首次 push）→ 不抛 BASELINE_CONFLICT，全流程完成', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    queueFlow(stubServer, [state('-1', 'Global', { script: '--global v1' })], [
      state('-1', 'Global', { script: '--global v2' }),
    ]);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(result.dryRun).toBe(false);
    expect(result.baselineConflicts).toBeUndefined();
    expect(result.pushed).toBe(1);
    // 首跑写回后建立了基线
    expect(await readBaseline(root)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 无变化过滤（normalizeContent 归一化）
// ---------------------------------------------------------------------------

describe('pushSaveAndPlay · 无变化过滤（内容归一化）', () => {
  it('混合场景：Global 改 script+ui、bb22 改 ui、aa11 没改 → pushed=2 skipped=1', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2'); // 改 script
    await writeUi(root, 'Global.xml', '<G v2/>');
    await writeScript(root, 'aa11.棋子.lua', '--pawn'); // 没改
    await writeUi(root, 'bb22.棋盘.xml', '<B v2/>'); // 只改 ui
    const initial = [
      state('-1', 'Global', { script: '--global v1', ui: '<G v1/>' }),
      state('aa11', '棋子', { script: '--pawn' }),
      state('bb22', '棋盘', { ui: '<B v1/>' }),
    ];
    queueFlow(
      stubServer,
      initial,
      [
        state('-1', 'Global', { script: '--global v2', ui: '<G v2/>' }),
        state('aa11', '棋子', { script: '--pawn' }),
        state('bb22', '棋盘', { ui: '<B v2/>' }),
      ],
    );
    await writeBaseline(root, initial);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    // pushed 按对象计：Global 的 script+ui 两处改动算 1 个对象
    expect(result.pushed).toBe(2);
    expect(result.skipped).toBe(1);
    // bb22 本地只有 UI、远端也没有 script 字段 → 发送 state 不带 script 键
    expect(sentStates()).toEqual([
      { name: 'Global', guid: '-1', script: '--global v2', ui: '<G v2/>' },
      { name: '棋盘', guid: 'bb22', ui: '<B v2/>' },
    ]);
  });

  it('本地 CRLF、游戏侧 LF → 归一化后无变化，跳过', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'aa11.棋子.lua', '--pawn\r\nprint(1)\r\n');
    const initial = [state('aa11', '棋子', { script: '--pawn\nprint(1)\n' })];
    queueFlow(stubServer, initial, []);

    const result = await pushSaveAndPlay(pushOpts(root));

    expect(result.pushed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('结尾空行差异 → trimEnd 后无变化，跳过', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'aa11.棋子.lua', '--pawn\n\n\n');
    queueFlow(stubServer, [state('aa11', '棋子', { script: '--pawn' })], []);

    const result = await pushSaveAndPlay(pushOpts(root));

    expect(result.pushed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('行内空格差异不属于归一化范围 → 算变化并推送', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'aa11.棋子.lua', '--pawn  spaced');
    queueFlow(stubServer, [state('aa11', '棋子', { script: '--pawn spaced' })], [
      state('aa11', '棋子', { script: '--pawn  spaced' }),
    ]);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(result.pushed).toBe(1);
    expect(sentStates()[0].script).toBe('--pawn  spaced');
  });

  it('本地有空脚本文件、游戏侧缺 script 字段 → 缺→有算变化并推送', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'aa11.棋子.lua', '');
    queueFlow(stubServer, [state('aa11', '棋子', { ui: '<P/>' })], [
      state('aa11', '棋子', { script: '', ui: '<P/>' }),
    ]);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(result.pushed).toBe(1);
    expect(sentStates()).toEqual([{ name: '棋子', guid: 'aa11', script: '', ui: '<P/>' }]);
  });

  it('回读快照换行风格与发送内容不同（CRLF 化）→ 归一化校验仍通过', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'aa11.棋子.lua', '--pawn v2\nprint(1)\n');
    const initial = [state('aa11', '棋子', { script: '--pawn v1' })];
    queueFlow(stubServer, initial, [state('aa11', '棋子', { script: '--pawn v2\r\nprint(1)\r\n' })]);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(result.pushed).toBe(1);
    expect(await readBaseline(root)).not.toBeNull(); // 校验通过 → baseline 已更新
  });
});

// ---------------------------------------------------------------------------
// 强制带 ui / name 对账（缺字段 = TTS 删除，绝不允许）
// ---------------------------------------------------------------------------

describe('pushSaveAndPlay · 强制带 ui 与 name 对账', () => {
  it('scriptPath 有、uiPath 缺 → 发送的 state 补上游戏侧 ui 原文', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'aa11.棋子.lua', '--pawn v2');
    const remoteUi = '<Panel id="pawn"><Text text="棋子"/></Panel>';
    queueFlow(stubServer, [state('aa11', '棋子', { script: '--pawn v1', ui: remoteUi })], [
      state('aa11', '棋子', { script: '--pawn v2', ui: remoteUi }),
    ]);

    await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(sentStates()).toEqual([{ name: '棋子', guid: 'aa11', script: '--pawn v2', ui: remoteUi }]);
  });

  it('uiPath 有、scriptPath 缺 → 发送的 state 补上游戏侧 script 原文', async () => {
    const root = await makePackRoot();
    await writeUi(root, 'aa11.棋子.xml', '<Panel v2/>');
    queueFlow(stubServer, [state('aa11', '棋子', { script: '--remote script', ui: '<Panel v1/>' })], [
      state('aa11', '棋子', { script: '--remote script', ui: '<Panel v2/>' }),
    ]);

    await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(sentStates()).toEqual([
      { name: '棋子', guid: 'aa11', script: '--remote script', ui: '<Panel v2/>' },
    ]);
  });

  it('scriptPath 缺且游戏侧也没有 script 字段 → 发送的 state 不带 script 键', async () => {
    const root = await makePackRoot();
    await writeUi(root, 'aa11.棋子.xml', '<Panel v2/>');
    queueFlow(stubServer, [state('aa11', '棋子', { ui: '<Panel v1/>' })], [
      state('aa11', '棋子', { ui: '<Panel v2/>' }),
    ]);

    await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    const sent = sentStates();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ name: '棋子', guid: 'aa11', ui: '<Panel v2/>' });
    expect('script' in sent[0]).toBe(false);
  });

  it('name 用游戏侧真实显示名（不用文件名净化名，避免把对象改名）', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'aa11.Chess_Pawn.lua', '--pawn v2');
    queueFlow(stubServer, [state('aa11', 'Chess Pawn', { script: '--pawn v1' })], [
      state('aa11', 'Chess Pawn', { script: '--pawn v2' }),
    ]);

    await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(sentStates()[0].name).toBe('Chess Pawn');
  });

  it('游戏侧没有该 guid（新对象）→ name 回退净化名，且不补 ui 字段', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'bb22.New_Object.lua', '--brand new');
    queueFlow(stubServer, [state('-1', 'Global', { script: '--global v1' })], [
      state('-1', 'Global', { script: '--global v1' }),
      state('bb22', 'New_Object', { script: '--brand new' }),
    ]);

    await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    const sent = sentStates();
    const added = sent.find((s) => s.guid === 'bb22');
    expect(added).toEqual({ name: 'New_Object', guid: 'bb22', script: '--brand new' });
    expect('ui' in (added as ScriptState)).toBe(false);
  });

  it('中文 name 全链路：发送用游戏侧中文名，备份 / 基线不依赖显示名', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'cc33.冒险牌堆.lua', '--deck v2');
    const initial = [state('cc33', '冒险牌堆（主线）', { script: '--deck v1', ui: '<D/>' })];
    queueFlow(stubServer, initial, [state('cc33', '冒险牌堆（主线）', { script: '--deck v2', ui: '<D/>' })]);
    await writeBaseline(root, initial);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(sentStates()).toEqual([
      { name: '冒险牌堆（主线）', guid: 'cc33', script: '--deck v2', ui: '<D/>' },
    ]);
    // 备份按净化名落盘（与 pull 命名一致）
    const backupDir = path.join(root, '.tts', 'backups', (await listBackups(root))[0].createdAt);
    expect(
      existsSync(path.join(backupDir, 'scripts', scriptFileName('cc33', '冒险牌堆（主线）'))),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 确认门
// ---------------------------------------------------------------------------

describe('pushSaveAndPlay · 确认门（PUSH_ABORTED）', () => {
  it('confirm 返回 false → 抛 PUSH_ABORTED；SaveAndPlay 未出站、baseline 未写', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    queueFlow(stubServer, initial, []);
    await writeBaseline(root, initial);

    await expect(
      pushSaveAndPlay(pushOpts(root, { dryRun: false, confirm: async () => false })),
    ).rejects.toMatchObject({ code: 'PUSH_ABORTED' });

    expect(outboundIds()).toEqual([OutboundId.GetScripts]);
    // 备份在确认门之前完成（流程第 9 步）：反悔也不丢现场
    expect(await listBackups(root)).toHaveLength(1);
    // baseline 未被改写（仍是夹具基线，lastPushAt 未盖）
    const baseline = await readBaseline(root);
    expect(baseline?.lastPushAt).toBeUndefined();
  });

  it('confirm 返回 true → 放行完成写回', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2' })]);
    await writeBaseline(root, initial);

    const result = await pushSaveAndPlay(
      pushOpts(root, { dryRun: false, confirm: async () => true }),
    );

    expect(result.pushed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 回读校验（PUSH_VERIFY_FAILED）
// ---------------------------------------------------------------------------

describe('pushSaveAndPlay · 回读校验（PUSH_VERIFY_FAILED）', () => {
  it('回读 script 与发送内容不一致 → 抛错，且 baseline 不更新', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    // 回读快照的 script 被"掉包"
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--被 TTS 改掉' })]);

    await expect(pushSaveAndPlay(pushOpts(root, { dryRun: false }))).rejects.toMatchObject({
      code: 'PUSH_VERIFY_FAILED',
    });
    // SaveAndPlay 确实发生了（失败发生在校验步）
    expect(outboundIds()).toEqual([OutboundId.GetScripts, OutboundId.SaveAndPlay, OutboundId.GetScripts]);
    expect(await readBaseline(root)).toBeNull();
  });

  it('回读 ui 与发送内容不一致 → 抛 PUSH_VERIFY_FAILED', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1', ui: '<G/>' })];
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2', ui: '<G 被改/>' })]);

    await expect(pushSaveAndPlay(pushOpts(root, { dryRun: false }))).rejects.toMatchObject({
      code: 'PUSH_VERIFY_FAILED',
    });
  });

  it('回读快照里整个 guid 消失 → 抛 PUSH_VERIFY_FAILED', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'aa11.棋子.lua', '--pawn v2');
    const initial = [state('aa11', '棋子', { script: '--pawn v1' })];
    queueFlow(stubServer, initial, []); // 回读为空：对象没了

    await expect(pushSaveAndPlay(pushOpts(root, { dryRun: false }))).rejects.toMatchObject({
      code: 'PUSH_VERIFY_FAILED',
    });
  });

  it('只校验发送过的对象：游戏里其他对象的内容不参与校验', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'aa11.棋子.lua', '--pawn v2');
    const initial = [state('aa11', '棋子', { script: '--pawn v1' })];
    // 回读里 aa11 一致；另一个没推送过的对象内容任意 → 不影响校验
    queueFlow(stubServer, initial, [
      state('aa11', '棋子', { script: '--pawn v2' }),
      state('zz99', '别人改的', { script: '--whatever' }),
    ]);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(result.pushed).toBe(1);
    expect(await readBaseline(root)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 备份行为
// ---------------------------------------------------------------------------

describe('pushSaveAndPlay · 备份行为', () => {
  it('skipBackup=true → 不建备份目录，结果无 backupDir', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2' })]);
    await writeBaseline(root, initial);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false, skipBackup: true }));

    expect(result.backupDir).toBeUndefined();
    expect(await listBackups(root)).toHaveLength(0);
    expect(existsSync(path.join(root, '.tts', 'backups'))).toBe(false);
  });

  it('backupRetention 透传：seed 3 份旧备份 + retention=2 → 写回后只保留最新 2 份', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2' })]);
    await writeBaseline(root, initial);
    await seedBackup(root, pastTimestamp(300));
    await seedBackup(root, pastTimestamp(200));
    const keptSeed = pastTimestamp(100); // 最新的 seed：应与本次 push 备份一同保留
    await seedBackup(root, keptSeed);

    await pushSaveAndPlay(pushOpts(root, { dryRun: false, backupRetention: 2 }));

    const backups = await listBackups(root);
    expect(backups).toHaveLength(2);
    // 本次 push 的新备份 + 最新的 seed；两份更旧的被清理
    expect(backups.map((m) => m.createdAt)).toContain(keptSeed);
    expect(backups.some((m) => m.createdAt === keptSeed && m.scriptsCount === 0)).toBe(true);
    expect(backups.every((m) => m.createdAt !== pastTimestamp(200) && m.createdAt !== pastTimestamp(300))).toBe(true);
  });

  it('基线存在时备份 manifest 记录 baselineHash 指纹', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2' })]);
    await writeBaseline(root, initial);

    await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    const manifest = (await listBackups(root))[0];
    expect(typeof manifest.baselineHash).toBe('string');
    expect(manifest.baselineHash).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// 空清单与入参校验
// ---------------------------------------------------------------------------

describe('pushSaveAndPlay · 空清单与入参校验', () => {
  it('空工作区（没有 scripts/ ui/）→ 直接返回 pushed=0 skipped=0，不连 TTS 不落盘', async () => {
    const root = await makePackRoot();

    const result = await pushSaveAndPlay(pushOpts(root));

    expect(result).toMatchObject({ dryRun: true, pushed: 0, skipped: 0 });
    expect(result.note).toBe(t('cli.pack.push.noteEmpty'));
    expect(wireLog.messages).toEqual([]); // 连 GetScripts 都不发
    expect(existsSync(path.join(root, '.tts'))).toBe(false);
  });

  it('空清单 + dryRun=false → 同样直接返回（无事可写，不备份不确认）', async () => {
    const root = await makePackRoot();

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(result).toMatchObject({ dryRun: false, pushed: 0, skipped: 0 });
    expect(wireLog.messages).toEqual([]);
    expect(await listBackups(root)).toHaveLength(0);
  });

  it('缺 pack.yaml → PackError code="PACK_NOT_FOUND"', async () => {
    const missing = path.join(tempRoot, 'not-a-pack');

    await expect(pushSaveAndPlay(pushOpts(missing))).rejects.toMatchObject({ code: 'PACK_NOT_FOUND' });
  });

  it('root 非法（空串）→ 编程错误（普通 Error，非 PackError）', async () => {
    await expect(pushSaveAndPlay(pushOpts(''))).rejects.toThrow(/root/);
  });

  it('timeoutMs 非法（0 / 负数 / NaN）→ 编程错误', async () => {
    const root = await makePackRoot();
    await expect(pushSaveAndPlay(pushOpts(root, { timeoutMs: 0 }))).rejects.toThrow(/timeoutMs/);
    await expect(pushSaveAndPlay(pushOpts(root, { timeoutMs: -1 }))).rejects.toThrow(/timeoutMs/);
    await expect(pushSaveAndPlay(pushOpts(root, { timeoutMs: Number.NaN }))).rejects.toThrow(/timeoutMs/);
  });
});

// ---------------------------------------------------------------------------
// 坑 17：server 注入 vs 独立模式
// ---------------------------------------------------------------------------

describe('pushSaveAndPlay · server 注入与独立模式（坑 17）', () => {
  it('独立模式（缺省 server）→ 走 withEditorServer 路径，完整流成功', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2' })]);
    await writeBaseline(root, initial);
    const { server: _ignored, ...withoutServer } = pushOpts(root, { dryRun: false });

    const result = await pushSaveAndPlay(withoutServer);

    expect(result.dryRun).toBe(false);
    expect(result.pushed).toBe(1);
    expect(outboundIds()).toEqual([OutboundId.GetScripts, OutboundId.SaveAndPlay, OutboundId.GetScripts]);
  });

  it('注入 server（hub 路径）→ 不经 withEditorServer 也能完整工作', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    const initial = [state('-1', 'Global', { script: '--global v1' })];
    queueFlow(stubServer, initial, [state('-1', 'Global', { script: '--global v2' })]);

    // 与独立模式共用同一套断言：注入路径是 hub 唯一入口，必须等价
    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(result.pushed).toBe(1);
    expect(result.backupDir).toBeDefined();
  });

  it('游戏侧空快照：本地对象全部按新对象推送，回读校验通过', async () => {
    const root = await makePackRoot();
    await writeScript(root, 'Global.lua', '--global v2');
    // 初始与 saveAndPlay 确认都是空快照（游戏里没有任何对象），回读快照含推送结果
    stubServer.enqueue([]);
    stubServer.enqueue([]);
    stubServer.enqueue([state('-1', 'Global', { script: '--global v2' })]);

    const result = await pushSaveAndPlay(pushOpts(root, { dryRun: false }));

    expect(result.pushed).toBe(1);
    expect(sentStates()).toEqual([{ name: 'Global', guid: '-1', script: '--global v2' }]);
    expect(await readBaseline(root)).not.toBeNull();
  });
});
