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

function other(id: string): ChatMessage {
  return { id, role: 'assistant', content: id, timestamp: 0 } as unknown as ChatMessage
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
})
