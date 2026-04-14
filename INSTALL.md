# Installation

This guide is for a technical user installing `discord-codex-sentinel` on their own machine.

## Scope

Current assumptions:

- macOS
- local `codex` CLI installed and working
- local `bun` installed and working
- one Discord account will own and drive the bots
- one or more Discord bot tokens already created

## 1. Install prerequisites

Verify the required tools are available:

```bash
bun --version
codex --version
```

If either command fails, install that dependency first before continuing.

## 2. Create Discord bot token(s)

For each bot you want to run:

1. Create an application in the Discord Developer Portal.
2. Create a bot user for that application.
3. Copy the bot token.
4. Enable the permissions and intents your bot needs for direct messages.

This project uses direct messages, so keep the bot setup minimal. You do not need guild automation for the normal workflow.

## 3. Clone the repo

```bash
git clone https://github.com/javiercvallejo1/discord-codex-sentinel.git
cd discord-codex-sentinel
```

## 4. Register the plugin in Codex

Run the bootstrap script:

```bash
./scripts/bootstrap-personal-marketplace.sh
```

This script:

- runs `bun install`
- copies the plugin to `~/.codex/plugins/discord-codex-assistant`
- writes or updates `~/.agents/plugins/marketplace.json`
- writes a plugin-local `.mcp.json` that points back to this repo

After the script completes:

1. Restart Codex.
2. Open `Plugins` in the app, or run `codex` and then `/plugins` in the CLI.
3. Choose the `Personal Plugins` marketplace.
4. Open `discord-codex-assistant`.
5. Select `Install`.

The bootstrap script only registers the plugin source. The actual plugin installation happens inside Codex.

## 5. Configure the sentinel

You can finish setup either through the plugin skill inside Codex or directly through the CLI.

### Plugin-driven setup

Start a new Codex thread after installing the plugin and ask it to install or configure Discord Codex Sentinel. The bundled install skill will guide:

- state initialization
- owner ID configuration
- default project path
- bot registration
- launch agent installation

### Direct CLI setup

If you want to configure it manually:

```bash
bun run src/index.ts install
bun run src/index.ts config owner YOUR_DISCORD_USER_ID
bun run src/index.ts config project /absolute/default/project/path
bun run src/index.ts bot add my-bot DISCORD_TOKEN /absolute/project/path
```

Repeat `bot add` for each bot.

## 6. Start the daemon

For a foreground test run:

```bash
bun run src/index.ts daemon start
```

For background startup on login:

```bash
./scripts/install-daemon.sh
```

That installs `~/Library/LaunchAgents/com.codex.discord-sentinel.plist`.

## 7. Verify the install

Check configured bots:

```bash
bun run src/index.ts bot list
```

Check daemon state:

```bash
bun run src/index.ts daemon status
```

Read recent logs:

```bash
bun run src/index.ts daemon logs
```

Expected state:

- `owner_id` is set
- each bot appears in `bot list`
- the daemon can start without crashing
- a DM to the bot from the configured owner produces a Codex reply

## Runtime files

Sentinel state lives under `~/.codex/discord-sentinel/`:

- `bots.json`
- `personalities/<bot>.md`
- `memory/<bot>.md`
- `memory-journal/<bot>.md`
- `state/<bot>.json`
- `logs/`

## Updates

If you pull new changes from the repo, refresh the registered plugin source:

```bash
git pull
./scripts/bootstrap-personal-marketplace.sh
```

Then restart Codex and, if needed, reinstall or refresh the plugin from `Plugins`.

## Uninstall

Remove the launch agent:

```bash
./scripts/uninstall-daemon.sh
```

If you also want to remove the local plugin source, delete:

- `~/.codex/plugins/discord-codex-assistant`
- the `discord-codex-assistant` entry from `~/.agents/plugins/marketplace.json`

If you want to remove all sentinel runtime state as well, delete:

- `~/.codex/discord-sentinel/`

## Troubleshooting

If the plugin does not appear in Codex:

- rerun `./scripts/bootstrap-personal-marketplace.sh`
- verify `~/.agents/plugins/marketplace.json` contains `discord-codex-assistant`
- restart Codex

If the daemon starts but the bot does not answer:

- verify the Discord token is correct
- verify you set the right Discord owner ID
- check `bun run src/index.ts daemon logs`

If Codex can see the plugin but MCP-backed actions fail:

- verify the repo still exists at the path where you originally bootstrapped it
- rerun `./scripts/bootstrap-personal-marketplace.sh` after moving the repo

