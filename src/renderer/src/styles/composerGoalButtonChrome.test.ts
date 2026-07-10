import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const composerSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/Composer.tsx'),
  'utf8'
)
const goalStart = composerSource.indexOf('className={`composer-goal-popover shell-')
const goalEnd = composerSource.indexOf('<ComposerPlanPopoverButton', goalStart)
const goalMarkup = composerSource.slice(goalStart, goalEnd)
const goalCss = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/03-composer-welcome-activity.css'),
  'utf8'
)

function occurrences(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length || 0
}

describe('composer goal button chrome', () => {
  it('uses shared compact PillButton variants for every goal action', () => {
    expect(goalStart).toBeGreaterThan(-1)
    expect(goalEnd).toBeGreaterThan(goalStart)
    expect(occurrences(goalMarkup, /<PillButton\b/g)).toBe(8)
    expect(occurrences(goalMarkup, /size="compact"/g)).toBe(8)
    expect(occurrences(goalMarkup, /variant="primary"/g)).toBe(2)
    expect(occurrences(goalMarkup, /variant="secondary"/g)).toBe(5)
    expect(occurrences(goalMarkup, /variant="danger"/g)).toBe(1)
    expect(goalMarkup).not.toContain('composer-goal-action')
  })

  it('keeps goal action layout without reviving bespoke button chrome', () => {
    expect(goalCss).toContain('.composer-goal-popover-actions')
    expect(goalCss).toMatch(
      /\.composer-goal-popover \.segmented-control-action--primary\s*\{[\s\S]*?var\(--accent\) 38%[\s\S]*?var\(--accent\) 10%[\s\S]*?var\(--accent\) 18%/
    )
    expect(goalCss).not.toMatch(/\.composer-goal-action(?:[\s.{:#]|$)/)
  })
})
