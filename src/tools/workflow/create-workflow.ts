import { tool, type PluginInput, type ToolDefinition } from "@opencode-ai/plugin"
import type { WorkflowManager } from "../../features/dynamic-workflow"
import { storeToolMetadata } from "../../features/tool-metadata-store"
import { WORKFLOW_DESCRIPTION } from "./constants"
import { buildRunMetadata, formatRunResult, resolveToolCallID } from "./format"
import {
  formatWorkflowStartResponse,
  resolveWorkflowParentContext,
  waitForTerminal,
} from "./workflow-tool-shared"
import type { WorkflowToolArgs, WorkflowToolContext } from "./types"

type OpencodeClient = PluginInput["client"]

function normalizeScript(script: string): string {
  let text = script.trim()
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i)
  if (fence) text = fence[1].trim()
  return text
}

export function createWorkflowTool(manager: WorkflowManager, client: OpencodeClient): ToolDefinition {
  return tool({
    description: WORKFLOW_DESCRIPTION,
    args: {
      script: tool.schema
        .string()
        .optional()
        .describe(
          "Raw JavaScript workflow script (no Markdown fences). First statement: export const meta = { name, description }. Must call agent() at least once. FORBIDDEN (parse fails): Date.now(), new Date(), Math.random(). Provide script, script_path, or resume_from.",
        ),
      script_path: tool.schema
        .string()
        .optional()
        .describe(
          "Path to a workflow script file relative to the project directory (e.g. .opencode/workflows/inspect.js). Mutually usable with args; do not also pass inline script unless overriding a resume.",
        ),
      resume_from: tool.schema
        .string()
        .optional()
        .describe(
          "Resume by run_id. Works for error/cancelled runs, or running/pending checkpoints after process/session interrupt.",
        ),
      args: tool.schema
        .any()
        .optional()
        .describe(
          "Optional JSON object passed into the workflow script as the global `args` (e.g. { dirs: ['src/'], focus: 'security' }). Use to parameterize reusable scripts; omit when all inputs are hardcoded in the script.",
        ),
      run_in_background: tool.schema
        .boolean()
        .optional()
        .describe("Run in the background and return a run_id immediately (default: true)."),
    },
    async execute(rawArgs: WorkflowToolArgs, toolContext) {
      const ctx = toolContext as WorkflowToolContext
      if (!rawArgs.script?.trim() && !rawArgs.script_path?.trim() && !rawArgs.resume_from?.trim()) {
        return "[ERROR] workflow requires one of: script, script_path, resume_from"
      }

      const script = rawArgs.script ? normalizeScript(rawArgs.script) : undefined
      const parentContext = await resolveWorkflowParentContext(ctx, client)
      const callID = resolveToolCallID(ctx)

      let run
      try {
        run = await manager.start({
          script,
          scriptPath: rawArgs.script_path?.trim(),
          resumeFromRunId: rawArgs.resume_from?.trim(),
          args: rawArgs.args,
          parentSessionID: parentContext.sessionID,
          parentMessageID: parentContext.messageID,
          parentAgent: parentContext.agent,
          parentModel: parentContext.model
            ? { providerID: parentContext.model.providerID, modelID: parentContext.model.modelID }
            : undefined,
          toolCallID: callID,
        })
      } catch (error) {
        return `[ERROR] Failed to start workflow: ${error instanceof Error ? error.message : String(error)}`
      }

      const meta = buildRunMetadata(run)
      await ctx.metadata?.(meta)
      if (callID) {
        storeToolMetadata(ctx.sessionID, callID, meta)
      }

      const runInBackground = rawArgs.run_in_background !== false
      if (runInBackground) {
        return formatWorkflowStartResponse(run)
      }

      const finalRun = await waitForTerminal(manager, run.id, ctx.abort)
      const finalMeta = buildRunMetadata(finalRun)
      await ctx.metadata?.(finalMeta)
      if (callID) {
        storeToolMetadata(ctx.sessionID, callID, finalMeta)
      }
      return formatRunResult(finalRun)
    },
  })
}
