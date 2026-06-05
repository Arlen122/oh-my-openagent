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
        run = await manager.start({
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
        const phaseOutline = run.phases.length > 0 ? `\n计划阶段：${run.phases.join(" -> ")}` : ""
        const sessionTitle = `工作流: ${run.meta.name}`
        const progressView = run.coordinatorSessionId
          ? `\n\n[MANDATORY] You MUST now tell the user, in their language, that they can watch live progress by running the /session command and opening the "${sessionTitle}" session. Each subagent's full result is also pushed there as it finishes.
Note: the workflow tool card itself is not click-navigable (OpenCode TUI only makes the built-in task tool clickable), so /session is the way in.`
          : ""
        return `工作流已启动。

工作流：${run.meta.name}
运行 ID：${run.id}
描述：${run.meta.description}${phaseOutline}

[IMPORTANT] The workflow runs in the background. Do NOT call workflow_output in a blocking loop and do NOT use block=true to wait. STOP here and wait for the automatic completion notification that will arrive in this session. Only call workflow_output(run_id="${run.id}") if the user explicitly asks for status mid-run.${progressView}`
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
