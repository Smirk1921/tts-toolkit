# `deck.yaml` — 卡牌组清单契约

> **本文档由窗口 B1 产出、B2 / Run 2 修订（v1.1），B3 必读。**
>
> 依据：`src/pack/manifest.ts`（Run 1 实现；Run 2 依 B2 主窗口裁决删除 `cards[]`）、`src/pack/unpack.ts:609-620`、`src/pack/layout.ts:214`。
> 适用结构版本：`schema_version: 1`。本文档描述**已实现的真实契约**，不是设想稿。
>
> **v1.1 修订摘要（2026-10-04）**：`cards[]` 字段已删除，卡牌明细迁至同目录的 `cards.csv`（见 `docs/schemas/cards.csv.md`）；`deck.yaml` 只保留牌堆级元数据（`schema_version` / `name` / `guid` / `shared_with` / `atlas`）。

---

## 1. 用途与位置

每个卡牌组一个目录、两份契约文件：

```text
<root>/decks/<卡堆名>/
  deck.yaml     ← 本文件（牌堆级元数据；文件名常量 DECK_YAML_FILENAME，src/pack/manifest.ts:77）
  cards.csv     ← 卡牌明细（每卡一行，含 face/back 与 sheet_* 位置信息；见 docs/schemas/cards.csv.md）
  data.json     ← 该牌堆对象的完整存档数据（由 unpack 落盘；build 用它按 GUID 定点替换）
  card-021.png  ← cards.csv 的 face / back 指向的图片文件（相对本目录）
  ...
```

- 目录换算：`decksDir(root)` → `<root>/decks`（`src/pack/layout.ts:214`）
- 读写入口：`readDeckManifest(deckDir)` / `writeDeckManifest(deckDir, manifest)`（`src/pack/manifest.ts:384`、`:411`）
- 定位键是 GUID，不是目录名：`build.ts` 遍历 `decks/` 下每个子目录时读 `data.json` 的 `GUID` 字段建索引，绝不解析目录名（`src/pack/build.ts:24-26`）。用户可以随意改目录名。
- **本文件不含卡牌明细**：`cards[]` 已于 v1.1 删除（B2 主窗口裁决 2026-10-04）。卡牌以 CardID 为主键落同目录 `cards.csv`，以兑现"Excel 可编辑 + git 逐行 diff"的核心诉求（`方案设计.md` §5.9）。分工见 §4.1。

**严格模式**：根对象与 `atlas` 都用 `z.strictObject`（`src/pack/manifest.ts:120-171`）——**未在字段表中出现的键一律拒绝**。回归用例（`tests/unit/pack-manifest.test.ts:233-234`）锁死：已废弃的 `cards: []` 现在属于未知字段，会导致整份 deck.yaml 读取失败并抛 `DECK_INVALID`。

---

## 2. 字段表

| 字段 | 类型 | 必填 | 默认 | 说明（中文） | Description (EN) |
| --- | --- | --- | --- | --- | --- |
| `schema_version` | 字面量 `1` | ✅ | 无 | 结构版本，本版固定 1；非法值直接拒绝 | Structure version; literal `1` |
| `name` | `string` | ✅ | 无 | 卡堆显示名（用户可见，保持原样不翻译） | Deck display name |
| `guid` | `string`，`^[0-9a-f]{6}$`（不区分大小写） | ✅ | 无 | TTS 对象 GUID，**6 位十六进制**；读取时不做大小写归一，原样保留 | TTS object GUID, 6 hex digits |
| `shared_with` | `string[]` | 可省略 | `[]` | **共享同一图集的其他对象 GUID 列表**；见 §4.2 | GUIDs of other objects sharing the same atlas |
| `atlas` | 对象（严格） | ❌（整块可省） | 无 | 图集布局声明；见 §4.3 | Atlas layout block, optional |
| `atlas.size` | `"512"` \| `"1024"` \| `"2048"` \| `"4096"`，**字符串** | `atlas` 出现时必填 | 无 | 图集边长；**必须带引号**，裸写 `1024` 会被当数字而拒绝 | Atlas edge length, must be a quoted string |
| `atlas.columns` | `number`，整数 `1..10` | `atlas` 出现时必填 | 无 | 图集列数，上限 10 | Atlas columns, max 10 |
| `atlas.rows` | `number`，整数 `1..7` | `atlas` 出现时必填 | 无 | 图集行数，上限 7 | Atlas rows, max 7 |

> 卡牌明细字段（`face` / `back` / `name` / `nickname` / `sheet_id` / `slot` / `sheet_cols` / `sheet_rows` / `sheet_source`）**不在本表**——它们是 `cards.csv` 的列，见 `docs/schemas/cards.csv.md`。

---

## 3. 完整示例

```yaml
schema_version: 1
name: 冒险牌堆
guid: 271fac                 # 游戏内对象 GUID，回写时靠它定位（不是目录名）

shared_with:                 # 共享同一张图集的其他牌堆 GUID；没有就省略或写 []
  - 8be0d1
  - 4c12aa

atlas:                       # 可选块；存在时写入方应保证它与 cards.csv 声明一致（见 §4.3）
  size: "2048"               # 注意引号：字符串，不是数字
  columns: 10                # 1..10
  rows: 7                    # 1..7
```

最小合法示例（`unpack` 生成的牌堆骨架就长这样，`src/pack/unpack.ts:609-620`）：

```yaml
schema_version: 1
name: 冒险牌堆
guid: 271fac
shared_with: []
```

同一个 deck 目录里的 `cards.csv` 负责明细（两者信息互补，**不重复**）：

```csv
card_id,face,back,name,nickname,sheet_id,slot,sheet_cols,sheet_rows,sheet_source
10121,card-021.png,back.png,迷路的旅人,旅人,1,21,10,7,https://img.example.com/sheet-101.png
```

---

## 4. 关键约束说明

### 4.1 卡牌明细在 `cards.csv`（原 `cards[].id` 索引基准问题 —— 已裁决）

- 原 v1.0 曾提出：`cards[].id` 是图集内 **0 基**索引（`0..68`），与 TTS 存档侧 **1 基**槽位号规则（`CardID % 100`）相差一档，需 B2 显式裁决。
- **已裁决（B2 主窗口，2026-10-04）**：**`deck.yaml` 不含 `cards[]`**；卡牌明细由同目录 `cards.csv` 承担。1 基 vs 0 基问题随之**消解**——`cards.csv` 的 `card_id` 直接使用 TTS **完整 CardID**，`slot` 直接使用 **1 基**槽位号（`slot = CardID % 100`，`%100===0` 时记第 100 格）。
- 0 基的 `cards[].id` 方案**不复存在**：任何模块不得再把"0 基 id / 1 基 slot"的换算带到新代码里；`cards.csv` 的完整列定义、校验规则与错误码见 `docs/schemas/cards.csv.md`。
- 回归防线：strictObject 会拒绝残留的 `cards` 键（`tests/unit/pack-manifest.test.ts:233-234`），防止旧格式静默复活。

### 4.2 `shared_with`：共享图集的联动名单

实测存在**一张图集 URL 被多个 `CustomDeck` 引用**的情况（`方案设计.md:1347`）。`shared_with` 就是为这种场景准备的：列出**共享此图集的其他对象 GUID**，避免后续换图集 URL 时只改一边、另一边变成死链。

`deck/patch.ts` / `deck/plan.ts` 的约定用法：

1. 拿到要改 URL 的对象 GUID 后，查其 `deck.yaml` 的 `shared_with`；
2. 展开成完整的引用者集合（本对象 + `shared_with` 全部成员）；
3. **列出全部引用者让用户显式选择**"只改本处 / 全部改"——`方案设计.md:1347` 与 `施工流程.md:231` 都明确要求**不得静默挑一个**；
4. 其余成员的 `shared_with` 应保持对称（互相列出），写入侧由创建 / 切片流程负责维护。

`shared_with` 缺省为 `[]`；schema 只校验它是字符串数组，**不校验元素是否为合法 GUID**——GUID 合法性与"该写没写"的审计由 `deck/verify.ts` 负责：它基于 `.tts/skeleton.json` 的 `FaceURL` 共享关系，检查每个 deck 的 `shared_with` 是否记录了其余共享者 GUID，未记录 → warning `SHARED_ATLAS_NOT_DECLARED`（`src/deck/verify.ts:634-686`）。

### 4.3 `atlas` 可选；当前是**咨询性**元数据（v1.1 更正）

- `atlas` 整块可省（不声明布局的 deck 依然合法，例如 unpack 骨架、或图集尚未生成）。
- 一旦存在，`size` 必须是**带引号的字符串**（`"1024"` 而不是 `1024`），`columns ∈ [1,10]`，`rows ∈ [1,7]`（`src/pack/manifest.ts:120-137`）。裸写数字 `size: 1024` 会被拒绝——这是刻意的，防止 `512`/`2048` 这类值在手改 YAML 时静默变类型。
- ⚠️ **v1.1 更正**：v1.0 曾预告"`deck/verify.ts` 会把图集图片实际尺寸换算后与 `atlas.columns/rows/size` 比对"；**实际落地的实现不是这样**。Run 2 的 `verify` 确实做了网格 ↔ 图片的比对（`ATLAS_GRID_MISMATCH`），但它读的是 **`cards.csv` 的 `sheet_cols` / `sheet_rows` / `sheet_source`**，**不读** `deck.yaml.atlas`（`src/deck/verify.ts:331-483`；grep 确认该文件只使用 `manifest.guid` 与 `manifest.shared_with`，见 `:665-680`）。
- 因此当前契约是：**`cards.csv` 的 `sheet_cols` / `sheet_rows` 是权威声明**（`verify` 校验它与图集实际宽高严格整除一致）；`deck.yaml.atlas` 是咨询性元数据——写入方应保证两者一致，读取方（B3）不要拿它当校验依据。若 B3 要落地 "`atlas` ↔ 图片 / `atlas` ↔ `cards.csv`" 的交叉校验，属于新增校验能力，需先改 `verify.ts`（代码变更，不是文档变更）。
- `atlas` 的可取值与 TTS 图集硬限制对应：单张图集最大 **10 列 × 7 行 = 70 格**（`参考资料/02-数据格式/图集规格与CardID.md:19-27`）。

### 4.4 `face` / `back` 已迁至 `cards.csv`

- v1.0 的 §4.4 描述的是 `deck.yaml` 里的 `face` / `back` 字段："文件名是与图包审批工具的连接键"。
- v1.1 起这两个字段**不属于 `deck.yaml`**（strict 模式会拒绝）：`face` / `back` 是 `cards.csv` 的列。完整约定（审批工具素材 ID = 文件名的零转换连接、改名时必须同步更新列、稳定序号命名建议）随字段迁移到 **`docs/schemas/cards.csv.md` §3.1**。
- 引用"卡片身份"时请认 `cards.csv`，不要在本文件里找 `face`。

### 4.5 存储冲突（S12）—— 已裁决：`cards.csv` 独立存储

- v1.0 记录的冲突 S12 是：`方案设计.md:587`（"卡堆由两个文件描述"）与 §5.9（`:1189`）、`施工流程.md:199`（任务 2B.1b）规划**卡牌明细独立成 `cards.csv`**，而 Run 1 落地的契约把 `cards[]` **内联在 `deck.yaml`** 里，两者并存且不一致。
- **已裁决（B2 主窗口，2026-10-04）**：**`cards.csv` 独立存储**。`deck.yaml` 只保留牌堆级元数据；`manifest.ts` 已删除 `cards[]` 及配套 schema，`unpack` 不再生成 `cards: []` 骨架（提交 `ec0b390`；`src/pack/manifest.ts:150-153`、`src/pack/unpack.ts:609-611`）。
- 冲突不再存在；卡牌明细契约以 `docs/schemas/cards.csv.md` 为准。

### 4.6 其他

- `guid` 必须是 6 位十六进制（不区分大小写），**读取时不做大小写归一**（`src/pack/manifest.ts:25-26`）。`unpack` 对不满足该约束的牌堆 GUID 只落 `data.json`、跳过 `deck.yaml`（`src/pack/unpack.ts:54-56`），因此 `decks/` 下**允许存在没有 `deck.yaml` 的目录**；B2/B3 遍历 `decks/` 时不得假设每个子目录都有清单，`DECK_NOT_FOUND` 要按"跳过并提示"处理而不是中断整包流程（`verify.ts` 的 `loadDecks` 就是静默跳过，`src/deck/verify.ts:253-271`）。
- 读写错误码：`DECK_NOT_FOUND`（文件不存在）/ `DECK_INVALID`（非法 YAML 或不合 schema）/ `DECK_READ_FAILED` / `DECK_WRITE_FAILED`；`writeDeckManifest` 同样**写前重新过 schema**，绝不落盘不合规清单（`src/pack/manifest.ts:411-425`）。
- `deckDir` 传空串或空白字符串会抛普通 `Error`（调用方编程错误），不是 `PackError`（`src/pack/manifest.ts:267-271`）。
- `build.ts` **仍不读 `deck.yaml`**（`BuildResult.decksPatched` 恒为 0，`src/pack/build.ts:711`）；2B 的 deck 流水线（`slice` / `generate` / `inplace` / `plan` / `verify`）独立于 `pack build` 运行，两者暂未接线。

---

## 5. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-04 | 初版 v1.0（窗口 B1 / Run 2 模板化）。契约来自 `src/pack/manifest.ts`，Run 2 未修改该模块。 |
| 2026-10-04 | **v1.1**（B2 主窗口裁决，Run 2 契约文档修订）：① 删除 `cards[]` 字段、配套字段表行与示例，字段表只剩 `schema_version` / `name` / `guid` / `shared_with` / `atlas`；② §4.1 索引基准问题标注**已裁决**（cards.csv 用完整 CardID + 1 基 slot，0 基 `id` 方案作废）；③ §4.5 S12 存储冲突标注**已裁决：cards.csv 独立存储**并指向 `docs/schemas/cards.csv.md`；④ §4.4 `face`/`back` 说明迁至 `cards.csv.md`；⑤ 更正 §4.3：`atlas` 目前无图片交叉校验，`verify` 的网格校验依据是 `cards.csv`；⑥ 行号引用同步到 Run 2 代码（`manifest.ts` 当前行号）。 |
