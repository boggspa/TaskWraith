import { describe, expect, it, vi } from 'vitest'
import {
  MainQuitProducerRegistry,
  MainQuitSessionRegistry,
  createMainQuitProducerBarrier
} from './MainQuitProducerRegistry'
import { createMainRunEventProducerQuiescence } from './MainRunEventProducerQuiescence'
import { createMainQuitDurabilityIntegration } from './MainQuitDurabilityIntegration'

describe('main quit producer registry integration', () => {
  it('retains an unresolved session after terminalization until a real callback joins', async () => {
    const registry = new MainQuitSessionRegistry()
    let active = true
    let callback: Promise<void> | undefined
    const session = {}
    const producer = registry.capture(session, 'untracked', 'main', async () => {
      active = false
      if (!callback) return false
      await callback
      return true
    })
    const barrier = createMainQuitProducerBarrier({
      fenceAdmissions: async () => {},
      fenceQueue: () => {},
      fenceNative: () => {},
      joinNative: async () => {},
      operations: () => [],
      joinOperation: async () => true,
      sessions: () => [...new Set([...(active ? [producer] : []), ...registry.pending()])]
    })
    await expect(barrier.quiesce()).rejects.toThrow()
    expect(active).toBe(false)
    await expect(barrier.quiesce()).rejects.toThrow()
    callback = Promise.resolve()
    await expect(barrier.quiesce()).resolves.toBeUndefined()
    expect(registry.pending()).toEqual([])
  })

  it('retries rejected native joins while retaining admission fences', async () => {
    const joinNative = vi
      .fn()
      .mockRejectedValueOnce(new Error('first join'))
      .mockResolvedValueOnce(undefined)
    const fenceNative = vi.fn()
    const barrier = createMainQuitProducerBarrier({
      fenceAdmissions: async () => {},
      fenceQueue: () => {},
      fenceNative,
      joinNative,
      operations: () => [],
      joinOperation: async () => true
    })
    await expect(barrier.quiesce()).rejects.toThrow()
    await expect(barrier.quiesce()).resolves.toBeUndefined()
    expect(fenceNative).toHaveBeenCalledOnce()
    expect(joinNative).toHaveBeenCalledTimes(2)
  })

  it('joins active main sessions without tracked operations and rejects unknown ownership', async () => {
    const registry = new MainQuitSessionRegistry()
    const session = {}
    const join = vi.fn(async () => true)
    let ownership: 'main' | 'unknown' | 'independent-host' = 'unknown'
    const barrier = createMainQuitProducerBarrier({
      fenceAdmissions: async () => {},
      fenceQueue: () => {},
      fenceNative: () => {},
      joinNative: async () => {},
      operations: () => [],
      joinOperation: async () => true,
      sessions: () => [registry.capture(session, 'active-untracked', ownership, join)]
    })
    await expect(barrier.quiesce()).rejects.toThrow()
    expect(join).not.toHaveBeenCalled()
    ownership = 'main'
    await barrier.quiesce()
    expect(join).toHaveBeenCalledOnce()
    ownership = 'independent-host'
    await barrier.quiesce()
    expect(join).toHaveBeenCalledOnce()
  })

  it('keeps stable operation identity and distinguishes replacement generations', () => {
    const registry = new MainQuitProducerRegistry()
    const first = Promise.resolve()
    const join = async () => true
    expect(registry.capture('run', first, join)).toBe(registry.capture('run', first, join))
    expect(registry.capture('run', Promise.resolve(), join)).not.toBe(
      registry.capture('run', first, join)
    )
  })

  it('holds persistence for transport and its late audit while leaving independent Host work alone', async () => {
    const registry = new MainQuitProducerRegistry()
    let release!: () => void
    const transport = new Promise<void>((resolve) => {
      release = resolve
    })
    let auditRelease!: () => void
    const audit = new Promise<void>((resolve) => {
      auditRelease = resolve
    })
    const producers = [
      registry.capture('transport', transport, async () => {
        await transport
        producers.push(
          registry.capture('audit', audit, async () => {
            await audit
            return true
          })
        )
        return true
      })
    ]
    const hostJoin = vi.fn(async () => false)
    const independentHost = {
      id: 'node-host',
      ownership: 'independent-host' as const,
      join: hostJoin
    }
    const fences: string[] = []
    const quiescence = createMainRunEventProducerQuiescence({
      fenceAdmissions: () => {
        fences.push('admissions')
      },
      fenceQueueDispatch: () => {
        fences.push('queue')
      },
      fenceNativeActions: () => {
        fences.push('native')
      },
      snapshot: () => [...producers, independentHost]
    })
    const shutdown = vi.fn(async () => {})
    const integration = createMainQuitDurabilityIntegration({
      quiesceProducers: () => quiescence.quiesce(),
      saveFinalState: async () => {},
      shutdownDurability: shutdown
    })
    const pending = integration.flush()
    expect(fences).toEqual(['admissions', 'queue', 'native'])
    expect(shutdown).not.toHaveBeenCalled()
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(shutdown).not.toHaveBeenCalled()
    integration.abandon()
    auditRelease()
    await expect(pending).rejects.toThrow('abandoned')
    expect(hostJoin).not.toHaveBeenCalled()
    expect(shutdown).not.toHaveBeenCalled()
  })
})
