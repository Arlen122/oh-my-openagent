import { describe, expect, test } from "bun:test"
import { parse } from "acorn"
import { transformAgentCalls } from "./workflow-agent-transform"

describe("transformAgentCalls", () => {
  test("#then rewrites agent() calls to __agent(siteIndex, ...)", () => {
    // given
    const body = `const a = await agent('one', { label: 'a' })
const b = await agent('two')`
    const ast = parse(body, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      ranges: true,
    })

    // when
    const result = transformAgentCalls(body, ast as never)

    // then
    expect(result.agentSiteCount).toBe(2)
    expect(result.body).toContain("__agent(0, 'one', { label: 'a' })")
    expect(result.body).toContain("__agent(1, 'two')")
  })
})
