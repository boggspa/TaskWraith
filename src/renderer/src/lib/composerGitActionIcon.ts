import type { ComposerStyle } from '../../../main/store/types'

const COMPOSER_GIT_ACTION_ICON_STYLES = new Set<ComposerStyle>([
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
])

export function composerGitActionUsesCommitIcon(
  composerStyle: ComposerStyle | null | undefined
): boolean {
  return Boolean(composerStyle && COMPOSER_GIT_ACTION_ICON_STYLES.has(composerStyle))
}
