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
| `name` | `string` | ✅ | 无 | 卡堆名（落盘为 `decks/<净化名>/`；净化用 `sanitizeName`，`src/pack/layout.ts`） | Deck name |
| `guid` | `string` | 可省略 | 无 | 关联已有对象的 GUID（仅原样收进结果，导入流程不读写 `deck.yaml`） | Existing object GUID |
| `grid` | `{ cols: number, rows: number }` | 可省略 | 按卡数自动选 | 网格；`cols` 1–10、`rows` 1–7；不填则按卡数自动选 | Grid layout |
| `back` | `"common" \| "unique" \| "none"` | 可省略 | `"common"` | 背面模式：`common` 共用背面 / `unique` 每卡独立背面 / `none` 无自定义背面 | Back mode |
| `back_file` | `string` | `back=common` 时必填 | 无 | 共用背面图片路径（相对清单文件所在目录）；`back != common` 时出现即报错 | Shared back image |
| `cards_dir` | `string` | ✅ | 无 | 卡图目录（相对清单文件所在目录）；该目录下的图片按**文件名码元序**装入 | Directory of card face images |

**规则**（与 `src/pack/import.ts` 的 `planDeckEntry` 一一对应）：

- 所有相对路径**相对清单文件（import.yaml）所在目录**解析（`path.resolve(baseDir, raw)`），不是相对图包根、也不是相对 CWD。
- `cards_dir` 里只有图片扩展名（`.png .jpg .jpeg .webp .gif .tif .tiff .avif`，`IMAGE_EXTENSIONS`，`src/pack/import.ts:161-163`）按文件名码元序装入；其余文件与子目录**跳过并归入 warnings**（`import.warning.skippedFiles`，不静默丢弃）。目录为空 → `IMPORT_INVALID`（`error.pack.importCardsDirEmpty`）。
- `back` 三模式：
  - `common`：`back_file` 必填（缺失报 `error.pack.importBackFileRequired`），共用背面复制进 deck 目录，每张新卡的 `back` 列写该文件名；
  - `unique`：按"序号_正面.ext ↔ 序号_背面.ext"配对；正面文件名不带 `_正面` 后缀时按"同名_背面.ext"找；**缺配对背面 → `IMPORT_FILE_MISSING`**（message 含期望路径），孤儿背面文件进 warnings；配对成功的背面复制进 deck 目录；
  - `none`：不写 `back` 列、不复制背面（"存档 `BackURL == FaceURL` 降级"是 deck / TTS 侧语义，不在导入流程处理）；
  - `back_file` 只允许出现在 `back=common` 的条目上，其余组合报 `IMPORT_INVALID`（`error.pack.importBackFileForbidden`）。
- 导入时**只写 `decks/<name>/cards.csv`，不写 `deck.yaml`**（卡牌明细唯一源是 cards.csv，且清单的 `guid` 是可选项，凑不齐 deck.yaml 的必填字段）。已有 cards.csv 的行**原样保留**（`card_id` 不重新分配）；新增卡从"已有最大 key + 1 / 已有最大 sheet_id + 1"另开新图集：
  - `card_id = slotToCardId(key, slot)`，新导入的 deck 从 `key=1`（card_id 101 起）开始；单张图集容量 = 显式 `grid ? cols×rows : 70`（`MAX_SLOTS`），超出自动拆多张；
  - 每张图集内 `slot` 独立从 1 编号，`key` 随 sheet 递增（跨图集进位规则见 `cards.csv.md` §9）；
  - 未显式声明 `grid` 时按该图集卡数用 `inferGrid(1, 1, 卡数)` 推断（导入是**逻辑布局**，没有真实图集宽高比，按正方形假设最中性）；
  - 每张新卡写 `sheet_source = "<清单里声明的 cards_dir>/<卡图文件名>"`（如 `./新卡图/001_正面.png`，逐卡可溯源）；导入的 deck 没有真实图集大图，`deck verify` 对这类行的图集存在性告警是预期现象。
- 导入即校验：文件存在性、图像可读（sharp 能读出正尺寸元数据）、色彩模式（**拒 CMYK**，`IMPORT_CMYK`）。
- 重名拦截：同一份清单里两个 deck 净化后同名 → `error.pack.importDuplicateDeck`；同一 `(type, name)` 重复 → `error.pack.importDuplicateObject`；`back=common` 的背面文件与正面同名 → `error.pack.importNameCollision`。

---

## 4. `objects[]` 条目字段表

每个条目描述**一个非卡牌素材**的归位（`objects/` 下每个文件独立，无图集概念，见 `方案设计.md` §4.6.1）。

| 字段 | 类型 | 必填 | 默认 | 说明（中文） | Description (EN) |
| --- | --- | --- | --- | --- | --- |
| `type` | `string`（开放集合） | ✅ | 无 | 素材类型（`tile` / `figurine` / `model` / `dice` / `pdf` / `notecard` / `decal` / `sky` / `table` / `audio` / `assetbundle` …），与 `objects.csv` 的 `type` 列同一开放集合 | Asset type |
| `name` | `string` | ✅ | 无 | 素材名（落盘为 `objects/<type>s/<净化名>/`） | Asset name |
| `image` | `string` | 见下"必填映射" | 无 | 主图（位图类型） | Primary image |
| `mesh` | `string` | 见下"必填映射" | 无 | 网格模型文件 | Mesh file |
| `diffuse` | `string` | 可省略 | 无 | 漫反射贴图（`figurine` / `model` 可配） | Diffuse texture |
| `assetbundle` | `string` | 见下"必填映射" | 无 | `.unity3d` 文件 | AssetBundle file |
| `pdf` | `string` | 见下"必填映射" | 无 | PDF 文件 | PDF file |
| `audio` | `string` | 见下"必填映射" | 无 | 音频文件 | Audio file |

**必填映射**（`REQUIRED_FILE_FIELD`，`src/pack/import.ts:178-194`，精确到实现）：

| `type` | 必填文件字段 |
| --- | --- |
| `tile` / `decal` / `notecard` / `sky` / `table` / `token` / `board` / `pawn` / `counter` | `image` |
| `figurine` / `model` / `dice` | `mesh` |
| `assetbundle` | `assetbundle` |
| `pdf` | `pdf` |
| `audio` | `audio` |
| 其余开放类型（不在上表） | 不强制，但五个文件字段（`image` / `mesh` / `assetbundle` / `pdf` / `audio`）**至少提供一个**，否则 `error.pack.importObjectNoFiles`；未注册类型会额外告警（`import.warning.unregisteredType`，注册表见 `src/deck/types.ts`） |

**规则**：

- 文件字段按类型校验必填（见上表）；`strictObject` 只允许字段表列出的 8 个键（`type` / `name` / `image` / `mesh` / `diffuse` / `assetbundle` / `pdf` / `audio`），未列出的字段一律拒绝。
- 路径同样相对清单文件所在目录；同一条目内落盘文件名（源文件 basename）不得互相冲突（`error.pack.importObjectFileCollision`）。
- 导入即校验：文件存在性、图像类（`image` / `diffuse`）sharp 可读 + 拒 CMYK；`mesh` / `pdf` / `audio` / `assetbundle` 只查存在性。
- 列映射：主文件（必填字段，开放类型按 `image > mesh > assetbundle > pdf > audio` 取第一个提供的）→ `file` 列；其余文件字段中第一个 → `file_secondary` 列；`diffuse` → `diffuse` 列；再多余的字段照常复制文件但逐条告警"未能映射"（`import.warning.unmappedObjectFile`）。
- 导入后自动生成或更新 `<root>/objects/objects.csv`；条目身份 = `(type, name)`：
  - 已有行 **`asset_id` 永不改变**；`file` / `file_secondary` / `diffuse` / `source` 按本次清单重算（本次未提供的 `file_secondary` / `diffuse` 写空）；`normal` / `collider` / `origin_asset_id` / `origin_pack` 不归导入管、原样保留；
  - 新行 `asset_id` 由 `(type, name)` 的 sha256 派生：`imp-` + 8 位十六进制（确定性、可复现），撞车时追加 `-2` / `-3` 后缀；
  - `source` 列 = 清单里声明的原始路径（溯源，不解析成绝对路径）；`file` 列 = `objects/<type>s/<净化名>/<源文件名>`（相对图包根的 POSIX 路径）。
- 导入流程**不写 `origin_asset_id`**：该列语义为"从别的图包复制来时的原始 `asset_id`"（溯源），由 copy 流程自行写入，不做哈希计算（与 `docs/schemas/objects.csv.md` §12.2 口径一致，窗口 C 主窗口 2026-10-05 裁决对齐）。

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

- 全部校验（schema → 业务规则 → 文件存在性 → 图像可读 / CMYK）与**全部规划先于任何落盘**完成；任一失败即报错并指出具体条目，**不静默跳过**（`importAssets` 的"规划 → 落盘"两段式，`src/pack/import.ts:1093-1165`）。
- `--dry-run` 走完全相同的校验与规划，只是跳过落盘步骤（返回结构与实落盘一致，`copiedFiles` 是"将复制"的计划）。
- 校验错误码（全部 `PackError`）：

| code | 触发 |
| --- | --- |
| `IMPORT_INVALID` | 清单不合 schema / 业务规则违规（back 组合、重名、必填文件字段缺失、空卡片目录、命名冲突、图像不可读等） |
| `IMPORT_FILE_MISSING` | 清单文件或任一源文件不存在 / 不可读 / 不是普通文件（含 `back=unique` 缺配对背面） |
| `IMPORT_CMYK` | 任一导入图像是 CMYK 色彩空间（与 `src/deck/verify.ts` 的 `CARD_CMYK` 同一口径） |
| `IMPORT_GRID_OVERFLOW` | 单张图集需要的格数超过上限 70（**防御性兜底**：拆分逻辑保证常规输入每张 ≤ 70，常规流不可达） |
| `IMPORT_EMPTY` | `decks` 与 `objects` 全空（清单没有任何可导入条目） |
| `IMPORT_READ_FAILED` | 读取清单文件时发生"文件不存在"以外的 IO 错误 |
| `IMPORT_WRITE_FAILED` | 复制素材文件时发生 IO 错误（csv 写入的 IO 错误由 cards.ts / objects.ts 自身的 `CARDS_WRITE_FAILED` / `OBJECTS_WRITE_FAILED` 透传） |

> 目标 `cards.csv` / `objects.csv` 已存在但内容非法时，`readCardsCsv` / `readObjectsCsv` 的 `CARDS_*` / `OBJECTS_*` 码**原样向上抛**（不静默覆盖损坏台账）。

### 6.3 与切图流程的关系

- `import.yaml` 面向**非切图来源**的素材（用户已备好成图）。
- 切图来源（整张图集 → 切片）走 `tts deck slice`（`src/deck/slice.ts`），不经过 `import.yaml`。
- 两者最终都落到 `decks/<name>/cards.csv` 与 `objects/objects.csv`，是同一工作区的两个入口。

### 6.4 面向 agent 的设计

- `import.ts` 的 `importAssets` 是**同时面向人类 CLI 与 agent 编程调用**的接口：agent 生成 `import.yaml` 再调 `importAssets`，比直接操作文件系统可预测得多（`方案设计.md` §4.6）。
- 返回结构化的 `ImportResult`（`src/pack/import.ts:367-383`），不依赖 stdout 文案：

  ```
  ImportResult {
    dryRun: boolean;
    root: string;                    // resolve 后的工作区根
    manifestPath: string;            // resolve 后的清单路径
    decks: DeckImportResult[];       // 每项含 name / guid? / deckDir / cardsCsvPath /
                                     //   cardsCsvExisted / addedCards / cards[] / sheets[] /
                                     //   copiedFiles[] / skippedFiles[]
    objects: ObjectImportResult[];   // 每项含 type / name / assetId / assetIdExisted /
                                     //   dir / copiedFiles[]
    objectsCsvPath: string | null;   // 清单无 objects 条目时为 null（不触碰台账）
    warnings: string[];              // 已本地化提示（包名不一致 / 未注册类型 / 跳过文件…）
  }
  ```

---

## 7. 现状与待办

- 本契约对应的 `src/pack/import.ts` 已在窗口 C（阶段 3A）实现并落地：CLI 入口 `tts import <清单> [--pack <工作区>] [--dry-run]`（`src/cli/commands/import.ts`），单元测试 `tests/unit/pack-import.test.ts`。
- `deck.yaml` 的 `cards[]` 字段已在 B2 删除（卡牌明细唯一源是 `cards.csv`，见 `docs/schemas/deck.yaml.md` v1.1），`import.ts` 生成的卡堆明细则**只写 `cards.csv`**，不回写 `deck.yaml.cards[]`。
- 错误码统一走 `src/pack/packyaml.ts` 的 `PackError`，不发明新错误类（红线）。
- 待办：阶段 3 集成验收用例（`tests/integration/phase3.acceptance.test.ts`）为 `it.skip` 骨架，需按用例内 TODO 装配夹具后开启。

---

## 8. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-05 | 初版（窗口 C / 阶段 3A）。命名裁决：导入清单定名 `import.yaml`，与 `assets.yaml`（URL 台账）划界。契约依据 `方案设计.md` §4.6 / §5.11。 |
| 2026-10-05 | §4 修正（窗口 C 主窗口裁决）：导入流程不写 `origin_asset_id`，与 `objects.csv.md` §12.2 的"原始 asset_id 溯源、不做哈希"口径对齐（此前误写"来源 URL 哈希"，与冻结的 objects.csv 契约矛盾）。 |
| 2026-10-05 | 核验修订（窗口 C 契约文档 Run）：按 `src/pack/import.ts` 补齐精确必填映射表（§4）、卡堆 `card_id`/`sheet_id`/`key` 分配与 `sheet_source` 规则（§3）、objects 列映射 / `asset_id` 派生 / `source` 列规则（§4）、完整错误码表与 `ImportResult` 结构（§6.2 / §6.4）；修正 `back: none` 的"降级"表述（导入不处理该语义）；§7 更新为已实现状态。字段表与实现逐项核对，无未记录的字段。 |
