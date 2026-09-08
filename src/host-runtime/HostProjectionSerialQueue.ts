/**
 * Serializes publication windows without changing a command's authority or
 * result — plus an optional, zero-obligation timing seam (Independent
 * Threads M1 amendment).
 *
 * §1.1 B2/B4 need `host_queue_wait` attributed per task, and this queue was
 * an opaque thunk runner: no timestamps, no identity. The seam keeps every
 * existing call site valid — `createHostProjectionSerialQueue()` with no
 * options returns the exact original untimed closure (its clock is never
 * read), and the runner still accepts a bare `operation`. When the
 * composition root supplies a `spans` recorder and/or an `observer`, each
 * task is measured: enqueue→start wait is emitted as a `host_queue_wait`
 * span on resource `host_chain` (chatId/laneId carry the per-enqueue label
 * until the claimed call sites can pass real identity — M2/M4 work), and
 * the observer additionally receives the run duration and outcome.
 * Instrumentation failures are swallowed: a broken sink must never break
 * the projection queue, and FIFO order and rejection propagation are
 * byte-for-byte the original semantics.
 */
import type { WorkSpanRecordInput } from '../host-shared/perf/WorkSpanRecorder'

export type HostProjectionOperationRunner = <T>(
  operation: () => Promise<T>,
  label?: string
) => Promise<T>

/** Raw per-task timing delivered to the observer; runMs covers the task body. */
export interface HostProjectionQueueTaskTiming {
  label: string
  queuedAt: number
  startedAt: number
  finishedAt: number
  waitMs: number
  runMs: number
  /** False when the task body rejected; the rejection still propagates. */
  ok: boolean
}

export interface HostProjectionSerialQueueOptions {
  /**
   * WorkSpanRecorder-compatible sink; receives one `host_queue_wait` span
   * per task with durationMs = enqueue→start wait. Per-task run duration and
   * outcome travel through `observer` — section aggregates are kind/resource
   * scoped, so per-task attribution needs the label or the observer.
   */
  spans?: { record(span: WorkSpanRecordInput): void }
  observer?: (timing: HostProjectionQueueTaskTiming) => void
  /** Clock seam; defaults to Date.now. Never read on the untimed path. */
  now?: () => number
}

const UNLABELED = 'unlabeled'

export function createHostProjectionSerialQueue(
  options: HostProjectionSerialQueueOptions = {}
): HostProjectionOperationRunner {
  let tail: Promise<unknown> = Promise.resolve()
  const spans = options.spans
  const observer = options.observer
  if (!spans && !observer) {
    // Zero-overhead path: the original untimed runner, no clock reads.
    return <T>(operation: () => Promise<T>): Promise<T> => {
      const result = tail.then(operation)
      tail = result.catch(() => undefined)
      return result
    }
  }
  const now = options.now ?? (() => Date.now())

  const emit = (
    label: string,
    queuedAt: number,
    startedAt: number,
    finishedAt: number,
    ok: boolean
  ): void => {
    const timing: HostProjectionQueueTaskTiming = {
      label,
      queuedAt,
      startedAt,
      finishedAt,
      waitMs: Math.max(0, startedAt - queuedAt),
      runMs: Math.max(0, finishedAt - startedAt),
      ok
    }
    if (spans) {
      try {
        spans.record({
          chatId: timing.label,
          laneId: timing.label,
          kind: 'host_queue_wait',
          resource: 'host_chain',
          startedAt: timing.queuedAt,
          durationMs: timing.waitMs
        })
      } catch {
        // Instrumentation must never break the projection queue.
      }
    }
    if (observer) {
      try {
        observer(timing)
      } catch {
        // Same rule for the raw observer.
      }
    }
  }

  return <T>(operation: () => Promise<T>, label?: string): Promise<T> => {
    const taskLabel = typeof label === 'string' && label.length > 0 ? label : UNLABELED
    const queuedAt = now()
    const run = async (): Promise<T> => {
      const startedAt = now()
      let ok = true
      try {
        return await operation()
      } catch (error) {
        ok = false
        throw error
      } finally {
        emit(taskLabel, queuedAt, startedAt, now(), ok)
      }
    }
    const result = tail.then(run)
    tail = result.catch(() => undefined)
    return result
  }
}
