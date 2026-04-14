import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { resolve } from "node:path"
import {
  BOTS_FILE,
  getMemoryJournalPath,
  getMemoryPath,
  getPersonalityPath,
  getSessionStatePath,
  LOGS_DIR,
  MEMORY_DIR,
  MEMORY_JOURNAL_DIR,
  PERSONALITIES_DIR,
  SESSION_STATE_DIR,
  STATE_ROOT,
} from "./paths"
import {
  botSessionStateSchema,
  DEFAULT_MEMORY,
  DEFAULT_PERSONALITY,
  type BotConfig,
  type BotSessionState,
  type NamedBot,
  type RegistryConfig,
  registryConfigSchema,
  registrySchema,
} from "./types"

export async function ensureStateDirs() {
  await Promise.all([
    mkdir(STATE_ROOT, { recursive: true }),
    mkdir(PERSONALITIES_DIR, { recursive: true }),
    mkdir(SESSION_STATE_DIR, { recursive: true }),
    mkdir(MEMORY_DIR, { recursive: true }),
    mkdir(MEMORY_JOURNAL_DIR, { recursive: true }),
    mkdir(LOGS_DIR, { recursive: true }),
  ])
}

export async function readRegistry() {
  await ensureStateDirs()

  try {
    const raw = await readFile(BOTS_FILE, "utf8")
    return normalizeRegistry(JSON.parse(raw))
  } catch {
    const fresh = normalizeRegistry({})
    await writeRegistry(fresh.config, fresh.bots)
    return fresh
  }
}

export async function writeRegistry(
  config: RegistryConfig,
  bots: Record<string, BotConfig>,
) {
  await ensureStateDirs()
  const payload = JSON.stringify({ _config: config, ...bots }, null, 2)
  await writeFile(BOTS_FILE, `${payload}\n`, "utf8")
}

export async function addBot(
  name: string,
  config: BotConfig,
  personality?: string,
) {
  const current = await readRegistry()
  if (current.bots[name]) {
    throw new Error(`Bot '${name}' already exists`)
  }

  current.bots[name] = config
  await writeRegistry(current.config, current.bots)

  const personalityText = (personality?.trim() || DEFAULT_PERSONALITY).trim()
  await writeFile(getPersonalityPath(name), `${personalityText}\n`, "utf8")
  await writeFile(getMemoryPath(name), `${DEFAULT_MEMORY.trim()}\n`, "utf8")
  await writeFile(getMemoryJournalPath(name), "", "utf8")

  return current
}

export async function removeBot(name: string) {
  const current = await readRegistry()
  if (!current.bots[name]) {
    throw new Error(`Bot '${name}' not found`)
  }

  delete current.bots[name]
  await writeRegistry(current.config, current.bots)
  await Promise.all([
    rm(getSessionStatePath(name), { force: true }),
    rm(getPersonalityPath(name), { force: true }),
    rm(getMemoryPath(name), { force: true }),
    rm(getMemoryJournalPath(name), { force: true }),
  ])
}

export async function updateRegistryConfig(
  updater: (config: RegistryConfig) => RegistryConfig,
) {
  const current = await readRegistry()
  current.config = updater(current.config)
  await writeRegistry(current.config, current.bots)
  return current
}

export async function readPersonality(botName: string) {
  await ensureStateDirs()
  const path = getPersonalityPath(botName)

  try {
    return await readFile(path, "utf8")
  } catch {
    await writeFile(path, `${DEFAULT_PERSONALITY.trim()}\n`, "utf8")
    return `${DEFAULT_PERSONALITY.trim()}\n`
  }
}

export async function writePersonality(botName: string, text: string) {
  await ensureStateDirs()
  await writeFile(getPersonalityPath(botName), `${text.trim()}\n`, "utf8")
}

export async function readMemory(botName: string) {
  await ensureStateDirs()
  const path = getMemoryPath(botName)

  try {
    return await readFile(path, "utf8")
  } catch {
    await writeFile(path, `${DEFAULT_MEMORY.trim()}\n`, "utf8")
    return `${DEFAULT_MEMORY.trim()}\n`
  }
}

export async function writeMemory(botName: string, text: string) {
  await ensureStateDirs()
  await writeFile(getMemoryPath(botName), `${text.trim()}\n`, "utf8")
}

export async function appendMemoryNote(botName: string, note: string) {
  await ensureStateDirs()
  const current = await readMemory(botName)
  const trimmed = note.trim()
  if (!trimmed) return current
  const next = `${current.trim()}\n\n- ${trimmed}\n`
  await writeMemory(botName, next)
  return next
}

export async function readMemoryJournal(botName: string) {
  await ensureStateDirs()
  const path = getMemoryJournalPath(botName)

  try {
    return await readFile(path, "utf8")
  } catch {
    await writeFile(path, "", "utf8")
    return ""
  }
}

export async function appendMemoryJournal(
  botName: string,
  entry: {
    user: string
    assistant: string
  },
) {
  await ensureStateDirs()
  const path = getMemoryJournalPath(botName)
  const ts = new Date().toISOString()
  const block = [
    `## ${ts}`,
    "",
    "### User",
    entry.user.trim() || "(empty)",
    "",
    "### Assistant",
    entry.assistant.trim() || "(empty)",
    "",
  ].join("\n")
  const current = await readMemoryJournal(botName)
  const next = current ? `${current.trimEnd()}\n\n${block}` : block
  await writeFile(path, next, "utf8")
  return next
}

export async function readBotSessionState(botName: string): Promise<BotSessionState> {
  await ensureStateDirs()
  const path = getSessionStatePath(botName)

  try {
    const raw = await readFile(path, "utf8")
    return botSessionStateSchema.parse(JSON.parse(raw))
  } catch {
    const fresh = botSessionStateSchema.parse({})
    await writeBotSessionState(botName, fresh)
    return fresh
  }
}

export async function writeBotSessionState(botName: string, state: BotSessionState) {
  await ensureStateDirs()
  const next = botSessionStateSchema.parse({
    ...state,
    updated_at: new Date().toISOString(),
  })
  await writeFile(getSessionStatePath(botName), `${JSON.stringify(next, null, 2)}\n`, "utf8")
}

export async function clearBotSessionState(botName: string) {
  await rm(getSessionStatePath(botName), { force: true })
}

export function resolveProjectPath(project: string) {
  return resolve(project)
}

function normalizeRegistry(input: unknown) {
  const candidate =
    input && typeof input === "object"
      ? { _config: registryConfigSchema.parse((input as { _config?: unknown })._config ?? {}), ...input }
      : { _config: registryConfigSchema.parse({}) }
  const parsed = registrySchema.parse(candidate)
  const { _config, ...rest } = parsed
  const bots = Object.entries(rest)
    .sort(([left], [right]) => left.localeCompare(right))
    .reduce<Record<string, BotConfig>>((acc, [name, bot]) => {
      acc[name] = bot
      return acc
    }, {})

  return { config: _config, bots }
}

export function listNamedBots(bots: Record<string, BotConfig>): NamedBot[] {
  return Object.entries(bots)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, config]) => ({ name, config }))
}
