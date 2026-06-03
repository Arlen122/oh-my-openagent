import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin"
import type { WorkflowManager } from "../../features/dynamic-workflow"
import { createWorkflowTool } from "./create-workflow"
import { createWorkflowOutputTool } from "./create-workflow-output"
import { createWorkflowCancelTool } from "./create-workflow-cancel"

type OpencodeClient = PluginInput["client"]

export { createWorkflowTool } from "./create-workflow"
export { createWorkflowOutputTool } from "./create-workflow-output"
export { createWorkflowCancelTool } from "./create-workflow-cancel"

export function createWorkflowTools(
  manager: WorkflowManager,
  client: OpencodeClient,
): Record<string, ToolDefinition> {
  return {
    workflow: createWorkflowTool(manager, client),
    workflow_output: createWorkflowOutputTool(manager),
    workflow_cancel: createWorkflowCancelTool(manager),
  }
}
