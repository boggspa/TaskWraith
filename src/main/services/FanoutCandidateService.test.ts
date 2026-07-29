import { describe, expect, it, vi } from 'vitest'
import {
  FanoutCandidateService,
  type FanoutCandidateGit,
  type FanoutCandidateStore
} from './FanoutCandidateService'
import type { FanoutWorktreeCandidate } from '../store/types'
import type {
  FanoutCandidatePromotionLock,
  VerifiedFanoutCandidatePromotion
} from './FanoutCandidatePromotionLock'

function makeStore(): FanoutCandidateStore & { rows: Map<string, FanoutWorktreeCandidate> } {
  const rows = new Map<string, FanoutWorktreeCandidate>()
  return {
    rows,
    getCandidates: vi.fn(async () => [...rows.values()]),
    upsertCandidate: vi.fn(async (_chatId, candidate) => {
      rows.set(candidate.candidateId, candidate)
    }),
    patchCandidate: vi.fn(async (_chatId, candidateId, patch) => {
      const existing = rows.get(candidateId)
      if (!existing) return null
      const merged = { ...existing, ...patch } as FanoutWorktreeCandidate
      rows.set(candidateId, merged)
      return merged
    })
  }
}

function makeGit(overrides: Partial<FanoutCandidateGit> = {}): FanoutCandidateGit {
  return {
    listWorktrees: vi.fn(async () => ({
      ok: true as const,
      data: {
        repoRoot: '/repo',
        worktrees: [
          { path: '/repo', branch: 'main', isCurrent: true },
          { path: '/worktrees/cand-1', branch: 'taskwraith/fanout-x', isCurrent: false }
        ]
      }
    })),
    createWorktree: vi.fn(async (input) => ({
      ok: true as const,
      data: { requestedPath: `/worktrees/${input.name}` } as never
    })),
    removeWorktree: vi.fn(async () => ({ ok: true as const, data: {} as never })),
    captureWorktreePatch: vi.fn(async () => ({
      ok: true as const,
      data: {
        repoRoot: '/worktrees/cand-1',
        patch: 'diff --git a/x b/x\n',
        numstat: [{ path: 'x', insertions: 1, deletions: 0, binary: false }],
        totals: { files: 1, insertions: 1, deletions: 0 },
        clean: false
      }
    })),
    inspectPatchApplication: vi.fn(async () => ({
      ok: true as const,
      data: { state: 'applicable' as const }
    })),
    applyPatchToRepository: vi.fn(async () => ({ ok: true as const, data: {} as never })),
    deleteBranch: vi.fn(async () => ({ ok: true as const, data: { branch: 'b' } })),
    ...overrides
  }
}

function makePromotionLock(
  overrides: Partial<FanoutCandidatePromotionLock> = {}
): FanoutCandidatePromotionLock {
  return {
    withPromotionLock: vi.fn(async (input, operation) => ({
      value: await operation({
        baseWorkspacePath: input.baseWorkspacePath,
        targetPaths: [`${input.baseWorkspacePath}/x`]
      })
    })),
    ...overrides
  }
}

function seededCandidate(
  store: ReturnType<typeof makeStore>,
  overrides: Partial<FanoutWorktreeCandidate> = {}
): FanoutWorktreeCandidate {
  const candidate: FanoutWorktreeCandidate = {
    schemaVersion: 1,
    candidateId: 'lane-1',
    roundId: 'r1',
    laneId: 'lane-1',
    runId: 'run-1',
    participantId: 'p1',
    provider: 'claude',
    baseWorkspacePath: '/repo',
    worktreePath: '/worktrees/cand-1',
    branch: 'taskwraith/fanout-x',
    createdAt: 'T0',
    status: 'settled',
    runStatus: 'completed',
    ...overrides
  }
  store.rows.set(candidate.candidateId, candidate)
  return candidate
}

describe('FanoutCandidateService', () => {
  it('allocates a lane worktree and records an active candidate', async () => {
    const store = makeStore()
    const git = makeGit({
      listWorktrees: vi.fn(async () => ({
        ok: true as const,
        data: { repoRoot: '/repo', worktrees: [] }
      }))
    })
    const service = new FanoutCandidateService({
      git,
      store,
      promotionLock: makePromotionLock(),
      nowIso: () => 'T1'
    })

    const allocation = await service.allocateForLane({
      chatId: 'chat-1',
      roundId: 'r1',
      laneId: 'lane-1',
      runId: 'run-1',
      participantId: 'p1',
      participantLabel: 'Writer',
      provider: 'codex',
      model: 'gpt-5.5',
      baseWorkspacePath: '/repo'
    })

    expect(allocation.branch.startsWith('taskwraith/fanout-Writer-')).toBe(true)
    const recorded = store.rows.get('lane-1')
    expect(recorded).toMatchObject({
      candidateId: 'lane-1',
      status: 'active',
      provider: 'codex',
      model: 'gpt-5.5',
      worktreePath: allocation.effectiveWorkspacePath,
      createdAt: 'T1'
    })
  })

  it('settles an active candidate with a diff stat and tolerates capture failures', async () => {
    const store = makeStore()
    seededCandidate(store, { status: 'active', runStatus: undefined })
    const service = new FanoutCandidateService({
      git: makeGit(),
      store,
      promotionLock: makePromotionLock(),
      nowIso: () => 'T2'
    })

    await service.settleLane({ chatId: 'chat-1', laneId: 'lane-1', runStatus: 'completed' })
    expect(store.rows.get('lane-1')).toMatchObject({
      status: 'settled',
      runStatus: 'completed',
      settledAt: 'T2',
      diffStat: { files: 1, insertions: 1, deletions: 0 }
    })

    const failingStore = makeStore()
    seededCandidate(failingStore, { status: 'active', runStatus: undefined })
    const failingService = new FanoutCandidateService({
      git: makeGit({
        captureWorktreePatch: vi.fn(async () => ({ ok: false as const, error: 'boom' }))
      }),
      store: failingStore,
      promotionLock: makePromotionLock(),
      nowIso: () => 'T2'
    })
    await failingService.settleLane({ chatId: 'chat-1', laneId: 'lane-1', runStatus: 'failed' })
    expect(failingStore.rows.get('lane-1')).toMatchObject({
      status: 'settled',
      runStatus: 'failed',
      reason: 'Change summary unavailable: boom'
    })
  })

  it('is a no-op for lanes that never ran isolated', async () => {
    const store = makeStore()
    const git = makeGit()
    const service = new FanoutCandidateService({ git, store, promotionLock: makePromotionLock() })
    await service.settleLane({ chatId: 'chat-1', laneId: 'lane-unknown', runStatus: 'completed' })
    expect(store.patchCandidate).not.toHaveBeenCalled()
    expect(git.captureWorktreePatch).not.toHaveBeenCalled()
  })

  it('promotes a settled candidate: applies the patch, cleans up, marks promoted', async () => {
    const store = makeStore()
    seededCandidate(store)
    const git = makeGit()
    const promotionLock = makePromotionLock()
    const service = new FanoutCandidateService({
      git,
      store,
      promotionLock,
      nowIso: () => 'T3'
    })

    const result = await service.promote('chat-1', 'lane-1')

    expect(result).toEqual({ ok: true, applied: true })
    expect(git.applyPatchToRepository).toHaveBeenCalledWith({
      repoPath: '/repo',
      patch: 'diff --git a/x b/x\n',
      verifiedTargetPaths: ['/repo/x']
    })
    expect(promotionLock.withPromotionLock).toHaveBeenCalledWith(
      {
        chatId: 'chat-1',
        candidateId: 'lane-1',
        baseWorkspacePath: '/repo',
        patch: 'diff --git a/x b/x\n'
      },
      expect.any(Function)
    )
    expect(git.listWorktrees).toHaveBeenCalledTimes(2)
    expect(git.removeWorktree).toHaveBeenCalledWith({
      repoPath: '/repo',
      path: '/worktrees/cand-1',
      force: true
    })
    expect(git.deleteBranch).toHaveBeenCalledWith({
      repoPath: '/repo',
      branch: 'taskwraith/fanout-x',
      force: true
    })
    expect(store.rows.get('lane-1')).toMatchObject({ status: 'promoted', resolvedAt: 'T3' })
  })

  it('promotes a clean candidate without applying anything', async () => {
    const store = makeStore()
    seededCandidate(store)
    const git = makeGit({
      captureWorktreePatch: vi.fn(async () => ({
        ok: true as const,
        data: {
          repoRoot: '/worktrees/cand-1',
          patch: '',
          numstat: [],
          totals: { files: 0, insertions: 0, deletions: 0 },
          clean: true
        }
      }))
    })
    const service = new FanoutCandidateService({ git, store, promotionLock: makePromotionLock() })

    const result = await service.promote('chat-1', 'lane-1')
    expect(result).toEqual({ ok: true, applied: false })
    expect(git.applyPatchToRepository).not.toHaveBeenCalled()
    expect(store.rows.get('lane-1')?.status).toBe('promoted')
  })

  it('refuses to promote an active or already-resolved candidate', async () => {
    const store = makeStore()
    seededCandidate(store, { status: 'active' })
    const service = new FanoutCandidateService({
      git: makeGit(),
      store,
      promotionLock: makePromotionLock()
    })
    await expect(service.promote('chat-1', 'lane-1')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('still running')
    })

    store.rows.set('lane-1', { ...store.rows.get('lane-1')!, status: 'promoted' })
    await expect(service.promote('chat-1', 'lane-1')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('already resolved')
    })
  })

  it('keeps the candidate settled and records the reason when apply fails', async () => {
    const store = makeStore()
    seededCandidate(store)
    const git = makeGit({
      applyPatchToRepository: vi.fn(async () => ({
        ok: false as const,
        error: 'The candidate patch no longer applies cleanly — drifted.'
      }))
    })
    const service = new FanoutCandidateService({ git, store, promotionLock: makePromotionLock() })

    const result = await service.promote('chat-1', 'lane-1')
    expect(result.ok).toBe(false)
    expect(store.rows.get('lane-1')).toMatchObject({
      status: 'settled',
      reason: expect.stringContaining('no longer applies cleanly')
    })
    expect(git.removeWorktree).not.toHaveBeenCalled()
  })

  it('refuses destructive operations when the worktree is no longer linked', async () => {
    const store = makeStore()
    seededCandidate(store, { worktreePath: '/worktrees/ghost' })
    const git = makeGit()
    const service = new FanoutCandidateService({ git, store, promotionLock: makePromotionLock() })

    const result = await service.discard('chat-1', 'lane-1')
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('no longer linked')
    })
    expect(git.removeWorktree).not.toHaveBeenCalled()
  })

  it('discards a settled candidate and serializes double-resolution', async () => {
    const store = makeStore()
    seededCandidate(store)
    const git = makeGit()
    const service = new FanoutCandidateService({
      git,
      store,
      promotionLock: makePromotionLock(),
      nowIso: () => 'T4'
    })

    const [first, second] = await Promise.all([
      service.discard('chat-1', 'lane-1'),
      service.discard('chat-1', 'lane-1')
    ])

    expect([first.ok, second.ok].sort()).toEqual([false, true])
    expect(git.removeWorktree).toHaveBeenCalledTimes(1)
    expect(store.rows.get('lane-1')).toMatchObject({ status: 'discarded', resolvedAt: 'T4' })
  })

  it('truncates giant patch previews but keeps totals intact', async () => {
    const store = makeStore()
    seededCandidate(store)
    const bigPatch = 'x'.repeat(2_000_001)
    const git = makeGit({
      captureWorktreePatch: vi.fn(async () => ({
        ok: true as const,
        data: {
          repoRoot: '/worktrees/cand-1',
          patch: bigPatch,
          numstat: [{ path: 'x', insertions: 9, deletions: 0, binary: false }],
          totals: { files: 1, insertions: 9, deletions: 0 },
          clean: false
        }
      }))
    })
    const service = new FanoutCandidateService({ git, store, promotionLock: makePromotionLock() })

    const preview = await service.candidatePatch('chat-1', 'lane-1')
    expect(preview.truncated).toBe(true)
    expect(preview.patch.length).toBe(2_000_000)
    expect(preview.totals.insertions).toBe(9)
  })

  it('applies only inside the lock callback and uses its freshly verified base path', async () => {
    const store = makeStore()
    seededCandidate(store)
    const git = makeGit()
    let releaseOperation: (() => void) | undefined
    const operationEntered = new Promise<void>((resolve) => {
      releaseOperation = resolve
    })
    let operation: ((verified: VerifiedFanoutCandidatePromotion) => Promise<unknown>) | undefined
    const promotionLock = makePromotionLock({
      withPromotionLock: vi.fn(async (_input, callback) => {
        operation = callback
        await operationEntered
        return {
          value: await callback({
            baseWorkspacePath: '/canonical/repo',
            targetPaths: ['/canonical/repo/x']
          })
        }
      })
    })
    const service = new FanoutCandidateService({ git, store, promotionLock })

    const promoting = service.promote('chat-1', 'lane-1')
    await vi.waitFor(() => expect(operation).toBeTypeOf('function'))
    expect(git.applyPatchToRepository).not.toHaveBeenCalled()
    releaseOperation?.()
    await expect(promoting).resolves.toEqual({ ok: true, applied: true })
    expect(git.applyPatchToRepository).toHaveBeenCalledWith({
      repoPath: '/canonical/repo',
      patch: 'diff --git a/x b/x\n',
      verifiedTargetPaths: ['/canonical/repo/x']
    })
  })

  it('keeps the candidate settled when durable promotion locking is unavailable', async () => {
    const store = makeStore()
    seededCandidate(store)
    const git = makeGit()
    const promotionLock = makePromotionLock({
      withPromotionLock: vi.fn(async () => {
        throw new Error('base workspace is held by another candidate')
      })
    })
    const service = new FanoutCandidateService({ git, store, promotionLock })

    const result = await service.promote('chat-1', 'lane-1')

    expect(result).toEqual({
      ok: false,
      error: 'base workspace is held by another candidate'
    })
    expect(git.applyPatchToRepository).not.toHaveBeenCalled()
    expect(store.rows.get('lane-1')).toMatchObject({
      status: 'settled',
      reason: 'base workspace is held by another candidate'
    })
  })

  it('commits promotion exactly once when authority cleanup degrades after apply', async () => {
    const store = makeStore()
    seededCandidate(store)
    const git = makeGit()
    const promotionLock = makePromotionLock({
      withPromotionLock: vi.fn(async (input, callback) => ({
        value: await callback({
          baseWorkspacePath: input.baseWorkspacePath,
          targetPaths: [`${input.baseWorkspacePath}/x`]
        }),
        cleanupError: 'durable lease cleanup is retrying'
      }))
    })
    const service = new FanoutCandidateService({
      git,
      store,
      promotionLock,
      nowIso: () => 'T5'
    })

    await expect(service.promote('chat-1', 'lane-1')).resolves.toEqual({
      ok: true,
      applied: true
    })
    expect(store.rows.get('lane-1')).toMatchObject({
      status: 'promoted',
      resolvedAt: 'T5',
      reason: expect.stringContaining('lease cleanup is retrying')
    })

    await expect(service.promote('chat-1', 'lane-1')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('already resolved')
    })
    expect(git.applyPatchToRepository).toHaveBeenCalledTimes(1)
  })

  it('recovers a durable intent after status persistence fails without applying twice', async () => {
    const store = makeStore()
    seededCandidate(store)
    let baseContainsPatch = false
    const git = makeGit({
      inspectPatchApplication: vi.fn(async () => ({
        ok: true as const,
        data: {
          state: baseContainsPatch ? ('already-applied' as const) : ('applicable' as const)
        }
      })),
      applyPatchToRepository: vi.fn(async () => {
        baseContainsPatch = true
        return { ok: true as const, data: {} as never }
      })
    })
    let failPromotedStatusOnce = true
    vi.mocked(store.patchCandidate).mockImplementation(
      async (_chatId, candidateId, patch) => {
        const existing = store.rows.get(candidateId)
        if (!existing) return null
        if (patch.status === 'promoted' && failPromotedStatusOnce) {
          failPromotedStatusOnce = false
          throw new Error('simulated crash before promoted status persisted')
        }
        const merged = { ...existing, ...patch } as FanoutWorktreeCandidate
        store.rows.set(candidateId, merged)
        return merged
      }
    )
    const service = new FanoutCandidateService({
      git,
      store,
      promotionLock: makePromotionLock(),
      nowIso: () => 'T6'
    })

    await expect(service.promote('chat-1', 'lane-1')).resolves.toEqual({
      ok: false,
      error: 'simulated crash before promoted status persisted'
    })
    expect(store.rows.get('lane-1')).toMatchObject({
      status: 'settled',
      promotionIntent: {
        patchSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        startedAt: 'T6'
      }
    })

    await expect(service.promote('chat-1', 'lane-1')).resolves.toEqual({
      ok: true,
      applied: true
    })
    expect(git.applyPatchToRepository).toHaveBeenCalledTimes(1)
    expect(git.inspectPatchApplication).toHaveBeenCalledTimes(2)
    expect(store.rows.get('lane-1')).toMatchObject({
      status: 'promoted',
      promotionIntent: undefined,
      resolvedAt: 'T6'
    })
  })

  it('refuses discard while a promotion recovery intent is unresolved', async () => {
    const store = makeStore()
    seededCandidate(store, {
      promotionIntent: {
        patchSha256: 'a'.repeat(64),
        startedAt: 'T0'
      }
    })
    const git = makeGit()
    const service = new FanoutCandidateService({
      git,
      store,
      promotionLock: makePromotionLock()
    })

    await expect(service.discard('chat-1', 'lane-1')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('unfinished promotion intent')
    })
    expect(git.removeWorktree).not.toHaveBeenCalled()
  })
})
