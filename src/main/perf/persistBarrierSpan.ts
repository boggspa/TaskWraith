/**
 * persist_barrier span (Independent Threads Programme M1 / A1.2).
 *
 * Measures Desktop `awaitChatRecordPersisted` wait (`barrier`) and the persist
 * client's 250 ms receipt-poll contribution (`receipt_poll`) separately from
 * host_queue_wait, durable_commit, and receipt_delivery. Optional sink.
 * A throwing sink loses the measurement, never the barrier. The returned
 * promise is the work's own identity so concurrent joiners keep sharing one
 * in-flight drain.
 */

import type { WorkSpanRecordInput } from './WorkSpanRecorder'

export const PERSIST_BARRIER_REASONS = ['barrier', 'receipt_poll'] as const
export type PersistBarrierReason = (typeof PERSIST_BARRIER_REASONS)[number]

export type PersistBarrierSpanSink = {
  record(span: WorkSpanRecordInput): void
}

export interface PersistBarrierSpanAttrs {
  readonly chatId?: string
  readonly runId?: string
  readonly reason: PersistBarrierReason
  /**
   * Host command id resolved at emit time (Trap 1). The persist client mints
   * `commandId` during drain, after awaitChatRecordPersisted has started.
   */
  readonly resolveRunId?: () => string | undefined
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPersistBarrierReason(value: unknown): value is PersistBarrierReason {
  return value === 'barrier' || value === 'receipt_poll'
}

function resolvedRunId(attrs: PersistBarrierSpanAttrs): string | undefined {
  if (isNonEmptyString(attrs.runId)) return attrs.runId.trim()
  if (typeof attrs.resolveRunId !== 'function') return undefined
  try {
    const id = attrs.resolveRunId()
    return isNonEmptyString(id) ? id.trim() : undefined
  } catch {
    return undefined
  }
}

function emitPersistBarrier(
  sink: PersistBarrierSpanSink,
  attrs: PersistBarrierSpanAttrs,
  chatId: string,
  startedAt: number,
  durationMs: number
): void {
  try {
    const runId = resolvedRunId(attrs)
    sink.record({
      chatId,
      kind: 'persist_barrier',
      startedAt,
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0,
      resource: 'host_chain',
      reason: attrs.reason,
      ...(runId ? { runId } : {})
    })
  } catch {
    // Instrumentation must never alter persistence.
  }
}

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as Promise<T>).then === 'function'
  )
}

/**
 * Run persist-barrier work and record one persist_barrier span. Missing sink,
 * chatId, or reason skips measurement and still runs the work. When work
 * returns a Promise, this function returns that same Promise instance.
 */
export function observePersistBarrierSpan<T>(
  sink: PersistBarrierSpanSink | undefined,
  attrs: PersistBarrierSpanAttrs,
  start: () => T,
  now: () => number = Date.now
): T {
  const chatId = isNonEmptyString(attrs.chatId) ? attrs.chatId.trim() : ''
  if (!sink || !chatId || !isPersistBarrierReason(attrs.reason)) return start()
  let startedAt: number
  try {
    startedAt = now()
  } catch {
    return start()
  }
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt < 0) {
    return start()
  }

  const emit = (): void => {
    let endedAt: number
    try {
      endedAt = now()
    } catch {
      return
    }
    if (typeof endedAt !== 'number' || !Number.isFinite(endedAt) || endedAt < 0) return
    emitPersistBarrier(sink, attrs, chatId, startedAt, Math.max(0, endedAt - startedAt))
  }

  let result: T
  try {
    result = start()
  } catch (error) {
    emit()
    throw error
  }
  if (!isThenable(result)) {
    emit()
    return result
  }
  try {
    void result.then(emit, emit)
  } catch {
    // A throwing then() loses the measurement, never the barrier.
  }
  return result
}
