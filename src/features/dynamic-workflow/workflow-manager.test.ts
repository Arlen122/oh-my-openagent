import { describe, expect, test } from "bun:test"
import { WorkflowManager } from "./workflow-manager"
import type { BackgroundManager } from "../background-agent"
import type { PluginInput } from "@opencode-ai/plugin"

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
})
