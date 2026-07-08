import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (path: string): string =>
  readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n')

const cssBlockStartingAt = (source: string, marker: string): string => {
  const start = source.indexOf(marker)
  expect(start, `Missing marker: ${marker}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for marker: ${marker}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('squished composer pane CSS', () => {
  it('uses composer pane width to hide low-priority git and timecode text', () => {
    const css = readCss('src/renderer/src/assets/css/03-composer-welcome-activity.css')

    const composerAreaBlock = cssBlockStartingAt(css, ':where(.app-transcript) .composer-area {')
    expect(composerAreaBlock).toContain('container-type: inline-size')

    const narrowBlockStart = css.indexOf('@container (max-width: 620px) {')
    expect(narrowBlockStart).toBeGreaterThanOrEqual(0)
    const narrowBlock = css.slice(
      narrowBlockStart,
      css.indexOf('\n}\n\n.composer-scheduler-controls', narrowBlockStart) + 3
    )

    expect(narrowBlock).toContain('.composer-diff-action-menu-wrap')
    expect(narrowBlock).toContain('display: none')
    expect(narrowBlock).toContain('.composer-telemetry-row .composer-run-timecode')
    expect(narrowBlock).toContain('min-width: 0')
    expect(narrowBlock).toContain('.composer-timecode-value')
  })

  it('hides roster row labels and the shared-history slider at the same pane width', () => {
    const css = readCss('src/renderer/src/assets/css/09-ensemble-work-session.css')
    const narrowBlockStart = css.indexOf('@container (max-width: 620px) {')
    expect(narrowBlockStart).toBeGreaterThanOrEqual(0)
    const narrowBlock = css.slice(
      narrowBlockStart,
      css.indexOf('\n}\n\n/* Roster-presets', narrowBlockStart) + 3
    )

    expect(narrowBlock).toContain('.composer-orchestration-cell-label')
    expect(narrowBlock).toContain('.composer-orchestration-cell-history')
    expect(narrowBlock).toContain('display: none')
    expect(narrowBlock).toContain(
      '.ensemble-roster-preset-picker.is-compact .composer-ensemble-orchestration-row'
    )
  })
})
