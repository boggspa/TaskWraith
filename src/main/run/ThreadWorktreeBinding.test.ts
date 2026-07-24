import { describe, expect, it, vi } from 'vitest'
import { ThreadWorktreeAllocator, type ThreadWorktreeGitService } from './ThreadWorktreeBinding'

function git(overrides: Partial<ThreadWorktreeGitService> = {}): ThreadWorktreeGitService {
  return {
    listWorktrees: vi.fn(async () => ({ ok: true as const, data: { worktrees: [] } })),
    createWorktree: vi.fn(async (input) => ({
      ok: true as const,
      data: {
        requestedPath: `/worktrees/${input.name}`,
        branch: input.branch
      }
    })),
    ...overrides
  }
}

describe('ThreadWorktreeAllocator', () => {
  it('reuses a still-linked durable binding without creating another worktree', async () => {
    const service = git({
      listWorktrees: vi.fn(async () => ({
        ok: true as const,
        data: { worktrees: [{ path: '/worktrees/thread-chat-a', branch: 'taskwraith/thread-chat-a' }] }
      }))
    })
    const persist = vi.fn(async () => undefined)

    await expect(
      new ThreadWorktreeAllocator().ensure({
        chatId: 'chat-a',
        baseWorkspacePath: '/repo/',
        binding: {
          schemaVersion: 1,
          baseWorkspacePath: '/repo',
          effectiveWorkspacePath: '/worktrees/thread-chat-a/',
          branch: 'taskwraith/thread-chat-a'
        },
        git: service,
        persist
      })
    ).resolves.toEqual({
      schemaVersion: 1,
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: '/worktrees/thread-chat-a',
      branch: 'taskwraith/thread-chat-a'
    })

    expect(service.createWorktree).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })

  it('creates, persists, and reports progress for a previously unbound chat', async () => {
    const service = git()
    const persist = vi.fn(async () => undefined)
    const onProgress = vi.fn()

    await expect(
      new ThreadWorktreeAllocator().ensure({
        chatId: 'chat-a',
        baseWorkspacePath: '/repo',
        git: service,
        persist,
        onProgress
      })
    ).resolves.toMatchObject({
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: '/worktrees/thread-chat-a',
      branch: 'taskwraith/thread-chat-a'
    })

    expect(service.createWorktree).toHaveBeenCalledWith({
      repoPath: '/repo',
      name: 'thread-chat-a',
      branch: 'taskwraith/thread-chat-a'
    })
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ effectiveWorkspacePath: '/worktrees/thread-chat-a' })
    )
    expect(onProgress.mock.calls.map(([state]) => state)).toEqual(['checking', 'creating', 'binding'])
  })

  it('adopts a matching branch left by an interrupted persistence attempt', async () => {
    const service = git({
      listWorktrees: vi.fn(async () => ({
        ok: true as const,
        data: { worktrees: [{ path: '/worktrees/thread-chat-a', branch: 'taskwraith/thread-chat-a' }] }
      }))
    })
    const persist = vi.fn(async () => undefined)

    const binding = await new ThreadWorktreeAllocator().ensure({
      chatId: 'chat-a',
      baseWorkspacePath: '/repo',
      git: service,
      persist
    })

    expect(binding.effectiveWorkspacePath).toBe('/worktrees/thread-chat-a')
    expect(service.createWorktree).not.toHaveBeenCalled()
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('shares one allocation while the same chat has concurrent dispatches', async () => {
    let resolveCreate: ((value: { ok: true; data: { requestedPath: string; branch: string } }) => void) | undefined
    const pendingCreate: ThreadWorktreeGitService['createWorktree'] = () =>
      new Promise((resolve) => {
        resolveCreate = resolve
      })
    const createWorktree = vi.fn(pendingCreate)
    const service = git({
      createWorktree
    })
    const allocator = new ThreadWorktreeAllocator()
    const input = { chatId: 'chat-a', baseWorkspacePath: '/repo', git: service, persist: vi.fn(async () => undefined) }

    const first = allocator.ensure(input)
    const second = allocator.ensure(input)
    expect(first).toBe(second)
    await vi.waitFor(() => expect(resolveCreate).toBeTypeOf('function'))
    resolveCreate?.({
      ok: true,
      data: { requestedPath: '/worktrees/thread-chat-a', branch: 'taskwraith/thread-chat-a' }
    })

    await expect(first).resolves.toMatchObject({ effectiveWorkspacePath: '/worktrees/thread-chat-a' })
    expect(createWorktree).toHaveBeenCalledTimes(1)
  })

  it('keeps allocation failures specific and actionable', async () => {
    const service = git({
      createWorktree: vi.fn(async () => ({ ok: false as const, error: 'branch already checked out' }))
    })

    await expect(
      new ThreadWorktreeAllocator().ensure({
        chatId: 'chat-a',
        baseWorkspacePath: '/repo',
        git: service,
        persist: vi.fn(async () => undefined)
      })
    ).rejects.toThrow('Open Branch & worktree to inspect the repository, then retry.')
  })
})
