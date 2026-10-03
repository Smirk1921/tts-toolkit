// src/session/scripts.ts
import type { EditorServer } from "../protocol/editor-server.js";
import { InboundId, OutboundId, type InboundMessage } from "../protocol/messages.js";
import { sendToTts } from "../protocol/tts-client.js";

/** 存档内单个对象的脚本状态（对应协议 scriptStates 元素） */
export type ScriptState = {
  /** 对象名称（如 "Global" / "Chess Pawn"） */
  name: string;
  /** 对象 guid；"-1" 为全局脚本 */
  guid: string;
  /** Lua 脚本；⚠️ 缺省 = 该对象的脚本会被删除 */
  script?: string;
  /** UI XML；⚠️ 缺省 = 该对象的 UI 会被删除 */
  ui?: string;
};

/** messageID 1（GameLoaded）消息在本模块内的字段视图 */
interface GameLoadedView {
  messageID: typeof InboundId.GameLoaded;
  scriptStates: Array<{ name: string; guid: string; script?: string; ui?: string }>;
}

/** 判定消息是否为 GameLoaded（加载存档 / 各类请求的统一回推） */
function isGameLoadedView(m: InboundMessage): m is InboundMessage & GameLoadedView {
  return m.messageID === InboundId.GameLoaded;
}

/**
 * 会话层脚本快照封装（SessionScripts）。
 *
 * 对应 TTS 外部编辑器协议的两条脚本通路：
 * - 取脚本：出站 messageID 0 → TTS 回推 GameLoaded（入站 messageID 1，含 scriptStates）；
 * - Save & Play：出站 messageID 1（携带 scriptStates）→ TTS 重载存档后回推 GameLoaded。
 */
export class SessionScripts {
  /**
   * @param server 已启动的协议层编辑器服务（监听 39998，留存消息只增不删）
   */
  constructor(private readonly server: EditorServer) {}

  /**
   * 拉取当前存档内全部对象的脚本状态。
   *
   * 只接受发送请求之后新回推的 GameLoaded（发送前快照已留存的 GameLoaded 引用并排除），
   * 避免拿到旧存档 / 上次请求遗留的脚本快照。
   *
   * @param timeoutMs 等待 GameLoaded 回推的超时，默认 30000
   * @returns scriptStates 列表（每个元素含 name / guid / script / ui）
   * @throws Error 等待超时未收到 GameLoaded 回推
   */
  async getScripts(timeoutMs = 30_000): Promise<ScriptState[]> {
    const stale = new Set(this.server.find(isGameLoadedView));
    await sendToTts({ messageID: OutboundId.GetScripts });
    const msg = await this.server.waitFor(
      (m: InboundMessage): m is InboundMessage & GameLoadedView =>
        isGameLoadedView(m) && !stale.has(m),
      timeoutMs,
    );
    return msg.scriptStates.map((s) => ({ name: s.name, guid: s.guid, script: s.script, ui: s.ui }));
  }

  /**
   * 写入脚本 / UI 并重载存档（Save & Play，出站 messageID 1）。
   *
   * ⚠️ TTS 协议规定（官方文档原文）：scriptStates 中若某对象不提供 script 或 ui 字段，
   * 对应的 Lua 脚本 / UI XML 会被【删除】。
   * 因此调用方必须提供完整字段——只改脚本时也必须把未改动的 ui 原样带上，反之亦然。
   *
   * ⚠️ 设计约束 7：push 协议（messageID 1）只接收脚本 / UI 字段（scriptStates），
   * 不接收素材字段——素材改动须走存档 / 离线路径，不能靠本方法推送。
   *
   * @param states 完整的脚本状态列表（缺 script / ui 字段 = 删除对应内容）
   * @param timeoutMs 等待重载完成回推 GameLoaded 的超时，默认 60000
   * @throws Error 等待超时未收到 GameLoaded 回推
   */
  async saveAndPlay(states: ScriptState[], timeoutMs = 60_000): Promise<void> {
    const stale = new Set(this.server.find(isGameLoadedView));
    await sendToTts({ messageID: OutboundId.SaveAndPlay, scriptStates: states });
    await this.server.waitFor(
      (m: InboundMessage): m is InboundMessage & GameLoadedView =>
        isGameLoadedView(m) && !stale.has(m),
      timeoutMs,
    );
  }
}
