/**
 * Wave 4.3c — Desktop Host projection provider tests.
 *
 * NO DOM IS AVAILABLE. This repo installs no jsdom, happy-dom or
 * testing-library, so renderer components are tested with
 * `renderToStaticMarkup` from `react-dom/server` — the same pattern
 * `Sidebar.test.tsx` established. That renders React for real; it simply does
 * not run effects, which is why every test below seeds the store's state
 * BEFORE rendering rather than relying on the mount refresh.
 *
 * The load-bearing test is the last one: an unreachable Host must reach the UI
 * as UNAVAILABLE, never as an empty world.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  HOST_PROJECTION_VERSION,
  HOST_PROTOCOL_VERSION,
  type HostSnapshot
} from '../../../shared/hostProtocol'
import { useHostProjection } from '../hooks/useHostProjection'
import { HostProjectionStore } from '../lib/host/HostProjectionStore'
import { HostCommandController } from '../lib/host/HostCommandController'
import {
  HostProjectionProvider,
  useHostCommandController,
  useHostProjectionStore
} from './HostProjectionProvider'

function snapshot(): HostSnapshot {
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
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
    workspaces: [{ id: 'w1', name: 'AGBench', path: '/tmp/x', pinned: false, updatedAt: 1 }],
    threads: [
      {
        id: 't1',
        workspaceId: 'w1',
        title: 'Thread one',
        chatKind: 'single',
        archived: false,
        pinned: false,
        updatedAt: 1,
        messageCount: 2
      }
    ],
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

function storeThatFails(reason: string): HostProjectionStore {
  return new HostProjectionStore({
    fetchSnapshot: async () => {
      throw new Error(reason)
    }
  })
}

function storeThatWorks(): HostProjectionStore {
  return new HostProjectionStore({ fetchSnapshot: async () => snapshot() })
}

/**
 * A consumer that reports what the UI would actually be able to say.
 *
 * It renders workspace names only when a projection genuinely exists, which is
 * what makes the "empty world" failure observable in markup.
 */
function Probe() {
  const store = useHostProjectionStore()
  const commands = useHostCommandController()
  const state = useHostProjection(store, false)

  return (
    <div>
      <span id="status">{state.status}</span>
      <span id="freshness">{state.projection?.freshness ?? 'none'}</span>
      <span id="commands">{commands ? 'available' : 'none'}</span>
      <span id="workspaces">
        {state.projection
          ? state.projection.workspaces.map((w) => w.name).join(',')
          : 'no-projection'}
      </span>
    </div>
  )
}

function renderWith(store?: HostProjectionStore): string {
  return renderToStaticMarkup(
    <HostProjectionProvider {...(store ? { store } : {})}>
      <Probe />
    </HostProjectionProvider>
  )
}

/* ------------------------------------------------------------------ */
/*  Wiring                                                            */
/* ------------------------------------------------------------------ */

describe('HostProjectionProvider · wiring', () => {
  it('renders its children', () => {
    const markup = renderWith(storeThatWorks())
    expect(markup).toContain('<span id="status">')
  })

  it('delivers a store to descendants, so the hook is not left idle-by-default', () => {
    const store = storeThatWorks()
    const markup = renderWith(store)
    // Provider present + store present => 'idle' before any fetch, NOT the
    // null-context path. The distinction matters: null context is a wiring
    // bug, idle is an honest pre-fetch state.
    expect(markup).toContain('<span id="status">idle</span>')
    expect(markup).toContain('<span id="commands">available</span>')
  })

  it('delivers an injected governed-command controller to descendants', () => {
    const commandController = new HostCommandController({
      client: {
        submitAndResolve: vi.fn(),
        decideApproval: vi.fn()
      }
    })
    const markup = renderToStaticMarkup(
      <HostProjectionProvider store={storeThatWorks()} commandController={commandController}>
        <Probe />
      </HostProjectionProvider>
    )
    expect(markup).toContain('<span id="commands">available</span>')
  })

  it('builds the real chain when no store is injected', () => {
    // No injection: the provider constructs HostProjectionStore over the real
    // IPC transport. Rendering proves construction did not throw with no
    // window.api present — the transport resolves its bridge lazily.
    expect(() =>
      renderToStaticMarkup(
        <HostProjectionProvider>
          <Probe />
        </HostProjectionProvider>
      )
    ).not.toThrow()
  })

  it('reports no provider distinctly from an unreachable Host', () => {
    // Rendered WITHOUT the provider: the hook sees a null store.
    const markup = renderToStaticMarkup(<Probe />)
    expect(markup).toContain('<span id="status">idle</span>')
    expect(markup).toContain('no-projection')
  })
})

/* ------------------------------------------------------------------ */
/*  The honesty pin                                                   */
/* ------------------------------------------------------------------ */

describe('HostProjectionProvider · an unreachable Host is never rendered as an empty world', () => {
  it('renders unavailable, and renders NO workspaces rather than zero workspaces', async () => {
    const store = storeThatFails('host socket refused')
    await store.refresh()

    const markup = renderWith(store)

    // What the user is told: we could not reach Host.
    expect(markup).toContain('<span id="status">unavailable</span>')
    // What the user is NOT told: that the workspace list is empty. There is no
    // projection at all, so the UI cannot claim an empty world.
    expect(markup).toContain('no-projection')
    expect(markup).not.toContain('<span id="status">live</span>')
  })

  it('renders a retained projection as CACHED after Host drops, never as live', async () => {
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

    const markup = renderWith(store)

    expect(markup).toContain('<span id="status">unavailable</span>')
    // The cache is still shown — useful — but explicitly labelled stale.
    expect(markup).toContain('<span id="freshness">cached</span>')
    expect(markup).toContain('AGBench')
    expect(markup).not.toContain('<span id="freshness">live</span>')
  })

  it('renders live Host state when Host answers', async () => {
    const store = storeThatWorks()
    await store.refresh()

    const markup = renderWith(store)

    expect(markup).toContain('<span id="status">live</span>')
    expect(markup).toContain('<span id="freshness">live</span>')
    expect(markup).toContain('AGBench')
  })
})
