/**
 * Host Arc Track3 Mixed Wave A — HostProductionRoundShadow pins.
 *
 * RED-first discipline matches HostProductionQuestionShadow /
 * HostProductionApprovalShadow: pins assert the mapping contract
 * before (and after) the adapter lands.
 *
 * WHAT IS BEING PINNED. Narrow ensemble round entries map into
 * HostRoundProjection with allowlisted fields only. Stale running
 * (status running + live=false, isEnsembleRoundDispatchLive concept)
 * must project as completed — never as a live running round.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createHostProductionRoundShadow,
  mapEnsembleRoundShadowsToHostRounds,
  type HostEnsembleRoundShadowEntry
} from './HostProductionRoundShadow'

function entry(
  overrides: Partial<HostEnsembleRoundShadowEntry> = {}
): HostEnsembleRoundShadowEntry {
  return {
    roundId: 'round-1',
    threadId: 'chat-1',
    status: 'running',
    live: true,
    participantIds: ['p-a', 'p-b'],
    providerRunIds: ['run-1'],
    startedAt: 1_700_000_000_000,
    ...overrides
  }
}

describe('mapEnsembleRoundShadowsToHostRounds', () => {
  it('returns empty for zero round entries (a measured none)', () => {
    expect(mapEnsembleRoundShadowsToHostRounds([])).toEqual([])
  })

  it('keeps roundId and threadId verbatim — they are the client join keys', () => {
    const rows = mapEnsembleRoundShadowsToHostRounds([entry()])
    expect(rows).toHaveLength(1)
    expect(rows[0].roundId).toBe('round-1')
    expect(rows[0].threadId).toBe('chat-1')
  })

  it('skips rows without a usable roundId or threadId — never invents ids', () => {
    const rows = mapEnsembleRoundShadowsToHostRounds([
      entry({ roundId: '' }),
      entry({ roundId: '   ' }),
      entry({ threadId: undefined as unknown as string }),
      entry({ threadId: '' }),
      entry({ threadId: '   ' }),
      entry({ roundId: 'y'.repeat(4096) }),
      entry({ threadId: 'z'.repeat(4096) })
    ])
    expect(rows).toEqual([])
  })

  it('projects a live running round as running', () => {
    const rows = mapEnsembleRoundShadowsToHostRounds([entry({ status: 'running', live: true })])
    expect(rows[0].status).toBe('running')
  })

  it('stale running (status running + live=false) projects as completed — not running', () => {
    // Pins isEnsembleRoundDispatchLive honesty: a persisted "running" round
    // whose dispatch is no longer live must not paint as live on the wire.
    const rows = mapEnsembleRoundShadowsToHostRounds([entry({ status: 'running', live: false })])
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('completed')
    expect(rows[0].status).not.toBe('running')
  })

  it('passes through non-running terminal statuses without consulting live', () => {
    expect(
      mapEnsembleRoundShadowsToHostRounds([entry({ status: 'completed', live: false })])[0].status
    ).toBe('completed')
    expect(
      mapEnsembleRoundShadowsToHostRounds([entry({ status: 'cancelled', live: true })])[0].status
    ).toBe('cancelled')
    expect(
      mapEnsembleRoundShadowsToHostRounds([entry({ status: 'failed', live: false })])[0].status
    ).toBe('failed')
  })

  it('maps unrecognized status to unknown', () => {
    const rows = mapEnsembleRoundShadowsToHostRounds([entry({ status: 'idle', live: true })])
    expect(rows[0].status).toBe('unknown')
  })

  it('carries participantIds and providerRunIds arrays', () => {
    const rows = mapEnsembleRoundShadowsToHostRounds([entry()])
    expect(rows[0].participantIds).toEqual(['p-a', 'p-b'])
    expect(rows[0].providerRunIds).toEqual(['run-1'])
  })

  it('filters unusable ids from participantIds / providerRunIds rather than skipping the row', () => {
    const rows = mapEnsembleRoundShadowsToHostRounds([
      entry({
        participantIds: ['p-ok', '', '   ', 'p-two'],
        providerRunIds: ['run-ok', '', 'run-two']
      })
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].participantIds).toEqual(['p-ok', 'p-two'])
    expect(rows[0].providerRunIds).toEqual(['run-ok', 'run-two'])
  })

  it('skips rows whose participantIds or providerRunIds are not arrays', () => {
    const rows = mapEnsembleRoundShadowsToHostRounds([
      entry({ participantIds: undefined as unknown as string[] }),
      entry({ providerRunIds: 'run-1' as unknown as string[] })
    ])
    expect(rows).toEqual([])
  })

  it('includes optional startedAt / endedAt when valid', () => {
    const rows = mapEnsembleRoundShadowsToHostRounds([
      entry({ startedAt: 100, endedAt: 200 })
    ])
    expect(rows[0].startedAt).toBe(100)
    expect(rows[0].endedAt).toBe(200)
  })

  it('omits invalid startedAt / endedAt rather than fabricating', () => {
    const rows = mapEnsembleRoundShadowsToHostRounds([
      entry({ startedAt: -1, endedAt: Number.NaN })
    ])
    expect('startedAt' in rows[0]).toBe(false)
    expect('endedAt' in rows[0]).toBe(false)
  })

  it('carries allowlisted routing when present', () => {
    const rows = mapEnsembleRoundShadowsToHostRounds([
      entry({
        routing: {
          mode: 'continuous',
          fanout: 'serial',
          activeParticipantId: 'p-a',
          continuationHops: 2,
          maxContinuationHops: 6,
          bossParticipantId: 'p-boss',
          captainParticipantId: 'p-cap'
        }
      })
    ])
    expect(rows[0].routing).toEqual({
      mode: 'continuous',
      fanout: 'serial',
      activeParticipantId: 'p-a',
      continuationHops: 2,
      maxContinuationHops: 6,
      bossParticipantId: 'p-boss',
      captainParticipantId: 'p-cap'
    })
  })

  it('carries allowlisted waves when present', () => {
    const rows = mapEnsembleRoundShadowsToHostRounds([
      entry({
        waves: [
          {
            waveId: 'wave-1',
            label: 'Scout',
            status: 'done',
            participantIds: ['p-a']
          }
        ]
      })
    ])
    expect(rows[0].waves).toEqual([
      {
        waveId: 'wave-1',
        label: 'Scout',
        status: 'done',
        participantIds: ['p-a']
      }
    ])
  })

  it('allowlists fields — never forwards prompt, queue, blackboard, or transcript', () => {
    const leaky = {
      ...entry(),
      prompt: 'SECRET_PROMPT',
      queuedPrompt: 'SECRET_QUEUE',
      queuedPrompts: ['SECRET_QUEUE_1'],
      blackboard: { note: 'SECRET_BOARD' },
      transcript: [{ role: 'user', text: 'SECRET_TX' }]
    } as HostEnsembleRoundShadowEntry
    const rows = mapEnsembleRoundShadowsToHostRounds([leaky])
    expect(rows).toHaveLength(1)
    const wire = rows[0] as unknown as Record<string, unknown>
    expect(Object.keys(wire).sort()).toEqual(
      ['participantIds', 'providerRunIds', 'roundId', 'startedAt', 'status', 'threadId'].sort()
    )
    expect(wire).not.toHaveProperty('prompt')
    expect(wire).not.toHaveProperty('queuedPrompt')
    expect(wire).not.toHaveProperty('queuedPrompts')
    expect(wire).not.toHaveProperty('blackboard')
    expect(wire).not.toHaveProperty('transcript')
    expect(JSON.stringify(wire)).not.toContain('SECRET_')
  })
})

describe('createHostProductionRoundShadow', () => {
  it('requires a listRounds function', () => {
    expect(() => createHostProductionRoundShadow({} as never)).toThrow(
      'HostProductionRoundShadow requires listRounds to be a function'
    )
  })

  it('reads live on every listRounds call (no caching of a moving set)', () => {
    const listRounds = vi.fn(() => [entry()])
    const port = createHostProductionRoundShadow({ listRounds })
    expect(port.listRounds()).toHaveLength(1)
    expect(port.listRounds()).toHaveLength(1)
    expect(listRounds).toHaveBeenCalledTimes(2)
  })

  it('lets a source throw propagate — fail closed, never a false empty', () => {
    const port = createHostProductionRoundShadow({
      listRounds: () => {
        throw new Error('ensemble rounds unavailable')
      }
    })
    expect(() => port.listRounds()).toThrow('ensemble rounds unavailable')
  })
})
