import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', file), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

// Comments are stripped so the declaration assertions below read declarations
// only — prose that happens to name a property must not stand in for one.
const declarationsOf = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1).replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('inline user-message editor width', () => {
  it('stretches the editing bubble across the prompt column', () => {
    // Without an explicit width the bubble is shrink-to-fit around the
    // textarea's default 20-column intrinsic size, so the editor opened at
    // roughly half the width of the prompt it replaced.
    const block = declarationsOf(readCss('rewind-feature.css'), '.message-bubble.user.is-editing {')

    expect(block).toContain('width: 100%')
  })

  it('inherits the prompt-bubble cap instead of declaring its own', () => {
    // `width: 100%` only matches an ordinary prompt because the shared
    // `.message-bubble.user` cap still clamps it — including the 92% it
    // widens to under the 760px breakpoint. A local max-width here would
    // silently fork the editor away from the prompt it edits.
    const editing = declarationsOf(
      readCss('rewind-feature.css'),
      '.message-bubble.user.is-editing {'
    )
    const shared = declarationsOf(readCss('04-settings-controls.css'), '\n.message-bubble.user {')

    expect(editing).not.toContain('max-width')
    expect(shared).toContain('max-width: min(76%, 820px)')
  })
})
