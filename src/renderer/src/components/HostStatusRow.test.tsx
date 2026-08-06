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
import { describe, expect, it } from 'vitest'

import { HostProjectionProvider } from './HostProjectionProvider'
import { HostStatusRow, describeHostConnection } from './HostStatusRow'
import { HostProjectionStore } from '../lib/host/HostProjectionStore'
import type { HostProjectionState } from '../lib/host/HostProjectionStore'
import type { HostSnapshot } from '../../../shared/hostProtocol'

function snapshot(): HostSnapshot {
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
    recovery: {}
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
