import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import type { BlackboardChangePayload } from '../../../shared/blackboardChange'
import { BlackboardChangeRow } from './BlackboardChangeRow'

const rowSource = readFileSync(new URL('./BlackboardChangeRow.tsx', import.meta.url), 'utf8')
const composerSource = readFileSync(
  new URL('./ComposerBlackboardButton.tsx', import.meta.url),
  'utf8'
)
const panelSource = readFileSync(new URL('./TranscriptPanel.tsx', import.meta.url), 'utf8')
const cssSource = readFileSync(
  new URL('../assets/css/41-blackboard-transcript.css', import.meta.url),
  'utf8'
)

function messageWithChange(
  action: 'updated' | 'pollOpened' | 'cleaned' | 'scoutBriefShared'
): ChatMessage {
  const common = {
    action,
    provider: 'ollama',
    displayProviderLabel: 'Alibaba',
    displayHueClass: 'alibaba',
    changedAt: '2026-08-27T12:40:00.000Z'
  }
  return {
    id: `blackboard-${action}`,
    role: 'system',
    content: 'Blackboard fallback.',
    timestamp: '2026-08-27T12:40:00.000Z',
    metadata: {
      kind: 'ensembleBlackboardChange',
      ensembleParticipantId: 'scout-5',
      blackboardChange:
        action === 'cleaned'
          ? { ...common, action, removedCount: 2 }
          : action === 'scoutBriefShared'
            ? { ...common, action, role: 'Competitive scout' }
            : action === 'pollOpened'
              ? {
                  ...common,
                  action,
                  key: 'ship-or-hold',
                  category: 'decision',
                  scope: 'round',
                  optionCount: 3
                }
              : {
                  ...common,
                  action,
                  key: 'scout5-competitor-research',
                  category: 'note',
                  scope: 'session'
                }
    }
  }
}

describe('BlackboardChangeRow', () => {
  it('renders the existing Blackboard glyph with upstream-provider accent and no seat label', () => {
    const html = renderToStaticMarkup(
      createElement(BlackboardChangeRow, { message: messageWithChange('updated') })
    )

    expect(html).toContain('Blackboard updated')
    expect(html).toContain('scout5-competitor-research')
    expect(html).toContain('blackboard-glyph')
    expect(html).toContain('--accent:var(--provider-alibaba-color, var(--accent))')
    expect(html).toContain('aria-label="Blackboard updated by Alibaba: note /')
    expect(html).not.toContain('scout-5')
    expect(html).not.toContain('Competitive scout')
  })

  it.each([
    ['pollOpened', 'Blackboard poll opened', '3 choices'],
    ['cleaned', 'Blackboard cleaned', '2 entries removed']
  ] as const)('renders the %s mutation vocabulary', (action, label, detail) => {
    const html = renderToStaticMarkup(
      createElement(BlackboardChangeRow, { message: messageWithChange(action) })
    )
    expect(html).toContain(label)
    expect(html).toContain(detail)
  })

  it('rejects malformed metadata so the plain system fallback remains available', () => {
    const message = messageWithChange('updated')
    if (message.metadata) {
      message.metadata.blackboardChange = {
        ...(message.metadata.blackboardChange as unknown as Record<string, unknown>),
        displayHueClass: 'bad); color: red'
      } as unknown as BlackboardChangePayload
    }
    expect(renderToStaticMarkup(createElement(BlackboardChangeRow, { message }))).toBe('')
  })

  it('renders Scout briefs as expandable Blackboard + next-writer handoffs', () => {
    const html = renderToStaticMarkup(
      createElement(BlackboardChangeRow, { message: messageWithChange('scoutBriefShared') })
    )

    expect(html).toContain('Scout brief shared')
    expect(html).toContain('Competitive scout')
    expect(html).toContain('(Alibaba)')
    expect(html).toContain('Blackboard + next writer')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('confidence high')
    expect(rowSource).toContain('blackboard-scout-brief-explanation')
    expect(rowSource).toContain('later briefs update this entry')
  })

  it('shows confidence only as an exceptional medium/low caveat', () => {
    const message = messageWithChange('scoutBriefShared')
    if (message.metadata?.blackboardChange?.action === 'scoutBriefShared') {
      message.metadata.blackboardChange.confidence = 'low'
    }
    const html = renderToStaticMarkup(createElement(BlackboardChangeRow, { message }))
    expect(html).toContain('Needs verification')
    expect(html).not.toContain('confidence low')
  })

  it('reuses the seat/handoff event hierarchy while keeping Blackboard-specific tool styling', () => {
    expect(rowSource).toContain('seat-change-message blackboard-change-message')
    expect(rowSource).toContain('seat-change-row blackboard-change-row')
    expect(rowSource).toContain('<BlackboardGlyph />')
    expect(composerSource).toContain("import { BlackboardGlyph } from './icons/BlackboardGlyph'")
    expect(composerSource).toContain('<BlackboardGlyph />')
    expect(cssSource).toContain('.blackboard-change-icon {')
    expect(cssSource).toContain('color-mix(in srgb, var(--accent)')
    expect(cssSource).toContain('.blackboard-scout-brief-explanation {')
  })
})

describe('TranscriptPanel Blackboard event wiring', () => {
  it('keeps valid Blackboard events out of system-notice collapse', () => {
    const plainStart = panelSource.indexOf('function plainSystemNoticeMessage(')
    const plainEnd = panelSource.indexOf('function superGroupParticipantKey(', plainStart)
    expect(plainStart).toBeGreaterThanOrEqual(0)
    expect(panelSource.slice(plainStart, plainEnd)).toContain(
      '!isBlackboardChangePayload(msg.metadata?.blackboardChange) &&'
    )
  })

  it('dispatches the dedicated row before the system auto-collapse branch', () => {
    const dispatch = panelSource.indexOf('isBlackboardChange ? (')
    const collapse = panelSource.indexOf('systemAutoCollapsible ? (', dispatch)
    expect(dispatch).toBeGreaterThanOrEqual(0)
    expect(collapse).toBeGreaterThan(dispatch)
    expect(panelSource.slice(dispatch, collapse)).toContain('<BlackboardChangeRow')
  })
})
