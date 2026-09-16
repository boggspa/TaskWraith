import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActivityStack } from './ActivityStack'
import type { ToolActivity } from '../../../main/store/types'

const THINK = 'THINKING-BODY-MARKER'
const TOOL = 'TOOL-BODY-MARKER'
const FAILED = 'FAILED-BODY-MARKER'

function thinking(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'think-1',
    toolName: 'reasoning',
    displayName: 'Thinking',
    category: 'task',
    status: 'success',
    parameters: { kind: 'thinking' },
    outputPreview: THINK,
    resultSummary: THINK,
    ...overrides
  } as ToolActivity
}

function shell(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'tool-1',
    toolName: 'Bash',
    displayName: 'Bash',
    category: 'shell',
    status: 'success',
    parameters: { command: TOOL },
    outputPreview: TOOL,
    resultSummary: TOOL,
    ...overrides
  } as ToolActivity
}

/** Render the same stack through BOTH of ActivityStack's render trees. */
function renderBothTrees(
  activities: ToolActivity[],
  transcriptView: 'minimal' | 'tools' | 'standard'
) {
  return {
    live: renderToStaticMarkup(
      <ActivityStack activities={activities} transcriptView={transcriptView} liveActivityViewport />
    ),
    flat: renderToStaticMarkup(
      <ActivityStack activities={activities} transcriptView={transcriptView} />
    )
  }
}

describe('standard renders exactly what it renders today', () => {
  it('shows both bodies in both trees', () => {
    // The positive control every negative assertion below depends on. If this
    // ever stops holding, the "hidden under minimal" tests become vacuous —
    // they would pass because the marker was never in the markup at all.
    const { live, flat } = renderBothTrees([thinking(), shell()], 'standard')
    expect(live).toContain(THINK)
    expect(live).toContain(TOOL)
    expect(flat).toContain(THINK)
    expect(flat).toContain(TOOL)
  })

  it('is byte-identical to passing no view at all', () => {
    const activities = [thinking(), shell()]
    for (const liveActivityViewport of [true, false]) {
      expect(
        renderToStaticMarkup(
          <ActivityStack
            activities={activities}
            transcriptView="standard"
            liveActivityViewport={liveActivityViewport}
          />
        )
      ).toBe(
        renderToStaticMarkup(
          <ActivityStack activities={activities} liveActivityViewport={liveActivityViewport} />
        )
      )
    }
  })
})

describe('both render trees hide the same things', () => {
  // THE half-ship risk. ActivityStack has two independent trees: a per-segment
  // one when the live activity viewport is on, and a flat per-item one when it
  // is off — which is also the ONLY tree SubThreadReturnCard ever reaches,
  // because it never passes `liveActivityViewport`. A gate wired into one tree
  // leaves the feature doing nothing for everyone with that setting off, and
  // nothing at all for sub-thread return cards in every configuration.

  it('drops thinking bodies under tools, in both trees', () => {
    const { live, flat } = renderBothTrees([thinking(), shell()], 'tools')
    expect(live).not.toContain(THINK)
    expect(flat).not.toContain(THINK)
    expect(live).toContain(TOOL)
    expect(flat).toContain(TOOL)
  })

  it('drops thinking AND tool bodies under minimal, in both trees', () => {
    const { live, flat } = renderBothTrees([thinking(), shell()], 'minimal')
    expect(live).not.toContain(THINK)
    expect(live).not.toContain(TOOL)
    expect(flat).not.toContain(THINK)
    expect(flat).not.toContain(TOOL)
  })

  it('agrees on every view, so an unrelated setting cannot change what is hidden', () => {
    const activities = [thinking(), shell()]
    for (const view of ['minimal', 'tools', 'standard'] as const) {
      const { live, flat } = renderBothTrees(activities, view)
      expect({ think: live.includes(THINK), tool: live.includes(TOOL) }).toEqual({
        think: flat.includes(THINK),
        tool: flat.includes(TOOL)
      })
    }
  })
})

describe('the failure carve-out survives rendering', () => {
  it('keeps a failed tool body under minimal while folding its successful sibling', () => {
    // A failed step folded behind a one-liner reads like success. The carve-out
    // is per SEGMENT, so the failure must not drag the thinking body back.
    const activities = [
      thinking(),
      shell({ id: 'fail-1', status: 'error', parameters: { command: FAILED } })
    ]
    const { live, flat } = renderBothTrees(activities, 'minimal')
    expect(live).toContain(FAILED)
    expect(flat).toContain(FAILED)
    expect(live).not.toContain(THINK)
    expect(flat).not.toContain(THINK)
  })

  it('exempts the whole segment a failure sits in, not just the failed row', () => {
    // `buildTimelineSegments` merges CONSECUTIVE items of the same kind, so one
    // failed command keeps its successful neighbours on screen. That is the
    // intended reading of the carve-out — a failure's neighbours are the
    // context that explains it — but it is surprising enough to pin, because
    // it is why a "minimal hides all tool output" test needs a stack with no
    // failure in it at all.
    const activities = [
      shell(),
      shell({ id: 'fail-1', status: 'error', parameters: { command: FAILED } })
    ]
    const { live, flat } = renderBothTrees(activities, 'minimal')
    expect(live).toContain(FAILED)
    expect(live).toContain(TOOL)
    expect(flat).toContain(FAILED)
    expect(flat).toContain(TOOL)
  })

  it('keeps a failed THINKING body too — the exemption is the failure, not the kind', () => {
    const activities = [thinking({ status: 'error' }), shell()]
    const { live, flat } = renderBothTrees(activities, 'minimal')
    expect(live).toContain(THINK)
    expect(flat).toContain(THINK)
  })
})

describe('a view that hides everything renders nothing', () => {
  it('returns null rather than an empty timeline wrapper', () => {
    // An empty `.activity-timeline` would still paint its header and accent
    // chrome, leaving a bare rule in the transcript where the work used to be.
    const { live, flat } = renderBothTrees([thinking(), shell()], 'minimal')
    expect(live).toBe('')
    expect(flat).toBe('')
  })

  it('still renders when something survives the filter', () => {
    // Positive control for the assertion above: proves `''` means "filtered to
    // nothing", not "this component renders nothing under minimal".
    const { live, flat } = renderBothTrees([thinking(), shell({ status: 'error' })], 'minimal')
    expect(live).not.toBe('')
    expect(flat).not.toBe('')
  })
})

describe('the live segment-children cache learns about the view', () => {
  it('carries the view in its reuse key', () => {
    // renderToStaticMarkup mounts fresh every time, so no rendering test can
    // reach the cross-render cache at `segmentChildrenCacheRef`. Without the
    // view in the reuse key a surviving segment keeps its id and is served
    // from that cache exactly as it was rendered under the previous view —
    // compiles clean, renders clean, and the transcript ignores the menu.
    const source = readFileSync(join(__dirname, 'ActivityStack.tsx'), 'utf8')
    const call = source.slice(
      source.indexOf('const reuseKey = liveSegmentChildrenReuseKey({'),
      source.indexOf('const cached = segmentChildrenCacheRef.current.get(segment.id)')
    )
    expect(call).not.toBe('')
    expect(call).toContain('transcriptView,')
  })
})
