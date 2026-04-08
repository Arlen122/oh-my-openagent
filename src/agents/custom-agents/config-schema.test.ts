import { describe, test, expect } from "bun:test"
import { CustomAgentConfigSchema, CustomAgentsFileSchema, validateCustomAgentsConfig, type CustomAgentConfig } from "./config-schema"

function makeAgent(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    name: "test-agent",
    mode: "primary",
    description: "Test agent",
    model: "anthropic/claude-sonnet-4",
    system_instructions: "You are a test agent.",
    tools: ["bash", "read_file", "task"],
    ...overrides,
  }
}

describe("CustomAgentConfigSchema", () => {
  test("valid config passes", () => {
    const result = CustomAgentConfigSchema.safeParse(makeAgent())
    expect(result.success).toBe(true)
  })

  test("rejects non-kebab-case name", () => {
    const result = CustomAgentConfigSchema.safeParse(makeAgent({ name: "TestAgent" }))
    expect(result.success).toBe(false)
  })

  test("rejects invalid mode", () => {
    const result = CustomAgentConfigSchema.safeParse(makeAgent({ mode: "invalid" as any }))
    expect(result.success).toBe(false)
  })

  test("rejects model without provider prefix", () => {
    const result = CustomAgentConfigSchema.safeParse(makeAgent({ model: "claude-sonnet" }))
    expect(result.success).toBe(false)
  })

  test("accepts valid hex color", () => {
    const result = CustomAgentConfigSchema.safeParse(makeAgent({ color: "#FF6B6B" }))
    expect(result.success).toBe(true)
  })

  test("rejects invalid hex color", () => {
    const result = CustomAgentConfigSchema.safeParse(makeAgent({ color: "red" }))
    expect(result.success).toBe(false)
  })

  test("accepts empty tools array", () => {
    const result = CustomAgentConfigSchema.safeParse(makeAgent({ tools: [] }))
    expect(result.success).toBe(true)
  })

  test("accepts subagents array", () => {
    const result = CustomAgentConfigSchema.safeParse(makeAgent({
      subagents: [{
        name: "sub-agent",
        domain: "Security",
        when_to_use: "When security review needed",
      }],
    }))
    expect(result.success).toBe(true)
  })

  test("accepts subagents with default_skills", () => {
    const result = CustomAgentConfigSchema.safeParse(makeAgent({
      subagents: [{
        name: "sub-agent",
        domain: "Security",
        when_to_use: "When security review needed",
        default_skills: ["code-audit"],
      }],
    }))
    expect(result.success).toBe(true)
  })
})

describe("CustomAgentsFileSchema", () => {
  test("valid file with custom_agents array", () => {
    const result = CustomAgentsFileSchema.safeParse({
      custom_agents: [makeAgent()],
    })
    expect(result.success).toBe(true)
  })

  test("empty custom_agents array is valid", () => {
    const result = CustomAgentsFileSchema.safeParse({ custom_agents: [] })
    expect(result.success).toBe(true)
  })
})

describe("validateCustomAgentsConfig", () => {
  test("passes valid config through", () => {
    const agents = [makeAgent()]
    const { agents: result, warnings } = validateCustomAgentsConfig(agents)
    expect(result).toHaveLength(1)
    expect(warnings).toHaveLength(0)
  })

  test("skips agent with builtin name conflict", () => {
    const agents = [makeAgent({ name: "sisyphus" })]
    const { agents: result, warnings } = validateCustomAgentsConfig(agents)
    expect(result).toHaveLength(0)
    expect(warnings.some(w => w.includes("conflicts with builtin"))).toBe(true)
  })

  test("name conflict is case-insensitive", () => {
    const agents = [makeAgent({ name: "oracle" })]
    const { agents: result, warnings } = validateCustomAgentsConfig(agents)
    expect(result).toHaveLength(0)
    expect(warnings.some(w => w.includes("conflicts with builtin"))).toBe(true)
  })

  test("removes subagent ref to primary agent", () => {
    const primary = makeAgent({ name: "my-primary", mode: "primary" })
    const secondary = makeAgent({
      name: "my-secondary",
      mode: "primary",
      subagents: [{ name: "my-primary", domain: "test", when_to_use: "test" }],
    })
    const { agents: result, warnings } = validateCustomAgentsConfig([primary, secondary])
    expect(result).toHaveLength(2)
    expect(result[1].subagents).toHaveLength(0)
    expect(warnings.some(w => w.includes("primary agents cannot be referenced"))).toBe(true)
  })

  test("removes subagent ref to nonexistent agent", () => {
    const agent = makeAgent({
      subagents: [{ name: "nonexistent", domain: "test", when_to_use: "test" }],
    })
    const { agents: result, warnings } = validateCustomAgentsConfig([agent])
    expect(result).toHaveLength(1)
    expect(result[0].subagents).toHaveLength(0)
    expect(warnings.some(w => w.includes("agent not found"))).toBe(true)
  })

  test("warns when primary has subagents but no task tool", () => {
    const sub = makeAgent({ name: "my-sub", mode: "subagent", tools: ["bash"] })
    const primary = makeAgent({
      name: "my-primary",
      mode: "primary",
      tools: ["bash"],
      subagents: [{ name: "my-sub", domain: "test", when_to_use: "test" }],
    })
    const { warnings } = validateCustomAgentsConfig([primary, sub])
    expect(warnings.some(w => w.includes("task") && w.includes("not in tools list"))).toBe(true)
  })

  test("no warning when primary has task tool and subagents", () => {
    const sub = makeAgent({ name: "my-sub", mode: "subagent", tools: ["bash"] })
    const primary = makeAgent({
      name: "my-primary",
      mode: "primary",
      tools: ["bash", "task"],
      subagents: [{ name: "my-sub", domain: "test", when_to_use: "test" }],
    })
    const { warnings } = validateCustomAgentsConfig([primary, sub])
    expect(warnings.filter(w => w.includes("task"))).toHaveLength(0)
  })
})
