import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatMessage } from '../../../main/store/types'
import type { EnsembleFanoutViewportHeaderData } from '../lib/ensembleFanoutViewportGroups'
import { EnsembleFanoutViewportHeader } from './EnsembleFanoutViewportHeader'

function viewportHeader(
  expanded = false,
  patch: Partial<EnsembleFanoutViewportHeaderData> = {}
): ChatMessage {
  return {
    id: 'ensemble-fanout-viewport-round-1-dispatch-1',
    role: 'system',
    content: `Fan-Out|scout|${expanded ? 'expanded' : 'collapsed'}`,
    timestamp: '2026-08-02T12:00:00.000Z',
    metadata: {
      kind: 'ensembleFanoutViewportHeader',
      ensembleRoundId: 'round-1',
      ensembleFanoutViewportHeader: {
        viewportId: 'ensemble-fanout-viewport-round-1-dispatch-1',
        waveId: 'dispatch-1',
        chatId: 'chat-1',
        roundId: 'round-1',
        stage: 'scout',
        category: 'orchestrated',
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
        ],
        ...patch
      }
    }
  }
}

describe('EnsembleFanoutViewportHeader', () => {
  it('renders a stage-aware one-liner with upstream-brand provider accents', () => {
    const html = renderToStaticMarkup(
      <EnsembleFanoutViewportHeader message={viewportHeader()} onSetExpanded={() => {}} />
    )

    expect(html).toContain('Fan-Out')
    expect(html).not.toContain('Fan-out viewport')
    expect(html).toContain('Scout')
    expect(html).toContain('2 lanes')
    expect(html).toContain('Mistral / Scout')
    expect(html).toContain('Alibaba / Builder')
    expect(html).toContain('provider-mistral')
    expect(html).toContain('provider-alibaba')
    expect(html).toContain('data-provider-hue="mistral"')
    expect(html).toContain('data-provider-hue="alibaba"')
    expect(html).toContain('ensemble-fanout-viewport-glyph')
    expect(html).toContain('class="ensemble-fanout-viewport-glyph" aria-hidden="true"')
    expect(html).toContain('class="ensemble-fanout-viewport-glyph-icon"')
    expect(html).toContain('d="M12 9.5V4.2"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Expand Scout fan-out with 2 lanes')
  })

  it('keeps the disclosure open while its lane rows are materialized as siblings', () => {
    const html = renderToStaticMarkup(
      <EnsembleFanoutViewportHeader message={viewportHeader(true)} onSetExpanded={() => {}} />
    )

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Collapse Scout fan-out with 2 lanes')
    expect(html).toContain('collapsed-activity-stack is-expanded')
  })

  it('presents a user-directed wave as User Fan-Out instead of Specified fan-out', () => {
    const html = renderToStaticMarkup(
      <EnsembleFanoutViewportHeader
        message={viewportHeader(false, {
          stage: 'specified',
          category: 'user',
          dispatchLabel: 'User Fan-Out'
        })}
        onSetExpanded={() => {}}
      />
    )

    expect(html).toContain('data-fanout-category="user"')
    expect(html).toContain('User Fan-Out')
    expect(html).not.toContain('Specified')
    expect(html).toContain('Expand User Fan-Out with 2 lanes')
  })
})
