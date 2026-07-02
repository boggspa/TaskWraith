import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/02-transcript-messages-fx.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('General Chat composer width CSS', () => {
  it('keeps started General Chat composer shells on the modern width', () => {
    const css = readCss()
    const rootBlock = cssBlockStartingAt(css, '.app-transcript {')
    const globalStartedBlock = cssBlockStartingAt(
      css,
      '.app-transcript.chat-scope-global:not(.welcome-mode) {'
    )

    expect(rootBlock).toContain('--composer-content-max-width: 980px')
    expect(globalStartedBlock).not.toContain('--composer-content-max-width')
  })

  it('keeps the legacy narrower General Chat reading column scoped to transcript content', () => {
    const css = readCss()
    const transcriptBlock = cssBlockStartingAt(
      css,
      '.app-transcript.chat-scope-global:not(.welcome-mode) .transcript-inner {'
    )

    expect(transcriptBlock).toContain('max-width: min(100%, 760px)')
  })
})
