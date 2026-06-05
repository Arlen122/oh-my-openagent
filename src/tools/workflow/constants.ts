export const WORKFLOW_SCRIPT_EXAMPLE = `export const meta = {
  name: 'audit_modules',
  description: 'Scan modules in parallel, deep-dive each via pipeline, then synthesize',
  phases: [{ title: 'Discover' }, { title: 'Deep dive' }, { title: 'Synthesize' }],
}

const focus = args?.focus ?? 'general'
const modules = args?.dirs ?? ['src/', 'tests/', 'docs/']
log('audit start: ' + modules.length + ' dirs, focus=' + focus + ', cwd=' + cwd)

phase('Discover')
const overviews = await parallel(
  modules.map((dir) => () =>
    agent('List key files and responsibilities under ' + cwd + '/' + dir, {
      label: 'scan ' + dir,
      subagent_type: 'explore',
    }),
  ),
)

phase('Deep dive')
const findings = await pipeline(
  modules,
  (dir) =>
    agent('Deep audit ' + dir + ' for risks and TODOs under ' + cwd, { label: 'audit ' + dir }),
  (audit, dir) =>
    agent('Summarize risks in ' + dir + ':\\n' + audit, { label: 'summarize ' + dir }),
)

phase('Synthesize')
const validFindings = findings.filter((item) => item !== null)
const report = await agent(
  'Combine these module findings into one audit report:\\n' + JSON.stringify(validFindings),
  { label: 'final report' },
)

return { overviews, findings: validFindings, report }`

export const WORKFLOW_PROMPT_GUIDELINES = [
  "Use workflow only when the user explicitly asks for a workflow, fan-out, or multi-agent orchestration, or when a task decomposes into dozens of independent subagents.",
  "Pass one raw JavaScript string in the required `script` parameter. Do not include Markdown fences or prose around the script.",
  "The script's first statement MUST be `export const meta = { name: 'short_snake_case', description: 'non-empty description' }`. meta.phases is optional documentation; live progress is driven by phase(title).",
  "MANDATORY FINAL RETURN: The script MUST end with an explicit `return` of the workflow deliverable (string or JSON-serializable object). That value becomes the completion summary shown to the caller. Omitting `return` yields an empty summary. Collect subagent outputs, synthesize them, then `return { ... }` or `return summaryText`. A trailing expression without `return` does NOT count.",
  "Write plain JavaScript after the meta export. Do NOT use TypeScript syntax, imports, require(), fs, network APIs, Date.now(), Math.random(), or new Date().",
  "Script globals (every workflow MUST call agent() at least once):",
  "agent(prompt, opts) spawns a subagent and returns its final text, or a parsed object when opts.schema is set. opts.label (2-5 words, unique) drives the live status view. opts.subagent_type routes to a real subagent (default: general). Example: `await agent('scan code patterns', { label: 'scan', subagent_type: 'explore' })`.",
  "agent(prompt, opts) supports opts.model to override the model for that subagent run. Use `provider/model` format, with optional variant suffix such as `openai/gpt-5.4 high`.",
  "parallel(thunks) runs an array of zero-arg async thunks concurrently and returns results in input order. Pass functions, NOT promises: `await parallel(items.map(item => () => agent('...', { label: '...' })))`.",
  "pipeline(items, ...stages) runs each item through stages sequentially while different items run in parallel. Each stage is `(previousValue, originalItem, index) => ...` and may call agent(). Example: `await pipeline(dirs, dir => agent('audit ' + dir, { label: 'audit ' + dir }), (result, dir) => agent('summarize ' + dir, { label: 'sum ' + dir }))`.",
  "phase(title) updates the current phase in the coordinator progress board. meta.phases is optional upfront documentation only; call phase(title) during execution to move the live phase marker.",
  "log(message) appends a diagnostic string to the run log buffer. console.log/info/warn/error are aliases. Use log() for milestones (e.g. item counts, branch decisions); logs are not shown in the coordinator session UI.",
  "args is an optional JSON value passed via the workflow tool's `args` parameter and exposed as a script global. Use it to parameterize reusable scripts without rewriting: `const dirs = args?.dirs ?? ['src/']`, `const focus = args?.focus ?? 'general'`. Omit `args` on the tool call when everything is hardcoded in the script.",
  "cwd is the project root directory string; process.cwd() returns the same path. Use them when building file paths in agent prompts because subagents do not inherit the parent's context. Example: `agent('Scan ' + cwd + '/src', { label: 'scan src' })`.",
  "budget is `{ total, spent(), remaining() }`, a token-budget tracker. When no budget is configured, remaining() is unlimited. If a budget is set, check `budget.remaining()` before large fan-outs to avoid exhausting the allowance.",
  "Give every agent() a unique short `label` (2-5 words), e.g. { label: 'repo inventory' }. Labels drive the live status view.",
  "Failed agent()/parallel()/pipeline() branches return null and log the failure unless the run is aborted. Check for null before synthesizing conclusions.",
  "For machine-readable subagent output, pass a plain JSON Schema via opts.schema; the subagent returns the parsed object. Use JSON Schema syntax, not TypeScript.",
  "Subagents do not share the parent's code context. Include enough task context and relevant paths in each agent prompt.",
  "Workflows run in the background by default. After launching, do NOT poll workflow_output in a blocking loop and do NOT call workflow_output with block=true just to wait; that wastes turns. STOP and wait for the system's completion notification, which arrives automatically in this session.",
  "After launching a background workflow, you MUST tell the user (in their language) how to watch progress: open the session named '工作流: <name>' via the /session command in the TUI to see the live checkbox progress board. This instruction to the user is mandatory on every launch.",
  "Only call workflow_output when the user explicitly asks for current status mid-run; otherwise rely on the completion notification.",
].join(" ")

export const WORKFLOW_DESCRIPTION = [
  "Execute a deterministic JavaScript workflow that orchestrates many subagents with agent(), parallel(), and pipeline().",
  "The workflow runs in the background by default and returns a run_id immediately; the session stays responsive.",
  "After launching: do NOT block on workflow_output - wait for the automatic completion notification, and you MUST tell the user they can watch live progress via the /session command (open the '工作流: <name>' session).",
  "`script` is required raw JavaScript that must start with `export const meta = { name, description }`, must call agent() at least once, and MUST `return` a final result for the completion summary.",
  "Complete script example (agent, parallel, pipeline, phase, log, args, cwd, explicit return; pass as one raw string, no Markdown fences):",
  WORKFLOW_SCRIPT_EXAMPLE,
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
