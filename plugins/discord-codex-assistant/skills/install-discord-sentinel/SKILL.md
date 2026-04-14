---
name: install-discord-sentinel
description: Guide a human through installing and configuring Discord Codex Sentinel with minimal terminal work.
---

Use this skill when the user wants to set up Discord Codex Sentinel.

Workflow:

1. Check prerequisites:
   - `which bun`
   - `which codex`
2. Install project dependencies:
   - `bun install`
3. If the plugin MCP tools are available, prefer them for setup:
   - `discord_sentinel_install_state`
   - `discord_sentinel_set_owner`
   - `discord_sentinel_set_default_project`
   - `discord_sentinel_add_bot`
   - `discord_sentinel_install_launch_agent`
4. If MCP is not available yet, fall back to CLI:
   - `bun run src/index.ts install`
   - `bun run src/index.ts config owner <DISCORD_USER_ID>`
   - `bun run src/index.ts config project <ABSOLUTE_PATH>`
5. For each Discord bot they want to use:
   - ask for bot name
   - ask for bot token
   - ask for project path if it differs from the default
   - use `discord_sentinel_add_bot` when MCP is available
   - otherwise run `bun run src/index.ts bot add <name> <token> [project]`
6. Install launchd autostart:
   - use `discord_sentinel_install_launch_agent` when MCP is available
   - otherwise run `./scripts/install-daemon.sh`
7. Confirm with:
   - `discord_sentinel_daemon_status`
   - `discord_sentinel_list_bots`
   - or the CLI fallbacks `bun run src/index.ts daemon status` and `bun run src/index.ts bot list`

Keep the setup conversational and optimized for a non-technical user. Explain each risky or confusing step in one short sentence.
