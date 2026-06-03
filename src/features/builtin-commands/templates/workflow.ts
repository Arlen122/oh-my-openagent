export const WORKFLOW_TEMPLATE = `# Dynamic Workflow Command

Turn the user's request into a dynamic workflow: a deterministic JavaScript script that orchestrates many subagents, executed in the background by the \`workflow\` tool.

## When this fits

Use a workflow when the task decomposes into many independent subagents whose intermediate results should NOT fill your context:
- Codebase-wide audits or bug sweeps
- Large migrations across many files
- Multi-perspective review or adversarial cross-checking
- Fan-out research that is synthesized at the end

If the request is a single quick edit or only needs one or two delegations, say so and use ordinary tools or the \`task\` tool instead. Do not force a workflow.

## How to write the script

1. The first statement MUST be the literal metadata export:
   \`export const meta = { name: 'short_snake_case', description: 'non-empty description' }\`
   Optionally add \`phases: [{ title: 'Scan' }, { title: 'Analyze' }]\` for an upfront outline.
2. After meta, write plain JavaScript. No imports, require(), fs, network, Date.now(), Math.random(), or new Date().
3. Available globals:
   - \`agent(prompt, opts)\` - spawn a subagent; returns its final text, or a parsed object when \`opts.schema\` (a JSON Schema) is given.
   - \`parallel(thunks)\` - run \`() => agent(...)\` thunks concurrently; results in input order.
   - \`pipeline(items, ...stages)\` - run each item through sequential stages while items fan out.
   - \`phase(title)\` - mark the current phase for the live progress view.
   - \`log(message)\`, \`args\`, \`cwd\`, \`budget\`.
4. Call \`agent()\` at least once. Give every \`agent()\` a unique short \`label\` (2-5 words).
5. \`parallel\` takes functions, not promises: \`await parallel(items.map(item => () => agent('...', { label: '...' })))\`.
6. Subagents do not share your code context: include enough task context and relevant paths in each prompt.
7. Failed branches return null and are logged. Check for null before synthesizing conclusions. End with a synthesis \`agent()\` when combining multiple results, returning a compact JSON-serializable value.

## How to run it

Call the \`workflow\` tool with the script as a single raw string in the \`script\` parameter (no Markdown fences). It runs in the background and returns a run_id. The system notifies you when it finishes; use \`workflow_output\` to inspect progress or the final result, and \`workflow_cancel\` to stop it.

## Example

\`\`\`
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [{ title: 'Scan' }, { title: 'Analyze' }],
}

phase('Scan')
const inventory = await agent('Inspect the repository structure under ' + cwd + ' and list the main directories and entry points.', { label: 'repo inventory' })

phase('Analyze')
const summary = await agent('Summarize the main modules from this inventory:\\n' + inventory, { label: 'module summary' })

return { inventory, summary }
\`\`\`

Now design and launch a workflow for the user's request below.`
