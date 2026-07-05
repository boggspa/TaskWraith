import { describe, expect, it } from 'vitest'
import {
  buildComposerSlashMenuGroups,
  resolveComposerSlashCommandIcon,
  resolveComposerSlashMenuPlacement
} from './ComposerSlashMenu'
import type { ComposerSlashCommand } from '../lib/ComposerSlashCommands'

describe('ComposerSlashMenu helpers', () => {
  it('sizes the slash menu from the composer surface with a small inset', () => {
    expect(
      resolveComposerSlashMenuPlacement({
        anchorTop: 500,
        surfaceLeft: 100,
        surfaceWidth: 800,
        viewportHeight: 900,
        viewportWidth: 1000
      })
    ).toEqual({
      left: 108,
      maxHeight: 420,
      top: 492,
      width: 784
    })
  })

  it('clamps slash menu width and left edge to narrow viewports', () => {
    expect(
      resolveComposerSlashMenuPlacement({
        anchorTop: 240,
        surfaceLeft: 0,
        surfaceWidth: 500,
        viewportHeight: 360,
        viewportWidth: 300
      })
    ).toEqual({
      left: 8,
      maxHeight: 224,
      top: 232,
      width: 284
    })
  })

  it('resolves command icons from command metadata', () => {
    expect(
      resolveComposerSlashCommandIcon({
        id: 'taskwraith-template-review-diff',
        command: '/review-diff',
        label: 'Review diff',
        description: 'Insert a review-the-current-diff template.',
        group: 'Custom'
      })
    ).toBe('review')

    expect(
      resolveComposerSlashCommandIcon({
        id: 'core-memory-refresh',
        command: '/memory refresh',
        label: 'Refresh memory',
        description: 'Reload memory from GEMINI.md files.',
        group: 'Memory'
      })
    ).toBe('memory')

    expect(
      resolveComposerSlashCommandIcon({
        id: 'universal-fork',
        command: '/fork',
        label: 'Fork thread',
        description: 'Fork the linked Codex thread.',
        group: 'Discovery'
      })
    ).toBe('branch')

    expect(
      resolveComposerSlashCommandIcon({
        id: 'taskwraith-screen',
        command: '/screen',
        label: 'Attach screen watch',
        description: 'Toggle the app/window screen watch attachment.',
        group: 'Custom'
      })
    ).toBe('screen')
  })

  it('keeps hierarchical child commands hidden until expanded', () => {
    const commands = compactHierarchyCommands()

    const collapsed = buildComposerSlashMenuGroups(commands, '', [])
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].rows.map((row) => row.command.command)).toEqual(['/compact'])
    expect(collapsed[0].rows[0]).toMatchObject({
      depth: 0,
      hasChildren: true,
      isExpanded: false
    })

    const expanded = buildComposerSlashMenuGroups(commands, '', ['compact'])
    expect(expanded[0].rows.map((row) => [row.command.command, row.depth])).toEqual([
      ['/compact', 0],
      ['/compact-shared', 1],
      ['/compact-selected', 1]
    ])
  })

  it('reveals matching child commands during search with their parent context', () => {
    const groups = buildComposerSlashMenuGroups(compactHierarchyCommands(), 'selected', [])

    expect(groups).toHaveLength(1)
    expect(groups[0].rows.map((row) => [row.command.command, row.depth])).toEqual([
      ['/compact', 0],
      ['/compact-selected', 1]
    ])
    expect(groups[0].rows[0].isExpanded).toBe(true)
  })
})

function compactHierarchyCommands(): ComposerSlashCommand[] {
  return [
    {
      kind: 'action',
      id: 'compact',
      command: '/compact',
      label: 'Compact context',
      description: 'Insert a context-summary request.',
      group: 'Custom',
      run: () => undefined
    },
    {
      kind: 'action',
      id: 'compact-shared',
      parentId: 'compact',
      command: '/compact-shared',
      label: 'Shared ensemble context',
      description: 'Insert a shared ensemble context summary request.',
      group: 'Custom',
      run: () => undefined
    },
    {
      kind: 'action',
      id: 'compact-selected',
      parentId: 'compact',
      command: '/compact-selected',
      label: 'Selected participant context',
      description: 'Insert a selected participant context summary request.',
      group: 'Custom',
      run: () => undefined
    }
  ]
}
