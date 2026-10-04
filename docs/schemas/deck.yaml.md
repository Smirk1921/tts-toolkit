# `deck.yaml` — 卡牌组清单契约

> **本文档由窗口 B1 产出，B2/B3 必读。**
>
> 依据：`src/pack/manifest.ts`（Run 1 实现，Run 2 未修改）、`src/pack/unpack.ts:608-617`、`src/pack/layout.ts:214-216`。
> 适用结构版本：`schema_version: 1`。本文档描述**已实现的真实契约**，不是设想稿。

---

## 1. 用途与位置

每个卡牌组一个目录、一份清单：

```text
<root>/decks/<卡堆名>/
  deck.yaml    ← 本文件（文件名常量 DECK_YAML_FILENAME，src/pack/manifest.ts:77）
  data.json    ← 该牌堆对象的完整存档数据（由 unpack 落盘；build 用它按 GUID 定点替换）
  001_正面.png ← cards[].face / cards[].back 指向的图片文件（相对本目录）
  ...
```

- 目录换算：`decksDir(root)` → `<root>/decks`（`src/pack/layout.ts:214`）
- 读写入口：`readDeckManifest(deckDir)` / `writeDeckManifest(deckDir, manifest)`（`src/pack/manifest.ts:403`、`:430`）
- 定位键是 GUID，不是目录名：`build.ts` 遍历 `decks/` 下每个子目录时读 `data.json` 的 `GUID` 字段建索引，绝不解析目录名（`src/pack/build.ts:24-26`）。用户可以随意改目录名。

**严格模式**：根对象与每个嵌套对象（`cards[]` 条目、`atlas`）都用 `z.strictObject`（`src/pack/manifest.ts:120-190`）——**未在字段表中出现的键一律拒绝**。实测：`cards[].nick`（拼错 `nickname`）导致整份 deck.yaml 读取失败并抛 `DECK_INVALID`。

---

## 2. 字段表

| 字段 | 类型 | 必填 | 默认 | 说明（中文） | Description (EN) |
| --- | --- | --- | --- | --- | --- |
| `schema_version` | 字面量 `1` | ✅ | 无 | 结构版本，本版固定 1；非法值直接拒绝 | Structure version; literal `1` |
| `name` | `string` | ✅ | 无 | 卡堆显示名（用户可见，保持原样不翻译） | Deck display name |
| `guid` | `string`，`^[0-9a-f]{6}$`（不区分大小写） | ✅ | 无 | TTS 对象 GUID，**6 位十六进制**；读取时不做大小写归一，原样保留 | TTS object GUID, 6 hex digits |
| `shared_with` | `string[]` | 可省略 | `[]` | **共享同一图集的其他对象 GUID 列表**；见 §4.2 | GUIDs of other objects sharing the same atlas |
| `cards` | 卡牌条目数组 | ✅ | 无（**可以是空数组** `[]`） | 卡牌明细；unpack 生成的骨架就是 `cards: []` | Card entries; empty array is legal |
| `cards[].id` | `number`，整数 `0..68` | ✅ | 无 | **图集内索引**；见 §4.1 | Index inside the atlas sheet |
| `cards[].face` | `string` | ✅ | 无 | 正面图片**文件名（相对本 deck 目录）**；见 §4.4 | Front image file name, relative to this deck dir |
| `cards[].back` | `string` | 可省略 | 无（省略=用牌堆默认背面） | 自定义背面文件名（相对本 deck 目录） | Optional back image file name |
| `cards[].name` | `string` | 可省略 | 无 | 卡牌显示名 | Card display name |
| `cards[].nickname` | `string` | 可省略 | 无 | 卡牌别名（TTS 的 `Nickname`） | Card nickname |
| `atlas` | 对象（严格） | ❌（整块可省） | 无 | 图集布局声明；见 §4.3 | Atlas layout block, optional |
| `atlas.size` | `"512"` \| `"1024"` \| `"2048"` \| `"4096"`，**字符串** | `atlas` 出现时必填 | 无 | 图集边长；**必须带引号**，裸写 `1024` 会被当数字而拒绝 | Atlas edge length, must be a quoted string |
| `atlas.columns` | `number`，整数 `1..10` | `atlas` 出现时必填 | 无 | 图集列数，上限 10 | Atlas columns, max 10 |
| `atlas.rows` | `number`，整数 `1..7` | `atlas` 出现时必填 | 无 | 图集行数，上限 7 | Atlas rows, max 7 |

---

## 3. 完整示例

```yaml
schema_version: 1
name: 冒险牌堆
guid: 271fac                 # 游戏内对象 GUID，回写时靠它定位（不是目录名）

shared_with:                 # 共享同一张图集的其他牌堆 GUID；没有就省略或写 []
  - 8be0d1
  - 4c12aa

cards:
  - id: 0                    # 图集内索引（0..68）
    face: 001_正面.png        # 相对本 deck 目录的文件名 ← 与审批工具的连接键
    back: 001_背面.png        # 省略则用牌堆默认背面
    name: 迷路的旅人
    nickname: 旅人
  - id: 1
    face: 002_正面.png
    name: 沉睡的神祇
  - id: 2
    face: 003_正面.png

atlas:                       # 可选块；存在时 B2 必须校验它与图片实际尺寸一致
  size: "2048"               # 注意引号：字符串，不是数字
  columns: 10                # 1..10
  rows: 7                    # 1..7
```

最小合法示例（unpack 生成的牌堆骨架就长这样）：

```yaml
schema_version: 1
name: 冒险牌堆
guid: 271fac
shared_with: []
cards: []
```

---

## 4. 关键约束说明

### 4.1 `cards[].id` 是图集内索引（0–68）

- 实现上就是整数 `0..68` 的闭区间校验（`src/pack/manifest.ts:120-133`）；实测 `0` 与 `68` 通过，`69` 与 `-1` 被拒。
- 上界 68 与 TTS 的硬限制对应：单张图集最大 **10 列 × 7 行 = 70 格**，其中最后一格（第 70 格）被官方约定用作"隐藏面"（`参考资料/02-数据格式/图集规格与CardID.md:22`、`:26`）。
- ⚠️ **索引基准需要 B2 显式裁决并写进自己的文档**：TTS 存档侧真正的槽位号规则是 `CardID % 100`，**从 1 开始**、行优先（`参考资料/02-数据格式/图集规格与CardID.md:74-77`），且 `CustomDeck` 的 key = `floor(CardID / 100)`。本契约的 `id` 是 0 基索引，两者相差一档。`deck/patch.ts` / `deck/inplace.ts` 在做"id → 槽位"或"CardID → id"换算时**必须显式写死这个偏移并有测试覆盖**，不要靠直觉。若 B2 决定改判基准，属于 schema 变更，须先改 `manifest.ts` 与本文档，不得只在 B2 内部转换。
- `id` 只表示"在本图集里的位置"，**不是** TTS 的 `CardID`，也不要求在一个 deck 内连续。

### 4.2 `shared_with`：共享图集的联动名单（B2 的 `deck/patch.ts` 要用）

实测存在**一张图集 URL 被多个 `CustomDeck` 引用**的情况（`方案设计.md:1341`）。`shared_with` 就是为这种场景准备的：列出**共享此图集的其他对象 GUID**，避免后续换图集 URL 时只改一边、另一边变成死链。

`deck/patch.ts` 的约定用法：

1. 拿到要改 URL 的对象 GUID 后，查其 `deck.yaml` 的 `shared_with`；
2. 展开成完整的引用者集合（本对象 + `shared_with` 全部成员）；
3. **列出全部引用者让用户显式选择**"只改本处 / 全部改"——`方案设计.md:1341` 与 `施工流程.md` 的 2B.3 都明确要求**不得静默挑一个**；
4. 其余成员的 `shared_with` 应保持对称（互相列出），写入侧由创建/切片流程负责维护。

`shared_with` 缺省为 `[]`；schema 只校验它是字符串数组，**不校验元素是否为合法 GUID、也不校验对称性**——这是 B2 侧 `deck/verify.ts` 的事。

### 4.3 `atlas` 可选；若存在必须与图集图片实际尺寸匹配

- `atlas` 整块可省（不声明布局的 deck 依然合法，例如 unpack 骨架、或图集尚未生成）。
- 一旦存在，`size` 必须是**带引号的字符串**（`"1024"` 而不是 `1024`），`columns ∈ [1,10]`，`rows ∈ [1,7]`（`src/pack/manifest.ts:142-159`）。实测裸写数字 `size: 1024` 被拒绝——这是刻意的，防止 `512`/`2048` 这类值在手改 YAML 时静默变类型。
- ⚠️ **本契约目前没有任何代码校验"atlas 声明的行列/边长与图集图片真实像素是否一致"**：
  - `manifest.ts` 模块头注释（`:28-30`）说该职责"留给 `pack/build.ts`"，但 **Run 1 的 `build.ts` 并不读 `deck.yaml`**——它只索引 `decks/<name>/data.json`，且 `BuildResult.decksPatched` 恒为 0（`src/pack/build.ts:60-62`）。
  - 因此**这个校验目前是空的**，`deck/verify.ts`（阶段 2B）是第一处真正落地它的地方：读图集图片实际宽高 → 换算期望行列 → 与 `atlas.columns/rows/size` 比对，不符必须报错，**不允许悄悄改变图集大小**（`方案设计.md` §5.10 的原位拼回约束）。

### 4.4 `face` 字段是与"图包审批工具"的连接键 ★

- `face`（以及可选的 `back`）是**文件名**，相对本 deck 目录，例如 `001_正面.png`。schema 只校验它是字符串，**不校验文件是否存在、不校验是否含路径分隔符**。
- 连接原理：图包审批工具的素材 ID **就是文件名**（`方案设计.md:1964`），而本工具的 `face` 也是文件名，两边的"卡片身份"天然同一，**零转换**。把审批工具的两个源目录（旧版 / 新版渲染目录）指向 `packs/<包>/decks/<卡堆>/`，配置 `pair: basename` 即可直接跑审批（`方案设计.md:1966`）。注意 `方案设计.md` 的 CSV 方案里这一列叫 `front`，本契约里叫 `face`，指同一个东西。
- 因此 **B2 修改 `face` 的取值时必须把它当成对外标识**：批量重命名图片文件时，`face` 字段必须同步更新；只改文件名不改字段会让审批结果与卡片对不上号（审批结果里的 `src` 是源文件指纹，可用于判断结果是否过期）。
- 建议（不是当前强制）：图片文件保留 `NNN_正面.png` 这类**稳定序号命名**，把"卡片叫什么"放在 `name` / `nickname` 里，避免渲染批次改变文件名而破坏审批侧的历史记录。

### 4.5 其他

- `guid` 必须是 6 位十六进制（不区分大小写），**读取时不做大小写归一**（`src/pack/manifest.ts:22-24`）。`unpack` 对不满足该约束的牌堆 GUID 只落 `data.json`、跳过 `deck.yaml`（`src/pack/unpack.ts:54-56`），因此 `decks/` 下**允许存在没有 `deck.yaml` 的目录**；B2/B3 遍历 `decks/` 时不得假设每个子目录都有清单，`DECK_NOT_FOUND` 要按"跳过并提示"处理而不是中断整包流程。
- 读写错误码：`DECK_NOT_FOUND`（文件不存在）/ `DECK_INVALID`（非法 YAML 或不合 schema）/ `DECK_READ_FAILED` / `DECK_WRITE_FAILED`；`writeDeckManifest` 同样**写前重新过 schema**，绝不落盘不合规清单。
- `deckDir` 传空串或空白字符串会抛普通 `Error`（调用方编程错误），不是 `PackError`。
- ⚠️ **已知未决冲突（S12），B2 动工前需主窗口裁决**：`方案设计.md:581` 与 `施工流程.md` 任务 2B.1b 规划的是**卡牌明细独立成 `cards.csv`（以 CardID 为主键，含 `sheet_id`/`slot`/`sheet_cols`/`sheet_rows`/`sheet_source`）**，`deck.yaml` 只放卡堆级信息；而 Run 1 落地的契约把 `cards[]` 放在了 `deck.yaml` 里、并用 `atlas` 表达布局（`src/pack/manifest.ts:175-190`）。**两者目前并存且不一致**：本文档描述的是**代码里真实生效的**那一份，B2 不得同时实现两套存储而不作说明；建议在 2B 开工前把差异提给主窗口（或写入 `需求确认.md`），确定是"deck.yaml 内联"还是"cards.csv 独立"后，同步更新本文档与 `manifest.ts`。

---

## 5. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-04 | 初版（窗口 B1 / Run 2 模板化）。契约来自 `src/pack/manifest.ts`，Run 2 未修改该模块。 |
