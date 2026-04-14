import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process"
import { createInterface } from "node:readline"
import { EventEmitter } from "node:events"
import { Logger } from "../state/logger"
import type {
  ConfigReadResponse,
  ConfigRequirementsResponse,
  InitializeResponse,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccess,
  ModelListResponse,
  ResumeThreadParams,
  StartThreadParams,
  SupportedNotification,
  SupportedServerRequest,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "./protocol"

interface PendingRequest {
  resolve: (value: any) => void
  reject: (error: Error) => void
}

export class CodexAppServerClient extends EventEmitter {
  private readonly logger: Logger
  private readonly codexBin: string
  private child: ChildProcessWithoutNullStreams | null = null
  private requestId = 0
  private readonly pending = new Map<JsonRpcId, PendingRequest>()

  constructor(codexBin: string, logger: Logger) {
    super()
    this.codexBin = codexBin
    this.logger = logger.child("codex")
  }

  async start() {
    if (this.child) {
      return
    }

    const args = this.getAppServerArgs()
    this.child = spawn(
      this.codexBin,
      args,
      {
        stdio: "pipe",
      },
    )

    this.child.once("exit", (code, signal) => {
      void this.logger.warn(`app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`)
      this.child = null
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(`Codex app-server exited while request ${String(id)} was pending`))
      }
      this.pending.clear()
      this.emit("exit", { code, signal })
    })

    const stdout = createInterface({ input: this.child.stdout })
    stdout.on("line", line => {
      if (!line.trim()) return
      try {
        const message = JSON.parse(line) as JsonRpcMessage
        this.handleMessage(message)
      } catch (error) {
        void this.logger.error(`failed to parse stdout line: ${String(error)}`)
      }
    })

    const stderr = createInterface({ input: this.child.stderr })
    stderr.on("line", line => {
      void this.logger.info(`stderr: ${line}`)
    })

    const init = await this.request<InitializeResponse>("initialize", {
      clientInfo: {
        name: "discord-codex-sentinel",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    })
    void this.logger.info(`initialized app-server (${init.userAgent})`)
  }

  async stop() {
    if (!this.child) return
    this.child.kill("SIGTERM")
    this.child = null
  }

  isRunning() {
    return this.child !== null
  }

  async modelList() {
    return this.request<ModelListResponse>("model/list", {})
  }

  async configRead() {
    return this.request<ConfigReadResponse>("config/read", {})
  }

  async configRequirementsRead() {
    return this.request<ConfigRequirementsResponse>("configRequirements/read", undefined)
  }

  async startThread(params: StartThreadParams) {
    return this.request<ThreadStartResponse>("thread/start", params)
  }

  async resumeThread(params: ResumeThreadParams) {
    return this.request<ThreadResumeResponse>("thread/resume", params)
  }

  async setThreadName(threadId: string, name: string) {
    return this.request("thread/name/set", { threadId, name })
  }

  async archiveThread(threadId: string) {
    return this.request("thread/archive", { threadId })
  }

  async startTurn(params: TurnStartParams) {
    return this.request<TurnStartResponse>("turn/start", params)
  }

  async steerTurn(params: TurnSteerParams) {
    return this.request<TurnSteerResponse>("turn/steer", params)
  }

  async interruptTurn(threadId: string, turnId: string) {
    return this.request("turn/interrupt", { threadId, turnId })
  }

  async respond(requestId: JsonRpcId, result: unknown) {
    this.write({
      jsonrpc: "2.0",
      id: requestId,
      result,
    })
  }

  async respondError(requestId: JsonRpcId, message: string, code = -32601) {
    this.write({
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code,
        message,
      },
    })
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    if (!this.child) {
      throw new Error("Codex app-server is not running")
    }

    const id = ++this.requestId
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
    }
    if (params !== undefined) {
      payload.params = params
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: any) => void, reject })
      this.write(payload)
    })
  }

  private write(payload: object) {
    if (!this.child) {
      throw new Error("Codex app-server is not running")
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private handleMessage(message: JsonRpcMessage) {
    if ("method" in message && "id" in message) {
      this.emit("serverRequest", message as SupportedServerRequest)
      return
    }

    if ("method" in message) {
      this.emit("notification", message as SupportedNotification)
      return
    }

    if ("result" in message) {
      this.resolvePending(message as JsonRpcSuccess)
      return
    }

    if ("error" in message) {
      this.rejectPending(message as JsonRpcFailure)
    }
  }

  private resolvePending(message: JsonRpcSuccess) {
    const pending = this.pending.get(message.id)
    if (!pending) {
      return
    }
    this.pending.delete(message.id)
    pending.resolve(message.result)
  }

  private rejectPending(message: JsonRpcFailure) {
    const pending = this.pending.get(message.id)
    if (!pending) {
      return
    }
    this.pending.delete(message.id)
    pending.reject(new Error(message.error.message))
  }

  private getAppServerArgs() {
    const args = ["app-server", "--listen", "stdio://"]

    if (this.supportsSessionSourceFlag()) {
      args.push("--session-source", "cli")
    } else {
      void this.logger.warn("app-server does not advertise --session-source; starting without it")
    }

    return args
  }

  private supportsSessionSourceFlag() {
    try {
      const help = execFileSync(this.codexBin, ["app-server", "--help"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      return help.includes("--session-source")
    } catch {
      return true
    }
  }
}
