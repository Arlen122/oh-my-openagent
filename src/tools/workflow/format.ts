import type { WorkflowRun } from "../../features/dynamic-workflow"

export function buildRunMetadata(run: WorkflowRun): {
  title: string
  metadata: Record<string, unknown>
} {
  return {
    title: run.meta.description || run.meta.name,
    metadata: {
      // Records the coordinator session id (which hosts the live progress board)
      // in tool metadata. Note: the stock OpenCode TUI does not make non-`task`
      // tool cards clickable, so the user opens this session via /session.
      ...(run.coordinatorSessionId ? { sessionId: run.coordinatorSessionId } : {}),
      workflowRunId: run.id,
      workflowName: run.meta.name,
      status: run.status,
      ...(run.scriptPath ? { scriptPath: run.scriptPath } : {}),
      ...(run.resumeFromRunId ? { resumeFromRunId: run.resumeFromRunId } : {}),
      ...(run.checkpointPath ? { checkpointPath: run.checkpointPath } : {}),
      phases: run.phases,
      currentPhase: run.currentPhase,
      agentCount: run.agents.length,
      doneCount: run.agents.filter((agent) => agent.status === "done").length,
      runningCount: run.agents.filter((agent) => agent.status === "running").length,
      agents: run.agents.map((agent) => ({
        label: agent.label,
        status: agent.status,
        phase: agent.phase,
        ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
      })),
    },
  }
}

export function formatRunStatus(run: WorkflowRun): string {
  const doneCount = run.agents.filter((agent) => agent.status === "done").length
  const runningCount = run.agents.filter((agent) => agent.status === "running").length
  const errorCount = run.agents.filter((agent) => agent.status === "error").length

  const lines: string[] = [
    `Workflow: ${run.meta.name}`,
    `Run ID: ${run.id}`,
    `Status: ${run.status}`,
  ]

  if (run.phases.length > 0) {
    const phaseLabel = run.currentPhase ? ` (current: ${run.currentPhase})` : ""
    lines.push(`Phases: ${run.phases.join(" -> ")}${phaseLabel}`)
  }

  lines.push(`Agents: ${run.agents.length} total | ${doneCount} done | ${runningCount} running | ${errorCount} error`)

  if (run.agents.length > 0) {
    lines.push("", "Agent detail:")
    for (const agent of run.agents) {
      const session = agent.sessionId ? ` [session: ${agent.sessionId}]` : ""
      const detail = agent.status === "error" && agent.error ? ` (${agent.error})` : ""
      lines.push(`- #${agent.id} [${agent.status}] ${agent.label}${session}${detail}`)
    }
  }

  if (run.status === "error" && run.error) {
    lines.push("", `Error: ${run.error}`)
  }

  return lines.join("\n")
}

export function formatRunResult(run: WorkflowRun): string {
  const status = formatRunStatus(run)
  if (run.status !== "completed") {
    return status
  }

  const result = formatResultValue(run.result)
  return `${status}\n\n---\n\nResult:\n${result}`
}

function formatResultValue(result: unknown): string {
  if (result === undefined) return "(no result returned)"
  if (typeof result === "string") return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

export function resolveToolCallID(ctx: {
  callID?: string
  callId?: string
  call_id?: string
}): string | undefined {
  if (typeof ctx.callID === "string" && ctx.callID.trim() !== "") return ctx.callID
  if (typeof ctx.callId === "string" && ctx.callId.trim() !== "") return ctx.callId
  if (typeof ctx.call_id === "string" && ctx.call_id.trim() !== "") return ctx.call_id
  return undefined
}
