import { describe, expect, test } from "bun:test"
import { listNamedBots } from "../src/state/store"
import { chunkText, renderWorkingMessage } from "../src/ui/discord/renderer"

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
    const chunks = chunkText("a".repeat(8000), 3500)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.length <= 3500)).toBe(true)
  })

  test("renderWorkingMessage prefers natural reply text", () => {
    const rendered = renderWorkingMessage("Do work", "Done")
    expect(rendered).toBe("Done")
  })
})
