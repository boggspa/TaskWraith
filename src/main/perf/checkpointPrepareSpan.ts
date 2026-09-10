/**
 * checkpoint_prepare span (Independent Threads Programme M1 / S6).
 *
 * Measures Desktop materialization of a Host thread-record transfer artifact
 * (stringify, write, fsync, rename) before the Host command is submitted.
 * Optional sink. A throwing sink loses the measurement, never the publish.
 */

import type { WorkSpanRecordInput } from './WorkSpanRecorder'

export type CheckpointPrepareSpanSink = {
  record(span: WorkSpanRecordInput): void
}

export interface CheckpointPrepareSpanAttrs {
  readonly chatId?: string
  readonly runId?: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function emitCheckpointPrepare(
  sink: CheckpointPrepareSpanSink,
  attrs: CheckpointPrepareSpanAttrs,
  chatId: string,
  startedAt: number,
  durationMs: number,
  bytes: number
): void {
  try {
    sink.record({
      chatId,
      kind: 'checkpoint_prepare',
      startedAt,
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0,
      bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : 0,
      ...(isNonEmptyString(attrs.runId) ? { runId: attrs.runId.trim() } : {})
    })
  } catch {
    // Instrumentation must never alter checkpoint publication.
  }
}

/**
 * Run a checkpoint publish and record one checkpoint_prepare span. Missing
 * sink or chatId skips measurement and still runs the publisher.
 */
export function recordCheckpointPrepareSpan<T>(
  sink: CheckpointPrepareSpanSink | undefined,
  attrs: CheckpointPrepareSpanAttrs,
  prepare: () => T,
  bytesOf: (result: T) => number = () => 0,
  now: () => number = Date.now
): T {
  const chatId = isNonEmptyString(attrs.chatId) ? attrs.chatId.trim() : ''
  if (!sink || !chatId) return prepare()
  let startedAt: number
  try {
    startedAt = now()
  } catch {
    return prepare()
  }
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt < 0) {
    return prepare()
  }
  let result: T
  try {
    result = prepare()
  } catch (error) {
    let endedAt: number
    try {
      endedAt = now()
    } catch {
      throw error
    }
    if (typeof endedAt === 'number' && Number.isFinite(endedAt) && endedAt >= 0) {
      emitCheckpointPrepare(sink, attrs, chatId, startedAt, Math.max(0, endedAt - startedAt), 0)
    }
    throw error
  }
  let endedAt: number
  try {
    endedAt = now()
  } catch {
    return result
  }
  if (typeof endedAt !== 'number' || !Number.isFinite(endedAt) || endedAt < 0) return result
  let bytes = 0
  try {
    bytes = bytesOf(result)
  } catch {
    bytes = 0
  }
  emitCheckpointPrepare(sink, attrs, chatId, startedAt, Math.max(0, endedAt - startedAt), bytes)
  return result
}
