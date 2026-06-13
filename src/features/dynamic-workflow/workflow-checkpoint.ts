import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import type { WorkflowMeta, WorkflowRunStatus } from "./types"

export interface WorkflowCheckpointAgentEntry {
  status: "done" | "error"
  result?: unknown
  label?: string
  phase?: string
  prompt?: string
  error?: string
}

export interface WorkflowCheckpoint {
  runId: string
  parentRunId?: string
  scriptHash: string
  scriptPath?: string
  script?: string
  args?: unknown
  status: WorkflowRunStatus
  meta: WorkflowMeta
  currentPhase?: string
  phases: string[]
  agents: Record<string, WorkflowCheckpointAgentEntry>
  error?: string
  updatedAt: string
}

export const WORKFLOW_DEFAULT_RUNS_DIR = ".opencode/workflows/runs"

export function hashWorkflowScript(script: string): string {
  return createHash("sha256").update(script.trim()).digest("hex")
}

export function resolveRunsDir(directory: string, runsDir?: string): string {
  if (runsDir && runsDir.trim()) {
    return isAbsolute(runsDir) ? runsDir : join(directory, runsDir)
  }
  return join(directory, WORKFLOW_DEFAULT_RUNS_DIR)
}

export function getCheckpointPath(directory: string, runId: string, runsDir?: string): string {
  return join(resolveRunsDir(directory, runsDir), `${runId}.json`)
}

export function readWorkflowCheckpoint(
  directory: string,
  runId: string,
  runsDir?: string,
): WorkflowCheckpoint | null {
  const path = getCheckpointPath(directory, runId, runsDir)
  if (!existsSync(path)) return null

  try {
    const raw = readFileSync(path, "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    if (typeof parsed.runId !== "string" || typeof parsed.scriptHash !== "string") return null
    if (!parsed.agents || typeof parsed.agents !== "object" || Array.isArray(parsed.agents)) return null
    return parsed as WorkflowCheckpoint
  } catch {
    return null
  }
}

export function writeWorkflowCheckpoint(
  directory: string,
  checkpoint: WorkflowCheckpoint,
  runsDir?: string,
): string {
  const path = getCheckpointPath(directory, checkpoint.runId, runsDir)
  mkdirSync(resolveRunsDir(directory, runsDir), { recursive: true })
  writeFileSync(path, JSON.stringify({ ...checkpoint, updatedAt: new Date().toISOString() }, null, 2), "utf8")
  return path
}

export function createInitialCheckpoint(input: {
  runId: string
  scriptHash: string
  script: string
  scriptPath?: string
  args?: unknown
  meta: WorkflowMeta
  phases: string[]
  parentRunId?: string
  inheritedAgents?: Record<string, WorkflowCheckpointAgentEntry>
}): WorkflowCheckpoint {
  return {
    runId: input.runId,
    parentRunId: input.parentRunId,
    scriptHash: input.scriptHash,
    scriptPath: input.scriptPath,
    script: input.script,
    args: input.args,
    status: "pending",
    meta: input.meta,
    phases: input.phases,
    agents: { ...(input.inheritedAgents ?? {}) },
    updatedAt: new Date().toISOString(),
  }
}

export function cloneCheckpointAgentsForResume(
  checkpoint: WorkflowCheckpoint,
): Record<string, WorkflowCheckpointAgentEntry> {
  const agents: Record<string, WorkflowCheckpointAgentEntry> = {}
  for (const [id, entry] of Object.entries(checkpoint.agents)) {
    if (entry.status === "done") {
      agents[id] = { ...entry }
    }
  }
  return agents
}

export function assertStructuredCloneableCheckpointValue(value: unknown, name: string): void {
  try {
    structuredClone(value)
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : ""
    throw new Error(`${name} must be structured-cloneable for checkpoint persistence.${detail}`)
  }
}

/**
 * A checkpoint is resumable when:
 * - error / cancelled (normal failure path)
 * - running / pending but the run is no longer active in memory (process restart or session interrupt)
 */
export function isCheckpointResumable(checkpoint: WorkflowCheckpoint, activeInMemory: boolean): boolean {
  if (checkpoint.status === "completed") return false
  if (checkpoint.status === "error" || checkpoint.status === "cancelled") return true
  if ((checkpoint.status === "running" || checkpoint.status === "pending") && !activeInMemory) {
    return true
  }
  return false
}

export function getCheckpointResumeBlockReason(
  checkpoint: WorkflowCheckpoint,
  activeInMemory: boolean,
): string | null {
  if (isCheckpointResumable(checkpoint, activeInMemory)) return null
  if (checkpoint.status === "completed") {
    return `Cannot resume workflow ${checkpoint.runId}: already completed`
  }
  if (activeInMemory && (checkpoint.status === "running" || checkpoint.status === "pending")) {
    return `Cannot resume workflow ${checkpoint.runId}: still running in this process (cancel it first or wait for completion)`
  }
  return `Cannot resume workflow ${checkpoint.runId}: status is "${checkpoint.status}"`
}

export function markCheckpointCancelled(
  checkpoint: WorkflowCheckpoint,
  reason: string,
): WorkflowCheckpoint {
  return {
    ...checkpoint,
    status: "cancelled",
    error: reason,
    updatedAt: new Date().toISOString(),
  }
}
