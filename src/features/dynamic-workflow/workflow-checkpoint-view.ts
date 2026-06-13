import type { WorkflowAgentEntry, WorkflowRun } from "./types"
import { WORKFLOW_RESULT_PREVIEW_MAX_CHARS } from "./constants"
import type { WorkflowCheckpoint } from "./workflow-checkpoint"
import { getCheckpointPath } from "./workflow-checkpoint"

export function checkpointToRunSnapshot(
  checkpoint: WorkflowCheckpoint,
  directory: string,
  runsDir?: string,
): WorkflowRun {
  const agents: WorkflowAgentEntry[] = Object.entries(checkpoint.agents).map(([checkpointId, entry], index) => ({
    id: index + 1,
    label: entry.label ?? checkpointId,
    phase: entry.phase,
    status: entry.status === "done" ? "done" : "error",
    prompt: entry.prompt ?? "",
    checkpointId,
    resultPreview: previewValue(entry.result),
    error: entry.error,
  }))

  return {
    id: checkpoint.runId,
    meta: checkpoint.meta,
    status: checkpoint.status,
    parentSessionID: "",
    parentMessageID: "",
    script: checkpoint.script ?? "",
    scriptPath: checkpoint.scriptPath,
    scriptHash: checkpoint.scriptHash,
    args: checkpoint.args,
    phases: checkpoint.phases,
    currentPhase: checkpoint.currentPhase,
    logs: [],
    agents,
    childTaskIds: [],
    error: checkpoint.error,
    checkpointPath: getCheckpointPath(directory, checkpoint.runId, runsDir),
  }
}

function previewValue(value: unknown): string | undefined {
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
