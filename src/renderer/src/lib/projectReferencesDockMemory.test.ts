import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  hasAutoOpenedProjectReferences,
  markProjectReferencesAutoOpened,
  rememberProjectReferencesDockOpened,
  resetProjectReferencesDockMemoryForTests,
  shouldAutoOpenProjectReferences,
  shouldPinProjectReferencesOnWorkRoute
} from './projectReferencesDockMemory'

function createStorage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key))
  }
}

describe('projectReferencesDockMemory', () => {
  beforeEach(() => {
    const localStorage = createStorage()
    vi.stubGlobal('window', { localStorage })
    resetProjectReferencesDockMemoryForTests()
  })

  it('remembers each project independently across reads', () => {
    expect(hasAutoOpenedProjectReferences('project-a')).toBe(false)

    markProjectReferencesAutoOpened('project-a')

    expect(hasAutoOpenedProjectReferences('project-a')).toBe(true)
    expect(hasAutoOpenedProjectReferences('project-b')).toBe(false)
  })

  it('persists the Work destination even when the active tab was already References', () => {
    const localStorage = createStorage()
    const sessionStorage = createStorage()
    vi.stubGlobal('window', { localStorage, sessionStorage })

    rememberProjectReferencesDockOpened('project-b')

    expect(sessionStorage.setItem).toHaveBeenCalledWith(
      'taskwraith.rightDockSurface.work:project-b',
      'references'
    )
    expect(hasAutoOpenedProjectReferences('project-b')).toBe(true)
  })

  it('ignores empty ids and degrades safely when storage is blocked', () => {
    markProjectReferencesAutoOpened('  ')
    expect(hasAutoOpenedProjectReferences(null)).toBe(false)

    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {
          throw new Error('blocked')
        },
        removeItem: () => undefined
      }
    })

    expect(hasAutoOpenedProjectReferences('project-a')).toBe(false)
    expect(() => markProjectReferencesAutoOpened('project-a')).not.toThrow()
    expect(hasAutoOpenedProjectReferences('project-a')).toBe(true)
  })

  it('pins References on the Work route regardless of width, project, or saved surface', () => {
    expect(shouldPinProjectReferencesOnWorkRoute({ activeSidebarTab: 'projects' })).toBe(true)
    expect(shouldPinProjectReferencesOnWorkRoute({ activeSidebarTab: 'chat' })).toBe(false)
    expect(shouldPinProjectReferencesOnWorkRoute({ activeSidebarTab: 'threads' })).toBe(false)

    expect(
      shouldAutoOpenProjectReferences({
        activeSidebarTab: 'projects',
        projectId: 'project-a',
        viewportWidth: 700,
        hasSavedDockSurface: true
      })
    ).toBe(true)

    markProjectReferencesAutoOpened('project-a')
    expect(
      shouldAutoOpenProjectReferences({
        activeSidebarTab: 'projects',
        projectId: 'project-a',
        viewportWidth: 1200
      })
    ).toBe(true)
  })
})
