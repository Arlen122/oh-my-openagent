export const WORKFLOW_PROMPT_GUIDELINES = [
  "Use workflow only when the user explicitly asks for a workflow, fan-out, or multi-agent orchestration, or when a task decomposes into dozens of independent subagents.",
  "Pass one raw JavaScript string in the required `script` parameter. Do not include Markdown fences or prose around the script.",
  "The script's first statement MUST be `export const meta = { name: 'short_snake_case', description: 'non-empty description' }`. meta.phases is optional documentation; live progress is driven by phase(title).",
  "Write plain JavaScript after the meta export. Do NOT use TypeScript syntax, imports, require(), fs, network APIs, Date.now(), Math.random(), or new Date().",
  "Available globals: agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), budget. Every workflow MUST call agent() at least once.",
  "parallel() takes functions, not promises: `await parallel(items.map(item => () => agent('...', { label: '...' })))`. Results are returned in input order.",
  "pipeline(items, ...stages) runs each item through stages sequentially while different items run concurrently. Each stage receives (previousValue, originalItem, index).",
  "Give every agent() a unique short `label` (2-5 words), e.g. { label: 'repo inventory' }. Labels drive the live status view.",
  "Failed agent()/parallel()/pipeline() branches return null and log the failure unless the run is aborted. Check for null before synthesizing conclusions.",
  "For machine-readable subagent output, pass a plain JSON Schema via opts.schema; the subagent returns the parsed object. Use JSON Schema syntax, not TypeScript.",
  "Subagents do not share the parent's code context. Include enough task context and relevant paths in each agent prompt.",
  "Workflows run in the background by default. The system notifies the parent session when the run finishes; use workflow_output to inspect progress or the final result.",
].join(" ")

export const WORKFLOW_DESCRIPTION = [
  "Execute a deterministic JavaScript workflow that orchestrates many subagents with agent(), parallel(), and pipeline().",
  "The workflow runs in the background by default and returns a run_id immediately; the session stays responsive.",
  "`script` is required raw JavaScript that must start with `export const meta = { name, description }` and must call agent() at least once.",
  WORKFLOW_PROMPT_GUIDELINES,
].join("\n\n")

export const WORKFLOW_OUTPUT_DESCRIPTION = [
  "Inspect a dynamic workflow run started by the `workflow` tool.",
  "Returns the run status, phases, per-agent progress, and (when finished) the final result.",
  "Set block=true to wait until the run reaches a terminal state (completed/error/cancelled).",
].join(" ")

export const WORKFLOW_CANCEL_DESCRIPTION = [
  "Cancel a running dynamic workflow.",
  "Provide run_id to cancel one run, or all=true to cancel every active run in this session.",
  "Cancelling aborts in-flight subagents.",
].join(" ")

export const WORKFLOW_OUTPUT_DEFAULT_TIMEOUT_MS = 60000
export const WORKFLOW_OUTPUT_MAX_TIMEOUT_MS = 600000
export const WORKFLOW_OUTPUT_POLL_INTERVAL_MS = 1000
