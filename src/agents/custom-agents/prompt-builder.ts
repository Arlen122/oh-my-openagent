import type { CustomAgentConfig, SubagentRef } from "./config-schema"

function escapePipeForMarkdown(text: string): string {
  return text.replace(/\|/g, "\\|")
}

export function buildDelegationTable(subagentRefs: SubagentRef[]): string {
  if (subagentRefs.length === 0) return ""

  const header = `| Agent | Domain | When to Use |
|-------|--------|-------------|`

  const rows = subagentRefs.map(ref =>
    `| ${escapePipeForMarkdown(ref.name)} | ${escapePipeForMarkdown(ref.domain)} | ${escapePipeForMarkdown(ref.when_to_use)} |`
  )

  return [header, ...rows].join("\n")
}

function buildDelegationProtocol(): string {
  return `When delegating via the \`task\` tool, structure your prompt with these 6 sections:
1. **Context** — What the user asked and relevant background
2. **Objective** — Clear, measurable goal for the subagent
3. **Scope** — What files/areas to focus on
4. **Constraints** — What NOT to do, boundaries
5. **Output Format** — Expected deliverable format
6. **Success Criteria** — How to verify completion

Always use \`subagent_type\` parameter (not \`category\`) when delegating to your subagents.
Always provide \`load_skills=[]\ unless you need to inject specific skills.
Prompts MUST be in English.`
}

function buildSessionContinuity(): string {
  return `Every \`task\` tool call returns a \`<task_metadata>\` block containing a \`session_id\`.
You MUST:
1. Save the \`session_id\` from each task result
2. Pass it as the \`session_id\` parameter in subsequent calls to the SAME subagent
3. This preserves full conversation context, saving ~70% tokens

Example flow:
- First call: \`task(subagent_type="my-agent", prompt="...", ...)\` → returns session_id: "ses_abc"
- Follow-up: \`task(subagent_type="my-agent", session_id="ses_abc", prompt="continue with...", ...)\`

Note: \`session_id\` is NOT supported when \`run_in_background=true\`.`
}

export function buildCustomPrimaryPrompt(
  config: CustomAgentConfig,
  subagentRefs: SubagentRef[]
): string {
  const sections: string[] = []

  sections.push(`<Role>
${config.system_instructions}
</Role>`)

  if (subagentRefs.length > 0) {
    sections.push(`<Delegation_Table>
You have the following specialized subagents available for delegation:

${buildDelegationTable(subagentRefs)}

Use the \`task\` tool to delegate work to these subagents when their domain matches the task at hand.
</Delegation_Table>`)

    sections.push(`<Delegation_Protocol>
${buildDelegationProtocol()}
</Delegation_Protocol>`)

    sections.push(`<Session_Continuity>
${buildSessionContinuity()}
</Session_Continuity>`)
  }

  if (config.tools.length > 0) {
    sections.push(`<Tool_Constraints>
You have access to the following tools: ${config.tools.join(", ")}.
Only use tools from this list. If a task requires tools you don't have, delegate to an appropriate subagent.
</Tool_Constraints>`)
  }

  const constraintLines: string[] = []
  if (subagentRefs.length > 0) {
    const allowedNames = subagentRefs.map(r => r.name).join(", ")
    constraintLines.push(`You MUST ONLY delegate to these subagents: ${allowedNames}. Do NOT attempt to delegate to any other agent.`)
  }
  constraintLines.push("Do NOT fabricate tool outputs or agent responses.")
  constraintLines.push("If a task is unclear, ask the user for clarification before proceeding.")

  sections.push(`<Constraints>
${constraintLines.join("\n")}
</Constraints>`)

  return sections.join("\n\n")
}
