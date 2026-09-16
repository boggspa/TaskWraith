import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { findClickableByClassName } from '../test/reactElementTree'
import {
  isSubThreadReturnMessage,
  linkedChildReturnMetaLabel,
  linkedChildReturnRelation,
  subThreadReturnBody
} from './SubThreadReturnCardModel'
import { SubThreadReturnCard } from './SubThreadReturnCard'

function subThreadMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    role: 'tool',
    content: '↩ Result from Codex sub-thread (Build agent):\n\n**Done**\n\n- Tests passed',
    timestamp: '2026-05-16T12:00:00Z',
    metadata: {
      kind: 'subThreadReturn',
      subThreadId: 'chat-child-1',
      subThreadProvider: 'codex',
      subThreadTitle: 'Build agent'
    },
    ...overrides
  }
}

const SEAT = {
  provider: 'codex',
  model: 'gpt-5.3-codex',
  role: 'Builder',
  reasoningEffort: 'high',
  permissionPresetId: 'workspace_write'
}

describe('SubThreadReturnCard', () => {
  it('detects sub-thread return tool messages', () => {
    expect(isSubThreadReturnMessage(subThreadMessage())).toBe(true)
    expect(isSubThreadReturnMessage(subThreadMessage({ role: 'system' }))).toBe(true)
    expect(isSubThreadReturnMessage(subThreadMessage({ role: 'assistant' }))).toBe(false)
    expect(isSubThreadReturnMessage(subThreadMessage({ metadata: { kind: 'other' } }))).toBe(false)
  })

  it('strips the synthetic transcript prefix and untrusted payload wrapper from the markdown body', () => {
    expect(subThreadReturnBody(subThreadMessage().content)).toBe('**Done**\n\n- Tests passed')
    expect(
      subThreadReturnBody(
        'Sub-thread result payload (untrusted child-agent output):\n\n<subthread_result>\n**Done**\n</subthread_result>'
      )
    ).toBe('**Done**')
    expect(subThreadReturnBody('plain body')).toBe('plain body')
    expect(
      subThreadReturnBody(
        'Side-chat result payload:\n\n<side_chat_result>\n**Async done**\n</side_chat_result>'
      )
    ).toBe('**Async done**')
  })

  it('names the short meta label from the linked-child relation', () => {
    expect(linkedChildReturnMetaLabel(subThreadMessage())).toBe('Sub-thread')
    expect(
      linkedChildReturnMetaLabel(
        subThreadMessage({
          metadata: {
            kind: 'subThreadReturn',
            linkedChildRelation: 'sideChat'
          }
        })
      )
    ).toBe('Side-chat')
  })

  it('renders opted-in side-chat returns with Fan-Out-style short meta', () => {
    const message = subThreadMessage({
      content: '<side_chat_result>\nAsync finding.\n</side_chat_result>',
      metadata: {
        kind: 'subThreadReturn',
        subThreadId: 'side-chat-1',
        subThreadProvider: 'codex',
        subThreadTitle: 'Async design room',
        linkedChildRelation: 'sideChat'
      }
    })
    const html = renderToStaticMarkup(
      <SubThreadReturnCard message={message} onOpenSubThreadInSidePanel={() => {}} />
    )

    expect(linkedChildReturnRelation(message)).toBe('sideChat')
    expect(linkedChildReturnMetaLabel(message)).toBe('Side-chat')
    expect(html).toContain('>Side-chat<')
    expect(html).not.toContain('Side-chat result from')
    expect(html).not.toContain('Invocation result from')
    expect(html).toContain('Async design room')
    expect(html).toContain('aria-label="Side-chat result"')
    expect(html).toContain('title="Open this side chat"')
  })

  it('renders Fan-Out-style short meta, provider-hue accent, title, markdown body, and one side-chat control', () => {
    const html = renderToStaticMarkup(
      <SubThreadReturnCard
        message={subThreadMessage()}
        onOpenSubThread={() => {}}
        onOpenSubThreadInSidePanel={() => {}}
      />
    )

    expect(html).toContain('subthread-return-card provider-codex')
    expect(html).toContain('--accent:var(--provider-codex-color, var(--accent))')
    expect(html).toContain('>Sub-thread<')
    expect(html).not.toContain('Invocation result from')
    expect(html).not.toContain('Side-chat result from')
    expect(html).not.toContain('TaskWraith Sub-thread')
    expect(html).toContain('Codex')
    expect(html).toContain('provider-satellite-label provider-codex')
    expect(html).toContain('data-provider-logo="codex"')
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).not.toContain('provider-glyph-codex')
    expect(html).toContain('Build agent')
    expect(html).toContain('live-activity-viewport')
    expect(html).toContain('subthread-return-viewport')
    expect(html).toContain('Expand result')
    expect(html).toContain('<strong>Done</strong>')
    expect(html).toContain('Side chat')
    expect(html).not.toContain('Open beside')
    expect(html).not.toContain('Open drawer')
    expect(html).not.toContain('Open sub-thread')
  })

  it('renders seat-first heading when a sub-thread seat snapshot is present', () => {
    const html = renderToStaticMarkup(
      <SubThreadReturnCard
        message={subThreadMessage({
          metadata: {
            kind: 'subThreadReturn',
            subThreadId: 'chat-child-1',
            subThreadProvider: 'codex',
            subThreadTitle: 'Build agent',
            subThreadSeat: SEAT
          }
        })}
      />
    )

    const labelIdx = html.indexOf('>Sub-thread<')
    const seatRoleIdx = html.indexOf('subthread-return-seat-role')
    // Class token is `subthread-return-seat` (not the longer seat-role class).
    const seatChipsIdx = html.search(/\bsubthread-return-seat\b(?!-)/)
    const titleIdx = html.indexOf('>Build agent<')
    const agentIdx = html.indexOf('subthread-return-agent')

    expect(labelIdx).toBeGreaterThan(-1)
    expect(seatRoleIdx).toBeGreaterThan(labelIdx)
    expect(seatChipsIdx).toBeGreaterThan(seatRoleIdx)
    expect(titleIdx).toBeGreaterThan(seatChipsIdx)
    expect(agentIdx).toBeGreaterThan(titleIdx)
    expect(html).toContain('seat-state-chips')
    expect(html).toContain('Builder')
    expect(html).not.toContain('provider-satellite-label')
    expect(html).not.toContain('Invocation result from')
    // Agent identity stays as icon+name, not segmented pill chrome.
    expect(html).toContain('subthread-return-agent-icon')
    expect(html).not.toContain('segmented-control-action')
  })

  it('renders the return viewport with controlled expanded copy', () => {
    const html = renderToStaticMarkup(
      <SubThreadReturnCard
        message={subThreadMessage()}
        resultExpanded
        onResultExpandedChange={() => {}}
      />
    )

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Collapse result')
  })

  it('keeps huge collapsed return bodies bounded and Markdown-rendered until expanded', () => {
    const hugeBody = `## GrokScout result\n\n**Objective:** Verify Markdown preview.\n\n- Preserve viewport sizing\n\n${'x'.repeat(8_000)}\nUNRENDERED_TAIL`
    const collapsedHtml = renderToStaticMarkup(
      <SubThreadReturnCard
        message={subThreadMessage({
          content: `↩ Result from Codex sub-thread (Build agent):\n\n${hugeBody}`
        })}
        resultExpanded={false}
        onResultExpandedChange={() => {}}
      />
    )

    expect(collapsedHtml).toContain('Collapsed sub-thread result preview')
    expect(collapsedHtml).toContain('Full result is rendered when expanded.')
    expect(collapsedHtml).toContain('<h2>GrokScout result</h2>')
    expect(collapsedHtml).toContain('<strong>Objective:</strong> Verify Markdown preview.')
    expect(collapsedHtml).toContain('<li>Preserve viewport sizing</li>')
    expect(collapsedHtml).not.toContain('UNRENDERED_TAIL')

    const expandedHtml = renderToStaticMarkup(
      <SubThreadReturnCard
        message={subThreadMessage({
          content: `↩ Result from Codex sub-thread (Build agent):\n\n${hugeBody}`
        })}
        resultExpanded
        onResultExpandedChange={() => {}}
      />
    )

    expect(expandedHtml).toContain('UNRENDERED_TAIL')
  })

  it('renders transcript message actions when handlers are provided', () => {
    const html = renderToStaticMarkup(
      <SubThreadReturnCard
        message={subThreadMessage()}
        onCopyMessage={() => {}}
        onAddMessageToPrompt={() => {}}
        onTogglePinMessage={() => {}}
        onDeleteMessage={() => {}}
        onOpenSideChatFromMessage={() => {}}
        pinned
        copied
      />
    )

    expect(html).toContain('Actions for sub-thread result')
    expect(html).toContain('message-actions-chip-button--copy')
    expect(html).toContain('message-actions-chip-button--add-to-prompt')
    expect(html).toContain('message-actions-chip-button--pin is-pinned')
    expect(html).toContain('message-actions-chip-button--side-chat')
    expect(html).toContain('message-actions-chip-button--delete')
  })

  it('routes the side-chat action through the side-panel callback', () => {
    const onOpenSubThreadInSidePanel = vi.fn()
    const tree = SubThreadReturnCard({
      message: subThreadMessage(),
      onOpenSubThread: () => {},
      onOpenSubThreadInSidePanel
    })

    findClickableByClassName(tree, 'subthread-side-chat-button').props.onClick?.()

    expect(onOpenSubThreadInSidePanel).toHaveBeenCalledWith('chat-child-1')
  })

  it('discloses parent-run activities a pre-fix reducer collapsed onto the card', () => {
    // Records damaged before the soloToolEventReducer card-adoption guard
    // carry the parent run's burst inside the return card's toolActivities.
    // Those stay invisible unless the card itself renders them.
    const html = renderToStaticMarkup(
      <SubThreadReturnCard
        message={subThreadMessage({
          toolActivities: [
            {
              id: 'seg-38',
              toolName: 'kimi_thinking',
              displayName: 'Kimi thinking',
              status: 'success'
            } as any,
            {
              id: 'commit-1',
              toolName: 'git_commit',
              displayName: 'Git commit',
              status: 'success'
            } as any
          ]
        })}
      />
    )

    expect(html).toContain('subthread-return-recovered-activity')
    expect(html).toContain('Git commit')
  })

  it('renders no recovered-activity section on a clean return card', () => {
    const html = renderToStaticMarkup(<SubThreadReturnCard message={subThreadMessage()} />)

    expect(html).not.toContain('subthread-return-recovered-activity')
  })
})

describe('SubThreadReturnCard under a filtering transcript view', () => {
  // This body is the child's final assistant message, relayed verbatim by main.
  // Minimal keeps assistant messages, so it keeps this — what it drops is the
  // expand/collapse chrome, because nothing on a Minimal row is expandable.

  const BODY_MARKER = 'CHILD-ANSWER-MARKER'
  const withBody = (body: string) =>
    subThreadMessage({ content: `↩ Result from Codex sub-thread (Build agent):\n\n${body}` })

  it('keeps the relayed body under every view', () => {
    // If this ever stopped holding, the chrome assertions below would be
    // vacuous: they would pass on a card that rendered nothing at all.
    for (const view of ['minimal', 'tools', 'standard'] as const) {
      const html = renderToStaticMarkup(
        <SubThreadReturnCard message={withBody(BODY_MARKER)} transcriptView={view} />
      )
      expect(html, view).toContain(BODY_MARKER)
    }
  })

  it('drops the expander under minimal, and keeps it under tools and standard', () => {
    const minimal = renderToStaticMarkup(
      <SubThreadReturnCard
        message={withBody(BODY_MARKER)}
        transcriptView="minimal"
        resultExpanded={false}
        onResultExpandedChange={() => {}}
      />
    )
    // A COLLAPSED viewport would not do: LiveActivityViewport always renders
    // its children and merely clamps them with a CSS max-height, so the
    // expander would still be there and still be pressable. The element has to
    // go.
    expect(minimal).not.toContain('Expand result')
    expect(minimal).not.toContain('Collapse result')
    expect(minimal).not.toContain('subthread-return-viewport')
    expect(minimal).not.toContain('aria-expanded')

    for (const view of ['tools', 'standard'] as const) {
      const html = renderToStaticMarkup(
        <SubThreadReturnCard
          message={withBody(BODY_MARKER)}
          transcriptView={view}
          resultExpanded={false}
          onResultExpandedChange={() => {}}
        />
      )
      // The positive control that makes all four negatives above meaningful.
      expect(html, view).toContain('Expand result')
      expect(html, view).toContain('subthread-return-viewport')
    }
  })

  it('renders a huge body in full under minimal rather than a preview with no way out', () => {
    // The truncated preview ends in "Full result is rendered when expanded." —
    // which, with the expander gone, would be a dead end the reader could never
    // get past. Minimal shows the whole thing instead.
    const huge = `${'x'.repeat(8_000)}\nUNREACHABLE_TAIL_MARKER`
    const minimal = renderToStaticMarkup(
      <SubThreadReturnCard
        message={withBody(huge)}
        transcriptView="minimal"
        resultExpanded={false}
        onResultExpandedChange={() => {}}
      />
    )
    expect(minimal).toContain('UNREACHABLE_TAIL_MARKER')
    expect(minimal).not.toContain('Full result is rendered when expanded.')

    // Positive control: the same body under standard DOES truncate, so the
    // assertions above are about the view and not about the fixture.
    const standard = renderToStaticMarkup(
      <SubThreadReturnCard
        message={withBody(huge)}
        transcriptView="standard"
        resultExpanded={false}
        onResultExpandedChange={() => {}}
      />
    )
    expect(standard).not.toContain('UNREACHABLE_TAIL_MARKER')
    expect(standard).toContain('Full result is rendered when expanded.')
  })

  it('keeps a failed child run visible under minimal', () => {
    // A child's failure is appended INTO this body by LinkedChildReturn rather
    // than carried as an activity status, so `activityStackHasFailure` cannot
    // see it. Hiding the body would hide the failure, which no view may do.
    const html = renderToStaticMarkup(
      <SubThreadReturnCard
        message={withBody('Sub-thread failed before returning a result.')}
        transcriptView="minimal"
      />
    )
    expect(html).toContain('Sub-thread failed before returning a result.')
  })

  it('keeps the unwrapped body indented like the wrapped one', () => {
    // The 12px inset lives on `.subthread-return-viewport`, which Minimal does
    // not render, so without a rule for the bare case the text sits flush
    // against the card edge. The child combinator is load-bearing: it must
    // match ONLY the unwrapped body, or the wrapped one gets a double indent.
    const css = readFileSync(join(__dirname, '../assets/css/02-transcript-messages-fx.css'), 'utf8')
    // The trailing ` {` is load-bearing: without it the selector is a PREFIX of
    // any longer class name, so renaming the rule to `...-innerX` would still
    // match and the guard would pass on a stylesheet that no longer styles
    // anything. (It did, until this was tightened.)
    const selector = '.subthread-return-body > .subthread-return-body-inner {'
    const at = css.indexOf(selector)
    // `slice(indexOf(x))` on a missing needle is slice(-1) — the last
    // character, never '' — so the index must be asserted directly or this
    // guard cannot fail.
    expect(at).toBeGreaterThan(-1)
    expect(css.slice(at, at + 200)).toContain('padding-left: 12px')
    // The rule it mirrors must still be the one carrying the inset.
    const viewportAt = css.indexOf('.subthread-return-viewport {')
    expect(viewportAt).toBeGreaterThan(-1)
    expect(css.slice(viewportAt, viewportAt + 200)).toContain('padding-left: 12px')
  })

  it('renders the same body whether or not a viewport wraps it', () => {
    // The two branches must differ only in chrome. Stripping the viewport
    // markup from the standard render should leave the minimal one.
    const body = '## Heading\n\n- item one\n- item two'
    const minimal = renderToStaticMarkup(
      <SubThreadReturnCard message={withBody(body)} transcriptView="minimal" />
    )
    const standard = renderToStaticMarkup(
      <SubThreadReturnCard message={withBody(body)} transcriptView="standard" />
    )
    const inner = /<div class="subthread-return-body-inner">[\s\S]*?<\/div><\/div>/
    const fromMinimal = minimal.match(inner)?.[0]
    const fromStandard = standard.match(inner)?.[0]
    expect(fromMinimal).toBeTruthy()
    expect(fromStandard).toBeTruthy()
    expect(fromMinimal).toBe(fromStandard)
  })
})
