---
name: manage-discord-sentinel
description: Operate or troubleshoot a Discord Codex Sentinel install for a normal end user.
---

Use this skill when the human wants help with day-2 operations.

Prefer MCP tools when they are available:

- `discord_sentinel_daemon_status`
- `discord_sentinel_daemon_logs`
- `discord_sentinel_list_bots`
- `discord_sentinel_add_bot`
- `discord_sentinel_remove_bot`
- `discord_sentinel_reset_thread`
- `discord_sentinel_get_personality`
- `discord_sentinel_set_personality`
- `discord_sentinel_get_memory`
- `discord_sentinel_set_memory`
- `discord_sentinel_add_memory_note`
- `discord_sentinel_get_memory_journal`

CLI fallbacks:

- `bun run src/index.ts daemon status`
- `bun run src/index.ts daemon logs`
- `bun run src/index.ts bot list`
- `bun run src/index.ts bot add <name> <token> [project]`
- `bun run src/index.ts bot remove <name>`
- `bun run src/index.ts thread reset <name>`

Keep explanations short. Prefer doing the operation directly when it is safe.
