import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPaneTopLeftChromeComposer } from './paneTopLeftChrome'

const trailing = <button type="button">sidebar</button>
const extra = <span>host chrome</span>

describe('createPaneTopLeftChromeComposer', () => {
  it('returns the trailing element itself when a pane has no host chrome', () => {
    const compose = createPaneTopLeftChromeComposer()
    // Viewer panes pass nothing, so the pane must receive the SAME element the
    // caller memoized — not a wrapper that re-allocates every render.
    expect(compose(undefined, trailing)).toBe(trailing)
    expect(compose(null, trailing)).toBe(trailing)
    expect(compose(false, trailing)).toBe(trailing)
  })

  it('reuses one combined element while both halves keep their identity', () => {
    const compose = createPaneTopLeftChromeComposer()
    const first = compose(extra, trailing)
    const second = compose(extra, trailing)
    expect(second).toBe(first)
  })

  it('rebuilds when either half changes identity', () => {
    const compose = createPaneTopLeftChromeComposer()
    const first = compose(extra, trailing)
    const nextTrailing = <button type="button">sidebar</button>
    const afterTrailing = compose(extra, nextTrailing)
    expect(afterTrailing).not.toBe(first)
    const afterExtra = compose(<span>host chrome</span>, nextTrailing)
    expect(afterExtra).not.toBe(afterTrailing)
  })

  it('keeps both halves, in caller order, inside the combined element', () => {
    const compose = createPaneTopLeftChromeComposer()
    const combined = compose(extra, trailing)
    const children = (combined as { props: { children: unknown[] } }).props.children
    expect(children).toEqual([extra, trailing])
  })

  it('composes per composer instance, so one pane cannot evict another', () => {
    const paneA = createPaneTopLeftChromeComposer()
    const paneB = createPaneTopLeftChromeComposer()
    const a = paneA(extra, trailing)
    paneB(<span>other</span>, trailing)
    expect(paneA(extra, trailing)).toBe(a)
  })
})

describe('multiview pane top-left chrome wiring', () => {
  const appSource = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const layoutSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/app/views/MainAppLayout.tsx'),
    'utf8'
  )
  const paneCell = (): string => {
    const start = appSource.indexOf('const renderMultiviewPaneCell =')
    const end = appSource.indexOf('// `buildPaneComposerCtx`', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    return appSource.slice(start, end)
  }

  it('hands panes a stable chrome element instead of a fresh fragment per render', () => {
    // A fresh JSX fragment here is never `===` its predecessor, so
    // chatViewPanePropsEqual returns false for EVERY pane on EVERY App render
    // and the whole comparator — including its store-prop clauses — is dead.
    expect(paneCell()).not.toMatch(/topLeftChromeExtra=\{\s*\n?\s*<>/)
    // Formatting-agnostic: the pane must route both halves through the composer.
    const collapsed = paneCell().replace(/\s+/g, ' ')
    expect(collapsed).toContain(
      'composePaneTopLeftChrome( options.topLeftChromeExtra, workspaceSidebarToggleButton )'
    )
    expect(appSource).toContain('createPaneTopLeftChromeComposer()')
  })

  it('memoizes the sidebar toggle the pane cell trails onto every pane', () => {
    expect(appSource).toContain('const workspaceSidebarToggleButton = useMemo(')
  })

  it('memoizes the focused-pane host chrome the layout feeds into that composer', () => {
    // The App-side composer can only preserve identity if its input is stable
    // too: an inline fragment built in MainAppLayout's render defeats it.
    expect(layoutSource).not.toMatch(
      /topLeftChromeExtra:\s*\n?\s*chatId === currentChatAppChatId \? \(\s*\n?\s*<>/
    )
    expect(layoutSource).toContain('const focusedPaneTopLeftChrome = useMemo(')
  })
})
