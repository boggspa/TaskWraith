import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '../../../main/store/types'
import {
  activityStackHasLiveWork,
  collapsedStackDiffAriaLabel,
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

/** A settled edit carrying an exact server-side diff, as the expanded
 * viewport's odometer would read it. */
const write = (path: string, additions: number, deletions: number): ToolActivity =>
  activity({
    toolName: 'edit',
    displayName: 'Edit',
    category: 'write',
    filePath: path,
    diffSummary: {
      additions,
      deletions,
      confidence: 'exact',
      source: 'git_numstat',
      files: [{ path, status: 'modified', additions, deletions }]
    }
  })

describe('summarizeCollapsedActivityStack', () => {
  it('excludes hidden infrastructure activities (antigravity_init, generic) from the fold', () => {
    const summary = summarizeCollapsedActivityStack([
      activity({ toolName: 'antigravity_init', displayName: 'Used AntiGravity Init' }),
      activity({ toolName: 'generic', displayName: 'Used Generic' }),
      write('src/a.ts', 3, 1)
    ])
    expect(summary.activityCount).toBe(1)
    expect(summary.label).not.toContain('tool')
    expect(summary.label).toContain('Edited')
  })

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

  it('sums the folded file writes into one +N -M total', () => {
    // Three edits fold into "Edited 2 files"; the diff the open viewports
    // showed per row must survive as a total, not be flattened away.
    const summary = summarizeCollapsedActivityStack([
      activity({ toolName: 'thinking', displayName: 'Thinking', durationMs: 3_000 }),
      write('/a/Blackboard.ts', 12, 5),
      write('/a/Blackboard.ts', 3, 0),
      write('/a/types.ts', 7, 4)
    ])
    expect(summary.label).toBe('Thought for 3s · Edited 2 files')
    expect(summary.diff).toEqual({ additions: 22, deletions: 9, estimated: false })
    // The counters are their own field — the label/parts contract that the
    // aria string and the iOS mirror build from stays byte-identical.
    expect(summary.parts.map((part) => part.text).join(' · ')).toBe(summary.label)
    expect(summary.label).not.toContain('+')
  })

  it('reports no diff when nothing folded away carried one', () => {
    expect(
      summarizeCollapsedActivityStack([
        activity({ category: 'read', filePath: '/a/x.ts' }),
        activity({ category: 'shell' })
      ]).diff
    ).toBeNull()
    expect(summarizeCollapsedActivityStack([]).diff).toBeNull()
  })

  it('excludes writes that errored — a denied edit changed nothing on disk', () => {
    const summary = summarizeCollapsedActivityStack([
      write('/a/x.ts', 9, 2),
      { ...write('/a/y.ts', 400, 400), status: 'error' }
    ])
    expect(summary.diff).toEqual({ additions: 9, deletions: 2, estimated: false })
  })

  it('flags the total as estimated when a contributing diff was not exact', () => {
    const summary = summarizeCollapsedActivityStack([
      write('/a/x.ts', 4, 1),
      // No server-side diff — the counts are inferred from the replacement
      // strings, which is what the `~` marker discloses.
      activity({
        category: 'write',
        toolName: 'edit',
        filePath: '/a/y.ts',
        parameters: { file_path: '/a/y.ts', old_string: 'one\ntwo', new_string: 'ONE\nTWO\nTHREE' }
      })
    ])
    expect(summary.diff?.additions).toBe(7)
    expect(summary.diff?.deletions).toBe(3)
    expect(summary.diff?.estimated).toBe(true)
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

  it('does not collapse a stack made only of hidden infrastructure activity', () => {
    const hidden = [
      activity({ toolName: 'antigravity_init', displayName: 'Used AntiGravity Init' }),
      activity({ toolName: 'generic', displayName: 'Used Generic' })
    ]
    expect(
      shouldAutoCollapseActivityStack({ activities: hidden, isLiveRow: false, isLastRow: false })
    ).toBe(false)
  })

  it('does not let hidden live infrastructure keep visible settled work open', () => {
    expect(
      shouldAutoCollapseActivityStack({
        activities: [
          activity({ toolName: 'antigravity_init', status: 'running' }),
          activity({ category: 'read', filePath: '/a/x.ts' })
        ],
        isLiveRow: false,
        isLastRow: false
      })
    ).toBe(true)
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
    expect(summary.diff).toBeNull()
  })

  it('sums diffs across every member stack the super-group swallowed', () => {
    const summary = summarizeCollapsedSuperGroup({
      activities: [write('/a/x.ts', 10, 3), write('/a/y.ts', 5, 1), write('/a/z.ts', 1, 1)],
      systemCount: 1,
      firstSystemPreview: 'Round settled.'
    })
    expect(summary.label).toBe('Edited 3 files · 1 system notice')
    expect(summary.diff).toEqual({ additions: 16, deletions: 5, estimated: false })
  })
})

describe('collapsedStackDiffAriaLabel', () => {
  it('announces the totals the counters paint, singular-aware', () => {
    expect(collapsedStackDiffAriaLabel({ additions: 22, deletions: 9, estimated: false })).toBe(
      '22 lines added, 9 lines removed'
    )
    expect(collapsedStackDiffAriaLabel({ additions: 1, deletions: 1, estimated: false })).toBe(
      '1 line added, 1 line removed'
    )
    expect(collapsedStackDiffAriaLabel({ additions: 4, deletions: 0, estimated: true })).toBe(
      'about 4 lines added, 0 lines removed'
    )
  })
})
