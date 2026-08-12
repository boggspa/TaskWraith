import { describe, expect, it, vi } from 'vitest'
import { openWorkspaceDiffInspector, withWorkspaceDiffPath } from './workspaceDiffInspector'

describe('openWorkspaceDiffInspector', () => {
  it('opens immediately and then presents a freshly loaded workspace diff', async () => {
    const order: string[] = []
    const diff = { type: 'changes', summaries: [{ path: 'src/App.tsx' }] }
    const loadDiff = vi.fn(async (workspacePath: string) => {
      order.push(`load:${workspacePath}`)
      return diff
    })
    const onLoaded = vi.fn(() => order.push('loaded'))

    await expect(
      openWorkspaceDiffInspector('  /repo/worktree  ', {
        loadDiff,
        onOpen: () => order.push('open'),
        onLoaded,
        onError: vi.fn()
      })
    ).resolves.toBe('opened')

    expect(loadDiff).toHaveBeenCalledWith('/repo/worktree')
    expect(onLoaded).toHaveBeenCalledWith(diff, '/repo/worktree')
    expect(order).toEqual(['open', 'load:/repo/worktree', 'loaded'])
  })

  it('ignores an empty workspace path without opening the inspector', async () => {
    const onOpen = vi.fn()
    const loadDiff = vi.fn(async () => ({ type: 'changes' }))

    await expect(
      openWorkspaceDiffInspector('  ', {
        loadDiff,
        onOpen,
        onLoaded: vi.fn(),
        onError: vi.fn()
      })
    ).resolves.toBe('ignored')

    expect(onOpen).not.toHaveBeenCalled()
    expect(loadDiff).not.toHaveBeenCalled()
  })

  it('reports a current load failure without throwing out of the click handler', async () => {
    const onError = vi.fn()

    await expect(
      openWorkspaceDiffInspector('/repo', {
        loadDiff: async () => {
          throw new Error('git status failed')
        },
        onOpen: vi.fn(),
        onLoaded: vi.fn(),
        onError
      })
    ).resolves.toBe('failed')

    expect(onError).toHaveBeenCalledWith('Could not load workspace changes: git status failed')
  })

  it('does not let an older request replace a newer workspace selection', async () => {
    let current = true
    let resolveDiff: ((diff: { type: string }) => void) | undefined
    const load = openWorkspaceDiffInspector('/first', {
      loadDiff: () =>
        new Promise<{ type: string }>((resolve) => {
          resolveDiff = resolve
        }),
      isCurrent: () => current,
      onOpen: vi.fn(),
      onLoaded: vi.fn(),
      onError: vi.fn()
    })

    current = false
    resolveDiff?.({ type: 'changes' })

    await expect(load).resolves.toBe('ignored')
  })
})

describe('withWorkspaceDiffPath', () => {
  it('carries the loaded repo path with the diff without mutating the bridge payload', () => {
    const diff = { type: 'changes', summaries: [{ path: 'src/App.tsx' }] }

    expect(withWorkspaceDiffPath(diff, '/repo/secondary')).toEqual({
      ...diff,
      workspacePath: '/repo/secondary'
    })
    expect(diff).not.toHaveProperty('workspacePath')
  })
})
