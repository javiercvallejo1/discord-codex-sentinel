import { homedir } from "node:os"
import { join } from "node:path"

export const STATE_ROOT = join(homedir(), ".codex", "discord-sentinel")
export const BOTS_FILE = join(STATE_ROOT, "bots.json")
export const PERSONALITIES_DIR = join(STATE_ROOT, "personalities")
export const SESSION_STATE_DIR = join(STATE_ROOT, "state")
export const LOGS_DIR = join(STATE_ROOT, "logs")

export function getPersonalityPath(botName: string) {
  return join(PERSONALITIES_DIR, `${botName}.md`)
}

export function getSessionStatePath(botName: string) {
  return join(SESSION_STATE_DIR, `${botName}.json`)
}

