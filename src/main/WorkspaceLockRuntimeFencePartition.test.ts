/**
 * Two write calls of ONE run to one file. They have the same owner, so their
 * leases never conflict and the commit fence is the only thing that
 * serializes them.
 *
 * Every caller (the MCP executor, main's native tool path, candidate
 * promotion, shared-workspace actions) fences the partitions of its ADMISSION
 * claims, then refreshes its claims and commits. The object under one path can
 * change between two admissions: created (planned to dev:ino), atomically
 * replaced (one dev:ino to another) or deleted (dev:ino to planned). Whatever
 * identity each call admitted, the second call must wait for the first.
 *
 * Driven in the executor's order through a real WorkspaceLockRuntime over a
 * temporary root: the real authority, the real commit fence and the real
 * partition function. Only the process identity is injected.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceLockProcessIdentityService } from './WorkspaceLockProcessIdentity'
import {
  WorkspaceLockRuntime,
  mutationFencePartitionKeys,
  type WorkspaceMutationCommitFenceAcquisition
} from './WorkspaceLockRuntime'
import {
  WorkspaceMutationCommitFence,
  WorkspaceMutationCommitFenceBusyError
} from './workLocks/WorkspaceMutationCommitFence'
import type {
  CanonicalWorkspaceLockClaim,
  WorkspaceLockOwner
} from './workLocks/WorkspaceLockTypes'

const BIRTH = 'fence-partition-birth'

/** Whether the temporary volume folds case, as macOS's default APFS does. */
const caseInsensitiveTmp = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-case-probe-'))
  try {
    fs.writeFileSync(path.join(dir, 'a'), '')
    return fs.existsSync(path.join(dir, 'A'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})()
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

interface Call {
  owner: WorkspaceLockOwner
  transitionId: string
  claims: readonly CanonicalWorkspaceLockClaim[]
}

async function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-fence-partition-')))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const userData = path.join(root, 'user-data')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(userData)
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
  const live = async () => ({ state: 'live' as const, processBirthIdentity: BIRTH })
  const runtime = await WorkspaceLockRuntime.open({
    userDataRoot: userData,
    instanceId: 'instance-fence-partition',
    processIdentity: {
      initialize: async () => BIRTH,
      currentProcessIdentity: () => BIRTH,
      observe: live,
      dispose: () => {}
    } as unknown as WorkspaceLockProcessIdentityService
  })
  cleanups.push(() => runtime.dispose())
  // Ends any fence wait this test left behind before the root goes away.
  let alive = true
  cleanups.push(() => {
    alive = false
  })
  // A second handle on the same fence directory, used only to probe.
  const probe = new WorkspaceMutationCommitFence({ userDataRoot: userData, observeProcess: live })
  const run = { lockOwnerId: 'owner-run-1', runId: 'run-1', chatId: 'chat-1' }
  const target = (file: string) => path.join(workspace, 'src', file)
  const request = (file: string) => ({
    workspacePath: workspace,
    kind: 'file' as const,
    targetPath: target(file)
  })

  /** One tool call's admission: its leases, and the claims the executor fences. */
  const admit = async (file: string): Promise<Call> => {
    const acquired = await runtime.acquireClaims(run, [request(file)])
    if (!acquired.ok) throw new Error(`admission failed: ${acquired.message}`)
    return {
      owner: acquired.owner,
      transitionId: acquired.authority.transitionId,
      claims: acquired.authority.leases.map((lease) => lease.claim)
    }
  }
  const fence = (call: Call) => runtime.acquireMutationFence(call.owner, call.claims, () => alive)
  /** The executor's refresh and verification, under the fence it already holds. */
  const refresh = async (call: Call, file: string): Promise<Call> => {
    const replaced = await runtime.replaceClaims(call.owner, call.transitionId, [request(file)])
    if (!replaced.ok) throw new Error(`replace failed: ${replaced.message}`)
    const verified = await runtime.verifyAcquisitionForMutation(
      call.owner,
      replaced.authority.transitionId
    )
    expect(verified.ok).toBe(true)
    return {
      owner: call.owner,
      transitionId: replaced.authority.transitionId,
      claims: replaced.authority.leases.map((lease) => lease.claim)
    }
  }

  /**
   * The second call cannot enter while the first is inside: they share a
   * partition the first holds, the fence refuses the second there, and the
   * runtime keeps the second waiting until the first releases.
   */
  const expectSerialized = async (
    first: WorkspaceMutationCommitFenceAcquisition,
    second: Call
  ): Promise<WorkspaceMutationCommitFenceAcquisition> => {
    const held = new Set(first.owners.map((owner) => owner.partitionKey))
    const shared = mutationFencePartitionKeys(second.claims).filter((key) => held.has(key))
    expect(shared).not.toEqual([])
    await expect(probe.acquire(second.owner, shared[0])).rejects.toBeInstanceOf(
      WorkspaceMutationCommitFenceBusyError
    )
    const entering = fence(second)
    entering.catch(() => {})
    expect(await settlesWithin(entering, 600)).toBe(false)
    runtime.releaseMutationFence(first)
    return entering
  }
  return { runtime, target, admit, fence, refresh, expectSerialized }
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true
      ),
      expired
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('two same-run writers to one file serialize on the commit fence', () => {
  it('when the first call admitted the file absent and it was created mid-commit', async () => {
    const w = await world()
    // Call 1 is admitted while the file is absent: a planned identity.
    const first = await w.admit('new.ts')
    expect(first.claims[0].objectIdentity).toMatch(/^planned:/)
    const firstFence = await w.fence(first)
    // A sibling call, a native provider or an editor creates it before call 1 refreshes.
    fs.writeFileSync(w.target('new.ts'), 'created mid-commit\n')
    const refreshed = await w.refresh(first, 'new.ts')
    expect(refreshed.claims[0].objectIdentity).toMatch(/^dev:/)

    // Call 2 of the same run is admitted now, with the dev:ino identity.
    const second = await w.admit('new.ts')
    expect(second.claims[0].objectIdentity).toBe(refreshed.claims[0].objectIdentity)
    const secondFence = await w.expectSerialized(firstFence, second)
    await w.refresh(second, 'new.ts')
    w.runtime.releaseMutationFence(secondFence)
  })

  it('when an atomic save replaced the file with another inode mid-commit', async () => {
    const w = await world()
    fs.writeFileSync(w.target('a.ts'), 'v1\n')
    const first = await w.admit('a.ts')
    const firstFence = await w.fence(first)
    // An editor's atomic save: a temporary renamed over the file.
    fs.writeFileSync(w.target('a.ts.save-tmp'), 'v2\n')
    fs.renameSync(w.target('a.ts.save-tmp'), w.target('a.ts'))
    const refreshed = await w.refresh(first, 'a.ts')
    expect(refreshed.claims[0].objectIdentity).toMatch(/^dev:/)
    expect(refreshed.claims[0].objectIdentity).not.toBe(first.claims[0].objectIdentity)

    const second = await w.admit('a.ts')
    expect(second.claims[0].objectIdentity).toBe(refreshed.claims[0].objectIdentity)
    w.runtime.releaseMutationFence(await w.expectSerialized(firstFence, second))
  })

  it('when the file was deleted mid-commit', async () => {
    const w = await world()
    fs.writeFileSync(w.target('b.ts'), 'v1\n')
    const first = await w.admit('b.ts')
    expect(first.claims[0].objectIdentity).toMatch(/^dev:/)
    const firstFence = await w.fence(first)
    fs.rmSync(w.target('b.ts'))
    const refreshed = await w.refresh(first, 'b.ts')
    expect(refreshed.claims[0].objectIdentity).toMatch(/^planned:/)

    const second = await w.admit('b.ts')
    expect(second.claims[0].objectIdentity).toMatch(/^planned:/)
    w.runtime.releaseMutationFence(await w.expectSerialized(firstFence, second))
  })

  it('when nothing changed under the path (the case that already worked)', async () => {
    const w = await world()
    fs.writeFileSync(w.target('same.ts'), 'v1\n')
    const first = await w.admit('same.ts')
    const firstFence = await w.fence(first)
    const second = await w.admit('same.ts')
    expect(second.claims[0].objectIdentity).toBe(first.claims[0].objectIdentity)
    w.runtime.releaseMutationFence(await w.expectSerialized(firstFence, second))
  })

  it.skipIf(process.platform === 'win32')(
    'when the second call names another path to the same inode (a hard link)',
    async () => {
      const w = await world()
      fs.writeFileSync(w.target('c.ts'), 'c\n')
      fs.linkSync(w.target('c.ts'), w.target('c-link.ts'))
      const first = await w.admit('c.ts')
      const firstFence = await w.fence(first)
      const alias = await w.admit('c-link.ts')
      expect(alias.claims[0].objectIdentity).toBe(first.claims[0].objectIdentity)
      w.runtime.releaseMutationFence(await w.expectSerialized(firstFence, alias))
    }
  )

  it.skipIf(!caseInsensitiveTmp)(
    'when the second call spells the file in another case after it was created',
    async () => {
      const w = await world()
      // Call 1 is admitted while the file is absent, spelled new.ts.
      const first = await w.admit('new.ts')
      expect(first.claims[0].objectIdentity).toMatch(/^planned:/)
      const firstFence = await w.fence(first)
      // A sibling call or an editor creates it as NEW.ts: the same file here.
      fs.writeFileSync(w.target('NEW.ts'), 'created\n')
      const second = await w.admit('NEW.ts')
      expect(second.claims[0].objectIdentity).toMatch(/^dev:/)
      w.runtime.releaseMutationFence(await w.expectSerialized(firstFence, second))
    }
  )

  it('and never across two different files', async () => {
    const w = await world()
    fs.writeFileSync(w.target('d.ts'), 'd\n')
    const d = await w.admit('d.ts')
    const dFence = await w.fence(d)
    // Absent, so its planned identity sits under the same directory as d.ts.
    const e = await w.admit('e.ts')
    const held = new Set(dFence.owners.map((owner) => owner.partitionKey))
    expect(mutationFencePartitionKeys(e.claims).filter((key) => held.has(key))).toEqual([])
    const eFence = await w.fence(e)
    w.runtime.releaseMutationFence(eFence)
    w.runtime.releaseMutationFence(dFence)
  })
})
