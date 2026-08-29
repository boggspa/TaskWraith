import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import type { EnsembleAuthorityRole } from '../../../shared/ensembleAuthority'
import { ContinuationHopsChangeRow } from './ContinuationHopsChangeRow'

const rowSource = readFileSync(new URL('./ContinuationHopsChangeRow.tsx', import.meta.url), 'utf8')
const panelSource = readFileSync(new URL('./TranscriptPanel.tsx', import.meta.url), 'utf8')
const cssSource = readFileSync(
  new URL('../assets/css/08-theme-picker-overrides.css', import.meta.url),
  'utf8'
)

function messageWithChange(actor: 'user' | EnsembleAuthorityRole): ChatMessage {
  return {
    id: `change-${actor}`,
    role: 'system',
    content: `${actor} changed max handoff turns from 4 to 12.`,
    timestamp: '2026-08-12T00:10:00.000Z',
    metadata: {
      kind: 'ensembleContinuationHopsChange',
      continuationHopsChange: {
        before: 4,
        after: 12,
        actor,
        changedAt: '2026-08-12T00:10:00.000Z',
        reason: actor === 'user' ? undefined : 'The round needs another review pass.'
      }
    }
  }
}

function messageWithAdvance(): ChatMessage {
  return {
    id: 'advance-49',
    role: 'system',
    content: '@-mention: extra turn appended for Boss. Continuous handoff 49/124.',
    timestamp: '2026-08-29T22:05:00.000Z',
    metadata: {
      kind: 'ensembleContinuationHopsChange',
      continuationHopsChange: {
        event: 'advance',
        before: 48,
        after: 49,
        maxHops: 124,
        changedAt: '2026-08-29T22:05:00.000Z',
        targetLabel: 'Boss',
        sourceLabel: '@-mention'
      }
    }
  }
}

function legacyAdvanceMessage(): ChatMessage {
  return {
    id: 'legacy-advance-49',
    role: 'system',
    content: '@-mention: extra turn appended for Boss. Continuous handoff 49/124.',
    timestamp: '2026-08-29T22:05:00.000Z',
    metadata: { kind: 'ensembleRoundStatus' }
  }
}

describe('ContinuationHopsChangeRow', () => {
  it.each([
    ['user', 'User'],
    ['boss', 'Boss'],
    ['captain', 'Captain']
  ] as const)('identifies a %s-authored change as %s', (actor, label) => {
    const markup = renderToStaticMarkup(
      createElement(ContinuationHopsChangeRow, { message: messageWithChange(actor) })
    )

    expect(markup).toContain('Max handoff turns')
    expect(markup).toContain(`>${label}</span>`)
    expect(markup).toContain('Max handoff turns 4')
    expect(markup).toContain('aria-expanded="false"')
  })

  it('rejects malformed metadata so TranscriptPanel can render the plain fallback', () => {
    const message = messageWithChange('user')
    if (message.metadata) {
      message.metadata.continuationHopsChange = {
        ...message.metadata.continuationHopsChange!,
        before: 0
      }
    }
    expect(renderToStaticMarkup(createElement(ContinuationHopsChangeRow, { message }))).toBe('')
  })

  it('renders an advancing numerator over the stable max with durable labels', () => {
    const markup = renderToStaticMarkup(
      createElement(ContinuationHopsChangeRow, { message: messageWithAdvance() })
    )

    expect(markup).toContain('Handoff turns')
    expect(markup).toContain('aria-label="Handoff turns 48 of 124"')
    expect(markup).toContain('>Boss</span>')
    expect(markup).toContain('>@-mention</span>')
    expect(markup).toContain('Show the previous handoff count')
  })

  it('promotes the exact legacy fallback into the same preserved row', () => {
    const markup = renderToStaticMarkup(
      createElement(ContinuationHopsChangeRow, { message: legacyAdvanceMessage() })
    )
    expect(markup).toContain('Handoff turns')
    expect(markup).toContain('aria-label="Handoff turns 48 of 124"')
    expect(markup).toContain('>Boss</span>')
  })

  it('mounts on the old number, waits on the shared delay, then rolls to the new number', () => {
    expect(rowSource).toContain("useState<'before' | 'after'>('before')")
    expect(rowSource).toContain('CONTINUATION_HOPS_CHANGE_REVEAL_DELAY_MS')
    expect(rowSource).toContain("phase === 'before' ? payload.before : payload.after")
    expect(rowSource).toContain('<ContinuationHopsValue')
    expect(rowSource).toContain('value={currentValue}')
  })

  it('reuses paired DigitOdometers for the advancing n/max fraction', () => {
    expect(rowSource).toContain('<DigitOdometer value={value} />')
    expect(rowSource).toContain('<DigitOdometer value={maxHops} />')
    expect(rowSource).toContain("const isAdvance = payload.event === 'advance'")
  })

  it('uses the seat-change hop-in and click-to-reveal-old interaction', () => {
    expect(rowSource).toContain('seat-change-message continuation-hops-change-message')
    expect(rowSource).toContain('seat-change-row continuation-hops-change-row')
    expect(rowSource).toContain('seat-change-was continuation-hops-change-was')
    expect(rowSource).toContain('value={payload.before}')
    expect(cssSource).toContain('.continuation-hops-change-value {')
  })
})

describe('TranscriptPanel continuation-hop event wiring', () => {
  it('keeps valid change events out of collapsible system/tool-thinking stacks', () => {
    const plainStart = panelSource.indexOf('function plainSystemNoticeMessage(')
    const plainEnd = panelSource.indexOf('function superGroupParticipantKey(', plainStart)
    expect(plainStart).toBeGreaterThanOrEqual(0)
    expect(panelSource.slice(plainStart, plainEnd)).toContain(
      '!resolveContinuationHopsChangePayload(msg) &&'
    )
  })

  it('dispatches the dedicated row before the system auto-collapse branch', () => {
    const dispatch = panelSource.indexOf('isContinuationHopsChange ? (')
    const collapse = panelSource.indexOf('systemAutoCollapsible ? (', dispatch)
    expect(dispatch).toBeGreaterThanOrEqual(0)
    expect(collapse).toBeGreaterThan(dispatch)
    expect(panelSource.slice(dispatch, collapse)).toContain('<ContinuationHopsChangeRow')
  })
})
