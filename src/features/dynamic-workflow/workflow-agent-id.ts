import { AsyncLocalStorage } from "node:async_hooks"

export interface WorkflowAgentContextFrame {
  branchIndex?: number
  itemIndex?: number
}

const agentContextStorage = new AsyncLocalStorage<WorkflowAgentContextFrame[]>()

export function runWithAgentContext<T>(
  frame: WorkflowAgentContextFrame,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const stack = agentContextStorage.getStore() ?? []
  return agentContextStorage.run([...stack, frame], fn)
}

export function getAgentContextFrames(): WorkflowAgentContextFrame[] {
  return agentContextStorage.getStore() ?? []
}

export function buildSeqCounterKey(
  siteIndex: number,
  branchIndex?: number,
  itemIndex?: number,
): string {
  const branch = branchIndex === undefined ? "" : String(branchIndex)
  const item = itemIndex === undefined ? "" : String(itemIndex)
  return `${siteIndex}:${branch}:${item}`
}

export function resolveMergedAgentContext(): {
  branchIndex?: number
  itemIndex?: number
} {
  const frames = getAgentContextFrames()
  let branchIndex: number | undefined
  let itemIndex: number | undefined
  for (const frame of frames) {
    if (frame.branchIndex !== undefined) branchIndex = frame.branchIndex
    if (frame.itemIndex !== undefined) itemIndex = frame.itemIndex
  }
  return { branchIndex, itemIndex }
}

export function generateAutoAgentId(
  scriptHash: string,
  siteIndex: number,
  seqCounters: Map<string, number>,
): string {
  const { branchIndex, itemIndex } = resolveMergedAgentContext()
  const counterKey = buildSeqCounterKey(siteIndex, branchIndex, itemIndex)
  const seq = seqCounters.get(counterKey) ?? 0
  seqCounters.set(counterKey, seq + 1)

  const hashPrefix = scriptHash.slice(0, 16)
  const parts = [hashPrefix, `site${siteIndex}`]
  if (branchIndex !== undefined) parts.push(`b${branchIndex}`)
  if (itemIndex !== undefined) parts.push(`i${itemIndex}`)
  parts.push(`n${seq}`)
  return parts.join(":")
}
