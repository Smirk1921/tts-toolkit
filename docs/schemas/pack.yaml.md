# `pack.yaml` — 图包主清单契约

> **本文档由窗口 B1 产出，B2/B3 必读。**
>
> 依据：`src/pack/packyaml.ts`（Run 1 实现，Run 2 未修改）、`src/pack/init.ts:548-553`。
> 适用结构版本：`schema_version: 1`。本文档描述**已实现的真实契约**，不是设想稿。
>
> **B3 / Run 2（2026-10-05）修订 §4.3**：补 lfs 三态在 init 之后的变更入口（`tts vcs lfs status|enable|disable|migrate`，详见方案设计 §4.11.1）与三方一致性检查；补 init 三选一的**实际决策路径**（`decideLfs`）；修正初版对 `disabled` / `disabled-no-lfs` 下 `.gitattributes` 的描述（实现是不创建该文件）。字段表与其余小节未改动。
> **阶段 5 / Run 2（2026-10-05）修订**：新增 `push` 可选子节点（`backup_retention` / `baseline_check`，§4.4）；原 §4.4 `host` / §4.5 `editor.adapter` 顺延为 §4.5 / §4.6，正文内容未变。字段表、示例与 §5 补 `push` 行。
> **窗口 G / Stage C（2026-10-06）新增**：`tests` 可选子节点（阶段 7 测试运行器的发现配置，§4.7）；字段表、示例与 §5 同步。`tests` 段在 `src/pack/packyaml.ts` 里插在 `upload` 之后，因此其后的行号引用已复核校正（§1 的 `readPackYaml` / `writePackYaml`、§4.4 的 `push` 两处），细节见 §6 变更记录。

---

## 1. 用途与位置

每个图包工作区根目录**有且仅有一份** `pack.yaml`（文件名常量 `PACK_YAML_FILENAME = "pack.yaml"`，`src/pack/packyaml.ts:42`），描述图包整体元数据：显示名、工坊归属、图床、版本控制状态、路径与上传前缀。

- 路径换算：`packYamlPath(root)` → `<root>/pack.yaml`
- 读写入口：`readPackYaml(root)` / `writePackYaml(root, data)`（`src/pack/packyaml.ts:277`、`:323`；行号为窗口 G / Stage C 插入 `tests` 段后的复核值，见 §6 变更记录）
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
| `push` | 对象（严格） | ❌（整块可省） | 允许空映射 `{}` | 阶段 5 写入路径的 push 子配置块；见 §4.4 | Push config block (optional) |
| `push.backup_retention` | `number`（整数） | `push` 出现时可省略 | `20` | 备份保留份数，整数 **1~100**（越界 / 非整数 → `PACK_INVALID`） | Backup retention count, integer 1–100 |
| `push.baseline_check` | `boolean` | `push` 出现时可省略 | `true` | push 前是否做基线冲突检测（`false` = 显式跳过，自担风险） | Whether to check baseline conflicts before push |
| `paths` | 对象（严格） | ✅（键本身必填） | 允许空映射 `{}` | 路径配置块 | Path config block |
| `paths.workdir` | `string` | 可省略 | `"."` | 工作目录，相对 `pack.yaml` 所在目录 | Working directory, relative to `pack.yaml` |
| `upload` | 对象（严格） | ✅（键本身必填） | 允许空映射 `{}` | 上传配置块 | Upload config block |
| `upload.prefix` | `string` | 可省略 | `""` | 图床上的路径前缀，避免多图包互相污染 | Path prefix on the image host |
| `editor` | 对象（严格） | ❌（整块可省） | 无 | 编辑器适配预留块 | Editor adapter block (optional) |
| `editor.adapter` | `"vscode"` | `editor` 出现时必填 | 无 | 当前**只接受 `"vscode"`** 一个值 | Only `"vscode"` accepted today |
| `tests` | 对象（严格） | ❌（整块可省） | 无（整块缺省时读回 `undefined`） | 阶段 7 测试运行器的发现配置块（`tts test` / `tts_test_run`）；见 §4.7 | Test-runner discovery config block (optional) |
| `tests.include` | `string[]` | `tests` 出现时可省略 | `["tests/**/*.test.lua"]` | 相对 pack 根的发现 glob（自实现子集：`*` / `**` / `?`） | Discovery globs, relative to the pack root |
| `tests.exclude` | `string[]` | `tests` 出现时可省略 | `[]` | 在 include 命中结果上再排除的 glob | Globs excluded from the include result |
| `tests.timeout` | `number`（正整数） | `tests` 出现时可省略 | `30000` | 单文件执行超时毫秒数（`0` / 负数 / 小数 → `PACK_INVALID`） | Per-file execution timeout in ms |
| `tests.target_guid` | `string` | `tests` 出现时可省略 | `"-1"` | 目标对象 guid（`"-1"` = Global 脚本） | Target object guid (`"-1"` = Global) |

> 实测确认（Node 24 + tsx 跑真实 schema）：
> - 省略 `paths` / `upload` 键会被拒绝（报 `paths 必须是键值对象`、`upload 必须是键值对象`）；写 `paths: {}` / `upload: {}` 则通过；
> - 省略 `host` 时读出值为 `"steamcloud"`，省略 `paths.workdir` 读为 `"."`，省略 `upload.prefix` 读为 `""`；
> - `schema_version: 2`、未知顶层键（如 `hostt`）、`host: weibo`、缺失 `workshop_id` 均被拒绝；
> - `push` 整块可省：写出后磁盘文本**不含** `push` 键，`readPackYaml` 读回 `push === undefined`（不自作主张补默认值）；
> - `push: {}` 会补出 `backup_retention: 20` / `baseline_check: true`；`push` 内未知键（如 `extra`）被拒（`PACK_INVALID`，message 含 `push：push 含有无法识别的字段：extra`）。

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

push:                        # 可选块，整块可省（阶段 5）；缺省语义见 §4.4
  backup_retention: 20       # 备份保留份数（整数 1-100，默认 20）
  baseline_check: true       # push 前是否做基线冲突检测（默认 true）

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

带 `push` 节点时（实测：`writePackYaml({...最小包, push: {backup_retention: 10, baseline_check: false}})` 的落盘输出；`push: {}` 则补成 `20` / `true`）：

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
push:
  backup_retention: 10
  baseline_check: false
```

带 `tests` 节点时（阶段 7 / 窗口 G 新增；实测：`writePackYaml({...最小包, tests: {}})` 落盘即补出四个默认值——本例即该实测输出；显式给值的字段原样保留）：

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
tests:                       # 可选块，整块可省（阶段 7 测试运行器）
  include:
    - tests/**/*.test.lua    # 相对 pack 根；缺省即此值
  exclude: []                # 缺省空数组
  timeout: 30000             # 单文件超时毫秒；缺省 30000
  target_guid: "-1"          # -1 = Global 脚本；缺省 "-1"
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

| 取值 | 含义 | 何时出现 / 谁做的决定 | `.gitattributes` | 后果 |
| --- | --- | --- | --- | --- |
| `enabled` | 已装 git-lfs 且用户启用 | 显式 `--lfs enabled`；或探测到已装后 `git lfs install` 成功；或用户在菜单选"现在装"且装好后重跑 | 写入 7 条 lfs 规则（png/jpg/jpeg/gif/webp/obj/ttsmod） | 标准行为，大文件走 LFS |
| `disabled` | **用户显式禁用** | 显式 `--lfs disabled`；或用户在三选一菜单选"跳过"并**通过二次确认**（输入 y/yes） | **不写 `.gitattributes`**（`src/pack/init.ts:557-560` 只在 enabled 时写） | 大文件直接入 git，仓库会膨胀；仅适合纯本地包 |
| `disabled-no-lfs` | **系统未装 git-lfs，工具降级** | 非交互环境（`skipLfsPrompt` 或 `stdout` 非 TTY）自动降级；**不是用户主动禁用** | 同 `disabled`：不写该文件 | 行为同"禁用"，但 init 时多一条 warning（`src/pack/init.ts:477-478`、`:485-488`） |

> 修正（B3 / 2026-10-05）：初版此处写"不写 lfs 规则（或注释掉）/ 并加注释说明原因"，与实现不符——init 在 `disabled` / `disabled-no-lfs` 下**根本不创建** `.gitattributes`，没有任何注释行；lfs 规则只由 `enabled` 或 `tts vcs lfs enable` 写入。

**init 时的实际决策路径**（`decideLfs`，`src/pack/init.ts:471-492`）：

```text
tts pack init 的 lfs 决策
    ↓
--lfs enabled|disabled 显式给出 ──────→ 直接采用（不探测、不安装）      :473-475
    ↓ 未显式给出
skipLfsPrompt（测试 / 非交互管道） ───→ disabled-no-lfs               :477-478
    ↓
检测 `git lfs version`（isGitLfsInstalled，:371-377）
    ├── 能执行成功（已装） ──────────→ `git lfs install` → enabled    :481-484
    └── 执行失败（未装）
          ├── stdout 非 TTY ────────→ 打 warning，disabled-no-lfs     :485-488
          └── TTY ──→ 三选一菜单（promptLfsChoice，:426-463）
                       1) 现在装：再探一次；装了 → install → enabled；
                          仍未装 → 打印安装指引并**中止**（skipped，不写 pack.yaml）
                       2) 跳过（禁用）：需再次输入 y/yes 确认；
                          否则视同取消（skipped）
                       3) 取消：skipped
```

- `skipped` 分支**不写 pack.yaml**（`vcs.lfs` 必填且无默认值，不能猜），目录骨架与 git 仓库已建出，重跑 init 可续完；CLI 层把"未写出 pack.yaml"以退出码 1 标记（`src/cli/commands/pack.ts:259-263`）。
- 设计 `方案设计.md:890` §4.11.1 还画了"安装但版本过老（< 2.0）→ 提示升级"分支；**当前实现没有版本号下限检查**——`isGitLfsInstalled` 只判断 `git lfs version` 能否执行成功（`src/pack/init.ts:367-377`）。这是已知的实现缺口，修订 schema 时不应照设计稿臆造该分支。

**三态可在 init 之后变更**（阶段 2C 新增，命令完整语义见 `方案设计.md:890` §4.11.1）：

- `tts vcs lfs status`：只读，打印三方事实（是否装 git-lfs 及版本、`.gitattributes` 是否含 lfs 规则、`pack.yaml` 的 `vcs.lfs`）并报告一致性（`src/cli/commands/vcs.ts:429`，复用 `inspectLfs`）；
- `tts vcs lfs enable`：把 `.gitattributes` 缺失的 lfs 行补上（已有行不动），并把 `vcs.lfs` 写为 `enabled`（`src/vcs/lfs.ts:291`）；
- `tts vcs lfs disable`：清空 `.gitattributes` 中含 `filter=lfs` 的行（其余行保留；清空后只剩空行 / 注释则整个文件删除），并把 `vcs.lfs` 写为 `disabled`（`src/vcs/lfs.ts:338`）——**`disableLfs` 自己不做二次确认**（该函数注释 `src/vcs/lfs.ts:329` 与模块头注释 `:21` 明示），确认在 CLI 层：交互环境要求输入 yes，非交互环境必须显式 `--yes`，否则拒绝执行（`src/cli/commands/vcs.ts` 的 `lfsDisableSub`）；
- `disabled-no-lfs` **不会**由 disable 命令写出：它是 init 的非交互降级态，事后无法区分"当时没装"与"用户禁用"就只能靠这个取值；
- `tts vcs lfs migrate` 只重写历史（`git lfs migrate import --everything`），**不改**本字段。

区分 `disabled` 与 `disabled-no-lfs` 的意义：事后排查"仓库为什么膨胀"时能分辨是用户选择还是环境缺失，也是将来"检测到 lfs 后提议重新启用"这一提示的触发依据（`disabled-no-lfs` 可提议，`disabled` 不该反复骚扰用户）。三态与 `.gitattributes` 的完整对照见 `方案设计.md:933-939`。

**三方一致性检查**（`inspectLfs`，`src/vcs/lfs.ts:243-272`；`tts vcs verify` 的 git 检查项复用同一实现）：

| 事实组合 | 判定 |
| --- | --- |
| `vcs.lfs: enabled` 但 `.gitattributes` 无 lfs 规则 | 不一致——新提交的图片不会走 lfs。`tts vcs lfs status` 报 warning 并退 1；`tts vcs verify` 报 **error** `VCS_LFS_INCONSISTENT`（`src/vcs/verify.ts:145-150`） |
| `vcs.lfs: disabled` 但 `.gitattributes` 仍含 lfs 规则 | 不一致——文件会继续被 lfs 改写。`tts vcs verify` 报 **warning** `VCS_LFS_INCONSISTENT`（`src/vcs/verify.ts:152-157`） |
| `vcs.lfs: disabled-no-lfs` | 上述两项均**不适用**（"明确不用 lfs 且预期不装"，不参与 .gitattributes 对照） |
| `.gitattributes` 声明 lfs 但本机没装 git-lfs | 图片无法正常 checkout。`tts vcs verify` 报 **error** `VCS_LFS_MISSING`；`tts vcs lfs status` 报 warning（`src/vcs/lfs.ts:255`、`src/vcs/verify.ts:138-143`） |
| 三者一致 | `tts vcs lfs status` 打印 `cli.vcs.lfs.consistent` 并退 0 |

`.registry.yaml` 条目的 `lfs_status` 是本字段的**冗余副本**（读索引不必逐包开 `pack.yaml`），两者不一致时**以本文件为准**；`registry.ts` 不做交叉校验，详见 `docs/schemas/registry.yaml.md` §6.4。

#### 4.3.1 离线用户克隆含 lfs 的仓库（搁置项 S13，2026-10-05 补）

**问题**：图包用 git-lfs 后，仓库里的图片其实是"lfs 指针文件"（文本，指向真实对象在 `.git/lfs/objects/` 或远端 lfs 存储里）。**纯离线用户**（不打算推远端，只想本地用）克隆仓库时会被 lfs  smudge filter 卡住——它需要联网从远端 lfs 存储下载真实图片。

**三种克隆场景**：

| 场景 | 命令 | 工作区得到什么 | 适用 |
| --- | --- | --- | --- |
| **完全本地仓库**（无远端，源仓库有完整 `.git/lfs/objects/`） | `git clone /path/to/repo` | 真实图片（lfs 对象从源仓库本地复制） | U盘/局域网分享 |
| **远端仓库 + 跳过 lfs 下载** | `GIT_LFS_SKIP_SMUDGE=1 git clone <url>` | lfs 指针文件（图片不可用） | 只看代码与元数据，不看图 |
| **远端仓库 + 完整下载** | `git clone <url>`（默认） | 真实图片（联网从远端 lfs 存储拉） | 标准场景 |

**已克隆的仓库如何把指针换真图**：

```bash
git lfs pull              # 拉所有 lfs 对象
git lfs pull --include="decks/冒险牌堆/**"   # 只拉特定路径
```

**本工具的支持**：

- `tts vcs lfs status` 与 `tts vcs verify` 会识别"`.gitattributes` 声明了 lfs 但本机没装 git-lfs"的不一致状态，按 §4.3 三方一致性表报错（`VCS_LFS_MISSING`），提醒用户工作区里看到的可能是指针文件而非真图。
- `src/vcs/lfs.ts` 的 `isLfsPointer(filePath)` 可判断单个文件是不是 lfs 指针（读文件头是否以 `version https://git-lfs` 开头），供需要"这张图到底可用不可用"的工具代码使用。
- **不做**：本工具**不主动**帮用户跑 `git lfs pull`——是否下载真实图片是用户的选择（体积 vs 可用性），工具只报告状态。

### 4.4 `push` 子节点（阶段 5 写入路径的可选配置）

```yaml
push:                        # 可选块，整块可省
  backup_retention: 20       # 备份保留份数（1-100，默认 20）
  baseline_check: true       # push 前是否做基线冲突检测（默认 true）
```

- **可选节点**：schema 里是 `z.optional(z.strictObject({...}))`（`src/pack/packyaml.ts:190-202`；行号为插入 `tests` 段后的复核值）——`pack.yaml` 不写 `push` 键完全合法，`tts pack init` 的初始模板也不含它（向后兼容旧清单）。
- **内层默认值**：只要 `push` 键出现，`backup_retention` 缺省填 `20`、`baseline_check` 缺省填 `true`（zod `.default()`）；`push: {}` 合法，读回即 `{backup_retention: 20, baseline_check: true}`（实测见 §2）。
- **整块缺省语义**：省略 `push` 时 `readPackYaml` 返回的 `push` 是 `undefined`（**不会**自动补出默认值，`src/pack/packyaml.ts:271-272`；行号为插入 `tests` 段后的复核值）；语义上等价于 `{backup_retention: 20, baseline_check: true}`。
- **zod strictObject**：内层任何未列出的键都会被拒（`PACK_INVALID`）——把 `backup_retention` 拼成 `backupRetention` 会直接报错，不会静默忽略（`src/pack/packyaml.ts:190-202`；与全文件同一策略，见 §1）。
- **取值约束**：`backup_retention` 必须是**整数**且 ∈ [1, 100]（`0` / `101` / `2.5` 均报 `PACK_INVALID`）；`baseline_check` 必须是布尔值。
- **消费现状（重要）**：本节点是**契约先行**——当前仓库中除 schema 定义外**没有**读取 `pack.push` 的代码路径（`grep -rn -e backup_retention -e baseline_check src/` 只命中 `packyaml.ts` 的 schema 与 `watch.ts` 的注释）。实际生效的口径来自命令参数 / hub 请求字段：`tts pack push --backup-retention` / `--no-baseline-check`（CLI 校验 1~100）与 `POST /v1/push` 的 `backupRetention` / `skipBaselineCheck`（契约见 `docs/schemas/hub-control.md` §4.11）；`writePackYaml` 会原样保留并规范化本节点。
- 两个字段的实际行为依据：
  - `backup_retention` → `createBackup({retention})`：只保留最新 N 份 `.tts/backups/`，其余删除（`<=0` 视为不清理；`src/safety/backup.ts:411`、`:546-559`）。
  - `baseline_check: false` → 显式跳过「游戏侧相对基线被人改过」的拦截（`skipBaselineCheck`），冲突仍记入 push 结果；这是**自担风险**开关（`src/pack/push.ts:445-446`、`:669-675`）。基线契约见 `docs/schemas/baseline.json.md`。

### 4.5 `host` 决定图床上传目标

- 默认 `steamcloud`（`src/pack/packyaml.ts:128-130`，与 `方案设计.md:1532` §6.5 的"默认 `steamcloud`（用户已定）"一致）。
- 阶段 3 的 `tts assets upload` 按此字段选择 `ImageHost` 实现：素材改动后把新文件传到对应图床，拿回 URL 再写回存档（`方案设计.md:663`）。
- **`pack.yaml` 的 `host` 与 `assets.yaml` 的 `assets[].host` 是两回事**：前者是"这个包以后往哪传"的策略，后者是"这一条素材现在挂在哪个图床"的事实，历史素材可能来自不同图床。死链迁移按条目上的 `host` 走，不要用包级 `host` 覆盖判断。

### 4.6 `editor.adapter` 可扩展

`editor` 块整体可选，当前 schema 只接受 `adapter: "vscode"`（`src/pack/packyaml.ts:131-136`）。这是给"外部编辑器适配层"（阶段 6）预留的入口：将来新增适配器（如自研插件、其他编辑器）时**扩充这个枚举**，而不是新增平行字段。B2/B3 当前**不应读写 `editor`**，也不要依赖它存在。

### 4.7 `tests` 子节点（阶段 7 测试运行器的发现配置）

```yaml
tests:                       # 可选块，整块可省（阶段 7）
  include:
    - tests/**/*.test.lua    # 相对 pack 根的 glob（缺省即此值）
  exclude: []                # 在 include 命中结果上再排除（缺省空数组）
  timeout: 30000             # 单文件执行超时毫秒（正整数，缺省 30000）
  target_guid: "-1"          # 目标对象 guid（"-1" = Global 脚本）
```

- **可选节点**：schema 里是 `z.optional(z.strictObject({...}))`（`src/pack/packyaml.ts:165-189`，插在 `upload` 与 `push` 之间）——`pack.yaml` 不写 `tests` 完全合法，`tts pack init` 的初始模板也不含它（`src/pack/init.ts:544-553` 只写 schema_version / name / workshop_id / source_mod / vcs / paths / upload），向后兼容旧清单。
- **内层默认值**（zod `.default()`，读 / 写两侧都填充）：`include` → `["tests/**/*.test.lua"]`、`exclude` → `[]`、`timeout` → `30000`、`target_guid` → `"-1"`。`tests: {}` 合法，读回即这四个默认值。
- **整块缺省语义**：省略 `tests` 时 `readPackYaml` 返回的 `tests` 是 `undefined`（**不会**自动补出默认值，与 `push` 同款，见 §4.4）；语义上等价于上表的四个默认值。需要"生效值"的调用方应写 `pack.tests?.include ?? ...` 这类兜底。
- **zod strictObject**：内层任何未列出的键都会被拒（`PACK_INVALID`），错误文案由 `strictObjectError("tests")` 生成（`src/pack/packyaml.ts:91-100`）。
- **取值约束**：`timeout` 必须是**正整数**；`include` / `exclude` 必须是数组且元素是字符串（数组元素本身不要求非空）；`target_guid` 必须是字符串（`"-1"` 是字符串而非数字）；`tests` 本身必须是对象。

**实测行为**（本文档窗口用构建产物 `dist/pack/packyaml.js` + Node 24 实跑，非设想）：

| 输入（`tests:` 段） | 结果 |
| --- | --- |
| `include: ["lua/**/*.test.lua"]` / `exclude: ["lua/skip/**"]` / `timeout: 1234` / `target_guid: "654321"` | 读回原值：`{"include":["lua/**/*.test.lua"],"exclude":["lua/skip/**"],"timeout":1234,"target_guid":"654321"}` |
| `tests: {}` | 读回四个默认值：`{"include":["tests/**/*.test.lua"],"exclude":[],"timeout":30000,"target_guid":"-1"}` |
| 整块省略 | `readPackYaml(...).tests === undefined`；`writePackYaml` 落盘文本里**不含** `tests` 键 |
| `tests: {unknow_field: 1}` | `PACK_INVALID`：`tests：tests 含有无法识别的字段：unknow_field` |
| `timeout: 0` / `timeout: -5` | `PACK_INVALID`：`tests.timeout：tests.timeout 必须是正数` |
| `timeout: 2.5` | `PACK_INVALID`：`tests.timeout：tests.timeout 必须是整数` |
| `timeout: "soon"` | `PACK_INVALID`：`tests.timeout：tests.timeout 必须是数字` |
| `include: lua/*.test.lua`（非数组） | `PACK_INVALID`：`tests.include：tests.include 必须是数组` |
| `include: [42]`（元素非字符串） | `PACK_INVALID`：`tests.include.0：tests.include 必须是字符串数组` |
| `target_guid: 42`（数字） | `PACK_INVALID`：`tests.target_guid：tests.target_guid 必须是字符串` |
| `tests:` 写成数组 | `PACK_INVALID`：`tests：tests 必须是键值对象` |

**与 Stage A `discover.ts` 的关系（重要）**：

- `discoverTests`（`src/test/discover.ts:388`）**不经过 `readPackYaml`**——它用 `yaml` 的 `parse` 直读 `pack.yaml`，只用模块内的 `testsSectionSchema`（`src/test/discover.ts:117-146`）校验 `tests` 子段。因此本字段进入 `packYamlSchema` 的实际效果是：**含 `tests` 段的清单不再被 `readPackYaml` 以 `PACK_INVALID`（未知键）拒绝**；发现逻辑本身仍走 discover 自己那份 schema。
- 两处 schema 的字段名与语义对齐（`include` / `exclude` / `timeout` / `target_guid`）。实测：一份由 `writePackYaml` 落盘（`tests: {include: ["lua/**/*.test.lua"], exclude: [], timeout: 1234, target_guid: "654321"}`）的清单可被 `discoverTests` 直接消费——无 warning，只命中 `lua/a.test.lua` 与 `lua/sub/b.test.lua`（`*.spec.lua` 不命中），且 `timeout` / `target_guid` 透传到每个发现条目。
- **两处的差异**（有意保留，不是 bug）：discover 侧每个字段都是 `.optional()` 且 glob 元素要求非空字符串（`.min(1)`），packyaml 侧给默认值、元素不要求非空。因此 `include: [""]` 这类输入 **packyaml 侧通过**（读回 `[""]`）而 **discover 侧拒绝**——discover 会告警 `TEST_DISCOVER_PACK_YAML_INVALID` 并回退默认发现配置（实测：仍然发现 `tests/a.test.lua`，即空 glob 未生效）。写清单的工具不要产出空 glob。
- **发现优先级**（`src/test/discover.ts:395-398`，S4 混合语义）：调用方显式传入的 `include` / `exclude` **整体替换**本节点的值 > 本节点 > 内置默认。`tts test [path]` 的位置参数就是通过"显式 include"覆盖本节点的。
- **消费方**：`src/test/discover.ts`（`tts test`、MCP `tts_test_run`、hub `POST /v1/test/run` 共用），契约见 `docs/schemas/test-report.json.md`。

---

## 5. 读写 API 与错误码（B2/B3 调用约定）

| API | 行为 | 抛错 |
| --- | --- | --- |
| `readPackYaml(root)` | 读 + 解析 + 校验，返回**默认值已填充**的 `PackYaml` | `PACK_NOT_FOUND`（文件不存在）/ `PACK_INVALID`（非法 YAML 或不合 schema，message 含问题摘要）/ `PACK_READ_FAILED`（其他 IO 错误） |
| `writePackYaml(root, data)` | **写前重新校验入参**（绝不落盘不合规清单），2 空格缩进序列化 | `PACK_INVALID`（入参不合规）/ `PACK_WRITE_FAILED`（IO 错误） |

- 错误统一为 `PackError`（`src/pack/packyaml.ts:63`），带机器可读 `code`；**按 code 分支，不要解析 message 文本**。
- `writePackYaml` 的入参类型是 `PackYaml`（schema 输出类型），但函数内部仍会再校验一次：调用方构造的运行时数据不可信。B2/B3 构造 `PackYaml` 后直接调用即可，不必自己预校验。
- `host` / `paths.workdir` / `upload.prefix` 三个默认值只在**读取与写入时**填充；直接读磁盘上的原始 YAML 文本时它们可能不存在，别假设文件里一定有。
- `push` 节点更特殊（见 §4.4）：**节点整块缺省时不会被补出**（`readPackYaml` 返回 `push: undefined`），只有节点出现时其内层默认值才在读写两侧填充。需要"生效值"的调用方应写 `pack.push?.backup_retention ?? 20` 这类兜底，不要假设 `pack.push` 一定存在。
- `tests` 节点与 `push` 同款（见 §4.7）：整块缺省时 `tests: undefined`，出现时四个字段在读写两侧都填默认值；但它的消费方是 `src/test/discover.ts`，且**显式传入的 include/exclude 会整体替换本节点**（发现优先级见 §4.7）。

---

## 6. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-04 | 初版（窗口 B1 / Run 2 模板化）。契约来自 `src/pack/packyaml.ts`，Run 2 未修改该模块。 |
| 2026-10-05 | B3 / Run 2 修订 §4.3：三态可在 init 后经 `tts vcs lfs status\|enable\|disable` 变更、三方一致性检查（`inspectLfs` / `vcs verify` 的错误码与 severity）、`lfs_status` 冗余副本指向 `docs/schemas/registry.yaml.md`；修正 `.gitattributes` 在 `disabled` / `disabled-no-lfs` 下的描述。 |
| 2026-10-05 | B3 / Run 2 核验修订 §4.3：补 init 实际决策路径图（`decideLfs`，含 `skipped` 中止分支）；明确设计 §4.11.1 的"版本过老"分支当前**未实现**；补 `tts vcs lfs status`；引用行号校正（init.ts、方案设计.md），并校正 §4.4 两处失效的设计行号引用（1524→1532、655→663）。 |
| 2026-10-05 | 阶段 5 / Run 2 修订：新增 §4.4 `push` 子节点（可选；`backup_retention` 整数 1~100 默认 20、`baseline_check` 默认 true；内层 `strictObject` 未知键拒绝；节点整块缺省时读回 `undefined` 而不补默认值）；字段表、完整示例与 §5「默认值填充」说明同步；原 §4.4 `host` / §4.5 `editor.adapter` 顺延为 §4.5 / §4.6（内容未变）。落盘/回读行为为本文档窗口用真实模块实测（`npx tsx` + Node 24，输出见 §2 / §3）。 |
| 2026-10-06 | 窗口 G / Stage C（C3）修订：新增 §4.7 `tests` 子节点（阶段 7 测试运行器；`include` / `exclude` / `timeout` 正整数 / `target_guid` 四字段 + 默认值 + 实测非法输入的中文报错 + 与 `src/test/discover.ts` 的兼容关系与两处差异 + 发现优先级）；字段表补 5 行、§3 补 `tests` 落盘示例、§5 补一条缺省语义说明。§4.7 的全部行为为本文档窗口**实跑构建产物**（`dist/pack/packyaml.js` / `dist/test/discover.js` + Node 24）所得，非设想。另：`tests` 段插在 `upload` 之后，其后行号 +32，故 §1 读写入口（225/271 → 277/323）与 §4.4 两处 `push` 引用（158-170 → 190-202、239-241 → 271-272）已复核校正；**插入点之前**的若干引用早于本次修改即已漂移（如 §1 的 `:118` 当时实为 `:123`、`:120` 实为 `:125`），本次未一并重排，引用源码时以实际文件为准。 |
