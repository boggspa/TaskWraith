import { describe, expect, it } from 'vitest'
import type { ComposerStyle } from '../../../main/store/types'
import { composerGitActionUsesCommitIcon } from './composerGitActionIcon'

describe('composerGitActionUsesCommitIcon', () => {
  it('enables commit icon actions for requested shell styles', () => {
    const iconStyles: ComposerStyle[] = [
      'default',
      'codex',
      'grok',
      'gemini',
      'kimi',
      'modular',
      'terminal',
      'stub',
      'satellite',
      'obsidian',
      'alabaster'
    ]

    for (const style of iconStyles) {
      expect(composerGitActionUsesCommitIcon(style), style).toBe(true)
    }
  })

  it('keeps Claude and Cursor as text actions', () => {
    expect(composerGitActionUsesCommitIcon('claude')).toBe(false)
    expect(composerGitActionUsesCommitIcon('cursor')).toBe(false)
  })
})
