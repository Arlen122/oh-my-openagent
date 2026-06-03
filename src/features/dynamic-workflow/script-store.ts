import { mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

export interface SaveWorkflowScriptInput {
  directory: string
  scriptsDir?: string
  name: string
  script: string
}

const WORKFLOW_TYPE_REFERENCE = '/// <reference types="oh-my-opencode/workflow" />'

export function resolveScriptsDir(directory: string, scriptsDir?: string): string {
  if (scriptsDir && scriptsDir.trim()) {
    return isAbsolute(scriptsDir) ? scriptsDir : join(directory, scriptsDir)
  }
  return join(directory, ".opencode", "workflows")
}

export function sanitizeWorkflowName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return cleaned || "workflow"
}

export async function saveWorkflowScript(input: SaveWorkflowScriptInput): Promise<string> {
  const dir = resolveScriptsDir(input.directory, input.scriptsDir)
  await mkdir(dir, { recursive: true })

  const fileName = `${sanitizeWorkflowName(input.name)}.js`
  const filePath = join(dir, fileName)

  const hasReference = input.script.includes("<reference types=")
  const contents = hasReference ? input.script : `${WORKFLOW_TYPE_REFERENCE}\n\n${input.script}\n`

  await writeFile(filePath, contents, "utf8")
  return filePath
}
