import { describe, expect, it } from 'vitest'
import {
  SIMULATOR_HUMAN_CONTROLLER_RUN_ID,
  SimulatorControllerLease
} from './SimulatorControllerLease'

function authorize(lease: SimulatorControllerLease, overrides: Record<string, unknown> = {}) {
  return lease.authorizeUserLease({
    chatId: 'chat-a',
    runId: 'run-1',
    provider: 'codex',
    surfaceId: 'simulator:DEVICE-1:com.example.App',
    verb: 'simulator_tap',
    allowedVerbs: ['simulator_tap', 'simulator_type', 'simulator_launch'],
    target: { udid: 'DEVICE-1', bundleId: 'com.example.App' },
    ownerParticipantId: 'boss',
    approvalId: 'approval-1',
    approvedBy: 'user',
    expiresAt: 10_000,
    stepBudget: 2,
    ...overrides
  } as never)
}

function acquire(lease: SimulatorControllerLease, overrides: Record<string, unknown> = {}) {
  return lease.mint({
    chatId: 'chat-a',
    runId: 'run-1',
    provider: 'codex',
    surfaceId: 'simulator:DEVICE-1:com.example.App',
    verb: 'simulator_tap',
    ownerParticipantId: 'boss',
    ...overrides
  } as never)
}

describe('SimulatorControllerLease', () => {
  it('refuses agent self-minting before exact user authorization', () => {
    const lease = new SimulatorControllerLease({ now: () => 1_000 })
    expect(acquire(lease)).toMatchObject({ ok: false, code: 'consent_required' })
  })

  it('authorizes an exact device/app lease, then consumes bounded steps', () => {
    const lease = new SimulatorControllerLease({ now: () => 1_000, createId: () => 'tok-1' })
    expect(authorize(lease)).toMatchObject({
      ok: true,
      token: {
        tokenId: 'tok-1',
        chatId: 'chat-a',
        runId: 'run-1',
        provider: 'codex',
        surfaceId: 'simulator:DEVICE-1:com.example.App',
        target: { udid: 'DEVICE-1', bundleId: 'com.example.App' },
        expiresAt: 10_000,
        stepBudget: 2,
        stepsUsed: 0,
        stepsRemaining: 2
      }
    })
    expect(acquire(lease)).toMatchObject({
      ok: true,
      token: { tokenId: 'tok-1', stepsUsed: 1, stepsRemaining: 1 }
    })
    expect(acquire(lease, { verb: 'simulator_type' })).toMatchObject({
      ok: true,
      token: { tokenId: 'tok-1', stepsUsed: 2, stepsRemaining: 0 }
    })
    expect(acquire(lease)).toMatchObject({ ok: false, code: 'step_budget_exhausted' })
  })

  it('refuses run, provider, surface, and verb drift', () => {
    const lease = new SimulatorControllerLease({ now: () => 1_000, createId: () => 'tok-1' })
    expect(authorize(lease).ok).toBe(true)
    expect(acquire(lease, { runId: 'run-2' })).toMatchObject({ ok: false, code: 'conflict' })
    expect(acquire(lease, { provider: 'claude' })).toMatchObject({
      ok: false,
      code: 'not_holder'
    })
    expect(acquire(lease, { surfaceId: 'simulator:DEVICE-2:com.example.App' })).toMatchObject({
      ok: false,
      code: 'conflict'
    })
    expect(acquire(lease, { verb: 'simulator_scroll' })).toMatchObject({
      ok: false,
      code: 'consent_required'
    })
  })

  it('expires mechanically and removes the controller projection', () => {
    const now = { value: 1_000 }
    const lease = new SimulatorControllerLease({ now: () => now.value, createId: () => 'tok-1' })
    expect(authorize(lease, { expiresAt: 1_100 }).ok).toBe(true)
    now.value = 1_101
    expect(lease.peek('chat-a')).toBeNull()
    expect(acquire(lease)).toMatchObject({ ok: false, code: 'consent_required' })
  })

  it('transfers the same user-approved lease only to Boss/Captain authority', () => {
    const lease = new SimulatorControllerLease({ now: () => 1_000, createId: () => 'tok-xfer' })
    expect(authorize(lease).ok).toBe(true)
    const denied = lease.transfer({
      chatId: 'chat-a',
      fromRunId: 'run-1',
      toRunId: 'run-2',
      toOwnerParticipantId: 'worker',
      ensemble: { bossmanParticipantId: 'boss', captainParticipantIds: ['captain'] }
    })
    expect(denied).toMatchObject({ ok: false, code: 'authority_denied' })

    const transferred = lease.transfer({
      chatId: 'chat-a',
      fromRunId: 'run-1',
      toRunId: 'run-2',
      toOwnerParticipantId: 'captain',
      ensemble: { bossmanParticipantId: 'boss', captainParticipantIds: ['captain'] }
    })
    expect(transferred).toMatchObject({
      ok: true,
      token: { tokenId: 'tok-xfer', runId: 'run-2', ownerParticipantId: 'captain' }
    })
    expect(lease.releaseForRun('run-1')).toEqual([])
    expect(lease.releaseForRun('run-2')).toHaveLength(1)
    expect(lease.peek('chat-a')).toBeNull()
  })

  it('human takeover rotates token identity and invalidates the agent lease', () => {
    let id = 0
    const lease = new SimulatorControllerLease({
      now: () => 1_000,
      createId: () => `tok-${++id}`
    })
    const authorized = authorize(lease)
    expect(authorized).toMatchObject({ ok: true, token: { tokenId: 'tok-1' } })
    const claimed = lease.claimHuman('chat-a')
    expect(claimed).toMatchObject({
      ok: true,
      token: {
        tokenId: 'tok-2',
        kind: 'human',
        runId: SIMULATOR_HUMAN_CONTROLLER_RUN_ID
      }
    })
    expect(acquire(lease)).toMatchObject({ ok: false, code: 'conflict' })
    expect(lease.isValid({ chatId: 'chat-a', tokenId: 'tok-1' })).toBe(false)
    expect(lease.isValid({ chatId: 'chat-a', tokenId: 'tok-2' })).toBe(true)
  })

  it('release requires the holding run and revokes its AppDrive lease', () => {
    const lease = new SimulatorControllerLease({ now: () => 1_000, createId: () => 'tok-1' })
    expect(authorize(lease).ok).toBe(true)
    expect(lease.release({ chatId: 'chat-a', runId: 'run-2' })).toMatchObject({
      ok: false,
      code: 'not_holder'
    })
    expect(lease.release({ chatId: 'chat-a', runId: 'run-1' }).ok).toBe(true)
    expect(lease.peek('chat-a')).toBeNull()
    expect(acquire(lease)).toMatchObject({ ok: false, code: 'consent_required' })
  })

  it('notifies permission authority when human takeover invalidates an agent lease', () => {
    const invalidated: Array<{ reason: string; surfaceId?: string }> = []
    const lease = new SimulatorControllerLease({
      now: () => 1_000,
      createId: () => 'tok',
      onAuthorityInvalidated: (token, reason) =>
        invalidated.push({ reason, surfaceId: token.surfaceId })
    })
    expect(authorize(lease).ok).toBe(true)
    lease.claimHuman('chat-a')
    expect(invalidated).toEqual([
      {
        reason: 'human-takeover',
        surfaceId: 'simulator:DEVICE-1:com.example.App'
      }
    ])
  })
})
