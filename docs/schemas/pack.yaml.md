# `pack.yaml` — 图包主清单契约

> **本文档由窗口 B1 产出，B2/B3 必读。**
>
> 依据：`src/pack/packyaml.ts`（Run 1 实现，Run 2 未修改）、`src/pack/init.ts:548-553`。
> 适用结构版本：`schema_version: 1`。本文档描述**已实现的真实契约**，不是设想稿。

---

## 1. 用途与位置

每个图包工作区根目录**有且仅有一份** `pack.yaml`（文件名常量 `PACK_YAML_FILENAME = "pack.yaml"`，`src/pack/packyaml.ts:42`），描述图包整体元数据：显示名、工坊归属、图床、版本控制状态、路径与上传前缀。

- 路径换算：`packYamlPath(root)` → `<root>/pack.yaml`
- 读写入口：`readPackYaml(root)` / `writePackYaml(root, data)`（`src/pack/packyaml.ts:225`、`:271`）
- 创建入口：`tts pack init`（`src/pack/init.ts`）写入的就是下文字段表中的形态

**严格模式**：根对象与所有嵌套对象都用 `z.strictObject`（`src/pack/packyaml.ts:118`）——**任何未在字段表中出现的键都会被拒绝**，缺失必填字段同样拒绝。因此「给 pack.yaml 加一个字段」这里**等同改 schema**，B2/B3 不得自行往 `pack.yaml` 里塞自定义键；需要新字段时先改 `packyaml.ts` 的 schema 并同步升级本文档。

---

## 2. 字段表

| 字段 | 类型 | 必填 | 默认 | 说明（中文） | Description (EN) |
| --- | --- | --- | --- | --- | --- |
| `schema_version` | 字面量 `1` | ✅ | 无 | 结构版本号，本版固定为 `1`；**只接受字面量 1**，未来升级靠递增此值 | Structure version; literal `1` only |
| `name` | `string` | ✅ | 无 | 图包显示名（用户可见，保持原样不翻译）；`build` 用它推导输出文件名 `dist/<净化名>.json` | Human-readable pack name |
| `workshop_id` | `number \| null` | ✅ | 无 | Steam 创意工坊文件 ID；**未发布时必须显式写 `null`**，不得省略该键 | Steam Workshop file id; `null` when not published |
| `source_mod` | `number \| null` | ✅ | 无 | 上游模组工坊 ID（魔改/汉化场景用于溯源）；无上游写 `null` | Upstream Workshop id for forks; `null` when none |
| `host` | `"steamcloud"` \| `"imgur"` \| `"gdrive"` \| `"dropbox"` \| `"custom"` | 可省略 | `"steamcloud"` | 图床类型，**决定素材上传的目标图床**；取值域 `PACK_HOSTS`（`src/pack/packyaml.ts:45`） | Image host used for uploads |
| `vcs` | 对象（严格） | ✅ | 无 | 版本控制声明块；当前只含 `lfs` 一个键 | VCS declaration block |
| `vcs.lfs` | `"enabled"` \| `"disabled"` \| `"disabled-no-lfs"` | ✅ | **无（刻意不设默认）** | git-lfs 三态；见 §4.3，约束 10 要求必须显式三选一 | git-lfs state; deliberately no default |
| `paths` | 对象（严格） | ✅（键本身必填） | 允许空映射 `{}` | 路径配置块 | Path config block |
| `paths.workdir` | `string` | 可省略 | `"."` | 工作目录，相对 `pack.yaml` 所在目录 | Working directory, relative to `pack.yaml` |
| `upload` | 对象（严格） | ✅（键本身必填） | 允许空映射 `{}` | 上传配置块 | Upload config block |
| `upload.prefix` | `string` | 可省略 | `""` | 图床上的路径前缀，避免多图包互相污染 | Path prefix on the image host |
| `editor` | 对象（严格） | ❌（整块可省） | 无 | 编辑器适配预留块 | Editor adapter block (optional) |
| `editor.adapter` | `"vscode"` | `editor` 出现时必填 | 无 | 当前**只接受 `"vscode"`** 一个值 | Only `"vscode"` accepted today |

> 实测确认（Node 24 + tsx 跑真实 schema）：
> - 省略 `paths` / `upload` 键会被拒绝（报 `paths 必须是键值对象`、`upload 必须是键值对象`）；写 `paths: {}` / `upload: {}` 则通过；
> - 省略 `host` 时读出值为 `"steamcloud"`，省略 `paths.workdir` 读为 `"."`，省略 `upload.prefix` 读为 `""`；
> - `schema_version: 2`、未知顶层键（如 `hostt`）、`host: weibo`、缺失 `workshop_id` 均被拒绝。

---

## 3. 完整示例

```yaml
schema_version: 1
name: 第七大陆-蜘蛛脚本增强版

workshop_id: 2955382975      # 未发布时写 null（键不能省）
source_mod: null             # 非魔改包写 null

host: steamcloud             # steamcloud | imgur | gdrive | dropbox | custom；省略等价于 steamcloud
# editor:                    # 可选块，整块可省
#   adapter: vscode          # 当前只接受 vscode

vcs:
  lfs: enabled               # enabled | disabled | disabled-no-lfs（无默认，必须显式写）

paths:
  workdir: .                 # 相对 pack.yaml 所在目录

upload:
  prefix: "第七大陆/"         # 图床上的路径前缀；不需要前缀时写 ""
```

最小可读示例（其余字段走默认）：

```yaml
schema_version: 1
name: 我的图包
workshop_id: null
source_mod: null
vcs:
  lfs: disabled-no-lfs
paths: {}
upload: {}
```

`writePackYaml` 落盘前会重新过 schema 并填充默认值，因此上面这份写回磁盘后长这样（实测输出）：

```yaml
schema_version: 1
name: 我的图包
workshop_id: null
source_mod: null
host: steamcloud
vcs:
  lfs: disabled-no-lfs
paths:
  workdir: .
upload:
  prefix: ""
```

---

## 4. 约束说明

### 4.1 `schema_version` 必须为 1，升级时旧工具必须报错

`schema_version` 是 `z.literal(1)`（`src/pack/packyaml.ts:120`），校验失败即抛 `PackError code="PACK_INVALID"`，**不存在"忽略版本继续读"的路径**。这是刻意设计：未来结构升级时递增该值，旧版工具面对新版清单必须**报错退出**而不是按旧结构猜测字段——静默猜测会把用户的图包写坏。B2/B3 若新增字段，必须同步推进这个版本号与本文档，不得只在代码里加字段。

### 4.2 `workshop_id` 未发布时为 `null`

- `number` 或 `null`，**必填键**（`src/pack/packyaml.ts:122-124`）；未发布写 `null`，不能省略、不能写 `0`、不能写空字符串。
- 发布流程（阶段 3B 打包上传）以它判断"新建工坊条目"还是"更新已有条目"；`null` 表示本地图包，不上传。
- `source_mod` 同规则：记录上游模组的工坊 ID，用于魔改包的溯源与后续对账；无上游写 `null`。

### 4.3 `vcs.lfs` 三态语义（约束 10：绝不静默降级）

取值域 `PACK_LFS_MODES`（`src/pack/packyaml.ts:53`），**没有默认值**，缺失即校验失败——强制 `tts pack init` 交互式三选一。三态各自代表"用户/系统当时怎么决定的"，三种都不是错误状态：

| 取值 | 含义 | 谁做的决定 | `.gitattributes` | 后果 |
| --- | --- | --- | --- | --- |
| `enabled` | 已装 git-lfs 且用户启用 | 用户显式启用（含"未装→选择现在装"） | 写入 lfs 规则 | 标准行为，大文件走 LFS |
| `disabled` | **用户显式禁用** | 用户在二次确认后仍选择禁用 | 不写 lfs 规则（或注释掉） | 大文件直接入 git，仓库会膨胀；仅适合纯本地包 |
| `disabled-no-lfs` | **系统未装 git-lfs，工具降级** | 系统缺依赖，用户选择跳过而非装 | 不写 lfs 规则，并加注释说明原因 | 行为同"禁用"，但 init 时多一条 warning；**不是用户主动禁用** |

区分 `disabled` 与 `disabled-no-lfs` 的意义：事后排查"仓库为什么膨胀"时能分辨是用户选择还是环境缺失，也是将来"检测到 lfs 后提议重新启用"这一提示的触发依据（`disabled-no-lfs` 可提议，`disabled` 不该反复骚扰用户）。三态与 `.gitattributes` 的完整对照见 `方案设计.md:923-929`。

### 4.4 `host` 决定图床上传目标

- 默认 `steamcloud`（`src/pack/packyaml.ts:128-130`，与 `方案设计.md:1524` 的"默认 steamcloud（用户已定）"一致）。
- 阶段 3 的 `tts assets upload` 按此字段选择 `ImageHost` 实现：素材改动后把新文件传到对应图床，拿回 URL 再写回存档（`方案设计.md:655`）。
- **`pack.yaml` 的 `host` 与 `assets.yaml` 的 `assets[].host` 是两回事**：前者是"这个包以后往哪传"的策略，后者是"这一条素材现在挂在哪个图床"的事实，历史素材可能来自不同图床。死链迁移按条目上的 `host` 走，不要用包级 `host` 覆盖判断。

### 4.5 `editor.adapter` 可扩展

`editor` 块整体可选，当前 schema 只接受 `adapter: "vscode"`（`src/pack/packyaml.ts:131-136`）。这是给"外部编辑器适配层"（阶段 6）预留的入口：将来新增适配器（如自研插件、其他编辑器）时**扩充这个枚举**，而不是新增平行字段。B2/B3 当前**不应读写 `editor`**，也不要依赖它存在。

---

## 5. 读写 API 与错误码（B2/B3 调用约定）

| API | 行为 | 抛错 |
| --- | --- | --- |
| `readPackYaml(root)` | 读 + 解析 + 校验，返回**默认值已填充**的 `PackYaml` | `PACK_NOT_FOUND`（文件不存在）/ `PACK_INVALID`（非法 YAML 或不合 schema，message 含问题摘要）/ `PACK_READ_FAILED`（其他 IO 错误） |
| `writePackYaml(root, data)` | **写前重新校验入参**（绝不落盘不合规清单），2 空格缩进序列化 | `PACK_INVALID`（入参不合规）/ `PACK_WRITE_FAILED`（IO 错误） |

- 错误统一为 `PackError`（`src/pack/packyaml.ts:63`），带机器可读 `code`；**按 code 分支，不要解析 message 文本**。
- `writePackYaml` 的入参类型是 `PackYaml`（schema 输出类型），但函数内部仍会再校验一次：调用方构造的运行时数据不可信。B2/B3 构造 `PackYaml` 后直接调用即可，不必自己预校验。
- `host` / `paths.workdir` / `upload.prefix` 三个默认值只在**读取与写入时**填充；直接读磁盘上的原始 YAML 文本时它们可能不存在，别假设文件里一定有。

---

## 6. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-04 | 初版（窗口 B1 / Run 2 模板化）。契约来自 `src/pack/packyaml.ts`，Run 2 未修改该模块。 |
