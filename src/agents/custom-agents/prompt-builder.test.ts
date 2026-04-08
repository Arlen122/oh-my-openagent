import { describe, test, expect } from "bun:test"
import { buildCustomPrimaryPrompt, buildDelegationTable } from "./prompt-builder"
import type { CustomAgentConfig, SubagentRef } from "./config-schema"

function makeConfig(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    name: "code-guardian",
    mode: "primary",
    description: "Code guardian primary agent",
    model: "anthropic/claude-sonnet-4",
    system_instructions: "You are a code guardian that reviews and secures codebases.",
    tools: ["bash", "read_file", "task"],
    ...overrides,
  }
}

const sampleSubagents: SubagentRef[] = [
  {
    name: "security-checker",
    domain: "Security Analysis",
    when_to_use: "When code needs security review or vulnerability scanning",
    default_skills: ["code-audit"],
  },
  {
    name: "perf-analyzer",
    domain: "Performance",
    when_to_use: "When performance profiling or optimization is needed",
  },
]

describe("buildDelegationTable", () => {
  test("generates markdown table with subagent rows", () => {
    const table = buildDelegationTable(sampleSubagents)
    expect(table).toContain("| Agent | Domain | When to Use |")
    expect(table).toContain("| security-checker | Security Analysis |")
    expect(table).toContain("| perf-analyzer | Performance |")
  })

  test("returns empty string for no subagents", () => {
    expect(buildDelegationTable([])).toBe("")
  })

  test("escapes pipe characters in domain and when_to_use", () => {
    const refs: SubagentRef[] = [{
      name: "test-agent",
      domain: "Domain A | Domain B",
      when_to_use: "When X | Y happens",
    }]
    const table = buildDelegationTable(refs)
    expect(table).toContain("Domain A \\| Domain B")
    expect(table).toContain("When X \\| Y happens")
  })
})

describe("buildCustomPrimaryPrompt", () => {
  test("generates full prompt with all sections for primary with subagents", () => {
    const config = makeConfig()
    const prompt = buildCustomPrimaryPrompt(config, sampleSubagents)

    expect(prompt).toContain("<Role>")
    expect(prompt).toContain("You are a code guardian")
    expect(prompt).toContain("</Role>")

    expect(prompt).toContain("<Delegation_Table>")
    expect(prompt).toContain("security-checker")
    expect(prompt).toContain("perf-analyzer")
    expect(prompt).toContain("</Delegation_Table>")

    expect(prompt).toContain("<Delegation_Protocol>")
    expect(prompt).toContain("</Delegation_Protocol>")

    expect(prompt).toContain("<Session_Continuity>")
    expect(prompt).toContain("session_id")
    expect(prompt).toContain("</Session_Continuity>")

    expect(prompt).toContain("<Tool_Constraints>")
    expect(prompt).toContain("bash, read_file, task")
    expect(prompt).toContain("</Tool_Constraints>")

    expect(prompt).toContain("<Constraints>")
    expect(prompt).toContain("MUST ONLY delegate to these subagents: security-checker, perf-analyzer")
    expect(prompt).toContain("</Constraints>")
  })

  test("generates simplified prompt without delegation sections when no subagents", () => {
    const config = makeConfig()
    const prompt = buildCustomPrimaryPrompt(config, [])

    expect(prompt).toContain("<Role>")
    expect(prompt).toContain("<Tool_Constraints>")
    expect(prompt).toContain("<Constraints>")

    expect(prompt).not.toContain("<Delegation_Table>")
    expect(prompt).not.toContain("<Session_Continuity>")
    expect(prompt).not.toContain("<Delegation_Protocol>")
  })

  test("constraints section does not mention delegation when no subagents", () => {
    const config = makeConfig()
    const prompt = buildCustomPrimaryPrompt(config, [])
    expect(prompt).not.toContain("MUST ONLY delegate")
  })
})
