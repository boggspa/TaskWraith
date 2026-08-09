/**
 * Wave 4.3a-adapter — renderer IPC transport tests.
 *
 * The load-bearing pin is the honesty hinge: every failure path must REJECT.
 * A resolved empty snapshot would be published by the store as LIVE and render
 * as an empty world, which is a fabricated claim rather than an honest
 * "Host unreachable". Each failure mode therefore has its own test, and the
 * end-to-end test drives the real store to prove the chain actually holds.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  HOST_PROJECTION_VERSION,
  HOST_PROTOCOL_VERSION,
  type HostSnapshot
} from '../../../../shared/hostProtocol'
import { HostProjectionStore } from './HostProjectionStore'
import {
  HOST_PROJECTION_BRIDGE_MALFORMED,
  HOST_PROJECTION_BRIDGE_UNAVAILABLE,
  createHostProjectionIpcTransport,
  type HostProjectionSnapshotBridge
} from './hostProjectionIpcTransport'

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

function bridgeOf(impl: () => Promise<unknown>): HostProjectionSnapshotBridge {
  return { hostProjectionSnapshot: impl } as unknown as HostProjectionSnapshotBridge
}

/* ------------------------------------------------------------------ */
/*  Success                                                           */
/* ------------------------------------------------------------------ */

describe('createHostProjectionIpcTransport · success', () => {
  it('returns the snapshot the bridge served', async () => {
    const snap = snapshot()
    const transport = createHostProjectionIpcTransport(
      bridgeOf(async () => ({ ok: true, snapshot: snap }))
    )

    await expect(transport.fetchSnapshot()).resolves.toBe(snap)
  })

  it('calls the bridge once per fetch', async () => {
    const hostProjectionSnapshot = vi.fn(async () => ({ ok: true, snapshot: snapshot() }))
    const transport = createHostProjectionIpcTransport({
      hostProjectionSnapshot
    } as unknown as HostProjectionSnapshotBridge)

    await transport.fetchSnapshot()
    await transport.fetchSnapshot()

    expect(hostProjectionSnapshot).toHaveBeenCalledTimes(2)
  })
})

/* ------------------------------------------------------------------ */
/*  Every failure REJECTS — never a resolved empty snapshot           */
/* ------------------------------------------------------------------ */

describe('createHostProjectionIpcTransport · failures reject', () => {
  it('rejects with the Host error when the bridge reports ok:false', async () => {
    const transport = createHostProjectionIpcTransport(
      bridgeOf(async () => ({ ok: false, error: 'host socket refused' }))
    )

    await expect(transport.fetchSnapshot()).rejects.toThrow('host socket refused')
  })

  it('rejects when the preload conduit is absent', async () => {
    const transport = createHostProjectionIpcTransport(null)
    await expect(transport.fetchSnapshot()).rejects.toThrow(HOST_PROJECTION_BRIDGE_UNAVAILABLE)
  })

  it('rejects a malformed result rather than guessing', async () => {
    const transport = createHostProjectionIpcTransport(bridgeOf(async () => ({ weird: true })))
    await expect(transport.fetchSnapshot()).rejects.toThrow(HOST_PROJECTION_BRIDGE_MALFORMED)
  })

  it('rejects ok:true with no snapshot — a broken contract is not an empty world', async () => {
    const transport = createHostProjectionIpcTransport(bridgeOf(async () => ({ ok: true })))
    await expect(transport.fetchSnapshot()).rejects.toThrow(HOST_PROJECTION_BRIDGE_MALFORMED)
  })

  it('rejects an ok:false with an empty error string, still without fabricating', async () => {
    const transport = createHostProjectionIpcTransport(
      bridgeOf(async () => ({ ok: false, error: '' }))
    )
    await expect(transport.fetchSnapshot()).rejects.toThrow(HOST_PROJECTION_BRIDGE_MALFORMED)
  })

  it('propagates a thrown bridge error', async () => {
    const transport = createHostProjectionIpcTransport(
      bridgeOf(async () => {
        throw new Error('ipc channel closed')
      })
    )
    await expect(transport.fetchSnapshot()).rejects.toThrow('ipc channel closed')
  })
})

/* ------------------------------------------------------------------ */
/*  Late bridge installation                                          */
/* ------------------------------------------------------------------ */

describe('createHostProjectionIpcTransport · bridge resolution', () => {
  it('re-reads the bridge each call so a late preload still works', async () => {
    // A store may be constructed by a module that loaded before preload
    // installed `window.api`. Pinning a null bridge at construction would
    // strand the app offline for its whole lifetime.
    let installed = false
    const holder = {
      get hostProjectionSnapshot() {
        if (!installed) return undefined
        return async () => ({ ok: true, snapshot: snapshot() })
      }
    }
    const transport = createHostProjectionIpcTransport(
      holder as unknown as HostProjectionSnapshotBridge
    )

    installed = true
    await expect(transport.fetchSnapshot()).resolves.toBeDefined()
  })
})

/* ------------------------------------------------------------------ */
/*  End-to-end honesty through the real store                         */
/* ------------------------------------------------------------------ */

describe('adapter + HostProjectionStore · the honesty chain holds', () => {
  it('turns an unreachable Host into unavailable, NOT an empty live world', async () => {
    const store = new HostProjectionStore(
      createHostProjectionIpcTransport(bridgeOf(async () => ({ ok: false, error: 'host down' })))
    )

    const state = await store.refresh()

    expect(state.status).toBe('unavailable')
    expect(state.unavailableReason).toBe('host down')
    // The claim that matters: no projection at all, rather than a projection
    // asserting zero workspaces and zero threads.
    expect(state.projection).toBeUndefined()
  })

  it('publishes a live projection when Host answers', async () => {
    const store = new HostProjectionStore(
      createHostProjectionIpcTransport(bridgeOf(async () => ({ ok: true, snapshot: snapshot() })))
    )

    const state = await store.refresh()

    expect(state.status).toBe('live')
    expect(state.projection?.freshness).toBe('live')
    expect(state.lastCursor).toBe(42)
  })

  it('re-labels a retained projection cached when Host later drops', async () => {
    let healthy = true
    const store = new HostProjectionStore(
      createHostProjectionIpcTransport(
        bridgeOf(async () =>
          healthy ? { ok: true, snapshot: snapshot() } : { ok: false, error: 'dropped' }
        )
      )
    )

    await store.refresh()
    expect(store.getState().projection?.freshness).toBe('live')

    healthy = false
    const state = await store.refresh()

    expect(state.status).toBe('unavailable')
    expect(state.projection?.freshness).toBe('cached')
  })
})
