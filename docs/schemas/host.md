# 图床（host）配置契约

> **本文档由窗口 C（阶段 3）产出，实现窗口与使用方必读。**
>
> 依据：`src/host/types.ts`（统一接口与运行时助手）、`src/host/steamcloud.ts`、`src/host/s3.ts`、`src/host/local.ts`、`src/host/command.ts`（配置声明 / 插件加载 / 注册表）、`src/cli/commands/assets.ts`（`assets upload`）、`src/cli/commands/host.ts`（`host list` / `host check`）。
> 本文档描述**已实现的真实契约**，不是设想稿。所有用户可见错误都走 `src/i18n/index.ts` 的 `t()` 双语键，错误对象统一是 `src/pack/packyaml.ts` 的 `PackError`（按 `code` 分支，不解析 message）。

---

## 1. 三处声明位置与优先级

图床有**三个来源**，全部走同一个 `ImageHost` 接口（内置实现不搞特殊路径）：

| 来源（`HostEntry.source`） | 位置 | 说明 |
| --- | --- | --- |
| `builtin` | 代码内置 | 固定一个：`steamcloud`（`RESERVED_DEFAULT_HOST_ID`，`src/host/command.ts:150`；保留 id 不允许被配置 / 插件占用） |
| `config` | 全局配置文件 `%APPDATA%\tts-toolkit\config.yaml` 的 `hosts.<name>` 块（非 Windows：`~/.config/tts-toolkit/config.yaml`，`src/host/command.ts:363-366`） | 配置声明：内置四种 `type` 都可以在这里起本地别名；自定义图床最常用 `type: command` |
| `plugin` | 插件目录 `~/.tts-toolkit/hosts/<name>.js`（`DEFAULT_HOSTS_PLUGIN_DIR`，`src/host/command.ts:153`；Windows 实为 `C:\Users\<用户>\.tts-toolkit\hosts\`） | 用户写一个实现 `ImageHost` 的 JS 模块，加载时自动识别 |

`listHosts()`（`src/host/command.ts:714`）按 **builtin → config → plugin** 顺序汇总；`resolveHost(id)`（`:750`）按同一顺序查找，**找不到就抛 `HOST_NOT_FOUND`，绝不静默回退到默认图床**（静默回退会把素材传到意想不到的地方，`方案设计.md` §6.3.1 的明确要求）。config 与 plugin 之间 id 冲突抛 `HOST_CONFIG_INVALID`（detail 含 `duplicateId`，含冲突双方来源）。

### 1.1 与 `pack.yaml` 的 `host` 字段的关系

`pack.yaml` 的 `host` 是**图包级默认图床名**，取值域受 `pack.yaml` schema 限制：
`steamcloud | imgur | gdrive | dropbox | custom`（`src/pack/packyaml.ts:45`；契约见 `docs/schemas/pack.yaml.md` §4.4）。

- `tts assets upload`（`src/cli/commands/assets.ts:345`）读 `pack.yaml.host` 后调 `resolveHost`；`--host <id>` 覆盖它。
- ⚠️ **`imgur` / `gdrive` / `dropbox` / `custom` 不是本工具注册的 `ImageHost` id**，直接跑会命中 `HOST_NOT_FOUND`；CLI 会明确提示改用 `--host` 指定配置声明的图床（`cli.assets.upload.hostNotResolvable`）。这是**有意为之**：这些名字只是"素材历史上挂在哪个图床"的事实标签，不是可调用后端。
- 自定义图床**不能**直接写成 `pack.yaml.host`（枚举里只有 `custom` 这个标签，不指向任何具体后端）：上传时始终用 `--host <声明名>`。把声明名纳入 `pack.yaml` 枚举属于窗口 B 的 schema 变更，不在本文档范围内。

---

## 2. 统一接口 `ImageHost`

```ts
interface ImageHost {
  readonly id: string;                                // 'steamcloud' | 's3' | 'local' | 'command' | 用户自定义名
  upload(files: File[], opts: UploadOptions): Promise<UploadResult[]>;
  check(url: string): Promise<Liveness>;
  capabilities(): HostCapabilities;
}
```

（`src/host/types.ts:110-119`。）

| 类型 | 字段 | 说明（`src/host/types.ts`） |
| --- | --- | --- |
| `File` | `name: string` / `data: Uint8Array` / `mime?: string` | `name` 是上传后的**对象名**，可含 `/` 表达子目录；`Buffer` 是 `Uint8Array` 子类可直接传；`mime` 缺省由实现按扩展名推断（`:43-50`） |
| `UploadOptions` | `timeoutMs?` / `stagingDir?` / `signal?` | `timeoutMs` 默认 `DEFAULT_UPLOAD_TIMEOUT_MS = 120_000`（`:129`）；`stagingDir` 仅 steamcloud 用；`signal` 透传网络请求 / 子进程（`:53-60`） |
| `UploadResult` | `file` / `status: "uploaded" \| "pending"` / `url?` / `pending?` | `uploaded` 必有 `url`；`pending` 是 **Steam Cloud 手动上传的可接受结果，不是失败**（`:73-85`） |
| `PendingUpload` | `hint` / `stagingDir` / `manifestPath` | `hint` 已本地化，可直接展示（`:63-70`） |
| `Liveness` | `alive` / `status?` / `error?` | `check` **不抛网络错误**，失败一律以 `alive=false + error` 返回（`:88-95`、`:115`） |
| `HostCapabilities` | `maxFileSize?` / `formats?` / `deletable` | `deletable` 必填；未声明上限 / 格式时省略（`:98-105`） |

### 2.1 所有实现共用的行为约定

- `upload` **按入参顺序逐个上传**；任一文件失败整体 reject，返回值要么全部成功、要么没有部分结果。
- 入参统一过 `validateUploadFiles`（`types.ts:204`）：`files` 必须是非空数组；`name` 非空、`data` 必须是 `Uint8Array`；对象名经 `safeObjectName`（`:258`）安全化后**不得重复**——重名报 `HOST_INVALID_INPUT`，不静默覆盖。
- `safeObjectName` 规则：`\` 归一为 `/`；丢弃空段与 `.` 段；**拒绝 `..` 段**（防目录穿越）与空结果。
- 所有错误码以 `HOST_*` 开头（见 §7），错误对象一律 `PackError`。

---

## 3. 全局配置 `hosts.<name>` 字段表

配置文件是**同一份** `%APPDATA%\tts-toolkit\config.yaml`（`datadir` / `lang` 等字段与 `hosts` 共存；`loadDeclaredHosts` 只读取 `.hosts`，其余顶层字段不参与图床解析）。文件不存在 → 未声明任何图床（不是错误）；文件存在但 YAML 非法 / `hosts` 非法 → `HOST_CONFIG_INVALID`（**绝不静默回退默认图床**）。

`hosts.<name>` 的 zod schema 是 **strictObject**（`src/host/command.ts:181-205`）：未知字段一律拒绝，防拼写错误静默生效。

| 字段 | 类型 | 必填 | 适用 `type` | 说明（中文） | Description (EN) |
| --- | --- | --- | --- | --- | --- |
| `type` | `"steamcloud" \| "s3" \| "local" \| "command"` | ✅ | — | 图床类型（`BUILTIN_HOST_IDS`，`src/host/types.ts:126`） | Host type |
| `command` | `string` | `command` 时必填 | command | 上传命令模板（占位符 `{file}` / `{name}`；stdout 须输出 http(s) URL） | Upload command template |
| `check` | `string` | 可省略 | command | 存活检测命令模板（占位符 `{url}`；退出码 0 = 存活）；省略时改为 HTTP 探测 | Liveness-check command template |
| `endpoint` | `string` | `s3` 时必填 | s3 | S3 兼容端点（http/https URL） | S3-compatible endpoint |
| `region` | `string` | `s3` 时必填 | s3 | 区域（R2 固定 `auto`；AWS 如 `us-east-1`） | Region |
| `bucket` | `string` | `s3` 时必填 | s3 | 桶名 | Bucket |
| `access_key_id` | `string` | `s3` 时必填 | s3 | 访问密钥 ID | Access key id |
| `secret_access_key` | `string` | `s3` 时必填 | s3 | 秘密访问密钥 | Secret access key |
| `prefix` | `string` | 可省略 | s3 | 对象 key 前缀（自动归一化为 `xxx/` 形态或空串） | Object key prefix |
| `public_base_url` | `string` | 可省略 | s3 | 公开访问基址；缺省 `<endpoint>/<bucket>` | Public base URL |
| `dir` | `string` | `local` 时必填 | local | 输出目录（不存在时自动创建） | Output directory |

**声明名（`hosts` 的键）即图床 id**（`createHostFromConfig(name, cfg)`，`src/host/command.ts:540`）。规则：

- 声明名不能为空、**不能是保留 id `steamcloud`**（抛 `HOST_CONFIG_INVALID` + `error.host.reservedId`）；
- 每种 `type` 的必填字段在 `createHostFromConfig` 里按类型检查，缺什么报什么（s3 一次列出全部缺失字段；command / local 指出缺哪个）；实现类构造器还会再自检一遍兜底；
- 未知 `type`（如 `type: ftp`）被 schema 拒绝，错误详情为 `type 必须是 steamcloud / s3 / local / command 之一`。

```yaml
# %APPDATA%\tts-toolkit\config.yaml
datadir: D:/SteamLibrary/steamapps/common/Tabletop Simulator/Tabletop Simulator_Data/Mods

hosts:
  my-local:
    type: local
    dir: D:/tts-cdn-test          # 仅本机测试用
  rclone-cdn:
    type: command
    command: 'rclone copyto "{file}" myremote:public/tts/{name} && echo "https://cdn.example.com/tts/{name}"'
    check: 'curl -sfI "{url}"'
```

---

## 4. 四种内置实现

### 4.1 `steamcloud`（默认，不可被占用）

- **配置项**：无。声明时只写 `type: steamcloud`（起别名用），id 不能叫 `steamcloud`。
- **上传**：当前实现**始终走人工流程**（程序化上传途径未验证）：把文件拷进暂存目录、生成 YAML 待上传清单，每个文件返回 `status: "pending"`（`src/host/steamcloud.ts:91-132`）。
  - 暂存目录：`opts.stagingDir`，缺省 `<cwd>/.tts/steamcloud-pending`；
  - 清单文件名：`pending-upload.yaml`（`STEAMCLOUD_PENDING_MANIFEST_FILENAME`，`:45`）；
  - 操作提示 `pending.hint` 告诉用户去游戏内 `Cloud Manager → Upload All` 点一下；`Upload All` 会自动重写存档里所有 URL。
- **检测**：普通 HTTP 探测（`:141-143`）。
- **能力**：`{ deletable: false }`——不声明单文件上限与格式；CLI 无删除途径。
- **接口升级路径**：将来若验证出程序化上传，只需该实现返回 `status: "uploaded"`，调用方代码不变。

### 4.2 `s3`（Cloudflare R2 / AWS S3 / MinIO）

- **配置项**：`endpoint` / `region` / `bucket` / `access_key_id` / `secret_access_key`（必填）+ `prefix` / `public_base_url`（可选）。
- **寻址**：path-style `<endpoint>/<bucket>/<key>`；自实现 AWS Signature V4 签名（`src/host/s3.ts`），**不引入 AWS SDK**。
- **公开 URL**：优先 `public_base_url`，缺省 `<endpoint>/<bucket>`；`prefix` 已含在 key 里，URL 中保留。
- **能力**：`{ maxFileSize: 5 GiB（S3_MAX_PUT_BYTES，s3.ts:59）, deletable: false }`；格式不限。
- **检测**：HTTP 探测（`:267-269`）。

```yaml
hosts:
  my-s3:
    type: s3
    endpoint: https://<accountid>.r2.cloudflarestorage.com   # MinIO 如 http://127.0.0.1:9000
    region: auto                                             # R2 固定 auto；AWS 如 us-east-1
    bucket: my-bucket
    access_key_id: <ACCESS_KEY_ID>
    secret_access_key: <SECRET_ACCESS_KEY>
    prefix: tts/                                             # 可选
    public_base_url: https://cdn.example.com/tts/            # 可选
```

### 4.3 `local`（仅本机测试用）

- **配置项**：`dir`（必填，上传时自动创建）。
- **上传**：把文件写进 `dir`（保持对象名的相对路径结构），返回 `file://` URL（`src/host/local.ts:92-113`）。
- **检测**：只认 `file://` URL 或本地路径（存在且是文件 = 存活）；其他协议返回 `alive=false` + `error.host.checkNotLocal`；文件不存在返回 `error.host.localFileMissing`（`:125-155`）。
- **能力**：`{ deletable: true }`。
- ⚠️ 别人加载不到 `file://` URL——**正式图包不要用它**，它只用于离线验证"上传 → 拿 URL → 存档引用"整条链路。

### 4.4 `command`（万能逃生口）

- **配置项**：`command`（必填）+ `check`（可选）。
- **上传**（`src/host/command.ts:414-466`）：每个文件先暂存到系统临时目录（`mkdtemp`）→ 展开模板占位符 → 经**平台 shell** 执行（Windows 是 cmd.exe，能用 `&&` 等复合命令）→ 从 stdout 提取**第一个** http(s) URL 作为公开地址。
  - 占位符：`{file}` = 本地暂存文件绝对路径；`{name}` = 文件对象名（可能含 `/`）；
  - 未声明的占位符原样保留，由用户命令自行处理；
  - 命令非零退出 / 超时（默认 120 s）/ 无法启动 / stdout 无 URL → `HOST_UPLOAD_FAILED`，detail 区分这几种原因（`error.host.commandNonZero` / `commandTimeout` / `commandAborted` / `commandSpawnFailed` / `noUrlInOutput`）。
- **检测**：配置了 `check` 则执行它（展开 `{url}`，退出码 0 = 存活）；未配置则回退 HTTP 探测（`:473-483`）。
- **能力**：`{ deletable: false }`；上传限制由用户命令决定，工具侧不声明。

---

## 5. 插件加载 `~/.tts-toolkit/hosts/<name>.js`

- **目录**：`path.join(os.homedir(), ".tts-toolkit", "hosts")`（`DEFAULT_HOSTS_PLUGIN_DIR`）。Windows 上即 `C:\Users\<用户>\.tts-toolkit\hosts\`。
- **识别文件**：`.js` / `.mjs` / `.cjs`（大小写不敏感；模块类型由 Node 按语法自动识别）；其他文件忽略。
- **导出形态**：ESM `export default {...}` 或 CJS `module.exports = {...}` 均可（`loadPluginHosts`，`:642-698`）。
- **必须实现**：`id`（非空字符串）、`upload(files, opts)`、`check(url)`、`capabilities()`；缺任何一项 → `HOST_PLUGIN_INVALID`，detail 列出缺失成员，**绝不静默忽略**。
- **id 约束**：插件 `id` 不能是保留 id `steamcloud`（`HOST_PLUGIN_INVALID`）；与配置声明重名会在 `listHosts` 汇总时抛 `HOST_CONFIG_INVALID`（duplicateId）。
- **目录不存在** → 空数组（没装插件不是错误）；插件 `import` 失败（语法错误 / 依赖缺失）→ `HOST_PLUGIN_LOAD_FAILED`。

```js
// ~/.tts-toolkit/hosts/my-host.js
export default {
  id: "my-host",
  async upload(files) {
    return files.map((f) => ({ file: f.name, status: "uploaded", url: "https://cdn.example.com/" + f.name }));
  },
  async check(url) {
    return { alive: true };
  },
  capabilities() {
    return { deletable: false };
  },
};
```

> ⚠️ 插件是**用户自己的代码**，本工具只负责加载与接口校验，不提供沙箱。加载发生在 `tts host` / `assets upload` / `migrate` 等命令启动时，插件抛出的运行时异常由命令层兜底为通用错误。

---

## 6. 完整可跑的 rclone 示例

**目标**：把素材传到任意 rclone 远端（S3 / OSS / 网盘均可），用公开访问域名拼出 URL。

**前置条件**（只有两条）：

1. 已安装 rclone 并用 `rclone config` 配好名为 `myremote` 的远端；
2. `https://cdn.example.com` 是该远端对应桶 / 目录的公开访问域名（对象写到 `public/tts/<文件名>`，URL 即 `https://cdn.example.com/tts/<文件名>`）。

```yaml
# %APPDATA%\tts-toolkit\config.yaml
hosts:
  rclone-cdn:
    type: command
    # {file} 是自动暂存后的本地文件路径；{name} 是对象名。
    # 含空格的参数请自行加引号；stdout 至少输出一个 http(s) URL（取第一个）。
    command: 'rclone copyto "{file}" myremote:public/tts/{name} && echo "https://cdn.example.com/tts/{name}"'
    # check 可选：退出码 0 = 存活；省略时改为对 URL 发 HTTP 探测。
    check: 'curl -sfI "{url}"'
```

跑通三步：

```console
$ tts host list
可用图床 2 个：
  steamcloud  内置（默认）
    可删除：否  单文件上限：不限  格式：-
  rclone-cdn  配置声明
    可删除：否  单文件上限：不限  格式：-

$ tts assets upload --pack ./packs/第七大陆 --host rclone-cdn
使用图床：rclone-cdn（pack.yaml 声明：steamcloud）
...
$ tts host check --pack ./packs/第七大陆 --host rclone-cdn
```

（`host list` 输出格式见 `src/cli/commands/host.ts:200-225`；`assets upload` 的 `--host` 覆盖逻辑见 `src/cli/commands/assets.ts:345-356`。）

**平台注意**：命令经平台 shell 执行——Windows 走 cmd.exe，`&&` 可用，但**引号必须是双引号**（`'...'` 在 cmd 里不是引号）；Linux / macOS 走 `/bin/sh`，单双引号均可。YAML 里用单引号包整个模板最省心。

---

## 7. 错误码

所有错误都是 `PackError`；CLI 侧按 `error.<CODE>` 取文案（缺键时原样输出键名），退出码 1。

| code | 触发 | 关键 i18n 键 |
| --- | --- | --- |
| `HOST_CONFIG_INVALID` | 配置文件读取 / YAML 解析失败、`hosts` 非对象、声明名为空、保留 id、未知字段 / 未知 type、按 type 缺必填字段、id 冲突、实现构造参数非法 | `error.host.configReadFailed` / `config.notObject` / `config.rootNotObject` / `config.emptyName` / `reservedId` / `duplicateId` / `config.missingCommand` / `config.missingS3Fields` / `config.missingLocalDir` / `config.invalidEndpoint` / `configInvalid` |
| `HOST_PLUGIN_LOAD_FAILED` | 插件目录不可读（非 ENOENT）、插件 `import` 失败 | `error.host.pluginLoadFailed` |
| `HOST_PLUGIN_INVALID` | 插件未实现接口、插件占用保留 id | `error.host.pluginInvalid` |
| `HOST_NOT_FOUND` | `resolveHost` 找不到指定 id（含 `pack.yaml.host` 写了 imgur / gdrive / dropbox / custom 的情况） | `error.host.notFound` |
| `HOST_INVALID_INPUT` | 入参文件结构非法 / 空数组 / 重名 / 对象名含 `..` / id 为空 / 超过 `maxFileSize` | `error.host.invalidInput` / `fileTooLarge` |
| `HOST_UPLOAD_FAILED` | 暂存写盘失败、命令非零退出 / 超时 / 无法启动、stdout 无 URL、PUT 非 2xx、网络异常 | `error.host.uploadFailed` / `noUrlInOutput` / `commandNonZero` / `commandTimeout` / `commandAborted` / `commandSpawnFailed` / `stderrEmpty` |

`check` 的失败**不是异常**：返回 `{ alive: false, status?, error? }`（local 的 `checkNotLocal` / `localFileMissing`、探测的 `probeUnavailable` / `httpStatusDead` 等文案在 `Liveness.error` 里）。

---

## 8. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-05 | 初版（窗口 C / 阶段 3）。契约来自 `src/host/` 五个模块与 `src/cli/commands/{host,assets}.ts`；附完整可跑的 rclone 示例。 |
