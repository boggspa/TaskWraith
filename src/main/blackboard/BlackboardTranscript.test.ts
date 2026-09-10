import { describe, expect, it } from 'vitest'
import { MainSourceProbe } from '../mainSourceProbe.testutil'
import type { BlackboardEntry, EnsembleParticipant } from '../store/types'
import {
  buildBlackboardCleanedTranscriptEvent,
  buildBlackboardPostTranscriptEvent,
  buildScoutBriefSharedTranscriptEvent
} from './BlackboardTranscript'

const probe = new MainSourceProbe('src/main/index.ts', new URL('../index.ts', import.meta.url))

const participant: EnsembleParticipant = {
  id: 'scout-5',
  provider: 'ollama',
  model: 'qwen3.5:9b',
  enabled: true,
  role: 'Competitive scout',
  instructions: '',
  order: 4
}

const entry: BlackboardEntry = {
  id: 'blackboard-1',
  chatId: 'chat-1',
  roundId: 'round-1',
  participantId: participant.id,
  key: 'scout5-competitor-research',
  value: 'Durable findings',
  category: 'note',
  scope: 'session',
  createdAt: '2026-08-27T12:40:00.000Z'
}

describe('Blackboard transcript event builder', () => {
  it('keeps the existing text fallback and freezes upstream branding', () => {
    const event = buildBlackboardPostTranscriptEvent(entry, participant)

    expect(event.content).toBe('Blackboard updated: note / scout5-competitor-research.')
    expect(event.metadata).toMatchObject({
      kind: 'ensembleBlackboardChange',
      provider: 'ollama',
      ensembleParticipantId: 'scout-5',
      displayProviderLabel: 'Alibaba',
      displayHueClass: 'alibaba',
      blackboardChange: {
        action: 'updated',
        key: 'scout5-competitor-research',
        category: 'note',
        scope: 'session',
        provider: 'ollama',
        displayProviderLabel: 'Alibaba',
        displayHueClass: 'alibaba'
      }
    })
  })

  it('promotes Blackboard polls and cleanups through the same event carrier', () => {
    const poll = buildBlackboardPostTranscriptEvent(
      {
        ...entry,
        key: 'ship-or-hold',
        category: 'decision',
        poll: {
          status: 'open',
          options: ['Ship', 'Hold', 'Revise'],
          votes: [],
          eligibleParticipantIds: ['scout-5'],
          includeUser: true,
          updatedAt: entry.createdAt
        }
      },
      participant
    )
    const cleaned = buildBlackboardCleanedTranscriptEvent(2, entry.createdAt, participant)

    expect(poll.content).toBe('Blackboard poll opened: ship-or-hold (3 choices).')
    expect(poll.metadata?.blackboardChange).toMatchObject({
      action: 'pollOpened',
      optionCount: 3
    })
    expect(cleaned.content).toBe('Blackboard cleaned: removed 2 entries.')
    expect(cleaned.metadata?.blackboardChange).toMatchObject({ action: 'cleaned', removedCount: 2 })
  })

  it('leaves attribution metadata absent when no live participant owns the run', () => {
    expect(buildBlackboardPostTranscriptEvent(entry, undefined)).toEqual({
      content: 'Blackboard updated: note / scout5-competitor-research.',
      metadata: undefined
    })
  })

  it('presents scout briefs as Blackboard + next-writer handoffs without routine high noise', () => {
    const high = buildScoutBriefSharedTranscriptEvent(
      {
        participantId: participant.id,
        participantRole: 'Competitive scout',
        provider: participant.provider,
        findings: 'The competitor route is bounded.',
        confidence: 'high',
        emittedAt: entry.createdAt
      },
      participant
    )
    const low = buildScoutBriefSharedTranscriptEvent(
      {
        participantId: participant.id,
        participantRole: 'Competitive scout',
        provider: participant.provider,
        findings: 'The route may have changed.',
        confidence: 'low',
        emittedAt: entry.createdAt
      },
      participant
    )

    expect(high.content).toBe(
      'Scout brief shared · Competitive scout (Alibaba) · Blackboard + next writer.'
    )
    expect(high.content).not.toContain('confidence')
    expect(high.metadata?.blackboardChange).toMatchObject({
      action: 'scoutBriefShared',
      role: 'Competitive scout',
      displayProviderLabel: 'Alibaba'
    })
    expect(high.metadata?.blackboardChange).not.toHaveProperty('confidence')
    expect(low.content).toContain('needs verification')
    expect(low.metadata?.blackboardChange).toMatchObject({ confidence: 'low' })
  })

  it('wires post and cleanup metadata through the run-authored status seam', () => {
    // The builders themselves are exercised above against real inputs. All this
    // claim owns is the wiring in the composition root, which cannot be
    // imported: every Blackboard MCP tool that mutates the board must reach a
    // builder and hand BOTH halves of what it returns to the run-authored
    // status seam. Scoped to the dispatcher rather than the whole file, so a
    // call that survives only in a comment or in an unrelated lane no longer
    // satisfies it.
    const dispatch = probe.fn('executeUnscopedGeminiMcpTool')

    const post = probe.callsTo(dispatch, 'buildBlackboardPostTranscriptEvent')
    expect(post).toHaveLength(1)
    expect(probe.argText(post[0], 0)).toBe('entry')
    expect(probe.argText(post[0], 1)).toBe('participant')

    // The cleanup line reports how many entries went away, so the count handed
    // over must be the removed list — the remaining count reads as a plausible
    // number and would produce a silently wrong transcript line that no
    // unit test of the builder can see.
    const cleaned = probe.callsTo(dispatch, 'buildBlackboardCleanedTranscriptEvent')
    expect(cleaned).toHaveLength(1)
    expect(probe.argText(cleaned[0], 0)).toBe('result.removed.length')

    // Only the brief the orchestrator actually recorded is shared; the raw tool
    // arguments are not the same thing (rejected briefs must stay out of the
    // transcript).
    const scoutBrief = probe.callsTo(dispatch, 'buildScoutBriefSharedTranscriptEvent')
    expect(scoutBrief).toHaveLength(1)
    expect(probe.argText(scoutBrief[0], 0)).toBe('recordedBrief')

    // The seam itself. This replaces a regex that allowed arbitrary text
    // between `appendStatusForRun(` and the two operands and was matched
    // against the whole file: one wired site anywhere kept it green, so a
    // dropped `transcriptEvent.metadata` at either of the other two sites —
    // which strips the provider attribution off the transcript row — was
    // invisible to it. Each of the three appends is now checked positionally.
    const appends = probe.callsTo(dispatch, 'appendStatusForRun')
    expect(appends).toHaveLength(3)
    for (const append of appends) {
      expect(probe.argText(append, 1)).toBe('transcriptEvent.content')
      expect(probe.argText(append, 2)).toBe('transcriptEvent.metadata')
    }
  })
})
