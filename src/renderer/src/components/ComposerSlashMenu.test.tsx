import { describe, expect, it } from 'vitest'
import {
  resolveComposerSlashCommandIcon,
  resolveComposerSlashMenuPlacement
} from './ComposerSlashMenu'

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
        id: 'codex-fork',
        command: '/fork',
        label: 'Fork thread',
        description: 'Fork the linked Codex thread.',
        group: 'Discovery'
      })
    ).toBe('branch')
  })
})
