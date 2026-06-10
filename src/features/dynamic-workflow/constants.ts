export const WORKFLOW_DEFAULT_SUBAGENT = "general"
export const WORKFLOW_DEFAULT_MAX_CONCURRENCY = 16
export const WORKFLOW_MAX_CONCURRENCY_CAP = 32
export const WORKFLOW_DEFAULT_MAX_AGENTS_PER_RUN = 1000

export const WORKFLOW_NONDETERMINISM_ERROR =
  "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are forbidden (use agent()+schema for time or status checks)"

export const WORKFLOW_AGENT_POLL_INTERVAL_MS = 2000
/** Max delay per sleep() call (1 hour) */
export const WORKFLOW_SLEEP_MAX_MS = 60 * 60 * 1000
/** Max total sleep() time accumulated per workflow run (24 hours) */
export const WORKFLOW_SLEEP_TOTAL_MAX_MS = 24 * 60 * 60 * 1000
export const WORKFLOW_RESULT_PREVIEW_MAX_CHARS = 280
export const WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS = 4000

export const WORKFLOW_COORDINATOR_SESSION_TITLE_PREFIX = "工作流"
export const WORKFLOW_PROGRESS_AGENT_PREVIEW_MAX_CHARS = 160
export const WORKFLOW_AGENT_RESULT_DETAIL_MAX_CHARS = 8000
