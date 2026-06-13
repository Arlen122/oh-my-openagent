import { describe, expect, test } from "bun:test"
import { generateAutoAgentId, runWithAgentContext } from "./workflow-agent-id"

describe("generateAutoAgentId", () => {
  const scriptHash = "a".repeat(64)
  const counters = new Map<string, number>()

  test("#then increments sequential ids for the same site", () => {
    // given / when
    const first = generateAutoAgentId(scriptHash, 3, counters)
    const second = generateAutoAgentId(scriptHash, 3, counters)

    // then
    expect(first).toBe(`${scriptHash.slice(0, 16)}:site3:n0`)
    expect(second).toBe(`${scriptHash.slice(0, 16)}:site3:n1`)
  })

  test("#then uses branch index inside parallel context", async () => {
    // given
    const branchCounters = new Map<string, number>()

    // when
    const ids = await Promise.all(
      [0, 1, 2].map((branchIndex) =>
        runWithAgentContext({ branchIndex }, async () =>
          generateAutoAgentId(scriptHash, 5, branchCounters),
        ),
      ),
    )

    // then
    expect(ids).toEqual([
      `${scriptHash.slice(0, 16)}:site5:b0:n0`,
      `${scriptHash.slice(0, 16)}:site5:b1:n0`,
      `${scriptHash.slice(0, 16)}:site5:b2:n0`,
    ])
  })

  test("#then uses item index inside pipeline context", async () => {
    // given
    const pipelineCounters = new Map<string, number>()

    // when
    const id = await runWithAgentContext({ itemIndex: 4 }, async () =>
      generateAutoAgentId(scriptHash, 7, pipelineCounters),
    )

    // then
    expect(id).toBe(`${scriptHash.slice(0, 16)}:site7:i4:n0`)
  })
})
