import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { CustomAgentsFileSchema, validateCustomAgentsConfig, type CustomAgentConfig, type ValidationResult } from "./config-schema"
import { log } from "../../shared/logger"

const CONFIG_PATH = path.join(os.homedir(), ".opencode", "custom-agents.json")

export function loadCustomAgentsConfig(configPath?: string): ValidationResult {
  const filePath = configPath ?? CONFIG_PATH

  if (!fs.existsSync(filePath)) {
    return { agents: [], warnings: [] }
  }

  let raw: unknown
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    raw = JSON.parse(content)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log("[custom-agents] Failed to read/parse config", { path: filePath, error: msg })
    return { agents: [], warnings: [`[custom-agents] Failed to parse ${filePath}: ${msg}`] }
  }

  const parseResult = CustomAgentsFileSchema.safeParse(raw)
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map(i => `${i.path.join(".")}: ${i.message}`)
    log("[custom-agents] Config validation failed", { issues })

    // Try partial loading: parse each agent individually, skip invalid ones
    const warnings: string[] = []
    const validAgents: CustomAgentConfig[] = []
    const rawObj = raw as { custom_agents?: unknown[] }

    if (rawObj?.custom_agents && Array.isArray(rawObj.custom_agents)) {
      for (let i = 0; i < rawObj.custom_agents.length; i++) {
        const singleParse = CustomAgentsFileSchema.shape.custom_agents.element.safeParse(rawObj.custom_agents[i])
        if (singleParse.success) {
          validAgents.push(singleParse.data)
        } else {
          const agentName = (rawObj.custom_agents[i] as { name?: string })?.name ?? `index ${i}`
          warnings.push(`[custom-agents] Skipping agent "${agentName}": ${singleParse.error.issues.map(i => i.message).join(", ")}`)
        }
      }
    }

    return validateCustomAgentsConfig(validAgents).agents.length > 0
      ? { ...validateCustomAgentsConfig(validAgents), warnings: [...warnings, ...validateCustomAgentsConfig(validAgents).warnings] }
      : { agents: [], warnings }
  }

  return validateCustomAgentsConfig(parseResult.data.custom_agents)
}
