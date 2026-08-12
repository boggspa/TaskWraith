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
  type HostDeltaEnvelope,
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
    recovery: { reopenStatus: 'unknown' },
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
    expect(state.liveBaselineContinuity).toBe(true)
    expect(state.projection?.threads).toHaveLength(1)
    expect(state.lastCursor).toBe(42)
    expect(state.lastGeneration).toBe(3)
  })

  it('exposes a defensive wire-snapshot clone for command correlation', async () => {
    const store = new HostProjectionStore(transportOf(async () => snapshot()))
    await store.refresh()

    const first = store.getSourceSnapshot()
    expect(first?.threads[0]?.id).toBe('t1')
    first?.threads.splice(0)

    expect(store.getSourceSnapshot()?.threads[0]?.id).toBe('t1')
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

  it('does not establish live-baseline continuity from a Host-served cache', async () => {
    const store = new HostProjectionStore(
      transportOf(async () => snapshot({ freshness: 'cached' }))
    )

    const state = await store.refresh()

    expect(state.status).toBe('live')
    expect(state.projection?.freshness).toBe('cached')
    expect(state.liveBaselineContinuity).toBe(false)
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

describe('HostProjectionStore · delta continuity', () => {
  function threadDelta(overrides: Partial<HostDeltaEnvelope> = {}): HostDeltaEnvelope {
    return {
      protocolVersion: HOST_PROTOCOL_VERSION,
      projectionVersion: HOST_PROJECTION_VERSION,
      generation: 3,
      cursor: 43,
      previousCursor: 42,
      kind: 'upsert',
      family: 'thread',
      entityId: 't2',
      payload: {
        id: 't2',
        workspaceId: 'w1',
        title: 'Two',
        chatKind: 'single',
        archived: false,
        pinned: false,
        updatedAt: 2,
        messageCount: 1
      },
      at: '2026-08-06T12:00:01.000Z',
      ...overrides
    }
  }

  it('atomically applies ordered deltas and advances the retained position', async () => {
    const store = new HostProjectionStore({
      fetchSnapshot: async () => snapshot(),
      fetchDeltas: async () => ({
        kind: 'deltas',
        generation: 3,
        fromCursor: 42,
        toCursor: 43,
        deltas: [threadDelta()]
      })
    })
    await store.refresh()

    const state = await store.catchUp()

    expect(state.status).toBe('live')
    expect(state.lastCursor).toBe(43)
    expect(state.projection?.threads.map((thread) => thread.id)).toEqual(['t1', 't2'])
    // Delta-applied client caches are coherent but never promoted to live.
    expect(state.projection?.freshness).toBe('cached')
    expect(state.liveBaselineContinuity).toBe(true)
  })

  it('falls back to a full snapshot on a retention/generation fence', async () => {
    const fetchSnapshot = vi
      .fn<() => Promise<HostSnapshot>>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ generation: 4, cursor: 2 }))
    const store = new HostProjectionStore({
      fetchSnapshot,
      fetchDeltas: async () => ({
        kind: 'full_resnapshot_required',
        reason: 'generation_reset',
        generation: 4,
        cursor: 2,
        clientGeneration: 3,
        clientCursor: 42
      })
    })
    await store.refresh()

    const state = await store.catchUp()

    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
    expect(state.status).toBe('live')
    expect(state.lastGeneration).toBe(4)
    expect(state.lastCursor).toBe(2)
    expect(state.projection?.freshness).toBe('live')
  })

  it('rejects an out-of-order batch without publishing a partial cache', async () => {
    const fetchSnapshot = vi
      .fn<() => Promise<HostSnapshot>>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ cursor: 50 }))
    const store = new HostProjectionStore({
      fetchSnapshot,
      fetchDeltas: async () => ({
        kind: 'deltas',
        generation: 3,
        fromCursor: 42,
        toCursor: 45,
        deltas: [threadDelta({ cursor: 45, previousCursor: 42 })]
      })
    })
    await store.refresh()

    const state = await store.catchUp()

    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
    expect(state.lastCursor).toBe(50)
    expect(state.projection?.threads.map((thread) => thread.id)).toEqual(['t1'])
    expect(state.projection?.freshness).toBe('live')
  })

  it('runs one bounded loop: deltas frequently, full snapshots periodically', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-06T12:00:00.000Z'))
    try {
      const fetchSnapshot = vi.fn(async () => snapshot())
      const fetchDeltas = vi.fn(async () => ({
        kind: 'deltas' as const,
        generation: 3,
        fromCursor: 42,
        toCursor: 42,
        deltas: []
      }))
      const store = new HostProjectionStore({ fetchSnapshot, fetchDeltas })
      await store.refresh()
      const stop = store.startSync({ deltaPollMs: 10, fullRefreshMs: 25 })

      await vi.advanceTimersByTimeAsync(35)
      expect(fetchDeltas).toHaveBeenCalledTimes(2)
      expect(fetchSnapshot).toHaveBeenCalledTimes(2)

      stop()
      await vi.advanceTimersByTimeAsync(50)
      expect(fetchDeltas).toHaveBeenCalledTimes(2)
      expect(fetchSnapshot).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
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
