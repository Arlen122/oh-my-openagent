export interface WorkflowToolArgs {
  script: string
  args?: unknown
  run_in_background?: boolean
}

export interface WorkflowOutputArgs {
  run_id: string
  block?: boolean
  timeout?: number
}

export interface WorkflowCancelArgs {
  run_id?: string
  all?: boolean
}

export type WorkflowToolContext = {
  sessionID: string
  messageID: string
  agent?: string
  abort?: AbortSignal
  metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  callID?: string
  callId?: string
  call_id?: string
}
