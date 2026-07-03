import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { anchorPendingAgentQuestionMarkers } from './agentQuestionMarkerAnchor'

const asst = (id: string): ChatMessage => ({ id, role: 'assistant', content: id, timestamp: id } as ChatMessage)
const marker = (id: string): ChatMessage =>
  ({ id, role: 'system', content: 'asked you', timestamp: id, metadata: { kind: 'agentQuestion' } } as ChatMessage)
const otherSystem = (id: string): ChatMessage =>
  ({ id, role: 'system', content: 'note', timestamp: id, metadata: { kind: 'contextCompaction' } } as ChatMessage)

const ids = (msgs: ChatMessage[]): string[] => msgs.map((m) => m.id)

describe('anchorPendingAgentQuestionMarkers', () => {
  it('is a no-op when there are no pending markers', () => {
    const merged = [asst('a1'), marker('q1'), asst('a2')]
    expect(anchorPendingAgentQuestionMarkers(merged, [], new Set())).toBe(merged)
  })

  it('moves a pending marker stranded in the middle down to the live tail', () => {
    // flushRun re-tailed a2/a3 past the frozen marker position.
    const merged = [asst('a1'), marker('q1'), asst('a2'), asst('a3')]
    const out = anchorPendingAgentQuestionMarkers(merged, merged, new Set(['q1']))
    expect(ids(out)).toEqual(['a1', 'a2', 'a3', 'q1'])
  })

  it('preserves reference when the pending marker is already at the tail', () => {
    const merged = [asst('a1'), asst('a2'), marker('q1')]
    expect(anchorPendingAgentQuestionMarkers(merged, merged, new Set(['q1']))).toBe(merged)
  })

  it('re-appends a marker main dropped from an authoritative snapshot', () => {
    // Incoming (main) snapshot has no marker; live ref still holds it.
    const incoming = [asst('a1'), asst('a2'), asst('a3')]
    const live = [asst('a1'), marker('q1'), asst('a2')]
    const out = anchorPendingAgentQuestionMarkers(incoming, live, new Set(['q1']))
    expect(ids(out)).toEqual(['a1', 'a2', 'a3', 'q1'])
  })

  it('leaves an ANSWERED / non-pending marker in place', () => {
    // q1 answered (not pending), q2 pending → only q2 floats to the tail.
    const merged = [asst('a1'), marker('q1'), asst('a2'), marker('q2'), asst('a3')]
    const out = anchorPendingAgentQuestionMarkers(merged, merged, new Set(['q2']))
    expect(ids(out)).toEqual(['a1', 'q1', 'a2', 'a3', 'q2'])
  })

  it('keeps multiple pending markers together at the tail in stable order', () => {
    const merged = [marker('q1'), asst('a1'), marker('q2'), asst('a2')]
    const out = anchorPendingAgentQuestionMarkers(merged, merged, new Set(['q1', 'q2']))
    expect(ids(out)).toEqual(['a1', 'a2', 'q1', 'q2'])
  })

  it('only touches agentQuestion markers, never other system cards', () => {
    const merged = [asst('a1'), otherSystem('c1'), asst('a2'), marker('q1')]
    // c1 id accidentally in the pending set must NOT move (wrong kind).
    const out = anchorPendingAgentQuestionMarkers(merged, merged, new Set(['q1', 'c1']))
    expect(ids(out)).toEqual(['a1', 'c1', 'a2', 'q1'])
    expect(out).toBe(merged) // q1 already at tail, c1 untouched → same ref
  })
})
