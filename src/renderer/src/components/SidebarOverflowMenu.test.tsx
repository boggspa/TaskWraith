import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SIDEBAR_CONTEXT_MENU_HOST_SELECTOR, scrollDismissesMenu } from './SidebarOverflowMenu'

/**
 * The renderer has no DOM under vitest, so these stand in for the real nodes.
 * `scrollDismissesMenu` duck-types `contains`, which is all a scroll container
 * needs to expose here; the casts keep the call sites honest to the real
 * `EventTarget`/`Node` signature.
 */
function node(id: string): Node {
  return { id } as unknown as Node
}

function scroller(contained: Node[]): EventTarget {
  return {
    contains: (candidate: Node) => contained.includes(candidate)
  } as unknown as EventTarget
}

describe('scrollDismissesMenu', () => {
  it('dismisses when the scrolled container actually moves the trigger', () => {
    const trigger = node('trigger')
    expect(scrollDismissesMenu(scroller([trigger]), trigger)).toBe(true)
  })

  it('keeps the menu open when an unrelated pane scrolls', () => {
    // The transcript scroller pins itself to the live edge on every streaming
    // delta. It does not contain the sidebar trigger, so the popover is still
    // correctly placed and must survive.
    const trigger = node('trigger')
    const transcriptScroller = scroller([node('transcript-row')])
    expect(scrollDismissesMenu(transcriptScroller, trigger)).toBe(false)
  })

  it('keeps the menu open while scrolling inside the portaled popover itself', () => {
    const trigger = node('trigger')
    const popover = scroller([node('menu-item')])
    expect(scrollDismissesMenu(popover, trigger)).toBe(false)
  })

  it('ignores scrolls with no trigger or no resolvable container', () => {
    const trigger = node('trigger')
    expect(scrollDismissesMenu(scroller([trigger]), null)).toBe(false)
    expect(scrollDismissesMenu(null, trigger)).toBe(false)
    expect(scrollDismissesMenu({} as unknown as EventTarget, trigger)).toBe(false)
  })
})

describe('SidebarOverflowMenu scroll dismissal wiring', () => {
  const source = readFileSync(new URL('./SidebarOverflowMenu.tsx', import.meta.url), 'utf8')

  it('routes the capture-phase scroll listener through the containment check', () => {
    // The listener is registered on `window` with capture, so it observes
    // scrolls in EVERY scroll container in the app. Dismissing unconditionally
    // closed the menu on each transcript delta.
    expect(source).not.toMatch(/const handleScroll = \(\)\s*=>\s*setOpen\(false\)/)
    expect(source).toMatch(/scrollDismissesMenu\(/)
  })
})

describe('SidebarOverflowMenu context-menu hosts', () => {
  it('covers ordinary, Work-project, and Active Runs thread rows', () => {
    expect(SIDEBAR_CONTEXT_MENU_HOST_SELECTOR).toContain('.sidebar-item')
    expect(SIDEBAR_CONTEXT_MENU_HOST_SELECTOR).toContain('.sidebar-project-member')
    expect(SIDEBAR_CONTEXT_MENU_HOST_SELECTOR).toContain('.sidebar-active-run-entry')
  })
})
