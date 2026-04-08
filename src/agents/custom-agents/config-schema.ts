import { z } from "zod"

export const SubagentRefSchema = z.object({
  name: z.string().min(1),
  domain: z.string().min(1),
  when_to_use: z.string().min(1),
  default_skills: z.array(z.string()).optional(),
})

export const CustomAgentConfigSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "name must be kebab-case"),
  mode: z.enum(["primary", "subagent", "all"]),
  description: z.string().min(1),
  model: z.string().min(1).regex(/^.+\/.+$/, "model must be in provider/model-id format"),
  system_instructions: z.string().min(1),
  tools: z.array(z.string()),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  subagents: z.array(SubagentRefSchema).optional(),
})

export const CustomAgentsFileSchema = z.object({
  custom_agents: z.array(CustomAgentConfigSchema),
})

export type SubagentRef = z.infer<typeof SubagentRefSchema>
export type CustomAgentConfig = z.infer<typeof CustomAgentConfigSchema>
export type CustomAgentsFile = z.infer<typeof CustomAgentsFileSchema>

const BUILTIN_AGENT_NAMES = [
  "sisyphus",
  "hephaestus",
  "oracle",
  "librarian",
  "explore",
  "multimodal-looker",
  "metis",
  "momus",
  "atlas",
  "sisyphus-junior",
  "prometheus",
]

export interface ValidationResult {
  agents: CustomAgentConfig[]
  warnings: string[]
}

/**
 * Validates cross-referential constraints that Zod alone cannot express:
 * - primary cannot be referenced as subagent
 * - names cannot collide with builtin agents
 * - subagent refs must exist in the config
 * - primary with subagents but no "task" tool gets a warning
 */
export function validateCustomAgentsConfig(agents: CustomAgentConfig[]): ValidationResult {
  const warnings: string[] = []
  const validAgents: CustomAgentConfig[] = []
  const agentNames = new Set(agents.map(a => a.name.toLowerCase()))

  const nameCollisionFiltered = agents.filter(agent => {
    if (BUILTIN_AGENT_NAMES.includes(agent.name.toLowerCase())) {
      warnings.push(`[custom-agents] Skipping "${agent.name}": conflicts with builtin agent name`)
      return false
    }
    return true
  })

  const primaryNames = new Set(
    nameCollisionFiltered
      .filter(a => a.mode === "primary")
      .map(a => a.name.toLowerCase())
  )

  const validNameSet = new Set(nameCollisionFiltered.map(a => a.name.toLowerCase()))

  for (const agent of nameCollisionFiltered) {
    const cleanedAgent = { ...agent }

    if (cleanedAgent.subagents && cleanedAgent.subagents.length > 0) {
      const originalLength = cleanedAgent.subagents.length
      cleanedAgent.subagents = cleanedAgent.subagents.filter(ref => {
        if (primaryNames.has(ref.name.toLowerCase())) {
          warnings.push(`[custom-agents] "${agent.name}": removed subagent ref "${ref.name}" — primary agents cannot be referenced as subagents`)
          return false
        }
        if (!validNameSet.has(ref.name.toLowerCase())) {
          warnings.push(`[custom-agents] "${agent.name}": removed subagent ref "${ref.name}" — agent not found in custom_agents`)
          return false
        }
        return true
      })
    }

    if (
      (agent.mode === "primary" || agent.mode === "all") &&
      cleanedAgent.subagents &&
      cleanedAgent.subagents.length > 0 &&
      !agent.tools.includes("task")
    ) {
      warnings.push(`[custom-agents] "${agent.name}": has subagents configured but "task" tool not in tools list — agent cannot delegate`)
    }

    validAgents.push(cleanedAgent)
  }

  return { agents: validAgents, warnings }
}
