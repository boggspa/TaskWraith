import { describe, expect, it, vi } from 'vitest'

import { WorkspaceLockExecutionIdentityRegistry } from './WorkspaceLockExecutionIdentity'
import { WorkspaceLockProviderCoordinator } from './WorkspaceLockProviderCoordinator'

function harness() {
  const runtime = {
    getUnhealthyReason: vi.fn((): string | null => null),
    acquire: vi.fn(async (input: { owner: Record<string, unknown> }) => ({
      ok: true as const,
      owner: {
        ...input.owner,
        pid: 10,
        processBirthIdentity: 'birth-10'
      },
      claims: [{ workspacePath: '/workspace', kind: 'workspace' as const }],
      authority: {
        ok: true as const,
        transitionId: 'acquire',
        tokens: [],
        leases: []
      }
    })),
    transferAcquisition: vi.fn(
      async (_previous: unknown, _transition: unknown, nextOwner: Record<string, unknown>) => ({
        ok: true as const,
        owner: {
          ...nextOwner,
          lifecycle: 'child' as const,
          pid: 44,
          processBirthIdentity: 'birth-44'
        },
        claims: [{ workspacePath: '/workspace', kind: 'workspace' as const }],
        authority: {
          ok: true as const,
          transitionId: 'transfer',
          tokens: [],
          leases: []
        }
      })
    ),
    releaseAcquisition: vi.fn(async () => ({
      ok: true as const,
      transitionId: 'release',
      released: []
    })),
    quarantineChildOwnerAcquisitions: vi.fn(async () => undefined)
  }
  const identities = new WorkspaceLockExecutionIdentityRegistry({
    createId: () => 'opaque-owner'
  })
  const coordinator = new WorkspaceLockProviderCoordinator({
    getRuntime: () => runtime as never,
    identities
  })
  return { coordinator, runtime, identities }
}

describe('WorkspaceLockProviderCoordinator', () => {
  it('acquires one coarse provider-native claim with an opaque lane identity', async () => {
    const { coordinator, runtime } = harness()

    const admission = await coordinator.admitCoarseWriteRun({
      provider: 'cursor',
      runId: 'run-1',
      laneId: 'lane-work',
      participantId: 'participant-1',
      workspacePath: '/workspace',
      worktreePath: '/workspace-lane'
    })

    expect(admission.owner.lockOwnerId).toBe('opaque-owner')
    expect(runtime.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: expect.objectContaining({
          lockOwnerId: 'opaque-owner',
          runId: 'run-1',
          lifecycle: 'launching-child',
          laneId: 'lane-work',
          participantId: 'participant-1'
        }),
        mutation: expect.objectContaining({
          source: 'provider-native',
          action: 'unobservable-write-surface',
          workspacePath: '/workspace',
          worktreePath: '/workspace-lane'
        }),
        coarseWorkspaceFallback: true
      })
    )
  })

  it('transfers without changing the logical lock owner or run', async () => {
    const { coordinator, runtime } = harness()
    await coordinator.admitCoarseWriteRun({
      provider: 'cursor',
      runId: 'run-1',
      workspacePath: '/workspace',
      worktreePath: '/workspace'
    })

    const transferred = await coordinator.transferToChild({ runId: 'run-1' }, 44)

    expect(transferred.transitionId).toBe('transfer')
    expect(runtime.transferAcquisition).toHaveBeenCalledWith(
      expect.objectContaining({ lockOwnerId: 'opaque-owner', runId: 'run-1' }),
      'acquire',
      expect.objectContaining({
        lockOwnerId: 'opaque-owner',
        runId: 'run-1',
        executionPid: 44
      })
    )
  })

  it('fails closed when admission conflicts or runtime health is poisoned', async () => {
    const conflict = harness()
    conflict.runtime.acquire.mockResolvedValueOnce({
      ok: false,
      code: 'conflict',
      message: 'held by another run'
    } as never)
    await expect(
      conflict.coordinator.admitCoarseWriteRun({
        provider: 'cursor',
        runId: 'run-1',
        workspacePath: '/workspace',
        worktreePath: '/workspace'
      })
    ).rejects.toThrow(/held by another run/)

    const poisoned = harness()
    poisoned.runtime.getUnhealthyReason.mockReturnValueOnce('fence release unresolved')
    await expect(
      poisoned.coordinator.admitCoarseWriteRun({
        provider: 'cursor',
        runId: 'run-1',
        workspacePath: '/workspace',
        worktreePath: '/workspace'
      })
    ).rejects.toThrow(/fail-closed/)
    expect(poisoned.runtime.acquire).not.toHaveBeenCalled()
  })

  it('releases setup failures exactly and forgets the opaque identity', async () => {
    const { coordinator, runtime, identities } = harness()
    await coordinator.admitCoarseWriteRun({
      provider: 'cursor',
      runId: 'run-1',
      workspacePath: '/workspace',
      worktreePath: '/workspace'
    })

    const admission = coordinator.get({ runId: 'run-1' })
    if (!admission) throw new Error('missing setup admission fixture')
    await coordinator.releaseSetupFailure({ runId: 'run-1' }, admission)

    expect(runtime.releaseAcquisition).toHaveBeenCalledWith('run-1', 'acquire')
    expect(coordinator.get({ runId: 'run-1' })).toBeNull()
    expect(identities.get({ kind: 'logical-run', runId: 'run-1' })).toBeNull()
  })

  it('retains a live child admission across terminal run cleanup until child close', async () => {
    const { coordinator, runtime, identities } = harness()
    await coordinator.admitCoarseWriteRun({
      provider: 'cursor',
      runId: 'run-1',
      workspacePath: '/workspace',
      worktreePath: '/workspace'
    })
    const childAdmission = await coordinator.transferToChild({ runId: 'run-1' }, 44)

    coordinator.forgetRun('run-1')

    expect(coordinator.get({ runId: 'run-1' })).toMatchObject({
      transitionId: 'transfer',
      owner: { lifecycle: 'child', pid: 44 }
    })
    expect(identities.get({ kind: 'logical-run', runId: 'run-1' })).toBe('opaque-owner')

    await coordinator.releaseChild({ runId: 'run-1' }, childAdmission)

    expect(runtime.releaseAcquisition).toHaveBeenCalledWith('run-1', 'transfer')
    expect(coordinator.get({ runId: 'run-1' })).toBeNull()
    expect(identities.get({ kind: 'logical-run', runId: 'run-1' })).toBeNull()
  })

  it('moves the exact closed child into durable recovery quarantine', async () => {
    const { coordinator, runtime } = harness()
    await coordinator.admitCoarseWriteRun({
      provider: 'cursor',
      runId: 'run-1',
      workspacePath: '/workspace',
      worktreePath: '/workspace'
    })
    const childAdmission = await coordinator.transferToChild({ runId: 'run-1' }, 44)

    await coordinator.quarantineChildForRecovery({ runId: 'run-1' }, childAdmission)

    expect(runtime.quarantineChildOwnerAcquisitions).toHaveBeenCalledWith(
      expect.objectContaining({
        lockOwnerId: 'opaque-owner',
        runId: 'run-1',
        lifecycle: 'child',
        pid: 44
      })
    )
    expect(coordinator.get({ runId: 'run-1' })).toBe(childAdmission)
  })

  it('retains a pre-transfer guardian across terminal cleanup', async () => {
    const { coordinator, identities } = harness()
    const admission = await coordinator.admitCoarseWriteRun({
      provider: 'cursor',
      runId: 'run-1',
      workspacePath: '/workspace',
      worktreePath: '/workspace'
    })

    coordinator.forgetRun('run-1')

    expect(admission.owner.lifecycle).toBe('launching-child')
    expect(coordinator.get({ runId: 'run-1' })).toBe(admission)
    expect(identities.get({ kind: 'logical-run', runId: 'run-1' })).toBe('opaque-owner')
  })

  it('forgets child receipts after authority-confirmed external recovery', async () => {
    const { coordinator, runtime, identities } = harness()
    await coordinator.admitCoarseWriteRun({
      provider: 'cursor',
      runId: 'run-1',
      workspacePath: '/workspace',
      worktreePath: '/workspace'
    })
    await coordinator.transferToChild({ runId: 'run-1' }, 44)

    coordinator.reconcileExternallyReleasedRun('run-1')

    expect(coordinator.get({ runId: 'run-1' })).toBeNull()
    expect(identities.get({ kind: 'logical-run', runId: 'run-1' })).toBeNull()
    expect(runtime.releaseAcquisition).not.toHaveBeenCalled()
  })

  it('refuses to use the child-close release path before transfer', async () => {
    const { coordinator, runtime } = harness()
    await coordinator.admitCoarseWriteRun({
      provider: 'cursor',
      runId: 'run-1',
      workspacePath: '/workspace',
      worktreePath: '/workspace'
    })

    const runAdmission = coordinator.get({ runId: 'run-1' })
    if (!runAdmission) throw new Error('missing run admission fixture')
    await expect(coordinator.releaseChild({ runId: 'run-1' }, runAdmission)).rejects.toThrow(
      /not owned by a child/
    )
    expect(runtime.releaseAcquisition).not.toHaveBeenCalled()
  })

  it('makes a sequential transfer to the same exact child idempotent', async () => {
    const { coordinator, runtime } = harness()
    await coordinator.admitCoarseWriteRun({
      provider: 'cursor',
      runId: 'run-1',
      workspacePath: '/workspace',
      worktreePath: '/workspace'
    })
    const firstChild = await coordinator.transferToChild({ runId: 'run-1' }, 44)
    const repeated = await coordinator.transferToChild({ runId: 'run-1' }, 44)

    expect(repeated).toBe(firstChild)
    expect(runtime.transferAcquisition).toHaveBeenCalledOnce()
  })

  it('refuses to move authority away from a still-owned child', async () => {
    const { coordinator, runtime } = harness()
    await coordinator.admitCoarseWriteRun({
      provider: 'cursor',
      runId: 'run-1',
      workspacePath: '/workspace',
      worktreePath: '/workspace'
    })
    const firstChild = await coordinator.transferToChild({ runId: 'run-1' }, 44)

    await expect(coordinator.transferToChild({ runId: 'run-1' }, 55)).rejects.toThrow(
      /still bound to another child/
    )
    expect(runtime.transferAcquisition).toHaveBeenCalledOnce()
    expect(coordinator.get({ runId: 'run-1' })).toBe(firstChild)
  })

  it('singleflights admission and transfer for one exact lane scope', async () => {
    const { coordinator, runtime } = harness()
    const input = {
      provider: 'cursor' as const,
      runId: 'run-1',
      laneId: 'lane-a',
      participantId: 'participant-a',
      workspacePath: '/workspace',
      worktreePath: '/workspace-lane-a'
    }

    const [first, second] = await Promise.all([
      coordinator.admitCoarseWriteRun(input),
      coordinator.admitCoarseWriteRun(input)
    ])
    expect(first).toEqual(second)
    expect(runtime.acquire).toHaveBeenCalledOnce()

    await Promise.all([
      coordinator.transferToChild(input, 44),
      coordinator.transferToChild(input, 44)
    ])
    expect(runtime.transferAcquisition).toHaveBeenCalledOnce()
  })

  it('rejects reuse of an exact scope with changed provider or checkout', async () => {
    const { coordinator } = harness()
    const input = {
      provider: 'cursor' as const,
      runId: 'run-1',
      laneId: 'lane-a',
      workspacePath: '/workspace',
      worktreePath: '/workspace-lane-a'
    }
    await coordinator.admitCoarseWriteRun(input)

    await expect(
      coordinator.admitCoarseWriteRun({
        ...input,
        provider: 'pi',
        worktreePath: '/different-worktree'
      })
    ).rejects.toThrow(/different authority/)
  })

  describe('launchOwnerId', () => {
    function seatHarness() {
      let next = 0
      const identities = new WorkspaceLockExecutionIdentityRegistry({
        createId: () => `opaque-owner-${(next += 1)}`
      })
      const coordinator = new WorkspaceLockProviderCoordinator({
        getRuntime: () => null,
        identities
      })
      return { coordinator, identities }
    }

    // Provider dispatch takes no coarse checkout lease, so a seat that waited
    // for lock admission to name it never carried TASKWRAITH_LOCK_OWNER_ID at
    // all — leaving a sandboxed seat, which cannot see a stable pid either,
    // with no identity its own work-in-progress marker could be checked against.
    it('names a seat at launch even though provider dispatch takes no lease', () => {
      const { coordinator } = seatHarness()

      const ownerId = coordinator.launchOwnerId({
        runId: 'run-1',
        laneId: 'lane-a',
        participantId: 'participant-a'
      })

      expect(ownerId).toBe('opaque-owner-1')
    })

    // The pre-commit hook and the brokered-MCP control plane authenticate the
    // same seat by string equality, so a launch that minted a second identity
    // would leave the seat unable to own the very marker its own brokered
    // mutation projected.
    it('names a seat the same way the brokered control plane does', () => {
      const { coordinator } = seatHarness()
      const seat = { runId: 'run-1', laneId: 'lane-a', participantId: 'participant-a' }

      expect(coordinator.launchOwnerId(seat)).toBe(coordinator.getOrCreateLogicalOwnerId(seat))
      expect(coordinator.launchOwnerId(seat)).toBe(coordinator.launchOwnerId(seat))
    })

    it('never lets two seats of one run inherit each other’s identity', () => {
      const { coordinator } = seatHarness()

      const lead = coordinator.launchOwnerId({
        runId: 'run-1',
        laneId: 'lane-a',
        participantId: 'participant-a'
      })
      const peer = coordinator.launchOwnerId({
        runId: 'run-1',
        laneId: 'lane-b',
        participantId: 'participant-b'
      })
      const unlaned = coordinator.launchOwnerId({ runId: 'run-1' })

      expect(new Set([lead, peer, unlaned]).size).toBe(3)
    })

    it('prefers the admitted owner over minting a rival identity', async () => {
      const { coordinator } = harness()
      const seat = { runId: 'run-1', laneId: 'lane-a', participantId: 'participant-a' }
      await coordinator.admitCoarseWriteRun({
        provider: 'cursor',
        ...seat,
        workspacePath: '/workspace',
        worktreePath: '/workspace-lane-a'
      })

      expect(coordinator.launchOwnerId(seat)).toBe('opaque-owner')
    })

    // A launch with no run identity has no seat to name. Throwing here would
    // turn a naming gap into a failed provider launch.
    it('declines to name an unrouted launch instead of failing it', () => {
      const { coordinator } = seatHarness()

      expect(coordinator.launchOwnerId({ runId: '' })).toBeNull()
      expect(coordinator.launchOwnerId({ runId: '   ' })).toBeNull()
    })

    // Naming is best-effort; the launch is not. A coordinate the identity
    // registry would reject must come back unnamed rather than throw out of the
    // spawn path, where it would turn a launch that used to succeed into a
    // visible setup failure.
    it('declines a malformed seat coordinate instead of failing the launch', () => {
      const { coordinator } = seatHarness()

      expect(coordinator.launchOwnerId({ runId: ' run-1' })).toBeNull()
      expect(coordinator.launchOwnerId({ runId: 'run-1', laneId: 'lane-a ' })).toBeNull()
      // NUL is the separator the scope key joins on, so it is the one character
      // that could make two different seats key the same identity.
      expect(
        coordinator.launchOwnerId({ runId: 'run-1', participantId: 'participant\u0000a' })
      ).toBeNull()
      // An absent lane is not malformed — it is how a solo seat is scoped.
      expect(coordinator.launchOwnerId({ runId: 'run-1', laneId: '' })).toBe('opaque-owner-1')
    })

    it('forgets a seat identity once its run is released', () => {
      const { coordinator } = seatHarness()
      const seat = { runId: 'run-1', laneId: 'lane-a' }
      expect(coordinator.launchOwnerId(seat)).toBe('opaque-owner-1')

      coordinator.forgetRun('run-1')

      expect(coordinator.launchOwnerId(seat)).toBe('opaque-owner-2')
    })
  })
})
