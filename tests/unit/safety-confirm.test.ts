// tests/unit/safety-confirm.test.ts
/**
 * src/safety/confirm.ts 单元测试：写回 TTS 前的 CLI 交互式确认门。
 *
 * 纯内存测试（无文件系统、无网络、不连 TTS）：confirmPush 只打印 + 读一行，
 * 唯一的外部依赖是 process.stdin / process.stdout / readline。
 *
 * 技术要点（踩过的坑）：process.stdin / process.stdout 在 Node 里是 **getter-only
 * 的 configurable 访问器**——直接赋值静默无效（严格模式会抛 TypeError），必须用
 * Object.defineProperty 换成值属性；restore 时把原属性描述符原样装回去。
 * 用 Readable / Writable mock 代替真实流（比 vi.stubGlobal('process') 稳，
 * 不会影响 i18n 等对 process 的其他读取）。
 *
 * i18n 断言约定：期望文案一律通过 t() 现算（如 t('cli.safety.confirm.aborted')），
 * 不写死字符串——locales 目前缺这些键时 t() 回退输出键名，本地化步骤（Run 2）
 * 补齐后测试依然成立，不需要跟着改。
 *
 * 覆盖（按 src/safety/confirm.ts 模块头注释的决策树顺序锁定）：
 * - assumeYes：打印摘要 + 全部 details 后直接 true（不询问、不出提示语）；
 *   details>10 仍走截断；与 nonInteractive 同时给出时 assumeYes 优先（树序）；
 * - 非交互：显式 nonInteractive / stdout 非 TTY → false + 非交互提示；
 *   摘要与 details 截断照常打印；
 * - TTY 交互（mock stdin 逐个喂答案）：y / Y / yes / Yes / YES / 带空白 yes → true
 *   并打印确认文案；空 / n / no / 任意文本 / EOF → false 并打印取消文案；
 * - 提示语：默认用 cli.safety.confirm.prompt 译文；promptText 覆盖后不再出现默认键；
 * - details 渲染：0 / 5 / 15 条 → 无明细 / 全部 "  - " 前缀 / 前 10 条 + 折叠行
 *   （第 11 条绝不出现在输出里）。
 */
import { Readable, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { confirmPush } from '../../src/safety/confirm.js';
import { t } from '../../src/i18n/index.js';

// ---------------------------------------------------------------------------
// process 流替换（getter-only 访问器，必须 defineProperty）
// ---------------------------------------------------------------------------

/** installIO 装上的活动替身（afterEach 统一恢复） */
let activeIO: IORig | undefined;

/** 一次流替换的句柄 */
interface IORig {
  /** 已捕获的 stdout 输出（按写入顺序拼接） */
  output(): string;
  /** 把 process.stdin / process.stdout 的原属性描述符装回去 */
  restore(): void;
}

/**
 * 用 mock 流替换 process.stdin / process.stdout。
 *
 * @param options - isTTY: stdout 是否伪装成终端（默认 false）；
 *   input: 预先灌入 stdin 的内容（含换行），null 表示立即 EOF，undefined 表示保持打开
 * @returns 句柄（output / restore）
 */
function installIO(options: { isTTY?: boolean; input?: string | null }): IORig {
  const chunks: string[] = [];
  const stdoutMock: Writable & { isTTY?: boolean } = new Writable({
    write(chunk: unknown, _encoding: BufferEncoding, cb: (err?: Error | null) => void) {
      chunks.push(String(chunk));
      cb();
    },
  });
  if (options.isTTY === true) {
    stdoutMock.isTTY = true;
  }
  const stdinMock = new Readable({ read() {} });
  if (options.input !== undefined) {
    if (options.input !== null) {
      stdinMock.push(options.input);
    }
    stdinMock.push(null);
  }

  const origStdout = Object.getOwnPropertyDescriptor(process, 'stdout');
  const origStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  if (origStdout === undefined || origStdin === undefined) {
    throw new Error('process.stdin / process.stdout 的属性描述符不可用');
  }
  Object.defineProperty(process, 'stdout', { value: stdoutMock, configurable: true, writable: true, enumerable: true });
  Object.defineProperty(process, 'stdin', { value: stdinMock, configurable: true, writable: true, enumerable: true });

  return {
    output: () => chunks.join(''),
    restore(): void {
      Object.defineProperty(process, 'stdout', origStdout);
      Object.defineProperty(process, 'stdin', origStdin);
    },
  };
}

beforeEach(() => {
  activeIO = undefined;
});

afterEach(() => {
  activeIO?.restore();
  activeIO = undefined;
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 通用摘要行（调用方传入，测试原样断言，不受 i18n 影响） */
const SUMMARY = '将写回 2 个对象、3 个脚本、2 个 UI 到 TTS。';

/** 通用差异明细（5 条） */
const DETAILS_5 = ['diff-a', 'diff-b', 'diff-c', 'diff-d', 'diff-e'];

/** 15 条差异明细（截断用） */
const DETAILS_15 = Array.from({ length: 15 }, (_, i) => `diff-${String(i + 1).padStart(2, '0')}`);

/**
 * 在 TTY 环境（stdout.isTTY=true）下执行 confirmPush 并捕获输出。
 * @param input - 预先灌入 stdin 的答案（含换行）；null 表示立即 EOF
 * @param opts - confirmPush 其余选项（缺省只带 message）
 */
async function confirmWithTTY(
  input: string | null,
  opts: { details?: string[]; promptText?: string } = {},
): Promise<{ result: boolean; out: string }> {
  activeIO = installIO({ isTTY: true, input });
  try {
    const result = await confirmPush({ message: SUMMARY, ...opts });
    return { result, out: activeIO.output() };
  } finally {
    activeIO.restore();
  }
}

// ---------------------------------------------------------------------------
// assumeYes 分支
// ---------------------------------------------------------------------------

describe('confirmPush: assumeYes', () => {
  it('assumeYes=true：打印 message 与全部 details 后直接返回 true，不询问', async () => {
    activeIO = installIO({ isTTY: false });
    try {
      const result = await confirmPush({ message: SUMMARY, details: DETAILS_5, assumeYes: true });
      expect(result).toBe(true);
      const out = activeIO.output();
      expect(out).toContain(SUMMARY);
      for (const line of DETAILS_5) {
        expect(out).toContain(`  - ${line}`);
      }
      // 不询问：不出提示语、不出非交互提示、不出确认 / 取消文案
      expect(out).not.toContain(t('cli.safety.confirm.prompt'));
      expect(out).not.toContain(t('cli.safety.confirm.nonInteractive'));
      expect(out).not.toContain(t('cli.safety.confirm.proceed'));
      expect(out).not.toContain(t('cli.safety.confirm.aborted'));
    } finally {
      activeIO.restore();
    }
  });

  it('assumeYes=true：details 超过 10 条仍按截断渲染（前 10 条 + 折叠行）', async () => {
    activeIO = installIO({ isTTY: false });
    try {
      const result = await confirmPush({ message: SUMMARY, details: DETAILS_15, assumeYes: true });
      expect(result).toBe(true);
      const out = activeIO.output();
      expect(out).toContain('  - diff-10');
      expect(out).toContain(`  ${t('cli.safety.confirm.more', { count: 5 })}`);
      expect(out).not.toContain('- diff-11');
    } finally {
      activeIO.restore();
    }
  });

  it('assumeYes 与 nonInteractive 同时给出：按决策树顺序 assumeYes 优先返回 true', async () => {
    activeIO = installIO({ isTTY: false });
    try {
      const result = await confirmPush({ message: SUMMARY, assumeYes: true, nonInteractive: true });
      expect(result).toBe(true);
      expect(activeIO.output()).not.toContain(t('cli.safety.confirm.nonInteractive'));
    } finally {
      activeIO.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 非交互分支
// ---------------------------------------------------------------------------

describe('confirmPush: nonInteractive', () => {
  it('nonInteractive=true：打印摘要与非交互提示后返回 false，不询问', async () => {
    activeIO = installIO({ isTTY: true, input: 'y\n' }); // 即便 stdin 有 y 也不生效
    try {
      const result = await confirmPush({ message: SUMMARY, details: DETAILS_5, nonInteractive: true });
      expect(result).toBe(false);
      const out = activeIO.output();
      expect(out).toContain(SUMMARY);
      expect(out).toContain(`  - diff-a`);
      expect(out).toContain(t('cli.safety.confirm.nonInteractive'));
      expect(out).not.toContain(t('cli.safety.confirm.prompt'));
    } finally {
      activeIO.restore();
    }
  });

  it('stdout 不是 TTY（未显式传 nonInteractive）：同样返回 false 并输出非交互提示', async () => {
    activeIO = installIO({ isTTY: false, input: 'y\n' });
    try {
      const result = await confirmPush({ message: SUMMARY });
      expect(result).toBe(false);
      expect(activeIO.output()).toContain(t('cli.safety.confirm.nonInteractive'));
    } finally {
      activeIO.restore();
    }
  });

  it('非交互分支：details 超过 10 条照常截断打印', async () => {
    activeIO = installIO({ isTTY: false });
    try {
      const result = await confirmPush({ message: SUMMARY, details: DETAILS_15, nonInteractive: true });
      expect(result).toBe(false);
      const out = activeIO.output();
      expect(out).toContain('  - diff-10');
      expect(out).toContain(`  ${t('cli.safety.confirm.more', { count: 5 })}`);
      expect(out).not.toContain('- diff-11');
    } finally {
      activeIO.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// TTY 交互：接受的答案
// ---------------------------------------------------------------------------

describe('confirmPush: TTY 接受', () => {
  const accepted: Array<[string, string]> = [
    ['y', '小写 y'],
    ['Y', '大写 Y'],
    ['yes', '小写 yes'],
    ['Yes', '首字母大写 Yes'],
    ['YES', '全大写 YES'],
    ['  yes  ', '带首尾空白的 yes'],
  ];
  for (const [input, label] of accepted) {
    it(`输入 ${label}（${JSON.stringify(input)}）→ true 并打印确认文案`, async () => {
      const { result, out } = await confirmWithTTY(`${input}\n`);
      expect(result).toBe(true);
      expect(out).toContain(SUMMARY);
      expect(out).toContain(t('cli.safety.confirm.proceed'));
      expect(out).not.toContain(t('cli.safety.confirm.aborted'));
    });
  }
});

// ---------------------------------------------------------------------------
// TTY 交互：拒绝的答案
// ---------------------------------------------------------------------------

describe('confirmPush: TTY 拒绝', () => {
  const rejected: Array<[string, string]> = [
    ['\n', '直接回车（空）'],
    ['n\n', '小写 n'],
    ['no\n', '小写 no'],
    ['废话 input\n', '任意文本'],
    ['yy\n', '近似但不是 yes 的输入'],
  ];
  for (const [input, label] of rejected) {
    it(`输入 ${label} → false 并打印取消文案`, async () => {
      const { result, out } = await confirmWithTTY(input);
      expect(result).toBe(false);
      expect(out).toContain(t('cli.safety.confirm.aborted'));
      expect(out).not.toContain(t('cli.safety.confirm.proceed'));
    });
  }

  it('stdin 直接 EOF（无任何输入）→ false 并按取消结算', async () => {
    const { result, out } = await confirmWithTTY(null);
    expect(result).toBe(false);
    expect(out).toContain(t('cli.safety.confirm.aborted'));
  });
});

// ---------------------------------------------------------------------------
// 提示语
// ---------------------------------------------------------------------------

describe('confirmPush: 提示语', () => {
  it('默认提示语：输出含 cli.safety.confirm.prompt 译文，且摘要先于提示出现', async () => {
    const { out } = await confirmWithTTY('y\n');
    expect(out).toContain(t('cli.safety.confirm.prompt'));
    expect(out.indexOf(SUMMARY)).toBeLessThan(out.indexOf(t('cli.safety.confirm.prompt')));
  });

  it('自定义 promptText：输出含自定义文本，且不再出现默认提示语', async () => {
    const { result, out } = await confirmWithTTY('y\n', { promptText: '真的要写回吗？(yes/no) ' });
    expect(result).toBe(true);
    expect(out).toContain('真的要写回吗？(yes/no) ');
    expect(out).not.toContain(t('cli.safety.confirm.prompt'));
  });
});

// ---------------------------------------------------------------------------
// details 渲染
// ---------------------------------------------------------------------------

describe('confirmPush: details 渲染', () => {
  it('details 为空（缺省）：不输出任何明细行，也不输出折叠行', async () => {
    const { result, out } = await confirmWithTTY('y\n');
    expect(result).toBe(true);
    expect(out).toContain(SUMMARY);
    expect(out).not.toContain('  - ');
    expect(out).not.toContain(t('cli.safety.confirm.more', { count: 0 }));
  });

  it('details=5 条：每条以 "  - " 前缀逐行打印，无折叠行', async () => {
    const { out } = await confirmWithTTY('y\n', { details: DETAILS_5 });
    for (const line of DETAILS_5) {
      expect(out).toContain(`  - ${line}`);
    }
    expect(out).not.toContain(t('cli.safety.confirm.more', { count: 0 }));
  });

  it('details=15 条：只打印前 10 条，末尾追加折叠行（计数 5），第 11 条不出现', async () => {
    const { out } = await confirmWithTTY('y\n', { details: DETAILS_15 });
    expect(out).toContain('  - diff-01');
    expect(out).toContain('  - diff-10');
    expect(out).toContain(`  ${t('cli.safety.confirm.more', { count: 5 })}`);
    expect(out).not.toContain('- diff-11');
  });
});
