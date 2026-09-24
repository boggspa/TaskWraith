import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

type TickListener = () => void

/**
 * Belt and braces for non-browser realms. This repo renders ~251 renderer
 * suites through `renderToStaticMarkup` with no jsdom, so hooks here must
 * survive a realm with no `window`.
 *
 * NOTE: React 19 no longer emits the old "useLayoutEffect does nothing on the
 * server" warning (verified against the installed react-dom — the string is not
 * in the bundle, and forcing the useLayoutEffect branch under SSR logs
 * nothing), so this is not warning-suppression. It is resolved once per realm,
 * never conditionally per render, so hook order stays stable across renders and
 * Fast Refresh.
 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

const listeners = new Set<TickListener>()
let nowTick = 0
let intervalId: number | undefined

function startTicking(): void {
  if (intervalId !== undefined || typeof window === 'undefined') return
  intervalId = window.setInterval(() => {
    nowTick += 1
    // Isolate each listener. These used to be only React's own
    // `useSyncExternalStore` callback, which does not throw; since
    // `useSharedNowEffect` they run arbitrary component code — formatters,
    // `toLocaleString`, DOM writes — directly on this interval. One throw would
    // abort the loop, so every listener AFTER it in the set would silently miss
    // that second while the error escaped as an unhandled renderer error. It
    // self-heals on the next tick, which makes a randomly-skipping clock the
    // symptom: the worst kind to diagnose.
    //
    // The copy is for a different hazard, and not the obvious one — a live Set
    // already tolerates a listener deleting itself mid-iteration. It is for
    // ADDITIONS: a live Set iterator picks up entries appended during the walk,
    // so a listener that mounts another subscriber would drag it into the same
    // tick, unboundedly. The tradeoff is that a listener unsubscribed by an
    // earlier listener still fires once more here; that is inert today, because
    // unsubscribes only happen in effect cleanup.
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[shared-now-tick] listener failed', error)
      }
    }
  }, 1000)
}

function stopTickingWhenUnused(): void {
  if (listeners.size > 0 || intervalId === undefined) return
  if (typeof window !== 'undefined') window.clearInterval(intervalId)
  intervalId = undefined
}

/**
 * Exported for tests. There is no jsdom, no react-test-renderer and no
 * @testing-library in this repo, so a mounted component cannot be observed —
 * which would leave the whole subscription lifecycle (subscribe on enable,
 * unsubscribe on disable/unmount, interval teardown, listener isolation)
 * unreachable from the suite by any route. Production code should use
 * `useSharedNowTick` or `useSharedNowEffect`, never this directly.
 */
export function subscribeToSharedNowTick(listener: TickListener): () => void {
  listeners.add(listener)
  startTicking()
  return () => {
    listeners.delete(listener)
    stopTickingWhenUnused()
  }
}

/** Test-only view of the registry; never branch on this in production code. */
export function sharedNowTickDiagnostics(): { listeners: number; ticking: boolean } {
  return { listeners: listeners.size, ticking: intervalId !== undefined }
}

function getSharedNowTick(): number {
  return nowTick
}

/**
 * Shares one renderer-wide one-second cadence between lightweight UI consumers.
 * The interval exists only while at least one enabled subscriber is mounted.
 */
export function useSharedNowTick(enabled = true): number {
  const subscribe = useCallback(
    (listener: TickListener) => (enabled ? subscribeToSharedNowTick(listener) : () => undefined),
    [enabled]
  )
  return useSyncExternalStore(subscribe, getSharedNowTick, getSharedNowTick)
}

/**
 * Runs `apply` on the shared one-second cadence WITHOUT re-rendering.
 *
 * `useSharedNowTick` is a `useSyncExternalStore`, so every subscriber pays a
 * Sync-lane re-render each second — and `memo` cannot stop it, because the
 * subscription lives inside the component rather than in its props. For a
 * clock that is pure waste: the only thing that changed is a string of digits.
 * This hook hands the tick to the caller as a callback instead, so it can write
 * the digits straight into the DOM and invalidate nothing — no reconciliation,
 * no memo churn, no composer or transcript involvement, and (as before) zero
 * main-process work, since the cadence is a renderer interval.
 *
 * CONTRACT — the caller still owns the FIRST paint. Refs do not attach and
 * effects do not run under `renderToStaticMarkup`, which is how this repo tests
 * the renderer, so a node left empty for this hook to fill would render blank
 * in tests AND on the real first paint. Render the initial value declaratively;
 * this hook only OVERWRITES it thereafter.
 *
 * THE MISSING DEPENDENCY ARRAY BELOW IS LOAD-BEARING — DO NOT ADD ONE.
 * `apply` must run after EVERY render, not only on each tick. React reconciles
 * against the previous VDOM value, not against the DOM, and the declarative
 * value here is frozen for the life of a turn. So whenever the component
 * re-renders for some unrelated reason, React writes no text (previous and next
 * agree) and the DOM keeps whatever the ticker last painted. The working chip
 * makes this constant, not rare: it re-renders on its own 500 ms token
 * odometer, and each of those renders rewrites `title` from the FROZEN
 * first-paint elapsed. This unconditional resync repairs that before paint.
 * The same shape covers a run ending, or `startedAt` moving to a new ensemble
 * round mid-run.
 *
 * Precise scope, so nobody "proves" this wrong and deletes it: with today's
 * call sites, `[apply]` happens to be equivalent to no array at all (both
 * callers pass an inline arrow, so `apply` is a fresh identity every render),
 * and `[enabled]` still repairs the run-end case (`enabled` IS `running`, so it
 * re-runs on that transition). The array is refused because it makes
 * correctness depend on a caller detail that is invisible from here: the day
 * someone wraps their callback in `useCallback`, `[apply]` silently stops
 * resyncing and the DOM latches a stale time. `useSharedNowTick.test.ts` pins
 * the absence of the array as a shape guard, since no test in this repo can
 * observe the latch itself — there is no jsdom.
 */
export function useSharedNowEffect(enabled: boolean, apply: (nowMs: number) => void): void {
  const applyRef = useRef(apply)

  useIsomorphicLayoutEffect(() => {
    applyRef.current = apply
    if (typeof window !== 'undefined') apply(Date.now())
  })

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    return subscribeToSharedNowTick(() => applyRef.current(Date.now()))
  }, [enabled])
}

/** Writes `value` to `node` only when it differs, so an unchanged second is free. */
export function paintLiveText(node: { textContent: string | null } | null, value: string): void {
  if (node && node.textContent !== value) node.textContent = value
}

/**
 * Keeps an attribute in step with the live text, because the timecode bar and
 * the working chip both bake their elapsed string into `aria-label`/`title`.
 * Left unpainted those would freeze at mount, so the tooltip would disagree
 * with the digits beside it.
 *
 * Scope note, so nobody over-claims this: today neither frozen value would
 * actually be ANNOUNCED. The working chip's root is `aria-hidden`, and the
 * bar's `aria-label` sits on a bare `<span>` with no role, where ARIA forbids
 * name-from-author. The transcript's `role="status" aria-live="polite"` group
 * announces only its own `sr-only` label, which carries no elapsed time.
 * Repainting is still correct — it keeps the tooltip honest and holds the line
 * if either element ever gains a role.
 */
export function paintLiveAttribute(
  node: {
    getAttribute(name: string): string | null
    setAttribute(name: string, value: string): void
  } | null,
  name: string,
  value: string
): void {
  if (node && node.getAttribute(name) !== value) node.setAttribute(name, value)
}
