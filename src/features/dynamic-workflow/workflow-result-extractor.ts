import type { PluginInput } from "@opencode-ai/plugin"

type OpencodeClient = PluginInput["client"]

interface SessionMessagePart {
  type: string
  text?: string
}

interface SessionMessage {
  info?: { role?: string; time?: unknown }
  parts?: SessionMessagePart[]
}

function extractMessages(value: unknown): SessionMessage[] {
  if (Array.isArray(value)) return value as SessionMessage[]
  if (value && typeof value === "object") {
    const data = (value as { data?: unknown }).data
    if (Array.isArray(data)) return data as SessionMessage[]
  }
  return []
}

/**
 * Returns the final assistant text from a session, used as an agent()'s return value.
 */
export async function extractLastAssistantText(
  client: OpencodeClient,
  sessionID: string,
): Promise<string> {
  const response = await client.session.messages({ path: { id: sessionID } })
  const messages = extractMessages(response)

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.info?.role !== "assistant" || !Array.isArray(message.parts)) continue
    const text = message.parts
      .filter((part) => (part.type === "text" || part.type === "reasoning") && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("")
    if (text.trim()) return text
  }
  return ""
}

/**
 * Parse the JSON object a schema-constrained subagent was asked to emit.
 * Falls back to the raw text when no valid JSON can be located.
 */
export function parseStructuredResult(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i)
  const candidate = fenced ? fenced[1] : extractFirstJsonObject(text)
  if (!candidate) return text
  try {
    return JSON.parse(candidate)
  } catch {
    return text
  }
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{")
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}
