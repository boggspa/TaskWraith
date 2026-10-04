import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DesktopThreadClaims,
  HostThreadOwnerTable,
  THREAD_CLAIM_RETRY_MS,
  THREAD_RELEASE_REQUEST_BOUND_MS,
  sameThreadOwnerEpoch,
  type DesktopThreadClaimsSnapshot,
  type HostDesktopPresence,
  type HostThreadOwnerTableSnapshot,
  type HostWriteFacts,
  type ThreadAdvancedMessage,
  type ThreadClaimFacts,
  type ThreadClaimReply,
  type ThreadClaimRequest,
  type ThreadOwnerEpoch,
  type ThreadReleaseDeclinedMessage,
  type ThreadReleaseMessage,
  type ThreadReleaseRequest
} from './ThreadOwnership'

const THREAD = 'thread-1'

/** What the Host knows when a claim arrives: its full copy, the log it can read, its own runs. */
function onDisk(
  fullCopyRevision: number | null,
  logRevision: number | null = fullCopyRevision,
  extra: Partial<ThreadClaimFacts> = {}
): ThreadClaimFacts {
  return {
    fullCopyRevision,
    logRevision,
    hostRunActive: false,
    otherDesktopUnattached: false,
    ...extra
  }
}

/** What the Host knows when it wants to change a thread itself. */
function beforeWrite(
  fullCopyRevision: number,
  logRevision: number = fullCopyRevision,
  desktop: HostDesktopPresence = 'attached'
): HostWriteFacts {
  return { fullCopyRevision, logRevision, desktop }
}

function claim(
  writerId: string,
  baseRevision: number,
  headRevision: number = baseRevision,
  claimId = 1
): ThreadClaimRequest {
  return { action: 'claim', threadId: THREAD, writerId, claimId, baseRevision, headRevision }
}

function granted(reply: ThreadClaimReply): ThreadOwnerEpoch {
  if (!reply.granted) throw new Error(`claim refused: ${reply.reason}`)
  return reply.epoch
}

function refusal(reply: ThreadClaimReply): { reason: string; revision: number | null } {
  if (reply.granted) throw new Error('claim granted')
  return { reason: reply.reason, revision: reply.revision }
}

describe('who may write a thread: the Host table', () => {
  it('makes the Host the writer of a thread nobody has claimed', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    expect(table.writerOf(THREAD)).toEqual({ kind: 'host' })
    expect(table.requestHostWrite(THREAD, beforeWrite(4), 0)).toEqual({ kind: 'write' })
  })

  it('grants a claim from a writer that holds every Host change, and makes it the only writer', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    expect(table.claim(claim('desk-1', 4), onDisk(4))).toEqual({
      threadId: THREAD,
      claimId: 1,
      granted: true,
      epoch: { host: 'host-a', grant: 1 }
    })
    expect(table.writerOf(THREAD)).toEqual({
      kind: 'desktop',
      writerId: 'desk-1',
      epoch: { host: 'host-a', grant: 1 },
      revision: 4,
      releaseRequested: false
    })
  })

  it('issues a new epoch with each grant', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const first = granted(table.claim(claim('desk-1', 4), onDisk(4)))
    expect(table.release({ action: 'release', threadId: THREAD, epoch: first, revision: 4 })).toBe(
      true
    )
    const second = granted(table.claim(claim('desk-1', 4, 4, 2), onDisk(4)))
    expect(second).toEqual({ host: 'host-a', grant: 2 })
    expect(sameThreadOwnerEpoch(first, second)).toBe(false)
  })

  it('refuses a claim while a Host run is live on the thread, and says how far the Host is', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const before = table.snapshot()
    const reply = table.claim(claim('desk-1', 4), onDisk(4, 4, { hostRunActive: true }))
    expect(reply).toEqual({
      threadId: THREAD,
      claimId: 1,
      granted: false,
      reason: 'host_run_active',
      revision: 4
    })
    expect(table.snapshot()).toEqual(before)
    expect(table.writerOf(THREAD)).toEqual({ kind: 'host' })
  })

  it('refuses a claim from a writer that lacks a Host change, with the revision it must reach', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const before = table.snapshot()
    expect(refusal(table.claim(claim('desk-1', 4), onDisk(6)))).toEqual({
      reason: 'host_ahead',
      revision: 6
    })
    expect(table.snapshot()).toEqual(before)
    expect(granted(table.claim(claim('desk-1', 6, 6, 2), onDisk(6)))).toEqual({
      host: 'host-a',
      grant: 1
    })
  })

  it('refuses a claim built on a full copy the Host has not stored yet', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    expect(refusal(table.claim(claim('desk-1', 5), onDisk(4)))).toEqual({
      reason: 'host_behind',
      revision: 4
    })
    expect(refusal(table.claim(claim('desk-1', 0, 0, 2), onDisk(null, null)))).toEqual({
      reason: 'host_behind',
      revision: null
    })
    // A head the Host cannot read yet (an append still buffered in the app) is the same case.
    expect(refusal(table.claim(claim('desk-1', 4, 7, 3), onDisk(4, 6)))).toEqual({
      reason: 'host_behind',
      revision: 6
    })
    expect(table.writerOf(THREAD)).toEqual({ kind: 'host' })
  })

  it('refuses a second writer while the first holds the thread', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const epoch = granted(table.claim(claim('desk-1', 4), onDisk(4)))
    const before = table.snapshot()
    expect(refusal(table.claim(claim('desk-2', 4), onDisk(4)))).toEqual({
      reason: 'owned_by_other_writer',
      revision: 4
    })
    expect(table.snapshot()).toEqual(before)
    expect(table.writerOf(THREAD)).toMatchObject({ kind: 'desktop', writerId: 'desk-1', epoch })
  })

  it('refuses every claim when log authority is off, and owns nothing', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a', enabled: false })
    expect(refusal(table.claim(claim('desk-1', 4), onDisk(4)))).toEqual({
      reason: 'disabled',
      revision: 4
    })
    expect(table.writerOf(THREAD)).toEqual({ kind: 'host' })
    expect(table.snapshot().threads).toEqual([])
  })

  it('answers the owner that claims again with the epoch it already holds', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const epoch = granted(table.claim(claim('desk-1', 4), onDisk(4)))
    const before = table.snapshot()
    // The log has moved on and a Host fact would refuse a stranger; the owner is still the owner.
    const again = table.claim(claim('desk-1', 4, 4, 2), onDisk(4, 9, { hostRunActive: true }))
    expect(again).toEqual({ threadId: THREAD, claimId: 2, granted: true, epoch })
    expect(table.snapshot()).toEqual(before)
  })

  it('lets a log above the full copy be claimed only by a writer that continues it from its head', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    // Full copy at 4, log at 7: three revisions of unpublished desktop work.
    expect(refusal(table.claim(claim('desk-2', 4, 4), onDisk(4, 7)))).toEqual({
      reason: 'host_ahead',
      revision: 7
    })
    expect(refusal(table.claim(claim('desk-2', 4, 6, 2), onDisk(4, 7)))).toEqual({
      reason: 'host_ahead',
      revision: 7
    })
    expect(table.writerOf(THREAD)).toEqual({ kind: 'host' })
    expect(granted(table.claim(claim('desk-2', 4, 7, 3), onDisk(4, 7)))).toEqual({
      host: 'host-a',
      grant: 1
    })
    expect(table.writerOf(THREAD)).toMatchObject({
      kind: 'desktop',
      writerId: 'desk-2',
      revision: 7
    })
  })

  it('ignores a log that is behind the full copy when it compares a claim', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    expect(granted(table.claim(claim('desk-1', 6), onDisk(6, 3)))).toEqual({
      host: 'host-a',
      grant: 1
    })
  })

  it('records an advance once, however often it is delivered, and never moves backwards', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const epoch = granted(table.claim(claim('desk-1', 4), onDisk(4)))
    const advanced: ThreadAdvancedMessage = {
      action: 'advanced',
      threadId: THREAD,
      epoch,
      revision: 9
    }
    expect(table.advanced(advanced)).toBe(true)
    const once = table.snapshot()
    expect(table.advanced(advanced)).toBe(true)
    expect(table.advanced({ ...advanced, revision: 6 })).toBe(true)
    expect(table.snapshot()).toEqual(once)
    expect(table.writerOf(THREAD)).toMatchObject({ revision: 9 })
  })

  it('ignores an advance and a release that carry a stale epoch', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const first = granted(table.claim(claim('desk-1', 4), onDisk(4)))
    table.release({ action: 'release', threadId: THREAD, epoch: first, revision: 4 })
    const second = granted(table.claim(claim('desk-2', 4), onDisk(4)))
    const before = table.snapshot()
    expect(
      table.advanced({ action: 'advanced', threadId: THREAD, epoch: first, revision: 50 })
    ).toBe(false)
    expect(table.release({ action: 'release', threadId: THREAD, epoch: first, revision: 50 })).toBe(
      false
    )
    // The same grant number from another Host incarnation is a different epoch.
    expect(
      table.release({
        action: 'release',
        threadId: THREAD,
        epoch: { host: 'host-0', grant: second.grant },
        revision: 4
      })
    ).toBe(false)
    expect(table.snapshot()).toEqual(before)
    expect(table.writerOf(THREAD)).toMatchObject({ kind: 'desktop', writerId: 'desk-2' })
  })

  it('returns the thread to the Host on release, once', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const epoch = granted(table.claim(claim('desk-1', 4), onDisk(4)))
    const release: ThreadReleaseMessage = {
      action: 'release',
      threadId: THREAD,
      epoch,
      revision: 8
    }
    expect(table.release(release)).toBe(true)
    expect(table.writerOf(THREAD)).toEqual({ kind: 'host' })
    const after = table.snapshot()
    expect(table.release(release)).toBe(false)
    expect(table.snapshot()).toEqual(after)
    expect(table.requestHostWrite(THREAD, beforeWrite(8), 0)).toEqual({ kind: 'write' })
  })

  it('asks a live desktop owner to release instead of writing, once per wait', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const epoch = granted(table.claim(claim('desk-1', 4), onDisk(4)))
    const request: ThreadReleaseRequest = {
      threadId: THREAD,
      epoch,
      requestId: 1,
      deadline: 1_000 + THREAD_RELEASE_REQUEST_BOUND_MS
    }
    expect(table.requestHostWrite(THREAD, beforeWrite(4), 1_000)).toEqual({
      kind: 'ask_release',
      writerId: 'desk-1',
      created: true,
      request
    })
    // A second Host command for the same thread joins the wait: no second message.
    expect(table.requestHostWrite(THREAD, beforeWrite(4), 3_000)).toEqual({
      kind: 'ask_release',
      writerId: 'desk-1',
      created: false,
      request
    })
    expect(table.writerOf(THREAD)).toMatchObject({ kind: 'desktop', releaseRequested: true })
    expect(table.nextDeadline()).toBe(1_000 + THREAD_RELEASE_REQUEST_BOUND_MS)
    expect(THREAD_RELEASE_REQUEST_BOUND_MS).toBe(10_000)
  })

  it('lets the Host write once the owner has released', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const epoch = granted(table.claim(claim('desk-1', 4), onDisk(4)))
    table.requestHostWrite(THREAD, beforeWrite(4, 7), 0)
    // The owner published its log (full copy now 7) and released.
    expect(table.release({ action: 'release', threadId: THREAD, epoch, revision: 7 })).toBe(true)
    expect(table.nextDeadline()).toBeNull()
    expect(table.requestHostWrite(THREAD, beforeWrite(7), 50)).toEqual({ kind: 'write' })
  })

  it('keeps the thread with an owner that declines because it is busy', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const epoch = granted(table.claim(claim('desk-1', 4), onDisk(4)))
    const decision = table.requestHostWrite(THREAD, beforeWrite(4), 0)
    if (decision.kind !== 'ask_release') throw new Error('expected a release request')
    const declined: ThreadReleaseDeclinedMessage = {
      action: 'declined',
      threadId: THREAD,
      epoch,
      requestId: decision.request.requestId
    }
    expect(table.releaseDeclined(declined)).toBe(true)
    expect(table.writerOf(THREAD)).toMatchObject({
      kind: 'desktop',
      writerId: 'desk-1',
      releaseRequested: false
    })
    expect(table.nextDeadline()).toBeNull()
    // A duplicate of the same answer settles nothing further.
    expect(table.releaseDeclined(declined)).toBe(false)
  })

  it('lets an unanswered release request lapse at the bound, leaving the owner in place', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    granted(table.claim(claim('desk-1', 4), onDisk(4)))
    table.requestHostWrite(THREAD, beforeWrite(4), 2_000)
    const deadline = 2_000 + THREAD_RELEASE_REQUEST_BOUND_MS
    expect(table.expireReleaseRequests(deadline - 1)).toEqual([])
    expect(table.nextDeadline()).toBe(deadline)
    expect(table.expireReleaseRequests(deadline)).toEqual([THREAD])
    expect(table.nextDeadline()).toBeNull()
    expect(table.writerOf(THREAD)).toMatchObject({
      kind: 'desktop',
      writerId: 'desk-1',
      releaseRequested: false
    })
    // The next Host command asks again, as a new request.
    expect(table.requestHostWrite(THREAD, beforeWrite(4), deadline + 5)).toMatchObject({
      kind: 'ask_release',
      created: true,
      request: { requestId: 2, deadline: deadline + 5 + THREAD_RELEASE_REQUEST_BOUND_MS }
    })
  })

  it('asks afresh once a request is past its deadline, even before the sweep', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    granted(table.claim(claim('desk-1', 4), onDisk(4)))
    table.requestHostWrite(THREAD, beforeWrite(4), 0)
    expect(
      table.requestHostWrite(THREAD, beforeWrite(4), THREAD_RELEASE_REQUEST_BOUND_MS)
    ).toMatchObject({
      kind: 'ask_release',
      created: true,
      request: { requestId: 2, deadline: 2 * THREAD_RELEASE_REQUEST_BOUND_MS }
    })
    expect(table.nextDeadline()).toBe(2 * THREAD_RELEASE_REQUEST_BOUND_MS)
  })

  it('reports the earliest deadline across threads', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    for (const threadId of ['thread-a', 'thread-b', 'thread-c']) {
      table.claim({ ...claim('desk-1', 1), threadId }, onDisk(1))
    }
    table.requestHostWrite('thread-a', beforeWrite(1), 500)
    table.requestHostWrite('thread-b', beforeWrite(1), 200)
    table.requestHostWrite('thread-c', beforeWrite(1), 900)
    expect(table.nextDeadline()).toBe(200 + THREAD_RELEASE_REQUEST_BOUND_MS)
    expect(table.expireReleaseRequests(500 + THREAD_RELEASE_REQUEST_BOUND_MS).sort()).toEqual([
      'thread-a',
      'thread-b'
    ])
    expect(table.nextDeadline()).toBe(900 + THREAD_RELEASE_REQUEST_BOUND_MS)
  })

  it('does not let a late answer to an old request cancel a newer one', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const epoch = granted(table.claim(claim('desk-1', 4), onDisk(4)))
    table.requestHostWrite(THREAD, beforeWrite(4), 0)
    table.expireReleaseRequests(THREAD_RELEASE_REQUEST_BOUND_MS)
    table.requestHostWrite(THREAD, beforeWrite(4), 20_000)
    const before = table.snapshot()
    expect(
      table.releaseDeclined({ action: 'declined', threadId: THREAD, epoch, requestId: 1 })
    ).toBe(false)
    expect(
      table.releaseDeclined({
        action: 'declined',
        threadId: THREAD,
        epoch: { host: 'host-a', grant: 99 },
        requestId: 2
      })
    ).toBe(false)
    expect(table.snapshot()).toEqual(before)
    expect(table.writerOf(THREAD)).toMatchObject({ releaseRequested: true })
  })

  it('takes over a dead owner only after its unpublished work has been folded', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    granted(table.claim(claim('desk-1', 4), onDisk(4)))
    // The app appended up to 9 and died; the caller's pid probe found it gone.
    expect(table.writerGone('desk-1')).toEqual([THREAD])
    expect(table.writerOf(THREAD)).toEqual({ kind: 'host' })
    expect(table.requestHostWrite(THREAD, beforeWrite(4, 9, 'none'), 0)).toEqual({
      kind: 'fold_first',
      revision: 9
    })
    // After the fold the full copy holds everything the log held.
    expect(table.requestHostWrite(THREAD, beforeWrite(9, 9, 'none'), 0)).toEqual({ kind: 'write' })
  })

  it('treats a holder as gone when no app process is alive, without asking it anything', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    granted(table.claim(claim('desk-1', 4), onDisk(4)))
    expect(table.requestHostWrite(THREAD, beforeWrite(4, 9, 'none'), 0)).toEqual({
      kind: 'fold_first',
      revision: 9
    })
    expect(table.writerOf(THREAD)).toEqual({ kind: 'host' })
    expect(table.snapshot()).toMatchObject({ requests: 0, threads: [] })
    expect(table.requestHostWrite(THREAD, beforeWrite(9, 9, 'none'), 0)).toEqual({ kind: 'write' })
  })

  it('does not fold or write over unpublished work while a desktop is alive', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    expect(table.requestHostWrite(THREAD, beforeWrite(4, 9, 'attached'), 0)).toEqual({
      kind: 'busy',
      reason: 'thread_busy_in_desktop'
    })
    expect(table.requestHostWrite(THREAD, beforeWrite(4, 9, 'unattached'), 0)).toEqual({
      kind: 'busy',
      reason: 'thread_busy_in_desktop'
    })
  })

  it('lets a new app process claim the unpublished log of a dead writer by continuing it from its head', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    granted(table.claim(claim('desk-1', 4), onDisk(4)))
    // Until the Host learns the old process is gone, the new one is a second writer.
    expect(refusal(table.claim(claim('desk-2', 4, 9), onDisk(4, 9)))).toEqual({
      reason: 'owned_by_other_writer',
      revision: 9
    })
    table.writerGone('desk-1')
    expect(granted(table.claim(claim('desk-2', 4, 9, 2), onDisk(4, 9)))).toEqual({
      host: 'host-a',
      grant: 2
    })
    expect(table.writerOf(THREAD)).toMatchObject({
      kind: 'desktop',
      writerId: 'desk-2',
      revision: 9
    })
  })

  it('only frees the threads of the writer that is gone', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    table.claim({ ...claim('desk-1', 1), threadId: 'thread-a' }, onDisk(1))
    table.claim({ ...claim('desk-2', 1), threadId: 'thread-b' }, onDisk(1))
    table.claim({ ...claim('desk-1', 1), threadId: 'thread-c' }, onDisk(1))
    expect(table.writerGone('desk-1').sort()).toEqual(['thread-a', 'thread-c'])
    expect(table.writerOf('thread-b')).toMatchObject({ kind: 'desktop', writerId: 'desk-2' })
    expect(table.writerGone('desk-1')).toEqual([])
  })

  it('starts empty after a Host restart and is rebuilt from re-assertions', () => {
    const before = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const oldEpoch = granted(before.claim(claim('desk-1', 4), onDisk(4)))
    // The Host restarts. Nothing was written down: the new table knows no owner.
    const after = new HostThreadOwnerTable({ incarnation: 'host-b' })
    expect(after.writerOf(THREAD)).toEqual({ kind: 'host' })
    // The app re-asserts with what it has now: full copy 4, its own log at 9.
    const newEpoch = granted(after.claim(claim('desk-1', 4, 9, 2), onDisk(4, 9)))
    expect(newEpoch).toEqual({ host: 'host-b', grant: 1 })
    expect(sameThreadOwnerEpoch(oldEpoch, newEpoch)).toBe(false)
    // A message composed under the old Host cannot touch the new grant.
    expect(
      after.release({ action: 'release', threadId: THREAD, epoch: oldEpoch, revision: 9 })
    ).toBe(false)
    expect(after.writerOf(THREAD)).toMatchObject({ kind: 'desktop', writerId: 'desk-1' })
  })

  it('refuses a re-assertion that follows a Host write', () => {
    const after = new HostThreadOwnerTable({ incarnation: 'host-b' })
    // The restarted Host changed the thread (full copy 4 -> 5) before the app re-asserted.
    expect(refusal(after.claim(claim('desk-1', 4, 9), onDisk(5, 9)))).toEqual({
      reason: 'host_ahead',
      revision: 9
    })
    expect(refusal(after.claim(claim('desk-1', 4, 4, 2), onDisk(5, 4)))).toEqual({
      reason: 'host_ahead',
      revision: 5
    })
    expect(after.writerOf(THREAD)).toEqual({ kind: 'host' })
  })

  it('refuses a re-assertion that would create two writers', () => {
    const after = new HostThreadOwnerTable({ incarnation: 'host-b' })
    granted(after.claim(claim('desk-1', 4), onDisk(4)))
    expect(refusal(after.claim(claim('desk-2', 4), onDisk(4))).reason).toBe('owned_by_other_writer')
    // A live desktop that has not re-attached may still hold the thread from before the restart.
    const other = new HostThreadOwnerTable({ incarnation: 'host-b' })
    expect(
      refusal(other.claim(claim('desk-2', 4), onDisk(4, 4, { otherDesktopUnattached: true })))
        .reason
    ).toBe('owned_by_other_writer')
    expect(other.writerOf(THREAD)).toEqual({ kind: 'host' })
  })

  it('does not write after a restart until a live desktop has re-attached', () => {
    const after = new HostThreadOwnerTable({ incarnation: 'host-b' })
    expect(after.requestHostWrite(THREAD, beforeWrite(4, 4, 'unattached'), 0)).toEqual({
      kind: 'busy',
      reason: 'thread_busy_in_desktop'
    })
    expect(after.requestHostWrite(THREAD, beforeWrite(4, 4, 'attached'), 0)).toEqual({
      kind: 'write'
    })
    expect(after.requestHostWrite(THREAD, beforeWrite(4, 4, 'none'), 0)).toEqual({ kind: 'write' })
  })

  it('admits a full copy only from the writer, or from anyone while the Host is the writer', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const settled = { otherDesktopUnattached: false }
    expect(table.mayReplaceFullCopy(THREAD, 'desk-2', settled)).toBe(true)
    expect(table.mayReplaceFullCopy(THREAD, 'desk-2', { otherDesktopUnattached: true })).toBe(false)
    granted(table.claim(claim('desk-1', 4), onDisk(4)))
    expect(table.mayReplaceFullCopy(THREAD, 'desk-1', settled)).toBe(true)
    expect(table.mayReplaceFullCopy(THREAD, 'desk-2', settled)).toBe(false)
  })

  it('rejects malformed input instead of guessing', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    expect(() => table.claim(claim('', 4), onDisk(4))).toThrow('Invalid writer id')
    expect(() => table.claim(claim('desk-1', 5, 4), onDisk(4))).toThrow('Invalid claim revisions')
    expect(() => table.claim(claim('desk-1', -1), onDisk(4))).toThrow('Invalid revision')
    expect(() => table.claim(claim('desk-1', 4), onDisk(1.5))).toThrow('Invalid revision')
    expect(() => new HostThreadOwnerTable({ incarnation: '' })).toThrow('Invalid Host incarnation')
    expect(table.snapshot().threads).toEqual([])
  })

  it('restores exactly what it snapshotted', () => {
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    granted(table.claim(claim('desk-1', 4), onDisk(4)))
    table.requestHostWrite(THREAD, beforeWrite(4), 100)
    const copy = HostThreadOwnerTable.restore(table.snapshot())
    expect(copy.snapshot()).toEqual(table.snapshot())
    expect(copy.nextDeadline()).toBe(100 + THREAD_RELEASE_REQUEST_BOUND_MS)
    expect(granted(copy.claim({ ...claim('desk-1', 1), threadId: 'thread-2' }, onDisk(1)))).toEqual(
      {
        host: 'host-a',
        grant: 2
      }
    )
  })
})

describe('who may write a thread: the claims an app process holds', () => {
  function attachedClaims(writerId = 'desk-1'): DesktopThreadClaims {
    const claims = new DesktopThreadClaims({ writerId })
    claims.hostChanged('host-a')
    return claims
  }
  const EPOCH: ThreadOwnerEpoch = { host: 'host-a', grant: 1 }
  const revisions = { baseRevision: 4, headRevision: 4 }

  it('owns nothing until the grant arrives: a claim in flight changes nothing', () => {
    const claims = attachedClaims()
    expect(claims.stateOf(THREAD)).toBe('unclaimed')
    expect(claims.claim(THREAD, { baseRevision: 4, headRevision: 6 }, 0)).toEqual({
      action: 'claim',
      threadId: THREAD,
      writerId: 'desk-1',
      claimId: 1,
      baseRevision: 4,
      headRevision: 6
    })
    expect(claims.stateOf(THREAD)).toBe('claiming')
    expect(claims.owns(THREAD)).toBe(false)
    // Nothing is sent for a thread that is not owned.
    expect(claims.advanced(THREAD, 7)).toBeNull()
    expect(claims.release(THREAD, 7)).toBeNull()
    expect(
      claims.claimReply({ threadId: THREAD, claimId: 1, granted: true, epoch: EPOCH })
    ).toEqual({ kind: 'granted', epoch: EPOCH })
    expect(claims.stateOf(THREAD)).toBe('owned')
    expect(claims.owns(THREAD)).toBe(true)
  })

  it('goes back to unclaimed when a claim is refused, and waits before asking again', () => {
    const claims = attachedClaims()
    claims.claim(THREAD, revisions, 5_000)
    expect(
      claims.claimReply({
        threadId: THREAD,
        claimId: 1,
        granted: false,
        reason: 'host_run_active',
        revision: 4
      })
    ).toEqual({ kind: 'refused', reason: 'host_run_active', revision: 4 })
    expect(claims.stateOf(THREAD)).toBe('unclaimed')
    expect(claims.owns(THREAD)).toBe(false)
    expect(claims.claim(THREAD, revisions, 5_000 + THREAD_CLAIM_RETRY_MS - 1)).toBeNull()
    expect(claims.claim(THREAD, revisions, 5_000 + THREAD_CLAIM_RETRY_MS)).toMatchObject({
      claimId: 2
    })
  })

  it('asks again when a claim is lost, but not before the retry interval', () => {
    const claims = attachedClaims()
    const table = new HostThreadOwnerTable({ incarnation: 'host-a' })
    const first = claims.claim(THREAD, revisions, 0)!
    // The Host granted it, and the reply was lost.
    const epoch = granted(table.claim(first, onDisk(4)))
    expect(claims.claim(THREAD, revisions, THREAD_CLAIM_RETRY_MS - 1)).toBeNull()
    expect(claims.stateOf(THREAD)).toBe('claiming')
    const second = claims.claim(THREAD, revisions, THREAD_CLAIM_RETRY_MS)!
    expect(second.claimId).toBe(2)
    // The owner asking again gets the grant it already holds.
    const reply = table.claim(second, onDisk(4))
    expect(reply).toEqual({ threadId: THREAD, claimId: 2, granted: true, epoch })
    expect(claims.claimReply(reply)).toEqual({ kind: 'granted', epoch })
    expect(THREAD_CLAIM_RETRY_MS).toBe(1_000)
  })

  it('acts only on the reply to its latest claim', () => {
    const claims = attachedClaims()
    claims.claim(THREAD, revisions, 0)
    claims.claim(THREAD, revisions, THREAD_CLAIM_RETRY_MS)
    const before = claims.snapshot()
    expect(
      claims.claimReply({
        threadId: THREAD,
        claimId: 1,
        granted: false,
        reason: 'host_ahead',
        revision: 9
      })
    ).toEqual({ kind: 'ignored' })
    expect(
      claims.claimReply({ threadId: THREAD, claimId: 1, granted: true, epoch: EPOCH })
    ).toEqual({ kind: 'ignored' })
    expect(claims.snapshot()).toEqual(before)
    expect(claims.stateOf(THREAD)).toBe('claiming')
    // A reply for a thread it never claimed is ignored too.
    expect(
      claims.claimReply({ threadId: 'thread-2', claimId: 2, granted: true, epoch: EPOCH })
    ).toEqual({ kind: 'ignored' })
    expect(claims.stateOf('thread-2')).toBe('unclaimed')
  })

  it('sends advances and a release only for a thread it owns, with its epoch', () => {
    const claims = attachedClaims()
    claims.claim(THREAD, revisions, 0)
    claims.claimReply({ threadId: THREAD, claimId: 1, granted: true, epoch: EPOCH })
    expect(claims.claim(THREAD, revisions, 60_000)).toBeNull()
    expect(claims.advanced(THREAD, 9)).toEqual({
      action: 'advanced',
      threadId: THREAD,
      epoch: EPOCH,
      revision: 9
    })
    expect(claims.release(THREAD, 9)).toEqual({
      action: 'release',
      threadId: THREAD,
      epoch: EPOCH,
      revision: 9
    })
    expect(claims.stateOf(THREAD)).toBe('unclaimed')
    expect(claims.release(THREAD, 9)).toBeNull()
    expect(claims.advanced(THREAD, 10)).toBeNull()
  })

  it('declines a release request while the thread is busy, and stays the owner', () => {
    const claims = attachedClaims()
    claims.claim(THREAD, revisions, 0)
    claims.claimReply({ threadId: THREAD, claimId: 1, granted: true, epoch: EPOCH })
    const request: ThreadReleaseRequest = {
      threadId: THREAD,
      epoch: EPOCH,
      requestId: 7,
      deadline: 10_000
    }
    expect(claims.releaseRequested(request, true)).toEqual({
      kind: 'declined',
      declined: { action: 'declined', threadId: THREAD, epoch: EPOCH, requestId: 7 }
    })
    expect(claims.stateOf(THREAD)).toBe('owned')
  })

  it('releases when asked while idle, after the caller has published', () => {
    const claims = attachedClaims()
    claims.claim(THREAD, revisions, 0)
    claims.claimReply({ threadId: THREAD, claimId: 1, granted: true, epoch: EPOCH })
    const request: ThreadReleaseRequest = {
      threadId: THREAD,
      epoch: EPOCH,
      requestId: 7,
      deadline: 10_000
    }
    expect(claims.releaseRequested(request, false)).toEqual({
      kind: 'release_started',
      deadline: 10_000
    })
    // Still the only writer while it parks saves and publishes its log.
    expect(claims.stateOf(THREAD)).toBe('releasing')
    expect(claims.owns(THREAD)).toBe(true)
    expect(claims.claim(THREAD, revisions, 60_000)).toBeNull()
    // A repeat of the request does not start a second release.
    expect(claims.releaseRequested(request, true)).toEqual({
      kind: 'release_started',
      deadline: 10_000
    })
    expect(claims.release(THREAD, 6)).toEqual({
      action: 'release',
      threadId: THREAD,
      epoch: EPOCH,
      revision: 6
    })
    expect(claims.owns(THREAD)).toBe(false)
  })

  it('can give up a release it started and keep the thread', () => {
    const claims = attachedClaims()
    claims.claim(THREAD, revisions, 0)
    claims.claimReply({ threadId: THREAD, claimId: 1, granted: true, epoch: EPOCH })
    claims.releaseRequested(
      { threadId: THREAD, epoch: EPOCH, requestId: 7, deadline: 10_000 },
      false
    )
    // The Host's first request lapsed and it asked again; an old copy of the first changes nothing.
    claims.releaseRequested(
      { threadId: THREAD, epoch: EPOCH, requestId: 9, deadline: 30_000 },
      false
    )
    claims.releaseRequested(
      { threadId: THREAD, epoch: EPOCH, requestId: 7, deadline: 10_000 },
      false
    )
    expect(claims.releaseAbandoned(THREAD)).toEqual({
      action: 'declined',
      threadId: THREAD,
      epoch: EPOCH,
      requestId: 9
    })
    expect(claims.stateOf(THREAD)).toBe('owned')
    expect(claims.releaseAbandoned(THREAD)).toBeNull()
  })

  it('hands back a thread the Host thinks it holds, and will not accept that grant afterwards', () => {
    const claims = attachedClaims()
    // The grant for claim 1 was lost; claim 2 is in flight when the Host asks for the thread.
    claims.claim(THREAD, revisions, 0)
    claims.claim(THREAD, revisions, THREAD_CLAIM_RETRY_MS)
    expect(
      claims.releaseRequested(
        { threadId: THREAD, epoch: EPOCH, requestId: 3, deadline: 10_000 },
        true
      )
    ).toEqual({
      kind: 'handed_back',
      release: { action: 'release', threadId: THREAD, epoch: EPOCH, revision: null }
    })
    expect(claims.stateOf(THREAD)).toBe('claiming')
    // The Host answered claim 2 before it saw the hand-back: that grant is already given up.
    expect(
      claims.claimReply({ threadId: THREAD, claimId: 2, granted: true, epoch: EPOCH })
    ).toEqual({ kind: 'ignored' })
    expect(claims.stateOf(THREAD)).toBe('unclaimed')
  })

  it('accepts a newer grant for a claim that was in flight when it handed an older one back', () => {
    const claims = attachedClaims()
    claims.claim(THREAD, revisions, 0)
    claims.releaseRequested(
      { threadId: THREAD, epoch: EPOCH, requestId: 3, deadline: 10_000 },
      false
    )
    // The Host saw the hand-back first and then granted the claim afresh.
    const fresh = { host: 'host-a', grant: 2 }
    expect(
      claims.claimReply({ threadId: THREAD, claimId: 1, granted: true, epoch: fresh })
    ).toEqual({ kind: 'granted', epoch: fresh })
    expect(claims.owns(THREAD)).toBe(true)
  })

  it('never takes back an epoch it has released, even if a later claim is answered with it', () => {
    const claims = attachedClaims()
    claims.claim(THREAD, revisions, 0)
    claims.claimReply({ threadId: THREAD, claimId: 1, granted: true, epoch: EPOCH })
    claims.release(THREAD, 4)
    // The next claim overtakes the release on the way to the Host, which answers with the old grant.
    claims.claim(THREAD, revisions, 60_000)
    expect(
      claims.claimReply({ threadId: THREAD, claimId: 2, granted: true, epoch: EPOCH })
    ).toEqual({ kind: 'ignored' })
    expect(claims.stateOf(THREAD)).toBe('unclaimed')
    // A fresh epoch is a fresh grant.
    claims.claim(THREAD, revisions, 120_000)
    const fresh = { host: 'host-a', grant: 2 }
    expect(claims.snapshot().released).toEqual([[THREAD, 1]])
    expect(
      claims.claimReply({ threadId: THREAD, claimId: 3, granted: true, epoch: fresh })
    ).toEqual({ kind: 'granted', epoch: fresh })
    // Nothing is remembered about a thread once it is held again.
    expect(claims.snapshot().released).toEqual([])
  })

  it('does not reopen a grant it handed back when an older request is repeated', () => {
    const claims = attachedClaims()
    const older = { host: 'host-a', grant: 1 }
    const newer = { host: 'host-a', grant: 2 }
    const ask = (epoch: ThreadOwnerEpoch, requestId: number): ThreadReleaseRequest => ({
      threadId: THREAD,
      epoch,
      requestId,
      deadline: 10_000
    })
    // The Host asked for two grants this process never received; the older request arrives last.
    expect(claims.releaseRequested(ask(newer, 2), false).kind).toBe('handed_back')
    expect(claims.releaseRequested(ask(older, 1), false).kind).toBe('handed_back')
    // Its next claim reaches the Host before the hand-back of the newer grant does.
    claims.claim(THREAD, revisions, 0)
    expect(
      claims.claimReply({ threadId: THREAD, claimId: 1, granted: true, epoch: newer })
    ).toEqual({ kind: 'ignored' })
    expect(claims.owns(THREAD)).toBe(false)
  })

  it('keeps its grant when a release request names another epoch', () => {
    const claims = attachedClaims()
    claims.claim(THREAD, revisions, 0)
    const epoch = { host: 'host-a', grant: 5 }
    claims.claimReply({ threadId: THREAD, claimId: 1, granted: true, epoch })
    const before = claims.snapshot()
    expect(
      claims.releaseRequested(
        { threadId: THREAD, epoch: EPOCH, requestId: 3, deadline: 10_000 },
        false
      )
    ).toEqual({
      kind: 'handed_back',
      release: { action: 'release', threadId: THREAD, epoch: EPOCH, revision: null }
    })
    expect(claims.snapshot()).toEqual(before)
    expect(claims.owns(THREAD)).toBe(true)
    // An epoch from another Host incarnation is not answered at all.
    expect(
      claims.releaseRequested(
        { threadId: THREAD, epoch: { host: 'host-0', grant: 5 }, requestId: 4, deadline: 10_000 },
        false
      )
    ).toEqual({ kind: 'ignored' })
    expect(claims.snapshot()).toEqual(before)
  })

  it('drops every claim when the Host changes, and names the threads to re-assert', () => {
    const claims = attachedClaims()
    claims.claim('thread-a', revisions, 0)
    claims.claimReply({ threadId: 'thread-a', claimId: 1, granted: true, epoch: EPOCH })
    claims.claim('thread-b', revisions, 0)
    claims.claim('thread-c', revisions, 0)
    claims.claimReply({
      threadId: 'thread-c',
      claimId: 3,
      granted: true,
      epoch: { host: 'host-a', grant: 2 }
    })
    claims.releaseRequested(
      { threadId: 'thread-c', epoch: { host: 'host-a', grant: 2 }, requestId: 1, deadline: 10_000 },
      false
    )
    expect(claims.hostChanged('host-a')).toEqual([])
    expect(claims.owns('thread-a')).toBe(true)
    expect(claims.hostChanged('host-b').sort()).toEqual(['thread-a', 'thread-c'])
    for (const threadId of ['thread-a', 'thread-b', 'thread-c']) {
      expect(claims.stateOf(threadId)).toBe('unclaimed')
    }
    // A grant issued by the old Host means nothing now.
    const again = claims.claim('thread-a', revisions, 0)!
    expect(
      claims.claimReply({
        threadId: 'thread-a',
        claimId: again.claimId,
        granted: true,
        epoch: { host: 'host-a', grant: 9 }
      })
    ).toEqual({ kind: 'ignored' })
    expect(claims.owns('thread-a')).toBe(false)
  })

  it('carries neither a refusal nor a given-back grant over to a new Host', () => {
    const claims = attachedClaims()
    claims.claim(THREAD, revisions, 0)
    claims.claimReply({
      threadId: THREAD,
      claimId: 1,
      granted: true,
      epoch: { host: 'host-a', grant: 3 }
    })
    claims.release(THREAD, 4)
    claims.claim('thread-2', revisions, 0)
    claims.claimReply({
      threadId: 'thread-2',
      claimId: 2,
      granted: false,
      reason: 'host_ahead',
      revision: 9
    })
    expect(claims.claim('thread-2', revisions, 1)).toBeNull()
    claims.hostChanged('host-b')
    // The new Host counts its grants from one again, and has refused nothing yet.
    expect(claims.claim('thread-2', revisions, 1)).toMatchObject({ claimId: 3 })
    const again = claims.claim(THREAD, revisions, 1)!
    const epoch = { host: 'host-b', grant: 1 }
    expect(
      claims.claimReply({ threadId: THREAD, claimId: again.claimId, granted: true, epoch })
    ).toEqual({ kind: 'granted', epoch })
  })

  it('claims nothing while it has no Host', () => {
    const claims = new DesktopThreadClaims({ writerId: 'desk-1' })
    expect(claims.claim(THREAD, revisions, 0)).toBeNull()
    claims.hostChanged('host-a')
    expect(claims.claim(THREAD, revisions, 0)).not.toBeNull()
    claims.hostChanged(null)
    expect(claims.stateOf(THREAD)).toBe('unclaimed')
    expect(claims.claim(THREAD, revisions, 60_000)).toBeNull()
  })

  it('stops asking a Host that has log authority off, until the Host changes', () => {
    const claims = attachedClaims()
    claims.claim(THREAD, revisions, 0)
    claims.claimReply({
      threadId: THREAD,
      claimId: 1,
      granted: false,
      reason: 'disabled',
      revision: 4
    })
    expect(claims.claim(THREAD, revisions, 3_600_000)).toBeNull()
    expect(claims.claim('thread-2', revisions, 3_600_000)).toBeNull()
    claims.hostChanged('host-b')
    expect(claims.claim(THREAD, revisions, 3_600_000)).toMatchObject({ claimId: 2 })
  })

  it('remembers a refusal only until the retry interval has passed', () => {
    const claims = attachedClaims()
    for (let index = 0; index < 500; index++) {
      const threadId = `thread-${index}`
      const request = claims.claim(threadId, revisions, index)!
      claims.claimReply({
        threadId,
        claimId: request.claimId,
        granted: false,
        reason: 'host_ahead',
        revision: 9
      })
    }
    expect(claims.snapshot().refused.length).toBe(500)
    // The next claim, by any thread, sweeps every refusal that has aged out.
    claims.claim('thread-0', revisions, 499 + THREAD_CLAIM_RETRY_MS)
    expect(claims.snapshot().refused).toEqual([])
    expect(claims.snapshot().threads.length).toBe(1)
  })

  it('holds each refused thread back by its own claim, whatever order the refusals arrived in', () => {
    const claims = attachedClaims()
    const early = claims.claim('thread-early', revisions, 0)!
    const late = claims.claim('thread-late', revisions, 500)!
    // The later claim is answered first.
    for (const request of [late, early]) {
      claims.claimReply({
        threadId: request.threadId,
        claimId: request.claimId,
        granted: false,
        reason: 'host_run_active',
        revision: 9
      })
    }
    expect(claims.claim('thread-early', revisions, THREAD_CLAIM_RETRY_MS - 1)).toBeNull()
    expect(claims.claim('thread-early', revisions, THREAD_CLAIM_RETRY_MS)).toMatchObject({
      threadId: 'thread-early'
    })
    expect(claims.snapshot().refused).toEqual([['thread-late', 500 + THREAD_CLAIM_RETRY_MS]])
    expect(claims.claim('thread-late', revisions, 500 + THREAD_CLAIM_RETRY_MS - 1)).toBeNull()
    expect(claims.claim('thread-late', revisions, 500 + THREAD_CLAIM_RETRY_MS)).toMatchObject({
      threadId: 'thread-late'
    })
    expect(claims.snapshot().refused).toEqual([])
  })

  it('restores exactly what it snapshotted', () => {
    const claims = attachedClaims()
    claims.claim(THREAD, revisions, 0)
    claims.claimReply({ threadId: THREAD, claimId: 1, granted: true, epoch: EPOCH })
    claims.claim('thread-2', revisions, 10)
    const copy = DesktopThreadClaims.restore(claims.snapshot())
    expect(copy.snapshot()).toEqual(claims.snapshot())
    expect(copy.owns(THREAD)).toBe(true)
    expect(copy.claim('thread-3', revisions, 10)).toMatchObject({ claimId: 3, writerId: 'desk-1' })
  })
})

/*
 * Every interleaving inside explicit bounds.
 *
 * The world is one thread, one Host and two desktop slots. A slot holds one app
 * process at a time; a process that dies can be replaced by a new one with a
 * new writer id. Messages travel in both directions and may be delivered in any
 * order, never delivered (lost), or delivered twice. The Host restarts with an
 * empty table. Each kind of step has a budget, which is what makes the space
 * finite; inside the budgets every order of steps is tried.
 *
 * Disk is two revisions: the full copy and the head of the log. Ghost fields,
 * which the code under test never sees, record the truth the rules are about:
 * how many writes the thread has had, how many of them each process's copy
 * includes, and the same pair frozen into each claim when it was composed.
 *
 * What the world leaves out, on purpose:
 * - A process that does not hold the thread saves as it does today (it appends
 *   to its log and publishes by compare-and-swap) only where a scenario budgets
 *   for it, and only while it is the one app process alive: the app is
 *   single-instance, and two of them appending to one log is not this protocol.
 * - A message that can no longer change anything (a reply to a superseded
 *   claim, anything carrying an epoch that is no longer current) is delivered
 *   as soon as it becomes so, checked to change nothing, and dropped. That is
 *   the same as delivering it at any later moment, and keeps the space small.
 */

type ToHost =
  | {
      kind: 'claim'
      request: ThreadClaimRequest
      /** Ghost: writes the thread had had when the claim was composed. */
      writes: number
      /** Ghost: whether the claimer's copy included all of them. */
      current: boolean
    }
  | { kind: 'advanced'; message: ThreadAdvancedMessage }
  | { kind: 'release'; message: ThreadReleaseMessage }
  | { kind: 'declined'; message: ThreadReleaseDeclinedMessage }

type ToDesk =
  | { kind: 'reply'; reply: ThreadClaimReply }
  | { kind: 'request'; request: ThreadReleaseRequest }

interface Desk {
  /** Null while no app process runs in this slot. */
  writerId: string | null
  claims: DesktopThreadClaimsSnapshot | null
  /** The full copy this process's state is built on, and the head of the log it continues. */
  base: number
  head: number
  /** Ghost: how many of the thread's writes this process's copy includes. */
  seen: number
  /** Messages on their way to this process, each as JSON so the queue sorts cheaply. */
  inbox: string[]
}

interface Bounds {
  /** App processes running at the start (one or two). */
  desktops: number
  claims: number
  /** Appends by the process that holds the thread. */
  appends: number
  /** Saves by a process that does not hold the thread. */
  todaySaves: number
  advances: number
  publishes: number
  releases: number
  abandons: number
  deaths: number
  starts: number
  duplicates: number
  hostWrites: number
  asks: number
  runs: number
  hostRestarts: number
}

interface World {
  hostBoot: number
  table: HostThreadOwnerTableSnapshot
  hostRun: boolean
  full: number
  log: number
  /** Ghost: writes that changed the thread's content so far. */
  writes: number
  /** Ghost: the process whose append is the head of the log. */
  logWriter: string | null
  desks: Desk[]
  /** Messages on their way to the Host, each as JSON. */
  toHost: string[]
  spawned: number
  left: Bounds
}

type Note = (event: string) => void

interface Step {
  label: string
  apply(world: World, note: Note): void
}

const hostName = (boot: number): string => `host-${boot}`
const hostBootOf = (host: string): number => Number(host.slice('host-'.length))

const NO_PROCESS: Desk = { writerId: null, claims: null, base: 0, head: 0, seen: 0, inbox: [] }

/** Messages are few and repeat across states, so each distinct one is parsed once. */
const parsedMessages = new Map<string, ToHost | ToDesk>()
function read<T extends ToHost | ToDesk>(raw: string): T {
  let message = parsedMessages.get(raw)
  if (!message) parsedMessages.set(raw, (message = JSON.parse(raw) as ToHost | ToDesk))
  return message as T
}
const toHost = (message: ToHost): string => JSON.stringify(message)
const toDesk = (message: ToDesk): string => JSON.stringify(message)

function startDesk(world: World, slot: number): void {
  const writerId = `desk-${world.spawned++}`
  world.desks[slot] = {
    writerId,
    claims: new DesktopThreadClaims({ writerId, claimRetryMs: 1 }).snapshot(),
    // A cold read: the full copy, and the log where it leads.
    base: world.full,
    head: Math.max(world.full, world.log),
    seen: world.writes,
    inbox: []
  }
}

function initialWorld(bounds: Bounds): World {
  const world: World = {
    hostBoot: 0,
    table: new HostThreadOwnerTable({ incarnation: hostName(0), releaseBoundMs: 1 }).snapshot(),
    hostRun: false,
    full: 1,
    log: 1,
    writes: 0,
    logWriter: null,
    desks: [NO_PROCESS, NO_PROCESS],
    toHost: [],
    spawned: 0,
    left: { ...bounds }
  }
  for (let slot = 0; slot < bounds.desktops; slot++) {
    startDesk(world, slot)
    onClaims(world, slot, (claims) => claims.hostChanged(hostName(0)))
  }
  return world
}

/** Snapshots and messages are replaced, never edited, so a shallow copy is enough. */
function copyWorld(world: World): World {
  return {
    ...world,
    desks: world.desks.map((desk) => ({ ...desk, inbox: desk.inbox.slice() })),
    toHost: world.toHost.slice(),
    left: { ...world.left }
  }
}

function keyOf(world: World): string {
  world.toHost.sort()
  for (const desk of world.desks) desk.inbox.sort()
  return JSON.stringify(world)
}

function attached(world: World, desk: Desk): boolean {
  return desk.claims!.host === hostName(world.hostBoot)
}

function desktopPresence(world: World): HostDesktopPresence {
  const alive = world.desks.filter((desk) => desk.writerId !== null)
  if (alive.length === 0) return 'none'
  return alive.every((desk) => attached(world, desk)) ? 'attached' : 'unattached'
}

function otherDesktopUnattached(world: World, writerId: string): boolean {
  return world.desks.some(
    (desk) => desk.writerId !== null && desk.writerId !== writerId && !attached(world, desk)
  )
}

function heldEpoch(desk: Desk): ThreadOwnerEpoch | null {
  const entry = desk.claims?.threads.find((thread) => thread.threadId === THREAD)
  return entry && (entry.state === 'owned' || entry.state === 'releasing') ? entry.epoch : null
}

function holders(world: World): Desk[] {
  return world.desks.filter((desk) => heldEpoch(desk) !== null)
}

function onClaims<T>(world: World, slot: number, act: (claims: DesktopThreadClaims) => T): T {
  const desk = world.desks[slot]
  const claims = DesktopThreadClaims.restore(desk.claims!)
  const result = act(claims)
  desk.claims = claims.snapshot()
  return result
}

function onTable<T>(world: World, act: (table: HostThreadOwnerTable) => T): T {
  const table = HostThreadOwnerTable.restore(world.table)
  const result = act(table)
  world.table = table.snapshot()
  return result
}

function take(queue: string[], index: number, duplicate: boolean, world: World): string {
  const message = queue[index]
  if (duplicate) world.left.duplicates--
  else queue.splice(index, 1)
  return message
}

function reread(world: World, slot: number): void {
  const desk = world.desks[slot]
  desk.base = world.full
  desk.head = Math.max(world.full, world.log)
  desk.seen = world.writes
}

function hostWriteFacts(world: World): HostWriteFacts {
  return { fullCopyRevision: world.full, logRevision: world.log, desktop: desktopPresence(world) }
}

/** The Host changes the thread itself: only ever with nobody else holding it and nothing unpublished. */
function hostChangesThread(world: World): void {
  if (holders(world).length > 0) throw new Error('the Host wrote a thread a desktop holds')
  if (world.log > world.full) throw new Error('the Host wrote over unpublished desktop work')
  world.left.hostWrites--
  world.full += 1
  world.writes += 1
}

/** Whether a message to the Host names the grant, and for a decline the request, that is current. */
function isLive(world: World, message: Exclude<ToHost, { kind: 'claim' }>): boolean {
  const owned = world.table.threads.find((thread) => thread.threadId === THREAD)
  if (!owned || !sameThreadOwnerEpoch(owned.epoch, message.message.epoch)) return false
  return message.kind !== 'declined' || owned.request?.requestId === message.message.requestId
}

function receiveAtHost(world: World, note: Note, message: ToHost): void {
  const before = JSON.stringify(world.table)
  if (message.kind === 'claim') {
    const { request } = message
    const ownedBefore = world.table.threads.some((thread) => thread.threadId === THREAD)
    const reply = onTable(world, (table) =>
      table.claim(request, {
        fullCopyRevision: world.full,
        logRevision: world.log,
        hostRunActive: world.hostRun,
        otherDesktopUnattached: otherDesktopUnattached(world, request.writerId)
      })
    )
    const unchanged = JSON.stringify(world.table) === before
    if (!reply.granted) {
      if (!unchanged) throw new Error('a refused claim changed the table')
      note(`claim refused: ${reply.reason}`)
    } else if (ownedBefore) {
      if (!unchanged) throw new Error('answering the holder again changed the table')
      note('claim answered with the grant the holder already has')
    } else {
      if (!message.current || message.writes !== world.writes) {
        throw new Error('granted a claim from a writer that lacks a write')
      }
      note('claim granted')
      if (world.hostBoot > 0) note('claim granted by a restarted Host')
      if (world.log > world.full) {
        note(
          world.logWriter === request.writerId
            ? 'claim granted to carry on its own unpublished log'
            : 'claim granted to carry on the unpublished log of another process'
        )
      }
    }
    // The reply reaches the claimer only if that process is still running.
    const claimer = world.desks.find((desk) => desk.writerId === request.writerId)
    if (claimer) claimer.inbox.push(toDesk({ kind: 'reply', reply }))
    return
  }
  const live = isLive(world, message)
  if (message.kind === 'advanced') {
    const { message: advanced } = message
    onTable(world, (table) => table.advanced(advanced))
    if (!live && JSON.stringify(world.table) !== before) {
      throw new Error('an advance with a stale epoch changed the table')
    }
    note(live ? 'advance recorded' : 'advance with a stale epoch ignored')
    return
  }
  if (message.kind === 'release') {
    const { message: release } = message
    onTable(world, (table) => table.release(release))
    if (!live) {
      if (JSON.stringify(world.table) !== before) {
        throw new Error('a release with a stale epoch changed the table')
      }
      note('release with a stale epoch ignored')
      return
    }
    if (HostThreadOwnerTable.restore(world.table).writerOf(THREAD).kind !== 'host') {
      throw new Error('a release did not return the thread to the Host')
    }
    note('thread released to the Host')
    return
  }
  const { message: declined } = message
  onTable(world, (table) => table.releaseDeclined(declined))
  if (!live && JSON.stringify(world.table) !== before) {
    throw new Error('a stale decline changed the table')
  }
  note(live ? 'release declined' : 'stale decline ignored')
}

function receiveAtDesk(
  world: World,
  note: Note,
  slot: number,
  message: ToDesk,
  busy: boolean
): void {
  const desk = world.desks[slot]
  const held = heldEpoch(desk)
  if (message.kind === 'reply') {
    const outcome = onClaims(world, slot, (claims) => claims.claimReply(message.reply))
    note(`claim reply ${outcome.kind}`)
    return
  }
  const { request } = message
  const outcome = onClaims(world, slot, (claims) => claims.releaseRequested(request, busy))
  if (outcome.kind === 'declined') {
    world.toHost.push(toHost({ kind: 'declined', message: outcome.declined }))
  }
  if (outcome.kind === 'handed_back') {
    world.toHost.push(toHost({ kind: 'release', message: outcome.release }))
  }
  const after = heldEpoch(desk)
  if (held && !sameThreadOwnerEpoch(held, request.epoch)) {
    if (!after || !sameThreadOwnerEpoch(after, held)) {
      throw new Error('a release request for another epoch took the thread from its holder')
    }
    note('release request for another epoch left the holder alone')
  }
  note(`release request ${outcome.kind}`)
}

/**
 * Delivers, checks and drops every message that can no longer change anything,
 * until none is left. Epochs, claim ids and request ids are never reused, so a
 * message that is stale now is stale for ever.
 */
function settleDeadMessages(world: World, note: Note): void {
  for (let settled = false; !settled; ) {
    settled = true
    for (let index = world.toHost.length - 1; index >= 0; index--) {
      const message = read<ToHost>(world.toHost[index])
      if (message.kind === 'claim' || isLive(world, message)) continue
      world.toHost.splice(index, 1)
      receiveAtHost(world, note, message)
      settled = false
    }
    world.desks.forEach((desk, slot) => {
      if (desk.writerId === null) return
      for (let index = desk.inbox.length - 1; index >= 0; index--) {
        const message = read<ToDesk>(desk.inbox[index])
        if (message.kind === 'reply') {
          const { claimId } = message.reply
          const waiting = desk.claims!.threads.some(
            (thread) => thread.state === 'claiming' && thread.claimId === claimId
          )
          if (waiting) continue
        } else {
          // A process only ever moves to a newer Host, so only a request from
          // an older one than it knows, or will come to know, is dead.
          const knows = desk.claims!.host === null ? world.hostBoot : hostBootOf(desk.claims!.host)
          if (hostBootOf(message.request.epoch.host) >= knows) continue
        }
        desk.inbox.splice(index, 1)
        const before = JSON.stringify(desk.claims)
        receiveAtDesk(world, note, slot, message, false)
        if (JSON.stringify(desk.claims) !== before) {
          throw new Error('a message that should be dead changed a process')
        }
        settled = false
      }
    })
  }
}

function stepsFrom(world: World): Step[] {
  const steps: Step[] = []
  const add = (label: string, apply: Step['apply']): void => {
    steps.push({ label, apply })
  }
  const host = hostName(world.hostBoot)
  const table = HostThreadOwnerTable.restore(world.table)
  const durableHead = Math.max(world.full, world.log)

  world.desks.forEach((desk, slot) => {
    if (desk.writerId === null) {
      if (world.left.starts > 0) {
        add(`slot ${slot}: a new app process starts`, (next) => {
          next.left.starts--
          startDesk(next, slot)
        })
      }
      return
    }
    const name = desk.writerId
    const claims = DesktopThreadClaims.restore(desk.claims!)
    const state = claims.stateOf(THREAD)
    const holds = claims.owns(THREAD)
    const stale =
      desk.base !== world.full || desk.head !== durableHead || desk.seen !== world.writes

    if (desk.claims!.host !== host) {
      add(`${name} connects to ${host}`, (next, note) => {
        const reassert = onClaims(next, slot, (c) => c.hostChanged(hostName(next.hostBoot)))
        note(reassert.length > 0 ? 'told to re-assert after a Host restart' : 'connected')
      })
    }
    if (world.left.claims > 0 && !holds) {
      const now = desk.claims!.claimSeq
      if (claims.claim(THREAD, { baseRevision: 0, headRevision: 0 }, now) !== null) {
        // A process that does not hold the thread may claim with the copy it
        // has, which can be out of date, or read the thread again first.
        for (const fresh of stale ? [false, true] : [false]) {
          add(`${name} ${fresh ? 're-reads and ' : ''}claims`, (next) => {
            if (fresh) reread(next, slot)
            const claimer = next.desks[slot]
            const revisions = { baseRevision: claimer.base, headRevision: claimer.head }
            const request = onClaims(next, slot, (c) => c.claim(THREAD, revisions, now))!
            next.left.claims--
            next.toHost.push(
              toHost({
                kind: 'claim',
                request,
                writes: next.writes,
                current: claimer.seen === next.writes
              })
            )
          })
        }
      }
    }
    if (holds && world.left.appends > 0) {
      add(`${name} appends`, (next, note) => {
        const writer = next.desks[slot]
        if (writer.seen !== next.writes || writer.head !== Math.max(next.full, next.log)) {
          throw new Error('a holder appended to a thread it had not caught up with')
        }
        next.left.appends--
        writer.head += 1
        next.log = writer.head
        next.logWriter = name
        next.writes += 1
        writer.seen = next.writes
        note(
          attached(next, writer) ? 'holder appended' : 'holder appended before noticing a restart'
        )
      })
    }
    const alone = world.desks.every((other) => other === desk || other.writerId === null)
    if (!holds && alone && world.left.todaySaves > 0) {
      add(`${name} saves without holding the thread`, (next, note) => {
        const saver = next.desks[slot]
        const upToDate = saver.seen === next.writes
        next.left.todaySaves--
        saver.head += 1
        next.log = saver.head
        next.logWriter = name
        next.writes += 1
        // A copy that had missed a write still misses it after adding its own.
        if (upToDate) saver.seen = next.writes
        note(
          upToDate
            ? 'saved without holding the thread'
            : 'saved on top of a copy that lacks a write'
        )
      })
    }
    if (holds && world.left.advances > 0) {
      add(`${name} reports its head`, (next) => {
        const message = onClaims(next, slot, (c) => c.advanced(THREAD, next.desks[slot].head))!
        next.left.advances--
        next.toHost.push(toHost({ kind: 'advanced', message }))
      })
    }
    if (world.left.publishes > 0) {
      const admitted = table.mayReplaceFullCopy(THREAD, name, {
        otherDesktopUnattached: otherDesktopUnattached(world, name)
      })
      // The Host stores a full copy only on top of the one the sender built on.
      const asItIs = desk.head > desk.base && desk.base === world.full
      const afterReading = !holds && stale && durableHead > world.full
      for (const fresh of [false, true]) {
        if (!admitted || !(fresh ? afterReading : asItIs)) continue
        add(`${name} ${fresh ? 're-reads and ' : ''}publishes a full copy`, (next, note) => {
          if (fresh) reread(next, slot)
          if (holders(next).some((holder) => holder.writerId !== name)) {
            throw new Error('a full copy was replaced under another holder')
          }
          next.left.publishes--
          next.full = next.desks[slot].head
          next.desks[slot].base = next.full
          note('full copy published')
        })
      }
    }
    if (state === 'owned' && world.left.releases > 0) {
      add(`${name} releases`, (next) => {
        const message = onClaims(next, slot, (c) => c.release(THREAD, next.desks[slot].head))!
        next.left.releases--
        next.toHost.push(toHost({ kind: 'release', message }))
      })
    }
    if (state === 'releasing') {
      add(`${name} finishes the release it was asked for`, (next) => {
        const message = onClaims(next, slot, (c) => c.release(THREAD, next.desks[slot].head))!
        next.toHost.push(toHost({ kind: 'release', message }))
      })
      if (world.left.abandons > 0) {
        add(`${name} gives up the release it was asked for`, (next) => {
          const message = onClaims(next, slot, (c) => c.releaseAbandoned(THREAD))!
          next.left.abandons--
          next.toHost.push(toHost({ kind: 'declined', message }))
        })
      }
    }
    const held = heldEpoch(desk)
    desk.inbox.forEach((raw, index) => {
      const message = read<ToDesk>(raw)
      // Being busy only matters to a process that is asked for a thread it holds and is not already releasing.
      const mayDecline =
        message.kind === 'request' &&
        state === 'owned' &&
        held !== null &&
        sameThreadOwnerEpoch(held, message.request.epoch)
      for (const duplicate of world.left.duplicates > 0 ? [false, true] : [false]) {
        for (const busy of mayDecline ? [false, true] : [false]) {
          const what = message.kind === 'reply' ? 'a claim reply' : 'a release request'
          const how = `${mayDecline ? (busy ? ', busy,' : ', idle,') : ''} receives ${what}`
          add(`${name}${how}${duplicate ? ', which will arrive again' : ''}`, (next, note) => {
            take(next.desks[slot].inbox, index, duplicate, next)
            receiveAtDesk(next, note, slot, message, busy)
          })
        }
      }
    })
    if (world.left.deaths > 0) {
      add(`${name} dies`, (next) => {
        next.left.deaths--
        next.desks[slot] = NO_PROCESS
      })
    }
  })

  world.toHost.forEach((raw, index) => {
    const message = read<ToHost>(raw)
    for (const duplicate of world.left.duplicates > 0 ? [false, true] : [false]) {
      add(
        `the Host receives ${message.kind}${duplicate ? ', which will arrive again' : ''}`,
        (next, note) => {
          take(next.toHost, index, duplicate, next)
          receiveAtHost(next, note, message)
        }
      )
    }
  })

  const decision = table.requestHostWrite(THREAD, hostWriteFacts(world), 0)
  if (decision.kind === 'write' && world.left.hostWrites > 0) {
    add('the Host changes the thread', (next, note) => {
      const again = onTable(next, (t) => t.requestHostWrite(THREAD, hostWriteFacts(next), 0))
      if (again.kind !== 'write') throw new Error('the decision changed between two looks')
      hostChangesThread(next)
      note('Host wrote')
    })
  }
  if (decision.kind === 'write' && !world.hostRun && world.left.runs > 0) {
    add('a Host run starts on the thread', (next) => {
      next.left.runs--
      next.hostRun = true
    })
  }
  if (decision.kind === 'fold_first') {
    add('the Host folds the log into the full copy', (next, note) => {
      if (desktopPresence(next) !== 'none') throw new Error('folded while a desktop is alive')
      if (decision.revision !== next.log) throw new Error('folded to the wrong revision')
      next.full = next.log
      note('Host folded unpublished work before writing')
    })
  }
  if (decision.kind === 'ask_release' && decision.created && world.left.asks > 0) {
    add('the Host asks the holder to release', (next, note) => {
      const asked = onTable(next, (t) => t.requestHostWrite(THREAD, hostWriteFacts(next), 0))
      if (asked.kind !== 'ask_release') throw new Error('the decision changed between two looks')
      next.left.asks--
      // The request reaches the holder only if that process is still running.
      const holder = next.desks.find((desk) => desk.writerId === asked.writerId)
      if (holder) holder.inbox.push(toDesk({ kind: 'request', request: asked.request }))
      note('release requested')
    })
  }
  // A `busy` decision is no step: the Host command fails and nothing changes.
  if (world.hostRun) {
    if (world.left.hostWrites > 0) {
      add('the Host run changes the thread', (next, note) => {
        hostChangesThread(next)
        note('Host run wrote')
      })
    }
    add('the Host run ends', (next) => {
      next.hostRun = false
    })
  }
  const owned = world.table.threads.find((thread) => thread.threadId === THREAD)
  if (owned?.request) {
    add('the release request lapses', (next, note) => {
      const lapsed = onTable(next, (t) => t.expireReleaseRequests(owned.request!.deadline))
      if (lapsed.length !== 1) throw new Error('the request did not lapse at its deadline')
      if (!next.table.threads.some((thread) => thread.writerId === owned.writerId)) {
        throw new Error('a lapsed request took the thread from its holder')
      }
      note('release request lapsed')
    })
  }
  if (owned && !world.desks.some((desk) => desk.writerId === owned.writerId)) {
    add('the Host finds the holder dead', (next, note) => {
      onTable(next, (t) => t.writerGone(owned.writerId))
      note('dead holder removed')
    })
  }
  if (world.left.hostRestarts > 0) {
    add('the Host restarts', (next) => {
      next.left.hostRestarts--
      next.hostBoot += 1
      next.hostRun = false
      next.table = new HostThreadOwnerTable({
        incarnation: hostName(next.hostBoot),
        releaseBoundMs: 1
      }).snapshot()
    })
  }
  return steps
}

/** What must hold in every state the world can reach. */
function checkWorld(world: World): void {
  const holding = holders(world)
  if (holding.length > 1) throw new Error('two desktop writers hold the thread')
  const owned = world.table.threads.find((thread) => thread.threadId === THREAD)
  if (world.hostRun && (holding.length > 0 || owned)) {
    throw new Error('a Host run is live on a thread a desktop holds')
  }
  for (const desk of holding) {
    const epoch = heldEpoch(desk)!
    // A grant from a Host that has since restarted is judged when the process claims again.
    if (epoch.host !== hostName(world.hostBoot)) continue
    if (!owned || owned.writerId !== desk.writerId || !sameThreadOwnerEpoch(owned.epoch, epoch)) {
      throw new Error('a desktop holds a grant the Host table does not')
    }
  }
}

interface Exploration {
  states: number
  steps: number
  events: Map<string, number>
  violation: string | null
}

function explore(bounds: Bounds, limit = 2_000_000): Exploration {
  const events = new Map<string, number>()
  const note: Note = (event) => {
    events.set(event, (events.get(event) ?? 0) + 1)
  }
  const reached = new Set<string>()
  const frontier: (string | null)[] = []
  const cameFrom: number[] = []
  const cameBy: string[] = []
  const admit = (key: string, digest: string, from: number, label: string): void => {
    reached.add(digest)
    frontier.push(key)
    cameFrom.push(from)
    cameBy.push(label)
  }
  const digestOf = (key: string): string => createHash('sha1').update(key).digest('binary')
  const trace = (index: number): string[] =>
    index <= 0 ? [] : [...trace(cameFrom[index]), cameBy[index]]
  const first = keyOf(initialWorld(bounds))
  admit(first, digestOf(first), -1, 'start')
  let steps = 0
  for (let index = 0; index < frontier.length; index++) {
    const world = JSON.parse(frontier[index]!) as World
    frontier[index] = null
    for (const step of stepsFrom(world)) {
      const next = copyWorld(world)
      try {
        step.apply(next, note)
        settleDeadMessages(next, note)
        checkWorld(next)
      } catch (error) {
        const path = [...trace(index), step.label].map((line, at) => `${at + 1}. ${line}`)
        return {
          states: reached.size,
          steps,
          events,
          violation: `${(error as Error).message}\n${path.join('\n')}`
        }
      }
      steps++
      const key = keyOf(next)
      const digest = digestOf(key)
      if (reached.has(digest)) continue
      if (reached.size >= limit) {
        return { states: reached.size, steps, events, violation: 'the space outgrew its limit' }
      }
      admit(key, digest, index, step.label)
    }
  }
  return { states: reached.size, steps, events, violation: null }
}

interface Scenario {
  name: string
  bounds: Bounds
  /** Distinct world states reached, and steps taken between them. */
  states: number
  steps: number
  /** Things this scenario must actually have done, or its silence proves nothing. */
  mustSee: string[]
}

const NOTHING: Bounds = {
  desktops: 1,
  claims: 0,
  appends: 0,
  todaySaves: 0,
  advances: 0,
  publishes: 0,
  releases: 0,
  abandons: 0,
  deaths: 0,
  starts: 0,
  duplicates: 0,
  hostWrites: 0,
  asks: 0,
  runs: 0,
  hostRestarts: 0
}

/*
 * The explored space. One space with every budget at once is far too large to
 * run here, so each scenario spends its budget on one kind of trouble. The
 * sizes are pinned: a change to the rules or to the world moves them, and
 * whoever moves them should look at why.
 */
const SCENARIOS: Scenario[] = [
  {
    name: 'two app processes contend for a thread while the Host writes it, runs on it and asks for it back',
    bounds: {
      ...NOTHING,
      desktops: 2,
      claims: 2,
      appends: 1,
      advances: 1,
      publishes: 1,
      releases: 1,
      abandons: 1,
      hostWrites: 1,
      asks: 1,
      runs: 1
    },
    states: 62894,
    steps: 205992,
    mustSee: [
      'claim granted',
      'claim granted to carry on its own unpublished log',
      'claim answered with the grant the holder already has',
      'claim refused: owned_by_other_writer',
      'claim refused: host_run_active',
      'claim refused: host_ahead',
      'claim reply granted',
      'claim reply refused',
      'claim reply ignored',
      'holder appended',
      'advance recorded',
      'advance with a stale epoch ignored',
      'full copy published',
      'thread released to the Host',
      'release with a stale epoch ignored',
      'release requested',
      'release request declined',
      'release request release_started',
      'release request handed_back',
      'release request lapsed',
      'release declined',
      'stale decline ignored',
      'Host wrote',
      'Host run wrote'
    ]
  },
  {
    name: 'one app process whose messages are lost, repeated and overtaken',
    bounds: {
      ...NOTHING,
      claims: 2,
      releases: 1,
      abandons: 1,
      duplicates: 2,
      hostWrites: 1,
      asks: 2
    },
    states: 32282,
    steps: 147986,
    mustSee: [
      'claim granted',
      'claim answered with the grant the holder already has',
      'claim refused: host_ahead',
      'claim reply ignored',
      'thread released to the Host',
      'release with a stale epoch ignored',
      'release request handed_back',
      'release request for another epoch left the holder alone',
      'release request lapsed',
      'release declined',
      'stale decline ignored',
      'Host wrote'
    ]
  },
  {
    name: 'the Host restarts twice under one app process',
    bounds: {
      ...NOTHING,
      claims: 3,
      appends: 2,
      publishes: 1,
      hostWrites: 1,
      asks: 1,
      runs: 1,
      hostRestarts: 2
    },
    states: 65348,
    steps: 216050,
    mustSee: [
      'told to re-assert after a Host restart',
      'holder appended before noticing a restart',
      'claim granted by a restarted Host',
      'claim granted to carry on its own unpublished log',
      'claim refused: host_ahead',
      'claim refused: host_run_active',
      'release request ignored',
      'release with a stale epoch ignored',
      'Host wrote',
      'Host run wrote'
    ]
  },
  {
    name: 'the Host restarts under two app processes',
    bounds: {
      ...NOTHING,
      desktops: 2,
      claims: 2,
      appends: 1,
      publishes: 1,
      hostWrites: 1,
      runs: 1,
      hostRestarts: 1
    },
    states: 7693,
    steps: 18584,
    mustSee: [
      'told to re-assert after a Host restart',
      'holder appended before noticing a restart',
      'claim granted by a restarted Host',
      'claim refused: owned_by_other_writer',
      'claim refused: host_ahead',
      'Host wrote'
    ]
  },
  {
    name: 'an app process that saves as it does today claims the thread while the Host changes it',
    bounds: {
      ...NOTHING,
      claims: 2,
      appends: 1,
      todaySaves: 2,
      publishes: 1,
      hostWrites: 1,
      hostRestarts: 1
    },
    states: 4889,
    steps: 11856,
    mustSee: [
      'saved without holding the thread',
      'saved on top of a copy that lacks a write',
      'claim granted to carry on its own unpublished log',
      'claim refused: host_ahead',
      'claim granted by a restarted Host',
      'full copy published',
      'Host wrote'
    ]
  },
  {
    name: 'an app process dies and a new one starts, with a Host restart in between',
    bounds: {
      ...NOTHING,
      claims: 2,
      appends: 1,
      publishes: 1,
      deaths: 1,
      starts: 1,
      hostWrites: 1,
      asks: 1,
      hostRestarts: 1
    },
    states: 47572,
    steps: 170833,
    mustSee: [
      'dead holder removed',
      'Host folded unpublished work before writing',
      'claim granted to carry on the unpublished log of another process',
      'claim refused: owned_by_other_writer',
      'claim granted by a restarted Host',
      'release request lapsed',
      'Host wrote'
    ]
  }
]

describe('who may write a thread: every interleaving inside the bounds', () => {
  for (const scenario of SCENARIOS) {
    it(
      scenario.name,
      () => {
        const result = explore(scenario.bounds)
        expect(result.violation).toBeNull()
        for (const event of scenario.mustSee) {
          expect(result.events.get(event) ?? 0, event).toBeGreaterThan(0)
        }
        expect({ states: result.states, steps: result.steps }).toEqual({
          states: scenario.states,
          steps: scenario.steps
        })
      },
      120_000
    )
  }
})
