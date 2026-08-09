import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', file), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('run-complete commit table CSS', () => {
  it('renders commit hashes as bold primary-theme text', () => {
    const css = readCss('04-settings-controls.css')
    const hash = cssBlockStartingAt(css, '.run-complete-epic-hash code {')

    expect(hash).toContain('color: var(--text-primary)')
    expect(hash).toContain('font-weight: 700')
  })

  it('keeps commit diff counts wired to the user appearance colors', () => {
    const css = readCss('07-composer-shells.css')
    const additions = cssBlockStartingAt(css, '.composer-diff-add {')
    const deletions = cssBlockStartingAt(css, '.composer-diff-del {')

    expect(additions).toContain('color: var(--diff-stat-add-color, #2db777)')
    expect(deletions).toContain('color: var(--diff-stat-del-color, #ec3d35)')
  })
})
