import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readRepoFile = (relativePath: string): string =>
  readFileSync(join(process.cwd(), relativePath), 'utf8')

const cssBlockStartingAt = (source: string, selector: string, fromIndex = 0): string => {
  const start = source.indexOf(selector, fromIndex)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('theme pane opacity CSS', () => {
  it('uses the direct main-pane opacity token for base transcript fills', () => {
    const css = readRepoFile('src/renderer/src/assets/css/06-component-panels-modals.css')
    const modelUsageList = css.indexOf('.app-sidebar .model-usage-window-list {')
    expect(modelUsageList).toBeGreaterThanOrEqual(0)

    const baseTranscriptBlock = cssBlockStartingAt(
      css,
      '.app-transcript {',
      modelUsageList
    )
    const nativeTranscriptBlock = cssBlockStartingAt(
      css,
      '[data-appearance="native_glass"][data-reduce-transparency="false"] .app-transcript {',
      css.indexOf(baseTranscriptBlock) + baseTranscriptBlock.length
    )

    expect(baseTranscriptBlock).toContain('--main-pane-opacity-100')
    expect(baseTranscriptBlock).not.toContain('--main-pane-opacity-60')
    expect(nativeTranscriptBlock).toContain('--main-pane-opacity-100')
    expect(nativeTranscriptBlock).not.toContain('--main-pane-opacity-60')
  })

  it('does not cap the Codex or Claude shell transcript floor at 60%', () => {
    const css = readRepoFile('src/renderer/src/assets/css/07-composer-shells.css')

    const shellTranscriptBlock = cssBlockStartingAt(
      css,
      '[data-interface-style="codex"] .app-transcript,'
    )

    expect(shellTranscriptBlock).toContain('--main-pane-opacity-100')
    expect(shellTranscriptBlock).not.toContain('--main-pane-opacity-60')
  })
})
