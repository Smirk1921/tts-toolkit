// src/protocol/messages.ts
/**
 * TTS 外部编辑器协议消息定义（zod schema + 类型）。
 *
 * 两个方向：
 * - 入站（TTS → 编辑器）：TTS 主动连接编辑器端口 39998 推送，每条连接一条 JSON；
 * - 出站（编辑器 → TTS）：编辑器连接 TTS 端口 39999 发送，连 → 写 → 关。
 *
 * 注意：guid "-1" 表示 Global 脚本（见 {@link GLOBAL_GUID}）。
 */
import { z } from 'zod';

/** Global 脚本的 guid。TTS 协议中 "-1" 即全局脚本。 */
export const GLOBAL_GUID = '-1';

/** 入站消息 ID（TTS → 编辑器）。 */
export enum InboundId {
  /** 对象被推送过来（实测不含 ui 字段）。 */
  PushNewObject = 0,
  /** 游戏加载完成（scriptStates 含 ui）。 */
  GameLoaded = 1,
  /** Lua print 输出。 */
  Print = 2,
  /** Lua 运行时错误。 */
  Error = 3,
  /** Lua 侧广播的自定义消息。 */
  CustomMessage = 4,
  /** ExecuteLua 的返回值（坑 1：只可能是标量，复杂结构由 Lua 侧 JSON.encode 成字符串）。 */
  ReturnValue = 5,
  /** 游戏保存完成（savePath 实测携带，官方文档未写）。 */
  GameSaved = 6,
  /** 对象创建完成（返回 guid）。 */
  ObjectCreated = 7,
}

/** 出站消息 ID（编辑器 → TTS）。 */
export enum OutboundId {
  /** 请求 TTS 推送全部脚本状态。 */
  GetScripts = 0,
  /** 保存并播放（回写 scriptStates）。 */
  SaveAndPlay = 1,
  /** 向 Lua 广播自定义消息（customMessage 必须是 table / JSON 对象）。 */
  CustomMessage = 2,
  /** 在指定对象上执行 Lua 并按 returnID 回传返回值。 */
  ExecuteLua = 3,
}

/**
 * 单个脚本状态。
 *
 * ui 字段按可选处理：实测入站消息是否携带 ui 因消息类型而异，
 * 解析时丢弃 ui 会导致 SaveAndPlay 回写时 UI 丢失，因此绝不能把它当未知字段 strip 掉。
 */
export const scriptStateSchema = z.object({
  /** 脚本名称（如 "Global" 或对象名称）。 */
  name: z.string(),
  /** 对象 guid；"-1" 为 Global 脚本。 */
  guid: z.string(),
  /** Lua 脚本源码。 */
  script: z.string(),
  /** UI XML；可能缺省。 */
  ui: z.string().optional(),
});
/** 单个脚本状态。 */
export type ScriptState = z.infer<typeof scriptStateSchema>;

// ---------- 入站（TTS → 编辑器） ----------

export const pushNewObjectSchema = z.object({
  messageID: z.literal(InboundId.PushNewObject),
  scriptStates: z.array(scriptStateSchema),
});

export const gameLoadedSchema = z.object({
  messageID: z.literal(InboundId.GameLoaded),
  scriptStates: z.array(scriptStateSchema),
});

export const printSchema = z.object({
  messageID: z.literal(InboundId.Print),
  message: z.string(),
});

export const errorSchema = z.object({
  messageID: z.literal(InboundId.Error),
  error: z.string(),
  guid: z.string(),
  errorMessagePrefix: z.string(),
});

export const customMessageInboundSchema = z.object({
  messageID: z.literal(InboundId.CustomMessage),
  customMessage: z.unknown(),
});

export const returnValueSchema = z.object({
  messageID: z.literal(InboundId.ReturnValue),
  returnValue: z.unknown(),
  returnID: z.number(),
});

export const gameSavedSchema = z.object({
  messageID: z.literal(InboundId.GameSaved),
  savePath: z.string().optional(),
});

export const objectCreatedSchema = z.object({
  messageID: z.literal(InboundId.ObjectCreated),
  guid: z.string(),
});

/** 全部入站消息的判别联合 schema。 */
export const inboundSchema = z.discriminatedUnion('messageID', [
  pushNewObjectSchema,
  gameLoadedSchema,
  printSchema,
  errorSchema,
  customMessageInboundSchema,
  returnValueSchema,
  gameSavedSchema,
  objectCreatedSchema,
]);

/** 入站消息（判别联合，按 messageID 区分）。 */
export type InboundMessage = z.infer<typeof inboundSchema>;

/**
 * 校验并解析一条入站消息。
 *
 * @param raw 已 JSON.parse 的原始数据（unknown）
 * @returns 符合协议的入站消息；未知字段会被忽略
 * @throws {z.ZodError} 消息不符合协议（messageID 未知 / 字段类型不符等）时抛出
 */
export function parseInbound(raw: unknown): InboundMessage {
  return inboundSchema.parse(raw);
}

// ---------- 出站（编辑器 → TTS） ----------

export const getScriptsSchema = z.object({
  messageID: z.literal(OutboundId.GetScripts),
});

/**
 * 出站 scriptStates 元素：script / ui 均可缺省。
 * 官方文档语义：某对象若不提供 script 或 ui 字段，对应的 Lua 脚本 / UI XML 会被【删除】，
 * 因此出站方向允许缺省（由上层保证字段完整性），入站方向 script 实测总会携带、保持必填。
 */
export const outboundScriptStateSchema = z.object({
  name: z.string(),
  guid: z.string(),
  script: z.string().optional(),
  ui: z.string().optional(),
});
/** 出站 scriptStates 元素。 */
export type OutboundScriptState = z.infer<typeof outboundScriptStateSchema>;

export const saveAndPlaySchema = z.object({
  messageID: z.literal(OutboundId.SaveAndPlay),
  scriptStates: z.array(outboundScriptStateSchema),
});

/**
 * CustomMessage：customMessage 必须是 JSON 对象（对应 Lua 的 table）。
 * 与坑 1 相关：TTS 只认 table，发数组/标量会静默失败，因此 schema 明确限制为
 * 字符串键的 record（zod 4 的 record 会拒绝数组）。
 */
export const customMessageOutboundSchema = z.object({
  messageID: z.literal(OutboundId.CustomMessage),
  customMessage: z.record(z.string(), z.unknown()),
});

export const executeLuaSchema = z.object({
  messageID: z.literal(OutboundId.ExecuteLua),
  /** 目标对象 guid；"-1" 为 Global 脚本。 */
  guid: z.string(),
  /** 要执行的 Lua 代码。 */
  script: z.string(),
  /** 返回值回传 ID，用于匹配 ReturnValue 消息。 */
  returnID: z.number(),
});

/** 全部出站消息的判别联合 schema。 */
export const outboundSchema = z.discriminatedUnion('messageID', [
  getScriptsSchema,
  saveAndPlaySchema,
  customMessageOutboundSchema,
  executeLuaSchema,
]);

/** 出站消息（判别联合，按 messageID 区分）。 */
export type OutboundMessage = z.infer<typeof outboundSchema>;
