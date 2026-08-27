import type { RunManager } from '../RunManager'
import { isThinkingTraceToolName } from '../providers/CliProviderThinking'

type ToolBoundaryRunManager = Pick<RunManager, 'consumeKillAfterToolResult' | 'getInterruptState'>

export type ExactProviderInterrupt = (runId: string) => Promise<boolean | void>

export interface ToolBoundarySteerObservation {
  /** The exact app run whose provider-owned batch crossed the boundary. */
  runId: string | null | undefined
  /** Provider-owned interrupt seam. `false` is an explicit refusal. */
  interruptExactRun: ExactProviderInterrupt
  /** Main-owned queue check; false consumes stale/cancelled boundary arms. */
  shouldInterrupt?: (queuedRunIds: readonly string[]) => boolean
}

export type ToolBoundarySteerOutcome =
  | {
      kind: 'ignored'
      reason: 'invalid-run-id' | 'not-armed' | 'no-runnable-steer'
      queuedRunIds: string[]
    }
  | { kind: 'interrupted'; runId: string; queuedRunIds: string[] }
  | { kind: 'failed'; runId: string; queuedRunIds: string[]; error: unknown }

const NON_TERMINAL_TOOL_STATUSES = new Set([
  'created',
  'executing',
  'in-progress',
  'in_progress',
  'pending',
  'progress',
  'queued',
  'running',
  'started',
  'starting',
  'streaming',
  'working'
])

const TERMINAL_TOOL_STATUSES = new Set([
  'aborted',
  'cancelled',
  'canceled',
  'complete',
  'completed',
  'declined',
  'denied',
  'done',
  'error',
  'failed',
  'failure',
  'ok',
  'success',
  'succeeded',
  'timed-out',
  'timed_out',
  'timeout',
  'warning'
])

const REASONING_KINDS = new Set(['analysis', 'reasoning', 'think', 'thinking', 'thought'])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function queueIdSnapshot(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const id = candidate.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function mergeQueueIds(first: readonly string[], second: readonly string[]): string[] {
  return queueIdSnapshot([...first, ...second])
}

function isReasoningToolResult(event: Record<string, unknown>): boolean {
  const toolName = firstString(event, ['tool_name', 'toolName', 'name'])
  if (isThinkingTraceToolName(toolName)) return true

  const directKind = normalizedString(
    firstString(event, ['tool_kind', 'toolKind', 'kind', 'category'])
  )
  if (REASONING_KINDS.has(directKind)) return true

  const parameters = record(event.parameters) || record(event.input)
  const parameterKind = parameters
    ? normalizedString(firstString(parameters, ['kind', 'category', 'type']))
    : ''
  return REASONING_KINDS.has(parameterKind)
}

/**
 * Identify a genuine completed tool boundary on the provider-compat lane.
 *
 * Thinking is represented as a synthetic tool whose cumulative updates are
 * emitted as successful `tool_result` rows, so checking `type` (or even
 * `status: success`) alone would interrupt on every reasoning chunk. Likewise,
 * some adapters use a `tool_result` envelope for progress snapshots. Unknown
 * explicit lifecycle values are treated conservatively as non-terminal.
 *
 * This predicate is auxiliary. Provider adapters should call
 * `observeBoundary` only from the full-batch seam that proves the tool result
 * is complete; the generic compat-event chokepoint is too early to own that
 * decision.
 */
export function isTerminalToolResultCompatEvent(event: unknown): boolean {
  const candidate = record(event)
  if (!candidate || candidate.type !== 'tool_result') return false
  if (isReasoningToolResult(candidate)) return false

  if (
    candidate.in_progress === true ||
    candidate.partial === true ||
    candidate.done === false ||
    candidate.complete === false ||
    candidate.completed === false ||
    candidate.final === false ||
    candidate.is_final === false ||
    candidate.terminal === false
  ) {
    return false
  }

  const lifecycleValues = ['status', 'state', 'phase', 'subtype']
    .map((key) => normalizedString(candidate[key]))
    .filter(Boolean)
  if (lifecycleValues.some((value) => NON_TERMINAL_TOOL_STATUSES.has(value))) return false
  if (lifecycleValues.length === 0) return true
  return lifecycleValues.some((value) => TERMINAL_TOOL_STATUSES.has(value))
}

/**
 * Turns a provider-proven tool-result batch boundary into one exact interrupt.
 *
 * This coordinator never guesses a current/global run. RunManager remains the
 * authority for whether this exact run is armed and which durable queue rows
 * it owns. The flag and its queue-id batch are consumed only after the exact
 * provider acknowledges the interrupt. Refusal or failure leaves both intact
 * so a later safe boundary can retry without losing the steer.
 */
export class ToolBoundarySteerCoordinator {
  private readonly attemptsByRunId = new Map<string, Promise<ToolBoundarySteerOutcome>>()

  constructor(private readonly runManager: ToolBoundaryRunManager) {}

  observeBoundary(input: ToolBoundarySteerObservation): Promise<ToolBoundarySteerOutcome> {
    const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
    if (!runId) {
      return Promise.resolve({ kind: 'ignored', reason: 'invalid-run-id', queuedRunIds: [] })
    }

    const interruptState = this.runManager.getInterruptState(runId)
    if (interruptState.killAfterToolResult !== true) {
      return Promise.resolve({ kind: 'ignored', reason: 'not-armed', queuedRunIds: [] })
    }
    const queuedRunIds = queueIdSnapshot(interruptState.pendingBoundarySteerRunIds)
    if (queuedRunIds.length > 0 && input.shouldInterrupt?.(queuedRunIds) === false) {
      this.runManager.consumeKillAfterToolResult(runId)
      return Promise.resolve({
        kind: 'ignored',
        reason: 'no-runnable-steer',
        queuedRunIds
      })
    }

    const existing = this.attemptsByRunId.get(runId)
    if (existing) return existing

    let settle!: (outcome: ToolBoundarySteerOutcome) => void
    const attempt = new Promise<ToolBoundarySteerOutcome>((resolve) => {
      settle = resolve
    })
    this.attemptsByRunId.set(runId, attempt)

    // Invoke the provider callback synchronously up to its first await. Exact
    // ACP/Ollama batch seams call this immediately before another model request;
    // deferring through Promise.resolve() left a microtask window in which the
    // provider could begin that request before cancellation was armed.
    void (async (): Promise<ToolBoundarySteerOutcome> => {
      // The run can terminalize while its completed tool batch is being
      // projected. Re-read immediately before the external side effect.
      if (this.runManager.getInterruptState(runId).killAfterToolResult !== true) {
        return { kind: 'ignored', reason: 'not-armed', queuedRunIds: [] }
      }
      const accepted = await input.interruptExactRun(runId)
      if (accepted === false) {
        throw new Error(`Provider refused the tool-boundary interrupt for run ${runId}.`)
      }

      // Consume only AFTER the provider accepted. `consume` also captures
      // rapid steers that joined this boundary while the async interrupt was
      // in flight, so the outcome never loses their durable queue ids.
      const consumed = this.runManager.consumeKillAfterToolResult(runId)
      return {
        kind: 'interrupted',
        runId,
        queuedRunIds: mergeQueueIds(queuedRunIds, consumed.queuedRunIds)
      }
    })()
      .catch((error: unknown): ToolBoundarySteerOutcome => {
        const latest = this.runManager.getInterruptState(runId)
        return {
          kind: 'failed',
          runId,
          queuedRunIds: mergeQueueIds(
            queuedRunIds,
            queueIdSnapshot(latest.pendingBoundarySteerRunIds)
          ),
          error
        }
      })
      .finally(() => {
        if (this.attemptsByRunId.get(runId) === attempt) {
          this.attemptsByRunId.delete(runId)
        }
      })
      .then(settle)
    return attempt
  }

  /** Lifecycle cleanup for a run that terminalized or was removed. */
  forget(runId: string): void {
    this.attemptsByRunId.delete(runId)
  }

  clear(): void {
    this.attemptsByRunId.clear()
  }
}
