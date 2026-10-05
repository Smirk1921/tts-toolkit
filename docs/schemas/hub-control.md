# hub 控制通道（S2）契约

> **本文档由窗口 D（阶段 4）产出，CLI / MCP 使用方与 hub 维护者必读。**
>
> 依据：`src/hub/control.ts`（控制通道服务实现，12 条 JSON 路由 + SSE）、`src/hub/lifecycle.ts`（进程编排与优雅退出）、`src/mcp/client.ts`（`HubClient` / `probeHub`）、`src/cli/_shared.ts`（CLI 委托判定）、`src/protocol/ports.ts`（端口常量）。路由表与 `方案设计.md` §14.5.1 S2、`施工流程.md` 阶段 4 的路由映射一致。
> 本文档描述**已实现的真实契约**，不是设想稿。发现的实现问题一律显式标注（§4.2 / §4.10 / §9 已知问题 #1），不隐去。

---

## 1. 概述

hub 控制通道是 `tts hub` 常驻进程暴露的**本机 HTTP+JSON 控制面**：基线 `http://127.0.0.1:39995/v1`，只监听回环地址。它解决的核心问题是——

- hub 运行期**独占编辑器入站端口 39998**（TTS 主动连入的唯一端点），CLI 的"临时绑 39998、用完即走"模式无法与 hub 共存；
- 于是 CLI 与 MCP 服务改为**经控制通道把请求委托给 hub**：hub 已持有与 TTS 的会话，代为执行拉取、执行 Lua、切片、导入、写回等操作（`方案设计.md` §14.5.1 S2；CLI 委托判定见 `src/cli/_shared.ts:1-21`）。

谁用它：

| 使用方 | 入口 | 说明 |
| --- | --- | --- |
| tts CLI | `src/cli/_shared.ts` 的 `tryHubClient()` | 先 `probeHub()`（800ms），在线则经 `HubClient` 委托；离线走独立模式（临时绑 39998） |
| MCP 服务 | `src/mcp/main.ts` → `src/mcp/server.ts`（`tts-mcp` bin，独立 stdio 进程，不经 `tts` 主 CLI） | 10 个工具全部经同一个 `HubClient` 访问 hub，自己不绑 39998 |
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
| `HUB_PACK_ERROR` | 400 | 底层 `PackError` 透传；`details.packCode` 为业务码（`PACK_*` / `PULL_FAILED` / `SLICE_*` / `PLAN_*` / `IMPORT_*` / `REGISTRY_*` / `PUSH_FAILED` 等） |
| `HUB_LUA_ERROR` | 400 | Lua 运行时错误透传 |
| `HUB_INTERNAL_ERROR` | 500 | 其余异常（含会话层超时 / 未连接 TTS 的普通 Error、端口占用 `PortInUseError`） |

**客户端 code（由 `HubClient` 分类产生，不来自 HTTP 响应体）：**

| code | 产生方 | 语义 |
| --- | --- | --- |
| `HUB_NOT_RUNNING` | MCP 工具层序列化（`src/mcp/tools/errors.ts:38-41`） | `HubNotRunningError`：连接拒绝 / 超时中止 / 响应体读取中断 → hub 没在跑或不可达；**没有 HTTP 状态码** |
| `HUB_UNKNOWN` | `HubClient`（`client.ts:228-241`、`:250-255`、`:324-329`） | HTTP 4xx/5xx 但响应体不符合标准错误形，或 2xx 响应体非法 JSON / 定型路由 shape 不符 |

`control.ts` 服务端**从不**产生 `HUB_NOT_RUNNING` / `HUB_UNKNOWN`。

### 3.4 响应体约定

- 成功响应一律 JSON 对象；`{ok:true}` 是多数操作型路由的通用成功形（`save-and-play` / `push` / `shutdown`）。
- 请求处理期间客户端断开：服务器静默（无响应对象可写），不产生未处理异常（`control.ts:617-622`）。

---

## 4. 路由清单

### 4.0 总览

S2 控制面共 **12 条 JSON 路由**（下表）+ **1 条 SSE 事件流**（`GET /v1/events`，见 §5），共 13 个路径。

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
| 11 | POST | `/v1/push` | 写回并重载（必须 `confirm:true`） | 改游戏状态 | `{root, confirm:true}` | `{ok:true, items}` |
| 12 | POST | `/v1/hub/shutdown` | 优雅关闭 hub | 进程退出 | 不读 | `{ok:true}` |

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

> ⚠️ **当前实现限制（阶段 4 已知 bug，待修）**
> - **症状**：hub 运行期调用本路由返回 **500 `HUB_INTERNAL_ERROR`**（message 为 `PortInUseError` 的端口占用描述）。
> - **根因**：`handlePull` 直接调 `pullFromGame`，而后者内部经 `withEditorServer` **新建 EditorServer 并独占绑定 39998**（`pull.ts:331` → `cli/with-server.ts:43-44` → `protocol/editor-server.ts:55-88`），与 hub daemon 已持有的 39998 冲突 → 第二次 `start()` 抛 `PortInUseError`（非 `PackError`/`LuaError` → 500）。
> - **修复方向**（不在本契约范围）：让 `pullFromGame` / `diffWorkspace` 接受可选的 `SessionScripts` / `EditorServer` 注入，hub 路由处理器传入 daemon 的会话（`daemon.scripts` / `daemon.server`）而不是新建。
> - **临时规避**：hub 运行期间，仓内调用方应直接使用 daemon 会话层；外部调用方暂时只能等待修复。

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

> ⚠️ **当前实现限制（阶段 4 已知 bug，待修）**
> - **症状**：hub 运行期调用本路由返回 **500 `HUB_INTERNAL_ERROR`**（`PortInUseError`）。
> - **根因**：`handleDiff` 直接调 `diffWorkspace`，后者内部经 `withEditorServer` 重新独占绑定 39998（`diff.ts:422`），与 hub daemon 已持有的 39998 冲突（同 §4.2）。
> - **修复方向**：与 §4.2 相同——为 `diffWorkspace` 增加可选会话注入，hub 路由传入 daemon 会话而不是新建。
> - **临时规避**：同 §4.2。

### 4.11 POST /v1/push

- 请求体（`control.ts:1018-1042`）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `root` | string | ✅ | 图包工作区根目录 |
| `confirm` | 字面量 `true` | ✅ | **不严格等于 `true` → 400 `HUB_CONFIRM_REQUIRED`**（`false` / 缺失 / `"true"` 都拒绝） |

- 行为：`collectPushItems({root})` 收集本地 `scripts/` + `ui/` 清单 → 逐条读取文件内容组装完整 `scriptStates` → `daemon.scripts.saveAndPlay` 写回并重载。**不做** baseline hash / 备份目录 / 素材改动检测（阶段 5 范围）；`scriptStates` 缺字段的删除语义见 §4.3。
- 响应 200：`{ok: true, items: <写回对象数>}`。
- 可能的错误码：400 `HUB_CONFIRM_REQUIRED`（confirm 检查在 root 校验之后）；400 `HUB_BAD_REQUEST`（root 缺失）；400 `HUB_PACK_ERROR`（`PUSH_FAILED`）；500 `HUB_INTERNAL_ERROR`。
- curl：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/push \
  -H "Content-Type: application/json" \
  -d '{"root":"D:/packs/第七大陆","confirm":true}'
```

### 4.12 POST /v1/hub/shutdown

- 请求体：**不读取**（无 Content-Type 要求）。
- 行为：先回 200 `{ok:true}`，响应出站后再触发 `onShutdown` 回调（lifecycle 传入 `HubProcess.stop`）：先停控制通道（拒新连接）→ 再停 daemon（编辑器端口 + TCP/WS 扇出）→ 关日志。停止幂等（SIGINT / SIGTERM / 本路由共享同一次停止流程）；回调失败只记日志（`control.ts:1044-1057`、`lifecycle.ts:202-254`）。
- 可能的错误码：404 / 405；500 仅防御路径。
- curl：

```bash
curl -s -X POST http://127.0.0.1:39995/v1/hub/shutdown
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
| `push(root, confirm: true)` | POST `/v1/push` | `HubPushResult` `{ok:true, items}` |
| `shutdown()` | POST `/v1/hub/shutdown` | `HubOkResult` `{ok:true}` |

- 缺省选项（`HubClientOptions`，`client.ts:49-76`）：`host=127.0.0.1`、`port=39995`、单请求 `timeoutMs=30000`（覆盖"发起请求 + 读取响应体"全程）；host 为 IPv6 字面量时自动加 `[]`。
- 请求体由 `JSON.stringify` 序列化，仅在有 body 时带 `Content-Type: application/json`；`push` 的 `confirm` 参数类型是字面量 `true`——调用方传 `false` / 漏传**编译期**即报错，与服务端 `HUB_CONFIRM_REQUIRED` 门双保险（`client.ts:525`）。

### 6.2 错误分类（`HubClient.request`）

| 失败层 | 抛出 |
| --- | --- |
| `fetch` reject（连接拒绝 ECONNREFUSED 等）、超时中止、响应体读取中断 | `HubNotRunningError`（语义：hub 没在跑或不可达） |
| HTTP 4xx/5xx 且 body 是 `{error:{code,message,details?}}` 标准形 | `HubError`（原样保留 `code` / `httpStatus` / `details`） |
| HTTP 4xx/5xx 但 body 非标准形 | `HubError(httpStatus, "HUB_UNKNOWN", <原始 body 文本>)` |
| HTTP 2xx 但 body 非法 JSON，或定型路由（status / save-and-play / push / shutdown）shape 不符 | `HubError(httpStatus, "HUB_UNKNOWN", ...)`（协议违规） |

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

推论：MCP 的 10 个工具也不包含这些能力（工具清单见 `src/mcp/server.ts:29-38`）；控制通道内也**没有**通用文件读写 / 任意命令执行入口（`/v1/exec` 的 Lua 在 TTS 进程内执行，不是宿主机 shell）。

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
| 2026-10-05 | 初版（窗口 D / 阶段 4）。契约依据 `src/hub/control.ts`（12 条 JSON 路由 + `GET /v1/events` SSE）、`src/hub/lifecycle.ts`、`src/mcp/client.ts`、`src/cli/_shared.ts`；路由表与 `方案设计.md` §14.5.1 S2 / `施工流程.md` 阶段 4 一致。**已知问题 #1**：`/v1/scripts/pull` 与 `/v1/diff` 在 hub 运行期因 39998 端口冲突返回 500（待修，详见 §4.2 / §4.10）。 |
