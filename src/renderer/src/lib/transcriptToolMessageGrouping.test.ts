import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import { groupAdjacentToolMessages } from './transcriptToolMessageGrouping'

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
