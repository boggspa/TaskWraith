/**
 * The erasure fence around the orphan fold: an erasure during an in-flight
 * fold waits for it, queued and retrying work is dropped synchronously, and
 * nothing re-enqueues a fenced chat until the fence lifts.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { threadLogFiles } from '../host-shared/thread-log/ThreadLogFiles'
import type { ThreadAuthorityRetirementOutcome } from '../host-shared/thread-log/ThreadAuthorityRetirement'
import type { ThreadOwnershipReservation } from '../host-shared/thread-log/ThreadOwnership'
import { ThreadOrphanFoldRecovery } from './ThreadOrphanFoldRecovery'

const TEMPORARY_PREFIX = 'thread-orphan-fold-erasure-'
const directories: string[] = []

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let turns = 0; !condition(); turns += 1) {
    if (turns > 2000) throw new Error(`never: ${what}`)
    await turn()
  }
}

afterEach(() => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) {
    if (!path.basename(directory).startsWith(TEMPORARY_PREFIX)) throw new Error('refusing')
    rmSync(directory, { recursive: true, force: true })
  }
})

function batch(chatId: string, revision: number) {
  return {
    format: 'taskwraith-chat-mutation',
    version: 1,
    chatId,
    baseRevision: revision - 1,
    revision,
    savedAt: new Date(Date.UTC(2026, 9, 6, 0, 0, revision)).toISOString(),
    operations: [{ type: 'record_patch', set: { title: `t${revision}` }, clear: [] }]
  }
}

/** The existing harness's shape, plus a gate the test opens to release a fold. */
function harness(options: {
  chatId?: string
  log?: number[]
  full?: number | null
  retire?: ThreadAuthorityRetirementOutcome[]
  holdFold?: boolean
}) {
  const chatId = options.chatId ?? 'chat-orphan-erasure-1'
  const directory = mkdtempSync(path.join(tmpdir(), TEMPORARY_PREFIX))
  directories.push(directory)
  if (options.log?.length)
    writeFileSync(
      threadLogFiles(directory, chatId).active,
      options.log.map((revision) => `${JSON.stringify(batch(chatId, revision))}\n`).join('')
    )
  const calls: string[] = []
  let full: number | null = options.full === undefined ? 0 : options.full
  const reservation: ThreadOwnershipReservation = Object.freeze({
    threadId: chatId,
    epoch: { host: 'old-host', grant: 1 },
    revalidate: () => undefined,
    erasing: () => false
  })
  const retire = [...(options.retire ?? [{ kind: 'retired' as const }])]
  const owners = {
    reserveOrphanOwnership: vi.fn(async () => reservation),
    retireOrphanAuthority: vi.fn(async () => retire.shift() ?? { kind: 'retired' as const }),
    releaseOrphanOwnership: vi.fn(() => true)
  }
  const foldGate: Array<() => void> = []
  const client = {
    query: vi.fn(async (query: Record<string, unknown>) => {
      if (query.method === 'open') {
        calls.push('open')
        return { leaseId: 'lease-1', entry: { sourceWitness: 'a'.repeat(64) } }
      }
      if (query.method === 'fold-owned-log') {
        calls.push('fold')
        if (options.holdFold) {
          await new Promise<void>((resolve) => foldGate.push(resolve))
        }
        return { foldId: 'fold-1', headRevision: query.headRevision }
      }
      if (query.method === 'release') return null
      if (query.method === 'discard-folded') return true
      throw new Error(`unexpected ${String(query.method)}`)
    })
  }
  const recovery = {
    beginOrphanViaReservation: vi.fn(() => ({
      kind: 'held' as const,
      hold: { token: 'token-1' } as never
    })),
    adoptViaFold: vi.fn(async () => {
      calls.push('adopt')
      full = Number.MAX_SAFE_INTEGER
      return { kind: 'adopted' as const, projection: {} as never }
    }),
    assertHeld: vi.fn(() => undefined),
    end: vi.fn(() => true)
  }
  const fold = new ThreadOrphanFoldRecovery({
    client: client as never,
    recovery: recovery as never,
    owners,
    logDirectory: directory,
    fullCopyRevision: () => full,
    profileAuthority: 'host-incarnation:test',
    maxBatches: 2
  })
  return { chatId, fold, calls, owners, recovery, foldGate }
}

describe('ThreadOrphanFoldRecovery erasure fence', () => {
  it('an erasure during an in-flight fold waits for it, through its own exit paths', async () => {
    const h = harness({ log: [1], holdFold: true })
    const folding = h.fold.foldOrphan(h.chatId)
    await until(() => h.foldGate.length > 0, 'fold reached the wire')
    let quiesced = false
    const exitsAtQuiesce: number[] = []
    const quiesce = h.fold.quiesceForErasure(h.chatId).then(() => {
      quiesced = true
      exitsAtQuiesce.push(
        h.owners.retireOrphanAuthority.mock.calls.length,
        h.recovery.end.mock.calls.length,
        h.owners.releaseOrphanOwnership.mock.calls.length
      )
    })
    await turn()
    expect(quiesced).toBe(false)
    expect(h.owners.releaseOrphanOwnership).not.toHaveBeenCalled()
    // Custody leaves only through the fold's own exit: retire, end, release.
    for (const resolve of h.foldGate.splice(0)) resolve()
    expect(await folding).toEqual({ kind: 'folded' })
    await quiesce
    expect(quiesced).toBe(true)
    // The join resolved only after every exit had run.
    expect(exitsAtQuiesce).toEqual([1, 1, 1])
    expect(h.calls).toEqual(['open', 'fold', 'adopt'])
  })

  it('a fenced chat is not re-enqueued until the fence lifts', async () => {
    const h = harness({ log: [1] })
    expect(await h.fold.foldOrphan(h.chatId)).toEqual({ kind: 'folded' })
    expect(h.owners.reserveOrphanOwnership).toHaveBeenCalledTimes(1)
    await h.fold.quiesceForErasure(h.chatId)
    h.fold.enqueue(h.chatId)
    await turn()
    await turn()
    expect(h.owners.reserveOrphanOwnership).toHaveBeenCalledTimes(1)
    h.fold.liftErasure(h.chatId)
    h.fold.enqueue(h.chatId)
    await until(() => h.owners.reserveOrphanOwnership.mock.calls.length > 1, 'fold ran again')
  })

  it('a chat queued behind an in-flight fold is dropped by the fence', async () => {
    const h = harness({ log: [1], holdFold: true })
    const QUEUED = 'chat-orphan-erasure-queued'
    const reservedFor = () =>
      h.owners.reserveOrphanOwnership.mock.calls.map((call) => (call as unknown[])[0])
    // The pump is serial: the held chat's fold keeps the queued chat in the
    // queue, where the fence must drop it.
    h.fold.enqueue(h.chatId)
    await until(() => h.foldGate.length > 0, 'held fold reached the wire')
    h.fold.enqueue(QUEUED)
    await turn()
    expect(reservedFor()).toEqual([h.chatId])
    await h.fold.quiesceForErasure(QUEUED)
    for (const resolve of h.foldGate.splice(0)) resolve()
    await until(() => h.owners.releaseOrphanOwnership.mock.calls.length > 0, 'held fold ended')
    await turn()
    await turn()
    expect(reservedFor()).toEqual([h.chatId])
    // Lifted, the queued chat is folded on the next enqueue.
    h.fold.liftErasure(QUEUED)
    h.fold.enqueue(QUEUED)
    await until(() => reservedFor().includes(QUEUED), 'queued chat reserved')
  })

  it('a chat waiting on a refused-fold retry is not retried while fenced', async () => {
    // setImmediate stays real so the polling loop runs under the fake clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness({
      log: [1],
      retire: [{ kind: 'uncertain', reason: 'sync_failed' }]
    })
    h.fold.enqueue(h.chatId)
    await until(() => h.owners.reserveOrphanOwnership.mock.calls.length === 1, 'fold ran')
    // Let the refused fold settle: its outcome scheduled the retry the fence
    // must then clear.
    await turn()
    await turn()
    await turn()
    // The pump refused outcome scheduled the 30s retry; nothing else has run.
    expect(h.owners.reserveOrphanOwnership).toHaveBeenCalledTimes(1)
    await h.fold.quiesceForErasure(h.chatId)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.owners.reserveOrphanOwnership).toHaveBeenCalledTimes(1)
    h.fold.liftErasure(h.chatId)
    h.fold.enqueue(h.chatId)
    await until(() => h.owners.reserveOrphanOwnership.mock.calls.length === 2, 'fold ran again')
    expect(h.owners.reserveOrphanOwnership).toHaveBeenCalledTimes(2)
  })

  it('a global fence covers every chat and lifts at once', async () => {
    const h = harness({ log: [1] })
    const OTHER = 'chat-orphan-erasure-other'
    const reservedFor = () =>
      h.owners.reserveOrphanOwnership.mock.calls.map((call) => (call as unknown[])[0])
    await h.fold.quiesceForErasure()
    h.fold.enqueue(h.chatId)
    h.fold.enqueue(OTHER)
    expect(await h.fold.foldOrphan(OTHER)).toEqual({ kind: 'deferred' })
    await turn()
    await turn()
    expect(h.owners.reserveOrphanOwnership).not.toHaveBeenCalled()
    h.fold.liftErasure()
    h.fold.enqueue(h.chatId)
    h.fold.enqueue(OTHER)
    await until(
      () => reservedFor().includes(h.chatId) && reservedFor().includes(OTHER),
      'both chats reserved'
    )
  })
})
