# `test-report.json` — 测试运行报告契约（RunReport）

> **本文档由窗口 G / Stage C（C3）产出，`tts test` / MCP `tts_test_run` / hub `/v1/test/run` 的维护者必读。**
>
> 依据：`src/test/types.ts`（A1 冻结的类型契约，本文档未修改该模块）、`src/test/runner.ts`（执行引擎）、`src/test/reporter.ts`（`toJson` / `formatConsole`）、`src/test/assert.ts`（Lua 侧结果形状）、`src/mcp/tools/test-run.ts`（MCP 返回）、`src/hub/control.ts:1168-1226`（`POST /v1/test/run` 响应）。
> 适用版本：**version 1（2026-10-06 冻结）**。本文档描述**已实现的真实契约**，不是设想稿；凡标注「实测」的行为均由本文档窗口用构建产物（`dist/test/*.js`）+ Node 24 实跑得到。
> 相关契约：`docs/schemas/pack.yaml.md` §4.7（`tests` 段的发现配置）、`docs/schemas/hub-control.md`（`POST /v1/test/run` / `POST /v1/pack/build` 路由）。

---

## 1. 用途与位置

`test-report.json` 不是磁盘上的固定文件，而是**一次测试运行的报告文档**（RunReport）。同一份 JSON 有三个出口，三者字节级同源（都由 `toJson` 或它的上游对象产生）：

| 出口 | 载体 | 说明 |
| --- | --- | --- |
| CLI | `tts test --json <path>` | `toJson(report)` 的返回值写到 `<path>`（`src/cli/commands/test.ts`，窗口 G / C1 产出） |
| MCP | `tts_test_run` 工具返回值 | `structuredContent = report` 对象；`content[0].text = JSON.stringify(report)`（`src/mcp/tools/test-run.ts:91-95`） |
| hub | `POST /v1/test/run` 响应体 | HTTP 200 + `sendJson(res, 200, report)`（`src/hub/control.ts:1225`） |

- 生成者：`TestRunner.run(opts)`（`src/test/runner.ts:261`），入参 `RunOptions` 见 §11.1。
- 序列化：`toJson(report)`（`src/test/reporter.ts:147-149`）= `JSON.stringify(report, null, 2)`。
- 人读形态：`formatConsole(report, opts)`（`src/test/reporter.ts:76`），见 §8。
- **英文键名，不走 `t()`**：报告是结构化数据（消费方是脚本 / MCP 客户端），字段名即契约；只有控制台渲染与人读文案才走 i18n。

### 1.1 三个出口的差异（不要混淆）

| 差异点 | CLI `--json` | MCP `tts_test_run` | hub `POST /v1/test/run` |
| --- | --- | --- | --- |
| 外层包装 | 无（就是 RunReport） | MCP 协议信封（`content` + `structuredContent`） | 无（HTTP body 就是 RunReport） |
| 失败时的形态 | 进程退出码（§9）；报告仍写到 `--json` 路径 | `isError: true` + `{error:{code,message,details?}}` | HTTP 400 + `{error:{code:"HUB_PACK_ERROR",message,details:{packCode}}}`（`src/hub/control.ts:783`） |
| "断言失败"是否算错误 | 否（退出码 1，报告正常） | 否（工具成功返回整份报告） | 否（路由 200，报告正常） |

---

## 2. 文档格式

- **JSON**，`JSON.stringify(report, null, 2)`：**2 空格缩进、无末尾换行**（实测 `toJson(...)` 末尾字符为 `"}"`，`endsWith("\n") === false`）。三个出口都是同一份字符串 / 对象：CLI 的 `writeJsonReport` 直接 `writeFile(resolved, toJson(report), "utf8")`（`src/cli/commands/test.ts:376-381`，因此 `--json` 落盘文件**同样无末尾换行**）；MCP / hub 走 `JSON.stringify(report)`（无缩进）与对象直传。
- 字符串一律 UTF-8（Node 默认），中文原样输出，无 `\uXXXX` 转义以外的惊喜（`JSON.stringify` 不转义非 ASCII）。
- 无 BOM、无注释、无尾随逗号（JSON 规范）。
- 数值字段为整数毫秒 / 秒（见 §3、§4 表）；时间字段为 `Date#toISOString()` 的 UTC ISO 8601 字符串（含毫秒与 `Z`）。
- 数组字段**永不缺省为 `null`**：`results` / `asserts` / `prints` 都是数组（可能为空 `[]`）。
- 可选字段（`failureReason`、`message`、`sourceFile`、`sourceLine`）**缺省时该键不出现**（`undefined` 被 `JSON.stringify` 丢弃），消费方必须按"可能没有这个键"处理。

---

## 3. 根对象字段（`RunReport`）

类型定义：`src/test/types.ts:54-74`；产出：`src/test/runner.ts:310-322`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `runId` | `string` | ✅ | 运行 ID：`<startMs.toString(36)>-<8 位随机 hex>`（`src/test/runner.ts:311`）。实测样例：`"mg8k2p1a-9f3c4b21"`。用于报告文件名 / 日志关联，**不保证全局唯一**（时间戳 + 32 位随机） |
| `root` | `string` | ✅ | 图包工作区根，**已 `path.resolve` 的绝对路径**（`src/test/runner.ts:264`）。Windows 上形如 `D:/packs/demo` |
| `startedAt` | `string` | ✅ | 运行开始时间，`new Date(startMs).toISOString()`（UTC，毫秒精度） |
| `endedAt` | `string` | ✅ | 运行结束时间，同上 |
| `durationMs` | `number` | ✅ | 墙钟总耗时（毫秒），`Math.max(0, endedMs - startMs)`（`:315`）——**大于等于**各 `results[].durationMs` 之和并不保证（并行 / 等待 / 打包开销都在内） |
| `total` | `number` | ✅ | 用例总数 = `results.length` |
| `passed` | `number` | ✅ | `status === "passed"` 的用例数 |
| `failed` | `number` | ✅ | `status === "failed"` 的用例数 |
| `errored` | `number` | ✅ | `results.length - passed - failed`（`:309`）——**不是**独立计数：任何既非 passed 也非 failed 的条目（含合成条目）都计在这里 |
| `bailed` | `boolean` | ✅ | 是否因 `--bail` 提前终止（`src/test/runner.ts:297-300`）。注意：**全局超时不算 bail**（超时是被动中断，见 §7） |
| `results` | `TestResult[]` | ✅ | 各用例结果，顺序 = 发现顺序（文件按相对路径字典序，见 `src/test/discover.ts:423-431`），文件内按 Lua 侧执行顺序 |

> 恒等式（消费方可直接断言）：`total === passed + failed + errored`，且 `total === results.length`。

---

## 4. `results[]` 条目字段（`TestResult`）

类型定义：`src/test/types.ts:39-51`；产出：`src/test/runner.ts:175-202`（映射 Lua 侧用例）与 `:205-214`（合成条目）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `case` | `TestCase` | ✅ | 用例标识（§5），`case.sourceFile` 是**相对 pack 根、`/` 分隔**的路径 |
| `status` | `"passed" \| "failed" \| "error"` | ✅ | 三态见 §6。**没有第 4 种取值**：Lua 侧返回未知状态时按 `error` 记录，并在 `failureReason` 里注明实际值（`src/test/runner.ts:184-195`） |
| `failureReason` | `string` | ❌ | `failed` / `error` 时给出原因（失败断言消息 / Lua 运行时错误文本 / 文件级错误说明）；`passed` 时该键不出现。断言级细节在 `asserts[]` 里，本字段是**汇总性**的一句话 |
| `asserts` | `AssertResult[]` | ✅ | 该用例内的全部断言结果（含通过的），见 §5。**文件级合成条目为 `[]`** |
| `durationMs` | `number` | ✅ | 该用例耗时（毫秒）。**粒度为文件**：同一文件内的所有用例共享同一次 `ExecuteLua` 的耗时（每个文件只做一次往返，`src/test/runner.ts:31-33`） |
| `prints` | `string[]` | ✅ | 该用例执行期间 `print()` 的输出（Lua 侧按行捕获；`src/test/assert.ts:95-105`）。运行器还会把 TTS 侧新增的 Print 消息（messageID 2）差分后**追加到该文件最后一个用例**（`src/test/runner.ts:39-42`） |

---

## 5. `case` 与 `asserts[]` 字段

### 5.1 `TestCase`（`src/test/types.ts:15-22`）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | `string` | ✅ | 用例名：Lua 侧 `it("...")` 的第一个参数（`src/test/assert.ts:19-20`）。合成条目形如 `"tests/broken.test.lua（文件级错误）"` |
| `sourceFile` | `string` | ✅ | 相对 pack 根、`/` 分隔的 Lua 源文件路径（bundle 模式下经 lineMap 回映射；直跑模式经前缀行偏移换算） |
| `sourceLine` | `number` | ✅ | `it(...)` 调用处的**源文件行号（1 基）**（Lua `debug.getinfo` 的 `currentline`，`src/test/assert.ts:132`）。合成条目 / 取不到行号时为 `0` |

### 5.2 `AssertResult`（`src/test/types.ts:25-36`）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `kind` | `string` | ✅ | 断言类型（如 `"assert_eq"` / `"assert_true"` / `"expect_error"`）。Lua 侧未给出时回落 `"unknown"`（`src/test/runner.ts:162`） |
| `passed` | `boolean` | ✅ | 是否通过。**只有严格 `true` 才算通过**（Lua 侧返回其他值一律记 false，`src/test/runner.ts:167`） |
| `message` | `string` | ❌ | 失败消息（含期望值 vs 实际值）；通过时通常不出现 |
| `sourceFile` | `string` | ❌ | 失败断言的源文件（行号回映射后） |
| `sourceLine` | `number` | ❌ | 失败断言的源文件行号（1 基；取不到为 `0`） |

---

## 6. `status` 三态语义

| 取值 | 含义 | 谁产生 | 计数 |
| --- | --- | --- | --- |
| `passed` | 用例内所有断言通过 | Lua 断言库（`src/test/assert.ts:133`） | `passed` |
| `failed` | **断言失败**（哨兵错误：`assert_*` 抛出并被库捕获） | `src/test/assert.ts:154-165` | `failed` |
| `error` | **运行时错误**（非断言的 Lua 异常 / 超时 / 文件级失败 / 无法解析返回值） | `src/test/assert.ts:157`、`src/test/runner.ts` 各处 | `errored` |

**关键口径**：断言失败**不是**错误（既不是路由错误也不是工具错误）。`tts test` 对 `failed > 0` 与 `errored > 0` 给出**不同退出码**（§9），CLI / MCP / hub 三处都不会因为 `failed` 而拒绝返回报告。

---

## 7. 合成条目（没有对应用户用例，但会出现在 `results[]` 里）

| 场景 | 条数 | 形状 | 依据 |
| --- | --- | --- | --- |
| 某个测试文件整体失败（打包失败 / 读取失败 / Lua 异常 / 单文件超时 / 返回值畸形 / 没有产出任何用例） | 每文件 1 条 | `status: "error"`；`case.name = "<相对路径>（文件级错误）"`；`case.sourceLine = 0`；`asserts: []`；`failureReason` = 具体原因（形如 `测试文件 <路径> 执行失败：<原因>`） | `src/test/runner.ts:204-214` |
| 全局超时（默认 `300_000` ms）后剩余文件未执行 | 每剩余文件 1 条 | `status: "error"`；`case.name = "<相对路径>（文件级错误）"`；`durationMs: 0`；`failureReason` 含 `TEST_RUN_GLOBAL_TIMEOUT` 的文案 | `src/test/runner.ts:281-293` |

因此 **`results.length` 可以大于实际写出的 `it()` 用例数**；`tts test` 的"用例数"以报告为准。

**`bailed` 的粒度是文件**（`src/test/runner.ts:33-34`、`:296-300`）：`--bail` 下，某文件跑完出现 failed/error 用例即停止后续**文件**；该文件内已执行的用例全在报告里。同一文件内的用例由 Lua 侧一次性执行完，无法中途停止。

---

## 8. 控制台形态（`formatConsole`）

`formatConsole(report, { color?, verbose? })`（`src/test/reporter.ts:76-139`）产出多行字符串，结构固定：

```text
测试运行报告
═══════════════
运行 ID: <runId>
工作区: <root>
开始: <startedAt>
耗时: <durationMs>ms

结果统计
────────
通过: <passed>/<total>
失败: <failed>
错误: <errored>
[已提前终止（--bail：出现失败后停止运行后续文件）]     ← 仅 bailed === true

[失败详情]                                            ← 仅 failed > 0
✗ <用例名> (<sourceFile>:<sourceLine>)
  断言失败: <message> (<sourceFile>:<sourceLine>)

[错误详情]                                            ← 仅 errored > 0
✗ <用例名> (<sourceFile>:<sourceLine>)
  运行时错误: <failureReason>

[print 输出]                                          ← 仅 verbose === true 且有用例带 prints
✓|✗ <用例名> (<sourceFile>:<sourceLine>)
    | <print 行>

总结: 通过 <passed> / 失败 <failed> / 错误 <errored>
```

- **控制台不是契约，报告才是**：脚本消费请用 `--json` / MCP / hub，不要正则解析控制台文本。
- `color: false` 时**不含任何 ANSI 码**（`src/test/reporter.ts:7-9` 的保证，实测无 `\u001b`）；`color: true` 时颜色码包裹在片段两侧。**必须解析 `color: true` 输出时先去 ANSI**（坑 16）：`/\u001b\[[0-9;]*m/g`。
- `verbose: true` 只影响"[print 输出]"段；`results[].prints` 无论如何都在 JSON 里。

---

## 9. CLI 退出码（`tts test`）

| 条件 | 退出码 |
| --- | --- |
| 未发现任何测试文件（空清单） | **0**（打印"未发现测试文件"，空报告 `total: 0`；`src/cli/commands/test.ts:443-445`） |
| `failed === 0` 且 `errored === 0`（含 `total: 0`） | **0** |
| `failed > 0` 且 `errored === 0` | **1** |
| `errored > 0`（无论有没有 failed） | **2** |

依据：`exitCodeFor(report)`（`src/cli/commands/test.ts:218-226`，**错误优先于失败**）与窗口 G 的 C1 接口契约（"exit code：全过 0；有失败 1；有错误 2"）。退出码非 0 时 CLI 还会按实际计数往 stderr 补一行 `cli.test.failed` / `cli.test.errored` 文案（`:475-480`），报告本身不受影响。**注意**：hub / MCP 侧没有"退出码"，同样的报告只体现为 `passed/failed/errored` 计数。

---

## 10. 完整示例

下面是**实测**输出：把本节 JSON 交给 `toJson`（`src/test/reporter.ts:147`）走一遍即得到同样的字符串（除 `runId` / 时间戳外逐字节一致）。

```json
{
  "runId": "mg8k2p1a-9f3c4b21",
  "root": "D:/packs/demo",
  "startedAt": "2026-10-06T03:15:00.000Z",
  "endedAt": "2026-10-06T03:15:02.480Z",
  "durationMs": 2480,
  "total": 3,
  "passed": 1,
  "failed": 1,
  "errored": 1,
  "bailed": false,
  "results": [
    {
      "case": { "name": "卡牌 52 张", "sourceFile": "tests/deck.test.lua", "sourceLine": 4 },
      "status": "passed",
      "asserts": [
        { "kind": "assert_eq", "passed": true, "sourceFile": "tests/deck.test.lua", "sourceLine": 5 },
        { "kind": "assert_true", "passed": true, "sourceFile": "tests/deck.test.lua", "sourceLine": 6 }
      ],
      "durationMs": 812,
      "prints": ["deck size = 52"]
    },
    {
      "case": { "name": "URL 前缀正确", "sourceFile": "tests/urls.test.lua", "sourceLine": 9 },
      "status": "failed",
      "failureReason": "断言失败：期望 \"https://\" 实际 \"http://\"",
      "asserts": [
        { "kind": "assert_eq", "passed": true, "sourceFile": "tests/urls.test.lua", "sourceLine": 10 },
        {
          "kind": "assert_eq",
          "passed": false,
          "message": "期望 \"https://\" 实际 \"http://\"",
          "sourceFile": "tests/urls.test.lua",
          "sourceLine": 12
        }
      ],
      "durationMs": 733,
      "prints": []
    },
    {
      "case": { "name": "缺少 GUID（文件级错误）", "sourceFile": "tests/broken.test.lua", "sourceLine": 0 },
      "status": "error",
      "failureReason": "测试文件 tests/broken.test.lua 执行失败：Lua 运行时错误：attempt to index a nil value",
      "asserts": [],
      "durationMs": 935,
      "prints": []
    }
  ]
}
```

对应的控制台输出（`formatConsole(report, { color: false })`，实测）：

```text
测试运行报告
═══════════════
运行 ID: mg8k2p1a-9f3c4b21
工作区: D:/packs/demo
开始: 2026-10-06T03:15:00.000Z
耗时: 2480ms

结果统计
────────
通过: 1/3
失败: 1
错误: 1

[失败详情]
✗ URL 前缀正确 (tests/urls.test.lua:9)
  断言失败: 期望 "https://" 实际 "http://" (tests/urls.test.lua:12)

[错误详情]
✗ 缺少 GUID（文件级错误） (tests/broken.test.lua:0)
  运行时错误: 测试文件 tests/broken.test.lua 执行失败：Lua 运行时错误：attempt to index a nil value

总结: 通过 1 / 失败 1 / 错误 1
```

空报告（没有测试文件时）长这样——`results: []`，四个计数全 0，不是错误：

```json
{
  "runId": "mg8k2p1b-1a2b3c4d",
  "root": "D:/packs/demo",
  "startedAt": "2026-10-06T03:20:00.000Z",
  "endedAt": "2026-10-06T03:20:00.010Z",
  "durationMs": 10,
  "total": 0,
  "passed": 0,
  "failed": 0,
  "errored": 0,
  "bailed": false,
  "results": []
}
```

---

## 11. API 与错误码

### 11.1 生成入口

| API | 位置 | 说明 |
| --- | --- | --- |
| `new TestRunner(server)` | `src/test/runner.ts:246-251` | `server` 为 `EditorServer`（仅用其 find 只读能力做 Print 快照） |
| `runner.run(opts: RunOptions)` | `src/test/runner.ts:261` | 返回 `Promise<RunReport>`；`RunOptions = { root, files, bundle?, bail?, server, globalTimeoutMs? }`（`src/test/types.ts:99-112`）。`opts.server` 优先于构造函数注入的 server（hub 委托模式用） |
| `toJson(report)` | `src/test/reporter.ts:147` | §2 的序列化 |
| `formatConsole(report, opts?)` | `src/test/reporter.ts:76` | §8 的渲染 |

### 11.2 运行时错误（**不是**报告里的 `failed`）

运行期"整轮跑不起来"才抛错（`PackError`），此时**没有报告**；单文件层面的失败会降级成合成 `error` 条目而不是抛出（`src/test/runner.ts:328-330`）：

| 错误码 | 触发 | 出口 |
| --- | --- | --- |
| `TEST_RUN_BUNDLE_FAILED` | bundle 模式打包某测试文件失败 | MCP `{error:{code:"HUB_PACK_ERROR",details:{packCode}}}` / CLI `error.TEST_RUN_BUNDLE_FAILED` |
| `TEST_RUN_FILE_UNREADABLE` | 直跑模式读取测试文件失败 | 同上 |
| `TEST_RUN_FILE_TIMEOUT` | 单文件执行超时（`DiscoveredTest.timeoutMs`） | 同上 |
| `TEST_RUN_EXEC_FAILED` | 其他执行期错误（非 LuaError、非超时） | 同上 |
| `TEST_RUN_RESULTS_MALFORMED` | 返回值不是字符串 / 非法 JSON / 缺 `tests` 数组 | 同上 |
| `TEST_RUN_GLOBAL_TIMEOUT` | 全局超时后剩余文件未执行（合成条目） | 同上 |
| `TEST_DISCOVER_PACK_YAML_INVALID` / `TEST_DISCOVER_FILE_UNREADABLE` | 发现阶段（`pack.yaml` tests 段不可用 / 目录不可读）——**只告警，不中断**，不影响报告 | 告警走 `discoverTests` 的 `onWarning`（缺省 stderr） |
| `TEST_ENTRY_NOT_FOUND` / `TEST_BUNDLE_FAILED` | bundle 阶段入口文件不存在 / 打包失败（`src/test/bundle.ts`） | 由 runner 捕获并降级为合成 `error` 条目 |

hub 侧另有传输层错误码（`HUB_BAD_REQUEST` / `HUB_PACK_ERROR` / `HUB_NOT_RUNNING` 等），契约见 `docs/schemas/hub-control.md`。

### 11.3 i18n 键

报告本身**不走 `t()`**（英文键名即契约）。与本契约相关的文案键（`locales/*.json` 双语镜像，由 Stage C 补齐）：`cli.test.*`、`mcp.tool.tts_test_run.title` / `.description`、`error.test.*`、`error.TEST_*`（机器码风格，供 `error.${code}` 拼接）。

---

## 12. 版本与冻结

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| `version 1` | 2026-10-06 | 本文档（窗口 G / Stage C）。字段集 = `src/test/types.ts` 的 `RunReport` / `TestResult` / `TestCase` / `AssertResult`，自本日起冻结 |

**兼容性规则**（后续窗口新增字段时）：

1. **只加不删、不改名、不改类型**：消费方（脚本 / MCP 客户端 / 第三方）按字段名读取，改名等于破坏契约；
2. 新增字段一律**可选**（缺省时键不出现），或提供向后兼容的默认值；
3. `status` 的取值域是闭合的三态，新增状态属于破坏性变更（必须先升级本文档版本号与所有消费方）；
4. 计数口径（`total === passed + failed + errored`）与 `errored` 的"兜底计数"语义不得改变。

---

## 13. 已知边界

- **`durationMs` 粒度是文件**：同一文件里的多个用例共享同一次 `ExecuteLua` 的耗时，不能据此做用例级性能断言。
- **`prints` 的归属**：TTS 侧增量 Print（messageID 2）会挂到**该文件最后一个用例**上；文件里没有任何用例时这些输出被丢弃（RunReport 没有文件级 prints 字段，`src/test/runner.ts:39-42`）。
- **`runId` 不保证唯一**：时间戳（36 进制）+ 32 位随机，理论上可碰撞；不要把它当主键存储。
- **`root` 是绝对路径**：跨机器 / 跨平台搬运报告时该字段会失效，且 Windows 盘符大小写不归一。
- **直跑模式（`bundle: false`）没有模块解析**：测试文件里的 `require`（断言库除外）会落到 TTS 的真实 `require` 上；报告本身不受影响，但失败原因会体现为 Lua 运行时错误（`status: "error"`）。
- **MCP 侧的超时**：`tts_test_run` 不做运行时长限制，长跑测试可能触达 MCP 客户端自身的超时；`globalTimeoutMs` 目前不经 MCP / hub 请求字段暴露（固定 `300_000`）。
