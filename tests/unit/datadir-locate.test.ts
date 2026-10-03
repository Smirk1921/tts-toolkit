// tests/unit/datadir-locate.test.ts
/**
 * src/datadir/locate.ts 的单元测试。
 *
 * 两种手法并用：
 * 1. `vi.mock('node:fs')` —— 精确控制 existsSync / statSync / readFileSync，
 *    用于探测优先级、去重、有效计数与入参/配置校验的错误路径；
 * 2. 临时目录真实 fs（mkdtemp）—— 用于 readConfig / writeConfig 的 yaml 读写
 *    与 locateDatadir 的集成探测（通过 TTS_INSTALL_DIR / USERPROFILE 环境变量
 *    把安装目录与 Documents 基准指进临时目录，隔离本机真实数据目录）。
 *
 * 注意：不依赖运行中的 TTS；所有路径均指向临时目录或 mock。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Stats } from "node:fs";

// 仅 mock 'node:fs'（locate.ts 的依赖）；'node:fs/promises' 是独立模块，保持真实，
// 供本测试文件在临时目录里造真实目录结构。
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { locateDatadir, readConfig, writeConfig } from "../../src/datadir/locate.js";

const existsSyncMock = vi.mocked(existsSync);
const statSyncMock = vi.mocked(statSync);
const readFileSyncMock = vi.mocked(readFileSync);
const writeFileSyncMock = vi.mocked(writeFileSync);
const mkdirSyncMock = vi.mocked(mkdirSync);

// node:fs 的真实实现（vi.importActual 不受 mock 影响）：
// 真实 fs 用例在 beforeEach 中把五个 mock 委托回真实实现
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");

/** 构造满足 statSync 返回类型的最小假 Stats（isDirectory 可控） */
function makeFakeStat(isDirectory: boolean): Stats {
  return { isDirectory: () => isDirectory } as unknown as Stats;
}

// ---------------------------------------------------------------------------
// 公共环境管理：环境变量快照 + 每个用例一个临时目录
// ---------------------------------------------------------------------------

let savedEnv: Array<[string, string | undefined]> = [];
let tmp = "";

/** 记录当前值并设置环境变量（afterEach 统一还原） */
function setEnv(name: string, value: string): void {
  if (!savedEnv.some(([k]) => k === name)) {
    savedEnv.push([name, process.env[name]]);
  }
  process.env[name] = value;
}

beforeEach(() => {
  savedEnv = [];
});

afterEach(async () => {
  // 还原环境变量，避免污染同进程内的其他用例
  for (const [name, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  savedEnv = [];
  if (tmp !== "") {
    await rm(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "tts-datadir-test-"));
});

/** 把 yaml 值序列化为双引号风格（自动转义反斜杠），用于伪造配置文件内容 */
function yamlQuoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\")}"`;
}

// ---------------------------------------------------------------------------
// 第一部分：探测逻辑（mock node:fs，路径不落盘，完全由 allowlist 控制）
// ---------------------------------------------------------------------------

describe("locateDatadir 探测逻辑（mock node:fs）", () => {
  /** mock 模式下的固定探测基准（不与真实文件系统交互） */
  const INSTALL_ROOT = path.win32.join("E:", "tts-test", "install-root");
  const FAKE_HOME = path.win32.join("E:", "tts-test", "fake-home");
  const CONFIG_YAML = path.win32.join("E:", "tts-test", "config.yaml");
  const INSTALL_MODS = path.join(INSTALL_ROOT, "Tabletop Simulator_Data", "Mods");
  const DOCS_MODS = path.win32.join(FAKE_HOME, "Documents", "My Games", "Tabletop Simulator", "Mods");

  /** existsSync 命中表；statSync 结果表（true=目录 / false=文件）；配置文件内容表 */
  const existsSet = new Set<string>();
  const statTable = new Map<string, boolean>();
  const contentMap = new Map<string, string>();

  /**
   * 注册一个 mock 探测结果。
   * @param dir - Mods 目录路径
   * @param opts.exists - 目录是否存在（默认 true）
   * @param opts.subdirs - 存在且为目录的关键子目录名（默认仅 Workshop）
   * @param opts.fileSubdirs - 存在但是文件的关键子目录名（isDirectory 为 false）
   * @returns 注册的目录路径
   */
  function registerMods(
    dir: string,
    opts: { exists?: boolean; subdirs?: string[]; fileSubdirs?: string[] } = {},
  ): string {
    const { exists = true, subdirs = ["Workshop"], fileSubdirs = [] } = opts;
    if (exists) {
      existsSet.add(dir);
    }
    for (const name of subdirs) {
      statTable.set(path.join(dir, name), true);
    }
    for (const name of fileSubdirs) {
      statTable.set(path.join(dir, name), false);
    }
    return dir;
  }

  beforeEach(() => {
    existsSyncMock.mockReset();
    statSyncMock.mockReset();
    readFileSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    existsSet.clear();
    statTable.clear();
    contentMap.clear();

    existsSyncMock.mockImplementation((p) => existsSet.has(String(p)));
    statSyncMock.mockImplementation((p) => {
      const isDirectory = statTable.get(String(p));
      if (isDirectory === undefined) {
        throw new Error("ENOENT（测试模拟：该子目录不存在）");
      }
      return makeFakeStat(isDirectory);
    });
    readFileSyncMock.mockImplementation((p) => {
      const content = contentMap.get(String(p));
      if (content === undefined) {
        throw new Error("ENOENT（测试模拟：该文件未配置内容）");
      }
      return content;
    });

    // 环境变量指向 mock 路径；模块在调用时读取，故每个用例内即时生效
    setEnv("TTS_INSTALL_DIR", INSTALL_ROOT);
    setEnv("USERPROFILE", FAKE_HOME);
  });

  describe("探测优先级", () => {
    it("四个来源全部有效时按 显式 > 配置 > 安装目录 > Documents 排序", async () => {
      const explicitMods = registerMods(path.win32.join("E:", "tts-test", "explicit", "Mods"), {
        subdirs: ["Workshop", "Images"],
      });
      const configMods = registerMods(path.win32.join("E:", "tts-test", "from-config", "Mods"));
      existsSet.add(CONFIG_YAML);
      contentMap.set(CONFIG_YAML, `datadir: ${yamlQuoted(configMods)}\n`);
      registerMods(INSTALL_MODS, { subdirs: ["Workshop", "Images", "Saves"] });
      registerMods(DOCS_MODS);

      const result = await locateDatadir({ explicitPath: explicitMods, configPath: CONFIG_YAML });

      expect(result.candidates.map((c) => c.source)).toEqual([
        "explicit",
        "config",
        "install-dir",
        "documents",
      ]);
      expect(result.candidates.map((c) => c.path)).toEqual([explicitMods, configMods, INSTALL_MODS, DOCS_MODS]);
      expect(result.candidates.map((c) => c.validSubdirs)).toEqual([2, 1, 3, 1]);
    });

    it("无显式路径时配置源位于安装目录与 Documents 之前", async () => {
      const configMods = registerMods(path.win32.join("E:", "tts-test", "from-config", "Mods"));
      existsSet.add(CONFIG_YAML);
      contentMap.set(CONFIG_YAML, `datadir: ${yamlQuoted(configMods)}\n`);
      registerMods(INSTALL_MODS);
      registerMods(DOCS_MODS);

      const result = await locateDatadir({ configPath: CONFIG_YAML });

      expect(result.candidates.map((c) => c.source)).toEqual(["config", "install-dir", "documents"]);
    });

    it("配置文件不存在时跳过配置源，安装目录位于 Documents 之前", async () => {
      registerMods(INSTALL_MODS);
      registerMods(DOCS_MODS);

      const result = await locateDatadir({ configPath: CONFIG_YAML });

      expect(result.candidates.map((c) => c.source)).toEqual(["install-dir", "documents"]);
      expect(result.candidates).toHaveLength(2);
    });

    it("设置 TTS_INSTALL_DIR 时只探测该安装目录，不再探测默认 Steam 库位置", async () => {
      registerMods(DOCS_MODS);

      const result = await locateDatadir({ configPath: CONFIG_YAML });

      const installCandidates = result.candidates.filter((c) => c.source === "install-dir");
      expect(installCandidates).toHaveLength(1);
      expect(installCandidates[0]?.path).toBe(INSTALL_MODS);
    });
  });

  describe("有效位置计数与选择建议", () => {
    it("找到多个有效位置时 requiresChoice 为 true 且不填 recommended", async () => {
      registerMods(INSTALL_MODS, { subdirs: ["Workshop", "Images"] });
      registerMods(DOCS_MODS);

      const result = await locateDatadir({ configPath: CONFIG_YAML });

      expect(result.requiresChoice).toBe(true);
      expect(result.recommended).toBeUndefined();
    });

    it("恰好一个有效时 recommended 指向该位置", async () => {
      registerMods(DOCS_MODS);

      const result = await locateDatadir({ configPath: CONFIG_YAML });

      expect(result.requiresChoice).toBe(false);
      expect(result.recommended).toBe(DOCS_MODS);
    });

    it("零个有效时 requiresChoice 为 false 且 recommended 省略", async () => {
      const result = await locateDatadir({ configPath: CONFIG_YAML });

      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.every((c) => !c.exists && c.validSubdirs === 0)).toBe(true);
      expect(result.requiresChoice).toBe(false);
      expect(result.recommended).toBeUndefined();
    });

    it("目录存在但缺少 Workshop/Images/Saves 时不计为有效", async () => {
      // 显式目录存在但为空壳；Documents 有效 → 唯一有效是 Documents
      const emptyMods = registerMods(path.win32.join("E:", "tts-test", "explicit", "Mods"), {
        subdirs: [],
      });
      registerMods(DOCS_MODS);

      const result = await locateDatadir({ explicitPath: emptyMods, configPath: CONFIG_YAML });

      expect(result.candidates[0]).toMatchObject({ source: "explicit", exists: true, validSubdirs: 0 });
      expect(result.requiresChoice).toBe(false);
      expect(result.recommended).toBe(DOCS_MODS);
    });

    it("仅凭 Saves 一个关键子目录也达到有效阈值", async () => {
      registerMods(DOCS_MODS, { subdirs: ["Saves"] });

      const result = await locateDatadir({ configPath: CONFIG_YAML });

      const docs = result.candidates.find((c) => c.source === "documents");
      expect(docs?.validSubdirs).toBe(1);
      expect(result.recommended).toBe(DOCS_MODS);
    });

    it("关键子目录是文件而非目录时不计数（isDirectory 为 false）", async () => {
      const fileLikeMods = registerMods(path.win32.join("E:", "tts-test", "file-like", "Mods"), {
        fileSubdirs: ["Workshop"],
      });
      registerMods(DOCS_MODS);

      const result = await locateDatadir({ explicitPath: fileLikeMods, configPath: CONFIG_YAML });

      expect(result.candidates[0]).toMatchObject({ source: "explicit", exists: true, validSubdirs: 0 });
      expect(result.recommended).toBe(DOCS_MODS);
    });

    it("显式路径与安装目录路径相同时去重，保留优先级更高的显式来源", async () => {
      registerMods(INSTALL_MODS, { subdirs: ["Workshop", "Images"] });
      registerMods(DOCS_MODS);

      const result = await locateDatadir({ explicitPath: INSTALL_MODS, configPath: CONFIG_YAML });

      expect(result.candidates.map((c) => c.source)).toEqual(["explicit", "documents"]);
      expect(result.requiresChoice).toBe(true);
    });

    it("显式路径不存在时仍列为首个候选且 exists 为 false", async () => {
      registerMods(DOCS_MODS);
      const missing = path.win32.join("E:", "tts-test", "missing", "Mods");

      const result = await locateDatadir({ explicitPath: missing, configPath: CONFIG_YAML });

      expect(result.candidates[0]).toMatchObject({ source: "explicit", path: missing, exists: false, validSubdirs: 0 });
      // 唯一有效是 Documents → 给出推荐
      expect(result.recommended).toBe(DOCS_MODS);
    });
  });

  describe("入参与配置校验的错误处理", () => {
    it("explicitPath 为空白字符串时抛出中文错误", async () => {
      await expect(locateDatadir({ explicitPath: "   " })).rejects.toThrow(
        /locateDatadir 入参无效（explicitPath：不能为空字符串）/,
      );
    });

    it("explicitPath 类型非法时抛出中文错误", async () => {
      await expect(locateDatadir({ explicitPath: 123 as unknown as string })).rejects.toThrow(
        /explicitPath：必须是字符串/,
      );
    });

    it("configPath 类型非法时抛出中文错误", async () => {
      await expect(locateDatadir({ configPath: 123 as unknown as string })).rejects.toThrow(
        /configPath：必须是字符串/,
      );
    });

    it("配置文件不是合法 YAML 时抛出中文错误", async () => {
      existsSet.add(CONFIG_YAML);
      contentMap.set(CONFIG_YAML, "datadir: [unclosed");

      await expect(locateDatadir({ configPath: CONFIG_YAML })).rejects.toThrow(/配置文件不是合法 YAML/);
    });

    it("配置 datadir 类型非法时抛出中文错误", async () => {
      existsSet.add(CONFIG_YAML);
      contentMap.set(CONFIG_YAML, "datadir: 123\n");

      await expect(locateDatadir({ configPath: CONFIG_YAML })).rejects.toThrow(
        /配置文件格式无效：.*（datadir：必须是字符串）/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 第二部分：集成探测（临时目录真实 fs，用环境变量隔离本机真实数据目录）
// ---------------------------------------------------------------------------

describe("locateDatadir 集成（临时目录真实 fs）", () => {
  let installRoot = "";
  let fakeHome = "";
  let installMods = "";
  let docsMods = "";
  let missingConfig = "";

  /** 在 base 下创建 Mods 目录及指定关键子目录，返回 Mods 路径 */
  async function makeModsDir(base: string, subdirs: string[]): Promise<string> {
    const mods = path.join(base, "Tabletop Simulator_Data", "Mods");
    for (const name of subdirs) {
      await mkdir(path.join(mods, name), { recursive: true });
    }
    return mods;
  }

  beforeEach(async () => {
    // 委托到 node:fs 真实实现（本文件顶层 mock 了 node:fs，真实 fs 用例需切回真实实现）
    existsSyncMock.mockImplementation(realFs.existsSync);
    statSyncMock.mockImplementation(realFs.statSync);
    readFileSyncMock.mockImplementation(realFs.readFileSync);
    writeFileSyncMock.mockImplementation(realFs.writeFileSync);
    mkdirSyncMock.mockImplementation(realFs.mkdirSync);
    installRoot = path.join(tmp, "install");
    fakeHome = path.join(tmp, "home");
    installMods = path.join(installRoot, "Tabletop Simulator_Data", "Mods");
    docsMods = path.join(fakeHome, "Documents", "My Games", "Tabletop Simulator", "Mods");
    missingConfig = path.join(tmp, "config-不存在.yaml");
    // 关键隔离手段：安装目录与 Documents 基准都指向临时目录，
    // 使本机真实存在的 D:\SteamLibrary 与 %USERPROFILE%\Documents 不参与探测
    setEnv("TTS_INSTALL_DIR", installRoot);
    setEnv("USERPROFILE", fakeHome);
  });

  it("四个来源均有效时按优先级排序并正确统计各目录的 validSubdirs", async () => {
    const explicitMods = await makeModsDir(path.join(tmp, "explicit"), ["Workshop", "Images"]);
    const configMods = await makeModsDir(path.join(tmp, "from-config"), ["Workshop"]);
    await makeModsDir(installRoot, ["Workshop", "Images", "Saves"]);
    await mkdir(path.join(docsMods, "Workshop"), { recursive: true });
    const cfgPath = path.join(tmp, "config.yaml");
    await writeConfig({ datadir: configMods }, cfgPath);

    const result = await locateDatadir({ explicitPath: explicitMods, configPath: cfgPath });

    expect(result.candidates.map((c) => c.source)).toEqual([
      "explicit",
      "config",
      "install-dir",
      "documents",
    ]);
    expect(result.candidates.map((c) => c.validSubdirs)).toEqual([2, 1, 3, 1]);
    expect(result.candidates.every((c) => c.exists)).toBe(true);
    expect(result.requiresChoice).toBe(true);
  });

  it("找到多个有效位置时 requiresChoice 为 true 且不填 recommended", async () => {
    await mkdir(path.join(installMods, "Workshop"), { recursive: true });
    await mkdir(path.join(docsMods, "Workshop"), { recursive: true });

    const result = await locateDatadir({ configPath: missingConfig });

    expect(result.requiresChoice).toBe(true);
    expect(result.recommended).toBeUndefined();
  });

  it("恰好一个有效时 recommended 指向该位置且 requiresChoice 为 false", async () => {
    // 只造 Documents 的 Mods；安装目录下无 Mods → 唯一有效
    await mkdir(path.join(docsMods, "Workshop"), { recursive: true });

    const result = await locateDatadir({ configPath: missingConfig });

    expect(result.candidates.map((c) => c.source)).toEqual(["install-dir", "documents"]);
    expect(result.candidates[0]).toMatchObject({ source: "install-dir", exists: false });
    expect(result.requiresChoice).toBe(false);
    expect(result.recommended).toBe(docsMods);
  });

  it("零个有效时 requiresChoice 为 false 且 recommended 省略", async () => {
    const result = await locateDatadir({ configPath: missingConfig });

    expect(result.candidates.map((c) => c.source)).toEqual(["install-dir", "documents"]);
    expect(result.candidates.every((c) => !c.exists)).toBe(true);
    expect(result.requiresChoice).toBe(false);
    expect(result.recommended).toBeUndefined();
  });

  it("显式路径不存在时仍列为首个候选且 exists 为 false", async () => {
    await mkdir(path.join(docsMods, "Workshop"), { recursive: true });
    const missing = path.join(tmp, "不存在的目录", "Mods");

    const result = await locateDatadir({ explicitPath: missing, configPath: missingConfig });

    expect(result.candidates[0]).toMatchObject({ source: "explicit", exists: false, validSubdirs: 0 });
    expect(result.recommended).toBe(docsMods);
  });

  it.runIf(process.platform === "win32")(
    "Windows 下同一路径大小写不同时去重（真实文件系统大小写不敏感）",
    async () => {
      await mkdir(path.join(docsMods, "Workshop"), { recursive: true });
      // 把路径中一段改成不同大小写，真实 fs 仍命中同一目录
      const explicitAltCase = docsMods.replace("My Games", "MY GAMES");

      const result = await locateDatadir({ explicitPath: explicitAltCase, configPath: missingConfig });

      expect(result.candidates.map((c) => c.source)).toEqual(["explicit", "install-dir"]);
      expect(result.candidates[0]).toMatchObject({ exists: true, validSubdirs: 1 });
    },
  );
});

// ---------------------------------------------------------------------------
// 第三部分：readConfig / writeConfig（临时目录真实 fs，yaml 读写）
// ---------------------------------------------------------------------------

describe("readConfig / writeConfig（临时目录真实 fs）", () => {
  beforeEach(() => {
    // 委托到 node:fs 真实实现（本文件顶层 mock 了 node:fs，真实 fs 用例需切回真实实现）
    existsSyncMock.mockImplementation(realFs.existsSync);
    statSyncMock.mockImplementation(realFs.statSync);
    readFileSyncMock.mockImplementation(realFs.readFileSync);
    writeFileSyncMock.mockImplementation(realFs.writeFileSync);
    mkdirSyncMock.mockImplementation(realFs.mkdirSync);
  });

  it("配置文件不存在时返回空对象", async () => {
    const cfgPath = path.join(tmp, "不存在.yaml");

    await expect(readConfig(cfgPath)).resolves.toEqual({});
  });

  it("writeConfig 写入后 readConfig 能原样读回含反斜杠的 Windows 路径", async () => {
    const cfgPath = path.join(tmp, "config.yaml");
    const datadir = "D:\\SteamLibrary\\我的 图包\\Mods";

    await writeConfig({ datadir }, cfgPath);

    // 直接校验落盘字节：反斜杠不丢失
    const raw = await readFile(cfgPath, "utf8");
    expect(raw).toContain('datadir: D:\\SteamLibrary\\我的 图包\\Mods');
    await expect(readConfig(cfgPath)).resolves.toEqual({ datadir });
  });

  it("空文件与纯注释文件都视为空配置", async () => {
    const emptyPath = path.join(tmp, "empty.yaml");
    const commentPath = path.join(tmp, "comment.yaml");
    await writeFile(emptyPath, "", "utf8");
    await writeFile(commentPath, "# 只有注释\n", "utf8");

    await expect(readConfig(emptyPath)).resolves.toEqual({});
    await expect(readConfig(commentPath)).resolves.toEqual({});
  });

  it("读取时忽略未知字段，只返回 datadir", async () => {
    const cfgPath = path.join(tmp, "config.yaml");
    await writeFile(cfgPath, "otherField: keep\ndatadir: D:/mods\n", "utf8");

    await expect(readConfig(cfgPath)).resolves.toEqual({ datadir: "D:/mods" });
  });

  it("datadir 为 null 时视作未设置", async () => {
    const cfgPath = path.join(tmp, "config.yaml");
    await writeFile(cfgPath, "datadir: null\n", "utf8");

    await expect(readConfig(cfgPath)).resolves.toEqual({});
  });

  it("配置文件不是合法 YAML 时抛出中文错误", async () => {
    const cfgPath = path.join(tmp, "bad.yaml");
    await writeFile(cfgPath, "datadir: [unclosed", "utf8");

    await expect(readConfig(cfgPath)).rejects.toThrow(/配置文件不是合法 YAML：/);
  });

  it("datadir 类型非法时抛出中文错误", async () => {
    const cfgPath = path.join(tmp, "bad-type.yaml");
    await writeFile(cfgPath, "datadir: 123\n", "utf8");

    await expect(readConfig(cfgPath)).rejects.toThrow(/配置文件格式无效：.*（datadir：必须是字符串）/);
  });

  it("配置根为数组时抛出中文错误", async () => {
    const cfgPath = path.join(tmp, "array-root.yaml");
    await writeFile(cfgPath, "- a\n- b\n", "utf8");

    await expect(readConfig(cfgPath)).rejects.toThrow(/（\(根\)：配置必须是键值对象）/);
  });

  it("writeConfig 自动创建多级目录并写入", async () => {
    const cfgPath = path.join(tmp, "a", "b", "c", "config.yaml");

    await writeConfig({ datadir: "D:/mods" }, cfgPath);

    await expect(readConfig(cfgPath)).resolves.toEqual({ datadir: "D:/mods" });
  });

  it("writeConfig 保留未知字段并更新 datadir（合并语义）", async () => {
    const cfgPath = path.join(tmp, "config.yaml");
    await writeFile(cfgPath, 'futureField: keep-me\ndatadir: "D:/old"\n', "utf8");

    await writeConfig({ datadir: "D:/new" }, cfgPath);

    const raw = await readFile(cfgPath, "utf8");
    expect(raw).toContain("keep-me");
    expect(raw).not.toContain("D:/old");
    expect(raw).toContain("D:/new");
    await expect(readConfig(cfgPath)).resolves.toEqual({ datadir: "D:/new" });
  });

  it("datadir 为 undefined 时清除该字段但保留其他字段", async () => {
    const cfgPath = path.join(tmp, "config.yaml");
    await writeFile(cfgPath, 'futureField: keep-me\ndatadir: "D:/old"\n', "utf8");

    await writeConfig({ datadir: undefined }, cfgPath);

    const raw = await readFile(cfgPath, "utf8");
    expect(raw).toContain("keep-me");
    expect(raw).not.toContain("datadir");
    await expect(readConfig(cfgPath)).resolves.toEqual({});
  });

  it("已有配置不是合法 YAML 时 writeConfig 拒绝写入且不破坏原文件", async () => {
    const cfgPath = path.join(tmp, "broken.yaml");
    const broken = "datadir: [unclosed";
    await writeFile(cfgPath, broken, "utf8");

    await expect(writeConfig({ datadir: "D:/mods" }, cfgPath)).rejects.toThrow(/配置文件不是合法 YAML：/);
    await expect(readFile(cfgPath, "utf8")).resolves.toBe(broken);
  });

  it("writeConfig 入参 cfg 为 undefined 时抛出中文错误", async () => {
    const cfgPath = path.join(tmp, "config.yaml");

    await expect(writeConfig(undefined as unknown as { datadir?: string }, cfgPath)).rejects.toThrow(
      /cfg 不能为 undefined/,
    );
  });
});
