import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatMessage } from '../../../main/store/types'
import type { ParallelResultViewportHeaderData } from '../lib/parallelResultViewportGroups'
import { ParallelResultViewportHeader } from './ParallelResultViewportHeader'

function viewportHeader(
  expanded = false,
  patch: Partial<ParallelResultViewportHeaderData> = {}
): ChatMessage {
  return {
    id: 'parallel-result-viewport-wave-1',
    role: 'system',
    content: `Sub-thread|${expanded ? 'expanded' : 'collapsed'}`,
    timestamp: '2026-08-02T12:00:00.000Z',
    metadata: {
      kind: 'parallelResultViewportHeader',
      parallelResultViewportHeader: {
        viewportId: 'parallel-result-viewport-wave-1',
        waveId: 'wave-1',
        chatId: 'chat-1',
        category: 'subThread',
        expanded,
        memberCount: 2,
        memberMessageIds: ['lane-message-1', 'lane-message-2'],
        attributions: [
          {
            subThreadId: 'sub-codex',
            provider: 'codex',
            title: 'Worker'
          },
          {
            subThreadId: 'sub-claude',
            provider: 'claude',
            title: 'Reviewer'
          }
        ],
        ...patch
      }
    }
  }
}

describe('ParallelResultViewportHeader', () => {
  it('renders a stage-less Sub-thread one-liner with provider accents', () => {
    const html = renderToStaticMarkup(
      <ParallelResultViewportHeader message={viewportHeader()} onSetExpanded={() => {}} />
    )

    expect(html).toContain('parallel-result-viewport-header')
    expect(html).toContain('Sub-thread')
    expect(html).not.toContain('Fan-Out')
    expect(html).not.toContain('Fan-out')
    expect(html).not.toContain('data-fanout-stage')
    expect(html).not.toContain('ensemble-fanout-viewport-stage')
    expect(html).not.toContain('Scout')
    expect(html).toContain('2 lanes')
    expect(html).toContain('Codex / Worker')
    expect(html).toContain('Claude / Reviewer')
    expect(html).toContain('provider-codex')
    expect(html).toContain('provider-claude')
    expect(html).toContain('data-provider-hue="codex"')
    expect(html).toContain('data-provider-hue="claude"')
    expect(html).toContain('ensemble-fanout-viewport-glyph')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Expand Sub-thread with 2 lanes')
  })

  it('keeps the disclosure open while its lane rows are materialized as siblings', () => {
    const html = renderToStaticMarkup(
      <ParallelResultViewportHeader message={viewportHeader(true)} onSetExpanded={() => {}} />
    )

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Collapse Sub-thread with 2 lanes')
    expect(html).toContain('collapsed-activity-stack is-expanded')
  })

  it('presents Side-chat meta labels without stage chrome', () => {
    const sideChat = renderToStaticMarkup(
      <ParallelResultViewportHeader
        message={viewportHeader(false, { category: 'sideChat' })}
        onSetExpanded={() => {}}
      />
    )
    expect(sideChat).toContain('Side-chat')
    expect(sideChat).toContain('Expand Side-chat with 2 lanes')
    expect(sideChat).not.toContain('data-fanout-stage')
  })

  it('uses singular lane copy when the wave has one member', () => {
    const html = renderToStaticMarkup(
      <ParallelResultViewportHeader
        message={viewportHeader(false, {
          memberCount: 1,
          memberMessageIds: ['lane-message-1'],
          attributions: [
            {
              subThreadId: 'sub-codex',
              provider: 'codex',
              title: 'Worker'
            }
          ]
        })}
        onSetExpanded={() => {}}
      />
    )

    expect(html).toContain('1 lane')
    expect(html).not.toContain('1 lanes')
    expect(html).toContain('Expand Sub-thread with 1 lane')
  })
})
