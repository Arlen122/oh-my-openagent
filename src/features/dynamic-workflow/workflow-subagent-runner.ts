import type { PluginInput } from "@opencode-ai/plugin"
import type { BackgroundManager } from "../background-agent"
import { WORKFLOW_AGENT_POLL_INTERVAL_MS } from "./constants"
import { extractLastAssistantText, parseStructuredResult } from "./workflow-result-extractor"
import type { WorkflowAgentRunOptions, WorkflowAgentRunner } from "./types"

type OpencodeClient = PluginInput["client"]

export interface SubagentLaunchEvent {
  taskId: string
  sessionId?: string
  label: string
}

export interface WorkflowSubagentRunnerOptions {
  backgroundManager: BackgroundManager
  client: OpencodeClient
  parentSessionID: string
  parentMessageID: string
  parentAgent?: string
  parentTools?: Record<string, boolean>
  parentModel?: { providerID: string; modelID: string }
  defaultAgent: string
  onTaskLaunched?: (event: SubagentLaunchEvent) => void
  onTaskSession?: (event: { taskId: string; sessionId: string; label: string }) => void
}

const TERMINAL_STATUSES = new Set(["completed", "error", "cancelled", "interrupt"])

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class WorkflowSubagentRunner implements WorkflowAgentRunner {
  private readonly options: WorkflowSubagentRunnerOptions

  constructor(options: WorkflowSubagentRunnerOptions) {
    this.options = options
  }

  async run(prompt: string, runOptions: WorkflowAgentRunOptions): Promise<unknown> {
    const { backgroundManager, client } = this.options
    const effectivePrompt = buildSubagentPrompt(prompt, runOptions)

    const task = await backgroundManager.launch({
      description: runOptions.label,
      prompt: effectivePrompt,
      agent: this.options.defaultAgent,
      parentSessionID: this.options.parentSessionID,
      parentMessageID: this.options.parentMessageID,
      parentAgent: this.options.parentAgent,
      parentTools: this.options.parentTools,
      parentModel: this.options.parentModel,
    })

    this.options.onTaskLaunched?.({ taskId: task.id, sessionId: task.sessionID, label: runOptions.label })

    let abortHandler: (() => void) | undefined
    if (runOptions.signal) {
      abortHandler = () => {
        void backgroundManager.cancelTask(task.id, {
          source: "workflow_cancel",
          abortSession: true,
          skipNotification: true,
        })
      }
      runOptions.signal.addEventListener("abort", abortHandler, { once: true })
    }

    try {
      let sessionReported = false
      while (true) {
        if (runOptions.signal?.aborted) {
          throw new Error("workflow subagent aborted")
        }
        const current = backgroundManager.getTask(task.id)
        if (!current) {
          throw new Error(`workflow subagent task disappeared: ${task.id}`)
        }
        if (!sessionReported && current.sessionID) {
          sessionReported = true
          this.options.onTaskSession?.({
            taskId: task.id,
            sessionId: current.sessionID,
            label: runOptions.label,
          })
        }
        if (TERMINAL_STATUSES.has(current.status)) {
          if (current.status !== "completed") {
            throw new Error(`workflow subagent ${runOptions.label} ended with status ${current.status}`)
          }
          if (!current.sessionID) {
            throw new Error(`workflow subagent ${runOptions.label} completed without a session`)
          }
          const text = await extractLastAssistantText(client, current.sessionID)
          return runOptions.schema ? parseStructuredResult(text) : text
        }
        await delay(WORKFLOW_AGENT_POLL_INTERVAL_MS)
      }
    } finally {
      if (runOptions.signal && abortHandler) {
        runOptions.signal.removeEventListener("abort", abortHandler)
      }
    }
  }
}

function buildSubagentPrompt(prompt: string, runOptions: WorkflowAgentRunOptions): string {
  const parts: string[] = []
  if (runOptions.phase) parts.push(`Workflow phase: ${runOptions.phase}`)
  if (runOptions.agentType) parts.push(`Act as workflow subagent type: ${runOptions.agentType}`)
  parts.push(prompt)

  if (runOptions.schema) {
    parts.push(
      [
        "Final output contract:",
        "- Your final message MUST be a single JSON object that conforms to this JSON Schema.",
        "- Output the JSON inside a ```json fenced code block, with no prose after it.",
        "- Do all necessary investigation first, then emit the JSON exactly once.",
        "",
        "JSON Schema:",
        "```json",
        JSON.stringify(runOptions.schema, null, 2),
        "```",
      ].join("\n"),
    )
  }

  return parts.join("\n\n")
}
