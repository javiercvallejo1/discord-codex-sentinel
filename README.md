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

## Installation

Technical installation steps are documented in [INSTALL.md](/Users/francisco/Documents/discord-codex-sentinel/INSTALL.md).

## Easy Setup

The intended setup path is to use the bundled Codex plugin as the operator surface. The plugin can guide install, ask for the Discord owner ID, add bots, and point Codex at the daemon commands in this repo.

Register the plugin in your personal Codex marketplace with one command:

```bash
./scripts/bootstrap-personal-marketplace.sh
```

That bootstrap script follows the Codex personal-marketplace layout from the plugin docs:
- installs the plugin into `~/.codex/plugins/discord-codex-assistant`
- writes or updates `~/.agents/plugins/marketplace.json`
- runs `bun install`
- stamps the plugin copy with this repo path so its MCP server can call back into the repo

Then:
1. Restart Codex.
2. Open `Plugins` in the app, or run `codex` then `/plugins` in the CLI.
3. Choose the `Personal Plugins` marketplace.
4. Open `discord-codex-assistant` and select `Install`.
5. Start a new thread and use the plugin's install skill to finish Discord setup.

`./scripts/install-local-plugin.sh` remains as a compatibility wrapper and now calls the same bootstrap flow.

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

That repo marketplace is for development and testing inside the repo. The recommended user-facing path is: register the plugin in the personal marketplace, then install it from `Plugins` or `/plugins` inside Codex.

## Launchd

To install the daemon as a LaunchAgent:

```bash
./scripts/install-daemon.sh
```

To uninstall it:

```bash
./scripts/uninstall-daemon.sh
```
