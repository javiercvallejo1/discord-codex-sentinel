import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js"

const MAX_DISCORD_MESSAGE = 3500

export function renderWorkingMessage(plan: string, reply: string) {
  if (reply.trim()) {
    if (reply.length <= MAX_DISCORD_MESSAGE) {
      return reply.trim()
    }
    return `${reply.trim().slice(0, MAX_DISCORD_MESSAGE - 18)}\n\n_(truncated)_`
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
  return [
    `**${input.label}** (\`${input.botName}\`)`,
    `Status: \`${input.status}\``,
    `Project: \`${input.project}\``,
    `Thread: ${input.threadId ? `\`${input.threadId}\`` : "_none_"}`,
    `Active turn: ${input.turnId ? `\`${input.turnId}\`` : "_none_"}`,
  ].join("\n")
}

export function renderQuestionPrompt(header: string, question: string, options: string[]) {
  const optionBlock = options.length
    ? `\n\nOptions:\n${options.map((option, index) => `${index + 1}. ${option}`).join("\n")}`
    : ""
  return `**${header}**\n${question}${optionBlock}`
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
  return lines.join("\n")
}

export function buildApprovalButtons(
  requestId: string,
  includeSession = true,
  disabled = false,
) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`approval:${requestId}:accept`)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  ]

  if (includeSession) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`approval:${requestId}:acceptForSession`)
        .setLabel("Accept Session")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    )
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(`approval:${requestId}:decline`)
      .setLabel("Decline")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  )
  buttons.push(
    new ButtonBuilder()
      .setCustomId(`approval:${requestId}:cancel`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  )

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)]
}
