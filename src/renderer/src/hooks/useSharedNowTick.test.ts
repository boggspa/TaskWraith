import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { paintLiveAttribute, paintLiveText } from './useSharedNowTick'

const SRC = join(process.cwd(), 'src/renderer/src')

function source(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf-8')
}

describe('paintLiveText', () => {
  it('writes the value when it differs', () => {
    const node = { textContent: '00:00:00:00' }
    paintLiveText(node, '00:00:00:01')
    expect(node.textContent).toBe('00:00:00:01')
  })

  /**
   * The whole point of the DOM-direct path is that an unchanged second costs
   * nothing. Assigning textContent unconditionally would replace the text node
   * every tick and dirty layout for no reason.
   */
  it('does NOT touch the node when the value is unchanged', () => {
    let writes = 0
    const node = {
      _value: '00:00:00:07',
      get textContent(): string {
        return this._value
      },
      set textContent(next: string) {
        writes += 1
        this._value = next
      }
    }
    paintLiveText(node, '00:00:00:07')
    expect(writes).toBe(0)
    paintLiveText(node, '00:00:00:08')
    expect(writes).toBe(1)
  })

  it('tolerates a null node (SSR / unmounted ref)', () => {
    expect(() => paintLiveText(null, '00:00:00:01')).not.toThrow()
  })
})

describe('paintLiveAttribute', () => {
  it('writes the attribute when it differs and skips it when it does not', () => {
    const attributes = new Map<string, string>([['aria-label', 'Turn 00:00:00:00']])
    let writes = 0
    const node = {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => {
        writes += 1
        attributes.set(name, value)
      }
    }

    paintLiveAttribute(node, 'aria-label', 'Turn 00:00:00:00')
    expect(writes).toBe(0)

    paintLiveAttribute(node, 'aria-label', 'Turn 00:00:00:01')
    expect(writes).toBe(1)
    expect(attributes.get('aria-label')).toBe('Turn 00:00:00:01')
  })

  it('tolerates a null node', () => {
    expect(() => paintLiveAttribute(null, 'title', 'x')).not.toThrow()
  })
})

/**
 * Slice from an anchor to end-of-file, failing loudly if the anchor is gone.
 * A guard whose anchor silently vanished is a guard that passes forever —
 * `projectReferenceContextDispatch.test.ts` is currently red in exactly that
 * way, from an anchor string that no longer exists.
 */
function sourceFrom(relativePath: string, anchor: string): string {
  const text = source(relativePath)
  const index = text.indexOf(anchor)
  expect(index, `anchor not found in ${relativePath}: ${anchor}`).toBeGreaterThanOrEqual(0)
  return text.slice(index)
}

/**
 * Source guards, matching how this repo already pins its "must not re-render"
 * contracts (`styles/approvalOverlayIsolation.test.ts`,
 * `components/ActiveRunsSection.test.tsx`). There is no jsdom environment here,
 * so a mounted component cannot be observed advancing its own text — these
 * guards, plus the frozen SSR markup in
 * `components/liveTimecodeSsrGoldens.test.tsx`, are what stop the per-second
 * React subscription creeping back in. Every assertion below was verified by
 * mutation — each corresponds to a distinct hand-applied regression that it
 * catches (a few trip the SSR golden as well).
 *
 * These pin SHAPE only. Whether the registry actually ticks is covered
 * behaviourally in `useSharedNowTickLifecycle.test.ts`, because source guards
 * cannot notice that nothing runs.
 */
describe('live clock surfaces stay off the per-second React subscription', () => {
  /**
   * SCOPED TO THE BAR, DELIBERATELY. A file-wide negative assertion is
   * impossible here: `useTimecodeNow` (ComposerTimecodes.tsx, used only by the
   * unmounted `ComposerTimecode`) legitimately still calls useSharedNowTick.
   * An unscoped guard therefore stays green while someone re-adds the
   * subscription to the bar itself — which is the entire regression this
   * describe block is named for.
   */
  it('the shipping thread timecode bar never joins the shared tick', () => {
    const bar = sourceFrom(
      'components/ComposerTimecodes.tsx',
      'export function ComposerThreadTimecodeBar'
    )

    expect(bar).not.toMatch(/useSharedNowTick\s*\(/)
    // ...and not through the side door either. `useTimecodeNow` calls
    // useSharedNowTick internally, so routing the bar's `initialNow` through it
    // re-adds the per-second Sync-lane render while reading like a revert and
    // leaving every other assertion here green.
    expect(bar).not.toMatch(/useTimecodeNow\s*\(/)
    expect(bar).toContain("const clockRunning = Number.isFinite(Date.parse(startedAt || ''))")
    expect(bar).toContain('useSharedNowEffect(clockRunning, (nowMs) => {')
  })

  it('the bar keeps a declarative first paint', () => {
    const bar = sourceFrom(
      'components/ComposerTimecodes.tsx',
      'export function ComposerThreadTimecodeBar'
    )

    // Refs never attach and effects never run under renderToStaticMarkup, so a
    // node left for the ticker to fill renders blank in tests AND on first
    // paint. `initialNow` must be a real clock read, not a frozen constant.
    expect(bar).toContain('const initialNow = useMemo(')
    expect(bar).toMatch(/const initialNow = useMemo\(\s*\(\) => Date\.now\(\)/)
    expect(bar).toContain('nowMs: initialNow')
  })

  /**
   * Every painted node individually. Deleting any ONE of these freezes exactly
   * one visible value while its neighbours keep ticking — the Total-thread
   * clock stopping while Turn advances, or the digits freezing while the
   * tooltip moves on. A guard that only spot-checked one of them would let the
   * other three through.
   */
  it('the bar repaints both values and both accessible names', () => {
    const bar = sourceFrom(
      'components/ComposerTimecodes.tsx',
      'export function ComposerThreadTimecodeBar'
    )

    expect(bar).toContain('paintLiveText(turnValueRef.current, live.turnLabel)')
    expect(bar).toContain("paintLiveAttribute(turnRef.current, 'aria-label'")
    expect(bar).toContain('paintLiveText(totalValueRef.current, live.totalLabel)')
    expect(bar).toContain("paintLiveAttribute(totalRef.current, 'aria-label'")

    // A paint call is inert without the ref actually attached in the JSX, and
    // refs are not serialised, so the SSR golden stays byte-identical while the
    // value freezes forever. Pin the attachment too.
    for (const ref of ['turnRef', 'turnValueRef', 'totalRef', 'totalValueRef']) {
      expect(bar, `${ref} is painted but never attached`).toContain(`ref={${ref}}`)
    }

    // The live callback must read the TICK's clock. Recomputing from
    // `initialNow` freezes the display at first paint while every other
    // assertion here still passes.
    expect(bar).toMatch(/cumulativeBaseMs,\s*nowMs\s*}/)
    expect(bar).not.toMatch(/const live = getComposerTimecodePresentation\([^)]*initialNow/)
  })

  it('the transcript working chip no longer subscribes to the shared tick at all', () => {
    const telemetry = source('components/ParticipantWorkingTelemetry.tsx')

    // It used to call useSharedNowTick() with no argument, so simply being
    // mounted cost a Sync-lane re-render every second.
    expect(telemetry).not.toMatch(/useSharedNowTick\s*\(/)
    expect(telemetry).toContain('useSharedNowEffect(hasLiveElapsed, (tickNowMs) => {')
    // A non-empty but unparseable startedAt would otherwise subscribe forever
    // to advance a value pinned at "0s".
    expect(telemetry).toContain("Number.isFinite(Date.parse(startedAt ?? ''))")
    // Both the digits and the tooltip carry the elapsed value.
    expect(telemetry).toContain('paintLiveText(elapsedRef.current, live)')
    expect(telemetry).toContain("paintLiveAttribute(rootRef.current, 'title', buildTitle(live))")
    // Same inert-paint hazard as the bar: no attached ref, no live value, and
    // the SSR golden cannot see it.
    expect(telemetry).toContain('ref={rootRef}')
    expect(telemetry).toContain('ref={elapsedRef}')
  })

  /**
   * Without this, `useSharedNowEffect` could simply never subscribe: every
   * source guard above still passes, the SSR golden still matches (it renders
   * the declarative first paint), and every clock in the app silently stops.
   */
  it('the effect actually joins the shared registry', () => {
    const hook = sourceFrom('hooks/useSharedNowTick.ts', 'export function useSharedNowEffect')

    expect(hook).toContain('return subscribeToSharedNowTick(')
    expect(hook).toContain('applyRef.current(Date.now())')
  })

  /**
   * The resync must stay dependency-free. React reconciles against the previous
   * VDOM value, not the DOM, and the declarative label is frozen for the life of
   * a turn, so an unrelated re-render writes no text and the DOM keeps the last
   * painted value.
   *
   * This is a SHAPE guard, deliberately. With today's callers `[apply]` would
   * behave identically (both pass an inline arrow, so `apply` is a fresh
   * identity every render) — the array is refused because it makes correctness hinge
   * on a caller detail invisible from the hook: wrap the callback in
   * `useCallback` and `[apply]` silently stops resyncing. No test here can
   * observe the resulting latch, because there is no jsdom.
   */
  it('the imperative resync runs after every render, with no dependency array', () => {
    const hook = sourceFrom('hooks/useSharedNowTick.ts', 'export function useSharedNowEffect')

    // Pinned as an exact block: the closing `})` carries no dependency array.
    // Adding one changes these bytes, so the guard fails rather than the app
    // silently latching a stale time.
    expect(hook).toContain(
      [
        '  useIsomorphicLayoutEffect(() => {',
        '    applyRef.current = apply',
        "    if (typeof window !== 'undefined') apply(Date.now())",
        '  })'
      ].join('\n')
    )
  })

  /**
   * Shape only, and scoped to the loop so an unrelated `try {` landing in this
   * file later cannot make it vacuous. The BEHAVIOUR — that a throwing listener
   * does not stop the ones after it — is asserted for real in
   * `useSharedNowTickLifecycle.test.ts`.
   */
  it('a throwing listener cannot decapitate the rest of the tick', () => {
    const ticking = sourceFrom('hooks/useSharedNowTick.ts', 'function startTicking')

    expect(ticking).toContain('for (const listener of [...listeners]) {')
    expect(ticking).toMatch(/try \{\s*listener\(\)\s*\} catch/)
  })

  it('guards are anchored to files that exist and are non-trivial', () => {
    expect(source('components/ComposerTimecodes.tsx').length).toBeGreaterThan(1000)
    expect(source('components/ParticipantWorkingTelemetry.tsx').length).toBeGreaterThan(1000)
  })
})
