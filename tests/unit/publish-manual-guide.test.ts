// tests/unit/publish-manual-guide.test.ts
/**
 * src/publish/manual-guide.ts（窗口 G / 阶段 7，B2 产出）单元测试。
 *
 * 覆盖：
 * - generateManualGuide：手册文本包含 BSON 绝对路径；包含恰好 7 个步骤
 *   （行首 "N)" 计数）；给定 itemId 时文本包含该 ID；bsonPath 不存在 →
 *   PackError "PUBLISH_BSON_NOT_FOUND"；文本含"绝不自动打开游戏或 Steam"
 *   红线声明；剪贴板失败经 clipboardError 上报、不阻断手册生成；
 * - copyToClipboard：非 win32 → ok:false（不 spawn）；成功 → ok:true 且
 *   以 UTF-16LE 写入 clip.exe stdin；clip.exe 非 0 退出 → ok:false + error。
 *
 * 实现方式：vi.mock 替换 node:child_process.spawn（不真实调 clip.exe）；
 * BSON 存在性检查用真实文件系统（os.tmpdir 下的临时目录，afterEach 清理）。
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// vi.mock 必须在 import 之前
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "node:child_process";

import { PackError } from "../../src/pack/packyaml.js";
import { copyToClipboard, generateManualGuide } from "../../src/publish/manual-guide.js";

// ---------------------------------------------------------------------------
// mock 工具
// ---------------------------------------------------------------------------

interface FakeStdin extends EventEmitter {
  write: Mock;
  end: Mock;
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  stdin: FakeStdin | null;
}

/** 构造假 ChildProcess：下一个 tick 触发 close（或 error） */
function makeChild(
  opts: { code?: number | null; error?: Error } = {},
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = null; // clip.exe 的 stdout / stderr 都是 ignore
  child.stderr = null;
  const stdin = new EventEmitter() as FakeStdin;
  stdin.write = vi.fn();
  stdin.end = vi.fn();
  child.stdin = stdin;
  queueMicrotask(() => {
    if (opts.error) {
      child.emit("error", opts.error);
      return;
    }
    child.emit("close", opts.code ?? 0);
  });
  return child;
}

const spawnMock = spawn as unknown as Mock;

// ---------------------------------------------------------------------------
// platform 现场与临时目录
// ---------------------------------------------------------------------------

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

let tempDir: string | undefined;

async function makeTempBson(name = "pack.bson"): Promise<string> {
  tempDir = await mkdtemp(path.join(tmpdir(), "tts-manual-guide-"));
  const bsonPath = path.join(tempDir, name);
  await writeFile(bsonPath, "not-a-real-bson");
  return bsonPath;
}

beforeEach(() => {
  // 缺省：clip.exe 成功退出（generateManualGuide 内部会复制剪贴板）
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeChild({ code: 0 }) as unknown as ChildProcess);
});

afterEach(async () => {
  if (platformDescriptor) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

// ---------------------------------------------------------------------------
// generateManualGuide
// ---------------------------------------------------------------------------

describe("generateManualGuide", () => {
  it("返回的 text 包含 BSON 绝对路径，且剪贴板复制成功", async () => {
    const bsonPath = await makeTempBson();
    const result = await generateManualGuide({ bsonPath });
    expect(result.text).toContain(bsonPath);
    expect(result.clipboardCopied).toBe(true);
    expect(result.clipboardError).toBeUndefined();
  });

  it("手册包含恰好 7 个步骤（行首 1) 到 7)）", async () => {
    const bsonPath = await makeTempBson();
    const result = await generateManualGuide({ bsonPath });
    const steps = result.text.match(/^\d\)/gm) ?? [];
    expect(steps).toHaveLength(7);
  });

  it("给定 itemId 时手册中包含该 ID", async () => {
    const bsonPath = await makeTempBson();
    const result = await generateManualGuide({ bsonPath, itemId: 2817359776 });
    expect(result.text).toContain("2817359776");
  });

  it("bsonPath 不存在 → PackError PUBLISH_BSON_NOT_FOUND", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "tts-manual-guide-"));
    const missing = path.join(tempDir, "missing.bson");
    await expect(generateManualGuide({ bsonPath: missing })).rejects.toThrow(PackError);
    try {
      await generateManualGuide({ bsonPath: missing });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PackError);
      expect((err as PackError).code).toBe("PUBLISH_BSON_NOT_FOUND");
    }
  });

  it("手册包含『绝不自动打开游戏或 Steam』红线声明", async () => {
    const bsonPath = await makeTempBson();
    const result = await generateManualGuide({ bsonPath });
    expect(result.text).toContain("绝不自动打开游戏或 Steam");
  });

  it("剪贴板复制失败不阻断手册生成：clipboardCopied=false + clipboardError", async () => {
    const bsonPath = await makeTempBson();
    spawnMock.mockImplementation(() => makeChild({ code: 1 }) as unknown as ChildProcess);
    const result = await generateManualGuide({ bsonPath });
    expect(result.clipboardCopied).toBe(false);
    expect(result.clipboardError).toContain("clip.exe");
    expect(result.text).toContain(bsonPath); // 手册照常生成
  });
});

// ---------------------------------------------------------------------------
// copyToClipboard
// ---------------------------------------------------------------------------

describe("copyToClipboard", () => {
  it("非 win32 平台返回 ok: false（不 spawn 任何进程）", async () => {
    setPlatform("linux");
    await expect(copyToClipboard("whatever")).resolves.toEqual({
      ok: false,
      error: "仅支持 Windows",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("成功时 ok: true：spawn clip.exe，文本以 UTF-16LE 写入 stdin", async () => {
    const child = makeChild({ code: 0 });
    spawnMock.mockImplementation(() => child as unknown as ChildProcess);
    const text = "D:\\pack\\out.bson";
    await expect(copyToClipboard(text)).resolves.toEqual({ ok: true });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], { stdio: string[] }];
    expect(cmd).toBe("clip.exe");
    expect(args).toEqual([]);
    expect(opts.stdio).toEqual(["pipe", "ignore", "ignore"]);
    expect(child.stdin?.write).toHaveBeenCalledWith(Buffer.from(text, "utf16le"));
    expect(child.stdin?.end).toHaveBeenCalledTimes(1);
  });

  it("clip.exe 非 0 退出 → ok: false + error 说明退出码", async () => {
    spawnMock.mockImplementation(() => makeChild({ code: 1 }) as unknown as ChildProcess);
    const result = await copyToClipboard("abc");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("clip.exe");
  });
});
