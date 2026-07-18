import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  readDockSurface,
  resolveDockSurfaceContext,
  writeDockSurface
} from './rightDockPersistence'

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

const chatContext = (chatId: string) => ({ kind: 'chat', chatId }) as const
const workContext = (projectId: string) => ({ kind: 'work', projectId }) as const

describe('resolveDockSurfaceContext', () => {
  const projects = [
    { id: 'project-a', memberChatIds: ['chat-1', 'chat-2'] },
    { id: 'project-b', memberChatIds: ['chat-2', 'chat-3'] }
  ]

  it('returns null without a focused chat', () => {
    expect(
      resolveDockSurfaceContext({ activeSidebarTab: 'projects', chatId: null, projects })
    ).toBeNull()
    expect(
      resolveDockSurfaceContext({ activeSidebarTab: 'chat', chatId: '   ', projects })
    ).toBeNull()
  })

  it('keys by project on the Work tab when membership is unambiguous', () => {
    expect(
      resolveDockSurfaceContext({ activeSidebarTab: 'projects', chatId: 'chat-1', projects })
    ).toEqual({ kind: 'work', projectId: 'project-a' })
  })

  it('falls back to the chat key for shared or unaffiliated chats on the Work tab', () => {
    expect(
      resolveDockSurfaceContext({ activeSidebarTab: 'projects', chatId: 'chat-2', projects })
    ).toEqual({ kind: 'chat', chatId: 'chat-2' })
    expect(
      resolveDockSurfaceContext({ activeSidebarTab: 'projects', chatId: 'chat-none', projects })
    ).toEqual({ kind: 'chat', chatId: 'chat-none' })
  })

  it('always keys by chat off the Work tab', () => {
    expect(
      resolveDockSurfaceContext({ activeSidebarTab: 'chat', chatId: 'chat-1', projects })
    ).toEqual({ kind: 'chat', chatId: 'chat-1' })
    expect(
      resolveDockSurfaceContext({ activeSidebarTab: 'threads', chatId: 'chat-1', projects })
    ).toEqual({ kind: 'chat', chatId: 'chat-1' })
  })
})

describe('rightDockPersistence', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('round-trips surfaces independently per chat and per work project', () => {
    const storage = createStorage()
    vi.stubGlobal('window', { sessionStorage: storage.storage })

    writeDockSurface(chatContext('chat-a'), 'home')
    writeDockSurface(chatContext('chat-b'), 'run')
    writeDockSurface(workContext('project-a'), 'run')

    // Chat contexts keep the pre-context bare-chatId key (same-session
    // continuity); work contexts get their own namespaced key.
    expect(storage.storage.setItem).toHaveBeenCalledWith(
      'taskwraith.rightDockSurface.chat-a',
      'home'
    )
    expect(storage.storage.setItem).toHaveBeenCalledWith(
      'taskwraith.rightDockSurface.work:project-a',
      'run'
    )
    expect(readDockSurface(chatContext('chat-a'))).toBe('home')
    expect(readDockSurface(chatContext('chat-b'))).toBe('run')
    expect(readDockSurface(workContext('project-a'))).toBe('run')
  })

  it('rejects unknown ids and ignores null contexts', () => {
    const storage = createStorage()
    storage.values.set('taskwraith.rightDockSurface.chat-a', 'unknown-surface')
    vi.stubGlobal('window', { sessionStorage: storage.storage })

    expect(readDockSurface(chatContext('chat-a'))).toBeNull()
    expect(readDockSurface(null)).toBeNull()
    writeDockSurface(null, 'home')
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

    expect(readDockSurface(chatContext('chat-a'))).toBeNull()
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

    expect(readDockSurface(chatContext('chat-a'))).toBeNull()
    expect(() => writeDockSurface(chatContext('chat-a'), 'home')).not.toThrow()
  })
})
