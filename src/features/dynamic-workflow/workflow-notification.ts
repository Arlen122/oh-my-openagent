import type { PluginInput } from "@opencode-ai/plugin"
import { createInternalAgentTextPart } from "../../shared/internal-initiator-marker"
import { log } from "../../shared/logger"
import { WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS } from "./constants"
import type { WorkflowRun } from "./types"

type OpencodeClient = PluginInput["client"]

type ClientWithTui = {
  tui?: {
    showToast: (opts: {
      body: { title: string; message: string; variant: string; duration: number }
    }) => Promise<unknown>
  }
}

export interface NotifyWorkflowOptions {
  client: OpencodeClient
  run: WorkflowRun
  shouldReply: boolean
  enableParentNotifications: boolean
}

/**
 * Show a toast when a workflow starts. The OpenCode TUI only renders a clickable
 * card for the built-in `task` tool, so the workflow card itself is not
 * clickable; this toast tells the user to open the progress session via /session.
 */
export function notifyWorkflowStarted(client: OpencodeClient, run: WorkflowRun): void {
  const tuiClient = client as ClientWithTui
  if (!tuiClient.tui?.showToast) return

  tuiClient.tui
    .showToast({
      body: {
        title: "工作流已启动",
        message: `"${run.meta.name}" 运行中。输入 /session 打开名为「工作流: ${run.meta.name}」的会话查看实时进度。`,
        variant: "success",
        duration: 6000,
      },
    })
    .catch(() => {})
}

export function buildWorkflowNotificationText(run: WorkflowRun): string {
  const statusLabel =
    run.status === "completed"
      ? "WORKFLOW COMPLETED"
      : run.status === "cancelled"
        ? "WORKFLOW CANCELLED"
        : "WORKFLOW ERROR"

  const doneCount = run.agents.filter((agent) => agent.status === "done").length
  const lines: string[] = [
    `[${statusLabel}] ${run.meta.name}`,
    `Run ID: ${run.id}`,
    `Duration: ${formatDuration(run.durationMs)}`,
    `Agents: ${doneCount}/${run.agents.length} succeeded`,
  ]

  if (run.phases.length > 0) {
    lines.push(`Phases: ${run.phases.join(" -> ")}`)
  }

  if (run.status === "error" && run.error) {
    lines.push("", `Error: ${run.error}`)
  }

  if (run.status === "completed") {
    lines.push("", "Result summary:", truncate(formatResult(run.result), WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS))
  }

  lines.push("", `Use workflow_output(run_id="${run.id}") for the full result.`)
  return lines.join("\n")
}

export async function notifyWorkflowComplete(options: NotifyWorkflowOptions): Promise<void> {
  const { client, run } = options

  showToast(client, run)

  if (!options.enableParentNotifications) {
    return
  }

  const notification = buildWorkflowNotificationText(run)

  try {
    await client.session.promptAsync({
      path: { id: run.parentSessionID },
      body: {
        noReply: !options.shouldReply,
        ...(run.parentAgent !== undefined ? { agent: run.parentAgent } : {}),
        ...(run.parentModel !== undefined ? { model: run.parentModel } : {}),
        ...(run.parentTools ? { tools: run.parentTools } : {}),
        parts: [createInternalAgentTextPart(notification)],
      },
    })
  } catch (error) {
    log("[dynamic-workflow] Failed to notify parent session:", {
      runId: run.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function showToast(client: OpencodeClient, run: WorkflowRun): void {
  const tuiClient = client as ClientWithTui
  if (!tuiClient.tui?.showToast) return

  const variant = run.status === "completed" ? "success" : run.status === "cancelled" ? "warning" : "error"
  tuiClient.tui
    .showToast({
      body: {
        title: `Workflow ${run.status}`,
        message: `"${run.meta.name}" ${run.status} in ${formatDuration(run.durationMs)}`,
        variant,
        duration: 5000,
      },
    })
    .catch(() => {})
}

function formatResult(result: unknown): string {
  if (result === undefined) return "(no result returned)"
  if (typeof result === "string") return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n... (truncated, ${text.length - maxChars} more chars)`
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "unknown"
  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
