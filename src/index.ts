import { execFileSync } from "node:child_process"
import { chmod } from "node:fs/promises"
import { join } from "node:path"
import { DiscordCodexSentinelService } from "./daemon/service"
import { startMcpServer } from "./mcp/server"

function usage() {
  return [
    "Usage:",
    "  bun src/index.ts install",
    "  bun src/index.ts config owner <discord-user-id>",
    "  bun src/index.ts config project <default-project>",
    "  bun src/index.ts daemon start|status|logs",
    "  bun src/index.ts bot add <name> <token> [project]",
    "  bun src/index.ts bot remove <name>",
    "  bun src/index.ts bot list",
    "  bun src/index.ts job list [bot]",
    "  bun src/index.ts job show <job-id>",
    "  bun src/index.ts job cancel <job-id>",
    "  bun src/index.ts job retry <job-id>",
    "  bun src/index.ts thread reset <name>",
    "  bun src/index.ts mcp serve",
  ].join("\n")
}

async function main() {
  const [command, subcommand, ...rest] = process.argv.slice(2)
  const service = new DiscordCodexSentinelService(process.env.CODEX_BIN ?? "codex")

  try {
    switch (command) {
      case "install": {
        execFileSync("bun", ["--version"], { stdio: "ignore" })
        execFileSync(process.env.CODEX_BIN ?? "codex", ["--version"], { stdio: "ignore" })
        await chmod(join(process.cwd(), "scripts", "install-daemon.sh"), 0o755).catch(() => {})
        await chmod(join(process.cwd(), "scripts", "uninstall-daemon.sh"), 0o755).catch(() => {})
        await service.install()
        console.log("Initialized ~/.codex/discord-sentinel/")
        return
      }
      case "daemon": {
        switch (subcommand) {
          case "start":
            await service.start()
            return
          case "status": {
            const status = await service.daemonStatusForCli()
            console.log(`Codex app-server: ${status.codexConnected ? "ready" : "disconnected"}`)
            console.log(`Owner: ${status.config.owner_id || "(unset)"}`)
            for (const entry of status.entries) {
              console.log(
                `${entry.name}\t${entry.config.label}\t${entry.session.last_status}\t${entry.session.thread_id ?? "-"}`,
                `\tactive_job=${entry.session.active_job_id ?? "-"}\tqueue=${entry.queue_depth}`,
              )
            }
            return
          }
          case "logs":
            console.log(await service.daemonLogsForCli())
            return
          default:
            console.error(usage())
            process.exitCode = 1
            return
        }
      }
      case "config": {
        switch (subcommand) {
          case "owner": {
            const [ownerId] = rest
            if (!ownerId) throw new Error("config owner requires <discord-user-id>")
            await service.setOwnerId(ownerId)
            console.log(`Configured owner_id '${ownerId}'`)
            return
          }
          case "project": {
            const [project] = rest
            if (!project) throw new Error("config project requires <default-project>")
            await service.setDefaultProject(project)
            console.log(`Configured default project '${project}'`)
            return
          }
          default:
            throw new Error("unknown config subcommand")
        }
      }
      case "bot": {
        switch (subcommand) {
          case "add": {
            const [name, token, project] = rest
            if (!name || !token) {
              throw new Error("bot add requires <name> <token> [project]")
            }
            await service.addBotFromCli(name, token, project)
            console.log(`Added bot '${name}'`)
            return
          }
          case "remove": {
            const [name] = rest
            if (!name) throw new Error("bot remove requires <name>")
            await service.removeBotFromCli(name)
            console.log(`Removed bot '${name}'`)
            return
          }
          case "list": {
            const result = await service.listBotsForCli()
            for (const entry of result.entries) {
              console.log(
                `${entry.name}\t${entry.config.label}\t${entry.config.project ?? result.config.default_project}\t${entry.session.last_status}`,
              )
            }
            return
          }
          default:
            throw new Error("unknown bot subcommand")
        }
      }
      case "thread": {
        if (subcommand !== "reset" || !rest[0]) {
          throw new Error("thread reset requires <name>")
        }
        await service.resetThreadForCli(rest[0])
        console.log(`Reset thread for '${rest[0]}'`)
        return
      }
      case "job": {
        switch (subcommand) {
          case "list": {
            const [botName] = rest
            const jobs = await service.listJobsForCli(botName)
            for (const job of jobs) {
              console.log(`${job.id}\t${job.bot_name}\t${job.status}\t${job.created_at}`)
            }
            return
          }
          case "show": {
            const [jobId] = rest
            if (!jobId) throw new Error("job show requires <job-id>")
            console.log(JSON.stringify(await service.showJobForCli(jobId), null, 2))
            return
          }
          case "cancel": {
            const [jobId] = rest
            if (!jobId) throw new Error("job cancel requires <job-id>")
            const result = await service.cancelJobForCli(jobId)
            console.log(result.message)
            return
          }
          case "retry": {
            const [jobId] = rest
            if (!jobId) throw new Error("job retry requires <job-id>")
            const result = await service.retryJobForCli(jobId)
            console.log(result.message)
            return
          }
          default:
            throw new Error("unknown job subcommand")
        }
      }
      case "mcp": {
        if (subcommand !== "serve") {
          throw new Error("unknown mcp subcommand")
        }
        await startMcpServer()
        return
      }
      default:
        console.error(usage())
        process.exitCode = 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

void main()
