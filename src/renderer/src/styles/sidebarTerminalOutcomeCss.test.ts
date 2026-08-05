import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(process.cwd(), 'src/renderer/src/assets/css/01-sidebar.css'), 'utf8')

function cssBlockStartingAt(selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) return ''
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(start, close + 1)
}

describe('sidebar terminal outcome title accent', () => {
  it('uses appearance diff colors and one slow seamless shimmer on title ink only', () => {
    expect(cssBlockStartingAt('.app-sidebar .sidebar-terminal-outcome-success {')).toContain(
      'var(--diff-stat-add-color, #2db777)'
    )
    expect(cssBlockStartingAt('.app-sidebar .sidebar-terminal-outcome-failure {')).toContain(
      'var(--diff-stat-del-color, #ec3d35)'
    )
    // The waiting tone is amber, not a third Appearance colour — Settings
    // exposes only the two diff hues.
    expect(cssBlockStartingAt('.app-sidebar .sidebar-attention-waiting {')).toContain(
      'var(--tool-warning, #f5a623)'
    )
    // Sea blue, and the ONLY tone with an explicit light-mode value: a blue
    // bright enough for dark chrome washes out on the light sidebar's white.
    // The pair is contrast-balanced (7.9:1 dark / 7.0:1 light), not merely
    // passing.
    expect(cssBlockStartingAt('.app-sidebar .sidebar-attention-sleeping {')).toContain('#57b6d9')
    expect(css.replace(/\s+/g, ' ')).toContain(
      "[data-theme='sage']) .app-sidebar .sidebar-attention-sleeping { --sidebar-terminal-outcome-color: #15607a;"
    )

    // All three tones share ONE sweep — the two settled outcomes and the live
    // waiting state — so the ink block is keyed on the whole selector list.
    const ink = cssBlockStartingAt(
      '.app-sidebar\n  :is(\n    .sidebar-terminal-outcome-success,\n    .sidebar-terminal-outcome-failure,\n    .sidebar-attention-waiting,\n    .sidebar-attention-sleeping\n  )'
    )
    expect(ink).not.toBe('')
    expect(ink).toContain('background-clip: text')
    expect(ink).toContain('background-size: 300% 100%')
    expect(ink).toContain('background-repeat: no-repeat')
    expect(ink).toContain('animation: sidebar-terminal-outcome-shimmer 10s linear infinite')
    expect(ink).toContain('var(--text-primary) 52%')
    expect(ink).toContain('var(--sidebar-terminal-outcome-color) 28%')
    expect(ink).not.toContain('text-shimmer-sweep')
    expect(css).toContain('@keyframes sidebar-terminal-outcome-shimmer')
    expect(css).toContain('background-position: 0% 0')
    expect(css).toContain('background-position: 100% 0')
    expect(ink).not.toMatch(/\b(border|border-radius|padding|box-shadow)\s*:/)
  })

  it('keeps the outcome color while disabling the sweep for both motion controls', () => {
    const compactCss = css.replace(/\s+/g, ' ')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(compactCss).toContain(
      ":root[data-reduce-motion='true'] .app-sidebar :is( .sidebar-terminal-outcome-success, .sidebar-terminal-outcome-failure, .sidebar-attention-waiting, .sidebar-attention-sleeping )"
    )
    expect(css).toContain('-webkit-text-fill-color: var(--sidebar-terminal-outcome-color)')
  })
})
