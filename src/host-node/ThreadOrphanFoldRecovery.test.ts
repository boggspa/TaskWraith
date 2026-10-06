import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { threadLogFiles } from '../host-shared/thread-log/ThreadLogFiles'
import type { ThreadAuthorityRetirementOutcome } from '../host-shared/thread-log/ThreadAuthorityRetirement'
import type { ThreadOwnershipReservation } from '../host-shared/thread-log/ThreadOwnership'
import { ThreadOrphanFoldRecovery } from './ThreadOrphanFoldRecovery'

const CHAT = 'chat-orphan-1'
const TEMPORARY_PREFIX = 'thread-orphan-fold-'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (!path.basename(directory).startsWith(TEMPORARY_PREFIX)) throw new Error('refusing')
    rmSync(directory, { recursive: true, force: true })
  }
})

function batch(revision: number) {
  return {
    format: 'taskwraith-chat-mutation',
    version: 1,
    chatId: CHAT,
    baseRevision: revision - 1,
    revision,
    savedAt: new Date(Date.UTC(2026, 9, 6, 0, 0, revision)).toISOString(),
    operations: [{ type: 'record_patch', set: { title: `t${revision}` }, clear: [] }]
  }
}

function harness(options: {
  log?: number[]
  full?: number | null
  retire?: ThreadAuthorityRetirementOutcome[]
}) {
  const directory = mkdtempSync(path.join(tmpdir(), TEMPORARY_PREFIX))
  directories.push(directory)
  if (options.log?.length)
    writeFileSync(
      threadLogFiles(directory, CHAT).active,
      options.log.map((revision) => `${JSON.stringify(batch(revision))}\n`).join('')
    )
  const calls: string[] = []
  let full: number | null = options.full === undefined ? 0 : options.full
  const reservation: ThreadOwnershipReservation = Object.freeze({
    threadId: CHAT,
    epoch: { host: 'old-host', grant: 1 },
    revalidate: () => undefined,
    erasing: () => false
  })
  let syncOwed = false
  const retire = [...(options.retire ?? [{ kind: 'retired' as const }])]
  const owners = {
    reserveOrphanOwnership: vi.fn(async () => {
      calls.push('reserve')
      return syncOwed ? null : reservation
    }),
    retireOrphanAuthority: vi.fn(async (_id: string, held: ThreadOwnershipReservation) => {
      calls.push('retire')
      expect(held).toBe(reservation)
      const outcome = retire.shift() ?? { kind: 'retired' as const }
      syncOwed = outcome.kind === 'uncertain' && outcome.reason === 'sync_failed'
      return outcome
    }),
    releaseOrphanOwnership: vi.fn(() => {
      calls.push(syncOwed ? 'release-refused' : 'release')
      return !syncOwed
    })
  }
  const folds: Array<{ headRevision: number; revisions: number[]; updatedAt: string }> = []
  const client = {
    query: vi.fn(async (query: Record<string, unknown>) => {
      if (query.method === 'open') {
        calls.push('open')
        return { leaseId: 'lease-1', entry: { sourceWitness: 'a'.repeat(64) } }
      }
      if (query.method === 'fold-owned-log') {
        calls.push('fold')
        const entries = query.logEntries as Array<{ revision: number }>
        folds.push({
          headRevision: query.headRevision as number,
          revisions: entries.map((entry) => entry.revision),
          updatedAt: query.updatedAt as string
        })
        return { foldId: `fold-${folds.length}`, headRevision: query.headRevision }
      }
      if (query.method === 'release') {
        calls.push('release-lease')
        return null
      }
      if (query.method === 'discard-folded') {
        calls.push(`discard:${String(query.foldId)}`)
        return true
      }
      throw new Error(`unexpected ${String(query.method)}`)
    })
  }
  const recovery = {
    beginOrphanViaReservation: vi.fn(() => {
      calls.push('begin')
      return { kind: 'held' as const, hold: { token: 'token-1' } as never }
    }),
    adoptViaFold: vi.fn(async () => {
      calls.push('adopt')
      full = folds[folds.length - 1].headRevision
      return { kind: 'adopted' as const, projection: {} as never }
    }),
    assertHeld: vi.fn(() => undefined),
    end: vi.fn(() => {
      calls.push('end')
      return true
    })
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
  return { fold, calls, folds, owners, recovery, reservation }
}

describe('ThreadOrphanFoldRecovery', () => {
  it('reserves, folds in rounds outside admission, adopts, retires, then releases custody', async () => {
    const h = harness({ log: [1, 2, 3, 4, 5] })
    expect(await h.fold.foldOrphan(CHAT)).toEqual({ kind: 'folded' })
    expect(h.folds.map((item) => item.revisions)).toEqual([[1, 2], [3, 4], [5]])
    // The log's own head and timestamp cross the wire; nothing is restamped.
    expect(h.folds.map((item) => item.headRevision)).toEqual([2, 4, 5])
    expect(h.folds[2].updatedAt).toBe(batch(5).savedAt)
    expect(h.calls).toEqual([
      'reserve',
      'begin',
      ...['open', 'fold', 'adopt', 'release-lease'],
      ...['open', 'fold', 'adopt', 'release-lease'],
      ...['open', 'fold', 'adopt', 'release-lease'],
      'retire',
      'end',
      'release'
    ])
  })

  it('retires a caught-up mark without folding', async () => {
    const h = harness({ log: [1, 2], full: 2 })
    expect(await h.fold.foldOrphan(CHAT)).toEqual({ kind: 'folded' })
    expect(h.calls).toEqual(['reserve', 'begin', 'retire', 'end', 'release'])
  })

  it('leaves a thread with no full copy unresolved and its mark in place', async () => {
    const h = harness({ log: [1, 2], full: null })
    expect(await h.fold.foldOrphan(CHAT)).toEqual({ kind: 'unresolved', reason: 'no full copy' })
    expect(h.owners.retireOrphanAuthority).not.toHaveBeenCalled()
    expect(h.calls.at(-1)).toBe('release')
  })

  it('keeps exact custody after a failed directory sync and pays the debt with it next time', async () => {
    const h = harness({
      log: [],
      retire: [{ kind: 'uncertain', reason: 'sync_failed' }, { kind: 'retired' }]
    })
    expect(await h.fold.foldOrphan(CHAT)).toEqual({ kind: 'unresolved', reason: 'sync_failed' })
    expect(h.calls.at(-1)).toBe('release-refused')
    h.calls.length = 0
    // No fresh reservation and no hold: the retained handle pays the debt
    // with a directory sync alone, then custody is released.
    expect(await h.fold.foldOrphan(CHAT)).toEqual({ kind: 'folded' })
    expect(h.calls).toEqual(['retire', 'release'])
    expect(h.recovery.beginOrphanViaReservation).toHaveBeenCalledTimes(1)
  })

  it('releases custody without folding when the hold cannot begin', async () => {
    const h = harness({ log: [1] })
    h.recovery.beginOrphanViaReservation.mockImplementationOnce(() => {
      h.calls.push('begin')
      return { kind: 'busy', reason: 'live_work' } as never
    })
    expect(await h.fold.foldOrphan(CHAT)).toEqual({ kind: 'deferred' })
    expect(h.calls).toEqual(['reserve', 'begin', 'release'])
  })

  it('does not retire when adoption is refused', async () => {
    const h = harness({ log: [1] })
    h.recovery.adoptViaFold.mockResolvedValueOnce({ kind: 'busy', reason: 'damaged' } as never)
    expect(await h.fold.foldOrphan(CHAT)).toEqual({ kind: 'deferred' })
    expect(h.owners.retireOrphanAuthority).not.toHaveBeenCalled()
    // The refused fold is discarded, never left in the worker's bounded set.
    expect(h.calls.slice(-4)).toEqual(['discard:fold-1', 'release-lease', 'end', 'release'])
  })

  it('discards a fold whose adoption threw', async () => {
    const h = harness({ log: [1] })
    h.recovery.adoptViaFold.mockRejectedValueOnce(new Error('adoption failed'))
    await expect(h.fold.foldOrphan(CHAT)).rejects.toThrow('adoption failed')
    expect(h.calls).toContain('discard:fold-1')
    expect(h.calls.at(-1)).toBe('release')
  })

  it('asks for no fold once its hold has changed', async () => {
    const h = harness({ log: [1] })
    h.recovery.assertHeld.mockImplementationOnce(() => {
      throw new Error('History recovery admission changed')
    })
    expect(await h.fold.foldOrphan(CHAT)).toEqual({ kind: 'deferred' })
    expect(h.calls).not.toContain('fold')
    expect(h.calls.slice(-3)).toEqual(['release-lease', 'end', 'release'])
  })

  it('never retires when an adoption leaves the full copy short of the folded head', async () => {
    const h = harness({ log: [1, 2] })
    h.recovery.adoptViaFold.mockImplementationOnce(async () => {
      h.calls.push('adopt')
      return { kind: 'adopted' as const, projection: {} as never }
    })
    expect(await h.fold.foldOrphan(CHAT)).toEqual({
      kind: 'unresolved',
      reason: 'full copy did not reach the folded head'
    })
    expect(h.owners.retireOrphanAuthority).not.toHaveBeenCalled()
    expect(h.calls.at(-1)).toBe('release')
  })

  it('keeps custody while a hold cannot be ended, and releases it once that hold is gone', async () => {
    const h = harness({ log: [], full: 0 })
    h.recovery.end.mockImplementationOnce(() => {
      h.calls.push('end-failed')
      throw new Error('end failed')
    })
    expect(await h.fold.foldOrphan(CHAT)).toEqual({ kind: 'folded' })
    expect(h.calls).toEqual(['reserve', 'begin', 'retire', 'end-failed'])
    h.calls.length = 0
    // The next attempt ends the stranded hold first, then releases custody
    // before it reserves again.
    expect(await h.fold.foldOrphan(CHAT)).toEqual({ kind: 'folded' })
    expect(h.calls.slice(0, 3)).toEqual(['end', 'release', 'reserve'])
  })
})
