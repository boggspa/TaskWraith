/**
 * Automatic Host restart for a poisoned Desktop session (Host-lifetime
 * programme D10).
 *
 * Every main-process consumer on the Desktop identity shares ONE Host session,
 * and `HostSession.bind` only ever retains or narrows its grant. One consumer
 * that binds with fewer capabilities strips them from the whole app until the
 * Host process restarts: every later Desktop socket is granted the narrowed
 * set, and its requests for what was dropped answer `unauthorized` — a flood,
 * with chats going summary-only and timers stuck at zero. Nothing short of a
 * Host restart clears it.
 *
 * The broker reports each typed Host error with the identity it ran under.
 * `POISON_UNAUTHORIZED_MIN` of them under the Desktop identity within
 * `POISON_WINDOW_MS` make a suspicion, never a verdict: the detector then reads
 * the Host's own `host.status` and confirms the tell directly — a connected
 * Desktop socket was granted less than a fresh bind of the same request is
 * granted on this Host right now (the reference grant, taken over a fixed
 * probe identity nobody narrows). A Host that simply does not offer something
 * the Desktop asks for is therefore never mistaken for a poisoned one, and an
 * `unauthorized` flood with the grant intact is logged only.
 *
 * A confirmed tell restarts the Host through the lifecycle
 * (`restart('poison-restart')`), deferred while runs are live (up to
 * `POISON_BUSY_CAP_MS`): the poison narrows main's session, not the Host's own
 * persistence, so waiting loses nothing durable, while an immediate kill would
 * cancel provider turns. The loop guard is mandatory: at most one automatic
 * restart per `POISON_RESTART_MIN_INTERVAL_MS` and `POISON_RESTARTS_PER_SESSION`
 * per app session; a tell beyond either limit posts one "restart manually"
 * notification and the detector stops for the session. It never acts while the
 * app is quitting, while an update restart is pending, or after a start
 * failed (a failed start is never retried in the background).
 */

import {
  TASKWRAITH_DESKTOP_HOST_CAPABILITIES,
  TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
  type HostCapability,
  type HostStatusProjection
} from '../../shared/hostProtocol'
import type { HostProjectionTransportErrorReport } from './HostProjectionBroker'
import type { HostLifecycleHostIdentity } from '../../shared/hostLifecycle'
import { HostProjectionClient } from './HostProjectionClient'

export const POISON_WINDOW_MS = 30_000
export const POISON_UNAUTHORIZED_MIN = 10
export const POISON_RESTART_MIN_INTERVAL_MS = 600_000
export const POISON_RESTARTS_PER_SESSION = 3
export const POISON_BUSY_CAP_MS = 1_800_000
export const POISON_IDLE_POLL_MS = 5_000

/** A fixed identity: it binds once per Host and always asks the same, so it is never narrowed. */
export const DESKTOP_GRANT_REFERENCE_CLIENT_ID = 'taskwraith-desktop-grant-reference'

export const POISON_MANUAL_RESTART_MESSAGE =
  'The TaskWraith Host needs a manual restart: its Desktop session lost capabilities again. ' +
  'Choose Restart Host from the TaskWraith menu.'

export type HostPoisonVerdict =
  | { readonly kind: 'confirmed'; readonly missing: readonly HostCapability[] }
  | { readonly kind: 'unconfirmed'; readonly why: string }

export interface HostPoisonDetectorOptions {
  /** The shared identity whose errors count (the Desktop one by default). */
  readonly clientId?: string
  /** The Host's own status over main's lease socket; null when it cannot be read. */
  readonly readHostStatus: () => Promise<HostStatusProjection | null>
  /** What a fresh bind of the Desktop request is granted on this Host now; null when unknown. */
  readonly readReferenceGrant: () => Promise<readonly HostCapability[] | null>
  /** `HostLifecycleController.restart('poison-restart')`. */
  readonly restart: (
    expectedHost: HostLifecycleHostIdentity
  ) => Promise<{ readonly ok: boolean; readonly error?: string }>
  readonly isClosing: () => boolean
  readonly isUpdateRestartPending: () => boolean
  /** The lifecycle's last start failed: nothing restarts in the background then. */
  readonly lastStartFailed: () => boolean
  /** A stopped or replaced lifecycle must not inherit a deferred restart. */
  readonly isHostRunning?: () => boolean
  readonly notify: (message: string) => void
  readonly now?: () => number
  readonly delay?: (ms: number) => Promise<void>
  readonly log?: (line: string) => void
}

/**
 * The tell, read from the Host itself: each connected socket bound as the
 * Desktop identity against the reference grant. Missing capabilities are those
 * the reference has and some Desktop socket was not granted.
 */
export function judgeHostPoison(
  status: HostStatusProjection,
  reference: readonly HostCapability[],
  clientId: string = TASKWRAITH_DESKTOP_HOST_CLIENT_ID
): HostPoisonVerdict {
  const desktop = status.clients.filter(
    (client) => client.clientClass === 'desktop' && client.clientId === clientId
  )
  if (desktop.length === 0) {
    return { kind: 'unconfirmed', why: 'no Desktop socket is connected to compare' }
  }
  const missing = new Set<HostCapability>()
  for (const client of desktop) {
    for (const capability of reference) {
      if (!client.capabilities.includes(capability)) missing.add(capability)
    }
  }
  return missing.size > 0
    ? { kind: 'confirmed', missing: [...missing] }
    : { kind: 'unconfirmed', why: 'the Desktop grant matches a fresh bind' }
}

/** The reference probe: the Desktop request under an identity nobody narrows. */
export function createDesktopGrantReferenceProbe(input: {
  readonly userDataPath: string
  readonly appVersion: string
}): () => Promise<readonly HostCapability[] | null> {
  return async () => {
    const client = new HostProjectionClient({
      userDataPath: input.userDataPath,
      client: {
        clientId: DESKTOP_GRANT_REFERENCE_CLIENT_ID,
        clientClass: 'desktop',
        clientVersion: input.appVersion
      },
      capabilities: [...TASKWRAITH_DESKTOP_HOST_CAPABILITIES],
      connectTimeoutMs: 2_000,
      requestTimeoutMs: 2_000
    })
    try {
      const welcome = await client.connect()
      return [...welcome.capabilities]
    } catch {
      return null
    } finally {
      client.close()
    }
  }
}

export class HostPoisonDetector {
  private readonly clientId: string
  private readonly now: () => number
  private readonly delay: (ms: number) => Promise<void>
  private readonly log: (line: string) => void
  private readonly window: number[] = []
  private evaluating: Promise<void> | null = null
  private restarts = 0
  private lastRestartAt: number | null = null
  private stopped = false

  constructor(private readonly options: HostPoisonDetectorOptions) {
    this.clientId = options.clientId ?? TASKWRAITH_DESKTOP_HOST_CLIENT_ID
    this.now = options.now ?? (() => Date.now())
    this.delay =
      options.delay ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms)
          timer.unref?.()
        }))
    this.log = options.log ?? (() => undefined)
  }

  /** Automatic restarts done this session (diagnostics and tests). */
  get restartCount(): number {
    return this.restarts
  }

  /** The loop guard tripped: the detector does nothing more this session. */
  get isStopped(): boolean {
    return this.stopped
  }

  /** The broker's `onTransportError`. Synchronous and never throws. */
  report(report: HostProjectionTransportErrorReport): void {
    if (this.stopped || report.code !== 'unauthorized' || report.clientId !== this.clientId) return
    const at = this.now()
    this.window.push(at)
    while (this.window.length > 0 && at - this.window[0] > POISON_WINDOW_MS) this.window.shift()
    if (this.window.length < POISON_UNAUTHORIZED_MIN || this.evaluating) return
    const count = this.window.length
    this.window.length = 0
    const evaluation = this.evaluate(count)
      .catch((error: unknown) => {
        this.log(
          `[host-poison] evaluation failed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => {
        if (this.evaluating === evaluation) this.evaluating = null
      })
    this.evaluating = evaluation
  }

  /** Settles the evaluation in flight, if any (tests and teardown). */
  async settled(): Promise<void> {
    await this.evaluating
  }

  private blockedBecause(): string | null {
    if (this.options.isClosing()) return 'the app is quitting'
    if (this.options.isUpdateRestartPending()) return 'an update restart is pending'
    if (this.options.lastStartFailed()) return 'the last Host start failed'
    if (this.options.isHostRunning?.() === false) return 'the Host is no longer running'
    return null
  }

  private async evaluate(count: number): Promise<void> {
    const flood = `${count} unauthorized answers within ${POISON_WINDOW_MS} ms`
    const blocked = this.blockedBecause()
    if (blocked) {
      this.log(`[host-poison] ${flood}; not acting because ${blocked}`)
      return
    }
    const status = await this.options.readHostStatus()
    const reference = status ? await this.options.readReferenceGrant() : null
    if (!status || !reference) {
      this.log(`[host-poison] ${flood}; unconfirmed: the Host status could not be read`)
      return
    }
    const verdict = judgeHostPoison(status, reference, this.clientId)
    if (verdict.kind === 'unconfirmed') {
      this.log(`[host-poison] ${flood}; unconfirmed: ${verdict.why}. Logged only.`)
      return
    }
    const missing = verdict.missing.join(', ')
    if (this.restarts >= POISON_RESTARTS_PER_SESSION) {
      this.stopForSession(
        `${flood}; confirmed (missing ${missing}) after ${this.restarts} automatic restarts this session`
      )
      return
    }
    if (
      this.lastRestartAt !== null &&
      this.now() - this.lastRestartAt < POISON_RESTART_MIN_INTERVAL_MS
    ) {
      this.stopForSession(
        `${flood}; confirmed (missing ${missing}) again within ${POISON_RESTART_MIN_INTERVAL_MS} ms of the last automatic restart`
      )
      return
    }
    this.log(`[host-poison] ${flood}; confirmed: the Desktop grant lacks ${missing}`)

    // Deferred while runs are live, up to the busy cap.
    const deferredAt = this.now()
    for (;;) {
      const stillBlocked = this.blockedBecause()
      if (stillBlocked) {
        this.log(`[host-poison] restart abandoned: ${stillBlocked}`)
        return
      }
      const current = await this.options.readHostStatus()
      if (
        !current ||
        current.pid !== status.pid ||
        current.startedAt !== status.startedAt ||
        current.hostId !== status.hostId
      ) {
        this.log('[host-poison] restart abandoned: the confirmed Host is no longer current')
        return
      }
      const live = current.liveWork.runs
      if (live === 0) break
      if (this.now() - deferredAt >= POISON_BUSY_CAP_MS) {
        this.log(
          `[host-poison] restarting at the ${POISON_BUSY_CAP_MS} ms cap with runs still live`
        )
        break
      }
      await this.delay(POISON_IDLE_POLL_MS)
    }
    const finalBlock = this.blockedBecause()
    if (finalBlock) {
      this.log(`[host-poison] restart abandoned: ${finalBlock}`)
      return
    }
    this.restarts += 1
    this.lastRestartAt = this.now()
    const result = await this.options.restart({
      pid: status.pid,
      startedAt: status.startedAt,
      hostId: status.hostId
    })
    this.log(
      result.ok
        ? `[host-poison] restarted the Host (${this.restarts} of ${POISON_RESTARTS_PER_SESSION} this session)`
        : `[host-poison] the automatic restart failed: ${result.error ?? 'unknown failure'}`
    )
  }

  private stopForSession(why: string): void {
    this.stopped = true
    this.log(`[host-poison] ${why}; not restarting again this session`)
    try {
      this.options.notify(POISON_MANUAL_RESTART_MESSAGE)
    } catch {
      // The notification is advisory; the log line above already names it.
    }
  }
}

/** The lifecycle surface the detector acts through. */
export interface HostPoisonLifecycle {
  restart(
    reason: 'poison-restart',
    expectedHost?: HostLifecycleHostIdentity
  ): Promise<{ readonly ok: boolean; readonly error?: string }>
  readonly isClosing: boolean
  getSnapshot(): { readonly phase: string; readonly reason: string }
}

/**
 * Production wiring: status over main's lease socket, the reference grant over
 * its fixed probe identity, and the lifecycle's restart. The caller routes the
 * Desktop broker's `onTransportError` into `report`.
 */
export function createHostPoisonDetector(input: {
  readonly profilePath: string
  readonly appVersion: string
  readonly lifecycle: HostPoisonLifecycle
  readonly readHostStatus: () => Promise<HostStatusProjection | null>
  readonly isUpdateRestartPending: () => boolean
  readonly notify: (message: string) => void
  readonly log?: (line: string) => void
}): HostPoisonDetector {
  return new HostPoisonDetector({
    readHostStatus: input.readHostStatus,
    readReferenceGrant: createDesktopGrantReferenceProbe({
      userDataPath: input.profilePath,
      appVersion: input.appVersion
    }),
    restart: (expectedHost) => input.lifecycle.restart('poison-restart', expectedHost),
    isClosing: () => input.lifecycle.isClosing,
    isUpdateRestartPending: input.isUpdateRestartPending,
    lastStartFailed: () => {
      const snapshot = input.lifecycle.getSnapshot()
      return snapshot.phase === 'failed' && snapshot.reason === 'start-failed'
    },
    isHostRunning: () => input.lifecycle.getSnapshot().phase === 'running',
    notify: input.notify,
    ...(input.log ? { log: input.log } : {})
  })
}
