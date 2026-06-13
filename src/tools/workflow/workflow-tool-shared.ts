import type { PluginInput } from "@opencode-ai/plugin"
import type { WorkflowManager, WorkflowRun } from "../../features/dynamic-workflow"
import { resolveParentContext } from "../delegate-task/executor"
import type { ToolContextWithMetadata } from "../delegate-task/types"
import { log } from "../../shared/logger"
import type { WorkflowToolContext } from "./types"

type OpencodeClient = PluginInput["client"]

export async function resolveWorkflowParentContext(ctx: WorkflowToolContext, client: OpencodeClient) {
  try {
    return await resolveParentContext(ctx as unknown as ToolContextWithMetadata, client)
  } catch (error) {
    log("[workflow] Failed to resolve parent context, falling back to ctx:", {
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      agent: ctx.agent,
      model: undefined,
    }
  }
}

export function formatWorkflowStartResponse(
  run: WorkflowRun,
  options?: { resumedFrom?: string },
): string {
  const phaseOutline = run.phases.length > 0 ? `\n计划阶段：${run.phases.join(" -> ")}` : ""
  const sessionTitle = `工作流: ${run.meta.name}`
  const progressView = run.coordinatorSessionId
    ? `\n\n[MANDATORY] You MUST now tell the user, in their language, that they can watch live progress by running the /session command and opening the "${sessionTitle}" session. Each subagent's full result is also pushed there as it finishes.
Note: the workflow tool card itself is not click-navigable (OpenCode TUI only makes the built-in task tool clickable), so /session is the way in.`
    : ""
  const resumeLine = options?.resumedFrom
    ? `\n续跑自：${options.resumedFrom}`
    : run.resumeFromRunId
      ? `\n续跑自：${run.resumeFromRunId}`
      : ""
  const checkpointLine = run.checkpointPath ? `\nCheckpoint：${run.checkpointPath}` : ""

  return `工作流已启动。

工作流：${run.meta.name}
运行 ID：${run.id}
描述：${run.meta.description}${phaseOutline}${resumeLine}${checkpointLine}

[IMPORTANT] The workflow runs in the background. Do NOT call workflow_output in a blocking loop and do NOT use block=true to wait. STOP here and wait for the automatic completion notification that will arrive in this session. Only call workflow_output(run_id="${run.id}") if the user explicitly asks for status mid-run.${progressView}`
}

export async function waitForTerminal(
  manager: WorkflowManager,
  runId: string,
  abort?: AbortSignal,
): Promise<WorkflowRun> {
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
