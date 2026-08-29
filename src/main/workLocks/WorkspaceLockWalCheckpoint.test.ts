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
  WORKSPACE_LOCK_ARCHIVE_DIRECTORY,
  WORKSPACE_LOCK_AUTHORITY_DIRECTORY,
  WORKSPACE_LOCK_CHECKPOINT_FILENAME,
  WORKSPACE_LOCK_EVENTS_FILENAME
} from './NodeWorkspaceLockPersistence'
import { WorkspaceLockAuthority } from './WorkspaceLockAuthority'
import type {
  WorkspaceLockAuthorityDependencies,
  WorkspaceLockOwner,
  WorkspaceLockProcessObservation
} from './WorkspaceLockTypes'
import { decodeWorkspaceLockWal } from './WorkspaceLockWal'
import {
  decodeWorkspaceLockWalCheckpoint,
  resolveWorkspaceLockWalState,
  workspaceLockWalArchiveFilename
} from './WorkspaceLockWalCheckpoint'

const temporaryRoots: string[] = []
let globalId = 0
let globalTime = Date.parse('2026-08-29T02:00:00.000Z')

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function harness(instanceId = 'checkpoint-instance') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-lock-checkpoint-'))
  const userData = path.join(root, 'user-data')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(userData)
  fs.mkdirSync(workspace)
  fs.mkdirSync(path.join(workspace, 'src'))
  for (const name of ['a.ts', 'b.ts', 'c.ts']) {
    fs.writeFileSync(path.join(workspace, 'src', name), `${name}\n`)
  }
  temporaryRoots.push(root)

  const observations = new Map<number, WorkspaceLockProcessObservation>([
    [100, { state: 'live', processBirthIdentity: 'authority-birth' }],
    [201, { state: 'live', processBirthIdentity: 'owner-a-birth' }],
    [202, { state: 'live', processBirthIdentity: 'owner-b-birth' }]
  ])
  const dependencies: WorkspaceLockAuthorityDependencies = {
    nowIso: () => new Date(globalTime++).toISOString(),
    nextId: (kind) => `${kind}-${++globalId}`,
    observeProcess: async (pid) => observations.get(pid) || { state: 'identity_unavailable' },
    canonicalizePath: (input) => {
      try {
        return fs.realpathSync(input)
      } catch {
        return path.resolve(input)
      }
    },
    resolveTargetPath: (targetRoot, targetPath) =>
      resolveCanonicalWorkspaceLockPath({ rootPath: targetRoot, targetPath }),
    verifyTargetPath: (expected) => verifyCanonicalWorkspaceLockPath(expected),
    validateHunkBaseline: async () => true,
    instance: { instanceId, pid: 100, processBirthIdentity: 'authority-birth' }
  }
  const persistence = new NodeWorkspaceLockPersistence({ userDataRoot: userData })
  const authorityDir = path.join(userData, WORKSPACE_LOCK_AUTHORITY_DIRECTORY)
  return {
    root,
    userData,
    workspace,
    observations,
    dependencies,
    persistence,
    authorityDir,
    eventsPath: path.join(authorityDir, WORKSPACE_LOCK_EVENTS_FILENAME),
    checkpointPath: path.join(authorityDir, WORKSPACE_LOCK_CHECKPOINT_FILENAME),
    archiveDir: path.join(authorityDir, WORKSPACE_LOCK_ARCHIVE_DIRECTORY)
  }
}

function owner(
  overrides: Partial<WorkspaceLockOwner> & Pick<WorkspaceLockOwner, 'lockOwnerId' | 'runId'>
): WorkspaceLockOwner {
  return { pid: 201, processBirthIdentity: 'owner-a-birth', ...overrides }
}

/** Builds a journal with enough real transitions to have something to seal. */
async function buildHistory(
  h: ReturnType<typeof harness>,
  cycles: number
): Promise<WorkspaceLockAuthority> {
  const authority = await WorkspaceLockAuthority.open({
    persistence: h.persistence,
    dependencies: h.dependencies
  })
  for (let index = 0; index < cycles; index += 1) {
    const acquired = await authority.acquire(
      owner({ lockOwnerId: `owner-${index}`, runId: `run-${index}` }),
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      }
    )
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) throw new Error('acquire failed')
    const released = await authority.release(acquired.tokens[0])
    expect(released.ok).toBe(true)
  }
  return authority
}

describe('workspace-lock WAL checkpoint', () => {
  it('seals history, keeps a bounded tail, and replays to the identical state', async () => {
    const h = harness()
    const authority = await buildHistory(h, 12)
    const before = authority.snapshot()
    const beforeFullState = decodeWorkspaceLockWal(h.persistence.readEvents().raw)

    const outcome = await authority.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 4 })
    expect(outcome).toMatchObject({ compacted: true, retainedFrameCount: 4 })
    if (!outcome.compacted) throw new Error('expected compaction')
    expect(outcome.afterByteLength).toBeLessThan(outcome.beforeByteLength)
    expect(fs.existsSync(path.join(h.archiveDir, outcome.archiveFilename))).toBe(true)
    expect(outcome.archiveFilename).toBe(workspaceLockWalArchiveFilename(outcome.boundarySequence))

    // A fresh authority must reconstruct the same authority state from the
    // checkpoint plus the short tail.
    const reopened = await WorkspaceLockAuthority.open({
      persistence: new NodeWorkspaceLockPersistence({ userDataRoot: h.userData }),
      dependencies: h.dependencies
    })
    expect(reopened.replaySource()).toBe('checkpoint')
    const after = reopened.snapshot()
    expect(after.sequence).toBeGreaterThan(before.sequence)
    expect(after.leases).toEqual(before.leases)

    const resolved = resolveWorkspaceLockWalState(
      h.persistence.readEvents().raw,
      decodeWorkspaceLockWalCheckpoint(fs.readFileSync(h.checkpointPath, 'utf8'))
    )
    expect(resolved.state.transitionIds).toEqual(
      beforeFullState.transitionIds.concat(
        resolved.state.transitionIds.slice(beforeFullState.sequence)
      )
    )
    expect(resolved.state.leaseIds).toEqual(beforeFullState.leaseIds)
    expect(resolved.state.events.length).toBeLessThan(resolved.state.sequence)
    authority.dispose()
    reopened.dispose()
  }, 60_000)

  it('does not compact below its byte threshold or when there is nothing to seal', async () => {
    const h = harness()
    const authority = await buildHistory(h, 2)
    expect(await authority.compactIfNeeded()).toMatchObject({
      compacted: false,
      reason: 'below_threshold'
    })
    expect(
      await authority.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 100_000 })
    ).toMatchObject({ compacted: false, reason: 'nothing_to_seal' })
    authority.dispose()
  }, 30_000)

  it('keeps every transition and lease id, so an old id is still refused', async () => {
    const h = harness()
    const authority = await buildHistory(h, 10)
    const full = decodeWorkspaceLockWal(h.persistence.readEvents().raw)
    const oldTransitionId = full.events[2].transitionId

    await authority.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 2 })
    const compacted = resolveWorkspaceLockWalState(
      h.persistence.readEvents().raw,
      decodeWorkspaceLockWalCheckpoint(fs.readFileSync(h.checkpointPath, 'utf8'))
    ).state
    expect(compacted.transitionIds).toContain(oldTransitionId)
    expect(full.leaseIds.every((id) => compacted.leaseIds.includes(id))).toBe(true)

    // The event itself is no longer replayable, so an idempotent retry of a
    // sealed transition must be refused rather than silently re-acquiring.
    const reopened = await WorkspaceLockAuthority.open({
      persistence: new NodeWorkspaceLockPersistence({ userDataRoot: h.userData }),
      dependencies: h.dependencies
    })
    const replayed = await reopened.acquire(
      owner({ lockOwnerId: 'owner-2', runId: 'run-2' }),
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      },
      { transitionId: oldTransitionId }
    )
    expect(replayed).toMatchObject({ ok: false, reason: 'invalid_request' })
    expect(replayed.ok === false && replayed.message).toMatch(/already used/i)
    authority.dispose()
    reopened.dispose()
  }, 60_000)

  it('still replays a transition inside the retained tail window', async () => {
    const h = harness()
    const authority = await buildHistory(h, 10)
    await authority.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 8 })

    const reopened = await WorkspaceLockAuthority.open({
      persistence: new NodeWorkspaceLockPersistence({ userDataRoot: h.userData }),
      dependencies: h.dependencies
    })
    const first = await reopened.acquire(
      owner({ lockOwnerId: 'retry-owner', runId: 'retry-run' }),
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'b.ts')
      },
      { transitionId: 'retry-transition' }
    )
    expect(first.ok).toBe(true)
    const retried = await reopened.acquire(
      owner({ lockOwnerId: 'retry-owner', runId: 'retry-run' }),
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'b.ts')
      },
      { transitionId: 'retry-transition' }
    )
    expect(retried).toMatchObject({ ok: true, transitionId: 'retry-transition' })
    expect(first.ok && retried.ok && first.leases[0].leaseId).toBe(
      retried.ok ? retried.leases[0].leaseId : null
    )
    authority.dispose()
    reopened.dispose()
  }, 60_000)

  it('carries active leases, recovered leases and markers across a checkpoint', async () => {
    const h = harness()
    const authority = await buildHistory(h, 8)
    const held = await authority.acquire(owner({ lockOwnerId: 'held-owner', runId: 'held-run' }), {
      workspacePath: h.workspace,
      kind: 'file',
      targetPath: path.join(h.workspace, 'src', 'c.ts')
    })
    expect(held.ok).toBe(true)
    const beforeMarkers = decodeWorkspaceLockWal(h.persistence.readEvents().raw).knownMarkers
    expect(beforeMarkers.length).toBeGreaterThan(0)

    await authority.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 1 })
    const checkpoint = decodeWorkspaceLockWalCheckpoint(fs.readFileSync(h.checkpointPath, 'utf8'))
    expect(checkpoint.activeLeases.map((lease) => lease.owner.runId)).toContain('held-run')

    // The checkpoint holds the marker inventory as of its own boundary, which
    // may still list a provisional marker the tail later retires. What must
    // match is the reconstructed state, not the checkpoint in isolation.
    const resolved = resolveWorkspaceLockWalState(h.persistence.readEvents().raw, checkpoint)
    expect(resolved.state.knownMarkers).toEqual(beforeMarkers)

    const reopened = await WorkspaceLockAuthority.open({
      persistence: new NodeWorkspaceLockPersistence({ userDataRoot: h.userData }),
      dependencies: h.dependencies
    })
    expect(reopened.snapshot().leases.map((lease) => lease.owner.runId)).toContain('held-run')
    authority.dispose()
    reopened.dispose()
  }, 60_000)

  describe('crash at each publication step', () => {
    it('crash after sealing leaves an inert segment and a full legacy replay', async () => {
      const h = harness()
      const authority = await buildHistory(h, 8)
      const expected = authority.snapshot()
      vi.spyOn(h.persistence, 'writeCheckpointDocument').mockImplementationOnce(() => {
        throw new Error('injected crash after archive')
      })
      await expect(
        authority.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 2 })
      ).rejects.toThrow(/injected crash after archive/)
      vi.restoreAllMocks()

      expect(fs.existsSync(h.checkpointPath)).toBe(false)
      expect(fs.readdirSync(h.archiveDir).length).toBe(1)
      const reopened = await WorkspaceLockAuthority.open({
        persistence: new NodeWorkspaceLockPersistence({ userDataRoot: h.userData }),
        dependencies: h.dependencies
      })
      expect(reopened.replaySource()).toBe('legacy')
      expect(reopened.snapshot().leases).toEqual(expected.leases)
      authority.dispose()
      reopened.dispose()
    }, 60_000)

    it('crash after publishing but before truncating ignores the checkpoint', async () => {
      const h = harness()
      const authority = await buildHistory(h, 8)
      const expected = authority.snapshot()
      vi.spyOn(h.persistence, 'truncateEventsToSuffix').mockImplementationOnce(() => {
        throw new Error('injected crash after checkpoint')
      })
      await expect(
        authority.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 2 })
      ).rejects.toThrow(/injected crash after checkpoint/)
      vi.restoreAllMocks()

      expect(fs.existsSync(h.checkpointPath)).toBe(true)
      const reopened = await WorkspaceLockAuthority.open({
        persistence: new NodeWorkspaceLockPersistence({ userDataRoot: h.userData }),
        dependencies: h.dependencies
      })
      // The tail is still the whole history, so the checkpoint is superseded.
      expect(reopened.replaySource()).toBe('checkpoint-superseded')
      expect(reopened.snapshot().leases).toEqual(expected.leases)

      // And the next compaction repairs the situation.
      expect(
        await reopened.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 2 })
      ).toMatchObject({ compacted: true })
      const repaired = await WorkspaceLockAuthority.open({
        persistence: new NodeWorkspaceLockPersistence({ userDataRoot: h.userData }),
        dependencies: h.dependencies
      })
      expect(repaired.replaySource()).toBe('checkpoint')
      authority.dispose()
      reopened.dispose()
      repaired.dispose()
    }, 60_000)

    it('refuses to boot when a checkpoint is lost and the tail cannot chain to zero', async () => {
      const h = harness()
      const authority = await buildHistory(h, 8)
      await authority.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 2 })
      fs.unlinkSync(h.checkpointPath)
      await expect(
        WorkspaceLockAuthority.open({
          persistence: new NodeWorkspaceLockPersistence({ userDataRoot: h.userData }),
          dependencies: h.dependencies
        })
      ).rejects.toThrow(/no checkpoint to chain it to/i)
      authority.dispose()
    }, 60_000)
  })

  describe('tampering and corruption', () => {
    it('rejects a checkpoint whose digest does not cover its contents', async () => {
      const h = harness()
      const authority = await buildHistory(h, 8)
      await authority.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 2 })
      const raw = JSON.parse(fs.readFileSync(h.checkpointPath, 'utf8'))
      raw.activeLeases = []
      fs.writeFileSync(h.checkpointPath, `${JSON.stringify(raw)}\n`)
      await expect(
        WorkspaceLockAuthority.open({
          persistence: new NodeWorkspaceLockPersistence({ userDataRoot: h.userData }),
          dependencies: h.dependencies
        })
      ).rejects.toThrow(/checkpoint digest mismatch/i)
      authority.dispose()
    }, 60_000)

    it('rejects a checkpoint that does not anchor the tail it precedes', async () => {
      const h = harness()
      const authority = await buildHistory(h, 8)
      await authority.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 2 })
      const checkpoint = decodeWorkspaceLockWalCheckpoint(fs.readFileSync(h.checkpointPath, 'utf8'))
      const tail = fs.readFileSync(h.eventsPath, 'utf8')
      const forged = { ...checkpoint, lastDigest: 'f'.repeat(64) }
      expect(() => resolveWorkspaceLockWalState(tail, forged as typeof checkpoint)).toThrow(
        /does not continue checkpoint/i
      )
      authority.dispose()
    }, 60_000)

    it('rejects an archive segment reference the checkpoint does not seal', async () => {
      const h = harness()
      const authority = await buildHistory(h, 8)
      await authority.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 2 })
      const raw = JSON.parse(fs.readFileSync(h.checkpointPath, 'utf8'))
      raw.archivedSegments = []
      fs.writeFileSync(h.checkpointPath, `${JSON.stringify(raw)}\n`)
      expect(() =>
        decodeWorkspaceLockWalCheckpoint(fs.readFileSync(h.checkpointPath, 'utf8'))
      ).toThrow(/does not name the segment it seals/i)
      authority.dispose()
    }, 60_000)

    it('refuses to truncate to frames that are not the exact live suffix', async () => {
      const h = harness()
      const authority = await buildHistory(h, 4)
      const snapshot = h.persistence.readEvents()
      expect(() =>
        h.persistence.truncateEventsToSuffix(snapshot.byteLength, '{"not":"a suffix"}\n')
      ).toThrow(/not the exact live WAL suffix/i)
      expect(h.persistence.readEvents().raw).toBe(snapshot.raw)
      authority.dispose()
    }, 30_000)
  })

  describe('concurrency', () => {
    it('a concurrent appender that raced a truncation fails its byte fence', async () => {
      const h = harness()
      const authority = await buildHistory(h, 8)
      const stale = h.persistence.readEvents()
      await authority.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 2 })
      expect(() => h.persistence.appendEvent('{"stale":true}\n', stale.byteLength)).toThrow(
        /byte fence changed|must be exactly one/i
      )
      authority.dispose()
    }, 60_000)

    it('a second instance opened after compaction sees the same authority state', async () => {
      const h = harness()
      const first = await buildHistory(h, 8)
      const held = await first.acquire(owner({ lockOwnerId: 'shared', runId: 'shared-run' }), {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'c.ts')
      })
      expect(held.ok).toBe(true)
      await first.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 2 })

      const second = await WorkspaceLockAuthority.open({
        persistence: new NodeWorkspaceLockPersistence({ userDataRoot: h.userData }),
        dependencies: {
          ...h.dependencies,
          instance: { ...h.dependencies.instance, instanceId: 'second-instance' }
        }
      })
      // The still-held lease must keep blocking a conflicting acquisition.
      const conflict = await second.acquire(
        owner({
          lockOwnerId: 'other',
          runId: 'other-run',
          pid: 202,
          processBirthIdentity: 'owner-b-birth'
        }),
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'c.ts')
        }
      )
      expect(conflict).toMatchObject({ ok: false, reason: 'conflict' })
      first.dispose()
      second.dispose()
    }, 60_000)

    it('compaction is a no-op on an authority whose persistence lacks the primitives', async () => {
      const h = harness()
      const authority = await buildHistory(h, 2)
      authority.dispose()
      const legacy = await WorkspaceLockAuthority.open({
        persistence: {
          readEvents: () => h.persistence.readEvents(),
          appendEvent: (line, expected) => h.persistence.appendEvent(line, expected),
          confirmEventsDurable: (expected) => h.persistence.confirmEventsDurable(expected),
          repairTornEventTail: (expected, prefix) =>
            h.persistence.repairTornEventTail(expected, prefix),
          acquireInstanceFence: (fence) => h.persistence.acquireInstanceFence(fence),
          replaceInstanceFence: (id, fence) => h.persistence.replaceInstanceFence(id, fence),
          recoverStaleReclaimGuard: (check) => h.persistence.recoverStaleReclaimGuard(check),
          releaseInstanceFence: (id) => h.persistence.releaseInstanceFence(id),
          writeDerivedMarker: (root, name, content, identity) =>
            h.persistence.writeDerivedMarker(root, name, content, identity),
          removeDerivedMarker: (root, name, identity) =>
            h.persistence.removeDerivedMarker(root, name, identity)
        },
        dependencies: h.dependencies
      })
      expect(await legacy.compactIfNeeded({ byteThreshold: 0 })).toMatchObject({
        compacted: false,
        reason: 'unsupported'
      })
      legacy.dispose()
    }, 30_000)
  })

  it('migrates a legacy v1 authority root that has never been compacted', async () => {
    const h = harness()
    const authority = await buildHistory(h, 6)
    expect(fs.existsSync(h.checkpointPath)).toBe(false)
    expect(authority.replaySource()).toBe('legacy')
    const before = authority.snapshot()

    expect(
      await authority.compactIfNeeded({ byteThreshold: 0, retainedTailEvents: 2 })
    ).toMatchObject({ compacted: true })

    const migrated = await WorkspaceLockAuthority.open({
      persistence: new NodeWorkspaceLockPersistence({ userDataRoot: h.userData }),
      dependencies: h.dependencies
    })
    expect(migrated.replaySource()).toBe('checkpoint')
    expect(migrated.snapshot().leases).toEqual(before.leases)
    authority.dispose()
    migrated.dispose()
  }, 60_000)
})
