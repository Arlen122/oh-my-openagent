import { tool, type PluginInput, type ToolDefinition } from "@opencode-ai/plugin"
import type { WorkflowManager } from "../../features/dynamic-workflow"
import { storeToolMetadata } from "../../features/tool-metadata-store"
import { resolveParentContext } from "../delegate-task/executor"
import type { ToolContextWithMetadata } from "../delegate-task/types"
import { log } from "../../shared/logger"
import { buildRunMetadata, formatRunResult, resolveToolCallID } from "./format"
import { formatWorkflowStartResponse, resolveWorkflowParentContext, waitForTerminal } from "./workflow-tool-shared"
import type { WorkflowResumeArgs, WorkflowToolContext } from "./types"

type OpencodeClient = PluginInput["client"]

export function createWorkflowResumeTool(manager: WorkflowManager, client: OpencodeClient): ToolDefinition {
  return tool({
    description:
      "Resume a failed or cancelled workflow run from its on-disk checkpoint. Replays the script from the start but skips agent() calls that already completed successfully.",
    args: {
      run_id: tool.schema.string().describe(
        "The workflow run_id to resume. Resumable when status is error/cancelled, or running/pending but no longer active in memory (interrupted).",
      ),
      args: tool.schema
        .any()
        .optional()
        .describe("Optional args override for the resumed run. Defaults to the checkpoint args."),
      run_in_background: tool.schema
        .boolean()
        .optional()
        .describe("Run in the background and return a new run_id immediately (default: true)."),
    },
    async execute(rawArgs: WorkflowResumeArgs, toolContext) {
      const ctx = toolContext as WorkflowToolContext
      const parentContext = await resolveWorkflowParentContext(ctx, client)
      const callID = resolveToolCallID(ctx)

      let run
      try {
        run = await manager.resume({
          runId: rawArgs.run_id.trim(),
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
        return `[ERROR] Failed to resume workflow: ${error instanceof Error ? error.message : String(error)}`
      }

      const meta = buildRunMetadata(run)
      await ctx.metadata?.(meta)
      if (callID) {
        storeToolMetadata(ctx.sessionID, callID, meta)
      }

      const runInBackground = rawArgs.run_in_background !== false
      if (runInBackground) {
        return formatWorkflowStartResponse(run, { resumedFrom: rawArgs.run_id.trim() })
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
