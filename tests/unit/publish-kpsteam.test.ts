// tests/unit/publish-kpsteam.test.ts
/**
 * src/publish/kpsteam.ts（窗口 G / 阶段 7，B2 产出）单元测试。
 *
 * 覆盖：
 * - probeKpsteam：非 win32 → NOT_WINDOWS；候选全缺 → NOT_FOUND；
 *   候选存在但 --version 非 0 / spawn error → VERSION_FAILED；
 *   --version 成功 → available + version；KPSTEAM_PATH 优先于默认安装位置；
 * - kpsteamUpload：argv 数组形态（--legacy 开关、appId 缺省 286160、itemId 数字
 *   转字符串、stdio 形态）；exit 0 → ok；exit 非 0 → ok=false + stderr；
 *   探测失败 → ok=false / exitCode=-1（不抛错）；spawn error 同样走返回值。
 *
 * 实现方式：vi.mock 替换 node:child_process.spawn 与 node:fs/promises.stat，
 * 不真实调用 kpsteam、不访问真实文件系统、不启动 Steam / TTS。
 */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Stats } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// vi.mock 必须在 import 之前
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn() };
});

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import { kpsteamUpload, probeKpsteam, TTS_APP_ID } from "../../src/publish/kpsteam.js";

// ---------------------------------------------------------------------------
// mock 工具
// ---------------------------------------------------------------------------

/** 默认安装位置（与 src/publish/kpsteam.ts 的探测顺序一致，用于断言） */
const PF_X86 = "C:\\Program Files (x86)\\kpsteam\\kpsteam.exe";

interface FakeStdin extends EventEmitter {
  write: Mock;
  end: Mock;
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  stdin: FakeStdin | null;
}

/**
 * 构造假 ChildProcess：spawn 返回后下一个 tick 触发
 * stdout/stderr data + close（或 error），行为对齐 Node 的真实事件序。
 */
function makeChild(
  opts: { code?: number | null; stdout?: string; stderr?: string; error?: Error } = {},
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as FakeStdin;
  stdin.write = vi.fn();
  stdin.end = vi.fn();
  child.stdin = stdin;
  queueMicrotask(() => {
    if (opts.error) {
      child.emit("error", opts.error);
      return;
    }
    if (opts.stdout) {
      child.stdout?.emit("data", Buffer.from(opts.stdout));
    }
    if (opts.stderr) {
      child.stderr?.emit("data", Buffer.from(opts.stderr));
    }
    child.emit("close", opts.code ?? 0);
  });
  return child;
}

/** mock spawn：所有用例都把 spawn 换成返回 FakeChild 的假实现 */
const spawnMock = spawn as unknown as Mock;
const statMock = stat as unknown as Mock;

function statAllExist(): void {
  statMock.mockResolvedValue({ isFile: () => true } as unknown as Stats);
}

function statNoneExist(): void {
  statMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
}

// ---------------------------------------------------------------------------
// platform / env 现场（探测是平台与环境敏感的，逐用例落定并恢复）
// ---------------------------------------------------------------------------

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

let savedKPSTEAM_PATH: string | undefined;
let savedPATH: string | undefined;

beforeEach(() => {
  savedKPSTEAM_PATH = process.env.KPSTEAM_PATH;
  savedPATH = process.env.PATH;
  delete process.env.KPSTEAM_PATH;
  process.env.PATH = ""; // PATH 扫描不产生候选，保证用例确定性
  spawnMock.mockReset();
  statMock.mockReset();
});

afterEach(() => {
  if (savedKPSTEAM_PATH === undefined) {
    delete process.env.KPSTEAM_PATH;
  } else {
    process.env.KPSTEAM_PATH = savedKPSTEAM_PATH;
  }
  if (savedPATH === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = savedPATH;
  }
  if (platformDescriptor) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

// ---------------------------------------------------------------------------
// probeKpsteam
// ---------------------------------------------------------------------------

describe("probeKpsteam", () => {
  it("非 win32 平台直接返回 NOT_WINDOWS，不 spawn 任何进程", async () => {
    setPlatform("linux");
    await expect(probeKpsteam()).resolves.toEqual({ available: false, reason: "NOT_WINDOWS" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("所有候选都不存在 → NOT_FOUND，且不 spawn", async () => {
    statNoneExist();
    await expect(probeKpsteam()).resolves.toEqual({ available: false, reason: "NOT_FOUND" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("候选存在但 --version 以非 0 退出 → VERSION_FAILED（附第一个候选路径）", async () => {
    statAllExist();
    spawnMock.mockImplementation(
      () => makeChild({ code: 1, stderr: "boom" }) as unknown as ChildProcess,
    );
    const probe = await probeKpsteam();
    expect(probe).toEqual({ available: false, exePath: PF_X86, reason: "VERSION_FAILED" });
    expect(spawnMock).toHaveBeenCalledWith(PF_X86, ["--version"], expect.anything());
  });

  it("候选存在但 spawn 本身报错（如权限）→ 同样按 VERSION_FAILED 处理", async () => {
    statAllExist();
    spawnMock.mockImplementation(
      () => makeChild({ error: new Error("EACCES") }) as unknown as ChildProcess,
    );
    const probe = await probeKpsteam();
    expect(probe.available).toBe(false);
    expect(probe.reason).toBe("VERSION_FAILED");
    expect(probe.exePath).toBe(PF_X86);
  });

  it("候选存在且 --version 成功 → available: true + version（取 stdout）", async () => {
    statAllExist();
    spawnMock.mockImplementation(
      () => makeChild({ code: 0, stdout: "kpsteam 1.2.3\n" }) as unknown as ChildProcess,
    );
    await expect(probeKpsteam()).resolves.toEqual({
      available: true,
      exePath: PF_X86,
      version: "kpsteam 1.2.3",
    });
  });

  it("KPSTEAM_PATH 优先于默认安装位置", async () => {
    process.env.KPSTEAM_PATH = "D:\\tools\\kp.exe";
    statAllExist();
    spawnMock.mockImplementation(
      () => makeChild({ code: 0, stdout: "v9" }) as unknown as ChildProcess,
    );
    const probe = await probeKpsteam();
    expect(probe.available).toBe(true);
    expect(probe.exePath).toBe("D:\\tools\\kp.exe");
    expect(spawnMock.mock.calls[0]?.[0]).toBe("D:\\tools\\kp.exe");
  });
});

// ---------------------------------------------------------------------------
// kpsteamUpload
// ---------------------------------------------------------------------------

describe("kpsteamUpload", () => {
  const bsonPath = "D:\\pack\\out.bson";
  const exePath = "C:\\kp\\kpsteam.exe";

  it("构造正确的参数数组：显式 appId + legacy=false 时省略 --legacy", async () => {
    spawnMock.mockImplementation(() => makeChild({ code: 0 }) as unknown as ChildProcess);
    const result = await kpsteamUpload({ itemId: "123", bsonPath, exePath, appId: 286160, legacy: false });
    expect(result.ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], { stdio: string[] }];
    expect(cmd).toBe(exePath);
    expect(args).toEqual(["upload", "--app", "286160", "--item", "123", "--path", bsonPath]);
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("缺省 appId=286160（TTS）、legacy=true、itemId 数字转字符串", async () => {
    spawnMock.mockImplementation(() => makeChild({ code: 0 }) as unknown as ChildProcess);
    await kpsteamUpload({ itemId: 2817359776, bsonPath, exePath });
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual([
      "upload",
      "--legacy",
      "--app",
      String(TTS_APP_ID),
      "--item",
      "2817359776",
      "--path",
      bsonPath,
    ]);
  });

  it("exit 0 → ok: true，stdout 全文带回", async () => {
    spawnMock.mockImplementation(
      () => makeChild({ code: 0, stdout: "uploaded\n" }) as unknown as ChildProcess,
    );
    await expect(kpsteamUpload({ itemId: "1", bsonPath, exePath })).resolves.toEqual({
      ok: true,
      exitCode: 0,
      stdout: "uploaded\n",
      stderr: "",
    });
  });

  it("exit 非 0 → ok: false + stderr 全文", async () => {
    spawnMock.mockImplementation(
      () => makeChild({ code: 3, stderr: "steam not running\n" }) as unknown as ChildProcess,
    );
    const result = await kpsteamUpload({ itemId: "1", bsonPath, exePath });
    expect(result).toEqual({
      ok: false,
      exitCode: 3,
      stdout: "",
      stderr: "steam not running\n",
    });
  });

  it("exePath 缺省且探测失败 → ok: false / exitCode -1（不抛错，stderr 说明原因）", async () => {
    statNoneExist();
    const result = await kpsteamUpload({ itemId: "1", bsonPath });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.stdout).toBe("");
    // 双态断言（Stage C 补齐 locales 后修正）：缺 error.publish.kpsteamNotAvailable 键时
    // t() 原样返回键名，补齐后是插值文案（中文 / 英文都含 reason 的取值 NOT_FOUND）。
    expect(
      result.stderr.includes("kpsteamNotAvailable") || result.stderr.includes("NOT_FOUND"),
    ).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled(); // 绝不盲目起进程
  });

  it("spawn 本身报错 → ok: false / exitCode -1 / stderr 带错误信息", async () => {
    spawnMock.mockImplementation(
      () => makeChild({ error: new Error("ENOENT") }) as unknown as ChildProcess,
    );
    const result = await kpsteamUpload({ itemId: "1", bsonPath, exePath });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toBe("ENOENT");
  });
});
