import type { SubagentRef } from "./config-schema"

/**
 * Module-level registry mapping primary agent names to their allowed subagent refs.
 * Used by the task tool's isolation logic to enforce delegation boundaries.
 */
class CustomAgentsRegistryImpl {
  private primaryToSubagents = new Map<string, SubagentRef[]>()
  private allCustomSubagentNames = new Set<string>()

  register(primaryName: string, subagentRefs: SubagentRef[]): void {
    this.primaryToSubagents.set(primaryName.toLowerCase(), subagentRefs)
    for (const ref of subagentRefs) {
      this.allCustomSubagentNames.add(ref.name.toLowerCase())
    }
  }

  registerSubagent(name: string): void {
    this.allCustomSubagentNames.add(name.toLowerCase())
  }

  getSubagentRefs(primaryName: string): SubagentRef[] | undefined {
    return this.primaryToSubagents.get(primaryName.toLowerCase())
  }

  isCustomPrimary(name: string): boolean {
    return this.primaryToSubagents.has(name.toLowerCase())
  }

  isCustomSubagent(name: string): boolean {
    return this.allCustomSubagentNames.has(name.toLowerCase())
  }

  /**
   * Find the SubagentRef for a given subagent name within a specific primary's config.
   * Used to retrieve default_skills during delegation.
   */
  getSubagentRefForPrimary(primaryName: string, subagentName: string): SubagentRef | undefined {
    const refs = this.primaryToSubagents.get(primaryName.toLowerCase())
    if (!refs) return undefined
    return refs.find(r => r.name.toLowerCase() === subagentName.toLowerCase())
  }

  clear(): void {
    this.primaryToSubagents.clear()
    this.allCustomSubagentNames.clear()
  }

  get size(): number {
    return this.primaryToSubagents.size
  }
}

export const customAgentsRegistry = new CustomAgentsRegistryImpl()
