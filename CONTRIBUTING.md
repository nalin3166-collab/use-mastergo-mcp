# Contributing to `use-mastergo-mcp`

Thank you for your interest in contributing! This project aims to stay lean, fast, and strictly aligned with MasterGo's official Plugin API (`@mastergo/plugin-typings`).

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 10
- **MasterGo Desktop** (for live end-to-end plugin testing)

## Local Setup

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## Monorepo Layout

- `packages/protocol`: Shared WebSocket message types, constants, and JSON/error serializers.
- `packages/mcp-server`: Publishable stdio MCP server (`use-mastergo-mcp`) + local `127.0.0.1` WebSocket bridge + image utilities + Vitest tests.
- `packages/mg-plugin`: MasterGo desktop plugin (`manifest.json`, `src/main.ts`, `src/ui.html`).
- `skills/mastergo-use/SKILL.md`: Verified Agent Skill documenting exact `mg.*` API syntax and best practices.

## Pull Request Guidelines

1. Keep the tool surface minimal—avoid adding redundant atomic tools when a pattern belongs in `skills/mastergo-use/SKILL.md`.
2. Never bind the WebSocket bridge to anything other than `127.0.0.1`.
3. Never write logs to `stdout` inside `packages/mcp-server` (stdout is reserved exclusively for MCP stdio JSON-RPC frames; always use `stderr`).
4. Run `pnpm build`, `pnpm typecheck`, and `pnpm test` before opening a PR.
5. Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`).
