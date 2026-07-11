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

  it('keeps the transcript surface theme-driven — composer shells never repaint it', () => {
    // The transcript pane is now decoupled from the composer shell: no
    // `[data-interface-style=…] .app-transcript` (or `.app-sidebar` /
    // `.message-bubble`) app-surface repaint survives. The composer shell only
    // styles composer chrome; the reading surface follows the app theme.
    for (const shard of [
      '07-composer-shells.css',
      '08-theme-picker-overrides.css',
      '10-provider-shell-overrides.css'
    ]) {
      const css = readRepoFile(`src/renderer/src/assets/css/${shard}`)
      for (const surface of ['.app-transcript', '.app-sidebar', '.message-bubble']) {
        expect(
          css,
          `${shard} still has an interface-style rule repainting ${surface}`
        ).not.toMatch(new RegExp(`\\[data-interface-style="[^"]+"\\][^{;}]*${surface.replace('.', '\\.')}`))
      }
    }
  })
})
