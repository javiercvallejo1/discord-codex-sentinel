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
  "errored",
])

export const botSessionStateSchema = z.object({
  thread_id: z.string().nullable().default(null),
  active_turn_id: z.string().nullable().default(null),
  last_discord_channel_id: z.string().nullable().default(null),
  last_working_message_id: z.string().nullable().default(null),
  last_status: sessionStatusSchema.default("idle"),
  updated_at: z.string().default(() => new Date().toISOString()),
})

export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>
export type SandboxMode = z.infer<typeof sandboxModeSchema>
export type Effort = z.infer<typeof effortSchema>
export type BotConfig = z.infer<typeof botConfigSchema>
export type RegistryConfig = z.infer<typeof registryConfigSchema>
export type RegistryFile = z.infer<typeof registrySchema>
export type SessionStatus = z.infer<typeof sessionStatusSchema>
export type BotSessionState = z.infer<typeof botSessionStateSchema>

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

