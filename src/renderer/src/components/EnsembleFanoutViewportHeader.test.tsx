import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatMessage } from '../../../main/store/types'
import { EnsembleFanoutViewportHeader } from './EnsembleFanoutViewportHeader'

function viewportHeader(expanded = false): ChatMessage {
  return {
    id: 'ensemble-fanout-viewport-round-1-dispatch-1',
    role: 'system',
    content: `Fan-out viewport|scout|${expanded ? 'expanded' : 'collapsed'}`,
    timestamp: '2026-08-02T12:00:00.000Z',
    metadata: {
      kind: 'ensembleFanoutViewportHeader',
      ensembleRoundId: 'round-1',
      ensembleFanoutViewportHeader: {
        viewportId: 'ensemble-fanout-viewport-round-1-dispatch-1',
        chatId: 'chat-1',
        roundId: 'round-1',
        stage: 'scout',
        dispatchLabel: 'Scout fan-out',
        expanded,
        laneCount: 2,
        laneMessageIds: ['lane-message-1', 'lane-message-2'],
        attributions: [
          {
            participantId: 'pi-mistral',
            provider: 'pi',
            role: 'Scout',
            model: 'mistral/devstral-2512'
          },
          {
            participantId: 'ollama-qwen',
            provider: 'ollama',
            role: 'Builder',
            model: 'qwen3.5:9b'
          }
        ]
      }
    }
  }
}

describe('EnsembleFanoutViewportHeader', () => {
  it('renders a stage-aware one-liner with upstream-brand provider accents', () => {
    const html = renderToStaticMarkup(
      <EnsembleFanoutViewportHeader message={viewportHeader()} onSetExpanded={() => {}} />
    )

    expect(html).toContain('Fan-out viewport')
    expect(html).toContain('Scout')
    expect(html).toContain('2 lanes')
    expect(html).toContain('Mistral / Scout')
    expect(html).toContain('Alibaba / Builder')
    expect(html).toContain('provider-mistral')
    expect(html).toContain('provider-alibaba')
    expect(html).toContain('data-provider-hue="mistral"')
    expect(html).toContain('data-provider-hue="alibaba"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Expand Scout fan-out viewport with 2 lanes')
  })

  it('keeps the disclosure open while its lane rows are materialized as siblings', () => {
    const html = renderToStaticMarkup(
      <EnsembleFanoutViewportHeader message={viewportHeader(true)} onSetExpanded={() => {}} />
    )

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Collapse Scout fan-out viewport with 2 lanes')
    expect(html).toContain('collapsed-activity-stack is-expanded')
  })
})
