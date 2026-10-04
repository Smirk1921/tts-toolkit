# `objects.csv` — 非卡牌素材台账契约

> **本文档由 B2 / Run 2 产出，B3 与后续窗口必读。**
>
> 依据：`src/deck/objects.ts`（Run 1 实现，Run 2 未修改）、`src/deck/types.ts`（素材类型开放集合）。
> 适用结构版本：`schema_version: 1`（CSV 文件本身没有版本列；列定义变更等同改契约，见 §14）。
> 本文档描述**已实现的真实契约**，不是设想稿。

---

## 1. 用途与文件位置

`objects.csv` 是**非卡牌素材的台账**：图块、棋子、模型、骰子、PDF……每行一个素材，记录"它是什么、文件在哪、来源是什么、从哪个图包溯源而来"。与 `cards.csv` **同构**（同样的 BOM + LF + 写时 trailing newline、同样的 RFC 4180 转义），但**没有图集概念**（见 §8）。

位置与命名：

```text
<packRoot>/
  objects/                 ← 推荐布局（方案设计 §4 目录树）
    objects.csv            ← 本文件（首选位置；verify.ts 第一优先）
    地图板块A/tile.png      ← file 列指向的素材（相对图包根）
    ...
  objects.csv              ← 兜底位置（verify.ts 第二优先，兼容"台账与 objects/ 同级"）
```

- 文件名常量 `OBJECTS_CSV_FILENAME = "objects.csv"`（`src/deck/objects.ts:60`）。
- ⚠️ **`objects.ts` 本身对 `root` 没有语义**：`objectsCsvPath(root)` 就是 `path.join(root, "objects.csv")`（`src/deck/objects.ts:235-237`）——传 `objects/` 目录得到 `<packRoot>/objects/objects.csv`，传 `packRoot` 得到 `<packRoot>/objects.csv`。**生产方与消费方必须约定好同一个 root**；`verify` 对两种布局都容忍（先找 `<root>/objects/objects.csv`，再兜底 `<root>/objects.csv`，`src/deck/verify.ts:50-51`）。
- 读写入口：`readObjectsCsv(root)` / `writeObjectsCsv(root, rows)`（`src/deck/objects.ts:426`、`:458`）。
- 结构类型：`ObjectRow`（`src/deck/objects.ts:88-114`），解析后的属性为 camelCase（`assetId` / `fileSecondary` / `originAssetId` / `originPack`）。

---

## 2. 文件格式

- **CSV（逗号分隔）**，字段分隔符恒为 ASCII `,`。
- **首行必须是表头**，列名与列序**写死**（见 §3）：读时把整行表头与 `OBJECTS_CSV_COLUMNS.join(",")` 做**字符串精确比对**，多列、少列、换序、改名都拒绝（`OBJECTS_INVALID`）（`src/deck/objects.ts:312-322`）。
- **编码：UTF-8 带 BOM**；**换行：LF**；写侧总是以 **trailing newline** 结束。
- **11 列全部是字符串**——没有数值列，没有枚举列；解析层不做任何类型转换。
- 可选列（`name` / `file_secondary` / `diffuse` / `normal` / `collider` / `origin_asset_id` / `origin_pack`）**空字符串 = 缺省**；写侧 `undefined` 写作空字段，读侧空字段还原为 `undefined` 并从结果对象上摘除该键（`src/deck/objects.ts:283-287`）。
- **不 trim、不归一**：字段值原样保留，前后空格是值的一部分；必填字段的"空"严格指空字符串 `""`，空白字符 `" "` **不算空**（`src/deck/objects.ts:43-46`）。

---

## 3. 列定义

列顺序**严格固定**，共 11 列（`OBJECTS_CSV_COLUMNS`，`src/deck/objects.ts:66-69`）：

| 列名 | 类型 | 必填 | 对应 `ObjectRow` 属性 | 说明 |
| --- | --- | --- | --- | --- |
| `asset_id` | string | ✅ | `assetId` | **图包内唯一标识**（通常是 GUID 或自定义字符串）；不能为空；全表精确字符串唯一（大小写敏感，见 §9） |
| `name` | string | 可省 | `name?` | 素材显示名（如 `地图板块A`） |
| `type` | string | ✅ | `type` | **素材类型（开放集合）**，如 `tile` / `model` / `figurine` / `dice`；未知值原样保留（见 §7） |
| `file` | string | ✅ | `file` | **主文件路径（相对图包根）**，如 `objects/地图板块A/tile.png` |
| `file_secondary` | string | 可省 | `fileSecondary?` | 次要文件（如 `ImageSecondaryURL` / `AssetbundleSecondaryURL` 对应的文件） |
| `diffuse` | string | 可省 | `diffuse?` | 漫反射贴图（`model` / 模型类素材用） |
| `normal` | string | 可省 | `normal?` | 法线贴图（`model` 类素材用） |
| `collider` | string | 可省 | `collider?` | 碰撞体文件（`model` 类素材用） |
| `source` | string | ✅ | `source` | **素材来源**：原始 URL / 本地文件路径 / 生成标识（追溯用）；不能为空。**替代 `cards.csv` 的 `sheet_source`**（见 §8） |
| `origin_asset_id` | string | 可省 | `originAssetId?` | **溯源**：原始 `asset_id`（从别的图包复制来时） |
| `origin_pack` | string | 可省 | `originPack?` | **溯源**：来自哪个图包 / 工坊（如工坊 ID 字符串） |

> 哪些 TTS 存档字段会被每种 `type` 影响，见 `src/deck/types.ts` 的注册表 `urlFields`（方案设计 §2.6.2 全量扫描实测）：例如 `model` 是 `CustomMesh` 的 `MeshURL` / `DiffuseURL` / `NormalURL` / `ColliderURL` 四件套，`tile` / `figurine` / `token` / `board` / `pawn` / `counter` 是 `CustomImage` 的主 / 次图。

---

## 4. 校验规则与错误码

`readObjectsCsv` 与 `writeObjectsCsv` 都做校验；**写侧先完整校验并序列化，任何一行不过都不落盘、不创建目录**（`src/deck/objects.ts:461-475`）。

| # | 规则 | 违规错误码 |
| --- | --- | --- |
| 1 | 文件非空且表头必须是 `asset_id,name,type,file,file_secondary,diffuse,normal,collider,source,origin_asset_id,origin_pack`（逐字符精确） | `OBJECTS_INVALID` |
| 2 | 数据行必须恰为 11 列 | `OBJECTS_INVALID` |
| 3 | 必填列 `asset_id` / `type` / `file` / `source` 不能为空字符串（读侧）；写侧任意字段不是字符串、或必填字段为空 | `OBJECTS_INVALID` |
| 4 | `asset_id` 全表唯一（**精确字符串相等**，大小写敏感） | `OBJECTS_DUPLICATE_ID` |
| 5 | 数据行之间的空行跳过（含末尾多余换行产生的空记录） | —（不算错误） |

规则 1 / 2 / 3 在读、写两条路径都生效；规则 4 在读、写两条路径都检查（`src/deck/objects.ts:343-349`、`:466-471`）。

### 4.1 全部 5 个 PackError 错误码

`PackError` 来自 `src/pack/packyaml.ts`；CLI 按 `` `error.${code}` `` 取文案，**按 code 分支，不要解析 message 文本**。模块自身构造消息用的 i18n 键（`locales/zh-CN.json` 与 `en-US.json` 已镜像提供）：

| 错误码 | 触发条件 | 模块消息 i18n 键 |
| --- | --- | --- |
| `OBJECTS_NOT_FOUND` | `<root>/objects.csv` 不存在 | `error.objects.notFound` {path} |
| `OBJECTS_READ_FAILED` | 读取时发生"文件不存在"以外的 IO 错误（如路径是目录、权限不足） | `error.objects.readFailed` {path} {detail} |
| `OBJECTS_INVALID` | 表头不符 / 列数不符 / 必填列为空 / 写侧字段不是字符串 | `error.objects.invalid` {path} {detail} |
| `OBJECTS_DUPLICATE_ID` | `asset_id` 重复（读、写两条路径都会检查） | `error.objects.duplicateId` {path} {assetId} |
| `OBJECTS_WRITE_FAILED` | 写入时的 IO 错误 | `error.objects.writeFailed` {path} {detail} |

> 行号口径：错误消息里的"第 N 行"指**数据行号**（1 基，跳过表头与空行后计数），不是文件物理行号。

---

## 5. CSV 转义

- **写侧**：字段含逗号 `,`、双引号 `"`、`\r`、`\n` 时，整体用双引号包围，内部双引号翻倍为 `""`；其余字段保持裸（git diff 友好）（`src/deck/objects.ts:222-227`）。
- **读侧**：引号内逗号 / 换行 / `""` 转义都正确还原；未加引号字段中部的裸引号按字面量宽容处理（`src/deck/objects.ts:181-191`）。
- 与 `cards.csv` 的转义实现是**两份独立代码**（cards.ts 动工时未抽公共 parser；objects.ts 头注释要求在 cards.ts 抽取共用实现后改为 import，见 `src/deck/objects.ts:36-39`）——当前行为一致，规则以本节为准。

示例（`name` 含逗号、`source` 用本地路径时；含表头，可直接另存为文件）：

```csv
asset_id,name,type,file,file_secondary,diffuse,normal,collider,source,origin_asset_id,origin_pack
t001,"地图, 板块A",tile,objects/map-a.png,,,,,https://img.example.com/bbb.png,,
t002,船长棋子,figurine,objects/captain.obj,captain.png,,,,file:./import/captain.obj,,
```

---

## 6. 编码与读取宽容细节

写侧（`serialize` + `writeObjectsCsv`，`src/deck/objects.ts:475-484`）：

- 首字符 `\uFEFF`（UTF-8 BOM，Excel 识别中文的关键）；
- 每行以 `\n` 结尾，**总 trailing newline**；全程不写 `\r\n`。

读侧（`parseObjectsCsv`，`src/deck/objects.ts:301-353`）宽容处理：

| 情况 | 行为 |
| --- | --- |
| 开头有 / 无 BOM | 都接受（有则剥离） |
| 换行 CRLF / LF / 裸 `\r` | 都按换行处理（CRLF 整体消费） |
| 末尾 trailing newline 有 / 无 | 都接受 |
| 数据行之间的空行 | 跳过，不计行号、不报错 |
| 未加引号字段中部的裸引号 | 按字面量宽容处理，不报错 |

> 读回的行**保持文件顺序，不排序**。

---

## 7. `type` 是开放集合（关键约定）

- 内置枚举 `ASSET_TYPES` 共 14 个值（`src/deck/types.ts:49-52`，按方案设计 §5.9 类型表顺序）：

  ```text
  card, model, assetbundle, tile, figurine, token,
  board, dice, notecard, text3d, pdf, pawn, counter, other
  ```

- **`type` 是开放集合，不是封闭枚举**：`objects.ts` 不 import `ASSET_TYPES`、不做任何枚举校验——**允许枚举之外的任意字符串**，原样保留、不报错、不丢弃、不 trim、不做大小写归一（`src/deck/objects.ts:34-39`）。
- **未知类型不告警**：告警由调用方按需触发。想判断某类型是否已注册，用 `src/deck/types.ts` 的注册表：`createRegistry().get(type)` 返回 `undefined` 即未注册（`src/deck/types.ts:198-204`）；`resolve(type)` 对未知值返回 defaultHandler（`type` 原样、`urlFields` 为空数组），因此未知类型素材**不会被猜字段、也不会被改写**（`src/deck/types.ts:186-214`）。
- 往返不丢数据：`Card` / `card` 是两个不同字符串；把未知类型悄悄改写成 `other` 属于破坏性行为，**禁止**。
- 消费方义务：`verify` / 导入等流程遇到未注册类型应**提示而非报错**（当前 Run 2 的 `verify` 尚未落地该提示——见 §13）。

---

## 8. 没有图集概念：`source` 与文件列

- 非卡牌素材**通常是独立文件**，没有"在第几张图集、第几格"的概念——因此本表**没有** `sheet_id` / `slot` / `sheet_cols` / `sheet_rows` 列，`cards.csv` 的 `sheet_source` 在这里由 **`source`** 替代（`source`：原始 URL / 本地路径 / 生成标识，追溯用；必填非空）。
- `source` **不做任何格式校验**：URL、`file:./...`、相对路径、纯文本标识都合法；可能是死链、可能指向原作者机器上的路径（`方案设计.md:732`）。素材修复 / 换 URL 时更新这一列。
- 文件列分工：`file` 是主文件；`file_secondary` 是次要文件（`CustomImage.ImageSecondaryURL` / `CustomAssetbundle.AssetbundleSecondaryURL` 等）；`diffuse` / `normal` / `collider` 是模型的贴图与碰撞体（仅部分类型使用，其余类型留空）。
- `objects.ts` **不检查**这些文件是否真的存在——文件存在性由 `verify` 报 `OBJECT_FILE_MISSING`（warning；相对**图包根**解析，`src/deck/verify.ts:53-54`）。

---

## 9. `asset_id` 语义与唯一性

- `asset_id` 是**图包内唯一标识**，通常是 GUID（也允许自定义可读字符串，如 `t001` / `f001`）；必填、非空。
- 唯一性判定：**精确字符串相等**（`Set<string>`），大小写敏感——`"abc"` 与 `"ABC"` 是两个不同 `asset_id`（与"GUID 读取时不做大小写归一"的 B2 约定一致）；不做 trim、不做格式校验（不要求是合法 GUID）。
- 读、写两条路径都检查重复：读侧按文件顺序遇到重复即抛 `OBJECTS_DUPLICATE_ID`；写侧在**落盘前**全量检查（`src/deck/objects.ts:343-349`、`:466-471`）。
- `origin_asset_id` / `origin_pack` 是**溯源**字段，与主键无关：从别的图包复制素材时记录原始 `asset_id` 与来源图包。
- 边界：唯一性只在**单个对象文件内**强制；同一图包若存在多份 `objects.csv`（例如同时有 `objects/objects.csv` 与根目录 `objects.csv`），跨文件重复**不会**被本模块发现。

---

## 10. 完整示例

可直接复制使用的 5 行样例（含表头；每行恰 11 列）：

```csv
asset_id,name,type,file,file_secondary,diffuse,normal,collider,source,origin_asset_id,origin_pack
t001,地图板块A,tile,objects/map-a.png,,,,,https://img.example.com/bbb.png,,
f001,船长棋子,figurine,objects/captain.obj,captain.png,,,,https://img.example.com/ccc.obj,,
m001,石像模型,model,objects/statue.obj,,statue_diffuse.png,statue_normal.png,statue_collider.obj,https://img.example.com/ddd.obj,orig-m001,第七大陆
d001,六面骰,dice,objects/dice_sheet.png,,,,,https://img.example.com/eee.png,,
x001,自定义物件,mystery_type,objects/thing.png,,,,,file:./import/thing.png,,
```

> 第 5 行的 `mystery_type` 演示开放集合（§7）：不在 `ASSET_TYPES` 里，但必须原样保留。`source` 用 `file:./...` 表示"只存在于原作者机器上的本地来源"（`方案设计.md:732`）。

---

## 11. 读写 API 与调用约定

| API | 行为 | 抛错 |
| --- | --- | --- |
| `readObjectsCsv(root)` | 读 + 剥 BOM + 解析 + 表头 / 列数 / 必填 / 唯一性校验，返回按文件顺序的 `ObjectRow[]` | `OBJECTS_NOT_FOUND`（文件不存在）/ `OBJECTS_READ_FAILED`（其他 IO）/ `OBJECTS_INVALID` / `OBJECTS_DUPLICATE_ID` |
| `writeObjectsCsv(root, rows)` | **写前完整校验并序列化**（任何一行不过都不落盘）→ BOM + 表头 + LF 行 + trailing newline；父目录不存在时逐级创建 | `OBJECTS_INVALID` / `OBJECTS_DUPLICATE_ID` / `OBJECTS_WRITE_FAILED` |

- 错误统一为 `PackError`，带机器可读 `code`；**按 code 分支**，不要匹配 message。
- `root` 传空串 / 空白字符串时行为由 `path.join` 决定（可能静默变成相对 cwd 的路径）——调用方（CLI / 导入流程）负责保证是非空路径；本模块不做 `assertDirPath`。
- 追加 / 更新条目时建议：先 `readObjectsCsv` → 在内存中增删改 → `writeObjectsCsv` 全量写回（全量写保证唯一性校验不遗漏）。

---

## 12. 相关契约

- `docs/schemas/cards.csv.md` — 卡牌明细表；本表的"同构姐妹"，差异只在 §8（无图集概念、`source` 替代 `sheet_source`）。
- `docs/schemas/deck.yaml.md` — 牌堆级元数据（与 objects 无直接关系，但同属 deck 流水线契约）。
- `src/deck/types.ts` — 素材类型开放集合与注册表；判断"类型是否已注册"的**唯一来源**。
- `src/deck/verify.ts` — 对象校验：`objects.csv` 存在且合法 + `file` 引用文件存在性（`OBJECT_FILE_MISSING`）。
- `方案设计.md` §5.9（`objects.csv` 设计来源）、§2.6.2（各类型对应字段清单）。

---

## 13. 已知差异与待决事项

1. **位置二义性（B3 动工前必须定）**：`objects.ts` 的 root 由调用方决定，导致 `<packRoot>/objects/objects.csv`（设计首选）与 `<packRoot>/objects.csv`（verify 兜底）两种布局都"合法"。**写入方必须先与调用方 / 主窗口约定用哪一种**，否则会出现两份台账各写各的、谁也不知道哪份生效。当前 Run 2 的 `verify` 两种都读（先 `objects/` 后根目录）。
2. **与 `方案设计.md` §5.9 草稿的差异（已按实现落定）**：草稿示例只列了 8 列（缺 `file_secondary` / `normal` / `collider`），实现契约固定 11 列；草稿把 `origin_asset_id` 描述为"**来源 URL 的哈希**"（跨机对账用），实现语义是"**原始 `asset_id`**"（从别的图包复制来时的溯源），**不做哈希计算**——B3 若需要 URL 哈希对账，属于 schema 变更，先改 `objects.ts` 与本文档，不得只往 CSV 里塞值。
3. **未注册类型的提示尚未落地**：`objects.ts` 按契约不告警（告警是调用方的事），`verify` 目前也没有检查 `type` 是否已注册；"未知类型只提示不报错"这条设计意图（`方案设计.md:1239-1241`）由谁在哪个流程输出提示，**待 B3 / 主窗口裁决**。
4. **`source` / `file` 的格式与可达性不由本模块保证**：`file` 是否存在由 `verify` 的 `OBJECT_FILE_MISSING`（warning）覆盖；`source` 的 URL 是否可达、`file` 路径是否越界（`..` / 绝对路径）当前**无人校验**。

---

## 14. 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-10-04 | **v1 初版**（B2 / Run 2 契约文档任务）。列定义、校验规则、错误码逐字对齐 `src/deck/objects.ts`（Run 1 实现）；开放集合语义对齐 `src/deck/types.ts`（方案设计 §5.9 用户要求：未知值原样保留、不报错、不丢弃，只告警）。 |
