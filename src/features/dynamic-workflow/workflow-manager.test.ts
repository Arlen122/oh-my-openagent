import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkflowManager } from "./workflow-manager"
import type { BackgroundManager } from "../background-agent"
import type { PluginInput } from "@opencode-ai/plugin"
import { hashWorkflowScript, readWorkflowCheckpoint, writeWorkflowCheckpoint, createInitialCheckpoint } from "./workflow-checkpoint"

type OpencodeClient = PluginInput["client"]

interface FakeTask {
  id: string
  sessionID?: string
  status: string
}

function createFakeBackgroundManager(options?: {
  failTask?: boolean
}): { manager: BackgroundManager; launched: FakeTask[] } {
  const launched: FakeTask[] = []
  let counter = 0
  const manager = {
    async launch(input: { description: string }) {
      counter++
      const task: FakeTask = {
        id: `bg_${counter}`,
        sessionID: `ses_${counter}`,
        status: options?.failTask ? "error" : "completed",
      }
      launched.push(task)
      return { ...task, description: input.description }
    },
    getTask(id: string) {
      return launched.find((task) => task.id === id)
    },
    async cancelTask() {
      return true
    },
  }
  return { manager: manager as unknown as BackgroundManager, launched }
}

interface CoordinatorPost {
  sessionId: string
  text: string
}

function createFakeClient(
  assistantText: string,
  coordinatorPosts?: CoordinatorPost[],
): OpencodeClient {
  let coordCounter = 0
  return {
    session: {
      async create() {
        coordCounter++
        return { data: { id: `ses_coord_${coordCounter}` } }
      },
      async messages() {
        return {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: assistantText }],
            },
          ],
        }
      },
      async promptAsync(opts: {
        path?: { id?: string }
        body?: { parts?: Array<{ text?: string }> }
      }) {
        const sessionId = opts?.path?.id ?? ""
        if (coordinatorPosts && sessionId.startsWith("ses_coord_")) {
          coordinatorPosts.push({
            sessionId,
            text: opts?.body?.parts?.[0]?.text ?? "",
          })
        }
        return {}
      },
    },
  } as unknown as OpencodeClient
}

async function waitForTerminal(manager: WorkflowManager, runId: string, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const run = manager.getRun(runId)
    if (run && (run.status === "completed" || run.status === "error" || run.status === "cancelled")) {
      return run
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("run did not reach terminal state in time")
}

const VALID_SCRIPT = `export const meta = { name: 'demo', description: 'demo run' }
const r = await agent('do the thing', { label: 'worker' })
return { r }`

describe("WorkflowManager", () => {
  describe("#given a valid script", () => {
    test("#then start returns a pending run with an id and coordinator session", async () => {
      // given
      const { manager: bg } = createFakeBackgroundManager()
      const wm = new WorkflowManager({
        client: createFakeClient("done"),
        backgroundManager: bg,
        directory: "/tmp",
        enableParentNotifications: false,
      })

      // when
      const run = await wm.start({
        script: VALID_SCRIPT,
        parentSessionID: "ses_parent",
        parentMessageID: "msg_1",
      })

      // then
      expect(run.id).toMatch(/^wf_/)
      expect(run.meta.name).toBe("demo")
      expect(["pending", "running", "completed"]).toContain(run.status)
      expect(run.coordinatorSessionId).toBe("ses_coord_1")
    })

    test("#then the run completes with the script result", async () => {
      // given
      const { manager: bg } = createFakeBackgroundManager()
      const wm = new WorkflowManager({
        client: createFakeClient("subagent output"),
        backgroundManager: bg,
        directory: "/tmp",
        enableParentNotifications: false,
      })

      // when
      const run = await wm.start({
        script: VALID_SCRIPT,
        parentSessionID: "ses_parent",
        parentMessageID: "msg_1",
      })
      const finished = await waitForTerminal(wm, run.id)

      // then
      expect(finished.status).toBe("completed")
      expect(finished.result).toEqual({ r: "subagent output" })
      expect(finished.agents).toHaveLength(1)
      expect(finished.agents[0].status).toBe("done")
      expect(finished.agents[0].sessionId).toBe("ses_1")
    })
  })

  describe("#given a failing subagent", () => {
    test("#then the agent entry is marked error but the run completes", async () => {
      // given
      const { manager: bg } = createFakeBackgroundManager({ failTask: true })
      const wm = new WorkflowManager({
        client: createFakeClient("ignored"),
        backgroundManager: bg,
        directory: "/tmp",
        enableParentNotifications: false,
      })

      // when
      const run = await wm.start({
        script: VALID_SCRIPT,
        parentSessionID: "ses_parent",
        parentMessageID: "msg_1",
      })
      const finished = await waitForTerminal(wm, run.id)

      // then
      expect(finished.status).toBe("completed")
      expect(finished.result).toEqual({ r: null })
      expect(finished.agents[0].status).toBe("error")
    })
  })

  describe("#given an invalid script", () => {
    test("#then start rejects", async () => {
      // given
      const { manager: bg } = createFakeBackgroundManager()
      const wm = new WorkflowManager({
        client: createFakeClient("x"),
        backgroundManager: bg,
        directory: "/tmp",
        enableParentNotifications: false,
      })

      // when / then
      await expect(
        wm.start({
          script: "const meta = {}",
          parentSessionID: "ses_parent",
          parentMessageID: "msg_1",
        }),
      ).rejects.toThrow()
    })
  })

  describe("#given listRuns by parent", () => {
    test("#then only returns runs for that parent session", async () => {
      // given
      const { manager: bg } = createFakeBackgroundManager()
      const wm = new WorkflowManager({
        client: createFakeClient("x"),
        backgroundManager: bg,
        directory: "/tmp",
        enableParentNotifications: false,
      })

      // when
      const runA = await wm.start({ script: VALID_SCRIPT, parentSessionID: "ses_a", parentMessageID: "m" })
      await wm.start({ script: VALID_SCRIPT, parentSessionID: "ses_b", parentMessageID: "m" })
      await waitForTerminal(wm, runA.id)

      // then
      expect(wm.listRuns("ses_a").map((run) => run.id)).toContain(runA.id)
      expect(wm.listRuns("ses_a").every((run) => run.parentSessionID === "ses_a")).toBe(true)
    })
  })

  describe("#given coordinator progress pushes", () => {
    test("#then no two consecutive coordinator messages are identical", async () => {
      // given
      const { manager: bg } = createFakeBackgroundManager()
      const posts: CoordinatorPost[] = []
      const wm = new WorkflowManager({
        client: createFakeClient("subagent output", posts),
        backgroundManager: bg,
        directory: "/tmp",
        enableParentNotifications: false,
      })

      // when
      const run = await wm.start({
        script: VALID_SCRIPT,
        parentSessionID: "ses_parent",
        parentMessageID: "msg_1",
      })
      await waitForTerminal(wm, run.id)
      // let the serialized push chain drain
      await new Promise((resolve) => setTimeout(resolve, 50))

      // then - at least one board was pushed, and never the same text twice in a row
      expect(posts.length).toBeGreaterThan(0)
      for (let i = 1; i < posts.length; i++) {
        expect(posts[i].text).not.toBe(posts[i - 1].text)
      }
    })
  })

  describe("#given a failed run checkpoint", () => {
    test("#then resume skips the completed agent", async () => {
      // given
      const dir = mkdtempSync(join(tmpdir(), "omo-wf-resume-"))
      const script = `export const meta = { name: 'resume_demo', description: 'resume demo' }
const first = await agent('first step', { label: 'first' })
const second = await agent('second step', { label: 'second' })
return { first, second }`
      const scriptHash = hashWorkflowScript(script)
      let calls = 0
      const { manager: bg } = createFakeBackgroundManager()
      const client = createFakeClient("ignored")
      const wm = new WorkflowManager({
        client,
        backgroundManager: {
          async launch(input: { description: string }) {
            calls++
            const id = `bg_${calls}`
            return {
              id,
              sessionID: `ses_${calls}`,
              status: "error",
              description: input.description,
            }
          },
          getTask(id: string) {
            return {
              id,
              sessionID: id.replace("bg_", "ses_"),
              status: "error",
            }
          },
          async cancelTask() {
            return true
          },
        } as unknown as BackgroundManager,
        directory: dir,
        enableParentNotifications: false,
        persistCheckpoints: true,
      })

      const failed = createInitialCheckpoint({
        runId: "wf_failed01",
        scriptHash,
        script,
        meta: { name: "resume_demo", description: "resume demo" },
        phases: [],
      })
      failed.status = "error"
      failed.agents[`${scriptHash.slice(0, 16)}:site0:n0`] = {
        status: "done",
        result: "cached-first",
        label: "first",
      }
      writeWorkflowCheckpoint(dir, failed)

      try {
        // when
        const resumed = await wm.start({
          resumeFromRunId: "wf_failed01",
          parentSessionID: "ses_parent",
          parentMessageID: "msg_1",
        })
        const finished = await waitForTerminal(wm, resumed.id)

        // then
        expect(finished.status).toBe("completed")
        expect(finished.result).toEqual({ first: "cached-first", second: null })
        expect(calls).toBe(1)
        expect(finished.resumeFromRunId).toBe("wf_failed01")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test("#then resumes from a stale running checkpoint after interrupt", async () => {
      // given
      const dir = mkdtempSync(join(tmpdir(), "omo-wf-interrupted-"))
      const script = `export const meta = { name: 'resume_demo', description: 'resume demo' }
const first = await agent('first step', { label: 'first' })
const second = await agent('second step', { label: 'second' })
return { first, second }`
      const scriptHash = hashWorkflowScript(script)
      let calls = 0
      const wm = new WorkflowManager({
        client: createFakeClient("step-two"),
        backgroundManager: {
          async launch() {
            calls++
            return { id: "bg_2", sessionID: "ses_2", status: "completed", description: "second" }
          },
          getTask() {
            return { id: "bg_2", sessionID: "ses_2", status: "completed" }
          },
          async cancelTask() {
            return true
          },
        } as unknown as BackgroundManager,
        directory: dir,
        enableParentNotifications: false,
        persistCheckpoints: true,
      })

      const interrupted = createInitialCheckpoint({
        runId: "wf_interrupted",
        scriptHash,
        script,
        meta: { name: "resume_demo", description: "resume demo" },
        phases: [],
      })
      interrupted.status = "running"
      interrupted.agents[`${scriptHash.slice(0, 16)}:site0:n0`] = {
        status: "done",
        result: "cached-first",
        label: "first",
      }
      writeWorkflowCheckpoint(dir, interrupted)

      try {
        // when
        const resumed = await wm.start({
          resumeFromRunId: "wf_interrupted",
          parentSessionID: "ses_parent",
          parentMessageID: "msg_1",
        })
        const finished = await waitForTerminal(wm, resumed.id)

        // then
        expect(finished.status).toBe("completed")
        expect(finished.result).toEqual({ first: "cached-first", second: "step-two" })
        expect(calls).toBe(1)
        const oldCheckpoint = readWorkflowCheckpoint(dir, "wf_interrupted")
        expect(oldCheckpoint?.status).toBe("cancelled")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
