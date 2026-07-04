import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { EnsembleFanoutResultCard } from './EnsembleFanoutResultCard'
import {
  ensembleFanoutLaneIntent,
  isEnsembleFanoutResultMessage
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

describe('EnsembleFanoutResultCard', () => {
  it('detects assistant messages materialized from fan-out lanes only', () => {
    expect(isEnsembleFanoutResultMessage(fanoutMessage())).toBe(true)
    expect(ensembleFanoutLaneIntent(fanoutMessage())).toBe('read')
    expect(
      isEnsembleFanoutResultMessage(
        fanoutMessage({ metadata: { kind: 'ensembleParticipant' } })
      )
    ).toBe(false)
    expect(isEnsembleFanoutResultMessage(fanoutMessage({ role: 'system' }))).toBe(false)
  })

  it('renders provider, role, intent, and a fixed viewport', () => {
    const html = renderToStaticMarkup(
      <EnsembleFanoutResultCard
        message={fanoutMessage()}
        onPreviewImage={() => {}}
      />
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
})
