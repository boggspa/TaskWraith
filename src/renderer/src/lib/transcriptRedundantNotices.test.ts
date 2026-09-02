import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { ENSEMBLE_FANOUT_VIEWPORT_HEADER_KIND } from './ensembleFanoutViewportGroups'
import { hideRedundantEnsembleTranscriptNotices } from './transcriptRedundantNotices'

function row(id: string, patch: Partial<ChatMessage>): ChatMessage {
  return { id, role: 'assistant', content: id, timestamp: '2026-09-02T19:00:00.000Z', ...patch }
}

const receipt = row('receipt', {
  role: 'system',
  content:
    'Locked writer fan-out · 1 participant(s) dispatched concurrently (0 read / 1 write-intent).',
  metadata: { kind: 'ensembleRoundStatus' }
})
const routed = row('routed', {
  role: 'system',
  content: 'Routed next: Claude.',
  metadata: { kind: 'ensembleRoundStatus' }
})
// What a folded receipt has become by the time the display list is filtered.
const header = row('header', {
  role: 'system',
  content: 'Fan-Out|wave-1|work|collapsed|1',
  metadata: { kind: ENSEMBLE_FANOUT_VIEWPORT_HEADER_KIND }
})
const lane = row('lane', {
  metadata: { kind: 'ensembleParticipant', ensembleLaneId: 'lane-1' }
})
const failure = row('failure', {
  role: 'system',
  content: 'User Fan-Out complete · 1 lane(s) returned, 1 failed (Reviewer — timeout).',
  metadata: { kind: 'ensembleRoundStatus' }
})

describe('hideRedundantEnsembleTranscriptNotices', () => {
  it('drops routine receipts and keeps every other row in order', () => {
    const output = hideRedundantEnsembleTranscriptNotices([receipt, header, routed, lane, failure])
    expect(output.map((message) => message.id)).toEqual(['header', 'lane', 'failure'])
  })

  it('returns the same array when nothing is redundant', () => {
    const input = [header, lane, failure]
    expect(hideRedundantEnsembleTranscriptNotices(input)).toBe(input)
  })
})
