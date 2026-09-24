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
      // Transfer publish is local fs (stringify/write/fsync/rename). It does
      // not take the MCP/git workspace lock (A1.27).
      resource: 'none',
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
  bytesOf: (result: Awaited<T>) => number = () => 0,
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
  const finish = (result: Awaited<T> | undefined, succeeded: boolean): void => {
    let endedAt: number
    try {
      endedAt = now()
      if (!Number.isFinite(endedAt) || endedAt < 0) return
    } catch {
      return
    }
    let bytes = 0
    try {
      if (succeeded) bytes = bytesOf(result as Awaited<T>)
    } catch {
      /* Measurement cannot affect publication. */
    }
    emitCheckpointPrepare(sink, attrs, chatId, startedAt, Math.max(0, endedAt - startedAt), bytes)
  }
  let result: T
  try {
    result = prepare()
  } catch (error) {
    finish(undefined, false)
    throw error
  }
  if (result instanceof Promise) {
    return result.then(
      (value: Awaited<T>) => {
        finish(value, true)
        return value
      },
      (error: unknown) => {
        finish(undefined, false)
        throw error
      }
    ) as T
  }
  finish(result as Awaited<T>, true)
  return result
}
