# tts-toolkit

面向《桌游模拟器》（Tabletop Simulator）图包作者的命令行工具：通过 TTS 的**外部编辑器协议**直连运行中的游戏，只读地检查连接状态、执行 Lua、拉取全部脚本与 UI、盘点素材 URL；并支持**离线**的图包工作区管理（unpack / build / pull / push / diff），所有面向用户的输出支持中文 / 英文双语。

> 当前进度：阶段 1（基础设施 + 协议层 + 只读 CLI）+ 阶段 2A（图包工作区）+ 2B（卡牌图集）+ 2C（多图包与版本控制）+ 阶段 3（素材导入 / 图床 / 打包分发，窗口 C）+ 阶段 4（hub + MCP，窗口 D）。`status / exec / pull / assets / config` 等命令只读；`pack init/unpack/build/export/import/sync-upstream`、`import / host / fetch / migrate / deck / vcs / review` 离线或按需联网；`pack pull/diff` 与运行中 TTS 交互；`pack push` 为骨架（阶段 5 才实际写入）；`tts hub` 启动常驻守护进程，`tts-mcp` 为 MCP stdio 服务（见 §10）。

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

工作区契约文档见 [`docs/schemas/`](./docs/schemas/)（`pack.yaml` / `deck.yaml` / `assets.yaml` / `cards.csv` / `objects.csv` / `registry.yaml` 六份，B2/B3 必读；另加阶段 3 的 `import.yaml` / `host` / `ttsmod` 三份）。

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

### 9. 素材导入、图床、体检迁移与打包分发（阶段 3 新增）

阶段 3（窗口 C）补齐"素材从哪来 → 传到哪去 → 怎么打成自包含分发包"这条链路。命令分四组：

| 组 | 命令 | 联网 / 环境 |
| --- | --- | --- |
| 素材导入 | `tts import` | 全离线 |
| 图床 | `tts host list` / `tts host check` / `tts assets upload` | `list` 离线；`check` / `upload` 按图床联网 |
| 体检与迁移 | `tts fetch` / `tts migrate` | 联网 |
| 打包分发 | `tts pack export` / `tts pack import` / `tts pack sync-upstream` | 离线（`export` 的扩展名探测可选联网） |
| 审批门禁 | `tts review prepare` / `tts review status` / `tts review gate` | `prepare` / `gate` 离线；`status` 需审批工具 |

> 本节示例中 `import` / `host list` / `pack export` / `pack import` 为 2026-10-05 在本机实测
> （演示夹具，非真实工坊图包）；`host check` / `fetch` / `migrate` / `assets upload` / `review`
> 为按 t() 模板展示的用法示例（依赖网络 / 图床 / 审批工具环境）。

#### 9.1 素材导入：`tts import <清单> [--pack <工作区>] [--dry-run]`

按 `import.yaml` 把用户已备好的成图归位到工作区（切图来源走 `tts deck slice`，不经过这里）。
清单里的**相对路径相对清单文件所在目录**解析，`--pack` 给工作区根（缺省 `.`）。

```console
$ tts import ./import.yaml --pack ./packs/演示包 --dry-run
导入完成：卡堆 1 个（新增卡 2 张），素材 1 个，复制文件 5 个
  卡堆 冒险牌堆：新增 2 张卡，图集 1 张（新建）  D:\...\packs\演示包\decks\冒险牌堆
  素材 tile 地图板块A：asset_id imp-964dedd7（新建）
（dry-run：未写入任何文件，以上为规划结果）

$ tts import ./import.yaml --pack ./packs/演示包      # 实落盘（去掉最后一行提示）
```

要点：

- 全部校验（清单 schema、文件存在性、图像可读、**拒 CMYK**）与规划**先于任何落盘**完成，
  失败即报错并指出具体条目，**不静默跳过**；坏清单的错误码见契约文档。
- 只写 `decks/<名>/cards.csv` 与 `objects/objects.csv`（**不写 deck.yaml**）；已有行的
  `card_id` / `asset_id` 永不改变，新增卡从已有最大 key + 1 另开新图集。
- 契约：`docs/schemas/import.yaml.md`。

#### 9.2 图床：`tts host list` / `tts host check [--pack <工作区>] [--host <id>]`

`host list` 汇总三个来源：内置默认 `steamcloud`、全局配置声明的图床、`~/.tts-toolkit/hosts/*.js`
插件。`host check` 从工作区盘点素材 URL（`.tts/skeleton.json` + `assets.yaml` 合并去重）逐个做
存活检测，**有死链时退出码 1**（可直接当健康检查用）。

```console
$ tts host list
可用图床 1 个：
  steamcloud  内置（默认）
    可删除：否  单文件上限：不限  格式：-

$ tts host check --pack ./packs/第七大陆
开始检测：130 个 URL（骨架 130 条 / 台账 0 条），图床 steamcloud
  死链：https://example.com/gone.png（HTTP 404）
检测完成：共 130 个，存活 129，死链 1
```

要点：

- 图床类型：`steamcloud`（默认，上传可能需按提示去游戏内 `Cloud Manager → Upload All` 手动完成，
  **这是可接受结果不是失败**）、`s3`（R2 / AWS / MinIO，可全自动）、`local`（仅本机测试）、
  `command`（调用自定义命令上传，万能逃生口；也可写 `~/.tts-toolkit/hosts/<名>.js` 插件）。
- **配置错误绝不静默回退默认图床**：未知 id 报 `HOST_NOT_FOUND`，配置 / 插件损坏报
  `HOST_CONFIG_INVALID` / `HOST_PLUGIN_*`。
- 契约与完整可跑的 rclone 示例：`docs/schemas/host.md`。

#### 9.3 素材体检与迁移：`tts fetch` / `tts migrate --to <图床>`

`fetch` 做"素材健康报告"，把 URL 分成正常 / 可迁移（老 Steam Cloud 域名、Google Drive 转直链、
Dropbox、paste 站 raw）/ 死链 / 需人工四类并给修复动作；`migrate` 按 `--to` 指定的图床
**下载 → 上传 → 递归改写**工作区里全部存档形态 JSON（骨架 + `decks/**/data.json` +
`objects/**/data.json`），并同步 `assets.yaml` 与 `objects.csv.source`。

```console
$ tts fetch ./packs/第七大陆/.tts/skeleton.json
从清单读取 URL：./packs/第七大陆/.tts/skeleton.json（132 条）
体检完成：共 132 个 URL（正常 100 / 可迁移 20 / 死链 8 / 需人工 4）
可迁移（20 条）：
  http://cloud-3.steamusercontent.com/ugc/...  [老式 Steam Cloud]  修复：迁移域名
    建议改为：https://steamusercontent-a.akamaihd.net/ugc/...
...

$ tts migrate --to s3 --pack ./packs/第七大陆
开始迁移：图床 s3，52 个 URL，3 个存档文件
  已迁移：https://old.example.com/a.png → https://cdn.example.com/tts/...
  跳过（不可下载）：file:///C:/Users/...（本地路径无法下载，需重新上传）
迁移完成：成功 50 / 跳过 1 / 失败 1 / 待人工 0；共改写 118 处 URL，涉及 3 个文件
```

要点：仍有失败 URL 时 `migrate` 退出码 1；`file:` / `{lang}` 变体等不可下载形态原样跳过并列出原因；
Steam Cloud 的 pending 结果不算失败，按"待人工上传"报告。迁移只改工作区，改完重新
`tts pack build` 即可产出引用新 URL 的存档。

#### 9.4 素材上传：`tts assets upload [--pack <工作区>] [--host <id>]`

扫 `decks/`、`objects/` 下的素材，逐个算 sha256 与 `assets.yaml` 台账比对，**只上传新增或内容
变化的文件**，成功后回写台账与 `objects.csv` 的 `source` 列。

```console
$ tts assets upload --pack ./packs/第七大陆 --host rclone-cdn
上传目标图床：rclone-cdn（pack.yaml 声明：steamcloud）
扫描完成：待上传 3 个，未变化跳过 12 个
  已上传 decks/冒险牌堆/001_正面.png → https://cdn.example.com/tts/decks/冒险牌堆/001_正面.png
已更新素材台账：D:\...\packs\第七大陆\assets.yaml
上传完成：成功 3 / 跳过 12 / 待人工 0 / 失败 0
```

要点：`--host` 覆盖 `pack.yaml.host`；`pack.yaml.host` 的 `imgur / gdrive / dropbox / custom`
不是注册图床 id，会提示改用 `--host`。用内置 `steamcloud` 上传时返回"待人工上传"提示
（文件已备好在 `.tts/steamcloud-pending/`，去游戏内点 `Upload All`）。有失败时退出码 1。

#### 9.5 打包分发：`tts pack export` / `pack import` / `pack sync-upstream`

**导出**：把工作区合成存档 JSON 后打成自包含 `.ttsmod`（素材条目名 = TTS 缓存键，接收方解压到
`Mods` 的父目录即可离线命中，**存档 JSON 里的 URL 一个字不改**）。

```console
$ tts pack export ./packs/演示包 -o 演示图包.ttsmod --datadir "D:\...\Tabletop Simulator_Data\Mods"
已导出 D:\...\演示图包.ttsmod：条目 4 个，1.95 KB，素材 1 条，跳过 0 条
随包说明：README.txt
```

包内布局（`readZip` 实测）：

```text
Mods/Workshop/演示图包.json                存档 JSON，逐字节原样（URL 一个字不改）
Mods/Images/httpsexamplecomimageshero.png  素材条目名 = sanitize(url) + 扩展名
manifest.json                              工具 / 版本 / 时间 / 源工坊 ID / 素材清单（新增根条目）
README.txt                                 中英双语随包说明（--readme zh|en|both|none，默认 both）
```

**导入**：解压到 `--into`（**`Mods` 的父目录**）；非 `Mods/` 条目（如 `Saves/`）解到 `--saves`
（缺省 `<into>/Saves`）。**已存在的文件不覆盖**，逐个列出。

```console
$ tts pack import 演示图包.ttsmod --into D:\tts-restore
已导入 演示图包.ttsmod → D:\tts-restore（写出 3 / 共 4 个文件条目）
包内工坊存档 1 个：
  D:\tts-restore\Mods\Workshop\演示图包.json
如需建工作区，可运行：tts pack unpack "D:\tts-restore\Mods\Workshop\演示图包.json"

$ tts pack import 演示图包.ttsmod --into D:\tts-restore      # 再导入一次
已导入 演示图包.ttsmod → D:\tts-restore（写出 0 / 共 4 个文件条目）
已存在未覆盖 3 个：
  Mods/Workshop/演示图包.json
  Mods/Images/httpsexamplecomimageshero.png
  README.txt
  ...
```

**上游同步**：`pack import <工坊ID> --as-upstream` 把上游快照落到 `upstream` 分支；
`pack sync-upstream` 拉新快照并合并回当前分支，**冲突只报告不选边**（退出码 1 待人工解决）。

```console
$ tts pack import 379104394 --as-upstream --pack ./packs/第七大陆 --snapshot ./upstream-v2.json
已导入上游快照 ./upstream-v2.json（分支 upstream，提交 3ab12cd）

$ tts pack sync-upstream --pack ./packs/第七大陆
已同步上游快照 ...（当前分支 zh-cn，upstream 提交 9e8f7a6）
已将 upstream 合并回分支 zh-cn（干净合并）
```

要点：`--strict` 缺任一素材即报错、不产出不完整的包；默认行为是"只打包本地已有的，**缺的逐条列出**"；
`-o` 缺省按 `<图包名> (<工坊ID>).ttsmod` 命名；`--datadir` 提供 TTS 的 `Mods` 目录后，扩展名推导
才有本地缓存可查。契约：`docs/schemas/ttsmod.md`。

#### 9.6 审批门禁：`tts review prepare` / `status` / `gate`

与「图包审批工具」松耦合联动：`prepare` 生成 `approval.config.json`（素材 id = 文件名，
零转换）；`status` 调审批工具总览（服务在跑走 HTTP，否则走 `python agent.py`）；`gate` 读审批结果做
**发布门禁——全 pass 才允许打包 / 上传**，不过时逐条列出拦截理由并退出码 1。

```console
$ tts review prepare --pack ./packs/第七大陆 --deck 冒险牌堆 --b ./render
审批配置已写入：D:\...\packs\第七大陆\.tts\approval\approval.config.json
  素材集 冒险牌堆：源A D:\...\packs\第七大陆\decks\冒险牌堆 → 源B D:\...\render
  审批数据目录：D:\...\packs\第七大陆\.tts\approval\data

$ tts review gate --pack ./packs/第七大陆
门禁评估：素材集 冒险牌堆，共 70 条（pass 69 / reject 1 / flag 0 / 未审 0 / 过期 0）
拦截项 1 条：
  003_正面.png：审批未通过（reject）
门禁未通过：请先处理上面的拦截项（重新审批后重跑本命令）
```

（全部 pass 时输出 `门禁通过：全部素材已审批通过，可以打包 / 上传` 并退出码 0。）

### 10. hub 守护进程与 MCP 接入（阶段 4 新增）

阶段 4（窗口 D）新增常驻 **hub 进程**与 **MCP 服务**：hub 独占编辑器端口 39998，把 TTS 推送扇出给下游，并在 `127.0.0.1:39995` 暴露 HTTP+JSON 控制通道；`status / pull / exec` 在 hub 在线时自动委托，`tts-mcp` 通过同一控制通道把 10 个工具接入 MCP 客户端。

> 本节中 hub 的 JSON Lines 日志、端口监听与 curl 响应为 2026-10-05 在本机实测（TTS 未运行，只验证了协议与错误契约）；CLI 中文提示来自 `locales` 的 `cli.hub.*` / `cli.status.connectedViaHub` / `cli.pull.viaHub` / `cli.exec.viaHub` / `error.hub.delegateFailed` 键，按 `t()` 模板语义展示。

#### 10.1 启动 hub：`tts hub`（或 `tts-hub`）

```console
$ tts hub
{"ts":"2026-10-05T05:21:52.023Z","level":"info","msg":"hub started","editorPort":39998,"tcpPort":39997,"wsPort":39996}
control server listening on 127.0.0.1:39995
{"ts":"2026-10-05T05:21:52.024Z","level":"info","msg":"hub started","port":39995}
hub 已启动：控制通道 http://127.0.0.1:39995/v1；编辑器端口 39998；TCP 扇出 39997；WS 扇出 39996（Ctrl+C 停止）
```

Ctrl+C（或 `POST /v1/hub/shutdown`）优雅停止，退出码 0：

```console
^C
{"ts":"2026-10-05T05:22:07.494Z","level":"info","msg":"hub stopping"}
control server stopped
{"ts":"2026-10-05T05:22:07.495Z","level":"info","msg":"hub stopped"}
{"ts":"2026-10-05T05:22:07.495Z","level":"info","msg":"hub stopped"}
hub 已停止
```

| 选项 | 缺省 | 说明 |
| --- | --- | --- |
| `--port <n>` | 39995 | 控制通道端口 |
| `--editor-port <n>` | 39998 | 编辑器入站端口（TTS 主动连入；hub 期间独占） |
| `--tcp-port <n>` | 39997 | TCP 扇出端口 |
| `--ws-port <n>` | 39996 | WebSocket 扇出端口 |
| `--log-file <path>` | 仅 stdout | 追加写日志文件；文件不可用时降级为仅 stdout 并记一条 warn |

端口分工：

| 端口 | 归属 | 方向与形态 |
| --- | --- | --- |
| 39998 | 编辑器入站 | TTS → hub，独占绑定（与官方 VSCode 插件互斥，见 10.6） |
| 39997 | TCP 扇出 | hub → 下游，连入后持续收 JSON 串（无分隔符） |
| 39996 | WS 扇出 | hub → 下游，连入后持续收 JSON 文本帧 |
| 39995 | 控制通道 | 双向 HTTP+JSON，**只绑 127.0.0.1** |

要点：

- 日志是英文 JSON Lines（`ts` / `level` / `msg` + 附加字段）写 stdout；控制通道自身的启停两行为纯英文文本行（`control server listening on ...` / `control server stopped`），不是 JSON。
- 启动失败（任一端口被占）输出中文原因并退出 1；39998 被占的提示含 PID（文案与「与官方 VSCode 插件的互斥」一节相同），已启动的资源会被回滚。
- 停止顺序固定：控制通道（先拒新连接）→ 编辑器 + 扇出 → 日志文件流；SIGINT / SIGTERM / `/v1/hub/shutdown` 三路共用同一次停止流程（幂等）。
- `tts-hub` bin 是 `tts hub` 的无选项薄入口（端口全取缺省值），适合写进脚本或服务自启。

#### 10.2 独立模式 vs hub 模式自动切换

`tts status` / `tts pull` / `tts exec` 每条命令执行前都会现场探测一次 hub（`GET /v1/status`，800 ms 超时，**不缓存**）：

- **hub 在线**：委托执行——`pull` / `exec` 首行打印一行「经 hub」提示（分别为 `cli.pull.viaHub` / `cli.exec.viaHub` 的文案），`status` 报告经 hub 的连接（含控制通道地址）；实际动作在 hub 进程内完成（它持有 39998 的独占绑定）。注意 `pull` 目前受 §10.4 的已知实现限制影响（hub 运行期该路由返回 500，委托失败退出 1）。
- **hub 不在线**：独立模式，与阶段 3 完全一致（临时独占绑定 39998 后直连 TTS）。
- **委托失败**（hub 中途退出、协议错误等）：输出 `error.hub.delegateFailed` 并退出 1，**不回退独立模式**——hub 在线期间 39998 由 hub 持有，回退也绑不上端口。
- 其余命令（`assets / config / pack / deck / vcs / import / host / fetch / migrate / review`）不经过 hub，行为不变。

```console
$ tts status
已通过 hub 连接到 TTS 编辑器（控制通道 127.0.0.1:39995）
脚本引擎版本：MoonSharp 3.0.0.0
当前存档对象数：251

$ tts exec 'return 1+1'
hub 在线：本次执行委托 hub 完成
2
```

（hub 在线但 TTS 还没连上 39998 时，`status` 给出提示并以退出码 1 结束。）

#### 10.3 下游通道：TCP / WS / SSE

hub 收到 TTS 推送后，同一份 JSON 同时写入三路（单路断开自动摘除，不影响其他路）：

| 通道 | 地址 | 数据形态 | 面向 |
| --- | --- | --- | --- |
| TCP 扇出 | `127.0.0.1:39997` | JSON 串原样连写，**无换行分隔** | 阶段 6 改版 VSCode 插件（纯字节转发） |
| WS 广播 | `ws://127.0.0.1:39996/` | 一条消息 = 一帧文本（JSON） | 自研客户端 / 网页面板 |
| SSE | `http://127.0.0.1:39995/v1/events` | `data: <JSON>` 行事件流 | curl / 浏览器 EventSource 调试 |

```console
$ curl -N http://127.0.0.1:39995/v1/events
:connected

data: {"messageID":2,"message":"hello from Lua"}
```

- TCP 不写分隔符（S2 约定）：接收方按 JSON 流自行增量解析；只服务本机（hub 绑 127.0.0.1）。
- WS 是手写极简 RFC6455：只接受 `GET /` + `Upgrade: websocket`，普通 HTTP 请求回 426；下行文本帧；上行只处理 Ping（回 Pong）与 Close，数据帧忽略——**下游只收**。
- SSE 连接先收到一行 `:connected` 注释；只转发 6 类消息：`GameLoaded / Print / Error / CustomMessage / GameSaved / ObjectCreated`（不含 `PushNewObject` 与 exec 往返的 `ReturnValue`）；客户端断开即退订。
- 三路都只绑回环地址（实测 39995 / 39996 / 39997 均为 `127.0.0.1`）。

#### 10.4 控制通道（HTTP+JSON on 39995）

基线 `http://127.0.0.1:39995/v1`，12 条请求 / 响应路由 + 1 条 SSE（`GET /v1/events`）：

| 方法 | 路由 | 作用 |
| --- | --- | --- |
| GET | `/v1/status` | hub 健康 + TTS 连接状态 |
| POST | `/v1/scripts/pull` | 拉全部脚本到工作区 |
| POST | `/v1/scripts/save-and-play` | 回写 scriptStates（供 push 用） |
| POST | `/v1/exec` | 执行 Lua 返回 JSON |
| POST | `/v1/assets/check` | 素材盘点 / 存活检测 |
| GET | `/v1/packs` | 列出注册表图包 |
| POST | `/v1/deck/slice` | 切片 |
| POST | `/v1/deck/plan` | 替换计划 dry-run |
| POST | `/v1/import` | 按 import.yaml 导入 |
| POST | `/v1/diff` | 本地 vs 游戏内差异 |
| POST | `/v1/push` | 写回并重载（必须 `confirm:true`） |
| POST | `/v1/hub/shutdown` | 优雅关闭 hub |
| GET | `/v1/events` | SSE 事件流 |

统一约定：

- 只监听回环地址；构造时就拒绝 `0.0.0.0` / `::` 等通配地址（绝不监听所有接口）。
- POST 请求体上限 **1 MB**（超限 413）；`Content-Type` 必须是 `application/json`（否则 415）。
- 错误统一 `{error:{code,message,details?}}` + 4xx/5xx：

| code | HTTP | 触发 |
| --- | --- | --- |
| `HUB_BAD_REQUEST` | 400 | 缺字段 / 非法 JSON / 请求体不是对象 |
| `HUB_NOT_FOUND` | 404 | 未知路由 |
| `HUB_METHOD_NOT_ALLOWED` | 405 | 路径存在但方法不对（带 `Allow` 头） |
| `HUB_PAYLOAD_TOO_LARGE` | 413 | 请求体超过 1 MB |
| `HUB_UNSUPPORTED_MEDIA_TYPE` | 415 | `Content-Type` 不是 `application/json` |
| `HUB_CONFIRM_REQUIRED` | 400 | `/v1/push` 未带 `confirm:true` |
| `HUB_PACK_ERROR` | 400 | 图包业务错误（`details.packCode` 透传业务码） |
| `HUB_LUA_ERROR` | 400 | Lua 运行时错误（`details` 带 guid / line / col / endCol） |
| `HUB_INTERNAL_ERROR` | 500 | 其余异常（含 TTS 未连接） |
| `HUB_NOT_RUNNING` | —（客户端合成） | hub 不可达：CLI / MCP 客户端侧网络层失败，不是 hub 返回的 |

```console
$ curl http://127.0.0.1:39995/v1/status
{"ok":true,"hub":{"editor":true,"tcpClients":0,"wsClients":0,"inprocClients":0,"startedAt":1791177712023,"uptimeMs":5020},"tts":{"connected":false}}

$ curl -X POST http://127.0.0.1:39995/v1/exec -H "Content-Type: application/json" -d '{"lua":"return 1+1"}'
{"error":{"code":"HUB_INTERNAL_ERROR","message":"无法连接 TTS（127.0.0.1:39999）。请确认游戏已启动并加载了存档。"}}

$ curl -X POST http://127.0.0.1:39995/v1/push -H "Content-Type: application/json" -d '{"root":"D:/packs/演示包"}'
{"error":{"code":"HUB_CONFIRM_REQUIRED","message":"this operation requires confirm:true in the request body"}}

$ curl -X POST http://127.0.0.1:39995/v1/hub/shutdown
{"ok":true}
```

要点：

- 控制通道**有意不暴露** `pack export` / `pack import`（`.ttsmod`）/ `pack sync-upstream` / `review`（打包、上游合并与审批门禁不进 HTTP 面）。
- `/v1/deck/slice` 与 `/v1/deck/plan` 的请求体就是 CLI 同名选项（`sheetPath` / `savePath` / `outDir` 等绝对路径）；HTTP 场景无交互，多候选时 slice 报 `SLICE_AMBIGUOUS`（`HUB_PACK_ERROR`），用 `deckKey` / `deckGuid` 消歧后重试。
- `/v1/push` 是本阶段**唯一实际写回游戏**的通路（`confirm:true` 必填）；CLI 的 `pack push` 仍是清单骨架（阶段 5 补 baseline hash / 备份 / 素材检测）。
- ⚠️ **已知实现限制（阶段 4，待修）**：`POST /v1/scripts/pull` 与 `POST /v1/diff` 在 hub 运行期会返回 500 `HUB_INTERNAL_ERROR`（`PortInUseError`）——`pullFromGame` / `diffWorkspace` 内部仍经 `withEditorServer` 重新独占绑定 39998，与 hub 冲突；修复方向（会话注入）与影响范围见 [`docs/schemas/hub-control.md`](./docs/schemas/hub-control.md) §4.2 / §4.10。
- 完整契约（字段级）见 [`docs/schemas/hub-control.md`](./docs/schemas/hub-control.md)（第 10 份契约文档）。

#### 10.5 MCP 服务（`tts-mcp`）

`tts-mcp` 是独立的 **stdio MCP 进程**（不经过 `tts` 主 CLI，自身不监听任何端口）：每个工具调用 = 控制通道上的一次 HTTP 请求，需要先启动 hub。hub 未运行时工具返回 `isError:true` + `{error:{code:"HUB_NOT_RUNNING",...}}`，不会倒退为本地模式。

```console
$ tts hub        # 先起 hub
$ tts-mcp        # MCP 客户端按需拉起（stdout 是协议通道，诊断走 stderr）
```

`--lang zh-CN | en-US` 指定工具标题 / 描述语言（非法值向 stderr 告警后按默认链回退，不阻塞会话）。

10 个工具：

| 工具 | 作用（对应路由） | 副作用 | 参数 |
| --- | --- | --- | --- |
| `tts_status` | hub + TTS 状态（GET `/v1/status`） | 只读 | 无 |
| `tts_pull` | 拉全部脚本到工作区（POST `/v1/scripts/pull`） | 写工作区 `scripts/`、`ui/` | `root` |
| `tts_exec` | 执行 Lua（POST `/v1/exec`） | 由 Lua 代码决定（游戏内） | `lua`；可选 `guid`、`timeoutMs` |
| `tts_assets` | URL 存活检测（POST `/v1/assets/check`） | 只读（联网探测） | `urls`（非空字符串数组）；可选 `timeoutMs` |
| `tts_pack_list` | 列出注册表图包（GET `/v1/packs`） | 只读 | 可选 `packsRoot` |
| `tts_deck_slice` | 图集切片（POST `/v1/deck/slice`） | 写切片图到 `outDir` | `sheetPath`、`savePath`、`outDir`；可选 `deckKey`、`deckGuid` |
| `tts_deck_plan` | 替换计划 dry-run（POST `/v1/deck/plan`） | 只读 | `savePath`（路径或已解析对象）、`rules`（数组） |
| `tts_import` | 按 `import.yaml` 导入（POST `/v1/import`） | `dryRun:false` 时写工作区 | `root`、`manifestPath`；可选 `dryRun` |
| `tts_diff` | 本地 vs 游戏内差异（POST `/v1/diff`） | 只读 | `root` |
| `tts_push` | 写回并重载（POST `/v1/push`） | **写入游戏**（危险） | `root`、`confirm`（必须字面量 `true`） |

要点：

- `tts_push` 是唯一有确认门的工具：调用侧 schema 就要求 `confirm: true`（字面量），hub 侧再挡一次（缺了返回 400 `HUB_CONFIRM_REQUIRED`）；写回语义注意——`scriptStates` 缺 `script` / `ui` 字段时 TTS 会**删除**对应内容。
- ⚠️ `tts_pull` / `tts_diff` 受 §10.4 的已知实现限制影响（hub 运行期对应路由返回 500 `HUB_INTERNAL_ERROR`）；其余 8 个工具不受影响。
- 工具结果都是结构化 JSON（英文键名，不走 `t()`）；失败体统一 `{error:{code,message,details?}}`（`HUB_LUA_ERROR` 时 details 带 guid / line / col / endCol）。
- MCP 会话期 stdout 只走协议；诊断 / 致命错误走 stderr JSON Lines（英文）。

**ZCode 注册示例**：编辑 `C:\Users\<用户>\.zcode\cli\config.json`（**先备份原文件**），把下面这段并入文件顶层（`plugins` / `skills` 等原字段保持不动）：

```json
{
  "mcp": {
    "servers": {
      "tts": {
        "command": "node",
        "args": ["D:\\Codex\\TTS图包制作维护工具\\tts-toolkit\\dist\\mcp\\main.js"]
      }
    }
  }
}
```

（需要先 `npm run build`；可选在 `args` 里追加 `"--lang", "zh-CN"`。改完重启 ZCode 会话即可看到 10 个 `tts_*` 工具。）

#### 10.6 与官方 VSCode 插件的互斥

hub 独占 39998 期间，官方 VSCode 插件（以及未走 hub 的其他工具实例）**都连不上游戏**；反过来官方插件先占用 39998 时，`tts hub` 会启动失败并输出含 PID 的中文提示。排查命令与阶段 1 相同：

```powershell
Get-NetTCPConnection -LocalPort 39998 -State Listen | Select-Object OwningProcess
```

阶段 6 会提供**改版 VSCode 插件**：它不再抢 39998，而是连 hub 的 TCP 扇出 `127.0.0.1:39997`（纯字节转发），届时两者可同时使用。在改版插件就绪前，使用 hub（或独立模式的任何命令）都要先关闭官方插件。

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

只有联网的探测 / 下载会用到代理：`tts assets --check`、`tts host check`、`tts fetch`、`tts migrate`，以及 `tts pack export` 的扩展名 HTTP 探测（`src/assets/check.ts` / `src/assets/fetch.ts` / `src/archive/detect.ts` 在调用时读取
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

- **VSCode 插件改版未提供**：hub（阶段 4）已落地并独占 39998，官方 VSCode 插件在
  hub 运行期间不可用；连 hub TCP 扇出（39997）的改版插件属于阶段 6（见 §10.6）。
- **CLI 的 `pack push` 仍是骨架**：push 协议（messageID 1）不接收素材字段，阶段 5 才由
  CLI 实际写入；真正写回游戏的唯一通路是 hub 控制通道 `POST /v1/push` / MCP `tts_push`
  （必须 `confirm:true`，见 §10.4 / §10.5）。
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
  assets/     snake_case ↔ CamelCase 字段映射、素材盘点、URL 存活检测、下载修复与迁移（阶段 3）
  datadir/    TTS 数据目录探测与配置读写
  i18n/       极简 t(key, params) 双语实现
  pack/       图包工作区：layout / packyaml / manifest / init / unpack / pull / push / diff / build / import（阶段 2A / 3）
  deck/       卡牌图集切片 / 拼接 / 校验、cards.csv 与 objects.csv（阶段 2B）
  vcs/        git 语义化 status / commit / verify / lfs / size（阶段 2C）
  archive/    .ttsmod 读写、TTS 缓存键、扩展名三级推导（阶段 3）
  host/       图床统一接口与四种内置实现：steamcloud / s3 / local / command（阶段 3）
  review/     与图包审批工具的联动：prepare 配置 / status 调用 / gate 门禁（阶段 3）
  hub/        hub 守护进程：编辑器入站 + TCP/WS 扇出 + S2 控制通道（阶段 4）
  mcp/        MCP stdio 服务与 10 个工具（阶段 4）
  cli/        commander 命令注册（status / config / pull / exec / assets / pack / deck / vcs / import / host / fetch / migrate / review / hub）
docs/schemas/ 契约文档：pack.yaml / deck.yaml / assets.yaml / cards.csv / objects.csv / registry.yaml
              + 阶段 3 的 import.yaml / host / ttsmod + 阶段 4 的 hub-control（共十份）
locales/      zh-CN.json、en-US.json
tests/unit/   不依赖 TTS 的单元测试
tests/integration/  验收骨架（phase1 需 TTS；phase2b / 2c / 3 / 4 为逐用例 it.skip 清单）
```

约定：TypeScript ESM（`.ts`，import/export）、target ES2022 / module NodeNext / strict；
面向用户的字符串一律走 `t()`；禁止 `any`（运行时边界用 `unknown` + zod）；注释用中文。

## 集成测试使用说明

`tests/integration/phase1.acceptance.test.ts` 对照《施工流程》阶段 1 验收标准，
通过子进程调用已构建的 CLI。因为需要真实 TTS，**默认整组 `describe.skip`**，
`npm test` 与 `npm run test:integration` 都会跳过它（输出 10 skipped）。

`tests/integration/phase2b.acceptance.test.ts` / `phase2c.acceptance.test.ts` /
`phase3.acceptance.test.ts` / `phase4.acceptance.test.ts` 是后续阶段的验收骨架：
**逐用例 `it.skip`**（不是 describe.skip），
每个用例体只有 TODO 与一条 `todo(...)` 守卫（未实现就打开会明确失败，不给假绿）。开启方式：
按用例内 TODO 装配夹具后删掉该用例的 `.skip`，再跑 `npx vitest run tests/integration/<文件>`
（或 `npm run test:integration`）。phase3 的 12 个场景覆盖 import / host / migrate / pack export /
pack import / 扩展名推导 / review 门禁 / sync-upstream，多数场景全离线。

手动开启 phase1 的步骤：

1. 确保已 `npm run build`；
2. 启动 TTS 并加载图包存档；
3. 关闭 VSCode 的 TTS 插件；
4. 打开 `tests/integration/phase1.acceptance.test.ts`，把 `describe.skip(` 改成 `describe(`；
5. 执行 `npm run test:integration`。

基准值（本机实测）：36 个 `.lua` + 1 个 `.xml`、脚本总量 277,644 字符（断言允许 ±5%）、
251 个对象、130 个不同素材 URL。存档改动后如数字变化，更新文件顶部的基准常量即可。
