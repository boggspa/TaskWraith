import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { AutoApprovalsChangeRow } from './AutoApprovalsChangeRow'

const rowSource = readFileSync(new URL('./AutoApprovalsChangeRow.tsx', import.meta.url), 'utf8')
const panelSource = readFileSync(new URL('./TranscriptPanel.tsx', import.meta.url), 'utf8')
const rosterSource = readFileSync(
  new URL('./EnsembleParticipantsAboveRow.tsx', import.meta.url),
  'utf8'
)
const transcriptCss = readFileSync(
  new URL('../assets/css/08-theme-picker-overrides.css', import.meta.url),
  'utf8'
)
const ensembleCss = readFileSync(
  new URL('../assets/css/09-ensemble-work-session.css', import.meta.url),
  'utf8'
)

function messageWithChange(before: boolean, after: boolean): ChatMessage {
  return {
    id: `auto-${before}-${after}`,
    role: 'system',
    content: `User ${after ? 'enabled' : 'disabled'} thread-wide Auto Approvals.`,
    timestamp: '2026-08-27T12:00:00.000Z',
    metadata: {
      kind: 'ensembleAutoApprovalsChange',
      autoApprovalsChange: {
        before,
        after,
        changedAt: '2026-08-27T12:00:00.000Z'
      }
    }
  }
}

describe('AutoApprovalsChangeRow', () => {
  it('mounts on the old disabled Auto pill before an enable transition', () => {
    const markup = renderToStaticMarkup(
      createElement(AutoApprovalsChangeRow, { message: messageWithChange(false, true) })
    )

    expect(markup).toContain('Thread-wide approvals')
    expect(markup).toContain('thread-auto-approvals-pill')
    expect(markup).toContain('data-pressed="false"')
    expect(markup).toContain('(Disabled)')
    expect(markup).toContain('>User</span>')
    expect(markup).toContain('aria-expanded="false"')
  })

  it('mounts on the old enabled Auto pill before a disable transition', () => {
    const markup = renderToStaticMarkup(
      createElement(AutoApprovalsChangeRow, { message: messageWithChange(true, false) })
    )
    expect(markup).toContain('data-pressed="true"')
    expect(markup).toContain('(Enabled)')
  })

  it('rejects malformed metadata so the plain fallback remains available', () => {
    const message = messageWithChange(false, true)
    if (message.metadata) {
      message.metadata.autoApprovalsChange = {
        before: false,
        after: false,
        changedAt: '2026-08-27T12:00:00.000Z'
      }
    }
    expect(renderToStaticMarkup(createElement(AutoApprovalsChangeRow, { message }))).toBe('')
  })

  it('waits on the shared delay, transitions to after, and expands to before', () => {
    expect(rowSource).toContain("useState<'before' | 'after'>('before')")
    expect(rowSource).toContain('AUTO_APPROVALS_CHANGE_REVEAL_DELAY_MS')
    expect(rowSource).toContain("phase === 'before' ? payload.before : payload.after")
    expect(rowSource).toContain('<AutoPill enabled={currentEnabled} />')
    expect(rowSource).toContain('<AutoPill enabled={payload.before} />')
    expect(rowSource).toContain('seat-change-was auto-approvals-change-was')
  })

  it('shares the production Auto pill treatment with both roster controls', () => {
    expect(rosterSource.match(/thread-auto-approvals-pill/g)).toHaveLength(2)
    expect(ensembleCss).toContain(
      ".thread-auto-approvals-pill:is([aria-pressed='true'], [data-pressed='true'])"
    )
    expect(transcriptCss).toContain('.auto-approvals-change-pill {')
  })
})

describe('TranscriptPanel Auto Approvals event wiring', () => {
  it('keeps valid events out of collapsed system stacks and dispatches the dedicated row', () => {
    const plainStart = panelSource.indexOf('function plainSystemNoticeMessage(')
    const plainEnd = panelSource.indexOf('function superGroupParticipantKey(', plainStart)
    expect(plainStart).toBeGreaterThanOrEqual(0)
    expect(panelSource.slice(plainStart, plainEnd)).toContain(
      '!isAutoApprovalsChangePayload(msg.metadata?.autoApprovalsChange) &&'
    )

    const dispatch = panelSource.indexOf('isAutoApprovalsChange ? (')
    const collapse = panelSource.indexOf('systemAutoCollapsible ? (', dispatch)
    expect(dispatch).toBeGreaterThanOrEqual(0)
    expect(collapse).toBeGreaterThan(dispatch)
    expect(panelSource.slice(dispatch, collapse)).toContain('<AutoApprovalsChangeRow')
  })
})
