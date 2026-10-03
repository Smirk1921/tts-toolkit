# tts-toolkit

面向《桌游模拟器》（Tabletop Simulator）图包作者的命令行工具：通过 TTS 的**外部编辑器协议**直连运行中的游戏，只读地检查连接状态、执行 Lua、拉取全部脚本与 UI、盘点素材 URL；所有面向用户的输出支持中文 / 英文双语。

> 当前进度：阶段 1（基础设施 + 协议层 + 只读 CLI）。所有命令均为只读，不会修改游戏内数据。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | **≥ 24.19.0**（`package.json` 的 `engines`；开发环境实测 v24.19.0） |
| 操作系统 | Windows 为主要目标平台（数据目录探测的安装目录 / 用户文档分支按 Windows 实现） |
| 游戏 | 使用与游戏通信的命令时，TTS 需**正在运行并已加载图包存档**（39999 端口才会监听） |
| 其他 | **关闭 VSCode 的 TTS 插件**（见下文「与官方 VSCode 插件的互斥」） |

## 安装

```bash
npm install        # 网络受限时先看「代理配置」
npm run build      # 编译到 dist/（集成测试与 tts 命令都依赖它）
npm link           # 可选：把 tts 命令链接到全局
```

不 `npm link` 时，用 `node dist/cli/index.js` 代替下文的 `tts`，例如
`node dist/cli/index.js status`。

## 快速开始

> 以下输出为 2026-10-04 在本机（251 个对象的图包存档）实测，具体数字随存档变化。

### 1. 检查连接：`tts status`

```console
$ tts status
已连接到 TTS 编辑器（端口 39998）
脚本引擎版本：MoonSharp 3.0.0.0
当前存档对象数：251
```

端口 39998 被占用时给出可操作的中文提示并以退出码 1 结束（通常是 VSCode 插件还开着）。

### 2. 执行 Lua：`tts exec '<lua>'`

在当前存档的全局脚本中执行一段 Lua，并打印返回值：

```console
$ tts exec 'return 1+1'
2
$ tts exec 'return #getObjects()'
251
$ tts exec 'return {a=1,b="x"}'
{
  "a": 1,
  "b": "x"
}
```

要点：

- 返回 table / 对象时，`exec` 自动用 `return JSON.encode(...)` 包装再解析，绕开「协议只回传标量、table 静默失败」的坑；
- 数字会整型化：TTS 回传 `2.0`，输出为 `2`；
- 默认超时 30 秒；Lua 报错时 stderr 含 TTS 原始错误与行列号（如 `(1,0-44)`），退出码 1；
- 不支持多返回值：`return 1, 2` 会报错并提示改用 `JSON.encode`。

### 3. 拉取脚本与 UI：`tts pull <dir>`

```console
$ tts pull ./work
输出目录：D:\...\work
拉取完成：脚本 36 个，UI 界面 1 个
```

文件名规则：全局脚本为 `Global.lua` / `Global.xml`，其他对象为 `<guid>.<对象名>.lua` / `.xml`；
对象没有脚本或 UI 时不生成空文件。目录不存在会自动创建。

### 4. 盘点素材：`tts assets [--check] [--sample <n>]`

```console
$ tts assets
共 130 个不同 URL，249 次引用
按域名分组：
  steamusercontent-a.akamaihd.net: 130 URL, 249 引用
```

- `--check`：联网探测每个 URL 的存活（HTTP 2xx），输出有效 / 失效数量与前 20 条死链；
- `--sample <n>`：配合 `--check` 只随机抽检 N 个 URL；
- 走代理：见「代理配置」。

### 5. 选择数据目录：`tts config datadir [--set <path>]`

```console
$ tts config datadir
找到 4 个 TTS 数据目录：
  1. D:\SteamLibrary\...\Tabletop Simulator_Data\Mods（来源：安装目录，有效子目录 2 个）
  2. C:\Program Files (x86)\Steam\...\Tabletop Simulator_Data\Mods（来源：安装目录，有效子目录 0 个）
  3. C:\SteamLibrary\...\Tabletop Simulator_Data\Mods（来源：安装目录，有效子目录 0 个）
  4. C:\Users\<用户>\Documents\My Games\Tabletop Simulator\Mods（来源：用户文档，有效子目录 2 个）
检测到多个可用的 TTS 数据目录：
请输入编号后回车（1-4，直接回车取消）：
```

探测到多个有效目录时**必须由用户选择**，不会静默挑一个；结果写入
`%APPDATA%\tts-toolkit\config.yaml`。非交互环境（如脚本、管道）请用
`tts config datadir --set <path>` 直接写入。

### 全局选项

| 选项 | 说明 |
| --- | --- |
| `--lang <zh-CN \| en-US>` | 输出语言；缺省按「配置文件 `lang` > 系统语言 > 中文」解析。**只接受这两个值**（施工文档里的 `--lang en` 不被接受，会报「无效的语言选项」） |
| `--datadir <path>` | 显式指定 TTS 数据目录，跳过自动探测 |
| `--dev` | 开发模式：缺翻译时向 stderr 告警 |
| `-h, --help` / `-V, --version` | 帮助 / 版本号 |

英文输出示例：`tts --lang en-US status` → `Connected to the TTS editor (port 39998)`。

## 与官方 VSCode 插件的互斥

TTS 的外部编辑器协议只认**一个** 39998 端口监听者。本工具与官方 VSCode 插件都会监听 39998，
**同时开启会互相抢端口**，表现为工具报错或 VSCode 插件失效。

- 使用本工具前：在 VSCode 中停用 / 卸载 TTS 插件，或关闭 VSCode；
- 报错文案：`端口 39998 已被占用（PID xxxx）。常见原因：VSCode 的 TTS 插件正在运行，请关闭后重试。`
- 排查占用进程（PowerShell 7）：

  ```powershell
  Get-NetTCPConnection -LocalPort 39998 -State Listen | Select-Object OwningProcess
  ```

本工具对 39998 采用**独占绑定**（`exclusive: true`），并会先试绑通配地址再试绑 `127.0.0.1`，
以避免 Windows 上 `SO_REUSEADDR` 造成的「绑定成功但收不到消息」假象。

## 代理配置

只有 `tts assets --check` 的联网探测会用到代理（`src/assets/check.ts` 在调用时读取
`https_proxy`，其次 `HTTPS_PROXY`，空值视为未设置）。TTS 协议本身始终连接
`127.0.0.1:39999`，**不受代理影响**。

本机代理为 `http://127.0.0.1:7897`：

```cmd
:: cmd.exe
set https_proxy=http://127.0.0.1:7897
set http_proxy=http://127.0.0.1:7897
tts assets --check
```

```powershell
# PowerShell 7
$env:https_proxy = "http://127.0.0.1:7897"
$env:http_proxy  = "http://127.0.0.1:7897"
tts assets --check
```

`npm install` 同样受上述环境变量影响，网络受限时先设置再安装。

## 数据目录探测说明

TTS 数据目录（Mods）的位置由**玩家游戏内设置**决定，安装目录与用户文档目录**都可能存在**，
因此本工具绝不写死单一路径（坑 6），而是按优先级列出全部候选：

1. 显式指定：`--datadir <path>` 或 `tts config datadir --set <path>`；
2. 全局配置文件 `%APPDATA%\tts-toolkit\config.yaml` 的 `datadir` 字段；
3. 注册表 / 游戏内 `ConfigMods\Location`（**本阶段未实现**，TODO）；
4. 安装目录 `<安装目录>\Tabletop Simulator_Data\Mods`（安装目录来自环境变量
   `TTS_INSTALL_DIR`，未设置时依次尝试三个常见 Steam 库路径）；
5. `%USERPROFILE%\Documents\My Games\Tabletop Simulator\Mods`；
6. macOS / Linux 对应路径（**本阶段未实现**，仅留 hook）。

候选「有效」的判定：目录存在且 `Workshop` / `Images` / `Saves` 中至少一个子目录存在。
有效候选 ≥ 2 时要求用户选择；恰好 1 个时推荐并二次确认；0 个时报错退出。

## 已知限制

- **不做 hub / MCP / VSCode 插件**：属于阶段 4；hub 的 TCP / WebSocket 端口常量
  （39997 / 39996）已在代码中预留，但未启用。
- **不暴露 push**：push 协议（messageID 1）不接收素材字段，本阶段 CLI 只读，
  不会向游戏写入任何内容（设计约束 7）。
- **注册表探测未实现**：无法读取游戏内设置的真实 Mods 路径，只能靠上述候选与用户指定。
- **macOS / Linux 探测未实现**：仅保留 hook。
- **`tts --help` 的文案不跟随 `--lang`**：命令描述在模块加载时求值，早于 `--lang` 生效。
- **`--lang` 只接受 `zh-CN` / `en-US`**：`--lang en` 会以「无效的语言选项」退出 1。
- **协议限制**：Lua 多返回值不受支持；table 必须经 `JSON.encode` 包装（`exec` 已自动处理）；
  端口 39998 同时只能有一个监听者。

## 开发

```bash
npm run dev -- status          # tsx 直接跑源码（tsx 免构建）
npm test                       # vitest：单元测试（集成测试默认跳过）
npm run test:integration      # 只跑 tests/integration
npm run build                  # tsc -p . → dist/
```

目录结构：

```
src/
  protocol/   消息类型、端口与独占检测、编辑器服务器（39998）、TTS 客户端（39999）
  session/    Lua 执行（execJson）、脚本快照读写、Lua 片段生成
  assets/     snake_case ↔ CamelCase 字段映射、素材盘点、URL 存活检测
  datadir/    TTS 数据目录探测与配置读写
  i18n/       极简 t(key, params) 双语实现
  cli/        commander 命令注册（status / config / pull / exec / assets）
locales/      zh-CN.json、en-US.json
tests/unit/   不依赖 TTS 的单元测试
tests/integration/  需 TTS 运行的验收测试
```

约定：TypeScript ESM（`.ts`，import/export）、target ES2022 / module NodeNext / strict；
面向用户的字符串一律走 `t()`；禁止 `any`（运行时边界用 `unknown` + zod）；注释用中文。

## 集成测试使用说明

`tests/integration/phase1.acceptance.test.ts` 对照《施工流程》阶段 1 验收标准，
通过子进程调用已构建的 CLI。因为需要真实 TTS，**默认整组 `describe.skip`**，
`npm test` 与 `npm run test:integration` 都会跳过它（输出 10 skipped）。

手动开启步骤：

1. 确保已 `npm run build`；
2. 启动 TTS 并加载图包存档；
3. 关闭 VSCode 的 TTS 插件；
4. 打开 `tests/integration/phase1.acceptance.test.ts`，把 `describe.skip(` 改成 `describe(`；
5. 执行 `npm run test:integration`。

基准值（本机实测）：36 个 `.lua` + 1 个 `.xml`、脚本总量 277,644 字符（断言允许 ±5%）、
251 个对象、130 个不同素材 URL。存档改动后如数字变化，更新文件顶部的基准常量即可。
