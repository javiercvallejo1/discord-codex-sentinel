# Discord Codex Sentinel

`discord-codex-sentinel` turns one or more Discord bots into trusted front doors for the local Codex runtime. Each bot is tied to a project, keeps a persistent Codex thread, and relays Codex approvals back to Discord instead of relying on a terminal session.

## What It Includes

- A Bun daemon that supervises `codex app-server`
- One Discord client per configured bot token
- Persistent per-bot Codex threads and local runtime state
- Durable per-bot memory summaries and turn journals
- Discord approval buttons for command execution and file changes
- A bundled Codex plugin plus MCP server for Codex-native install and management flows

## Requirements

- macOS
- [Bun](https://bun.sh)
- [Codex CLI](https://developers.openai.com/codex)
- Discord bot tokens

## Easy Setup

The intended setup path is to use the bundled Codex plugin as the operator surface. The plugin can guide install, ask for the Discord owner ID, add bots, and point Codex at the daemon commands in this repo.

If you want to install the local plugin marketplace into your Codex home first:

```bash
./scripts/install-local-plugin.sh
```

That installer writes a home-local plugin copy and stamps it with the absolute repo path so the plugin's MCP tools can call this repo directly.

Before using the MCP-backed plugin tools, install repo dependencies once:

```bash
bun install
./scripts/install-local-plugin.sh
```

Then, inside Codex, install the local `discord-codex-assistant` plugin and use its install skill to guide setup.

## Quick Start

```bash
bun install
bun run src/index.ts install
bun run src/index.ts config owner YOUR_DISCORD_USER_ID
bun run src/index.ts config project /absolute/default/project/path
bun run src/index.ts bot add my-bot DISCORD_TOKEN /absolute/project/path
bun run src/index.ts daemon start
```

Useful commands:

```bash
bun run src/index.ts bot list
bun run src/index.ts config owner YOUR_DISCORD_USER_ID
bun run src/index.ts config project /absolute/default/project/path
bun run src/index.ts thread reset my-bot
bun run src/index.ts daemon status
bun run src/index.ts daemon logs
bun run src/index.ts mcp serve
```

## Runtime State

State lives in `~/.codex/discord-sentinel/`:

- `bots.json`
- `personalities/<bot>.md`
- `memory/<bot>.md`
- `memory-journal/<bot>.md`
- `state/<bot>.json`
- `logs/`

## Bundled Codex Plugin

This repo also includes a local Codex plugin marketplace at `.agents/plugins/marketplace.json` and a plugin bundle at `plugins/discord-codex-assistant/`.

That plugin does not replace the daemon. It packages Codex-side guidance, reusable skills, and an MCP bridge so Codex can install and manage the Discord setup with much less manual terminal work.

## Launchd

To install the daemon as a LaunchAgent:

```bash
./scripts/install-daemon.sh
```

To uninstall it:

```bash
./scripts/uninstall-daemon.sh
```
