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
  clearBotSessionState,
  appendMemoryJournal,
  ensureStateDirs,
  listNamedBots,
  readMemory,
  readBotSessionState,
  readPersonality,
  readRegistry,
  removeBot,
  resolveProjectPath,
  updateRegistryConfig,
  writeBotSessionState,
} from "../state/store"
import type { BotConfig, BotSessionState, RegistryConfig } from "../state/types"
import {
  appendDiscordSuffix,
  type ApprovalDecision,
  buildApprovalButtons,
  chunkText,
  fitDiscordMessage,
  renderApprovalText,
  renderQuestionPrompt,
  renderStatusMessage,
  renderWorkingMessage,
} from "../ui/discord/renderer"

interface ActiveTurn {
  turnId: string
  planText: string
  replyText: string
  lastUserText: string
  lastActivityAt: number
  workingMessageId: string | null
  flushTimer: ReturnType<typeof setTimeout> | null
  typingTimer: ReturnType<typeof setInterval> | null
  recovering: boolean
  activityMessages: Map<string, { kind: "command" | "file"; text: string; messageId: string | null }>
}

interface PromptWaiter {
  header: string
  resolve: (value: string) => void
}

interface RuntimeBot {
  name: string
  config: BotConfig
  client: Client
  session: BotSessionState
  threadLoaded: boolean
  activeTurn: ActiveTurn | null
  promptWaiter: PromptWaiter | null
  dmPollTimer: ReturnType<typeof setInterval> | null
  inboundInFlightMessageIds: Set<string>
}

interface PendingApproval {
  requestId: string
  botName: string
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

const TURN_STALL_TIMEOUT_MS = 90_000
const INTERRUPT_TIMEOUT_MS = 5_000

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
    await removeBot(name)
  }

  async listBotsForCli() {
    const registry = await readRegistry()
    const entries = await Promise.all(
      listNamedBots(registry.bots).map(async bot => ({
        ...bot,
        session: await readBotSessionState(bot.name),
      })),
    )
    return {
      config: registry.config,
      entries,
    }
  }

  async resetThreadForCli(name: string) {
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
      runtime.activeTurn = null
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
        session: await this.normalizeRecoveredSession(name, await readBotSessionState(name)),
        threadLoaded: false,
        activeTurn: null,
        promptWaiter: null,
        dmPollTimer: null,
        inboundInFlightMessageIds: new Set(),
      }

      this.attachDiscordHandlers(runtime)
      await client.login(config.token)
      this.startDmPolling(runtime)
      this.bots.set(name, runtime)
      if (runtime.session.thread_id) {
        this.threadToBot.set(runtime.session.thread_id, name)
      }
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
      if (runtime.promptWaiter) {
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

      await this.startOrSteerTurn(runtime, message.content.trim())
      await this.markInboundProcessed(runtime, message.id)
    } finally {
      runtime.inboundInFlightMessageIds.delete(message.id)
    }
  }

  private async handleLocalCommand(runtime: RuntimeBot, message: Message) {
    const [command] = message.content.trim().split(/\s+/)

    switch (command) {
      case "!help":
        await message.reply(fitDiscordMessage("Commands: `!help`, `!status`, `!stop`, `!reset`"))
        return
      case "!status":
        await message.reply(
          renderStatusMessage({
            botName: runtime.name,
            label: runtime.config.label,
            threadId: runtime.session.thread_id,
            turnId: runtime.session.active_turn_id,
            status: runtime.session.last_status,
            project: runtime.config.project ?? this.registryConfig?.default_project ?? process.cwd(),
          }),
        )
        return
      case "!stop":
        if (!runtime.session.thread_id || !runtime.session.active_turn_id) {
          await message.reply(fitDiscordMessage("No active turn."))
          return
        }
        await this.codex.interruptTurn(runtime.session.thread_id, runtime.session.active_turn_id)
        await message.reply(fitDiscordMessage("Interrupt sent."))
        return
      case "!reset":
        await this.resetBotThread(runtime)
        await message.reply(fitDiscordMessage("Thread archived. The next message will start a fresh Codex thread."))
        return
      default:
        await message.reply(fitDiscordMessage("Unknown command."))
    }
  }

  private async startOrSteerTurn(runtime: RuntimeBot, text: string) {
    if (!text) return

    const threadId = await this.ensureThread(runtime)
    const channel = await this.getDmChannel(runtime)
    await channel.sendTyping().catch(() => {})

    if (runtime.activeTurn && runtime.session.active_turn_id) {
      if (this.isTurnStale(runtime)) {
        await this.recoverStalledTurn(runtime, "stale active turn detected before handling a new message", false)
      }
    }

    if (runtime.activeTurn && runtime.session.active_turn_id) {
      runtime.activeTurn.lastUserText = runtime.activeTurn.lastUserText
        ? `${runtime.activeTurn.lastUserText.trim()}\n\n${text}`
        : text
      runtime.activeTurn.lastActivityAt = Date.now()
      await this.codex.steerTurn({
        threadId,
        expectedTurnId: runtime.session.active_turn_id,
        input: [this.textInput(text)],
      })
      await this.logger.info(`steered turn ${runtime.session.active_turn_id} for ${runtime.name}`)
      return
    }

    const response = await this.codex.startTurn({
      threadId,
      input: [this.textInput(text)],
      model: runtime.config.model ?? this.registryConfig?.default_model ?? null,
      effort: runtime.config.effort ?? this.registryConfig?.default_effort ?? null,
    })

    runtime.activeTurn = {
      turnId: response.turn.id,
      planText: "",
      replyText: "",
      lastUserText: text,
      lastActivityAt: Date.now(),
      workingMessageId: null,
      flushTimer: null,
      typingTimer: this.startTypingLoop(runtime),
      recovering: false,
      activityMessages: new Map(),
    }
    runtime.session.active_turn_id = response.turn.id
    runtime.session.last_status = "running"
    await writeBotSessionState(runtime.name, runtime.session)
    await this.logger.info(`started turn ${response.turn.id} for ${runtime.name}`)
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
    this.clearActiveTurn(runtime)
    runtime.session = {
      thread_id: null,
      active_turn_id: null,
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
        await this.onDelta(notification.params as DeltaNotification, "reply")
        return
      case "item/plan/delta":
        await this.onDelta(notification.params as DeltaNotification, "plan")
        return
      case "item/commandExecution/outputDelta":
        await this.onActivityDelta(notification.params as DeltaNotification, "command")
        return
      case "item/fileChange/outputDelta":
        await this.onActivityDelta(notification.params as DeltaNotification, "file")
        return
      case "serverRequest/resolved":
        await this.disableApproval((notification.params as { requestId: JsonRpcId }).requestId)
        return
      case "thread/status/changed":
        {
          const threadId = (notification.params as { threadId: string }).threadId
          const runtime = this.findRuntimeByThreadId(threadId)
          if (runtime?.activeTurn) {
            runtime.activeTurn.lastActivityAt = Date.now()
          }
          await this.logger.info(`thread status changed ${threadId}`)
        }
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
      default:
        await this.codex.respondError(request.id, `Unsupported server request: ${request.method}`)
        const runtime = this.findRuntimeByUnknownRequest(request.params as any)
        if (runtime) {
          const channel = await this.getDmChannel(runtime)
          await channel.send(fitDiscordMessage(`Codex requested an unsupported capability: \`${request.method}\``))
        }
    }
  }

  private async handleCodexExit() {
    if (this.stopped) return
    await this.logger.warn("restarting Codex app-server")
    for (const runtime of this.bots.values()) {
      runtime.threadLoaded = false
      this.clearActiveTurn(runtime)
      runtime.session.active_turn_id = null
      runtime.session.last_status = "errored"
      await writeBotSessionState(runtime.name, runtime.session)
    }

    await new Promise(resolve => setTimeout(resolve, 2000))
    await this.codex.start()
  }

  private async onTurnStarted(threadId: string, turnId: string) {
    const runtime = this.findRuntimeByThreadId(threadId)
    if (!runtime) return
    if (!runtime.activeTurn) {
      runtime.activeTurn = {
        turnId,
        planText: "",
        replyText: "",
        lastUserText: "",
        lastActivityAt: Date.now(),
        workingMessageId: null,
        flushTimer: null,
        typingTimer: this.startTypingLoop(runtime),
        recovering: false,
        activityMessages: new Map(),
      }
    }
    runtime.activeTurn.lastActivityAt = Date.now()
    runtime.activeTurn.recovering = false
    runtime.session.active_turn_id = turnId
    runtime.session.last_status = "running"
    await writeBotSessionState(runtime.name, runtime.session)
  }

  private async onTurnCompleted(threadId: string, turn: { id: string; status: string; error?: { message?: string } | null }) {
    const runtime = this.findRuntimeByThreadId(threadId)
    if (!runtime) return

    runtime.session.active_turn_id = null
    runtime.session.last_status = turn.status === "failed" ? "errored" : "idle"
    await writeBotSessionState(runtime.name, runtime.session)

    if (runtime.activeTurn) {
      const completedTurn = runtime.activeTurn
      if (completedTurn.typingTimer) {
        clearInterval(completedTurn.typingTimer)
        completedTurn.typingTimer = null
      }
      const fullReply = completedTurn.replyText.trim()
      if (completedTurn.workingMessageId) {
        await this.flushWorkingMessage(runtime, true)
      } else if (fullReply) {
        const channel = await this.getDmChannel(runtime)
        const chunks = chunkText(fullReply)
        if (chunks.length > 0) {
          const first = await channel.send(chunks[0]!)
          runtime.session.last_working_message_id = first.id
          await writeBotSessionState(runtime.name, runtime.session)
          for (const chunk of chunks.slice(1)) {
            await channel.send(chunk)
          }
        }
      }
      const chunks = chunkText(fullReply)
      if (completedTurn.workingMessageId && chunks.length > 1) {
        const channel = await this.getDmChannel(runtime)
        for (const chunk of chunks.slice(1)) {
          await channel.send(chunk)
        }
      }
      if (completedTurn.lastUserText.trim() || fullReply) {
        await appendMemoryJournal(runtime.name, {
          user: completedTurn.lastUserText,
          assistant: fullReply,
        })
      }
      runtime.activeTurn = null
    }

    if (turn.status === "failed") {
      const channel = await this.getDmChannel(runtime)
      for (const chunk of chunkText(`Turn failed${turn.error?.message ? `: ${turn.error.message}` : "."}`)) {
        await channel.send(chunk)
      }
    }
  }

  private async onDelta(notification: DeltaNotification, kind: "plan" | "reply") {
    const runtime = this.findRuntimeByThreadId(notification.threadId)
    if (!runtime?.activeTurn) return

    if (kind === "plan") {
      runtime.activeTurn.planText += notification.delta
    } else {
      runtime.activeTurn.replyText += notification.delta
    }
    runtime.activeTurn.lastActivityAt = Date.now()
    this.scheduleFlush(runtime)
  }

  private async onActivityDelta(notification: DeltaNotification, kind: "command" | "file") {
    const runtime = this.findRuntimeByThreadId(notification.threadId)
    if (!runtime?.activeTurn) return

    const current = runtime.activeTurn.activityMessages.get(notification.itemId) ?? {
      kind,
      text: "",
      messageId: null,
    }
    current.text += notification.delta
    runtime.activeTurn.activityMessages.set(notification.itemId, current)
    runtime.activeTurn.lastActivityAt = Date.now()
    this.scheduleFlush(runtime)
  }

  private scheduleFlush(runtime: RuntimeBot) {
    if (!runtime.activeTurn) return
    if (runtime.activeTurn.flushTimer) return
    runtime.activeTurn.flushTimer = setTimeout(() => {
      void this.emitProgressHint(runtime)
    }, 750)
  }

  private async flushWorkingMessage(runtime: RuntimeBot, final = false) {
    if (!runtime.activeTurn) return
    if (runtime.activeTurn.flushTimer) {
      clearTimeout(runtime.activeTurn.flushTimer)
      runtime.activeTurn.flushTimer = null
    }

    const activeTurn = runtime.activeTurn
    if (!activeTurn.workingMessageId) {
      return
    }

    const working = await this.getOrCreateWorkingMessage(runtime)
    if (!runtime.activeTurn || runtime.activeTurn.turnId !== activeTurn.turnId) {
      return
    }

    const content = renderWorkingMessage(activeTurn.planText, activeTurn.replyText)
    await working.edit(fitDiscordMessage(content))

    if (final) {
      runtime.session.last_working_message_id = working.id
      await writeBotSessionState(runtime.name, runtime.session)
    }
  }

  private async getOrCreateWorkingMessage(runtime: RuntimeBot) {
    const channel = await this.getDmChannel(runtime)
    const existingId = runtime.activeTurn?.workingMessageId ?? null
    if (existingId) {
      const existing = await channel.messages.fetch(existingId).catch(() => null)
      if (existing) {
        return existing
      }
    }

    const created = await channel.send("_Working..._")
    if (runtime.activeTurn) {
      runtime.activeTurn.workingMessageId = created.id
    }
    runtime.session.last_working_message_id = created.id
    await writeBotSessionState(runtime.name, runtime.session)
    return created
  }

  private startTypingLoop(runtime: RuntimeBot) {
    const timer = setInterval(() => {
      void this.emitProgressHint(runtime)
    }, 4000)

    return timer
  }

  private async emitProgressHint(runtime: RuntimeBot) {
    if (!runtime.activeTurn) return
    if (this.isTurnStale(runtime)) {
      await this.recoverStalledTurn(runtime, `no Codex activity for ${Math.round(TURN_STALL_TIMEOUT_MS / 1000)} seconds`, true)
      return
    }
    if (runtime.activeTurn.flushTimer) {
      clearTimeout(runtime.activeTurn.flushTimer)
      runtime.activeTurn.flushTimer = null
    }

    const channel = await this.getDmChannel(runtime).catch(() => null)
    if (!channel) return
    await channel.sendTyping().catch(() => {})
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
    if (!runtime) {
      await this.respondToApproval(requestId, "cancel", legacy, "approval target not found", {
        approvalId: "approvalId" in params ? params.approvalId ?? null : null,
      })
      return
    }

    runtime.session.last_status = "waiting_approval"
    await writeBotSessionState(runtime.name, runtime.session)
    if (runtime.activeTurn) {
      runtime.activeTurn.lastActivityAt = Date.now()
    }

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

    const runtime = this.bots.get(pending.botName)
    if (!runtime) {
      await this.disableApproval(requestId, "_Timed out._")
      return
    }

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
    if (!runtime) return

    const channel = await this.getDmChannel(runtime)
    const message = await channel.messages.fetch(pending.discordMessageId).catch(() => null)
    if (!message) return

    await message.edit({ content: appendDiscordSuffix(message.content, suffix), components: [] })
    runtime.session.last_status = runtime.session.active_turn_id ? "running" : "idle"
    await writeBotSessionState(runtime.name, runtime.session)
  }

  private async handleUserInputRequest(requestId: JsonRpcId, params: { threadId: string; questions: ToolRequestUserInputQuestion[] }) {
    const runtime = this.findRuntimeByThreadId(params.threadId)
    if (!runtime) {
      await this.codex.respondError(requestId, "Unknown thread for user input request")
      return
    }

    const answers: Record<string, { answers: string[] }> = {}
    for (const question of params.questions) {
      if (runtime.activeTurn) {
        runtime.activeTurn.lastActivityAt = Date.now()
      }
      const answer = await this.askQuestion(runtime, question)
      answers[question.id] = { answers: [answer] }
    }

    await this.codex.respond(requestId, { answers })
  }

  private async askQuestion(runtime: RuntimeBot, question: ToolRequestUserInputQuestion) {
    const channel = await this.getDmChannel(runtime)
    const options = (question.options ?? []).map(option => `${option.label} — ${option.description}`)
    await channel.send(renderQuestionPrompt(question.header, question.question, options))

    return new Promise<string>(resolve => {
      runtime.promptWaiter = {
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

  private findRuntimeByUnknownRequest(params: any) {
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
    if (!channel) return

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

  private clearActiveTurn(runtime: RuntimeBot) {
    if (runtime.activeTurn?.flushTimer) {
      clearTimeout(runtime.activeTurn.flushTimer)
    }
    if (runtime.activeTurn?.typingTimer) {
      clearInterval(runtime.activeTurn.typingTimer)
    }
    runtime.activeTurn = null
  }

  private isTurnStale(runtime: RuntimeBot) {
    if (!runtime.activeTurn) return false
    if (runtime.promptWaiter) return false
    if (runtime.session.last_status === "waiting_approval") return false
    return Date.now() - runtime.activeTurn.lastActivityAt >= TURN_STALL_TIMEOUT_MS
  }

  private async recoverStalledTurn(runtime: RuntimeBot, reason: string, notifyUser: boolean) {
    const activeTurn = runtime.activeTurn
    if (!activeTurn || activeTurn.recovering) {
      return false
    }

    activeTurn.recovering = true
    await this.logger.warn(`recovering stalled turn ${activeTurn.turnId} for ${runtime.name}: ${reason}`)

    let restartedCodex = false
    if (runtime.session.thread_id && runtime.session.active_turn_id) {
      try {
        await Promise.race([
          this.codex.interruptTurn(runtime.session.thread_id, runtime.session.active_turn_id),
          new Promise((_, reject) => setTimeout(() => reject(new Error("interrupt timeout")), INTERRUPT_TIMEOUT_MS)),
        ])
      } catch (error) {
        await this.logger.warn(`interrupt failed for stalled turn ${activeTurn.turnId}: ${String(error)}`)
        if (this.codex.isRunning()) {
          restartedCodex = true
          await this.codex.stop()
        }
      }
    }

    this.clearActiveTurn(runtime)
    runtime.threadLoaded = runtime.session.thread_id ? !restartedCodex : false
    runtime.session.active_turn_id = null
    runtime.session.last_status = restartedCodex ? "errored" : "idle"
    await writeBotSessionState(runtime.name, runtime.session)

    if (notifyUser) {
      const channel = await this.getDmChannel(runtime).catch(() => null)
      if (channel) {
        await channel.send(fitDiscordMessage("I got stuck on the last turn and reset myself. Send that again."))
      }
    }

    return true
  }

  private teardownRuntime(runtime: RuntimeBot) {
    if (runtime.dmPollTimer) {
      clearInterval(runtime.dmPollTimer)
      runtime.dmPollTimer = null
    }
    this.clearActiveTurn(runtime)
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

  private async normalizeRecoveredSession(name: string, session: BotSessionState) {
    if (!session.active_turn_id && session.last_status !== "running" && session.last_status !== "waiting_approval") {
      return session
    }

    const normalized: BotSessionState = {
      ...session,
      active_turn_id: null,
      last_status: "idle",
      updated_at: new Date().toISOString(),
    }
    await writeBotSessionState(name, normalized)
    return normalized
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
