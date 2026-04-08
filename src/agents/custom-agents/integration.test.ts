import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { loadCustomAgentsConfig } from "./config-loader"
import { createCustomAgents } from "./agent-factory"
import { customAgentsRegistry } from "./registry"

const TEST_CONFIG_DIR = path.join(os.tmpdir(), "opencode-test-custom-agents")
const TEST_CONFIG_PATH = path.join(TEST_CONFIG_DIR, "custom-agents.json")

function writeTestConfig(config: unknown): void {
  fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
  fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(config, null, 2))
}

function cleanupTestConfig(): void {
  try {
    fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
  } catch {}
}

beforeEach(() => {
  customAgentsRegistry.clear()
  cleanupTestConfig()
})

afterEach(() => {
  customAgentsRegistry.clear()
  cleanupTestConfig()
})

describe("Integration: config loading → agent registration → permission check", () => {
  test("full pipeline with valid config", () => {
    const config = {
      custom_agents: [
        {
          name: "code-guardian",
          mode: "primary",
          description: "Security-focused code guardian",
          model: "anthropic/claude-sonnet-4",
          system_instructions: "You are a security-focused orchestrator.",
          tools: ["bash", "read_file", "task"],
          color: "#FF6B6B",
          subagents: [
            {
              name: "security-checker",
              domain: "Security Analysis",
              when_to_use: "When code needs security review",
              default_skills: ["code-audit"],
            },
            {
              name: "perf-analyzer",
              domain: "Performance",
              when_to_use: "When performance optimization needed",
            },
          ],
        },
        {
          name: "security-checker",
          mode: "subagent",
          description: "Security analysis specialist",
          model: "anthropic/claude-sonnet-4",
          system_instructions: "You are a security analysis expert.",
          tools: ["bash", "read_file"],
        },
        {
          name: "perf-analyzer",
          mode: "subagent",
          description: "Performance optimization specialist",
          model: "anthropic/claude-sonnet-4",
          system_instructions: "You are a performance optimization expert.",
          tools: ["bash", "read_file"],
        },
      ],
    }

    writeTestConfig(config)
    const { agents, warnings } = loadCustomAgentsConfig(TEST_CONFIG_PATH)

    expect(agents).toHaveLength(3)
    expect(warnings).toHaveLength(0)

    const agentConfigs = createCustomAgents(agents)

    // Verify correct number of agents registered
    expect(Object.keys(agentConfigs)).toHaveLength(3)

    // Verify primary agent config
    const guardian = agentConfigs["code-guardian"]
    expect(guardian.mode).toBe("primary")
    expect(guardian.model).toBe("anthropic/claude-sonnet-4")
    expect(guardian.color).toBe("#FF6B6B")
    expect(guardian.prompt).toContain("<Role>")
    expect(guardian.prompt).toContain("security-focused orchestrator")
    expect(guardian.prompt).toContain("<Delegation_Table>")
    expect(guardian.prompt).toContain("security-checker")

    const guardianPermission = guardian.permission as Record<string, string>
    expect(guardianPermission.task).toBe("allow")
    expect(guardianPermission.call_omo_agent).toBe("deny")
    expect(guardianPermission.bash).toBe("allow")
    expect(guardianPermission.read_file).toBe("allow")

    // Verify subagent config
    const checker = agentConfigs["security-checker"]
    expect(checker.mode).toBe("subagent")
    expect(checker.prompt).toBe("You are a security analysis expert.")

    const checkerPermission = checker.permission as Record<string, string>
    expect(checkerPermission.task).toBe("deny")
    expect(checkerPermission.call_omo_agent).toBe("deny")
    expect(checkerPermission.bash).toBe("allow")
    expect(checkerPermission.read_file).toBe("allow")

    // Verify registry
    expect(customAgentsRegistry.isCustomPrimary("code-guardian")).toBe(true)
    expect(customAgentsRegistry.isCustomSubagent("security-checker")).toBe(true)
    expect(customAgentsRegistry.isCustomSubagent("perf-analyzer")).toBe(true)
  })

  test("missing config file returns empty", () => {
    const { agents, warnings } = loadCustomAgentsConfig("/nonexistent/path.json")
    expect(agents).toHaveLength(0)
    expect(warnings).toHaveLength(0)
  })

  test("empty custom_agents produces no agents", () => {
    writeTestConfig({ custom_agents: [] })
    const { agents } = loadCustomAgentsConfig(TEST_CONFIG_PATH)
    expect(agents).toHaveLength(0)

    const result = createCustomAgents(agents)
    expect(Object.keys(result)).toHaveLength(0)
  })

  test("partial invalid config loads valid agents", () => {
    writeTestConfig({
      custom_agents: [
        {
          name: "valid-agent",
          mode: "primary",
          description: "Valid",
          model: "anthropic/claude-sonnet-4",
          system_instructions: "Valid agent.",
          tools: ["bash"],
        },
        {
          name: "INVALID",
          mode: "primary",
        },
      ],
    })

    const { agents, warnings } = loadCustomAgentsConfig(TEST_CONFIG_PATH)
    expect(agents).toHaveLength(1)
    expect(agents[0].name).toBe("valid-agent")
    expect(warnings.length).toBeGreaterThan(0)
  })

  test("builtin name collision skips agent", () => {
    writeTestConfig({
      custom_agents: [
        {
          name: "sisyphus",
          mode: "primary",
          description: "Fake sisyphus",
          model: "anthropic/claude-sonnet-4",
          system_instructions: "Should be skipped.",
          tools: ["bash"],
        },
      ],
    })

    const { agents, warnings } = loadCustomAgentsConfig(TEST_CONFIG_PATH)
    expect(agents).toHaveLength(0)
    expect(warnings.some(w => w.includes("conflicts with builtin"))).toBe(true)
  })
})

describe("Integration: isolation enforcement via registry", () => {
  beforeEach(() => {
    const config = {
      custom_agents: [
        {
          name: "code-guardian",
          mode: "primary",
          description: "Primary",
          model: "anthropic/claude-sonnet-4",
          system_instructions: "Primary agent.",
          tools: ["bash", "task"],
          subagents: [
            { name: "security-checker", domain: "Security", when_to_use: "Security review" },
          ],
        },
        {
          name: "security-checker",
          mode: "subagent",
          description: "Sub",
          model: "anthropic/claude-sonnet-4",
          system_instructions: "Sub agent.",
          tools: ["bash"],
        },
      ],
    }
    writeTestConfig(config)
    const { agents } = loadCustomAgentsConfig(TEST_CONFIG_PATH)
    createCustomAgents(agents)
  })

  test("custom primary can delegate to its subagent", () => {
    const refs = customAgentsRegistry.getSubagentRefs("code-guardian")!
    const allowed = refs.map(r => r.name.toLowerCase())
    expect(allowed.includes("security-checker")).toBe(true)
  })

  test("custom primary cannot delegate to unregistered subagent", () => {
    const refs = customAgentsRegistry.getSubagentRefs("code-guardian")!
    const allowed = refs.map(r => r.name.toLowerCase())
    expect(allowed.includes("perf-analyzer")).toBe(false)
  })

  test("builtin agents cannot access custom subagents", () => {
    expect(customAgentsRegistry.isCustomSubagent("security-checker")).toBe(true)
    expect(customAgentsRegistry.isCustomPrimary("sisyphus")).toBe(false)
  })

  test("custom primary cannot delegate to builtin subagents", () => {
    const refs = customAgentsRegistry.getSubagentRefs("code-guardian")!
    const allowed = refs.map(r => r.name.toLowerCase())
    expect(allowed.includes("sisyphus-junior")).toBe(false)
    expect(allowed.includes("explore")).toBe(false)
  })
})
