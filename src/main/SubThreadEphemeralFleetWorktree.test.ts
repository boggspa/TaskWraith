import { describe, expect, it, vi } from 'vitest'
import {
  EphemeralFleetWorktreeAllocator,
  allocateEphemeralFleetWriterWorktree,
  ephemeralFleetWorktreeIdentity,
  type EphemeralFleetWorktreeGitService
} from './SubThreadEphemeralFleetWorktree'

function git(
  overrides: Partial<EphemeralFleetWorktreeGitService> = {}
): EphemeralFleetWorktreeGitService {
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

describe('ephemeralFleetWorktreeIdentity', () => {
  it('is deterministic for the same parent + worker and unique across workers', () => {
    const a1 = ephemeralFleetWorktreeIdentity('parent-a', 'worker-1', 'Fixer')
    const a2 = ephemeralFleetWorktreeIdentity('parent-a', 'worker-1', 'Fixer')
    const b = ephemeralFleetWorktreeIdentity('parent-a', 'worker-2', 'Fixer')
    expect(a1).toEqual(a2)
    expect(a1.branch).not.toBe(b.branch)
    expect(a1.name).not.toBe(b.name)
    expect(a1.name.startsWith('fleet-Fixer-')).toBe(true)
    expect(a1.branch.startsWith('taskwraith/fleet-Fixer-')).toBe(true)
  })

  it('sanitizes hostile labels and never emits an empty segment', () => {
    const identity = ephemeralFleetWorktreeIdentity('parent-a', 'worker-1', '../;rm -rf ~')
    expect(identity.name).toMatch(/^fleet-[A-Za-z0-9._-]+-[0-9a-f]{10}$/)
    const empty = ephemeralFleetWorktreeIdentity('parent-a', 'worker-1', '///')
    expect(empty.name).toMatch(/^fleet-worker-[0-9a-f]{10}$/)
  })
})

describe('EphemeralFleetWorktreeAllocator', () => {
  it('creates a fresh per-worker worktree when none is linked', async () => {
    const service = git()
    const allocation = await new EphemeralFleetWorktreeAllocator().allocate({
      parentChatId: 'parent-a',
      workerChatId: 'worker-1',
      label: 'fixer',
      baseWorkspacePath: '/repo/',
      git: service
    })

    const identity = ephemeralFleetWorktreeIdentity('parent-a', 'worker-1', 'fixer')
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

  it('adopts an already-linked branch instead of creating again', async () => {
    const identity = ephemeralFleetWorktreeIdentity('parent-a', 'worker-1', 'fixer')
    const service = git({
      listWorktrees: vi.fn(async () => ({
        ok: true as const,
        data: { worktrees: [{ path: `/worktrees/${identity.name}/`, branch: identity.branch }] }
      }))
    })

    const allocation = await new EphemeralFleetWorktreeAllocator().allocate({
      parentChatId: 'parent-a',
      workerChatId: 'worker-1',
      label: 'fixer',
      baseWorkspacePath: '/repo',
      git: service
    })

    expect(allocation?.effectiveWorkspacePath).toBe(`/worktrees/${identity.name}`)
    expect(service.createWorktree).not.toHaveBeenCalled()
  })

  it('soft-fails to null on Git list/create errors (no throw)', async () => {
    await expect(
      new EphemeralFleetWorktreeAllocator().allocate({
        parentChatId: 'parent-a',
        workerChatId: 'worker-1',
        baseWorkspacePath: '/repo',
        git: git({
          listWorktrees: vi.fn(async () => ({ ok: false as const, error: 'not a git repo' }))
        })
      })
    ).resolves.toBeNull()

    await expect(
      new EphemeralFleetWorktreeAllocator().allocate({
        parentChatId: 'parent-a',
        workerChatId: 'worker-1',
        baseWorkspacePath: '/repo',
        git: git({
          createWorktree: vi.fn(async () => ({ ok: false as const, error: 'disk full' }))
        })
      })
    ).resolves.toBeNull()

    await expect(
      new EphemeralFleetWorktreeAllocator().allocate({
        parentChatId: 'parent-a',
        workerChatId: 'worker-1',
        baseWorkspacePath: '/repo',
        git: git({
          createWorktree: vi.fn(async () => {
            throw new Error('boom')
          })
        })
      })
    ).resolves.toBeNull()
  })

  it('soft-fails to null on blank identities', async () => {
    await expect(
      new EphemeralFleetWorktreeAllocator().allocate({
        parentChatId: '  ',
        workerChatId: 'worker-1',
        baseWorkspacePath: '/repo',
        git: git()
      })
    ).resolves.toBeNull()
  })

  it('dedupes concurrent allocation for the SAME worker', async () => {
    let resolveCreate:
      | ((value: { ok: true; data: { requestedPath: string; branch: string } }) => void)
      | undefined
    const pendingCreate: EphemeralFleetWorktreeGitService['createWorktree'] = () =>
      new Promise((resolve) => {
        resolveCreate = resolve
      })
    const createWorktree = vi.fn(pendingCreate)
    const service = git({ createWorktree })
    const allocator = new EphemeralFleetWorktreeAllocator()
    const input = {
      parentChatId: 'parent-a',
      workerChatId: 'worker-1',
      baseWorkspacePath: '/repo',
      git: service
    }

    const first = allocator.allocate(input)
    const second = allocator.allocate(input)
    expect(first).toBe(second)
    await vi.waitFor(() => expect(resolveCreate).toBeTypeOf('function'))
    resolveCreate?.({
      ok: true,
      data: { requestedPath: '/worktrees/x', branch: 'taskwraith/fleet-x' }
    })

    await expect(first).resolves.toMatchObject({ effectiveWorkspacePath: '/worktrees/x' })
    expect(createWorktree).toHaveBeenCalledTimes(1)
  })
})

describe('allocateEphemeralFleetWriterWorktree', () => {
  it('exposes the module-level soft-fail entry point', async () => {
    const service = git()
    const allocation = await allocateEphemeralFleetWriterWorktree({
      parentChatId: 'parent-a',
      workerChatId: 'worker-9',
      label: 'solo',
      baseWorkspacePath: '/repo',
      git: service
    })
    expect(allocation?.branch).toMatch(/^taskwraith\/fleet-solo-/)
    expect(allocation?.effectiveWorkspacePath).toMatch(/^\/worktrees\/fleet-solo-/)
  })
})
