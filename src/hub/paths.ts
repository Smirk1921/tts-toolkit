// src/hub/paths.ts
/**
 * hub 文件路由（UI-1b /v1/files/read、/v1/files/write）共用的路径防护。
 *
 * 这两条路由按 UI 请求在"图包工作区 root"内读写任意相对路径的文件，是 hub 全部
 * 路由里唯一直接触碰宿主机文件系统写入面的入口，因此必须在进入 fs 之前把请求
 * 路径钉死在 root 内。防护分四层（参考 src/archive/ttsmod.ts 的 zip-slip 检查
 * 模式，并追加 symlink 真实路径校验）：
 *
 * 1. 字面拒绝：rel 含 null 字节（C 运行时层可截断路径）；
 * 2. 字面拒绝：rel 是绝对路径 / 盘符前缀（`/etc/passwd`、`C:\Windows`、`C:foo`）；
 * 3. 字面拒绝：rel 含 ".." 段（按 / 与 \ 两种分隔符切分后逐段比对）；
 * 4. 归一化后前缀校验：path.resolve(root, rel) 必须落在 path.resolve(root) 的
 *    直接子树内（startsWith(root + path.sep)），双保险拦住 1-3 之外的归一化逃逸；
 * 5. symlink 真实路径校验（防逃逸关键层）：对 root 与"目标路径最深的已存在祖先"
 *    各取 fs.realpath，把不存在尾部拼回后再做一次前缀校验——root 本身是符号链接、
 *    或 rel 的中间段有指向 root 外的符号链接时，这里必然拦截。
 *
 * 错误模型：防护失败抛 {@link PathEscapeError}（code = "HUB_PATH_ESCAPE"），由
 * src/hub/control.ts 的 dispatch 统一映射为 400 HUB_PATH_ESCAPE。本模块不引入
 * i18n：message 是协议层英文短句，消费方是 MCP/运维日志与桌面 UI 的错误展示。
 */

import { realpath } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/**
 * 请求路径逃逸工作区 root（/v1/files/* 的路径防护失败）。
 *
 * 不继承 src/hub/control.ts 的私有 BadRequestError（避免 hub↔paths 循环依赖），
 * 由 control.ts 的 dispatch instanceof 分支映射为 400 HUB_PATH_ESCAPE。
 */
export class PathEscapeError extends Error {
  /** 机器可读错误码（固定 "HUB_PATH_ESCAPE"）。 */
  readonly code: string;

  /**
   * @param message 协议层英文短句（描述哪一层防护拦下了什么）
   */
  constructor(message: string) {
    super(message);
    this.name = "PathEscapeError";
    this.code = "HUB_PATH_ESCAPE";
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 从 unknown 错误中取 Node 风格的 code 属性（如 ENOENT / ELOOP），避免 any。
 * @param err 任意抛出值
 * @returns 字符串形式的 code；取不到时返回 undefined
 */
function errCode(err: unknown): string | undefined {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

/**
 * 把"相对 root 的请求路径"解析为绝对路径，并验证它（及其符号链接真实路径）
 * 严格落在 root 子树内。
 *
 * 前置条件：root 必须是已存在的目录（realpath 失败视为"无法验证 containment"，
 * 一律拒绝——两条 /v1/files/* 路由的调用方都先做过 root 级校验，root 不存在时
 * 在这里失败是预期行为）；rel 必须是相对路径（绝对路径 / 盘符 / ".." 段 /
 * null 字节一律 {@link PathEscapeError}）。
 *
 * 校验通过的返回值是 path.resolve(root, rel)（保持请求方的路径拼写；符号链接
 * 只是验证对象，不在返回值里改写）。
 *
 * @param root 工作区根目录（绝对 / 相对均可，内部先 resolve）
 * @param rel 相对 root 的请求路径（不允许绝对路径 / ".." / null 字节）
 * @returns 解析出的绝对路径（保证在 root 子树内）
 * @throws PathEscapeError rel 含 null 字节 / 绝对路径 / 盘符 / ".." 段、
 *                          归一化后逃出 root、root 或路径祖先经 realpath
 *                          解析后逃出 root，或 root 不可访问（无法验证）时
 */
export async function resolveWithinRoot(root: string, rel: string): Promise<string> {
  // —— 1-3. 字面拒绝（null 字节 / 绝对路径 / 盘符 / ".." 段）——
  if (rel.includes("\0")) {
    throw new PathEscapeError("path contains a null byte");
  }
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new PathEscapeError(`path must be relative to the workspace root: ${rel}`);
  }
  // 按 / 与 \ 两种分隔符切分（Windows 反斜杠在 POSIX 上是文件名字符，但字面
  // 拒绝 ".." 段对两种平台都取更严的一侧）
  const segments = rel.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) {
    throw new PathEscapeError(`path must not contain ".." segments: ${rel}`);
  }

  // —— 4. 归一化后前缀校验 ——
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, rel);
  const rootPrefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (!target.startsWith(rootPrefix)) {
    throw new PathEscapeError(`path escapes the workspace root: ${rel}`);
  }

  // —— 5. symlink 真实路径校验：root 与目标的最深已存在祖先各取 realpath ——
  let realRoot: string;
  try {
    realRoot = await realpath(rootAbs);
  } catch (err) {
    throw new PathEscapeError(
      `cannot verify workspace root containment (root missing or inaccessible): ${rootAbs} (${errCode(err) ?? String(err)})`,
    );
  }

  // 从 target 逐级向上找第一个真实存在的祖先（write 场景目标文件可以尚不存在；
  // ENOENT / ENOTDIR / EINVAL 是"这一级不存在 / 不是目录"的正常信号，继续向上；
  // 其余错误——EACCES / ELOOP 等——无法验证 containment，一律拒绝）
  let probe = target;
  const missing: string[] = [];
  let realAncestor: string;
  for (;;) {
    try {
      realAncestor = await realpath(probe);
      break;
    } catch (err) {
      const code = errCode(err);
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EINVAL") {
        throw new PathEscapeError(
          `cannot verify path containment: ${probe} (${code ?? String(err)})`,
        );
      }
    }
    const parent = path.dirname(probe);
    if (parent === probe) {
      // root 已验证存在，理论上走不到文件系统根；防御兜底
      throw new PathEscapeError(`cannot verify path containment: ${target}`);
    }
    missing.push(path.basename(probe));
    probe = parent;
  }
  missing.reverse();
  // 把不存在（未参与 realpath 解析）的尾部段拼回真实祖先，得到目标的真实路径
  const realTarget =
    missing.length === 0 ? realAncestor : path.join(realAncestor, ...missing);
  const realPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (!realTarget.startsWith(realPrefix)) {
    throw new PathEscapeError(
      `path escapes the workspace root through a symbolic link: ${rel}`,
    );
  }

  return target;
}
