/**
 * Asks the thread owner registry before the Host changes a thread's full copy
 * of its own accord, and says what to tell the caller when it may not.
 *
 * With the thread log authority switch on, an app process can own a thread:
 * it appends to the thread's log, and publishes the full copy itself. A Host
 * write over such a thread would fork it. So each path on which the Host
 * changes a thread itself asks here first, and writes only when it is let
 * through:
 * - a send, the model or effort it chooses for the thread, the run it starts
 *   and that run's own writes, which happen while the run is live;
 * - the notice that a send was checked against the last offers known;
 * - a configuration and an archive;
 * - a seat toggle on an ensemble;
 * - catalogue recovery settling runs a former Host left unsettled.
 * A thread an app process holds, or may still hold from before the Host
 * started, is refused as busy in the desktop. One whose ended writer left
 * work above the full copy is refused until the Host can fold that work in.
 * When the registry cannot decide, the thread is refused as busy. Each
 * refusal is counted, by its reason and by the path that asked.
 *
 * A write let through is live until its caller releases it. The registry
 * refuses an app's claim on a thread with a live Host write
 * (`host_run_active`), so nobody is granted the thread between the answer and
 * the write. The write is live from the moment its caller is answered, and
 * the registry takes its next decision on the thread a turn later.
 *
 * With the switch off there is no gate, and the Host writes as it always has.
 */
import type { HostWriteDecision } from '../host-shared/thread-log/ThreadOwnership'

/** The Host's own paths that change a thread's full copy. */
export type HostThreadWritePath =
  | 'composer.send'
  | 'offer.notice'
  | 'thread.configure'
  | 'thread.archive'
  | 'ensemble.seat.toggle'
  | 'catalogue.recovery'

export type HostThreadWriteRefusalCode = 'thread_busy_in_desktop' | 'thread_fold_first'

export interface HostThreadWriteRefusal {
  readonly kind: 'refused'
  readonly errorCode: HostThreadWriteRefusalCode
  readonly errorMessage: string
}

export interface HostThreadWriteLetThrough {
  readonly kind: 'write'
  /** The write is done: the thread is no longer held for it. Later calls do nothing. */
  release(): void
}

export type HostThreadWriteAdmission = HostThreadWriteLetThrough | HostThreadWriteRefusal

export interface HostThreadWriteGateOptions {
  /** The registry's decision, as `HostThreadOwnerService.requestHostWrite` gives it. */
  decide(threadId: string): Promise<HostWriteDecision>
}

export interface HostThreadWriteGateSnapshot {
  readonly asked: number
  readonly written: number
  readonly refused: {
    /** A process holds the thread, or may from before the Host started. */
    readonly busy: number
    readonly foldFirst: number
    /** A writer this Host granted holds it; the Host does not ask it to let go yet. */
    readonly askRelease: number
    /** The registry could not decide. */
    readonly failed: number
  }
  /** Each path that has asked. */
  readonly paths: Readonly<
    Partial<Record<HostThreadWritePath, { readonly asked: number; readonly refused: number }>>
  >
  /** Writes let through and not yet released. */
  readonly live: number
  readonly lastFailure: string | null
}

const BUSY_MESSAGE = 'The desktop app holds this thread, so the Host left it unchanged.'
const FOLD_FIRST_MESSAGE =
  'The desktop app that last held this thread stopped before it published its work, so the Host left the thread unchanged.'
const UNDECIDED_MESSAGE =
  'The Host could not tell whether the desktop app holds this thread, so it left the thread unchanged.'

function refusal(
  errorCode: HostThreadWriteRefusalCode,
  errorMessage: string
): HostThreadWriteRefusal {
  return { kind: 'refused', errorCode, errorMessage }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}

export class HostThreadWriteGate {
  private asked = 0
  private written = 0
  private readonly refused = { busy: 0, foldFirst: 0, askRelease: 0, failed: 0 }
  private readonly paths = new Map<HostThreadWritePath, { asked: number; refused: number }>()
  /** Live writes on each thread that has one. */
  private readonly live = new Map<string, number>()
  private lastFailure: string | null = null

  constructor(private readonly options: HostThreadWriteGateOptions) {}

  async admit(threadId: string, path: HostThreadWritePath): Promise<HostThreadWriteAdmission> {
    this.asked += 1
    let counts = this.paths.get(path)
    if (!counts) {
      counts = { asked: 0, refused: 0 }
      this.paths.set(path, counts)
    }
    counts.asked += 1
    let decision: HostWriteDecision
    try {
      decision = await this.options.decide(threadId)
    } catch (error) {
      this.lastFailure = errorText(error)
      this.refused.failed += 1
      counts.refused += 1
      return refusal('thread_busy_in_desktop', UNDECIDED_MESSAGE)
    }
    switch (decision.kind) {
      case 'write':
        this.written += 1
        return this.hold(threadId)
      case 'fold_first':
        this.refused.foldFirst += 1
        counts.refused += 1
        return refusal('thread_fold_first', FOLD_FIRST_MESSAGE)
      case 'ask_release':
        // Asking the writer to let go is not built yet: until it is, the
        // thread stays the writer's, as a busy one does.
        this.refused.askRelease += 1
        counts.refused += 1
        return refusal('thread_busy_in_desktop', BUSY_MESSAGE)
      case 'busy':
        this.refused.busy += 1
        counts.refused += 1
        return refusal('thread_busy_in_desktop', BUSY_MESSAGE)
    }
  }

  /** A write let through on the thread has not been released. */
  writing(threadId: string): boolean {
    return this.live.has(threadId)
  }

  snapshot(): HostThreadWriteGateSnapshot {
    let live = 0
    for (const count of this.live.values()) live += count
    return {
      asked: this.asked,
      written: this.written,
      refused: { ...this.refused },
      paths: Object.fromEntries([...this.paths].map(([path, counts]) => [path, { ...counts }])),
      live,
      lastFailure: this.lastFailure
    }
  }

  private hold(threadId: string): HostThreadWriteLetThrough {
    this.live.set(threadId, (this.live.get(threadId) ?? 0) + 1)
    let released = false
    return {
      kind: 'write',
      release: () => {
        if (released) return
        released = true
        const count = this.live.get(threadId)! - 1
        if (count === 0) this.live.delete(threadId)
        else this.live.set(threadId, count)
      }
    }
  }
}
