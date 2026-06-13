import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { WorkflowManager } from "../../features/dynamic-workflow"
import {
  WORKFLOW_OUTPUT_DEFAULT_TIMEOUT_MS,
  WORKFLOW_OUTPUT_DESCRIPTION,
  WORKFLOW_OUTPUT_MAX_TIMEOUT_MS,
  WORKFLOW_OUTPUT_POLL_INTERVAL_MS,
} from "./constants"
import { formatRunResult } from "./format"
import type { WorkflowOutputArgs } from "./types"

function isTerminal(status: string): boolean {
  return status === "completed" || status === "error" || status === "cancelled"
}

export function createWorkflowOutputTool(manager: WorkflowManager): ToolDefinition {
  return tool({
    description: WORKFLOW_OUTPUT_DESCRIPTION,
    args: {
      run_id: tool.schema.string().describe("Workflow run ID to inspect."),
      block: tool.schema
        .boolean()
        .optional()
        .describe("Wait until the run finishes (default: false). Only applies to runs active in memory."),
      timeout: tool.schema
        .number()
        .optional()
        .describe("Max wait time in ms when block=true (default: 60000, max: 600000)."),
    },
    async execute(args: WorkflowOutputArgs, toolContext) {
      const ctx = toolContext as { abort?: AbortSignal }
      const runId = args.run_id.trim()
      const fromCheckpointOnly = manager.isCheckpointOnly(runId)

      if (args.block === true && !fromCheckpointOnly) {
        const timeoutMs = Math.min(args.timeout ?? WORKFLOW_OUTPUT_DEFAULT_TIMEOUT_MS, WORKFLOW_OUTPUT_MAX_TIMEOUT_MS)
        const startTime = Date.now()
        while (Date.now() - startTime < timeoutMs) {
          if (ctx.abort?.aborted) break
          const current = manager.getRun(runId)
          if (!current || isTerminal(current.status)) break
          await new Promise((resolve) => setTimeout(resolve, WORKFLOW_OUTPUT_POLL_INTERVAL_MS))
        }
      }

      const latest = manager.getRunOrCheckpoint(runId)
      if (!latest) {
        return `[ERROR] Workflow run not found: ${runId}`
      }

      let output = formatRunResult(latest)
      if (fromCheckpointOnly) {
        output += `\n\n> Loaded from on-disk checkpoint (run is not active in this process).`
        if (latest.status === "running" || latest.status === "pending") {
          output += ` Use workflow_resume(run_id="${runId}") to continue from completed agents.`
        }
      } else if (args.block === true && !isTerminal(latest.status)) {
        output += `\n\n> Timed out waiting; the run is still active.`
      }
      return output
    },
  })
}
