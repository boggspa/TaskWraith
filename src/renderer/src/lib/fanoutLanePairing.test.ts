import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { classifyFanoutLaneSlots } from './fanoutLanePairing'

function lane(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: `lane ${id}`,
    timestamp: 0,
    metadata: { kind: 'ensembleParticipant', ensembleLaneId: `lane-${id}` }
  } as unknown as ChatMessage
}

function subThreadReturn(
  id: string,
  extras?: { waveId?: string; role?: 'tool' | 'system' }
): ChatMessage {
  return {
    id,
    role: extras?.role ?? 'tool',
    content: `↩ Result from Codex sub-thread (${id}):\n\nbody`,
    timestamp: 0,
    metadata: {
      kind: 'subThreadReturn',
      subThreadId: `child-${id}`,
      ...(extras?.waveId ? { parallelResultWaveId: extras.waveId } : {})
    }
  } as unknown as ChatMessage
}

function other(id: string): ChatMessage {
  return { id, role: 'assistant', content: id, timestamp: 0 } as unknown as ChatMessage
}

function tool(id: string): ChatMessage {
  return {
    id,
    role: 'tool',
    content: id,
    timestamp: 0,
    metadata: { kind: 'tool' }
  } as unknown as ChatMessage
}

function system(id: string): ChatMessage {
  return { id, role: 'system', content: id, timestamp: 0 } as unknown as ChatMessage
}

function delegation(id: string): ChatMessage {
  return {
    id,
    role: 'tool',
    content: id,
    timestamp: 0,
    metadata: { kind: 'subThreadDelegation', subThreadId: `child-${id}` }
  } as unknown as ChatMessage
}

describe('classifyFanoutLaneSlots', () => {
  it('returns nothing while the setting is off, so the stacked layout is untouched', () => {
    expect(classifyFanoutLaneSlots([lane('a'), lane('b')], false).size).toBe(0)
  })

  it('pairs adjacent lanes left-to-right', () => {
    const slots = classifyFanoutLaneSlots([lane('a'), lane('b'), lane('c'), lane('d')], true)
    expect([...slots.entries()]).toEqual([
      ['a#0', 'lead'],
      ['b#1', 'trail'],
      ['c#2', 'lead'],
      ['d#3', 'trail']
    ])
  })

  it('spans the odd lane at the end of a run rather than leaving a hole beside it', () => {
    const slots = classifyFanoutLaneSlots([lane('a'), lane('b'), lane('c')], true)
    expect(slots.get('c#2')).toBe('solo')
  })

  it('spans a lane that has no neighbour at all', () => {
    const slots = classifyFanoutLaneSlots([other('x'), lane('a'), other('y')], true)
    expect(slots.get('a#1')).toBe('solo')
    expect(slots.has('x#0')).toBe(false)
    expect(slots.has('y#2')).toBe(false)
  })

  it('restarts pairing at the left column after a non-lane row breaks the run', () => {
    // Without the run reset, `c` would inherit the parity of the run before the
    // interruption and pair across a row the reader has to scroll past.
    const slots = classifyFanoutLaneSlots(
      [lane('a'), lane('b'), lane('c'), other('gap'), lane('d'), lane('e')],
      true
    )
    expect(slots.get('c#2')).toBe('solo')
    expect(slots.get('d#4')).toBe('lead')
    expect(slots.get('e#5')).toBe('trail')
  })

  it('keeps earlier slots stable when a lane streams in at the end of a run', () => {
    // The virtualiser reuses row objects for an unchanged prefix, so a slot that
    // moved under an append would leave stale geometry behind it.
    const before = classifyFanoutLaneSlots([lane('a'), lane('b'), lane('c')], true)
    const after = classifyFanoutLaneSlots([lane('a'), lane('b'), lane('c'), lane('d')], true)
    expect(after.get('a#0')).toBe(before.get('a#0'))
    expect(after.get('b#1')).toBe(before.get('b#1'))
    expect(before.get('c#2')).toBe('solo')
    expect(after.get('c#2')).toBe('lead')
  })

  it('tolerates an empty transcript', () => {
    expect(classifyFanoutLaneSlots([], true).size).toBe(0)
  })

  it('pairs adjacent subThreadReturn rows left-to-right', () => {
    const slots = classifyFanoutLaneSlots(
      [subThreadReturn('r1'), subThreadReturn('r2'), subThreadReturn('r3'), subThreadReturn('r4')],
      true
    )
    expect([...slots.entries()]).toEqual([
      ['r1#0', 'lead'],
      ['r2#1', 'trail'],
      ['r3#2', 'lead'],
      ['r4#3', 'trail']
    ])
  })

  it('spans the odd trailing return as solo', () => {
    const slots = classifyFanoutLaneSlots(
      [subThreadReturn('r1'), subThreadReturn('r2'), subThreadReturn('r3')],
      true
    )
    expect(slots.get('r1#0')).toBe('lead')
    expect(slots.get('r2#1')).toBe('trail')
    expect(slots.get('r3#2')).toBe('solo')
  })

  it.each([
    ['tool', tool('gap')],
    ['assistant', other('gap')],
    ['system', system('gap')],
    ['delegation', delegation('gap')]
  ] as const)('restarts return pairing after a %s breaker', (_label, breaker) => {
    const slots = classifyFanoutLaneSlots(
      [
        subThreadReturn('r1'),
        subThreadReturn('r2'),
        subThreadReturn('r3'),
        breaker,
        subThreadReturn('r4'),
        subThreadReturn('r5')
      ],
      true
    )
    expect(slots.get('r3#2')).toBe('solo')
    expect(slots.get('r4#4')).toBe('lead')
    expect(slots.get('r5#5')).toBe('trail')
    expect(slots.has(`${breaker.id}#3`)).toBe(false)
  })

  it('does not pair a fan-out lane with an adjacent subThreadReturn', () => {
    const slots = classifyFanoutLaneSlots([lane('a'), subThreadReturn('r1')], true)
    expect(slots.get('a#0')).toBe('solo')
    expect(slots.get('r1#1')).toBe('solo')
  })

  it('does not pair across a gap even when returns share a wave id', () => {
    // Wave identity drives viewport headers elsewhere; pairing never reorders
    // or jumps a scrolled-past row to manufacture adjacency.
    const slots = classifyFanoutLaneSlots(
      [
        subThreadReturn('r1', { waveId: 'wave-1' }),
        other('gap'),
        subThreadReturn('r2', { waveId: 'wave-1' })
      ],
      true
    )
    expect(slots.get('r1#0')).toBe('solo')
    expect(slots.get('r2#2')).toBe('solo')
  })

  it('keeps earlier return slots stable when a fourth return streams in', () => {
    const before = classifyFanoutLaneSlots(
      [subThreadReturn('r1'), subThreadReturn('r2'), subThreadReturn('r3')],
      true
    )
    const after = classifyFanoutLaneSlots(
      [
        subThreadReturn('r1'),
        subThreadReturn('r2'),
        subThreadReturn('r3'),
        subThreadReturn('r4')
      ],
      true
    )
    expect(after.get('r1#0')).toBe(before.get('r1#0'))
    expect(after.get('r2#1')).toBe(before.get('r2#1'))
    expect(before.get('r3#2')).toBe('solo')
    expect(after.get('r3#2')).toBe('lead')
    expect(after.get('r4#3')).toBe('trail')
  })
})
