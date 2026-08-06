/**
 * Host Arc Wave 4.3d — the first view that actually reads Host.
 *
 * WHAT THIS IS. A single row in the sidebar's Devices popover reporting
 * whether this window can currently reach TaskWraith Host. Until this existed,
 * 4.3c mounted the provider but nothing consumed it: Desktop *could* project
 * Host state and never did. This is the call site that makes the mount real.
 *
 * IT ALSO EXERCISES THE MOUNT-TIME FETCH. `useHostProjection` refreshes on
 * mount by default, so opening this popover drives the whole chain for real —
 * preload conduit, main-process client, authenticated socket, snapshot. The
 * 4.3a/4.3c tests could never cover that, because renderer tests here run
 * under `renderToStaticMarkup`, which does not run effects.
 *
 * WHY THIS ROW, IN THIS POPOVER. It reuses the Devices popover's existing row
 * markup exactly, so the slice needs ZERO new CSS — no stylesheet is in scope,
 * and inventing layout would be the opposite of "small". "Devices" is already
 * the connections surface, which is where a connection state belongs.
 *
 * THE DISTINCTION THIS ROW EXISTS TO PRESERVE. "We cannot reach Host" and
 * "this is what Host last told us" are DIFFERENT CLAIMS, and this is the only
 * layer where a person ever sees either. Rendering them identically would be
 * lying by omission, so `unavailable` and `cached` get different words —
 * enforced by a test, not by convention.
 *
 * READ-ONLY. No commands, no mutations, and it retires no AppStore-backed
 * view. It reports connection state and nothing else.
 */

import { useHostProjection } from '../hooks/useHostProjection'
import { useHostProjectionStore } from './HostProjectionProvider'
import type { HostProjectionState } from '../lib/host/HostProjectionStore'
import { HOST_WARNING_PROVIDER_SOURCE_NOT_READY } from '../../../shared/hostProtocol'

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
export function describeHostConnection(state: HostProjectionState): HostConnectionView {
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

/** Providers as Host reports them, or an honest absence. */
export interface HostProvidersView {
  /** False whenever the numbers are not a LIVE measured fact. */
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
 *  2. Host answered, but said the projection it served was ITSELF cached —
 *     `projectHostSnapshot` forces `freshness: 'cached'` in that case, so
 *     `status` can be 'live' while the data underneath is stale.
 *
 * Checking only (1) is the easy mistake, and it would paint Host's own stale
 * answer as a fresh measurement. Rendering either as "0 providers" would be
 * worse still: a confident zero reads as "there are none", which is a
 * different and false claim from "we do not know".
 */
export function describeHostProviders(state: HostProjectionState): HostProvidersView {
  const projection = state.projection
  if (!projection || state.status !== 'live' || projection.freshness !== 'live') {
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

/**
 * Host connection row for the Devices popover.
 *
 * Reads the app-scope store through context. With no provider above it the
 * hook reports `idle`, which renders as "Not checked" rather than inventing a
 * connection state.
 */
export function HostStatusRow() {
  const store = useHostProjectionStore()
  const state = useHostProjection(store)
  const view = describeHostConnection(state)
  const providers = describeHostProviders(state)

  return (
    <>
      <div className="sidebar-footer-device-row" {...(view.detail ? { title: view.detail } : {})}>
        <span className={`sidebar-footer-led${view.connected ? ' is-on' : ''}`} aria-hidden />
        <span className="sidebar-footer-device-name">TaskWraith Host</span>
        <span className="sidebar-footer-device-status">{view.status}</span>
      </div>
      {/* Wave 5a. Reuses the same row markup, so still ZERO new CSS. The LED
          stays unlit here: it means "this client reached Host", which is the
          row above's claim, not this one's. */}
      <div className="sidebar-footer-device-row">
        <span className="sidebar-footer-led" aria-hidden />
        <span className="sidebar-footer-device-name">Host providers</span>
        <span className="sidebar-footer-device-status">{providers.label}</span>
      </div>
    </>
  )
}
