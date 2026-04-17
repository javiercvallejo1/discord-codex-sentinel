import { watch } from "node:fs"
import { readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import {
  ButtonInteraction,
  ChannelType,
  Client,
  GatewayIntentBits,
  Message,
  Partials,
  type DMChannel,
} from "discord.js"
import { CodexAppServerClient } from "../codex/client"
import type {
  CommandExecutionApprovalRequest,
  DeltaNotification,
  FileChangeApprovalRequest,
  JsonRpcId,
  LegacyExecApprovalRequest,
  LegacyPatchApprovalRequest,
  SupportedNotification,
  SupportedServerRequest,
  ToolRequestUserInputQuestion,
} from "../codex/protocol"
import { Logger } from "../state/logger"
import { LOGS_DIR } from "../state/paths"
import {
  addBot,
  appendMemoryJournal,
  clearBotSessionState,
  createJob,
  deleteJob,
  ensureStateDirs,
  listJobs,
  listNamedBots,
  readJob,
  readJobQueue,
  readMemory,
  readBotSessionState,
  readPersonality,
  readRegistry,
  removeBot,
  resolveProjectPath,
  updateRegistryConfig,
  writeJob,
  writeJobQueue,
  writeBotSessionState,
} from "../state/store"
import type {
  BotConfig,
  BotSessionState,
  JobRecord,
  RegistryConfig,
} from "../state/types"
import {
  appendDiscordSuffix,
  type ApprovalDecision,
  buildApprovalButtons,
  chunkText,
  fitDiscordMessage,
  renderApprovalText,
  renderQuestionPrompt,
} from "../ui/discord/renderer"

interface PromptWaiter {
  jobId: string
  header: string
  resolve: (value: string) => void
}

interface CurrentJobRuntime {
  jobId: string
  turnId: string | null
  replyText: string
  typingTimer: ReturnType<typeof setInterval> | null
  cancelIssued: boolean
}

interface RuntimeBot {
  name: string
  config: BotConfig
  client: Client
  session: BotSessionState
  threadLoaded: boolean
  currentJob: CurrentJobRuntime | null
  promptWaiter: PromptWaiter | null
  dmPollTimer: ReturnType<typeof setInterval> | null
  workerLoop: Promise<void> | null
  inboundInFlightMessageIds: Set<string>
}

interface PendingApproval {
  requestId: string
  botName: string
  jobId: string
  channelId: string
  discordMessageId: string
  approvalId: string | null
  availableDecisions: ApprovalDecision[]
  legacy: boolean
  timeout: ReturnType<typeof setTimeout> | null
}

const BASE_INSTRUCTIONS = `You are operating through a Discord bridge.

Reply concisely.
Before a risky action, explain the intent clearly so the human can approve from Discord.
If a tool asks for user input, keep the question short and concrete.
Attachments and images are not supported in this bridge.`

export class DiscordCodexSentinelService {
  private readonly logger = new Logger("sentinel")
  private readonly codex: CodexAppServerClient
  private registryConfig: RegistryConfig | null = null
  private readonly bots = new Map<string, RuntimeBot>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly threadToBot = new Map<string, string>()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private registryWatcherStop: (() => void) | null = null
  private stopped = false

  constructor(codexBin = "codex") {
    this.codex = new CodexAppServerClient(codexBin, this.logger)
  }

  async start() {
    await ensureStateDirs()
    const registry = await readRegistry()
    this.registryConfig = registry.config

    this.codex.on("notification", notification => {
      void this.handleNotification(notification).catch(error => {
        void this.logger.error(`failed to handle Codex notification: ${String(error)}`)
      })
    })
    this.codex.on("serverRequest", request => {
      void this.handleServerRequest(request).catch(error => {
        void this.logger.error(`failed to handle Codex server request: ${String(error)}`)
      })
    })
    this.codex.on("exit", () => {
      void this.handleCodexExit().catch(error => {
        void this.logger.error(`failed to recover from Codex app-server exit: ${String(error)}`)
      })
    })

    await this.codex.start()
    await this.codex.modelList()
    await this.codex.configRead()
    await this.codex.configRequirementsRead()
    await this.syncBots()
    this.watchRegistry()
    await this.logger.info(`daemon ready with ${this.bots.size} bot(s)`)

    return new Promise<void>(() => {})
  }

  async stop() {
    this.stopped = true
    if (this.registryWatcherStop) {
      this.registryWatcherStop()
      this.registryWatcherStop = null
    }

    for (const runtime of this.bots.values()) {
      try {
        this.teardownRuntime(runtime)
      } catch {}
    }
    this.bots.clear()
    await this.codex.stop()
  }

  async install() {
    await ensureStateDirs()
    await readRegistry()
    await this.logger.info("state initialized")
  }

  async setOwnerId(ownerId: string) {
    await updateRegistryConfig(config => ({ ...config, owner_id: ownerId }))
  }

  async setDefaultProject(project: string) {
    await updateRegistryConfig(config => ({
      ...config,
      default_project: resolveProjectPath(project),
    }))
  }

  async addBotFromCli(name: string, token: string, project?: string) {
    const resolvedProject = resolveProjectPath(project ?? process.cwd())
    await addBot(name, {
      token,
      label: name,
      project: resolvedProject,
    })
  }

  async removeBotFromCli(name: string) {
    const jobs = await listJobs(name)
    for (const job of jobs) {
      await deleteJob(job.id).catch(() => null)
    }
    await removeBot(name)
  }

  async listBotsForCli() {
    const registry = await readRegistry()
    const entries = await Promise.all(
      listNamedBots(registry.bots).map(async bot => {
        const [session, queue] = await Promise.all([
          readBotSessionState(bot.name),
          readJobQueue(bot.name),
        ])
        return {
          ...bot,
          session,
          queue_depth: queue.pending_job_ids.length,
        }
      }),
    )
    return {
      config: registry.config,
      entries,
    }
  }

  async resetThreadForCli(name: string) {
    const queue = await readJobQueue(name)
    if (queue.active_job_id || queue.pending_job_ids.length > 0) {
      throw new Error(`Cannot reset '${name}' while it has active or queued jobs`)
    }

    const runtime = this.bots.get(name)
    if (runtime?.session.thread_id) {
      await this.codex.archiveThread(runtime.session.thread_id)
    } else {
      const session = await readBotSessionState(name)
      if (session.thread_id) {
        await this.codex.archiveThread(session.thread_id)
      }
    }

    await clearBotSessionState(name)
    if (runtime) {
      runtime.session = await readBotSessionState(name)
      runtime.threadLoaded = false
      runtime.currentJob = null
      runtime.promptWaiter = null
    }
  }

  async listJobsForCli(botName?: string) {
    return listJobs(botName)
  }

  async showJobForCli(jobId: string) {
    return readJob(jobId)
  }

  async cancelJobForCli(jobId: string) {
    const job = await readJob(jobId)
    const queue = await readJobQueue(job.bot_name)

    if (queue.active_job_id === jobId) {
      const next = await writeJob({
        ...job,
        cancel_requested: true,
      })
      return {
        message: `Cancellation requested for '${jobId}'`,
        job: next,
      }
    }

    if (queue.pending_job_ids.includes(jobId)) {
      queue.pending_job_ids = queue.pending_job_ids.filter(id => id !== jobId)
      await writeJobQueue(queue)
      const next = await writeJob({
        ...job,
        status: "cancelled",
        finished_at: new Date().toISOString(),
        error: "Cancelled before execution",
        waiting_kind: null,
        approval_request_id: null,
      })
      return {
        message: `Cancelled queued job '${jobId}'`,
        job: next,
      }
    }

    throw new Error(`Job '${jobId}' is not active or queued`)
  }

  async retryJobForCli(jobId: string) {
    const job = await readJob(jobId)
    if (!["failed", "interrupted", "cancelled"].includes(job.status)) {
      throw new Error(`Job '${jobId}' is not retryable`)
    }

    const queue = await readJobQueue(job.bot_name)
    if (queue.active_job_id === jobId || queue.pending_job_ids.includes(jobId)) {
      throw new Error(`Job '${jobId}' is already active or queued`)
    }

    queue.pending_job_ids.push(jobId)
    await writeJobQueue(queue)
    const next = await writeJob({
      ...job,
      status: "queued",
      turn_id: null,
      started_at: null,
      finished_at: null,
      waiting_kind: null,
      approval_request_id: null,
      result_summary: null,
      final_reply: null,
      error: null,
      cancel_requested: false,
      artifacts: {
        branch: null,
        commit: null,
        pr_url: null,
        artifact_links: [],
      },
    })
    const runtime = this.bots.get(job.bot_name)
    if (runtime) {
      this.kickWorker(runtime)
    }
    return {
      message: `Requeued job '${jobId}'`,
      job: next,
    }
  }

  async daemonStatusForCli() {
    const { config, entries } = await this.listBotsForCli()
    return {
      config,
      codexConnected: this.isDaemonRunningUnderLaunchd(),
      entries,
    }
  }

  async daemonLogsForCli(lines = 50) {
    const logPath = join(LOGS_DIR, `sentinel-${new Date().toISOString().slice(0, 10)}.log`)
    try {
      const content = await readFile(logPath, "utf8")
      return content.split("\n").filter(Boolean).slice(-lines).join("\n")
    } catch {
      return ""
    }
  }

  private async syncBots() {
    const registry = await readRegistry()
    this.registryConfig = registry.config
    const desiredNames = new Set(Object.keys(registry.bots))

    for (const [name, runtime] of this.bots) {
      if (!desiredNames.has(name)) {
        await this.logger.info(`disconnecting removed bot ${name}`)
        this.teardownRuntime(runtime)
        this.bots.delete(name)
      }
    }

    for (const [name, config] of Object.entries(registry.bots)) {
      const existing = this.bots.get(name)
      if (existing) {
        const tokenChanged = existing.config.token !== config.token
        existing.config = config
        if (tokenChanged) {
          await this.logger.info(`reconnecting bot ${name} after token change`)
          this.teardownRuntime(existing)
          this.bots.delete(name)
        } else {
          continue
        }
      }

      if (this.bots.has(name)) {
        continue
      }

      const client = new Client({
        intents: [GatewayIntentBits.DirectMessages],
        partials: [Partials.Channel],
      })
      const runtime: RuntimeBot = {
        name,
        config,
        client,
        session: await this.normalizeRecoveredSession(await readBotSessionState(name)),
        threadLoaded: false,
        currentJob: null,
        promptWaiter: null,
        dmPollTimer: null,
        workerLoop: null,
        inboundInFlightMessageIds: new Set(),
      }

      this.attachDiscordHandlers(runtime)
      await client.login(config.token)
      if (runtime.session.thread_id) {
        this.threadToBot.set(runtime.session.thread_id, name)
      }
      this.bots.set(name, runtime)
      await this.recoverOutstandingJobs(runtime)
      this.startDmPolling(runtime)
      this.kickWorker(runtime)
      await this.logger.info(`connected Discord bot ${name}`)
    }
  }

  private watchRegistry() {
    const watcher = watch(join(process.env.HOME ?? "", ".codex", "discord-sentinel"), (_event, filename) => {
      if (filename !== "bots.json") return
      if (this.debounceTimer) clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => {
        void this.syncBots()
      }, 500)
    })

    this.registryWatcherStop = () => watcher.close()
  }

  private attachDiscordHandlers(runtime: RuntimeBot) {
    runtime.client.on("messageCreate", message => {
      void this.logger.info(`gateway message received for ${runtime.name}: ${message.id}`)
      void this.handleDiscordMessage(runtime, message).catch(error => {
        void this.logger.error(`failed to handle Discord message for ${runtime.name}: ${String(error)}`)
      })
    })
    runtime.client.on("interactionCreate", interaction => {
      if (interaction.isButton()) {
        void this.handleButtonInteraction(runtime, interaction).catch(error => {
          void this.logger.error(`failed to handle button interaction for ${runtime.name}: ${String(error)}`)
        })
      }
    })
  }

  private async handleDiscordMessage(runtime: RuntimeBot, message: Message) {
    if (message.author.bot) return
    if (message.channel.type !== ChannelType.DM) return

    const ownerId = this.registryConfig?.owner_id ?? ""
    if (ownerId && message.author.id !== ownerId) {
      await message.reply(fitDiscordMessage("This bot only accepts commands from the configured owner."))
      return
    }

    runtime.session.last_discord_channel_id = message.channel.id
    await writeBotSessionState(runtime.name, runtime.session)

    if (!this.beginInboundProcessing(runtime, message.id)) {
      return
    }

    try {
      if (runtime.promptWaiter && runtime.currentJob && runtime.currentJob.jobId === runtime.promptWaiter.jobId) {
        const waiter = runtime.promptWaiter
        runtime.promptWaiter = null
        waiter.resolve(message.content.trim())
        await this.markInboundProcessed(runtime, message.id)
        return
      }

      if (message.content.startsWith("!")) {
        await this.handleLocalCommand(runtime, message)
        await this.markInboundProcessed(runtime, message.id)
        return
      }

      const { job, ahead } = await this.enqueueJob(runtime, message)
      await this.acknowledgeJob(runtime, message, job.id, ahead)
      await this.markInboundProcessed(runtime, message.id)
      this.kickWorker(runtime)
    } finally {
      runtime.inboundInFlightMessageIds.delete(message.id)
    }
  }

  private async handleLocalCommand(runtime: RuntimeBot, message: Message) {
    const [command, ...rest] = message.content.trim().split(/\s+/)

    switch (command) {
      case "!help":
        await message.reply(fitDiscordMessage("Commands: `!help`, `!status`, `!btw <note>`, `!stop`, `!reset`"))
        return
      case "!status": {
        const queue = await readJobQueue(runtime.name)
        const activeJob = queue.active_job_id ? await readJob(queue.active_job_id).catch(() => null) : null
        const lines = [
          `**${runtime.config.label}** (\`${runtime.name}\`)`,
          `Status: \`${runtime.session.last_status}\``,
          `Project: \`${runtime.config.project ?? this.registryConfig?.default_project ?? process.cwd()}\``,
          `Thread: ${runtime.session.thread_id ? `\`${runtime.session.thread_id}\`` : "_none_"}`,
          `Active job: ${activeJob ? `\`${activeJob.id}\` (${activeJob.status})` : "_none_"}`,
          `Queue depth: \`${queue.pending_job_ids.length}\``,
        ]
        await message.reply(fitDiscordMessage(lines.join("\n")))
        return
      }
      case "!stop": {
        const activeJobId = runtime.session.active_job_id
        if (!activeJobId) {
          await message.reply(fitDiscordMessage("No active job."))
          return
        }
        const job = await readJob(activeJobId)
        await writeJob({ ...job, cancel_requested: true })
        if (runtime.session.thread_id && runtime.session.active_turn_id) {
          await this.codex.interruptTurn(runtime.session.thread_id, runtime.session.active_turn_id).catch(() => null)
        }
        await message.reply(fitDiscordMessage("Stop sent."))
        return
      }
      case "!btw": {
        const note = rest.join(" ").trim()
        if (!note) {
          await message.reply(fitDiscordMessage("Usage: `!btw <note>`"))
          return
        }

        if (!runtime.currentJob || !runtime.session.active_job_id || !runtime.session.thread_id || !runtime.session.active_turn_id) {
          await message.reply(fitDiscordMessage("No active running job to steer."))
          return
        }

        const job = await readJob(runtime.session.active_job_id)
        if (job.status === "waiting_approval") {
          await message.reply(fitDiscordMessage("The active job is waiting on approval. Resolve that first."))
          return
        }
        if (job.status === "waiting_input") {
          await message.reply(fitDiscordMessage("The active job is waiting for an answer. Reply directly to that question first."))
          return
        }
        if (job.status !== "running") {
          await message.reply(fitDiscordMessage("The active job is no longer steerable."))
          return
        }

        await this.codex.steerTurn({
          threadId: runtime.session.thread_id,
          expectedTurnId: runtime.session.active_turn_id,
          input: [this.textInput(note)],
        })

        await writeJob({
          ...job,
          steer_events: [
            ...job.steer_events,
            {
              message_id: message.id,
              text: note,
              created_at: new Date().toISOString(),
            },
          ],
        })
        await this.logger.info(`steered active job ${job.id} for ${runtime.name}`)
        await message.reply(fitDiscordMessage(`Added to job \`${job.id}\`: ${note}`))
        return
      }
      case "!reset": {
        const queue = await readJobQueue(runtime.name)
        if (queue.active_job_id || queue.pending_job_ids.length > 0) {
          await message.reply(fitDiscordMessage("Cannot reset while there is active or queued work."))
          return
        }
        await this.resetBotThread(runtime)
        await message.reply(fitDiscordMessage("Thread archived. The next message will start a fresh Codex thread."))
        return
      }
      default:
        await message.reply(fitDiscordMessage("Unknown command."))
    }
  }

  private async enqueueJob(runtime: RuntimeBot, message: Message) {
    const queue = await readJobQueue(runtime.name)
    const ahead = (queue.active_job_id ? 1 : 0) + queue.pending_job_ids.length
    const job = await createJob({
      botName: runtime.name,
      channelId: message.channel.id,
      inputText: message.content.trim(),
      requestMessageId: message.id,
    })
    queue.pending_job_ids.push(job.id)
    await writeJobQueue(queue)
    return { job, ahead }
  }

  private async acknowledgeJob(runtime: RuntimeBot, message: Message, jobId: string, ahead: number) {
    const content = ahead === 0
      ? "I’m on it."
      : `I’m on it. Your request is queued behind ${ahead} other job${ahead === 1 ? "" : "s"}.`
    await message.reply(fitDiscordMessage(`${content} Job: \`${jobId}\``))
  }

  private kickWorker(runtime: RuntimeBot) {
    if (runtime.workerLoop || this.stopped) {
      return
    }

    runtime.workerLoop = this.runWorker(runtime).finally(() => {
      runtime.workerLoop = null
      if (!this.stopped) {
        void this.maybeContinueWorker(runtime)
      }
    })
  }

  private async maybeContinueWorker(runtime: RuntimeBot) {
    if (runtime.currentJob) return
    const queue = await readJobQueue(runtime.name)
    if (!queue.active_job_id && queue.pending_job_ids.length > 0) {
      this.kickWorker(runtime)
    }
  }

  private async runWorker(runtime: RuntimeBot) {
    while (!this.stopped && !runtime.currentJob) {
      const queue = await readJobQueue(runtime.name)

      if (queue.active_job_id) {
        await this.markPersistedActiveJobInterrupted(runtime, queue.active_job_id, "Worker restarted before job completed.")
        continue
      }

      const nextJobId = queue.pending_job_ids.shift()
      if (!nextJobId) {
        return
      }

      const job = await readJob(nextJobId).catch(() => null)
      if (!job) {
        await writeJobQueue(queue)
        continue
      }

      if (job.cancel_requested) {
        await writeJob({
          ...job,
          status: "cancelled",
          finished_at: new Date().toISOString(),
          error: "Cancelled before execution",
        })
        await writeJobQueue(queue)
        continue
      }

      queue.active_job_id = nextJobId
      await writeJobQueue(queue)

      const startedAt = job.started_at ?? new Date().toISOString()
      await writeJob({
        ...job,
        status: "running",
        started_at: startedAt,
        finished_at: null,
        waiting_kind: null,
        approval_request_id: null,
        error: null,
        cancel_requested: false,
      })

      runtime.session.active_job_id = job.id
      runtime.session.last_status = "running"
      await writeBotSessionState(runtime.name, runtime.session)

      try {
        await this.startJob(runtime, job.id)
      } catch (error) {
        await this.failJobStart(runtime, job.id, String(error))
      }

      return
    }
  }

  private async startJob(runtime: RuntimeBot, jobId: string) {
    const job = await readJob(jobId)
    const threadId = await this.ensureThread(runtime)
    const channel = await this.getDmChannel(runtime)
    await channel.sendTyping().catch(() => null)

    const response = await this.codex.startTurn({
      threadId,
      input: [this.textInput(job.input_text)],
      model: runtime.config.model ?? this.registryConfig?.default_model ?? null,
      effort: runtime.config.effort ?? this.registryConfig?.default_effort ?? null,
    })

    runtime.currentJob = {
      jobId,
      turnId: response.turn.id,
      replyText: "",
      typingTimer: this.startTypingLoop(runtime),
      cancelIssued: false,
    }

    runtime.session.active_turn_id = response.turn.id
    runtime.session.active_job_id = jobId
    runtime.session.last_status = "running"
    await writeBotSessionState(runtime.name, runtime.session)

    await writeJob({
      ...job,
      status: "running",
      thread_id: threadId,
      turn_id: response.turn.id,
      started_at: job.started_at ?? new Date().toISOString(),
      waiting_kind: null,
      approval_request_id: null,
      error: null,
    })

    await this.logger.info(`started job ${jobId} turn ${response.turn.id} for ${runtime.name}`)
  }

  private async failJobStart(runtime: RuntimeBot, jobId: string, error: string) {
    const queue = await readJobQueue(runtime.name)
    if (queue.active_job_id === jobId) {
      queue.active_job_id = null
      await writeJobQueue(queue)
    }

    const job = await readJob(jobId)
    await writeJob({
      ...job,
      status: "failed",
      finished_at: new Date().toISOString(),
      error,
    })

    runtime.session.active_job_id = null
    runtime.session.active_turn_id = null
    runtime.session.last_status = "errored"
    await writeBotSessionState(runtime.name, runtime.session)

    const channel = await this.getDmChannel(runtime).catch(() => null)
    if (channel) {
      for (const chunk of chunkText(`I couldn’t start job \`${jobId}\`: ${error}`)) {
        await channel.send(chunk)
      }
    }
  }

  private async ensureThread(runtime: RuntimeBot) {
    if (runtime.session.thread_id && runtime.threadLoaded) {
      return runtime.session.thread_id
    }

    const project = runtime.config.project ?? this.registryConfig?.default_project ?? process.cwd()
    const developerInstructions = await this.buildDeveloperInstructions(runtime.name)
    const shared = {
      cwd: project,
      model: runtime.config.model ?? this.registryConfig?.default_model ?? null,
      approvalPolicy: runtime.config.approval_policy ?? this.registryConfig?.default_approval_policy ?? "on-request",
      sandbox: runtime.config.sandbox_mode ?? this.registryConfig?.default_sandbox_mode ?? "workspace-write",
      baseInstructions: BASE_INSTRUCTIONS,
      developerInstructions,
      personality: "pragmatic" as const,
    }

    try {
      if (runtime.session.thread_id) {
        const resumed = await this.codex.resumeThread({
          threadId: runtime.session.thread_id,
          ...shared,
        })
        runtime.threadLoaded = true
        this.threadToBot.set(resumed.thread.id, runtime.name)
        return resumed.thread.id
      }
    } catch (error) {
      await this.logger.warn(`resume failed for ${runtime.name}: ${String(error)}`)
      runtime.session.thread_id = null
    }

    const started = await this.codex.startThread(shared)
    runtime.threadLoaded = true
    runtime.session.thread_id = started.thread.id
    runtime.session.last_status = "idle"
    this.threadToBot.set(started.thread.id, runtime.name)
    await writeBotSessionState(runtime.name, runtime.session)
    await this.codex.setThreadName(started.thread.id, `Discord • ${runtime.config.label}`)
    return started.thread.id
  }

  private async resetBotThread(runtime: RuntimeBot) {
    if (runtime.session.thread_id) {
      await this.codex.archiveThread(runtime.session.thread_id)
      this.threadToBot.delete(runtime.session.thread_id)
    }
    this.clearCurrentJob(runtime)
    runtime.session = {
      thread_id: null,
      active_turn_id: null,
      active_job_id: null,
      last_discord_channel_id: runtime.session.last_discord_channel_id,
      last_inbound_message_id: runtime.session.last_inbound_message_id,
      last_working_message_id: null,
      last_status: "idle",
      updated_at: new Date().toISOString(),
    }
    runtime.threadLoaded = false
    await writeBotSessionState(runtime.name, runtime.session)
  }

  private async handleNotification(notification: SupportedNotification) {
    switch (notification.method) {
      case "turn/started":
        await this.onTurnStarted(
          (notification.params as { threadId: string; turn: { id: string } }).threadId,
          (notification.params as { threadId: string; turn: { id: string } }).turn.id,
        )
        return
      case "turn/completed":
        await this.onTurnCompleted(
          (notification.params as { threadId: string; turn: { id: string; status: string; error?: { message?: string } | null } }).threadId,
          (notification.params as { threadId: string; turn: { id: string; status: string; error?: { message?: string } | null } }).turn,
        )
        return
      case "item/agentMessage/delta":
        await this.onDelta(notification.params as DeltaNotification)
        return
      case "item/plan/delta":
        return
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        return
      case "serverRequest/resolved":
        await this.disableApproval((notification.params as { requestId: JsonRpcId }).requestId)
        return
      case "thread/status/changed":
        await this.logger.info(`thread status changed ${(notification.params as { threadId: string }).threadId}`)
        return
      default:
        return
    }
  }

  private async handleServerRequest(request: SupportedServerRequest) {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        await this.createApprovalPrompt(request.id, request.params as CommandExecutionApprovalRequest, false)
        return
      case "item/fileChange/requestApproval":
        await this.createApprovalPrompt(request.id, request.params as FileChangeApprovalRequest, false)
        return
      case "execCommandApproval":
        await this.createApprovalPrompt(request.id, request.params as LegacyExecApprovalRequest, true)
        return
      case "applyPatchApproval":
        await this.createApprovalPrompt(request.id, request.params as LegacyPatchApprovalRequest, true)
        return
      case "item/tool/requestUserInput":
        await this.handleUserInputRequest(request.id, request.params as { threadId: string; questions: ToolRequestUserInputQuestion[] })
        return
      default: {
        await this.codex.respondError(request.id, `Unsupported server request: ${request.method}`)
        const runtime = this.findRuntimeByUnknownRequest(request.params as Record<string, unknown>)
        if (runtime) {
          const channel = await this.getDmChannel(runtime)
          await channel.send(fitDiscordMessage(`Codex requested an unsupported capability: \`${request.method}\``))
        }
      }
    }
  }

  private async handleCodexExit() {
    if (this.stopped) return
    await this.logger.warn("restarting Codex app-server")

    for (const runtime of this.bots.values()) {
      await this.markCurrentJobInterrupted(runtime, "Codex app-server exited unexpectedly.", true)
      runtime.threadLoaded = false
      runtime.session.last_status = "errored"
      await writeBotSessionState(runtime.name, runtime.session)
    }

    await new Promise(resolve => setTimeout(resolve, 2000))
    await this.codex.start()

    for (const runtime of this.bots.values()) {
      this.kickWorker(runtime)
    }
  }

  private async onTurnStarted(threadId: string, turnId: string) {
    const runtime = this.findRuntimeByThreadId(threadId)
    if (!runtime?.currentJob) return

    runtime.currentJob.turnId = turnId
    runtime.session.active_turn_id = turnId
    runtime.session.active_job_id = runtime.currentJob.jobId
    runtime.session.last_status = "running"
    await writeBotSessionState(runtime.name, runtime.session)

    const job = await readJob(runtime.currentJob.jobId)
    await writeJob({
      ...job,
      turn_id: turnId,
      status: "running",
      started_at: job.started_at ?? new Date().toISOString(),
    })
  }

  private async onTurnCompleted(threadId: string, turn: { id: string; status: string; error?: { message?: string } | null }) {
    const runtime = this.findRuntimeByThreadId(threadId)
    if (!runtime?.currentJob) return

    const job = await readJob(runtime.currentJob.jobId)
    const fullReply = runtime.currentJob.replyText.trim()

    let status: JobRecord["status"]
    if (turn.status === "failed") {
      status = "failed"
    } else if (turn.status === "interrupted") {
      status = job.cancel_requested ? "cancelled" : "interrupted"
    } else {
      status = "completed"
    }

    const finalJob = await writeJob({
      ...job,
      status,
      turn_id: turn.id,
      finished_at: new Date().toISOString(),
      waiting_kind: null,
      approval_request_id: null,
      final_reply: fullReply || null,
      result_summary: this.summarizeJobResult(fullReply, turn.error?.message ?? null, status),
      error: turn.error?.message ?? (status === "cancelled" ? "Cancelled by user" : null),
    })

    const queue = await readJobQueue(runtime.name)
    if (queue.active_job_id === finalJob.id) {
      queue.active_job_id = null
      await writeJobQueue(queue)
    }

    runtime.session.active_turn_id = null
    runtime.session.active_job_id = null
    runtime.session.last_status = status === "failed" ? "errored" : "idle"
    await writeBotSessionState(runtime.name, runtime.session)

    this.clearCurrentJob(runtime)

    if (status === "completed") {
      await this.sendJobCompletion(runtime, finalJob)
      if (finalJob.input_text.trim() || fullReply) {
        await appendMemoryJournal(runtime.name, {
          user: this.renderJobUserText(finalJob),
          assistant: fullReply,
        })
      }
    } else {
      await this.sendJobFailure(runtime, finalJob)
    }

    this.kickWorker(runtime)
  }

  private async onDelta(notification: DeltaNotification) {
    const runtime = this.findRuntimeByThreadId(notification.threadId)
    if (!runtime?.currentJob) return
    runtime.currentJob.replyText += notification.delta
  }

  private startTypingLoop(runtime: RuntimeBot) {
    return setInterval(() => {
      void this.tickCurrentJob(runtime)
    }, 4000)
  }

  private async tickCurrentJob(runtime: RuntimeBot) {
    if (!runtime.currentJob) return
    const persisted = await readJob(runtime.currentJob.jobId).catch(() => null)
    if (!persisted) return

    if (persisted.cancel_requested && !runtime.currentJob.cancelIssued && runtime.session.thread_id && runtime.session.active_turn_id) {
      runtime.currentJob.cancelIssued = true
      await this.logger.info(`interrupting job ${persisted.id} after cancellation request`)
      await this.codex.interruptTurn(runtime.session.thread_id, runtime.session.active_turn_id).catch(error => {
        runtime.currentJob!.cancelIssued = false
        void this.logger.warn(`failed to interrupt job ${persisted.id}: ${String(error)}`)
      })
      return
    }

    const channel = await this.getDmChannel(runtime).catch(() => null)
    if (!channel) return
    await channel.sendTyping().catch(() => null)
  }

  private async createApprovalPrompt(
    requestId: JsonRpcId,
    params:
      | CommandExecutionApprovalRequest
      | FileChangeApprovalRequest
      | LegacyExecApprovalRequest
      | LegacyPatchApprovalRequest,
    legacy: boolean,
  ) {
    const runtime = legacy
      ? this.findRuntimeByThreadId("conversationId" in params ? params.conversationId : "")
      : this.findRuntimeByThreadId("threadId" in params ? params.threadId : "")
    if (!runtime?.currentJob) {
      await this.respondToApproval(requestId, "cancel", legacy, "approval target not found", {
        approvalId: "approvalId" in params ? params.approvalId ?? null : null,
      })
      return
    }

    const job = await readJob(runtime.currentJob.jobId)
    await writeJob({
      ...job,
      status: "waiting_approval",
      waiting_kind: "approval",
      approval_request_id: String(requestId),
    })
    runtime.session.last_status = "waiting_approval"
    await writeBotSessionState(runtime.name, runtime.session)

    const channel = await this.getDmChannel(runtime)
    const availableDecisions = this.getAvailableApprovalDecisions(params, legacy)
    const prompt = this.renderApprovalPrompt(params)
    const message = await channel.send({
      content: prompt,
      components: buildApprovalButtons(String(requestId), availableDecisions),
    })
    const timeoutMs = (this.registryConfig?.approval_timeout_sec ?? 120) * 1000
    const timeout = setTimeout(() => {
      void this.expireApproval(String(requestId))
    }, timeoutMs)

    this.approvals.set(String(requestId), {
      requestId: String(requestId),
      botName: runtime.name,
      jobId: runtime.currentJob.jobId,
      channelId: channel.id,
      discordMessageId: message.id,
      approvalId: "approvalId" in params ? params.approvalId ?? null : null,
      availableDecisions,
      legacy,
      timeout,
    })
  }

  private renderApprovalPrompt(
    params:
      | CommandExecutionApprovalRequest
      | FileChangeApprovalRequest
      | LegacyExecApprovalRequest
      | LegacyPatchApprovalRequest,
  ) {
    if ("command" in params || "cwd" in params) {
      const command = Array.isArray((params as LegacyExecApprovalRequest).command)
        ? (params as LegacyExecApprovalRequest).command.join(" ")
        : (params as CommandExecutionApprovalRequest).command ?? null
      return renderApprovalText({
        kind: "command",
        reason: params.reason,
        command,
        cwd: "cwd" in params ? params.cwd : null,
      })
    }

    return renderApprovalText({
      kind: "file",
      reason: params.reason,
      grantRoot: "grantRoot" in params ? params.grantRoot : null,
    })
  }

  private async handleButtonInteraction(runtime: RuntimeBot, interaction: ButtonInteraction) {
    const [prefix, requestId, decision] = interaction.customId.split(":")
    if (prefix !== "approval" || !requestId || !decision) return

    const pending = this.approvals.get(requestId)
    if (!pending) {
      await interaction.reply({ content: fitDiscordMessage("This approval is no longer pending."), ephemeral: true })
      return
    }

    if (pending.botName !== runtime.name) {
      await interaction.reply({ content: fitDiscordMessage("Approval belongs to a different bot."), ephemeral: true })
      return
    }

    if (!pending.availableDecisions.includes(decision as ApprovalDecision)) {
      await interaction.reply({ content: fitDiscordMessage("That approval option is not available."), ephemeral: true })
      return
    }

    await interaction.deferUpdate()
    try {
      await this.respondToApproval(requestId, decision as ApprovalDecision, pending.legacy, "discord button", {
        approvalId: pending.approvalId,
      })
      await this.disableApproval(requestId)
    } catch (error) {
      await interaction.followUp({
        content: fitDiscordMessage(`Approval failed: ${String(error)}`),
        ephemeral: true,
      }).catch(() => null)
    }
  }

  private mapLegacyDecision(decision: string) {
    switch (decision) {
      case "accept":
        return "approved"
      case "acceptForSession":
        return "approved_for_session"
      case "decline":
        return "denied"
      default:
        return "abort"
    }
  }

  private getAvailableApprovalDecisions(
    params:
      | CommandExecutionApprovalRequest
      | FileChangeApprovalRequest
      | LegacyExecApprovalRequest
      | LegacyPatchApprovalRequest,
    legacy: boolean,
  ): ApprovalDecision[] {
    if (legacy) {
      return ["accept", "acceptForSession", "decline", "cancel"]
    }

    if ("availableDecisions" in params && Array.isArray(params.availableDecisions) && params.availableDecisions.length > 0) {
      const supported = params.availableDecisions.filter((decision): decision is ApprovalDecision =>
        decision === "accept" ||
        decision === "acceptForSession" ||
        decision === "decline" ||
        decision === "cancel",
      )
      if (supported.length > 0) {
        return supported
      }
    }

    if ("command" in params || "cwd" in params) {
      return ["accept", "acceptForSession", "decline", "cancel"]
    }

    return ["accept", "decline", "cancel"]
  }

  private async respondToApproval(
    requestId: JsonRpcId,
    decision: ApprovalDecision,
    legacy: boolean,
    reason: string,
    params: { approvalId?: string | null },
  ) {
    await this.logger.info(`resolving approval ${String(requestId)} as ${decision} (${reason})`)
    if (legacy) {
      await this.codex.respond(requestId, {
        decision: this.mapLegacyDecision(decision),
        ...(params.approvalId ? { approvalId: params.approvalId } : {}),
      })
      return
    }

    await this.codex.respond(requestId, {
      decision,
      ...(params.approvalId ? { approvalId: params.approvalId } : {}),
    })
  }

  private async expireApproval(requestId: string) {
    const pending = this.approvals.get(requestId)
    if (!pending) return

    try {
      await this.respondToApproval(requestId, "cancel", pending.legacy, "approval timeout", {
        approvalId: pending.approvalId,
      })
    } catch (error) {
      await this.logger.error(`failed to cancel timed-out approval ${requestId}: ${String(error)}`)
    }

    await this.disableApproval(requestId, "_Timed out._")
  }

  private async disableApproval(requestId: JsonRpcId, suffix = "_Resolved._") {
    const pending = this.approvals.get(String(requestId))
    if (!pending) return
    this.approvals.delete(String(requestId))
    if (pending.timeout) {
      clearTimeout(pending.timeout)
    }

    const runtime = this.bots.get(pending.botName)
    const job = await readJob(pending.jobId).catch(() => null)
    if (job && ["waiting_approval", "running"].includes(job.status)) {
      await writeJob({
        ...job,
        status: runtime?.currentJob?.jobId === job.id ? "running" : job.status,
        waiting_kind: null,
        approval_request_id: null,
      })
    }

    if (runtime) {
      runtime.session.last_status = runtime.currentJob ? "running" : "idle"
      await writeBotSessionState(runtime.name, runtime.session)
    }

    if (!runtime) return

    const channel = await this.getDmChannel(runtime)
    const message = await channel.messages.fetch(pending.discordMessageId).catch(() => null)
    if (!message) return

    await message.edit({ content: appendDiscordSuffix(message.content, suffix), components: [] })
  }

  private async handleUserInputRequest(requestId: JsonRpcId, params: { threadId: string; questions: ToolRequestUserInputQuestion[] }) {
    const runtime = this.findRuntimeByThreadId(params.threadId)
    if (!runtime?.currentJob) {
      await this.codex.respondError(requestId, "Unknown thread for user input request")
      return
    }

    const job = await readJob(runtime.currentJob.jobId)
    await writeJob({
      ...job,
      status: "waiting_input",
      waiting_kind: "input",
    })
    runtime.session.last_status = "waiting_input"
    await writeBotSessionState(runtime.name, runtime.session)

    const answers: Record<string, { answers: string[] }> = {}
    for (const question of params.questions) {
      const answer = await this.askQuestion(runtime, question)
      answers[question.id] = { answers: [answer] }
    }

    await this.codex.respond(requestId, { answers })
    const updated = await readJob(runtime.currentJob.jobId).catch(() => null)
    if (updated) {
      await writeJob({
        ...updated,
        status: "running",
        waiting_kind: null,
      })
    }
    runtime.session.last_status = "running"
    await writeBotSessionState(runtime.name, runtime.session)
  }

  private async askQuestion(runtime: RuntimeBot, question: ToolRequestUserInputQuestion) {
    if (!runtime.currentJob) {
      throw new Error("No active job for user input")
    }

    const channel = await this.getDmChannel(runtime)
    const options = (question.options ?? []).map(option => `${option.label} — ${option.description}`)
    await channel.send(renderQuestionPrompt(question.header, question.question, options))

    return new Promise<string>(resolve => {
      runtime.promptWaiter = {
        jobId: runtime.currentJob!.jobId,
        header: question.header,
        resolve: raw => {
          const trimmed = raw.trim()
          if (!options.length) {
            resolve(trimmed)
            return
          }

          const numbered = Number.parseInt(trimmed, 10)
          if (!Number.isNaN(numbered) && numbered >= 1 && numbered <= options.length) {
            resolve((question.options ?? [])[numbered - 1]!.label)
            return
          }

          const exact = (question.options ?? []).find(option => option.label.toLowerCase() === trimmed.toLowerCase())
          if (exact) {
            resolve(exact.label)
            return
          }

          resolve(trimmed)
        },
      }
    })
  }

  private async getDmChannel(runtime: RuntimeBot): Promise<DMChannel> {
    if (runtime.session.last_discord_channel_id) {
      const fetched = await runtime.client.channels.fetch(runtime.session.last_discord_channel_id).catch(() => null)
      if (fetched?.type === ChannelType.DM && !fetched.partial) {
        return fetched as DMChannel
      }
    }

    const ownerId = this.registryConfig?.owner_id
    if (!ownerId) {
      throw new Error("owner_id is not configured")
    }

    const user = await runtime.client.users.fetch(ownerId)
    return user.createDM()
  }

  private findRuntimeByThreadId(threadId: string) {
    const botName = this.threadToBot.get(threadId)
    if (!botName) return null
    return this.bots.get(botName) ?? null
  }

  private findRuntimeByUnknownRequest(params: Record<string, unknown>) {
    const threadId =
      (typeof params?.threadId === "string" && params.threadId) ||
      (typeof params?.conversationId === "string" && params.conversationId) ||
      ""
    return threadId ? this.findRuntimeByThreadId(threadId) : null
  }

  private textInput(text: string) {
    return {
      type: "text" as const,
      text,
      text_elements: [],
    }
  }

  private startDmPolling(runtime: RuntimeBot) {
    if (runtime.dmPollTimer) {
      clearInterval(runtime.dmPollTimer)
    }

    runtime.dmPollTimer = setInterval(() => {
      void this.pollDmChannel(runtime)
    }, 3000)

    void this.pollDmChannel(runtime)
  }

  private async pollDmChannel(runtime: RuntimeBot) {
    const ownerId = this.registryConfig?.owner_id ?? ""
    if (!ownerId) return
    if (!runtime.client.isReady()) return

    const channel = await this.getDmChannel(runtime).catch(() => null)
    if (!channel) {
      await this.maybeContinueWorker(runtime)
      return
    }

    if (runtime.session.last_discord_channel_id !== channel.id) {
      runtime.session.last_discord_channel_id = channel.id
      await writeBotSessionState(runtime.name, runtime.session)
    }

    const fetched = await channel.messages.fetch({ limit: 10 }).catch(() => null)
    if (!fetched) return

    const ownerMessages = [...fetched.values()]
      .filter(message => !message.author.bot && message.author.id === ownerId)
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp)

    const pending =
      runtime.session.last_inbound_message_id === null
        ? ownerMessages.slice(-1)
        : ownerMessages.filter(message =>
            this.isSnowflakeAfter(message.id, runtime.session.last_inbound_message_id),
          )

    for (const message of pending) {
      await this.logger.info(`polled DM message for ${runtime.name}: ${message.id}`)
      await this.handleDiscordMessage(runtime, message).catch(error => {
        void this.logger.error(`failed to process polled DM for ${runtime.name}: ${String(error)}`)
      })
    }

    await this.maybeContinueWorker(runtime)
  }

  private isSnowflakeAfter(left: string, right: string | null) {
    if (!right) return true
    return BigInt(left) > BigInt(right)
  }

  private async markInboundProcessed(runtime: RuntimeBot, messageId: string) {
    if (
      runtime.session.last_inbound_message_id &&
      !this.isSnowflakeAfter(messageId, runtime.session.last_inbound_message_id)
    ) {
      return
    }

    runtime.session.last_inbound_message_id = messageId
    await writeBotSessionState(runtime.name, runtime.session)
  }

  private beginInboundProcessing(runtime: RuntimeBot, messageId: string) {
    if (
      runtime.session.last_inbound_message_id &&
      !this.isSnowflakeAfter(messageId, runtime.session.last_inbound_message_id)
    ) {
      return false
    }

    if (runtime.inboundInFlightMessageIds.has(messageId)) {
      return false
    }

    runtime.inboundInFlightMessageIds.add(messageId)
    return true
  }

  private clearCurrentJob(runtime: RuntimeBot) {
    if (runtime.currentJob?.typingTimer) {
      clearInterval(runtime.currentJob.typingTimer)
    }
    runtime.currentJob = null
    runtime.promptWaiter = null
  }

  private async recoverOutstandingJobs(runtime: RuntimeBot) {
    const queue = await readJobQueue(runtime.name)
    if (!queue.active_job_id) {
      return
    }

    const interruptedJobId = queue.active_job_id
    await this.markPersistedActiveJobInterrupted(runtime, interruptedJobId, "The daemon restarted while this job was running.")
  }

  private async markPersistedActiveJobInterrupted(runtime: RuntimeBot, jobId: string, reason: string) {
    const queue = await readJobQueue(runtime.name)
    const job = await readJob(jobId).catch(() => null)
    if (job) {
      await writeJob({
        ...job,
        status: "interrupted",
        finished_at: new Date().toISOString(),
        waiting_kind: null,
        approval_request_id: null,
        error: reason,
      })
    }
    if (queue.active_job_id === jobId) {
      queue.active_job_id = null
      await writeJobQueue(queue)
    }

    runtime.session.active_job_id = null
    runtime.session.active_turn_id = null
    runtime.session.last_status = "idle"
    await writeBotSessionState(runtime.name, runtime.session)

    if (job) {
      const channel = await this.getDmChannel(runtime).catch(() => null)
      if (channel) {
        await channel.send(fitDiscordMessage(`Job \`${job.id}\` was interrupted. Ask again or retry it from the CLI/plugin.`)).catch(() => null)
      }
    }
  }

  private async markCurrentJobInterrupted(runtime: RuntimeBot, reason: string, notifyUser: boolean) {
    if (!runtime.currentJob) {
      return
    }

    const job = await readJob(runtime.currentJob.jobId).catch(() => null)
    if (job) {
      await writeJob({
        ...job,
        status: "interrupted",
        finished_at: new Date().toISOString(),
        waiting_kind: null,
        approval_request_id: null,
        error: reason,
      })
    }

    const queue = await readJobQueue(runtime.name)
    if (queue.active_job_id === runtime.currentJob.jobId) {
      queue.active_job_id = null
      await writeJobQueue(queue)
    }

    runtime.session.active_job_id = null
    runtime.session.active_turn_id = null
    runtime.session.last_status = "idle"
    await writeBotSessionState(runtime.name, runtime.session)

    const currentJobId = runtime.currentJob.jobId
    this.clearCurrentJob(runtime)

    if (notifyUser) {
      const channel = await this.getDmChannel(runtime).catch(() => null)
      if (channel) {
        await channel.send(fitDiscordMessage(`Job \`${currentJobId}\` was interrupted. Ask again or retry it from the CLI/plugin.`)).catch(() => null)
      }
    }
  }

  private async sendJobCompletion(runtime: RuntimeBot, job: JobRecord) {
    const channel = await this.getDmChannel(runtime)
    const body = job.final_reply?.trim() || `Done. Job \`${job.id}\` completed.`
    for (const chunk of chunkText(body)) {
      await channel.send(chunk)
    }
  }

  private async sendJobFailure(runtime: RuntimeBot, job: JobRecord) {
    const channel = await this.getDmChannel(runtime)
    const prefix =
      job.status === "cancelled"
        ? `Job \`${job.id}\` was cancelled.`
        : job.status === "interrupted"
          ? `Job \`${job.id}\` was interrupted.`
          : `Job \`${job.id}\` failed.`
    const body = job.error ? `${prefix}\n\n${job.error}` : prefix
    for (const chunk of chunkText(body)) {
      await channel.send(chunk)
    }
  }

  private summarizeJobResult(reply: string, error: string | null, status: JobRecord["status"]) {
    if (reply.trim()) {
      return fitDiscordMessage(reply.trim().split("\n\n")[0] ?? reply.trim(), 400)
    }
    if (error) {
      return fitDiscordMessage(error, 400)
    }
    return fitDiscordMessage(`Job ${status}.`, 400)
  }

  private renderJobUserText(job: JobRecord) {
    const steerNotes = job.steer_events.map(event => `BTW: ${event.text.trim()}`).filter(Boolean)
    const parts = [job.input_text.trim(), ...steerNotes].filter(Boolean)
    return parts.join("\n\n")
  }

  private teardownRuntime(runtime: RuntimeBot) {
    if (runtime.dmPollTimer) {
      clearInterval(runtime.dmPollTimer)
      runtime.dmPollTimer = null
    }
    this.clearCurrentJob(runtime)
    if (runtime.session.thread_id) {
      this.threadToBot.delete(runtime.session.thread_id)
    }
    runtime.client.destroy()
  }

  private isDaemonRunningUnderLaunchd() {
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : null
      if (uid === null) {
        return this.codex.isRunning()
      }

      const output = execFileSync("launchctl", ["print", `gui/${uid}/com.codex.discord-sentinel`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      return output.includes("state = running")
    } catch {
      return this.codex.isRunning()
    }
  }

  private async normalizeRecoveredSession(session: BotSessionState) {
    if (!session.active_turn_id && !session.active_job_id && !["running", "waiting_approval", "waiting_input"].includes(session.last_status)) {
      return session
    }

    return {
      ...session,
      active_turn_id: null,
      active_job_id: null,
      last_status: "idle" as const,
      updated_at: new Date().toISOString(),
    }
  }

  private async buildDeveloperInstructions(botName: string) {
    const [personality, memory] = await Promise.all([
      readPersonality(botName),
      readMemory(botName),
    ])

    return [
      personality.trim(),
      "## Durable Memory",
      "Treat the following as stable cross-session context for this Discord bot.",
      memory.trim(),
    ].join("\n\n")
  }
}
