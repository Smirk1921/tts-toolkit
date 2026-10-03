// src/assets/fieldmap.ts
/**
 * Lua 在线 API 字段名（snake_case）与存档 JSON 字段名（CamelCase）的双向映射（坑 2）。
 *
 * 背景：
 * - TTS 的 Lua 在线 API（如 `obj.getCustomObject()`）用 snake_case：`image` / `face` / `num_width` …；
 * - 存档 JSON（以及 push 协议里的 CustomDeck 等结构）用 CamelCase：`ImageURL` / `FaceURL` / `NumWidth` …；
 * - 两边同名不同形，任何跨边界搬运字段的代码都必须先查这张表，不要凭猜测拼字段名：
 *   照存档字段名去 Lua 里找会一个都匹配不到（反之亦然）。
 *
 * 映射表（存档 JSON → Lua）：
 * | 存档 JSON (CamelCase)   | Lua (snake_case)      |
 * | ----------------------- | --------------------- |
 * | ImageURL                | image                 |
 * | ImageSecondaryURL       | image_secondary       |
 * | FaceURL                 | face                  |
 * | BackURL                 | back                  |
 * | MeshURL                 | mesh                  |
 * | DiffuseURL              | diffuse               |
 * | NormalURL               | normal                |
 * | ColliderURL             | collider              |
 * | AssetbundleURL          | assetbundle           |
 * | AssetbundleSecondaryURL | assetbundle_secondary |
 * | NumWidth                | num_width             |
 * | NumHeight               | num_height            |
 *
 * 实现约定：两表由同一份字段对（{@link FIELD_PAIRS}）派生，保证互为反向、不会单边漂移；
 * 查询函数只做精确匹配（区分大小写），并用 hasOwnProperty 判断，
 * 避免 `constructor` / `toString` 之类的原型键被误判为命中。
 */

/**
 * 唯一数据源：`[Lua snake_case 字段名, 存档 JSON CamelCase 字段名]` 字段对。
 * 新增字段只改这里，{@link LUA_TO_ARCHIVE} 与 {@link ARCHIVE_TO_LUA} 会自动保持反向一致。
 */
const FIELD_PAIRS: readonly (readonly [string, string])[] = Object.freeze([
  ["image", "ImageURL"],
  ["image_secondary", "ImageSecondaryURL"],
  ["face", "FaceURL"],
  ["back", "BackURL"],
  ["mesh", "MeshURL"],
  ["diffuse", "DiffuseURL"],
  ["normal", "NormalURL"],
  ["collider", "ColliderURL"],
  ["assetbundle", "AssetbundleURL"],
  ["assetbundle_secondary", "AssetbundleSecondaryURL"],
  ["num_width", "NumWidth"],
  ["num_height", "NumHeight"],
] as const);

/**
 * Lua（snake_case）→ 存档 JSON（CamelCase）映射表，如 `image` → `ImageURL`。
 * 已 Object.freeze，运行时不可改；未收录的键返回 undefined。
 */
export const LUA_TO_ARCHIVE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(FIELD_PAIRS.map(([lua, archive]): [string, string] => [lua, archive])),
);

/**
 * 存档 JSON（CamelCase）→ Lua（snake_case）映射表，如 `ImageURL` → `image`。
 * 已 Object.freeze，运行时不可改；未收录的键返回 undefined。
 */
export const ARCHIVE_TO_LUA: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(FIELD_PAIRS.map(([lua, archive]): [string, string] => [archive, lua])),
);

/**
 * Lua 字段名（snake_case）转存档 JSON 字段名（CamelCase）。
 *
 * @param key Lua 字段名（如 `image`）；大小写敏感，不做过任何归一化
 * @returns 对应的存档字段名（如 `ImageURL`）；未收录时返回 undefined（调用方可据此提示"未知字段"）
 */
export function luaToArchive(key: string): string | undefined {
  // 用 hasOwnProperty 判断：避免 "constructor" / "toString" 等原型链上的键被当成命中
  return Object.prototype.hasOwnProperty.call(LUA_TO_ARCHIVE, key) ? LUA_TO_ARCHIVE[key] : undefined;
}

/**
 * 存档 JSON 字段名（CamelCase）转 Lua 字段名（snake_case）。
 *
 * @param key 存档字段名（如 `ImageURL`）；大小写敏感，不做过任何归一化
 * @returns 对应的 Lua 字段名（如 `image`）；未收录时返回 undefined（调用方可据此提示"未知字段"）
 */
export function archiveToLua(key: string): string | undefined {
  // 同 luaToArchive：必须用 hasOwnProperty，防止原型链键误判
  return Object.prototype.hasOwnProperty.call(ARCHIVE_TO_LUA, key) ? ARCHIVE_TO_LUA[key] : undefined;
}
