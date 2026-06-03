import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { WorkflowManager } from "../../features/dynamic-workflow"
import { WORKFLOW_CANCEL_DESCRIPTION } from "./constants"
import type { WorkflowCancelArgs } from "./types"

export function createWorkflowCancelTool(manager: WorkflowManager): ToolDefinition {
  return tool({
    description: WORKFLOW_CANCEL_DESCRIPTION,
    args: {
      run_id: tool.schema.string().optional().describe("Workflow run ID to cancel (required unless all=true)."),
      all: tool.schema.boolean().optional().describe("Cancel all active workflow runs in this session (default: false)."),
    },
    async execute(args: WorkflowCancelArgs, toolContext) {
      const ctx = toolContext as { sessionID: string }

      if (args.all === true) {
        const count = await manager.cancelAll(ctx.sessionID)
        return count > 0
          ? `Cancelled ${count} active workflow run(s).`
          : "No active workflow runs to cancel."
      }

      if (!args.run_id) {
        return "[ERROR] Provide a run_id or set all=true."
      }

      const run = manager.getRun(args.run_id)
      if (!run) {
        return `[ERROR] Workflow run not found: ${args.run_id}`
      }

      const cancelled = await manager.cancel(args.run_id)
      if (!cancelled) {
        return `[ERROR] Cannot cancel run ${args.run_id}: current status is "${run.status}".`
      }
      return `Workflow run cancelled: ${args.run_id} (${run.meta.name}).`
    },
  })
}
