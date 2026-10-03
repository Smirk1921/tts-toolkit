// src/session/lua.ts

/**
 * 生成“枚举场上所有对象”的 Lua 代码。
 *
 * 遍历 getObjects()，对每个对象返回 { guid, name, type }。
 * 注意（坑 2）：type 返回的是枚举名（如 "Tile" / "Deck"），不是存档 JSON 里的
 * "Custom_Tile" / "DeckCustom"。
 *
 * 代码最外层是 return，可被 SessionExec.execJson 直接使用：
 * execJson 会把 return 之后的部分包装为 JSON.encode 表达式，
 * 即 `return JSON.encode((function() ... end)())`。
 *
 * @returns Lua 代码字符串
 */
export function luaEnumerateObjects(): string {
  return `return (function()
  local out = {}
  for _, obj in ipairs(getObjects()) do
    table.insert(out, { guid = obj.guid, name = obj.name, type = obj.type })
  end
  return out
end)()`;
}

/**
 * 生成“递归扫描场上全部自定义对象的 URL”的 Lua 代码。
 *
 * ⚠️ 关键约束（坑 2）：不猜字段名——Lua 在线 API 用 snake_case（image / face / back），
 * 存档 JSON 用 CamelCase（ImageURL / FaceURL），照存档字段名去找会一个都匹配不到。
 * 这里递归扫描 getCustomObject() 里所有以 http 开头的字符串，路径记录为
 * `<guid>.<字段链>`，TTS 以后加什么字段都不会漏。
 *
 * 实现说明：扫描逻辑多行多语句，若不加包装，execJson 会把整段代码当作单个表达式
 * 包装成 `return JSON.encode(local urls = ...)`（非法 Lua）。因此把原有逻辑原样收进
 * 立即执行函数，使最外层是 return——execJson 的 return 分支会把整个函数调用
 * 包装为 `return JSON.encode((function() ... end)())`，可直接使用。
 *
 * @returns Lua 代码字符串，返回 `Array<{ path: string, url: string }>`
 */
export function luaScanUrlsInObject(): string {
  return `return (function()
  local urls = {}
  local function scan(v, path)
    if type(v) == "string" and v:match("^https?://") then
      table.insert(urls, { path = path, url = v })
    elseif type(v) == "table" then
      for k, vv in pairs(v) do
        scan(vv, path .. "." .. tostring(k))
      end
    end
  end
  for _, obj in ipairs(getObjects()) do
    local ok, custom = pcall(function() return obj.getCustomObject() end)
    if ok and custom then
      scan(custom, obj.guid)
    end
  end
  return urls
end)()`;
}

/**
 * 生成“统计场上对象数量”的 Lua 代码（`return #getObjects()`）。
 * @returns Lua 代码字符串
 */
export function luaGetObjectCount(): string {
  return "return #getObjects()";
}

/**
 * 生成“查询脚本引擎版本”的 Lua 代码（`return _VERSION`，实测为 "MoonSharp 3.0.0.0"）。
 * @returns Lua 代码字符串
 */
export function luaGetVersion(): string {
  return "return _VERSION";
}

/**
 * 生成“检测 TTS 内置 JSON 全局是否可用”的 Lua 代码（`return type(JSON) == "table"`）。
 * JSON.encode 是 execJson 拿结构化数据的唯一正确姿势，调用前可先探测。
 * @returns Lua 代码字符串
 */
export function luaHasJsonEncode(): string {
  return 'return type(JSON) == "table"';
}
