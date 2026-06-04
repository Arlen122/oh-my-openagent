import type { PluginInput } from "@opencode-ai/plugin"
import { createInternalAgentTextPart } from "../../shared/internal-initiator-marker"
import { log } from "../../shared/logger"
import {
  WORKFLOW_AGENT_RESULT_DETAIL_MAX_CHARS,
  WORKFLOW_PROGRESS_AGENT_PREVIEW_MAX_CHARS,
} from "./constants"
import type { WorkflowAgentEntry, WorkflowRun } from "./types"

type OpencodeClient = PluginInput["client"]

// The coordinator message box renders plain text only (no markdown), so use
// ASCII checkboxes that read clearly without styling.
const STATUS_CHECKBOX: Record<WorkflowAgentEntry["status"], string> = {
  queued: "[ ]",
  running: "[~]",
  done: "[x]",
  error: "[!]",
  skipped: "[-]",
}

const STATUS_LABEL: Record<WorkflowAgentEntry["status"], string> = {
  queued: "排队中",
  running: "进行中",
  done: "已完成",
  error: "失败",
  skipped: "已跳过",
}

const RUN_STATUS_HEADER: Record<WorkflowRun["status"], string> = {
  pending: "工作流准备中",
  running: "工作流运行中",
  completed: "工作流已完成",
  error: "工作流出错",
  cancelled: "工作流已取消",
}

/**
 * Render the current workflow state as a plain-text checkbox board for the
 * coordinator session (opened via /session). The message box does not render
 * markdown, so this avoids headings/bold/inline-code and uses plain text only.
 *
 * Counts are shown as separate labeled tallies instead of a "done/total"
 * fraction: agents are discovered as the script runs, so the total grows over
 * time and a moving denominator is confusing. "已发现任务" makes it explicit
 * that the total is what has been spawned so far, not a fixed plan size.
 */
export function buildProgressBoard(run: WorkflowRun): string {
  const doneCount = run.agents.filter((agent) => agent.status === "done").length
  const runningCount = run.agents.filter((agent) => agent.status === "running").length
  const queuedCount = run.agents.filter((agent) => agent.status === "queued").length
  const errorCount = run.agents.filter((agent) => agent.status === "error").length
  const total = run.agents.length

  const lines: string[] = [`${RUN_STATUS_HEADER[run.status]}: ${run.meta.name}`]

  if (run.meta.description) {
    lines.push(run.meta.description)
  }

  lines.push(
    "",
    `已完成 ${doneCount} | 进行中 ${runningCount} | 排队 ${queuedCount} | 失败 ${errorCount} | 已发现任务 ${total}`,
  )

  if (run.phases.length > 0) {
    const current = run.currentPhase ? ` (当前: ${run.currentPhase})` : ""
    lines.push("", `阶段: ${run.phases.join(" -> ")}${current}`)
  }

  if (run.agents.length > 0) {
    lines.push("", "任务清单:")
    for (const agent of run.agents) {
      const checkbox = STATUS_CHECKBOX[agent.status]
      const phase = agent.phase ? ` (${agent.phase})` : ""
      const detail = agentDetail(agent)
      lines.push(`${checkbox} #${agent.id} ${agent.label} - ${STATUS_LABEL[agent.status]}${phase}${detail}`)
    }
  }

  if (run.status === "error" && run.error) {
    lines.push("", `错误: ${run.error}`)
  }

  return lines.join("\n")
}

/**
 * Build a self-contained detail message for one finished agent so the user can
 * read its full output directly in the coordinator session, without needing to
 * drill into the subagent's own session (which is not click/keyboard navigable
 * in the stock OpenCode TUI). Plain text only.
 */
export function buildAgentCompletionMessage(
  agent: WorkflowAgentEntry,
  fullResult: unknown,
): string {
  const checkbox = STATUS_CHECKBOX[agent.status]
  const phase = agent.phase ? ` (${agent.phase})` : ""
  const header = `${checkbox} #${agent.id} ${agent.label} - ${STATUS_LABEL[agent.status]}${phase}`

  if (agent.status === "error") {
    return `${header}\n\n错误: ${agent.error ?? "子代理执行失败"}`
  }

  const body = formatResultBody(fullResult)
  return `${header}\n\n${truncate(body, WORKFLOW_AGENT_RESULT_DETAIL_MAX_CHARS)}`
}

function formatResultBody(result: unknown): string {
  if (result === null || result === undefined) return "(无输出)"
  if (typeof result === "string") return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function agentDetail(agent: WorkflowAgentEntry): string {
  if (agent.status === "error" && agent.error) {
    return ` -- ${agent.error}`
  }
  if (agent.status === "done" && agent.resultPreview) {
    return ` -- ${truncate(agent.resultPreview, WORKFLOW_PROGRESS_AGENT_PREVIEW_MAX_CHARS)}`
  }
  return ""
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max)}...`
}

/**
 * Post a message into the workflow coordinator session. Uses `noReply` so the
 * side session never spawns its own agent turn; it only acts as a live progress
 * board / log the user can open from the TUI session list.
 */
export async function postToCoordinator(
  client: OpencodeClient,
  run: WorkflowRun,
  text: string,
): Promise<void> {
  if (!run.coordinatorSessionId) return

  try {
    await client.session.promptAsync({
      path: { id: run.coordinatorSessionId },
      body: {
        noReply: true,
        ...(run.parentAgent !== undefined ? { agent: run.parentAgent } : {}),
        ...(run.parentModel !== undefined ? { model: run.parentModel } : {}),
        parts: [createInternalAgentTextPart(text)],
      },
    })
  } catch (error) {
    log("[dynamic-workflow] Failed to post to coordinator session:", {
      runId: run.id,
      coordinatorSessionId: run.coordinatorSessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Push a full checkbox progress snapshot into the coordinator session. */
export async function pushProgressBoard(
  client: OpencodeClient,
  run: WorkflowRun,
): Promise<void> {
  await postToCoordinator(client, run, buildProgressBoard(run))
}
