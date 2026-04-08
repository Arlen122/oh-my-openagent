import { describe, test, expect, beforeEach } from "bun:test"
import { customAgentsRegistry } from "./registry"

beforeEach(() => {
  customAgentsRegistry.clear()
})

describe("CustomAgentsRegistry", () => {
  test("registers and retrieves primary subagent refs", () => {
    const refs = [
      { name: "security-checker", domain: "Security", when_to_use: "Security review" },
      { name: "perf-analyzer", domain: "Performance", when_to_use: "Perf tuning" },
    ]
    customAgentsRegistry.register("code-guardian", refs)

    expect(customAgentsRegistry.isCustomPrimary("code-guardian")).toBe(true)
    expect(customAgentsRegistry.getSubagentRefs("code-guardian")).toEqual(refs)
  })

  test("isCustomPrimary is case-insensitive", () => {
    customAgentsRegistry.register("Code-Guardian", [])
    expect(customAgentsRegistry.isCustomPrimary("code-guardian")).toBe(true)
  })

  test("isCustomSubagent tracks registered subagents", () => {
    const refs = [
      { name: "security-checker", domain: "Security", when_to_use: "test" },
    ]
    customAgentsRegistry.register("code-guardian", refs)
    expect(customAgentsRegistry.isCustomSubagent("security-checker")).toBe(true)
    expect(customAgentsRegistry.isCustomSubagent("nonexistent")).toBe(false)
  })

  test("registerSubagent adds standalone subagent", () => {
    customAgentsRegistry.registerSubagent("my-sub")
    expect(customAgentsRegistry.isCustomSubagent("my-sub")).toBe(true)
  })

  test("getSubagentRefForPrimary returns correct ref", () => {
    const refs = [
      { name: "security-checker", domain: "Security", when_to_use: "test", default_skills: ["code-audit"] },
      { name: "perf-analyzer", domain: "Performance", when_to_use: "test" },
    ]
    customAgentsRegistry.register("code-guardian", refs)

    const ref = customAgentsRegistry.getSubagentRefForPrimary("code-guardian", "security-checker")
    expect(ref?.default_skills).toEqual(["code-audit"])

    const ref2 = customAgentsRegistry.getSubagentRefForPrimary("code-guardian", "nonexistent")
    expect(ref2).toBeUndefined()
  })

  test("clear resets all state", () => {
    customAgentsRegistry.register("code-guardian", [
      { name: "sub", domain: "test", when_to_use: "test" },
    ])
    customAgentsRegistry.clear()
    expect(customAgentsRegistry.isCustomPrimary("code-guardian")).toBe(false)
    expect(customAgentsRegistry.isCustomSubagent("sub")).toBe(false)
    expect(customAgentsRegistry.size).toBe(0)
  })
})

describe("Isolation scenarios", () => {
  beforeEach(() => {
    customAgentsRegistry.register("code-guardian", [
      { name: "security-checker", domain: "Security", when_to_use: "test" },
      { name: "perf-analyzer", domain: "Performance", when_to_use: "test" },
    ])
    customAgentsRegistry.registerSubagent("security-checker")
    customAgentsRegistry.registerSubagent("perf-analyzer")
  })

  test("custom primary can access its subagents", () => {
    const refs = customAgentsRegistry.getSubagentRefs("code-guardian")!
    const allowed = refs.map(r => r.name.toLowerCase())
    expect(allowed.includes("security-checker")).toBe(true)
    expect(allowed.includes("perf-analyzer")).toBe(true)
  })

  test("custom primary cannot access other subagents", () => {
    customAgentsRegistry.registerSubagent("other-sub")
    const refs = customAgentsRegistry.getSubagentRefs("code-guardian")!
    const allowed = refs.map(r => r.name.toLowerCase())
    expect(allowed.includes("other-sub")).toBe(false)
  })

  test("builtin agent check: custom subagent is detectable", () => {
    expect(customAgentsRegistry.isCustomSubagent("security-checker")).toBe(true)
    expect(customAgentsRegistry.isCustomSubagent("sisyphus-junior")).toBe(false)
  })
})
