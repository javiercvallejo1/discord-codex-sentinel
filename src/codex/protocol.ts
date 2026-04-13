import type { ApprovalPolicy, Effort, SandboxMode } from "../state/types"

export type JsonRpcId = string | number

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0"
  id: JsonRpcId
  method: string
  params?: T
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc?: "2.0"
  id: JsonRpcId
  result: T
}

export interface JsonRpcFailure {
  jsonrpc?: "2.0"
  id: JsonRpcId
  error: {
    code: number
    message: string
    data?: unknown
  }
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc?: "2.0"
  method: string
  params: T
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcSuccess
  | JsonRpcFailure
  | JsonRpcNotification

export interface InitializeResponse {
  userAgent: string
  platformFamily: string
  platformOs: string
}

export interface ModelInfo {
  id: string
  model: string
  displayName: string
  isDefault: boolean
  hidden: boolean
  defaultReasoningEffort: string
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
}

export interface ModelListResponse {
  data: ModelInfo[]
  nextCursor?: string | null
}

export interface ConfigReadResponse {
  config: Record<string, unknown>
  origins: Record<string, unknown>
  layers?: unknown[] | null
}

export interface ConfigRequirementsResponse {
  requirements?: {
    allowedApprovalPolicies?: ApprovalPolicy[] | null
    allowedSandboxModes?: SandboxMode[] | null
    allowedWebSearchModes?: string[] | null
  } | null
}

export interface ThreadDescriptor {
  id: string
  preview: string
  cwd: string
  name?: string | null
  path?: string | null
}

export interface TurnDescriptor {
  id: string
  status: "completed" | "interrupted" | "failed" | "inProgress"
  error?: {
    message?: string
  } | null
}

export interface ThreadStartResponse {
  thread: ThreadDescriptor
  model: string
  modelProvider: string
  cwd: string
  approvalPolicy: ApprovalPolicy | { granular: Record<string, boolean> }
  sandbox: unknown
  reasoningEffort?: string | null
}

export type ThreadResumeResponse = ThreadStartResponse

export interface TurnStartResponse {
  turn: TurnDescriptor
}

export interface TurnSteerResponse {
  turnId: string
}

export interface StartThreadParams {
  cwd: string
  model?: string | null
  approvalPolicy: ApprovalPolicy
  sandbox: SandboxMode
  baseInstructions: string
  developerInstructions: string
  personality: "pragmatic"
}

export interface ResumeThreadParams extends StartThreadParams {
  threadId: string
}

export interface TurnTextInput {
  type: "text"
  text: string
  text_elements: unknown[]
}

export interface TurnStartParams {
  threadId: string
  input: TurnTextInput[]
  model?: string | null
  effort?: Effort | null
}

export interface TurnSteerParams {
  threadId: string
  expectedTurnId: string
  input: TurnTextInput[]
}

export interface CommandExecutionApprovalRequest {
  threadId: string
  turnId: string
  itemId: string
  approvalId?: string | null
  reason?: string | null
  command?: string | null
  cwd?: string | null
  availableDecisions?: Array<
    | "accept"
    | "acceptForSession"
    | "decline"
    | "cancel"
    | Record<string, unknown>
  > | null
}

export interface FileChangeApprovalRequest {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
  grantRoot?: string | null
}

export interface ToolRequestUserInputQuestion {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: Array<{ label: string; description: string }> | null
}

export interface ToolRequestUserInputRequest {
  threadId: string
  turnId: string
  itemId: string
  questions: ToolRequestUserInputQuestion[]
}

export interface LegacyExecApprovalRequest {
  conversationId: string
  approvalId?: string | null
  command: string[]
  cwd: string
  reason?: string | null
}

export interface LegacyPatchApprovalRequest {
  conversationId: string
  callId: string
  reason?: string | null
  grantRoot?: string | null
}

export interface TurnStartedNotification {
  threadId: string
  turn: TurnDescriptor
}

export interface TurnCompletedNotification {
  threadId: string
  turn: TurnDescriptor
}

export interface DeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface ServerRequestResolvedNotification {
  threadId: string
  requestId: JsonRpcId
}

export interface ThreadStatusChangedNotification {
  threadId: string
  status: unknown
}

export type SupportedServerRequest =
  | {
      method: "item/commandExecution/requestApproval"
      id: JsonRpcId
      params: CommandExecutionApprovalRequest
    }
  | {
      method: "item/fileChange/requestApproval"
      id: JsonRpcId
      params: FileChangeApprovalRequest
    }
  | {
      method: "item/tool/requestUserInput"
      id: JsonRpcId
      params: ToolRequestUserInputRequest
    }
  | {
      method: "execCommandApproval"
      id: JsonRpcId
      params: LegacyExecApprovalRequest
    }
  | {
      method: "applyPatchApproval"
      id: JsonRpcId
      params: LegacyPatchApprovalRequest
    }
  | {
      method: string
      id: JsonRpcId
      params: Record<string, unknown>
    }

export type SupportedNotification =
  | { method: "turn/started"; params: TurnStartedNotification }
  | { method: "turn/completed"; params: TurnCompletedNotification }
  | { method: "item/agentMessage/delta"; params: DeltaNotification }
  | { method: "item/plan/delta"; params: DeltaNotification }
  | { method: "item/commandExecution/outputDelta"; params: DeltaNotification }
  | { method: "item/fileChange/outputDelta"; params: DeltaNotification }
  | { method: "serverRequest/resolved"; params: ServerRequestResolvedNotification }
  | { method: "thread/status/changed"; params: ThreadStatusChangedNotification }
  | { method: string; params: Record<string, unknown> }
