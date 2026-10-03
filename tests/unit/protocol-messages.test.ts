// tests/unit/protocol-messages.test.ts
/**
 * messages.ts 单元测试：parseInbound / outboundSchema / 协议常量。
 * 纯 schema 校验，无网络依赖。
 */
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  GLOBAL_GUID,
  InboundId,
  OutboundId,
  outboundSchema,
  parseInbound,
} from '../../src/protocol/messages.js';

describe('parseInbound：8 种入站消息的正确解析', () => {
  it('messageID 0（PushNewObject）：解析 scriptStates', () => {
    const msg = parseInbound({
      messageID: InboundId.PushNewObject,
      scriptStates: [{ name: 'Global', guid: GLOBAL_GUID, script: '-- lua' }],
    });
    expect(msg).toMatchObject({
      messageID: 0,
      scriptStates: [{ name: 'Global', guid: '-1', script: '-- lua' }],
    });
  });

  it('messageID 1（GameLoaded）：scriptStates 含 ui 时原样保留', () => {
    const msg = parseInbound({
      messageID: InboundId.GameLoaded,
      scriptStates: [{ name: 'Global', guid: '-1', script: '-- lua', ui: '<Panel/>' }],
    });
    expect(msg).toMatchObject({
      messageID: 1,
      scriptStates: [{ ui: '<Panel/>' }],
    });
  });

  it('messageID 1（GameLoaded）：scriptStates 缺 ui 也可解析（边界，ui 可选不丢字段）', () => {
    const msg = parseInbound({
      messageID: InboundId.GameLoaded,
      scriptStates: [{ name: 'Global', guid: '-1', script: '-- lua' }],
    });
    if (msg.messageID !== InboundId.GameLoaded) {
      throw new Error('应解析为 GameLoaded');
    }
    // 缺省 ui 时 key 不存在（zod optional），读取结果为 undefined
    expect(msg.scriptStates[0]?.ui).toBeUndefined();
  });

  it('messageID 2（Print）：解析 message 文本', () => {
    const msg = parseInbound({ messageID: InboundId.Print, message: '你好，TTS' });
    expect(msg).toEqual({ messageID: 2, message: '你好，TTS' });
  });

  it('messageID 3（Error）：解析 error / guid / errorMessagePrefix', () => {
    const msg = parseInbound({
      messageID: InboundId.Error,
      error: 'chunk_0:(36,4-8): unexpected symbol',
      guid: 'ab12',
      errorMessagePrefix: 'Error in Global Script: ',
    });
    expect(msg).toEqual({
      messageID: 3,
      error: 'chunk_0:(36,4-8): unexpected symbol',
      guid: 'ab12',
      errorMessagePrefix: 'Error in Global Script: ',
    });
  });

  it('messageID 4（CustomMessage）：customMessage 任意 JSON 透传', () => {
    const custom = { foo: 'bar', nested: { n: 1 } };
    const msg = parseInbound({ messageID: InboundId.CustomMessage, customMessage: custom });
    expect(msg).toEqual({ messageID: 4, customMessage: custom });
  });

  it('messageID 5（ReturnValue）：解析 returnValue 与 returnID', () => {
    const msg = parseInbound({
      messageID: InboundId.ReturnValue,
      returnValue: 2,
      returnID: 77,
    });
    expect(msg).toEqual({ messageID: 5, returnValue: 2, returnID: 77 });
  });

  it('messageID 6（GameSaved）：带 savePath 时解析', () => {
    const msg = parseInbound({
      messageID: InboundId.GameSaved,
      savePath: 'C:/保存/存档.json',
    });
    expect(msg).toEqual({ messageID: 6, savePath: 'C:/保存/存档.json' });
  });

  it('messageID 6（GameSaved）：缺 savePath 也可解析（边界，实测字段可选）', () => {
    const msg = parseInbound({ messageID: InboundId.GameSaved });
    expect(msg).toEqual({ messageID: 6 });
  });

  it('messageID 7（ObjectCreated）：解析 guid', () => {
    const msg = parseInbound({ messageID: InboundId.ObjectCreated, guid: 'obj-9' });
    expect(msg).toEqual({ messageID: 7, guid: 'obj-9' });
  });
});

describe('parseInbound：非法输入抛 ZodError', () => {
  it('未知 messageID（如 999）抛 ZodError', () => {
    expect(() => parseInbound({ messageID: 999 })).toThrow(ZodError);
  });

  it('messageID 类型错误（字符串 "2"）抛 ZodError', () => {
    expect(() => parseInbound({ messageID: '2', message: 'x' })).toThrow(ZodError);
  });

  it('Print 缺 message 字段抛 ZodError', () => {
    expect(() => parseInbound({ messageID: 2 })).toThrow(ZodError);
  });

  it('Error 缺 errorMessagePrefix 字段抛 ZodError', () => {
    expect(() => parseInbound({ messageID: 3, error: 'e', guid: 'g' })).toThrow(ZodError);
  });

  it('入站 scriptState 缺必填 script 字段抛 ZodError', () => {
    expect(() =>
      parseInbound({ messageID: 1, scriptStates: [{ name: 'Global', guid: '-1' }] }),
    ).toThrow(ZodError);
  });

  it('ReturnValue 的 returnID 类型错误（字符串）抛 ZodError', () => {
    expect(() =>
      parseInbound({ messageID: 5, returnValue: null, returnID: '77' }),
    ).toThrow(ZodError);
  });

  it('非对象输入（null / 字符串 / 数组 / 数字 / undefined）全部抛 ZodError', () => {
    expect(() => parseInbound(null)).toThrow(ZodError);
    expect(() => parseInbound('不是对象')).toThrow(ZodError);
    expect(() => parseInbound([])).toThrow(ZodError);
    expect(() => parseInbound(42)).toThrow(ZodError);
    expect(() => parseInbound(undefined)).toThrow(ZodError);
  });
});

describe('parseInbound：schema 严格性（多余字段忽略）', () => {
  it('多余字段被剥离：解析结果只含协议字段', () => {
    const msg = parseInbound({
      messageID: 1,
      scriptStates: [{ name: 'Global', guid: '-1', script: 'x' }],
      loadableObjects: [{ junk: true }],
    });
    // zod 对象默认 strip 模式：解析成功但多余字段不进入结果
    expect(msg).toEqual({
      messageID: 1,
      scriptStates: [{ name: 'Global', guid: '-1', script: 'x' }],
    });
  });
});

describe('outboundSchema：出站消息约束', () => {
  it('GetScripts：仅 messageID 即可', () => {
    expect(outboundSchema.safeParse({ messageID: OutboundId.GetScripts }).success).toBe(true);
  });

  it('SaveAndPlay：scriptStates 缺省 script/ui 可通过（缺省 = 删除语义）', () => {
    const result = outboundSchema.safeParse({
      messageID: OutboundId.SaveAndPlay,
      scriptStates: [{ name: 'x', guid: 'y' }],
    });
    expect(result.success).toBe(true);
  });

  it('SaveAndPlay：完整 script/ui 也可通过', () => {
    const result = outboundSchema.safeParse({
      messageID: OutboundId.SaveAndPlay,
      scriptStates: [{ name: 'x', guid: 'y', script: 's', ui: 'u' }],
    });
    expect(result.success).toBe(true);
  });

  it('CustomMessage：JSON 对象（Lua table）可通过', () => {
    const result = outboundSchema.safeParse({
      messageID: OutboundId.CustomMessage,
      customMessage: { a: 1 },
    });
    expect(result.success).toBe(true);
  });

  it('CustomMessage：数组被拒绝（坑 1：必须是 table，不能是数组/标量）', () => {
    const result = outboundSchema.safeParse({
      messageID: OutboundId.CustomMessage,
      customMessage: [1, 2],
    });
    expect(result.success).toBe(false);
  });

  it('CustomMessage：标量被拒绝', () => {
    expect(
      outboundSchema.safeParse({ messageID: OutboundId.CustomMessage, customMessage: 'x' })
        .success,
    ).toBe(false);
    expect(
      outboundSchema.safeParse({ messageID: OutboundId.CustomMessage, customMessage: null })
        .success,
    ).toBe(false);
  });

  it('ExecuteLua：guid / script / returnID 齐全才可通过', () => {
    expect(
      outboundSchema.safeParse({
        messageID: OutboundId.ExecuteLua,
        guid: '-1',
        script: 'return 1',
        returnID: 1,
      }).success,
    ).toBe(true);
    expect(
      outboundSchema.safeParse({ messageID: OutboundId.ExecuteLua, guid: '-1', script: 'return 1' })
        .success,
    ).toBe(false);
  });
});

describe('协议常量', () => {
  it('GLOBAL_GUID 为 "-1"（全局脚本）', () => {
    expect(GLOBAL_GUID).toBe('-1');
  });

  it('InboundId / OutboundId 数值与协议文档锚定，防止重构漂移', () => {
    expect(InboundId.PushNewObject).toBe(0);
    expect(InboundId.GameLoaded).toBe(1);
    expect(InboundId.Print).toBe(2);
    expect(InboundId.Error).toBe(3);
    expect(InboundId.CustomMessage).toBe(4);
    expect(InboundId.ReturnValue).toBe(5);
    expect(InboundId.GameSaved).toBe(6);
    expect(InboundId.ObjectCreated).toBe(7);
    expect(OutboundId.GetScripts).toBe(0);
    expect(OutboundId.SaveAndPlay).toBe(1);
    expect(OutboundId.CustomMessage).toBe(2);
    expect(OutboundId.ExecuteLua).toBe(3);
  });
});
