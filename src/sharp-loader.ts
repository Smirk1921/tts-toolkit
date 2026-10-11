import type * as SharpNS from "sharp";

let cached: typeof SharpNS.default | null = null;

/**
 * 动态加载 sharp。pkg 环境下注入 PATH 让 .dll 可被 Windows 加载器找到。
 * 缓存实例避免重复加载。
 */
export async function loadSharp(): Promise<typeof SharpNS.default> {
  if (cached !== null) {
    return cached;
  }
  if (typeof (process as any).pkg !== "undefined") {
    const path = await import("node:path");
    const nativeDir = path.join(path.dirname(process.execPath), "native");
    const currentPath = process.env.PATH;
    process.env.PATH = currentPath ? `${nativeDir}${path.delimiter}${currentPath}` : nativeDir;
  }
  try {
    const m = await import("sharp");
    cached = m.default;
    return cached;
  } catch (err) {
    throw new Error(`failed to load sharp: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}
