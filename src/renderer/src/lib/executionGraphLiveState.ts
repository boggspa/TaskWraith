import type { ExecutionRunProjection } from '../../../main/executionGraph/ExecutionGraphRun'
import {
  buildExecutionGraphProjection,
  type ExecutionGraphProjection
} from './executionGraphProjection'

const TERMINAL_EXECUTION_STATES = new Set(['succeeded', 'failed', 'cancelled'])

export function isTerminalExecutionRun(run: ExecutionRunProjection): boolean {
  return TERMINAL_EXECUTION_STATES.has(run.state)
}

export function executionRunTimestamp(run: ExecutionRunProjection): number {
  const parsed = Date.parse(run.updatedAt || run.createdAt || '')
  return Number.isFinite(parsed) ? parsed : 0
}

export function sortExecutionRunHistory(
  runs: readonly ExecutionRunProjection[]
): ExecutionRunProjection[] {
  return [...runs].sort(
    (left, right) =>
      Number(isTerminalExecutionRun(left)) - Number(isTerminalExecutionRun(right)) ||
      executionRunTimestamp(right) - executionRunTimestamp(left) ||
      right.lastSequence - left.lastSequence ||
      left.executionId.localeCompare(right.executionId)
  )
}

export function mergeExecutionRunProjection(
  current: ExecutionRunProjection | undefined,
  incoming: ExecutionRunProjection
): ExecutionRunProjection {
  return current && current.lastSequence > incoming.lastSequence ? current : incoming
}

export function projectExecutionRun(run: ExecutionRunProjection): ExecutionGraphProjection {
  return buildExecutionGraphProjection({
    runId: run.executionId,
    runState: run.state,
    topology: run.topology,
    activations: Object.values(run.activations),
    attempts: Object.values(run.attempts),
    runtimeAppendedStepIds: run.baseRevision ? [] : run.topology.steps.map((step) => step.id),
    title: run.title,
    updatedAt: run.updatedAt
  })
}

export function executionStackStepTitle(objective: string): string {
  const firstLine = objective
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  const title = firstLine || 'Continue task'
  return title.length <= 96 ? title : `${title.slice(0, 93).trimEnd()}...`
}

export function shouldAppendBusySendToExecutionStack(input: {
  busy: boolean
  hasWorkspace: boolean
  isTopLevel: boolean
  isPopout: boolean
  isGlobal: boolean
  chatKind?: string
  existingPrompt?: boolean
  scheduled?: boolean
  directedParticipant?: boolean
  specialOverride?: boolean
}): boolean {
  return Boolean(
    input.busy &&
    input.hasWorkspace &&
    input.isTopLevel &&
    !input.isPopout &&
    !input.isGlobal &&
    input.chatKind !== 'ensemble' &&
    !input.existingPrompt &&
    !input.scheduled &&
    !input.directedParticipant &&
    !input.specialOverride
  )
}
