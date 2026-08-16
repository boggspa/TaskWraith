import { describe, expect, it } from 'vitest'
import {
  extractRoundSummaryBlock,
  findTerminalSynthesizerRoundSummary
} from './EnsembleRoundSummary'
import type { ChatMessage } from './store/types'

function assistant(
  id: string,
  participantId: string,
  content: string,
  roundId = 'round-1'
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: '2026-05-27T12:00:00.000Z',
    runId: `${participantId}-run`,
    metadata: {
      kind: 'ensembleParticipant',
      ensembleRoundId: roundId,
      ensembleParticipantId: participantId,
      ensembleProvider: participantId === 'claude' ? 'claude' : 'codex',
      ensembleRole: participantId === 'claude' ? 'Reviewer' : 'Chair'
    }
  }
}

const structured = `Round summary:
The panel chose the smaller patch.

Decisions:
- Capture only terminal chair output.

Corrections:
- None.

Open risks:
- Wakeups are still deferred.

Next action:
- Write tests.`

describe('EnsembleRoundSummary', () => {
  it('extracts the final structured round summary block', () => {
    expect(extractRoundSummaryBlock(`Earlier text\n\n${structured}`)).toContain('The panel chose')
  })

  it('requires every structured label', () => {
    expect(extractRoundSummaryBlock('Round summary:\nOnly prose')).toBeNull()
  })

  it('captures only the terminal synthesizer assistant message', () => {
    const record = findTerminalSynthesizerRoundSummary({
      messages: [assistant('a', 'claude', 'Looks good.'), assistant('b', 'codex', structured)],
      roundId: 'round-1',
      synthesizerParticipantId: 'codex',
      capturedAt: '2026-05-27T12:01:00.000Z'
    })
    expect(record).toMatchObject({
      roundId: 'round-1',
      participantId: 'codex',
      provider: 'codex',
      role: 'Chair'
    })
    expect(record?.summary).toContain('Next action:')
  })

  it('ignores non-synth summaries', () => {
    const record = findTerminalSynthesizerRoundSummary({
      messages: [assistant('a', 'claude', structured)],
      roundId: 'round-1',
      synthesizerParticipantId: 'codex',
      capturedAt: '2026-05-27T12:01:00.000Z'
    })
    expect(record).toBeNull()
  })

  it('rejects synth summaries followed by another participant', () => {
    const record = findTerminalSynthesizerRoundSummary({
      messages: [
        assistant('a', 'codex', structured),
        assistant('b', 'claude', 'I have a late correction.')
      ],
      roundId: 'round-1',
      synthesizerParticipantId: 'codex',
      capturedAt: '2026-05-27T12:01:00.000Z'
    })
    expect(record).toBeNull()
  })

  it('ignores a host status receipt after the terminal synthesizer', () => {
    const status: ChatMessage = {
      id: 'status',
      role: 'system',
      content: 'Continuous handoff limit reached.',
      timestamp: '2026-05-27T12:00:30.000Z',
      metadata: {
        kind: 'ensembleParticipantStatus',
        ensembleRoundId: 'round-1'
      }
    }
    const record = findTerminalSynthesizerRoundSummary({
      messages: [assistant('a', 'codex', structured), status],
      roundId: 'round-1',
      synthesizerParticipantId: 'codex',
      capturedAt: '2026-05-27T12:01:00.000Z'
    })

    expect(record?.participantId).toBe('codex')
  })
})
