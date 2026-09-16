import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '../../../main/store/types'
import {
  TRANSCRIPT_VIEWS,
  activityStackHasFailure,
  activityStackHasPriorityActivity,
  isTranscriptPriorityActivity,
  transcriptViewFoldsLiveStacks,
  TRANSCRIPT_ROW_VIEW_GATING,
  transcriptViewOffersExpandChrome,
  transcriptViewRendersSegment,
  visibleTimelineItems,
  visibleTimelineSegments
} from './transcriptViewFold'

function activity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return { id: 'a1', toolName: 'Bash', status: 'success', ...overrides } as ToolActivity
}

describe('transcript view segment rendering', () => {
  it('hides nothing at all under standard', () => {
    for (const kind of ['thinking', 'tools', 'agent'] as const) {
      expect(transcriptViewRendersSegment('standard', kind)).toBe(true)
    }
  })

  it('drops only thinking under tools', () => {
    expect(transcriptViewRendersSegment('tools', 'thinking')).toBe(false)
    expect(transcriptViewRendersSegment('tools', 'tools')).toBe(true)
    expect(transcriptViewRendersSegment('tools', 'agent')).toBe(true)
  })

  it('drops thinking and tool-call viewports under minimal', () => {
    expect(transcriptViewRendersSegment('minimal', 'thinking')).toBe(false)
    expect(transcriptViewRendersSegment('minimal', 'tools')).toBe(false)
  })

  it('keeps sub-agent segments under every view', () => {
    // Not one of the three surfaces Minimal was asked to hide. A spawn wave
    // that vanished would leave a delegating turn indistinguishable from an
    // idle one.
    expect(transcriptViewRendersSegment('minimal', 'agent')).toBe(true)
    expect(transcriptViewRendersSegment('tools', 'agent')).toBe(true)
  })
})

describe('the failure carve-out', () => {
  it('keeps a failed segment on screen under every view', () => {
    // The one rule Minimal does not get to break. A failed step folded behind
    // "Used 3 tools" reads like success — the reader is told the opposite of
    // what happened.
    for (const view of TRANSCRIPT_VIEWS) {
      expect(transcriptViewRendersSegment(view, 'thinking', true)).toBe(true)
      expect(transcriptViewRendersSegment(view, 'tools', true)).toBe(true)
    }
  })

  it('does not let a failure elsewhere drag an unrelated segment back', () => {
    // `hasFailure` is scoped to THIS segment. A failed shell command must not
    // re-reveal the thinking viewport the reader asked to hide.
    expect(transcriptViewRendersSegment('minimal', 'thinking', false)).toBe(false)
    expect(transcriptViewRendersSegment('tools', 'thinking', false)).toBe(false)
  })

  it('reads a failure off activity status', () => {
    expect(activityStackHasFailure([activity(), activity({ id: 'a2' })])).toBe(false)
    expect(activityStackHasFailure([activity(), activity({ id: 'a2', status: 'error' })])).toBe(
      true
    )
  })

  it('reports no failure for an empty stack', () => {
    expect(activityStackHasFailure([])).toBe(false)
  })
})

describe('expand chrome on a relayed message body', () => {
  it('drops the expander under minimal only', () => {
    expect(transcriptViewOffersExpandChrome('minimal')).toBe(false)
    expect(transcriptViewOffersExpandChrome('tools')).toBe(true)
    expect(transcriptViewOffersExpandChrome('standard')).toBe(true)
  })
})

describe('every transcript row type has a recorded gating decision', () => {
  // The four ungated rows are a DECISION, and an absence of code cannot say so.
  // This table is what makes "correct" distinguishable from "unfinished" at
  // sites where the two are byte-identical.

  /** The `VirtualRowType` union, parsed from its own source. */
  function declaredRowTypes(): string[] {
    const source = readFileSync(join(__dirname, 'TranscriptVirtualWindow.ts'), 'utf8')
    const start = source.indexOf('export type VirtualRowType =')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('export interface VirtualRow', start)
    expect(end).toBeGreaterThan(start)
    return [...source.slice(start, end).matchAll(/\|\s*'([a-zA-Z]+)'/g)].map((m) => m[1])
  }

  it('parses the union, and finds every member', () => {
    // Anti-vacuity: a regex that matched nothing would make the comparison
    // below pass over two empty lists.
    const declared = declaredRowTypes()
    expect(declared.length).toBeGreaterThan(10)
    expect(declared).toContain('participantHealth')
    expect(declared).toContain('collaborator')
  })

  it('records exactly the declared row types, no more and no fewer', () => {
    // A fourteenth row type cannot be added without answering here. TypeScript
    // catches a MISSING key on its own; this catches a STALE one, and pins that
    // the table is keyed on the real union rather than on a copy that drifted.
    expect(Object.keys(TRANSCRIPT_ROW_VIEW_GATING).sort()).toEqual(declaredRowTypes().sort())
  })

  it('keeps the four examined rows ungated, and the three surfaces gated', () => {
    for (const row of ['participantHealth', 'delegation', 'guestReply', 'collaborator'] as const) {
      expect(TRANSCRIPT_ROW_VIEW_GATING[row], row).toBe('kept')
    }
    // The positive control. Without it "everything is kept" would pass, which
    // is the state the feature exists to move away from.
    for (const row of ['tool', 'fanoutResult', 'return'] as const) {
      expect(TRANSCRIPT_ROW_VIEW_GATING[row], row).toBe('gated')
    }
  })

  it('never gates a row that may be the only record of a failure', () => {
    for (const row of ['system', 'error', 'participantHealth'] as const) {
      expect(TRANSCRIPT_ROW_VIEW_GATING[row], row).toBe('kept')
    }
  })
})

describe('the rejected fan-out lane gate stays deleted', () => {
  it('exports no fan-out viewport predicate', async () => {
    // A lane's RESULT is the seat's answer, and no view removes it. The gate
    // that would have hidden it was examined and rejected: a wave only folds
    // to its one-liner once every lane is terminal and focus has moved on, so
    // on a live wave hiding the body leaves an attribution header with nothing
    // underneath. Pinned as an export assertion rather than a comment because
    // the failure mode is someone re-adding the helper as "unfinished work".
    const fold = await import('./transcriptViewFold')
    expect(Object.keys(fold)).not.toContain('transcriptViewRendersFanoutViewport')
    // Anti-vacuity: the module really does export predicates under this name
    // shape, so the absence above is a filtered result and not an empty one.
    expect(Object.keys(fold)).toContain('transcriptViewRendersSegment')
  })
})

describe('expansion and live folding', () => {
  it('folds live stacks under minimal only', () => {
    expect(transcriptViewFoldsLiveStacks('minimal')).toBe(true)
    expect(transcriptViewFoldsLiveStacks('tools')).toBe(false)
    expect(transcriptViewFoldsLiveStacks('standard')).toBe(false)
  })
})

describe('the view list', () => {
  it('offers every view exactly once, quietest first', () => {
    expect(TRANSCRIPT_VIEWS).toEqual(['minimal', 'tools', 'standard'])
  })

  it('renders SOMETHING for every view and kind, so no view can blank a turn', () => {
    // A fourth view added to the union without fold handling would fall
    // through to `return false` for every kind and hide the whole turn. This
    // asserts each view keeps at least one kind, which `return false` breaks.
    for (const view of TRANSCRIPT_VIEWS) {
      const kept = (['thinking', 'tools', 'agent'] as const).filter((kind) =>
        transcriptViewRendersSegment(view, kind)
      )
      expect(kept.length).toBeGreaterThan(0)
    }
  })
})

describe('the priority carve-out', () => {
  const yielding = activity({ toolName: 'mcp_TaskWraith_ensemble_yield' })

  it('recognises a yield through its canonical name', () => {
    expect(isTranscriptPriorityActivity(yielding)).toBe(true)
    expect(isTranscriptPriorityActivity(activity())).toBe(false)
    expect(activityStackHasPriorityActivity([activity(), yielding])).toBe(true)
    expect(activityStackHasPriorityActivity([activity()])).toBe(false)
  })

  it('keeps a priority segment on screen under every view', () => {
    // Without this the two protections CANCEL: the fold refuses a yield
    // because it is conversation structure, so it falls through to the full
    // stack, where the filter drops it as ordinary tool noise and the row
    // renders nothing at all. That shipped.
    for (const view of TRANSCRIPT_VIEWS) {
      expect(transcriptViewRendersSegment(view, 'tools', false, true)).toBe(true)
    }
    // Control: the same segment WITHOUT a priority activity is dropped under
    // minimal, so the assertion above is the exemption doing work.
    expect(transcriptViewRendersSegment('minimal', 'tools', false, false)).toBe(false)
  })
})

describe('segment and item filtering', () => {
  const seg = (kind: 'thinking' | 'tools' | 'agent', items: string[], acts = [activity()]) => ({
    kind,
    items,
    activities: acts
  })

  it('returns the SAME ARRAY for standard, so the default install pays nothing', () => {
    // Not just equal — identical. Standard must not allocate a copy per render
    // of every activity stack in the transcript.
    const segments = [seg('thinking', ['t1']), seg('tools', ['x1'])]
    expect(visibleTimelineSegments(segments, 'standard')).toBe(segments)
    const items = ['t1', 'x1']
    expect(visibleTimelineItems(segments, 'standard', items)).toBe(items)
  })

  it('drops thinking under tools and both under minimal', () => {
    const segments = [seg('thinking', ['t1']), seg('tools', ['x1'])]
    expect(visibleTimelineSegments(segments, 'tools').map((s) => s.kind)).toEqual(['tools'])
    expect(visibleTimelineSegments(segments, 'minimal')).toEqual([])
  })

  it('feeds the flat tree exactly the survivors, in order', () => {
    const segments = [seg('thinking', ['t1']), seg('agent', ['a1']), seg('tools', ['x1'])]
    expect(visibleTimelineItems(segments, 'tools', ['t1', 'a1', 'x1'])).toEqual(['a1', 'x1'])
    expect(visibleTimelineItems(segments, 'minimal', ['t1', 'a1', 'x1'])).toEqual(['a1'])
  })

  it('keeps a failed or priority segment through the filter', () => {
    const failed = seg('tools', ['x1'], [activity({ status: 'error' })])
    const priority = seg('tools', ['y1'], [activity({ toolName: 'mcp_TaskWraith_ensemble_yield' })])
    expect(visibleTimelineSegments([failed], 'minimal')).toHaveLength(1)
    expect(visibleTimelineSegments([priority], 'minimal')).toHaveLength(1)
  })
})
