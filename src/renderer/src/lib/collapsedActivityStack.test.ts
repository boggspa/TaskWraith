import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '../../../main/store/types'
import {
  activityStackHasLiveWork,
  collapsedSystemNoticeLabel,
  shouldAutoCollapseActivityStack,
  summarizeCollapsedActivityStack,
  summarizeCollapsedSuperGroup
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
    expect(summary.families).toEqual(['thinking', 'search', 'read', 'write', 'shell'])
    expect(summary.activityCount).toBe(8)
    expect(summary.errorCount).toBe(0)
    expect(summary.parts.map((part) => part.text).join(' · ')).toBe(summary.label)
    expect(summary.parts.every((part) => !part.failed)).toBe(true)
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
    // One failed command is enough to accent the family verb; the error
    // tally part accents whole (no verb).
    expect(summary.parts).toEqual([
      { text: 'Ran 2 commands', verb: 'Ran', failed: true },
      { text: '1 error', verb: '', failed: true }
    ])
  })

  it('attributes failure to the family that errored, not its neighbours', () => {
    const summary = summarizeCollapsedActivityStack([
      activity({ category: 'read', filePath: '/a/x.ts', status: 'error' }),
      activity({ category: 'write', filePath: '/a/x.ts' }),
      activity({ category: 'shell' })
    ])
    expect(summary.parts).toEqual([
      { text: 'Read 1 file', verb: 'Read', failed: true },
      { text: 'Edited 1 file', verb: 'Edited', failed: false },
      { text: 'Ran 1 command', verb: 'Ran', failed: false },
      { text: '1 error', verb: '', failed: true }
    ])
  })

  it('marks the thinking part when a reasoning step errored', () => {
    const summary = summarizeCollapsedActivityStack([
      activity({ toolName: 'thinking', displayName: 'Thinking', durationMs: 3_000, status: 'error' }),
      activity({ category: 'shell' })
    ])
    expect(summary.parts[0]).toEqual({ text: 'Thought for 3s', verb: 'Thought', failed: true })
    expect(summary.parts[1]).toEqual({ text: 'Ran 1 command', verb: 'Ran', failed: false })
  })

  it('sums minute-scale thinking and never shows an empty label', () => {
    expect(
      summarizeCollapsedActivityStack([
        activity({ displayName: 'Cursor thinking', durationMs: 95_000 })
      ]).label
    ).toBe('Thought for 1m 35s')
    expect(summarizeCollapsedActivityStack([]).label).toBe('Activity')
  })

  it('always includes a duration for sub-second and untimed thoughts', () => {
    expect(
      summarizeCollapsedActivityStack([
        activity({ toolName: 'thinking', displayName: 'Thinking', durationMs: 450 })
      ]).label
    ).toBe('Thought for <1s')
    expect(
      summarizeCollapsedActivityStack([
        activity({ toolName: 'reasoning', displayName: 'Reasoning' })
      ]).label
    ).toBe('Thought for <1s')
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

describe('summarizeCollapsedSuperGroup', () => {
  it('merges member stacks and appends the system-notice count', () => {
    const summary = summarizeCollapsedSuperGroup({
      activities: [
        activity({ toolName: 'thinking', displayName: 'Thinking', durationMs: 7_000 }),
        activity({ category: 'shell' }),
        activity({ category: 'shell' }),
        activity({ toolName: 'reasoning', displayName: 'Reasoning', durationMs: 5_000 }),
        activity({ category: 'read', filePath: '/a/x.ts' })
      ],
      systemCount: 2,
      firstSystemPreview: 'Blackboard updated: fact.'
    })
    expect(summary.label).toBe(
      'Thought for 12s · Ran 2 commands · Read 1 file · 2 system notices'
    )
    expect(summary.families).toEqual(['thinking', 'shell', 'read'])
    expect(summary.parts.map((part) => part.text).join(' · ')).toBe(summary.label)
    expect(summary.parts[summary.parts.length - 1]).toEqual({
      text: '2 system notices',
      verb: '',
      failed: false
    })
  })

  it('carries member-stack failure attribution through the merged line', () => {
    const summary = summarizeCollapsedSuperGroup({
      activities: [
        activity({ category: 'shell', status: 'error' }),
        activity({ category: 'read', filePath: '/a/x.ts' })
      ],
      systemCount: 1,
      firstSystemPreview: 'Round settled.'
    })
    expect(summary.parts).toEqual([
      { text: 'Ran 1 command', verb: 'Ran', failed: true },
      { text: 'Read 1 file', verb: 'Read', failed: false },
      { text: '1 error', verb: '', failed: true },
      { text: '1 system notice', verb: '', failed: false }
    ])
    expect(summary.label).toBe('Ran 1 command · Read 1 file · 1 error · 1 system notice')
  })

  it('leads with the notice count and first preview for all-system groups', () => {
    const summary = summarizeCollapsedSuperGroup({
      activities: [],
      systemCount: 2,
      firstSystemPreview: 'Blackboard updated: fact.'
    })
    expect(summary.label).toBe('2 system notices · Blackboard updated: fact.')
    expect(summary.families).toEqual([])
  })
})
