import { describe, expect, it, vi } from 'vitest'
import { createChatDetailDependencyBindings } from './ChatDetailDependencyBindings'

describe('chat detail dependency bindings', () => {
  it('joins later debt after the first token throws synchronously', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const later = vi.fn(() => pending)
    const binding = createChatDetailDependencyBindings()
    binding.collect([
      {
        awaitDurable: () => {
          throw new Error('sync debt')
        },
        flushSync: () => {},
        journalDependencies: () => []
      },
      { awaitDurable: later, flushSync: () => {}, journalDependencies: () => [] }
    ])
    let settled = false
    const attempt = binding.awaitDurable().finally(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(later).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    release()
    await expect(attempt).rejects.toThrow('dependencies')
  })

  it('attempts every synchronous drain before reporting failure', () => {
    const later = vi.fn()
    const binding = createChatDetailDependencyBindings()
    binding.collect([
      {
        awaitDurable: async () => {},
        flushSync: () => {
          throw new Error('first')
        },
        journalDependencies: () => []
      },
      { awaitDurable: async () => {}, flushSync: later, journalDependencies: () => [] }
    ])
    expect(() => binding.flushSync()).toThrow('synchronous drain')
    expect(later).toHaveBeenCalledOnce()
  })
  it('deduplicates tokens and preserves strict receipt flushing', async () => {
    const flushSync = vi.fn()
    const awaitDurable = vi.fn(async () => {})
    const token = { flushSync, awaitDurable, journalDependencies: () => [] }
    const binding = createChatDetailDependencyBindings()
    binding.collect([token, token])
    binding.seal()
    binding.flushSync()
    await binding.awaitDurable()
    expect(flushSync).toHaveBeenCalledOnce()
    expect(awaitDurable).toHaveBeenCalledOnce()
    expect(() => binding.collect([token])).toThrow('sealed')
    expect(JSON.stringify(binding)).toBe('{}')
  })

  it('joins all debt after a failure and retains it for retry', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = vi.fn().mockRejectedValueOnce(new Error('debt')).mockResolvedValueOnce(undefined)
    const binding = createChatDetailDependencyBindings()
    binding.collect([
      { flushSync: () => {}, awaitDurable: first, journalDependencies: () => [] },
      { flushSync: () => {}, awaitDurable: () => held, journalDependencies: () => [] }
    ])
    let settled = false
    const attempt = binding.awaitDurable().finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await expect(attempt).rejects.toThrow('dependencies')
    await expect(binding.awaitDurable()).resolves.toBeUndefined()
    expect(first).toHaveBeenCalledTimes(2)
  })
})
