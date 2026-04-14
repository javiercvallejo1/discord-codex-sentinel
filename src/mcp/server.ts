import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import * as z from "zod/v4"
import { DiscordCodexSentinelService } from "../daemon/service"
import {
  appendMemoryNote,
  listNamedBots,
  readBotSessionState,
  readMemory,
  readMemoryJournal,
  readPersonality,
  readRegistry,
  writeMemory,
  writePersonality,
} from "../state/store"

const execFileAsync = promisify(execFile)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

function textResult(value: unknown) {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2)

  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
  }
}

async function assertBotExists(name: string) {
  const registry = await readRegistry()
  if (!registry.bots[name]) {
    throw new Error(`Bot '${name}' not found`)
  }
}

export async function startMcpServer() {
  const service = new DiscordCodexSentinelService(process.env.CODEX_BIN ?? "codex")
  const server = new McpServer({
    name: "discord-codex-sentinel",
    version: "0.1.0",
  })

  server.registerTool(
    "discord_sentinel_install_state",
    {
      description: "Initialize the local Discord Codex Sentinel state directory under ~/.codex/discord-sentinel.",
      inputSchema: {},
    },
    async () => {
      await service.install()
      return textResult("Initialized ~/.codex/discord-sentinel/")
    },
  )

  server.registerTool(
    "discord_sentinel_set_owner",
    {
      description: "Set the Discord user ID that is allowed to drive all configured bots.",
      inputSchema: {
        owner_id: z.string().min(1).describe("Discord user ID to allow"),
      },
    },
    async ({ owner_id }) => {
      await service.setOwnerId(owner_id)
      return textResult(`Configured owner_id '${owner_id}'`)
    },
  )

  server.registerTool(
    "discord_sentinel_set_default_project",
    {
      description: "Set the default absolute project path used for bots that do not override their project.",
      inputSchema: {
        project: z.string().min(1).describe("Absolute path to the default project"),
      },
    },
    async ({ project }) => {
      await service.setDefaultProject(project)
      return textResult(`Configured default project '${project}'`)
    },
  )

  server.registerTool(
    "discord_sentinel_add_bot",
    {
      description: "Add a Discord bot token and create its default personality and durable memory files.",
      inputSchema: {
        name: z.string().min(1).describe("Short stable bot name"),
        token: z.string().min(1).describe("Discord bot token"),
        project: z.string().optional().describe("Optional absolute project path for this bot"),
      },
    },
    async ({ name, token, project }) => {
      await service.addBotFromCli(name, token, project)
      return textResult(`Added bot '${name}'`)
    },
  )

  server.registerTool(
    "discord_sentinel_list_bots",
    {
      description: "List configured bots with their project, thread ID, and last known status.",
      inputSchema: {},
    },
    async () => {
      const registry = await readRegistry()
      const entries = await Promise.all(
        listNamedBots(registry.bots).map(async bot => {
          const session = await readBotSessionState(bot.name)
          return {
            name: bot.name,
            label: bot.config.label,
            project: bot.config.project ?? registry.config.default_project,
            status: session.last_status,
            thread_id: session.thread_id,
          }
        }),
      )
      return textResult({
        owner_id: registry.config.owner_id,
        default_project: registry.config.default_project,
        bots: entries,
      })
    },
  )

  server.registerTool(
    "discord_sentinel_remove_bot",
    {
      description: "Remove a configured Discord bot and delete its local personality, memory, and thread state files.",
      inputSchema: {
        name: z.string().min(1).describe("Bot name to remove"),
      },
    },
    async ({ name }) => {
      await service.removeBotFromCli(name)
      return textResult(`Removed bot '${name}'`)
    },
  )

  server.registerTool(
    "discord_sentinel_reset_thread",
    {
      description: "Archive the current Codex thread for a bot so the next Discord message starts fresh.",
      inputSchema: {
        name: z.string().min(1).describe("Bot name"),
      },
    },
    async ({ name }) => {
      await service.resetThreadForCli(name)
      return textResult(`Reset thread for '${name}'`)
    },
  )

  server.registerTool(
    "discord_sentinel_get_personality",
    {
      description: "Read the saved per-bot personality instructions.",
      inputSchema: {
        name: z.string().min(1).describe("Bot name"),
      },
    },
    async ({ name }) => {
      await assertBotExists(name)
      return textResult(await readPersonality(name))
    },
  )

  server.registerTool(
    "discord_sentinel_set_personality",
    {
      description: "Replace the saved per-bot personality instructions.",
      inputSchema: {
        name: z.string().min(1).describe("Bot name"),
        text: z.string().min(1).describe("Full personality markdown"),
      },
    },
    async ({ name, text }) => {
      await assertBotExists(name)
      await writePersonality(name, text)
      return textResult(`Updated personality for '${name}'`)
    },
  )

  server.registerTool(
    "discord_sentinel_get_memory",
    {
      description: "Read the durable memory summary for a bot.",
      inputSchema: {
        name: z.string().min(1).describe("Bot name"),
      },
    },
    async ({ name }) => {
      await assertBotExists(name)
      return textResult(await readMemory(name))
    },
  )

  server.registerTool(
    "discord_sentinel_set_memory",
    {
      description: "Replace the durable memory summary for a bot.",
      inputSchema: {
        name: z.string().min(1).describe("Bot name"),
        text: z.string().min(1).describe("Full durable memory markdown"),
      },
    },
    async ({ name, text }) => {
      await assertBotExists(name)
      await writeMemory(name, text)
      return textResult(`Updated durable memory for '${name}'`)
    },
  )

  server.registerTool(
    "discord_sentinel_add_memory_note",
    {
      description: "Append one short stable fact or preference to a bot's durable memory file.",
      inputSchema: {
        name: z.string().min(1).describe("Bot name"),
        note: z.string().min(1).describe("Short memory note"),
      },
    },
    async ({ name, note }) => {
      await assertBotExists(name)
      const next = await appendMemoryNote(name, note)
      return textResult(next)
    },
  )

  server.registerTool(
    "discord_sentinel_get_memory_journal",
    {
      description: "Read the conversation journal captured from completed Discord turns.",
      inputSchema: {
        name: z.string().min(1).describe("Bot name"),
        max_chars: z.number().int().positive().max(20000).optional().describe("Optional maximum number of trailing characters to return"),
      },
    },
    async ({ name, max_chars }) => {
      await assertBotExists(name)
      const journal = await readMemoryJournal(name)
      const text = max_chars ? journal.slice(-max_chars) : journal
      return textResult(text || "(empty)")
    },
  )

  server.registerTool(
    "discord_sentinel_daemon_status",
    {
      description: "Read the configured owner, bots, thread IDs, and last known bot statuses.",
      inputSchema: {},
    },
    async () => {
      return textResult(await service.daemonStatusForCli())
    },
  )

  server.registerTool(
    "discord_sentinel_daemon_logs",
    {
      description: "Read the latest daemon log lines.",
      inputSchema: {
        lines: z.number().int().positive().max(400).optional().describe("Number of log lines to return"),
      },
    },
    async ({ lines }) => {
      const content = await service.daemonLogsForCli(lines)
      return textResult(content || "(no logs)")
    },
  )

  server.registerTool(
    "discord_sentinel_install_launch_agent",
    {
      description: "Install and load the macOS LaunchAgent so Discord Codex Sentinel starts automatically.",
      inputSchema: {},
    },
    async () => {
      const result = await execFileAsync(resolve(REPO_ROOT, "scripts", "install-daemon.sh"), [], {
        cwd: REPO_ROOT,
      })
      return textResult(result.stdout || "Installed launch agent.")
    },
  )

  server.registerTool(
    "discord_sentinel_uninstall_launch_agent",
    {
      description: "Unload and remove the macOS LaunchAgent for Discord Codex Sentinel.",
      inputSchema: {},
    },
    async () => {
      const result = await execFileAsync(resolve(REPO_ROOT, "scripts", "uninstall-daemon.sh"), [], {
        cwd: REPO_ROOT,
      })
      return textResult(result.stdout || "Removed launch agent.")
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
