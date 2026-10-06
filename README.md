# tts-toolkit

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
- Recommended: close the official TTS VSCode extension while using the CLI
  (both bind port 39998); the [tts-lua-hub](https://github.com/Smirk1921/tts-lua-hub)
  fork removes this conflict via the hub daemon.

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
- 建议：使用 CLI 时关闭官方 TTS VSCode 插件（端口互斥）；
  或换用 [tts-lua-hub](https://github.com/Smirk1921/tts-lua-hub) fork，通过 hub 消除冲突

### 许可证

MIT — 见 [LICENSE](LICENSE)。
