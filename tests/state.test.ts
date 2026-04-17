import { describe, expect, test } from "bun:test"
import { listNamedBots } from "../src/state/store"
import { botSessionStateSchema } from "../src/state/types"
import {
  appendDiscordSuffix,
  chunkText,
  fitDiscordMessage,
  MAX_DISCORD_MESSAGE,
  renderWorkingMessage,
} from "../src/ui/discord/renderer"

describe("state helpers", () => {
  test("listNamedBots sorts by name", () => {
    const result = listNamedBots({
      zebra: { token: "1", label: "Zebra" },
      alpha: { token: "2", label: "Alpha" },
    })

    expect(result.map(entry => entry.name)).toEqual(["alpha", "zebra"])
  })
})

describe("renderer helpers", () => {
  test("chunkText splits long content", () => {
    const chunks = chunkText("a".repeat(MAX_DISCORD_MESSAGE * 3))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.length <= MAX_DISCORD_MESSAGE)).toBe(true)
  })

  test("renderWorkingMessage prefers natural reply text", () => {
    const rendered = renderWorkingMessage("Do work", "Done")
    expect(rendered).toBe("Done")
  })

  test("fitDiscordMessage truncates oversized content", () => {
    const rendered = fitDiscordMessage("a".repeat(MAX_DISCORD_MESSAGE + 500))
    expect(rendered.length).toBeLessThanOrEqual(MAX_DISCORD_MESSAGE)
  })

  test("appendDiscordSuffix keeps edited content within Discord limit", () => {
    const rendered = appendDiscordSuffix("a".repeat(MAX_DISCORD_MESSAGE), "_Resolved._")
    expect(rendered.length).toBeLessThanOrEqual(MAX_DISCORD_MESSAGE)
    expect(rendered.endsWith("_Resolved._")).toBe(true)
  })
})

describe("session state schema", () => {
  test("defaults include last inbound message tracking", () => {
    const state = botSessionStateSchema.parse({})
    expect(state.last_inbound_message_id).toBeNull()
    expect(state.active_job_id).toBeNull()
  })
})
