# tts-toolkit

面向《桌游模拟器》（Tabletop Simulator）图包作者的命令行工具：通过 TTS 的**外部编辑器协议**直连运行中的游戏，只读地检查连接状态、执行 Lua、拉取全部脚本与 UI、盘点素材 URL；并支持**离线**的图包工作区管理（unpack / build / pull / push / diff），所有面向用户的输出支持中文 / 英文双语。

> 当前进度：阶段 1（基础设施 + 协议层 + 只读 CLI）+ 阶段 2A（图包工作区）。`status / exec / pull / assets / config` 等命令只读；`pack init/unpack/build` 离线；`pack pull/diff` 与运行中 TTS 交互；`pack push` 为骨架（阶段 5 才实际写入）。

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

### 6. 图包工作区：`tts pack *`（阶段 2A 新增）

**离线**地管理图包工作区：从存档 JSON 或 `.ttsmod` 解包出 scripts/、ui/、decks/、objects/，改完后再合成回 TTS 可加载的存档 JSON。骨架存档 `.tts/skeleton.json` 是 build 做"按 GUID 定点替换"的依据，**绝不入 git**（已加入 .gitignore）。

```console
$ tts pack init ./my-pack --name 第七大陆汉化
图包工作区已创建于 D:\...\my-pack

$ tts pack unpack ./save.json --out ./my-pack
已从 ./save.json 解包到 ./my-pack：36 脚本，1 UI，251 对象

$ tts pack unpack ./workshop.ttsmod --out ./my-pack
已从 ./workshop.ttsmod 解包到 ./my-pack：0 脚本，0 UI，11 对象

$ tts pack build --root ./my-pack
已写出 ./my-pack/dist/my-pack.json：替换 0 脚本 / 0 UI / 0 对象

$ tts pack build --root ./my-pack --dry-run
已写出 ./my-pack/dist/my-pack.json：替换 0 脚本 / 0 UI / 0 对象
（dry-run，未写文件）
```

要点：

- **`tts pack init <dir>`** 新建工作区：`ensureLayout` 建 7 个目录（`scripts/ ui/ decks/ objects/ sheets/ source/ .tts/`）+ 写 `pack.yaml` + `git init` + **git-lfs 强制三选一**（装 / 禁用二次确认 / 取消，约束 10）；可用 `--lfs enabled|disabled` 跳过交互、`--skip-git` 跳过 git。
- **`tts pack unpack <save>`** 离线解包：支持存档 JSON 或 `.ttsmod`（后者是 ZIP，自动找 `Mods/Workshop/*.json`）。落盘 `.tts/skeleton.json` + 整理 `scripts/`、`ui/`、`decks/`、`objects/`。
- **`tts pack pull`** 从运行中的 TTS 拉最新脚本/UI 到工作区，**不**更新 skeleton（skeleton 只由 unpack 生成）。
- **`tts pack push`** 骨架：列出将推回游戏的清单（阶段 5 才实际调 saveAndPlay）。
- **`tts pack diff`** 对比工作区与运行中 TTS 的脚本/UI 差异（added/modified/deleted）。
- **`tts pack build`** 把工作区合成 TTS 可加载的存档 JSON（约束 8：读 skeleton + 按 GUID 定点替换，未改动对象与骨架逐字节一致）；`--dry-run` 只打印摘要。

工作区契约文档见 [`docs/schemas/`](./docs/schemas/)（`pack.yaml` / `deck.yaml` / `assets.yaml` / `cards.csv` / `objects.csv` / `registry.yaml` 六份，B2/B3 必读）。

### 7. 卡牌图集：`tts deck *`（阶段 2B 新增）

**离线**做卡牌图集的切片 / 重新拼接 / 原位拼回 / URL 替换 dry-run / 一致性校验。卡牌明细的唯一源是 `<deck>/cards.csv`（10 列严格顺序）；`deck.yaml` 只留元数据（name/guid/shared_with/atlas）。

```console
$ tts deck slice --sheet 第七大陆卡图.png --cols 5 --rows 5 --save save.json -o ./cards
已切片：5 张卡到 ./cards/冒险牌堆/

$ tts deck generate --cards ./cards --cols 10 --rows 7 -o ./rebuilt.png
已重新排版：70 张卡 → 1 张图集

$ tts deck generate --in-place --deck 冒险牌堆 --root ./my-pack
已原位拼回：3 张卡换图，67 张保持原像素

$ tts deck plan --replace https://old.com/=https://new.com/ --root ./my-pack
替换计划：影响 52 处 / 涉及 52 个对象（父牌堆 + 每张 Card 子对象的 CustomDeck 都覆盖）

$ tts deck verify --root ./my-pack
校验完成：0 错误，2 警告
```

要点：

- **1 基 slot 写死**：`cards.csv` 的 `slot` 列与 `CardID % 100` 一致（%100===0 记 100）。
- **slot 是不变量**：重新排版时按 card_id 的 slot 连续段切，不改卡序。
- **余数吸收机制**：源图集不整除网格时（如 4096/5=819.2），单格尺寸按 `floor(源/cols)` 取整，剩余像素由最后一列/行吸收——切片/拼回/校验四处统一。
- **UniqueBack 两种**：`true` 切 70 张背面；`false + BackURL==FaceURL` 降级为无自定义背面（不重复切）。
- **共享图集**：同一 URL 被多个 CustomDeck 引用时，`slice` 列出所有候选牌堆让用户选，写入 `deck.yaml` 的 `shared_with`。

### 8. 多图包与版本控制：`tts pack list/status/open` + `tts vcs *`（阶段 2C 新增）

**多图包统一视图**：所有图包注册到 `<packs_root>/.registry.yaml`（含名称/类型/上游工坊/当前分支/图床/统计/lfs 状态）。

**git 版本控制语义封装**：把 `git status` 的文件级输出**翻译成图包语言**——"冒险牌堆 12 张卡换图"而不是"`decks/冒险牌堆/001_正面.png` 已修改"。**绝不替用户做合并选择**。

```console
$ tts pack list --root ./packs
已注册图包（2 个）：
  第七大陆全扩  第七大陆全扩（脚本汉化）  zh-cn  true   enabled
  沉睡的神祇   沉睡的神祇              main   false  disabled

$ tts pack list --dirty
已注册图包（1 个）：
  第七大陆全扩  第七大陆全扩（脚本汉化）  zh-cn  true  enabled

$ tts pack status 第七大陆全扩
dir: 第七大陆全扩
name: 第七大陆全扩（脚本汉化）
kind: localization
branch: zh-cn
...

$ tts vcs status
冒险牌堆 2 张卡换图（001_正面.png, 002_正面.png）
素材 tile_01 改动
Global 脚本 +5/-1 行

$ tts vcs commit -m "汉化冒险牌堆"
已提交 32ab68e：汉化冒险牌堆：替换 冒险牌堆 2 张卡图，修改 Global 脚本（+8/-0 行），更新素材 tile_01

$ tts vcs status --conflicts     # 有 merge UU 时
冒险牌堆 1 张卡换图（001_正面.png）
发现 1 个合并冲突：
⚠️ 卡牌图片冲突（需人工选择）

牌堆：冒险牌堆 (GUID: abc123)
卡牌：迷路的旅人 (CardID: 101)
文件：decks/冒险牌堆/001_正面.png（正面）
所属图集：sheet_id=1, slot=1
源 URL：https://example.com/sheet1.png
冲突类型：双方都修改 (UU)

选择：
  git checkout --ours   decks/冒险牌堆/001_正面.png   # 保留当前分支版本
  git checkout --theirs decks/冒险牌堆/001_正面.png   # 用对方分支版本
  或手动用图像工具合成后 git add

$ tts vcs verify
校验完成：0 错误，1 警告（存在未提交改动）

$ tts vcs size
工作区体积：1.23 KB
.git 体积：806.03 KB
.git/lfs/objects 体积：768.09 KB
按目录分解：
  decks    329 B  4
  scripts  171 B  1
  ...

$ tts vcs lfs status
git-lfs 已安装（版本 3.7.1）
.gitattributes 含 lfs 规则：true
pack.yaml 的 vcs.lfs：enabled
三方一致（lfs 状态正常）

$ tts vcs lfs disable            # 强制二次确认（约束 10）
⚠️  禁用 git-lfs 后：
   - 每次修改一张卡图，git 都会存一整份新副本
   - 一个图包改 10 轮，仓库可能膨胀到几十 GB
   - 推送到远端会非常慢，某些托管商可能拒绝（GitHub 单文件 100MB 上限）
确认禁用？此操作建议仅用于「纯本地、不打算推远端」的场景。
输入 yes 确认：yes
lfs 已禁用（.gitattributes 的 lfs 规则已清空，pack.yaml 已写为 disabled）
```

要点：

- **`.registry.yaml` 并发写保护**：乐观锁（mtime 校验），写冲突抛 `REGISTRY_CONFLICT`（不引入文件锁）。
- **`vcs verify` 是 `deck verify` 的超集**：先跑 deck verify（网格/卡数/CMYK/CardID/父子一致/共享图集），再加 git 检查（未提交改动 / UU 冲突 / lfs 三方一致性）。
- **`vcs size` 三数字同报**：lfs 启用时必须同时给"工作区体积"和"lfs 对象体积"（方案设计 §4.11.1）。
- **冲突语义化反查**：从 `cards.csv` / `objects.csv` 反查冲突文件对应的 CardID / sheet_id / slot / sheet_source；**绝不替用户选边**（不自动跑 `--ours/--theirs`）。
- **`vcs commit` 自动 message**：基于 `analyzeStatus` 的语义化结果，按"卡图 > 卡表 > 脚本 > UI > 素材 > 元数据"优先级取前 3 条，超过 3 条末尾加"等 N 项改动"。

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
  pack/       图包工作区：layout / packyaml / manifest / init / unpack / pull / push / diff / build（阶段 2A）
  cli/        commander 命令注册（status / config / pull / exec / assets / pack）
docs/schemas/ pack.yaml / deck.yaml / assets.yaml 契约文档（B2/B3 必读）
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
