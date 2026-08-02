import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import {
  buildCollapsedEnsembleFanoutViewportRanges,
  collectEnsembleFanoutViewportGroups,
  ensembleFanoutViewportStageLabel,
  isEnsembleFanoutViewportHeaderMessage,
  readEnsembleFanoutViewportHeader
} from './ensembleFanoutViewportGroups'

function status(id: string, roundId: string, content: string): ChatMessage {
  return {
    id,
    role: 'system',
    content,
    timestamp: `2026-08-02T12:00:0${id.length}.000Z`,
    metadata: { kind: 'ensembleRoundStatus', ensembleRoundId: roundId }
  }
}

function lane(
  id: string,
  roundId: string,
  patch: Partial<NonNullable<ChatMessage['metadata']>> = {}
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: `result-${id}`,
    timestamp: `2026-08-02T12:01:0${id.length}.000Z`,
    runId: `run-${id}`,
    metadata: {
      kind: 'ensembleParticipant',
      ensembleRoundId: roundId,
      ensembleParticipantId: id,
      ensembleLaneId: `lane-${id}`,
      ensembleLaneIntent: 'read',
      ensembleProvider: 'codex',
      ensembleRole: id,
      ensembleModel: 'gpt-5.6-sol',
      ...patch
    }
  }
}

describe('completed-round fan-out viewport groups', () => {
  it('recovers separate Scout and Review waves from durable dispatch receipts', () => {
    const roundId = 'round-1'
    const messages = [
      status(
        'legacy-shared-dispatch',
        roundId,
        'Scout fan-out · 2 read-only participants dispatched concurrently.'
      ),
      lane('scout-a', roundId, { ensembleStageRole: 'scout' }),
      lane('scout-b', roundId, {
        ensembleProvider: 'pi',
        ensembleModel: 'mistral/devstral-2512',
        ensembleStageRole: 'scout'
      }),
      status(
        'legacy-shared-dispatch',
        roundId,
        'Review wave · 1 read-only participants dispatched concurrently.'
      ),
      lane('review-a', roundId, { ensembleProvider: 'claude', ensembleStageRole: 'reviewer' })
    ]

    const groups = collectEnsembleFanoutViewportGroups('chat-1', roundId, messages)

    expect(groups.map((group) => group.stage)).toEqual(['scout', 'review'])
    expect(groups.map((group) => group.lanes.map((entry) => entry.message.id))).toEqual([
      ['scout-a', 'scout-b'],
      ['review-a']
    ])
    expect(groups[0].dispatchLabel).toBe('Scout fan-out')
    expect(new Set(groups.map((group) => group.viewportId)).size).toBe(2)
  })

  it('distinguishes All dispatches from explicitly specified parallel passes', () => {
    const roundId = 'round-2'
    const groups = collectEnsembleFanoutViewportGroups('chat-2', roundId, [
      status(
        'all-dispatch',
        roundId,
        'Ensemble fan-out · 1 participant(s) dispatched concurrently.'
      ),
      lane('all-a', roundId),
      status(
        'specified-dispatch',
        roundId,
        'Parallel fan-out · 1 participant(s) dispatched concurrently.'
      ),
      lane('specified-a', roundId)
    ])

    expect(groups.map((group) => group.stage)).toEqual(['all', 'specified'])
    expect(groups.map((group) => ensembleFanoutViewportStageLabel(group.stage))).toEqual([
      'All',
      'Specified'
    ])
  })

  it('recovers legacy lanes without dispatch receipts from their frozen stage role', () => {
    const groups = collectEnsembleFanoutViewportGroups('chat-legacy', 'round-legacy', [
      lane('legacy-a', 'round-legacy', { ensembleStageRole: 'background' }),
      lane('legacy-b', 'round-legacy', { ensembleStageRole: 'background' })
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].stage).toBe('background')
    expect(groups[0].dispatchLabel).toBeNull()
  })

  it('keeps the summary as one virtual row and restores its lane rows only when expanded', () => {
    const roundId = 'round-3'
    const messages = [
      status('dispatch', roundId, 'Worker fan-out · 2 participant(s) dispatched concurrently.'),
      lane('worker-a', roundId, {
        ensembleStageRole: 'worker',
        groupedFanoutMessageIds: ['worker-a-fragment']
      }),
      lane('worker-b', roundId, { ensembleStageRole: 'worker' })
    ]
    const collapsed = buildCollapsedEnsembleFanoutViewportRanges({
      chatId: 'chat-3',
      roundId,
      messages,
      sourceOffset: 10,
      expandedViewportIds: new Set()
    })
    expect(collapsed).toHaveLength(1)
    const header = collapsed[0].message
    expect(isEnsembleFanoutViewportHeaderMessage(header)).toBe(true)
    expect(readEnsembleFanoutViewportHeader(header)).toMatchObject({
      stage: 'work',
      expanded: false,
      laneCount: 2,
      laneMessageIds: ['worker-a', 'worker-b']
    })
    expect(header.metadata?.groupedFanoutMessageIds).toEqual([
      'worker-a',
      'worker-a-fragment',
      'worker-b'
    ])

    const expanded = buildCollapsedEnsembleFanoutViewportRanges({
      chatId: 'chat-3',
      roundId,
      messages,
      sourceOffset: 10,
      expandedViewportIds: new Set([header.id])
    })
    expect(expanded.map((entry) => entry.message.id)).toEqual([header.id, 'worker-a', 'worker-b'])
    expect(readEnsembleFanoutViewportHeader(expanded[0].message)?.expanded).toBe(true)
    expect(expanded.map((entry) => [entry.startIndex, entry.endIndex])).toEqual([
      [11, 13],
      [11, 12],
      [12, 13]
    ])
  })
})
