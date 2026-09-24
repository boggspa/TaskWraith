/**
 * Durability-barrier policy for the Host-routed chat persistence path.
 *
 * Pins the contract the barrier now guarantees at trust/dispatch edges:
 * the journal delta for the current revision is fsynced before the barrier
 * resolves, the staged checkpoint is only materialized when a fresh artifact
 * does not already cover it (never a duplicate full-record serialization),
 * and in-flight work drains through the compatibility coordinator barrier
 * with its error-surfacing semantics intact.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  createHostMaterializationBarrier,
  type HostMaterializationBarrierDeps
} from './hostMaterializationBarrier'

function harness() {
  const order: string[] = []
  const awaitJournalDurability = vi.fn(async (chatId: string) => {
    order.push(`journal:${chatId}`)
  })
  const materialize = vi.fn((chatId: string) => {
    order.push(`materialize:${chatId}`)
    return true
  })
  const barrier = vi.fn(async (chatId: string) => {
    order.push(`barrier:${chatId}`)
  })
  const clearUnconfirmed = vi.fn()
  const hasUnconfirmed = vi.fn(() => false)
  const hasSubmitted = vi.fn(() => false)
  const deps: HostMaterializationBarrierDeps = {
    awaitJournalDurability,
    compatibility: {
      hasUnconfirmed,
      hasSubmitted,
      barrier
    },
    materialize,
    clearUnconfirmed
  }
  return {
    deps,
    order,
    awaitJournalDurability,
    materialize,
    barrier,
    clearUnconfirmed,
    hasUnconfirmed,
    hasSubmitted
  }
}

describe('createHostMaterializationBarrier', () => {
  it('rejects a construction without its journal, materialization and drain ports', () => {
    expect(() => createHostMaterializationBarrier({} as never)).toThrow(TypeError)
    expect(() =>
      createHostMaterializationBarrier({
        awaitJournalDurability: async () => {},
        materialize: () => true,
        clearUnconfirmed: () => {},
        compatibility: {
          hasUnconfirmed: () => false,
          hasSubmitted: () => false,
          barrier: async () => {}
        }
      })
    ).not.toThrow()
  })

  it('resolves only after both the journal fsync and the drain settle', async () => {
    const { deps, order, hasUnconfirmed } = harness()
    await createHostMaterializationBarrier(deps)('chat-a')
    expect(order).toEqual(['journal:chat-a', 'barrier:chat-a'])
    expect(hasUnconfirmed).toHaveBeenCalledWith('chat-a')
  })

  it('starts the drain immediately and gates only the resolution on the journal fsync', async () => {
    let releaseJournal: (() => void) | null = null
    const { deps, order, awaitJournalDurability } = harness()
    awaitJournalDurability.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseJournal = resolve
        })
    )
    const pending = createHostMaterializationBarrier(deps)('chat-a')
    // The drain path is already running while the journal fsync is pending.
    expect(order).toEqual(['barrier:chat-a'])
    releaseJournal!()
    await expect(pending).resolves.toBeUndefined()
  })

  it('skips materialization when nothing is staged and drains', async () => {
    const { deps, materialize, barrier } = harness()
    await createHostMaterializationBarrier(deps)('chat-a')
    expect(materialize).not.toHaveBeenCalled()
    expect(barrier).toHaveBeenCalledWith('chat-a')
  })

  it('skips materialization when a fresh artifact already covers the chain (submission in flight)', async () => {
    const { deps, materialize, barrier, hasUnconfirmed, hasSubmitted } = harness()
    hasUnconfirmed.mockReturnValue(true)
    hasSubmitted.mockReturnValue(true)
    await createHostMaterializationBarrier(deps)('chat-a')
    expect(materialize).not.toHaveBeenCalled()
    expect(barrier).toHaveBeenCalledWith('chat-a')
  })

  it('materializes exactly once when a staged record is uncovered, then drains', async () => {
    const { deps, materialize, barrier, order, hasUnconfirmed } = harness()
    hasUnconfirmed.mockReturnValue(true)
    await createHostMaterializationBarrier(deps)('chat-a')
    expect(materialize).toHaveBeenCalledTimes(1)
    expect(materialize).toHaveBeenCalledWith('chat-a')
    expect(barrier).toHaveBeenCalledWith('chat-a')
    expect(order).toEqual(['journal:chat-a', 'materialize:chat-a', 'barrier:chat-a'])
  })

  it('clears the unconfirmed marker only when the drain settles clean', async () => {
    const { deps, clearUnconfirmed } = harness()
    await createHostMaterializationBarrier(deps)('chat-a')
    expect(clearUnconfirmed).toHaveBeenCalledWith('chat-a')

    const stillDirty = harness()
    stillDirty.hasUnconfirmed.mockReturnValue(true)
    stillDirty.hasSubmitted.mockReturnValue(true)
    await createHostMaterializationBarrier(stillDirty.deps)('chat-b')
    expect(stillDirty.clearUnconfirmed).not.toHaveBeenCalled()
  })

  it('rejects the barrier when the journal fsync cannot be acknowledged, while the drain still starts', async () => {
    const { deps, barrier, awaitJournalDurability } = harness()
    awaitJournalDurability.mockImplementation(async () => {
      throw new Error('journal fsync failed')
    })
    await expect(createHostMaterializationBarrier(deps)('chat-a')).rejects.toThrow(
      'journal fsync failed'
    )
    expect(barrier).toHaveBeenCalledWith('chat-a')
  })

  it('propagates the coordinator drain failure to the dispatch caller', async () => {
    const { deps, barrier } = harness()
    const failure = new Error('host lane closed')
    barrier.mockImplementation(async () => {
      throw failure
    })
    await expect(createHostMaterializationBarrier(deps)('chat-a')).rejects.toBe(failure)
  })
})
