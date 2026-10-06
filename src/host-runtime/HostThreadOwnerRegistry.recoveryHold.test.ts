import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ThreadAuthorityFiles } from '../host-shared/thread-log/ThreadAuthorityFile'
import type {
  ThreadClaimReply,
  ThreadClaimRequest
} from '../host-shared/thread-log/ThreadOwnership'
import { HostThreadOwnerRegistry } from './HostThreadOwnerRegistry'

const THREAD = 'thread-recovery-hold'
const TEMPORARY_PREFIX = 'host-owner-registry-recovery-hold-'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  const made = temporary + path.sep + TEMPORARY_PREFIX
  if (
    directory === temporary ||
    !directory.startsWith(made) ||
    directory.length <= made.length ||
    path.dirname(directory) !== temporary
  )
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  fs.rmSync(directory, { recursive: true, force: true })
}

function claim(writerId: string, claimId: number): ThreadClaimRequest {
  return {
    action: 'claim',
    threadId: THREAD,
    writerId,
    claimId,
    baseRevision: 4,
    headRevision: 4
  }
}

function refused(reply: ThreadClaimReply): { reason: string; revision: number | null } {
  if (reply.granted) throw new Error('claim granted')
  return { reason: reply.reason, revision: reply.revision }
}

/**
 * What the production wiring composes: `hostRunActive` also reports threads
 * the catalogue recovery controller holds (`hasPendingHold`), so a desktop
 * claim on a thread under a pending recovery hold is refused until the
 * thread is explicitly taken over. At registry level that is the
 * `hostRunActive` callback answering true.
 */
describe('the Host thread owner registry: a pending recovery hold refuses a claim', () => {
  it('refuses with host_run_active while hostRunActive reports the held recovery, grants after the takeover', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    try {
      const files = new ThreadAuthorityFiles(profile)
      let recoveryHeld = true
      const registry = new HostThreadOwnerRegistry({
        incarnation: 'host-a',
        enabled: true,
        files,
        fullCopyRevision: () => 4,
        logRevision: async () => null,
        hostRunActive: (threadId) => threadId === THREAD && recoveryHeld,
        desktopPresence: () => 'attached',
        otherDesktopUnattached: () => false
      })

      expect(refused(await registry.claim(claim('desk-a', 1)))).toEqual({
        reason: 'host_run_active',
        revision: 4
      })
      // The explicit per-thread takeover ends the hold; the same claim is
      // then granted.
      recoveryHeld = false
      expect((await registry.claim(claim('desk-a', 2))).granted).toBe(true)
    } finally {
      removeTemporaryDirectory(profile)
    }
  })
})
