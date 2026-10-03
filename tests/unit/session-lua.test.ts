// tests/unit/session-lua.test.ts
/**
 * src/session/lua.ts 单元测试（纯字符串生成器，不依赖 TCP）。
 *
 * 说明：TTS 的脚本引擎是 MoonSharp，本测试环境无法运行 Lua，
 * 因此只做字符串结构与关键 Lua 代码的存在性检查，不实际执行 Lua。
 */
import { describe, expect, it } from 'vitest';

import {
  luaEnumerateObjects,
  luaGetObjectCount,
  luaGetVersion,
  luaHasJsonEncode,
  luaScanUrlsInObject,
} from '../../src/session/lua.js';

describe('lua.ts 简单片段生成器', () => {
  it('luaGetObjectCount 返回精确片段 "return #getObjects()"', () => {
    expect(luaGetObjectCount()).toBe('return #getObjects()');
  });

  it('luaGetVersion 返回精确片段 "return _VERSION"（实测引擎为 MoonSharp）', () => {
    expect(luaGetVersion()).toBe('return _VERSION');
    expect(luaGetVersion()).toContain('_VERSION');
  });

  it('luaHasJsonEncode 检测内置 JSON 全局（type(JSON) == "table"）', () => {
    expect(luaHasJsonEncode()).toBe('return type(JSON) == "table"');
    expect(luaHasJsonEncode()).toContain('type(JSON)');
    expect(luaHasJsonEncode()).toContain('"table"');
  });
});

describe('lua.ts 枚举与扫描片段', () => {
  it('luaEnumerateObjects 遍历 getObjects() 并对每个对象返回 guid / name / type', () => {
    const code = luaEnumerateObjects();
    expect(code).toContain('getObjects()');
    expect(code).toContain('guid = obj.guid');
    expect(code).toContain('name = obj.name');
    expect(code).toContain('type = obj.type');
    expect(code).toContain('table.insert');
    expect(code).toContain('return out');
  });

  it('luaScanUrlsInObject 按 http 前缀递归扫描，不猜字段名（坑 2）', () => {
    const code = luaScanUrlsInObject();
    // ask 规定的四个关键字符串
    expect(code).toContain('getCustomObject');
    expect(code).toContain('match');
    expect(code).toContain('http');
    expect(code).toContain('table.insert');
    // 关键实现细节
    expect(code).toContain('^https?://'); // 只认 http/https 开头的字符串
    expect(code).toContain('ipairs(getObjects())'); // 遍历全部对象
    expect(code).toContain('pcall'); // getCustomObject 失败（非自定义对象）不中断
    expect(code).toContain('local function scan'); // 递归函数定义
  });

  it('全部片段最外层都是 return，可被 SessionExec.execJson 的 return 分支直接使用', () => {
    const snippets: Array<[string, string]> = [
      ['luaEnumerateObjects', luaEnumerateObjects()],
      ['luaScanUrlsInObject', luaScanUrlsInObject()],
      ['luaGetObjectCount', luaGetObjectCount()],
      ['luaGetVersion', luaGetVersion()],
      ['luaHasJsonEncode', luaHasJsonEncode()],
    ];
    for (const [name, code] of snippets) {
      expect(code.startsWith('return '), `${name} 必须以 return 开头`).toBe(true);
      // execJson 规则：以 return 开头 → 把 return 之后的部分作为表达式包装，
      // 多行多语句片段必须是单个 return 表达式（否则包装后是非法 Lua）
      expect(code.slice('return'.length).trim().length, `${name} return 后必须有表达式`).toBeGreaterThan(0);
    }
  });

  it('luaScanUrlsInObject 的多行逻辑收进立即执行函数（execJson 包装后是合法 Lua）', () => {
    const code = luaScanUrlsInObject();
    // 多行片段必须以 return (function() ... end)() 形式收进立即执行函数：
    // 否则 execJson 会把整段代码包装成 return JSON.encode(local urls = ...)（非法 Lua）
    expect(code.startsWith('return (function()')).toBe(true);
    expect(code.endsWith('end)()')).toBe(true);
    expect(code).toContain('local urls = {}');
    expect(code).toContain('return urls');
  });
});
