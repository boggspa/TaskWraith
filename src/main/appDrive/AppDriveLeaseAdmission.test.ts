import { describe, expect, it, vi } from 'vitest'
import { AppDriveLeaseRegistry } from './AppDriveLease'
import { authorizeApprovedAppDriveSurface } from './AppDriveLeaseAdmission'

function harness() {
  const leases = new AppDriveLeaseRegistry({
    now: () => 1_000,
    createLeaseId: () => 'lease-1'
  })
  return {
    leases,
    simulatorController: {
      authorizeUserLease: vi.fn(() => ({
        ok: true as const,
        token: {
          tokenId: 'sim-token',
          chatId: 'chat-a',
          runId: 'run-a',
          kind: 'run' as const,
          mintedAt: 1_000,
          updatedAt: 1_000
        }
      }))
    },
    hasSessionGrant: vi.fn(() => false),
    removeSessionGrant: vi.fn(() => true),
    now: () => 1_000
  }
}

const webInput = {
  descriptor: {
    surfaceId: 'canvas-a',
    surfaceKind: 'web' as const,
    target: { canvasId: 'canvas-a' },
    verb: 'click',
    allowedVerbs: ['click', 'fill']
  },
  provider: 'codex' as const,
  service: 'canvasInteraction' as const,
  workspacePath: '/repo',
  chatId: 'chat-a',
  runId: 'run-a',
  participantId: 'seat-a',
  oneOffPermissionRetry: false
}

describe('authorizeApprovedAppDriveSurface', () => {
  it('refuses broad policy auto-allow without user surface consent', () => {
    const deps = harness()
    expect(authorizeApprovedAppDriveSurface(webInput, deps)).toMatchObject({ ok: false })
    expect(deps.leases.peek('canvas-a')).toBeNull()
  })

  it('mints a one-step lease from an explicit one-shot user decision', () => {
    const deps = harness()
    expect(
      authorizeApprovedAppDriveSurface(
        {
          ...webInput,
          approval: { action: 'accept', decisionSource: 'user' }
        },
        deps
      )
    ).toEqual({ ok: true })
    expect(deps.leases.peek('canvas-a')).toMatchObject({
      approvedBy: 'user',
      stepBudget: 1,
      stepsUsed: 0
    })
  })

  it('mints the normal bounded session lease from an exact user surface grant', () => {
    const deps = harness()
    deps.hasSessionGrant.mockReturnValue(true)
    expect(authorizeApprovedAppDriveSurface(webInput, deps)).toEqual({ ok: true })
    expect(deps.leases.peek('canvas-a')).toMatchObject({ stepBudget: 20 })
  })

  it('reuses a live exact binding without resetting its budget', () => {
    const deps = harness()
    deps.hasSessionGrant.mockReturnValue(true)
    authorizeApprovedAppDriveSurface(webInput, deps)
    deps.leases.acquireAndConsume({
      surfaceId: 'canvas-a',
      surfaceKind: 'web',
      chatId: 'chat-a',
      runId: 'run-a',
      provider: 'codex',
      participantId: 'seat-a',
      verb: 'click'
    })
    expect(authorizeApprovedAppDriveSurface(webInput, deps)).toEqual({ ok: true })
    expect(deps.leases.peek('canvas-a')).toMatchObject({ stepsUsed: 1 })
  })

  it('routes simulator consent into the token authority instead of self-minting', () => {
    const deps = harness()
    const descriptor = {
      surfaceId: 'simulator:DEVICE-1:com.example.App',
      surfaceKind: 'simulator' as const,
      target: { udid: 'DEVICE-1', bundleId: 'com.example.App' },
      verb: 'simulator_tap',
      allowedVerbs: ['simulator_tap']
    }
    expect(
      authorizeApprovedAppDriveSurface(
        {
          ...webInput,
          descriptor,
          service: 'simulatorCanvas',
          approval: { action: 'accept', decisionSource: 'user' }
        },
        deps
      )
    ).toEqual({ ok: true })
    expect(deps.simulatorController.authorizeUserLease).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedBy: 'user',
        surfaceId: descriptor.surfaceId,
        stepBudget: 1
      })
    )
  })

  it('removes a stale surface grant instead of silently renewing an exhausted lease', () => {
    const deps = harness()
    deps.hasSessionGrant.mockReturnValue(true)
    authorizeApprovedAppDriveSurface(webInput, deps)
    deps.leases.acquireAndConsume({
      surfaceId: 'canvas-a',
      surfaceKind: 'web',
      chatId: 'chat-a',
      runId: 'run-a',
      provider: 'codex',
      participantId: 'seat-a',
      verb: 'click'
    })
    const lease = deps.leases.peek('canvas-a')!
    for (let index = lease.stepsUsed; index < lease.stepBudget; index += 1) {
      deps.leases.acquireAndConsume({
        surfaceId: 'canvas-a',
        surfaceKind: 'web',
        chatId: 'chat-a',
        runId: 'run-a',
        provider: 'codex',
        participantId: 'seat-a',
        verb: 'click'
      })
    }
    expect(authorizeApprovedAppDriveSurface(webInput, deps)).toMatchObject({ ok: false })
    expect(deps.removeSessionGrant).toHaveBeenCalledWith(
      'codex',
      '/repo',
      'canvasInteraction',
      'run-a',
      'canvas-a'
    )
  })
})
