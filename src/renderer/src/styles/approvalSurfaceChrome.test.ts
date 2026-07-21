import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (file: string): string => readFileSync(join(process.cwd(), file), 'utf8')

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('approval surface chrome', () => {
  it('uses the shared popover material with solid accessibility fallbacks', () => {
    const modalCss = readSource('src/renderer/src/assets/css/08-theme-picker-overrides.css')
    const composerCss = readSource('src/renderer/src/assets/css/03-composer-welcome-activity.css')

    for (const block of [
      cssBlockStartingAt(modalCss, '.creative-approval-modal {'),
      cssBlockStartingAt(composerCss, '.composer-permission-card {')
    ]) {
      expect(block).toContain('var(--tw-popover-glass-bg)')
      expect(block).toContain('blur(18px) saturate(150%)')
    }

    expect(modalCss).toContain(':root[data-reduce-transparency="true"] .creative-approval-modal')
    expect(composerCss).toContain(
      ':root[data-reduce-transparency="true"] .composer-permission-card'
    )
    expect(modalCss).toContain('background: var(--tw-glass-solid)')
    expect(composerCss).toContain('background: var(--tw-glass-solid)')
  })

  it('keeps longer approval scopes visible and responsive', () => {
    const composerSource = readSource('src/renderer/src/components/Composer.tsx')
    const composerCss = readSource('src/renderer/src/assets/css/03-composer-welcome-activity.css')

    expect(composerSource).toContain('className="composer-permission-scope-actions"')
    expect(composerSource).toContain('Allow for session')
    expect(composerSource).toContain('Allow in workspace')
    expect(composerCss).toContain('.composer-permission-actions {')
    expect(composerCss).toContain('flex-wrap: wrap')
    expect(composerCss).toContain('@media (max-width: 620px)')
  })
})
