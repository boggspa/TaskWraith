import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import type { EnsembleAuthorityRole } from '../../../shared/ensembleAuthority'
import type { ExecutionPlanChangePayload } from '../../../shared/executionPlanChange'
import { ExecutionPlanChangeRow } from './ExecutionPlanChangeRow'

const rowSource = readFileSync(new URL('./ExecutionPlanChangeRow.tsx', import.meta.url), 'utf8')
const panelSource = readFileSync(new URL('./TranscriptPanel.tsx', import.meta.url), 'utf8')
const cssSource = readFileSync(
  new URL('../assets/css/08-theme-picker-overrides.css', import.meta.url),
  'utf8'
)

function messageWithPlan(actor: EnsembleAuthorityRole, previousSummary?: string): ChatMessage {
  return {
    id: `plan-${actor}`,
    role: 'system',
    content: `${actor === 'boss' ? 'Boss' : 'Captain'} set the execution plan: Ship the parser first.`,
    timestamp: '2026-09-01T10:42:00.000Z',
    metadata: {
      kind: 'ensembleExecutionPlanChange',
      executionPlanChange: {
        summary: 'Ship the parser first.',
        actor,
        actorParticipantId: 'claude',
        changedAt: '2026-09-01T10:42:00.000Z',
        phase: 'Implementation',
        ownerLabels: ['Worker', 'Reviewer'],
        blockers: ['Waiting on the decoder audit'],
        doneCriteria: 'Row renders before generic notices.',
        ...(previousSummary ? { previousSummary } : {})
      }
    }
  }
}

function legacyPlanMessage(): ChatMessage {
  return {
    id: 'legacy-plan',
    role: 'system',
    content: 'Boss set the execution plan: Verify the close-out, then ship.',
    timestamp: '2026-08-18T09:00:00.000Z',
    metadata: { kind: 'ensembleRoundStatus' }
  }
}

describe('ExecutionPlanChangeRow', () => {
  it.each([
    ['boss', 'Boss'],
    ['captain', 'Captain']
  ] as const)('renders the compact %s row: icon, label, summary, actor, time', (actor, label) => {
    const markup = renderToStaticMarkup(
      createElement(ExecutionPlanChangeRow, { message: messageWithPlan(actor) })
    )

    expect(markup).toContain('Execution plan')
    expect(markup).toContain('Ship the parser first.')
    expect(markup).toContain(`>${label}</span>`)
    expect(markup).toContain('aria-expanded="false"')
    // Collapsed by default: the details and the "was" line are click-gated.
    expect(markup).not.toContain('execution-plan-change-details')
    expect(markup).not.toContain('>was</span>')
  })

  it('rejects malformed metadata so TranscriptPanel can render the plain fallback', () => {
    const message = messageWithPlan('boss')
    if (message.metadata) {
      // Cast because that is the whole point: what lands on disk is data, not
      // trusted TypeScript, and the validator exists for records tsc would
      // never have allowed to be written.
      message.metadata.executionPlanChange = {
        ...(message.metadata.executionPlanChange as object),
        summary: ''
      } as unknown as ExecutionPlanChangePayload
    }
    expect(renderToStaticMarkup(createElement(ExecutionPlanChangeRow, { message }))).toBe('')
  })

  it('promotes the exact legacy fallback sentence into the same preserved row', () => {
    const markup = renderToStaticMarkup(
      createElement(ExecutionPlanChangeRow, { message: legacyPlanMessage() })
    )
    expect(markup).toContain('Execution plan')
    expect(markup).toContain('Verify the close-out, then ship.')
    expect(markup).toContain('>Boss</span>')
  })

  it('describes the disclosure to assistive tech', () => {
    const markup = renderToStaticMarkup(
      createElement(ExecutionPlanChangeRow, { message: messageWithPlan('boss') })
    )
    expect(markup).toContain('Boss set the execution plan: Ship the parser first.')
    expect(markup).toContain('Show the plan details')
  })

  it('reveals the full details on click, and the was-line only for later updates', () => {
    expect(rowSource).toContain('{expanded && (')
    expect(rowSource).toContain('execution-plan-change-details')
    expect(rowSource).toContain('{expanded && payload.previousSummary && (')
    expect(rowSource).toContain('seat-change-was execution-plan-change-was')
    expect(rowSource).toContain('{payload.previousSummary}')
  })

  it('reuses the seat-change fresh-row hop without faking an odometer transition', () => {
    expect(rowSource).toContain('seat-change-message execution-plan-change-message')
    expect(rowSource).toContain('seat-change-row execution-plan-change-row')
    expect(rowSource).toContain('SEAT_CHANGE_COALESCE_WINDOW_MS')
    // The summary is prose, not a counter: no odometer, no before -> after roll.
    expect(rowSource).not.toContain('DigitOdometer')
    expect(rowSource).not.toContain('REVEAL_DELAY')
    expect(cssSource).toContain('.execution-plan-change-summary {')
  })
})

describe('TranscriptPanel execution-plan event wiring', () => {
  it('keeps valid plan events out of collapsible system/tool-thinking stacks', () => {
    const plainStart = panelSource.indexOf('function plainSystemNoticeMessage(')
    const plainEnd = panelSource.indexOf('function superGroupParticipantKey(', plainStart)
    expect(plainStart).toBeGreaterThanOrEqual(0)
    expect(panelSource.slice(plainStart, plainEnd)).toContain(
      '!resolveExecutionPlanChangePayload(msg) &&'
    )
  })

  it('dispatches the dedicated row before the system auto-collapse branch', () => {
    const dispatch = panelSource.indexOf('isExecutionPlanChange ? (')
    const collapse = panelSource.indexOf('systemAutoCollapsible ? (', dispatch)
    expect(dispatch).toBeGreaterThanOrEqual(0)
    expect(collapse).toBeGreaterThan(dispatch)
    expect(panelSource.slice(dispatch, collapse)).toContain('<ExecutionPlanChangeRow')
  })
})
