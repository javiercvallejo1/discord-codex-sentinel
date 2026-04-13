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
3. Initialize state:
   - `bun run src/index.ts install`
4. Ask the human for their Discord user ID and set it:
   - `bun run src/index.ts config owner <DISCORD_USER_ID>`
5. Ask for the default project directory and set it:
   - `bun run src/index.ts config project <ABSOLUTE_PATH>`
6. For each Discord bot they want to use:
   - ask for bot name
   - ask for bot token
   - ask for project path if it differs from the default
   - run `bun run src/index.ts bot add <name> <token> [project]`
7. Install launchd autostart:
   - `./scripts/install-daemon.sh`
8. Confirm with:
   - `bun run src/index.ts daemon status`
   - `bun run src/index.ts bot list`

Keep the setup conversational and optimized for a non-technical user. Explain each risky or confusing step in one short sentence.

