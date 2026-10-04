# `.registry.yaml` — 多图包索引契约

> **本文档由 B3 / Run 2 产出，后续窗口必读。**
>
> 依据：`src/pack/registry.ts`（Run 1 实现，本文档窗口未修改该模块）、`src/cli/commands/pack.ts` 的 `list` / `status` / `open`。
> 适用结构版本：`schema_version: 1`。本文档描述**已实现的真实契约**，不是设想稿。
> 单元测试口径：`tests/unit/pack-registry.test.ts`（含序列化样例与乐观锁竞态用例）。

---

## 1. 用途与位置

`.registry.yaml` 是**多图包索引**（packs_root 级注册表）：一个根目录下挂多个图包工作区时，用它回答"这里有哪些图包、各自什么状态"，而不必逐包打开 `pack.yaml`。

```text
<packs_root>/                 ← `tts pack list --root <packs_root>` 的 root
  .registry.yaml              ← 本文件（文件名常量 REGISTRY_FILENAME，src/pack/registry.ts:74）
  alpha/                      ← 一个图包子目录 = 一个独立 git 仓库
    pack.yaml                 ← 该包的主清单（契约见 docs/schemas/pack.yaml.md）
    .gitattributes
    decks/ objects/ scripts/ ui/ ...
  beta/
    pack.yaml
```

- 路径换算：`registryPath(packsRoot)` → `<packsRoot>/.registry.yaml`（`src/pack/registry.ts:545`）。
- 读写入口：`readRegistry(packsRoot)` / `writeRegistry(packsRoot, reg)`（`src/pack/registry.ts:560`、`:596`）。
- 条目级入口：`upsertPack(packsRoot, entry)` / `removePack(packsRoot, dir)` / `findPack(packsRoot, dir)`（`src/pack/registry.ts:626`、`:647`、`:668`）。
- 消费方：`tts pack list` / `tts pack status <dir>` / `tts pack open <dir>`（`src/cli/commands/pack.ts` 的 `listSub` / `packStatusSub` / `openSub`）。
- **不参与**其他流程：`pack init / unpack / pull / push / diff / build` 都直接按 `pack.yaml` 工作，不读注册表；注册表只在"管理多个包"这一层使用。

### 1.1 与 `pack.yaml` 的分工

| 维度 | `pack.yaml` | `.registry.yaml` |
| --- | --- | --- |
| 粒度 | 单个图包工作区的**主清单**（权威） | packs_root 下**全部图包的索引**（派生视图） |
| 位置 | `<packRoot>/pack.yaml` | `<packsRoot>/.registry.yaml` |
| 字段 | 名称 / 工坊 ID / 图床 / vcs.lfs / 路径 / 上传前缀 | 目录名 / 名称 / 类型 / 上游同步 / 分支 / 图床 / 修改日期 / 规模统计 / lfs 状态 |
| 冲突时以谁为准 | **以 pack.yaml 为准** | `lfs_status` 等冗余字段与 pack.yaml 不一致时，重新同步即可（本模块不做交叉校验，见 §6.4） |

---

## 2. 文件格式

- **YAML**，`yaml.stringify` 序列化、**2 空格缩进**（`serializeRegistry`，`src/pack/registry.ts:357-366`），UTF-8 无 BOM。
- 写盘走**原子替换**：先写同目录 `<file>.<uuid>.tmp`，再 `rename` 覆盖目标（`writeAtomic`，`src/pack/registry.ts:424-433`）——中途崩溃不会留下半写的注册表。
- **严格模式**：根对象与条目对象都是 `z.strictObject`——任何未在字段表中出现的键、缺失的必填字段一律拒绝（`registrySchema`，`src/pack/registry.ts:256-262`；`packEntrySchema`，`:218-247`）。手改 YAML 时的拼写错误会立刻报 `REGISTRY_INVALID`，不会静默生效。
- **文件不存在是正常状态**：`readRegistry` 返回空注册表 `{ schema_version: 1, packs: [] }` 且**不创建文件**（`src/pack/registry.ts:560-581`；实测见 `tests/unit/pack-registry.test.ts:167-171`）。
- 日期类字符串（`modified` / `last_synced`）经 `yaml.stringify` 落盘**不加引号**（实测输出 `2026-10-04`）。`yaml` 包默认按 YAML 1.2 core schema 解析，**不会**把这种写法解析成 `Date`（读回仍是字符串）；手写 YAML 时加不加引号（`"2026-10-04"`）等价。读侧统一按字符串校验 `^\d{4}-\d{2}-\d{2}$`。

---

## 3. 根对象字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `schema_version` | 字面量 `1` | ✅ | 无（必填） | 结构版本；**只接受字面量 1**（`src/pack/registry.ts:258`），未来升级靠递增此值 |
| `packs` | 条目数组 | ✅ | 无（必填，允许空数组） | 图包条目列表（`packs: []` 合法；`src/pack/registry.ts:259`） |

空注册表（`packs: []`）与"文件不存在"在读侧是同一个语义：`{ schema_version: 1, packs: [] }`（`emptyRegistry`，`src/pack/registry.ts:320-322`）。

---

## 4. 条目字段

条目类型 `PackEntry`（`src/pack/registry.ts:113-132`）：

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `dir` | `string` | ✅ | 无（必填） | 相对 packs_root 的**一级子目录名**：非空、不能含 `/` 或 `\`、不能是 `.` / `..`（`:220-224`）。拼路径逃不出 packs_root |
| `name` | `string` | ✅ | 无（必填） | 图包显示名，非空（`:225-227`） |
| `kind` | `"original"` \| `"localization"` \| `"modification"` | ✅ | 无（必填） | 图包类型，取值域 `PACK_KINDS`（`:77`） |
| `upstream` | 对象 \| `null` | ✅ | 无（必填，键必须存在） | 上游同步信息；`null` = 本地原创包（见 §4.1） |
| `branch` | `string` | ✅ | 无（必填） | 当前 git 分支名，非空（`:232-234`） |
| `host` | `"steamcloud"` \| `"imgur"` \| `"gdrive"` \| `"dropbox"` \| `"custom"` | ✅ | 无（必填） | 图床类型，取值域复用 `PACK_HOSTS`（`src/pack/packyaml.ts:45`） |
| `modified` | `string` | ✅ | 无（必填） | 最近修改日期，ISO `YYYY-MM-DD`（`:238-240`）；upsert 语义见 §6.5 |
| `stats` | 对象（严格） | ✅ | 无（必填） | 规模统计，见 §4.2 |
| `lfs_status` | `"enabled"` \| `"disabled"` \| `"disabled-no-lfs"` | ✅ | 无（必填） | 冗余自该包 `pack.yaml` 的 `vcs.lfs`（`:242-244`），语义见 §6.4 |

### 4.1 `upstream` 两种形态

```yaml
upstream:                     # 对象形态：有上游（工坊来源）
  workshop_id: 1234567        # 正整数
  last_synced: "2026-09-20"   # ISO 日期 YYYY-MM-DD
  local_commit: a1b2c3d       # 非空字符串（短 / 完整哈希均可）
```

```yaml
upstream: null                # 本地原创包（类型是 "null"，不是缺键）
```

三个子字段都是必填（`upstreamSchema`，`src/pack/registry.ts:175-189`）：`workshop_id` 正整数、`last_synced` ISO 日期、`local_commit` 非空。

### 4.2 `stats` 三个计数器

```yaml
stats:
  decks: 60      # 卡牌组数量（非负整数，允许 0）
  cards: 3010    # 卡牌总数量（非负整数，允许 0）
  scripts: 34    # 脚本文件数量（非负整数，允许 0）
```

三个计数器都允许 `0`——刚 `tts pack init` 完的空包也要能登记（`statsSchema`，`src/pack/registry.ts:194-210`）。

---

## 5. 完整示例

```yaml
schema_version: 1
packs:
  - dir: 第七大陆全扩
    name: 第七大陆全扩（脚本汉化）
    kind: localization
    upstream:
      workshop_id: 1234567
      last_synced: "2026-09-20"
      local_commit: a1b2c3d
    branch: zh-cn
    host: steamcloud
    modified: "2026-10-04"
    stats:
      decks: 60
      cards: 3010
      scripts: 34
    lfs_status: enabled
  - dir: origin-lab
    name: 原创实验室
    kind: original
    upstream: null
    branch: main
    host: imgur
    modified: "2026-10-01"
    stats:
      decks: 2
      cards: 40
      scripts: 3
    lfs_status: disabled-no-lfs
```

（上述文本与 `tests/unit/pack-registry.test.ts:77-115` 的 `fullRegistry` / `validRegistryYaml` 同源。）

最小合法文件：

```yaml
schema_version: 1
packs: []
```

---

## 6. 约束说明

### 6.1 `schema_version` 必须为 1

`z.literal(1)`（`src/pack/registry.ts:258`），校验失败即抛 `PackError code="REGISTRY_INVALID"`，**不存在"忽略版本继续读"的路径**。新增字段必须同步递增此版本号并更新本文档。

### 6.2 `dir` 是一级子目录名，不是路径

只允许单段目录名（无 `/` `\`，非 `.` / `..`，`:220-224`）：注册表是 packs_root 的索引，`dir` 含分隔符时按它拼路径会逃出 packs_root（或指向 packs_root 本身）。各 CLI 命令把它与 `--root` 拼接后再操作：

- `tts pack list`：`path.resolve(root, dir)` 后跑 `git status`（`src/cli/commands/pack.ts` 的 `probeDirty`）；
- `tts pack open`：`path.resolve(root, dir)` 交给系统文件管理器。

### 6.3 读写都过 schema，写前再校验一次

`writeRegistry` / `upsertPack` 在序列化前对**运行时数据**重新过一遍 `registrySchema`（`serializeRegistry`，`src/pack/registry.ts:357-366`），不过就把 `REGISTRY_INVALID` 抛回去——绝不落盘不合规的注册表（调用方可能传入手工拼的对象）。

### 6.4 `lfs_status` 是冗余副本，权威在 `pack.yaml`

- `lfs_status` 冗余自该包 `pack.yaml` 的 `vcs.lfs`，取值域完全一致（`LfsStatus`，`src/pack/registry.ts:86`）——目的是"读注册表不必逐包开 pack.yaml"。
- **两者不一致时以 pack.yaml 为准**；一致性由上层同步流程维护，本模块**不做交叉校验**（模块头注释，`src/pack/registry.ts:8-10`）。
- 改 `pack.yaml` 的 lfs 状态（`tts vcs lfs enable|disable`）不会自动回写注册表；需要刷新条目时由上层流程调 `upsertPack` 重写该行。
- `lfs_status` 的语义与 `pack.yaml` 的 `vcs.lfs` 三态相同（见 `docs/schemas/pack.yaml.md` §4.3）：`disabled-no-lfs` 表示"系统未装 git-lfs、工具降级"，`disabled` 表示"用户显式禁用"。

### 6.5 `modified` 的 upsert 语义

`upsertPack` 对 `entry.modified` 有特殊约定（`resolveModified`，`src/pack/registry.ts:528-534`）：

| 传入值 | dir 已存在 | dir 不存在（新增） |
| --- | --- | --- |
| `""`（空字符串） | **保留**原条目的 `modified` | 填当天 UTC 日期（`YYYY-MM-DD`） |
| 非空值 | 原样写入（视为调用方显式指定） | 原样写入 |

### 6.6 并发写保护（乐观锁，设计搁置项 S6）

`upsertPack` / `removePack` 共用 `updateRegistry`（`src/pack/registry.ts:454`）：

1. 取 mtime 基线（本进程最近一次读取 / 写入事件所见 mtime，`knownMtimeByPath`，`:395`）；
2. 读内容 → 原地修改 → 过 schema 序列化；
3. 写盘前重新核对磁盘 mtime：与基线不一致（含"读后被改 / 被删"与"读时无、写前被建"）→ 抛 `REGISTRY_CONFLICT`，**一个字节都不写**；
4. 一致才原子替换，随后把写完的 mtime 记为新基线。

基线是**进程内**状态：检测的是"自我上次读取之后文件有没有被别人动过"，其他进程不共享该表；本进程从未读过时现取基线（文件不存在视为 0），退化为仅调用内竞态保护（模块头注释，`src/pack/registry.ts:26-40`）。

### 6.7 本模块消息不走 t()

按 B3 窗口约定，`registry.ts` 的错误消息 / zod issue 文案**写死中文、不走 `t()`**（`src/pack/registry.ts:60-62`）；CLI 展示时由命令层用 `t()` 包装（`error.<code>` / 逐行数据）。后续若新增面向用户的界面文案，加在 CLI 层而不是本模块。

---

## 7. API 与错误码

### 7.1 签名（`src/pack/registry.ts`）

```ts
/** `<packsRoot>/.registry.yaml` 的完整路径（路径分隔符跟随平台） */
export function registryPath(packsRoot: string): string;

/** 读取 + 校验；文件不存在时返回空表（不抛错、不建文件） */
export async function readRegistry(packsRoot: string): Promise<Registry>;

/** 入参再校验 + 原子写；不做乐观锁（需要并发保护用 upsert / remove） */
export async function writeRegistry(packsRoot: string, reg: Registry): Promise<void>;

/** 按 dir 原位替换或追加条目，带乐观锁 */
export async function upsertPack(packsRoot: string, entry: PackEntry): Promise<void>;

/** 按 dir 删除条目，带乐观锁；找不到抛 REGISTRY_PACK_NOT_FOUND */
export async function removePack(packsRoot: string, dir: string): Promise<void>;

/** 按 dir 查找；找不到返回 null（不抛错） */
export async function findPack(packsRoot: string, dir: string): Promise<PackEntry | null>;
```

类型：`Registry`（§3）、`PackEntry`（§4）、`PackError`（`src/pack/packyaml.ts:63`，带机器可读 `code`）。

### 7.2 行为一览

| API | 行为 | 抛错（`PackError.code`） |
| --- | --- | --- |
| `readRegistry(packsRoot)` | 读 + 校验；**文件不存在返回空表且不建文件** | `REGISTRY_INVALID`（非法 YAML / 不合 schema）/ `REGISTRY_READ_FAILED`（ENOENT 以外的 IO 错误） |
| `writeRegistry(packsRoot, reg)` | 入参再校验 + 原子写（2 空格缩进）；**不做乐观锁** | `REGISTRY_INVALID` / `REGISTRY_WRITE_FAILED` |
| `upsertPack(packsRoot, entry)` | 按 `dir` 原位替换或追加，带乐观锁 | `REGISTRY_INVALID` / `REGISTRY_CONFLICT` / `REGISTRY_READ_FAILED` / `REGISTRY_WRITE_FAILED` |
| `removePack(packsRoot, dir)` | 按 `dir` 删除条目，带乐观锁 | 同上 + `REGISTRY_PACK_NOT_FOUND`（找不到该 dir，不落盘） |
| `findPack(packsRoot, dir)` | 按 `dir` 精确查找；**找不到返回 `null`，不抛错**（注册表缺失时同样 `null`） | `REGISTRY_INVALID` / `REGISTRY_READ_FAILED` |

### 7.3 错误码表

| 错误码 | 触发条件 | 出现在 | 说明 |
| --- | --- | --- | --- |
| `REGISTRY_INVALID` | 内容不是合法 YAML、不符合 schema；或 `writeRegistry` / `upsertPack` 的**入参**不合规（message 含 zod issues 摘要） | 读 / 写 / upsert / remove 全线 | 写前防线：不合规数据**绝不落盘**（`parseRegistry`，`:331`；`serializeRegistry`，`:357`） |
| `REGISTRY_READ_FAILED` | 读取时发生"文件不存在"以外的 IO 错误（如权限不足） | `readRegistry` / `updateRegistry` | ENOENT 不算错误：走空表容错或"空表起建"（`:374-387`、`:560-581`） |
| `REGISTRY_WRITE_FAILED` | 写入注册表时发生 IO 错误（mkdir / 临时文件写入 / rename 任一步失败） | `writeRegistry` / `upsertPack` / `removePack` | `updateRegistry` 的写盘段失败（`:506-515`） |
| `REGISTRY_CONFLICT` | **乐观锁冲突**：读之后文件 mtime 被其他进程改动（含读后被改 / 被删、读时无写前被建） | `upsertPack` / `removePack` | 检测点在写盘前，**一个字节都不写**（`:497-504`），CLI 提示"请重读后重试" |
| `REGISTRY_PACK_NOT_FOUND` | `removePack` 找不到指定 `dir` 的条目（`findPack` 找不到返回 `null`，不抛） | `removePack` | 消息含注册表路径（`:647-658`） |

`REGISTRY_NOT_FOUND`（文件名存在性错误）当前**不会**被任何 API 抛出：`readRegistry` 对缺文件容错，`upsertPack` / `removePack` 把缺文件当空表起建。该码保留给将来"要求注册表必须已存在"的调用方区分两种状态（`src/pack/registry.ts:44-53`）。

---

## 8. CLI 出口（`tts pack list / status / open`）

| 命令 | 数据源 | stdout | 退出码 |
| --- | --- | --- | --- |
| `tts pack list [--root <packsRoot>] [--dirty]` | `readRegistry` + 逐包 `statusPorcelain`（`src/vcs/git.ts:272`） | `cli.pack.list.header` {count} + 每行 `dir  name  branch  dirty  lfs_status`（`dirty` 列：`true` / `false` / `?`=不是 git 仓库或 git 不可用） | 0；注册表为空只打 `cli.pack.list.empty` 也退 0；`REGISTRY_INVALID` 等按 `error.<code>` 退 1 |
| `tts pack status <dir> [--root <packsRoot>]` | `findPack` | 条目的纯数据行（`dir:` / `name:` / `kind:` / `branch:` / `host:` / `modified:` / `lfs_status:` / `stats:` / `upstream.*`） | 0；找不到 `<dir>` → stderr `cli.pack.status.notFound` {dir}，退 1 |
| `tts pack open <dir> [--root <packsRoot>]` | `findPack` | Windows：`execa("explorer", [<绝对路径>])` 后用 `cli.pack.open.done` {path} 收尾；其他平台只打路径 | 0；找不到 `<dir>` → stderr `cli.pack.open.notFound` {dir}，退 1 |

约定：`list` 的 `--dirty` 只显示**实测**有未提交改动的包（无法判定 git 状态的条目按"不脏"处理，宁可不显示也不误报）；`status` / `open` 的字段名即本文档的契约键，作为纯数据不翻译。

---

## 9. 与方案设计 §4.7 的对应关系

设计依据：`方案设计.md:752-788`（§4.7 统一管理所有图包）。本节逐条对照设计意图与实现落点，**实现为准**。

| §4.7 的设计条目 | 实现落点 | 差异 / 状态 |
| --- | --- | --- |
| "一个入口看到所有图包，而不是翻目录" | `.registry.yaml` + `tts pack list`（`src/cli/commands/pack.ts:426`） | ✅ 已实现 |
| 索引位于 packs_root（设计的 `packs/`，可在配置里改） | `<packs_root>/.registry.yaml`（`REGISTRY_FILENAME`，`src/pack/registry.ts:74`） | ✅ 已实现；`--root` 即"配置入口"，当前无独立配置文件项 |
| 索引"工具维护，可手工编辑" | 严格 schema（§2）；手改拼写错误报 `REGISTRY_INVALID` | ✅ 可手工编辑，但比设计更严：未知字段 / 缺键一律拒绝，不会静默生效 |
| 记录 `dir` / `name` / `kind` / `upstream` / `branch` / `host` / `modified` / `stats` 八项 | 条目字段表 §4 一一对应 | ✅ 全部实现 |
| （设计样例未列） | `schema_version: 1` | **实现新增**：结构版本，升级时递增（§6.1） |
| （设计样例未列） | `lfs_status` | **实现新增**：冗余自 `pack.yaml` 的 `vcs.lfs`，为 `pack list` 免开子目录（§6.4） |
| `upstream` 本地包为 `null` | `upstream: null`（非缺键） | ✅ 已实现（§4.1） |
| `tts pack list` / `tts pack list --dirty` | `listSub`；`--dirty` 逐包实测 `git status --porcelain`，探测失败显示 `?` 且按不脏过滤 | ✅ 已实现；设计未细化"探测失败"语义，实现选择"宁可不显示不误报" |
| `tts pack status <dir>` | `packStatusSub` → `findPack` | ✅ 已实现；找不到以退出码 1 + stderr 提示 |
| `tts pack open <dir>`（打开工作目录 / 用编辑器打开） | `openSub`；Windows 调 `explorer`，其他平台打印绝对路径 | ⚠️ 部分实现：**文件管理器打开已实现**，"用编辑器打开"未实现（`pack.yaml` 的 `editor.adapter` 仍为预留，见 `docs/schemas/pack.yaml.md` §4.5） |
| （设计未提并发保护） | 乐观锁 mtime 校验（搁置项 S6，§6.6） | **实现新增**：`upsertPack` / `removePack` 写盘前核对，冲突抛 `REGISTRY_CONFLICT` |
| 设计 §4.9：packs 容器本身不是 git 仓库，每个图包目录是独立仓库 | 注册表只存条目，不创建 / 管理仓库；`dir` 仅为一级子目录名（§6.2） | ✅ 边界一致：注册表不碰各包的 git 状态，`list` 的 dirty 列是只读探测 |

对应的集成验收场景见 `tests/integration/phase2c.acceptance.test.ts`。

---

## 10. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-05 | 初版（窗口 B3 / Run 2）。契约来自 `src/pack/registry.ts`（Run 1 实现，本文档窗口未修改），补充 `tts pack list / status / open` 的 CLI 出口。 |
| 2026-10-05 | 核验修订：字段表补"默认"列；补 API 签名与独立错误码表；修正 YAML 日期序列化描述（实测 `yaml` 包**不加引号**且仍读回字符串，原文"带引号"有误）；新增 §9 与方案设计 §4.7 的逐条对照。 |
