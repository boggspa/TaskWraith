import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import {
  groupAdjacentToolMessages,
  groupAdjacentToolMessagesWithRanges,
  groupFanoutLaneMessages,
  groupFanoutLaneMessagesStable,
  groupedTranscriptMessageIds
} from './transcriptToolMessageGrouping'
import {
  isEnsembleFanoutResultMessage,
  readEnsembleFanoutTranscriptParts
} from '../components/EnsembleFanoutResultCardModel'

function activity(
  id: string,
  category: ToolActivity['category'] = 'read',
  overrides: Partial<ToolActivity> = {}
): ToolActivity {
  return {
    id,
    toolName: category === 'write' ? 'write_file' : 'read_file',
    displayName: category,
    category,
    status: 'success',
    ...overrides
  } as ToolActivity
}

function toolMessage(
  id: string,
  activities: ToolActivity[] = [activity(`${id}-a`)],
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    role: 'tool',
    content: '',
    timestamp: '2026-06-13T00:00:00.000Z',
    toolActivities: activities,
    runId: 'run-1',
    ...overrides
  }
}

function textMessage(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: 'Break the tool run.',
    timestamp: '2026-06-13T00:00:00.000Z'
  }
}

function fanoutContentMessage(
  id: string,
  content: string,
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: '2026-06-13T00:00:00.000Z',
    runId: 'run-fanout',
    metadata: {
      kind: 'ensembleParticipant',
      ensembleRoundId: 'round-1',
      ensembleParticipantId: 'participant-reader',
      ensembleLaneId: 'lane-round-1-reader-1',
      ensembleLaneIntent: 'read',
      ensembleProvider: 'codex',
      ensembleRole: 'Reader',
      ensembleOrder: 2
    },
    ...overrides
  }
}

function fanoutToolMessage(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return toolMessage(id, [activity(`${id}-a`, 'read')], {
    runId: 'run-fanout',
    metadata: {
      kind: 'ensembleParticipantTools',
      ensembleRoundId: 'round-1',
      ensembleParticipantId: 'participant-reader',
      ensembleLaneId: 'lane-round-1-reader-1',
      ensembleLaneIntent: 'read',
      ensembleProvider: 'codex',
      ensembleRole: 'Reader',
      ensembleOrder: 2
    },
    ...overrides
  })
}

describe('groupAdjacentToolMessages', () => {
  it('folds adjacent plain tool messages into one synthetic tool row', () => {
    const grouped = groupAdjacentToolMessages([
      toolMessage('t1', [activity('a1')]),
      toolMessage('t2', [activity('a2')])
    ])

    expect(grouped).toHaveLength(1)
    // Stable id derived from the first message only — does NOT change as the
    // run grows (prevents the React-key churn that replayed the entrance fade).
    expect(grouped[0].id).toBe('tool-group-t1')
    expect(grouped[0].toolActivities?.map((entry) => entry.id)).toEqual(['a1', 'a2'])
    expect(grouped[0].metadata?.groupedToolMessageIds).toEqual(['t1', 't2'])
  })

  it('reports source ranges for grouped tool runs', () => {
    const ranges = groupAdjacentToolMessagesWithRanges([
      textMessage('before'),
      toolMessage('t1', [activity('a1')]),
      toolMessage('t2', [activity('a2')]),
      textMessage('after')
    ])

    expect(ranges.map((range) => [range.message.id, range.startIndex, range.endIndex])).toEqual([
      ['before', 0, 1],
      ['tool-group-t1', 1, 3],
      ['after', 3, 4]
    ])
  })

  it('keeps the grouped id STABLE as the run grows (no React-key churn)', () => {
    // The id must not change as more tool messages stream into the same
    // group — otherwise the React key churns, the grouped row remounts, and
    // the CSS entrance fade replays as a flash near the tail. The growing
    // membership is still observable via `groupedToolMessageIds`.
    const two = groupAdjacentToolMessages([
      toolMessage('t1', [activity('a1')]),
      toolMessage('t2', [activity('a2')])
    ])
    const three = groupAdjacentToolMessages([
      toolMessage('t1', [activity('a1')]),
      toolMessage('t2', [activity('a2')]),
      toolMessage('t3', [activity('a3')])
    ])
    expect(two[0].id).toBe('tool-group-t1')
    expect(three[0].id).toBe('tool-group-t1')
    expect(three[0].id).toBe(two[0].id) // stable identity across growth
    expect(three[0].metadata?.groupedToolMessageIds).toEqual(['t1', 't2', 't3'])
  })

  it('does not group across assistant/user/system messages', () => {
    const grouped = groupAdjacentToolMessages([
      toolMessage('t1', [activity('a1')]),
      textMessage('m1'),
      toolMessage('t2', [activity('a2')])
    ])

    expect(grouped.map((message) => message.id)).toEqual(['t1', 'm1', 't2'])
  })

  it('does not group across different run ids', () => {
    const first = toolMessage('t1', [activity('a1')])
    const second = { ...toolMessage('t2', [activity('a2')]), runId: 'run-2' }

    expect(groupAdjacentToolMessages([first, second]).map((message) => message.id)).toEqual([
      't1',
      't2'
    ])
  })

  it('leaves tool-role special cards out of grouped tool runs', () => {
    const special: ChatMessage = {
      ...toolMessage('return-card', [activity('return-a')]),
      metadata: { kind: 'subThreadReturn' }
    }

    const grouped = groupAdjacentToolMessages([
      toolMessage('t1', [activity('a1')]),
      special,
      toolMessage('t2', [activity('a2')])
    ])

    expect(grouped.map((message) => message.id)).toEqual(['t1', 'return-card', 't2'])
  })

  it('groups adjacent ensemble tools from the same participant', () => {
    const metadata = {
      kind: 'ensembleParticipantTools',
      ensembleProvider: 'claude',
      ensembleParticipantId: 'participant-claude',
      ensembleRole: 'Reviewer',
      ensembleModel: 'claude-sonnet-5',
      ensembleReasoningEffort: 'high',
      ensembleRoundId: 'round-1'
    }
    const grouped = groupAdjacentToolMessages([
      toolMessage('t1', [activity('a1')], { metadata }),
      toolMessage('t2', [activity('a2')], { metadata })
    ])

    expect(grouped).toHaveLength(1)
    expect(grouped[0].toolActivities?.map((entry) => entry.id)).toEqual(['a1', 'a2'])
    expect(grouped[0].metadata?.ensembleProvider).toBe('claude')
    expect(grouped[0].metadata?.groupedToolMessageIds).toEqual(['t1', 't2'])
  })

  it('does not group same-participant tools when model or reasoning metadata differs', () => {
    const baseMetadata = {
      kind: 'ensembleParticipantTools',
      ensembleProvider: 'codex',
      ensembleParticipantId: 'participant-codex',
      ensembleRole: 'Reviewer',
      ensembleRoundId: 'round-1'
    }
    const first = toolMessage('t1', [activity('a1')], {
      metadata: {
        ...baseMetadata,
        ensembleModel: 'gpt-5.5',
        ensembleReasoningEffort: 'xhigh'
      }
    })
    const second = toolMessage('t2', [activity('a2')], {
      metadata: {
        ...baseMetadata,
        ensembleModel: 'gpt-5.4',
        ensembleReasoningEffort: 'high'
      }
    })

    expect(groupAdjacentToolMessages([first, second]).map((message) => message.id)).toEqual([
      't1',
      't2'
    ])
  })

  it('does not group ensemble tools from different participants or providers', () => {
    const first = toolMessage('t1', [activity('a1')], {
      metadata: {
        kind: 'ensembleParticipantTools',
        ensembleProvider: 'claude',
        ensembleParticipantId: 'participant-claude',
        ensembleRole: 'Reviewer',
        ensembleRoundId: 'round-1'
      }
    })
    const second = toolMessage('t2', [activity('a2')], {
      metadata: {
        kind: 'ensembleParticipantTools',
        ensembleProvider: 'codex',
        ensembleParticipantId: 'participant-codex',
        ensembleRole: 'Implementer',
        ensembleRoundId: 'round-1'
      }
    })

    expect(groupAdjacentToolMessages([first, second]).map((message) => message.id)).toEqual([
      't1',
      't2'
    ])
  })

  it('does not group activity-level tool attribution from different providers', () => {
    const first = toolMessage('t1', [
      activity('a1', 'read', { metadata: { provider: 'claude', ensembleProvider: 'claude' } })
    ])
    const second = toolMessage('t2', [
      activity('a2', 'read', { metadata: { provider: 'codex', ensembleProvider: 'codex' } })
    ])

    expect(groupAdjacentToolMessages([first, second]).map((message) => message.id)).toEqual([
      't1',
      't2'
    ])
  })
})

describe('groupFanoutLaneMessages', () => {
  it('folds a fan-out participant timeline into one result row with ordered content/tool parts', () => {
    const grouped = groupFanoutLaneMessages([
      fanoutContentMessage('c1', 'First note.'),
      fanoutToolMessage('t1'),
      fanoutContentMessage('c2', 'Second note.')
    ])

    expect(grouped).toHaveLength(1)
    expect(grouped[0].id).toBe('c1')
    expect(isEnsembleFanoutResultMessage(grouped[0])).toBe(true)
    expect(grouped[0].content).toBe('First note.\n\nSecond note.')
    expect(grouped[0].toolActivities?.map((entry) => entry.id)).toEqual(['t1-a'])
    expect(grouped[0].metadata?.groupedFanoutMessageIds).toEqual(['c1', 't1', 'c2'])
    expect(grouped[0].metadata?.groupedToolMessageIds).toEqual(['t1'])
    expect(groupedTranscriptMessageIds(grouped[0])).toEqual(['c1', 't1', 'c2'])
    expect(readEnsembleFanoutTranscriptParts(grouped[0]).map((part) => part.kind)).toEqual([
      'content',
      'tools',
      'content'
    ])
  })

  it('reuses unchanged historical lane cards while a different lane grows', () => {
    const firstLane = fanoutContentMessage('c1', 'First note.')
    const otherLane = fanoutContentMessage('other-c1', 'Other lane.', {
      runId: 'run-other',
      metadata: {
        ...fanoutContentMessage('base', '').metadata,
        ensembleParticipantId: 'participant-other',
        ensembleLaneId: 'lane-round-1-other-1',
        ensembleRole: 'Other'
      }
    })
    const initial = groupFanoutLaneMessagesStable([firstLane, otherLane])
    const otherLaneTool = fanoutToolMessage('other-t1', {
      runId: 'run-other',
      metadata: {
        ...otherLane.metadata,
        kind: 'ensembleParticipantTools'
      }
    })
    const next = groupFanoutLaneMessagesStable(
      [firstLane, otherLane, otherLaneTool],
      initial
    )

    expect(next.output[0]).toBe(initial.output[0])
    expect(next.output[1]).not.toBe(initial.output[1])
    expect(next.output[1].metadata?.groupedFanoutMessageIds).toEqual(['other-c1', 'other-t1'])
  })

  it('keeps same-round fan-out lanes separated by lane/run identity', () => {
    const otherLane = fanoutContentMessage('c-other', 'Other lane.', {
      runId: 'run-other',
      metadata: {
        ...fanoutContentMessage('base', '').metadata,
        ensembleParticipantId: 'participant-other',
        ensembleLaneId: 'lane-round-1-other-1',
        ensembleRole: 'Other'
      }
    })

    const grouped = groupFanoutLaneMessages([
      fanoutContentMessage('c1', 'First note.'),
      fanoutToolMessage('t1'),
      otherLane
    ])

    expect(grouped.map((message) => message.id)).toEqual(['c1', 'c-other'])
    expect(grouped[0].metadata?.groupedFanoutMessageIds).toEqual(['c1', 't1'])
    expect(grouped[1].metadata?.groupedFanoutMessageIds).toBeUndefined()
  })

  it('keeps each fan-out lane in one first-anchored viewport across interleaved rows', () => {
    const systemMessage: ChatMessage = {
      id: 'system-between-lanes',
      role: 'system',
      content: 'Blackboard updated: risk / viewport-smoke.',
      timestamp: '2026-06-13T00:00:01.000Z'
    }
    const otherLane = fanoutContentMessage('other-c1', 'Other lane first note.', {
      runId: 'run-other',
      metadata: {
        ...fanoutContentMessage('base', '').metadata,
        ensembleParticipantId: 'participant-other',
        ensembleLaneId: 'lane-round-1-other-1',
        ensembleRole: 'Other'
      }
    })
    const otherLaneTool = fanoutToolMessage('other-t1', {
      runId: 'run-other',
      metadata: {
        ...otherLane.metadata,
        kind: 'ensembleParticipantTools'
      }
    })

    const grouped = groupFanoutLaneMessages([
      fanoutContentMessage('c1', 'First note.'),
      systemMessage,
      otherLane,
      fanoutToolMessage('t1'),
      otherLaneTool,
      fanoutContentMessage('c2', 'Final note.')
    ])

    expect(grouped).toHaveLength(3)
    expect(grouped[0].id).toBe('c1')
    expect(grouped[1]).toBe(systemMessage)
    expect(grouped[2].id).toBe('other-c1')
    expect(grouped[0].metadata?.groupedFanoutMessageIds).toEqual(['c1', 't1', 'c2'])
    expect(readEnsembleFanoutTranscriptParts(grouped[0]).map((part) => part.kind)).toEqual([
      'content',
      'tools',
      'content'
    ])
    expect(grouped[2].metadata?.groupedFanoutMessageIds).toEqual(['other-c1', 'other-t1'])
  })

  it('materializes tool-only fan-out lane activity as a fan-out result card row', () => {
    const grouped = groupFanoutLaneMessages([fanoutToolMessage('t-only')])

    expect(grouped).toHaveLength(1)
    expect(grouped[0].id).toBe('t-only')
    expect(grouped[0].role).toBe('assistant')
    expect(isEnsembleFanoutResultMessage(grouped[0])).toBe(true)
    expect(grouped[0].toolActivities?.map((entry) => entry.id)).toEqual(['t-only-a'])
    expect(readEnsembleFanoutTranscriptParts(grouped[0]).map((part) => part.kind)).toEqual([
      'tools'
    ])
  })

  it('keeps real constituent ids when the lane starts with an adjacent tool group', () => {
    const toolGrouped = groupAdjacentToolMessages([
      fanoutToolMessage('t1'),
      fanoutToolMessage('t2')
    ])
    const grouped = groupFanoutLaneMessages([
      ...toolGrouped,
      fanoutContentMessage('c1', 'Summary after tools.')
    ])

    expect(toolGrouped[0].id).toBe('tool-group-t1')
    expect(grouped).toHaveLength(1)
    expect(grouped[0].id).toBe('t1')
    expect(grouped[0].metadata?.groupedFanoutMessageIds).toEqual([
      'tool-group-t1',
      't1',
      't2',
      'c1'
    ])
    expect(groupedTranscriptMessageIds(grouped[0])).toEqual(['tool-group-t1', 't1', 't2', 'c1'])
  })
})
