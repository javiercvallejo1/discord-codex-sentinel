import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "..")
const decoder = new TextDecoder()
const tempHomes: string[] = []

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

describe("store integration", () => {
  test("adding a bot creates personality and durable memory files", async () => {
    const home = await mkdtemp(join(tmpdir(), "discord-codex-sentinel-"))
    tempHomes.push(home)

    const script = `
      const store = await import(${JSON.stringify(resolve(repoRoot, "src/state/store.ts"))})
      await store.addBot("test-bot", { token: "token", label: "Test Bot", project: "/tmp/project" })
      const memory = await store.readMemory("test-bot")
      const journal = await store.readMemoryJournal("test-bot")
      console.log(JSON.stringify({ memory, journal }))
    `

    const result = Bun.spawnSync({
      cmd: ["bun", "-e", script],
      env: {
        ...process.env,
        HOME: home,
      },
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(decoder.decode(result.stdout))
    expect(payload.memory).toContain("# Durable Memory")
    expect(payload.journal).toBe("")
  })

  test("memory journal appends completed turn history", async () => {
    const home = await mkdtemp(join(tmpdir(), "discord-codex-sentinel-"))
    tempHomes.push(home)

    const script = `
      const store = await import(${JSON.stringify(resolve(repoRoot, "src/state/store.ts"))})
      await store.addBot("journal-bot", { token: "token", label: "Journal Bot", project: "/tmp/project" })
      await store.appendMemoryJournal("journal-bot", { user: "Hello", assistant: "Hi there" })
      console.log(JSON.stringify({ journal: await store.readMemoryJournal("journal-bot") }))
    `

    const result = Bun.spawnSync({
      cmd: ["bun", "-e", script],
      env: {
        ...process.env,
        HOME: home,
      },
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(decoder.decode(result.stdout))
    expect(payload.journal).toContain("### User")
    expect(payload.journal).toContain("Hello")
    expect(payload.journal).toContain("### Assistant")
    expect(payload.journal).toContain("Hi there")
  })

  test("jobs and queue state persist for a bot", async () => {
    const home = await mkdtemp(join(tmpdir(), "discord-codex-sentinel-"))
    tempHomes.push(home)

    const script = `
      const store = await import(${JSON.stringify(resolve(repoRoot, "src/state/store.ts"))})
      await store.addBot("queue-bot", { token: "token", label: "Queue Bot", project: "/tmp/project" })
      const job = await store.createJob({
        botName: "queue-bot",
        channelId: "123",
        inputText: "Do the thing",
        requestMessageId: "456",
      })
      const queue = await store.readJobQueue("queue-bot")
      queue.pending_job_ids.push(job.id)
      await store.writeJobQueue(queue)
      console.log(JSON.stringify({
        job: await store.readJob(job.id),
        queue: await store.readJobQueue("queue-bot"),
      }))
    `

    const result = Bun.spawnSync({
      cmd: ["bun", "-e", script],
      env: {
        ...process.env,
        HOME: home,
      },
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(decoder.decode(result.stdout))
    expect(payload.job.bot_name).toBe("queue-bot")
    expect(payload.job.status).toBe("queued")
    expect(payload.queue.pending_job_ids).toContain(payload.job.id)
  })
})
