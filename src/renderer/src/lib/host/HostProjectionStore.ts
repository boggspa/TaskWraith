/**
 * Host Arc Wave 4.3a — Desktop Host projection store.
 *
 * WHAT THIS IS. The renderer-side cache and state machine for one Host
 * projection. It holds the last snapshot, the generation/cursor it was taken
 * at, and an honest connection state — and it is deliberately NOT an
 * authority. Every fact it exposes came from Host; nothing is reconstructed
 * locally.
 *
 * WHY A TRANSPORT PORT. The renderer runs sandboxed (`sandbox: true`,
 * `contextIsolation: true`), so it has no Node access and cannot open the Host
 * unix socket. The real transport must therefore be a preload/IPC conduit onto
 * a main-process Host client. That conduit does not exist yet (see the Wave
 * 4.3a handoff), so this store takes it as an INJECTED PORT: the store, the
 * mapper and their tests are complete and provable now, and wiring the real
 * transport later changes nothing here.
 *
 * WHAT THIS STORE MUST NEVER DO — these are goal constraints, not preferences:
 * - never invent domain state when Host is unreachable (no empty-array
 *   "there are no chats", which is a false claim, not a neutral one);
 * - never present a cached snapshot as live;
 * - never rewrite a run/mission outcome because the CLIENT lost its
 *   connection. Client connectivity and domain outcome are separate facts.
 *
 * RENDERER RESTART (AC-critical). A renderer reload destroys this store; it
 * does not touch Host, where missions actually live. Recovery is therefore a
 * plain re-fetch: construct a new store, call `refresh()`, and Host replies
 * with current state. `lastCursor` is retained so a later delta-capable slice
 * can resume instead of re-snapshotting. NOTE HONESTLY: this design has not
 * been exercised against a live Host — the production Host has never been
 * observed running (stale pre-R4' binary), so restart-continuity is DESIGNED
 * FOR here and NOT evidenced.
 */

import { projectHostSnapshot, type HostProjectedSnapshot } from './hostSnapshotProjection'
import { applyHostSnapshotDeltas } from '../../../../shared/hostSnapshotApply'
import type {
  HostCursorPosition,
  HostDeltasSinceResult,
  HostSnapshot
} from '../../../../shared/hostProtocol'

/* ------------------------------------------------------------------ */
/*  Transport port                                                    */
/* ------------------------------------------------------------------ */

/**
 * The single capability this store needs from the outside world.
 *
 * This is the exact contract the preload/IPC bridge must satisfy. It is
 * intentionally one read method: Wave 4.3a is read-only, so there is no
 * command surface to misuse, and a later command slice adds a separate port
 * rather than widening this one.
 */
export interface HostProjectionTransport {
  /** Fetch the current snapshot. Rejects when Host is unreachable. */
  fetchSnapshot(): Promise<HostSnapshot>
  /** Fetch ordered deltas after a coherent snapshot position. */
  fetchDeltas?(position: HostCursorPosition): Promise<HostDeltasSinceResult>
}

export const HOST_PROJECTION_DELTA_POLL_MS = 1_000
export const HOST_PROJECTION_FULL_REFRESH_MS = 5_000

export interface HostProjectionSyncOptions {
  readonly deltaPollMs?: number
  readonly fullRefreshMs?: number
  readonly now?: () => number
}

/* ------------------------------------------------------------------ */
/*  State                                                             */
/* ------------------------------------------------------------------ */

/**
 * Connection state of THIS CLIENT — not of Host, and not of any run.
 *
 * `unavailable` says the renderer could not reach Host. It says nothing about
 * whether Host is running, whether a mission is progressing, or whether a run
 * succeeded. Collapsing those is the exact failure the goal forbids.
 */
export type HostProjectionStatus = 'idle' | 'loading' | 'live' | 'unavailable'

export interface HostProjectionState {
  readonly status: HostProjectionStatus
  /**
   * Last successfully fetched projection, if any.
   *
   * Present in `unavailable` too — a coherent cache is useful for
   * presentation. Its `freshness` is forced to `cached` in that case, so a
   * view cannot mistake it for current.
   */
  readonly projection?: HostProjectedSnapshot
  /**
   * True when the current projection descends from a freshness-live full Host
   * snapshot through only validated, contiguous deltas. This provenance does
   * not promote a delta-applied cache to live authority; it lets explicitly
   * presentation-only consumers distinguish that coherent cache from an
   * arbitrary or Host-served cached snapshot.
   */
  readonly liveBaselineContinuity?: boolean
  /** Why the last fetch failed. Present only in `unavailable`. */
  readonly unavailableReason?: string
  /** Cursor of the last successful snapshot; enables later delta resumption. */
  readonly lastCursor?: number
  readonly lastGeneration?: number
}

const IDLE_STATE: HostProjectionState = { status: 'idle' }

type Listener = (state: HostProjectionState) => void

/* ------------------------------------------------------------------ */
/*  Store                                                             */
/* ------------------------------------------------------------------ */

/**
 * Observable read-only Host projection for the Desktop renderer.
 *
 * Framework-free on purpose: it is a plain subscribable so it can be tested
 * without a DOM (this repo has no jsdom renderer environment) and consumed by
 * a thin React hook.
 */
export class HostProjectionStore {
  private readonly transport: HostProjectionTransport
  private readonly listeners = new Set<Listener>()
  private state: HostProjectionState = IDLE_STATE
  /** Full Host shape retained only for validated delta application. */
  private sourceSnapshot: HostSnapshot | null = null
  private lastFullRefreshAt = 0
  /** Guards against overlapping refreshes racing each other's results. */
  private inFlight: Promise<HostProjectionState> | null = null
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private syncGeneration = 0
  private syncNow: () => number = () => Date.now()

  constructor(transport: HostProjectionTransport) {
    if (!transport || typeof transport.fetchSnapshot !== 'function') {
      throw new Error('HostProjectionStore requires a transport with fetchSnapshot')
    }
    this.transport = transport
  }

  getState(): HostProjectionState {
    return this.state
  }

  /**
   * Current validated Host wire snapshot for command/approval correlation.
   * Returned as a clone so renderer consumers cannot mutate store state.
   */
  getSourceSnapshot(): HostSnapshot | null {
    return this.sourceSnapshot
      ? (JSON.parse(JSON.stringify(this.sourceSnapshot)) as HostSnapshot)
      : null
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Fetch a fresh snapshot.
   *
   * Concurrent calls share one in-flight request rather than racing: two
   * overlapping fetches could otherwise resolve out of order and install an
   * OLDER snapshot over a newer one, which would silently roll the UI
   * backwards.
   */
  async refresh(): Promise<HostProjectionState> {
    if (this.inFlight) return this.inFlight

    this.setState({
      ...this.state,
      status: 'loading'
    })

    return this.runExclusive(() => this.performFullRefresh())
  }

  /**
   * Resume from the retained generation/cursor. Any discontinuity, malformed
   * batch, retention gap, or unsupported mutation falls back to one full
   * snapshot; the partially-applied working copy is never published.
   */
  async catchUp(): Promise<HostProjectionState> {
    if (this.inFlight) return this.inFlight
    const base = this.sourceSnapshot
    const liveBaselineContinuity = this.state.liveBaselineContinuity === true
    const fetchDeltas = this.transport.fetchDeltas
    if (!base || typeof fetchDeltas !== 'function') {
      return this.refresh()
    }

    return this.runExclusive(async () => {
      const result = await fetchDeltas.call(this.transport, {
        generation: base.generation,
        cursor: base.cursor
      })
      if (result.kind === 'full_resnapshot_required') {
        await this.performFullRefresh()
        return
      }
      if (result.generation !== base.generation || result.fromCursor !== base.cursor) {
        await this.performFullRefresh()
        return
      }

      const applied = applyHostSnapshotDeltas(base, result.deltas)
      if (
        applied.outcome === 'rejected' ||
        applied.outcome === 'require_resnapshot' ||
        applied.cursor !== result.toCursor
      ) {
        await this.performFullRefresh()
        return
      }

      this.sourceSnapshot = applied.snapshot
      this.setState({
        status: 'live',
        projection: projectHostSnapshot(
          applied.snapshot,
          applied.snapshot.freshness === 'live' ? 'live' : 'cached'
        ),
        liveBaselineContinuity,
        lastCursor: applied.cursor,
        lastGeneration: applied.generation
      })
    })
  }

  /**
   * Start one provider-owned continuity loop. Delta polls keep Host-command
   * mutations current; periodic full snapshots reconcile legacy shadows that
   * do not yet publish into the journal. The returned stop is generation-
   * fenced, so an old React cleanup cannot stop a newer loop.
   */
  startSync(options: HostProjectionSyncOptions = {}): () => void {
    const deltaPollMs = positiveDelay(options.deltaPollMs, HOST_PROJECTION_DELTA_POLL_MS)
    const fullRefreshMs = positiveDelay(options.fullRefreshMs, HOST_PROJECTION_FULL_REFRESH_MS)
    const now = options.now ?? (() => Date.now())
    this.syncNow = now
    if (this.sourceSnapshot) this.lastFullRefreshAt = now()
    const generation = ++this.syncGeneration
    if (this.syncTimer) clearTimeout(this.syncTimer)

    const schedule = (): void => {
      if (generation !== this.syncGeneration) return
      this.syncTimer = setTimeout(() => {
        this.syncTimer = null
        const needsFull = !this.sourceSnapshot || now() - this.lastFullRefreshAt >= fullRefreshMs
        const operation = needsFull ? this.refreshQuietly() : this.catchUp()
        void operation.finally(schedule)
      }, deltaPollMs)
    }
    schedule()

    return () => {
      if (generation !== this.syncGeneration) return
      this.syncGeneration += 1
      if (this.syncTimer) clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
  }

  private async refreshQuietly(): Promise<HostProjectionState> {
    if (this.inFlight) return this.inFlight
    return this.runExclusive(() => this.performFullRefresh())
  }

  private async performFullRefresh(): Promise<void> {
    const snapshot = await this.transport.fetchSnapshot()
    const projection = projectHostSnapshot(snapshot, 'live')
    this.sourceSnapshot = snapshot
    this.lastFullRefreshAt = this.syncNow()
    this.setState({
      status: 'live',
      projection,
      liveBaselineContinuity: projection.freshness === 'live',
      lastCursor: snapshot.cursor,
      lastGeneration: snapshot.generation
    })
  }

  private runExclusive(operation: () => Promise<void>): Promise<HostProjectionState> {
    const run = (async (): Promise<HostProjectionState> => {
      try {
        await operation()
      } catch (error) {
        this.setState(this.toUnavailable(error))
      } finally {
        this.inFlight = null
      }
      return this.state
    })()
    this.inFlight = run
    return run
  }

  /**
   * Build the unavailable state.
   *
   * Any previously fetched projection is RETAINED and re-labelled `cached`.
   * Dropping it would be worse than useless: the UI would render an empty
   * workspace, which asserts "there is nothing here" — a fabricated claim.
   * Keeping it, clearly marked stale, is the honest option.
   */
  private toUnavailable(error: unknown): HostProjectionState {
    const reason = error instanceof Error ? error.message : String(error)
    const previous = this.state.projection
    return {
      status: 'unavailable',
      unavailableReason: reason,
      ...(previous
        ? {
            projection: { ...previous, freshness: 'cached' as const },
            liveBaselineContinuity: this.state.liveBaselineContinuity === true
          }
        : {}),
      ...(this.state.lastCursor !== undefined ? { lastCursor: this.state.lastCursor } : {}),
      ...(this.state.lastGeneration !== undefined
        ? { lastGeneration: this.state.lastGeneration }
        : {})
    }
  }

  private setState(next: HostProjectionState): void {
    this.state = next
    for (const listener of this.listeners) {
      listener(next)
    }
  }
}

function positiveDelay(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}
