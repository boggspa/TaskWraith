import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (file: string): string =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n')

/*
 * Pending contributions — external messages waiting for the host to release
 * them, pinned above the composer.
 *
 * Three load-bearing facts, each of which fails SILENTLY if broken:
 *
 * 1. GEOMETRY. The composer is absolutely positioned over the transcript, so
 *    "above but outside the composer" is a z-layer band, not a flow position.
 *    Mounting inside `.composer-area` — the bottom-anchored flex column — is
 *    what makes `bindComposerReservation` measure this surface at all: it
 *    observes that element and nothing else, so an `.app-transcript` sibling
 *    would leave the transcript's last message sitting underneath.
 *
 * 2. POINTER EVENTS. `.composer-area` is `pointer-events: none` so the
 *    transcript stays scrollable around the composer. A child shipping buttons
 *    must opt back in or Approve and Deny render perfectly and do nothing.
 *
 * 3. SEPARATION. The host's OWN queued messages live in
 *    `.composer-above-bar-stack`. This surface must not be moved in there, and
 *    must not be restyled to match: keeping the two visually distinct is the
 *    reason it exists rather than an incidental layout choice.
 */
describe('pending contributions surface', () => {
  it('mounts inside .composer-area, before the above-bar stack', () => {
    const source = readSource('src/renderer/src/components/Composer.tsx')

    const areaOpen = source.indexOf('className={`composer-area ')
    const mount = source.indexOf('<PendingContributionsStack ')
    const aboveBarStack = source.indexOf('<div className={`composer-above-bar-stack ')

    expect(areaOpen).toBeGreaterThanOrEqual(0)
    expect(mount).toBeGreaterThan(areaOpen)
    // Earlier in a bottom-anchored flex column means higher on screen.
    expect(aboveBarStack).toBeGreaterThan(mount)
  })

  it('is chat-scoped, so a Multiview pane cannot show another pane’s queue', () => {
    const source = readSource('src/renderer/src/components/Composer.tsx')
    expect(source).toContain('<PendingContributionsStack chatId={currentChat?.appChatId} />')
  })

  it('re-enables pointer events, or Approve and Deny are dead controls', () => {
    const css = readSource('src/renderer/src/assets/css/03-composer-welcome-activity.css')
    const block = css.slice(css.indexOf('.pending-contributions-stack {'))
    expect(block).toContain('pointer-events: auto')
  })

  it('bounds its own height and wraps untrusted text', () => {
    const css = readSource('src/renderer/src/assets/css/03-composer-welcome-activity.css')
    // An unbounded stack would eat the transcript; an unbroken token would push
    // the action row off the edge. Both are reachable with attacker-chosen text.
    expect(css).toContain('max-height: min(38vh, 320px)')
    expect(css).toContain('overflow-wrap: anywhere')
  })

  it('renders nothing at all when there is nothing pending', () => {
    // The common case by a wide margin: no share, no host review, or an empty
    // queue. It must cost no layout, because it is in the composer's column.
    const source = readSource('src/renderer/src/components/PendingContributionsStack.tsx')
    expect(source).toContain('if (pending.length === 0) return null')
  })

  it('rides real theme tokens, so light themes are not a black slab', () => {
    // Regression: the first version used --surface-raised and --border-strong,
    // which do not exist in this repo (they are the visualisation design
    // system's names). Undefined tokens fall through to whatever fallback is
    // written, and the fallbacks were dark — invisible text on light themes.
    const css = readSource('src/renderer/src/assets/css/03-composer-welcome-activity.css')
    const block = css.slice(css.indexOf('.pending-contribution {'))
    expect(block).toContain('background: var(--panel-elevated-bg)')
    expect(block).toContain('color: var(--text-primary)')
    expect(css).not.toContain('--surface-raised')
  })

  it('bounds a single row, not just the stack', () => {
    // A Multiview pane is a fraction of the viewport, so the stack's own vh cap
    // can exceed the cell; one long contribution would push its Approve and
    // Deny past the top edge.
    const css = readSource('src/renderer/src/assets/css/03-composer-welcome-activity.css')
    const block = css.slice(css.indexOf('.pending-contribution-text {'))
    expect(block).toContain('max-height: 120px')
  })

  it('discards a fetch that resolved after the host changed chats', () => {
    // Four async callers (mount, broadcast, focus, post-resolve refresh). Without
    // the guard a reply for the previous chat can land last and paint one chat's
    // queue under another's transcript.
    const source = readSource('src/renderer/src/components/PendingContributionsStack.tsx')
    expect(source).toContain('chatIdRef.current = chatId')
    expect(source).toContain('if (chatIdRef.current !== chatId) return')
  })

  it('names each row’s controls after its author', () => {
    const source = readSource('src/renderer/src/components/PendingContributionsStack.tsx')
    expect(source).toContain('aria-label={`Approve the contribution from ${entry.displayName}`}')
    expect(source).toContain('aria-label={`Deny the contribution from ${entry.displayName}`}')
  })

  it('never optimistically removes a row — main is the authority', () => {
    const source = readSource('src/renderer/src/components/PendingContributionsStack.tsx')
    // approve/deny return null when the entry was already resolved, so the
    // list must be re-read rather than spliced locally on the click.
    expect(source).toContain('void refresh()')
    expect(source).not.toContain('setPending((prev) => prev.filter')
  })
})
