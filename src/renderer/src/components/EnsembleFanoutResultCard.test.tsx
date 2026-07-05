import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import { EnsembleFanoutResultCard } from './EnsembleFanoutResultCard'
import {
  ensembleFanoutLaneIntent,
  isEnsembleFanoutResultMessage,
  readEnsembleFanoutTranscriptParts
} from './EnsembleFanoutResultCardModel'

function fanoutMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'fanout-message-1',
    role: 'assistant',
    content: '**Scout finding**\n\n- Keep the lane bounded.',
    timestamp: '2026-07-04T12:00:00.000Z',
    runId: 'codex-run-1',
    metadata: {
      kind: 'ensembleParticipant',
      ensembleRoundId: 'round-1',
      ensembleParticipantId: 'reader-1',
      ensembleLaneId: 'lane-round-1-reader-1-1',
      ensembleLaneIntent: 'read',
      ensembleProvider: 'codex',
      ensembleRole: 'Reader',
      ensembleModel: 'gpt-5.5',
      ensembleOrder: 2
    },
    ...overrides
  }
}

function toolActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'activity-1',
    toolName: 'read_file',
    displayName: 'Read file',
    category: 'read',
    status: 'success',
    resultSummary: 'Read src/App.tsx',
    ...overrides
  } as ToolActivity
}

describe('EnsembleFanoutResultCard', () => {
  it('detects assistant messages materialized from fan-out lanes only', () => {
    expect(isEnsembleFanoutResultMessage(fanoutMessage())).toBe(true)
    expect(ensembleFanoutLaneIntent(fanoutMessage())).toBe('read')
    expect(
      isEnsembleFanoutResultMessage(fanoutMessage({ metadata: { kind: 'ensembleParticipant' } }))
    ).toBe(false)
    expect(isEnsembleFanoutResultMessage(fanoutMessage({ role: 'system' }))).toBe(false)
  })

  it('renders provider, role, intent, and a fixed viewport', () => {
    const html = renderToStaticMarkup(
      <EnsembleFanoutResultCard message={fanoutMessage()} onPreviewImage={() => {}} />
    )

    expect(html).toContain('ensemble-fanout-result-card')
    expect(html).toContain('Reader fan-out')
    expect(html).toContain('Codex')
    expect(html).toContain('Reader')
    expect(html).toContain('live-activity-viewport')
    expect(html).toContain('ensemble-fanout-result-viewport')
    expect(html).toContain('Expand result')
    expect(html).toContain('<strong>Scout finding</strong>')
  })

  it('labels write-intent lanes as writer fan-out', () => {
    const html = renderToStaticMarkup(
      <EnsembleFanoutResultCard
        message={fanoutMessage({
          metadata: {
            ...fanoutMessage().metadata,
            ensembleLaneIntent: 'write',
            ensembleRole: 'Writer'
          }
        })}
        onPreviewImage={() => {}}
      />
    )

    expect(html).toContain('Writer fan-out')
    expect(html).toContain('Writer')
  })

  it('renders grouped fan-out tool activity inside the bounded result card', () => {
    const activity = toolActivity()
    const message = fanoutMessage({
      id: 'fanout-group-1',
      content: 'First note.\n\nSecond note.',
      toolActivities: [activity],
      metadata: {
        ...fanoutMessage().metadata,
        groupedFanoutMessageIds: ['content-1', 'tool-1', 'content-2'],
        groupedToolMessageIds: ['tool-1'],
        ensembleFanoutTranscriptParts: [
          {
            kind: 'content',
            id: 'content-1',
            messageIds: ['content-1'],
            content: 'First note.'
          },
          {
            kind: 'tools',
            id: 'tool-1',
            messageIds: ['tool-1'],
            toolActivities: [activity]
          },
          {
            kind: 'content',
            id: 'content-2',
            messageIds: ['content-2'],
            content: 'Second note.'
          }
        ]
      }
    })
    const html = renderToStaticMarkup(
      <EnsembleFanoutResultCard message={message} onPreviewImage={() => {}} />
    )

    expect(readEnsembleFanoutTranscriptParts(message)).toHaveLength(3)
    expect(html).toContain('ensemble-fanout-result-viewport')
    expect(html.split('live-activity-viewport').length - 1).toBeGreaterThanOrEqual(2)
    expect(html).toContain('ensemble-fanout-tools-viewport')
    expect(html).toContain('Expand tool calls')
    expect(html).toContain('ensemble-fanout-result-tools')
    expect(html).toContain('activity-timeline')
    expect(html).toContain('Read file')
    expect(html).toContain('First note.')
    expect(html).toContain('Second note.')
  })

  it('bounds collapsed grouped fan-out parts to the latest entries', () => {
    const parts = Array.from({ length: 40 }, (_, index) => ({
      kind: 'content' as const,
      id: `content-${index}`,
      messageIds: [`content-${index}`],
      content: `Fanout note ${index}`
    }))
    const message = fanoutMessage({
      content: parts.map((part) => part.content).join('\n\n'),
      metadata: {
        ...fanoutMessage().metadata,
        groupedFanoutMessageIds: parts.map((part) => part.id),
        ensembleFanoutTranscriptParts: parts
      }
    })

    const html = renderToStaticMarkup(
      <EnsembleFanoutResultCard message={message} onPreviewImage={() => {}} />
    )

    expect(html).toContain('16 earlier parts hidden while collapsed.')
    expect(html).not.toContain('Fanout note 0')
    expect(html).toContain('Fanout note 39')
  })

  it('nests and bounds tool-heavy fan-out transcript parts', () => {
    const activities = Array.from({ length: 120 }, (_, index) =>
      toolActivity({
        id: `fanout-tool-${index}`,
        displayName: `Nested tool ${index}`,
        status: 'running',
        resultSummary: `running nested tool ${index}`
      })
    )
    const message = fanoutMessage({
      content: '',
      toolActivities: activities,
      metadata: {
        ...fanoutMessage().metadata,
        groupedFanoutMessageIds: ['tool-heavy'],
        groupedToolMessageIds: ['tool-heavy'],
        ensembleFanoutTranscriptParts: [
          {
            kind: 'tools',
            id: 'tool-heavy',
            messageIds: ['tool-heavy'],
            toolActivities: activities
          }
        ]
      }
    })

    const collapsedHtml = renderToStaticMarkup(
      <EnsembleFanoutResultCard
        message={message}
        expanded={false}
        onExpandedChange={() => {}}
        onPreviewImage={() => {}}
      />
    )

    expect(collapsedHtml.split('live-activity-viewport').length - 1).toBeGreaterThanOrEqual(2)
    expect(collapsedHtml).toContain('ensemble-fanout-tools-viewport')
    expect(collapsedHtml).toContain('aria-label="Reader fan-out tool calls"')
    expect(collapsedHtml).toContain('Expand tool calls')
    expect(collapsedHtml).toContain('40 earlier events hidden while collapsed.')
    expect(collapsedHtml).not.toContain('Nested tool 0')
    expect(collapsedHtml).toContain('Nested tool 119')

    const expandedHtml = renderToStaticMarkup(
      <EnsembleFanoutResultCard
        message={message}
        expanded
        onExpandedChange={() => {}}
        onPreviewImage={() => {}}
      />
    )

    expect(expandedHtml).toContain('Collapse tool calls')
    expect(expandedHtml).not.toContain('earlier events hidden while collapsed.')
    expect(expandedHtml).toContain('Nested tool 0')
    expect(expandedHtml).toContain('Nested tool 119')
  })

  it('nests and bounds fallback tool-only fan-out activity', () => {
    const activities = Array.from({ length: 120 }, (_, index) =>
      toolActivity({
        id: `fallback-tool-${index}`,
        displayName: `Fallback tool ${index}`,
        status: 'running',
        resultSummary: `running fallback tool ${index}`
      })
    )
    const message = fanoutMessage({
      content: '',
      toolActivities: activities
    })

    const html = renderToStaticMarkup(
      <EnsembleFanoutResultCard
        message={message}
        expanded={false}
        onExpandedChange={() => {}}
        onPreviewImage={() => {}}
      />
    )

    expect(html.split('live-activity-viewport').length - 1).toBeGreaterThanOrEqual(2)
    expect(html).toContain('ensemble-fanout-tools-viewport')
    expect(html).toContain('Expand tool calls')
    expect(html).toContain('40 earlier events hidden while collapsed.')
    expect(html).not.toContain('Fallback tool 0')
    expect(html).toContain('Fallback tool 119')
  })
})
