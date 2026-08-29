import type { ExecutionRunProjection } from '../../../main/executionGraph/ExecutionGraphRun'
import {
  buildExecutionGraphProjection,
  type ExecutionGraphProjection
} from './executionGraphProjection'

const TERMINAL_EXECUTION_STATES = new Set(['succeeded', 'failed', 'cancelled'])

export function isTerminalExecutionRun(run: ExecutionRunProjection): boolean {
  return TERMINAL_EXECUTION_STATES.has(run.state)
}

/**
 * Threads that still own an execution which has not settled.
 *
 * `requires_action` counts as live on purpose: a paused graph is unfinished
 * work the thread is still accountable for, so its thread has not completed its
 * task even though no provider run is going.
 *
 * Keyed on `owner.threadId`, never `rootChatId`. Association is not
 * accountability — and an unowned legacy graph is permanently stuck by design,
 * so letting it suppress a thread's close-out forever would be a bug, not
 * caution. Those surface through the Execution Map instead.
 */
export function liveOwnedExecutionThreadIds(
  runsById: Record<string, ExecutionRunProjection>
): Set<string> {
  const threadIds = new Set<string>()
  for (const run of Object.values(runsById)) {
    const threadId = run.owner?.threadId
    if (!threadId || isTerminalExecutionRun(run)) continue
    threadIds.add(threadId)
  }
  return threadIds
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

/**
 * Compact, non-sensitive key for recovering one uncertain Stack append after
 * a renderer/main restart. This is not an authority digest: collisions are
 * harmless because main binds the nonce to its own SHA-256 command receipt and
 * rejects mismatched reuse.
 */
export function executionAppendSubmissionKey(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193) >>> 0
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0
  }
  return `${value.length.toString(36)}-${first.toString(36)}-${second.toString(36)}`
}

/**
 * Product rule: ordinary Composer busy-sends use classic RunQueue + Steer.
 * Execution Graph / Stack / Map stay available as Work-tab / map projections
 * and for deliberate graph tooling — they must not own the above-row queue
 * or intercept follow-up messages while a chat is busy.
 *
 * The gate is kept (and the call sites remain) so a future explicit “add to
 * graph” path can opt in without rewiring Send. Until then, always false.
 */
export function shouldAppendBusySendToExecutionStack(_input: {
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
  return false
}
