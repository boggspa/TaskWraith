import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ThreadAuthorityFiles,
  type ThreadAuthorityRead
} from '../host-shared/thread-log/ThreadAuthorityFile'
import {
  THREAD_LOG_BATCH_FORMAT,
  THREAD_LOG_BATCH_VERSION
} from '../host-shared/thread-log/ThreadLogBatch'
import { THREAD_LOG_AUTHORITY_ENV } from '../host-shared/thread-log/ThreadLogAuthoritySwitch'
import { TASKWRAITH_HOST_TXN_PERSIST_ENV } from './HostCommandExecutionClass'
import {
  HostThreadOwnerService,
  threadLogDirectory,
  type HostThreadOwnerServiceOptions
} from './HostThreadOwnerService'

const TEMPORARY_PREFIX = 'host-thread-owner-service-'
const INCARNATION = 'd'.repeat(64)
const ON = { [THREAD_LOG_AUTHORITY_ENV]: '1' }

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  if (
    directory === temporary ||
    path.dirname(directory) !== temporary ||
    !path.basename(directory).startsWith(TEMPORARY_PREFIX) ||
    path.basename(directory).length <= TEMPORARY_PREFIX.length
  ) {
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  }
  rmSync(directory, { recursive: true, force: true })
}

let profile = ''
let copies: Map<string, number>
let runs: Set<string>
let lines: string[]

beforeEach(() => {
  profile = mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  copies = new Map()
  runs = new Set()
  lines = []
})

afterEach(() => {
  removeTemporaryDirectory(profile)
})

function service(
  environment: Record<string, string>,
  extra: Partial<HostThreadOwnerServiceOptions> = {}
): HostThreadOwnerService {
  return new HostThreadOwnerService({
    environment,
    transactionalPersist: environment[TASKWRAITH_HOST_TXN_PERSIST_ENV] === '1',
    profilePath: profile,
    incarnation: INCARNATION,
    fullCopyRevision: (threadId) => copies.get(threadId) ?? null,
    hostRunActive: (threadId) => runs.has(threadId),
    log: (line) => lines.push(line),
    ...extra
  })
}

const claim = (threadId: string, writerId: string, revisions: [number, number], claimId = 1) => ({
  action: 'claim' as const,
  threadId,
  writerId,
  claimId,
  baseRevision: revisions[0],
  headRevision: revisions[1]
})

function grantOf(result: unknown): { host: string; grant: number } {
  const reply = (result as { reply: { granted: boolean; epoch?: { host: string; grant: number } } })
    .reply
  if (!reply.granted || !reply.epoch) throw new Error(`not granted: ${JSON.stringify(reply)}`)
  return reply.epoch
}

/** A log for the thread whose last whole line is at `revision`. */
function writeLog(threadId: string, revision: number): void {
  const directory = threadLogDirectory(profile)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    path.join(directory, `${threadId}.mutations.jsonl`),
    `${JSON.stringify({
      format: THREAD_LOG_BATCH_FORMAT,
      version: THREAD_LOG_BATCH_VERSION,
      chatId: threadId,
      baseRevision: revision - 1,
      revision,
      savedAt: '2026-10-05T10:00:00.000Z',
      operations: []
    })}\n`
  )
}

async function writeAuthority(threadId: string, writerId: string, pid: number, at: number) {
  await new ThreadAuthorityFiles(profile).write({
    threadId,
    writer: { writerId, pid },
    epoch: { host: 'e'.repeat(64), grant: 1 },
    grantedAtRevision: at,
    grantedAt: Date.now()
  })
}

describe('the Host’s thread owner service', () => {
  it('reads the switch once, and is on only for the exact token without transactional persists', () => {
    expect(service({}).mode).toBe('off')
    expect(service({ [THREAD_LOG_AUTHORITY_ENV]: 'true' }).mode).toBe('off')
    expect(service({ [THREAD_LOG_AUTHORITY_ENV]: '0' }).mode).toBe('off')
    expect(service({ [TASKWRAITH_HOST_TXN_PERSIST_ENV]: '1' }).mode).toBe('off')
    expect(lines).toEqual([])
    const environment: Record<string, string> = { ...ON }
    const on = service(environment)
    expect(on.mode).toBe('on')
    environment[THREAD_LOG_AUTHORITY_ENV] = '0'
    expect(on.mode).toBe('on')
    expect(service({ ...ON, [TASKWRAITH_HOST_TXN_PERSIST_ENV]: '1' }).mode).toBe('off-txn-persist')
    expect(lines).toEqual([expect.stringContaining('takes no thread claims')])
  })

  it('off, refuses every message without reading a file', async () => {
    const files = {
      read: vi.fn(),
      list: vi.fn(),
      remove: vi.fn()
    }
    const off = service({}, { files })
    expect(await off.start()).toBeNull()
    copies.set('thread-1', 3)
    expect(await off.answer(1, claim('thread-1', 'desk-1', [3, 3]))).toEqual({
      kind: 'thread.owner',
      action: 'claim',
      reply: {
        threadId: 'thread-1',
        claimId: 1,
        granted: false,
        reason: 'disabled',
        revision: null
      }
    })
    const epoch = { host: INCARNATION, grant: 1 }
    expect(
      await off.answer(1, { action: 'advanced', threadId: 'thread-1', epoch, revision: 4 })
    ).toEqual({ kind: 'thread.owner', action: 'advanced', recorded: false })
    expect(
      await off.answer(1, { action: 'release', threadId: 'thread-1', epoch, revision: null })
    ).toEqual({ kind: 'thread.owner', action: 'release', released: false })
    off.closed(1)
    expect(files.read).not.toHaveBeenCalled()
    expect(files.list).not.toHaveBeenCalled()
    expect(off.snapshot()).toEqual({ mode: 'off', attached: [], table: null })
  })

  it('on, lists the authority files at start and reports what they hold', async () => {
    const read = (pid: number): Extract<ThreadAuthorityRead, { kind: 'held' }> => ({
      kind: 'held',
      record: {
        threadId: 'x',
        writer: { writerId: `desk-${pid}`, pid },
        epoch: { host: INCARNATION, grant: 1 },
        grantedAtRevision: 1,
        grantedAt: 1
      }
    })
    const files = {
      read: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(async () => [
        { threadId: 'thread-1', read: read(11) },
        { threadId: 'thread-2', read: read(22) },
        { threadId: 'thread-3', read: { kind: 'damaged' as const, reason: 'bad' } }
      ])
    }
    const on = service(ON, {
      files,
      liveness: (writer) => (writer.pid === 11 ? 'alive' : 'dead')
    })
    expect(await on.start()).toEqual({
      held: [{ threadId: 'thread-1', writerId: 'desk-11' }],
      fold: ['thread-2'],
      damaged: ['thread-3']
    })
    expect(lines).toEqual([
      'taskwraith-host: thread owners: 1 held by a live app process, 1 left by an ended one, 1 unreadable\n'
    ])
  })

  it('on, starts though its authority folder cannot be listed, and keeps each thread whose file it cannot read', async () => {
    const unreadable = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const files = {
      list: vi.fn(async () => {
        throw unreadable
      }),
      read: vi.fn(
        async (): Promise<ThreadAuthorityRead> => ({
          kind: 'damaged',
          reason: 'unreadable (EACCES)'
        })
      ),
      remove: vi.fn()
    }
    const on = service(ON, { files })
    copies.set('thread-1', 5)
    expect(await on.start()).toEqual({
      held: [],
      fold: [],
      damaged: [],
      folderUnreadable: 'permission denied'
    })
    expect(lines).toEqual([
      'taskwraith-host: thread owners: the authority folder cannot be listed (permission denied): ' +
        'each thread is judged by its own file, and one that cannot be read is kept as busy\n'
    ])
    const refused = { reply: { granted: false, reason: 'owned_by_other_writer' } }
    expect(await on.answer(1, claim('thread-1', 'desk-1', [5, 5]))).toMatchObject(refused)
    // A read that fails outright is a file it cannot read, too.
    files.read.mockRejectedValueOnce(unreadable)
    expect(await on.answer(1, claim('thread-1', 'desk-1', [5, 5], 2))).toMatchObject(refused)
    expect(on.snapshot().authority).toEqual({
      folderUnreadable: 1,
      lastFolderError: 'permission denied',
      damagedReads: 2,
      damagedThreads: ['thread-1'],
      removeFailures: 0,
      lastRemoveError: null
    })
  })

  it('on, starts on a disk where the authority folder is not a folder', async () => {
    writeFileSync(path.join(profile, 'thread-authority'), 'not a folder')
    const on = service(ON)
    copies.set('thread-1', 5)
    expect(await on.start()).toMatchObject({ folderUnreadable: expect.stringContaining('ENOTDIR') })
    expect(await on.answer(1, claim('thread-1', 'desk-1', [5, 5]))).toMatchObject({
      reply: { granted: false, reason: 'owned_by_other_writer' }
    })
    expect(on.snapshot().authority).toMatchObject({ folderUnreadable: 1, damagedReads: 1 })
  })

  it('off, reads no authority folder, and its snapshot is as it was', async () => {
    writeFileSync(path.join(profile, 'thread-authority'), 'not a folder')
    const off = service({})
    expect(await off.start()).toBeNull()
    expect(lines).toEqual([])
    expect(off.snapshot()).toEqual({ mode: 'off', attached: [], table: null })
  })

  it('on, gives a writer’s threads back once its last connection closes', async () => {
    const on = service(ON)
    copies.set('thread-1', 3)
    copies.set('thread-2', 8)
    grantOf(await on.answer(1, claim('thread-1', 'desk-1', [3, 3])))
    grantOf(await on.answer(2, claim('thread-2', 'desk-1', [8, 8], 2)))
    expect(on.snapshot().attached).toEqual([{ writerId: 'desk-1', connections: 2 }])
    on.closed(1)
    expect(on.snapshot().table!.threads).toHaveLength(2)
    on.closed(2)
    expect(on.snapshot().attached).toEqual([])
    expect(on.snapshot().table!.threads).toEqual([])
    // An unknown connection, or one closed twice, changes nothing.
    on.closed(2)
    on.closed(9)
  })

  it('on, attaches a connection that reports on a grant it did not claim', async () => {
    const on = service(ON)
    copies.set('thread-1', 3)
    const epoch = grantOf(await on.answer(1, claim('thread-1', 'desk-1', [3, 3])))
    expect(
      await on.answer(2, { action: 'advanced', threadId: 'thread-1', epoch, revision: 5 })
    ).toEqual({ kind: 'thread.owner', action: 'advanced', recorded: true })
    expect(on.snapshot().attached).toEqual([{ writerId: 'desk-1', connections: 2 }])
    on.closed(1)
    expect(on.snapshot().table!.threads).toHaveLength(1)
    // A report on a grant that is not current attaches nobody.
    expect(
      await on.answer(3, {
        action: 'advanced',
        threadId: 'thread-1',
        epoch: { ...epoch, grant: 99 },
        revision: 6
      })
    ).toEqual({ kind: 'thread.owner', action: 'advanced', recorded: false })
    expect(on.snapshot().attached).toEqual([{ writerId: 'desk-1', connections: 1 }])
  })

  it('on, drops a grant decided after its connection closed', async () => {
    let release: () => void = () => {}
    const files = new ThreadAuthorityFiles(profile)
    const on = service(ON, {
      files: {
        read: async (threadId) => {
          await new Promise<void>((resolve) => (release = resolve))
          return files.read(threadId)
        },
        list: () => files.list(),
        remove: (threadId) => files.remove(threadId)
      }
    })
    copies.set('thread-1', 3)
    const answer = on.answer(1, claim('thread-1', 'desk-1', [3, 3]))
    await vi.waitFor(() => expect(on.snapshot().attached).toHaveLength(1))
    on.closed(1)
    release()
    // The reply is lost with its socket; the Host keeps no grant for it.
    grantOf(await answer)
    expect(on.snapshot().table!.threads).toEqual([])
  })

  it('on, refuses a connection that speaks for a second writer, and ids no thread has', async () => {
    const on = service(ON)
    copies.set('thread-1', 3)
    grantOf(await on.answer(1, claim('thread-1', 'desk-1', [3, 3])))
    expect(await on.answer(1, claim('thread-1', 'desk-2', [3, 3], 2))).toBe('invalid_payload')
    for (const threadId of ['..', '.', 'a/b', 'a\\b', '']) {
      expect(await on.answer(2, claim(threadId, 'desk-2', [3, 3])), threadId).toBe(
        'invalid_payload'
      )
    }
  })

  it('on, reads the log head under an authority file, and only there', async () => {
    const on = service(ON)
    copies.set('thread-1', 5)
    copies.set('thread-2', 5)
    writeLog('thread-1', 9)
    writeLog('thread-2', 9)
    // A live writer's file marks thread-1's log above the full copy as its work.
    await writeAuthority('thread-1', 'desk-1', process.pid, 5)
    expect(await on.answer(1, claim('thread-1', 'desk-1', [5, 8]))).toMatchObject({
      reply: { granted: false, reason: 'host_ahead', revision: 9 }
    })
    grantOf(await on.answer(1, claim('thread-1', 'desk-1', [5, 9], 2)))
    // Without a file, thread-2's log is a mirror: the Host's copy is the head.
    grantOf(await on.answer(2, claim('thread-2', 'desk-2', [5, 5])))
  })

  it('on, fails a decision it cannot make from an unreadable log', async () => {
    const on = service(ON)
    copies.set('thread-1', 5)
    await writeAuthority('thread-1', 'desk-1', process.pid, 5)
    const directory = threadLogDirectory(profile)
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, 'thread-1.mutations.jsonl'), 'not a batch\n')
    await expect(on.answer(1, claim('thread-1', 'desk-1', [5, 5]))).rejects.toThrow(
      'Thread log head is unreadable'
    )
  })

  it('on, lets a new process carry on the log of one that ended', async () => {
    const on = service(ON, { liveness: () => 'dead' })
    copies.set('thread-1', 5)
    writeLog('thread-1', 7)
    await writeAuthority('thread-1', 'desk-old', 4242, 5)
    grantOf(await on.answer(1, claim('thread-1', 'desk-new', [5, 7])))
  })

  it('on, tells its observer of each advance recorded and each grant released, and nothing else', async () => {
    const told: Array<[string, string]> = []
    const on = service(ON, {
      observer: {
        advanced: (threadId) => told.push(['advanced', threadId]),
        released: (threadId) => told.push(['released', threadId])
      }
    })
    copies.set('thread-1', 3)
    const epoch = grantOf(await on.answer(1, claim('thread-1', 'desk-1', [3, 3])))
    expect(told).toEqual([])
    await on.answer(1, { action: 'advanced', threadId: 'thread-1', epoch, revision: 4 })
    // A report on a grant that is not current is not the log growing.
    await on.answer(1, {
      action: 'advanced',
      threadId: 'thread-1',
      epoch: { ...epoch, grant: 99 },
      revision: 5
    })
    await on.answer(1, {
      action: 'release',
      threadId: 'thread-1',
      epoch: { ...epoch, grant: 99 },
      revision: 4
    })
    expect(told).toEqual([['advanced', 'thread-1']])
    await on.answer(1, { action: 'release', threadId: 'thread-1', epoch, revision: 4 })
    expect(told).toEqual([
      ['advanced', 'thread-1'],
      ['released', 'thread-1']
    ])
  })

  it('tells its observer nothing while it takes no claims, and answers whatever the observer does', async () => {
    const told: string[] = []
    const observer = {
      advanced: (threadId: string) => {
        told.push(threadId)
        throw new Error('the observer failed')
      },
      released: (threadId: string) => {
        told.push(threadId)
        throw new Error('the observer failed')
      }
    }
    const epoch = { host: INCARNATION, grant: 1 }
    for (const environment of [{}, { ...ON, [TASKWRAITH_HOST_TXN_PERSIST_ENV]: '1' }]) {
      const off = service(environment, { observer })
      await off.answer(1, { action: 'advanced', threadId: 'thread-1', epoch, revision: 4 })
      await off.answer(1, { action: 'release', threadId: 'thread-1', epoch, revision: null })
    }
    expect(told).toEqual([])
    const on = service(ON, { observer })
    copies.set('thread-1', 3)
    const granted = grantOf(await on.answer(1, claim('thread-1', 'desk-1', [3, 3])))
    expect(
      await on.answer(1, { action: 'advanced', threadId: 'thread-1', epoch: granted, revision: 4 })
    ).toEqual({ kind: 'thread.owner', action: 'advanced', recorded: true })
    expect(
      await on.answer(1, { action: 'release', threadId: 'thread-1', epoch: granted, revision: 4 })
    ).toEqual({ kind: 'thread.owner', action: 'release', released: true })
    expect(told).toEqual(['thread-1', 'thread-1'])
  })

  it('lets every Host write through, reading no file, while it takes no claims', async () => {
    const files = { read: vi.fn(), list: vi.fn(), remove: vi.fn() }
    for (const environment of [{}, { ...ON, [TASKWRAITH_HOST_TXN_PERSIST_ENV]: '1' }]) {
      expect(await service(environment, { files }).requestHostWrite('thread-1')).toEqual({
        kind: 'write'
      })
    }
    expect(files.read).not.toHaveBeenCalled()
    expect(files.remove).not.toHaveBeenCalled()
  })

  it('on, answers a Host write from the thread’s authority file and its log', async () => {
    const on = service(ON, { liveness: (writer) => (writer.pid === 11 ? 'alive' : 'dead') })
    await on.start()
    for (const threadId of ['held', 'ended', 'published', 'free']) copies.set(threadId, 3)
    await writeAuthority('held', 'desk-1', 11, 3)
    await writeAuthority('ended', 'desk-2', 12, 3)
    writeLog('ended', 5)
    await writeAuthority('published', 'desk-3', 13, 3)
    writeLog('published', 3)
    const files = new ThreadAuthorityFiles(profile)

    expect(await on.requestHostWrite('held')).toEqual({
      kind: 'busy',
      reason: 'thread_busy_in_desktop'
    })
    expect(await on.requestHostWrite('ended')).toEqual({ kind: 'fold_first', revision: 5 })
    expect(await on.requestHostWrite('published')).toEqual({ kind: 'write' })
    expect(await on.requestHostWrite('free')).toEqual({ kind: 'write' })
    expect((await files.read('held')).kind).toBe('held')
    expect((await files.read('ended')).kind).toBe('held')
    expect((await files.read('published')).kind).toBe('none')
  })

  it('on, never lets a write over a file it cannot take away, and counts each', async () => {
    const files = new ThreadAuthorityFiles(profile)
    const on = service(ON, {
      liveness: () => 'dead',
      files: {
        read: (threadId) => files.read(threadId),
        list: () => files.list(),
        remove: async () => {
          throw Object.assign(new Error('EACCES: permission denied, unlink'), { code: 'EACCES' })
        }
      }
    })
    await on.start()
    copies.set('thread-1', 3)
    await writeAuthority('thread-1', 'desk-1', 12, 3)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await on.requestHostWrite('thread-1')).toEqual({
        kind: 'busy',
        reason: 'thread_busy_in_desktop'
      })
    }
    expect(on.snapshot().authority).toMatchObject({
      removeFailures: 2,
      lastRemoveError: 'EACCES: permission denied, unlink'
    })
  })
})
