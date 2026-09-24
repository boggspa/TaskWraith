import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  WorkspaceLockRuntime,
  createCommitFenceOwnerReader,
  createWorkspaceExternalMutationAuthorityReceipt,
  listCommitFenceOwners,
  mutationFencePartitionKeys,
  workspaceLockAuthorityRootForHome
} from './WorkspaceLockRuntime'
import {
  WORKSPACE_MUTATION_COMMIT_FENCE_DIRECTORY,
  WorkspaceMutationCommitFence
} from './workLocks/WorkspaceMutationCommitFence'
import type {
  CanonicalWorkspaceLockClaim,
  WorkspaceLockLease,
  WorkspaceLockProcessObservation,
  WorkspaceLockSnapshot
} from './workLocks/WorkspaceLockTypes'

function emptySnapshot(): WorkspaceLockSnapshot {
  return {
    authority: {
      instanceId: 'instance',
      generation: 1,
      pid: 10,
      processBirthIdentity: 'main-birth',
      fenceId: 'fence',
      acquiredAt: '2026-07-29T00:00:00.000Z'
    },
    sequence: 1,
    lastTransitionId: 'boot',
    leases: [],
    projectionErrors: []
  }
}

function projectedLease(
  leaseId: string,
  status: WorkspaceLockLease['status'],
  statusChangedAt: string
): WorkspaceLockLease {
  return {
    leaseId,
    acquiredTransitionId: `transition-${leaseId}`,
    authorityInstanceId: 'instance',
    authorityGeneration: 1,
    owner: {
      lockOwnerId: `owner-${leaseId}`,
      runId: `run-${leaseId}`,
      pid: 10,
      processBirthIdentity: 'main-birth'
    },
    claim: {
      workspaceIdentity: '/workspace',
      worktreeCanonicalPath: '/workspace',
      worktreeIdentity: '/workspace',
      targetCanonicalPath: '/workspace',
      comparisonTargetPath: '/workspace',
      physicalTargetIdentity: '/workspace',
      displayWorkspacePath: '/workspace',
      displayWorktreePath: '/workspace',
      kind: 'workspace',
      mode: 'write'
    },
    acquiredAt: statusChangedAt,
    status,
    statusChangedAt,
    ...(status === 'recovered' ? { recoveryReason: 'owner_dead' as const } : {})
  }
}

function harness() {
  let listener: ((snapshot: WorkspaceLockSnapshot) => void) | undefined
  const authority = {
    acquireMany: vi.fn(async (_owner, claims, _options?: { transitionId?: string }) => ({
      ok: true as const,
      transitionId: 'acquire',
      tokens: [],
      leases: [],
      claims
    })),
    replaceAcquisition: vi.fn(
      async (_owner, _previous, claims, _options?: { transitionId?: string }) => ({
        ok: true as const,
        transitionId: 'replace',
        tokens: [],
        leases: [],
        claims
      })
    ),
    verifyAcquisitionForMutation: vi.fn(async (_owner, acquiredTransitionId) => ({
      ok: true as const,
      acquiredTransitionId,
      capabilities: []
    })),
    transferAcquisition: vi.fn(
      async (_previousOwner, _transitionId, nextOwner, _options?: { transitionId?: string }) => ({
        ok: true as const,
        transitionId: 'transfer',
        tokens: [],
        leases: [
          {
            leaseId: 'lease-transferred',
            acquiredTransitionId: 'transfer',
            authorityInstanceId: 'instance',
            authorityGeneration: 1,
            owner: { ...nextOwner, lifecycle: 'child' as const },
            claim: {
              workspaceIdentity: '/workspace',
              worktreeCanonicalPath: '/workspace',
              worktreeIdentity: '/workspace',
              targetCanonicalPath: '/workspace',
              comparisonTargetPath: '/workspace',
              physicalTargetIdentity: '/workspace',
              displayWorkspacePath: '/workspace',
              displayWorktreePath: '/workspace',
              kind: 'workspace' as const,
              mode: 'write' as const
            },
            acquiredAt: '2026-07-29T00:00:00.000Z',
            status: 'held' as const,
            statusChangedAt: '2026-07-29T00:00:00.000Z'
          }
        ]
      })
    ),
    releaseAllForRun: vi.fn(async (_runId?: string, _options?: { transitionId?: string }) => ({
      ok: true as const,
      transitionId: 'release',
      released: []
    })),
    releaseAcquisition: vi.fn(
      async (
        _runId?: string,
        _acquiredTransitionId?: string,
        _options?: { transitionId?: string }
      ) => ({
        ok: true as const,
        transitionId: 'release-acquisition',
        released: []
      })
    ),
    forceReleaseRecoveryBlockedAcquisition: vi.fn(
      async (
        _ownerRunId: string,
        _acquiredTransitionId: string,
        _leaseIds: readonly string[],
        _approvalReceiptId: string,
        _options?: { transitionId?: string }
      ) => ({
        ok: true as const,
        transitionId: 'force-release-recovery',
        released: []
      })
    ),
    quarantineChildOwnerAcquisitions: vi.fn(async () => ({
      transitionId: 'quarantine-child',
      decisions: []
    })),
    snapshot: vi.fn(() => emptySnapshot()),
    onChange: vi.fn((next) => {
      listener = next
      return vi.fn()
    }),
    dispose: vi.fn()
  }
  const mutationFence = {
    acquire: vi.fn(),
    release: vi.fn(() => true)
  }
  const processIdentity = {
    currentProcessIdentity: vi.fn(() => 'main-birth'),
    observe: vi.fn(async () => ({
      state: 'live' as const,
      processBirthIdentity: 'main-birth'
    })),
    dispose: vi.fn()
  }
  return {
    runtime: new WorkspaceLockRuntime(authority, mutationFence, processIdentity, 10),
    authority,
    mutationFence,
    processIdentity,
    emitAuthoritySnapshot: (snapshot: WorkspaceLockSnapshot) => listener?.(snapshot)
  }
}

/** A real commit fence over a temporary root, with exact process observation injected. */
async function commitFenceRoot(
  observations: Map<number, WorkspaceLockProcessObservation>,
  options: { onReclaimGuardAcquired?: () => void | Promise<void> } = {}
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tw-fence-owners-')))
  const fence = new WorkspaceMutationCommitFence({
    userDataRoot: root,
    observeProcess: async (pid) => observations.get(pid) ?? { state: 'identity_unavailable' },
    ...(options.onReclaimGuardAcquired
      ? { onReclaimGuardAcquired: options.onReclaimGuardAcquired }
      : {})
  })
  const owner = (pid: number) => ({
    lockOwnerId: `owner-${pid}`,
    runId: `run-${pid}`,
    pid,
    processBirthIdentity: `birth-${pid}`
  })
  return { root, directory: join(root, WORKSPACE_MUTATION_COMMIT_FENCE_DIRECTORY), fence, owner }
}

function live(...pids: number[]): Map<number, WorkspaceLockProcessObservation> {
  return new Map(
    pids.map((pid) => [pid, { state: 'live' as const, processBirthIdentity: `birth-${pid}` }])
  )
}

const PARTITION_A = `mutation-target:${'a'.repeat(64)}`
const PARTITION_B = `mutation-target:${'b'.repeat(64)}`

describe('listCommitFenceOwners', () => {
  it('names the owner of every partition and of the unpartitioned fence, and nothing without a fence directory', async () => {
    const f = await commitFenceRoot(live(11, 22, 33))
    try {
      expect(listCommitFenceOwners(f.root)).toEqual([])
      // Reading never creates the fence directory.
      expect(existsSync(f.directory)).toBe(false)
      await f.fence.acquire(f.owner(11), PARTITION_A)
      await f.fence.acquire(f.owner(22), PARTITION_B)
      await f.fence.acquire(f.owner(33))
      const owners = listCommitFenceOwners(f.root)
      expect([...owners].sort((left, right) => left.pid - right.pid)).toEqual([
        { pid: 11, processBirthIdentity: 'birth-11', partitionKey: PARTITION_A },
        { pid: 22, processBirthIdentity: 'birth-22', partitionKey: PARTITION_B },
        { pid: 33, processBirthIdentity: 'birth-33' }
      ])
      // A released partition is no longer named.
      const heldB = f.fence.readFence(PARTITION_B)
      expect(f.fence.release(heldB!)).toBe(true)
      expect(
        listCommitFenceOwners(f.root)
          .map((owner) => owner.pid)
          .sort()
      ).toEqual([11, 33])
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('names a contender while it holds the reclaim guard over a dead owner', async () => {
    const observations = live(44)
    observations.set(55, { state: 'dead' })
    let seen: number[] = []
    const f = await commitFenceRoot(observations, {
      onReclaimGuardAcquired: () => {
        seen = listCommitFenceOwners(f.root)
          .map((owner) => owner.pid)
          .sort()
      }
    })
    try {
      // A record left by a process that is now dead, then a live contender.
      const stale = new WorkspaceMutationCommitFence({
        userDataRoot: f.root,
        observeProcess: async () => ({ state: 'live', processBirthIdentity: 'birth-55' })
      })
      await stale.acquire(f.owner(55), PARTITION_A)
      const won = await f.fence.acquire(f.owner(44), PARTITION_A)
      expect(won.pid).toBe(44)
      // Mid-reclaim both the stale owner and the guard's contender are named.
      expect(seen).toEqual([44, 55])
      expect(listCommitFenceOwners(f.root).map((owner) => owner.pid)).toEqual([44])
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('skips unpublished temporaries and quarantined guards', async () => {
    const f = await commitFenceRoot(live(11))
    try {
      await f.fence.acquire(f.owner(11), PARTITION_A)
      await writeFile(join(f.directory, '.0f0e-temporary.tmp'), 'partial')
      await writeFile(join(f.directory, `.reclaim-guard-quarantine-${'c'.repeat(64)}-x.json`), '{')
      expect(listCommitFenceOwners(f.root).map((owner) => owner.pid)).toEqual([11])
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('throws on any record it cannot read or does not recognise, so the reclaim defers', async () => {
    const f = await commitFenceRoot(live(11))
    try {
      await f.fence.acquire(f.owner(11), PARTITION_A)
      const unknown = join(f.directory, 'fence-v2-layout.json')
      await writeFile(unknown, '{}')
      expect(() => listCommitFenceOwners(f.root)).toThrow(/Unrecognised commit-fence entry/)
      await rm(unknown)
      const corrupt = join(f.directory, `fence-${'d'.repeat(64)}.json`)
      await writeFile(corrupt, '{"pid":')
      expect(() => listCommitFenceOwners(f.root)).toThrow(/not valid JSON/)
      await writeFile(corrupt, JSON.stringify({ processBirthIdentity: 'birth-x' }))
      expect(() => listCommitFenceOwners(f.root)).toThrow(/names no exact owner/)
      await writeFile(corrupt, JSON.stringify({ pid: 12, processBirthIdentity: '' }))
      expect(() => listCommitFenceOwners(f.root)).toThrow(/names no exact owner/)
      await rm(corrupt)
      await writeFile(join(f.directory, `reclaim-guard-${'e'.repeat(64)}.json`), '{"contender":7}')
      expect(() => listCommitFenceOwners(f.root)).toThrow(/names no exact owner/)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked record or fence directory instead of following it',
    async () => {
      const f = await commitFenceRoot(live(11))
      try {
        await f.fence.acquire(f.owner(11), PARTITION_A)
        const record = readdirSync(f.directory).find((name) => name.startsWith('fence-'))!
        const elsewhere = join(f.root, 'elsewhere.json')
        await writeFile(elsewhere, readFileSync(join(f.directory, record), 'utf8'))
        const link = join(f.directory, `fence-${'f'.repeat(64)}.json`)
        await symlink(elsewhere, link)
        expect(() => listCommitFenceOwners(f.root)).toThrow(/not a regular file/)
        await rm(link)

        const other = await realpath(await mkdtemp(join(tmpdir(), 'tw-fence-owners-link-')))
        try {
          await symlink(f.directory, join(other, WORKSPACE_MUTATION_COMMIT_FENCE_DIRECTORY))
          expect(() => listCommitFenceOwners(other)).toThrow(/not a real directory/)
        } finally {
          await rm(other, { recursive: true, force: true })
        }
      } finally {
        await rm(f.root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'is read-only: the directory, its mode and every record are untouched',
    async () => {
      const f = await commitFenceRoot(live(11, 22))
      try {
        await f.fence.acquire(f.owner(11), PARTITION_A)
        await f.fence.acquire(f.owner(22))
        const snapshot = () => {
          const directory = lstatSync(f.directory)
          return {
            directory: [directory.mode, directory.mtimeMs, directory.ctimeMs],
            entries: readdirSync(f.directory)
              .sort()
              .map((name) => {
                const entry = lstatSync(join(f.directory, name))
                return [
                  name,
                  entry.mode,
                  entry.mtimeMs,
                  entry.ctimeMs,
                  readFileSync(join(f.directory, name), 'utf8')
                ]
              })
          }
        }
        const before = snapshot()
        for (let read = 0; read < 3; read += 1) listCommitFenceOwners(f.root)
        expect(snapshot()).toEqual(before)
      } finally {
        await rm(f.root, { recursive: true, force: true })
      }
    }
  )
})

describe('mutationFencePartitionKeys', () => {
  const claim: CanonicalWorkspaceLockClaim = {
    workspaceIdentity: '/ws',
    worktreeCanonicalPath: '/ws',
    worktreeIdentity: '/ws',
    worktreeObjectIdentity: 'dev:1:ino:10',
    targetCanonicalPath: '/ws/src/a.ts',
    comparisonTargetPath: '/ws/src/a.ts',
    objectIdentity: 'dev:1:ino:20',
    physicalTargetIdentity: '/ws/src/a.ts',
    displayWorkspacePath: '/ws',
    displayWorktreePath: '/ws',
    relativeTargetPath: 'src/a.ts',
    kind: 'file',
    mode: 'write'
  }
  /** Derived as every earlier build derives it, from the worktree and the object. */
  const OBJECT_KEY =
    'mutation-target:1a5be236e4b1ef19600ea73c924dcea3f045fbc061b0c8cfcc6e5ce65e0c85f3'

  it('fences an exact claim by its object and by its location', () => {
    const keys = mutationFencePartitionKeys([claim])
    expect(keys).toHaveLength(2)
    expect(keys).toContain(OBJECT_KEY)
    const [location] = keys.filter((key) => key !== OBJECT_KEY)

    // The location outlives the object under the path: created, replaced, deleted.
    for (const objectIdentity of ['planned:dev:1:ino:11:a.ts', 'dev:1:ino:21']) {
      const moved = mutationFencePartitionKeys([{ ...claim, objectIdentity }])
      expect(moved).toContain(location)
      expect(moved).not.toContain(OBJECT_KEY)
    }
    // A hard link shares the object and not the location.
    const link = mutationFencePartitionKeys([
      {
        ...claim,
        targetCanonicalPath: '/ws/src/a-link.ts',
        comparisonTargetPath: '/ws/src/a-link.ts',
        physicalTargetIdentity: '/ws/src/a-link.ts',
        relativeTargetPath: 'src/a-link.ts'
      }
    ])
    expect(link).toContain(OBJECT_KEY)
    expect(link).not.toContain(location)
    // A hunk of the same file takes the same two.
    const hunk = {
      ...claim,
      kind: 'hunk' as const,
      hunk: { baseline: 'x', startLine: 1, endLine: 2 }
    }
    expect(mutationFencePartitionKeys([claim, hunk])).toEqual(keys)
  })

  it('keys the location on the case-folded comparison path, not the spelling', () => {
    // On a case-insensitive volume, new.ts admitted while absent and NEW.ts
    // admitted once a sibling created it are one file. The spelling survives in
    // targetCanonicalPath and the fold in comparisonTargetPath; only the fold
    // gives the two calls a shared key.
    const absent = mutationFencePartitionKeys([
      {
        ...claim,
        targetCanonicalPath: '/ws/src/new.ts',
        comparisonTargetPath: '/ws/src/new.ts',
        objectIdentity: 'planned:dev:1:ino:11:new.ts',
        physicalTargetIdentity: '/ws/src/new.ts',
        relativeTargetPath: 'src/new.ts'
      }
    ])
    const created = mutationFencePartitionKeys([
      {
        ...claim,
        targetCanonicalPath: '/ws/src/NEW.ts',
        comparisonTargetPath: '/ws/src/new.ts',
        objectIdentity: 'dev:1:ino:30',
        physicalTargetIdentity: '/ws/src/NEW.ts',
        relativeTargetPath: 'src/NEW.ts'
      }
    ])
    expect(created.filter((key) => absent.includes(key))).toHaveLength(1)
  })

  it('returns one sorted, deduplicated set, the single order each call acquires in', () => {
    const other: CanonicalWorkspaceLockClaim = {
      ...claim,
      targetCanonicalPath: '/ws/src/b.ts',
      comparisonTargetPath: '/ws/src/b.ts',
      objectIdentity: 'dev:1:ino:30',
      physicalTargetIdentity: '/ws/src/b.ts',
      relativeTargetPath: 'src/b.ts'
    }
    const forward = mutationFencePartitionKeys([claim, other])
    expect(forward).toHaveLength(4)
    expect(mutationFencePartitionKeys([other, claim, other])).toEqual(forward)
    expect([...forward]).toEqual([...forward].sort())
  })
})

describe('createCommitFenceOwnerReader', () => {
  it('warns once when reads start failing, once per different failure, and once when they recover', async () => {
    const f = await commitFenceRoot(live(11))
    try {
      await f.fence.acquire(f.owner(11), PARTITION_A)
      const warnings: string[] = []
      const read = createCommitFenceOwnerReader(f.root, (message) => warnings.push(message))
      expect(read().map((owner) => owner.pid)).toEqual([11])
      expect(warnings).toEqual([])

      // An outside writer's entry: every read throws (so every lapse reclaim
      // defers), scan after scan, and only the first failure is named.
      const stray = join(f.directory, 'desktop.ini')
      await writeFile(stray, '[.ShellClassInfo]\n')
      for (let scan = 0; scan < 5; scan += 1) {
        expect(() => read()).toThrow(/Unrecognised commit-fence entry: desktop\.ini/)
      }
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/^Lapse reclaim is paused: /)
      expect(warnings[0]).toContain(JSON.stringify(f.directory))
      expect(warnings[0]).toContain('Unrecognised commit-fence entry: desktop.ini')

      // A different failure is news: named once more.
      await rm(stray)
      await mkdir(join(f.directory, 'backup'))
      for (let scan = 0; scan < 3; scan += 1) {
        expect(() => read()).toThrow(/Unrecognised commit-fence entry: backup/)
      }
      expect(warnings).toHaveLength(2)
      expect(warnings[1]).toContain('Unrecognised commit-fence entry: backup')

      // Clean again: said once, then silence.
      await rm(join(f.directory, 'backup'), { recursive: true })
      for (let scan = 0; scan < 3; scan += 1) {
        expect(read().map((owner) => owner.pid)).toEqual([11])
      }
      expect(warnings).toHaveLength(3)
      expect(warnings[2]).toMatch(/^Lapse reclaim resumed: /)

      // A failure after the recovery is named again.
      await writeFile(stray, '[.ShellClassInfo]\n')
      expect(() => read()).toThrow(/Unrecognised commit-fence entry/)
      expect(warnings).toHaveLength(4)
      expect(warnings[3]).toMatch(/^Lapse reclaim is paused: /)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'names an entry with a control character escaped, on one line',
    async () => {
      const f = await commitFenceRoot(live(11))
      try {
        await f.fence.acquire(f.owner(11), PARTITION_A)
        const warnings: string[] = []
        const read = createCommitFenceOwnerReader(f.root, (message) => warnings.push(message))
        // Finder's custom-folder-icon file.
        await writeFile(join(f.directory, 'Icon\r'), '')
        expect(() => read()).toThrow(/Unrecognised commit-fence entry/)
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('Unrecognised commit-fence entry: Icon\\r')
        expect(warnings[0]).not.toMatch(/[\r\n]/)
      } finally {
        await rm(f.root, { recursive: true, force: true })
      }
    }
  )
})

describe('WorkspaceLockRuntime', () => {
  it('projects holder liveness per lease and never a process identity', () => {
    const h = harness()
    h.authority.snapshot.mockReturnValue({
      ...emptySnapshot(),
      leases: [
        projectedLease('lapsed-peer', 'orphan_live', '2026-07-29T00:00:00.000Z'),
        projectedLease('mine', 'held', '2026-07-29T00:00:01.000Z')
      ],
      holderLiveness: {
        'lapsed-peer': {
          instanceScope: 'other',
          liveness: 'lapsed',
          heartbeatAgeMs: 91_000,
          generation: 3
        }
      }
    })

    const locks = h.runtime.snapshot().locks
    expect(locks.map((lock) => lock.lockId)).toEqual(['lapsed-peer', 'mine'])
    expect(locks[0].holder).toEqual({
      instanceScope: 'other',
      liveness: 'lapsed',
      heartbeatAgeMs: 91_000,
      generation: 3
    })
    expect(locks[1].holder).toBeUndefined()
    expect(JSON.stringify(h.runtime.snapshot())).not.toContain('main-birth')
    expect(JSON.stringify(h.runtime.snapshot())).not.toContain('"pid"')
  })

  it('uses one profile-independent authority root for a local OS user', () => {
    const homePath = '/Users/example'
    const releaseUserData = '/Users/example/Library/Application Support/TaskWraith'
    const devUserData = '/Users/example/Library/Application Support/TaskWraith Dev'

    const root = workspaceLockAuthorityRootForHome(homePath)
    expect(root).toBe(join(resolve(homePath), '.taskwraith', 'workspace-lock-authority-v1'))
    expect(root).not.toBe(releaseUserData)
    expect(root).not.toBe(devUserData)
  })

  it('shares one durable projection poll across every renderer subscriber', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const firstUpdate = vi.fn()
      const secondUpdate = vi.fn()
      const first = h.runtime.subscribe({}, firstUpdate)
      const second = h.runtime.subscribe({}, secondUpdate)
      const callsAfterSubscribe = h.authority.snapshot.mock.calls.length

      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.authority.snapshot).toHaveBeenCalledTimes(callsAfterSubscribe + 1)
      expect(firstUpdate).not.toHaveBeenCalled()
      expect(secondUpdate).not.toHaveBeenCalled()

      h.authority.snapshot.mockReturnValue({
        ...emptySnapshot(),
        sequence: 2,
        leases: [projectedLease('new-lock', 'held', '2026-07-29T00:00:00.000Z')]
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(firstUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'acquired' })
      )
      expect(secondUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'acquired' })
      )

      first.unsubscribe()
      const callsWithOneSubscriber = h.authority.snapshot.mock.calls.length
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.authority.snapshot).toHaveBeenCalledTimes(callsWithOneSubscriber + 1)

      second.unsubscribe()
      const callsAfterUnsubscribe = h.authority.snapshot.mock.calls.length
      await vi.advanceTimersByTimeAsync(2_000)
      expect(h.authority.snapshot).toHaveBeenCalledTimes(callsAfterUnsubscribe)
      h.runtime.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('derives and atomically acquires catalog workspace claims for every run', async () => {
    const { runtime, authority } = harness()

    const result = await runtime.acquire({
      owner: {
        lockOwnerId: 'run-1',
        runId: 'run-1',
        provider: 'codex'
      },
      mutation: {
        workspacePath: '/workspace',
        action: 'write_file',
        args: { path: 'src/new.ts', content: 'x' }
      }
    })

    expect(result.ok).toBe(true)
    expect(authority.acquireMany).toHaveBeenCalledTimes(1)
    const [ownerArg, claimsArg, optionsArg] = authority.acquireMany.mock.calls[0]!
    expect(ownerArg).toMatchObject({
      lockOwnerId: 'run-1',
      runId: 'run-1',
      pid: 10,
      processBirthIdentity: 'main-birth'
    })
    expect(claimsArg).toEqual([
      expect.objectContaining({ kind: 'file', targetPath: resolve('/workspace', 'src') }),
      expect.objectContaining({ kind: 'file', targetPath: resolve('/workspace', 'src/new.ts') })
    ])
    expect(optionsArg).toMatchObject({ transitionId: expect.any(String) })
  })

  it('waits and retries refresh contention without poisoning the transaction', async () => {
    const h = harness()
    const owner = {
      lockOwnerId: 'refresh-owner',
      runId: 'refresh-run',
      pid: 10,
      processBirthIdentity: 'main-birth'
    }
    const claims = [
      { workspacePath: '/workspace', kind: 'file' as const, targetPath: '/workspace/file.ts' }
    ]
    h.authority.replaceAcquisition
      .mockResolvedValueOnce({
        ok: false,
        reason: 'conflict',
        message: 'another exact edit is finishing'
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        transitionId: 'refresh-after-wait',
        tokens: [],
        leases: [],
        claims: []
      } as never)

    const replacement = h.runtime.replaceClaims(owner, 'acquire', claims)
    setTimeout(() => h.emitAuthoritySnapshot(emptySnapshot()), 0)
    await expect(replacement).resolves.toMatchObject({
      ok: true,
      authority: { transitionId: 'refresh-after-wait' }
    })
    expect(h.authority.replaceAcquisition).toHaveBeenCalledTimes(2)
    expect(h.authority.replaceAcquisition.mock.calls[0]?.[3]?.transitionId).toBe(
      h.authority.replaceAcquisition.mock.calls[1]?.[3]?.transitionId
    )
    expect(h.runtime.getUnhealthyReason()).toBeNull()
  })

  it('cancels a contended refresh without poisoning future mutation admission', async () => {
    const h = harness()
    h.authority.replaceAcquisition.mockResolvedValue({
      ok: false,
      reason: 'conflict',
      message: 'another exact edit is finishing'
    } as never)

    await expect(
      h.runtime.replaceClaims(
        {
          lockOwnerId: 'cancel-owner',
          runId: 'cancel-run',
          pid: 10,
          processBirthIdentity: 'main-birth'
        },
        'acquire',
        [
          {
            workspacePath: '/workspace',
            kind: 'file',
            targetPath: '/workspace/file.ts'
          }
        ],
        () => false
      )
    ).resolves.toMatchObject({ ok: false, code: 'cancelled' })
    expect(h.authority.replaceAcquisition).toHaveBeenCalledOnce()
    expect(h.runtime.getUnhealthyReason()).toBeNull()
  })

  it('normalizes untrusted owner presentation before durable lock admission', async () => {
    const { runtime, authority } = harness()

    const result = await runtime.acquire({
      owner: {
        lockOwnerId: 'run-display',
        runId: 'run-display',
        provider: 'codex',
        displayName: 'Sol\n\0Boss',
        chatTitle: '# 1.9.3 bounded work program\n\n...'
      },
      mutation: {
        workspacePath: '/workspace',
        action: 'write_file',
        args: { path: 'src/new.ts', content: 'x' }
      }
    })

    expect(result).toMatchObject({
      ok: true,
      owner: {
        lockOwnerId: 'run-display',
        runId: 'run-display',
        provider: 'codex',
        displayName: 'Sol Boss',
        chatTitle: '# 1.9.3 bounded work program ...'
      }
    })
    expect(authority.acquireMany).toHaveBeenCalledWith(
      expect.objectContaining({
        lockOwnerId: 'run-display',
        runId: 'run-display',
        displayName: 'Sol Boss',
        chatTitle: '# 1.9.3 bounded work program ...'
      }),
      expect.any(Array),
      expect.any(Object)
    )
  })

  it('atomically acquires and replaces an explicit combined claim set', async () => {
    const { runtime, authority } = harness()
    const claims = [
      {
        workspacePath: '/workspace',
        kind: 'file' as const,
        mode: 'write' as const,
        targetPath: '/workspace/file.ts'
      },
      {
        workspacePath: '/workspace',
        kind: 'file' as const,
        mode: 'write' as const,
        targetPath: '/workspace/other.ts'
      }
    ]

    const acquired = await runtime.acquireClaims(
      { lockOwnerId: 'promotion', runId: 'run-promotion' },
      claims
    )
    expect(acquired.ok).toBe(true)
    expect(authority.acquireMany).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-promotion' }),
      claims,
      { transitionId: expect.any(String) }
    )

    if (!acquired.ok) throw new Error(acquired.message)
    const replaced = await runtime.replaceClaims(acquired.owner, 'acquire', claims.slice(1))
    expect(replaced.ok).toBe(true)
    expect(authority.replaceAcquisition).toHaveBeenCalledWith(
      acquired.owner,
      'acquire',
      claims.slice(1),
      { transitionId: expect.any(String) }
    )
  })

  it('transfers a long-lived acquisition to one exact child incarnation', async () => {
    const { runtime, authority, processIdentity } = harness()
    processIdentity.observe.mockResolvedValueOnce({
      state: 'live',
      processBirthIdentity: 'child-birth'
    } as never)
    const previousOwner = {
      lockOwnerId: 'background:1',
      runId: 'run-background',
      pid: 10,
      processBirthIdentity: 'main-birth'
    }

    const transferred = await runtime.transferAcquisition(previousOwner, 'acquire-1', {
      lockOwnerId: 'background:1',
      runId: 'run-background',
      executionPid: 44
    })

    expect(transferred).toMatchObject({
      ok: true,
      owner: { lifecycle: 'child', pid: 44, processBirthIdentity: 'child-birth' }
    })
    expect(authority.transferAcquisition).toHaveBeenCalledWith(
      previousOwner,
      'acquire-1',
      expect.objectContaining({
        lockOwnerId: 'background:1',
        runId: 'run-background',
        pid: 44,
        processBirthIdentity: 'child-birth'
      }),
      { transitionId: expect.any(String) }
    )
  })

  it('fails closed when an exact owner identity cannot be observed', async () => {
    const { runtime, processIdentity, authority } = harness()
    processIdentity.observe.mockResolvedValueOnce({ state: 'identity_unavailable' } as never)

    const result = await runtime.acquire({
      owner: { lockOwnerId: 'run-1', runId: 'run-1' },
      mutation: {
        workspacePath: '/workspace',
        action: 'write_file',
        args: { path: 'file.txt', content: 'next' }
      }
    })

    expect(result).toMatchObject({ ok: false, code: 'owner_identity_unavailable' })
    expect(authority.acquireMany).not.toHaveBeenCalled()
  })

  it('never broadens an unobservable write surface into a workspace claim', async () => {
    const { runtime, authority } = harness()

    const result = await runtime.acquire({
      owner: { lockOwnerId: 'opaque-run', runId: 'opaque-run', provider: 'pi' },
      mutation: {
        source: 'provider-native',
        provider: 'pi',
        workspacePath: '/workspace',
        action: 'opaque-write'
      },
      coarseWorkspaceFallback: true
    })

    expect(result).toMatchObject({ ok: false, code: 'unmapped_action' })
    expect(authority.acquireMany).not.toHaveBeenCalled()
  })

  it('rejects broad canonical claims again at the mutation-fence boundary', async () => {
    const { runtime, mutationFence } = harness()
    const owner = {
      lockOwnerId: 'exact-owner',
      runId: 'exact-run',
      pid: 10,
      processBirthIdentity: 'main-birth'
    }

    await expect(
      runtime.acquireMutationFence(owner, [
        projectedLease('broad-fence', 'held', '2026-07-29T00:00:00.000Z').claim
      ])
    ).rejects.toThrow(/only exact file\/hunk claims/)
    expect(mutationFence.acquire).not.toHaveBeenCalled()
  })

  it('claims every exact parent entry an external write may create', async () => {
    const { runtime, authority } = harness()
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-external-write-lock-'))
    const workspacePath = join(root, 'workspace')
    const grantedRoot = join(root, 'granted')
    await Promise.all([mkdir(workspacePath), mkdir(grantedRoot)])
    const canonicalGrantedRoot = await realpath(grantedRoot)
    const lexicalTargetPath = join(grantedRoot, 'nested', 'deep', 'granted.txt')
    const targetPath = join(canonicalGrantedRoot, 'nested', 'deep', 'granted.txt')
    const mutation = {
      workspacePath,
      action: 'write_file',
      args: { path: lexicalTargetPath }
    }

    try {
      const result = await runtime.acquire({
        owner: { lockOwnerId: 'external-run', runId: 'external-run', provider: 'codex' },
        mutation,
        externalMutationAuthority: createWorkspaceExternalMutationAuthorityReceipt({
          mutation,
          provider: 'codex',
          runId: 'external-run',
          targetPath,
          grantId: 'grant-1',
          grantSignature: 'a'.repeat(64)
        })
      })
      if (!result.ok) throw new Error(result.message)

      expect(result).toMatchObject({
        ok: true,
        claims: [
          expect.objectContaining({
            kind: 'file',
            targetPath: join(canonicalGrantedRoot, 'nested')
          }),
          expect.objectContaining({
            kind: 'file',
            targetPath: join(canonicalGrantedRoot, 'nested/deep')
          }),
          expect.objectContaining({ kind: 'file', targetPath })
        ]
      })
      expect(authority.acquireMany).toHaveBeenCalledOnce()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a receipt bound to a different escaped target', async () => {
    const { runtime, authority } = harness()
    const mutation = {
      workspacePath: '/workspace',
      action: 'write_file',
      args: { path: '/outside/actual.txt' }
    }

    const result = await runtime.acquire({
      owner: { lockOwnerId: 'external-run', runId: 'external-run', provider: 'codex' },
      mutation,
      externalMutationAuthority: createWorkspaceExternalMutationAuthorityReceipt({
        mutation,
        provider: 'codex',
        runId: 'external-run',
        targetPath: '/outside/different.txt',
        grantId: 'grant-1',
        grantSignature: 'a'.repeat(64)
      })
    })

    expect(result).toMatchObject({ ok: false, code: 'invalid_claim' })
    expect(authority.acquireMany).not.toHaveBeenCalled()
  })

  it('preserves trailing-space bytes in an exact external target receipt', async () => {
    const { runtime, authority } = harness()
    const targetPath = '/outside/granted.txt '
    const mutation = {
      workspacePath: '/workspace',
      action: 'write_file',
      args: { path: targetPath }
    }

    await expect(
      runtime.acquire({
        owner: { lockOwnerId: 'external-run', runId: 'external-run', provider: 'codex' },
        mutation,
        externalMutationAuthority: createWorkspaceExternalMutationAuthorityReceipt({
          mutation,
          provider: 'codex',
          runId: 'external-run',
          targetPath,
          grantId: 'grant-1',
          grantSignature: 'a'.repeat(64)
        })
      })
    ).resolves.toMatchObject({ ok: true })
    expect(authority.acquireMany).toHaveBeenCalledOnce()
  })

  it('pins external grant ancestors and rejects directory symlink replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-external-lock-'))
    const workspacePath = join(root, 'workspace')
    const grantedPath = join(root, 'granted')
    const attackerPath = join(root, 'attacker')
    await Promise.all([mkdir(workspacePath), mkdir(grantedPath), mkdir(attackerPath)])
    const canonicalGrantedPath = await realpath(grantedPath)
    const lexicalTargetPath = join(grantedPath, 'nested', 'file.txt ')
    const targetPath = join(canonicalGrantedPath, 'nested', 'file.txt ')
    const mutation = {
      workspacePath,
      action: 'write_file',
      args: { path: lexicalTargetPath }
    }
    const runtimeInput = {
      owner: {
        lockOwnerId: 'external-run',
        runId: 'external-run',
        provider: 'codex' as const
      },
      mutation,
      externalMutationAuthority: createWorkspaceExternalMutationAuthorityReceipt({
        mutation,
        provider: 'codex',
        runId: 'external-run',
        targetPath,
        grantId: 'grant-1',
        grantSignature: 'a'.repeat(64)
      })
    }
    const { runtime } = harness()

    try {
      await expect(runtime.revalidateExternalMutationAuthority(runtimeInput)).resolves.toEqual({
        rootPath: canonicalGrantedPath,
        targetPath
      })
      await writeFile(join(attackerPath, 'file.txt '), 'attacker')
      await rename(grantedPath, `${grantedPath}-original`)
      await symlink(attackerPath, grantedPath, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(runtime.revalidateExternalMutationAuthority(runtimeInput)).rejects.toThrow(
        /no longer matches/
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never broadens invalid arguments or path escapes through coarse fallback', async () => {
    const { runtime, authority } = harness()

    for (const mutation of [
      { workspacePath: '/workspace', action: 'write_file', args: {} },
      {
        workspacePath: '/workspace',
        action: 'write_file',
        args: { path: '../escape.txt' }
      }
    ]) {
      await expect(
        runtime.acquire({
          owner: { lockOwnerId: 'opaque-run', runId: 'opaque-run', provider: 'pi' },
          mutation,
          coarseWorkspaceFallback: true
        })
      ).resolves.toMatchObject({ ok: false, code: 'invalid_claim' })
    }
    expect(authority.acquireMany).not.toHaveBeenCalled()
  })

  it('replays acquire, replace, and transfer with one stable transition id', async () => {
    const acquireHarness = harness()
    acquireHarness.authority.acquireMany.mockRejectedValueOnce(
      new Error('projection failed after WAL commit')
    )
    await expect(
      acquireHarness.runtime.acquireClaims({ lockOwnerId: 'owner-a', runId: 'run-a' }, [
        { workspacePath: '/workspace', kind: 'file', targetPath: '/workspace/a.ts' }
      ])
    ).resolves.toMatchObject({ ok: true })
    expect(acquireHarness.authority.acquireMany).toHaveBeenCalledTimes(2)
    expect(acquireHarness.authority.acquireMany.mock.calls[0]?.[2]?.transitionId).toBe(
      acquireHarness.authority.acquireMany.mock.calls[1]?.[2]?.transitionId
    )
    expect(acquireHarness.runtime.getUnhealthyReason()).toBeNull()

    const replaceHarness = harness()
    replaceHarness.authority.replaceAcquisition.mockRejectedValueOnce(
      new Error('replacement projection failed after WAL commit')
    )
    const owner = {
      lockOwnerId: 'owner-r',
      runId: 'run-r',
      pid: 10,
      processBirthIdentity: 'main-birth'
    }
    await expect(
      replaceHarness.runtime.replaceClaims(owner, 'acquire-r', [
        { workspacePath: '/workspace', kind: 'file', targetPath: '/workspace/a.ts' }
      ])
    ).resolves.toMatchObject({ ok: true })
    expect(replaceHarness.authority.replaceAcquisition).toHaveBeenCalledTimes(2)
    expect(replaceHarness.authority.replaceAcquisition.mock.calls[0]?.[3]?.transitionId).toBe(
      replaceHarness.authority.replaceAcquisition.mock.calls[1]?.[3]?.transitionId
    )
    expect(replaceHarness.runtime.getUnhealthyReason()).toBeNull()

    const transferHarness = harness()
    transferHarness.processIdentity.observe.mockResolvedValueOnce({
      state: 'live',
      processBirthIdentity: 'child-birth'
    } as never)
    transferHarness.authority.transferAcquisition.mockRejectedValueOnce(
      new Error('transfer projection failed after WAL commit')
    )
    await expect(
      transferHarness.runtime.transferAcquisition(owner, 'acquire-r', {
        lockOwnerId: owner.lockOwnerId,
        runId: owner.runId,
        executionPid: 44
      })
    ).resolves.toMatchObject({ ok: true })
    expect(transferHarness.authority.transferAcquisition).toHaveBeenCalledTimes(2)
    expect(transferHarness.authority.transferAcquisition.mock.calls[0]?.[3]?.transitionId).toBe(
      transferHarness.authority.transferAcquisition.mock.calls[1]?.[3]?.transitionId
    )
    expect(transferHarness.runtime.getUnhealthyReason()).toBeNull()
  })

  it('poisons future mutation admission after a fence or exact-release failure', async () => {
    const fenceHarness = harness()
    fenceHarness.mutationFence.release.mockReturnValue(false)
    expect(() =>
      fenceHarness.runtime.releaseMutationFence({
        owners: [
          {
            lockOwnerId: 'owner',
            runId: 'run',
            pid: 10,
            processBirthIdentity: 'main-birth',
            partitionKey: 'file:a',
            fenceId: 'fence',
            acquiredAt: '2026-07-29T00:00:00.000Z'
          }
        ]
      })
    ).toThrow(/not owned/)
    await expect(
      fenceHarness.runtime.acquireClaims({ lockOwnerId: 'next', runId: 'next' }, [
        { workspacePath: '/workspace', kind: 'file', targetPath: '/workspace/next.ts' }
      ])
    ).resolves.toMatchObject({ ok: false, code: 'runtime_unavailable' })

    const releaseHarness = harness()
    releaseHarness.authority.releaseAcquisition.mockResolvedValue({
      ok: false,
      reason: 'authority_busy',
      message: 'busy'
    } as never)
    await expect(
      releaseHarness.runtime.releaseAcquisition('run', 'transition')
    ).resolves.toMatchObject({ ok: false, reason: 'authority_busy' })
    expect(releaseHarness.runtime.getUnhealthyReason()).toMatch(/busy/)
  })

  it('poisons admission when a partial fence acquisition cannot clean up its ownership', async () => {
    const h = harness()
    const owner = {
      lockOwnerId: 'partial-owner',
      runId: 'partial-run',
      pid: 10,
      processBirthIdentity: 'main-birth'
    }
    h.mutationFence.acquire
      .mockResolvedValueOnce({
        ...owner,
        partitionKey: 'first-partition',
        fenceId: 'first-fence',
        acquiredAt: '2026-07-29T00:00:00.000Z'
      })
      .mockRejectedValueOnce(new Error('second partition acquisition failed'))
    h.mutationFence.release.mockReturnValue(false)
    const firstClaim = {
      ...projectedLease('first-exact', 'held', '2026-07-29T00:00:00.000Z').claim,
      kind: 'file' as const,
      targetCanonicalPath: '/workspace/a.ts',
      comparisonTargetPath: '/workspace/a.ts',
      physicalTargetIdentity: '/workspace/a.ts'
    }
    const secondClaim = {
      ...projectedLease('second-exact', 'held', '2026-07-29T00:00:00.000Z').claim,
      kind: 'file' as const,
      targetCanonicalPath: '/workspace/b.ts',
      comparisonTargetPath: '/workspace/b.ts',
      physicalTargetIdentity: '/workspace/b.ts'
    }

    await expect(h.runtime.acquireMutationFence(owner, [firstClaim, secondClaim])).rejects.toThrow(
      /partial partition cleanup failed/
    )
    expect(h.mutationFence.release).toHaveBeenCalledOnce()
    expect(h.runtime.getUnhealthyReason()).toMatch(/partial partition cleanup failed/)
    await expect(
      h.runtime.acquireClaims({ lockOwnerId: 'next', runId: 'next' }, [
        { workspacePath: '/workspace', kind: 'file', targetPath: '/workspace/next.ts' }
      ])
    ).resolves.toMatchObject({ ok: false, code: 'runtime_unavailable' })
  })

  it('retries transient authority contention before poisoning release health', async () => {
    const { runtime, authority } = harness()
    authority.releaseAcquisition
      .mockResolvedValueOnce({
        ok: false,
        reason: 'authority_busy',
        message: 'busy'
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        transitionId: 'release-after-retry',
        released: []
      } as never)

    await expect(runtime.releaseAcquisition('run', 'transition')).resolves.toMatchObject({
      ok: true,
      transitionId: 'release-after-retry'
    })
    expect(authority.releaseAcquisition).toHaveBeenCalledTimes(2)
    expect(runtime.getUnhealthyReason()).toBeNull()
  })

  it('keeps exact release healthy through sustained cross-instance contention', async () => {
    const { runtime, authority } = harness()
    const busyRelease = {
      ok: false,
      reason: 'authority_busy',
      message: 'another instance is replaying a large WAL'
    } as never
    authority.releaseAcquisition
      .mockResolvedValueOnce(busyRelease)
      .mockResolvedValueOnce(busyRelease)
      .mockResolvedValueOnce(busyRelease)
      .mockResolvedValueOnce(busyRelease)
      .mockResolvedValueOnce({
        ok: true,
        transitionId: 'release-after-sustained-contention',
        released: []
      } as never)

    await expect(runtime.releaseAcquisition('run', 'transition')).resolves.toMatchObject({
      ok: true,
      transitionId: 'release-after-sustained-contention'
    })
    expect(authority.releaseAcquisition).toHaveBeenCalledTimes(5)
    expect(runtime.getUnhealthyReason()).toBeNull()
  })

  it('reconciles an exact child quarantine without poisoning healthy admission', async () => {
    const { runtime, authority } = harness()
    authority.quarantineChildOwnerAcquisitions
      .mockRejectedValueOnce(new Error('marker projection failed after quarantine commit'))
      .mockResolvedValueOnce({
        transitionId: 'quarantine-after-retry',
        decisions: []
      })

    const childOwner = {
      lockOwnerId: 'owner-child',
      runId: 'run-child',
      lifecycle: 'child' as const,
      pid: 44,
      processBirthIdentity: 'birth-44'
    }
    await expect(runtime.quarantineChildOwnerAcquisitions(childOwner)).resolves.toBe(undefined)
    expect(authority.quarantineChildOwnerAcquisitions).toHaveBeenCalledTimes(2)
    expect(authority.quarantineChildOwnerAcquisitions).toHaveBeenCalledWith(childOwner)
    expect(runtime.getUnhealthyReason()).toBeNull()
  })

  it('reconciles post-commit release failures with stable transition ids', async () => {
    const acquisitionHarness = harness()
    acquisitionHarness.authority.releaseAcquisition.mockRejectedValueOnce(
      new Error('marker unlink failed after release commit')
    )
    await expect(
      acquisitionHarness.runtime.releaseAcquisition('run', 'acquired-transition')
    ).resolves.toMatchObject({ ok: true })
    expect(acquisitionHarness.authority.releaseAcquisition).toHaveBeenCalledTimes(2)
    expect(acquisitionHarness.authority.releaseAcquisition.mock.calls[0]?.[2]?.transitionId).toBe(
      acquisitionHarness.authority.releaseAcquisition.mock.calls[1]?.[2]?.transitionId
    )
    expect(acquisitionHarness.runtime.getUnhealthyReason()).toBeNull()

    const runHarness = harness()
    runHarness.authority.releaseAllForRun.mockRejectedValueOnce(
      new Error('marker reconciliation failed after terminal commit')
    )
    await expect(runHarness.runtime.releaseRun('run')).resolves.toMatchObject({ ok: true })
    expect(runHarness.authority.releaseAllForRun).toHaveBeenCalledTimes(2)
    expect(runHarness.authority.releaseAllForRun.mock.calls[0]?.[1]?.transitionId).toBe(
      runHarness.authority.releaseAllForRun.mock.calls[1]?.[1]?.transitionId
    )
    expect(runHarness.runtime.getUnhealthyReason()).toBeNull()
  })

  it('counts only durable active leases owned by the exact recovered run', () => {
    const { runtime, authority } = harness()
    const first = projectedLease('first', 'recovery_blocked', '2026-07-29T00:00:00.000Z')
    const second = projectedLease('second', 'held', '2026-07-29T00:00:01.000Z')
    const foreign = projectedLease('foreign', 'held', '2026-07-29T00:00:02.000Z')
    const recovered = projectedLease('recovered', 'recovered', '2026-07-29T00:00:03.000Z')
    first.owner.runId = 'run-recovery'
    second.owner.runId = 'run-recovery'
    recovered.owner.runId = 'run-recovery'
    authority.snapshot.mockReturnValue({
      ...emptySnapshot(),
      leases: [first, foreign, second, recovered]
    })

    expect(runtime.activeLeaseCountForRun('run-recovery')).toBe(2)
    expect(runtime.activeLeaseCountForRun('run-foreign')).toBe(1)
    expect(runtime.activeLeaseCountForRun('   ')).toBe(0)
  })

  it('clears only the matching unresolved-operation poison after exact run quiescence', () => {
    const { runtime } = harness()
    const reason =
      'Workspace-lock mutation admission is fail-closed: Workspace-lock operation run-leaked:7 did not settle before its terminal deadline.'
    runtime.markUnhealthy(reason)

    expect(
      runtime.reconcileUnresolvedRunOperation({
        runId: 'run-leaked',
        expectedUnhealthyReason: reason,
        processTreeStopped: true
      })
    ).toEqual({ ok: true, runId: 'run-leaked', clearedReason: reason })
    expect(runtime.getUnhealthyReason()).toBeNull()
  })

  it('retains fail-closed health without process death, zero leases, and an exact reason', () => {
    const reason = 'Workspace-lock mutation admission is fail-closed: leaked operation'

    const liveProcess = harness()
    liveProcess.runtime.markUnhealthy(reason)
    expect(
      liveProcess.runtime.reconcileUnresolvedRunOperation({
        runId: 'run-leaked',
        expectedUnhealthyReason: reason,
        processTreeStopped: false
      })
    ).toMatchObject({ ok: false, reason: 'process_tree_live' })
    expect(liveProcess.runtime.getUnhealthyReason()).toBe(reason)

    const leased = harness()
    const active = projectedLease('active-leak', 'held', '2026-07-29T00:00:00.000Z')
    active.owner.runId = 'run-leaked'
    leased.authority.snapshot.mockReturnValue({ ...emptySnapshot(), leases: [active] })
    leased.runtime.markUnhealthy(reason)
    expect(
      leased.runtime.reconcileUnresolvedRunOperation({
        runId: 'run-leaked',
        expectedUnhealthyReason: reason,
        processTreeStopped: true
      })
    ).toMatchObject({ ok: false, reason: 'active_leases', activeLeaseCount: 1 })
    expect(leased.runtime.getUnhealthyReason()).toBe(reason)

    const mismatch = harness()
    mismatch.runtime.markUnhealthy(reason)
    expect(
      mismatch.runtime.reconcileUnresolvedRunOperation({
        runId: 'run-leaked',
        expectedUnhealthyReason: `${reason} changed`,
        processTreeStopped: true
      })
    ).toMatchObject({ ok: false, reason: 'reason_mismatch' })
    expect(mismatch.runtime.getUnhealthyReason()).toBe(reason)
  })

  it('bounds recovered projection history while preserving every active lease', () => {
    const { runtime, authority } = harness()
    const now = Date.now()
    const active = projectedLease('active', 'held', new Date(now - 60_000).toISOString())
    const recentRecovered = Array.from({ length: 25 }, (_, index) =>
      projectedLease(`recent-${index}`, 'recovered', new Date(now - index * 1_000).toISOString())
    )
    const oldRecovered = projectedLease(
      'old',
      'recovered',
      new Date(now - 16 * 60_000).toISOString()
    )
    authority.snapshot.mockReturnValueOnce({
      ...emptySnapshot(),
      leases: [oldRecovered, ...recentRecovered, active]
    })

    const projected = runtime.list()

    expect(projected.locks).toHaveLength(21)
    expect(projected.locks.some((lock) => lock.lockId === 'active')).toBe(true)
    expect(projected.locks.some((lock) => lock.lockId === 'old')).toBe(false)
    expect(projected.locks.filter((lock) => lock.status === 'recovered')).toHaveLength(20)
  })
})
