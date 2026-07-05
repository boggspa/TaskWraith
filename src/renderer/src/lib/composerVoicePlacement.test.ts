import { describe, expect, it } from 'vitest'
import type { ComposerStyle } from '../../../main/store/types'
import { composerVoicePlacementForStyle } from './composerVoicePlacement'

describe('composerVoicePlacementForStyle', () => {
  it('places missing shell microphones between context and send in the action row', () => {
    const styles: ComposerStyle[] = ['default', 'grok', 'kimi', 'terminal', 'stub', 'satellite']

    expect(styles.map((style) => [style, composerVoicePlacementForStyle(style)])).toEqual([
      ['default', 'action-row'],
      ['grok', 'action-row'],
      ['kimi', 'action-row'],
      ['terminal', 'action-row'],
      ['stub', 'action-row'],
      ['satellite', 'action-row']
    ])
  })

  it('preserves the existing placements for shells that already had voice controls', () => {
    const permissionStyles: ComposerStyle[] = [
      'claude',
      'gemini',
      'cursor',
      'modular',
      'obsidian',
      'alabaster'
    ]

    for (const style of permissionStyles) {
      expect(composerVoicePlacementForStyle(style)).toBe('permissions')
    }
    expect(composerVoicePlacementForStyle('codex')).toBe('send-cluster')
  })
})
