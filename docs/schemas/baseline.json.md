# `.tts/baseline.json` — 基线 hash 契约

> **本文档由阶段 5（写入路径）Run 2 产出，push / pull / hub / MCP 维护者必读。**
>
> 依据：`src/safety/baseline.ts`（Run 1 实现，本文档窗口未修改该模块）、`src/pack/pull.ts`（pull 末尾写基线）、`src/pack/push.ts`（push 前检测 + 成功后更新）、`src/pack/init.ts:110-118`（`.gitignore` 条目）。
> 适用结构版本：`version: 1`。本文档描述**已实现的真实契约**，不是设想稿。
> 单元测试口径：`tests/unit/safety-baseline.test.ts`；相关：`tests/unit/pack-pull-baseline.test.ts`、`tests/unit/pack-layout-baseline.test.ts`、`tests/unit/pack-push-save.test.ts`、`tests/unit/hub-control-push.test.ts`。

---

## 1. 用途与位置

`.tts/baseline.json` 是**图包工作区的安全基线**：记录"上一次与游戏对账时"各对象的脚本 / UI 内容 hash 与工作区素材清单的内容 hash。它回答 push 前必须问清楚的两个问题：

1. **游戏内脚本 / UI 是否被别人改过？** —— pull 之后立即把当时游戏侧各对象 `script` / `ui` 的归一化 sha256 写进基线；push 前把当前游戏侧快照与基线对比，不一致即报冲突，提示先 `pull` 对账，**避免覆盖他人改动**。
2. **工作区素材是否漂移？** —— 基线同时记录文本素材清单的内容 hash；push 前发现任何 `changed` / `added` / `deleted` 都必须拦截。原因是约束 7：push 协议（`GameLoaded` / messageID 1 的写回）**只接收 `scriptStates`，不接收任何素材字段**，素材改动永远不可能靠 push 热重载生效，必须走 `tts assets upload → tts pack build → 游戏内加载新存档` 的离线回路。

```text
<packRoot>/                     ← `tts pack pull/push --root <dir>` 的 root
  pack.yaml
  .gitignore                    ← init 写入，含 ".tts/baseline.json"（不入库）
  .tts/
    baseline.json               ← 本文件（工具内部状态）
    skeleton.json               ← 离线回路中间产物（同样不入库）
    backups/<时间戳>/           ← push 前自动备份（同样不入库）
  scripts/  ui/  decks/  objects/ ...
```

- 路径换算：`baselinePath(root)` → `<root>/.tts/baseline.json`（`src/safety/baseline.ts:454-456`；目录名 / 文件名常量 `BASELINE_DIR` / `BASELINE_FILE`，`:91-94`）。
- 读写入口：`readBaseline(root)` / `writeBaseline(root, states)`（`src/safety/baseline.ts:471`、`:509`）。
- 检测入口：`diffBaseline(root, remoteStates)`（脚本 / UI 冲突）、`detectAssetChanges(root, baseline)`（素材三向对比）（`:596`、`:656`）。
- 盖章入口：`touchLastPushAt(root)`（`:697`）。
- **工具内部状态，绝不入 git**：`tts pack init` 在 `<root>/.gitignore` 写入 `.tts/baseline.json`（`src/pack/init.ts:112`）。
- **纯离线模块**：不连 TTS、不绑 39998、不触碰 `pack/build.ts` 与任何素材 URL（`src/safety/baseline.ts:60-61`）。

### 1.1 与其他契约的分工

| 文件 | 角色 | 冲突时以谁为准 |
| --- | --- | --- |
| `pack.yaml` | 图包主清单（名称 / 图床 / vcs），**人可编辑** | 以 `pack.yaml` 为准（见 `docs/schemas/pack.yaml.md`） |
| `baseline.json` | 工具内部的**对账快照**，人不应手改 | 内容以基线为准（它就是判据）；基线损坏按"没有基线"处理 |
| `.tts/backups/<时间戳>/` | push 前的可回滚快照（含 manifest） | 备份与基线**互不引用**：`createBackup` 会顺带拷一份基线，但恢复流程不读它（`src/safety/backup.ts:36-41`） |

---

## 2. 文件格式

- **JSON**，`JSON.stringify(baseline, null, 2)` **2 空格缩进 + 末尾换行**（`writeBaselineFile`，`src/safety/baseline.ts:351-362`；实测落盘末尾两字符为 `"}\n"`）。
- UTF-8 无 BOM；父目录（`.tts/`）不存在时自动 `mkdir -p`（`:354`）。
- **写入不是原子替换**：直接 `writeFile` 覆盖（与 `.registry.yaml` 的临时文件 + rename 不同）。中途崩溃可能留下截断文件——读到截断 JSON 时按"损坏 → 没有基线"处理（§2.1），安全方向不受损。
- 手改说明：**不建议手改**。所有字段都是工具写的账本，手改会让冲突检测失真；确需重置时删除整个文件即可（等价于"首跑"）。

### 2.1 读取与损坏语义

`readBaseline`（`src/safety/baseline.ts:471-486`）+ `parseBaseline`（`:275-343`）的容错分层：

| 磁盘状态 | 结果 |
| --- | --- |
| 文件不存在（ENOENT） | `null`（没有基线，不报错） |
| 文件在但**读不出**（权限等非 ENOENT 的 IO 错误） | 抛 `PackError code="BASELINE_READ_FAILED"` |
| 内容不是合法 JSON | `null`（按损坏处理） |
| 顶层不是键值对象 / 是数组 | `null` |
| `version` 不是字面量 `1` | `null`（未知结构版本，语义无法保证） |
| 必填字段缺失或类型不符（见 §3） | `null` |
| 条目 / 素材表元素结构不符 | `null` |

> **损坏基线的安全方向是"没有基线"**，而不是让整条写入链路卡死（`src/safety/baseline.ts:45-49`）：调用方按首跑处理、重建即可。基线里 hash 值**只做类型校验不做格式校验**——对比是等值比较，畸形 hash 只会必然不相等（报冲突，安全方向），不会误放行。

---

## 3. 根对象字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `version` | 字面量 `1` | ✅ | 结构版本；`readBaseline` 只认 `1`，其他一律按损坏返回 `null`（§7） |
| `packRoot` | `string` | ✅ | 写入时刻的图包根目录（`path.resolve` 后的**绝对路径**） |
| `updatedAt` | `string` | ✅ | 基线写入时刻（ISO 8601，`new Date().toISOString()`） |
| `lastPushAt` | `string` | 可省略 | 上次**成功 push 完成**时间（ISO 8601）；只由 `touchLastPushAt` 维护（§8） |
| `entries` | `BaselineEntry[]` | ✅ | 各对象的脚本 / UI hash（允许空数组；顺序 = 写入时 states 顺序） |
| `assetFiles` | `Record<string, string>` | ✅ | 素材清单相对路径（正斜杠）→ 内容 sha256（允许空对象，§5） |

> `packRoot` 在**读侧不做一致性校验**：`writeBaseline` 之后把图包整体搬到别的目录，`readBaseline` 照样返回旧 `packRoot`，`diffBaseline` / `detectAssetChanges` 也不会因此报错。它只是"这份基线是谁写的"的溯源字段。

---

## 4. `entries[]` 条目字段

条目类型 `BaselineEntry`（`src/safety/baseline.ts:110-119`）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `guid` | `string` | ✅ | 对象 GUID（**非空**；`"-1"` 为全局脚本 / 全局 UI） |
| `name` | `string` | ✅ | 净化名（`Global` 固定 `"Global"`，其余 `sanitizeName(state.name)`；可空串） |
| `scriptHash` | `string` | 可省略 | 脚本内容归一化后的 sha256 hex；pull 时该对象**没有 `script` 字段**则缺省 |
| `uiHash` | `string` | 可省略 | UI 内容归一化后的 sha256 hex；pull 时该对象**没有 `ui` 字段**则缺省 |

生成规则（`writeBaseline` 第 2 步，`:519-543`）：

- 遍历 `states`（游戏侧快照），**同 guid 先到先得**（重复出现取第一条，与 `diff.ts` 的 `gameByGuid` 一致）；
- `guid` 缺失 / 空串 / 非字符串的 state **跳过**（防御性，协议保证不出现）——否则无法与本地文件对账；
- 缺字段**不记 hash**，与"缺字段即删除"的 push 语义对应：基线与远端"都没记"不算冲突，"一边有另一边没有"算冲突（§9）；
- `name` 取自 pull 落盘文件名里的净化名：`guid === "-1"` 固定 `"Global"`，其余 `sanitizeName(state.name)`（`:259-264`），与 `layout.scriptFileName` 的命名一致。

---

## 5. `assetFiles` 表：素材 hash 集合的覆盖范围

口径为「内容 hash 最严」（用户裁决），**只覆盖以下三类文本清单，不含图片等二进制素材**（`scanAssetFiles`，`src/safety/baseline.ts:403-438`）：

| 覆盖 | 路径（相对 root） | 说明 |
| --- | --- | --- |
| ✅ | `decks/<卡堆目录>/cards.csv` | 只扫 `decks/` 的**一层子目录**（不递归；`readdir` 后 `filter(isDirectory)`，`:419-428`） |
| ✅ | `decks/<卡堆目录>/deck.yaml` | 同上 |
| ✅ | `objects/objects.csv` | 单文件；`objects/` 不存在按无素材处理 |
| ❌ | `decks/**` 下的图片 / 图集 / 其他文件 | 二进制素材不进基线 |
| ❌ | `assets.yaml` / `import.yaml` / `scripts/` / `ui/` | 脚本 / UI 由 `entries[]` 覆盖；其余清单不在本口径内 |
| ❌ | 深层目录（如 `decks/a/b/cards.csv`） | 只扫一层，**不递归** |

- **key 是相对 root 的正斜杠路径**（如 `decks/冒险牌堆/cards.csv`），与平台分隔符无关，保证跨机器可比（`:42-43`）。
- 文件读取（utf8）→ 归一化 → sha256；**文件不存在（ENOENT）跳过、不进表**；其他 IO 错误抛 `BASELINE_ASSET_SCAN_FAILED`（`addAssetFile`，`:376-390`）。
- 输出按 key 的 **UTF-16 码元序**排序（`:434-436`），保证 JSON 序列化跨机器确定。
- 把 `decks/` 或 `objects/` 整个删掉不报错，等价于"没有素材"（`:413-418`）。

---

## 6. hash 算法

### 6.1 sha256（不截断）

`sha256Text`（`src/safety/baseline.ts:225-227`）：

```ts
createHash("sha256").update(text, "utf8").digest("hex")   // 64 字符小写 hex
```

与 `src/pack/import.ts` 的 `shortSha256` **同款算法**，但**不做截断**（那边截前 12 位用于短标识，这边要全量）。

### 6.2 前置归一化：CRLF / 单独 CR → LF，再去掉结尾空白

`normalizeContent`（`src/safety/baseline.ts:215-217`；与 `src/pack/diff.ts` 的同名函数逐字一致）：

```ts
text.replace(/\r\n?/g, "\n").trimEnd()
```

不归一化会把编辑器换行风格 / 结尾空行差异误报成冲突（假冲突），因此**记录 hash 与对比 hash 两侧都先归一化**（`hashOfOptionalText`，`:234-236`）。

实测（Node 24 + 真实模块，2026-10-05）：

| 输入 | sha256 |
| --- | --- |
| `print("hi")\r\n` | `336f365e3407c76220fd9683cb075331635d4b6cfab8a8421f48df0f80c73a13` |
| `print("hi")\n` | `336f365e3407c76220fd9683cb075331635d4b6cfab8a8421f48df0f80c73a13`（同上） |
| `print("hi")`（无结尾换行） | `336f365e3407c76220fd9683cb075331635d4b6cfab8a8421f48df0f80c73a13`（同上） |
| `a\rb`（单独 CR） | `7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78` |
| `a\nb` | `7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78`（同上） |

> **副本约定**：`normalizeContent` 在 `baseline.ts` 与 `diff.ts` 各持一份实现（都未跨模块导出）。仓库既定约定是"小工具函数各模块持有副本"（同 `layout.ts` 的 `sanitizeName`、`push.ts` 的 `errCode`）——**两处如需调整必须同步修改**（`src/safety/baseline.ts:31-35`）。

---

## 7. 版本演化（`version` 字段）

- 当前**只存在 `version: 1`**（`Baseline.version: 1`，`src/safety/baseline.ts:122-135`）。
- `readBaseline` 对非 `1` 的版本**一律返回 `null`**（`parseBaseline`，`:286-288`），没有"按旧结构猜测字段"的路径。
- 升级策略：未来结构变化（增删字段 / 改语义）时递增 `version` 并同步修改 `readBaseline` 与本文档；旧版工具面对新版基线会当作"没有基线"→ 在 pull 时**重建**为当前版本，而不是误用旧语义。
- 这是刻意的安全设计：基线是"我上次确认过什么"的判据，**陈旧的判据比没有判据更危险**（会漏报他人改动）。重建的代价只是一次 pull。

---

## 8. 与 pull / push 的同步语义

### 8.1 调用时序

```text
tts pack pull / hub /v1/scripts/pull
  ├─ 1. 读 pack.yaml、取游戏侧全部 scriptStates、逐对象落盘到 scripts/ ui/
  └─ 2. writeBaseline(root, states)          pull.ts:391
        （失败上抛：脚本 / UI 可能已部分落盘——先写盘后记基线）

tts pack push / hub /v1/push  →  pushSaveAndPlay
  ├─ 3. 拉游戏侧快照（getScripts）
  ├─ 4. readBaseline + detectAssetChanges     push.ts:657-658
  │      └─ 有 changed/added/deleted 且未 --force-scripts-only → PUSH_ASSET_CHANGES_DETECTED
  ├─ 5. diffBaseline(root, remoteStates)      push.ts:669
  │      └─ 有冲突且未 --no-baseline-check → BASELINE_CONFLICT
  ├─ 6-7. 过滤无变化对象 + 强制补齐 script/ui（缺字段 = TTS 删除）
  ├─ 8. dryRun（CLI 默认）：到此为止，**不写基线**
  ├─ 9-12. 备份 → 确认 → saveAndPlay → 回读校验（不一致 → PUSH_VERIFY_FAILED，**基线不更新**）
  └─ 13. writeBaseline(root, 回读快照) + touchLastPushAt(root)   push.ts:723-724
```

### 8.2 读写责任表

| 时机 | 动作 | 谁做 | 依据 |
| --- | --- | --- | --- |
| `pull` 落盘后 | **写**（全量覆盖 `entries` / `assetFiles` / `updatedAt`；保留旧 `lastPushAt`） | `pullFromGame` | `src/pack/pull.ts:391` |
| `push` 前 | **读 + 检测**：`readBaseline` → `detectAssetChanges` → `diffBaseline` | `pushSaveAndPlay` | `src/pack/push.ts:657-669` |
| `push` 成功（回读校验通过）后 | **写**（用**回读快照**，不是发送内容） | `pushSaveAndPlay` | `src/pack/push.ts:723` |
| 紧接着 | **盖章** `lastPushAt = now`（只改这一个字段） | `pushSaveAndPlay` | `src/pack/push.ts:724` |
| `push` dry-run / 被拦截 / 校验失败 | **不写**（基线保持原样） | — | `src/pack/push.ts:681-690`、`:718-720` |

### 8.3 `writeBaseline` 与 `touchLastPushAt` 的分工

- `writeBaseline` **不设置** `lastPushAt`，只在能读到旧值时**保留**它（best-effort 读旧文件，`:545-558`：旧文件不存在 / 损坏 / 读不出都视为无旧值，**不因此中断写入**）。理由：pull 不该抹掉推送史。
- `touchLastPushAt` **只改 `lastPushAt`**，其余字段原样保留（`updatedAt` / `entries` / `assetFiles` 不动，`:697-705`；实测 touch 前后 `updatedAt` 不变）。
- `touchLastPushAt` 在**基线不存在 / 损坏时不创建文件、不报错**（静默返回）；基线存在但读取发生 IO 错误（`BASELINE_READ_FAILED`）原样上抛。

---

## 9. 冲突判定规则（`diffBaseline`）

`src/safety/baseline.ts:596-637`；远端快照的 hash 计算与 `writeBaseline` **完全同款**（归一化 + sha256），因此"内容等价但换行风格不同"不会误报；同 guid 重复出现时先到先得。

| 场景 | 判定 |
| --- | --- |
| 无基线（`readBaseline` 返回 `null`：首跑 / 损坏） | 返回 `[]`，不报错（调用方按首跑流程处理） |
| 基线文件存在但读不出 | `BASELINE_READ_FAILED` 原样上抛 |
| 同 guid，某 kind 两侧 hash 不一致 | **一条冲突**（`missing` 一侧的 hash 字段缺省） |
| 同 guid，某 kind 两侧都缺 hash | 不算冲突（无意义） |
| 同 guid，一边有 hash 一边没有 | **算冲突**（`undefined` 也算一个值） |
| 基线有、远端整个 guid 没有 | 该条目**每个已记录 hash 的 kind** 各一条冲突（`remoteHash` 缺省） |
| 远端多出新 guid（基线没有） | **不算冲突**（新增不是覆盖风险） |

- 冲突结构 `BaselineConflict = {guid, name, kind: "script" | "ui", baselineHash?, remoteHash?}`（`:138-149`）；`name` 取自**基线条目**。
- 返回顺序：按基线条目顺序遍历，同一条目内 `script` 在 `ui` 之前。

### 9.1 素材三向对比（`detectAssetChanges`）

`src/safety/baseline.ts:656-683`；**不读盘上的 baseline.json**——基线由调用方传入（push 流程先 `readBaseline` 再传，避免重复读盘）。

| 场景 | 结果 |
| --- | --- |
| `baseline === null`（没有基线） | `changed: []`、`deleted: []`、`added` = 当前全部素材相对路径（首跑口径：所有素材都"基线没记录"） |
| 两侧都有但 hash 不同 | `changed` |
| 只在磁盘当前存在 | `added` |
| 只在基线里 | `deleted` |

三个数组都按相对路径**码元序**排序。

---

## 10. 完整示例

实测输出（`writeBaseline` 对 3 个对象 + 3 份素材清单落盘的真实结果；`packRoot` / 时间戳按示意替换）：

```json
{
  "version": 1,
  "packRoot": "D:\\packs\\第七大陆",
  "updatedAt": "2026-10-05T13:38:41.252Z",
  "entries": [
    {
      "guid": "-1",
      "name": "Global",
      "scriptHash": "336f365e3407c76220fd9683cb075331635d4b6cfab8a8421f48df0f80c73a13",
      "uiHash": "6238462c4873df4c50bc1a901ece576b2d166b0156802c88a05a85b1f5d511c7"
    },
    {
      "guid": "aa11bb",
      "name": "测试对象",
      "scriptHash": "486d9affb60dbb0063b03d8e23a6ccf6364ce203dc3a9f56f20e750eb41ecade"
    },
    {
      "guid": "cc22dd",
      "name": "OnlyUi",
      "uiHash": "77c22c130511ddebf274dc5f7cd974df8ed2a60408990e87cf57d63bc7392408"
    }
  ],
  "assetFiles": {
    "decks/冒险牌堆/cards.csv": "aca7e28b305fef1074f9d427fd2822467d4b9a53b5caa3650c652326441c39ae",
    "decks/冒险牌堆/deck.yaml": "0a77534ac9ebaa5bbfdfa060414bc5073a4e40e7d58a3ca2915fc89382ee1945",
    "objects/objects.csv": "24aa93a6dee00482b0f5e36d8f9b672ea989a2950a4392d925c17e536733fde6"
  }
}
```

- `guid: "aa11bb"` 只有 `scriptHash`（pull 时该对象没有 `ui` 字段）；`cc22dd` 相反。
- 第 2 / 3 条 `name` 分别来自 `sanitizeName(state.name)`（`测试对象` 原样、`OnlyUi` 原样）。
- 想核验某条 hash 时：把对应文件内容按 §6.2 归一化后算 sha256 即可比对。

完整实例（含 `lastPushAt`）——push 成功过一次之后：

```json
{
  "version": 1,
  "packRoot": "D:\\packs\\第七大陆",
  "updatedAt": "2026-10-05T13:38:41.257Z",
  "lastPushAt": "2026-10-05T13:38:41.263Z",
  "entries": [],
  "assetFiles": {}
}
```

（最小合法文件形如 `entries: []` / `assetFiles: {}`；两者都允许为空。）

---

## 11. API 与错误码

### 11.1 签名（`src/safety/baseline.ts`）

```ts
/** `<root>/.tts/baseline.json` 的完整路径（路径分隔符跟随平台） */
export function baselinePath(root: string): string;

/** 读基线；文件不存在 / 解析失败 / 形状不符一律返回 null（不抛） */
export async function readBaseline(root: string): Promise<Baseline | null>;

/** 扫描素材清单 + 把 states 转成 entries 落盘（updatedAt = now；保留旧 lastPushAt） */
export async function writeBaseline(root: string, states: ScriptState[]): Promise<Baseline>;

/** 游戏侧快照 vs 基线的脚本 / UI hash 逐一比对，返回全部冲突 */
export async function diffBaseline(root: string, remoteStates: ScriptState[]): Promise<BaselineConflict[]>;

/** 素材三向对比（changed / added / deleted）；baseline 传 null 时 added = 当前全部 */
export async function detectAssetChanges(root: string, baseline: Baseline | null): Promise<AssetChanges>;

/** 只盖 lastPushAt 时间戳；基线不存在 / 损坏时静默返回（不建文件） */
export async function touchLastPushAt(root: string): Promise<void>;
```

类型：`Baseline`（§3）、`BaselineEntry`（§4）、`BaselineConflict`（§9）、`AssetChanges`（§9.1）、`PackError`（`src/pack/packyaml.ts:63`）、`ScriptState`（`src/session/scripts.ts`）。

### 11.2 错误码表

| 错误码（`PackError.code`） | 触发条件 | 出现在 |
| --- | --- | --- |
| `BASELINE_READ_FAILED` | baseline.json **存在**但读取发生"不存在"以外的 IO 错误（权限等） | `readBaseline` / `diffBaseline` / `touchLastPushAt`（后两者原样上抛） |
| `BASELINE_WRITE_FAILED` | 写 baseline.json（建目录 / 写文件）失败 | `writeBaseline` / `touchLastPushAt` |
| `BASELINE_ASSET_SCAN_FAILED` | 扫描 / 读取素材清单（`decks/` 目录扫描、`cards.csv` / `deck.yaml` / `objects.csv` 读取）发生"不存在"以外的 IO 错误 | `writeBaseline` / `detectAssetChanges` |

- 上述错误码会沿调用链被 pull / push 原样上抛（`src/pack/pull.ts:61-62`、`src/pack/push.ts:110-112`），经 hub 路由映射为 400 `HUB_PACK_ERROR` + `details.packCode`。
- 入参编程错误不产生 `PackError`：`root` 不是非空字符串、`states` / `remoteStates` 不是数组时抛普通 `Error`（中文消息，调用方 bug；`assertRoot`，`:244-249`）。

### 11.3 本模块新增 i18n 键（`locales/*.json`）

| 键 | 占位符 | 用于 |
| --- | --- | --- |
| `error.baseline.readFailed` | `{path}` `{detail}` | `BASELINE_READ_FAILED` |
| `error.baseline.writeFailed` | `{path}` `{detail}` | `BASELINE_WRITE_FAILED` |
| `error.baseline.assetScanFailed` | `{detail}` | `BASELINE_ASSET_SCAN_FAILED` |

（缺键时 `t()` 原样输出键名，不抛错。）

---

## 12. 已知差异与边界

1. **素材口径不含二进制**：`assetFiles` 只覆盖 §5 的文本清单。图片变化（替换 `decks/<卡堆>/atlas.png`）**不会**被 `detectAssetChanges` 发现——图像改动的影响走 URL / 存档侧，不在本基线职责内。
2. **深层目录不覆盖**：只扫 `decks/` 的一层子目录；若将来支持 `decks/<分类>/<卡堆>/` 两层结构，`scanAssetFiles` 必须同步改造，否则新结构的素材改动会被漏检（`src/safety/baseline.ts:406-428` 明示"只扫一层"）。
3. **`.tts/` 路径写死**：`layout.ts` 的 `DIR_TTS` 常量未导出、且（Run 1 时）模块约定不得修改 `layout.ts`，故 `baselinePath` 按任务书指示拼 `.tts/baseline.json`（`:16-19`、`:444-448`）。若将来 `DIR_TTS` 导出，应改为引用常量，避免两处漂移。
4. **非原子写**：见 §2。截断文件按损坏 → 没有基线处理。
5. **`lastPushAt` 只在 push 成功后更新**：pull、dry-run、被拦截的 push 都不会动它；`writeBaseline` 只保留旧值。因此它的语义是"上次**成功写入**游戏侧的时刻"，不是"上次动基线的时刻"（后者看 `updatedAt`）。
6. **`packRoot` 不参与校验**：见 §3 注。图包整体搬目录后基线仍然可用（hash 与相对路径都不含根路径），只有 `packRoot` 字段是陈旧的溯源信息。
7. **`name` 写入侧不会为空、读取侧却允许空串**：`writeBaseline` 走 `sanitizeName`，空结果回退 `"object"`（`src/pack/layout.ts` 的 `sanitizeName`），所以工具写出的基线里 `name` 恒为非空；但 `parseBaseline` 只校验 `name` 是字符串、**不校验非空**（`:304`），手改文件写出 `"name": ""` 也会被接受（冲突消息里出现空名是可能的）。

---

## 13. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-05 | 初版（阶段 5 Run 2 / 模板化收尾）。契约来自 `src/safety/baseline.ts`（Run 1 实现，本文档窗口未修改）与 `src/pack/pull.ts` / `src/pack/push.ts` 的调用点；hash 样例与落盘格式为本文档窗口用真实模块实测所得（`npx tsx` + Node 24）。 |
