import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readDockSurface, writeDockSurface } from './rightDockPersistence'

function createStorage() {
  const values = new Map<string, string>()
  return {
    values,
    storage: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value))
    }
  }
}

describe('rightDockPersistence', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('round-trips Home independently for each chat', () => {
    const storage = createStorage()
    vi.stubGlobal('window', { sessionStorage: storage.storage })

    writeDockSurface('chat-a', 'home')
    writeDockSurface('chat-b', 'run')

    expect(storage.storage.setItem).toHaveBeenCalledWith(
      'taskwraith.rightDockSurface.chat-a',
      'home'
    )
    expect(readDockSurface('chat-a')).toBe('home')
    expect(readDockSurface('chat-b')).toBe('run')
  })

  it('rejects unknown ids and ignores missing chat ids', () => {
    const storage = createStorage()
    storage.values.set('taskwraith.rightDockSurface.chat-a', 'unknown-surface')
    vi.stubGlobal('window', { sessionStorage: storage.storage })

    expect(readDockSurface('chat-a')).toBeNull()
    expect(readDockSurface(null)).toBeNull()
    writeDockSurface(undefined, 'home')
    expect(storage.storage.setItem).not.toHaveBeenCalled()
  })

  it('ignores legacy cross-launch localStorage values', () => {
    const session = createStorage()
    const legacy = createStorage()
    legacy.values.set('taskwraith.rightDockSurface.chat-a', 'home')
    vi.stubGlobal('window', {
      sessionStorage: session.storage,
      localStorage: legacy.storage
    })

    expect(readDockSurface('chat-a')).toBeNull()
    expect(legacy.storage.getItem).not.toHaveBeenCalled()
  })

  it('treats storage failures as best-effort misses', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {
          throw new Error('blocked')
        }
      }
    })

    expect(readDockSurface('chat-a')).toBeNull()
    expect(() => writeDockSurface('chat-a', 'home')).not.toThrow()
  })
})
