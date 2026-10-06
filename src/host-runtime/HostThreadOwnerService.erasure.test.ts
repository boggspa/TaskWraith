/**
 * Erasure invalidation in the owner service: a publication permit captured
 * before an erasure is no longer current afterwards, for one thread and
 * globally, while a permit captured after invalidation is current again.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { THREAD_LOG_AUTHORITY_ENV } from '../host-shared/thread-log/ThreadLogAuthoritySwitch'
import { TASKWRAITH_HOST_TXN_PERSIST_ENV } from './HostCommandExecutionClass'
import {
  HostThreadOwnerService,
  type HostThreadOwnerServiceOptions
} from './HostThreadOwnerService'

const TEMPORARY_PREFIX = 'host-thread-owner-service-erasure-'
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

beforeEach(() => {
  profile = mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  copies = new Map()
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
    hostRunActive: () => false,
    ...extra
  })
}

const claim = (threadId: string, writerId: string, revisions: [number, number]) => ({
  action: 'claim' as const,
  threadId,
  writerId,
  claimId: 1,
  baseRevision: revisions[0],
  headRevision: revisions[1]
})

function grantOf(result: unknown): { host: string; grant: number } {
  const reply = (result as { reply: { granted: boolean; epoch?: { host: string; grant: number } } })
    .reply
  if (!reply.granted || !reply.epoch) throw new Error(`not granted: ${JSON.stringify(reply)}`)
  return reply.epoch
}

describe('the owner service’s erasure invalidation', () => {
  it('a permit captured before an erasure is no longer current after it', async () => {
    const on = service(ON)
    copies.set('thread-1', 3)
    copies.set('thread-2', 3)
    grantOf(await on.answer(1, claim('thread-1', 'desk-1', [3, 3])))
    grantOf(await on.answer(2, claim('thread-2', 'desk-2', [3, 3])))
    const first = on.capturePublication(1, 'thread-1')
    const second = on.capturePublication(2, 'thread-2')
    const commit = vi.fn(() => 'saved')
    expect(await on.publish(first, commit)).toEqual({ kind: 'published', value: 'saved' })
    on.invalidatePublicationForErasure('thread-1')
    expect(await on.publish(first, commit)).toMatchObject({ kind: 'refused' })
    // Only the erased thread was invalidated.
    expect(await on.publish(second, commit)).toEqual({ kind: 'published', value: 'saved' })
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it('a global erasure invalidates every captured permit at once', async () => {
    const on = service(ON)
    copies.set('thread-1', 3)
    copies.set('thread-2', 3)
    grantOf(await on.answer(1, claim('thread-1', 'desk-1', [3, 3])))
    grantOf(await on.answer(2, claim('thread-2', 'desk-2', [3, 3])))
    const first = on.capturePublication(1, 'thread-1')
    const second = on.capturePublication(2, 'thread-2')
    const commit = vi.fn(() => 'saved')
    on.invalidatePublicationForErasure()
    expect(await on.publish(first, commit)).toMatchObject({ kind: 'refused' })
    expect(await on.publish(second, commit)).toMatchObject({ kind: 'refused' })
    expect(commit).not.toHaveBeenCalled()
  })

  it('a permit captured after the invalidation is current again', async () => {
    const on = service(ON)
    copies.set('thread-1', 3)
    grantOf(await on.answer(1, claim('thread-1', 'desk-1', [3, 3])))
    const stale = on.capturePublication(1, 'thread-1')
    on.invalidatePublicationForErasure('thread-1')
    const fresh = on.capturePublication(1, 'thread-1')
    const commit = vi.fn(() => 'saved')
    expect(await on.publish(stale, commit)).toMatchObject({ kind: 'refused' })
    expect(await on.publish(fresh, commit)).toEqual({ kind: 'published', value: 'saved' })
    expect(commit).toHaveBeenCalledTimes(1)
  })
})
