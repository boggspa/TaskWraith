import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { buildFanoutLaneJumpTargets } from './fanoutLaneJumpTargets'

function lane(id: string, participantId: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: `lane ${id}`,
    timestamp: 0,
    metadata: {
      kind: 'ensembleParticipant',
      ensembleLaneId: `lane-${id}`,
      ensembleParticipantId: participantId
    }
  } as unknown as ChatMessage
}

function other(id: string): ChatMessage {
  return { id, role: 'assistant', content: id, timestamp: 0 } as unknown as ChatMessage
}

describe('buildFanoutLaneJumpTargets', () => {
  it('maps a seat to its lane card, carrying the collision-proof row key', () => {
    const targets = buildFanoutLaneJumpTargets([other('intro'), lane('m1', 'seat-a')])
    expect(targets.get('seat-a')).toEqual({ messageId: 'm1', rowKey: 'm1#1' })
  })

  it('points a seat at its LATEST lane card, not the first', () => {
    // A seat that worked several rounds owns a card per round. Jumping to an
    // older round's card lands the reader on finished output and reads as a
    // broken link, so the live one has to win.
    const targets = buildFanoutLaneJumpTargets([
      lane('round1', 'seat-a'),
      other('boss'),
      lane('round2', 'seat-a')
    ])
    expect(targets.get('seat-a')).toEqual({ messageId: 'round2', rowKey: 'round2#2' })
  })

  it('keeps each seat on its own card', () => {
    const targets = buildFanoutLaneJumpTargets([
      lane('m1', 'seat-a'),
      lane('m2', 'seat-b'),
      lane('m3', 'seat-c')
    ])
    expect(targets.get('seat-a')?.messageId).toBe('m1')
    expect(targets.get('seat-b')?.messageId).toBe('m2')
    expect(targets.get('seat-c')?.messageId).toBe('m3')
  })

  it('omits a lane row that predates the participant id, so no dead target is offered', () => {
    const legacy = {
      id: 'old',
      role: 'assistant',
      content: 'old lane',
      timestamp: 0,
      metadata: { kind: 'ensembleParticipant', ensembleLaneId: 'lane-old' }
    } as unknown as ChatMessage
    expect(buildFanoutLaneJumpTargets([legacy]).size).toBe(0)
  })

  it('ignores rows that are not fan-out lanes', () => {
    const targets = buildFanoutLaneJumpTargets([other('a'), other('b')])
    expect(targets.size).toBe(0)
  })

  it('disambiguates duplicate message ids by position', () => {
    // Historical/imported transcripts really do repeat message ids; the row key
    // is what stops two rows sharing one measurement slot, so it must track the
    // index rather than the id.
    const targets = buildFanoutLaneJumpTargets([lane('dup', 'seat-a'), lane('dup', 'seat-b')])
    expect(targets.get('seat-a')?.rowKey).toBe('dup#0')
    expect(targets.get('seat-b')?.rowKey).toBe('dup#1')
  })

  it('tolerates an empty transcript', () => {
    expect(buildFanoutLaneJumpTargets([]).size).toBe(0)
  })
})
