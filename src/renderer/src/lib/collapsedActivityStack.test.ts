import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '../../../main/store/types'
import {
  activityStackHasLiveWork,
  collapsedSystemNoticeLabel,
  shouldAutoCollapseActivityStack,
  summarizeCollapsedActivityStack
} from './collapsedActivityStack'

const activity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: `a-${Math.random().toString(36).slice(2)}`,
  toolName: 'tool',
  displayName: 'Tool',
  category: 'unknown',
  status: 'success',
  ...overrides
})

describe('summarizeCollapsedActivityStack', () => {
  it('leads with thinking duration and follows tool families in first-appearance order', () => {
    const summary = summarizeCollapsedActivityStack([
      activity({ toolName: 'thinking', displayName: 'Thinking', durationMs: 8_000 }),
      activity({ category: 'search' }),
      activity({ category: 'search' }),
      activity({ category: 'read', filePath: '/a/Blackboard.ts' }),
      activity({ category: 'read', filePath: '/a/types.ts' }),
      activity({ toolName: 'reasoning', displayName: 'Reasoning', durationMs: 4_000 }),
      activity({ category: 'write', filePath: '/a/Blackboard.ts' }),
      activity({ category: 'shell' })
    ])
    expect(summary.label).toBe(
      'Thought for 12s · Searched ×2 · Read 2 files · Edited 1 file · Ran 1 command'
    )
    expect(summary.activityCount).toBe(8)
    expect(summary.errorCount).toBe(0)
  })

  it('counts distinct files, not raw call counts, for reads and edits', () => {
    const summary = summarizeCollapsedActivityStack([
      activity({ category: 'read', filePath: '/a/x.ts' }),
      activity({ category: 'read', filePath: '/a/x.ts' }),
      activity({ category: 'read', filePath: '/a/y.ts' })
    ])
    expect(summary.label).toBe('Read 2 files')
  })

  it('surfaces error counts on the summary line', () => {
    const summary = summarizeCollapsedActivityStack([
      activity({ category: 'shell', status: 'error' }),
      activity({ category: 'shell' })
    ])
    expect(summary.label).toBe('Ran 2 commands · 1 error')
    expect(summary.errorCount).toBe(1)
  })

  it('sums minute-scale thinking and never shows an empty label', () => {
    expect(
      summarizeCollapsedActivityStack([
        activity({ displayName: 'Cursor thinking', durationMs: 95_000 })
      ]).label
    ).toBe('Thought for 1m 35s')
    expect(summarizeCollapsedActivityStack([]).label).toBe('Activity')
  })
})

describe('collapsedSystemNoticeLabel', () => {
  it('returns the first non-empty line and a fallback for empty bodies', () => {
    expect(
      collapsedSystemNoticeLabel('\n\n@-mention: extra turn appended for kimi.\nSecond line')
    ).toBe('@-mention: extra turn appended for kimi.')
    expect(collapsedSystemNoticeLabel('')).toBe('System notice')
    expect(collapsedSystemNoticeLabel(undefined)).toBe('System notice')
  })
})

describe('shouldAutoCollapseActivityStack', () => {
  const settled = [activity({ category: 'read', filePath: '/a/x.ts' })]

  it('collapses a settled stack once a later message exists', () => {
    expect(
      shouldAutoCollapseActivityStack({ activities: settled, isLiveRow: false, isLastRow: false })
    ).toBe(true)
  })

  it('never collapses the live row, the last row, or a stack with live work', () => {
    expect(
      shouldAutoCollapseActivityStack({ activities: settled, isLiveRow: true, isLastRow: false })
    ).toBe(false)
    expect(
      shouldAutoCollapseActivityStack({ activities: settled, isLiveRow: false, isLastRow: true })
    ).toBe(false)
    const streaming = [activity({ category: 'shell', status: 'running' })]
    expect(
      shouldAutoCollapseActivityStack({ activities: streaming, isLiveRow: false, isLastRow: false })
    ).toBe(false)
    expect(activityStackHasLiveWork(streaming)).toBe(true)
  })
})
