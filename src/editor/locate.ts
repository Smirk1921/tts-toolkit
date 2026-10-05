// src/editor/locate.ts
/**
 * 在工作区按对象名定位脚本绝对路径（阶段 6 / 6A 轻量层）。
 *
 * 设计决策（窗口 F 简化版）：
 * - 只查工作区 `scripts/` 目录（即 `tts pull` 或 `tts pack pull` 已落盘的脚本）
 * - **不**主动从 TTS 拉取临时副本——与 E 窗口的 `watch` 配合：用户先 `tts pull`
 *   拉一次脚本，edit 打开工作区文件直接编辑，watch 自动同步回 TTS；或编辑完用
 *   `tts pack push` / `tts edit --save` 显式推送
 * - 未命中时抛 PackError "EDITOR_OBJECT_NOT_FOUND"，message 中带工作区现有候选名
 *
 * 匹配规则（与 pull.ts 的 fileBaseName 一致）：
 * - 全局脚本：`scripts/Global.lua`
 * - 普通对象：`scripts/<guid>.<safeName>.lua`（任意 guid，按文件名后缀匹配）
 *
 * 本模块使用的 i18n 键（locales/*.json 双语镜像）：
 * - `error.editor.objectNotFound` {name} {candidates}
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { t } from "../i18n/index.js";
import { PackError } from "../pack/packyaml.js";
import { GLOBAL_GUID } from "../protocol/messages.js";

/** Windows 文件名非法字符（与 pull.ts 保持一致） */
const INVALID_FILENAME_CHARS = /[/\\?%*:|"<>]/g;
/** Windows 不允许的控制字符（与 pull.ts 保持一致） */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * 净化对象名为文件名片段（与 pull.ts sanitizeName 同规则；
 * 不从 cli 反向依赖，故重写一份——这是坑 22 允许的"模块相互独立"场景）。
 */
function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, "_")
    .replace(CONTROL_CHARS, "")
    .replace(INVALID_FILENAME_CHARS, "")
    .replace(/^[._]+/, "")
    .replace(/[._ ]+$/, "");
  return cleaned === "" ? "object" : cleaned;
}

/** locateScript 的返回结果。 */
export interface LocatedScript {
  /** 脚本文件的绝对路径（工作区 scripts/ 下） */
  absPath: string;
  /** 匹配到的对象名（与输入相同；保留以便错误信息使用） */
  name: string;
  /** 匹配到的对象 guid（"-1" = 全局脚本） */
  guid: string;
}

/**
 * 列出工作区 scripts/ 下所有可用的对象名（未命中时报错用）。
 *
 * 提取规则：
 * - `Global.lua` → "Global"
 * - `<guid>.<safeName>.lua` → 从文件名还原（safeName 是净化过的，与原名可能
 *   有差异，但作为候选提示够用）
 *
 * @param root 工作区根目录
 * @returns 候选名数组（可能为空）
 */
async function listWorkspaceCandidates(root: string): Promise<string[]> {
  const scriptsDir = path.join(root, "scripts");
  if (!existsSync(scriptsDir)) {
    return [];
  }
  let entries: string[];
  try {
    entries = await readdir(scriptsDir);
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".lua")) {
      continue;
    }
    if (entry === "Global.lua") {
      candidates.push("Global");
      continue;
    }
    // <guid>.<safeName>.lua：去掉 .lua 后缀，再去掉 <guid>. 前缀
    const stem = entry.slice(0, -".lua".length);
    const firstDot = stem.indexOf(".");
    if (firstDot === -1) {
      continue;
    }
    candidates.push(stem.slice(firstDot + 1));
  }
  return candidates;
}

/**
 * 在工作区 `scripts/` 目录下按对象名定位脚本绝对路径。
 *
 * 匹配规则：
 * - name === "Global"：查 `scripts/Global.lua`
 * - 其他 name：查 `scripts/<任意 guid>.<sanitizeName(name)>.lua`，按后缀精确匹配
 *
 * 未命中时：
 * - 列出工作区现有的所有候选名（前 5 个，字典序）放进 PackError message 的
 *   candidates 占位符
 * - PackError.code = "EDITOR_OBJECT_NOT_FOUND"
 *
 * @param root 工作区根目录
 * @param name 对象名（如 "统计面板" / "Global"）
 * @returns 定位结果（absPath / name / guid）
 * @throws PackError code="EDITOR_OBJECT_NOT_FOUND" 工作区未命中
 */
export async function locateScript(root: string, name: string): Promise<LocatedScript> {
  const scriptsDir = path.join(root, "scripts");

  if (existsSync(scriptsDir)) {
    let entries: string[] = [];
    try {
      entries = await readdir(scriptsDir);
    } catch {
      entries = [];
    }

    if (name === "Global") {
      if (entries.includes("Global.lua")) {
        return {
          absPath: path.join(scriptsDir, "Global.lua"),
          name,
          guid: GLOBAL_GUID,
        };
      }
    } else {
      const safeName = sanitizeName(name);
      const suffix = `.${safeName}.lua`;
      for (const entry of entries) {
        if (!entry.endsWith(suffix)) {
          continue;
        }
        const guidEnd = entry.length - suffix.length;
        if (guidEnd <= 0) {
          continue;
        }
        const guid = entry.slice(0, guidEnd);
        return {
          absPath: path.join(scriptsDir, entry),
          name,
          guid,
        };
      }
    }
  }

  // 未命中：列出工作区候选名
  const allCandidates = await listWorkspaceCandidates(root);
  const sorted = allCandidates.sort((a, b) => a.localeCompare(b, "zh-CN"));
  const head = sorted.slice(0, 5);
  const candidates =
    sorted.length === 0
      ? "(无)"
      : head.join(", ") + (sorted.length > 5 ? ", ..." : "");

  throw new PackError(
    "EDITOR_OBJECT_NOT_FOUND",
    t("error.editor.objectNotFound", { name, candidates }),
  );
}
