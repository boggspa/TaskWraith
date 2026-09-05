import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatMessage, ChatRecord, ChatRun } from '../../../main/store/types'
import { buildEnsembleFanoutDispatchPayload } from '../../../main/services/EnsembleFanoutDispatchTranscript'
import {
  groupFanoutLaneMessages,
  isEnsembleFanoutResultMessage
} from '../../../shared/fanoutLaneGrouping'
import { buildTranscriptPage } from '../../../shared/transcriptPage'
import { buildEnsembleRoundCardRows } from '../lib/ensembleRoundCards'
import { readEnsembleFanoutViewportHeader } from '../lib/ensembleFanoutViewportGroups'
import { groupAdjacentToolMessages } from '../lib/transcriptToolMessageGrouping'
import { EnsembleFanoutDispatchRow } from './EnsembleFanoutDispatchRow'
import { EnsembleFanoutResultCard } from './EnsembleFanoutResultCard'
import { EnsembleFanoutViewportHeader } from './EnsembleFanoutViewportHeader'

const roundId = 'history-round'

function message(id: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'system',
    content: '',
    timestamp: '2026-09-05T22:04:00.000Z',
    metadata: { ensembleRoundId: roundId },
    ...patch
  }
}

function wave(id: string, laneCount: number, category: 'user' | 'orchestrated') {
  const label = category === 'user' ? 'User Fan-Out' : 'Parallel fan-out'
  const plans = Array.from({ length: laneCount }, (_, index) => ({
    participant: {
      id: `${id}-seat-${index}`,
      provider: 'muse' as const,
      role: `Scout ${index + 1}`,
      model: 'muse-spark-1.3'
    },
    laneIntent: index % 2 === 0 ? ('read' as const) : ('write' as const)
  }))
  const receipt = message(id, {
    content: `${label} · ${laneCount} participant(s) requested; preparing under bounded host admission (read-only seat lanes).`,
    metadata: {
      kind: 'ensembleRoundStatus',
      ensembleRoundId: roundId,
      ensembleFanoutWaveId: id,
      ensembleFanoutDispatch: buildEnsembleFanoutDispatchPayload({ label, category, lanes: plans })
    }
  })
  const runs: ChatRun[] = []
  const fragments = plans.map(({ participant, laneIntent }) => {
    const runId = `${participant.id}-run`
    const metadata = {
      ensembleRoundId: roundId,
      ensembleFanoutWaveId: id,
      ensembleFanoutLabel: label,
      ensembleFanoutCategory: category,
      ensembleLaneId: `${participant.id}-lane`,
      ensembleParticipantId: participant.id,
      ensembleProvider: participant.provider,
      ensembleRole: participant.role,
      ensembleModel: participant.model,
      ensembleLaneIntent: laneIntent,
      // Tool-first lanes can carry stale message status; their persisted run
      // completion must still let the disclosure settle in the loaded page.
      ensembleStatus: 'running'
    }
    runs.push({
      runId,
      status: 'success',
      startedAt: '2026-09-05T22:04:01.000Z',
      endedAt: '2026-09-05T22:07:00.000Z',
      ensembleRoundId: roundId,
      ensembleLaneId: metadata.ensembleLaneId
    })
    return [
      message(`${participant.id}-tool`, {
        role: 'tool',
        runId,
        metadata: { ...metadata, kind: 'ensembleParticipantTools' },
        toolActivities: [
          {
            id: `${participant.id}-read`,
            toolName: 'read_file',
            displayName: 'Read file',
            category: 'read',
            status: 'success',
            resultSummary: 'Read the relevant source.'
          }
        ]
      }),
      message(`${participant.id}-content`, {
        role: 'assistant',
        runId,
        content: `LANE_BODY_${participant.id}`,
        metadata: { ...metadata, kind: 'ensembleParticipant' }
      })
    ]
  })
  return { receipt, fragments, runs }
}

function renderRows(rows: ChatMessage[]): string {
  return renderToStaticMarkup(
    <>
      {rows.map((row) =>
        readEnsembleFanoutViewportHeader(row) ? (
          <EnsembleFanoutViewportHeader key={row.id} message={row} onSetExpanded={() => {}} />
        ) : isEnsembleFanoutResultMessage(row) ? (
          <EnsembleFanoutResultCard key={row.id} message={row} onPreviewImage={() => {}} />
        ) : row.metadata?.ensembleFanoutDispatch ? (
          <EnsembleFanoutDispatchRow key={row.id} message={row} />
        ) : null
      )}
    </>
  )
}

describe('paged mid-round fan-out viewport history', () => {
  it.each([1, 6])(
    'opens only the selected %i-lane wave with its content and tools',
    (laneCount) => {
      const dispatched = wave('orchestrated-wave', laneCount, 'orchestrated')
      const steered = wave('steered-wave', 1, 'user')
      const messages = [
        ...Array.from({ length: 100 }, (_, index) => message(`older-${index}`, { metadata: {} })),
        dispatched.receipt,
        ...dispatched.fragments.map(([tool]) => tool),
        steered.receipt,
        ...steered.fragments.flat(),
        ...dispatched.fragments.map(([, content]) => content),
        message('resumed-caller', {
          role: 'assistant',
          content: 'Continuing the parent turn.',
          metadata: {
            kind: 'ensembleParticipant',
            ensembleRoundId: roundId,
            ensembleParticipantId: 'caller'
          }
        })
      ]
      const chat = {
        appChatId: 'paged-fanout-history',
        chatKind: 'ensemble',
        messages,
        runs: [...dispatched.runs, ...steered.runs],
        updatedAt: 0
      } as ChatRecord
      const page = buildTranscriptPage(chat, { chatId: chat.appChatId, maxMessages: 32 })!
      expect(page.hasOlder).toBe(true)
      const grouped = groupFanoutLaneMessages(groupAdjacentToolMessages(page.messages))
      const project = (expandedFanoutViewportIds: ReadonlySet<string>) =>
        buildEnsembleRoundCardRows({
          chat: { ...chat, messages: page.messages, runs: page.runs },
          displayMessages: grouped,
          collapseOlderRounds: true,
          hasLiveRunEvidence: true,
          manualRoundExpansion: new Map(),
          expandedFanoutViewportIds
        })

      const collapsed = project(new Set())
      const headers = collapsed
        .map(readEnsembleFanoutViewportHeader)
        .filter((header) => header !== null)
      expect(headers.map((header) => [header.waveId, header.laneCount])).toEqual([
        ['orchestrated-wave', laneCount],
        ['steered-wave', 1]
      ])
      const collapsedHtml = renderRows(collapsed)
      expect(collapsedHtml).toContain('aria-expanded="false"')
      expect(collapsedHtml).not.toContain('ensemble-fanout-dispatch-details')
      expect(collapsedHtml).not.toContain('ensemble-fanout-result-card')
      expect(collapsedHtml).not.toContain('LANE_BODY_')

      const expanded = project(new Set([headers[0].viewportId]))
      const laneRows = expanded.filter(isEnsembleFanoutResultMessage)
      expect(laneRows).toHaveLength(laneCount)
      const headerIndex = expanded.findIndex((row) => row.id === headers[0].viewportId)
      expect(expanded.slice(headerIndex + 1, headerIndex + 1 + laneCount)).toEqual(laneRows)
      for (let index = 0; index < laneCount; index += 1) {
        expect(laneRows[index].metadata?.groupedFanoutMessageIds).toEqual([
          `orchestrated-wave-seat-${index}-tool`,
          `orchestrated-wave-seat-${index}-content`
        ])
      }
      const expandedHtml = renderRows(expanded)
      expect(expandedHtml).toContain('aria-expanded="true"')
      expect(expandedHtml).toContain('ensemble-fanout-result-viewport')
      expect(expandedHtml).toContain('ensemble-fanout-result-tools')
      expect(expandedHtml).toContain('Expand 1 activity step')
      expect(expandedHtml).toContain('Expand result')
      for (let index = 0; index < laneCount; index += 1) {
        expect(expandedHtml).toContain(`LANE_BODY_orchestrated-wave-seat-${index}`)
      }
      expect(expandedHtml).not.toContain('LANE_BODY_steered-wave')
      expect(renderRows(project(new Set()))).not.toContain('ensemble-fanout-result-card')
    }
  )
})
