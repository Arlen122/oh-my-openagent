/**
 * Workflow mode keyword detector.
 *
 * Triggers on `ultracode` or `workflow` to steer the agent toward the
 * `workflow` tool for script-driven, fan-out subagent orchestration.
 */

export const WORKFLOW_PATTERN = /\b(ultracode|workflow)\b/i

export const WORKFLOW_MESSAGE = `[workflow-mode]
PREFER THE workflow TOOL. This task is a good fit for a dynamic workflow: script-driven orchestration of many subagents that runs in the background.

When to use the workflow tool:
- Codebase-wide audits, large migrations, multi-perspective review, or fan-out/fan-in research
- Work that decomposes into many independent subagents whose intermediate results should NOT fill your context

How to use it:
- Call the workflow tool with a single raw JavaScript string in \`script\`.
- First statement MUST be \`export const meta = { name: 'short_snake_case', description: '...' }\`.
- Use phase('Title') (string literal), agent(prompt, { label }), parallel(thunks), pipeline(items, ...stages), sleep(ms) for poll intervals. Call agent() at least once.
- NEVER use Date.now(), new Date(), or Math.random() in the script — parse fails before run. For time/status polling, use agent()+schema; subagent reads clocks/APIs via tools.
- For polling (CI pipelines, wait-until-time, etc.): bounded for-loop with agent() checks + sleep(intervalMs); stop when schema field matches (e.g. reached:true or status:'success').
- The script MUST end with an explicit \`return\` of the final deliverable (aggregated subagent outputs). Without \`return\`, the completion summary is empty.
- The run executes in the background; the system notifies you on completion. Use workflow_output to inspect progress or results.

If the task is a single quick edit or a couple of delegations, do NOT use workflow - use ordinary tools or the task tool instead.`
