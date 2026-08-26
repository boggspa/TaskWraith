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
