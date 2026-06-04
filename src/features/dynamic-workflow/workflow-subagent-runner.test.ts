import { describe, expect, test } from "bun:test"
import { WorkflowSubagentRunner } from "./workflow-subagent-runner"
import type { BackgroundManager } from "../background-agent"
import type { PluginInput } from "@opencode-ai/plugin"

type OpencodeClient = PluginInput["client"]

function createClient(availableAgents: Array<{ name: string; mode?: "subagent" | "primary" | "all" }>): OpencodeClient {
  return {
    app: {
      async agents() {
        return { data: availableAgents }
      },
    },
    session: {
      async messages() {
        return {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "ok" }],
            },
          ],
        }
      },
    },
  } as unknown as OpencodeClient
}

function createBackgroundManagerCapture(): {
  manager: BackgroundManager
  launchedAgents: string[]
  launchedModels: Array<{ providerID: string; modelID: string; variant?: string } | undefined>
} {
  const launchedAgents: string[] = []
  const launchedModels: Array<{ providerID: string; modelID: string; variant?: string } | undefined> = []
  const tasks = new Map<string, { id: string; status: string; sessionID?: string }>()

  const manager = {
    async launch(input: { agent: string; model?: { providerID: string; modelID: string; variant?: string } }) {
      const id = `bg_${launchedAgents.length + 1}`
      launchedAgents.push(input.agent)
      launchedModels.push(input.model)
      const task = { id, status: "completed", sessionID: `ses_${launchedAgents.length}` }
      tasks.set(id, task)
      return task
    },
    getTask(id: string) {
      return tasks.get(id)
    },
    async cancelTask() {
      return true
    },
  }

  return { manager: manager as unknown as BackgroundManager, launchedAgents, launchedModels }
}

describe("WorkflowSubagentRunner", () => {
  test("#given no subagent_type #then uses default agent", async () => {
    // given
    const { manager, launchedAgents } = createBackgroundManagerCapture()
    const runner = new WorkflowSubagentRunner({
      backgroundManager: manager,
      client: createClient([
        { name: "general", mode: "subagent" },
        { name: "explore", mode: "subagent" },
      ]),
      parentSessionID: "ses_parent",
      parentMessageID: "msg_parent",
      defaultAgent: "general",
    })

    // when
    await runner.run("scan repo", { label: "scan" })

    // then
    expect(launchedAgents).toEqual(["general"])
  })

  test("#given subagent_type #then routes to that subagent", async () => {
    // given
    const { manager, launchedAgents } = createBackgroundManagerCapture()
    const runner = new WorkflowSubagentRunner({
      backgroundManager: manager,
      client: createClient([
        { name: "general", mode: "subagent" },
        { name: "explore", mode: "subagent" },
      ]),
      parentSessionID: "ses_parent",
      parentMessageID: "msg_parent",
      defaultAgent: "general",
    })

    // when
    await runner.run("scan repo", { label: "scan", subagentType: "explore" })

    // then
    expect(launchedAgents).toEqual(["explore"])
  })

  test("#given model option #then passes parsed model to background task", async () => {
    // given
    const { manager, launchedModels } = createBackgroundManagerCapture()
    const runner = new WorkflowSubagentRunner({
      backgroundManager: manager,
      client: createClient([
        { name: "general", mode: "subagent" },
      ]),
      parentSessionID: "ses_parent",
      parentMessageID: "msg_parent",
      defaultAgent: "general",
    })

    // when
    await runner.run("scan repo", { label: "scan", model: "openai/gpt-5.4 high" })

    // then
    expect(launchedModels).toEqual([
      { providerID: "openai", modelID: "gpt-5.4", variant: "high" },
    ])
  })

  test("#given unknown subagent_type #then throws with available list", async () => {
    // given
    const { manager } = createBackgroundManagerCapture()
    const runner = new WorkflowSubagentRunner({
      backgroundManager: manager,
      client: createClient([
        { name: "general", mode: "subagent" },
        { name: "explore", mode: "subagent" },
      ]),
      parentSessionID: "ses_parent",
      parentMessageID: "msg_parent",
      defaultAgent: "general",
    })

    // when / then
    await expect(
      runner.run("scan repo", { label: "scan", subagentType: "not-exists" }),
    ).rejects.toThrow(/Unknown workflow subagent_type/)
  })
})

