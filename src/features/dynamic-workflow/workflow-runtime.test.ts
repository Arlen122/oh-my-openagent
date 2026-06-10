import { describe, expect, test } from "bun:test"
import { WORKFLOW_SLEEP_MAX_MS } from "./constants"
import { parseWorkflowScript, runWorkflow } from "./workflow-runtime"
import type { WorkflowAgentRunner } from "./types"

describe("parseWorkflowScript", () => {
  describe("#given a valid meta export", () => {
    test("#then extracts name and description", () => {
      // given
      const script = `export const meta = { name: 'inspect', description: 'Inspect the repo' }\nawait agent('go', { label: 'x' })`

      // when
      const { meta, body } = parseWorkflowScript(script)

      // then
      expect(meta.name).toBe("inspect")
      expect(meta.description).toBe("Inspect the repo")
      expect(body).not.toContain("export const meta")
    })

    test("#then supports optional phases", () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b', phases: [{ title: 'Scan' }] }\nawait agent('go')`

      // when
      const { meta } = parseWorkflowScript(script)

      // then
      expect(meta.phases).toEqual([{ title: "Scan" }])
    })
  })

  describe("#given an invalid script", () => {
    test("#then rejects a missing meta export", () => {
      // given
      const script = `const meta = { name: 'a', description: 'b' }\nawait agent('go')`

      // when / then
      expect(() => parseWorkflowScript(script)).toThrow(/meta/)
    })

    test("#then rejects an empty name", () => {
      // given
      const script = `export const meta = { name: '', description: 'b' }`

      // when / then
      expect(() => parseWorkflowScript(script)).toThrow(/meta.name/)
    })

    test("#then rejects Date.now()", () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }\nconst t = Date.now()`

      // when / then
      expect(() => parseWorkflowScript(script)).toThrow(/deterministic/)
    })

    test("#then rejects Math.random()", () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }\nconst r = Math.random()`

      // when / then
      expect(() => parseWorkflowScript(script)).toThrow(/deterministic/)
    })

    test("#then rejects template interpolation in meta", () => {
      // given
      const name = "x"
      const script = `export const meta = { name: \`a-\${${JSON.stringify(name)}}\`, description: 'b' }`

      // when / then
      expect(() => parseWorkflowScript(script)).toThrow()
    })

    test("#then rejects phase({ title: '...' }) object form", () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }\nphase({ title: 'Scan' })`

      // when / then
      expect(() => parseWorkflowScript(script)).toThrow(/phase\(\) must be called with a string title/)
    })

    test("#then rejects phase() with a variable title", () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }\nconst t = 'Scan'\nphase(t)`

      // when / then
      expect(() => parseWorkflowScript(script)).toThrow(/string literal title/)
    })

    test("#then accepts phase('Scan') string literal form", () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }\nphase('Scan')\nawait agent('go', { label: 'x' })`

      // when / then
      expect(() => parseWorkflowScript(script)).not.toThrow()
    })
  })
})

describe("runWorkflow", () => {
  function stubRunner(handler: (prompt: string) => unknown): WorkflowAgentRunner {
    return {
      async run(prompt) {
        return handler(prompt)
      },
    }
  }

  describe("#given a single-agent workflow", () => {
    test("#then returns the script result and counts agents", async () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }\nconst r = await agent('hello', { label: 'greet' })\nreturn { r }`
      const runner = stubRunner((prompt) => `echo:${prompt}`)

      // when
      const result = await runWorkflow(script, { agent: runner })

      // then
      expect(result.agentCount).toBe(1)
      expect(result.result).toEqual({ r: "echo:hello" })
    })

    test("#then forwards opts.subagent_type to the runner", async () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }
const r = await agent('hello', { label: 'greet', subagent_type: 'explore' })
return { r }`
      const calls: Array<{ prompt: string; options: { subagentType?: string } }> = []
      const runner: WorkflowAgentRunner = {
        async run(prompt, options) {
          calls.push({ prompt, options })
          return `echo:${prompt}`
        },
      }

      // when
      const result = await runWorkflow(script, { agent: runner })

      // then
      expect(result.result).toEqual({ r: "echo:hello" })
      expect(calls).toHaveLength(1)
      expect(calls[0].options.subagentType).toBe("explore")
    })
  })

  describe("#given parallel agents", () => {
    test("#then runs thunks and preserves order", async () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }
const results = await parallel([1, 2, 3].map((n) => () => agent('n=' + n, { label: 'n' + n })))
return results`
      const runner = stubRunner((prompt) => prompt)

      // when
      const result = await runWorkflow(script, { agent: runner })

      // then
      expect(result.result).toEqual(["n=1", "n=2", "n=3"])
      expect(result.agentCount).toBe(3)
    })
  })

  describe("#given a failing agent", () => {
    test("#then the branch resolves to null and is logged", async () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }\nconst r = await agent('go', { label: 'boom' })\nreturn { r }`
      const runner = stubRunner(() => {
        throw new Error("subagent exploded")
      })

      // when
      const result = await runWorkflow(script, { agent: runner })

      // then
      expect(result.result).toEqual({ r: null })
      expect(result.logs.some((line) => line.includes("boom"))).toBe(true)
    })
  })

  describe("#given an abort signal", () => {
    test("#then aborts the run", async () => {
      // given
      const controller = new AbortController()
      controller.abort()
      const script = `export const meta = { name: 'a', description: 'b' }\nawait agent('go', { label: 'x' })`
      const runner = stubRunner((prompt) => prompt)

      // when / then
      await expect(runWorkflow(script, { agent: runner, signal: controller.signal })).rejects.toThrow(/abort/)
    })
  })

  describe("#given phase calls", () => {
    test("#then records phases in order", async () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }
phase('Scan')
await agent('s', { label: 's' })
phase('Analyze')
await agent('a', { label: 'a' })
return true`
      const runner = stubRunner((prompt) => prompt)

      // when
      const result = await runWorkflow(script, { agent: runner })

      // then
      expect(result.phases).toEqual(["Scan", "Analyze"])
    })
  })

  describe("#given sleep", () => {
    test("#then delays between steps", async () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }
await sleep(40)
return 'done'`

      // when
      const started = Date.now()
      const result = await runWorkflow(script, { agent: stubRunner(() => "ok") })
      const elapsed = Date.now() - started

      // then
      expect(result.result).toBe("done")
      expect(elapsed).toBeGreaterThanOrEqual(30)
    })

    test("#then aborts an in-flight sleep", async () => {
      // given
      const controller = new AbortController()
      const script = `export const meta = { name: 'a', description: 'b' }
await sleep(5000)
return true`
      setTimeout(() => controller.abort(), 30)

      // when / then
      await expect(
        runWorkflow(script, { agent: stubRunner(() => "ok"), signal: controller.signal }),
      ).rejects.toThrow(/abort/)
    })

    test("#then rejects per-call sleep above the cap", async () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }
await sleep(${WORKFLOW_SLEEP_MAX_MS + 1})
return true`

      // when / then
      await expect(runWorkflow(script, { agent: stubRunner(() => "ok") })).rejects.toThrow(/per-call maximum/)
    })

    test("#then rejects total sleep above the budget", async () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }
await sleep(30)
await sleep(30)
return true`

      // when / then
      await expect(
        runWorkflow(script, {
          agent: stubRunner(() => "ok"),
          sleepTotalMaxMs: 50,
        }),
      ).rejects.toThrow(/total sleep budget/)
    })
  })

  describe("#given a polling loop with sleep", () => {
    test("#then checks repeatedly until a terminal status", async () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }
const schema = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] }
let status = 'running'
for (let i = 0; i < 5 && status === 'running'; i++) {
  const check = await agent('poll', { label: 'poll ' + (i + 1), schema })
  status = check.status
  if (status === 'running' && i < 4) await sleep(10)
}
return { status, checks: 3 }`
      let calls = 0
      const runner = stubRunner(() => {
        calls++
        return calls < 3 ? { status: "running" } : { status: "success" }
      })

      // when
      const result = await runWorkflow(script, { agent: runner })

      // then
      expect(result.result).toEqual({ status: "success", checks: 3 })
      expect(calls).toBe(3)
    })
  })

  describe("#given maxAgents limit", () => {
    test("#then throws when exceeded", async () => {
      // given
      const script = `export const meta = { name: 'a', description: 'b' }
await agent('1', { label: '1' })
await agent('2', { label: '2' })
return true`
      const runner = stubRunner((prompt) => prompt)

      // when / then
      await expect(runWorkflow(script, { agent: runner, maxAgents: 1 })).rejects.toThrow(/max agents/)
    })
  })
})
