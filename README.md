# tts-toolkit

[![CI](https://github.com/Smirk1921/tts-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/Smirk1921/tts-toolkit/actions/workflows/ci.yml)

> **English** — A comprehensive toolchain for Tabletop Simulator mod creators: pack
> workspace, atlas slicing/stitching, git-based version control, hub daemon, MCP
> integration, Lua test runner, and Steam Workshop publishing.
>
> **中文** — 面向《桌游模拟器》图包作者的全套工具链：图包工作区、卡牌图集切拼、
> Git 版本控制、hub 常驻守护、MCP 集成、Lua 测试运行器、Steam 工坊发布。

---

## Features

- **Pack workspace** — unpack any TTS save into a clean file-based workspace (decks,
  objects, scripts, UI), edit with your own tools, and rebuild byte-identical saves.
- **Atlas slicing & stitching** — convert card sheets to/from TTS deck atlases with
  remainder absorption for real-world sheets.
- **Git-based version control** — semantic diff, LFS for binary assets, upstream
  sync and review gates for multi-pack workflows.
- **Hub daemon + MCP integration** — one TTS connection shared by the CLI, the
  VSCode extension ([tts-lua-hub](https://github.com/Smirk1921/tts-lua-hub)), and
  any MCP-compatible AI agent.
- **Lua test runner** — write Lua tests with an assertion library and run them
  inside TTS via `tts test` (standalone or hub-delegated).
- **Steam Workshop publishing** — BSON payload generation (`tts build`),
  kpsteam-powered upload (`tts publish --auto`), and a 7-step manual guide
  (`tts publish --manual-guide`).

## Quick Start

```bash
npm install
npm run build

# Check TTS connection / list installed mods
tts status
tts assets

# Unpack a save into a workspace
tts pack unpack <save.json> --out my-pack

# Edit files, then push back into TTS
tts pack push --root my-pack --yes

# Run Lua tests inside TTS
tts test --root my-pack

# Build a Workshop payload and publish
tts build -o dist/mod.bson --root my-pack
tts publish --item <workshop_id> --bson dist/mod.bson --auto
```

## Design Principles

- **Single TTS connection** — TTS only listens on port 39998/39999; the hub
  daemon owns that connection and fans it out to CLI / VSCode / MCP clients,
  so tools never fight over the game.
- **File-based workspace** — every concept (deck, object, script, UI) maps to
  plain files you can diff, merge and review with standard tools.
- **Contract-driven** — 13 file-format contracts in
  [`docs/schemas/`](docs/schemas/) pin every byte the tool reads or writes;
  unpack → build is byte-identical by design.
- **Phased delivery** — shipped in 7 phases (infrastructure → workspace →
  decks/VCS → assets/publish → hub/MCP → write path → editor → test/publish),
  each phase adding green tests on top of the previous baseline.

## Documentation

- **English**
  - This file (overview)
  - [Contracts](docs/schemas/) — 13 file-format contracts
- **中文**
  - [完整使用文档](docs/zh/usage.md) — 命令参考、协议、错误码、locales 镜像
  - [契约文档](docs/schemas/) — 13 份文件格式契约

## Requirements

- **Node.js ≥ 24.19.0** (pinned in `engines`)
- **Windows** is the primary target (data-dir probing follows Windows conventions)
- **Tabletop Simulator** running with a save loaded (required for live commands
  such as `tts status` / `tts pull` / `tts test` / `tts push`)
- Optional: **kpsteam v1.1.1** for `tts publish --auto`
- Optional: **Git LFS** for binary asset versioning

## Companion: tts-lua-hub VSCode extension

This CLI is designed to work side-by-side with
**[tts-lua-hub](https://github.com/Smirk1921/tts-lua-hub)** — a fork of the
community-standard TTS VSCode extension (`rolandostar/tabletopsimulator-lua`,
inactive since 2023-04) that we maintain. **Replace the official extension with
this fork** to remove the port-39998 conflict and unlock hub-shared workflows.

### Why replace the official extension

The official extension **binds port 39998** directly. The CLI (without the hub)
also binds 39998 for `pack pull/diff` etc. So you used to have to close one to
use the other. The fork introduces a third option: it can connect to a running
`tts-hub` daemon on port **39997** (TCP fan-out) and let the hub own the 39998
connection. Result: CLI, extension, and any MCP-compatible AI agent all share a
single TTS connection — you never close anything.

### Architecture

```
                 ┌──────────────────────────────┐
                 │  Tabletop Simulator (game)   │
                 │   listens on 39998 / 39999   │
                 └──────────────┬───────────────┘
                                │ (single connection)
                       ┌────────┴────────┐
                       │    tts-hub      │     <- long-running daemon (this repo)
                       │  (port 39997)   │
                       └────────┬────────┘
              ┌─────────────────┼─────────────────┐
              │                 │                 │
        ┌─────┴─────┐    ┌──────┴──────┐   ┌──────┴──────┐
        │  tts CLI  │    │ tts-lua-hub │   │  MCP agent  │
        │ (this     │    │  (VSCode    │   │ (ZCode /    │
        │  repo)    │    │  extension) │   │  Claude…)   │
        └───────────┘    └─────────────┘   └─────────────┘
```

Without the hub, both the CLI and the extension can fall back to binding 39998
directly (upstream behavior). With the hub, they coexist.

### Install the fork

**Option A — VSIX from GitHub Releases (recommended for now)**

1. Download `tts-lua-hub-<version>.vsix` from
   [tts-lua-hub Releases](https://github.com/Smirk1921/tts-lua-hub/releases).
2. In VSCode: `Ctrl+Shift+P` → `Extensions: Install from VSIX...` → pick the file.
   Or from a terminal:
   ```bash
   code --install-extension tts-lua-hub-<version>.vsix
   ```
3. **Uninstall or disable the official "Tabletop Simulator Lua" extension**
   (`rolandostar.tabletopsimulator-lua`) — only one of them can be active.

**Option B — VSCode Marketplace (coming soon)**

Once Marketplace registration completes, search for `tts-lua-hub` and install
with one click.

### Configure the fork to use the hub

In VSCode `settings.json` (user or workspace):

```jsonc
{
  "ttslua.hub.host": "127.0.0.1",
  "ttslua.hub.port": 39997,
  "ttslua.hub.fallback": "prompt",       // or "bind" — see below
  "ttslua.hub.reconnectMaxMs": 30000
}
```

| Setting | Values | Effect |
|---|---|---|
| `ttslua.hub.host` / `port` | default `127.0.0.1:39997` | where the hub daemon listens |
| `ttslua.hub.fallback` | `"prompt"` (default) | only connect via hub; status-bar hint when hub offline |
|  | `"bind"` | probe 39998 for 500 ms; if hub unreachable, temporarily bind 39998 like the upstream extension |
| `ttslua.hub.reconnectMaxMs` | default `30000` | max backoff between reconnect attempts |

### End-to-end quick start (CLI + extension together)

```bash
# 1. Terminal: install and build the CLI (this repo)
git clone https://github.com/Smirk1921/tts-toolkit.git
cd tts-toolkit && npm install && npm run build

# 2. Start Tabletop Simulator and load a save (required — TTS only listens
#    on 39998/39999 while a save is loaded)

# 3. Start the hub daemon (keeps running in this terminal)
node dist/cli/hub-main.js
#    or, after npm install -g tts-toolkit:  tts-hub

# 4. VSCode: install the tts-lua-hub fork per the steps above,
#    set ttslua.hub.fallback = "prompt", reload window

# 5. Verify: the extension's status bar shows "Connected to tts-hub";
#    in another terminal you can now run, simultaneously:
node dist/cli/index.js status          # CLI works
node dist/cli/index.js pull --root .   # CLI works, extension stays connected
#    and from VSCode: "TTS: Get Scripts" also works at the same time
```

### When you don't want the hub

Both this CLI and the fork work standalone (they'll each bind 39998 directly
when needed). You just go back to the old rule: close one before using the
other. Set `ttslua.hub.fallback: "bind"` in the extension, or simply don't
start `tts-hub` for the CLI.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文简介

`tts-toolkit` 是一套面向《桌游模拟器》图包作者的命令行工具，通过 TTS 的
**外部编辑器协议**与运行中的游戏通信，同时支持**完全离线**的图包工作区管理。
所有面向用户的输出支持中英文双语。

### 核心特性

- **图包工作区**：`pack unpack / build / pull / push / diff` 把存档 JSON 展开成
  干净文件树，编辑后无字节差重建
- **卡牌图集**：把牌面图切片成 TTS 牌组图集，或反向拼合，支持真实图集的余数吸收
- **Git 版本控制**：语义化 diff、二进制素材走 LFS、上游同步、review 门禁
- **hub 常驻守护 + MCP 集成**：单一 TTS 连接由 hub 持有，CLI / VSCode 插件 /
  MCP AI 代理扇出共享，不再抢 39998
- **Lua 测试运行器**：在仓库里写 `tests/**/*_test.lua`，`tts test` 在游戏内执行
  并返回结构化 RunReport
- **Steam 工坊发布**：`tts build` 产 BSON，`tts publish --auto` 走 kpsteam
  自动上传，`--manual-guide` 给 7 步手工手册

### 快速上手

```bash
npm install
npm run build

# 检测连接
tts status

# 解开存档
tts pack unpack <存档.json> --out my-pack

# 编辑后写回（默认 dry-run，--yes 才实写）
tts pack push --root my-pack --yes

# 在 TTS 内跑 Lua 测试
tts test --root my-pack

# 打包并发布到工坊
tts build -o dist/mod.bson --root my-pack
tts publish --item <工坊ID> --bson dist/mod.bson --auto
```

### 设计要点

- **单一 TTS 连接** —— 39998/39999 端口由 hub 独占并扇出，工具不互斥
- **文件即真相** —— 牌堆 / 对象 / 脚本 / UI 全部映射为可 diff、可合并的纯文件
- **契约驱动** —— [`docs/schemas/`](docs/schemas/) 13 份契约钉死读写格式，
  unpack → build 字节级一致
- **阶段化交付** —— 7 个阶段（基础设施 → 工作区 → 牌堆/VCS → 素材/发布 →
  hub/MCP → 写入路径 → 编辑器 → 测试/发布），2037 用例全绿

### 文档导航

- [完整使用文档](docs/zh/usage.md) — 命令参考、协议细节、错误码表
- [契约文档](docs/schemas/) — 13 份文件格式契约（pack / deck / assets / cards /
  objects / registry / import / host / ttsmod / hub-control / baseline / test-report）

### 环境要求

- Node.js ≥ 24.19.0（`engines` 已钉死）
- Windows 为主要目标平台
- 与游戏通信时需 TTS 正在运行并已加载存档
- 可选：kpsteam v1.1.1（`tts publish --auto`）
- 可选：Git LFS（二进制素材版本化）

### 配套插件：tts-lua-hub（VSCode 扩展）

本 CLI 与我们维护的 VSCode 扩展 fork ——
**[tts-lua-hub](https://github.com/Smirk1921/tts-lua-hub)** —— 配套设计。
上游是 TTS 社区标准插件（`rolandostar.tabletopsimulator-lua`，2023-04 起停滞），
fork 在其基础上加了 **hub 集成**。**建议卸载/禁用官方插件，换装本 fork**，
这样才能与 CLI 同时在线，不再抢 39998 端口。

#### 为什么要换掉官方插件

官方插件会**直接绑 39998**。本 CLI 在独立模式下（`pack pull/diff` 等）
也要绑 39998——所以以前你必须二选一。fork 引入了第三条路：
连上 `tts-hub` 守护进程的 **39997 扇出**端口，由 hub 独占 39998。
结果：CLI、插件、MCP AI 代理同时在线，谁都不必关。

#### 架构

```
                 ┌──────────────────────────────┐
                 │  Tabletop Simulator（游戏）  │
                 │   监听 39998 / 39999         │
                 └──────────────┬───────────────┘
                                │（单一连接）
                       ┌────────┴────────┐
                       │    tts-hub      │     <- 常驻守护进程（本仓库）
                       │  （39997 端口） │
                       └────────┬────────┘
              ┌─────────────────┼─────────────────┐
              │                 │                 │
        ┌─────┴─────┐    ┌──────┴──────┐   ┌──────┴──────┐
        │  tts CLI  │    │ tts-lua-hub │   │  MCP 代理   │
        │（本仓库） │    │（VSCode 插件）│   │（ZCode 等） │
        └───────────┘    └─────────────┘   └─────────────┘
```

无 hub 时，CLI 与插件都退回直接绑 39998（上游行为）；有 hub 时两边并存。

#### 安装 fork

**方式 A — GitHub Releases 下载 .vsix（当前推荐）**

1. 从 [tts-lua-hub Releases](https://github.com/Smirk1921/tts-lua-hub/releases)
   下载 `tts-lua-hub-<版本>.vsix`。
2. VSCode 中 `Ctrl+Shift+P` → `Extensions: Install from VSIX...` → 选择文件；
   或终端执行：
   ```bash
   code --install-extension tts-lua-hub-<版本>.vsix
   ```
3. **卸载或禁用官方「Tabletop Simulator Lua」插件**
   （`rolandostar.tabletopsimulator-lua`）——两者只能启用一个。

**方式 B — VSCode Marketplace（即将上架）**

Marketplace 注册完成后，搜索 `tts-lua-hub` 一键安装。

#### 配置 fork 走 hub

在 VSCode `settings.json`（用户或工作区）加：

```jsonc
{
  "ttslua.hub.host": "127.0.0.1",
  "ttslua.hub.port": 39997,
  "ttslua.hub.fallback": "prompt",       // 或 "bind"，见下表
  "ttslua.hub.reconnectMaxMs": 30000
}
```

| 配置 | 取值 | 含义 |
|---|---|---|
| `ttslua.hub.host` / `port` | 缺省 `127.0.0.1:39997` | hub 守护进程监听地址 |
| `ttslua.hub.fallback` | `"prompt"`（缺省） | 只走 hub；hub 不在线时状态栏提示「请运行 tts-hub」 |
|  | `"bind"` | 探测 39998 500ms；hub 不在线时退回直接绑 39998（上游行为） |
| `ttslua.hub.reconnectMaxMs` | 缺省 `30000` | 断线重连的最长退避毫秒数 |

#### 端到端上手（CLI + 插件同时在线）

```bash
# 1. 终端：装并编译本 CLI
git clone https://github.com/Smirk1921/tts-toolkit.git
cd tts-toolkit && npm install && npm run build

# 2. 启动 TTS 并加载一个存档（必须先做——39998/39999 只在存档加载后监听）

# 3. 启动 hub 守护进程（保持这个终端开着）
node dist/cli/hub-main.js
#    或装全局后：tts-hub

# 4. VSCode：按上面步骤装好 fork，把 ttslua.hub.fallback 设为 "prompt"，
#    然后 Ctrl+Shift+P → Developer: Reload Window

# 5. 验证：插件状态栏显示「Connected to tts-hub」；
#    另开一个终端可以同时跑：
node dist/cli/index.js status          # CLI 能用
node dist/cli/index.js pull --root .   # CLI 拉脚本，插件仍在线
#    VSCode 里同时「TTS: Get Scripts」也能用
```

#### 不想用 hub 时

CLI 与 fork 都能独立工作（各自需要时直接绑 39998）。回到老规则：
用一边前关掉另一边即可。把插件的 `ttslua.hub.fallback` 设为 `"bind"`，
或干脆不启动 `tts-hub`。

### 许可证

MIT — 见 [LICENSE](LICENSE)。
