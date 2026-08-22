import { describe, expect, it, vi } from 'vitest'
import { LiveRunDiffStore } from './liveRunDiffStore'

describe('LiveRunDiffStore', () => {
  it('merges repeated writes by path and notifies only that chat', () => {
    const store = new LiveRunDiffStore()
    const firstChatListener = vi.fn()
    const otherChatListener = vi.fn()
    store.subscribe('chat-1', firstChatListener)
    store.subscribe('chat-2', otherChatListener)

    store.upsert('chat-1', {
      path: 'src/file.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      previewKind: 'none'
    })
    store.upsert('chat-1', {
      path: 'src/file.ts',
      status: 'deleted',
      additions: 0,
      deletions: 4,
      previewKind: 'none'
    })

    expect(store.getSnapshot('chat-1')).toEqual([
      expect.objectContaining({
        path: 'src/file.ts',
        status: 'deleted',
        additions: 2,
        deletions: 5
      })
    ])
    expect(firstChatListener).toHaveBeenCalledTimes(2)
    expect(otherChatListener).not.toHaveBeenCalled()
  })

  it('clears one chat without invalidating another', () => {
    const store = new LiveRunDiffStore()
    store.upsert('chat-1', {
      path: 'one.ts',
      status: 'created',
      additions: 1,
      deletions: 0,
      previewKind: 'none'
    })
    store.upsert('chat-2', {
      path: 'two.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      previewKind: 'none'
    })

    store.clear('chat-1')

    expect(store.getSnapshot('chat-1')).toBeNull()
    expect(store.getSnapshot('chat-2')).toHaveLength(1)
  })
})
