import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { LOGS_DIR } from "./paths"

type Level = "INFO" | "WARN" | "ERROR"

export class Logger {
  private readonly name: string

  constructor(name: string) {
    this.name = name
  }

  info(message: string) {
    return this.write("INFO", message)
  }

  warn(message: string) {
    return this.write("WARN", message)
  }

  error(message: string) {
    return this.write("ERROR", message)
  }

  child(name: string) {
    return new Logger(`${this.name}:${name}`)
  }

  private async write(level: Level, message: string) {
    const ts = new Date().toISOString()
    const line = `[${ts}] [${level}] [${this.name}] ${message}\n`
    process.stderr.write(line)
    await mkdir(LOGS_DIR, { recursive: true })
    const logPath = join(LOGS_DIR, `sentinel-${ts.slice(0, 10)}.log`)
    await appendFile(logPath, line)
  }
}

