import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import { PI_MODEL_LABELS, PI_UPSTREAM_BRANDS } from '../../../shared/piBrandTable'
import { EnsembleFanoutResultCard } from './EnsembleFanoutResultCard'
import {
  ensembleFanoutLaneIntent,
  ensembleFanoutParticipantId,
  isEnsembleFanoutLaneWorking,
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

  it('themes each card with its own participant accent, not the pane accent', () => {
    const html = renderToStaticMarkup(
      <EnsembleFanoutResultCard message={fanoutMessage()} onPreviewImage={() => {}} />
    )

    // Codex participant → codex hue class + --accent pinned to the codex brand
    // token, so the card frame/badge paint codex regardless of the surrounding
    // transcript's provider tint.
    expect(html).toContain('ensemble-fanout-result-card provider-codex')
    expect(html).toContain('--accent:var(--provider-codex-color, var(--accent))')
  })

  it('spoofs the upstream brand accent for Ollama-backed participants', () => {
    const html = renderToStaticMarkup(
      <EnsembleFanoutResultCard
        message={fanoutMessage({
          metadata: {
            ...fanoutMessage().metadata,
            ensembleProvider: 'ollama',
            ensembleModel: 'qwen3.5:9b'
          }
        })}
        onPreviewImage={() => {}}
      />
    )

    // A Qwen model on Ollama paints Alibaba purple (matching the mention chips),
    // not generic Ollama green.
    expect(html).toContain('provider-alibaba')
    expect(html).toContain('--accent:var(--provider-alibaba-color, var(--accent))')
    expect(html).not.toContain('provider-ollama')
  })

  it('spoofs every Pi upstream accent on its fan-out viewport card', () => {
    for (const [upstream, brand] of Object.entries(PI_UPSTREAM_BRANDS)) {
      const model = Object.keys(PI_MODEL_LABELS).find((id) => id.startsWith(`${upstream}/`))
      expect(model, `missing representative Pi model for ${upstream}`).toBeTruthy()
      const html = renderToStaticMarkup(
        <EnsembleFanoutResultCard
          message={fanoutMessage({
            metadata: {
              ...fanoutMessage().metadata,
              ensembleProvider: 'pi',
              ensembleModel: model
            }
          })}
          onPreviewImage={() => {}}
        />
      )

      expect(html).toContain(`provider-${brand.hueClass}`)
      expect(html).toContain(`--accent:var(--provider-${brand.hueClass}-color, var(--accent))`)
      expect(html).not.toContain('provider-pi')
    }
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

  it('keeps huge collapsed fan-out markdown bounded and Markdown-rendered until expanded', () => {
    const hugeContent = `## CursorScout recon\n\n**Objective:** Verify Markdown preview.\n\n- Preserve viewport sizing\n\n${'x'.repeat(8_000)}\nUNRENDERED_FANOUT_TAIL`
    const message = fanoutMessage({ content: hugeContent })

    const collapsedHtml = renderToStaticMarkup(
      <EnsembleFanoutResultCard
        message={message}
        expanded={false}
        onExpandedChange={() => {}}
        onPreviewImage={() => {}}
      />
    )

    expect(collapsedHtml).toContain('Collapsed fan-out result preview')
    expect(collapsedHtml).toContain('Full lane output is rendered when expanded.')
    expect(collapsedHtml).toContain('<h2>CursorScout recon</h2>')
    expect(collapsedHtml).toContain('<strong>Objective:</strong> Verify Markdown preview.')
    expect(collapsedHtml).toContain('<li>Preserve viewport sizing</li>')
    expect(collapsedHtml).not.toContain('UNRENDERED_FANOUT_TAIL')

    const expandedHtml = renderToStaticMarkup(
      <EnsembleFanoutResultCard
        message={message}
        expanded
        onExpandedChange={() => {}}
        onPreviewImage={() => {}}
      />
    )

    expect(expandedHtml).toContain('UNRENDERED_FANOUT_TAIL')
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

describe('working-lane rim shimmer', () => {
  const WORKING = new Set(['reader-1'])

  it('marks the card as working so the rim can chase', () => {
    const html = renderToStaticMarkup(
      <EnsembleFanoutResultCard message={fanoutMessage()} working onPreviewImage={() => {}} />
    )
    expect(html).toContain('is-working')
    expect(html).toContain('data-lane-working="true"')
  })

  it('leaves a finished lane unmarked — the shimmer is the whole "still going" signal', () => {
    const html = renderToStaticMarkup(
      <EnsembleFanoutResultCard message={fanoutMessage()} onPreviewImage={() => {}} />
    )
    expect(html).not.toContain('is-working')
    expect(html).not.toContain('data-lane-working')
  })

  it('keeps the participant accent class alongside the working class', () => {
    // The chase colours itself from the card's --accent, so the hue class has
    // to survive the working state or a busy lane would chase the wrong colour.
    const html = renderToStaticMarkup(
      <EnsembleFanoutResultCard message={fanoutMessage()} working onPreviewImage={() => {}} />
    )
    expect(html).toContain('provider-codex')
    expect(html).toContain('is-working')
  })

  it('lights only the lanes whose seat is in the working set', () => {
    expect(isEnsembleFanoutLaneWorking(fanoutMessage(), WORKING)).toBe(true)
    const otherSeat = fanoutMessage({
      metadata: { ...fanoutMessage().metadata, ensembleParticipantId: 'writer-2' }
    })
    expect(isEnsembleFanoutLaneWorking(otherSeat, WORKING)).toBe(false)
  })

  it('treats an empty or absent working set as nobody working', () => {
    expect(isEnsembleFanoutLaneWorking(fanoutMessage(), new Set())).toBe(false)
    expect(isEnsembleFanoutLaneWorking(fanoutMessage(), null)).toBe(false)
    expect(isEnsembleFanoutLaneWorking(fanoutMessage(), undefined)).toBe(false)
  })

  it('does not light a card whose message predates the participant id', () => {
    // A null participant id must read as not-working rather than matching
    // whatever happens to be first in the set.
    const legacy = fanoutMessage({
      metadata: { ...fanoutMessage().metadata, ensembleParticipantId: undefined }
    })
    expect(ensembleFanoutParticipantId(legacy)).toBeNull()
    expect(isEnsembleFanoutLaneWorking(legacy, WORKING)).toBe(false)
  })

  it('ignores a blank participant id rather than matching on empty string', () => {
    const blank = fanoutMessage({
      metadata: { ...fanoutMessage().metadata, ensembleParticipantId: '   ' }
    })
    expect(ensembleFanoutParticipantId(blank)).toBeNull()
    expect(isEnsembleFanoutLaneWorking(blank, new Set(['   ']))).toBe(false)
  })
})
