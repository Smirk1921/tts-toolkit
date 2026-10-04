# `assets.yaml` — 素材清单契约

> **本文档由窗口 B1 产出，B2/B3 必读。**
>
> 依据：`src/pack/manifest.ts`（Run 1 实现，Run 2 未修改）。
> 适用结构版本：`schema_version: 1`。本文档描述**已实现的真实契约**，不是设想稿。

---

## 1. 用途与位置

`assets.yaml` 是**图包引用的外部素材的台账**：记录每个素材落在工作区里的相对路径、当前生效 URL、内容哈希与所属图床。它服务三类流程：

- **素材续传**：本地文件缺失时按 `url` 重新下载（`sha256` 校验完整性）；
- **URL 体检 / 死链修复**：批量探测 `url`，失效的按 `host` 走对应图床的迁移流程；
- **版本控制校验**：B3 的 `vcs/verify.ts` 按 `sha256` 判断工作区文件与台账是否一致。

位置与可选性：

- 路径：`<root>/assets.yaml`（文件名常量 `ASSETS_YAML_FILENAME`，`src/pack/manifest.ts:80`）
- **图包根目录至多一份，且允许不存在**：`readAssetsManifest(root)` 在文件缺失时**返回 `null` 而不是报错**（`src/pack/manifest.ts:453-475`）——图包完全可以不引用任何外部素材。
- 读写入口：`readAssetsManifest(root)` / `writeAssetsManifest(root, manifest)`（`src/pack/manifest.ts:462`、`:489`）

**严格模式**：根对象与每条素材条目都是 `z.strictObject`（`src/pack/manifest.ts:203-230`）——**未在字段表中出现的键一律拒绝**，缺必填键同样拒绝。

---

## 2. 字段表

| 字段 | 类型 | 必填 | 默认 | 说明（中文） | Description (EN) |
| --- | --- | --- | --- | --- | --- |
| `schema_version` | 字面量 `1` | ✅ | 无 | 结构版本，本版固定 1 | Structure version; literal `1` |
| `assets` | 素材条目数组 | ✅ | 无（**可以是空数组** `[]`） | 台账主体 | Asset entries; empty array is legal |
| `assets[].file` | `string` | ✅ | 无 | 素材在图包内的落盘路径，**相对图包根**；见 §4.1 | Path inside the pack, relative to pack root |
| `assets[].url` | `string`，须为合法 URL | ✅ | 无 | 该素材**当前生效**的 URL；见 §4.2 | Currently effective URL |
| `assets[].sha256` | `string` | 可省略 | 无 | 素材内容哈希；见 §4.3 | Content hash of the file |
| `assets[].host` | `"steamcloud"` \| `"imgur"` \| `"gdrive"` \| `"dropbox"` \| `"custom"` | 可省略 | 无 | 该素材挂在哪个图床；见 §4.4 | Image host this asset lives on |

---

## 3. 完整示例

```yaml
schema_version: 1
assets:
  - file: decks/冒险牌堆/001_正面.png          # 相对图包根，用 "/" 分隔
    url: https://steamuserimages-a.akamaihd.net/ugc/1234567890/ABCDEF.png
    sha256: 9f2c1d0e5b8a4376c1e2f0a9b7d84c6382e5f1a0d9c8b7a6958473625140ffee
    host: steamcloud

  - file: objects/地图板块A/tile.png
    url: https://i.imgur.com/abcd123.png
    host: imgur                              # 历史素材可能来自不同图床

  - file: objects/船长棋子/captain.obj
    url: https://example.com/models/captain.obj
    # sha256 / host 可省略：旧台账或尚未体检的条目允许只记 file + url
```

空台账（合法，等价于"本包当前不引用外部素材"）：

```yaml
schema_version: 1
assets: []
```

---

## 4. 关键约束说明

### 4.1 `file` 相对图包根

- 是**相对于图包根目录**的路径（不是相对 `assets.yaml`，虽然两者位置相同）。示例：`decks/冒险牌堆/001_正面.png`、`objects/地图板块A/tile.png`。
- **schema 不做任何路径校验**：不校验是否绝对路径、不校验 `..` 越界、不校验文件是否存在。写入方（切片 / 导入流程）必须自己保证路径规范；消费方（B3 校验、死链修复）读文件前应自行 `path.resolve(root, file)` 并确认结果仍在 `root` 之内。
- 路径分隔符建议统一用 `/`（跨平台、git diff 稳定）；Windows 上的 `\` 不会被 schema 拒绝，但不同人写出的台账会 diff 出噪音。
- `file` 是台账的**唯一标识**：同一条目在数组中重复出现、或两条目 `file` 相同而 `url` 不同，schema 都不会拦（数组本身允许重复），去重与冲突检测由消费方负责。

### 4.2 `url` 是当前生效 URL（可能已经死链）

- 只校验 **URL 形式**（`z.string().url()`，`src/pack/manifest.ts:206-208`）；**不做连通性校验、不判断图床是否还能访问**——所以台账里的 URL 完全可能是死链，这是已知且允许的状态。
- 实测：`url: 不是URL` 会被拒绝并抛 `ASSETS_INVALID`。
- 语义是"**当前生效**"：素材换图床 / 重新上传后，写回的新 URL 要覆盖旧值，旧值不保留在本文件里（历史溯源靠 git 提交历史）。B3 的体检流程发现死链后，应把修复结果**写回这里**。
- URL 里可能带 `{en}...{zh-cn}...` 形式的**语言变体占位**（TTS 的多语言 URL 写法）。本工具约定这类值**原样保留、不当普通 URL 处理**（`施工流程.md` 任务 2B.5 的"`{lang}` 防御"）；即便它不符合 `url()` 校验而被拒绝，也不得擅自改写或"修复"。这是当前 schema 与 TTS 现实之间已知的摩擦点，处理方案需主窗口确认后再动。

### 4.3 `sha256` 用于完整性校验（B3 的 `vcs/verify.ts` 要用）

- 保存素材文件内容的 SHA-256，供**续传 / 完整性比对 / 版本校验**使用。
- schema 只约束它是 `string`（`src/pack/manifest.ts:209`）：**不校验长度、不校验是否 64 位十六进制、不校验大小写**。因此 B3 的 `verify.ts` 必须自行定义并写死比较规则（建议：写入侧统一小写十六进制、比较前对两侧 `toLowerCase()`），否则会出现"哈希其实相同、只是大小写不同"的假告警。
- 建议比较语义（B3 落地时确定并写进 B3 的文档，此处仅为约定建议）：台账有 `sha256` 而本地文件缺失 → 按 `url` 重新下载后校验；下载结果不符 → 报错并保留旧文件，不静默覆盖。
- 字段可省：尚未计算哈希的条目允许只有 `file` + `url`；消费方遇到缺 `sha256` 时应**跳过完整性校验并提示**，不得当成空字符串比较。

### 4.4 `host` 标识图床，用于死链迁移

- 取值域与 `pack.yaml` 的 `host` 完全相同（`steamcloud` / `imgur` / `gdrive` / `dropbox` / `custom`，`src/pack/manifest.ts:210-212`）。
- 作用：某条 URL 失效时，决定"去哪找 / 往哪传"——例如 `steamcloud` 走 Steam 图床的重传流程，`imgur` 走 Imgur 的回退逻辑（`方案设计.md:655`、§7 图床章节）。
- **条目级 `host` ≠ 包级 `pack.yaml` 的 `host`**：包级 `host` 是"以后往哪传"的策略，条目级是"这条素材现在挂在哪"的事实。历史素材来自多个图床是完全正常的，死链迁移必须按**条目上的 `host`** 判断，不要用包级策略覆盖。
- 字段可省：旧台账 / 尚未体检的条目允许不写。消费方遇到缺 `host` 时按包级 `pack.yaml.host` **作为兜底猜测**可以，但必须在输出里标明"host 未知、按包级策略推断"，不要假装确定。

---

## 5. 现状与待办（B2/B3 必读）

- **本契约目前没有生产者**：全仓 `grep` 确认，`readAssetsManifest` / `writeAssetsManifest` 在 `src/pack/manifest.ts` 与其单元测试之外**没有任何调用方**（`src/pack/`、`src/cli/` 均无）。也就是说 `assets.yaml` 的 schema 与读写已就绪，但**切片 / 导入 / 上传等流程还没有任何一处往它里面写**。
- 因此 B2/B3 是它的第一批量产消费者：由谁负责登记条目（切片时？导入 `assets.yaml` 时？上传换 URL 后？）、登记粒度（每个卡图一条还是每张图集一条）**尚未决定**，动工前需与主窗口确认，并把决定写进各自窗口的文档；本文档届时同步更新。
- ⚠️ **命名冲突已裁决（窗口 C 主窗口，2026-10-05）**：`方案设计.md` §5.11 的"素材导入清单"（顶层 `pack:` / `decks:` / `objects:`，描述"把哪些文件装进哪个卡堆"）与本文件的 `assets.yaml`（素材 URL 台账，顶层 `schema_version` + `assets[]`）同名不同物。裁决结果：**导入清单定名 `import.yaml`**，契约见 `docs/schemas/import.yaml.md`；**本文件 `assets.yaml` 保留给 URL 台账**。消费方引用时按此区分，不再存在歧义。
- 错误码：`ASSETS_INVALID`（非法 YAML / 不合 schema / 写前校验失败）/ `ASSETS_READ_FAILED` / `ASSETS_WRITE_FAILED`；**文件不存在不是错误**（返回 `null`）。
- `root` 传空串或空白字符串会抛普通 `Error`（调用方编程错误），不是 `PackError`。

---

## 6. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-04 | 初版（窗口 B1 / Run 2 模板化）。契约来自 `src/pack/manifest.ts`，Run 2 未修改该模块。 |
| 2026-10-05 | §5 命名冲突裁决落笔（窗口 C 主窗口）：导入清单定名 `import.yaml`，本文件保留给 URL 台账。 |
