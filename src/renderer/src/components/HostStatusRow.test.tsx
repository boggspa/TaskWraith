/**
 * Wave 4.3d — Host status row tests.
 *
 * The load-bearing test is `renders CACHED and UNREACHABLE with different
 * words`. Both are `status: 'unavailable'` internally, and this row is the
 * only place a human ever sees the difference between "we cannot reach Host"
 * and "this is what Host last told us". Collapsing them would be lying by
 * omission.
 *
 * No DOM: `renderToStaticMarkup` per the Sidebar.test.tsx pattern. The pure
 * mapper carries every decision, so most assertions need no React at all.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// Wave 4.3e — the iOS remote flag is forced OFF for this whole file.
//
// That is the condition the placement pin exists to survive: Host is not an
// iOS feature, so Desktop's Host surface must not vanish when iOS remote
// chrome is switched off. Both flags are mocked because the module exports
// two, and a partial mock would leave the other undefined at import time.
vi.mock('../lib/featureFlags', () => ({
  IOS_REMOTE_ENABLED: false,
  ACTIVITY_REPORTING_CONFIGURED: false
}))

import { ApprovalsFooterPopover, DevicesFooterPopover } from './Sidebar'
import { HostProjectionProvider } from './HostProjectionProvider'
import { HostStatusRow, describeHostConnection, describeHostProviders } from './HostStatusRow'
import { HOST_WARNING_PROVIDER_SOURCE_NOT_READY } from '../../../shared/hostProtocol'
import { HostProjectionStore } from '../lib/host/HostProjectionStore'
import type { HostProjectionState } from '../lib/host/HostProjectionStore'
import type { HostSnapshot } from '../../../shared/hostProtocol'

function snapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    protocolVersion: 2,
    projectionVersion: 1,
    generatedAt: '2026-08-06T12:00:00.000Z',
    generation: 3,
    cursor: 42,
    freshness: 'live',
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    },
    workspaces: [],
    threads: [],
    runs: [],
    missions: [],
    rounds: [],
    participants: [],
    providers: [],
    questions: [],
    approvals: [],
    schedules: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings: [],
    recovery: {},
    ...overrides
  } as unknown as HostSnapshot
}

const state = (partial: Partial<HostProjectionState>): HostProjectionState =>
  ({ status: 'idle', ...partial }) as HostProjectionState

/* ------------------------------------------------------------------ */
/*  The distinction this row exists to preserve                       */
/* ------------------------------------------------------------------ */

describe('describeHostConnection · cached and unreachable are different claims', () => {
  it('renders CACHED and UNREACHABLE with different words', () => {
    const cached = describeHostConnection(
      state({
        status: 'unavailable',
        projection: { freshness: 'cached' } as never,
        unavailableReason: 'host socket refused'
      })
    )
    const unreachable = describeHostConnection(
      state({ status: 'unavailable', unavailableReason: 'host socket refused' })
    )

    // Both are internally `unavailable`. A human must still be able to tell
    // "we hold Host's last word" from "we hold nothing at all".
    expect(cached.status).not.toBe(unreachable.status)
    expect(cached.status).toBe('Last known state')
    expect(unreachable.status).toBe('Unreachable')
  })

  it('never lights the LED for cached data', () => {
    const cached = describeHostConnection(
      state({ status: 'unavailable', projection: { freshness: 'cached' } as never })
    )
    // A lit LED would read as "connected". Cached state is not a connection.
    expect(cached.connected).toBe(false)
  })

  it('lights the LED only when Host answered this session', () => {
    expect(describeHostConnection(state({ status: 'live' })).connected).toBe(true)
    expect(describeHostConnection(state({ status: 'idle' })).connected).toBe(false)
    expect(describeHostConnection(state({ status: 'loading' })).connected).toBe(false)
  })

  it('carries the honest reason as hover detail when there is one', () => {
    const view = describeHostConnection(
      state({ status: 'unavailable', unavailableReason: 'host socket refused' })
    )
    expect(view.detail).toBe('host socket refused')
  })

  it('reports pre-fetch states as themselves, not as failures', () => {
    expect(describeHostConnection(state({ status: 'idle' })).status).toBe('Not checked')
    expect(describeHostConnection(state({ status: 'loading' })).status).toBe('Checking…')
    // "Not checked" must not be dressed up as a problem.
    expect(describeHostConnection(state({ status: 'idle' })).status).not.toBe('Unreachable')
  })
})

/* ------------------------------------------------------------------ */
/*  Rendered output                                                   */
/* ------------------------------------------------------------------ */

function renderRow(store?: HostProjectionStore): string {
  return renderToStaticMarkup(
    <HostProjectionProvider {...(store ? { store } : {})}>
      <HostStatusRow />
    </HostProjectionProvider>
  )
}

describe('HostStatusRow · rendered output', () => {
  it('reuses the existing Devices row markup so no new CSS is needed', () => {
    const markup = renderRow()
    expect(markup).toContain('sidebar-footer-device-row')
    expect(markup).toContain('sidebar-footer-led')
    expect(markup).toContain('sidebar-footer-device-name')
    expect(markup).toContain('sidebar-footer-device-status')
    expect(markup).toContain('TaskWraith Host')
  })

  it('shows Connected with a lit LED when Host answered', async () => {
    const store = new HostProjectionStore({ fetchSnapshot: async () => snapshot() })
    await store.refresh()

    const markup = renderRow(store)
    expect(markup).toContain('Connected')
    expect(markup).toContain('sidebar-footer-led is-on')
  })

  it('shows Unreachable with an unlit LED and never claims connection', async () => {
    const store = new HostProjectionStore({
      fetchSnapshot: async () => {
        throw new Error('host socket refused')
      }
    })
    await store.refresh()

    const markup = renderRow(store)
    expect(markup).toContain('Unreachable')
    expect(markup).not.toContain('sidebar-footer-led is-on')
    expect(markup).not.toContain('Connected')
  })

  it('shows Last known state after Host drops, distinct from Unreachable', async () => {
    let healthy = true
    const store = new HostProjectionStore({
      fetchSnapshot: async () => {
        if (!healthy) throw new Error('dropped')
        return snapshot()
      }
    })
    await store.refresh()
    healthy = false
    await store.refresh()

    const markup = renderRow(store)
    expect(markup).toContain('Last known state')
    expect(markup).not.toContain('Unreachable')
    expect(markup).not.toContain('sidebar-footer-led is-on')
  })

  it('reports Not checked when no provider is mounted', () => {
    const markup = renderToStaticMarkup(<HostStatusRow />)
    expect(markup).toContain('Not checked')
  })
})

/* ------------------------------------------------------------------ */
/*  Wave 4.3e — placement: Host must not live behind the iOS flag     */
/* ------------------------------------------------------------------ */

describe('HostStatusRow · placement is not gated by the iOS remote flag', () => {
  // These two are a PAIR and only mean something together. The first proves a
  // Host surface exists with iOS remote off; the second proves it is not ALSO
  // (or instead) hiding in the gated Devices chrome. Either alone could be
  // satisfied by a mistake.
  //
  // 4.3d's tests rendered HostStatusRow directly, so they could not fail when
  // the row became unreachable — that test gap was the real defect, not the
  // placement. These render the CONTAINING popovers instead.

  it('surfaces Host from an UNGATED popover while iOS remote is off', () => {
    const markup = renderToStaticMarkup(
      <ApprovalsFooterPopover pendingApprovals={[]} onOpenSettings={() => {}} />
    )
    expect(markup).toContain('TaskWraith Host')
  })

  it('does NOT hide Host inside the iOS-gated Devices popover', () => {
    const markup = renderToStaticMarkup(
      <DevicesFooterPopover devices={[]} onOpenSettings={() => {}} />
    )
    expect(markup).not.toContain('TaskWraith Host')
  })
})

/* ------------------------------------------------------------------ */
/*  Wave 5a — "unavailable is not zero" for the providers family      */
/* ------------------------------------------------------------------ */

const projectionWith = (
  freshness: 'live' | 'cached',
  providers: Array<{ available: boolean }>
): never => ({ freshness, providers }) as never

describe('describeHostProviders · unavailable is not zero, cached is not live', () => {
  it('reports a LIVE empty list as a real measured zero', () => {
    const view = describeHostProviders(
      state({ status: 'live', projection: projectionWith('live', []) })
    )
    // Host genuinely answered "none". That is knowledge, not the absence of it.
    expect(view.known).toBe(true)
    expect(view.total).toBe(0)
  })

  it('never reports zero providers when Host is UNREACHABLE', () => {
    const view = describeHostProviders(state({ status: 'unavailable' }))
    expect(view.known).toBe(false)
    expect(view.total).toBeUndefined()
    // A zero here would be fabricated telemetry: it reads as "there are no
    // providers", a different and false claim from "we do not know".
    expect(view.label).not.toContain('0')
  })

  it('never reports counts from a CACHED projection as if they were live', () => {
    const view = describeHostProviders(
      state({
        status: 'unavailable',
        projection: projectionWith('cached', [{ available: true }, { available: true }])
      })
    )
    expect(view.known).toBe(false)
    expect(view.available).toBeUndefined()
    expect(view.label).not.toContain('2')
  })

  it('treats a STALE projection as unknown even when the client is connected', () => {
    // The subtle one, and the reason a status check alone is not enough.
    // `projectHostSnapshot` forces `cached` when HOST itself says the
    // projection it served was cached, so status can be 'live' while the data
    // is stale. Counting it would present Host's own stale answer as current.
    const view = describeHostProviders(
      state({ status: 'live', projection: projectionWith('cached', [{ available: true }]) })
    )
    expect(view.known).toBe(false)
    expect(view.label).not.toContain('1')
  })

  it('counts available providers separately from total when live', () => {
    const view = describeHostProviders(
      state({
        status: 'live',
        projection: projectionWith('live', [
          { available: true },
          { available: false },
          { available: true }
        ])
      })
    )
    expect(view.known).toBe(true)
    expect(view.available).toBe(2)
    expect(view.total).toBe(3)
  })

  it('reports pre-fetch states as unknown rather than zero', () => {
    expect(describeHostProviders(state({ status: 'idle' })).known).toBe(false)
    expect(describeHostProviders(state({ status: 'loading' })).known).toBe(false)
  })
})

describe('HostStatusRow · Desktop actually reads providers from Host', () => {
  it('shows a live provider count in the row', async () => {
    const store = new HostProjectionStore({
      fetchSnapshot: async () =>
        snapshot({
          providers: [
            { providerId: 'claude', displayProvider: 'Claude', shortCode: 'CL', available: true },
            { providerId: 'codex', displayProvider: 'Codex', shortCode: 'CX', available: false }
          ]
        } as Partial<HostSnapshot>)
    })
    await store.refresh()

    const markup = renderRow(store)
    expect(markup).toContain('Host providers')
    // Wave 5e — wire `available` means admitted/configured, not runtime-healthy.
    // The leaf must say "configured"; "available" overstates once rows exist.
    expect(markup).toContain('1 of 2 configured')
    expect(markup).not.toContain('1 of 2 available')
  })

  it('renders providers as Unknown — never 0 — when Host is unreachable', async () => {
    const store = new HostProjectionStore({
      fetchSnapshot: async () => {
        throw new Error('host socket refused')
      }
    })
    await store.refresh()

    const markup = renderRow(store)
    expect(markup).toContain('Host providers')
    expect(markup).toContain('Unknown')
    expect(markup).not.toContain('0 of 0')
  })
})

/* ------------------------------------------------------------------ */
/*  Wave 5d — an empty family is TWO different facts                  */
/* ------------------------------------------------------------------ */

const projectionWithCodes = (
  providers: Array<{ available: boolean }>,
  warningCodes: string[]
): never => ({ freshness: 'live', providers, warningCodes }) as never

describe('describeHostProviders · not-ready is not a measured zero', () => {
  /* ---- RED PIN 2: the code turns a confident zero into an honest unknown ---- */
  it('renders Unknown — NOT "None reported" — when Host says the source is not ready', () => {
    const view = describeHostProviders(
      state({
        status: 'live',
        projection: projectionWithCodes([], [HOST_WARNING_PROVIDER_SOURCE_NOT_READY])
      })
    )
    // The snapshot is honestly live and honestly empty. The ONLY thing that
    // distinguishes "we measured none" from "the source has not answered yet"
    // is this code, so the leaf must consult it.
    expect(view.known).toBe(false)
    expect(view.label).toBe('Unknown')
    expect(view.total).toBeUndefined()
  })

  /* ---- RED PIN 3: THE REGRESSION GUARD ---- */
  it('still renders "None reported" for a genuine measured zero with NO code', () => {
    const view = describeHostProviders(
      state({ status: 'live', projection: projectionWithCodes([], []) })
    )
    // Without this the repair simply inverts the lie: every real empty answer
    // would start claiming to be unknown.
    expect(view.known).toBe(true)
    expect(view.total).toBe(0)
    expect(view.label).toBe('None reported')
  })

  it('ignores UNRELATED warning codes — only the provider code suppresses the count', () => {
    const view = describeHostProviders(
      state({ status: 'live', projection: projectionWithCodes([], ['projection_truncated']) })
    )
    expect(view.known).toBe(true)
    expect(view.label).toBe('None reported')
  })

  it('matches on code, never on message prose', () => {
    // A message mentioning readiness must NOT be enough. Only the typed code
    // counts — this is the `\bCONNECTED\b` bug class, pinned.
    const view = describeHostProviders(
      state({
        status: 'live',
        projection: {
          freshness: 'live',
          providers: [],
          warningCodes: [],
          warnings: [{ message: 'provider source is not ready' }]
        } as never
      })
    )
    expect(view.label).toBe('None reported')
  })

  it('reports rows normally when the source is ready and has admitted providers', () => {
    const view = describeHostProviders(
      state({
        status: 'live',
        projection: projectionWithCodes([{ available: true }, { available: false }], [])
      })
    )
    expect(view.known).toBe(true)
    expect(view.available).toBe(1)
    expect(view.total).toBe(2)
    expect(view.label).toBe('1 of 2 configured')
  })
})

describe('describeHostProviders · Wave 5e configured wording', () => {
  /* ---- RED PIN: today's bytes still say "available"; that overstates ---- */
  it('labels admitted rows as configured, never as available', () => {
    const view = describeHostProviders(
      state({
        status: 'live',
        projection: projectionWith('live', [
          { available: true },
          { available: false },
          { available: true }
        ])
      })
    )
    expect(view.known).toBe(true)
    expect(view.label).toBe('2 of 3 configured')
    expect(view.label).not.toMatch(/\bavailable\b/)
  })
})
