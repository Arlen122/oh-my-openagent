export interface WorkflowMetaPhase {
  title: string
  detail?: string
  model?: string
}

export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowMetaPhase[]
}

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "cancelled"

export type WorkflowAgentStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "skipped"

export interface WorkflowAgentEntry {
  id: number
  label: string
  phase?: string
  status: WorkflowAgentStatus
  prompt: string
  sessionId?: string
  backgroundTaskId?: string
  resultPreview?: string
  error?: string
}

export interface WorkflowRun {
  id: string
  meta: WorkflowMeta
  status: WorkflowRunStatus
  parentSessionID: string
  parentMessageID: string
  parentAgent?: string
  parentTools?: Record<string, boolean>
  parentModel?: { providerID: string; modelID: string }
  script: string
  args?: unknown
  phases: string[]
  currentPhase?: string
  logs: string[]
  agents: WorkflowAgentEntry[]
  result?: unknown
  error?: string
  startedAt?: Date
  completedAt?: Date
  durationMs?: number
  toolCallID?: string
  childTaskIds: string[]
}

export interface WorkflowAgentRunOptions {
  label: string
  phase?: string
  schema?: Record<string, unknown>
  model?: string
  agentType?: string
  signal?: AbortSignal
}

export interface WorkflowAgentRunner {
  run(prompt: string, options: WorkflowAgentRunOptions): Promise<unknown>
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta
  result: T
  logs: string[]
  phases: string[]
  agentCount: number
  durationMs: number
}
