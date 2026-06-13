import type { PluginInput } from "@opencode-ai/plugin"
import { existsSync, readdirSync } from "node:fs"
import type { BackgroundManager } from "../background-agent"
import { log } from "../../shared/logger"
import {
  WORKFLOW_COORDINATOR_SESSION_TITLE_PREFIX,
  WORKFLOW_DEFAULT_MAX_AGENTS_PER_RUN,
  WORKFLOW_DEFAULT_MAX_CONCURRENCY,
  WORKFLOW_DEFAULT_SUBAGENT,
  WORKFLOW_RESULT_PREVIEW_MAX_CHARS,
} from "./constants"
import { notifyWorkflowComplete, notifyWorkflowStarted } from "./workflow-notification"
import { buildAgentCompletionMessage, buildProgressBoard, postToCoordinator } from "./workflow-progress"
import { parseWorkflowScript, runWorkflow } from "./workflow-runtime"
import { saveWorkflowScript } from "./script-store"
import {
  assertStructuredCloneableCheckpointValue,
  createInitialCheckpoint,
  isCheckpointResumable,
  markCheckpointCancelled,
  readWorkflowCheckpoint,
  resolveRunsDir,
  writeWorkflowCheckpoint,
  type WorkflowCheckpoint,
  type WorkflowCheckpointAgentEntry,
} from "./workflow-checkpoint"
import { checkpointToRunSnapshot } from "./workflow-checkpoint-view"
import { resolveWorkflowScript } from "./workflow-script-loader"
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
  persistCheckpoints?: boolean
  runsDir?: string
}

export interface StartWorkflowInput {
  script?: string
  scriptPath?: string
  resumeFromRunId?: string
  args?: unknown
  parentSessionID: string
  parentMessageID: string
  parentAgent?: string
  parentTools?: Record<string, boolean>
  parentModel?: { providerID: string; modelID: string }
  toolCallID?: string
}

export interface ResumeWorkflowInput extends Omit<StartWorkflowInput, "resumeFromRunId"> {
  runId: string
}

interface ActiveRun {
  run: WorkflowRun
  controller: AbortController
  pushChain: Promise<void>
  /** Last text posted to the coordinator, used to drop duplicate consecutive snapshots */
  lastPushedText?: string
  checkpoint: WorkflowCheckpoint
}

export class WorkflowManager {
  private readonly options: WorkflowManagerOptions
  private readonly runs = new Map<string, ActiveRun>()
  private readonly pendingByParent = new Map<string, Set<string>>()

  constructor(options: WorkflowManagerOptions) {
    this.options = options
  }

  async start(input: StartWorkflowInput): Promise<WorkflowRun> {
    const resumeFromRunId = input.resumeFromRunId?.trim()
    const resolved = await resolveWorkflowScript({
      directory: this.options.directory,
      script: input.script,
      scriptPath: input.scriptPath,
      args: input.args,
      resumeFromRunId,
      runsDir: this.options.runsDir,
      isRunActiveInMemory: resumeFromRunId ? this.isRunActive(resumeFromRunId) : false,
    })

    if (resolved.interrupted && resumeFromRunId) {
      this.markInterruptedCheckpointSuperseded(resumeFromRunId)
    }

    const { meta } = parseWorkflowScript(resolved.script)

    const run: WorkflowRun = {
      id: `wf_${crypto.randomUUID().slice(0, 8)}`,
      meta,
      status: "pending",
      parentSessionID: input.parentSessionID,
      parentMessageID: input.parentMessageID,
      parentAgent: input.parentAgent,
      parentTools: input.parentTools,
      parentModel: input.parentModel,
      script: resolved.script,
      scriptPath: resolved.scriptPath,
      scriptHash: resolved.scriptHash,
      resumeFromRunId: resolved.resumeFromRunId,
      args: resolved.args,
      phases: meta.phases?.map((phase) => phase.title) ?? [],
      logs: [],
      agents: [],
      childTaskIds: [],
      toolCallID: input.toolCallID,
    }

    const checkpoint = createInitialCheckpoint({
      runId: run.id,
      parentRunId: resolved.resumeFromRunId,
      scriptHash: resolved.scriptHash,
      script: resolved.script,
      scriptPath: resolved.scriptPath,
      args: resolved.args,
      meta,
      phases: run.phases,
      inheritedAgents: resolved.inheritedAgents,
    })
    run.checkpointPath = this.maybeWriteCheckpoint(checkpoint)

    // Create a dedicated coordinator session that holds the live checkbox
    // progress board. The user opens it via /session (the workflow tool card is
    // not clickable in the stock OpenCode TUI).
    run.coordinatorSessionId = await this.createCoordinatorSession(run)

    const controller = new AbortController()
    this.runs.set(run.id, { run, controller, pushChain: Promise.resolve(), checkpoint })
    this.trackPending(run)

    if (run.coordinatorSessionId) {
      this.schedulePush(run.id)
      notifyWorkflowStarted(this.options.client, run)
    }

    void this.executeRun(run.id, controller)
    return run
  }

  async resume(input: ResumeWorkflowInput): Promise<WorkflowRun> {
    return this.start({
      ...input,
      resumeFromRunId: input.runId,
    })
  }

  listResumableRuns(): WorkflowCheckpoint[] {
    const dir = resolveRunsDir(this.options.directory, this.options.runsDir)
    if (!existsSync(dir)) return []
    try {
      return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => readWorkflowCheckpoint(this.options.directory, name.slice(0, -5), this.options.runsDir))
        .filter((checkpoint): checkpoint is WorkflowCheckpoint => checkpoint !== null)
        .filter((checkpoint) => isCheckpointResumable(checkpoint, this.isRunActive(checkpoint.runId)))
    } catch {
      return []
    }
  }

  isRunActive(runId: string): boolean {
    const entry = this.runs.get(runId)
    if (!entry) return false
    return entry.run.status === "pending" || entry.run.status === "running"
  }

  getCheckpoint(runId: string): WorkflowCheckpoint | null {
    return readWorkflowCheckpoint(this.options.directory, runId, this.options.runsDir)
  }

  getRunOrCheckpoint(runId: string): WorkflowRun | undefined {
    const active = this.getRun(runId)
    if (active) return active
    const checkpoint = this.getCheckpoint(runId)
    if (!checkpoint) return undefined
    return checkpointToRunSnapshot(checkpoint, this.options.directory, this.options.runsDir)
  }

  isCheckpointOnly(runId: string): boolean {
    return !this.runs.has(runId) && this.getCheckpoint(runId) !== null
  }

  async cancelRunOrStaleCheckpoint(runId: string): Promise<"memory" | "checkpoint" | "not_found" | "already_terminal"> {
    if (this.isRunActive(runId)) {
      const cancelled = await this.cancel(runId)
      return cancelled ? "memory" : "already_terminal"
    }

    const checkpoint = this.getCheckpoint(runId)
    if (!checkpoint) return "not_found"
    if (checkpoint.status === "completed" || checkpoint.status === "cancelled") {
      return "already_terminal"
    }

    const updated = markCheckpointCancelled(checkpoint, "cancelled (run no longer active in memory)")
    this.maybeWriteCheckpoint(updated)
    return "checkpoint"
  }

  private markInterruptedCheckpointSuperseded(runId: string): void {
    const checkpoint = this.getCheckpoint(runId)
    if (!checkpoint) return
    if (checkpoint.status !== "running" && checkpoint.status !== "pending") return
    const updated = markCheckpointCancelled(checkpoint, "interrupted; resumed in a new run")
    this.maybeWriteCheckpoint(updated)
  }

  private async createCoordinatorSession(run: WorkflowRun): Promise<string | undefined> {
    try {
      // Create the coordinator as a TOP-LEVEL (root) session, NOT a child of the
      // parent session. Standard OpenCode hides child sessions (those with a
      // parentID) from the session list, so a child coordinator is unreachable
      // in the stock TUI. A root session shows up via the /session command,
      // letting the user manually open the live progress board.
      const response = await this.options.client.session.create({
        body: {
          title: `${WORKFLOW_COORDINATOR_SESSION_TITLE_PREFIX}: ${run.meta.name}`,
        } as Record<string, unknown>,
        query: { directory: this.options.directory },
      })
      const data = (response as { data?: { id?: unknown } }).data
      const id = data?.id
      if (typeof id === "string" && id.length > 0) return id
      log("[dynamic-workflow] Coordinator session create returned no id:", { runId: run.id })
      return undefined
    } catch (error) {
      log("[dynamic-workflow] Failed to create coordinator session:", {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  /**
   * Queue a message to the coordinator session. The text is snapshotted eagerly
   * (NOT lazily inside the promise) so that multiple queued pushes don't all
   * render the same mutated run state and produce duplicate identical messages.
   * Consecutive identical snapshots are dropped.
   */
  private enqueueCoordinatorPush(runId: string, text: string | undefined): void {
    const entry = this.runs.get(runId)
    if (!entry || !entry.run.coordinatorSessionId || !text) return
    if (text === entry.lastPushedText) return
    entry.lastPushedText = text
    entry.pushChain = entry.pushChain
      .catch(() => {})
      .then(() => postToCoordinator(this.options.client, entry.run, text))
  }

  private schedulePush(runId: string): void {
    const entry = this.runs.get(runId)
    if (!entry) return
    this.enqueueCoordinatorPush(runId, buildProgressBoard(entry.run))
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
    entry.checkpoint.status = "cancelled"
    entry.run.checkpointPath = this.maybeWriteCheckpoint(entry.checkpoint)
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

  private async executeRun(runId: string, controller: AbortController): Promise<void> {
    const entry = this.runs.get(runId)
    if (!entry) return
    const run = entry.run
    run.status = "running"
    run.startedAt = new Date()
    entry.checkpoint.status = "running"
    run.checkpointPath = this.maybeWriteCheckpoint(entry.checkpoint)

    const runner = new WorkflowSubagentRunner({
      backgroundManager: this.options.backgroundManager,
      client: this.options.client,
      parentSessionID: run.coordinatorSessionId ?? run.parentSessionID,
      parentMessageID: run.parentMessageID,
      parentAgent: run.parentAgent,
      parentTools: run.parentTools,
      parentModel: run.parentModel,
      defaultAgent: this.options.defaultSubagent ?? WORKFLOW_DEFAULT_SUBAGENT,
      onTaskLaunched: ({ taskId, sessionId, label }) => {
        if (!run.childTaskIds.includes(taskId)) run.childTaskIds.push(taskId)
        const agentEntry = findRunningAgent(run, label)
        if (agentEntry) {
          agentEntry.backgroundTaskId = taskId
          if (sessionId) agentEntry.sessionId = sessionId
        }
      },
      onTaskSession: ({ sessionId, label }) => {
        const agentEntry = findRunningAgent(run, label)
        if (agentEntry) agentEntry.sessionId = sessionId
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
        scriptHash: run.scriptHash,
        checkpointAgents: entry.checkpoint.agents,
        onLog: (message) => {
          run.logs.push(message)
        },
        onPhase: (title) => {
          run.currentPhase = title
          entry.checkpoint.currentPhase = title
          if (!run.phases.includes(title)) run.phases.push(title)
          if (!entry.checkpoint.phases.includes(title)) entry.checkpoint.phases.push(title)
          this.schedulePush(run.id)
        },
        onAgentStart: (event) => {
          if (event.fromCheckpoint) return
          run.agents.push({
            id: run.agents.length + 1,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: "running",
            checkpointId: event.checkpointId,
          })
          this.schedulePush(run.id)
        },
        onAgentEnd: (event) => {
          if (event.fromCheckpoint) {
            run.agents.push({
              id: run.agents.length + 1,
              label: event.label,
              phase: event.phase,
              prompt: "",
              status: event.result === null ? "error" : "done",
              checkpointId: event.checkpointId,
              resultPreview: preview(event.result),
            })
            return
          }
          const agentEntry = findRunningAgent(run, event.label, event.checkpointId)
          if (agentEntry) {
            agentEntry.status = event.result === null ? "error" : "done"
            agentEntry.resultPreview = preview(event.result)
            agentEntry.checkpointId = event.checkpointId
            this.enqueueCoordinatorPush(run.id, buildAgentCompletionMessage(agentEntry, event.result))
          }
        },
        onCheckpointAgent: (checkpointId, agentCheckpoint) => {
          this.recordCheckpointAgent(entry, checkpointId, agentCheckpoint)
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
      entry.checkpoint.status = "completed"
      entry.checkpoint.error = undefined

      await this.maybePersistScript(run)
    } catch (error) {
      if (controller.signal.aborted) {
        run.status = "cancelled"
        entry.checkpoint.status = "cancelled"
        markRunningAgentsSkipped(run)
      } else {
        run.status = "error"
        run.error = error instanceof Error ? error.message : String(error)
        entry.checkpoint.status = "error"
        entry.checkpoint.error = run.error
      }
      run.completedAt = new Date()
      run.durationMs = run.startedAt ? Date.now() - run.startedAt.getTime() : undefined
    } finally {
      run.checkpointPath = this.maybeWriteCheckpoint(entry.checkpoint)
      this.finishRun(run)
    }
  }

  private recordCheckpointAgent(
    entry: ActiveRun,
    checkpointId: string,
    agentCheckpoint: WorkflowCheckpointAgentEntry,
  ): void {
    if (agentCheckpoint.result !== undefined) {
      assertStructuredCloneableCheckpointValue(agentCheckpoint.result, `checkpoint agent result (${checkpointId})`)
    }
    entry.checkpoint.agents[checkpointId] = agentCheckpoint
    entry.run.checkpointPath = this.maybeWriteCheckpoint(entry.checkpoint)
  }

  private maybeWriteCheckpoint(checkpoint: WorkflowCheckpoint): string | undefined {
    if (this.options.persistCheckpoints === false) return undefined
    try {
      return writeWorkflowCheckpoint(this.options.directory, checkpoint, this.options.runsDir)
    } catch (error) {
      log("[dynamic-workflow] Failed to write workflow checkpoint:", {
        runId: checkpoint.runId,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  private finishRun(run: WorkflowRun): void {
    this.schedulePush(run.id)
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
    if (this.options.persistScripts === false) return
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

function findRunningAgent(
  run: WorkflowRun,
  label: string,
  checkpointId?: string,
): WorkflowAgentEntry | undefined {
  for (let i = run.agents.length - 1; i >= 0; i--) {
    const entry = run.agents[i]
    if (entry.status !== "running") continue
    if (checkpointId && entry.checkpointId === checkpointId) return entry
    if (entry.label === label) return entry
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
