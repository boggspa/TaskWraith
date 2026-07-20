import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const composerSource = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')

describe('Composer permission / tool-grant admission while running', () => {
  it('does not disable the permission + tool-grant picker solely because the solo composer is locked', () => {
    const marker =
      'const handleToggleGrantForPicker = ('
    const start = composerSource.indexOf(marker)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = composerSource.indexOf('onToggleGrant={handleToggleGrantForPicker}', start)
    expect(end).toBeGreaterThan(start)
    const region = composerSource.slice(start, end)

    // The picker may still disable for unavailable providers / Gemini trust,
    // but a live solo run must not freeze tool-grant overrides.
    expect(region).toContain('const pickerDisabled =')
    expect(region).not.toMatch(/const pickerDisabled =\s*[\s\S]*isCurrentComposerLocked/)
    expect(region).toContain('providerRunUnavailableReason(effectiveProvider)')
  })
})
