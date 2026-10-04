# `.ttsmod` — 打包分发格式契约

> **本文档由窗口 C（阶段 3）产出，打包 / 解包使用方必读。**
>
> 依据：`src/archive/ttsmod.ts`（读写主模块）、`src/archive/cachekey.ts`（缓存键）、`src/archive/detect.ts`（扩展名三级推导）、`src/cli/commands/pack.ts`（`pack export` / `pack import`）；格式反向验证见 `方案设计.md` §12 与 `参考资料/02-数据格式/ttsmod打包格式.md`。
> 本文档描述**已实现的真实契约**，不是设想稿。`.ttsmod` 就是一个普通 ZIP（Zip64），无官方 schema，内容镜像 TTS 本地 `Mods/` 目录结构。

---

## 1. 自包含原理（全部机制）

**存档 JSON 里的 URL 一个字不改**；素材条目名 = TTS 自己的缓存键 `sanitize(url) + 扩展名`。接收方解压到 `Mods` 的**父目录**后，TTS 按同样规则算出文件名，直接命中本地文件，**永远不会去访问原始 URL**。不需要 URL 重写、不需要 base64、不需要 manifest。

推论（实现红线）：

- 存档 JSON **逐字节原样入包**（`exportTtsmod` 的 `saveJson`）；
- 扩展名必须按 TTS 的缓存约定推导（§4.2），错一个字符接收方就命中不了缓存；
- 因此条目名由 `src/archive/cachekey.ts` 的 `cacheFileName(url, ext)` 统一生成，调用方不得手拼。

---

## 2. 条目布局

| 条目名 | 何时出现 | 说明 |
| --- | --- | --- |
| `Mods/Workshop/<主干>.json` | 默认（`saveJsonTarget: "workshop"`） | 存档 JSON，逐字节原样。`<主干>` 缺省 = 工坊 ID；工坊 ID 为 null 时 = 净化后的图包名 |
| `Saves/<主干>.json` | `saveJsonTarget: "saves"` | 存档备份（修正原工具"存档也写进 `Mods/Workshop/`"的怪癖）；`<主干>` 缺省 = 净化后的图包名 |
| `Mods/Workshop/Thumbnails/<主干>.png` | 调用方提供 `thumbnail` 时 | 工坊缩略图（PNG 字节原样） |
| `Mods/Images/<sanitize(url)><ext>` | 有 image 素材时 | 图片：扩展名走三级推导 |
| `Mods/Models/<sanitize(url)>.obj` | 有 model 素材时 | 模型：固定扩展名 `.obj`（TTS 的 `ConvertModelURL` 无条件追加，URL 自带 `.obj` 也照样再追加） |
| `Mods/Assetbundles/<sanitize(url)>.unity3d` | 有 assetbundle 素材时 | 资源包：固定 `.unity3d` |
| `Mods/PDF/<sanitize(url)>.PDF` | 有 pdf 素材时 | PDF：固定 `.PDF`（大写是实测约定） |
| `Mods/Audio/<sanitize(url)><ext>` | 有 audio 素材时 | 音频：原工具盲区，本工具新增 |
| `manifest.json` | 默认（`manifest: false` 时不写） | 工具 / 版本 / 时间 / 源工坊 ID / 素材清单（§5）；**新增的根条目**，旧读取器不认识会当普通文件忽略，旧布局一个字节不变 |
| `README.txt` | `readme: "both"`（默认） | 中英双语随包说明，单文件两段 |
| `README-zh-CN.txt` / `README-en-US.txt` | `readme: "zh"` / `"en"` | 单语言随包说明；`readme: "none"` 不生成 |

目录常量：`ARCHIVE_ENTRY_DIRS`（`src/archive/ttsmod.ts:116-122`）＝ `{ image: "Mods/Images", model: "Mods/Models", assetbundle: "Mods/Assetbundles", pdf: "Mods/PDF", audio: "Mods/Audio" }`。条目名一律 `/` 分隔。

**条目次序**（写出时固定）：存档 JSON → 缩略图 → 素材（类型次序 image → model → assetbundle → pdf → audio，同类型内按条目名字典序）→ manifest.json → README（`src/archive/ttsmod.ts:843-939`）。

**同名条目去重**：不同 URL 撞同一个缓存键（`sanitize` 后相同）时保留首条，后续条目丢弃并逐条告警（`archive.export.duplicateEntry`）。

---

## 3. sanitize 规则（两套，别混用）

### 3.1 URL → 缓存键 `sanitizeUrl`（`src/archive/cachekey.ts:46-48`）

- 规则：**去掉 URL 中所有非 ASCII 字母数字字符**（`[^A-Za-z0-9]`），**大小写原样保留**；
- 实测样本（已按真实 `.ttsmod` 验证）：
  - `https://raw.githubusercontent.com/DasUmlaut/TTSLibrary/master/dials/dial-12-0.jpg`
    → `httpsrawgithubusercontentcomDasUmlautTTSLibrarymasterdialsdial120jpg.jpg`（`-` `/` `:` `.` 全部去除）；
  - `http://nikulas.webs.com/UV.png` → `httpnikulaswebscomUVpng.png`；
  - `http://pastebin.com/raw.php?i=cDn7Eum6` + `.obj` → `httppastebincomrawphpicDn7Eum6.obj`；
- 该函数必须与 TTS（`CustomCache.ConvertURL` 系列）**逐字符一致**；空串 → 空串；本模块不做 Unicode 扩展（存档 URL 实全 ASCII）。

### 3.2 图包名 / 存档名 → 文件名 `sanitizeFileName`（`src/archive/ttsmod.ts:506-510`）

- Windows 非法文件名字符 `<>:"/\|?*` 与控制字符（`\u0000-\u001f`）替换为 `_`；
- 结尾的 `.` 与空格剥掉（Windows 不允许）；剥空退化为 `_`；
- 用于包文件名、存档条目主干、README 内容里的图包名（与原工具 `Path.GetInvalidFileNameChars` → `_` 一致）。

### 3.3 包文件名 `ttsmodFileName`（`src/archive/ttsmod.ts:522-533`）

- 命名约定：`<图包名> (<工坊ID>).ttsmod`（与 TTS Mod Vault 互操作）；
- 图包名过 `sanitizeFileName`；`opts.save` 为 true 时加 `Save_` 前缀；
- `workshopId` 为 `null` / `undefined`（未发布）时不带 ` (<ID>)` 段；
- 例：`Custom Dice Set (379104394).ttsmod`。

---

## 4. 写：`exportTtsmod`

### 4.1 选项（`ExportTtsmodOptions`，`src/archive/ttsmod.ts:552-593`）

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `outPath` | `string` | ✅ | 无 | 输出文件路径；父目录不存在自动创建，已存在覆盖 |
| `packName` | `string` | ✅ | 无 | 图包显示名（manifest / README / 存档条目名兜底） |
| `saveJson` | `string \| Uint8Array` | ✅ | 无 | 存档 JSON 原文；**逐字节原样入包，URL 一个字不改**（string 按 UTF-8 编码） |
| `workshopId` | `number \| null` | 可省略 | `null` | 工坊 ID（决定存档条目名与 manifest / README） |
| `sourceModId` | `number \| null` | 可省略 | `null` | 上游模组 ID（manifest / README 用） |
| `packVersion` | `string` | 可省略 | 不写 | 图包版本号（manifest / README 用） |
| `saveJsonTarget` | `"workshop" \| "saves"` | 可省略 | `"workshop"` | 存档 JSON 条目落点（§2） |
| `saveJsonName` | `string` | 可省略 | 见 §2 | 存档条目文件名主干（会过 `sanitizeFileName`） |
| `thumbnail` | `Uint8Array` | 可省略 | 无 | 工坊缩略图 PNG 字节 |
| `assets` | `TtsmodAssetInput[]` | 可省略 | `[]` | 素材清单：每项 `{url, kind, data?, localPath?}`（`kind` ∈ image/model/assetbundle/pdf/audio） |
| `cacheDirs` | `Partial<Record<AssetKind, string>>` | 可省略 | 无 | 各类型本地缓存目录（扩展名推导第 2 级 + 素材字节兜底来源） |
| `probe` | `(url) => Promise<string \| undefined>` | 可省略 | HTTP 探测 | 注入的 Content-Type 探测函数（扩展名推导第 3 级） |
| `probeTimeoutMs` | `number` | 可省略 | `10_000` | 探测超时 |
| `strict` | `boolean` | 可省略 | `false` | 缺任一素材即抛 `TTSMOD_STRICT_MISSING`，不产出不完整的包 |
| `readme` | `"zh" \| "en" \| "both" \| "none"` | 可省略 | `"both"` | 随包说明语言 |
| `manifest` | `boolean` | 可省略 | `true` | 是否写 `manifest.json` |
| `createdAt` | `Date` | 可省略 | 当前时间 | manifest / README 的创建时间（测试可注入固定值） |
| `onWarn` | `(message) => void` | 可省略 | 无 | 每条告警回调一次（告警同时原样收进返回值） |

返回值 `ExportTtsmodResult`：`{ outPath, entryCount, fileBytes, included, skipped, warnings, manifestIncluded, readmeEntries, manifest? }`（`src/archive/ttsmod.ts:658-677`）。

### 4.2 扩展名推导（三级兜底 + 固定类型）

`src/archive/detect.ts`，按序尝试、命中即返回：

| 级别（`ExtSource`） | 规则 |
| --- | --- |
| 1 `url-path` | 原始 URL 路径里的扩展名，且须在白名单内（image：`png jpg jpeg webp gif bmp tga`；audio：`mp3 ogg wav`）——避免把 `?x.y` 噪声当扩展名 |
| 2 `cache-dir` | 本地缓存目录里已有文件：按 `sanitize(url)`（大小写不敏感）匹配 `<base>.<ext>`，命中多个扩展名时按优先序 `png jpg jpeg webp gif bmp tga mp3 ogg wav`，并列取文件名字典序最小 |
| 3 `content-type` | HTTP `Content-Type` 响应头（HEAD 405/501 退化 GET；走 `https_proxy` / `HTTPS_PROXY`；重定向最多 5 跳；超时双保险） |
| 固定 `fixed` | **不推导**：model → `obj`、assetbundle → `unity3d`、pdf → `PDF`（TTS 缓存约定） |

**三级都失败时绝不静默跳过**：失败条目原样列进 `detectExtensions` 的 `unresolved`，并生成 t() 告警（`archive.detect.unresolvedSummary` / `unresolvedItem`）——原工具就是静默跳过，导致接收方拿到包才知道缺素材（`方案设计.md` §12.4）。

实测背景：本机 `mods.cache` 里 36,184 条素材记录中有 **16,714 条（46%）没有扩展名**，推导失败是常态不是异常。

### 4.3 素材字节来源与缺素材策略

- 字节来源优先级：`data` → `localPath` → 该类型 `cacheDirs` 里按缓存键命中的文件；都取不到视为**缺失**（单个文件读取失败不算错误）。
- 缺素材默认行为（3B.8，用户已定）：**照原工具——只打包本地已有的素材，缺的跳过**，但多一步：把跳过的**逐条列出**（返回值 `skipped` + `warnings` + `onWarn` 三份，`archive.export.skippedSummary` / `skippedMissing` / `skippedExt`）。
- `strict: true`：缺任一素材（缺文件或扩展名推导失败）即抛 `PackError("TTSMOD_STRICT_MISSING")`，**不产出**；message 含完整缺失清单。
- 素材去重键：`kind|url`。

### 4.4 ZIP 编码（`writeZip`，`src/archive/ttsmod.ts:217-358`）

- 逐条目 deflateRaw（默认级别）；压缩后不小于原字节时自动改 store（method 0）；
- Zip64：条目大小 ≥ 4 GiB 时该条目带 `0x0001` extra（基础字段写 escape 哨兵）；条目数 ≥ 65535、中心目录偏移 / 大小越界或任一条目 Zip64 时追加 Zip64 EOCD + locator；`forceZip64` 选项供离线测试；
- 条目名含非 ASCII 时置 UTF-8 标志位（bit 11）；
- 默认条目时间戳固定 **2000-01-01**（可复现、不泄露本机时间；manifest 里有真实创建时间），可用 `options.timestamps` 覆盖；
- 写侧不去重（调用方负责；`exportTtsmod` 有覆盖保护兜底）。

---

## 5. `manifest.json` 字段表

可选根条目（`manifest: true` 时写）。结构见 `TtsmodManifest`（`src/archive/ttsmod.ts:620-655`），字段名是机器可读 JSON、**不走 i18n**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `manifest_version` | 字面量 `1` | manifest 结构版本（本格式自身演进用） |
| `tool.name` / `tool.version` | `string` | 打包工具名称与版本（当前 `tts-toolkit` / `0.1.0`，与 `package.json` 保持同步） |
| `created_at` | `string` | 创建时间（ISO 8601） |
| `pack.name` | `string` | 图包显示名 |
| `pack.version` | `string`（可省略） | 图包版本（调用方提供时） |
| `pack.workshop_id` | `number \| null` | 工坊 ID（未发布为 null） |
| `pack.source_mod_id` | `number \| null` | 上游模组 ID（无上游为 null） |
| `pack.save_json_target` | `"workshop" \| "saves"` | 存档 JSON 条目落点 |
| `assets[]` | 数组 | 素材清单（**含未打进去的**）：`{ url, kind, status, entry?, ext?, ext_source? }`；`status` ∈ `included` / `missing-file` / `unresolved-ext`，后两者没有 `entry` / `ext` / `ext_source` |

> manifest 是**新增的根条目**：旧读取器（含 TTS Mod Vault）不认识根条目会当普通文件忽略，因此"旧布局一个字节都不变"与互读性都成立。

---

## 6. 读：`importTtsmod`

入参 `{ modsParentDir, modSaveLocation, onWarn? }`（`ImportTtsmodOptions`，`src/archive/ttsmod.ts:1056-1063`）；`modsParentDir` 是 `Mods` 目录的**父目录**（TTS 数据根）。

落地规则（`src/archive/ttsmod.ts:1127-1186`）：

1. 条目名先做 `\` → `/` 归一（旧工具 / .NET 可能写反斜杠）；
2. **以 `Mods` 开头（大小写不敏感，`/^Mods(\/|$)/i`）→ 解压到 `modsParentDir`；否则 → 解压到 `modSaveLocation`**（`Saves/` 等条目由此落地）；
3. **已存在的文件不覆盖**（原工具 `DoNotOverwrite` 语义；判定为"存在且是文件"）；跳过的逐个列出（`archive.import.skippedExistingSummary` / `skippedExistingItem`）；
4. **防解压逃逸（zip-slip）**：条目名含 `..` 段、绝对路径（`/` 开头）、盘符（`C:`）或全为空的段 → 跳过并列出（`archive.import.unsafeEntrySkipped`），绝不写出目标目录之外；
5. 目录占位条目（名字以 `/` 结尾）不落地、不计入 `totalEntries`；
6. 根条目 `manifest.json`（大小写不敏感）特殊处理：**不落地**，`JSON.parse` 后随返回值返回；解析失败告警（`archive.import.manifestInvalid`）；
7. 顺带报告 `Mods/Workshop/*.json` 的落地路径（`workshopSaves`，供上层 `pack unpack` 复用）。

返回值 `ImportTtsmodResult`：`{ totalEntries, extracted, skippedExisting, skippedUnsafe, workshopSaves, manifest?, warnings }`（`src/archive/ttsmod.ts:1066-1081`）。

`readZip`（同文件 `:376-495`）支持 store / deflate / Zip64；条目大小一律取中心目录（本地头在 data descriptor 场景下不可信）；method 只有 0 / 8，其余报 `TTSMOD_INVALID`。

---

## 7. 本机实跑示例（演示夹具，2026-10-05）

一个含 1 条图片素材（URL 无扩展名、缓存命中推导）的包，条目与 manifest 实测如下：

```
Mods/Workshop/演示图包.json                     461 B
Mods/Images/httpsexamplecomimageshero.png       265 B
manifest.json                                   513 B
README.txt                                     1198 B
```

```json
{
  "manifest_version": 1,
  "tool": { "name": "tts-toolkit", "version": "0.1.0" },
  "created_at": "2026-10-04T20:06:34.489Z",
  "pack": {
    "name": "演示图包",
    "workshop_id": null,
    "source_mod_id": null,
    "save_json_target": "workshop"
  },
  "assets": [
    {
      "url": "https://example.com/images/hero",
      "kind": "image",
      "status": "included",
      "entry": "Mods/Images/httpsexamplecomimageshero.png",
      "ext": "png",
      "ext_source": "cache-dir"
    }
  ]
}
```

CLI 实测输出：

```console
$ tts pack export ./packs/演示包 -o 演示图包.ttsmod --datadir <TTS Mods 目录>
已导出 D:\...\演示图包.ttsmod：条目 4 个，1.95 KB，素材 1 条，跳过 0 条
随包说明：README.txt

$ tts pack import 演示图包.ttsmod --into <临时 Mods 父目录>
已导入 演示图包.ttsmod → D:\...\restore（写出 3 / 共 4 个文件条目）
包内工坊存档 1 个：
  D:\...\restore\Mods\Workshop\演示图包.json
如需建工作区，可运行：tts pack unpack "D:\...\restore\Mods\Workshop\演示图包.json"

$ tts pack import 演示图包.ttsmod --into <临时 Mods 父目录>     # 再导入一次
已导入 演示图包.ttsmod → D:\...\restore（写出 0 / 共 4 个文件条目）
已存在未覆盖 3 个：
  Mods/Workshop/演示图包.json
  Mods/Images/httpsexamplecomimageshero.png
  README.txt
  ...
```

`--datadir` 的作用：给出 TTS 的 `Mods` 目录后，扩展名推导第 2 级与素材字节兜底才有缓存可查（缺省走 `locateDatadir` 探测；探测不到仍可导出，只多一行提示）。

---

## 8. 错误码

| code | 触发 |
| --- | --- |
| `TTSMOD_INVALID` | 输入文件不存在 / 不是 ZIP（无 PK 头）/ ZIP 结构损坏或条目无法解压 |
| `TTSMOD_EXPORT_FAILED` | `.ttsmod` 写盘失败（IO 错误） |
| `TTSMOD_STRICT_MISSING` | `strict` 模式下素材不全（message 含缺失清单） |

`PackError` 统一来自 `src/pack/packyaml.ts`；相关 i18n 键：`error.archive.inputMissing` / `notZip` / `corrupt` / `exportWriteFailed` / `strictMissing`，以及 `archive.detect.*` / `archive.export.*` / `archive.import.*` / `archive.readme.*`（`src/archive/ttsmod.ts` 头注释列出全量）。

---

## 9. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-05 | 初版（窗口 C / 阶段 3）。契约来自 `src/archive/{ttsmod,cachekey,detect}.ts` 与 `src/cli/commands/pack.ts`，并附本机实跑示例（演示夹具）。 |
