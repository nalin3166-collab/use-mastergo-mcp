# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-11-24

### Fixed
- **MasterGo `postMessage` handshake**: Send direct payloads via `parent.postMessage(msg, '*')` (without Figma's `{ pluginMessage }` wrapper), attach `mg.ui.onmessage` before `mg.showUI()`, and listen with `window.addEventListener('message', ...)`.
- **MasterGo `manifest.json` ID**: Added a valid numeric plugin `id` and updated the plugin build script to preserve existing `dist/manifest.json` IDs across rebuilds.
- **GitHub Actions CI**: Aligned CI matrix to Node 22 & Node 24 LTS for `pnpm@11.25.0` compatibility.

### Docs
- Updated README quickstart steps to match MasterGo Desktop's exact plugin menu (`开发插件 → 创建 / 添加插件`) and added live-verified font/screenshot tips to `skills/mastergo-use/SKILL.md`.

## [0.1.0] - 2026-11-24

### Added
- **Monorepo architecture** (`packages/protocol`, `packages/mcp-server`, `packages/mg-plugin`, `skills/mastergo-use`).
- **4 high-throughput MCP tools**:
  - `mastergo_status`: Inspect bridge connectivity, plugin capabilities (`dynamicEval`), active document, pages, and current selection.
  - `use_mastergo`: Execute async JS scripts directly in the MasterGo plugin main thread with full `mg.*` API access, captured console logs, structured JSON return values, single-step undo (`mg.commitUndo()`), and formatted stack traces on error.
  - `upload_local_images`: Read local PNG/JPG/WebP/GIF files from disk, automatically resize oversized images via `sharp`, and batch upload via `mg.createImage()`.
  - `screenshot_node`: Export any MasterGo node/artboard via `node.exportAsync()`, save to disk, and optionally return the PNG inline for automated visual verification.
- **Local loopback WebSocket bridge** (`ws://127.0.0.1:8787`, configurable via `--port` or `MASTERGO_BRIDGE_PORT`) with strict `requestId` correlation, configurable timeouts, and heartbeat monitoring.
- **MasterGo desktop bridge plugin** with auto-reconnecting status UI panel and activity log.
- **Verified Agent Skill** (`skills/mastergo-use/SKILL.md`) aligned with `@mastergo/plugin-typings` v2.19.5.
- **Unit & end-to-end Vitest test suite**, bilingual READMEs (`README.md` / `README.zh-CN.md`), and GitHub Actions CI.
