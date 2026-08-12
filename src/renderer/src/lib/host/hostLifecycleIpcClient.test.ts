import { describe, expect, it, vi } from 'vitest'

import type {
  HostLifecycleActionResult,
  HostLifecycleSnapshot,
  HostLifecycleStatusResult
} from '../../../../shared/hostLifecycle'
import { HostLifecycleIpcClient, type HostLifecycleBridge } from './hostLifecycleIpcClient'

function snapshot(overrides: Partial<HostLifecycleSnapshot> = {}): HostLifecycleSnapshot {
  return {
    revision: 2,
    phase: 'running',
    desired: 'running',
    reason: 'user-start',
    changedAt: '2026-08-12T12:00:00.000Z',
    ...overrides
  }
}

function bridge(overrides: Partial<HostLifecycleBridge> = {}): HostLifecycleBridge {
  return {
    hostLifecycleStatus: vi.fn(
      async (): Promise<HostLifecycleStatusResult> => ({ ok: true, snapshot: snapshot() })
    ),
    hostLifecycleSet: vi.fn(
      async (): Promise<HostLifecycleActionResult> => ({ ok: true, snapshot: snapshot() })
    ),
    onHostLifecycleChanged: vi.fn(() => () => undefined),
    ...overrides
  }
}

describe('HostLifecycleIpcClient', () => {
  it('returns a detached validated status snapshot', async () => {
    const source = snapshot()
    const client = new HostLifecycleIpcClient(
      bridge({
        hostLifecycleStatus: vi.fn(
          async (): Promise<HostLifecycleStatusResult> => ({ ok: true, snapshot: source })
        )
      })
    )

    const result = await client.status()
    expect(result).toEqual(source)
    expect(result).not.toBe(source)
  })

  it('surfaces a denied status and rejects malformed responses', async () => {
    const denied = new HostLifecycleIpcClient(
      bridge({
        hostLifecycleStatus: vi.fn(
          async (): Promise<HostLifecycleStatusResult> => ({ ok: false, error: 'main only' })
        )
      })
    )
    await expect(denied.status()).rejects.toThrow('main only')

    const malformed = new HostLifecycleIpcClient(
      bridge({ hostLifecycleStatus: vi.fn(async () => ({ ok: true }) as never) })
    )
    await expect(malformed.status()).rejects.toThrow(/malformed/)
  })

  it('sends only the requested action and preserves controller failures as values', async () => {
    const hostLifecycleSet = vi.fn(
      async (): Promise<HostLifecycleActionResult> => ({
        ok: false,
        error: 'socket bind failed',
        snapshot: snapshot({ phase: 'failed', reason: 'start-failed', error: 'socket bind failed' })
      })
    )
    const client = new HostLifecycleIpcClient(bridge({ hostLifecycleSet }))

    await expect(client.set('start')).resolves.toMatchObject({
      ok: false,
      error: 'socket bind failed',
      snapshot: { phase: 'failed' }
    })
    expect(hostLifecycleSet).toHaveBeenCalledWith({ action: 'start' })
  })

  it('validates lifecycle events and returns the bridge unsubscribe', () => {
    let emit: ((value: HostLifecycleSnapshot) => void) | undefined
    const unsubscribe = vi.fn()
    const client = new HostLifecycleIpcClient(
      bridge({
        onHostLifecycleChanged: vi.fn((listener) => {
          emit = listener
          return unsubscribe
        })
      })
    )
    const listener = vi.fn()
    const dispose = client.subscribe(listener)

    emit?.(snapshot({ revision: 3 }))
    emit?.({ ...snapshot(), phase: 'daemonized' } as never)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ revision: 3 }))
    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('is safe to construct during server rendering without a window bridge', async () => {
    const client = new HostLifecycleIpcClient()
    expect(() => client.subscribe(() => undefined)).not.toThrow()
    await expect(client.status()).rejects.toThrow(/outside TaskWraith Desktop|unavailable/)
  })
})
