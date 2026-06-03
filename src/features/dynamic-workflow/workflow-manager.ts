import type { PluginInput } from "@opencode-ai/plugin"
import type { BackgroundManager } from "../background-agent"
import { log } from "../../shared/logger"
import {
  WORKFLOW_DEFAULT_MAX_AGENTS_PER_RUN,
  WORKFLOW_DEFAULT_MAX_CONCURRENCY,
  WORKFLOW_DEFAULT_SUBAGENT,
  WORKFLOW_RESULT_PREVIEW_MAX_CHARS,
} from "./constants"
import { notifyWorkflowComplete } from "./workflow-notification"
import { parseWorkflowScript, runWorkflow } from "./workflow-runtime"
import { saveWorkflowScript } from "./script-store"
import { WorkflowSubagentRunner } from "./workflow-subagent-runner"
import type { WorkflowAgentEntry, WorkflowRun } from "./types"

type OpencodeClient = PluginInput["client"]

export interface WorkflowManagerOptions {
  client: OpencodeClient
  backgroundManager: BackgroundManager
  directory: string
  defaultSubagent?: string
  maxConcurrency?: number
  maxAgentsPerRun?: number
  enableParentNotifications?: boolean
  persistScripts?: boolean
  scriptsDir?: string
}

export interface StartWorkflowInput {
  script: string
  args?: unknown
  parentSessionID: string
  parentMessageID: string
  parentAgent?: string
  parentTools?: Record<string, boolean>
  parentModel?: { providerID: string; modelID: string }
  toolCallID?: string
}

interface ActiveRun {
  run: WorkflowRun
  controller: AbortController
}

export class WorkflowManager {
  private readonly options: WorkflowManagerOptions
  private readonly runs = new Map<string, ActiveRun>()
  private readonly pendingByParent = new Map<string, Set<string>>()

  constructor(options: WorkflowManagerOptions) {
    this.options = options
  }

  start(input: StartWorkflowInput): WorkflowRun {
    const { meta } = parseWorkflowScript(input.script)

    const run: WorkflowRun = {
      id: `wf_${crypto.randomUUID().slice(0, 8)}`,
      meta,
      status: "pending",
      parentSessionID: input.parentSessionID,
      parentMessageID: input.parentMessageID,
      parentAgent: input.parentAgent,
      parentTools: input.parentTools,
      parentModel: input.parentModel,
      script: input.script,
      args: input.args,
      phases: meta.phases?.map((phase) => phase.title) ?? [],
      logs: [],
      agents: [],
      childTaskIds: [],
      toolCallID: input.toolCallID,
    }

    const controller = new AbortController()
    this.runs.set(run.id, { run, controller })
    this.trackPending(run)

    void this.executeRun(run, controller)
    return run
  }

  getRun(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId)?.run
  }

  listRuns(parentSessionID?: string): WorkflowRun[] {
    const all = Array.from(this.runs.values()).map((entry) => entry.run)
    if (!parentSessionID) return all
    return all.filter((run) => run.parentSessionID === parentSessionID)
  }

  async cancel(runId: string): Promise<boolean> {
    const entry = this.runs.get(runId)
    if (!entry) return false
    if (entry.run.status === "completed" || entry.run.status === "error" || entry.run.status === "cancelled") {
      return false
    }
    entry.run.status = "cancelled"
    entry.controller.abort()
    await this.cancelChildTasks(entry.run)
    return true
  }

  async cancelAll(parentSessionID: string): Promise<number> {
    const active = this.listRuns(parentSessionID).filter(
      (run) => run.status === "pending" || run.status === "running",
    )
    let count = 0
    for (const run of active) {
      if (await this.cancel(run.id)) count++
    }
    return count
  }

  private async executeRun(run: WorkflowRun, controller: AbortController): Promise<void> {
    run.status = "running"
    run.startedAt = new Date()

    const runner = new WorkflowSubagentRunner({
      backgroundManager: this.options.backgroundManager,
      client: this.options.client,
      parentSessionID: run.parentSessionID,
      parentMessageID: run.parentMessageID,
      parentAgent: run.parentAgent,
      parentTools: run.parentTools,
      parentModel: run.parentModel,
      defaultAgent: this.options.defaultSubagent ?? WORKFLOW_DEFAULT_SUBAGENT,
      onTaskLaunched: ({ taskId, sessionId, label }) => {
        if (!run.childTaskIds.includes(taskId)) run.childTaskIds.push(taskId)
        const entry = findRunningAgent(run, label)
        if (entry) {
          entry.backgroundTaskId = taskId
          if (sessionId) entry.sessionId = sessionId
        }
      },
      onTaskSession: ({ sessionId, label }) => {
        const entry = findRunningAgent(run, label)
        if (entry) entry.sessionId = sessionId
      },
    })

    try {
      const result = await runWorkflow(run.script, {
        agent: runner,
        cwd: this.options.directory,
        args: run.args,
        concurrency: this.options.maxConcurrency ?? WORKFLOW_DEFAULT_MAX_CONCURRENCY,
        maxAgents: this.options.maxAgentsPerRun ?? WORKFLOW_DEFAULT_MAX_AGENTS_PER_RUN,
        signal: controller.signal,
        onLog: (message) => {
          run.logs.push(message)
        },
        onPhase: (title) => {
          run.currentPhase = title
          if (!run.phases.includes(title)) run.phases.push(title)
        },
        onAgentStart: (event) => {
          run.agents.push({
            id: run.agents.length + 1,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: "running",
          })
        },
        onAgentEnd: (event) => {
          const entry = findRunningAgent(run, event.label)
          if (entry) {
            entry.status = event.result === null ? "error" : "done"
            entry.resultPreview = preview(event.result)
          }
        },
      })

      if (result.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but ran no subagents",
        )
      }

      run.result = result.result
      run.durationMs = result.durationMs
      run.status = "completed"
      run.completedAt = new Date()

      await this.maybePersistScript(run)
    } catch (error) {
      if (controller.signal.aborted) {
        run.status = "cancelled"
        markRunningAgentsSkipped(run)
      } else {
        run.status = "error"
        run.error = error instanceof Error ? error.message : String(error)
      }
      run.completedAt = new Date()
      run.durationMs = run.startedAt ? Date.now() - run.startedAt.getTime() : undefined
    } finally {
      this.finishRun(run)
    }
  }

  private finishRun(run: WorkflowRun): void {
    const shouldReply = this.releasePending(run)
    void notifyWorkflowComplete({
      client: this.options.client,
      run,
      shouldReply,
      enableParentNotifications: this.options.enableParentNotifications ?? true,
    })
  }

  private async cancelChildTasks(run: WorkflowRun): Promise<void> {
    for (const taskId of run.childTaskIds) {
      try {
        await this.options.backgroundManager.cancelTask(taskId, {
          source: "workflow_cancel",
          abortSession: true,
          skipNotification: true,
        })
      } catch (error) {
        log("[dynamic-workflow] Failed to cancel child task:", {
          runId: run.id,
          taskId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private async maybePersistScript(run: WorkflowRun): Promise<void> {
    if (!this.options.persistScripts) return
    try {
      const path = await saveWorkflowScript({
        directory: this.options.directory,
        scriptsDir: this.options.scriptsDir,
        name: run.meta.name,
        script: run.script,
      })
      log("[dynamic-workflow] Saved workflow script:", { runId: run.id, path })
    } catch (error) {
      log("[dynamic-workflow] Failed to persist workflow script:", {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private trackPending(run: WorkflowRun): void {
    const set = this.pendingByParent.get(run.parentSessionID) ?? new Set<string>()
    set.add(run.id)
    this.pendingByParent.set(run.parentSessionID, set)
  }

  private releasePending(run: WorkflowRun): boolean {
    const set = this.pendingByParent.get(run.parentSessionID)
    if (!set) return true
    set.delete(run.id)
    if (set.size === 0) {
      this.pendingByParent.delete(run.parentSessionID)
      return true
    }
    return false
  }
}

function findRunningAgent(run: WorkflowRun, label: string): WorkflowAgentEntry | undefined {
  for (let i = run.agents.length - 1; i >= 0; i--) {
    const entry = run.agents[i]
    if (entry.label === label && entry.status === "running") return entry
  }
  return undefined
}

function markRunningAgentsSkipped(run: WorkflowRun): void {
  for (const entry of run.agents) {
    if (entry.status === "running") {
      entry.status = "skipped"
      entry.error = "aborted"
    }
  }
}

function preview(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = typeof value === "string" ? value : safeStringify(value)
  if (text.length <= WORKFLOW_RESULT_PREVIEW_MAX_CHARS) return text
  return `${text.slice(0, WORKFLOW_RESULT_PREVIEW_MAX_CHARS)}...`
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
