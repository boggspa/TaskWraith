import { describe, expect, it } from 'vitest'
import {
  buildCompactGroupLabel,
  buildCompactGroupTargetSummary,
  buildTimelineSegments,
  buildTimelineItems
} from './ActivityStack'
import type { ToolActivity } from '../../../main/store/types'

/*
 * 1.0.74 — Same-tool timeline grouping (unified single + ensemble).
 *
 * `buildTimelineItems` collapses runs of 2+ CONSECUTIVE terminal
 * activities of the SAME family (read / write / shell / search /
 * task) into one expandable `compact-group`; clicking the group
 * reveals every call in the run (Codex/Claude-style). A family change
 * breaks the run, so distinct tools never merge into a vague blob.
 * Errors, running, pending and `ensemble_yield` stay inline. Both
 * single-provider and ensemble chats use this exact behaviour — there
 * is no per-mode split (the old `collapseAllTerminal` option is gone).
 */

function activity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: `a-${Math.random().toString(36).slice(2, 8)}`,
    toolName: 'edit',
    displayName: 'edit',
    category: 'write',
    status: 'success',
    ...overrides
  } as ToolActivity
}

describe('buildTimelineItems — same-tool grouping (unified single + ensemble)', () => {
  it('groups 2+ consecutive same-family activities into a compact group', () => {
    const acts: ToolActivity[] = [
      activity({ id: 'r1', category: 'read', toolName: 'read_file' }),
      activity({ id: 'r2', category: 'read', toolName: 'read_file' }),
      activity({ id: 'r3', category: 'read', toolName: 'read_file' })
    ]
    const items = buildTimelineItems(acts)
    expect(items.length).toBe(1)
    expect(items[0].type).toBe('compact-group')
  })

  it('keeps compact-group identity stable when a same-family run appends another call', () => {
    const firstPair = buildTimelineItems([
      activity({ id: 'r1', category: 'read', toolName: 'read_file' }),
      activity({ id: 'r2', category: 'read', toolName: 'read_file' })
    ])
    const appended = buildTimelineItems([
      activity({ id: 'r1', category: 'read', toolName: 'read_file' }),
      activity({ id: 'r2', category: 'read', toolName: 'read_file' }),
      activity({ id: 'r3', category: 'read', toolName: 'read_file' })
    ])

    expect(firstPair[0]).toMatchObject({ type: 'compact-group', id: 'compact-r1' })
    expect(appended[0]).toMatchObject({ type: 'compact-group', id: 'compact-r1' })
  })

  it('now groups consecutive writes too (consistent with reads — were inline before)', () => {
    const acts: ToolActivity[] = [
      activity({ id: 'w1', category: 'write' }),
      activity({ id: 'w2', category: 'write' }),
      activity({ id: 'w3', category: 'write' })
    ]
    const items = buildTimelineItems(acts)
    expect(items.length).toBe(1)
    expect(items[0].type).toBe('compact-group')
  })

  it('breaks a group at a family boundary (read-run, lone write, lone read)', () => {
    const acts: ToolActivity[] = [
      activity({ id: 'r1', category: 'read', toolName: 'read_file' }),
      activity({ id: 'r2', category: 'read', toolName: 'read_file' }),
      activity({ id: 'w1', category: 'write' }),
      activity({ id: 'r3', category: 'read', toolName: 'read_file' })
    ]
    const items = buildTimelineItems(acts)
    expect(items.map((i) => i.type)).toEqual(['compact-group', 'activity', 'activity'])
  })

  it('does NOT merge different consecutive families into one blob', () => {
    const acts: ToolActivity[] = [
      activity({ id: 'r1', category: 'read', toolName: 'read_file' }),
      activity({ id: 'w1', category: 'write' }),
      activity({ id: 's1', category: 'shell' }),
      activity({ id: 't1', category: 'task' })
    ]
    const items = buildTimelineItems(acts)
    expect(items.map((i) => i.type)).toEqual(['activity', 'activity', 'activity', 'activity'])
  })

  it('separates read and search into distinct same-family groups', () => {
    const acts: ToolActivity[] = [
      activity({ id: 'r1', category: 'read', toolName: 'read_file' }),
      activity({ id: 'r2', category: 'read', toolName: 'read_file' }),
      activity({ id: 's1', category: 'search', toolName: 'grep' }),
      activity({ id: 's2', category: 'search', toolName: 'grep' })
    ]
    const items = buildTimelineItems(acts)
    expect(items.map((i) => i.type)).toEqual(['compact-group', 'compact-group'])
  })

  it('keeps a solitary same-family activity inline (min-2)', () => {
    const acts: ToolActivity[] = [activity({ id: 'w1', category: 'write' })]
    const items = buildTimelineItems(acts)
    expect(items.map((i) => i.type)).toEqual(['activity'])
  })

  it('leaves the currently-running activity inline; collapses the prior same-family run', () => {
    const acts: ToolActivity[] = [
      activity({ id: 'r1', category: 'read', toolName: 'read_file' }),
      activity({ id: 'r2', category: 'read', toolName: 'read_file' }),
      activity({ id: 'live', category: 'read', toolName: 'read_file', status: 'running' })
    ]
    const items = buildTimelineItems(acts)
    expect(items.length).toBe(2)
    expect(items[0].type).toBe('compact-group')
    expect(items[1].type).toBe('activity')
    if (items[1].type === 'activity') expect(items[1].activity.id).toBe('live')
  })

  it('keeps errors inline between same-family groups', () => {
    const acts: ToolActivity[] = [
      activity({ id: 'r1', category: 'read', toolName: 'read_file' }),
      activity({ id: 'r2', category: 'read', toolName: 'read_file' }),
      activity({ id: 'err', category: 'read', toolName: 'read_file', status: 'error' }),
      activity({ id: 'r3', category: 'read', toolName: 'read_file' }),
      activity({ id: 'r4', category: 'read', toolName: 'read_file' })
    ]
    const items = buildTimelineItems(acts)
    expect(items.map((i) => i.type)).toEqual(['compact-group', 'activity', 'compact-group'])
    if (items[1].type === 'activity') expect(items[1].activity.id).toBe('err')
  })

  it('keeps pending activities inline', () => {
    const acts: ToolActivity[] = [
      activity({ id: 'r1', category: 'read', toolName: 'read_file' }),
      activity({ id: 'r2', category: 'read', toolName: 'read_file' }),
      activity({ id: 'pend', category: 'write', status: 'pending' })
    ]
    const items = buildTimelineItems(acts)
    expect(items.map((i) => i.type)).toEqual(['compact-group', 'activity'])
    if (items[1].type === 'activity') expect(items[1].activity.id).toBe('pend')
  })

  it('produces an empty timeline for empty input', () => {
    expect(buildTimelineItems([])).toEqual([])
  })

  it('keeps ensemble_yield activities inline (social-glue exception, all alias forms)', () => {
    const yields: ToolActivity[] = [
      activity({ id: 'y1', toolName: 'ensemble_yield', category: 'task' }),
      activity({ id: 'y2', toolName: 'mcp_TaskWraith_ensemble_yield', category: 'task' }),
      activity({ id: 'y3', toolName: 'mcp__TaskWraith__ensemble_yield', category: 'task' })
    ]
    const items = buildTimelineItems(yields)
    expect(items.length).toBe(3)
    expect(items.every((i) => i.type === 'activity')).toBe(true)
  })

  it('separates an inline ensemble_yield from surrounding same-family groups', () => {
    const acts: ToolActivity[] = [
      activity({ id: 'r1', category: 'read', toolName: 'read_file' }),
      activity({ id: 'r2', category: 'read', toolName: 'read_file' }),
      activity({ id: 'y1', toolName: 'ensemble_yield', category: 'task', status: 'success' }),
      activity({ id: 'r3', category: 'read', toolName: 'read_file' }),
      activity({ id: 'r4', category: 'read', toolName: 'read_file' })
    ]
    const items = buildTimelineItems(acts)
    expect(items.map((i) => i.type)).toEqual(['compact-group', 'activity', 'compact-group'])
    if (items[1].type === 'activity') expect(items[1].activity.id).toBe('y1')
  })

  it('does NOT merge same-family calls from DIFFERENT ensemble providers (keeps attribution)', () => {
    const acts: ToolActivity[] = [
      activity({ id: 'a', category: 'write', metadata: { ensembleProvider: 'codex' } }),
      activity({ id: 'b', category: 'write', metadata: { ensembleProvider: 'claude' } })
    ]
    const items = buildTimelineItems(acts)
    expect(items.map((i) => i.type)).toEqual(['activity', 'activity'])
  })

  it('groups a same-family run from the SAME ensemble provider', () => {
    const acts: ToolActivity[] = [
      activity({ id: 'a', category: 'write', metadata: { ensembleProvider: 'codex' } }),
      activity({ id: 'b', category: 'write', metadata: { ensembleProvider: 'codex' } })
    ]
    const items = buildTimelineItems(acts)
    expect(items.length).toBe(1)
    expect(items[0].type).toBe('compact-group')
  })

  it('keeps reasoning-name thinking traces inline instead of compacting them as task tools', () => {
    const acts: ToolActivity[] = [
      activity({ id: 'think-1', category: 'task', toolName: 'grok_thinking', displayName: 'Thinking' }),
      activity({ id: 'think-2', category: 'task', toolName: 'kimi_reasoning', displayName: 'Reasoning' })
    ]

    const items = buildTimelineItems(acts)
    expect(items.map((i) => i.type)).toEqual(['activity', 'activity'])
  })

  it('keeps display-name-only thinking traces inline', () => {
    const acts: ToolActivity[] = [
      activity({ id: 'think-1', category: 'task', toolName: 'Task', displayName: 'Kimi Thinking' }),
      activity({ id: 'think-2', category: 'task', toolName: 'Task', displayName: 'Claude Reasoning' })
    ]

    const items = buildTimelineItems(acts)
    expect(items.map((i) => i.type)).toEqual(['activity', 'activity'])
  })

  it('uses a thinking trace as a boundary between task tool groups', () => {
    const acts: ToolActivity[] = [
      activity({ id: 't1', category: 'task', toolName: 'plan' }),
      activity({ id: 't2', category: 'task', toolName: 'plan' }),
      activity({ id: 'think', category: 'task', toolName: 'codex_thinking', displayName: 'Thinking' }),
      activity({ id: 't3', category: 'task', toolName: 'plan' }),
      activity({ id: 't4', category: 'task', toolName: 'plan' })
    ]

    const items = buildTimelineItems(acts)
    expect(items.map((i) => i.type)).toEqual(['compact-group', 'activity', 'compact-group'])
    if (items[1].type === 'activity') expect(items[1].activity.id).toBe('think')
  })

  it('splits interleaved thinking traces into separate viewport segments', () => {
    const items = buildTimelineItems([
      activity({ id: 't1', category: 'task', toolName: 'plan' }),
      activity({ id: 't2', category: 'task', toolName: 'plan' }),
      activity({ id: 'think', category: 'task', toolName: 'codex_thinking', displayName: 'Thinking' }),
      activity({ id: 't3', category: 'task', toolName: 'plan' }),
      activity({ id: 't4', category: 'task', toolName: 'plan' })
    ])
    const segments = buildTimelineSegments(items)

    expect(segments.map((segment) => segment.kind)).toEqual(['tools', 'thinking', 'tools'])
    expect(segments.map((segment) => segment.activities.map((a) => a.id))).toEqual([
      ['t1', 't2'],
      ['think'],
      ['t3', 't4']
    ])
  })

  it('keeps consecutive thinking traces together but separate from tools', () => {
    const items = buildTimelineItems([
      activity({ id: 'read-1', category: 'read', toolName: 'read_file' }),
      activity({ id: 'read-2', category: 'read', toolName: 'read_file' }),
      activity({ id: 'think-1', category: 'task', toolName: 'codex_thinking', displayName: 'Thinking' }),
      activity({ id: 'think-2', category: 'task', toolName: 'kimi_reasoning', displayName: 'Reasoning' })
    ])
    const segments = buildTimelineSegments(items)

    expect(segments.map((segment) => segment.kind)).toEqual(['tools', 'thinking'])
    expect(segments[1].activities.map((activity) => activity.id)).toEqual(['think-1', 'think-2'])
  })
})

/*
 * buildCompactGroupLabel is UNCHANGED — same-family groups resolve to
 * a single-family label ("Read 3 files", "Edited 2 files"), and the
 * function still defensively handles heterogeneous inputs.
 */
describe('buildCompactGroupLabel', () => {
  it('keeps the descriptive read+search phrasing for pure read/search groups', () => {
    expect(
      buildCompactGroupLabel([
        activity({ id: 'r1', category: 'read', toolName: 'read_file' }),
        activity({ id: 'r2', category: 'read', toolName: 'read_file' }),
        activity({ id: 'r3', category: 'read', toolName: 'read_file' })
      ])
    ).toBe('Read 3 files')

    expect(
      buildCompactGroupLabel([
        activity({ id: 's1', category: 'search', toolName: 'grep' }),
        activity({ id: 's2', category: 'search', toolName: 'grep' })
      ])
    ).toBe('Searched 2 times')

    expect(
      buildCompactGroupLabel([
        activity({ id: 'r1', category: 'read', toolName: 'read_file' }),
        activity({ id: 's1', category: 'search', toolName: 'grep' })
      ])
    ).toBe('Read 1 file and searched 1 time')
  })

  it('emits "Edited N files" for write-heavy heterogeneous groups', () => {
    expect(
      buildCompactGroupLabel([
        activity({ id: 'w1', category: 'write', toolName: 'edit' }),
        activity({ id: 'w2', category: 'write', toolName: 'edit' }),
        activity({ id: 'w3', category: 'write', toolName: 'edit' }),
        activity({ id: 's1', category: 'shell', toolName: 'bash' })
      ])
    ).toBe('Edited 3 files (+1 more)')
  })

  it('emits "Ran N commands" for shell-heavy heterogeneous groups', () => {
    expect(
      buildCompactGroupLabel([
        activity({ id: 's1', category: 'shell', toolName: 'bash' }),
        activity({ id: 's2', category: 'shell', toolName: 'bash' })
      ])
    ).toBe('Ran 2 commands')
  })

  it('emits "Completed N tasks" for task-heavy heterogeneous groups', () => {
    expect(
      buildCompactGroupLabel([
        activity({ id: 't1', category: 'task', toolName: 'plan' }),
        activity({ id: 't2', category: 'task', toolName: 'plan' }),
        activity({ id: 'w1', category: 'write', toolName: 'edit' })
      ])
    ).toBe('Completed 2 tasks (+1 more)')
  })

  it('uses singular phrasing for count === 1', () => {
    expect(
      buildCompactGroupLabel([
        activity({ id: 'w1', category: 'write', toolName: 'edit' }),
        activity({ id: 's1', category: 'shell', toolName: 'bash' })
      ])
    ).toBe('Edited 1 file (+1 more)')
  })

  it('falls back to "Used N tools" when no activity has a categorisable kind', () => {
    expect(
      buildCompactGroupLabel([
        activity({ id: 'u1', category: 'unknown', toolName: 'x' }),
        activity({ id: 'u2', category: 'unknown', toolName: 'y' })
      ])
    ).toBe('Used 2 tools')
  })

  it('picks the highest-count category as the dominant label', () => {
    expect(
      buildCompactGroupLabel([
        activity({ id: 'r1', category: 'read', toolName: 'read_file' }),
        activity({ id: 'r2', category: 'read', toolName: 'read_file' }),
        activity({ id: 'r3', category: 'read', toolName: 'read_file' }),
        activity({ id: 'w1', category: 'write', toolName: 'edit' }),
        activity({ id: 'w2', category: 'write', toolName: 'edit' }),
        activity({ id: 's1', category: 'shell', toolName: 'bash' })
      ])
    ).toBe('Read 3 files (+3 more)')
  })
})

describe('buildCompactGroupTargetSummary', () => {
  it('labels repeated reads of the same file as one updated target', () => {
    const summary = buildCompactGroupTargetSummary([
      activity({
        id: 'r1',
        category: 'read',
        toolName: 'read_file',
        parameters: { file_path: '/repo/src/App.tsx' }
      }),
      activity({
        id: 'r2',
        category: 'read',
        toolName: 'read_file',
        parameters: { file_path: '/repo/src/App.tsx' }
      }),
      activity({
        id: 'r3',
        category: 'read',
        toolName: 'read_file',
        parameters: { file_path: '/repo/src/App.tsx' }
      })
    ])

    expect(summary).toMatchObject({
      label: 'Read App.tsx',
      hasRepeatTargets: true,
      overflowCount: 0,
      chips: [{ label: 'App.tsx', repeatCount: 3 }]
    })
  })

  it('summarizes repeated reads across multiple files without reordering activities', () => {
    const summary = buildCompactGroupTargetSummary([
      activity({
        id: 'r1',
        category: 'read',
        toolName: 'read_file',
        parameters: { file_path: '/repo/src/App.tsx' }
      }),
      activity({
        id: 'r2',
        category: 'read',
        toolName: 'read_file',
        parameters: { file_path: '/repo/src/App.tsx' }
      }),
      activity({
        id: 'r3',
        category: 'read',
        toolName: 'read_file',
        parameters: { file_path: '/repo/src/Composer.tsx' }
      }),
      activity({
        id: 'r4',
        category: 'read',
        toolName: 'read_file',
        parameters: { file_path: '/repo/src/Composer.tsx' }
      })
    ])

    expect(summary.label).toBe('Read 4 times across 2 files')
    expect(summary.overflowCount).toBe(0)
    expect(summary.chips.map((chip) => [chip.label, chip.repeatCount])).toEqual([
      ['App.tsx', 2],
      ['Composer.tsx', 2]
    ])
  })

  it('labels repeated edits of the same file as one updated target', () => {
    const summary = buildCompactGroupTargetSummary([
      activity({
        id: 'w1',
        category: 'write',
        toolName: 'edit_file',
        parameters: { file_path: '/repo/src/ActivityStack.tsx' }
      }),
      activity({
        id: 'w2',
        category: 'write',
        toolName: 'edit_file',
        parameters: { file_path: '/repo/src/ActivityStack.tsx' }
      })
    ])

    expect(summary.label).toBe('Edited ActivityStack.tsx')
    expect(summary.chips).toMatchObject([{ label: 'ActivityStack.tsx', repeatCount: 2 }])
  })

  it('does not coalesce move or rename path roles into a fake single file target', () => {
    const summary = buildCompactGroupTargetSummary([
      activity({
        id: 'm1',
        category: 'write',
        toolName: 'move_path',
        parameters: { source: '/repo/src/a.ts', target: '/repo/src/b.ts' }
      }),
      activity({
        id: 'm2',
        category: 'write',
        toolName: 'move_path',
        parameters: { source: '/repo/src/b.ts', target: '/repo/src/a.ts' }
      })
    ])

    expect(summary.hasRepeatTargets).toBe(false)
    expect(summary.label).toBe('Edited 2 files')
  })

  it('does not coalesce a partial target set into a misleading repeated-file label', () => {
    const summary = buildCompactGroupTargetSummary([
      activity({
        id: 'r1',
        category: 'read',
        toolName: 'read_file',
        parameters: { file_path: '/repo/src/App.tsx' }
      }),
      activity({
        id: 'r2',
        category: 'read',
        toolName: 'read_file',
        parameters: { file_path: '/repo/src/App.tsx' }
      }),
      activity({
        id: 'r3',
        category: 'read',
        toolName: 'list_directory',
        parameters: { directory: '/repo/src' }
      })
    ])

    expect(summary.hasRepeatTargets).toBe(false)
    expect(summary.label).toBe('Read 3 files')
  })

  it('treats identical shell commands in different working directories as distinct', () => {
    const summary = buildCompactGroupTargetSummary([
      activity({
        id: 's1',
        category: 'shell',
        toolName: 'run_shell_command',
        parameters: { command: 'npm test', cwd: '/repo/a' }
      }),
      activity({
        id: 's2',
        category: 'shell',
        toolName: 'run_shell_command',
        parameters: { command: 'npm test', cwd: '/repo/b' }
      })
    ])

    expect(summary.hasRepeatTargets).toBe(false)
    expect(summary.label).toBe('Ran 2 commands')
  })

  it('coalesces exact repeated shell commands in the same working directory', () => {
    const summary = buildCompactGroupTargetSummary([
      activity({
        id: 's1',
        category: 'shell',
        toolName: 'run_shell_command',
        parameters: { command: 'npm test', cwd: '/repo' }
      }),
      activity({
        id: 's2',
        category: 'shell',
        toolName: 'run_shell_command',
        parameters: { command: 'npm test', cwd: '/repo' }
      })
    ])

    expect(summary.label).toBe('Ran npm test')
    expect(summary.chips).toMatchObject([{ label: 'npm test', repeatCount: 2 }])
  })
})
