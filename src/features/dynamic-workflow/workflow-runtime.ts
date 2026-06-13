import vm from "node:vm"
import { parse } from "acorn"
import type { Node } from "acorn"
import { generateAutoAgentId, runWithAgentContext } from "./workflow-agent-id"
import { transformAgentCalls } from "./workflow-agent-transform"
import type { WorkflowCheckpointAgentEntry } from "./workflow-checkpoint"
import { hashWorkflowScript } from "./workflow-checkpoint"
import {
  WORKFLOW_DEFAULT_MAX_AGENTS_PER_RUN,
  WORKFLOW_DEFAULT_MAX_CONCURRENCY,
  WORKFLOW_MAX_CONCURRENCY_CAP,
  WORKFLOW_NONDETERMINISM_ERROR,
  WORKFLOW_SLEEP_MAX_MS,
  WORKFLOW_SLEEP_TOTAL_MAX_MS,
} from "./constants"
import type {
  WorkflowAgentRunner,
  WorkflowMeta,
  WorkflowMetaPhase,
  WorkflowRunResult,
} from "./types"

type AnyNode = Node & { [key: string]: unknown; start: number; end: number }

export interface RunWorkflowOptions {
  agent: WorkflowAgentRunner
  cwd?: string
  args?: unknown
  concurrency?: number
  maxAgents?: number
  tokenBudget?: number | null
  /** Override per-call sleep() cap (default WORKFLOW_SLEEP_MAX_MS). */
  sleepPerCallMaxMs?: number
  /** Override total sleep() budget per run (default WORKFLOW_SLEEP_TOTAL_MAX_MS). */
  sleepTotalMaxMs?: number
  signal?: AbortSignal
  scriptHash?: string
  checkpointAgents?: Record<string, WorkflowCheckpointAgentEntry>
  onLog?: (message: string) => void
  onPhase?: (title: string) => void
  onAgentStart?: (event: {
    label: string
    phase?: string
    prompt: string
    checkpointId: string
    fromCheckpoint?: boolean
  }) => void
  onAgentEnd?: (event: {
    label: string
    phase?: string
    result: unknown
    checkpointId: string
    fromCheckpoint?: boolean
  }) => void
  onCheckpointAgent?: (checkpointId: string, entry: WorkflowCheckpointAgentEntry) => void
}

interface AgentOptions {
  label?: string
  phase?: string
  schema?: Record<string, unknown>
  model?: string
  subagentType?: string
  id?: string
}

interface RuntimeState {
  currentPhase?: string
  logs: string[]
  phases: string[]
  agentCount: number
  spent: number
  totalSleepMs: number
}

export async function runWorkflow<T = unknown>(
  script: string,
  options: RunWorkflowOptions,
): Promise<WorkflowRunResult<T>> {
  const started = Date.now()
  const { meta, body } = parseWorkflowScript(script)
  const scriptHash = options.scriptHash ?? hashWorkflowScript(script)
  const checkpointAgents = options.checkpointAgents ?? {}
  const seqCounters = new Map<string, number>()
  const state: RuntimeState = { logs: [], phases: [], agentCount: 0, spent: 0, totalSleepMs: 0 }
  const agentRunner = options.agent
  const maxAgents = options.maxAgents ?? WORKFLOW_DEFAULT_MAX_AGENTS_PER_RUN
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? WORKFLOW_DEFAULT_MAX_CONCURRENCY, WORKFLOW_MAX_CONCURRENCY_CAP),
  )
  const limiter = createLimiter(concurrency)
  const pendingAgentRuns = new Set<Promise<unknown>>()

  const log = (message: unknown) => {
    const text = String(message)
    state.logs.push(text)
    options.onLog?.(text)
  }

  const phase = (title: unknown) => {
    const text = requireString(title, "phase title")
    state.currentPhase = text
    if (!state.phases.includes(text)) state.phases.push(text)
    options.onPhase?.(text)
  }

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => state.spent,
    remaining: () =>
      options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - state.spent),
  })

  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new Error("workflow aborted")
  }

  const sleepPerCallMaxMs = options.sleepPerCallMaxMs ?? WORKFLOW_SLEEP_MAX_MS
  const sleepTotalMaxMs = options.sleepTotalMaxMs ?? WORKFLOW_SLEEP_TOTAL_MAX_MS

  const sleep = async (ms: unknown) => {
    throwIfAborted()
    const duration = requirePositiveFiniteNumber(ms, "sleep duration")
    if (duration > sleepPerCallMaxMs) {
      throw new Error(`sleep() exceeds per-call maximum of ${sleepPerCallMaxMs}ms`)
    }
    if (state.totalSleepMs + duration > sleepTotalMaxMs) {
      throw new Error(`workflow exceeded total sleep budget of ${sleepTotalMaxMs}ms`)
    }
    state.totalSleepMs += duration
    await delayWithAbort(duration, options.signal)
    throwIfAborted()
  }

  const __agent = async (siteIndex: number, prompt: unknown, agentOptions: unknown = {}) => {
    throwIfAborted()
    if (state.agentCount >= maxAgents) {
      throw new Error(`workflow exceeded max agents per run (${maxAgents})`)
    }
    if (budget.total !== null && budget.remaining() <= 0) {
      throw new Error("workflow token budget exhausted")
    }
    if (typeof siteIndex !== "number" || !Number.isInteger(siteIndex) || siteIndex < 0) {
      throw new TypeError("__agent site index must be a non-negative integer")
    }

    const taskPrompt = requireString(prompt, "agent prompt")
    const normalizedOptions = normalizeAgentOptions(agentOptions)
    const assignedPhase = normalizedOptions.phase ?? state.currentPhase
    const requestedLabel = normalizedOptions.label?.trim()
    const checkpointId =
      normalizedOptions.id?.trim() ||
      generateAutoAgentId(scriptHash, siteIndex, seqCounters)

    const run = limiter(async () => {
      state.agentCount++
      const label = requestedLabel || defaultAgentLabel(assignedPhase, state.agentCount)
      const cached = checkpointAgents[checkpointId]
      if (cached?.status === "done") {
        options.onAgentStart?.({
          label,
          phase: assignedPhase,
          prompt: taskPrompt,
          checkpointId,
          fromCheckpoint: true,
        })
        options.onAgentEnd?.({
          label,
          phase: assignedPhase,
          result: cached.result,
          checkpointId,
          fromCheckpoint: true,
        })
        return cached.result
      }

      options.onAgentStart?.({ label, phase: assignedPhase, prompt: taskPrompt, checkpointId })
      try {
        throwIfAborted()
        const result = await agentRunner.run(taskPrompt, {
          label,
          phase: assignedPhase,
          schema: normalizedOptions.schema,
          model: normalizedOptions.model,
          subagentType: normalizedOptions.subagentType,
          checkpointId,
          signal: options.signal,
        })
        throwIfAborted()
        state.spent += estimateTokens(result)
        options.onAgentEnd?.({ label, phase: assignedPhase, result, checkpointId })
        options.onCheckpointAgent?.(checkpointId, {
          status: "done",
          result,
          label,
          phase: assignedPhase,
          prompt: taskPrompt,
        })
        return result
      } catch (error) {
        if (options.signal?.aborted) throw error
        log(`agent ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
        options.onAgentEnd?.({ label, phase: assignedPhase, result: null, checkpointId })
        options.onCheckpointAgent?.(checkpointId, {
          status: "error",
          result: null,
          label,
          phase: assignedPhase,
          prompt: taskPrompt,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    })
    pendingAgentRuns.add(run)
    run.then(
      () => pendingAgentRuns.delete(run),
      () => pendingAgentRuns.delete(run),
    )
    return run
  }

  const agent = (prompt: unknown, agentOptions: unknown = {}) => __agent(0, prompt, agentOptions)

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted()
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions")
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError(
        "parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)",
      )
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await runWithAgentContext({ branchIndex: index }, () => thunk())
        } catch (error) {
          if (options.signal?.aborted) throw error
          log(`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`)
          return null
        }
      }),
    )
  }

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted()
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument")
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)")
    }
    return Promise.all(
      items.map(async (item, index) => {
        return runWithAgentContext({ itemIndex: index }, async () => {
          let value: unknown = item
          for (const stage of stages) {
            try {
              throwIfAborted()
              value = await stage(value, item, index)
              throwIfAborted()
            } catch (error) {
              if (options.signal?.aborted) throw error
              log(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`)
              return null
            }
          }
          return value
        })
      }),
    )
  }

  const cwd = options.cwd ?? process.cwd()
  const context = vm.createContext({
    agent,
    __agent,
    parallel,
    pipeline,
    log,
    phase,
    sleep,
    args: options.args,
    cwd,
    process: Object.freeze({ cwd: () => cwd }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    JSON,
    Math,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Promise,
  })

  const wrapped = `(async () => {\n${body}\n})()`
  const result = await new vm.Script(wrapped, {
    filename: `${meta.name || "workflow"}.js`,
  }).runInContext(context)
  await Promise.allSettled([...pendingAgentRuns])
  assertStructuredCloneable(result, "workflow result")

  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
    durationMs: Date.now() - started,
  }
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string; scriptHash: string } {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: true,
  }) as unknown as AnyNode

  assertDeterministicAst(ast)
  assertPhaseCallFormat(ast)

  const first = (ast.body as AnyNode[] | undefined)?.[0]
  if (first?.type !== "ExportNamedDeclaration") {
    throw new Error("`export const meta = { name, description }` must be the first statement in the script")
  }

  const declaration = first.declaration as AnyNode | null
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new Error("meta export must be `export const meta = ...`")
  }
  const declarations = declaration.declarations as AnyNode[]
  if (declarations.length !== 1) {
    throw new Error("meta export must declare only `meta`")
  }

  const declarator = declarations[0]
  const id = declarator.id as AnyNode
  if (id?.type !== "Identifier" || id.name !== "meta") {
    throw new Error("meta export must declare `meta`")
  }
  if (!declarator.init) throw new Error("meta must have a literal value")

  const meta = evaluateLiteral(declarator.init as AnyNode, "meta")
  validateMeta(meta)

  const rawBody = script.slice(0, first.start) + script.slice(first.end)
  const bodyAst = parse(rawBody, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: true,
  }) as unknown as AnyNode
  const transformed = transformAgentCalls(rawBody, bodyAst)

  return {
    meta,
    body: transformed.body,
    scriptHash: hashWorkflowScript(script),
  }
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {}
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`)
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`)
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`)
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`)
        const key = propertyKey(prop.key as AnyNode, path)
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`)
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`)
      }
      return out
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`)
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`)
        return evaluateLiteral(element, `${path}[${index}]`)
      })
    case "Literal":
      return node.value
    case "TemplateLiteral": {
      const expressions = node.expressions as AnyNode[]
      if (expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`)
      return (node.quasis as AnyNode[])
        .map((quasi) => {
          const value = quasi.value as { cooked?: string; raw?: string }
          return value.cooked ?? value.raw ?? ""
        })
        .join("")
    }
    case "UnaryExpression": {
      const argument = node.argument as AnyNode | undefined
      if (node.operator === "-" && argument?.type === "Literal" && typeof argument.value === "number") {
        return -argument.value
      }
      throw new Error(`only negative-number unary allowed in ${path}`)
    }
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`)
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name as string
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
    return String(node.value)
  }
  throw new Error(`unsupported key type in ${path}: ${node.type}`)
}

function assertDeterministicAst(node: AnyNode): void {
  if (isDateNowCall(node) || isMathRandomCall(node) || isNewDateExpression(node)) {
    throw new Error(WORKFLOW_NONDETERMINISM_ERROR)
  }
  for (const child of astChildren(node)) assertDeterministicAst(child)
}

function assertPhaseCallFormat(node: AnyNode): void {
  if (node.type === "CallExpression") {
    const callee = node.callee as AnyNode
    if (callee?.type === "Identifier" && callee.name === "phase") {
      validatePhaseCallArguments(node.arguments as AnyNode[])
    }
  }
  for (const child of astChildren(node)) assertPhaseCallFormat(child)
}

function validatePhaseCallArguments(args: AnyNode[]): void {
  if (args.length !== 1) {
    throw new Error("phase() takes exactly one argument: phase('Title')")
  }
  const arg = args[0]
  if (!arg) {
    throw new Error("phase() requires a non-empty string literal title: phase('Scan')")
  }
  if (arg.type === "ObjectExpression") {
    throw new Error(
      "phase() must be called with a string title: phase('Scan'), not phase({ title: 'Scan' }). The { title: '...' } object form is only for meta.phases, not for phase() calls.",
    )
  }
  const title = staticStringOf(arg)
  if (title === undefined || title.trim() === "") {
    throw new Error(
      "phase() requires a non-empty string literal title: phase('Scan'). Do not pass variables, expressions, or objects.",
    )
  }
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

function isDateNowCall(node: AnyNode): boolean {
  return node.type === "CallExpression" && isMemberExpression(node.callee as AnyNode, "Date", "now")
}

function isMathRandomCall(node: AnyNode): boolean {
  return node.type === "CallExpression" && isMemberExpression(node.callee as AnyNode, "Math", "random")
}

function isNewDateExpression(node: AnyNode): boolean {
  const callee = node.callee as AnyNode | undefined
  return node.type === "NewExpression" && callee?.type === "Identifier" && callee.name === "Date"
}

function isMemberExpression(node: AnyNode | undefined, objectName: string, propertyName: string): boolean {
  const object = node?.object as AnyNode | undefined
  if (node?.type !== "MemberExpression" || object?.type !== "Identifier" || object.name !== objectName) {
    return false
  }
  return propertyNameOf(node) === propertyName
}

function propertyNameOf(node: AnyNode): string | undefined {
  const property = node.property as AnyNode | undefined
  if (!node.computed && property?.type === "Identifier") return property.name as string
  return staticStringOf(property)
}

function staticStringOf(node: AnyNode | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value
  if (node?.type === "TemplateLiteral" && (node.expressions as AnyNode[]).length === 0) {
    return (node.quasis as AnyNode[])
      .map((quasi) => {
        const value = quasi.value as { cooked?: string; raw?: string }
        return value.cooked ?? value.raw ?? ""
      })
      .join("")
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = staticStringOf(node.left as AnyNode)
    const right = staticStringOf(node.right as AnyNode)
    if (left !== undefined && right !== undefined) return left + right
  }
  return undefined
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object")
  const value = meta as WorkflowMeta
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new Error("meta.name must be a non-empty string")
  }
  if (typeof value.description !== "string" || !value.description.trim()) {
    throw new Error("meta.description must be a non-empty string")
  }
  if (value.whenToUse !== undefined && typeof value.whenToUse !== "string") {
    throw new Error("meta.whenToUse must be a string")
  }
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array")
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string")
      }
    }
  }
}

function createLimiter(limit: number) {
  let active = 0
  const queue: Array<() => void> = []
  const next = () => {
    active--
    queue.shift()?.()
  }
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      next()
    }
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`)
  return value
}

function requirePositiveFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number of milliseconds`)
  }
  return value
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("workflow aborted"))
      return
    }

    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)

    const onAbort = () => {
      cleanup()
      reject(new Error("workflow aborted"))
    }

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }

    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, name)
}

function normalizeAgentOptions(value: unknown): AgentOptions {
  if (!value || typeof value !== "object") throw new TypeError("agent options must be an object")
  const options = value as AgentOptions & { subagent_type?: unknown }
  const subagentType = options.subagentType ?? options.subagent_type
  return {
    label: optionalString(options.label, "agent label"),
    phase: optionalString(options.phase, "agent phase"),
    model: optionalString(options.model, "agent model"),
    subagentType: optionalString(subagentType, "subagent type"),
    id: optionalString(options.id, "agent id"),
    schema: options.schema && typeof options.schema === "object" ? options.schema : undefined,
  }
}

function assertStructuredCloneable(value: unknown, name: string): void {
  try {
    structuredClone(value)
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : ""
    throw new Error(
      `${name} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()?${detail}`,
    )
  }
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4)
}
