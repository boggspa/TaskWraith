import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  WorkspaceMutationCommitFence,
  WorkspaceMutationCommitFenceBusyError,
  WorkspaceMutationCommitFenceIdentityUnavailableError,
  WorkspaceMutationCommitFenceOwnerNotLiveError,
  WORKSPACE_MUTATION_COMMIT_FENCE_DIRECTORY,
  WORKSPACE_MUTATION_COMMIT_FENCE_FILENAME,
  WORKSPACE_MUTATION_COMMIT_RECLAIM_GUARD_FILENAME,
  type WorkspaceMutationCommitFenceIdentity,
  type WorkspaceMutationCommitFenceProcessObservation
} from './WorkspaceMutationCommitFence'

/**
 * Asserts the INTENT — readable and writable by the owner alone — rather than a
 * raw octal. NTFS reports 0666 where POSIX reports 0600, and macOS enforces modes
 * so a local run cannot see the difference; on Windows the ACL rather than the
 * mode carries this property, so the octal check is meaningful only off win32.
 */
function expectOwnerOnly(target: string): void {
  if (process.platform === 'win32') return
  expect(lstatSync(target).mode & 0o077).toBe(0)
}

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-mutation-fence-'))
  temporaryRoots.push(root)
  return root
}

function identity(
  lockOwnerId: string,
  pid: number,
  processBirthIdentity = `birth-${pid}`
): WorkspaceMutationCommitFenceIdentity {
  return {
    lockOwnerId,
    runId: `run-${lockOwnerId}`,
    pid,
    processBirthIdentity
  }
}

function live(processBirthIdentity: string): WorkspaceMutationCommitFenceProcessObservation {
  return { state: 'live', processBirthIdentity }
}

function idSource(prefix: string): (kind: 'fence' | 'reclaim-guard') => string {
  let sequence = 0
  return (kind) => `${prefix}-${kind}-${++sequence}`
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('WorkspaceMutationCommitFence', () => {
  it('holds the cross-process fence across an async mutation and excludes a concurrent mutation', async () => {
    const root = temporaryRoot()
    const firstOwner = identity('first', 101)
    const secondOwner = identity('second', 202)
    const observations = new Map([
      [firstOwner.pid, live(firstOwner.processBirthIdentity)],
      [secondOwner.pid, live(secondOwner.processBirthIdentity)]
    ])
    const first = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: async (pid) => observations.get(pid) || { state: 'dead' },
      nextId: idSource('first'),
      nowIso: () => '2026-07-29T16:00:00.000Z'
    })
    const second = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: (pid) => observations.get(pid) || { state: 'dead' },
      nextId: idSource('second'),
      nowIso: () => '2026-07-29T16:01:00.000Z'
    })
    const entered = deferred<void>()
    const finish = deferred<void>()

    const firstMutation = first.withFence(firstOwner, async (fence) => {
      expect(fence).toEqual({
        ...firstOwner,
        fenceId: 'first-fence-1',
        acquiredAt: '2026-07-29T16:00:00.000Z'
      })
      entered.resolve()
      await finish.promise
      return 'committed'
    })
    await entered.promise

    expect(second.readFence()).toMatchObject(firstOwner)
    await expect(
      second.withFence(secondOwner, async () => {
        throw new Error('concurrent mutation entered the critical section')
      })
    ).rejects.toMatchObject({
      name: 'WorkspaceMutationCommitFenceBusyError',
      existing: expect.objectContaining(firstOwner)
    })

    finish.resolve()
    await expect(firstMutation).resolves.toBe('committed')
    expect(first.readFence()).toBeNull()
    await expect(second.withFence(secondOwner, async () => 'second-committed')).resolves.toBe(
      'second-committed'
    )
    expect(second.readFence()).toBeNull()
  })

  it('releases in finally when the broker executor rejects', async () => {
    const root = temporaryRoot()
    const owner = identity('throwing', 303)
    const fence = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: () => live(owner.processBirthIdentity),
      nextId: idSource('throwing'),
      nowIso: () => '2026-07-29T16:02:00.000Z'
    })
    const failure = new Error('executor failed')

    await expect(
      fence.withFence(owner, async () => {
        await Promise.resolve()
        throw failure
      })
    ).rejects.toBe(failure)
    expect(fence.readFence()).toBeNull()
  })

  it('reclaims conclusively dead and PID-reused owners with a new exact fence id', async () => {
    const root = temporaryRoot()
    const staleOwner = identity('stale', 404)
    const replacementOwner = identity('replacement', 505)
    const observations = new Map<number, WorkspaceMutationCommitFenceProcessObservation>([
      [staleOwner.pid, live(staleOwner.processBirthIdentity)],
      [replacementOwner.pid, live(replacementOwner.processBirthIdentity)]
    ])
    const staleProcess = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: (pid) => observations.get(pid) || { state: 'dead' },
      nextId: idSource('stale'),
      nowIso: () => '2026-07-29T16:03:00.000Z'
    })
    const staleFence = await staleProcess.acquire(staleOwner)

    observations.set(staleOwner.pid, live('reused-process-birth'))
    const replacementProcess = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: async (pid) => observations.get(pid) || { state: 'dead' },
      nextId: idSource('replacement'),
      nowIso: () => '2026-07-29T16:04:00.000Z'
    })
    const replacementFence = await replacementProcess.acquire(replacementOwner)

    expect(replacementFence.fenceId).toBe('replacement-fence-1')
    expect(replacementFence.fenceId).not.toBe(staleFence.fenceId)
    expect(replacementProcess.readFence()).toEqual(replacementFence)
    expect(staleProcess.release(staleFence)).toBe(false)
    expect(
      staleProcess.release({
        ...replacementFence,
        lockOwnerId: staleOwner.lockOwnerId
      })
    ).toBe(false)
    expect(replacementProcess.readFence()).toEqual(replacementFence)
    expect(replacementProcess.release(replacementFence)).toBe(true)
  })

  it('fails closed when exact identity is unavailable and rejects a non-live prospective owner', async () => {
    const root = temporaryRoot()
    const existingOwner = identity('existing', 606)
    const contender = identity('contender', 707)
    const seed = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: (pid) =>
        pid === existingOwner.pid
          ? live(existingOwner.processBirthIdentity)
          : live(contender.processBirthIdentity),
      nextId: idSource('seed'),
      nowIso: () => '2026-07-29T16:05:00.000Z'
    })
    const existingFence = await seed.acquire(existingOwner)
    const unavailable = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: (pid) =>
        pid === contender.pid
          ? live(contender.processBirthIdentity)
          : { state: 'identity_unavailable' },
      nextId: idSource('unavailable'),
      nowIso: () => '2026-07-29T16:06:00.000Z'
    })

    await expect(unavailable.acquire(contender)).rejects.toBeInstanceOf(
      WorkspaceMutationCommitFenceIdentityUnavailableError
    )
    expect(seed.readFence()).toEqual(existingFence)

    expect(seed.release(existingFence)).toBe(true)
    const noIdentity = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: () => ({ state: 'identity_unavailable' }),
      nextId: idSource('no-identity')
    })
    await expect(noIdentity.acquire(contender)).rejects.toBeInstanceOf(
      WorkspaceMutationCommitFenceIdentityUnavailableError
    )
    expect(noIdentity.readFence()).toBeNull()

    const pidReusedBeforeAcquire = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: () => live('different-birth'),
      nextId: idSource('not-live')
    })
    await expect(pidReusedBeforeAcquire.acquire(contender)).rejects.toBeInstanceOf(
      WorkspaceMutationCommitFenceOwnerNotLiveError
    )
    expect(pidReusedBeforeAcquire.readFence()).toBeNull()
  })

  it('prevents a delayed stale reclaimer from overwriting the newer winner', async () => {
    const root = temporaryRoot()
    const staleOwner = identity('stale-race', 808)
    const delayedOwner = identity('delayed', 909)
    const winnerOwner = identity('winner', 1001)
    const seed = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: () => live(staleOwner.processBirthIdentity),
      nextId: idSource('seed-race'),
      nowIso: () => '2026-07-29T16:07:00.000Z'
    })
    await seed.acquire(staleOwner)

    const staleObservationStarted = deferred<void>()
    const staleObservation = deferred<WorkspaceMutationCommitFenceProcessObservation>()
    const delayed = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: async (pid) => {
        if (pid === delayedOwner.pid) return live(delayedOwner.processBirthIdentity)
        if (pid === staleOwner.pid) {
          staleObservationStarted.resolve()
          return staleObservation.promise
        }
        return { state: 'dead' }
      },
      nextId: idSource('delayed'),
      nowIso: () => '2026-07-29T16:08:00.000Z'
    })
    const delayedAcquire = delayed.acquire(delayedOwner)
    await staleObservationStarted.promise

    const winner = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: (pid) => {
        if (pid === winnerOwner.pid) return live(winnerOwner.processBirthIdentity)
        if (pid === staleOwner.pid) return { state: 'dead' }
        return { state: 'dead' }
      },
      nextId: idSource('winner'),
      nowIso: () => '2026-07-29T16:09:00.000Z'
    })
    const winnerFence = await winner.acquire(winnerOwner)
    staleObservation.resolve({ state: 'dead' })

    await expect(delayedAcquire).rejects.toEqual(
      expect.objectContaining({
        name: 'WorkspaceMutationCommitFenceBusyError',
        existing: winnerFence
      })
    )
    expect(winner.readFence()).toEqual(winnerFence)
    expect(winner.release(winnerFence)).toBe(true)
  })

  it('serializes reclaimers behind an O_EXCL guard', async () => {
    const root = temporaryRoot()
    const staleOwner = identity('guard-stale', 1101)
    const firstOwner = identity('guard-first', 1102)
    const secondOwner = identity('guard-second', 1103)
    const seed = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: () => live(staleOwner.processBirthIdentity),
      nextId: idSource('guard-seed')
    })
    await seed.acquire(staleOwner)

    const guardHeld = deferred<void>()
    const releaseGuard = deferred<void>()
    const first = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: (pid) =>
        pid === firstOwner.pid ? live(firstOwner.processBirthIdentity) : { state: 'dead' },
      nextId: idSource('guard-first'),
      onReclaimGuardAcquired: async () => {
        guardHeld.resolve()
        await releaseGuard.promise
      }
    })
    const second = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: (pid) => {
        if (pid === secondOwner.pid) return live(secondOwner.processBirthIdentity)
        if (pid === firstOwner.pid) return live(firstOwner.processBirthIdentity)
        return { state: 'dead' }
      },
      nextId: idSource('guard-second')
    })

    const firstAcquire = first.acquire(firstOwner)
    await guardHeld.promise
    await expect(second.acquire(secondOwner)).rejects.toBeInstanceOf(
      WorkspaceMutationCommitFenceBusyError
    )
    releaseGuard.resolve()
    const firstFence = await firstAcquire
    expect(first.readFence()).toEqual(firstFence)
    expect(first.release(firstFence)).toBe(true)
  })

  it('quarantines a stale guard without unlinking a replacement guard pathname', async () => {
    const root = temporaryRoot()
    const staleOwner = identity('quarantine-stale-fence', 1151)
    const contender = identity('quarantine-contender', 1152)
    const newestOwner = identity('quarantine-newest', 1153)
    const seed = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: () => live(staleOwner.processBirthIdentity),
      nextId: idSource('quarantine-seed')
    })
    const staleFence = await seed.acquire(staleOwner)
    const authority = join(root, WORKSPACE_MUTATION_COMMIT_FENCE_DIRECTORY)
    const guardPath = join(authority, WORKSPACE_MUTATION_COMMIT_RECLAIM_GUARD_FILENAME)
    const staleGuard = {
      guardId: 'stale-guard',
      expectedFenceId: staleFence.fenceId,
      contender: {
        ...identity('stale-reclaimer', 1154),
        fenceId: 'stale-reclaimer-fence',
        acquiredAt: '2026-07-29T16:11:00.000Z'
      }
    }
    const newestGuard = {
      guardId: 'newest-guard',
      expectedFenceId: staleFence.fenceId,
      contender: {
        ...newestOwner,
        fenceId: 'newest-reclaimer-fence',
        acquiredAt: '2026-07-29T16:12:00.000Z'
      }
    }
    writeFileSync(guardPath, `${JSON.stringify(staleGuard)}\n`)

    const recovering = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: (pid) => {
        if (pid === contender.pid) return live(contender.processBirthIdentity)
        if (pid === newestOwner.pid) return live(newestOwner.processBirthIdentity)
        return { state: 'dead' }
      },
      nextId: idSource('quarantine-recovering'),
      onStaleReclaimGuardQuarantined: () => {
        writeFileSync(guardPath, `${JSON.stringify(newestGuard)}\n`)
      }
    })
    await expect(recovering.acquire(contender)).rejects.toBeInstanceOf(
      WorkspaceMutationCommitFenceBusyError
    )
    expect(JSON.parse(readFileSync(guardPath, 'utf8'))).toEqual(newestGuard)
    expect(seed.readFence()).toEqual(staleFence)
  })

  it('persists only the authority fields from a presentation-rich runtime owner', async () => {
    const root = temporaryRoot()
    const owner = {
      ...identity('canonical-owner', 1171),
      lifecycle: 'child' as const,
      laneId: 'ensemble-participant-1',
      chatId: 'chat-1',
      provider: 'codex',
      participantId: 'ensemble-participant-1',
      displayName: 'SolBoss',
      chatTitle: '# bounded work program'
    }
    const store = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: () => live(owner.processBirthIdentity),
      nextId: idSource('canonical'),
      nowIso: () => '2026-07-29T16:09:00.000Z'
    })

    const acquired = await store.acquire(owner)
    expect(acquired).toEqual({
      lockOwnerId: owner.lockOwnerId,
      runId: owner.runId,
      pid: owner.pid,
      processBirthIdentity: owner.processBirthIdentity,
      fenceId: 'canonical-fence-1',
      acquiredAt: '2026-07-29T16:09:00.000Z'
    })
    const path = join(
      root,
      WORKSPACE_MUTATION_COMMIT_FENCE_DIRECTORY,
      WORKSPACE_MUTATION_COMMIT_FENCE_FILENAME
    )
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(acquired)
    expect(store.release(acquired)).toBe(true)
  })

  it('reclaims the exact presentation-rich fence schema emitted by older builds', async () => {
    const root = temporaryRoot()
    const staleOwner = identity('legacy-owner', 1181)
    const contender = identity('legacy-replacement', 1182)
    const observations = new Map<number, WorkspaceMutationCommitFenceProcessObservation>([
      [staleOwner.pid, live(staleOwner.processBirthIdentity)],
      [contender.pid, live(contender.processBirthIdentity)]
    ])
    const seed = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: (pid) => observations.get(pid) || { state: 'dead' },
      nextId: idSource('legacy-seed'),
      nowIso: () => '2026-07-29T16:09:30.000Z'
    })
    const staleFence = await seed.acquire(staleOwner)
    observations.set(staleOwner.pid, { state: 'dead' })
    const path = join(
      root,
      WORKSPACE_MUTATION_COMMIT_FENCE_DIRECTORY,
      WORKSPACE_MUTATION_COMMIT_FENCE_FILENAME
    )
    writeFileSync(
      path,
      `${JSON.stringify({
        ...staleFence,
        chatId: 'chat-legacy',
        chatTitle: '# legacy title',
        displayName: 'Legacy Boss',
        laneId: 'lane-legacy',
        lifecycle: 'child',
        participantId: 'participant-legacy',
        provider: 'codex'
      })}\n`
    )
    expect(seed.readFence()).toEqual(staleFence)

    const recovering = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: (pid) => observations.get(pid) || { state: 'dead' },
      nextId: idSource('legacy-replacement'),
      nowIso: () => '2026-07-29T16:09:31.000Z'
    })
    const replacement = await recovering.acquire(contender)
    expect(replacement).toMatchObject(contender)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(replacement)
    expect(recovering.release(replacement)).toBe(true)
  })

  it('keeps rejecting unknown or malformed fields in legacy fence envelopes', async () => {
    const root = temporaryRoot()
    const owner = identity('strict-legacy', 1191)
    const store = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: () => live(owner.processBirthIdentity),
      nextId: idSource('strict-legacy')
    })
    const acquired = await store.acquire(owner)
    const path = join(
      root,
      WORKSPACE_MUTATION_COMMIT_FENCE_DIRECTORY,
      WORKSPACE_MUTATION_COMMIT_FENCE_FILENAME
    )

    writeFileSync(path, `${JSON.stringify({ ...acquired, attackerField: 'ignored?' })}\n`)
    expect(() => store.readFence()).toThrow(/unexpected schema/i)

    writeFileSync(path, `${JSON.stringify({ ...acquired, chatTitle: null })}\n`)
    expect(() => store.readFence()).toThrow(/legacy fence metadata is corrupt/i)
  })

  it('creates private fsynced artefacts and rejects a substituted symlink', async () => {
    const root = temporaryRoot()
    const owner = identity('private', 1201)
    const store = new WorkspaceMutationCommitFence({
      userDataRoot: root,
      observeProcess: () => live(owner.processBirthIdentity),
      nextId: idSource('private'),
      nowIso: () => '2026-07-29T16:10:00.000Z'
    })
    const acquired = await store.acquire(owner)
    const authority = join(root, WORKSPACE_MUTATION_COMMIT_FENCE_DIRECTORY)
    const fencePath = join(authority, WORKSPACE_MUTATION_COMMIT_FENCE_FILENAME)

    expectOwnerOnly(authority)
    expectOwnerOnly(fencePath)
    expect(JSON.parse(readFileSync(fencePath, 'utf8'))).toEqual(acquired)
    expect(store.release(acquired)).toBe(true)

    const outside = join(root, 'outside.json')
    writeFileSync(outside, `${JSON.stringify(acquired)}\n`)
    symlinkSync(outside, fencePath)
    expect(() => store.readFence()).toThrow(/regular file/i)
    await expect(store.acquire(owner)).rejects.toThrow(/regular file/i)
  })
})
