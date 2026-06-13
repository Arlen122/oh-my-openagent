import type { Node } from "acorn"

type AnyNode = Node & { [key: string]: unknown; start: number; end: number }

export interface AgentCallTransformResult {
  body: string
  agentSiteCount: number
}

export function transformAgentCalls(body: string, ast: AnyNode): AgentCallTransformResult {
  const calls: Array<{ start: number; end: number; siteIndex: number }> = []
  let siteIndex = 0
  collectAgentCalls(ast, (node) => {
    calls.push({ start: node.start, end: node.end, siteIndex: siteIndex++ })
  })

  if (calls.length === 0) {
    return { body, agentSiteCount: 0 }
  }

  calls.sort((a, b) => b.start - a.start)
  let transformed = body
  for (const call of calls) {
    const original = body.slice(call.start, call.end)
    if (!/^agent\s*\(/.test(original)) continue
    const argsWithParen = original.slice("agent".length)
    if (!argsWithParen.startsWith("(")) continue
    transformed =
      transformed.slice(0, call.start) +
      `__agent(${call.siteIndex}, ${argsWithParen.slice(1)}` +
      transformed.slice(call.end)
  }

  return { body: transformed, agentSiteCount: siteIndex }
}

function collectAgentCalls(node: AnyNode, onCall: (node: AnyNode) => void): void {
  if (isAgentCallExpression(node)) {
    onCall(node)
  }
  for (const child of astChildren(node)) {
    collectAgentCalls(child, onCall)
  }
}

function isAgentCallExpression(node: AnyNode): boolean {
  if (node.type !== "CallExpression") return false
  const callee = node.callee as AnyNode | undefined
  return callee?.type === "Identifier" && callee.name === "agent"
}

function astChildren(node: AnyNode): AnyNode[] {
  const children: AnyNode[] = []
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) children.push(...value.filter(isAstNode))
    else if (isAstNode(value)) children.push(value)
  }
  return children
}

function isAstNode(value: unknown): value is AnyNode {
  return !!value && typeof value === "object" && typeof (value as AnyNode).type === "string"
}
