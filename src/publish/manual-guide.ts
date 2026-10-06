// src/publish/manual-guide.ts
/**
 * 手动上传手册生成 + 剪贴板工具 —— 窗口 G / 阶段 7，B2 产出。
 *
 * kpsteam（自动上传）在 2026 年实测不可用（见
 * `参考资料/05-工坊发布/上传方式与SteamAPI.md` §1.2：5 年未更新、需 Windows +
 * Steam 已登录作者账号等硬前提），因此本模块提供**手动模式的完整兜底**：
 * - {@link generateManualGuide}：校验 BSON 载荷存在 → 生成 Markdown 手册
 *   （7 步游戏内上传流程）→ 把 BSON 绝对路径复制到剪贴板；
 * - {@link copyToClipboard}：独立的小工具，把任意文本写入 Windows 剪贴板。
 *
 * 红线：本模块**绝不自动打开 Steam 或 Tabletop Simulator**，也绝不模拟点击——
 * 上传动作只能由用户在游戏内手动完成；手册第一句话就向用户声明这一点。
 *
 * 剪贴板实现（Windows）：`spawn("clip.exe", [], { stdio: ["pipe", "ignore", "ignore"] })`
 * 把文本写入 stdin。编码为 **UTF-16LE（无 BOM）**——本机（Windows 10.0.26200）
 * 实测：clip.exe 会启发式识别 UTF-16 字节流，纯 ASCII 与含中文的路径都能
 * 精确还原；写 UTF-8 会被按控制台代码页误读（中文变乱码），带 BOM 则会在
 * 内容前多出一个 U+FEFF。不引 clipboardy 等外部依赖。
 *
 * i18n 说明（坑 19 / 坑 20）：本阶段只声明键名，locales 由 Stage C 补；
 * 缺键时 t() 原样输出键名，会导致手册不可读，因此这里用 tOr 兜底：t() 命中
 * locales 时用译文，否则用内置中文文案（手工插值 {placeholder}）。每个键的
 * 占位符集合是固定的、调用时必定提供（ itemId 缺省时 step7 用字面量
 * `<item_id>` 占位），Stage C 补 locales 时不会有缺参 / 多参问题。
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像）：
 * - `publish.manual_guide.title`
 * - `publish.manual_guide.intro`
 * - `publish.manual_guide.preparedTitle`
 * - `publish.manual_guide.preparedPath` {path}
 * - `publish.manual_guide.itemLabel` {itemId}
 * - `publish.manual_guide.stepsTitle`
 * - `publish.manual_guide.step1` / `step2` / `step3` / `step4` / `step5` / `step6`
 * - `publish.manual_guide.step7` {itemId}
 * - `publish.manual_guide.notes`
 * - `error.publish.bsonNotFound` {path}
 * - `error.publish.clipboardFailed` {code}
 *
 * 新增错误码（locales 由 Stage C 补）：
 * - `PUBLISH_BSON_NOT_FOUND`：BSON 文件不存在（本模块抛出）；
 * - `PUBLISH_KPSTEAM_NOT_AVAILABLE` / `PUBLISH_UPLOAD_FAILED`：声明于
 *   src/publish/kpsteam.ts（CLI 层 --auto 模式使用）。
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 手动上传手册生成参数 */
export interface ManualGuideOptions {
  /** BSON 文件绝对路径（会被复制到剪贴板） */
  bsonPath: string;
  /** 工坊条目 ID（可选，用于在手册中告诉用户更新哪个条目） */
  itemId?: string | number;
  /** 语言（默认 "zh"；locales 未接入前仅作声明保留，见文件头 i18n 说明） */
  lang?: "zh" | "en";
}

/** 手动上传手册生成结果 */
export interface ManualGuideResult {
  /** 手册文本（Markdown 格式） */
  text: string;
  /** 是否已成功复制 bsonPath 到剪贴板 */
  clipboardCopied: boolean;
  /** 剪贴板复制失败的原因（成功时 undefined） */
  clipboardError?: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * t() 的兜底包装：locales 命中时返回译文；缺键（t() 原样返回键名）时返回
 * 内置中文 fallback，并对 fallback 里的 {name} 手工插值。
 * Stage C 补齐 locales 后，本函数自动切换为纯 t() 通路，无需改动调用点。
 */
function tOr(key: string, fallback: string, params?: Record<string, unknown>): string {
  const out = t(key, params);
  if (out !== key) {
    return out;
  }
  return fallback.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params?.[name];
    return value === undefined ? whole : String(value);
  });
}

/** 逐节拼装手册文本（Markdown，中文为主，标题附英文） */
function buildGuideText(opts: ManualGuideOptions): string {
  const itemId = opts.itemId === undefined ? undefined : String(opts.itemId);
  const lines: string[] = [];

  lines.push(tOr("publish.manual_guide.title", "# 工坊手动上传手册（Manual Workshop Upload Guide）"));
  lines.push("");
  lines.push(tOr(
    "publish.manual_guide.intro",
    "> kpsteam 在 2026 年实测不可用（或你选择了手动模式），本次上传需要你在游戏内手动完成。"
      + "工具已生成 BSON 载荷，并把载荷绝对路径复制到了剪贴板。",
  ));
  lines.push("");
  lines.push(tOr("publish.manual_guide.preparedTitle", "## 工具已准备好的内容"));
  lines.push(tOr(
    "publish.manual_guide.preparedPath",
    "- BSON 载荷已生成，路径（已复制到剪贴板）：`{path}`",
    { path: opts.bsonPath },
  ));
  if (itemId !== undefined) {
    lines.push(tOr("publish.manual_guide.itemLabel", "- 目标条目 PublishedFileID：{itemId}", { itemId }));
  }
  lines.push("");
  lines.push(tOr("publish.manual_guide.stepsTitle", "## 手动上传步骤（7 步）"));
  lines.push(tOr(
    "publish.manual_guide.step1",
    "1) 打开 Steam 客户端，登录拥有 Tabletop Simulator 且是该工坊条目作者的账号。",
  ));
  lines.push(tOr("publish.manual_guide.step2", "2) 启动 Tabletop Simulator 并进入主菜单。"));
  lines.push(tOr("publish.manual_guide.step3", "3) 点击 \"Games\" → \"Workshop\" 找到目标条目（上方已列出 PublishedFileID，可直接搜索定位）。"));
  lines.push(tOr(
    "publish.manual_guide.step4",
    "4) 在条目页面点 \"Update Workshop\"（或在游戏内加载存档后点 \"Modding\" → \"Workshop Upload\"）。",
  ));
  lines.push(tOr(
    "publish.manual_guide.step5",
    "5) 在弹出的上传窗口：\n"
      + "   - \"Update existing\" 选中目标条目的 PublishedFileID；\n"
      + "   - 内容文件选择工具产出的 BSON（路径已复制到剪贴板）；\n"
      + "   - 标题 / 简介 / 预览图按需修改（元数据只能在游戏内改）。",
  ));
  lines.push(tOr("publish.manual_guide.step6", "6) 点 \"Upload\" 等待进度条完成。"));
  lines.push(tOr(
    "publish.manual_guide.step7",
    "7) 到工坊页面验证 time_updated 已刷新（或调 `tts publish --check {itemId}` 确认）。",
    { itemId: itemId ?? "<item_id>" },
  ));
  lines.push("");
  lines.push(tOr(
    "publish.manual_guide.notes",
    "## 注意事项\n"
      + "- 本工具绝不自动打开游戏或 Steam；上传必须由你在游戏内 / Steam 中手动完成。\n"
      + "- 上传前 Steam 客户端必须在运行，且登录的是拥有 TTS、并为该条目作者的账号。\n"
      + "- 预览缩略图必填：跳过会导致报错、上传失败。\n"
      + "- 走 kpsteam（--auto，legacy 模式）时不支持更新说明（change notes），也无法更新预览图。\n"
      + "- 新建的工坊条目默认隐藏（仅好友可见），上传完成后记得改为公开。",
  ));
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 仅复制文本到剪贴板（独立工具）。
 *
 * Windows：`spawn("clip.exe", ...)`，文本以 UTF-16LE（无 BOM）写入 stdin
 * （编码依据见文件头实测注释）；非 Windows：返回 ok=false（不抛错）。
 */
export function copyToClipboard(text: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve({ ok: false, error: "仅支持 Windows" });
      return;
    }
    let settled = false;
    const finish = (r: { ok: boolean; error?: string }): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      const child = spawn("clip.exe", [], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.on("error", (err: Error) => {
        finish({ ok: false, error: err.message });
      });
      child.on("close", (code) => {
        if (code === 0) {
          finish({ ok: true });
        } else {
          finish({ ok: false, error: tOr("error.publish.clipboardFailed", "clip.exe 退出码异常：{code}", { code: code ?? "null" }) });
        }
      });
      child.stdin?.on("error", (err: Error) => {
        finish({ ok: false, error: err.message });
      });
      child.stdin?.write(Buffer.from(text, "utf16le"));
      child.stdin?.end();
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * 生成手动上传手册。
 *
 * 1. 校验 opts.bsonPath 存在且是文件（否则抛 PackError "PUBLISH_BSON_NOT_FOUND"）；
 * 2. 生成 Markdown 手册（7 步流程；itemId 给定时在手册中列出该 ID）；
 * 3. 把 opts.bsonPath 原文复制到剪贴板（失败不阻断，通过 clipboardError 上报）。
 */
export async function generateManualGuide(opts: ManualGuideOptions): Promise<ManualGuideResult> {
  let st;
  try {
    st = await stat(opts.bsonPath);
  } catch {
    st = undefined;
  }
  if (!st?.isFile()) {
    throw new PackError(
      "PUBLISH_BSON_NOT_FOUND",
      tOr("error.publish.bsonNotFound", "BSON 文件不存在：{path}", { path: opts.bsonPath }),
    );
  }
  const text = buildGuideText(opts);
  const clip = await copyToClipboard(opts.bsonPath);
  return {
    text,
    clipboardCopied: clip.ok,
    clipboardError: clip.ok ? undefined : clip.error,
  };
}
