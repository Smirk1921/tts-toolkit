# `cards.csv` — 卡牌明细表契约

> **本文档由 B2 / Run 2 产出，B3 与后续窗口必读。**
>
> 依据：`src/deck/cards.ts`（Run 1 实现，Run 2 未修改）、`src/deck/cardid.ts`（CardID ↔ slot 换算的**单一实现**）。
> 适用结构版本：`schema_version: 1`（CSV 文件本身没有版本列；列定义变更等同改契约，见 §13）。
> **裁决背景**：B2 主窗口 2026-10-04 决定——卡牌明细不在 `deck.yaml`，全部由本文件承担（`deck.yaml` 已删除 `cards[]`，见 `docs/schemas/deck.yaml.md` §4.1 / §4.5）。本文档描述**已实现的真实契约**，不是设想稿。

---

## 1. 用途与文件位置

`cards.csv` 是**卡牌明细的唯一权威存储**：每张卡一行，自描述"这张卡是谁、在哪张图集、哪个格子、来源图集是什么"。它是阶段 2B 四条 deck 流水线的共同枢纽：

| 流程 | 与 cards.csv 的关系 |
| --- | --- |
| `tts deck slice` | 切片时从存档的 `CustomDeck` / `DeckIDs` 读出归属，**写入**（`src/deck/slice.ts:80-88`） |
| `tts deck generate` | 重新排版拼接的**输入 + 回写**（重排后更新 `sheet_id` / `slot` / `sheet_cols` / `sheet_rows`，`src/deck/generate.ts:426-441`） |
| `tts deck inplace` | 原位拼回的**定位依据**（按 `sheet_id` / `slot` 放回原位，**不改写**本文件，`src/deck/inplace.ts:8`） |
| `tts deck verify` | 明细源：网格一致性、卡数容量、CardID 匹配、CMYK 等检查都以它为准（`src/deck/verify.ts:8-29`） |

位置与命名：

```text
<packRoot>/decks/<deckName>/
  deck.yaml     ← 牌堆级元数据（显示名 / GUID / shared_with / atlas；不含卡牌明细）
  cards.csv     ← 本文件（文件名常量 CARDS_CSV_FILENAME = "cards.csv"，src/deck/cards.ts:115）
  card-021.png  ← cards.csv 的 face 列指向的卡图（相对本 deck 目录）
  back.png      ← cards.csv 的 back 列指向的自定义背面（相对本 deck 目录）
  ...
```

- 每个 deck 目录**至多一份** `cards.csv`；**允许不存在**（未切片 / 未登记的牌堆只有 `deck.yaml` 骨架）：`readCardsCsv` 抛 `CARDS_NOT_FOUND`，由调用方决定"跳过"还是"报错"。
- 目录换算：`decksDir(root)` → `<packRoot>/decks`（`src/pack/layout.ts:214`）；`deckDir` 传 `<packRoot>/decks/<deckName>` 本身（**不是** `decks/` 根）。
- 读写入口：`readCardsCsv(deckDir)` / `writeCardsCsv(deckDir, rows)`（`src/deck/cards.ts:548`、`:578`）。
- 结构类型：`CardRow`（`src/deck/cards.ts:139-160`），解析后的属性是 camelCase（`cardId` / `sheetId` / `sheetCols` / `sheetRows` / `sheetSource`）。

---

## 2. 文件格式

- **CSV（逗号分隔）**，字段分隔符恒为 ASCII `,`。
- **首行必须是表头**，列名与列序**写死**（见 §3）；读时逐列精确比对——多列、少列、换序、改名都拒绝（`CARDS_INVALID`）。
- **编码：UTF-8 带 BOM**；**换行：LF**（`\n`）；文件总是以 **trailing newline** 结束（写侧；读侧容忍有无）。
- 数值列（`card_id` / `sheet_id` / `slot` / `sheet_cols` / `sheet_rows`）在文件里是**整数字面量**：读侧只接受 `^\d+$`，拒绝空串、负号、小数点、十六进制、指数形式；前导零宽容（`"007"` → `7`）（`src/deck/cards.ts:439-444`）。
- 可选列（`back` / `name` / `nickname`）**空字符串 = 缺省**；写侧 `undefined` 写作空字段，读侧空字段还原为 `undefined`（往返稳定）。

---

## 3. 列定义

列顺序**严格固定**（`CARDS_COLUMNS`，`src/deck/cards.ts:121-124`）：

| 列名 | 类型 | 必填 | 对应 `CardRow` 属性 | 说明 |
| --- | --- | --- | --- | --- |
| `card_id` | number | ✅ | `cardId` | TTS 完整 **CardID**（`key × 100 + slot`，如 `10121`）；主键，全表唯一，正整数 |
| `face` | string | ✅ | `face` | 正面图片**文件名（相对本 deck 目录）**；不能为空字符串。`slice` 产出 `card-<slot:03d>.png`（3 位补零，如 `card-021.png`） |
| `back` | string | 可省 | `back?` | 自定义背面**文件名（相对本 deck 目录）**；空 = 该卡无自定义背面，回退牌堆默认背面。`slice` 产出 `back.png`（UniqueBack=false）或 `back-<slot:03d>.png`（UniqueBack=true） |
| `name` | string | 可省 | `name?` | 卡牌显示名（如 `迷路的旅人`） |
| `nickname` | string | 可省 | `nickname?` | TTS 的 `Nickname`（卡牌别名） |
| `sheet_id` | number | ✅ | `sheetId` | **图集编号（1 基）**，同一 deck 多张图集时区分；`slice` 恒写 `1`，`generate` 重排时按 `card_id` 的 slot 连续段从 1 连续递增（`src/deck/generate.ts:24-35`） |
| `slot` | number | ✅ | `slot` | **图集内格子序号（1 基）**，必须 `== cardIdToSlot(card_id)`（`%100==0` 时记 100，见 §7）；必须落在 `[1, sheet_cols × sheet_rows]` |
| `sheet_cols` | number | ✅ | `sheetCols` | 该图集**列数**，整数 ∈ `[1, 10]` |
| `sheet_rows` | number | ✅ | `sheetRows` | 该图集**行数**，整数 ∈ `[1, 7]` |
| `sheet_source` | string | ✅ | `sheetSource` | **源图集 URL 或本地路径**（追溯用）；不能为空字符串。`slice` 原样保留存档里的 `FaceURL`（含 `{lang}` 变体形式，不做任何解析） |

> `sheet_cols` / `sheet_rows` / `sheet_source` 在同一 `sheet_id` 的每行**重复存储**——这是有意的反范式，换来"每行自足"（只看一行就知道该卡该放哪张图集、什么网格、哪个格子），`inplace` 原位拼回正是靠它成立。同一 `sheet_id` 的各行应声明**完全相同**的网格与来源；行间声明矛盾会被 `verify` 报 `ATLAS_GRID_MISMATCH`（`src/deck/verify.ts:62-66`）。

### 3.1 `face` 是与"图包审批工具"的连接键 ★

- `face`（以及可选的 `back`）是**文件名**，相对本 deck 目录，例如 `card-021.png`。`cards.ts` 只校验它是非空字符串，**不校验文件是否存在、不校验是否含路径分隔符**。
- 连接原理：图包审批工具的素材 ID **就是文件名**（`方案设计.md:1973`），而本工具的 `face` 也是文件名，两边的"卡片身份"天然同一，**零转换**：把审批工具的两个源目录（旧版 / 新版渲染目录）指向 `decks/<卡堆名>/`，配置 `pair: basename` 即可直接跑审批（`方案设计.md:1975`）。
- ⚠️ 因此**批量重命名卡图文件时必须同步更新 `face` 列**；只改文件名不改列会让审批结果与卡片对不上号。建议（非强制）图片文件保留 `card-NNN.png` 这类**稳定序号命名**，把"卡片叫什么"放在 `name` / `nickname` 里。
- 历史口径提醒：`方案设计.md` §5.9 草稿里这一列叫 `front`，实现契约里叫 `face`，指同一个东西。

---

## 4. 校验规则与错误码

`readCardsCsv` 与 `writeCardsCsv` 共用同一套校验（`validateRow` / `validateRows`，`src/deck/cards.ts:292-385`）。**写侧先全量校验、不过绝不落盘（连目录都不创建）**（`src/deck/cards.ts:578-591`）。

### 4.1 单行校验（严格按序，一行同时踩多条时只抛**最先命中**的码）

| # | 规则 | 违规错误码 |
| --- | --- | --- |
| 1 | `card_id` 必须是正整数 | `CARDS_INVALID` |
| 2 | `sheet_id` 必须是不小于 1 的整数 | `CARDS_INVALID` |
| 3 | `sheet_cols ∈ [1,10]` 且 `sheet_rows ∈ [1,7]` | `CARDS_INVALID_GRID` |
| 4 | `slot` 必须是整数（非整数 → `CARDS_INVALID`）；且必须 `== cardIdToSlot(card_id)` | `CARDS_SLOT_MISMATCH` |
| 5 | `slot ∈ [1, sheet_cols × sheet_rows]` | `CARDS_SLOT_OUT_OF_RANGE` |
| 6 | `face` 不能为空字符串 | `CARDS_INVALID` |
| 7 | `sheet_source` 不能为空字符串 | `CARDS_INVALID` |

### 4.2 跨行校验

| # | 规则 | 违规错误码 |
| --- | --- | --- |
| 8 | `card_id` 全表唯一 | `CARDS_DUPLICATE_ID` |
| 9 | 同一 `sheet_id` 内 `slot` 不重复（**不同** `sheet_id` 的相同 `slot` 合法——每张图集各有自己的第 1 格） | `CARDS_DUPLICATE_SLOT` |

### 4.3 结构层（读侧，`src/deck/cards.ts:495-527`）

空文件 / 表头列名或列序不符 / 数据行列数 ≠ 10 / 数值列不是整数字面量 → 一律 `CARDS_INVALID`。

### 4.4 全部 9 个 PackError 错误码

`PackError` 来自 `src/pack/packyaml.ts`；CLI 按 `` `error.${code}` `` 取文案，**按 code 分支，不要解析 message 文本**。模块自身的默认 i18n 键（`locales/zh-CN.json` 与 `en-US.json` 已镜像提供）：

| 错误码 | 触发条件 | 模块消息 i18n 键 |
| --- | --- | --- |
| `CARDS_NOT_FOUND` | `<deckDir>/cards.csv` 不存在 | `error.pack.cardsNotFound` {path} |
| `CARDS_READ_FAILED` | 读取时发生"文件不存在"以外的 IO 错误 | `error.pack.cardsReadFailed` {path} {detail} |
| `CARDS_WRITE_FAILED` | 写入时发生 IO 错误 | `error.pack.cardsWriteFailed` {path} {detail} |
| `CARDS_INVALID` | 结构非法，或单行规则 1 / 2 / 6 / 7 违规、`slot` 非整数 | `error.pack.cardsInvalid` {detail} |
| `CARDS_DUPLICATE_ID` | `card_id` 重复（规则 8） | `error.pack.cardsDuplicateId` {cardId} {firstRow} {dupRow} |
| `CARDS_SLOT_MISMATCH` | `slot` 是整数但不等于 `cardIdToSlot(card_id)`（规则 4） | `error.pack.cardsSlotMismatch` {row} {cardId} {slot} {expected} |
| `CARDS_SLOT_OUT_OF_RANGE` | `slot > sheet_cols × sheet_rows`（规则 5） | `error.pack.cardsSlotOutOfRange` {row} {slot} {max} |
| `CARDS_INVALID_GRID` | `sheet_cols` / `sheet_rows` 越界（规则 3） | `error.pack.cardsInvalidGrid` {row} {sheetCols} {sheetRows} |
| `CARDS_DUPLICATE_SLOT` | 同一 `sheet_id` 内 `slot` 重复（规则 9） | `error.pack.cardsDuplicateSlot` {sheetId} {slot} {firstRow} {dupRow} |

> **行号口径**：错误消息里的"第 N 行"指**数据行序号**（1 基，跳过表头与空行后的第几条数据），**不是文件物理行号**——`name` 等字段内嵌换行时两者不等（`src/deck/cards.ts:69-70`）。

### 4.5 已知的"数学必然"（不是 bug）

`card_id` 为 100 的整数倍（如 `10100`）时 `slot` 换算为 **100**，能通过规则 4，但图集硬上限 **10 × 7 = 70 < 100**，必然卡在规则 5 → 报 `CARDS_SLOT_OUT_OF_RANGE`（而不是 `CARDS_SLOT_MISMATCH`）。这是 1 基规则 + 容量规则的数学必然，测试有专门用例守着（`src/deck/cards.ts:32-35`）。

---

## 5. CSV 转义

- **写侧**：字段含逗号 `,`、双引号 `"`、`\r`、`\n` 时，整体用双引号包围，内部双引号翻倍为 `""`；其余字段保持裸（git diff 友好）（`src/deck/cards.ts:278-280`）。
- **读侧**：引号内逗号 / 换行 / `""` 转义都正确还原；未加引号字段中部的裸引号按字面量宽容处理（Excel 不会产出，手改文件尽量救回）（`src/deck/cards.ts:221-228`）。
- 解析器是模块内手写的约 35 行状态机（`in_quotes` / 双引号翻倍），**不引入 papaparse 等新依赖**（契约明确要求）。

示例（`name` 含逗号、`sheet_source` 含引号时；含表头，可直接另存为文件）：

```csv
card_id,face,back,name,nickname,sheet_id,slot,sheet_cols,sheet_rows,sheet_source
10121,card-021.png,,迷路的旅人,旅人,1,21,10,7,https://img.example.com/sheet-101.png
10130,card-030.png,,"沉睡的神祇, 初版",,1,30,10,7,"https://img.example.com/sheet-""特别""版.png"
```

---

## 6. 编码与读取宽容细节

写侧（`serializeCardsCsv`，`src/deck/cards.ts:417-423`）：

- 首字符 `\ufeff`（UTF-8 BOM，Excel 识别中文的关键）；
- 每行以 `\n` 结尾，**总 trailing newline**；全程不写 `\r\n`。

读侧（`parseCardsCsvText`，`src/deck/cards.ts:495-527`）宽容处理：

| 情况 | 行为 |
| --- | --- |
| 开头有 / 无 BOM | 都接受（有则剥离） |
| 换行 CRLF / LF / 裸 `\r` | 都按换行处理（CRLF 算一个） |
| 末尾 trailing newline 有 / 无 | 都接受 |
| 数据行之间的空行 | 跳过，不计行号、不报错 |
| 引号内的换行 | 原样保留在字段值内 |

> 读回的行**保持文件顺序，不排序**；排序 / 去重由调用方决定。

---

## 7. 索引基准：CardID 与 1 基 slot（关键坑）

TTS 的编号规则（【实测】，`参考资料/02-数据格式/图集规格与CardID.md:74-77`）：

```text
CustomDeck 的 key = floor(CardID / 100)     （字符串形式，如 "101"）
slot              = CardID % 100            （行优先：左→右、上→下）
                    %100 === 0 时按 TTS 约定记第 100 格 → 100（不是 0）
```

本契约的裁决（写死防回退）：

1. **`card_id` 列直接存 TTS 完整 CardID**（如 `10121`）——**不是**某个 0 基索引，也**不是**图集内序号。
2. **`slot` 全程 1 基**：`slot = cardIdToSlot(card_id)`（`src/deck/cardid.ts:161-165`），`%100==0 → 100`；`10121 → 21`，`10100 → 100`。
3. **`card_id` 不重新分配**：真实图包的 CardID 继承自上游、范围可能很大（实测 1,700–176,710），`key` 会是 42–1767 这种值——重新编号会让回写存档对不上（`参考资料/02-数据格式/图集规格与CardID.md:87-98`）。
4. `card_id` 只要求正整数与全表唯一，**不要求连续**；同一 `key` 段内 `slot` 连续是常见形态但非强制。
5. 项目内**不允许**再出现第二套基准：`deck.yaml` 旧的 `cards[].id`（0 基，0..68）已随 B2 裁决删除，**不要做任何 0 基 ↔ 1 基的隐式换算**。项目的格点坐标 `(col, row)` 是 0 基（`slotToGrid` / `gridToSlot`，`src/deck/cardid.ts:197-224`），CSV 里永远写 1 基 slot。
6. 编码固有性质（非 bug）：`slot = 100` 时 `key` 往返会加一（`slotToCardId("101", 100) === 10200`，读回 `key "102"`）；正常网格上限 70 格，永远落在无损区间 `[1, 99]`（`src/deck/cardid.ts:36-41`）。

---

## 8. Excel 兼容性

- **BOM 是给 Excel 的**：不带 BOM 的 UTF-8 CSV 在中文 Windows 的 Excel 里会直接乱码；写侧无条件带 BOM。
- **LF 换行**：Excel 读得懂；Excel 另存时会写成 CRLF，读侧容忍（§6），往返不报错。
- **逗号分隔是 Excel 默认**；卡名 / 路径含逗号时由 §5 的转义规则正确处理，Excel 显示与编辑无感。
- 手改时的红线：**保留表头与列序、不要加列**（表头比对失败即 `CARDS_INVALID`）；空值**留空**，不要写 `null` / `N/A`（那会被当成字面量字符串）。
- 数字列请写纯数字（Excel 可能把 `10121` 存成科学计数法或加千分位——出现这种行会在读侧报 `CARDS_INVALID`，改回纯数字即可）。

---

## 9. 完整示例

可直接复制使用的 5 行样例（含表头；每行都满足 §4 全部规则：`101 × 100 + 21 = 10121`，slot 与容量 10×7 均匹配）：

```csv
card_id,face,back,name,nickname,sheet_id,slot,sheet_cols,sheet_rows,sheet_source
10121,card-021.png,back.png,迷路的旅人,旅人,1,21,10,7,https://cloud-3.steamusercontent.com/ugc/1234567890/ABCDEF0123456789.png
10122,card-022.png,back.png,沉睡的神祇,,1,22,10,7,https://cloud-3.steamusercontent.com/ugc/1234567890/ABCDEF0123456789.png
10123,card-023.png,back.png,古老遗迹,遗迹,1,23,10,7,https://cloud-3.steamusercontent.com/ugc/1234567890/ABCDEF0123456789.png
10124,card-024.png,,深林小径,,1,24,10,7,https://cloud-3.steamusercontent.com/ugc/1234567890/ABCDEF0123456789.png
10125,card-025.png,,,断桥残垣,1,25,10,7,https://cloud-3.steamusercontent.com/ugc/1234567890/ABCDEF0123456789.png
```

> 第 4 / 5 行 `back` 留空 = 这两张卡无自定义背面（合法；`slice` 在 UniqueBack=false 且本地找不到背面图时会这样降级，`src/deck/slice.ts:69-72`）。

多图集示例（同一 deck 两张图集，`sheet_id` 从 1 连续编号；**不同 sheet 的相同 slot 合法**，但同一 sheet 内 slot 不得重复）：

```csv
card_id,face,back,name,nickname,sheet_id,slot,sheet_cols,sheet_rows,sheet_source
10169,card-069.png,back.png,第六十九张,,1,69,10,7,https://img.example.com/sheet-A.png
10170,card-070.png,back.png,第七十张,,1,70,10,7,https://img.example.com/sheet-A.png
10201,card-001.png,back.png,跨段新图集第一张,,2,1,10,7,https://img.example.com/sheet-B.png
10202,card-002.png,back.png,跨段新图集第二张,,2,2,10,7,https://img.example.com/sheet-B.png
```

> 关键约束：`slot` 与 `card_id` **绑定**，拆图集**不允许**重编号。单张图集容量上限 10×7 = 70，因此 `card_id % 100 ∈ {0} ∪ [71, 99]` 的值在本格式里**不可表示**（其 slot 必然越过容量 → `CARDS_SLOT_OUT_OF_RANGE`）。跨图集靠 TTS 的 key 进位：`10101..10170` 是 key `"101"` 的第 1..70 格，下一张图集的卡是 `10201..10270`（slot 回到 1）。`generate` 正是按这一 "slot 连续段" 的容量边界找切分点（`src/deck/generate.ts:24-35`）。

---

## 10. 读写 API 与调用约定

| API | 行为 | 抛错 |
| --- | --- | --- |
| `readCardsCsv(deckDir)` | 读 + 剥 BOM + 解析 + **全量校验**，返回按文件顺序的 `CardRow[]` | §4.4 全部 9 码（结构 / 单行 / 跨行）；文件不存在 → `CARDS_NOT_FOUND` |
| `writeCardsCsv(deckDir, rows)` | **写前全量校验**（不过绝不落盘、不建目录）→ BOM + 表头 + LF 行 + trailing newline；`deckDir` 不存在时逐级创建 | §4.4 除 `CARDS_NOT_FOUND` / `CARDS_READ_FAILED` 外的全部；写入 IO 错误 → `CARDS_WRITE_FAILED` |

- 错误统一为 `PackError`，带机器可读 `code`；**按 code 分支**，不要匹配 message。
- 写侧**不做部分写入**：任何一行不合规，文件保持原样；`generate` 把 `cards.csv` 的重写放在整个流程的最后一步，也是同一考虑（`src/deck/generate.ts:49-55`）。
- `deckDir` 传空串 / 空白字符串不会走到本模块——`readCardsCsv` / `writeCardsCsv` 本身不校验路径参数（cards.ts 无 `assertDirPath`），调用方（CLI）负责保证是非空路径。

---

## 11. 相关契约

- `docs/schemas/deck.yaml.md` — 同一 deck 目录的牌堆级元数据；`cards[]` 已删除的裁决记录。
  - ⚠️ 注意分工：`deck.yaml.atlas` 是**声明**，`cards.csv` 的 `sheet_cols` / `sheet_rows` 是**实际依据**；截至 Run 2，`verify` 只校验后者与实际图片的一致性（`ATLAS_GRID_MISMATCH`），**没有**代码交叉比对 `atlas.columns/rows/size` 与 cards.csv 声明（`src/deck/verify.ts` 的网格检查只读 cards 行）。
- `docs/schemas/objects.csv.md` — 同构的非卡牌素材台账（无图集概念）。
- `src/deck/cardid.ts` — CardID / key / slot / 格点坐标换算的**唯一实现**，任何模块不得自建第二套。
- `src/deck/generate.ts` / `src/deck/inplace.ts` / `src/deck/slice.ts` / `src/deck/verify.ts` — 四个生产者 / 消费者。
- `参考资料/02-数据格式/图集规格与CardID.md` — CardID 规则的原始实测依据（§3、§6）。

---

## 12. 已知差异与待决事项

1. **与 `方案设计.md` §5.9 草稿的差异（已按实现落定）**：设计草稿的 cards.csv 列还包含 `type` / `front` / `origin_card_id` / `origin_pack`（`方案设计.md:1191-1204`）；**实现契约没有这些列**——`face` 取代了 `front`（见 §3.1），本表只收卡牌故无 `type`，上游 CardID 溯源字段未落地（卡牌来源追溯目前靠 `sheet_source` + git 历史）。B3 若需要新增列，属于 **schema 变更**：先改 `src/deck/cards.ts` 与本文档，不得只往 CSV 里加列。
2. **`sheet_source` 的存在性不由本模块保证**：`cards.ts` 只校验非空，不检查 URL 可达或本地文件存在；`verify` 负责 `SHEET_SOURCE_MISSING`（按 `sheet_source` 解析图集文件：`file:` URL / 绝对路径 / 相对 deckDir / 相对 packRoot → 兜底 `<deckDir>/source/sheet-<sheetId>.png`，`src/deck/verify.ts:15-18`）。
3. **跨文件一致性不在本模块**：多 deck 共享同一张图集（`sheet_source` 相同）时，每个 deck 各有一份 cards.csv、各记自己的 CardID；`cards.ts` 不做跨 deck 比对，共享关系由 `deck.yaml.shared_with` + `verify` 的 `SHARED_ATLAS_NOT_DECLARED` 告警覆盖。
4. **本表与存档的 `CardID` 对账**是 B3 的职责：`verify` 目前检查 `slot === cardIdToSlot(card_id)`，**不**核对 `card_id` 是否真的存在于某个存档对象（需要存档时才有依据）。

---

## 13. 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-10-04 | **v1 初版**（B2 / Run 2 契约文档任务）。列定义、校验规则、错误码逐字对齐 `src/deck/cards.ts`（Run 1 实现）；B2 主窗口裁决落地：本文件承担卡牌明细，替代 `deck.yaml.cards[]`，1 基 slot 问题随之定案（完整 CardID + `cardIdToSlot`）。 |
