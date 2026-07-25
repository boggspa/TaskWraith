import { describe, expect, it, vi } from 'vitest'
import {
  FanoutWorktreeAllocator,
  fanoutWorktreeIdentity,
  type FanoutWorktreeGitService
} from './FanoutWorktreeAllocation'

function git(overrides: Partial<FanoutWorktreeGitService> = {}): FanoutWorktreeGitService {
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

describe('fanoutWorktreeIdentity', () => {
  it('is deterministic for the same chat + lane and unique across lanes', () => {
    const a1 = fanoutWorktreeIdentity('chat-a', 'lane-r1-seat-1', 'seat')
    const a2 = fanoutWorktreeIdentity('chat-a', 'lane-r1-seat-1', 'seat')
    const b = fanoutWorktreeIdentity('chat-a', 'lane-r1-seat-2', 'seat')
    expect(a1).toEqual(a2)
    expect(a1.branch).not.toBe(b.branch)
    expect(a1.name).not.toBe(b.name)
    expect(a1.branch.startsWith('taskwraith/fanout-seat-')).toBe(true)
  })

  it('sanitizes hostile participant hints and never emits an empty segment', () => {
    const identity = fanoutWorktreeIdentity('chat-a', 'lane-1', '../;rm -rf ~')
    expect(identity.name).toMatch(/^fanout-[A-Za-z0-9._-]+-[0-9a-f]{10}$/)
    const empty = fanoutWorktreeIdentity('chat-a', 'lane-1', '///')
    expect(empty.name).toMatch(/^fanout-lane-[0-9a-f]{10}$/)
  })

  it('gives sibling lanes distinct branches even with identical hints', () => {
    const one = fanoutWorktreeIdentity('chat-a', 'lane-r1-p1-1', 'Writer')
    const two = fanoutWorktreeIdentity('chat-a', 'lane-r1-p2-1', 'Writer')
    expect(one.branch).not.toBe(two.branch)
  })
})

describe('FanoutWorktreeAllocator', () => {
  it('creates a fresh per-lane worktree when none is linked', async () => {
    const service = git()
    const allocation = await new FanoutWorktreeAllocator().ensure({
      chatId: 'chat-a',
      laneId: 'lane-r1-p1-1',
      participantHint: 'writer',
      baseWorkspacePath: '/repo/',
      git: service
    })

    const identity = fanoutWorktreeIdentity('chat-a', 'lane-r1-p1-1', 'writer')
    expect(service.createWorktree).toHaveBeenCalledWith({
      repoPath: '/repo',
      name: identity.name,
      branch: identity.branch
    })
    expect(allocation).toEqual({
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: `/worktrees/${identity.name}`,
      branch: identity.branch
    })
  })

  it('adopts an already-linked branch instead of failing on re-dispatch', async () => {
    const identity = fanoutWorktreeIdentity('chat-a', 'lane-r1-p1-1', 'writer')
    const service = git({
      listWorktrees: vi.fn(async () => ({
        ok: true as const,
        data: { worktrees: [{ path: `/worktrees/${identity.name}/`, branch: identity.branch }] }
      }))
    })

    const allocation = await new FanoutWorktreeAllocator().ensure({
      chatId: 'chat-a',
      laneId: 'lane-r1-p1-1',
      participantHint: 'writer',
      baseWorkspacePath: '/repo',
      git: service
    })

    expect(allocation.effectiveWorkspacePath).toBe(`/worktrees/${identity.name}`)
    expect(service.createWorktree).not.toHaveBeenCalled()
  })

  it('allocates DISTINCT worktrees for sibling lanes of the same chat', async () => {
    const service = git()
    const allocator = new FanoutWorktreeAllocator()
    const [first, second] = await Promise.all([
      allocator.ensure({
        chatId: 'chat-a',
        laneId: 'lane-r1-p1-1',
        baseWorkspacePath: '/repo',
        git: service
      }),
      allocator.ensure({
        chatId: 'chat-a',
        laneId: 'lane-r1-p2-1',
        baseWorkspacePath: '/repo',
        git: service
      })
    ])

    expect(first.effectiveWorkspacePath).not.toBe(second.effectiveWorkspacePath)
    expect(first.branch).not.toBe(second.branch)
    expect(service.createWorktree).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent allocation for the SAME lane', async () => {
    let resolveCreate:
      | ((value: { ok: true; data: { requestedPath: string; branch: string } }) => void)
      | undefined
    const pendingCreate: FanoutWorktreeGitService['createWorktree'] = () =>
      new Promise((resolve) => {
        resolveCreate = resolve
      })
    const createWorktree = vi.fn(pendingCreate)
    const service = git({ createWorktree })
    const allocator = new FanoutWorktreeAllocator()
    const input = {
      chatId: 'chat-a',
      laneId: 'lane-r1-p1-1',
      baseWorkspacePath: '/repo',
      git: service
    }

    const first = allocator.ensure(input)
    const second = allocator.ensure(input)
    expect(first).toBe(second)
    await vi.waitFor(() => expect(resolveCreate).toBeTypeOf('function'))
    resolveCreate?.({
      ok: true,
      data: { requestedPath: '/worktrees/x', branch: 'taskwraith/fanout-x' }
    })

    await expect(first).resolves.toMatchObject({ effectiveWorkspacePath: '/worktrees/x' })
    expect(createWorktree).toHaveBeenCalledTimes(1)
  })

  it('keeps allocation failures specific and actionable', async () => {
    const service = git({
      createWorktree: vi.fn(async () => ({ ok: false as const, error: 'disk full' }))
    })

    await expect(
      new FanoutWorktreeAllocator().ensure({
        chatId: 'chat-a',
        laneId: 'lane-r1-p1-1',
        baseWorkspacePath: '/repo',
        git: service
      })
    ).rejects.toThrow('Open Branch & worktree to inspect the repository, then retry.')
  })

  it('rejects blank identities instead of allocating a nameless worktree', async () => {
    await expect(
      new FanoutWorktreeAllocator().ensure({
        chatId: '  ',
        laneId: 'lane-1',
        baseWorkspacePath: '/repo',
        git: git()
      })
    ).rejects.toThrow('saved chat')
  })
})
