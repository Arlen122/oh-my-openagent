import { tool, type PluginInput, type ToolDefinition } from "@opencode-ai/plugin"
import type { WorkflowManager } from "../../features/dynamic-workflow"
import { storeToolMetadata } from "../../features/tool-metadata-store"
import { resolveParentContext } from "../delegate-task/executor"
import type { ToolContextWithMetadata } from "../delegate-task/types"
import { log } from "../../shared/logger"
import { WORKFLOW_DESCRIPTION } from "./constants"
import { buildRunMetadata, formatRunResult, resolveToolCallID } from "./format"
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
        .describe(
          "Raw JavaScript workflow script (no Markdown fences). First statement: export const meta = { name, description }. Must call agent() at least once.",
        ),
      args: tool.schema
        .any()
        .optional()
        .describe("Optional JSON value exposed to the workflow script as the global `args`."),
      run_in_background: tool.schema
        .boolean()
        .optional()
        .describe("Run in the background and return a run_id immediately (default: true)."),
    },
    async execute(rawArgs: WorkflowToolArgs, toolContext) {
      const ctx = toolContext as WorkflowToolContext
      const script = normalizeScript(rawArgs.script)

      let parentContext: Awaited<ReturnType<typeof resolveParentContext>>
      try {
        parentContext = await resolveParentContext(ctx as unknown as ToolContextWithMetadata, client)
      } catch (error) {
        log("[workflow] Failed to resolve parent context, falling back to ctx:", {
          error: error instanceof Error ? error.message : String(error),
        })
        parentContext = {
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          agent: ctx.agent,
          model: undefined,
        }
      }

      const callID = resolveToolCallID(ctx)

      let run
      try {
        run = manager.start({
          script,
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
        const phaseOutline = run.phases.length > 0 ? `\nPlanned phases: ${run.phases.join(" -> ")}` : ""
        return `Workflow launched.

Workflow: ${run.meta.name}
Run ID: ${run.id}
Description: ${run.meta.description}${phaseOutline}

The workflow runs in the background. The system notifies you when it finishes.
Use \`workflow_output\` with run_id="${run.id}" to inspect progress or the final result.`
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

async function waitForTerminal(
  manager: WorkflowManager,
  runId: string,
  abort?: AbortSignal,
) {
  while (true) {
    const run = manager.getRun(runId)
    if (!run) throw new Error(`Workflow run disappeared: ${runId}`)
    if (run.status === "completed" || run.status === "error" || run.status === "cancelled") {
      return run
    }
    if (abort?.aborted) {
      await manager.cancel(runId)
      const cancelled = manager.getRun(runId)
      if (cancelled) return cancelled
      throw new Error(`Workflow run disappeared: ${runId}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
