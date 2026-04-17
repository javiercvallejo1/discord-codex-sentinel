import { homedir } from "node:os"
import { join } from "node:path"

export const STATE_ROOT = join(homedir(), ".codex", "discord-sentinel")
export const BOTS_FILE = join(STATE_ROOT, "bots.json")
export const PERSONALITIES_DIR = join(STATE_ROOT, "personalities")
export const SESSION_STATE_DIR = join(STATE_ROOT, "state")
export const MEMORY_DIR = join(STATE_ROOT, "memory")
export const MEMORY_JOURNAL_DIR = join(STATE_ROOT, "memory-journal")
export const JOBS_DIR = join(STATE_ROOT, "jobs")
export const QUEUES_DIR = join(STATE_ROOT, "queues")
export const LOGS_DIR = join(STATE_ROOT, "logs")

export function getPersonalityPath(botName: string) {
  return join(PERSONALITIES_DIR, `${botName}.md`)
}

export function getSessionStatePath(botName: string) {
  return join(SESSION_STATE_DIR, `${botName}.json`)
}

export function getMemoryPath(botName: string) {
  return join(MEMORY_DIR, `${botName}.md`)
}

export function getMemoryJournalPath(botName: string) {
  return join(MEMORY_JOURNAL_DIR, `${botName}.md`)
}

export function getJobPath(jobId: string) {
  return join(JOBS_DIR, `${jobId}.json`)
}

export function getQueuePath(botName: string) {
  return join(QUEUES_DIR, `${botName}.json`)
}
