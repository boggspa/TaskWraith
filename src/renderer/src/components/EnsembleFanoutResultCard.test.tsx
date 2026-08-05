import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import { PI_MODEL_LABELS, PI_UPSTREAM_BRANDS } from '../../../shared/piBrandTable'
import { EnsembleFanoutResultCard } from './EnsembleFanoutResultCard'
import {
  ensembleFanoutLaneIntent,
  ensembleFanoutParticipantId,
  fanoutActivityPartExpansionId,
  isEnsembleFanoutLaneWorking,
  isEnsembleFanoutResultMessage,
  readEnsembleFanoutTranscriptParts,
  shouldCollapseFanoutActivityPart
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
            ensembleModel: 'qwen3.5:9b',
            ensembleSeatSnapshot: {
              schemaVersion: 1,
              provider: 'ollama',
              model: 'qwen3.5:9b',
              configuredPermissionPresetId: 'default'
            }
          }
        })}
        onPreviewImage={() => {}}
      />
    )

    // A Qwen model on Ollama paints Alibaba purple (matching the mention chips),
    // not generic Ollama green. The card accent, the chip hue and the PROVIDER
    // LABEL are all the upstream brand — those are the overrides that carry the
    // identity, and they are what this pins.
    expect(html).toContain('provider-alibaba')
    expect(html).toContain('--accent:var(--provider-alibaba-color, var(--accent))')
    expect(html).toContain('data-provider-hue="alibaba"')
    expect(html).toContain('>Alibaba<')
    // The generic Ollama HUE must never win.
    expect(html).not.toContain('provider-ollama-color')
    // The serving provider's LOGO may appear (owner call 2026-08-05): the seat
    // element draws it beside the upstream label, so a lane reads as "Alibaba's
    // Qwen, served via Ollama". Close-out and the seat-change row already do
    // this; fan-out matches them rather than hiding the mark.
    expect(html).toContain('provider-brand-logo-ollama')
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
              ensembleModel: model,
              ensembleSeatSnapshot: {
                schemaVersion: 1,
                provider: 'pi',
                model,
                configuredPermissionPresetId: 'default'
              }
            }
          })}
          onPreviewImage={() => {}}
        />
      )

      expect(html).toContain(`provider-${brand.hueClass}`)
      expect(html).toContain(`--accent:var(--provider-${brand.hueClass}-color, var(--accent))`)
      expect(html).toContain(`data-provider-hue="${brand.hueClass}"`)
      // The upstream hue wins; the raw Pi hue never does. The Pi logo itself is
      // allowed beside the upstream label (see the Ollama case above).
      expect(html).not.toContain('provider-pi-color')
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

  it('collapses settled grouped fan-out tools to a re-expandable one-liner', () => {
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
    expect(html).toContain('ensemble-fanout-result-tools')
    expect(html).toContain('collapsed-activity-stack-summary')
    expect(html).toContain('aria-label="Expand 1 activity step: Read ×1"')
    expect(html).not.toContain('activity-timeline')
    expect(html).not.toContain('Read file')
    expect(html).toContain('First note.')
    expect(html).toContain('Second note.')

    const expandedHtml = renderToStaticMarkup(
      <EnsembleFanoutResultCard
        message={message}
        expandedActivityIds={new Set([fanoutActivityPartExpansionId('tool-1')])}
        onExpandedActivityIdsChange={() => {}}
        onPreviewImage={() => {}}
      />
    )
    expect(expandedHtml).toContain('aria-label="Collapse 1 activity step: Read ×1"')
    expect(expandedHtml).toContain('ensemble-fanout-tools-viewport')
    expect(expandedHtml).toContain('Expand tool calls')
    expect(expandedHtml).toContain('activity-timeline')
    expect(expandedHtml).toContain('Read file')
  })

  it('folds completed history while keeping the current fan-out activity visible', () => {
    const completed = toolActivity({
      id: 'completed-read',
      displayName: 'Completed historical read',
      status: 'success'
    })
    const current = toolActivity({
      id: 'current-shell',
      toolName: 'shell',
      displayName: 'Current live command',
      category: 'shell',
      status: 'running'
    })
    const message = fanoutMessage({
      content: '',
      toolActivities: [completed, current],
      metadata: {
        ...fanoutMessage().metadata,
        groupedFanoutMessageIds: ['old-tools', 'checkpoint', 'live-tools'],
        groupedToolMessageIds: ['old-tools', 'live-tools'],
        ensembleFanoutTranscriptParts: [
          {
            kind: 'tools',
            id: 'old-tools',
            messageIds: ['old-tools'],
            toolActivities: [completed]
          },
          {
            kind: 'content',
            id: 'checkpoint',
            messageIds: ['checkpoint'],
            content: 'Checkpoint reached.'
          },
          {
            kind: 'tools',
            id: 'live-tools',
            messageIds: ['live-tools'],
            toolActivities: [current]
          }
        ]
      }
    })

    const html = renderToStaticMarkup(
      <EnsembleFanoutResultCard message={message} working onPreviewImage={() => {}} />
    )

    expect(html).toContain('aria-label="Expand 1 activity step: Read ×1"')
    expect(html).not.toContain('Completed historical read')
    expect(html).toContain('Current live command')
    expect(html).toContain('Checkpoint reached.')
  })

  it('never folds running work, even if the lane-working signal has already cleared', () => {
    expect(
      shouldCollapseFanoutActivityPart({
        activities: [toolActivity({ status: 'running' })],
        isLatestPart: true,
        laneWorking: false
      })
    ).toBe(false)
    expect(
      shouldCollapseFanoutActivityPart({
        activities: [toolActivity({ status: 'success' })],
        isLatestPart: true,
        laneWorking: false
      })
    ).toBe(true)
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

describe('EnsembleFanoutResultCard — the lane wears the seat element', () => {
  const SNAPSHOT = {
    schemaVersion: 1,
    provider: 'claude',
    model: 'claude-opus-5',
    reasoningEffort: 'xhigh',
    configuredPermissionPresetId: 'read_only'
  }

  const render = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(
      <EnsembleFanoutResultCard
        message={fanoutMessage({ metadata: { ...fanoutMessage().metadata, ...extra } })}
        onPreviewImage={() => {}}
      />
    )

  it('renders the shared seat chips instead of the old segmented pills', () => {
    const html = render({ ensembleSeatSnapshot: SNAPSHOT })
    expect(html).toContain('seat-state-chips')
    expect(html).not.toContain('ensemble-fanout-result-model')
  })

  it('shows the permission tier the lane ACTUALLY ran under', () => {
    // The flat metadata cannot carry this; without the snapshot the chip would
    // fall back to the default tier and misreport a read-only lane.
    expect(render({ ensembleSeatSnapshot: SNAPSHOT })).toContain('Ask')
  })

  it('KEEPS #N — a fan-out lane sits in the reader’s own roster', () => {
    // Deliberately opposite to the peer thread-message card, where the sender
    // belongs to a roster the reader is not in and a seat number is unreadable.
    expect(render({ ensembleSeatSnapshot: SNAPSHOT })).toContain('#2 Reader')
  })

  it('still wears the seat element with no snapshot — minus the permission chip', () => {
    // This used to assert the opposite, and the reason was sound at the time:
    // the element resolved an absent preset to 'default', so a pre-snapshot row
    // would have claimed "Accept Edits" for a lane that may have run read-only.
    //
    // But the snapshot only began being written when the lane card moved onto
    // the seat element, so the fallback swallowed nearly every row already on
    // disk — measured on a real chat, 1734 of 1741 lane rows, across EVERY
    // provider. The element now omits the tier when it is unknown, so the
    // honest answer and the consistent one are the same answer.
    const html = render({ ensembleSeatSnapshot: undefined })
    expect(html).toContain('seat-state-chips')
    expect(html).not.toContain('ensemble-fanout-result-model')
    // The claim we cannot make is still not made.
    expect(html).not.toContain('Accept Edits')
    expect(html).not.toContain('data-permission-value')
  })
})

describe('EnsembleFanoutResultCard — authority glyph', () => {
  const SNAP = {
    schemaVersion: 1,
    provider: 'claude',
    model: 'claude-opus-5',
    configuredPermissionPresetId: 'default'
  }
  const render = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(
      <EnsembleFanoutResultCard
        message={fanoutMessage({ metadata: { ...fanoutMessage().metadata, ...extra } })}
        onPreviewImage={() => {}}
      />
    )

  it('titles a Boss lane as Boss, not by its stage role', () => {
    // Authority outranks stage, matching the composer chips: a Boss who is also
    // a Worker reads as the Boss rather than wearing both marks.
    const html = render({
      ensembleSeatSnapshot: SNAP,
      ensembleSeatAuthority: 'boss',
      ensembleStageRole: 'worker'
    })
    expect(html).toContain('Boss · #2 Reader')
  })

  it('falls back to the stage role when the lane holds no authority', () => {
    expect(render({ ensembleSeatSnapshot: SNAP, ensembleStageRole: 'worker' })).toContain(
      'Worker · #2 Reader'
    )
  })
})
