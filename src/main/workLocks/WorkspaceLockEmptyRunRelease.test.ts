import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  resolveCanonicalWorkspaceLockPath,
  verifyCanonicalWorkspaceLockPath
} from './CanonicalWorkspaceLockPath'
import {
  NodeWorkspaceLockPersistence,
  WORKSPACE_LOCK_AUTHORITY_DIRECTORY,
  WORKSPACE_LOCK_EVENTS_FILENAME,
  type NodeWorkspaceLockPersistenceFs
} from './NodeWorkspaceLockPersistence'
import { WorkspaceLockAuthority } from './WorkspaceLockAuthority'
import type {
  WorkspaceLockAuthorityFence,
  WorkspaceLockOwner,
  WorkspaceLockProcessObservation
} from './WorkspaceLockTypes'
import { decodeWorkspaceLockWal } from './WorkspaceLockWal'

// Every run end releases the run's leases. A run that holds none must not pay
// for the machine-wide transition fence and its three syncs to learn that.

const TEMP_PREFIX = 'lock-empty-run-release-'
const temporaryRoots: string[] = []
const authorities: WorkspaceLockAuthority[] = []

/** Removes only a directory this file's own mkdtemp made, directly under os.tmpdir(). */
function removeOwnTemporaryRoot(root: string): void {
  const base = os.tmpdir()
  if (
    root === base ||
    !root.startsWith(base + path.sep + TEMP_PREFIX) ||
    path.relative(base, root).includes(path.sep)
  ) {
    throw new Error(`Refusing to remove ${root}: not this test's own temporary directory.`)
  }
  fs.rmSync(root, { recursive: true, force: true })
}

afterEach(() => {
  for (const authority of authorities.splice(0)) authority.dispose()
  for (const root of temporaryRoots.splice(0)) removeOwnTemporaryRoot(root)
})

const observations = new Map<number, WorkspaceLockProcessObservation>([
  [100, { state: 'live', processBirthIdentity: 'authority-birth' }],
  [201, { state: 'live', processBirthIdentity: 'owner-birth' }],
  [300, { state: 'live', processBirthIdentity: 'peer-birth' }]
])

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX))
  temporaryRoots.push(root)
  const userData = path.join(root, 'user-data')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
  fs.mkdirSync(userData)
  fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'a\n')
  fs.writeFileSync(path.join(workspace, 'src', 'b.ts'), 'b\n')
  const authorityDirectory = path.join(userData, WORKSPACE_LOCK_AUTHORITY_DIRECTORY)
  const walPath = path.join(authorityDirectory, WORKSPACE_LOCK_EVENTS_FILENAME)

  let fsyncs = 0
  const realpath =
    typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync
  const countingFs: NodeWorkspaceLockPersistenceFs = {
    ...(fs as unknown as NodeWorkspaceLockPersistenceFs),
    realpathSync: (input) => realpath(input),
    fsyncSync: (fd) => {
      fsyncs += 1
      fs.fsyncSync(fd)
    }
  }
  const persistence = new NodeWorkspaceLockPersistence({
    userDataRoot: userData,
    fs: countingFs,
    ensureMarkerExcluded: () => ({ status: 'skipped', reason: 'not-a-git-worktree' })
  })

  let id = 0
  let time = Date.parse('2026-10-05T12:00:00.000Z')
  const open = async (): Promise<WorkspaceLockAuthority> => {
    const authority = await WorkspaceLockAuthority.open({
      persistence,
      holderLease: { enabled: false },
      dependencies: {
        nowIso: () => new Date(time++).toISOString(),
        nextId: (kind) => `${kind}-${++id}`,
        observeProcess: async (pid) => observations.get(pid) || { state: 'dead' },
        canonicalizePath: (input) => {
          try {
            return realpath(input)
          } catch {
            return path.resolve(input)
          }
        },
        resolveTargetPath: (rootPath, targetPath) =>
          resolveCanonicalWorkspaceLockPath({ rootPath, targetPath }),
        verifyTargetPath: (expected) => verifyCanonicalWorkspaceLockPath(expected),
        validateHunkBaseline: async () => true,
        instance: { instanceId: 'instance-a', pid: 100, processBirthIdentity: 'authority-birth' }
      }
    })
    authorities.push(authority)
    return authority
  }

  return {
    workspace,
    authorityDirectory,
    persistence,
    open,
    fsyncs: () => fsyncs,
    walText: () => fs.readFileSync(walPath, 'utf8'),
    appendToWal: (text: string) => fs.appendFileSync(walPath, text),
    writeWal: (text: string) => fs.writeFileSync(walPath, text),
    listing: () => [
      ...fs.readdirSync(authorityDirectory).sort(),
      ...fs.readdirSync(workspace).sort()
    ],
    request: (targetPath: string) => ({
      workspacePath: workspace,
      kind: 'file' as const,
      targetPath
    })
  }
}

function owner(runId: string, overrides: Partial<WorkspaceLockOwner> = {}): WorkspaceLockOwner {
  return {
    lockOwnerId: `owner-of-${runId}`,
    runId,
    pid: 201,
    processBirthIdentity: 'owner-birth',
    ...overrides
  }
}

function frameKinds(walText: string): string[] {
  return walText
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { kind: string }).kind)
}

function lastTransitionIdOf(walText: string): string {
  const lines = walText.split('\n').filter(Boolean)
  return (JSON.parse(lines[lines.length - 1]) as { transitionId: string }).transitionId
}

const peerFence: WorkspaceLockAuthorityFence = {
  instanceId: 'instance-peer',
  generation: 9,
  pid: 300,
  processBirthIdentity: 'peer-birth',
  fenceId: 'fence-peer',
  acquiredAt: '2026-10-05T12:00:00.000Z'
}

describe('WorkspaceLockAuthority.releaseAllForRun when the run holds no lease', () => {
  it('returns the result it always did without the fence, a sync or a write', async () => {
    const h = harness()
    const authority = await h.open()
    const held = await authority.acquire(owner('run-1'), h.request('src/a.ts'), {
      transitionId: 'acquire-1'
    })
    expect(held.ok).toBe(true)
    await authority.releaseAllForRun('run-1', { transitionId: 'release-1' })

    const acquireFence = vi.spyOn(h.persistence, 'acquireInstanceFence')
    const releaseFence = vi.spyOn(h.persistence, 'releaseInstanceFence')
    const wal = h.walText()
    const listing = h.listing()
    const syncs = h.fsyncs()

    await expect(
      authority.releaseAllForRun('run-empty', { transitionId: 'release-empty' })
    ).resolves.toEqual({ ok: true, transitionId: 'release-empty', released: [] })
    await expect(authority.releaseAllForRun('run-empty')).resolves.toEqual({
      ok: true,
      transitionId: lastTransitionIdOf(wal),
      released: []
    })
    await expect(
      authority.releaseAllForRun('run-empty', {
        transitionId: 'release-forced',
        forceOrphaned: true
      })
    ).resolves.toEqual({ ok: true, transitionId: 'release-forced', released: [] })

    expect(acquireFence).not.toHaveBeenCalled()
    expect(releaseFence).not.toHaveBeenCalled()
    expect(h.fsyncs()).toBe(syncs)
    expect(h.walText()).toBe(wal)
    expect(h.listing()).toEqual(listing)
  })

  it('still releases a run that holds a lease under the fence, with a synced frame', async () => {
    const h = harness()
    const authority = await h.open()
    const held = await authority.acquire(owner('run-1'), h.request('src/a.ts'), {
      transitionId: 'acquire-1'
    })
    const retained = await authority.acquire(
      owner('run-2', { lifecycle: 'launching-child' }),
      h.request('src/b.ts'),
      { transitionId: 'acquire-2' }
    )
    if (!held.ok || !retained.ok) throw new Error('setup acquisitions failed')
    const acquireFence = vi.spyOn(h.persistence, 'acquireInstanceFence')
    const syncs = h.fsyncs()

    const released = await authority.releaseAllForRun('run-1', { transitionId: 'release-1' })

    expect(released).toMatchObject({ ok: true, transitionId: 'release-1' })
    expect(released.ok && released.released.map((lease) => lease.leaseId)).toEqual(
      held.leases.map((lease) => lease.leaseId)
    )
    expect(acquireFence).toHaveBeenCalledTimes(1)
    expect(frameKinds(h.walText()).slice(-2)).toEqual(['release_run', 'cleanup'])
    expect(h.fsyncs() - syncs).toBeGreaterThanOrEqual(3)

    // A run whose only lease is retained still holds a lease: it is fenced too.
    const kept = await authority.releaseAllForRun('run-2', { transitionId: 'release-2' })
    expect(kept).toMatchObject({ ok: true, released: [] })
    expect(kept.ok && kept.retained?.map((lease) => lease.leaseId)).toEqual(
      retained.leases.map((lease) => lease.leaseId)
    )
    expect(acquireFence).toHaveBeenCalledTimes(2)
  })

  it('replays or refuses a transition id the log already holds, under the fence', async () => {
    const h = harness()
    const authority = await h.open()
    const held = await authority.acquire(owner('run-1'), h.request('src/a.ts'), {
      transitionId: 'acquire-1'
    })
    if (!held.ok) throw new Error('setup acquisition failed')
    const first = await authority.releaseAllForRun('run-1', { transitionId: 'release-1' })
    expect(first.ok && first.released).toHaveLength(1)
    const acquireFence = vi.spyOn(h.persistence, 'acquireInstanceFence')
    const confirmDurable = vi.spyOn(h.persistence, 'confirmEventsDurable')

    // The run now holds nothing, but this id names its committed release.
    await expect(
      authority.releaseAllForRun('run-1', { transitionId: 'release-1' })
    ).resolves.toEqual(first)
    expect(acquireFence).toHaveBeenCalledTimes(1)
    expect(confirmDurable).toHaveBeenCalledTimes(1)

    // An id another operation used is refused, as it always was.
    await expect(
      authority.releaseAllForRun('run-empty', { transitionId: 'acquire-1' })
    ).resolves.toMatchObject({ ok: false, reason: 'stale_token' })
    expect(acquireFence).toHaveBeenCalledTimes(2)
  })

  it('throws, without the fence, when the committed log does not continue its checkpoint', async () => {
    const h = harness()
    const authority = await h.open()
    for (const [index, file] of ['src/a.ts', 'src/b.ts'].entries()) {
      const acquired = await authority.acquire(owner(`run-${index}`), h.request(file), {
        transitionId: `acquire-${index}`
      })
      if (!acquired.ok) throw new Error('setup acquisition failed')
      await authority.releaseAllForRun(`run-${index}`, { transitionId: `release-${index}` })
    }
    const compaction = await authority.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 2 })
    expect(compaction.compacted).toBe(true)
    const [, ...rest] = h.walText().split('\n').filter(Boolean)
    h.writeWal(`${rest.join('\n')}\n`)
    const acquireFence = vi.spyOn(h.persistence, 'acquireInstanceFence')

    await expect(
      authority.releaseAllForRun('run-empty', { transitionId: 'release-empty' })
    ).rejects.toThrow(/does not continue checkpoint/)
    expect(acquireFence).not.toHaveBeenCalled()
  })

  it('leaves a torn tail to the next fenced transition, which repairs it', async () => {
    const h = harness()
    const authority = await h.open()
    h.appendToWal('{"partial":')
    const torn = h.walText()

    await expect(
      authority.releaseAllForRun('run-empty', { transitionId: 'release-empty' })
    ).resolves.toEqual({ ok: true, transitionId: 'release-empty', released: [] })
    expect(h.walText()).toBe(torn)

    const acquired = await authority.acquire(owner('run-1'), h.request('src/a.ts'), {
      transitionId: 'acquire-1'
    })
    expect(acquired.ok).toBe(true)
    const repaired = h.walText()
    expect(repaired.endsWith('\n')).toBe(true)
    expect(repaired).not.toContain('{"partial":')
    expect(frameKinds(repaired)).toContain('acquire')
    expect(decodeWorkspaceLockWal(repaired).activeLeases.map((lease) => lease.owner.runId)).toEqual(
      ['run-1']
    )
  })

  it('returns at once while another instance holds the fence', async () => {
    const h = harness()
    const authority = await h.open()
    const held = await authority.acquire(owner('run-1'), h.request('src/a.ts'), {
      transitionId: 'acquire-1'
    })
    if (!held.ok) throw new Error('setup acquisition failed')
    expect(h.persistence.acquireInstanceFence(peerFence)).toEqual({ ok: true })
    const acquireFence = vi.spyOn(h.persistence, 'acquireInstanceFence')

    await expect(
      authority.releaseAllForRun('run-empty', { transitionId: 'release-empty' })
    ).resolves.toEqual({ ok: true, transitionId: 'release-empty', released: [] })
    expect(acquireFence).not.toHaveBeenCalled()

    // A lease is never released without the fence: this one still waits for it.
    await expect(
      authority.releaseAllForRun('run-1', { transitionId: 'release-1' })
    ).resolves.toMatchObject({ ok: false, reason: 'authority_busy' })
    expect(acquireFence).toHaveBeenCalled()
    expect(h.persistence.releaseInstanceFence(peerFence.fenceId)).toBe(true)
  })
})
