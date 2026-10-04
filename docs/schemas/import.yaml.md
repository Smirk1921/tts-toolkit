# `import.yaml` — 素材导入清单契约

> **本文档由窗口 C（阶段 3）产出，3A/3B/3C 必读。**
>
> 依据：`方案设计.md` §4.6（素材导入）与 §5.11（素材导入清单）。
> 适用结构版本：`schema_version: 1`。本文档描述**已实现的真实契约**，不是设想稿。

---

## 1. 用途与位置

`import.yaml` 是 **素材导入清单**：用户（或 agent）把素材丢进工作区时，用它声明"把哪些文件装进哪个卡堆 / 哪个 objects 分类、正反面怎么关联、网格怎么选"。它是 `tts import` 的**输入**。

- 位置：**由用户在任意位置提供**（通常放工作区根或图包根），命令行显式指定路径：`tts import <路径>/import.yaml`。
- **与工作区根的 `assets.yaml` 是两份完全不同的文件**：
  - `import.yaml`（本文档）＝**导入清单**，顶层是 `pack:` + `decks[]` + `objects[]`，描述"装什么、装到哪"。
  - `assets.yaml`（`docs/schemas/assets.yaml.md`）＝**素材 URL 台账**，顶层是 `schema_version` + `assets[]`，记录每个素材当前的 URL / 哈希 / 图床。
  - 命名裁决（窗口 C 主窗口，2026-10-05）：导入清单**定名 `import.yaml`**，`assets.yaml` 保留给 URL 台账，避免同名歧义（见 `assets.yaml.md` §5）。
- 读写入口：`src/pack/import.ts` 的 `importAssets({root, manifestPath, dryRun?})`。schema 校验与读写由该模块内部完成，**不暴露独立 read/write 给外部**。

**严格模式**：根对象与每条 `decks[]` / `objects[]` 条目都是 `z.strictObject`——未在字段表中出现的键一律拒绝，缺必填键同样拒绝。

---

## 2. 顶层字段表

| 字段 | 类型 | 必填 | 默认 | 说明（中文） | Description (EN) |
| --- | --- | --- | --- | --- | --- |
| `schema_version` | 字面量 `1` | ✅ | 无 | 结构版本，本版固定 1 | Structure version; literal `1` |
| `pack` | `string` | ✅ | 无 | 目标图包名（须与 `pack.yaml` 的 `name` 一致，仅作校验提示，不强制写回） | Target pack name |
| `decks` | 卡堆条目数组 | 可省略 | `[]` | 卡牌素材清单 | Card deck entries |
| `objects` | 非卡牌素材条目数组 | 可省略 | `[]` | 非卡牌素材清单（图块 / 棋子 / 模型 / 骰子 / 贴花 / PDF / 音频 …） | Non-card asset entries |

> `decks` 与 `objects` 至少提供一个非空数组，否则导入无意义（schema 层面不拦，由 `import.ts` 在业务层报 `IMPORT_EMPTY`）。

---

## 3. `decks[]` 条目字段表

每个条目描述**一个卡堆**的素材归位。

| 字段 | 类型 | 必填 | 默认 | 说明（中文） | Description (EN) |
| --- | --- | --- | --- | --- | --- |
| `name` | `string` | ✅ | 无 | 卡堆名（落盘为 `decks/<name>/`） | Deck name |
| `guid` | `string` | 可省略 | 无 | 关联已有对象的 GUID（用于原位拼回 / 与骨架对齐） | Existing object GUID |
| `grid` | `{ cols: number, rows: number }` | 可省略 | 按卡数自动选 | 网格；不填则按卡数自动选（10×7 上限，超出自动拆多张图集） | Grid layout |
| `back` | `"common" \| "unique" \| "none"` | 可省略 | `"common"` | 背面模式：`common` 共用背面 / `unique` 每卡独立背面 / `none` 无自定义背面 | Back mode |
| `back_file` | `string` | `back=common` 时必填 | 无 | 共用背面图片路径（相对清单文件所在目录） | Shared back image |
| `cards_dir` | `string` | ✅ | 无 | 卡图目录（相对清单文件所在目录）；该目录下的图按文件名顺序装入 | Directory of card face images |

**规则**：
- 所有相对路径**相对清单文件（import.yaml）所在目录**解析，不是相对图包根。
- 导入时自动生成或更新 `decks/<name>/cards.csv`：`card_id` 按顺序自动分配（也可在后续扩展显式指定，本版不支持）。
- 导入即校验：文件存在性、图像格式可读、色彩模式（**拒 CMYK**）、网格容量（单图集 10×7=70 上限，超出自动拆多张，`sheet_id`=1,2,3…，`slot` 在每张图集内独立编号，见 `方案设计.md` §5.12）。
- `back: unique` 时，卡图目录内需按命名约定同时提供背面（约定：`001_正面.png` ↔ `001_背面.png`）；`back: none` 且存档 `BackURL == FaceURL` 时降级为无自定义背面。

---

## 4. `objects[]` 条目字段表

每个条目描述**一个非卡牌素材**的归位（`objects/` 下每个文件独立，无图集概念，见 `方案设计.md` §4.6.1）。

| 字段 | 类型 | 必填 | 默认 | 说明（中文） | Description (EN) |
| --- | --- | --- | --- | --- | --- |
| `type` | `string`（开放集合） | ✅ | 无 | 素材类型（`tile` / `figurine` / `model` / `dice` / `pdf` / `notecard` / `decal` / `sky` / `table` / `audio` …），与 `objects.csv` 的 `type` 列同一开放集合 | Asset type |
| `name` | `string` | ✅ | 无 | 素材名（落盘为 `objects/<type>s/<name>/`） | Asset name |
| `image` | `string` | 按类型 | 无 | 主图（tile / decal / notecard / sky / table 等以图为主的类型必填） | Primary image |
| `mesh` | `string` | 按类型 | 无 | 网格模型文件（figurine / model / dice 必填） | Mesh file |
| `diffuse` | `string` | 可省略 | 无 | 漫反射贴图（figurine / model 可配） | Diffuse texture |
| `assetbundle` | `string` | 按类型 | 无 | `.unity3d` 文件（assetbundle 类型必填） | AssetBundle file |
| `pdf` | `string` | 按类型 | 无 | PDF 文件（pdf 类型必填） | PDF file |
| `audio` | `string` | 按类型 | 无 | 音频文件（audio 类型必填） | Audio file |

**规则**：
- 文件字段按类型校验：`type` 决定哪些文件字段必填（见上表"按类型"），多余字段会被 strictObject 拒绝。
- 路径同样相对清单文件所在目录。
- 导入即校验：文件存在性、格式可读（图像类拒 CMYK）。
- 导入后自动生成或更新 `objects/objects.csv`；`asset_id` 一旦生成**永不改变**，`origin_asset_id`（来源 URL 哈希）在换 URL 时重算（见 `方案设计.md` §5.9）。

---

## 5. 完整示例

```yaml
schema_version: 1
pack: 第七大陆

decks:
  - name: 冒险牌堆
    guid: 271fac                      # 可选：关联已有对象
    grid: { cols: 10, rows: 7 }       # 可选；不填则按卡数自动选
    back: common                      # common | unique | none
    back_file: 背面.png               # back=common 时必填
    cards_dir: ./新卡图               # 该目录下的图按文件名顺序装入

objects:                              # 非卡牌素材
  - type: tile
    name: 地图板块A
    image: tiles/地图板块A.png
  - type: figurine                    # 新增类型示例
    name: 船长棋子
    mesh: models/captain.obj
    diffuse: textures/captain.png
```

---

## 6. 关键约束说明

### 6.1 路径解析基准

- **所有相对路径相对 `import.yaml` 文件所在目录**，不是相对图包根、也不是相对 CWD。
- 解析后 `import.ts` 必须确认每个源文件真实存在且可读，再规划落盘；`--dry-run` 时只打印归位计划不落盘。
- 落盘目标统一在工作区内（`decks/<name>/`、`objects/<type>s/<name>/`），schema 不做路径校验，由 `import.ts` 用 `path.resolve` 并确认结果在工作区之内。

### 6.2 校验失败即报错，不静默跳过

- 缺文件 / 图像不可读 / **CMYK 色彩模式** / 网格超容量且无法自动拆分 → 报错并指出具体条目，**不静默跳过**。
- 校验错误码：`IMPORT_INVALID`（不合 schema）/ `IMPORT_FILE_MISSING` / `IMPORT_CMYK` / `IMPORT_GRID_OVERFLOW` / `IMPORT_EMPTY`（decks 与 objects 全空）。

### 6.3 与切图流程的关系

- `import.yaml` 面向**非切图来源**的素材（用户已备好成图）。
- 切图来源（整张图集 → 切片）走 `tts deck slice`（`src/deck/slice.ts`），不经过 `import.yaml`。
- 两者最终都落到 `decks/<name>/cards.csv` 与 `objects/objects.csv`，是同一工作区的两个入口。

### 6.4 面向 agent 的设计

- `import.ts` 的 `importAssets` 是**同时面向人类 CLI 与 agent 编程调用**的接口：agent 生成 `import.yaml` 再调 `importAssets`，比直接操作文件系统可预测得多（`方案设计.md` §4.6）。
- 返回结构化的 `ImportResult { decks: DeckImportResult[], objects: ObjectImportResult[], warnings: string[] }`，不依赖 stdout 文案。

---

## 7. 现状与待办

- 本契约对应的 `src/pack/import.ts` 在窗口 C（阶段 3A）由 Run 1（GLM）实现，本版为**首个落地版本**。
- `deck.yaml` 的 `cards[]` 字段已在 B2 删除（卡牌明细唯一源是 `cards.csv`，见 `docs/schemas/deck.yaml.md` v1.1），`import.ts` 生成的卡堆明细则**只写 `cards.csv`**，不回写 `deck.yaml.cards[]`。
- 错误码统一走 `src/pack/packyaml.ts` 的 `PackError`，不发明新错误类（红线）。

---

## 8. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-05 | 初版（窗口 C / 阶段 3A）。命名裁决：导入清单定名 `import.yaml`，与 `assets.yaml`（URL 台账）划界。契约依据 `方案设计.md` §4.6 / §5.11。 |
