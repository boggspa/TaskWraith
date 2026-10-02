import { describe, expect, it, vi } from 'vitest'
import { startLeasedJournalSourceAdapter } from './LeasedJournalSourceAdapter'

describe('leased journal source adapter', () => {
  it('preserves a post-exit currency callback error while discarding and releasing', async () => {
    const original = new Error('currency failed')
    const cleanup = vi.fn()
    const release = vi.fn(() => {
      throw new Error('release failed')
    })
    const adapter = startLeasedJournalSourceAdapter(
      {
        type: 'start',
        id: 1,
        attempt: 1,
        chatId: 'chat',
        revision: 1,
        generation: 1,
        purpose: 'publication'
      },
      {
        ownsSubmittedLineage: () => true,
        start: () => ({
          result: Promise.resolve('artifact'),
          isCurrent: () => {
            throw original
          },
          cancel: () => {},
          release
        }),
        cleanupExactOutput: cleanup
      }
    )!
    await expect(adapter.result).rejects.toBe(original)
    expect(cleanup).toHaveBeenCalledWith('artifact')
    expect(release).toHaveBeenCalled()
  })
  it('automatically releases executor rejection after exit and preserves its error', async () => {
    const original = new Error('executor failed')
    const release = vi.fn(() => {
      throw new Error('release failed')
    })
    const adapter = startLeasedJournalSourceAdapter(
      {
        type: 'start',
        id: 1,
        attempt: 1,
        chatId: 'chat',
        revision: 1,
        generation: 1,
        purpose: 'publication'
      },
      {
        ownsSubmittedLineage: () => true,
        start: () => ({
          result: Promise.reject(original),
          isCurrent: () => true,
          cancel: () => {},
          release
        }),
        cleanupExactOutput: () => {}
      }
    )!
    await expect(adapter.result).rejects.toBe(original)
    expect(release).toHaveBeenCalled()
  })

  it('holds a successful artifact until cancellation after exit discards it', async () => {
    const release = vi.fn()
    const cleanup = vi.fn()
    const adapter = startLeasedJournalSourceAdapter(
      {
        type: 'start',
        id: 1,
        attempt: 1,
        chatId: 'chat',
        revision: 1,
        generation: 1,
        purpose: 'publication'
      },
      {
        ownsSubmittedLineage: () => true,
        start: () => ({
          result: Promise.resolve('artifact'),
          isCurrent: () => true,
          cancel: () => {},
          release
        }),
        cleanupExactOutput: cleanup
      }
    )!
    await adapter.result
    expect(release).not.toHaveBeenCalled()
    adapter.cancel()
    expect(cleanup).toHaveBeenCalledWith('artifact')
    expect(release).toHaveBeenCalledOnce()
  })
  it('retains custody when exact output cleanup is indeterminate', async () => {
    const release = vi.fn()
    const adapter = startLeasedJournalSourceAdapter(
      {
        type: 'start',
        id: 1,
        attempt: 1,
        chatId: 'chat',
        revision: 1,
        generation: 1,
        purpose: 'publication'
      },
      {
        ownsSubmittedLineage: () => true,
        start: () => ({
          result: Promise.resolve('artifact'),
          isCurrent: () => false,
          cancel: () => {},
          release
        }),
        cleanupExactOutput: () => {
          throw new Error('Host custody unknown')
        }
      }
    )!
    adapter.release()
    await expect(adapter.result).rejects.toThrow('custody unknown')
    adapter.release()
    expect(release).not.toHaveBeenCalled()
  })
  it('holds release until executor exit and checks submitted lineage before adoption', async () => {
    let finish!: (artifact: string) => void
    let owned = true
    const release = vi.fn()
    const cleanup = vi.fn()
    const result = new Promise<string>((resolve) => {
      finish = resolve
    })
    const adapter = startLeasedJournalSourceAdapter(
      {
        type: 'start',
        id: 1,
        attempt: 1,
        chatId: 'chat',
        revision: 1,
        generation: 1,
        purpose: 'publication'
      },
      {
        ownsSubmittedLineage: () => owned,
        start: () => ({ result, isCurrent: () => true, cancel: () => {}, release }),
        cleanupExactOutput: cleanup
      }
    )!
    adapter.release()
    expect(release).not.toHaveBeenCalled()
    owned = false
    finish('exact-artifact')
    await expect(adapter.result).rejects.toThrow('lineage')
    expect(cleanup).toHaveBeenCalledWith('exact-artifact')
    expect(release).toHaveBeenCalledOnce()
  })
})
