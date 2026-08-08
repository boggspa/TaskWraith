import { describe, expect, it } from 'vitest'
import {
  SIMULATOR_HUMAN_CONTROLLER_RUN_ID,
  SimulatorControllerLease
} from './SimulatorControllerLease'

describe('SimulatorControllerLease', () => {
  it('mints a run controller when the chat has none', () => {
    const lease = new SimulatorControllerLease({ now: () => 1_000, createId: () => 'tok-1' })
    const result = lease.mint({
      chatId: 'chat-a',
      runId: 'run-1',
      ownerParticipantId: 'seat-boss'
    })
    expect(result).toEqual({
      ok: true,
      token: {
        tokenId: 'tok-1',
        chatId: 'chat-a',
        runId: 'run-1',
        kind: 'run',
        ownerParticipantId: 'seat-boss',
        mintedAt: 1_000,
        updatedAt: 1_000
      }
    })
    expect(lease.peek('chat-a')?.tokenId).toBe('tok-1')
  })

  it('returns the same token across seat yields within the same run', () => {
    let n = 0
    const lease = new SimulatorControllerLease({
      now: () => 2_000 + n++,
      createId: () => `tok-${n}`
    })
    const first = lease.mint({
      chatId: 'chat-a',
      runId: 'run-1',
      ownerParticipantId: 'seat-a'
    })
    expect(first.ok).toBe(true)
    const second = lease.mint({
      chatId: 'chat-a',
      runId: 'run-1',
      ownerParticipantId: 'seat-b'
    })
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.token.tokenId).toBe(first.token.tokenId)
    expect(second.token.ownerParticipantId).toBe('seat-b')
    expect(second.token.updatedAt).toBeGreaterThan(first.token.mintedAt)
  })

  it('conflicts when a second run tries to control the same chat', () => {
    const lease = new SimulatorControllerLease({ createId: () => 'tok-1' })
    expect(lease.mint({ chatId: 'chat-a', runId: 'run-1' }).ok).toBe(true)
    const conflict = lease.mint({ chatId: 'chat-a', runId: 'run-2' })
    expect(conflict).toMatchObject({
      ok: false,
      code: 'conflict'
    })
    if (conflict.ok) return
    expect(conflict.holder?.runId).toBe('run-1')
    expect(conflict.error).toMatch(/another run/i)
  })

  it('transfers to another authoritative role and releases on run terminal', () => {
    const lease = new SimulatorControllerLease({
      now: () => 5_000,
      createId: () => 'tok-xfer'
    })
    expect(lease.mint({ chatId: 'chat-a', runId: 'run-1', ownerParticipantId: 'boss' }).ok).toBe(
      true
    )

    const denied = lease.transfer({
      chatId: 'chat-a',
      fromRunId: 'run-1',
      toRunId: 'run-2',
      toOwnerParticipantId: 'worker',
      ensemble: {
        bossmanParticipantId: 'boss',
        captainParticipantIds: ['captain']
      }
    })
    expect(denied).toMatchObject({ ok: false, code: 'authority_denied' })

    const transferred = lease.transfer({
      chatId: 'chat-a',
      fromRunId: 'run-1',
      toRunId: 'run-2',
      toOwnerParticipantId: 'captain',
      ensemble: {
        bossmanParticipantId: 'boss',
        captainParticipantIds: ['captain']
      }
    })
    expect(transferred.ok).toBe(true)
    if (!transferred.ok) return
    expect(transferred.token).toMatchObject({
      runId: 'run-2',
      ownerParticipantId: 'captain',
      tokenId: 'tok-xfer'
    })

    // Original run terminal must not release after transfer.
    expect(lease.releaseForRun('run-1')).toEqual([])
    expect(lease.peek('chat-a')?.runId).toBe('run-2')

    const released = lease.releaseForRun('run-2')
    expect(released).toHaveLength(1)
    expect(lease.peek('chat-a')).toBeNull()
  })

  it('lets the human dock claim control authoritatively over a run holder', () => {
    const lease = new SimulatorControllerLease({
      now: () => 9_000,
      createId: () => 'tok-human'
    })
    expect(lease.mint({ chatId: 'chat-a', runId: 'run-1' }).ok).toBe(true)
    const claimed = lease.claimHuman('chat-a')
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    expect(claimed.token).toMatchObject({
      kind: 'human',
      runId: SIMULATOR_HUMAN_CONTROLLER_RUN_ID,
      tokenId: 'tok-human'
    })
    expect(
      lease.isValid({
        chatId: 'chat-a',
        tokenId: 'tok-human',
        runId: SIMULATOR_HUMAN_CONTROLLER_RUN_ID
      })
    ).toBe(true)
  })

  it('release requires the holding run', () => {
    const lease = new SimulatorControllerLease({ createId: () => 'tok-1' })
    expect(lease.mint({ chatId: 'chat-a', runId: 'run-1' }).ok).toBe(true)
    expect(lease.release({ chatId: 'chat-a', runId: 'run-2' })).toMatchObject({
      ok: false,
      code: 'not_holder'
    })
    expect(lease.release({ chatId: 'chat-a', runId: 'run-1' }).ok).toBe(true)
    expect(lease.peek('chat-a')).toBeNull()
  })
})
