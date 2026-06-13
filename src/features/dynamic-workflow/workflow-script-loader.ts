import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import type { WorkflowCheckpointAgentEntry } from "./workflow-checkpoint"
import {
  getCheckpointResumeBlockReason,
  hashWorkflowScript,
  readWorkflowCheckpoint,
} from "./workflow-checkpoint"

export async function loadWorkflowScriptFromPath(directory: string, scriptPath: string): Promise<string> {
  const trimmed = scriptPath.trim()
  if (!trimmed) throw new Error("script_path must be a non-empty string")
  const resolved = isAbsolute(trimmed) ? trimmed : join(directory, trimmed)
  try {
    return await readFile(resolved, "utf8")
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read workflow script at ${resolved}: ${detail}`)
  }
}

export interface ResolvedWorkflowScript {
  script: string
  scriptPath?: string
  scriptHash: string
  args?: unknown
  resumeFromRunId?: string
  inheritedAgents?: Record<string, WorkflowCheckpointAgentEntry>
  /** True when resuming a stale running/pending checkpoint (process lost the run). */
  interrupted?: boolean
}

export async function resolveWorkflowScript(input: {
  directory: string
  script?: string
  scriptPath?: string
  args?: unknown
  resumeFromRunId?: string
  runsDir?: string
  isRunActiveInMemory?: boolean
}): Promise<ResolvedWorkflowScript> {
  if (input.resumeFromRunId) {
    const checkpoint = readWorkflowCheckpoint(input.directory, input.resumeFromRunId, input.runsDir)
    if (!checkpoint) {
      throw new Error(`Workflow checkpoint not found for run_id: ${input.resumeFromRunId}`)
    }
    const activeInMemory = input.isRunActiveInMemory ?? false
    const blockReason = getCheckpointResumeBlockReason(checkpoint, activeInMemory)
    if (blockReason) {
      throw new Error(blockReason)
    }
    const interrupted = checkpoint.status === "running" || checkpoint.status === "pending"
    let script = checkpoint.script
    let scriptPath = checkpoint.scriptPath
    if (input.script) {
      script = input.script.trim()
      scriptPath = undefined
    } else if (input.scriptPath) {
      script = await loadWorkflowScriptFromPath(input.directory, input.scriptPath)
      scriptPath = input.scriptPath.trim()
    } else if (scriptPath) {
      script = await loadWorkflowScriptFromPath(input.directory, scriptPath)
    }
    if (!script?.trim()) {
      throw new Error(`Checkpoint ${input.resumeFromRunId} has no script and no script_path to load`)
    }

    const scriptHash = hashWorkflowScript(script)
    if (scriptHash !== checkpoint.scriptHash) {
      throw new Error(
        "Workflow script changed since the checkpoint was created; refusing to resume with a mismatched scriptHash",
      )
    }

    return {
      script: script.trim(),
      scriptPath,
      scriptHash,
      args: input.args ?? checkpoint.args,
      resumeFromRunId: input.resumeFromRunId,
      inheritedAgents: Object.fromEntries(
        Object.entries(checkpoint.agents).filter(([, entry]) => entry.status === "done"),
      ),
      interrupted,
    }
  }

  if (input.script?.trim()) {
    const script = input.script.trim()
    return {
      script,
      scriptHash: hashWorkflowScript(script),
      args: input.args,
    }
  }

  if (input.scriptPath?.trim()) {
    const scriptPath = input.scriptPath.trim()
    const script = (await loadWorkflowScriptFromPath(input.directory, scriptPath)).trim()
    return {
      script,
      scriptPath,
      scriptHash: hashWorkflowScript(script),
      args: input.args,
    }
  }

  throw new Error("workflow requires one of: script, script_path, or resume_from (run_id)")
}
