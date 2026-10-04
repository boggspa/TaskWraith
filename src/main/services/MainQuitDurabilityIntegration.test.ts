import { describe, expect, it, vi } from 'vitest'
import { createMainQuitDurabilityIntegration } from './MainQuitDurabilityIntegration'

describe('main quit durability integration', () => {
  it('joins final producers before saving and retiring durability', async () => {
    const order: string[] = []
    const integration = createMainQuitDurabilityIntegration({
      quiesceProducers: async () => {
        order.push('join')
      },
      saveFinalState: async () => {
        order.push('save')
      },
      shutdownDurability: async () => {
        order.push('shutdown')
      }
    })
    const first = integration.flush()
    expect(integration.flush()).toBe(first)
    await first
    expect(order).toEqual(['join', 'save', 'shutdown'])
  })

  it.each(['join', 'save'])('does not retire after a failed %s barrier', async (stage) => {
    const shutdown = vi.fn(async () => {})
    const integration = createMainQuitDurabilityIntegration({
      quiesceProducers: async () => {
        if (stage === 'join') throw new Error(stage)
      },
      saveFinalState: async () => {
        if (stage === 'save') throw new Error(stage)
      },
      shutdownDurability: shutdown
    })
    await expect(integration.flush()).rejects.toThrow(stage)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('still writes the final save when a producer cannot be joined, and does not retire', async () => {
    const order: string[] = []
    const integration = createMainQuitDurabilityIntegration({
      quiesceProducers: async () => {
        order.push('join')
        throw new Error('Producer did not join: run-1')
      },
      saveFinalState: async () => {
        order.push('save')
      },
      shutdownDurability: async () => {
        order.push('shutdown')
      }
    })
    await expect(integration.flush()).rejects.toThrow('Producer did not join: run-1')
    expect(order).toEqual(['join', 'save'])
  })

  it('reports both failures when the join and the final save fail', async () => {
    const shutdown = vi.fn(async () => {})
    const integration = createMainQuitDurabilityIntegration({
      quiesceProducers: async () => {
        throw new Error('join failed')
      },
      saveFinalState: async () => {
        throw new Error('save failed')
      },
      shutdownDurability: shutdown
    })
    const failure = await integration.flush().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      'join failed',
      'save failed'
    ])
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('does not start the final save once the fallback teardown has taken over', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const save = vi.fn(async () => {})
    const integration = createMainQuitDurabilityIntegration({
      quiesceProducers: async () => {
        await blocked
        throw new Error('join failed late')
      },
      saveFinalState: save,
      shutdownDurability: async () => {}
    })
    const flush = integration.flush()
    await Promise.resolve()
    integration.abandon()
    release()
    await expect(flush).rejects.toThrow('abandoned')
    expect(save).not.toHaveBeenCalled()
  })

  it.each(['join', 'save'])('prevents late retirement after fallback during %s', async (stage) => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const shutdown = vi.fn(async () => {})
    const integration = createMainQuitDurabilityIntegration({
      quiesceProducers: () => (stage === 'join' ? blocked : Promise.resolve()),
      saveFinalState: () => (stage === 'save' ? blocked : Promise.resolve()),
      shutdownDurability: shutdown
    })
    const flush = integration.flush()
    await Promise.resolve()
    integration.abandon()
    release()
    await expect(flush).rejects.toThrow('abandoned')
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('propagates retirement failure without claiming completion', async () => {
    const integration = createMainQuitDurabilityIntegration({
      quiesceProducers: async () => {},
      saveFinalState: async () => {},
      shutdownDurability: async () => {
        throw new Error('retirement failed')
      }
    })
    await expect(integration.flush()).rejects.toThrow('retirement failed')
  })
})
