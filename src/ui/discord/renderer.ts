import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js"

export const MAX_DISCORD_MESSAGE = 1900
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel"

function truncateForDiscord(text: string, size = MAX_DISCORD_MESSAGE) {
  const trimmed = text.trim()
  if (trimmed.length <= size) {
    return trimmed
  }

  const suffix = "\n\n_(truncated)_"
  const budget = Math.max(0, size - suffix.length)
  return `${trimmed.slice(0, budget).trimEnd()}${suffix}`
}

export function fitDiscordMessage(text: string, size = MAX_DISCORD_MESSAGE) {
  return truncateForDiscord(text, size)
}

export function appendDiscordSuffix(
  text: string,
  suffix: string,
  size = MAX_DISCORD_MESSAGE,
) {
  const normalizedBase = text.trim()
  const normalizedSuffix = suffix.trim()
  const combined = normalizedBase
    ? `${normalizedBase}\n\n${normalizedSuffix}`
    : normalizedSuffix

  if (combined.length <= size) {
    return combined
  }

  if (normalizedSuffix.length >= size) {
    return truncateForDiscord(normalizedSuffix, size)
  }

  const available = size - normalizedSuffix.length - 2
  const base = truncateForDiscord(normalizedBase, available)
  return `${base}\n\n${normalizedSuffix}`
}

export function renderWorkingMessage(plan: string, reply: string) {
  if (reply.trim()) {
    return fitDiscordMessage(reply)
  }

  if (plan.trim()) {
    return "_Thinking..._"
  }

  return "_Thinking..._"
}

export function chunkText(text: string, size = MAX_DISCORD_MESSAGE) {
  if (!text.trim()) {
    return []
  }

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > size) {
    let split = remaining.lastIndexOf("\n", size)
    if (split < size / 2) {
      split = size
    }
    chunks.push(remaining.slice(0, split))
    remaining = remaining.slice(split).trimStart()
  }

  if (remaining) {
    chunks.push(remaining)
  }

  return chunks
}

export function renderStatusMessage(input: {
  botName: string
  label: string
  threadId: string | null
  turnId: string | null
  status: string
  project: string
}) {
  return fitDiscordMessage([
    `**${input.label}** (\`${input.botName}\`)`,
    `Status: \`${input.status}\``,
    `Project: \`${input.project}\``,
    `Thread: ${input.threadId ? `\`${input.threadId}\`` : "_none_"}`,
    `Active turn: ${input.turnId ? `\`${input.turnId}\`` : "_none_"}`,
  ].join("\n"))
}

export function renderQuestionPrompt(header: string, question: string, options: string[]) {
  const optionBlock = options.length
    ? `\n\nOptions:\n${options.map((option, index) => `${index + 1}. ${option}`).join("\n")}`
    : ""
  return fitDiscordMessage(`**${header}**\n${question}${optionBlock}`)
}

export function renderApprovalText(input: {
  kind: "command" | "file"
  reason?: string | null
  command?: string | null
  cwd?: string | null
  grantRoot?: string | null
}) {
  const lines = [`**Approval required**`, `Kind: \`${input.kind}\``]
  if (input.reason) lines.push(`Reason: ${input.reason}`)
  if (input.command) lines.push(`Command:\n\`\`\`\n${input.command.slice(0, 1200)}\n\`\`\``)
  if (input.cwd) lines.push(`Cwd: \`${input.cwd}\``)
  if (input.grantRoot) lines.push(`Grant root: \`${input.grantRoot}\``)
  return fitDiscordMessage(lines.join("\n"))
}

export function buildApprovalButtons(
  requestId: string,
  availableDecisions: ApprovalDecision[] = ["accept", "acceptForSession", "decline", "cancel"],
  disabled = false,
) {
  const buttons: ButtonBuilder[] = []

  if (availableDecisions.includes("accept")) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`approval:${requestId}:accept`)
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
    )
  }

  if (availableDecisions.includes("acceptForSession")) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`approval:${requestId}:acceptForSession`)
        .setLabel("Accept Session")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    )
  }

  if (availableDecisions.includes("decline")) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`approval:${requestId}:decline`)
        .setLabel("Decline")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    )
  }
  if (availableDecisions.includes("cancel")) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`approval:${requestId}:cancel`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    )
  }

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)]
}
