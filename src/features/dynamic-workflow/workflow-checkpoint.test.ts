import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createInitialCheckpoint,
  hashWorkflowScript,
  isCheckpointResumable,
  readWorkflowCheckpoint,
  writeWorkflowCheckpoint,
} from "./workflow-checkpoint"

describe("workflow checkpoint storage", () => {
  test("#then round-trips checkpoint data", () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "omo-wf-checkpoint-"))
    const script = `export const meta = { name: 'a', description: 'b' }\nawait agent('go')`
    const checkpoint = createInitialCheckpoint({
      runId: "wf_test1234",
      scriptHash: hashWorkflowScript(script),
      script,
      meta: { name: "a", description: "b" },
      phases: [],
    })
    checkpoint.agents["abc:site0:n0"] = {
      status: "done",
      result: "ok",
      label: "worker",
    }

    try {
      // when
      writeWorkflowCheckpoint(dir, checkpoint)
      const loaded = readWorkflowCheckpoint(dir, "wf_test1234")

      // then
      expect(loaded?.runId).toBe("wf_test1234")
      expect(loaded?.agents["abc:site0:n0"]?.result).toBe("ok")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("#then allows resume when running but not active in memory", () => {
    // given
    const checkpoint = createInitialCheckpoint({
      runId: "wf_stale",
      scriptHash: "abc",
      script: "export const meta = { name: 'a', description: 'b' }",
      meta: { name: "a", description: "b" },
      phases: [],
    })
    checkpoint.status = "running"

    // when / then
    expect(isCheckpointResumable(checkpoint, false)).toBe(true)
    expect(isCheckpointResumable(checkpoint, true)).toBe(false)
  })
})
