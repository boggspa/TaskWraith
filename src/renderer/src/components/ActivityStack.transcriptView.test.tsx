import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActivityStack, activityStackHasVisibleContent } from './ActivityStack'
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

function yielding(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'yield-1',
    toolName: 'mcp_TaskWraith_ensemble_yield',
    displayName: 'Captain K yielding to Gems',
    category: 'task',
    status: 'success',
    parameters: { target: 'Gems' },
    ...overrides
  } as ToolActivity
}

describe('a priority row survives every view', () => {
  it('renders an ensemble_yield identically under minimal, tools and standard', () => {
    // The carve-out used to CANCEL ITSELF: the fold refused a yield because it
    // is conversation structure, so it fell through to the full stack, where
    // the segment filter dropped it as tool noise and the row rendered NOTHING.
    const standard = renderToStaticMarkup(
      <ActivityStack activities={[yielding()]} transcriptView="standard" />
    )
    expect(standard).not.toBe('')
    for (const view of ['minimal', 'tools'] as const) {
      expect(
        renderToStaticMarkup(<ActivityStack activities={[yielding()]} transcriptView={view} />)
      ).toBe(standard)
    }
  })
})

function spawn(overrides: Partial<ToolActivity> = {}): ToolActivity {
  // `task` is on ChildAgentThreads' explicit TASK_TOOL_NAMES list, so this
  // activity anchors a ChildAgentThread and therefore segments as kind
  // 'agent' — the one kind every view keeps.
  return {
    id: 'spawn-1',
    toolName: 'task',
    displayName: 'Task',
    category: 'task',
    status: 'success',
    parameters: { prompt: 'SPAWN-PROMPT-MARKER' },
    ...overrides
  } as ToolActivity
}

describe('a sub-agent spawn wave stays reachable', () => {
  it('renders under every view, and is expandable under minimal', () => {
    // `transcriptViewRendersSegment` keeps kind 'agent' in every view — but
    // that promise was unkept: the settled stack folded, `canExpand` asked
    // "is the view minimal" and said no, so the children never mounted and
    // the surviving agent segment could not be reached.
    const opts = { provider: 'claude' as const, chatId: 'c1', runId: 'r1' }
    for (const view of ['minimal', 'tools', 'standard'] as const) {
      expect(activityStackHasVisibleContent([spawn()], view, opts)).toBe(true)
    }
    // Control: without the provider there is no thread, so the same activity
    // segments as ordinary tool noise and minimal drops it. This is what makes
    // the assertion above depend on the agent-anchor path.
    expect(activityStackHasVisibleContent([spawn()], 'minimal')).toBe(false)
  })
})

describe('activityStackHasVisibleContent agrees with what renders', () => {
  // The predicate replicates the component's pipeline because the CALLER must
  // decide `canExpand` before rendering the stack as children. This is the
  // anti-drift pin: for every fixture and every view, "would opening show
  // anything" must equal "does the component render anything".
  const fixtures: { name: string; activities: ToolActivity[] }[] = [
    { name: 'thinking only', activities: [thinking()] },
    { name: 'tools only', activities: [shell()] },
    { name: 'thinking + tools', activities: [thinking(), shell()] },
    { name: 'failed tool', activities: [shell({ status: 'error' })] },
    { name: 'priority yield', activities: [yielding()] },
    { name: 'thinking + failed tool', activities: [thinking(), shell({ status: 'error' })] }
  ]

  for (const view of ['minimal', 'tools', 'standard'] as const) {
    for (const fixture of fixtures) {
      it(`${view}: ${fixture.name}`, () => {
        const rendered =
          renderToStaticMarkup(
            <ActivityStack activities={fixture.activities} transcriptView={view} />
          ) !== ''
        expect(activityStackHasVisibleContent(fixture.activities, view)).toBe(rendered)
      })
    }
  }

  it('says no for an empty stack and yes for standard without doing any work', () => {
    expect(activityStackHasVisibleContent([], 'minimal')).toBe(false)
    expect(activityStackHasVisibleContent(undefined, 'minimal')).toBe(false)
    expect(activityStackHasVisibleContent([thinking()], 'standard')).toBe(true)
  })
})

function todo(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'todo-1',
    toolName: 'TodoWrite',
    displayName: 'Todo',
    category: 'task',
    status: 'success',
    parameters: { todos: [{ content: 'PLAN-RAIL-MARKER', status: 'in_progress' }] },
    ...overrides
  } as ToolActivity
}

describe('pinned status outlives every view', () => {
  it('keeps the plan rail when the view filters every segment away', () => {
    // The rail normally rides inside the first segment's cached body, so a
    // view that removed every segment took it with them — and then the
    // empty-guard returned null and the whole row vanished. The rail is pinned
    // STATUS, not a viewport, and none of the three surfaces any view hides.
    for (const view of ['minimal', 'tools', 'standard'] as const) {
      const html = renderToStaticMarkup(
        <ActivityStack activities={[todo()]} transcriptView={view} liveActivityViewport />
      )
      expect(html).toContain('PLAN-RAIL-MARKER')
    }
  })
})

describe('the collapsed cap counts what the CAP hid', () => {
  // 90 thinking + 10 shell. Under standard everything is present and the cap
  // bites; under tools/minimal the thinking is gone and there is nothing left
  // for the cap to hide.
  const many: ToolActivity[] = Array.from({ length: 100 }, (_, i) =>
    i < 90
      ? thinking({ id: `k${i}`, outputPreview: `T${i}`, resultSummary: `T${i}` })
      : shell({ id: `s${i}`, parameters: { command: `echo ${i}` } })
  )

  const banner = (view: 'minimal' | 'tools' | 'standard') =>
    renderToStaticMarkup(
      <ActivityStack activities={many} transcriptView={view} liveActivityViewport />
    ).match(/(\d+) earlier events hidden/)?.[1] ?? null

  it("never claims the view's removals as its own", () => {
    // Reading the UNFILTERED list made the banner announce hidden events on a
    // row where the view, not the cap, had removed them — and where nothing
    // was capped at all.
    expect(banner('minimal')).toBeNull()
    expect(banner('tools')).toBeNull()
  })

  it('still reports the cap under standard', () => {
    // Positive control: without this the assertions above would pass simply
    // because the banner never renders.
    expect(banner('standard')).not.toBeNull()
    expect(Number(banner('standard'))).toBeGreaterThan(0)
  })

  it('reads the cap and its banner off the SAME filtered list', () => {
    // These two halves mask each other at render level, which is why both
    // shipped wrong: with only the cap reading the unfiltered list the banner
    // computes a negative and renders nothing, and with only the banner
    // reading it the cap never activates. Neither is observable alone, and a
    // fixture that separates them cannot be built — `buildTimelineItems`
    // merges consecutive same-kind activities into compact groups, so a
    // hundred shell commands collapse well below the cap. The invariant that
    // matters is that both read the same list, so that is what is pinned.
    const source = readFileSync(join(__dirname, 'ActivityStack.tsx'), 'utf8')
    const capAt = source.indexOf('const collapseCapActive =')
    const bannerAt = source.indexOf('const hiddenTimelineItemCount =')
    expect(capAt).toBeGreaterThan(-1)
    expect(bannerAt).toBeGreaterThan(capAt)
    const capBlock = source.slice(capAt, source.indexOf('\n\n', capAt))
    const bannerBlock = source.slice(bannerAt, source.indexOf('\n\n', bannerAt))
    expect(capBlock).toContain('viewFilteredTimelineItems.length')
    expect(bannerBlock).toContain('viewFilteredTimelineItems.length')
    expect(capBlock).not.toContain('timelineItems.length >')
    expect(bannerBlock).not.toContain('? timelineItems.length')
  })
})
