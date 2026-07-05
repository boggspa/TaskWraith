import { describe, expect, it } from 'vitest'
import { buildCompactGroupLabel, buildTimelineItems } from './ActivityStack'
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
