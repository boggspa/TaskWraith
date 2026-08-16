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
import { summarizeCollapsedActivityStack } from './collapsedActivityStack'

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

  it('coalesces Claude provider and host mirrors of one TaskWraith MCP call', () => {
    const resultSummary = JSON.stringify({
      ok: false,
      tool: 'ensemble_fanout',
      error: 'not_authorized'
    })
    const parameters = {
      mode: 'locked_writers',
      targets: ['Work2', 'Work3']
    }
    const providerActivity = activity('toolu_fanout', 'unknown', {
      toolName: 'mcp__TaskWraith__ensemble_fanout',
      displayName: 'Ensemble Fanout',
      status: 'error',
      startedAt: '2026-08-14T10:16:54.223Z',
      endedAt: '2026-08-14T10:16:54.346Z',
      durationMs: 123,
      parameters,
      resultSummary,
      metadata: { provider: 'claude', ensembleProvider: 'claude' }
    })
    const hostActivity = activity(
      'claude-mcp-ensemble_fanout-1786702614341-x4nook6pff',
      'unknown',
      {
        toolName: 'ensemble_fanout',
        displayName: 'Ensemble Fanout',
        status: 'error',
        startedAt: '2026-08-14T10:16:54.342Z',
        endedAt: '2026-08-14T10:16:54.343Z',
        durationMs: 1,
        parameters: { ...parameters, cwd: '/workspace' },
        resultSummary,
        metadata: { provider: 'claude', ensembleProvider: 'claude' }
      }
    )

    const grouped = groupAdjacentToolMessages([
      toolMessage('provider-row', [providerActivity]),
      toolMessage('host-row', [hostActivity])
    ])

    expect(grouped).toHaveLength(1)
    expect(grouped[0].toolActivities?.map((entry) => entry.id)).toEqual(['toolu_fanout'])
    expect(grouped[0].toolActivities?.[0].durationMs).toBe(123)
    expect(grouped[0].metadata?.groupedToolMessageIds).toEqual(['provider-row', 'host-row'])
  })

  it('coalesces a canonical Image View activity using its retained raw wrapper identity', () => {
    const parameters = { paths: ['one.png', 'two.png'], imageCount: 2 }
    const resultSummary = '{"ok":true,"tool":"image_view","imageCount":2}'
    const providerActivity = activity('toolu_images', 'read', {
      toolName: 'image_view',
      displayName: 'Image View',
      startedAt: '2026-08-14T10:16:54.223Z',
      endedAt: '2026-08-14T10:16:54.346Z',
      parameters,
      resultSummary,
      rawUseEvent: { tool_name: 'mcp__TaskWraith__image_view' },
      metadata: { provider: 'claude', ensembleProvider: 'claude' }
    })
    const hostActivity = activity('claude-mcp-image_view-1786702614341-x4nook6pff', 'read', {
      toolName: 'image_view',
      displayName: 'Image View',
      startedAt: '2026-08-14T10:16:54.342Z',
      endedAt: '2026-08-14T10:16:54.343Z',
      parameters: { ...parameters, cwd: '/workspace' },
      resultSummary,
      metadata: { provider: 'claude', ensembleProvider: 'claude' }
    })

    const grouped = groupAdjacentToolMessages([
      toolMessage('provider-row', [providerActivity]),
      toolMessage('host-row', [hostActivity])
    ])

    expect(grouped[0].toolActivities?.map((entry) => entry.id)).toEqual(['toolu_images'])
  })

  it('coalesces Kimi empty ACP wrappers into their enriched host MCP activities', () => {
    const resultSummary = 'Edited src/main/collaboration/ChannelRuntime.test.ts.'
    const providerActivity = activity('2:tool_54ALIIglrx40d9io3WGyvDYa', 'write', {
      toolName: 'mcp__taskwraith__replace',
      displayName: 'Edited file',
      startedAt: '2026-08-16T00:26:40.528Z',
      endedAt: '2026-08-16T00:27:06.476Z',
      durationMs: 25_948,
      parameters: {},
      resultSummary,
      metadata: { provider: 'kimi', ensembleProvider: 'kimi' }
    })
    const hostActivity = activity('kimi-mcp-replace-1786840009148-m3wxiboq3yl', 'write', {
      toolName: 'replace',
      displayName: 'Edited src/main/collaboration/ChannelRuntime.test.ts',
      startedAt: '2026-08-16T00:26:49.149Z',
      endedAt: '2026-08-16T00:27:06.447Z',
      durationMs: 17_298,
      parameters: {
        path: 'src/main/collaboration/ChannelRuntime.test.ts',
        old_string: 'before',
        new_string: 'after',
        cwd: '/workspace'
      },
      filePath: 'src/main/collaboration/ChannelRuntime.test.ts',
      diffSummary: {
        additions: 33,
        deletions: 14,
        source: 'string_replace',
        confidence: 'exact',
        files: [
          {
            path: 'src/main/collaboration/ChannelRuntime.test.ts',
            status: 'modified',
            additions: 33,
            deletions: 14
          }
        ]
      },
      resultSummary,
      metadata: { provider: 'kimi', ensembleProvider: 'kimi' }
    })
    const shellResult = 'Exit code: 1\n\nAssertionError: expected expired to be live'
    const providerShellActivity = activity('2:tool_ui2qd9IvTPWSs4rRvHVZcuIH', 'shell', {
      toolName: 'mcp__taskwraith__run_shell_command',
      displayName: 'Shell command',
      status: 'error',
      startedAt: '2026-08-16T00:27:13.878Z',
      endedAt: '2026-08-16T00:27:19.971Z',
      durationMs: 6_093,
      parameters: {},
      resultSummary: shellResult,
      metadata: { provider: 'kimi', ensembleProvider: 'kimi' }
    })
    const hostShellActivity = activity(
      'kimi-mcp-run_shell_command-1786840034930-hk4hdpu3xop',
      'shell',
      {
        toolName: 'run_shell_command',
        displayName: 'Shell command',
        status: 'error',
        startedAt: '2026-08-16T00:27:14.935Z',
        endedAt: '2026-08-16T00:27:19.946Z',
        durationMs: 5_011,
        parameters: { command: 'npm test -- ChannelRuntime.test.ts', cwd: '/workspace' },
        resultSummary: shellResult,
        metadata: { provider: 'kimi', ensembleProvider: 'kimi' }
      }
    )

    const grouped = groupAdjacentToolMessages([
      toolMessage('provider-row', [providerActivity]),
      toolMessage('host-row', [hostActivity]),
      toolMessage('provider-shell-row', [providerShellActivity]),
      toolMessage('host-shell-row', [hostShellActivity])
    ])

    expect(grouped).toHaveLength(1)
    expect(grouped[0].toolActivities?.map((entry) => entry.id)).toEqual([
      hostActivity.id,
      hostShellActivity.id
    ])
    expect(grouped[0].toolActivities?.[0]).toMatchObject({
      filePath: 'src/main/collaboration/ChannelRuntime.test.ts',
      diffSummary: { additions: 33, deletions: 14 },
      durationMs: 25_948
    })
    expect(summarizeCollapsedActivityStack(grouped[0].toolActivities || [])).toMatchObject({
      label: 'Edited 1 file · Ran 1 command · 1 error',
      activityCount: 2,
      errorCount: 1
    })
    expect(grouped[0].metadata?.groupedToolMessageIds).toEqual([
      'provider-row',
      'host-row',
      'provider-shell-row',
      'host-shell-row'
    ])
  })

  it('keeps a Kimi ACP wrapper when no nested matching host receipt proves a mirror', () => {
    const providerActivity = activity('2:tool_unmatched', 'write', {
      toolName: 'mcp__taskwraith__replace',
      startedAt: '2026-08-16T00:26:40.528Z',
      endedAt: '2026-08-16T00:27:06.476Z',
      parameters: {},
      resultSummary: 'Edited src/a.ts.',
      metadata: { provider: 'kimi', ensembleProvider: 'kimi' }
    })
    const laterHostActivity = activity('kimi-mcp-replace-later', 'write', {
      toolName: 'replace',
      startedAt: '2026-08-16T00:27:07.000Z',
      endedAt: '2026-08-16T00:27:08.000Z',
      parameters: { path: 'src/a.ts' },
      resultSummary: 'Edited src/a.ts.',
      metadata: { provider: 'kimi', ensembleProvider: 'kimi' }
    })

    const grouped = groupAdjacentToolMessages([
      toolMessage('provider-row', [providerActivity]),
      toolMessage('host-row', [laterHostActivity])
    ])

    expect(grouped[0].toolActivities?.map((entry) => entry.id)).toEqual([
      providerActivity.id,
      laterHostActivity.id
    ])
  })

  it('coalesces a running Kimi wrapper as soon as its scoped host activity appears', () => {
    const providerActivity = activity('2:tool_live', 'write', {
      toolName: 'mcp__taskwraith__replace',
      displayName: 'Edited file',
      status: 'running',
      startedAt: '2026-08-16T00:29:40.000Z',
      parameters: {},
      metadata: { provider: 'kimi', ensembleProvider: 'kimi' }
    })
    const hostActivity = activity('kimi-mcp-replace-live', 'write', {
      toolName: 'replace',
      displayName: 'Edited src/main/collaboration/ChannelRuntime.ts',
      status: 'running',
      startedAt: '2026-08-16T00:29:48.000Z',
      parameters: { path: 'src/main/collaboration/ChannelRuntime.ts', cwd: '/workspace' },
      filePath: 'src/main/collaboration/ChannelRuntime.ts',
      metadata: { provider: 'kimi', ensembleProvider: 'kimi' }
    })

    const grouped = groupAdjacentToolMessages([
      toolMessage('provider-row', [providerActivity]),
      toolMessage('host-row', [hostActivity])
    ])

    expect(grouped[0].toolActivities).toMatchObject([
      {
        id: hostActivity.id,
        displayName: 'Edited src/main/collaboration/ChannelRuntime.ts',
        filePath: 'src/main/collaboration/ChannelRuntime.ts',
        startedAt: providerActivity.startedAt
      }
    ])
    expect(summarizeCollapsedActivityStack(grouped[0].toolActivities || [])).toMatchObject({
      label: 'Edited 1 file',
      activityCount: 1
    })
  })

  it('keeps similar Claude MCP calls when mirror proof does not match', () => {
    const base = activity('toolu_fanout', 'unknown', {
      toolName: 'mcp__TaskWraith__ensemble_fanout',
      status: 'error',
      startedAt: '2026-08-14T10:16:54.223Z',
      endedAt: '2026-08-14T10:16:54.346Z',
      parameters: { mode: 'locked_writers', targets: ['Work2'] },
      resultSummary: '{"error":"not_authorized"}',
      metadata: { provider: 'claude', ensembleProvider: 'claude' }
    })
    const differentResult = activity(
      'claude-mcp-ensemble_fanout-1786702614341-x4nook6pff',
      'unknown',
      {
        toolName: 'ensemble_fanout',
        status: 'error',
        startedAt: '2026-08-14T10:16:54.342Z',
        endedAt: '2026-08-14T10:16:54.343Z',
        parameters: { mode: 'locked_writers', targets: ['Work2'], cwd: '/workspace' },
        resultSummary: '{"error":"different_failure"}',
        metadata: { provider: 'claude', ensembleProvider: 'claude' }
      }
    )

    const grouped = groupAdjacentToolMessages([
      toolMessage('provider-row', [base]),
      toolMessage('host-row', [differentResult])
    ])
    expect(grouped[0].toolActivities?.map((entry) => entry.id)).toEqual([
      base.id,
      differentResult.id
    ])
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
