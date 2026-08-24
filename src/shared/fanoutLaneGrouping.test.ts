import { describe, expect, it } from 'vitest'

import type { ChatMessage, ToolActivity } from '../main/store/types'
import { groupFanoutLaneMessages, readEnsembleFanoutTranscriptParts } from './fanoutLaneGrouping'

const metadata = {
  kind: 'ensembleParticipantTools',
  ensembleRoundId: 'round-1',
  ensembleParticipantId: 'mistral-seat',
  ensembleLaneId: 'lane-1',
  ensembleProvider: 'mistral',
  ensembleRole: 'Writer'
}

function message(id: string, activity: ToolActivity): ChatMessage {
  return {
    id,
    role: 'tool',
    content: '',
    timestamp: '2026-08-24T02:16:29.000Z',
    runId: 'mistral-run-1',
    metadata,
    toolActivities: [activity]
  }
}

describe('fanout lane grouping', () => {
  it('keeps an enriched Mistral host mirror in the lane parts as well as the top activity list', () => {
    const wrapper: ToolActivity = {
      id: 'MtlNbiz6L',
      toolName: 'TaskWraith_replace',
      displayName: 'Ran replace',
      category: 'unknown',
      status: 'success',
      startedAt: '2026-08-24T02:16:29.026Z',
      endedAt: '2026-08-24T02:16:29.537Z',
      durationMs: 511,
      parameters: {},
      resultSummary: 'Ran replace',
      metadata: { provider: 'mistral', ensembleProvider: 'mistral' }
    }
    const host: ToolActivity = {
      id: 'mistral-mcp-replace-1787451389069-nk41h7ege1',
      toolName: 'replace',
      displayName: 'Edited src/a.ts',
      category: 'write',
      status: 'success',
      startedAt: '2026-08-24T02:16:29.069Z',
      endedAt: '2026-08-24T02:16:29.531Z',
      durationMs: 462,
      parameters: { path: 'src/a.ts', old_string: 'before', new_string: 'after\nnext' },
      filePath: 'src/a.ts',
      diffSummary: {
        additions: 2,
        deletions: 1,
        source: 'string_replace',
        confidence: 'estimated'
      },
      resultSummary: 'Ran replace',
      metadata: { provider: 'mistral', ensembleProvider: 'mistral' }
    }

    const [grouped] = groupFanoutLaneMessages([
      message('wrapper-row', wrapper),
      message('host-row', host)
    ])

    expect(grouped.toolActivities).toMatchObject([
      { id: host.id, filePath: 'src/a.ts', durationMs: 511, diffSummary: { additions: 2 } }
    ])
    expect(readEnsembleFanoutTranscriptParts(grouped)).toMatchObject([
      { kind: 'tools', toolActivities: [{ id: host.id, diffSummary: { deletions: 1 } }] }
    ])
  })
})
