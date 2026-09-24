import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { shouldInvalidateLiveGitSnapshot } from './GitLiveSnapshotInvalidation'

describe('shouldInvalidateLiveGitSnapshot', () => {
  it('does not turn provider output into a Git refresh loop', () => {
    expect(shouldInvalidateLiveGitSnapshot('agent-output')).toBe(false)
    expect(shouldInvalidateLiveGitSnapshot('gemini-output')).toBe(false)
  })

  it('keeps terminal refresh as the final-diff fallback', () => {
    expect(shouldInvalidateLiveGitSnapshot('agent-exit')).toBe(true)
    expect(shouldInvalidateLiveGitSnapshot('gemini-exit')).toBe(true)
  })

  it('keeps the production event sink on the terminal-only gate', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(source).toContain('if (!shouldInvalidateLiveGitSnapshot(event.channel))')
  })
})
