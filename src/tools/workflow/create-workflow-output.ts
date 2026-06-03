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
        .describe("Wait until the run finishes (default: false)."),
      timeout: tool.schema
        .number()
        .optional()
        .describe("Max wait time in ms when block=true (default: 60000, max: 600000)."),
    },
    async execute(args: WorkflowOutputArgs, toolContext) {
      const ctx = toolContext as { abort?: AbortSignal }
      const run = manager.getRun(args.run_id)
      if (!run) {
        return `[ERROR] Workflow run not found: ${args.run_id}`
      }

      if (args.block === true && !isTerminal(run.status)) {
        const timeoutMs = Math.min(args.timeout ?? WORKFLOW_OUTPUT_DEFAULT_TIMEOUT_MS, WORKFLOW_OUTPUT_MAX_TIMEOUT_MS)
        const startTime = Date.now()
        while (Date.now() - startTime < timeoutMs) {
          if (ctx.abort?.aborted) break
          const current = manager.getRun(args.run_id)
          if (!current || isTerminal(current.status)) break
          await new Promise((resolve) => setTimeout(resolve, WORKFLOW_OUTPUT_POLL_INTERVAL_MS))
        }
      }

      const latest = manager.getRun(args.run_id)
      if (!latest) {
        return `[ERROR] Workflow run not found: ${args.run_id}`
      }

      const output = formatRunResult(latest)
      if (args.block === true && !isTerminal(latest.status)) {
        return `${output}\n\n> Timed out waiting; the run is still active.`
      }
      return output
    },
  })
}
