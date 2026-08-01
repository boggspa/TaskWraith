import { describe, expect, it, vi } from 'vitest'

import type { WorkspaceLockRecoveryBlockedAcquisition } from './WorkspaceLockRuntime'
import { recoverWorkspaceLock, type WorkspaceLockRecoveryRuntime } from './WorkspaceLockRecovery'

const candidate: WorkspaceLockRecoveryBlockedAcquisition = {
  lockId: 'lease-1',
  ownerRunId: 'run-1',
  acquiredTransitionId: 'acquire-1',
  leaseIds: ['lease-1'],
  owner: {
    lockOwnerId: 'owner-1',
    runId: 'run-1',
    lifecycle: 'child',
    provider: 'codex',
    displayName: 'Codex',
    pid: 8821,
    processBirthIdentity: 'birth-1'
  },
  workspacePath: '/repo',
  worktreePath: '/repo'
}

function runtime(
  overrides: Partial<WorkspaceLockRecoveryRuntime> = {}
): WorkspaceLockRecoveryRuntime {
  return {
    recoveryBlockedAcquisition: vi.fn(() => candidate),
    observeRecoveryBlockedAcquisitionOwner: vi.fn(async () => ({ state: 'dead' as const })),
    forceReleaseRecoveryBlockedAcquisition: vi.fn(async () => ({
      ok: true as const,
      transitionId: 'release-1',
      released: []
    })),
    ...overrides
  }
}

describe('recoverWorkspaceLock', () => {
  it('binds a human confirmation receipt to the exact dead child acquisition', async () => {
    const target = runtime()
    const confirm = vi.fn(async () => true)

    const result = await recoverWorkspaceLock({
      runtime: target,
      lockId: candidate.lockId,
      confirm,
      createApprovalReceiptId: () => 'approval-1'
    })

    expect(result).toEqual({
      ok: true,
      releasedLeaseCount: 0,
      message:
        'The approved acquisition was released durably. Restart TaskWraith before starting another write-capable run.'
    })
    expect(confirm).toHaveBeenCalledWith({
      lockId: 'lease-1',
      ownerLabel: 'Codex',
      ownerPid: 8821,
      runId: 'run-1',
      workspacePath: '/repo',
      worktreePath: '/repo',
      evidence: 'owner_dead'
    })
    expect(target.observeRecoveryBlockedAcquisitionOwner).toHaveBeenCalledTimes(2)
    expect(target.forceReleaseRecoveryBlockedAcquisition).toHaveBeenCalledWith(
      candidate,
      'approval-1'
    )
  })

  it('refuses recovery while the exact process birth identity is still live', async () => {
    const target = runtime({
      observeRecoveryBlockedAcquisitionOwner: vi.fn(async () => ({
        state: 'live' as const,
        processBirthIdentity: 'birth-1'
      }))
    })
    const confirm = vi.fn(async () => true)

    await expect(
      recoverWorkspaceLock({ runtime: target, lockId: candidate.lockId, confirm })
    ).resolves.toMatchObject({ ok: false, reason: 'owner_live' })
    expect(confirm).not.toHaveBeenCalled()
    expect(target.forceReleaseRecoveryBlockedAcquisition).not.toHaveBeenCalled()
  })

  it('fails closed when process identity cannot be observed', async () => {
    const target = runtime({
      observeRecoveryBlockedAcquisitionOwner: vi.fn(async () => ({
        state: 'identity_unavailable' as const
      }))
    })

    await expect(
      recoverWorkspaceLock({ runtime: target, lockId: candidate.lockId, confirm: vi.fn() })
    ).resolves.toMatchObject({ ok: false, reason: 'owner_identity_unavailable' })
    expect(target.forceReleaseRecoveryBlockedAcquisition).not.toHaveBeenCalled()
  })

  it('keeps the acquisition protected when the human cancels', async () => {
    const target = runtime()

    await expect(
      recoverWorkspaceLock({
        runtime: target,
        lockId: candidate.lockId,
        confirm: vi.fn(async () => false)
      })
    ).resolves.toMatchObject({ ok: false, reason: 'cancelled' })
    expect(target.forceReleaseRecoveryBlockedAcquisition).not.toHaveBeenCalled()
  })

  it('rechecks the exact acquisition after the confirmation dwell', async () => {
    const lookup = vi.fn<WorkspaceLockRecoveryRuntime['recoveryBlockedAcquisition']>()
    lookup.mockReturnValueOnce(candidate).mockReturnValueOnce(null)
    const target = runtime({ recoveryBlockedAcquisition: lookup })

    await expect(
      recoverWorkspaceLock({
        runtime: target,
        lockId: candidate.lockId,
        confirm: vi.fn(async () => true)
      })
    ).resolves.toMatchObject({ ok: false, reason: 'stale' })
    expect(target.observeRecoveryBlockedAcquisitionOwner).toHaveBeenCalledTimes(1)
    expect(target.forceReleaseRecoveryBlockedAcquisition).not.toHaveBeenCalled()
  })

  it('treats an owner lifecycle change during confirmation as stale', async () => {
    const changed = {
      ...candidate,
      owner: { ...candidate.owner, lifecycle: 'launching-child' as const }
    }
    const lookup = vi.fn<WorkspaceLockRecoveryRuntime['recoveryBlockedAcquisition']>()
    lookup.mockReturnValueOnce(candidate).mockReturnValueOnce(changed)
    const target = runtime({ recoveryBlockedAcquisition: lookup })

    await expect(
      recoverWorkspaceLock({
        runtime: target,
        lockId: candidate.lockId,
        confirm: vi.fn(async () => true)
      })
    ).resolves.toMatchObject({ ok: false, reason: 'stale' })
    expect(target.forceReleaseRecoveryBlockedAcquisition).not.toHaveBeenCalled()
  })

  it('accepts a reused PID only after confirmation and a fresh recheck', async () => {
    const target = runtime({
      observeRecoveryBlockedAcquisitionOwner: vi.fn(async () => ({
        state: 'live' as const,
        processBirthIdentity: 'different-birth'
      }))
    })
    const confirm = vi.fn(async () => true)

    await expect(
      recoverWorkspaceLock({ runtime: target, lockId: candidate.lockId, confirm })
    ).resolves.toMatchObject({ ok: true })
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ evidence: 'pid_reused' }))
    expect(target.observeRecoveryBlockedAcquisitionOwner).toHaveBeenCalledTimes(2)
  })
})
