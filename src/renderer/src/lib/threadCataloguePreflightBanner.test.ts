import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import {
  threadCatalogueStatusIsDegraded,
  threadCataloguePreflightBanner,
  type ThreadCatalogueStatusSnapshot
} from './threadCataloguePreflightBanner'

const snapshot = (
  over: Partial<ThreadCatalogueStatusSnapshot> = {}
): ThreadCatalogueStatusSnapshot => ({
  complete: true,
  loaded: 12,
  failed: 0,
  error: null,
  ...over
})

describe('threadCataloguePreflightBanner', () => {
  it('states an unavailable mirror while the launch screen is up', () => {
    expect(
      threadCataloguePreflightBanner({
        bootRevealed: false,
        status: snapshot({ complete: false, loaded: 0, error: 'History is unavailable' })
      })
    ).toBe('History is temporarily unavailable. Retrying…')
  })

  it('names unreadable threads and says their history is retained', () => {
    expect(
      threadCataloguePreflightBanner({
        bootRevealed: false,
        status: snapshot({ complete: true, loaded: 40, failed: 3 })
      })
    ).toBe('40 threads ready. 3 could not be read; their saved history is retained.')
  })

  it('counts an in-progress listing', () => {
    expect(
      threadCataloguePreflightBanner({
        bootRevealed: false,
        status: snapshot({ complete: false, loaded: 7 })
      })
    ).toBe('Loading history… 7 threads ready.')
  })

  it('says nothing for a healthy mirror, or before the first status read', () => {
    expect(threadCataloguePreflightBanner({ bootRevealed: false, status: snapshot() })).toBeNull()
    expect(threadCataloguePreflightBanner({ bootRevealed: false, status: null })).toBeNull()
  })

  // The point of the surface: reveal ends it, whatever the mirror is doing.
  it.each([
    [
      'an outright error',
      snapshot({ complete: false, loaded: 0, error: 'History is unavailable' })
    ],
    ['unreadable threads', snapshot({ loaded: 40, failed: 3 })],
    ['an incomplete listing', snapshot({ complete: false, loaded: 7 })]
  ])('shows nothing after the app is revealed, even with %s', (_label, status) => {
    expect(threadCataloguePreflightBanner({ bootRevealed: false, status })).not.toBeNull()
    expect(threadCataloguePreflightBanner({ bootRevealed: true, status })).toBeNull()
  })
})

describe('threadCatalogueStatusIsDegraded', () => {
  it('reports every state worth logging at reveal', () => {
    expect(threadCatalogueStatusIsDegraded(snapshot({ error: 'boom' }))).toBe(true)
    expect(threadCatalogueStatusIsDegraded(snapshot({ failed: 1 }))).toBe(true)
    expect(threadCatalogueStatusIsDegraded(snapshot({ complete: false }))).toBe(true)
  })

  it('stays quiet for a healthy or unread mirror', () => {
    expect(threadCatalogueStatusIsDegraded(snapshot())).toBe(false)
    expect(threadCatalogueStatusIsDegraded(null)).toBe(false)
  })
})

describe('the launch-screen note stacks above the mask it sits on', () => {
  const css = readFileSync(join(__dirname, '..', 'assets', 'css', '16-boot-mask.css'), 'utf8')
  const zIndexOf = (selector: string): number => {
    const block = css.slice(css.indexOf(`${selector} {`))
    const match = /z-index:\s*(\d+)/.exec(block.slice(0, block.indexOf('}')))
    if (!match) throw new Error(`no z-index on ${selector}`)
    return Number(match[1])
  }

  // The bubble used to sit at 1000 against the mask's 10001, so the only phase
  // it now renders in was the one phase it could not be seen in.
  it('paints over the boot mask and the booting drag strip', () => {
    expect(zIndexOf('.app-boot-history-note')).toBeGreaterThan(zIndexOf('.app-boot-mask'))
    expect(zIndexOf('.app-boot-history-note')).toBeGreaterThan(
      zIndexOf('.app-root.app-root-booting .window-drag-strip')
    )
  })

  it('drags like the mask, so it is not a dead spot in the launch window', () => {
    const block = css.slice(css.indexOf('.app-boot-history-note {'))
    expect(block.slice(0, block.indexOf('}'))).toMatch(/-webkit-app-region:\s*drag/)
  })
})
