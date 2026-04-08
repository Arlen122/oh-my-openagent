import type { AgentConfig } from "@opencode-ai/sdk"
import type { CustomAgentConfig, SubagentRef } from "./config-schema"
import { buildCustomPrimaryPrompt } from "./prompt-builder"
import { customAgentsRegistry } from "./registry"
import { log } from "../../shared/logger"

function buildPermission(config: CustomAgentConfig): Record<string, string> {
  const permission: Record<string, string> = {}

  if (config.mode === "subagent") {
    permission.task = "deny"
    permission.call_omo_agent = "deny"
  } else {
    if (config.tools.includes("task")) {
      permission.task = "allow"
      permission.call_omo_agent = "deny"
    } else {
      permission.task = "deny"
      permission.call_omo_agent = "deny"
    }
  }

  for (const toolName of config.tools) {
    if (toolName === "task") continue
    permission[toolName] = "allow"
  }

  return permission
}

export function buildCustomAgentConfig(
  agentDef: CustomAgentConfig,
  subagentRefs: SubagentRef[]
): AgentConfig {
  const isPrimaryLike = agentDef.mode === "primary" || agentDef.mode === "all"
  const hasSubagents = subagentRefs.length > 0

  const prompt = isPrimaryLike && hasSubagents
    ? buildCustomPrimaryPrompt(agentDef, subagentRefs)
    : isPrimaryLike
      ? buildCustomPrimaryPrompt(agentDef, [])
      : agentDef.system_instructions

  const agentConfig: AgentConfig = {
    description: agentDef.description,
    mode: agentDef.mode,
    model: agentDef.model,
    prompt,
    permission: buildPermission(agentDef) as AgentConfig["permission"],
  }

  if (agentDef.color) {
    agentConfig.color = agentDef.color
  }

  return agentConfig
}

/**
 * Creates all custom agent configs from the validated configuration.
 * Also populates the customAgentsRegistry for isolation enforcement.
 */
export function createCustomAgents(
  agents: CustomAgentConfig[]
): Record<string, AgentConfig> {
  if (agents.length === 0) return {}

  customAgentsRegistry.clear()

  const agentMap = new Map(agents.map(a => [a.name.toLowerCase(), a]))
  const result: Record<string, AgentConfig> = {}

  for (const agent of agents) {
    const subagentRefs = agent.subagents ?? []

    const config = buildCustomAgentConfig(agent, subagentRefs)
    result[agent.name] = config

    if (agent.mode === "primary" || agent.mode === "all") {
      customAgentsRegistry.register(agent.name, subagentRefs)
    }

    if (agent.mode === "subagent") {
      customAgentsRegistry.registerSubagent(agent.name)
    }
  }

  log("[custom-agents] Registered custom agents", {
    total: agents.length,
    primaries: agents.filter(a => a.mode === "primary").map(a => a.name),
    subagents: agents.filter(a => a.mode === "subagent").map(a => a.name),
  })

  return result
}
