import * as nodeFs from 'node:fs'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  NodeWorkspaceLockPersistence,
  WORKSPACE_LOCK_AUTHORITY_DIRECTORY,
  WORKSPACE_LOCK_EVENTS_FILENAME,
  WORKSPACE_LOCK_HOLDERS_DIRECTORY,
  WORKSPACE_LOCK_INSTANCE_FENCE_FILENAME,
  WORKSPACE_LOCK_RECLAIM_AUDIT_FILENAME,
  WORKSPACE_LOCK_RECLAIM_GUARD_FILENAME
} from './NodeWorkspaceLockPersistence'
import type {
  NodeWorkspaceLockPersistenceAsyncFs,
  NodeWorkspaceLockPersistenceFs
} from './NodeWorkspaceLockPersistence'
import {
  WORKSPACE_LOCK_HEARTBEAT_SCHEMA,
  workspaceLockHolderHeartbeatFilename,
  type WorkspaceLockHolderHeartbeat
} from './WorkspaceLockHolderHeartbeat'
import type { WorkspaceLockAuthorityFence } from './WorkspaceLockTypes'

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

function canonicalRealpath(path: string): string {
  const realpath =
    typeof nodeFs.realpathSync.native === 'function'
      ? nodeFs.realpathSync.native
      : nodeFs.realpathSync
  return realpath(path)
}

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createStore(): { root: string; store: NodeWorkspaceLockPersistence } {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-work-locks-'))
  temporaryRoots.push(root)
  return { root, store: new NodeWorkspaceLockPersistence({ userDataRoot: root }) }
}

function fence(fenceId: string, generation = 1): WorkspaceLockAuthorityFence {
  return {
    instanceId: 'desktop-instance',
    generation,
    pid: 123,
    processBirthIdentity: 'birth-receipt',
    fenceId,
    acquiredAt: '2026-07-29T12:00:00.000Z'
  }
}

describe('NodeWorkspaceLockPersistence', () => {
  it('appends fsynced JSONL frames behind an exact byte fence', () => {
    const { root, store } = createStore()
    const empty = store.readEvents()
    expect(empty).toMatchObject({ raw: '', byteLength: 0, revision: 'absent' })

    const first = '{"kind":"acquire","id":"a"}\n'
    const firstLength = store.appendEvent(first, 0)
    expect(firstLength).toBe(Buffer.byteLength(first))
    const firstSnapshot = store.readEvents()
    expect(firstSnapshot).toMatchObject({ raw: first, byteLength: firstLength })
    expect(store.readEventsRevision()).toBe(firstSnapshot.revision)
    expect(firstSnapshot.revision).not.toBe(empty.revision)

    expect(() => store.appendEvent('{"kind":"release","id":"a"}\n', 0)).toThrow(
      /byte fence changed/i
    )
    const second = '{"kind":"release","id":"a"}\n'
    const totalLength = store.appendEvent(second, firstLength)
    expect(totalLength).toBe(Buffer.byteLength(`${first}${second}`))
    expect(store.readEventsRevision()).not.toBe(firstSnapshot.revision)
    expect(
      readFileSync(
        join(root, WORKSPACE_LOCK_AUTHORITY_DIRECTORY, WORKSPACE_LOCK_EVENTS_FILENAME),
        'utf8'
      )
    ).toBe(`${first}${second}`)
  })

  it('does not reread a validated append-only prefix for every new frame', () => {
    const root = mkdtempSync(join(tmpdir(), 'taskwraith-work-lock-append-cache-'))
    temporaryRoots.push(root)
    const baseFs = nodeFs as unknown as NodeWorkspaceLockPersistenceFs
    let fileReads = 0
    const countingFs: NodeWorkspaceLockPersistenceFs = {
      ...baseFs,
      readFileSync: (fd) => {
        fileReads += 1
        return baseFs.readFileSync(fd)
      }
    }
    const store = new NodeWorkspaceLockPersistence({ userDataRoot: root, fs: countingFs })
    let byteLength = 0

    for (let index = 0; index < 100; index += 1) {
      byteLength = store.appendEvent(`${JSON.stringify({ index })}\n`, byteLength)
    }

    expect(fileReads).toBe(0)
    expect(store.readEvents()).toMatchObject({ byteLength })
    expect(fileReads).toBe(1)
  })

  it('uses a write-capable WAL handle for durable confirmation on Windows', () => {
    const root = mkdtempSync(join(tmpdir(), 'taskwraith-work-lock-windows-fsync-'))
    temporaryRoots.push(root)
    const baseFs = nodeFs as unknown as NodeWorkspaceLockPersistenceFs
    const openFlags = new Map<number, number>()
    const windowsFs: NodeWorkspaceLockPersistenceFs = {
      ...baseFs,
      openSync: (path, flags, mode) => {
        const fd = baseFs.openSync(path, flags, mode)
        openFlags.set(fd, flags)
        return fd
      },
      fsyncSync: (fd) => {
        const flags = openFlags.get(fd)
        if (flags !== undefined && (flags & baseFs.constants.O_WRONLY) === 0) {
          const error = new Error(
            'injected Windows read-handle fsync refusal'
          ) as NodeJS.ErrnoException
          error.code = 'EPERM'
          throw error
        }
        baseFs.fsyncSync(fd)
      },
      closeSync: (fd) => {
        openFlags.delete(fd)
        baseFs.closeSync(fd)
      }
    }
    const store = new NodeWorkspaceLockPersistence({
      userDataRoot: root,
      platform: 'win32',
      fs: windowsFs
    })
    const frame = '{"kind":"acquire","id":"windows"}\n'
    const byteLength = store.appendEvent(frame, 0)

    expect(() => store.confirmEventsDurable(byteLength)).not.toThrow()
  })

  it('fails closed on a malformed WAL rather than returning a partial history', () => {
    const { root, store } = createStore()
    const authority = join(root, WORKSPACE_LOCK_AUTHORITY_DIRECTORY)
    store.readEvents()
    writeFileSync(join(authority, WORKSPACE_LOCK_EVENTS_FILENAME), '{"valid":true}\nnot-json\n')

    expect(() => store.readEvents()).toThrow(/corrupt/i)
    expect(() =>
      store.appendEvent('{"kind":"acquire"}\n', Buffer.byteLength('{"valid":true}\nnot-json\n'))
    ).toThrow(/corrupt/i)
    expect(() =>
      store.repairTornEventTail(Buffer.byteLength('{"valid":true}\nnot-json\n'), '{"valid":true}\n')
    ).toThrow(/corrupt/i)
  })

  it('passes an uncommitted torn WAL tail through for codec recovery', () => {
    const { root, store } = createStore()
    const authority = join(root, WORKSPACE_LOCK_AUTHORITY_DIRECTORY)
    store.readEvents()
    const raw = '{"valid":true}\n{"torn"'
    writeFileSync(join(authority, WORKSPACE_LOCK_EVENTS_FILENAME), raw)

    expect(store.readEvents()).toMatchObject({ raw, byteLength: Buffer.byteLength(raw) })
    expect(() => store.appendEvent('{"later":true}\n', Buffer.byteLength(raw))).toThrow(
      /torn tail/i
    )
    const completePrefix = '{"valid":true}\n'
    const repairedLength = store.repairTornEventTail(Buffer.byteLength(raw), completePrefix)
    expect(repairedLength).toBe(Buffer.byteLength(completePrefix))
    expect(store.readEvents()).toMatchObject({ raw: completePrefix, byteLength: repairedLength })
    expect(() => store.repairTornEventTail(Buffer.byteLength(raw), completePrefix)).toThrow(
      /byte fence changed/i
    )
    const appendedLength = store.appendEvent('{"later":true}\n', repairedLength)
    expect(store.readEvents()).toMatchObject({
      raw: `${completePrefix}{"later":true}\n`,
      byteLength: appendedLength
    })
  })

  it('uses unique fence ids to reclaim stale transition mutexes and reject ABA release', () => {
    const { root, store } = createStore()
    const first = fence('fence-a', 1)
    const second = fence('fence-b', 2)

    expect(store.acquireInstanceFence(first)).toEqual({ ok: true })
    expect(store.acquireInstanceFence(fence('foreign'))).toEqual({ ok: false, existing: first })
    const liveContender = new NodeWorkspaceLockPersistence({ userDataRoot: root })
    expect(liveContender.acquireInstanceFence(second)).toEqual({ ok: false, existing: first })
    let delayedResult: ReturnType<NodeWorkspaceLockPersistence['acquireInstanceFence']> | undefined
    const delayedContender = new NodeWorkspaceLockPersistence({ userDataRoot: root })
    const staleContender = new NodeWorkspaceLockPersistence({
      userDataRoot: root,
      onReclaimGuardAcquired: () => {
        delayedResult = delayedContender.replaceInstanceFence(first.fenceId, fence('fence-c', 3))
      }
    })
    expect(staleContender.replaceInstanceFence(first.fenceId, second)).toEqual({ ok: true })
    expect(delayedResult).toEqual({ ok: false, existing: first })
    expect(store.releaseInstanceFence(first.fenceId)).toBe(false)
    expect(store.releaseInstanceFence('foreign-fence')).toBe(false)
    expect(staleContender.readInstanceFence()).toEqual(second)
    expect(staleContender.releaseInstanceFence(second.fenceId)).toBe(true)
    expect(staleContender.readInstanceFence()).toBeNull()
  })

  it('accepts a fresh contender fence installed immediately after exact release', () => {
    const root = mkdtempSync(join(tmpdir(), 'taskwraith-work-lock-release-race-'))
    temporaryRoots.push(root)
    const original = fence('fence-release-owner', 1)
    const replacement = fence('fence-next-contender', 2)
    const fencePath = join(
      root,
      WORKSPACE_LOCK_AUTHORITY_DIRECTORY,
      WORKSPACE_LOCK_INSTANCE_FENCE_FILENAME
    )
    const baseFs = nodeFs as unknown as NodeWorkspaceLockPersistenceFs
    let installReplacement = true
    const racingFs: NodeWorkspaceLockPersistenceFs = {
      ...baseFs,
      unlinkSync: (target) => {
        baseFs.unlinkSync(target)
        if (installReplacement && target === fencePath) {
          installReplacement = false
          writeFileSync(fencePath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 })
        }
      }
    }
    const owner = new NodeWorkspaceLockPersistence({ userDataRoot: root })
    const releaser = new NodeWorkspaceLockPersistence({ userDataRoot: root, fs: racingFs })

    expect(owner.acquireInstanceFence(original)).toEqual({ ok: true })
    expect(releaser.releaseInstanceFence(original.fenceId)).toBe(true)
    expect(owner.readInstanceFence()).toEqual(replacement)
    expect(owner.releaseInstanceFence(replacement.fenceId)).toBe(true)
  })

  it('quarantines only the observed stale guard and never unlinks a replacement pathname', async () => {
    const { root, store } = createStore()
    store.readEvents()
    const authority = join(root, WORKSPACE_LOCK_AUTHORITY_DIRECTORY)
    const guardPath = join(authority, WORKSPACE_LOCK_RECLAIM_GUARD_FILENAME)
    const staleGuard = {
      guardId: 'guard-stale',
      expectedFenceId: 'fence-stale',
      contender: fence('contender-stale')
    }
    const replacementGuard = {
      guardId: 'guard-replacement',
      expectedFenceId: 'fence-replacement',
      contender: fence('contender-replacement')
    }
    writeFileSync(guardPath, `${JSON.stringify(staleGuard)}\n`)

    expect(
      await store.recoverStaleReclaimGuard(async () => {
        rmSync(guardPath)
        writeFileSync(guardPath, `${JSON.stringify(replacementGuard)}\n`)
        return true
      })
    ).toBe(false)
    expect(JSON.parse(readFileSync(guardPath, 'utf8'))).toEqual(replacementGuard)

    rmSync(guardPath)
    writeFileSync(guardPath, `${JSON.stringify(staleGuard)}\n`)
    const newestGuard = {
      guardId: 'guard-newest',
      expectedFenceId: 'fence-newest',
      contender: fence('contender-newest')
    }
    const rescuer = new NodeWorkspaceLockPersistence({
      userDataRoot: root,
      onStaleReclaimGuardQuarantined: () => {
        writeFileSync(guardPath, `${JSON.stringify(newestGuard)}\n`)
      }
    })
    expect(await rescuer.recoverStaleReclaimGuard(async () => true)).toBe(true)
    expect(JSON.parse(readFileSync(guardPath, 'utf8'))).toEqual(newestGuard)
  })

  it('never publishes a truncated canonical fence when atomic link publication fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'taskwraith-work-lock-fault-'))
    temporaryRoots.push(root)
    const fault = new Error('injected link failure') as NodeJS.ErrnoException
    fault.code = 'EIO'
    const baseFs = nodeFs as unknown as NodeWorkspaceLockPersistenceFs
    const faultFs: NodeWorkspaceLockPersistenceFs = {
      ...baseFs,
      linkSync: () => {
        throw fault
      }
    }
    const store = new NodeWorkspaceLockPersistence({
      userDataRoot: root,
      fs: faultFs
    })

    expect(() => store.acquireInstanceFence(fence('never-published'))).toThrow(
      /injected link failure/i
    )
    const authority = join(root, WORKSPACE_LOCK_AUTHORITY_DIRECTORY)
    expect(nodeFs.existsSync(join(authority, WORKSPACE_LOCK_INSTANCE_FENCE_FILENAME))).toBe(false)
    expect(nodeFs.readdirSync(authority).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('atomically creates, replaces, and removes per-worktree derived markers', () => {
    const { root, store } = createStore()
    const worktree = join(root, 'checkout')
    mkdirSync(worktree)
    const canonicalWorktree = canonicalRealpath(worktree)
    // bigint: the store compares a bigint dev/ino identity, and NTFS file ids exceed 2^53.
    const initialStat = lstatSync(canonicalWorktree, { bigint: true })
    const worktreeIdentity = `dev:${initialStat.dev}:ino:${initialStat.ino}`
    const markerName = `.WORK-IN-PROGRESS-taskwraith-runtime-desktop-${'a'.repeat(64)}.md`

    expect(store.readDerivedMarker(canonicalWorktree, markerName)).toBeNull()
    store.writeDerivedMarker(canonicalWorktree, markerName, 'first', worktreeIdentity)
    expect(store.readDerivedMarker(canonicalWorktree, markerName)).toBe('first')
    store.writeDerivedMarker(canonicalWorktree, markerName, 'second', worktreeIdentity)
    expect(store.readDerivedMarker(canonicalWorktree, markerName)).toBe('second')
    expect(store.removeDerivedMarker(canonicalWorktree, markerName, worktreeIdentity)).toBe(true)
    expect(store.readDerivedMarker(canonicalWorktree, markerName)).toBeNull()
    expect(store.removeDerivedMarker(canonicalWorktree, markerName, worktreeIdentity)).toBe(false)
    nodeFs.rmSync(worktree, { recursive: true })
    expect(store.removeDerivedMarker(canonicalWorktree, markerName, worktreeIdentity)).toBe(false)

    mkdirSync(worktree)
    const replacementStat = lstatSync(canonicalWorktree, { bigint: true })
    const replacementIdentity = `dev:${replacementStat.dev}:ino:${replacementStat.ino}`
    store.writeDerivedMarker(canonicalWorktree, markerName, 'private', replacementIdentity)
    expectOwnerOnly(join(worktree, markerName))
  })

  it('never follows a substituted or recreated marker root', () => {
    const { root, store } = createStore()
    const worktree = join(root, 'checkout')
    const movedWorktree = join(root, 'checkout-moved')
    const outside = join(root, 'outside')
    mkdirSync(worktree)
    mkdirSync(outside)
    const canonicalWorktree = canonicalRealpath(worktree)
    const originalStat = lstatSync(canonicalWorktree, { bigint: true })
    const originalIdentity = `dev:${originalStat.dev}:ino:${originalStat.ino}`
    const markerName = `.WORK-IN-PROGRESS-taskwraith-runtime-desktop-${'b'.repeat(64)}.md`
    store.writeDerivedMarker(canonicalWorktree, markerName, 'original', originalIdentity)

    nodeFs.renameSync(worktree, movedWorktree)
    nodeFs.symlinkSync(outside, worktree, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() =>
      store.writeDerivedMarker(canonicalWorktree, markerName, 'redirected', originalIdentity)
    ).toThrow(/no-follow|canonical path/i)
    expect(store.removeDerivedMarker(canonicalWorktree, markerName, originalIdentity)).toBe(false)
    expect(nodeFs.existsSync(join(outside, markerName))).toBe(false)
    nodeFs.unlinkSync(worktree)

    mkdirSync(worktree)
    expect(() =>
      store.writeDerivedMarker(canonicalWorktree, markerName, 'recreated', originalIdentity)
    ).toThrow(/physical identity changed/i)
    expect(store.removeDerivedMarker(canonicalWorktree, markerName, originalIdentity)).toBe(false)
    expect(nodeFs.existsSync(join(worktree, markerName))).toBe(false)
    expect(nodeFs.readFileSync(join(movedWorktree, markerName), 'utf8')).toBe('original')
  })

  it('creates private authority artefacts and rejects a substituted symlink', () => {
    const { root, store } = createStore()
    const authority = join(root, WORKSPACE_LOCK_AUTHORITY_DIRECTORY)
    const event = '{"kind":"acquire"}\n'
    store.appendEvent(event, 0)
    expectOwnerOnly(authority)
    expectOwnerOnly(join(authority, WORKSPACE_LOCK_EVENTS_FILENAME))
    expect(store.acquireInstanceFence(fence('fence-private'))).toEqual({ ok: true })
    expectOwnerOnly(join(authority, WORKSPACE_LOCK_INSTANCE_FENCE_FILENAME))

    const target = join(root, 'outside.jsonl')
    writeFileSync(target, '{"outside":true}\n')
    rmSync(join(authority, WORKSPACE_LOCK_EVENTS_FILENAME))
    symlinkSync(target, join(authority, WORKSPACE_LOCK_EVENTS_FILENAME))
    expect(() => store.readEvents()).toThrow(/regular file/i)
  })
})

describe('NodeWorkspaceLockPersistence holder heartbeats', () => {
  const holder = { instanceId: 'desktop-instance', pid: 123, processBirthIdentity: 'birth-receipt' }

  function heartbeat(
    beatSeq: number,
    beatAt = '2026-09-23T10:00:00.000Z'
  ): WorkspaceLockHolderHeartbeat {
    return {
      schema: WORKSPACE_LOCK_HEARTBEAT_SCHEMA,
      ...holder,
      generation: 4,
      beatSeq,
      monotonicMs: 1_000 * beatSeq,
      beatAt
    }
  }

  function recordingAsyncFs(calls: string[]): NodeWorkspaceLockPersistenceAsyncFs {
    return {
      mkdir: (path, options) => {
        calls.push('mkdir')
        return nodeFs.promises.mkdir(path, options)
      },
      writeFile: (path, data, options) => {
        calls.push('writeFile')
        return nodeFs.promises.writeFile(path, data, options)
      },
      rename: (oldPath, newPath) => {
        calls.push('rename')
        return nodeFs.promises.rename(oldPath, newPath)
      },
      unlink: (path) => {
        calls.push('unlink')
        return nodeFs.promises.unlink(path)
      },
      appendFile: (path, data, options) => {
        calls.push('appendFile')
        return nodeFs.promises.appendFile(path, data, options)
      }
    }
  }

  /** Boot always creates the authority root before the first beat; tests do the same. */
  function createBootedStore(): { root: string; store: NodeWorkspaceLockPersistence } {
    const created = createStore()
    created.store.readEventsRevision()
    return created
  }

  it('writes the sidecar asynchronously with private modes and never an fsync', async () => {
    const root = mkdtempSync(join(tmpdir(), 'taskwraith-work-locks-'))
    temporaryRoots.push(root)
    new NodeWorkspaceLockPersistence({ userDataRoot: root }).readEventsRevision()
    const calls: string[] = []
    let fsyncs = 0
    const countingFs: NodeWorkspaceLockPersistenceFs = {
      ...(nodeFs as unknown as NodeWorkspaceLockPersistenceFs),
      fsyncSync: (fd) => {
        fsyncs += 1
        nodeFs.fsyncSync(fd)
      }
    }
    const asyncFs = recordingAsyncFs(calls)
    const store = new NodeWorkspaceLockPersistence({ userDataRoot: root, fs: countingFs, asyncFs })

    await store.writeHolderHeartbeat(heartbeat(1))

    expect(calls).toEqual(['mkdir', 'writeFile', 'rename'])
    expect(fsyncs).toBe(0)
    expect(Object.keys(asyncFs).sort()).toEqual([
      'appendFile',
      'mkdir',
      'rename',
      'unlink',
      'writeFile'
    ])
    const holders = join(root, WORKSPACE_LOCK_AUTHORITY_DIRECTORY, WORKSPACE_LOCK_HOLDERS_DIRECTORY)
    const path = join(holders, workspaceLockHolderHeartbeatFilename(holder))
    expectOwnerOnly(holders)
    expectOwnerOnly(path)
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true)
    expect(nodeFs.readdirSync(holders)).toEqual([workspaceLockHolderHeartbeatFilename(holder)])
    expect(store.readHolderHeartbeats()).toEqual({ heartbeats: [heartbeat(1)], errors: [] })

    await store.writeHolderHeartbeat(heartbeat(2, '2026-09-23T10:00:10.000Z'))
    expect(store.readHolderHeartbeats().heartbeats).toEqual([
      heartbeat(2, '2026-09-23T10:00:10.000Z')
    ])
    expect(nodeFs.readdirSync(holders)).toEqual([workspaceLockHolderHeartbeatFilename(holder)])
  })

  it('reads nothing before the directory exists and skips malformed or foreign files with a report', async () => {
    const { root, store } = createBootedStore()
    expect(store.readHolderHeartbeats()).toEqual({ heartbeats: [], errors: [] })

    await store.writeHolderHeartbeat(heartbeat(1))
    const holders = join(root, WORKSPACE_LOCK_AUTHORITY_DIRECTORY, WORKSPACE_LOCK_HOLDERS_DIRECTORY)
    writeFileSync(join(holders, 'garbage.json'), '{"schema":"other"}\n')
    writeFileSync(join(holders, 'torn.json'), '{"sche')
    writeFileSync(join(holders, '.leftover.tmp'), 'x')
    writeFileSync(join(holders, WORKSPACE_LOCK_RECLAIM_AUDIT_FILENAME), '{"a":1}\n')

    const result = store.readHolderHeartbeats()
    expect(result.heartbeats).toEqual([heartbeat(1)])
    expect(result.errors).toHaveLength(2)
    expect(result.errors.join(' ')).toContain('garbage.json')
    expect(result.errors.join(' ')).toContain('torn.json')
  })

  it('removes exactly the holder sidecar and appends single-line reclaim audit records', async () => {
    const { root, store } = createBootedStore()
    await store.writeHolderHeartbeat(heartbeat(1))
    await store.writeHolderHeartbeat({
      ...heartbeat(1),
      instanceId: 'other-instance',
      pid: 456,
      processBirthIdentity: 'other-birth'
    })

    expect(store.removeHolderHeartbeat(holder)).toBe(true)
    expect(store.removeHolderHeartbeat(holder)).toBe(false)
    expect(store.readHolderHeartbeats().heartbeats.map((entry) => entry.pid)).toEqual([456])

    await store.appendHolderReclaimAudit('{"leaseId":"lease-1"}\n')
    await store.appendHolderReclaimAudit('{"leaseId":"lease-2"}\n')
    const audit = join(
      root,
      WORKSPACE_LOCK_AUTHORITY_DIRECTORY,
      WORKSPACE_LOCK_HOLDERS_DIRECTORY,
      WORKSPACE_LOCK_RECLAIM_AUDIT_FILENAME
    )
    expect(readFileSync(audit, 'utf8')).toBe('{"leaseId":"lease-1"}\n{"leaseId":"lease-2"}\n')
    expectOwnerOnly(audit)
    await expect(store.appendHolderReclaimAudit('{"a":1}\n{"b":2}\n')).rejects.toThrow(
      /multiple lines/
    )
    expect(readFileSync(audit, 'utf8')).toBe('{"leaseId":"lease-1"}\n{"leaseId":"lease-2"}\n')
  })

  it('never recreates an authority root removed underneath a running holder', async () => {
    const { root, store } = createBootedStore()
    await store.writeHolderHeartbeat(heartbeat(1))
    const authority = join(root, WORKSPACE_LOCK_AUTHORITY_DIRECTORY)
    rmSync(authority, { recursive: true })

    await expect(store.writeHolderHeartbeat(heartbeat(2))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(store.appendHolderReclaimAudit('{"leaseId":"lease-1"}\n')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(nodeFs.existsSync(authority)).toBe(false)
  })

  it('refuses a holders directory that is a symlink as liveness evidence', async () => {
    const { root, store } = createStore()
    const outside = mkdtempSync(join(tmpdir(), 'taskwraith-foreign-holders-'))
    temporaryRoots.push(outside)
    const decoy = createBootedStore()
    await decoy.store.writeHolderHeartbeat(heartbeat(1))
    nodeFs.cpSync(
      join(decoy.root, WORKSPACE_LOCK_AUTHORITY_DIRECTORY, WORKSPACE_LOCK_HOLDERS_DIRECTORY),
      outside,
      { recursive: true }
    )
    mkdirSync(join(root, WORKSPACE_LOCK_AUTHORITY_DIRECTORY), { recursive: true, mode: 0o700 })
    symlinkSync(
      outside,
      join(root, WORKSPACE_LOCK_AUTHORITY_DIRECTORY, WORKSPACE_LOCK_HOLDERS_DIRECTORY),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect(nodeFs.readdirSync(outside)).toEqual([workspaceLockHolderHeartbeatFilename(holder)])

    const result = store.readHolderHeartbeats()
    expect(result.heartbeats).toEqual([])
    expect(result.errors.join(' ')).toMatch(/not a real directory/)
  })
})
