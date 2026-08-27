import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BlackboardEntry, EnsembleParticipant } from '../store/types'
import {
  buildBlackboardCleanedTranscriptEvent,
  buildBlackboardPostTranscriptEvent,
  buildScoutBriefSharedTranscriptEvent
} from './BlackboardTranscript'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

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
    expect(indexSource).toContain('buildBlackboardPostTranscriptEvent(entry, participant)')
    expect(indexSource).toContain('buildBlackboardCleanedTranscriptEvent(')
    expect(indexSource).toContain('buildScoutBriefSharedTranscriptEvent(')
    expect(indexSource).toMatch(
      /appendStatusForRun\([\s\S]{0,180}transcriptEvent\.content,[\s\S]{0,80}transcriptEvent\.metadata/
    )
  })
})
