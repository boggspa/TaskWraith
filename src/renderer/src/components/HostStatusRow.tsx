/**
 * Host Arc Wave 4.3d — the first view that actually reads Host.
 *
 * WHAT THIS IS. The compact Desktop Host surface in the approvals popover. It
 * reports connection/provider/approval status. Mission Control now lives in
 * Thread Home, where the same Host projection has room for a dedicated pane.
 * Until this existed, 4.3c mounted the provider but nothing consumed it:
 * Desktop *could* project Host state and never did. This call site makes the
 * mount real.
 *
 * IT ALSO EXERCISES THE MOUNT-TIME FETCH. `useHostProjection` refreshes on
 * mount by default, so opening this popover drives the whole chain for real —
 * preload conduit, main-process client, authenticated socket, snapshot. The
 * 4.3a/4.3c tests could never cover that, because renderer tests here run
 * under `renderToStaticMarkup`, which does not run effects.
 *
 * WHY THIS POPOVER. Host reachability determines whether nearby approvals and
 * questions are current, so these compact facts remain useful after Mission
 * Control moves into Thread Home.
 *
 * THE DISTINCTION THIS ROW EXISTS TO PRESERVE. "We cannot reach Host" and
 * "this is what Host last told us" are DIFFERENT CLAIMS, and this is the only
 * layer where a person ever sees either. Rendering them identically would be
 * lying by omission, so `unavailable` and `cached` get different words —
 * enforced by a test, not by convention.
 *
 * Mission Control still authors only governed Host command intents from its
 * new pane; authority and durable receipts remain Host-owned.
 */

import { useEffect, useRef, useState } from 'react'

import { useHostProjection } from '../hooks/useHostProjection'
import { useHostProjectionStore } from './HostProjectionProvider'
import type { HostProjectionState } from '../lib/host/HostProjectionStore'
import { HostLifecycleIpcClient } from '../lib/host/hostLifecycleIpcClient'
import { HOST_WARNING_PROVIDER_SOURCE_NOT_READY } from '../../../shared/hostProtocol'
import type { HostLifecycleAction, HostLifecycleSnapshot } from '../../../shared/hostLifecycle'

/** What the row should show. Pure data so it can be tested without React. */
export interface HostConnectionView {
  /** LED lit ONLY when Host answered just now. Cached data never lights it. */
  readonly connected: boolean
  /** Short label a human reads at a glance. */
  readonly status: string
  /** Optional hover detail — the honest reason, when there is one. */
  readonly detail?: string
}

/**
 * Map projection state to what the row says.
 *
 * Exported and pure on purpose: every meaningful decision here is testable
 * without a DOM, which matters because this repo has no jsdom environment.
 *
 * The four outcomes are deliberately distinct strings:
 * - `Connected`        Host answered this session.
 * - `Last known state` Host is unreachable BUT we still hold a coherent
 *                      snapshot. Shown, and explicitly not called live.
 * - `Unreachable`      Host is unreachable and we hold nothing. This must
 *                      never be rendered as an empty-but-fine world.
 * - `Not checked` / `Checking…`  Honest pre-fetch states, not failures.
 */
export function describeHostConnection(
  state: HostProjectionState,
  lifecycle?: HostLifecycleSnapshot | null
): HostConnectionView {
  if (lifecycle?.phase === 'starting') {
    return { connected: false, status: 'Starting…' }
  }
  if (lifecycle?.phase === 'stopping') {
    return { connected: false, status: 'Stopping…' }
  }
  if (lifecycle?.phase === 'stopped') {
    return {
      connected: false,
      status: lifecycle.reason === 'user-stop' ? 'Stopped by you' : 'Stopped'
    }
  }
  if (lifecycle?.phase === 'failed') {
    return {
      connected: false,
      status: lifecycle.desired === 'running' ? 'Start failed' : 'Stop failed',
      ...(lifecycle.error ? { detail: lifecycle.error } : {})
    }
  }
  if (state.status === 'live') {
    return { connected: true, status: 'Connected' }
  }

  if (state.status === 'loading') {
    return { connected: false, status: 'Checking…' }
  }

  if (state.status === 'unavailable') {
    // The load-bearing branch. A retained projection means we can still show
    // something true — but it is history, not current state, and the wording
    // has to say so.
    if (state.projection) {
      return {
        connected: false,
        status: 'Last known state',
        ...(state.unavailableReason
          ? { detail: `Host unreachable: ${state.unavailableReason}` }
          : {})
      }
    }
    return {
      connected: false,
      status: 'Unreachable',
      ...(state.unavailableReason ? { detail: state.unavailableReason } : {})
    }
  }

  // idle — a provider is mounted but nothing has asked Host yet. Distinct from
  // a failure, and never dressed up as one.
  return { connected: false, status: 'Not checked' }
}

/**
 * Lifecycle state fences cached projection authority immediately. The socket
 * store catches up asynchronously, so without this adapter a just-stopped Host
 * could leave Mission Control buttons enabled for one render.
 */
export function applyHostLifecycleToProjectionState(
  state: HostProjectionState,
  lifecycle?: HostLifecycleSnapshot | null
): HostProjectionState {
  if (!lifecycle || lifecycle.phase === 'running') return state
  return {
    ...state,
    status: 'unavailable',
    unavailableReason:
      lifecycle.error ??
      (lifecycle.phase === 'stopped'
        ? 'Host is stopped inside TaskWraith.'
        : `Host is ${lifecycle.phase}.`),
    ...(state.projection
      ? { projection: { ...state.projection, freshness: 'cached' as const } }
      : {})
  }
}

export interface HostLifecycleControlView {
  readonly note: string
  readonly stateLabel: string
  readonly action?: HostLifecycleAction
  readonly actionLabel?: string
  readonly disabled: boolean
  readonly detail?: string
}

/** The Host is its own process: apps and the terminal client attach to it. */
export const INDEPENDENT_HOST_NOTE = 'Independent Host'

/**
 * How long the Host lives now that clients hold leases on it, short enough for
 * an aria-label. The 45 s is the Host's last-lease grace
 * (`HOST_LAST_LEASE_GRACE_MS`); a test ties the sentence to that constant.
 */
export const HOST_LEASE_LIFETIME_NOTE =
  'The Host runs while TaskWraith or a TUI holds it, and stops about 45 s after the last one leaves, once live work drains.'

/** Compact Host duration (uptime, connection age, grace left): 42s, 12m, 3h 12m, 2d 4h. */
export function formatHostDuration(ms: number): string {
  const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalHours < 24) return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

/**
 * "Independent Host · pid 4242 · up 3h 12m" while the Host runs and its
 * process has been observed; "Independent Host" otherwise.
 *
 * The compact surfaces receive only the lifecycle snapshot, whose `host`
 * block carries the listener start the Host stamped itself (ISO-8601 UTC), so
 * the uptime here is that instant's distance from `nowMs` on the same
 * machine's clock. The Settings Host card shows the Host's own `uptimeMs`
 * from `host.status` instead.
 */
export function describeHostProcessNote(
  lifecycle: HostLifecycleSnapshot | null,
  nowMs: number = Date.now()
): string {
  const host = lifecycle?.phase === 'running' ? lifecycle.host : undefined
  if (!host) return INDEPENDENT_HOST_NOTE
  const startedAtMs = Date.parse(host.startedAt)
  const uptime = Number.isFinite(startedAtMs)
    ? ` · up ${formatHostDuration(nowMs - startedAtMs)}`
    : ''
  return `${INDEPENDENT_HOST_NOTE} · pid ${host.pid}${uptime}`
}

/** Pure copy/action mapping for the visible in-app lifecycle control. */
export function describeHostLifecycleControl(
  lifecycle: HostLifecycleSnapshot | null,
  pending = false,
  unavailableReason?: string,
  nowMs: number = Date.now()
): HostLifecycleControlView {
  const note = describeHostProcessNote(lifecycle, nowMs)
  if (!lifecycle) {
    return {
      note,
      stateLabel: unavailableReason ? 'Control unavailable' : 'Checking control…',
      disabled: true,
      ...(unavailableReason ? { detail: unavailableReason } : {})
    }
  }
  if (lifecycle.phase === 'running') {
    return {
      note,
      stateLabel: 'Running in this app',
      action: 'stop',
      actionLabel: pending ? 'Stopping…' : 'Stop Host',
      disabled: pending
    }
  }
  if (lifecycle.phase === 'starting') {
    return {
      note,
      stateLabel: 'Starting in this app',
      action: 'start',
      actionLabel: 'Starting…',
      disabled: true
    }
  }
  if (lifecycle.phase === 'stopping') {
    return {
      note,
      stateLabel: 'Stopping',
      action: 'stop',
      actionLabel: 'Stopping…',
      disabled: true
    }
  }
  if (lifecycle.phase === 'failed') {
    const action = lifecycle.desired === 'running' ? 'start' : 'stop'
    return {
      note,
      stateLabel: lifecycle.desired === 'running' ? 'Start failed' : 'Stop failed',
      action,
      actionLabel:
        action === 'start'
          ? pending
            ? 'Starting…'
            : 'Retry Host'
          : pending
            ? 'Stopping…'
            : 'Retry stop',
      disabled: pending,
      ...(lifecycle.error ? { detail: lifecycle.error } : {})
    }
  }
  return {
    note,
    stateLabel: lifecycle.reason === 'user-stop' ? 'Stopped by you' : 'Stopped',
    action: 'start',
    actionLabel: pending ? 'Starting…' : 'Start Host',
    disabled: pending
  }
}

/** Providers as Host reports them, or an honest absence. */
export interface HostProvidersView {
  /** True for a live snapshot or its continuously validated display projection. */
  readonly known: boolean
  readonly available?: number
  readonly total?: number
  /** What a human reads. Never a fabricated count. */
  readonly label: string
}

/**
 * Wave 5a — the goal invariant, applied to a real family.
 *
 * "Unavailable telemetry is not zero. Cached state is not live state."
 *
 * There are TWO independent ways a provider count can fail to be current, and
 * both must land on "Unknown":
 *
 *  1. the client could not reach Host at all (`status !== 'live'`);
 *  2. Host served a cached snapshot without a live baseline. This differs
 *     from a connected client applying contiguous deltas to a live snapshot:
 *     those rows remain suitable for display (as in the provider picker),
 *     while their cached freshness still fences command authority.
 *
 * Checking only (1) is the easy mistake, and it would paint Host's own stale
 * answer as a fresh measurement. Rendering either as "0 providers" would be
 * worse still: a confident zero reads as "there are none", which is a
 * different and false claim from "we do not know".
 */
export function describeHostProviders(state: HostProjectionState): HostProvidersView {
  const projection = state.projection
  if (
    !projection ||
    state.status !== 'live' ||
    (projection.freshness !== 'live' && state.liveBaselineContinuity !== true)
  ) {
    return { known: false, label: 'Unknown' }
  }

  // Wave 5d — THE DISTINCTION AN EMPTY ARRAY CANNOT MAKE.
  //
  // `providers` is required on the wire, so [] means BOTH "Host measured
  // none" AND "the source has not finished discovering". Host tells us which
  // by publishing a typed warning code. Counting without consulting it
  // renders a confident zero for an unknown — fabricated telemetry, which the
  // arc goal forbids by name.
  //
  // `?? []` because a projection may predate this field; a missing code list
  // means "no warnings", which correctly falls through to the real count.
  if ((projection.warningCodes ?? []).includes(HOST_WARNING_PROVIDER_SOURCE_NOT_READY)) {
    return { known: false, label: 'Unknown' }
  }

  const total = projection.providers.length
  const available = projection.providers.filter((provider) => provider.available).length
  return {
    known: true,
    available,
    total,
    // A live empty list is a real answer and says so in words, so it can never
    // be confused with the unknown case above.
    // Wave 5e — wire `available` means admitted in the configured snapshot,
    // not runtime-healthy. Say "configured" so the leaf does not overstate.
    label: total === 0 ? 'None reported' : `${available} of ${total} configured`
  }
}

/** Awaiting approvals as Host reports them, or an honest absence. */
export interface HostAwaitingApprovalsView {
  readonly known: boolean
  /** Count of rows still waiting on a decision. Never a total of all approvals. */
  readonly awaiting?: number
  readonly label: string
}

/**
 * Wave 5f — the first family Desktop reads that actually has rows behind it.
 *
 * TWO honesty constraints, both known BEFORE this was written:
 *
 * 1. SUBSET. Host carries AWAITING approval cards only — base suppliers return
 *    `[]` and the composition merges nothing else. Decided/rejected/ledger
 *    approvals never reach the wire, so the label says "awaiting" and never
 *    "approvals". An empty list is a real answer — "nothing is waiting" — not
 *    a claim that no approval has ever existed.
 *
 * 2. STATUS VALUE. The wire enum is pending|approved|denied|expired|cancelled.
 *    There is NO 'awaiting' status: `HostMainComposition` mints awaiting cards
 *    as `status: 'pending'`. Counting a literal 'awaiting' would read zero
 *    forever and look perfectly healthy while doing it.
 *
 * Staleness reuses the SAME unknown path as the providers row — one unknown
 * mechanism, not two.
 */
export function describeHostAwaitingApprovals(
  state: HostProjectionState
): HostAwaitingApprovalsView {
  const projection = state.projection
  if (
    !projection ||
    state.status !== 'live' ||
    (projection.freshness !== 'live' && state.liveBaselineContinuity !== true)
  ) {
    return { known: false, label: 'Unknown' }
  }

  const awaiting = (projection.approvals ?? []).filter(
    (approval) => approval.status === 'pending'
  ).length

  return {
    known: true,
    awaiting,
    // "None awaiting" — not "None". Host only ever knew the awaiting subset.
    label: awaiting === 0 ? 'None awaiting' : `${awaiting} awaiting`
  }
}

/**
 * Compact Host status surface for the approvals popover.
 *
 * Reads the app-scope store through context. With no provider above it the
 * hook reports `idle`, which renders as "Not checked" rather than inventing a
 * connection state.
 */
export interface HostStatusRowProps {
  /** Injected only by tests; production resolves the preload conduit lazily. */
  readonly lifecycleClient?: HostLifecycleIpcClient
}

export function HostStatusRow({
  lifecycleClient: injectedLifecycleClient
}: HostStatusRowProps = {}) {
  const store = useHostProjectionStore()
  const sourceState = useHostProjection(store)
  const [lifecycleClient] = useState(() => injectedLifecycleClient ?? new HostLifecycleIpcClient())
  const [lifecycle, setLifecycle] = useState<HostLifecycleSnapshot | null>(null)
  const [lifecycleError, setLifecycleError] = useState<string>()
  const [lifecyclePending, setLifecyclePending] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const adopt = (next: HostLifecycleSnapshot): void => {
      if (!mounted.current) return
      setLifecycle((current) => (!current || next.revision >= current.revision ? next : current))
      setLifecycleError(undefined)
    }
    const unsubscribe = lifecycleClient.subscribe(adopt)
    void lifecycleClient.status().then(adopt, (error: unknown) => {
      if (!mounted.current) return
      setLifecycleError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      mounted.current = false
      unsubscribe()
    }
  }, [lifecycleClient])

  const state = applyHostLifecycleToProjectionState(sourceState, lifecycle)
  const view = describeHostConnection(state, lifecycle)
  const providers = describeHostProviders(state)
  const approvals = describeHostAwaitingApprovals(state)
  const lifecycleControl = describeHostLifecycleControl(lifecycle, lifecyclePending, lifecycleError)

  const runLifecycleAction = (): void => {
    const action = lifecycleControl.action
    if (!action || lifecycleControl.disabled) return
    setLifecyclePending(true)
    setLifecycleError(undefined)
    void lifecycleClient
      .set(action)
      .then((result) => {
        if (!mounted.current) return
        if (result.snapshot) {
          setLifecycle((current) =>
            !current || result.snapshot!.revision >= current.revision ? result.snapshot! : current
          )
        }
        if (!result.ok) setLifecycleError(result.error)
        void store?.refresh()
      })
      .catch((error: unknown) => {
        if (mounted.current) {
          setLifecycleError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (mounted.current) setLifecyclePending(false)
      })
  }

  return (
    <>
      <div className="sidebar-footer-device-row" {...(view.detail ? { title: view.detail } : {})}>
        <span className={`sidebar-footer-led${view.connected ? ' is-on' : ''}`} aria-hidden />
        <span className="sidebar-footer-device-name">TaskWraith Host</span>
        <span className="sidebar-footer-device-status">{view.status}</span>
      </div>
      <div
        className="host-lifecycle-control"
        {...(lifecycleControl.detail ? { title: lifecycleControl.detail } : {})}
      >
        <span className="host-lifecycle-copy">
          <span>{lifecycleControl.note}</span>
          <span className="host-lifecycle-state" role="status" aria-live="polite">
            {lifecycleControl.stateLabel}
          </span>
        </span>
        {lifecycleControl.action ? (
          <button
            type="button"
            className="host-lifecycle-toggle"
            disabled={lifecycleControl.disabled}
            onClick={runLifecycleAction}
            aria-label={`${lifecycleControl.actionLabel}. ${lifecycleControl.note}.`}
          >
            {lifecycleControl.actionLabel}
          </button>
        ) : null}
      </div>
      {/* Wave 5a. Reuses the same status-row markup. The LED
          stays unlit here: it means "this client reached Host", which is the
          row above's claim, not this one's. */}
      <div className="sidebar-footer-device-row">
        <span className="sidebar-footer-led" aria-hidden />
        <span className="sidebar-footer-device-name">Host providers</span>
        <span className="sidebar-footer-device-status">{providers.label}</span>
      </div>
      {/* Wave 5f. Same status-row markup again. The value
          carries the word "awaiting" because that is the only subset Host
          holds — the decided history lives in AppStore and is not projected. */}
      <div className="sidebar-footer-device-row">
        <span className="sidebar-footer-led" aria-hidden />
        <span className="sidebar-footer-device-name">Host approvals</span>
        <span className="sidebar-footer-device-status">{approvals.label}</span>
      </div>
    </>
  )
}
