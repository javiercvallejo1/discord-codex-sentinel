import { z } from "zod"

export const approvalPolicySchema = z.enum([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
])

export const sandboxModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
])

export const effortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
])

export const botConfigSchema = z.object({
  token: z.string().min(1),
  label: z.string().min(1),
  project: z.string().optional(),
  model: z.string().optional(),
  effort: effortSchema.optional(),
  approval_policy: approvalPolicySchema.optional(),
  sandbox_mode: sandboxModeSchema.optional(),
})

export const registryConfigSchema = z.object({
  owner_id: z.string().default(""),
  default_project: z.string().default(process.cwd()),
  codex_bin: z.string().default("codex"),
  default_model: z.string().nullable().default(null),
  default_effort: effortSchema.nullable().default(null),
  default_approval_policy: approvalPolicySchema.default("on-request"),
  default_sandbox_mode: sandboxModeSchema.default("workspace-write"),
  approval_timeout_sec: z.number().int().positive().default(120),
})

export const registrySchema = z.object({
  _config: registryConfigSchema,
}).catchall(botConfigSchema)

export const sessionStatusSchema = z.enum([
  "idle",
  "running",
  "waiting_approval",
  "waiting_input",
  "errored",
])

export const botSessionStateSchema = z.object({
  thread_id: z.string().nullable().default(null),
  active_turn_id: z.string().nullable().default(null),
  active_job_id: z.string().nullable().default(null),
  last_discord_channel_id: z.string().nullable().default(null),
  last_inbound_message_id: z.string().nullable().default(null),
  last_working_message_id: z.string().nullable().default(null),
  last_status: sessionStatusSchema.default("idle"),
  updated_at: z.string().default(() => new Date().toISOString()),
})

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
])

export const jobWaitingKindSchema = z.enum([
  "approval",
  "input",
])

export const jobArtifactSchema = z.object({
  branch: z.string().nullable().default(null),
  commit: z.string().nullable().default(null),
  pr_url: z.string().nullable().default(null),
  artifact_links: z.array(z.string()).default([]),
})

export const jobRecordSchema = z.object({
  id: z.string().min(1),
  bot_name: z.string().min(1),
  channel_id: z.string().min(1),
  request_message_ids: z.array(z.string()).default([]),
  status: jobStatusSchema.default("queued"),
  thread_id: z.string().nullable().default(null),
  turn_id: z.string().nullable().default(null),
  input_text: z.string().default(""),
  created_at: z.string().default(() => new Date().toISOString()),
  started_at: z.string().nullable().default(null),
  finished_at: z.string().nullable().default(null),
  waiting_kind: jobWaitingKindSchema.nullable().default(null),
  approval_request_id: z.string().nullable().default(null),
  result_summary: z.string().nullable().default(null),
  final_reply: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  cancel_requested: z.boolean().default(false),
  steer_events: z.array(z.object({
    message_id: z.string(),
    text: z.string(),
    created_at: z.string(),
  })).default([]),
  artifacts: jobArtifactSchema.default({}),
})

export const jobQueueSchema = z.object({
  bot_name: z.string().min(1),
  active_job_id: z.string().nullable().default(null),
  pending_job_ids: z.array(z.string()).default([]),
})

export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>
export type SandboxMode = z.infer<typeof sandboxModeSchema>
export type Effort = z.infer<typeof effortSchema>
export type BotConfig = z.infer<typeof botConfigSchema>
export type RegistryConfig = z.infer<typeof registryConfigSchema>
export type RegistryFile = z.infer<typeof registrySchema>
export type SessionStatus = z.infer<typeof sessionStatusSchema>
export type BotSessionState = z.infer<typeof botSessionStateSchema>
export type JobStatus = z.infer<typeof jobStatusSchema>
export type JobRecord = z.infer<typeof jobRecordSchema>
export type JobQueueState = z.infer<typeof jobQueueSchema>

export interface NamedBot {
  name: string
  config: BotConfig
}

export const DEFAULT_PERSONALITY = `# Discord Codex Assistant

You are a trustworthy coding assistant operating through Discord.

- Be concise and explicit.
- State risky actions before asking for approval.
- Prefer concrete next steps over long explanations.
- Assume the human is reading from chat and keep updates compact.
`

export const DEFAULT_MEMORY = `# Durable Memory

Use this file for stable cross-session memory for this bot.

## Preferences

- None recorded yet.

## Important Facts

- None recorded yet.

## Active Context

- None recorded yet.
`
