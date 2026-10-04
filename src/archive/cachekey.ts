// src/archive/cachekey.ts
/**
 * TTS 素材缓存键（方案设计 §12.2 —— `.ttsmod` 自包含的全部原理）。
 *
 * 背景：
 * - `.ttsmod` 是一个普通 ZIP，条目镜像 TTS 本地 `Mods/` 目录结构；
 * - 存档 JSON 里的 URL **一个字不改**；素材条目名用的是 TTS 自己的缓存键：
 *   `sanitize(url) + 扩展名`。接收方解压到 TTS 的 `Mods` 父目录后，TTS 按
 *   **同样规则**算出文件名，直接命中本地文件，永远不会去访问原始 URL——
 *   这就是"离线可用"的全部原理（不需要 URL 重写、不需要 base64、不需要 manifest）；
 * - 因此 {@link sanitizeUrl} 必须与 TTS（`CustomCache.ConvertURL` 系列）的实现
 *   **逐字符一致**，错一个字符接收方就命中不了缓存。
 *
 * 规则（已实测钉死）：
 * - `sanitize(url)` = url 去掉所有**非 ASCII 字母数字**字符（`[^A-Za-z0-9]`），
 *   大小写原样保留；
 * - 验证依据（真实 `.ttsmod` 样本，`D:\工具\TTS\research\`，实测日期 2026-10-04）：
 *   · `https://raw.githubusercontent.com/DasUmlaut/TTSLibrary/master/dials/dial-12-0.jpg`
 *     → `Mods/Images/httpsrawgithubusercontentcomDasUmlautTTSLibrarymasterdialsdial120jpg.jpg`
 *     （s_dial.ttsmod 实测条目：大小写保留、`-` `/` `:` `.` 全部去除）；
 *   · `http://nikulas.webs.com/UV.png`
 *     → `Mods/Images/httpnikulaswebscomUVpng.png`（s_hex.ttsmod 实测条目）；
 *   · `http://pastebin.com/raw.php?i=cDn7Eum6` + `".obj"`
 *     → `Mods/Models/httppastebincomrawphpicDn7Eum6.obj`（sample_diceset.ttsmod 实测条目）；
 * - 采用 ASCII 字母数字而非 Unicode 判定：TTS 存档里的 URL 实际全是 ASCII
 *   （非 ASCII 字符在 URL 里本就按百分号编码存储），且实测样本只覆盖 ASCII
 *   形态；按 ASCII 实现与非 ASCII URL 的 TTS 行为差异无从实测，不做猜测扩展。
 *
 * 扩展名部分（`.jpg` / `.obj` / `.unity3d` / `.PDF`）不属于本模块——它不在 URL
 * 里（16,714/36,184 条素材的 URL 没有扩展名，见 §12.4），由 src/archive/detect.ts
 * 的三级兜底推导。本模块只提供"拼缓存文件名"的薄封装，扩展名一律由调用方给。
 *
 * 本模块是纯函数模块：无 IO、无 i18n、不抛错。
 */

/**
 * TTS 缓存键：去掉 URL 中所有非 ASCII 字母数字字符（大小写原样保留）。
 *
 * 与 TTS 的 `CustomCache.ConvertURL` 逐字符一致（验证依据见模块头注释）。
 * 传入空字符串返回空字符串；非字符串入参由 TypeScript 类型约束排除，
 * 运行时不做二次校验（与 src/deck/patch.ts 的纯遍历模块同风格）。
 *
 * @param url 原始 URL（存档 JSON 中的原文）
 * @returns 缓存键（只含 A-Z a-z 0-9）
 */
export function sanitizeUrl(url: string): string {
  return url.replace(/[^A-Za-z0-9]/g, "");
}

/**
 * 拼 TTS 缓存文件名：`sanitize(url) + "." + ext`。
 *
 * 扩展名不带前导点传入（如 `"jpg"`）；调用方给的扩展名原样拼接、不改大小写
 * （PDF 约定大写 `".PDF"`，实测条目亦如此；Windows 文件系统大小写不敏感，
 * 不影响 TTS 命中）。ext 已带点时按已带点处理（幂等，防御调用方写法差异）。
 *
 * @param url 原始 URL（存档 JSON 中的原文）
 * @param ext 扩展名（不带点，如 `"jpg"`；带点时原样追加）
 * @returns 缓存文件名，如 `httpsrawgithubusercontentcomDasUmlautTTSLibrarymasterdialsdial120jpg.jpg`
 */
export function cacheFileName(url: string, ext: string): string {
  if (ext.startsWith(".")) {
    return `${sanitizeUrl(url)}${ext}`;
  }
  return `${sanitizeUrl(url)}.${ext}`;
}
