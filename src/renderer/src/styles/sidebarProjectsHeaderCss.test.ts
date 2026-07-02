import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/08-theme-picker-overrides.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('sidebar Projects header CSS', () => {
  it('includes the Projects tab header in the glass section-title treatment', () => {
    const css = readCss()

    const resetBlock = cssBlockStartingAt(
      css,
      '.app-sidebar .sidebar-workspace-scroll .sidebar-section-header,'
    )
    const titleBlock = cssBlockStartingAt(
      css,
      '.app-sidebar .sidebar-active-runs-section .sidebar-section-title,'
    )
    const nativeTitleBlock = cssBlockStartingAt(
      css,
      '[data-appearance="native_glass"][data-reduce-transparency="false"] .app-sidebar .sidebar-active-runs-section .sidebar-section-title,'
    )

    expect(resetBlock).toContain('.app-sidebar .sidebar-projects-view .sidebar-section-header')
    expect(titleBlock).toContain('.app-sidebar .sidebar-projects-header .sidebar-section-title')
    expect(titleBlock).toContain('font-family:')
    expect(titleBlock).toContain('text-transform: none')
    expect(titleBlock).toContain('border-radius: var(--composer-bubble-radius, 18px)')
    expect(nativeTitleBlock).toContain(
      '[data-appearance="native_glass"][data-reduce-transparency="false"] .app-sidebar .sidebar-projects-header .sidebar-section-title'
    )
  })
})
