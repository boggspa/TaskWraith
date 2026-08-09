/**
 * Wave 4.3a — Desktop Host projection store tests.
 *
 * The load-bearing pins here are the ones that protect a USER from being
 * misled when Host is unreachable: the cache must survive, it must be
 * re-labelled cached, and an empty workspace must never be fabricated.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  HOST_PROJECTION_VERSION,
  HOST_PROTOCOL_VERSION,
  type HostSnapshot
} from '../../../../shared/hostProtocol'
import { HostProjectionStore, type HostProjectionTransport } from './HostProjectionStore'

function snapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
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
        title: 'One',
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
    recovery: {},
    ...overrides
  } as unknown as HostSnapshot
}

function transportOf(impl: () => Promise<HostSnapshot>): HostProjectionTransport {
  return { fetchSnapshot: impl }
}

describe('HostProjectionStore · construction', () => {
  it('requires a transport', () => {
    expect(() => new HostProjectionStore(undefined as never)).toThrow(/fetchSnapshot/)
    expect(() => new HostProjectionStore({} as never)).toThrow(/fetchSnapshot/)
  })

  it('starts idle and holds no fabricated projection', () => {
    const store = new HostProjectionStore(transportOf(async () => snapshot()))
    expect(store.getState().status).toBe('idle')
    expect(store.getState().projection).toBeUndefined()
  })
})

describe('HostProjectionStore · live fetch', () => {
  it('exposes a live projection and retains cursor/generation', async () => {
    const store = new HostProjectionStore(transportOf(async () => snapshot()))
    const state = await store.refresh()

    expect(state.status).toBe('live')
    expect(state.projection?.freshness).toBe('live')
    expect(state.projection?.threads).toHaveLength(1)
    expect(state.lastCursor).toBe(42)
    expect(state.lastGeneration).toBe(3)
  })

  it('notifies subscribers and stops after unsubscribe', async () => {
    const store = new HostProjectionStore(transportOf(async () => snapshot()))
    const seen: string[] = []
    const unsubscribe = store.subscribe((s) => seen.push(s.status))

    await store.refresh()
    expect(seen).toContain('loading')
    expect(seen).toContain('live')

    unsubscribe()
    const before = seen.length
    await store.refresh()
    expect(seen).toHaveLength(before)
  })
})

describe('HostProjectionStore · Host unreachable', () => {
  it('reports unavailable with an honest reason', async () => {
    const store = new HostProjectionStore(
      transportOf(async () => {
        throw new Error('host socket refused')
      })
    )
    const state = await store.refresh()

    expect(state.status).toBe('unavailable')
    expect(state.unavailableReason).toBe('host socket refused')
  })

  it('NEVER fabricates an empty workspace when it has never reached Host', async () => {
    // An empty projection here would assert "there are no chats", which is a
    // false claim rather than a neutral default.
    const store = new HostProjectionStore(
      transportOf(async () => {
        throw new Error('down')
      })
    )
    const state = await store.refresh()

    expect(state.projection).toBeUndefined()
    expect(state.status).toBe('unavailable')
  })

  it('keeps the last projection but RE-LABELS it cached', async () => {
    let fail = false
    const store = new HostProjectionStore(
      transportOf(async () => {
        if (fail) throw new Error('dropped')
        return snapshot()
      })
    )

    await store.refresh()
    expect(store.getState().projection?.freshness).toBe('live')

    fail = true
    const state = await store.refresh()

    expect(state.status).toBe('unavailable')
    // Cache survives for presentation...
    expect(state.projection?.threads).toHaveLength(1)
    // ...but can never still claim to be live.
    expect(state.projection?.freshness).toBe('cached')
    // Cursor survives so a later delta slice can resume.
    expect(state.lastCursor).toBe(42)
  })

  it('recovers to live on a later successful fetch', async () => {
    let fail = true
    const store = new HostProjectionStore(
      transportOf(async () => {
        if (fail) throw new Error('down')
        return snapshot()
      })
    )

    await store.refresh()
    expect(store.getState().status).toBe('unavailable')

    fail = false
    const state = await store.refresh()
    expect(state.status).toBe('live')
    expect(state.projection?.freshness).toBe('live')
    expect(state.unavailableReason).toBeUndefined()
  })
})

describe('HostProjectionStore · concurrent refresh', () => {
  it('shares one in-flight request instead of racing', async () => {
    const fetchSnapshot = vi.fn(async () => snapshot())
    const store = new HostProjectionStore({ fetchSnapshot })

    const [a, b] = await Promise.all([store.refresh(), store.refresh()])

    // Two overlapping fetches could otherwise resolve out of order and install
    // an OLDER snapshot over a newer one, rolling the UI silently backwards.
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)
    expect(a.status).toBe('live')
    expect(b.status).toBe('live')
  })

  it('allows a fresh request after the in-flight one settles', async () => {
    const fetchSnapshot = vi.fn(async () => snapshot())
    const store = new HostProjectionStore({ fetchSnapshot })

    await store.refresh()
    await store.refresh()

    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
  })
})

describe('HostProjectionStore · renderer restart continuity (design pin)', () => {
  it('a fresh store re-reaches Host without any local reconstruction', async () => {
    // A renderer reload destroys the store; it does not touch Host, where the
    // mission actually lives. Recovery must be a plain re-fetch.
    //
    // HONEST LIMIT: this proves the CLIENT path only. It does not evidence
    // mission continuity against a live Host — the production Host has never
    // been observed running.
    const fetchSnapshot = vi.fn(async () => snapshot({ cursor: 99 }))

    const first = new HostProjectionStore({ fetchSnapshot })
    await first.refresh()
    expect(first.getState().lastCursor).toBe(99)

    const afterReload = new HostProjectionStore({ fetchSnapshot })
    expect(afterReload.getState().status).toBe('idle')

    const state = await afterReload.refresh()
    expect(state.status).toBe('live')
    expect(state.lastCursor).toBe(99)
  })
})
