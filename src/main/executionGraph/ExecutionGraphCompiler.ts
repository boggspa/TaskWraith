import { createHash } from 'node:crypto'
import {
  EXECUTION_GRAPH_SCHEMA_VERSION,
  type EffectiveExecutionTopology,
  type ExecutionEdge,
  type ExecutionGraphLimits,
  type ExecutionGraphRevision,
  type ExecutionGraphRevisionDraft,
  type ExecutionGraphRevisionRef,
  type ExecutionJsonSchema,
  type ExecutionPortDefinition,
  type ExecutionStepCommon,
  type ExecutionStepDefinition,
  type JsonValue
} from './ExecutionGraphModel'

export const DEFAULT_EXECUTION_GRAPH_LIMITS: ExecutionGraphLimits = Object.freeze({
  maxSteps: 128,
  maxConcurrentSteps: 8,
  maxAttempts: 256
})

export const MAX_EXECUTION_GRAPH_STEPS = 1_000
export const MAX_EXECUTION_GRAPH_CONCURRENCY = 64
export const MAX_EXECUTION_GRAPH_ATTEMPTS = 10_000

export interface ExecutionGraphCompilationIssue {
  readonly code: string
  readonly path: string
  readonly message: string
}

export type ExecutionGraphCompilationResult =
  | {
      readonly ok: true
      readonly revision: ExecutionGraphRevision
      readonly issues: readonly []
    }
  | {
      readonly ok: false
      readonly issues: readonly ExecutionGraphCompilationIssue[]
    }

function issue(code: string, path: string, message: string): ExecutionGraphCompilationIssue {
  return { code, path, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isJsonValue(value: unknown, seen: Set<object> = new Set()): value is JsonValue {
  if (value === null) return true
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) {
    const valid = value.every((entry) => isJsonValue(entry, seen))
    seen.delete(value)
    return valid
  }
  const valid = Object.values(value as Record<string, unknown>).every((entry) =>
    isJsonValue(entry, seen)
  )
  seen.delete(value)
  return valid
}

/** Deterministic JSON encoding used for definition identity and schema equality. */
export function stableExecutionGraphStringify(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableExecutionGraphStringify(entry)).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableExecutionGraphStringify(value[key])}`)
      .join(',')}}`
  }
  return 'null'
}

export function deepFreezeExecutionGraph<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreezeExecutionGraph(nested)
  }
  return Object.freeze(value)
}

function validatePorts(
  value: unknown,
  path: string,
  issues: ExecutionGraphCompilationIssue[]
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    issues.push(issue('invalid_ports', path, 'Ports must be an array.'))
    return
  }
  const names = new Set<string>()
  value.forEach((port, index) => {
    const portPath = `${path}[${index}]`
    if (!isRecord(port)) {
      issues.push(issue('invalid_port', portPath, 'Port must be an object.'))
      return
    }
    if (!isNonEmptyString(port.name)) {
      issues.push(issue('invalid_port_name', `${portPath}.name`, 'Port name is required.'))
    } else if (names.has(port.name.trim())) {
      issues.push(
        issue('duplicate_port_name', `${portPath}.name`, `Duplicate port "${port.name.trim()}".`)
      )
    } else {
      names.add(port.name.trim())
    }
    if (port.schema !== undefined && !isJsonValue(port.schema)) {
      issues.push(
        issue('invalid_port_schema', `${portPath}.schema`, 'Port schema must be JSON-compatible.')
      )
    }
    if (port.required !== undefined && typeof port.required !== 'boolean') {
      issues.push(
        issue('invalid_port_required', `${portPath}.required`, 'Port required must be boolean.')
      )
    }
  })
}

function validatePermissionRequest(
  value: unknown,
  path: string,
  issues: ExecutionGraphCompilationIssue[]
): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    issues.push(
      issue('invalid_permission_request', path, 'Permission request ref must be an object.')
    )
    return
  }
  if (value.schemaVersion !== 1) {
    issues.push(issue('invalid_permission_request_version', `${path}.schemaVersion`, 'Expected 1.'))
  }
  if (!isNonEmptyString(value.referenceId)) {
    issues.push(
      issue('invalid_permission_request_ref', `${path}.referenceId`, 'Reference id is required.')
    )
  }
  if (!isNonEmptyString(value.ceilingReferenceId)) {
    issues.push(
      issue(
        'invalid_permission_ceiling_ref',
        `${path}.ceilingReferenceId`,
        'Ceiling reference id is required.'
      )
    )
  }
  if (value.authorityDigest !== undefined && !isNonEmptyString(value.authorityDigest)) {
    issues.push(
      issue(
        'invalid_permission_digest',
        `${path}.authorityDigest`,
        'Authority digest must be non-empty.'
      )
    )
  }
}

export function validateExecutionStep(
  value: unknown,
  path = 'step'
): readonly ExecutionGraphCompilationIssue[] {
  const issues: ExecutionGraphCompilationIssue[] = []
  if (!isRecord(value)) {
    return [issue('invalid_step', path, 'Step must be an object.')]
  }
  if (!isNonEmptyString(value.id)) {
    issues.push(issue('invalid_step_id', `${path}.id`, 'Step id is required.'))
  }
  if (!isNonEmptyString(value.title)) {
    issues.push(issue('invalid_step_title', `${path}.title`, 'Step title is required.'))
  }
  if (!isNonEmptyString(value.objective)) {
    issues.push(issue('invalid_step_objective', `${path}.objective`, 'Step objective is required.'))
  }
  if (!['read_only', 'workspace_write', 'external_side_effect'].includes(String(value.effect))) {
    issues.push(
      issue(
        'invalid_step_effect',
        `${path}.effect`,
        'Step effect must be read_only, workspace_write, or external_side_effect.'
      )
    )
  }
  if (!isRecord(value.retry) || !isPositiveInteger(value.retry.maxAttempts)) {
    issues.push(
      issue(
        'invalid_retry_policy',
        `${path}.retry.maxAttempts`,
        'Retry maxAttempts must be a positive integer.'
      )
    )
  } else if (value.retry.backoffMs !== undefined && !isNonNegativeNumber(value.retry.backoffMs)) {
    issues.push(
      issue(
        'invalid_retry_backoff',
        `${path}.retry.backoffMs`,
        'Retry backoff must be non-negative.'
      )
    )
  }
  if (value.timeoutMs !== undefined && !isPositiveInteger(value.timeoutMs)) {
    issues.push(
      issue('invalid_step_timeout', `${path}.timeoutMs`, 'Timeout must be a positive integer.')
    )
  }
  validatePorts(value.inputs, `${path}.inputs`, issues)
  validatePorts(value.outputs, `${path}.outputs`, issues)
  validatePermissionRequest(value.permissionRequestRef, `${path}.permissionRequestRef`, issues)

  switch (value.kind) {
    case 'solo_agent': {
      if (!isRecord(value.agent)) {
        issues.push(
          issue('invalid_solo_agent', `${path}.agent`, 'Solo-agent configuration is required.')
        )
        break
      }
      if (!isNonEmptyString(value.agent.provider)) {
        issues.push(
          issue('invalid_agent_provider', `${path}.agent.provider`, 'Provider is required.')
        )
      }
      if (
        value.agent.runTemplateRef !== undefined &&
        !isNonEmptyString(value.agent.runTemplateRef)
      ) {
        issues.push(
          issue(
            'invalid_run_template_ref',
            `${path}.agent.runTemplateRef`,
            'Run template ref must be non-empty when present.'
          )
        )
      }
      if (!isRecord(value.agent.session)) {
        issues.push(
          issue('invalid_agent_session', `${path}.agent.session`, 'Session policy is required.')
        )
      } else if (value.agent.session.mode === 'bound') {
        if (!isNonEmptyString(value.agent.session.sessionRef)) {
          issues.push(
            issue(
              'invalid_bound_session',
              `${path}.agent.session.sessionRef`,
              'A bound session requires a session ref.'
            )
          )
        }
      } else if (value.agent.session.mode !== 'fresh') {
        issues.push(
          issue(
            'invalid_agent_session_mode',
            `${path}.agent.session.mode`,
            'Expected fresh or bound.'
          )
        )
      }
      break
    }
    case 'deterministic_check': {
      if (!isRecord(value.check) || !isNonEmptyString(value.check.handlerRef)) {
        issues.push(
          issue(
            'invalid_check_handler',
            `${path}.check.handlerRef`,
            'A deterministic check requires a registered handler ref.'
          )
        )
      }
      if (value.effect !== 'read_only') {
        issues.push(
          issue(
            'effectful_deterministic_check',
            `${path}.effect`,
            'V1 deterministic checks must be read-only.'
          )
        )
      }
      break
    }
    case 'human_gate': {
      if (!isRecord(value.gate)) {
        issues.push(
          issue('invalid_human_gate', `${path}.gate`, 'Human-gate configuration is required.')
        )
        break
      }
      if (!['approval', 'input'].includes(String(value.gate.mode))) {
        issues.push(issue('invalid_gate_mode', `${path}.gate.mode`, 'Expected approval or input.'))
      }
      if (!isNonEmptyString(value.gate.prompt)) {
        issues.push(issue('invalid_gate_prompt', `${path}.gate.prompt`, 'Gate prompt is required.'))
      }
      if (
        value.gate.mode === 'input' &&
        value.gate.options !== undefined &&
        (!Array.isArray(value.gate.options) ||
          value.gate.options.some((option) => !isNonEmptyString(option)))
      ) {
        issues.push(
          issue(
            'invalid_gate_options',
            `${path}.gate.options`,
            'Input options must be non-empty strings.'
          )
        )
      }
      if (value.effect !== 'read_only') {
        issues.push(
          issue('effectful_human_gate', `${path}.effect`, 'Human gates must be read-only.')
        )
      }
      break
    }
    case 'join': {
      if (!isRecord(value.join)) {
        issues.push(issue('invalid_join', `${path}.join`, 'Join configuration is required.'))
        break
      }
      if (!['all', 'any', 'quorum'].includes(String(value.join.mode))) {
        issues.push(
          issue('invalid_join_mode', `${path}.join.mode`, 'Expected all, any, or quorum.')
        )
      }
      if (value.join.mode === 'quorum' && !isPositiveInteger(value.join.quorum)) {
        issues.push(
          issue('invalid_join_quorum', `${path}.join.quorum`, 'Quorum must be a positive integer.')
        )
      }
      if (value.join.deadlineMs !== undefined && !isPositiveInteger(value.join.deadlineMs)) {
        issues.push(
          issue('invalid_join_deadline', `${path}.join.deadlineMs`, 'Deadline must be positive.')
        )
      }
      if (value.effect !== 'read_only') {
        issues.push(issue('effectful_join', `${path}.effect`, 'Join steps must be read-only.'))
      }
      break
    }
    case 'ensemble_round': {
      if (!isRecord(value.ensemble)) {
        issues.push(
          issue(
            'invalid_ensemble_round',
            `${path}.ensemble`,
            'Ensemble-round configuration is required.'
          )
        )
        break
      }
      if (!isNonEmptyString(value.ensemble.snapshotRef)) {
        issues.push(
          issue(
            'invalid_ensemble_snapshot',
            `${path}.ensemble.snapshotRef`,
            'Snapshot ref is required.'
          )
        )
      }
      if (!isNonEmptyString(value.ensemble.prompt)) {
        issues.push(
          issue('invalid_ensemble_prompt', `${path}.ensemble.prompt`, 'Prompt is required.')
        )
      }
      if (!['turn_bound', 'continuous'].includes(String(value.ensemble.orchestrationMode))) {
        issues.push(
          issue(
            'invalid_ensemble_mode',
            `${path}.ensemble.orchestrationMode`,
            'Expected turn_bound or continuous.'
          )
        )
      }
      break
    }
    case 'output': {
      if (
        !isRecord(value.output) ||
        !['none', 'propose'].includes(String(value.output.projectReference))
      ) {
        issues.push(
          issue(
            'invalid_output',
            `${path}.output.projectReference`,
            'Output must declare none or propose for Project-reference promotion.'
          )
        )
      }
      if (value.effect !== 'read_only') {
        issues.push(issue('effectful_output', `${path}.effect`, 'Output steps must be read-only.'))
      }
      break
    }
    default:
      issues.push(
        issue(
          'unsupported_step_kind',
          `${path}.kind`,
          'V1 supports solo_agent, deterministic_check, human_gate, join, ensemble_round, and output.'
        )
      )
  }
  return issues
}

function stepIdForEdgeEnd(edge: ExecutionEdge, end: 'from' | 'to'): string {
  if (edge.kind === 'control') {
    const value = end === 'from' ? edge.fromStepId : edge.toStepId
    return typeof value === 'string' ? value : ''
  }
  const endpoint = edge[end] as unknown
  return isRecord(endpoint) && typeof endpoint.stepId === 'string' ? endpoint.stepId : ''
}

function portForStep(
  step: ExecutionStepDefinition,
  side: 'inputs' | 'outputs',
  name: string
): ExecutionPortDefinition | undefined {
  return step[side]?.find((port) => port.name === name)
}

function findCycle(
  steps: readonly ExecutionStepDefinition[],
  edges: readonly ExecutionEdge[]
): string[] {
  const adjacency = new Map<string, string[]>(steps.map((step) => [step.id, []]))
  for (const edge of edges) {
    const from = stepIdForEdgeEnd(edge, 'from')
    const to = stepIdForEdgeEnd(edge, 'to')
    adjacency.get(from)?.push(to)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const path: string[] = []

  const visit = (stepId: string): string[] | null => {
    if (visiting.has(stepId)) {
      const start = path.indexOf(stepId)
      return [...path.slice(start), stepId]
    }
    if (visited.has(stepId)) return null
    visiting.add(stepId)
    path.push(stepId)
    for (const next of adjacency.get(stepId) ?? []) {
      const cycle = visit(next)
      if (cycle) return cycle
    }
    path.pop()
    visiting.delete(stepId)
    visited.add(stepId)
    return null
  }

  for (const step of steps) {
    const cycle = visit(step.id)
    if (cycle) return cycle
  }
  return []
}

export function validateExecutionTopology(
  steps: readonly ExecutionStepDefinition[],
  edges: readonly ExecutionEdge[],
  options: { readonly maxSteps?: number } = {}
): readonly ExecutionGraphCompilationIssue[] {
  const issues: ExecutionGraphCompilationIssue[] = []
  if (steps.length === 0) {
    issues.push(issue('empty_graph', 'steps', 'A compiled revision requires at least one step.'))
  }
  if (steps.length > (options.maxSteps ?? MAX_EXECUTION_GRAPH_STEPS)) {
    issues.push(
      issue(
        'step_limit_exceeded',
        'steps',
        `Graph has ${steps.length} steps, above its ${options.maxSteps ?? MAX_EXECUTION_GRAPH_STEPS} step limit.`
      )
    )
  }

  const stepIds = new Set<string>()
  const stepById = new Map<string, ExecutionStepDefinition>()
  steps.forEach((step, index) => {
    issues.push(...validateExecutionStep(step, `steps[${index}]`))
    if (isNonEmptyString(step?.id)) {
      const id = step.id.trim()
      if (stepIds.has(id)) {
        issues.push(issue('duplicate_step_id', `steps[${index}].id`, `Duplicate step id "${id}".`))
      } else {
        stepIds.add(id)
        stepById.set(id, step)
      }
    }
  })

  const edgeIds = new Set<string>()
  const dataTargets = new Set<string>()
  edges.forEach((edge, index) => {
    const path = `edges[${index}]`
    if (!isRecord(edge)) {
      issues.push(issue('invalid_edge', path, 'Edge must be an object.'))
      return
    }
    if (!isNonEmptyString(edge.id)) {
      issues.push(issue('invalid_edge_id', `${path}.id`, 'Edge id is required.'))
    } else if (edgeIds.has(edge.id.trim())) {
      issues.push(
        issue('duplicate_edge_id', `${path}.id`, `Duplicate edge id "${edge.id.trim()}".`)
      )
    } else {
      edgeIds.add(edge.id.trim())
    }
    if (edge.kind !== 'control' && edge.kind !== 'data') {
      issues.push(
        issue('unsupported_edge_kind', `${path}.kind`, 'V1 supports only control and data edges.')
      )
      return
    }
    const fromStepId = stepIdForEdgeEnd(edge, 'from')
    const toStepId = stepIdForEdgeEnd(edge, 'to')
    if (!isNonEmptyString(fromStepId) || !stepById.has(fromStepId)) {
      issues.push(issue('unknown_edge_source', path, `Unknown source step "${fromStepId || ''}".`))
    }
    if (!isNonEmptyString(toStepId) || !stepById.has(toStepId)) {
      issues.push(issue('unknown_edge_target', path, `Unknown target step "${toStepId || ''}".`))
    }
    if (fromStepId === toStepId && fromStepId) {
      issues.push(issue('self_edge', path, 'A step cannot depend on itself.'))
    }
    if (edge.kind === 'control') {
      if (edge.outcome !== 'success') {
        issues.push(
          issue(
            'unsupported_control_outcome',
            `${path}.outcome`,
            'V1 control edges are success-only.'
          )
        )
      }
      return
    }

    if (!isRecord(edge.from) || !isRecord(edge.to)) {
      issues.push(issue('invalid_data_binding', path, 'Data edges require from and to endpoints.'))
      return
    }

    if (!isNonEmptyString(edge.from.port)) {
      issues.push(issue('invalid_source_port', `${path}.from.port`, 'Source port is required.'))
    }
    if (!isNonEmptyString(edge.to.port)) {
      issues.push(issue('invalid_target_port', `${path}.to.port`, 'Target port is required.'))
    }
    const fromStep = stepById.get(fromStepId)
    const toStep = stepById.get(toStepId)
    const fromPort = fromStep ? portForStep(fromStep, 'outputs', edge.from.port) : undefined
    const toPort = toStep ? portForStep(toStep, 'inputs', edge.to.port) : undefined
    if (fromStep && !fromPort) {
      issues.push(
        issue(
          'unknown_source_port',
          `${path}.from.port`,
          `Step "${fromStepId}" does not declare output "${edge.from.port}".`
        )
      )
    }
    if (toStep && !toPort) {
      issues.push(
        issue(
          'unknown_target_port',
          `${path}.to.port`,
          `Step "${toStepId}" does not declare input "${edge.to.port}".`
        )
      )
    }
    const targetKey = `${toStepId}\u0000${edge.to.port}`
    if (dataTargets.has(targetKey)) {
      issues.push(
        issue(
          'duplicate_data_binding',
          `${path}.to`,
          `Input "${toStepId}.${edge.to.port}" already has an incoming data binding.`
        )
      )
    }
    dataTargets.add(targetKey)
    if (
      fromPort?.schema &&
      toPort?.schema &&
      stableExecutionGraphStringify(fromPort.schema) !==
        stableExecutionGraphStringify(toPort.schema)
    ) {
      issues.push(
        issue(
          'incompatible_port_schema',
          path,
          `Data binding ${fromStepId}.${edge.from.port} -> ${toStepId}.${edge.to.port} has incompatible schemas.`
        )
      )
    }
  })

  if (
    !issues.some((entry) => ['unknown_edge_source', 'unknown_edge_target'].includes(entry.code))
  ) {
    const cycle = findCycle(steps, edges)
    if (cycle.length > 0) {
      issues.push(
        issue('cycle_not_supported', 'edges', `V1 graphs must be acyclic: ${cycle.join(' -> ')}.`)
      )
    }
  }

  for (const step of steps) {
    const outgoing = edges.filter((edge) => stepIdForEdgeEnd(edge, 'from') === step.id)
    if (step.kind === 'output' && outgoing.length > 0) {
      issues.push(
        issue('output_not_terminal', `steps.${step.id}`, 'Output steps must be terminal in V1.')
      )
    }
    if (step.kind === 'join') {
      const incomingControls = edges.filter(
        (edge) => edge.kind === 'control' && edge.toStepId === step.id
      )
      if (incomingControls.length < 2) {
        issues.push(
          issue(
            'join_requires_branches',
            `steps.${step.id}`,
            'A join requires at least two control inputs.'
          )
        )
      }
      if (step.join.mode === 'quorum' && step.join.quorum > incomingControls.length) {
        issues.push(
          issue(
            'join_quorum_unreachable',
            `steps.${step.id}.join.quorum`,
            `Quorum ${step.join.quorum} exceeds ${incomingControls.length} incoming branches.`
          )
        )
      }
    }
  }

  return issues
}

function cloneSchema(schema: ExecutionJsonSchema | undefined): ExecutionJsonSchema | undefined {
  return schema ? (JSON.parse(JSON.stringify(schema)) as ExecutionJsonSchema) : undefined
}

function normalizePorts(
  ports: readonly ExecutionPortDefinition[] | undefined
): readonly ExecutionPortDefinition[] | undefined {
  return ports?.map((port) => ({
    name: port.name.trim(),
    ...(port.schema ? { schema: cloneSchema(port.schema) } : {}),
    ...(port.required !== undefined ? { required: port.required } : {})
  }))
}

function normalizeStepCommon(step: ExecutionStepDefinition): ExecutionStepCommon {
  return {
    id: step.id.trim(),
    title: step.title.trim(),
    objective: step.objective.trim(),
    effect: step.effect,
    ...(step.inputs ? { inputs: normalizePorts(step.inputs) } : {}),
    ...(step.outputs ? { outputs: normalizePorts(step.outputs) } : {}),
    retry: {
      maxAttempts: step.retry.maxAttempts,
      ...(step.retry.backoffMs !== undefined ? { backoffMs: step.retry.backoffMs } : {})
    },
    ...(step.permissionRequestRef
      ? {
          permissionRequestRef: {
            schemaVersion: 1,
            referenceId: step.permissionRequestRef.referenceId.trim(),
            ceilingReferenceId: step.permissionRequestRef.ceilingReferenceId.trim(),
            ...(step.permissionRequestRef.authorityDigest
              ? { authorityDigest: step.permissionRequestRef.authorityDigest.trim() }
              : {})
          }
        }
      : {}),
    ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {})
  }
}

function normalizeStep(step: ExecutionStepDefinition): ExecutionStepDefinition {
  const common = normalizeStepCommon(step)
  switch (step.kind) {
    case 'solo_agent':
      return {
        ...common,
        kind: 'solo_agent',
        agent: {
          provider: step.agent.provider.trim(),
          ...(step.agent.model ? { model: step.agent.model.trim() } : {}),
          ...(step.agent.runtimeProfileRef
            ? { runtimeProfileRef: step.agent.runtimeProfileRef.trim() }
            : {}),
          ...(step.agent.runTemplateRef
            ? { runTemplateRef: step.agent.runTemplateRef.trim() }
            : {}),
          session:
            step.agent.session.mode === 'fresh'
              ? { mode: 'fresh' }
              : { mode: 'bound', sessionRef: step.agent.session.sessionRef.trim() }
        }
      }
    case 'deterministic_check':
      return {
        ...common,
        kind: 'deterministic_check',
        check: {
          handlerRef: step.check.handlerRef.trim(),
          ...(step.check.version ? { version: step.check.version.trim() } : {})
        }
      }
    case 'human_gate':
      return {
        ...common,
        kind: 'human_gate',
        gate:
          step.gate.mode === 'approval'
            ? {
                mode: 'approval',
                prompt: step.gate.prompt.trim(),
                ...(step.gate.approveLabel ? { approveLabel: step.gate.approveLabel.trim() } : {}),
                ...(step.gate.declineLabel ? { declineLabel: step.gate.declineLabel.trim() } : {})
              }
            : {
                mode: 'input',
                prompt: step.gate.prompt.trim(),
                ...(step.gate.options
                  ? { options: step.gate.options.map((option) => option.trim()) }
                  : {})
              }
      }
    case 'join':
      return {
        ...common,
        kind: 'join',
        join:
          step.join.mode === 'quorum'
            ? {
                mode: 'quorum',
                quorum: step.join.quorum,
                ...(step.join.deadlineMs !== undefined ? { deadlineMs: step.join.deadlineMs } : {})
              }
            : {
                mode: step.join.mode,
                ...(step.join.deadlineMs !== undefined ? { deadlineMs: step.join.deadlineMs } : {})
              }
      }
    case 'ensemble_round':
      return {
        ...common,
        kind: 'ensemble_round',
        ensemble: {
          snapshotRef: step.ensemble.snapshotRef.trim(),
          prompt: step.ensemble.prompt.trim(),
          orchestrationMode: step.ensemble.orchestrationMode
        }
      }
    case 'output':
      return {
        ...common,
        kind: 'output',
        output: {
          ...(step.output.label ? { label: step.output.label.trim() } : {}),
          projectReference: step.output.projectReference
        }
      }
  }
}

function normalizeEdge(edge: ExecutionEdge): ExecutionEdge {
  if (edge.kind === 'control') {
    return {
      id: edge.id.trim(),
      kind: 'control',
      fromStepId: edge.fromStepId.trim(),
      toStepId: edge.toStepId.trim(),
      outcome: 'success'
    }
  }
  return {
    id: edge.id.trim(),
    kind: 'data',
    from: { stepId: edge.from.stepId.trim(), port: edge.from.port.trim() },
    to: { stepId: edge.to.stepId.trim(), port: edge.to.port.trim() }
  }
}

function validateLimit(
  value: unknown,
  path: string,
  max: number,
  issues: ExecutionGraphCompilationIssue[]
): void {
  if (!isPositiveInteger(value) || value > max) {
    issues.push(
      issue('invalid_graph_limit', path, `Expected a positive integer no greater than ${max}.`)
    )
  }
}

function normalizeLimits(limits: Partial<ExecutionGraphLimits> | undefined): ExecutionGraphLimits {
  return {
    maxSteps: limits?.maxSteps ?? DEFAULT_EXECUTION_GRAPH_LIMITS.maxSteps,
    maxConcurrentSteps:
      limits?.maxConcurrentSteps ?? DEFAULT_EXECUTION_GRAPH_LIMITS.maxConcurrentSteps,
    maxAttempts: limits?.maxAttempts ?? DEFAULT_EXECUTION_GRAPH_LIMITS.maxAttempts,
    ...(limits?.maxWallClockMs !== undefined ? { maxWallClockMs: limits.maxWallClockMs } : {}),
    ...(limits?.maxTokens !== undefined ? { maxTokens: limits.maxTokens } : {}),
    ...(limits?.maxCostUsd !== undefined ? { maxCostUsd: limits.maxCostUsd } : {})
  }
}

export function compileExecutionGraphRevision(
  input: ExecutionGraphRevisionDraft
): ExecutionGraphCompilationResult {
  const issues: ExecutionGraphCompilationIssue[] = []
  if (!isNonEmptyString(input?.graphId)) {
    issues.push(issue('invalid_graph_id', 'graphId', 'Graph id is required.'))
  }
  if (!isPositiveInteger(input?.revision)) {
    issues.push(issue('invalid_revision', 'revision', 'Revision must be a positive integer.'))
  }
  if (!isNonEmptyString(input?.workspaceId)) {
    issues.push(issue('invalid_workspace_id', 'workspaceId', 'Workspace id is required.'))
  }
  if (!isNonEmptyString(input?.name)) {
    issues.push(issue('invalid_graph_name', 'name', 'Graph name is required.'))
  }
  if (!isNonEmptyString(input?.createdAt) || !Number.isFinite(Date.parse(input.createdAt))) {
    issues.push(
      issue('invalid_created_at', 'createdAt', 'Created-at must be an ISO-compatible timestamp.')
    )
  }
  if (!Array.isArray(input?.steps)) {
    issues.push(issue('invalid_steps', 'steps', 'Steps must be an array.'))
  }
  if (!Array.isArray(input?.edges)) {
    issues.push(issue('invalid_edges', 'edges', 'Edges must be an array.'))
  }

  const limits = normalizeLimits(input?.limits)
  validateLimit(limits.maxSteps, 'limits.maxSteps', MAX_EXECUTION_GRAPH_STEPS, issues)
  validateLimit(
    limits.maxConcurrentSteps,
    'limits.maxConcurrentSteps',
    MAX_EXECUTION_GRAPH_CONCURRENCY,
    issues
  )
  validateLimit(limits.maxAttempts, 'limits.maxAttempts', MAX_EXECUTION_GRAPH_ATTEMPTS, issues)
  for (const [name, value] of [
    ['maxWallClockMs', limits.maxWallClockMs],
    ['maxTokens', limits.maxTokens],
    ['maxCostUsd', limits.maxCostUsd]
  ] as const) {
    if (value !== undefined && !isNonNegativeNumber(value)) {
      issues.push(
        issue(
          'invalid_graph_limit',
          `limits.${name}`,
          `${name} must be a non-negative finite number.`
        )
      )
    }
  }

  if (Array.isArray(input?.steps) && Array.isArray(input?.edges)) {
    issues.push(
      ...validateExecutionTopology(input.steps, input.edges, { maxSteps: limits.maxSteps })
    )
  }
  if (issues.length > 0) return { ok: false, issues }

  const steps = input.steps.map(normalizeStep)
  const edges = input.edges.map(normalizeEdge)
  const revisionId = `${input.graphId.trim()}@${input.revision}`
  const digestInput = {
    schemaVersion: EXECUTION_GRAPH_SCHEMA_VERSION,
    graphId: input.graphId.trim(),
    revision: input.revision,
    revisionId,
    workspaceId: input.workspaceId.trim(),
    name: input.name.trim(),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    createdAt: input.createdAt,
    steps,
    edges,
    limits
  }
  const definitionDigest = createHash('sha256')
    .update(stableExecutionGraphStringify(digestInput))
    .digest('hex')
  const revision: ExecutionGraphRevision = {
    ...digestInput,
    definitionDigest
  }
  return {
    ok: true,
    revision: deepFreezeExecutionGraph(revision) as ExecutionGraphRevision,
    issues: []
  }
}

export function executionGraphRevisionRef(
  revision: ExecutionGraphRevision
): ExecutionGraphRevisionRef {
  return deepFreezeExecutionGraph({
    schemaVersion: EXECUTION_GRAPH_SCHEMA_VERSION,
    graphId: revision.graphId,
    revision: revision.revision,
    revisionId: revision.revisionId,
    definitionDigest: revision.definitionDigest
  })
}

export function topologyFromRevision(revision: ExecutionGraphRevision): EffectiveExecutionTopology {
  return deepFreezeExecutionGraph({
    baseRevision: executionGraphRevisionRef(revision),
    steps: revision.steps,
    edges: revision.edges
  })
}
