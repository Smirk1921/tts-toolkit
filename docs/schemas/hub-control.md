# hub 控制通道（S2）契约

> **本文档由窗口 D（阶段 4）产出，CLI / MCP 使用方与 hub 维护者必读。**
>
> 依据：`src/hub/control.ts`（控制通道服务实现，12 条 JSON 路由 + SSE）、`src/hub/lifecycle.ts`（进程编排与优雅退出）、`src/mcp/client.ts`（`HubClient` / `probeHub`）、`src/cli/_shared.ts`（CLI 委托判定）、`src/protocol/ports.ts`（端口常量）；`/v1/push` 的流水线语义依据 `src/pack/push.ts`（`pushSaveAndPlay`）与 `src/safety/baseline.ts`。路由表与 `方案设计.md` §14.5.1 S2、`施工流程.md` 阶段 4 的路由映射一致。
> 本文档描述**已实现的真实契约**，不是设想稿。发现的实现问题一律显式标注（§4.2 / §4.10 / §9 已知问题 #1），不隐去。
> **阶段 5（写入路径）修订（2026-10-05）**：已知问题 #1（hub 运行期 pull / diff 必 500）**已修复**——`pullFromGame` / `diffWorkspace` 增加 `server?: EditorServer` 注入，hub 路由传 `daemon.server` 复用已绑定的 39998（§4.2 / §4.10）；`POST /v1/push` 契约扩展为完整写入流水线（§4.11）。
> **阶段 7（测试运行器 + 发布链路）修订（2026-10-06）**：新增 `POST /v1/test/run`（§4.13）与 `POST /v1/pack/build`（§4.14）——JSON 路由 **12 → 14 条**；`HubClient` 补 `testRun` / `packBuild`（§6.1）；MCP 工具 10 → 12 个（新增 `tts_test_run` / `tts_pack_build`，§7）。

---

## 1. 概述

hub 控制通道是 `tts hub` 常驻进程暴露的**本机 HTTP+JSON 控制面**：基线 `http://127.0.0.1:39995/v1`，只监听回环地址。它解决的核心问题是——

- hub 运行期**独占编辑器入站端口 39998**（TTS 主动连入的唯一端点），CLI 的"临时绑 39998、用完即走"模式无法与 hub 共存；
- 于是 CLI 与 MCP 服务改为**经控制通道把请求委托给 hub**：hub 已持有与 TTS 的会话，代为执行拉取、执行 Lua、切片、导入、写回等操作（`方案设计.md` §14.5.1 S2；CLI 委托判定见 `src/cli/_shared.ts:1-21`）。

谁用它：

| 使用方 | 入口 | 说明 |
| --- | --- | --- |
| tts CLI | `src/cli/_shared.ts` 的 `tryHubClient()` | 先 `probeHub()`（800ms），在线则经 `HubClient` 委托；离线走独立模式（临时绑 39998） |
| MCP 服务 | `src/mcp/main.ts` → `src/mcp/server.ts`（`tts-mcp` bin，独立 stdio 进程，不经 `tts` 主 CLI） | 12 个工具全部经同一个 `HubClient` 访问 hub，自己不绑 39998（阶段 7 起为 12 个：含 `tts_test_run` / `tts_pack_build`） |
| 未来 GUI | 同一条 HTTP 控制面 | S2 按"将来给 GUI 用"的标准设计（`施工流程.md` 阶段 4） |

为什么是 HTTP+JSON：本机进程间请求/响应语义直接、任何语言可调、curl 可调试；实现零框架（`node:http`），不引入 HTTP 服务依赖。它与 hub 的**三路扇出**（39997 TCP / 39996 WS / 进程内事件总线，`src/hub/fanout.ts`）是两条不同通路：控制通道面向"命令"，扇出面向"事件"；只读事件订阅由控制通道内的一条 SSE 路由提供（§5），`HubClient` 不覆盖 SSE。

---

## 2. 传输与基线

| 项 | 约定 | 依据 |
| --- | --- | --- |
| 基线 URL | `http://127.0.0.1:39995/v1`（路由路径直接拼在 `/v1` 后） | `control.ts:77`、`client.ts:263-266` |
| 监听地址 | 只监听回环；缺省 `127.0.0.1`；空串 / `0.0.0.0` / `::` / `0:0:0:0:0:0:0:0` 在构造时直接抛错 | `control.ts:80-83`、`:225-231` |
| 端口 | 缺省 39995；`tts hub --port <n>` 可改；与 39998 / 39997 / 39996 相互独立 | `lifecycle.ts:27-28`、`cli/commands/hub.ts:93-100` |
| 请求体编码 | UTF-8 JSON 对象（顶层必须是键值对象，数组 / 标量 → 400） | `control.ts:726-737` |
| 响应编码 | `application/json; charset=utf-8` + `Content-Length` | `control.ts:278-292` |
| 请求媒体类型 | 读请求体的 POST 路由要求 `Content-Type: application/json`（允许 `; charset=...` 等参数，大小写不敏感）；否则 415。三个 GET 路由与 `/v1/hub/shutdown` **不读请求体**，不校验媒体类型 | `control.ts:213-218`、`:710-717`、`:1049-1057` |
| 路径匹配 | 精确匹配 pathname；查询串不参与路由（仅 `/v1/packs` 读取 `packsRoot` 参数） | `control.ts:630-665`、`:797-801` |
| 鉴权 | **无 token / 无鉴权**：唯一访问边界是本机回环。本机任意进程都可调用，切勿把控制通道暴露到局域网 | `control.ts` 全模块无鉴权代码路径；`:225-231` 的地址约束 |

---

## 3. 通用约定

### 3.1 请求体上限与请求侧错误

- 读请求体的 POST 路由：请求体上限 **1MB = 1 048 576 字节**，超限 → **413 `HUB_PAYLOAD_TOO_LARGE`**（超限后不再缓冲，`control.ts:86`、`:239-269`、`:722-725`）。
- 请求体不是合法 JSON、或顶层不是键值对象 → **400 `HUB_BAD_REQUEST`**。
- 必填字段缺失 / 类型不符 / 全空白字符串 / 非正有限数字 → **400 `HUB_BAD_REQUEST`**，message 形如 `missing or invalid field: root (non-empty string required)`（协议层英文短句）。
- 请求 URL 本身解析失败（防御路径）→ **400 `HUB_BAD_REQUEST`** `malformed request URL`（`control.ts:630-637`）。

### 3.2 错误响应格式

所有 4xx/5xx 统一：

```json
{ "error": { "code": "HUB_BAD_REQUEST", "message": "missing or invalid field: root (non-empty string required)" } }
```

- `code`：机器可读错误码（§3.3）。
- `message`：协议层英文短句；业务错误（`PackError` / `LuaError`）的 message 由底层模块经 `t()` 生成后**原样透传**（可能是中文）。消费方按 `code` 分支，不解析 message（`control.ts:47-50`）。
- `details`：可选；无细节时该字段不出现。

`control.ts` 自身的业务异常映射顺序（`respondError`，`control.ts:681-701`）：

| 抛出类型 | HTTP | code | details |
| --- | --- | --- | --- |
| `LuaError`（`src/session/exec.ts`） | 400 | `HUB_LUA_ERROR` | `{guid, line?, col?, endCol?}` |
| `PackError`（`src/pack/packyaml.ts`） | 400 | `HUB_PACK_ERROR` | `{packCode: "<底层业务码>"}` |
| 其余一切异常 | 500 | `HUB_INTERNAL_ERROR` | 无（message 为原始错误描述） |

### 3.3 错误 code 表

**服务端 code（出现在 HTTP 4xx/5xx 响应体中）：**

| code | HTTP | 触发 |
| --- | --- | --- |
| `HUB_BAD_REQUEST` | 400 | 请求体非法 JSON / 非对象、必填字段缺失或类型不符、URL 解析失败 |
| `HUB_NOT_FOUND` | 404 | 路径不在 12 条 JSON 路由中（SSE 路径另计，见 §5） |
| `HUB_METHOD_NOT_ALLOWED` | 405 | 路径存在但方法不对；响应带 `Allow: GET` / `Allow: POST` |
| `HUB_PAYLOAD_TOO_LARGE` | 413 | 请求体超过 1MB |
| `HUB_UNSUPPORTED_MEDIA_TYPE` | 415 | 读体 POST 路由的 `Content-Type` 不是 `application/json` |
| `HUB_CONFIRM_REQUIRED` | 400 | `POST /v1/push` 的 `confirm` 不严格等于 `true` |
| `HUB_PACK_ERROR` | 400 | 底层 `PackError` 透传；`details.packCode` 为业务码（`PACK_*` / `PULL_FAILED` / `SLICE_*` / `PLAN_*` / `IMPORT_*` / `REGISTRY_*` / `PUSH_FAILED` / `PUSH_ASSET_CHANGES_DETECTED` / `BASELINE_CONFLICT` / `PUSH_VERIFY_FAILED` / `BASELINE_*` / `BACKUP_*` 等） |
| `HUB_LUA_ERROR` | 400 | Lua 运行时错误透传 |
| `HUB_INTERNAL_ERROR` | 500 | 其余异常（含会话层超时 / 未连接 TTS 的普通 Error、端口占用 `PortInUseError`） |

**客户端 code（由 `HubClient` 分类产生，不来自 HTTP 响应体）：**

| code | 产生方 | 语义 |
| --- | --- | --- |
| `HUB_NOT_RUNNING` | MCP 工具层序列化（`src/mcp/tools/errors.ts:38-41`） | `HubNotRunningError`：连接拒绝 / 超时中止 / 响应体读取中断 → hub 没在跑或不可达；**没有 HTTP 状态码** |
| `HUB_UNKNOWN` | `HubClient`（`client.ts:228-241`、`:250-255`、`:324-329`） | HTTP 4xx/5xx 但响应体不符合标准错误形，或 2xx 响应体非法 JSON / 定型路由 shape 不符 |

`control.ts` 服务端**从不**产生 `HUB_NOT_RUNNING` / `HUB_UNKNOWN`。

### 3.4 响应体约定

- 成功响应一律 JSON 对象；`{ok:true}` 是多数操作型路由的通用成功形（`save-and-play` / `shutdown`）；`push` 的成功形是 `{ok:true, dryRun, pushed, skipped, items, ...}`（§4.11），`items = pushed + skipped` 为向后兼容别名。
- 请求处理期间客户端断开：服务器静默（无响应对象可写），不产生未处理异常（`control.ts:617-622`）。

---

## 4. 路由清单

### 4.0 总览

S2 控制面共 **12 条 JSON 路由**（下表）+ **1 条 SSE 事件流**（`GET /v1/events`，见 §5），共 13 个路径；阶段 7（窗口 G）追加 2 条 JSON 路由（§4.13 / §4.14，下表 13 / 14 行），**JSON 路由合计 14 条**。

| # | 方法 | 路径 | 作用 | 副作用 | 请求体 | 成功响应 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/v1/status` | hub 健康 + TTS 连接状态 | 无（只探测） | 无 | 状态对象 |
| 2 | POST | `/v1/scripts/pull` | 拉全部脚本 / UI 到工作区 | 写本地文件 | `{root}` | `PullResult` |
| 3 | POST | `/v1/scripts/save-and-play` | 回写 `scriptStates` 并重载存档 | 改游戏状态 | `{scriptStates}` | `{ok:true}` |
| 4 | POST | `/v1/exec` | 执行 Lua 返回 JSON | 可能改游戏状态 | `{lua, guid?, timeoutMs?}` | `{result}` |
| 5 | POST | `/v1/assets/check` | 素材 URL 存活检测 | 无 | `{urls, timeoutMs?}` | `CheckSummary` |
| 6 | GET | `/v1/packs` | 列出注册表图包 | 无 | 无（查询参数 `packsRoot`） | `Registry` |
| 7 | POST | `/v1/deck/slice` | 图集切片 | 写本地文件 | `SliceOptions` | `SliceResult` |
| 8 | POST | `/v1/deck/plan` | 替换计划 dry-run | 无 | `PlanOptions` | `PlanResult` |
| 9 | POST | `/v1/import` | 按 import.yaml 导入素材 | 写本地文件 | `{root, manifestPath, dryRun?}` | `ImportResult` |
| 10 | POST | `/v1/diff` | 本地 vs 游戏内差异 | 无 | `{root}` | `DiffResult` |
| 11 | POST | `/v1/push` | 写回并重载（必须 `confirm:true`） | 改游戏状态（可选自动备份） | `{root, confirm:true, dryRun?, forceScriptsOnly?, skipBackup?, skipBaselineCheck?, backupRetention?}` | `PushSaveResult` 摘要（§4.11） |
| 12 | POST | `/v1/hub/shutdown` | 优雅关闭 hub | 进程退出 | 不读 | `{ok:true}` |
| 13 | POST | `/v1/test/run` | 在 TTS 中跑 Lua 测试（阶段 7） | 可能改游戏状态（测试脚本在 TTS 内执行） | `{root, targetGuid?, timeoutMs?, bail?, bundle?, include?}` | `RunReport`（§4.13） |
| 14 | POST | `/v1/pack/build` | 工作区 → 存档 JSON → BSON 载荷（阶段 7） | 写本地文件（`dryRun` 时无） | `{root, outPath?, dryRun?}` | `BsonBuildResult` + 诊断字段（§4.14） |

所有 POST 路由通用的请求侧错误（400 / 404 / 405 / 413 / 415）见 §3；各小节只列该路由特有的错误。curl 示例假定 hub 在缺省端口 39995。

### 4.1 GET /v1/status

- 请求体：无。查询参数忽略。
- 响应 200（`control.ts:751-787`）：

```json
{
  "ok": true,
  "hub": { "editor": true, "tcpClients": 0, "wsClients": 1, "inprocClients": 2, "startedAt": 1759638000000, "uptimeMs": 123456 },
  "tts": { "connected": true, "version": "MoonSharp 3.0.0.0", "objects": 42 }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `hub.editor` | boolean | 编辑器入站通道（39998）是否就绪（daemon 已 start 且未 stop） |
| `hub.tcpClients` / `hub.wsClients` / `hub.inprocClients` | number | 当前三路扇出下游数 |
| `hub.startedAt` | number | hub 启动时刻（epoch 毫秒） |
| `hub.uptimeMs` | number | 已运行毫秒数，**响应时现算**（负值截为 0） |
| `tts.connected` | boolean | TTS 是否已连上 39998：经执行 Lua `return _VERSION` 探测（单次 2s 超时）成功即为 true |
| `tts.version` | string? | 版本探测成功且返回字符串时存在（实测 MoonSharp 版本串） |
| `tts.objects` | number? | 对象数探测（`return #getObjects()`，2s 超时）成功时存在；失败只影响该可选字段 |

- **TTS 未连接 / 探活失败不是路由错误**：仍 200、`connected:false`（S2 约定）。
- 可能的错误码：404 `HUB_NOT_FOUND`、405 `HUB_METHOD_NOT_ALLOWED`；500 `HUB_INTERNAL_ERROR` 仅为防御路径。
- curl：

```bash
curl -s http://127.0.0.1:39995/v1/status
```

### 4.2 POST /v1/scripts/pull

- 请求体（`control.ts:851-859`）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `root` | string | ✅ | 图包工作区根目录（非空字符串；hub 不校验绝对性，`pullFromGame` 按自身规则 resolve） |

- 行为：调用 `pullFromGame({root})`（`src/pack/pull.ts:315`）——读 `pack.yaml`、补齐目录布局、经编辑器会话取全部 `scriptStates`、逐对象落盘到 `scripts/` / `ui/`（缺字段即删除；无 state 的 guid 不动本地文件）。
- 响应 200 = `PullResult`：`{scriptsWritten: number, uiWritten: number, skippedNoChange: number}`（`src/pack/pull.ts:73-80`）。
- 可能的错误码：400 `HUB_PACK_ERROR`（`details.packCode` = `PACK_NOT_FOUND` / `PULL_FAILED`）、500 `HUB_INTERNAL_ERROR`（TTS 未连接 / 会话超时等普通 Error）。
- curl：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/scripts/pull \
  -H "Content-Type: application/json" \
  -d '{"root":"D:/packs/第七大陆"}'
```

> ✅ **阶段 4 已知问题 #1（hub 运行期本路由必 500）— 已修复（阶段 5）**
> - **原症状**：hub 运行期调用本路由返回 **500 `HUB_INTERNAL_ERROR`**（message 为 `PortInUseError` 的端口占用描述）。
> - **根因**：`handlePull` 直接调 `pullFromGame`，而后者内部经 `withEditorServer` **新建 EditorServer 并独占绑定 39998**，与 hub daemon 已持有的 39998 冲突 → 第二次 `start()` 抛 `PortInUseError`（非 `PackError`/`LuaError` → 500）。
> - **修复**：`PullOptions` 增加可选 `server?: EditorServer`（`src/pack/pull.ts:93-99`）；传入时用 `new SessionScripts(opts.server)` 复用该服务器、**不再** `withEditorServer` 独占端口（`src/pack/pull.ts:367-369`）。`handlePull` 传 `daemon.server`（`src/hub/control.ts:887`）。`/v1/diff` 同款修复，见 §4.10。
> - **现状**：hub 运行期本路由正常返回 `PullResult`；独立模式（CLI 无 hub 时，不传 `server`）行为不变，仍临时独占 39998。
> - 单元口径：注入路径由 `tests/unit/pack-pull-baseline.test.ts:430`（`pullFromGame({root, server: fakeEditorServer(states)})`，不经过 `withEditorServer`）覆盖；hub 路由侧对 `/v1/diff` 只覆盖到 `PACK_NOT_FOUND` 透传（`tests/unit/hub-control.test.ts:249-256`），**没有**直接断言 `/v1/scripts/pull` / `/v1/diff` 收到 `daemon.server` 的用例。

### 4.3 POST /v1/scripts/save-and-play

- 请求体（`control.ts:866-879`）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `scriptStates` | `{name: string, guid: string, script?: string, ui?: string}[]` | ✅ | 元素逐项校验；额外字段**丢弃**后只转发 `name` / `guid` / `script` / `ui`；空数组合法 |

- ⚠️ 协议语义：某对象**缺 `script` / `ui` 字段时，TTS 会删除对应内容**（`src/session/scripts.ts:7-15` 的警告）——调用方必须提供完整状态。
- 响应 200：`{ok: true}`。
- 可能的错误码：400 `HUB_BAD_REQUEST`（`scriptStates` 缺失 / 元素结构不符）；500 `HUB_INTERNAL_ERROR`（TTS 未连接、等待重载回推超时等）。
- curl：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/scripts/save-and-play \
  -H "Content-Type: application/json" \
  -d '{"scriptStates":[{"name":"Global","guid":"-1","script":"print(1)"}]}'
```

### 4.4 POST /v1/exec

- 请求体（`control.ts:886-906`）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `lua` | string | ✅ | Lua 源码（单条语句或返回值表达式，语义同 `SessionExec.execJson`） |
| `guid` | string | 可省略 | 目标对象 GUID（非空字符串）；缺省为 `"-1"`（全局脚本） |
| `timeoutMs` | number | 可省略 | 正有限数字；执行超时 |

- 响应 200：`{result: <JSON-Lua 返回值>}`（响应形固定为 `{result:...}` 包装，`control.ts:904-905`）。
- 可能的错误码：400 `HUB_BAD_REQUEST`；400 `HUB_LUA_ERROR`（`details` 携带 `guid`，可选 `line` / `col` / `endCol`）；500 `HUB_INTERNAL_ERROR`（TTS 未连接 / 超时）。
- curl：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/exec \
  -H "Content-Type: application/json" \
  -d '{"lua":"return #getObjects()"}'
```

### 4.5 POST /v1/assets/check

- 请求体（`control.ts:913-927`）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `urls` | string[] | ✅ | 非空字符串数组（空数组 / 元素非字符串 → 400） |
| `timeoutMs` | number | 可省略 | 正有限数字；单 URL 检测超时（底层还要求整数，见错误码） |

- 响应 200 = `CheckSummary`（`src/assets/check.ts:97-103`）：

```json
{
  "total": 2, "alive": 1, "dead": 1,
  "deadUrls": [{ "url": "https://example.com/b.png", "alive": false, "status": 0, "error": "连接被拒绝" }],
  "results": [{ "url": "https://example.com/a.png", "alive": true, "status": 200 },
              { "url": "https://example.com/b.png", "alive": false, "status": 0, "error": "连接被拒绝" }]
}
```

- 说明：`alive` = 拿到响应且状态码 ∈ [200, 300)；`error` **仅在完全没拿到 HTTP 响应**（超时 / 网络错误）时出现，4xx/5xx 只体现在 `status`（`src/assets/check.ts:280-298`）。
- 可能的错误码：400 `HUB_BAD_REQUEST`；500 `HUB_INTERNAL_ERROR`（底层 zod 对 `timeoutMs` 有更严约束——非整数等会在 `checkUrls` 内抛普通 Error）。
- curl：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/assets/check \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com/a.png"],"timeoutMs":5000}'
```

### 4.6 GET /v1/packs

- 查询参数：`packsRoot`（可选；缺省 / 空串 → hub 进程的 `process.cwd()`）。路由不读请求体。
- 行为：`readRegistry(packsRoot)` 读 `<packsRoot>/.registry.yaml`（`src/pack/registry.ts:560`）。
- 响应 200 = `Registry`：`{schema_version: 1, packs: PackEntry[]}`；`PackEntry` 含 `dir / name / kind / upstream / branch / host / modified / stats / lfs_status`（`src/pack/registry.ts:113-140`）。
- **`.registry.yaml` 不存在 → 200 空表** `{schema_version:1, packs:[]}`（容错，不视为错误）。
- 可能的错误码：400 `HUB_PACK_ERROR`（`REGISTRY_INVALID` 内容不合 schema；`REGISTRY_READ_FAILED` ENOENT 以外的 IO 错误）；404 / 405；500 防御路径。
- curl：

```bash
curl -s "http://127.0.0.1:39995/v1/packs?packsRoot=D:/packs"
```

### 4.7 POST /v1/deck/slice

- 请求体**就是 `SliceOptions` 本身**（`control.ts:934-947`；不做 root+deck → 路径推导，路径由调用方给绝对路径，与 CLI 的 `--sheet/--save/-o` 同构）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `sheetPath` | string | ✅ | 图集图片绝对路径 |
| `savePath` | string | ✅ | 存档 JSON 绝对路径 |
| `outDir` | string | ✅ | 输出目录（deckDir） |
| `deckKey` | string | 可省略 | 显式指定 CustomDeck key（消歧用） |
| `deckGuid` | string | 可省略 | 显式指定 deck GUID（消歧用） |

- `selectCandidate` 是 CLI 交互用的函数字段，**控制通道不注入也不会调用**：多候选时必须先用 `deckKey` / `deckGuid` 消歧，否则 `sliceAtlas` 抛 `SLICE_AMBIGUOUS`（`control.ts:38-41`）。
- 响应 200 = `SliceResult`：`{cardsSliced, deck: DeckCandidate, sharedWith: string[], cardsCsvPath, cardFiles: string[], backFiles: string[]}`（`src/deck/slice.ts:194-207`）。
- 可能的错误码：400 `HUB_BAD_REQUEST`（三个必填路径缺一）；400 `HUB_PACK_ERROR`，`details.packCode` ∈ `SLICE_SHEET_NOT_FOUND` / `SLICE_SAVE_INVALID` / `SLICE_ORPHAN_ATLAS` / `SLICE_AMBIGUOUS` / `SLICE_DECK_NOT_FOUND` / `SLICE_GRID_MISMATCH` / `SLICE_IMAGE_INVALID`（`src/deck/slice.ts:89-96`）。
- curl：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/deck/slice \
  -H "Content-Type: application/json" \
  -d '{"sheetPath":"D:/packs/第七大陆/decks/冒险/atlas.png","savePath":"D:/TTS/Saves/xxx.json","outDir":"D:/packs/第七大陆/decks/冒险","deckKey":"3"}'
```

### 4.8 POST /v1/deck/plan

- 请求体**就是 `PlanOptions` 本身**（`control.ts:955-968`）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `savePath` | string \| object | ✅ | 存档 JSON 路径；也接受**已解析的键值对象**（直接遍历，不落盘） |
| `rules` | `ReplaceRule[]` | ✅ | `{from: string, to: string, mode?: "exact" \| "regex" \| "prefix"}`（缺省 exact）；规则元素由 `planReplace` 深度校验 |

- 响应 200 = `PlanResult`：`{entries: PlanEntry[], stats: Record<string, number>, totalAffected: number}`（`src/deck/plan.ts:120-127`）；dry-run，不写文件。
- 可能的错误码：400 `HUB_BAD_REQUEST`（`savePath` / `rules` 结构不符）；400 `HUB_PACK_ERROR`（`PLAN_RULE_INVALID` / `PLAN_SAVE_INVALID`）。
- curl：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/deck/plan \
  -H "Content-Type: application/json" \
  -d '{"savePath":"D:/TTS/Saves/xxx.json","rules":[{"from":"https://old.example.com/a.png","to":"https://new.example.com/a.png"}]}'
```

### 4.9 POST /v1/import

- 请求体（`control.ts:975-991`）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `root` | string | ✅ | 图包工作区根目录 |
| `manifestPath` | string | ✅ | `import.yaml` 清单路径 |
| `dryRun` | boolean | 可省略 | true 只盘点不落盘；非 boolean → 400 |

- 行为：`importAssets({root, manifestPath, dryRun})`（`src/pack/import.ts`；清单契约见 `docs/schemas/import.yaml.md`）。
- 响应 200 = `ImportResult`（结构见 `import.yaml.md` §6.4：`dryRun / root / manifestPath / decks[] / objects[] / objectsCsvPath / warnings[]`）。
- 可能的错误码：400 `HUB_BAD_REQUEST`；400 `HUB_PACK_ERROR`，`details.packCode` 为 `IMPORT_*`（`IMPORT_INVALID` / `IMPORT_FILE_MISSING` / `IMPORT_CMYK` / `IMPORT_GRID_OVERFLOW` / `IMPORT_EMPTY` / `IMPORT_READ_FAILED` / `IMPORT_WRITE_FAILED`）。
- curl：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/import \
  -H "Content-Type: application/json" \
  -d '{"root":"D:/packs/第七大陆","manifestPath":"D:/packs/第七大陆/import.yaml","dryRun":true}'
```

### 4.10 POST /v1/diff

- 请求体：`{root: string}`（非空；`control.ts:998-1006`）。
- 行为：`diffWorkspace({root})`——读本地 `scripts/` / `ui/` 与游戏侧快照比对（线上回路，需 TTS）。
- 响应 200 = `DiffResult`：`{entries: DiffEntry[], added, modified, deleted}`；`DiffEntry = {guid, name, kind: "script"|"ui", status: "added"|"modified"|"deleted", localPath?}`（`src/pack/diff.ts:87-113`）。方向以**游戏侧相对本地**为准：`added` = 游戏有本地无。
- 可能的错误码：400 `HUB_BAD_REQUEST`；400 `HUB_PACK_ERROR`（`PACK_NOT_FOUND` / `PACK_INVALID` / `PACK_READ_FAILED`）；500 `HUB_INTERNAL_ERROR`（TTS 未连接 / 会话超时等）。
- curl：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/diff \
  -H "Content-Type: application/json" \
  -d '{"root":"D:/packs/第七大陆"}'
```

> ✅ **阶段 4 已知问题 #1（hub 运行期本路由必 500）— 已修复（阶段 5）**
> - **原症状**：hub 运行期调用本路由返回 **500 `HUB_INTERNAL_ERROR`**（`PortInUseError`）。
> - **根因**：`handleDiff` 直接调 `diffWorkspace`，后者内部经 `withEditorServer` 重新独占绑定 39998，与 hub daemon 已持有的 39998 冲突（同 §4.2）。
> - **修复**：`DiffOptions` 增加可选 `server?: EditorServer`（`src/pack/diff.ts:161-167`）；传入时用 `new SessionScripts(opts.server).getScripts(...)` 复用该服务器，**不再** `withEditorServer`（`src/pack/diff.ts:799-801`）。`handleDiff` 传 `daemon.server`（`src/hub/control.ts:1036`）。
> - **现状**：hub 运行期本路由正常返回 `DiffResult`；独立模式行为不变。
> - **测试现状**：`diffWorkspace` 的 `server` 注入分支当前无专门单测（`tests/unit/pack-diff.test.ts` / `pack-diff-unified.test.ts` 走 `with-server` 打桩）；`tests/unit/hub-control.test.ts:249-256` 只覆盖 `/v1/diff` 的 `PACK_NOT_FOUND` 透传。属已知测试缺口，不影响契约。

### 4.11 POST /v1/push

阶段 5「写入路径」的实接通路由：整条流水线委托 `src/pack/push.ts` 的 `pushSaveAndPlay`，本路由只做**字段校验 + 坑 17 注入 + 响应整形**（`handlePush`，`src/hub/control.ts:1070-1107`）。

- 请求体：

| 字段 | 类型 | 必填 | 缺省 | 说明 |
| --- | --- | --- | --- | --- |
| `root` | string | ✅ | 无 | 图包工作区根目录（非空字符串；缺失 / 空白 → 400 `HUB_BAD_REQUEST`） |
| `confirm` | 字面量 `true` | ✅ | 无 | **不严格等于 `true` → 400 `HUB_CONFIRM_REQUIRED`**（`false` / 缺失 / `"true"` 都拒绝）。注意：`root` 校验在 `confirm` 之前，两者都缺时先报 `HUB_BAD_REQUEST` |
| `dryRun` | boolean | 可省略 | `false` | 试运行：只做检测与过滤、返回"将推送什么"，不备份 / 不发送 / 不写基线。**与 `pushSaveAndPlay` 自身的缺省 `true` 不同**——HTTP 层的 `confirm:true` 已表达实写意图 |
| `forceScriptsOnly` | boolean | 可省略 | `false` | 素材有改动时仍强制只推脚本（用户自担风险；检测结果记入 `assetChanges` 而不报错） |
| `skipBackup` | boolean | 可省略 | `false` | 跳过 push 前自动备份（不推荐） |
| `skipBaselineCheck` | boolean | 可省略 | `false` | 跳过基线冲突检测（冲突记入 `baselineConflicts` 而不报错） |
| `backupRetention` | number | 可省略 | `20` | 备份保留份数；路由只校验**正有限数字**（`optionalPositiveNumber`），不校验整数与上限 100（非整数会被底层 `pruneBackups` 的 `slice` 截断） |

- 字段类型不符 → 400 `HUB_BAD_REQUEST`，message 形如 `invalid field: dryRun (boolean required)` / `invalid field: backupRetention (positive finite number required)`（`control.ts:1080-1084`）。
- 行为（`pushSaveAndPlay`，`src/pack/push.ts:60-126`）：读 `pack.yaml` → 收集本地 `scripts/` + `ui/` 清单（空清单直接返回）→ 拉游戏侧快照 → **素材改动检测**（`readBaseline` + `detectAssetChanges`）→ **基线冲突检测**（`diffBaseline`）→ 过滤无变化对象 → **强制补齐 script / ui**（缺字段 = TTS 删除）→ dryRun 则返回 → 备份 → `saveAndPlay` → **回读校验**（不一致 → `PUSH_VERIFY_FAILED`，基线不更新）→ 更新 `.tts/baseline.json`（`writeBaseline` + `touchLastPushAt`，契约见 `docs/schemas/baseline.json.md`）。
- **坑 17**：路由注入 `server: this.daemon.server` 复用 hub 已绑定的编辑器端口 39998，**绝不**二次 `withEditorServer`（`control.ts:1087`；单测 `tests/unit/hub-control-push.test.ts:239-244` 断言是同一对象）。
- **不注入确认函数**：`pushSaveAndPlay` 的 `confirm` 回调（CLI 交互确认门）不传——hub 场景由本路由的 `confirm:true` 一门拦截。
- 响应 200：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | 字面量 `true` | 固定 |
| `dryRun` | boolean | 与请求一致 |
| `pushed` | number | 实际写入（dryRun 下为"将写入"）的对象数 |
| `skipped` | number | 无变化（含防御性跳过）而未发送的对象数 |
| `items` | number | **向后兼容别名**：`pushed + skipped`（旧客户端的 `items` 计数） |
| `backupDir` | string? | 备份目录完整路径；仅**实写且未 `skipBackup`** 时携带 |
| `baselineConflicts` | `BaselineConflict[]`? | 仅检测到冲突且被 `skipBaselineCheck` 放行时携带（否则已 400 中断） |
| `assetChanges` | `AssetChanges`? | 仅检测到素材改动且被 `forceScriptsOnly` 放行时携带（否则已 400 中断） |

- `note` 字段（`PushSaveResult.note`，中文摘要）**不透出**到 HTTP 响应。
- 可能的错误码：

| HTTP | code | 触发 |
| --- | --- | --- |
| 400 | `HUB_BAD_REQUEST` | `root` 缺失 / 空白；5 个可选字段类型不符 |
| 400 | `HUB_CONFIRM_REQUIRED` | `confirm !== true`（`root` 校验通过之后才检查） |
| 400 | `HUB_PACK_ERROR` | 底层 `PackError` 透传，`details.packCode` ∈ `PACK_NOT_FOUND` / `PACK_INVALID` / `PACK_READ_FAILED`（pack.yaml）、`PUSH_ASSET_CHANGES_DETECTED`（素材有改动且未 `forceScriptsOnly`）、`BASELINE_CONFLICT`（游戏侧相对基线被改且未 `skipBaselineCheck`）、`PUSH_FAILED`（本地脚本 / UI 读取失败）、`PUSH_VERIFY_FAILED`（回读不一致）、`BASELINE_READ_FAILED` / `BASELINE_ASSET_SCAN_FAILED` / `BASELINE_WRITE_FAILED`（基线）、`BACKUP_WRITE_FAILED` / `BACKUP_PRUNE_FAILED` / `BACKUP_DIR_INVALID`（备份） |
| 500 | `HUB_INTERNAL_ERROR` | 端口占用（本路由注入 `server`、不会二次绑定 39998）/ TTS 未连接 / 等待重载超时等普通 Error |

> `PUSH_ABORTED`（确认门返回 false）经本路由**不可达**：路由不注入 `confirm` 回调（`control.ts:1093`）。

- curl（实写；`--yes` 语义）：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/push \
  -H "Content-Type: application/json" \
  -d '{"root":"D:/packs/第七大陆","confirm":true,"backupRetention":20}'
```

- curl（试运行：检测素材改动 / 基线冲突并报告，不写任何东西）：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/push \
  -H "Content-Type: application/json" \
  -d '{"root":"D:/packs/第七大陆","confirm":true,"dryRun":true}'
```

### 4.12 POST /v1/hub/shutdown

- 请求体：**不读取**（无 Content-Type 要求）。
- 行为：先回 200 `{ok:true}`，响应出站后再触发 `onShutdown` 回调（lifecycle 传入 `HubProcess.stop`）：先停控制通道（拒新连接）→ 再停 daemon（编辑器端口 + TCP/WS 扇出）→ 关日志。停止幂等（SIGINT / SIGTERM / 本路由共享同一次停止流程）；回调失败只记日志（`control.ts:1044-1057`、`lifecycle.ts:202-254`）。
- 可能的错误码：404 / 405；500 仅防御路径。
- curl：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/hub/shutdown
```

### 4.13 POST /v1/test/run

阶段 7（窗口 G）新增：在 TTS 中跑图包工作区的 Lua 测试并返回 `RunReport`（`handleTestRun`，`src/hub/control.ts:1193-1226`）。落地顺序：`discoverTests`（`src/test/discover.ts`）→ 把 `targetGuid` / `timeoutMs` 覆盖到每个发现条目 → `TestRunner.run`（`src/test/runner.ts`）。

- 请求体：

| 字段 | 类型 | 必填 | 缺省 | 说明 |
| --- | --- | --- | --- | --- |
| `root` | string | ✅ | 无 | 图包工作区根目录（非空字符串；缺失 / 空白 → 400 `HUB_BAD_REQUEST`；hub 侧 `path.resolve`） |
| `targetGuid` | string | 可省略 | `pack.yaml` 的 `tests.target_guid`，再缺省 `"-1"`（Global） | **逐文件条目的覆盖值**：给了就覆盖所有发现条目；非空字符串，类型不符 → 400 `HUB_BAD_REQUEST` |
| `timeoutMs` | number | 可省略 | `pack.yaml` 的 `tests.timeout`，再缺省 `30000` | 单文件执行超时（正有限数字；非正数 / 非数字 → 400）；同为逐文件覆盖值 |
| `bail` | boolean | 可省略 | `false` | 首个失败即停；粒度是**文件**（同一文件内的用例由 Lua 侧一次性跑完，无法中途停） |
| `bundle` | boolean | 可省略 | `true` | 是否 luabundle 打包；`false` 时逐文件直跑（直跑模式没有模块解析能力，`require` 只对断言库 `tts.assert` 有效） |
| `include` | string[] | 可省略 | `pack.yaml` 的 `tests.include`，再缺省 `["tests/**/*.test.lua"]` | 测试文件 glob（相对 `root`，元素必须是字符串）；CLI 把位置参数 `tts test <path>` 委托给 hub 时用；`[]` 表示"匹配空集"。**本字段是任务书 5 字段之外附加的可选项**（不加也能用缺省发现配置） |

- 行为：
  - **发现不到测试文件不是错误**：返回 `total=0` 的空报告（200），退出码由调用方（CLI）决定；
  - **坑 17**：`new TestRunner(this.daemon.server)` 且 `RunOptions.server` 也注入 `daemon.server`（`control.ts:1217-1222`），复用 hub 已绑定的编辑器端口 39998——本路由绝不二次 `withEditorServer`；
  - **断言失败 / 用例错误不是路由错误**：它们记在报告的 `failed` / `errored` 与 `results[].status` 里，路由照样 200；只有"无法完成一轮运行"的异常（打包失败、文件不可读、结果格式非法等 `PackError`）才 400；
  - 发现阶段的 `TEST_DISCOVER_*`（pack.yaml 读不动 / tests 段不合约定 / 目录不可读）**只告警不上抛**（`discoverTests` 零异常设计，警告走 stderr），因此不会变成 4xx。
- 响应 200 = `RunReport`（`src/test/types.ts`；结构化 JSON 英文键名，**不走 t()**）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `runId` | string | 运行 ID（时间戳 36 进制 + 8 位随机后缀） |
| `root` | string | resolve 后的工作区根 |
| `startedAt` / `endedAt` | string | ISO 8601 起止时刻 |
| `durationMs` | number | 总耗时 |
| `total` / `passed` / `failed` / `errored` | number | 统计（`errored` 是运行时错误，与断言失败 `failed` 分开计） |
| `bailed` | boolean | 是否因 `bail` 提前终止 |
| `results` | `TestResult[]` | `{case:{name,sourceFile,sourceLine}, status:"passed"\|"failed"\|"error", failureReason?, asserts:[{kind,passed,message?,sourceFile?,sourceLine?}], durationMs, prints:string[]}` |

- 可能的错误码：

| HTTP | code | 触发 |
| --- | --- | --- |
| 400 | `HUB_BAD_REQUEST` | `root` 缺失 / 空白；`targetGuid` 非非空字符串；`timeoutMs` 非正数；`bail` / `bundle` 非布尔；`include` 非字符串数组 |
| 400 | `HUB_PACK_ERROR` | 业务 `PackError` 透传，`details.packCode` ∈ `TEST_RUN_BUNDLE_FAILED`（某测试文件打包失败）/ `TEST_RUN_FILE_UNREADABLE`（直跑模式读文件失败）/ `TEST_RUN_FILE_TIMEOUT`（单文件执行超时）/ `TEST_RUN_EXEC_FAILED`（其他执行期错误）/ `TEST_RUN_RESULTS_MALFORMED`（拿回的结果不是合法 JSON）|
| 405 | `HUB_METHOD_NOT_ALLOWED` | GET 本路由（响应带 `Allow: POST`）；404 路径拼错 |
| 500 | `HUB_INTERNAL_ERROR` | TTS 未连接 / 会话超时 / 编辑器端口异常等普通 Error |

- curl（默认发现配置 + 首个失败即停）：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/test/run \
  -H "Content-Type: application/json" \
  -d '{"root":"D:/packs/第七大陆","bail":true}'
```

- curl（只跑一个子目录的测试，覆盖 targetGuid 与单文件超时）：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/test/run \
  -H "Content-Type: application/json" \
  -d '{"root":"D:/packs/第七大陆","include":["tests/deck/**/*.test.lua"],"targetGuid":"-1","timeoutMs":60000}'
```

### 4.14 POST /v1/pack/build

阶段 7（窗口 G）新增：图包工作区 → TTS 存档 JSON → 工坊上传用 BSON 载荷（`handlePackBuild`，`src/hub/control.ts:1253-1290`）。**纯本地文件流水线，不依赖 daemon.server**（不碰 39998 / 39999）；上控制通道只是为 MCP / 其他调用方提供统一入口（对比 §7 的边界表：上传本身仍只在 CLI / 手动流程里发生）。

- 请求体：

| 字段 | 类型 | 必填 | 缺省 | 说明 |
| --- | --- | --- | --- | --- |
| `root` | string | ✅ | 无 | 图包工作区根目录（非空字符串） |
| `outPath` | string | 可省略 | 与中间 JSON 同目录同名、扩展名换成 `.bson`（即 `<root>/dist/<净化(pack.yaml name)>.bson`） | **输出 BSON 载荷路径**（非空字符串）；中间存档 JSON 一律走 `buildSave` 自己的缺省命名 |
| `dryRun` | boolean | 可省略 | `false` | 只统计与生成摘要，不写 JSON / BSON 文件 |

- 行为：
  - `dryRun !== true`：`buildSave`（`src/pack/build.ts`：工作区 → 存档 JSON，缺省 `<root>/dist/<净化(pack.yaml name)>.json`，pack.yaml 缺失时回退骨架 `SaveName`）→ `buildBson`（`src/publish/bson.ts`：JSON → BSON，内部自检"前 4 字节小端整数 == 文件大小"，自检失败抛 `PUBLISH_BSON_INVALID`）；
  - `dryRun === true`：只跑 `buildSave({dryRun: true})`（不写 JSON、不建 `dist/`），**不跑** `buildBson`（没有产物可转换）；响应的 `byteLength` / `headerLength` 恒为 `0`——不做虚报；
  - 红线：本路由只产出本地文件，**绝不自动打开游戏 / Steam、不发起任何上传**（上传入口是 `tts publish`，见 §7 / `src/publish/kpsteam.ts`）。
- 响应 200：`BsonBuildResult` 三字段 + 诊断字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `outPath` | string | 输出 BSON 绝对路径（`dryRun` 下是"将写入"的路径） |
| `byteLength` | number | BSON 总字节数（`dryRun` 下恒 0） |
| `headerLength` | number | 头部 4 字节小端值（实写时恒等于 `byteLength`，自检保证；`dryRun` 下恒 0） |
| `dryRun` | boolean | 与请求一致 |
| `jsonPath` | string | 中间存档 JSON 绝对路径（`buildSave` 的 `outPath`） |
| `warnings` | string[] | `buildSave` 的不中断告警（中文、经 t()；如孤儿脚本 / UI / 对象目录、data.json 不可读），不改变 HTTP 状态 |
| `scriptsReplaced` / `uiReplaced` / `objectsReplaced` / `decksPatched` | number | `buildSave` 的四个计数（口径见 `src/pack/build.ts` 模块头注释） |

- 可能的错误码：

| HTTP | code | 触发 |
| --- | --- | --- |
| 400 | `HUB_BAD_REQUEST` | `root` 缺失 / 空白；`outPath` 非非空字符串；`dryRun` 非布尔 |
| 400 | `HUB_PACK_ERROR` | 业务 `PackError` 透传，`details.packCode` ∈ `SKELETON_MISSING`（未 unpack）/ `SKELETON_INVALID` / `GUID_MISMATCH` / `BUILD_FAILED` / `PUBLISH_JSON_NOT_FOUND` / `PUBLISH_JSON_INVALID` / `PUBLISH_BSON_INVALID` / `PUBLISH_OUTPUT_EXISTS` |
| 405 | `HUB_METHOD_NOT_ALLOWED` | GET 本路由（响应带 `Allow: POST`）；404 路径拼错 |
| 500 | `HUB_INTERNAL_ERROR` | 磁盘写入失败等普通 Error |

- curl（实写：生成 JSON 与 BSON，BSON 路径由 pack.yaml 的 name 推导）：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/pack/build \
  -H "Content-Type: application/json" \
  -d '{"root":"D:/packs/第七大陆"}'
```

- curl（试运行：只统计，不写文件；指定输出路径）：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/pack/build \
  -H "Content-Type: application/json" \
  -d '{"root":"D:/packs/第七大陆","outPath":"D:/packs/第七大陆/dist/pack.bson","dryRun":true}'
```

---

## 5. SSE 事件流

`GET /v1/events` 是控制通道内唯一的**只读事件订阅**（`control.ts:804-842`）。

- 响应头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache`、`Connection: keep-alive`。
- 连接建立后立即收到一帧注释：`:connected\n\n`（不是数据帧）。
- 之后每收到一条**入站 TTS 消息**且 `messageID` 在转发集合内时写一帧：

```
data: {"messageID":2,"message":"hello"}\n\n
```

- 转发集合（`SSE_FORWARDED_MESSAGE_IDS`，`control.ts:99-106`；`src/protocol/messages.ts:17-34`）：

| messageID | 名称 | data 载荷字段（zod 解析后） |
| --- | --- | --- |
| 1 | GameLoaded | `scriptStates: {name, guid, script, ui?}[]` |
| 2 | Print | `message: string` |
| 3 | Error | `error / guid / errorMessagePrefix: string` |
| 4 | CustomMessage | `customMessage: unknown` |
| 6 | GameSaved | `savePath?: string` |
| 7 | ObjectCreated | `guid: string` |

- **不转发**：`messageID 0`（PushNewObject，内部推送）与 `messageID 5`（ReturnValue，exec 往返的协议噪声）。
- data 是消息对象原样 JSON（`JSON.stringify`）；无 `id:` / `event:` / `retry:` 字段、无心跳、无历史回放、不处理 `Last-Event-ID`——**只收到订阅之后产生的事件**。
- 客户端断开（响应 `close`）即退订；hub 停止时对 SSE 长连接最多等 1s 宽限期后强关（`control.ts:91-92`、`:572-601`）。
- curl（`-N` 关闭缓冲）：

```bash
curl -N http://127.0.0.1:39995/v1/events
```

> 需要可重放的脚本快照 / 对象事件时，下游也可连 39997 TCP / 39996 WS 扇出（§8）；SSE 与三路扇出收到的是同一批入站消息。

---

## 6. 客户端实现要点

控制通道的官方客户端是 `src/mcp/client.ts` 的 `HubClient`（CLI 与 MCP 工具层共用；`HubClient` **不覆盖** SSE）。

### 6.1 HubClient 方法 ↔ 路由

| 方法 | 路由 | 返回类型 |
| --- | --- | --- |
| `status()` | GET `/v1/status` | `HubStatusResult`（定型校验） |
| `pullScripts(root)` | POST `/v1/scripts/pull` | `unknown`（原样透传） |
| `saveAndPlay(scriptStates)` | POST `/v1/scripts/save-and-play` | `HubOkResult` `{ok:true}` |
| `exec(lua, {guid?, timeoutMs?})` | POST `/v1/exec` | `unknown`（`{result:...}` 包装） |
| `assetsCheck(urls, timeoutMs?)` | POST `/v1/assets/check` | `unknown`（`CheckSummary`） |
| `listPacks(packsRoot?)` | GET `/v1/packs` | `unknown`（注册表 JSON） |
| `deckSlice(opts)` | POST `/v1/deck/slice` | `unknown`（`SliceResult`） |
| `deckPlan(opts)` | POST `/v1/deck/plan` | `unknown`（`PlanResult`） |
| `importAssets(root, manifestPath, dryRun?)` | POST `/v1/import` | `unknown` |
| `diff(root)` | POST `/v1/diff` | `unknown` |
| `push(root, confirm: true, opts?)` | POST `/v1/push` | `HubPushResult` `{ok:true, dryRun, pushed, skipped, items, backupDir?, baselineConflicts?, assetChanges?}` |
| `shutdown()` | POST `/v1/hub/shutdown` | `HubOkResult` `{ok:true}` |
| `testRun({root, targetGuid?, timeoutMs?, bail?, bundle?})` | POST `/v1/test/run` | `unknown`（`RunReport`，§4.13） |
| `packBuild({root, outPath?, dryRun?})` | POST `/v1/pack/build` | `unknown`（`BsonBuildResult` + 诊断字段，§4.14） |

- 缺省选项（`HubClientOptions`，`client.ts:49-76`）：`host=127.0.0.1`、`port=39995`、单请求 `timeoutMs=30000`（覆盖"发起请求 + 读取响应体"全程）；host 为 IPv6 字面量时自动加 `[]`。
- 请求体由 `JSON.stringify` 序列化，仅在有 body 时带 `Content-Type: application/json`；`push` 的 `confirm` 参数类型是字面量 `true`——调用方传 `false` / 漏传**编译期**即报错，与服务端 `HUB_CONFIRM_REQUIRED` 门双保险（`client.ts:566`）。`push` 第 3 参 `PushOptions`（`dryRun` / `forceScriptsOnly` / `skipBackup` / `skipBaselineCheck` / `backupRetention`，全部可选）逐字段透传，未给的字段**不出现在请求体**里、由 hub 侧套用缺省值（§4.11）。

### 6.2 错误分类（`HubClient.request`）

| 失败层 | 抛出 |
| --- | --- |
| `fetch` reject（连接拒绝 ECONNREFUSED 等）、超时中止、响应体读取中断 | `HubNotRunningError`（语义：hub 没在跑或不可达） |
| HTTP 4xx/5xx 且 body 是 `{error:{code,message,details?}}` 标准形 | `HubError`（原样保留 `code` / `httpStatus` / `details`） |
| HTTP 4xx/5xx 但 body 非标准形 | `HubError(httpStatus, "HUB_UNKNOWN", <原始 body 文本>)` |
| HTTP 2xx 但 body 非法 JSON，或定型路由（status / save-and-play / push / shutdown）shape 不符 | `HubError(httpStatus, "HUB_UNKNOWN", ...)`（协议违规）。push 的定型要求 `ok:true` + `dryRun` / `pushed` / `skipped` 均为正确类型；`items` 缺失时客户端按 `pushed + skipped` 补算（`client.ts:586-621`） |

- `HubError`（`client.ts:134-155`）与 `HubNotRunningError`（`:162-170`）是**兄弟类**（都直接继承 `Error`）；消费方按 `src/mcp/tools/errors.ts:38-49` 的约定先判 `HubNotRunningError`（序列化为 `HUB_NOT_RUNNING`），再判 `HubError`（透传 `code` / `details`），最后 `INTERNAL_ERROR` / `UNKNOWN`。
- 网络失败绝不返回半截结果：失败即抛出。

### 6.3 probeHub 与 CLI 委托

- `probeHub(opts?)`（`client.ts:564-591`）：**零异常**探测——GET `/v1/status` + 固定 **800ms** AbortController 超时；任何失败（超时 / 连接拒绝 / 非 200 / body 非法 / `hub.uptimeMs` / `hub.startedAt` 缺失）返回 `null`，绝不抛。成功返回 `{uptimeMs, startedAt}`。
- CLI `tryHubClient()`（`src/cli/_shared.ts:32-38`）：每次现探、**不缓存**；在线返回新 `HubClient`，离线返回 `null` → 调用方走独立模式（`withEditorServer`）。
- hub 已在线时，业务请求再抛 `HubError` / `HubNotRunningError` **不回退独立模式**（hub 持有 39998，回退必然绑不上端口）——报错退出 1。
- 委托判定契约见 `方案设计.md` §14.5.1 S2："先 GET /v1/status（800ms 超时）通 → 走 HTTP 委托不占 39998；不通 → 回退 withEditorServer 独立模式"。

---

## 7. 不暴露的能力

S2 明确控制通道**不暴露**以下能力（`control.ts:5-6`、`施工流程.md` 阶段 4；理由：这些操作不需要 hub 持有 39998，CLI 直连本地文件即可，避免 hub 越权）：

| 能力 | 为什么不走控制通道 | 正确入口 |
| --- | --- | --- |
| `pack export`（`.ttsmod` 打包） | 纯本地读 + 写 ZIP，无需 TTS 会话 | `tts pack export`（本地直接执行） |
| `pack import .ttsmod` | 纯本地解包，无需 TTS 会话 | `tts pack import`（本地直接执行） |
| `sync-upstream` | 上游仓库同步，不触碰游戏 | 对应本地命令 |
| `review` | 评审流程（本地 diff / 门禁） | `tts review`（本地直接执行） |

推论：MCP 的 12 个工具也不包含这些能力（工具清单见 `src/mcp/server.ts:29-40`）；控制通道内也**没有**通用文件读写 / 任意命令执行入口（`/v1/exec` 的 Lua 在 TTS 进程内执行，不是宿主机 shell）。阶段 7 新增的 `/v1/pack/build`（§4.14）虽然"纯本地"，但它是**离线回路的构建步骤**（工作区 → 可加载存档 → 上传载荷），不是通用文件写入入口：路径由 `root` 推导、内容由 pack 布局决定，且不提供覆盖任意文件的能力。

---

## 8. 与其他端口的边界

| 端口 | 方向 / 角色 | 谁连接谁 | 用途 |
| --- | --- | --- | --- |
| **39995**（本文档） | 控制通道：HTTP+JSON 请求/响应 + 1 条 SSE | CLI / MCP / GUI → hub | 命令委托与状态查询；只绑回环 |
| **39998** | 编辑器入站：TTS **主动连入** hub | TTS → hub | 入站消息（`GameLoaded` / `Print` / …）的唯一入口；hub 运行期独占 |
| **39999** | TTS 出站：编辑器 / hub **连过去发请求** | hub → TTS | 出站协议消息（GetScripts / SaveAndPlay / ExecuteLua / CustomMessage），连→写→关 |
| **39997** | hub TCP 扇出：下游连入后持续收 JSON 串 | 下游工具 → hub | 事件广播（原样 JSON，不带分隔符），断线自动摘除 |
| **39996** | hub WebSocket 扇出：下游连入后持续收文本帧 | 下游工具 → hub | 事件广播（WS 文本帧），断线自动摘除 |

- 39998 / 39997 / 39996 与 39995 一样都有缺省值、可经 `tts hub --editor-port / --tcp-port / --ws-port` 覆盖（`cli/commands/hub.ts:93-100`）；控制通道端口经 `--port` 覆盖。
- **控制通道不是 TTS 协议通道**：它不接收 TTS 连接；TTS 流量只走 39998（入站）/ 39999（出站）。SSE 只是把 39998 收到的消息复制给订阅者。
- hub 运行期独占 39998 正是控制通道存在的理由：CLI 不再需要（也不能）临时绑定 39998。

---

## 9. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-05 | 初版（窗口 D / 阶段 4）。契约依据 `src/hub/control.ts`（12 条 JSON 路由 + `GET /v1/events` SSE）、`src/hub/lifecycle.ts`、`src/mcp/client.ts`、`src/cli/_shared.ts`；路由表与 `方案设计.md` §14.5.1 S2 / `施工流程.md` 阶段 4 一致。**已知问题 #1**：`/v1/scripts/pull` 与 `/v1/diff` 在 hub 运行期因 39998 端口冲突返回 500（待修，详见 §4.2 / §4.10）。**（阶段 5 已修复，见下行）** |
| 2026-10-05 | 阶段 5（写入路径）Run 2 修订。① **已知问题 #1 修复落档**：`PullOptions.server` / `DiffOptions.server` 注入（`src/pack/pull.ts:93-99` / `src/pack/diff.ts:161-167`），hub 路由传 `daemon.server`（`control.ts:887` / `:1036`）——§4.2 / §4.10 的"待修"块改为"已修复"并补测试现状。② **§4.11 `/v1/push` 契约扩展**：请求体加 `dryRun` / `forceScriptsOnly` / `skipBackup` / `skipBaselineCheck` / `backupRetention` 五个可选字段，响应体改为 `{ok:true, dryRun, pushed, skipped, items(=pushed+skipped 兼容别名), backupDir?, baselineConflicts?, assetChanges?}`，错误码补 `PUSH_ASSET_CHANGES_DETECTED` / `BASELINE_CONFLICT` 等（经 `HUB_PACK_ERROR` + `details.packCode` 透传）。③ 依据行补 `src/pack/push.ts` / `src/safety/baseline.ts`；§3.3 / §3.4 / §6.1 / §6.2 同步 push 的新形状与注入语义；新增契约文档 `docs/schemas/baseline.json.md` 交叉引用。 |
| 2026-10-06 | 阶段 7（窗口 G：测试运行器 + 发布链路）修订（子代理 C2）。① **新增 §4.13 `POST /v1/test/run`**：`discoverTests` + `TestRunner`（`server: daemon.server` 注入，坑 17），请求体 `{root, targetGuid?, timeoutMs?, bail?, bundle?, include?}`（`include` 为附加可选字段），响应 = `RunReport`；`details.packCode` 补 `TEST_RUN_*`。② **新增 §4.14 `POST /v1/pack/build`**：`buildSave` + `buildBson`（纯本地、不依赖 daemon.server），请求体 `{root, outPath?, dryRun?}`，响应 = `BsonBuildResult`（`{outPath, byteLength, headerLength}`）+ 诊断字段（`dryRun` / `jsonPath` / `warnings` / 四个替换计数），`dryRun` 下字节数恒 0。③ §4.0 总览表补 13 / 14 行、计数 12 → 14；§6.1 补 `testRun` / `packBuild`；§1 与 §7 的"MCP 10 个工具" → 12 个（新增 `tts_test_run` / `tts_pack_build`）。实现依据：`src/hub/control.ts:1193-1290`（两个 handler）、`src/mcp/client.ts`（`testRun` / `packBuild`）、`src/mcp/tools/test-run.ts` / `pack-build.ts`、`src/test/index.ts`（Stage A 桶文件）、`src/pack/build.ts`、`src/publish/bson.ts`。单测：`tests/unit/mcp-test-run.test.ts` / `tests/unit/mcp-pack-build.test.ts`。 |
