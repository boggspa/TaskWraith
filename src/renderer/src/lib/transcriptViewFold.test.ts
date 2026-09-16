import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '../../../main/store/types'
import {
  TRANSCRIPT_VIEWS,
  activityStackHasFailure,
  transcriptViewAllowsExpansion,
  transcriptViewFoldsLiveStacks,
  transcriptViewRendersFanoutViewport,
  transcriptViewRendersSegment
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

describe('fan-out lane viewports', () => {
  it('folds a succeeded lane under minimal only', () => {
    expect(transcriptViewRendersFanoutViewport('minimal')).toBe(false)
    expect(transcriptViewRendersFanoutViewport('tools')).toBe(true)
    expect(transcriptViewRendersFanoutViewport('standard')).toBe(true)
  })

  it('keeps a failed lane whole under minimal', () => {
    // The lane card is the only thing attributing a lane to its seat, so a
    // failed lane that folded would lose both the error and its owner.
    expect(transcriptViewRendersFanoutViewport('minimal', true)).toBe(true)
  })
})

describe('expansion and live folding', () => {
  it('makes minimal one-liners inert and leaves the others expandable', () => {
    expect(transcriptViewAllowsExpansion('minimal')).toBe(false)
    expect(transcriptViewAllowsExpansion('tools')).toBe(true)
    expect(transcriptViewAllowsExpansion('standard')).toBe(true)
  })

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

  it('covers every view the fold predicates accept', () => {
    // Guards the pair: a fourth view added to the union without a picker entry
    // would be unreachable, and one added here without fold handling would
    // fall through to `return false` and hide the whole turn.
    const decided = TRANSCRIPT_VIEWS.filter(
      (view) =>
        transcriptViewRendersSegment(view, 'agent') &&
        typeof transcriptViewAllowsExpansion(view) === 'boolean'
    )
    expect(decided).toHaveLength(3)
  })
})
