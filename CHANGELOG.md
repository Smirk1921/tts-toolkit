# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Phase tags (`v0.x.0-phaseN`) are annotated on the corresponding commits for
> historical reference; the npm-published version drops the `-phaseN` suffix.

## [0.7.0] - 2026-10-06 — Phase 7: Lua test runner + Workshop publish

### Added

- **`tts test` Lua test runner** (`src/test/`):
  - Mixed discovery: default glob `tests/**/*_test.lua` plus optional override
    via `tests:` section in `pack.yaml`.
  - Assertion library written in pure Lua (compatible with TTS Lua restrictions:
    no `require`, no `debug` library, string-only `error()`).
  - Standalone and hub-delegated execution modes; identical results either way.
  - Structured `RunReport` JSON written to disk.
- **`tts build`** (`src/publish/bson.ts`):
  - Generate Steam Workshop BSON payload from a pack workspace, with header
    self-check and round-trip deserialize validation.
- **`tts publish`** (`src/publish/`):
  - `--check <item_id>`: query Steam API for item visibility / state.
  - `--manual-guide`: print 7-step manual Workshop upload instructions and copy
    to clipboard.
  - `--auto`: invoke kpsteam v1.1.1 subprocess for automated upload (verified
    against the 2026 Steam client).
- **MCP tools**: `tts_test_run` and `tts_pack_build` exposed via the MCP server.
- **Hub routes**: 12 → 14 (added test/build dispatch).
- **Contracts**: added `test-report.json.md` (13 total).

### Test baseline

- 2037 unit tests passing, 69 skipped, 0 failed.
- 8 TTS Lua environment compatibility bugs fixed during Stage D real-game runs.

## [0.6.0] - 2026-10-06 — Phase 6: Editor integration

### Added

- **6A — Lightweight editor adapter** (`src/editor/`):
  - `tts edit` command, preset resolution, file-locate and file-resolve helpers.
  - 5 modules with full i18n.
- **6B — VSCode extension protocol adapter** ([tts-lua-hub](https://github.com/Smirk1921/tts-lua-hub) fork):
  - New `src/transport/` layer: `ITransport` interface, `JsonStreamDecoder`,
    `ClientTransport` (connects to hub 39997), `ConnectionStateMachine`
    (4-state + exponential backoff), `ServerTransport` (upstream behavior preserved).
  - `TTSAdapter` refactored to depend on `ITransport`; no longer binds 39998
    when hub is available.
  - Dual-mode fallback: `ttslua.hub.fallback: "prompt" | "bind"`.
  - `api.json` upgraded 13.2.1.1 → 14.0.3.2.
  - `_lastSentScripts` persisted with sha256 checksum.
  - Support for dots in object names via regex `/^(.+)\.([^.]+)\.lua$/`.

## [0.5.0] - 2026-10-05 — Phase 5: Write path

### Added

- **`tts pack push`** — full pipeline with safety: dry-run by default, `--yes`
  to actually write; pre-flight checks, atomic write, rollback on failure.
- **`tts watch`** — file-watcher mode powered by chokidar v4.
- **Safety layer** (`src/safety/`): three modules for confirmation, diff review,
  and guarded execution.
- Hub control schema synchronized across four parties (hub / CLI / MCP / VSCode ext).

### Fixed

- Error-code i18n gaps and unified diff format surfaced in Stage 4 acceptance.

## [0.4.0] - 2026-10-05 — Phase 4: Hub daemon + MCP server

### Added

- **`tts hub`** — long-running daemon (`src/hub/`): fanout, daemon lifecycle,
  control channel, and `tts-hub` CLI entry.
- **MCP integration** (`src/mcp/`):
  - 10 MCP tools (status / exec / pull / diff / assets / push / deck_slice /
    deck_plan / import / pack_list).
  - MCP client + server modules with 110 unit tests.
- CLI commands can delegate to the hub when it's running.
- New contract: `hub-control.md`.

### Fixed

- Port-39998 double-bind issue when hub and CLI both tried to pull/diff.

## [0.3.0] - 2026-10-05 — Phase 3: Assets, hosting, packaging

### Added

- **Asset import** (`src/import/`): bring external images/models into a pack,
  with deduplication and YAML manifest (`import.yaml`).
- **Image hosts** (`src/host/`): built-in `steamcloud`, four command types,
  and a JS-plugin directory for custom hosts.
- **Fetch + migrate** commands for syncing upstream asset URLs.
- **Pack export / import**: `.ttsmod` write path and Steam Workshop file layout.
- **Sync-upstream** and **review gate** modules for multi-contributor workflows.
- Contracts: `import.yaml.md`, `host.md`, `objects.csv.md` (9 total).

## [0.2.0] - 2026-10-04 — Phase 2: Pack workspace, deck atlases, VCS

### Added

- **2A — Pack workspace** (`src/pack/`): unpack a TTS save into a file-based
  workspace (decks, objects, scripts, UI) and rebuild it byte-identically.
- **2B — Deck atlases** (`src/deck/`):
  - Slice an atlas into individual card images; stitch cards back into an atlas.
  - Remainder absorption for real TTS atlases with non-uniform grids.
  - `cards.csv` replaces inline `cards[]` in `deck.yaml` for diff-friendly editing.
- **2C — Multi-pack + version control** (`src/vcs/`):
  - 7 vcs modules: registry, git plumbing, semantic diff, conflicts, size, verify,
    commit.
  - Pack registry (`pack list / status / open`).
  - Merge-conflict semantics that can trace a `UU` line back to a specific row
    in `cards.csv`.
- Contracts: `pack.yaml.md`, `deck.yaml.md`, `cards.csv.md`, `assets.yaml.md`,
  `baseline.json.md`, `registry.yaml.md`.

## [0.1.0] - 2026-10-04 — Phase 1: Infrastructure

### Added

- **Data directory probing** (`src/datadir/`): locate TTS install + Mods folders.
- **External-editor protocol client** (`src/protocol/`): port 39998/39999
  lifecycle, message framing, error mapping.
- **Read-only CLI**: `tts status`, `tts exec`, `tts pull`, `tts assets`,
  `tts config datadir`.
- **i18n** (zh-CN / en) with key-mirror guarantee across locales.
- Integration test suite skeleton (10 scenarios).

[0.7.0]: https://github.com/Smirk1921/tts-toolkit/releases/tag/v0.7.0
[0.6.0]: https://github.com/Smirk1921/tts-toolkit/releases/tag/v0.6.0-phase6
[0.5.0]: https://github.com/Smirk1921/tts-toolkit/releases/tag/v0.5.0-phase5
[0.4.0]: https://github.com/Smirk1921/tts-toolkit/releases/tag/v0.4.0-phase4
[0.3.0]: https://github.com/Smirk1921/tts-toolkit/releases/tag/v0.3.0-phase3
[0.2.0]: https://github.com/Smirk1921/tts-toolkit/releases/tag/v0.2.0-phase2
[0.1.0]: https://github.com/Smirk1921/tts-toolkit/releases/tag/v0.1.0-phase1
