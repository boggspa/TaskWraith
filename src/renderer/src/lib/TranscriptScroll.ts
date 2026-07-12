/**
 * Pure helpers for the transcript auto-follow ("stick to bottom") scroll
 * behaviour in App.tsx. Extracted so the threshold logic can be unit
 * tested without spinning up the renderer.
 *
 * Background — the bug this module exists to address:
 *
 * Long Kimi runs streamed many `update_topic`/`intent`/`summary`/
 * `progress` events through `emitVisibleProgress` (see GeminiAdapter).
 * Each event produced both a `tool_use` and a paired `tool_result`,
 * which flipped the corresponding ActivityStack row from `running` to
 * `success`. ActivityStack's local `useEffect` then collapsed the row
 * (`setExpanded(false)`), shrinking the transcript content height in
 * the frame _after_ the parent's `useLayoutEffect`-driven snap-to-bottom
 * already ran. The browser clamped `scrollTop`, the visible content
 * shifted upward, and the user perceived the transcript "snapping" away
 * from the bottom. Code blocks rendered through CodeMirror exhibit the
 * same late-mount height growth and caused the equivalent symptom.
 *
 * The fix has two parts and both are deliberately conservative — the
 * earlier history of this code path (a ResizeObserver feedback loop)
 * is documented in App.tsx and must not be reintroduced:
 *
 *   1. Keep auto-follow opt-in precise: a transcript follows new
 *      content only while it was already at the live edge. Once the
 *      user scrolls away, no new message should pull them down until
 *      they return to the bottom.
 *   2. After every snap-to-bottom write, schedule one extra rAF re-pin
 *      so late-mount layout growth/shrink (CodeMirror, ActivityStack
 *      collapse) can settle and we re-anchor the visible bottom. The
 *      re-pin is gated on `autoFollow` _and_ a flag that goes false the
 *      moment we observe a real user-initiated upward scroll, so the
 *      compensation pass never fights a deliberate scroll-up.
 */

/**
 * Distance, in CSS pixels, within which a scroll position RE-ENGAGES
 * auto-follow. Intentionally tighter than the disengage threshold: once
 * the user scrolls away, follow re-arms only when they return to the
 * genuine live edge (≤2px). Keeping this strictly below
 * `STICK_DISENGAGE_PX` creates a small hysteresis dead-band (see below)
 * so a single pixel of layout jitter at the bottom cannot oscillate the
 * follow state.
 */
export const STICK_ENGAGE_PX = 2

/**
 * Distance beyond which auto-follow DISENGAGES. Kept sensitive (small) so
 * the user owns scroll the instant they move away from the bottom — note
 * this also backstops scrollbar-drag / keyboard scroll-ups that never
 * fire the wheel/touch intent listeners. The `2 < d ≤ 4` gap between
 * engage and disengage is the hysteresis dead-band: within it the follow
 * state is sticky, so micro-jitter at the live edge does not flap it.
 */
export const STICK_DISENGAGE_PX = 4

/**
 * Wider re-engage band for a DELIBERATE downward return. The 2px engage
 * band is right for passive landings, but while a run is streaming the
 * exact live edge is a moving target: the user wheels down to catch up,
 * content grows under them, and by the time the rAF evaluate reads the
 * metrics they are tens of pixels short — follow never re-arms and the
 * transcript runs away (Claude/Codex re-lock in this gesture). A landing
 * inside this band re-engages ONLY under a recent, verified downward input
 * gesture (`recentDownwardIntent`: wheel/touch/keys or a tracked scrollbar
 * pointer — signals scroll EVENTS cannot fake); the caller then snaps the
 * remaining distance so the gesture completes at the live edge. Shrink clamps
 * and unarmed restore writes produce no input gesture and keep follow off — so
 * an app-owned reflow can never convert a reading position into a re-lock.
 */
export const STICK_REENGAGE_DOWNWARD_PX = 48

/**
 * How long a verified downward input vouches for a near-bottom landing. Long
 * enough to cover wheel/touch momentum, key scrolling, a scrollbar pointerup,
 * and the rAF evaluate that follows; short enough that stale intent cannot hand
 * the band to an unrelated later layout shift.
 */
export const DOWNWARD_INTENT_WINDOW_MS = 400

/**
 * Width of the pointer hit strip used for overlay scrollbars. macOS overlay
 * scrollbars do not consume layout width (`offsetWidth - clientWidth === 0`),
 * so the native gutter alone cannot identify a thumb drag. Pointer events that
 * start inside this narrow inline-end strip are treated as scrollbar gestures
 * only while the transcript actually overflows.
 */
export const OVERLAY_SCROLLBAR_HIT_PX = 14

export const PROGRAMMATIC_SCROLL_EPSILON_PX = 1

/** Whether a recorded user-input voucher is still fresh enough to re-arm follow. */
export function hasRecentTranscriptDownwardIntent(input: {
  intentAt: number
  now: number
}): boolean {
  if (!Number.isFinite(input.intentAt) || !Number.isFinite(input.now) || input.intentAt <= 0) {
    return false
  }
  const elapsed = input.now - input.intentAt
  return elapsed >= 0 && elapsed <= DOWNWARD_INTENT_WINDOW_MS
}

export interface ChatScrollState {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  scrollRatio: number
  atBottom: boolean
  anchorMessageId?: string
  anchorOffset?: number
}

export interface CachedChatScrollState {
  scrollState: ChatScrollState
  /** Follow ownership is deliberately stored separately from geometry. A
   * reader can disengage follow while still inside the loose 24px capture
   * band, and revisiting that chat must not silently re-arm it. */
  autoFollow: boolean
}

export type TranscriptChatSwitchPlan =
  | { kind: 'manual-jump' }
  | { kind: 'external-restore'; cached: CachedChatScrollState }
  | { kind: 'restore'; cached: CachedChatScrollState }
  | { kind: 'latest' }

/** Resolve chat-switch precedence without coupling it to React timing.
 * Explicit message jumps win, reading positions restore only when the user
 * owned scroll, and first visits / previously pinned chats land at the current
 * live edge rather than a stale stored scrollHeight. */
export function resolveTranscriptChatSwitchPlan(input: {
  cached?: CachedChatScrollState
  pendingExternalRestore?: CachedChatScrollState
  hasPendingManualJump: boolean
}): TranscriptChatSwitchPlan {
  if (input.hasPendingManualJump) return { kind: 'manual-jump' }
  if (input.pendingExternalRestore) {
    return { kind: 'external-restore', cached: input.pendingExternalRestore }
  }
  if (input.cached && !input.cached.autoFollow) {
    return { kind: 'restore', cached: input.cached }
  }
  return { kind: 'latest' }
}

export function captureChatScrollState(
  scroller: HTMLElement | null | undefined
): ChatScrollState | undefined {
  if (!scroller) return undefined
  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const scrollTop = Math.max(0, Math.min(maxScrollTop, scroller.scrollTop))
  const distanceFromBottom = maxScrollTop - scrollTop
  const state: ChatScrollState = {
    scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    scrollRatio: maxScrollTop > 0 ? scrollTop / maxScrollTop : 1,
    atBottom: distanceFromBottom <= 24
  }
  if (!state.atBottom && typeof scroller.getBoundingClientRect === 'function') {
    const scrollerRect = scroller.getBoundingClientRect()
    const messageNodes = scroller.querySelectorAll<HTMLElement>('[data-message-id]')
    for (const node of messageNodes) {
      const messageId = node.getAttribute('data-message-id')
      if (!messageId) continue
      const nodeRect = node.getBoundingClientRect()
      if (nodeRect.bottom < scrollerRect.top) continue
      if (nodeRect.top > scrollerRect.bottom) break
      state.anchorMessageId = messageId
      state.anchorOffset = nodeRect.top - scrollerRect.top
      break
    }
  }
  return state
}

function escapeDomAttributeValue(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}

export function restoreChatScrollAnchor(
  scroller: HTMLElement,
  scrollState: ChatScrollState
): boolean {
  const anchorOffset = scrollState.anchorOffset
  if (
    !scrollState.anchorMessageId ||
    typeof anchorOffset !== 'number' ||
    !Number.isFinite(anchorOffset)
  ) {
    return false
  }
  const target = scroller.querySelector<HTMLElement>(
    `[data-message-id="${escapeDomAttributeValue(scrollState.anchorMessageId)}"]`
  )
  if (!target || typeof scroller.getBoundingClientRect !== 'function') return false
  const scrollerRect = scroller.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  scroller.scrollTop = Math.max(
    0,
    Math.min(maxScrollTop, scroller.scrollTop + targetRect.top - scrollerRect.top - anchorOffset)
  )
  return true
}

export function normalizeChatScrollState(value: unknown): ChatScrollState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const scrollTop = Number(source.scrollTop)
  const scrollHeight = Number(source.scrollHeight)
  const clientHeight = Number(source.clientHeight)
  const scrollRatio = Number(source.scrollRatio)
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(scrollHeight) ||
    !Number.isFinite(clientHeight) ||
    !Number.isFinite(scrollRatio)
  ) {
    return undefined
  }
  return {
    scrollTop: Math.max(0, scrollTop),
    scrollHeight: Math.max(0, scrollHeight),
    clientHeight: Math.max(0, clientHeight),
    scrollRatio: Math.max(0, Math.min(1, scrollRatio)),
    atBottom: Boolean(source.atBottom),
    ...(typeof source.anchorMessageId === 'string' && Number.isFinite(Number(source.anchorOffset))
      ? {
          anchorMessageId: source.anchorMessageId,
          anchorOffset: Number(source.anchorOffset)
        }
      : {})
  }
}

export function restoreChatScrollState(
  scroller: HTMLElement | null | undefined,
  scrollState: ChatScrollState | undefined,
  shouldApply: () => boolean = () => true,
  onSettled: () => void = () => {}
): () => void {
  if (!scroller || !scrollState) return () => {}
  let cancelled = false
  let firstRafId: number | null = null
  let secondRafId: number | null = null
  const apply = () => {
    if (cancelled || !shouldApply()) return
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    if (scrollState.atBottom) {
      scroller.scrollTop = scroller.scrollHeight
      return
    }
    if (restoreChatScrollAnchor(scroller, scrollState)) return
    scroller.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollState.scrollRatio * maxScrollTop))
  }
  firstRafId = requestAnimationFrame(() => {
    firstRafId = null
    apply()
    if (cancelled || !shouldApply()) return
    secondRafId = requestAnimationFrame(() => {
      secondRafId = null
      apply()
      if (!cancelled && shouldApply()) onSettled()
    })
  })
  return () => {
    cancelled = true
    if (firstRafId !== null) cancelAnimationFrame(firstRafId)
    if (secondRafId !== null) cancelAnimationFrame(secondRafId)
    firstRafId = null
    secondRafId = null
  }
}

export function restoreChatScrollStateWhenReady(
  getScroller: () => HTMLElement | null | undefined,
  scrollState: ChatScrollState | undefined,
  attempts = 8,
  shouldApply: () => boolean = () => true,
  onSettled: () => void = () => {}
): () => void {
  if (!scrollState) return () => {}
  let cancelled = false
  let retryRafId: number | null = null
  let cancelRestore = () => {}
  let remainingAttempts = attempts
  const tryRestore = () => {
    retryRafId = null
    if (cancelled || !shouldApply()) return
    const scroller = getScroller()
    if (scroller) {
      cancelRestore = restoreChatScrollState(
        scroller,
        scrollState,
        () => !cancelled && shouldApply(),
        onSettled
      )
      return
    }
    if (remainingAttempts <= 0) return
    remainingAttempts -= 1
    retryRafId = requestAnimationFrame(tryRestore)
  }
  tryRestore()
  return () => {
    cancelled = true
    if (retryRafId !== null) cancelAnimationFrame(retryRafId)
    retryRafId = null
    cancelRestore()
  }
}

/**
 * Decide whether the transcript is close enough to the bottom that a
 * scroll event should re-engage auto-follow.
 *
 * Returns `true` only when the user has stopped scrolling so close to
 * the bottom that any further streamed content should keep the bottom
 * pinned. Defensive against negative or NaN inputs (which can occur if
 * the scroll container is detached or the layout has briefly produced
 * inconsistent metrics during a reflow).
 */
export function shouldEngageAutoFollow(distanceFromBottom: number): boolean {
  if (!Number.isFinite(distanceFromBottom)) return false
  return distanceFromBottom <= STICK_ENGAGE_PX
}

/**
 * Decide whether a scroll evaluation may re-arm sticky-bottom.
 *
 * Being numerically near the bottom is not enough after upward user intent.
 * During fast streaming the transcript can grow under the viewport and keep
 * `distanceFromBottom` inside the tiny engage band while the user is trying to
 * move upward. In that case, only a verified downward gesture plus movement
 * back to the live edge should clear the scroll-away guard.
 */
export function shouldReengageAutoFollowAfterScroll(input: {
  distanceFromBottom: number
  userScrolledAwayInThisFrame: boolean
  previousScrollTop: number
  nextScrollTop: number
  isProgrammatic: boolean
  /** True when a downward wheel/touch/key gesture or scrollbar-pointer drag
   *  happened within DOWNWARD_INTENT_WINDOW_MS and no upward gesture followed
   *  it. Scroll EVENTS alone can't prove a gesture (restore writes and a
   *  frame-coalesced net movement look identical), so both the strict and wide
   *  re-engage bands demand this out-of-band evidence after scroll-away. */
  recentDownwardIntent: boolean
}): boolean {
  const movedDown =
    Number.isFinite(input.previousScrollTop) &&
    Number.isFinite(input.nextScrollTop) &&
    input.nextScrollTop > input.previousScrollTop + 0.5
  if (shouldEngageAutoFollow(input.distanceFromBottom)) {
    if (!input.userScrolledAwayInThisFrame) return true
    if (input.isProgrammatic) return false
    // Once a USER has released sticky-bottom, position + direction alone are
    // not proof that they came back. Assistant/reasoning layout, browser clamps,
    // and virtual-window anchor corrections can all move scrollTop downward
    // without a gesture. Require an out-of-band wheel/touch/key or scrollbar-
    // drag signal even inside the strict 2px band so an unclassified landing can
    // never re-arm follow and let the next stream frame yank the reader to tail.
    if (!input.recentDownwardIntent) return false
    return movedDown
  }
  // Deliberate downward return that lands NEAR the live edge (see
  // STICK_REENGAGE_DOWNWARD_PX): re-arm even though streamed growth kept the
  // exact edge out of reach. Demands BOTH the scroll-away flag (a user owns
  // the scroll) and a recent verified downward gesture — net-downward scroll
  // movement alone can be an app-owned restore write or a coalesced frame
  // whose LAST input was actually upward.
  if (!Number.isFinite(input.distanceFromBottom)) return false
  if (input.isProgrammatic) return false
  if (!input.userScrolledAwayInThisFrame) return false
  if (!input.recentDownwardIntent) return false
  return movedDown && input.distanceFromBottom <= STICK_REENGAGE_DOWNWARD_PX
}

/**
 * Whether a pointer-down landed in the transcript's vertical scrollbar hit
 * area. Handles both layout-consuming scrollbars and macOS overlay scrollbars.
 * The caller still waits for an actual downward scrollTop movement before
 * recording intent, so merely clicking near the edge cannot re-arm follow.
 */
export function isTranscriptScrollbarPointer(input: {
  clientX: number
  rectLeft: number
  rectRight: number
  offsetWidth: number
  clientWidth: number
  scrollHeight: number
  clientHeight: number
  direction?: 'ltr' | 'rtl'
}): boolean {
  const values = [
    input.clientX,
    input.rectLeft,
    input.rectRight,
    input.offsetWidth,
    input.clientWidth,
    input.scrollHeight,
    input.clientHeight
  ]
  if (values.some((value) => !Number.isFinite(value))) return false
  if (input.rectRight <= input.rectLeft) return false
  if (input.scrollHeight <= input.clientHeight) return false

  const nativeGutterWidth = Math.max(0, input.offsetWidth - input.clientWidth)
  const hitWidth = Math.max(nativeGutterWidth, OVERLAY_SCROLLBAR_HIT_PX)
  if (input.direction === 'rtl') {
    return input.clientX >= input.rectLeft && input.clientX <= input.rectLeft + hitWidth
  }
  return input.clientX <= input.rectRight && input.clientX >= input.rectRight - hitWidth
}

/**
 * A scrollbar pointer-down becomes verified downward intent only after the
 * thumb/track actually moves scrollTop down. App-owned writes are explicitly
 * excluded so holding the pointer near the gutter cannot bless a layout snap.
 */
export function shouldRecordScrollbarDownwardIntent(input: {
  pointerActive: boolean
  isProgrammatic: boolean
  previousScrollTop: number
  nextScrollTop: number
}): boolean {
  if (!input.pointerActive || input.isProgrammatic) return false
  if (!Number.isFinite(input.previousScrollTop) || !Number.isFinite(input.nextScrollTop)) {
    return false
  }
  return input.nextScrollTop > input.previousScrollTop + 0.5
}

/**
 * A scrollbar drag can reverse within one animation frame. Clear the voucher
 * from its immediately preceding native position, not the older rAF position,
 * so a `260 → 320 → 300` gesture cannot be mistaken for a downward return.
 */
export function shouldClearScrollbarDownwardIntent(input: {
  pointerActive: boolean
  isProgrammatic: boolean
  previousScrollTop: number
  nextScrollTop: number
}): boolean {
  if (!input.pointerActive || input.isProgrammatic) return false
  if (!Number.isFinite(input.previousScrollTop) || !Number.isFinite(input.nextScrollTop)) {
    return false
  }
  return input.nextScrollTop < input.previousScrollTop - 0.5
}

/** Keyboard navigation inside transcript-owned editors must stay in the editor. */
export function isEditableTranscriptKeyTarget(target: EventTarget | null): boolean {
  const element = target as
    | (EventTarget & {
        isContentEditable?: boolean
        matches?: (selector: string) => boolean
        closest?: (selector: string) => Element | null
      })
    | null
  if (!element || typeof element.matches !== 'function') return false
  if (element.matches('input, textarea, select, [role="textbox"]')) return true
  if (element.isContentEditable) return true
  return Boolean(
    element.closest?.(
      'input, textarea, select, [role="textbox"], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
    )
  )
}

export function expectedBottomScrollTop(input: {
  scrollHeight: number
  clientHeight: number
}): number {
  const scrollHeight = Number.isFinite(input.scrollHeight) ? input.scrollHeight : 0
  const clientHeight = Number.isFinite(input.clientHeight) ? input.clientHeight : 0
  return Math.max(0, scrollHeight - clientHeight)
}

export function isExpectedProgrammaticScroll(input: {
  expectedScrollTop: number | null | undefined
  nextScrollTop: number
}): boolean {
  if (typeof input.expectedScrollTop !== 'number') return false
  if (!Number.isFinite(input.expectedScrollTop) || !Number.isFinite(input.nextScrollTop)) {
    return false
  }
  return Math.abs(input.nextScrollTop - input.expectedScrollTop) <= PROGRAMMATIC_SCROLL_EPSILON_PX
}

/**
 * Decide whether the user has scrolled far enough away from the bottom
 * that auto-follow should disengage.
 */
export function shouldDisengageAutoFollow(distanceFromBottom: number): boolean {
  if (!Number.isFinite(distanceFromBottom)) return false
  return distanceFromBottom > STICK_DISENGAGE_PX
}

/**
 * Detect a user-owned upward scroll directly from scrollTop movement.
 *
 * Wheel/touch/key intent listeners catch the common paths before the browser
 * emits `scroll`, but scrollbar drags and some platform-native scroll gestures
 * can produce only a scroll event. The scroll listener itself is rAF-coalesced
 * for layout-thrash reasons, so this cheap direction check lets callers drop
 * auto-follow synchronously before the next streamed message layout effect can
 * snap the viewport back to the bottom.
 *
 * A scrollTop decrease alone is NOT sufficient evidence of user intent: when
 * transcript content SHRINKS while pinned to the bottom (ActivityStack rows
 * collapsing as a run completes — every ensemble participant close-out — or a
 * streaming placeholder unmounting), the browser clamps scrollTop down to the
 * new maximum and emits a scroll event indistinguishable by direction from a
 * scrollbar drag. Treating that clamp as a scroll-away disengaged auto-follow
 * at every participant boundary AND suppressed the resize re-pin that exists
 * to compensate for exactly that collapse. The discriminator is the landing
 * position: no user gesture can reduce scrollTop while remaining at the live
 * edge, so a decrease that still lands within the disengage threshold is the
 * clamp, not the user. (Non-finite `distanceFromBottom` is treated as
 * not-user via `shouldDisengageAutoFollow`'s guard — the wheel/touch intent
 * listeners still own disengage if metrics are briefly inconsistent.)
 */
export function shouldTreatScrollAsUserScrollAway(input: {
  previousScrollTop: number
  nextScrollTop: number
  distanceFromBottom: number
  isProgrammatic: boolean
}): boolean {
  if (input.isProgrammatic) return false
  if (!Number.isFinite(input.previousScrollTop) || !Number.isFinite(input.nextScrollTop)) {
    return false
  }
  if (input.previousScrollTop <= 0) return false
  if (input.nextScrollTop >= input.previousScrollTop - 0.5) return false
  return shouldDisengageAutoFollow(input.distanceFromBottom)
}

/**
 * Scroll geometry is shared by user gestures and browser-owned layout clamps.
 * Only input paths that TaskWraith can attribute to the user may disengage a
 * pinned transcript. Wheel/touch/key handlers set the frame flag directly;
 * native scrollbar drags are attributed while their pointer remains active.
 */
export function hasExplicitTranscriptScrollAwayIntent(input: {
  userScrolledAwayInThisFrame: boolean
  scrollbarPointerActive: boolean
  previousScrollTop: number
  nextScrollTop: number
}): boolean {
  if (input.userScrolledAwayInThisFrame) return true
  if (!input.scrollbarPointerActive) return false
  if (!Number.isFinite(input.previousScrollTop) || !Number.isFinite(input.nextScrollTop)) {
    return false
  }
  return input.nextScrollTop < input.previousScrollTop - 0.5
}

/**
 * Synchronous DOM guard for layout-effect and rAF snap paths. The scroll
 * listener coalesces its evaluate pass, so `autoFollowRef` can still read
 * "follow" when a committed message update runs before the listener has
 * evaluated the user's new scroll position. Compare the latest native sample
 * against the live scroller using the same predicate as the scroll listener's
 * immediate scroll-away branch. The rAF-coalesced sample is retained only as
 * a defensive fallback.
 */
export function shouldAbortAutoFollowSnap(input: {
  lastRecordedScrollTop: number
  lastNativeScrollTop: number
  currentScrollTop: number
  scrollHeight: number
  clientHeight: number
  expectedProgrammaticScrollTop: number | null | undefined
  hasExplicitScrollAwayIntent: boolean
}): boolean {
  if (!input.hasExplicitScrollAwayIntent) return false
  const distanceFromBottom =
    input.scrollHeight - input.currentScrollTop - input.clientHeight
  const isProgrammatic = isExpectedProgrammaticScroll({
    expectedScrollTop: input.expectedProgrammaticScrollTop,
    nextScrollTop: input.currentScrollTop
  })
  return shouldTreatScrollAsUserScrollAway({
    // Native scroll events update this position synchronously, while the
    // evaluator's recorded position is intentionally rAF-coalesced. A
    // live-edge content shrink can therefore clamp scrollTop and update the
    // native sample before the evaluator catches up. If new content then grows
    // the tail in the same frame, the stale evaluated sample looks exactly
    // like a user-owned upward scroll. Prefer the native sample; retain the
    // evaluated value only as a defensive fallback for malformed callers.
    previousScrollTop: Number.isFinite(input.lastNativeScrollTop)
      ? input.lastNativeScrollTop
      : input.lastRecordedScrollTop,
    nextScrollTop: input.currentScrollTop,
    distanceFromBottom,
    isProgrammatic
  })
}

/**
 * A scroll event caused by live-edge layout churn can be evaluated after the
 * next transcript row has already grown the tail. If follow is still owned by
 * the app and no user-away intent exists, distance from the bottom is a signal
 * to re-pin — never a reason to silently hand ownership to a layout clamp.
 */
export function shouldRepinAfterScrollEvaluation(input: {
  autoFollow: boolean
  userScrolledAwayInThisFrame: boolean
  jumpInFlight: boolean
  distanceFromBottom: number
}): boolean {
  if (!input.autoFollow) return false
  if (input.userScrolledAwayInThisFrame) return false
  if (input.jumpInFlight) return false
  return shouldDisengageAutoFollow(input.distanceFromBottom)
}

/**
 * Decide whether a post-frame re-pin should fire after a messages
 * update. Re-pinning is only valuable when auto-follow is still
 * engaged _and_ we have not observed a deliberate user scroll-away
 * since the last paint. The latter guard is critical: without it, a
 * legitimate scroll-up could be fought by the rAF callback writing
 * `scrollTop = scrollHeight` and snapping the user back down.
 */
export function shouldRepinAfterFrame(input: {
  autoFollow: boolean
  userScrolledAwayInThisFrame: boolean
}): boolean {
  if (!input.autoFollow) return false
  if (input.userScrolledAwayInThisFrame) return false
  return true
}

/**
 * Chat switches normally land at the live edge, but an explicit message jump
 * issued during the switch owns the scroll position for that frame.
 */
export function shouldSnapAfterChatSwitch(input: {
  autoFollow: boolean
  userScrolledAwayInThisFrame: boolean
  hasPendingManualJump: boolean
}): boolean {
  if (input.hasPendingManualJump) return false
  return shouldRepinAfterFrame(input)
}

/**
 * DOM event name dispatched (bubbling) by each `HighlightedCodeBlock`
 * when its rendered element resizes after the initial CodeMirror
 * measurement pass. The transcript scroll effect listens for this on
 * the scroll container and runs the standard rAF re-pin path.
 *
 * Why this is safe even though a ResizeObserver feedback loop is the
 * documented historical bug: the previous loop observed the _entire
 * transcript content_ via a single ResizeObserver wrapping the scroll
 * container. That observer fired on every scrollTop write (because
 * any reflow during the write changed the observed element's content
 * rect), so its callback could chain back into more scroll writes and
 * keep oscillating.
 *
 * The observers here are scoped to individual code-block elements and
 * fire only when CodeMirror itself recomputes the block's measured
 * height (i.e. once shortly after the block first mounts, then on
 * subsequent content/font/wrap changes — none of which are caused by
 * the scroll write). Setting `scrollTop` on an ancestor scroller does
 * not change the code block's own bounding rect, so dispatching this
 * event and re-pinning the scroller from its handler cannot feed back.
 */
export const CODE_BLOCK_RESIZE_EVENT = 'taskwraith:code-block-resized'

/**
 * Payload shape carried on a `CODE_BLOCK_RESIZE_EVENT`. The receiver
 * uses the `width`/`height` fields only for diagnostics; the actual
 * re-pin decision is driven by `shouldRepinAfterCodeBlockResize`.
 */
export interface CodeBlockResizeDetail {
  /** Pixel width of the resized block at the time the entry fired. */
  width: number
  /** Pixel height of the resized block at the time the entry fired. */
  height: number
}

/**
 * Build the `CustomEventInit` for a code-block resize dispatch. Used
 * by `HighlightedCodeBlock` and asserted by tests so the event shape
 * stays in lockstep with the listener in App.tsx.
 *
 * Defensive against malformed `ResizeObserverEntry` inputs (jsdom and
 * some embedded browsers don't expose `contentRect`).
 */
export function buildCodeBlockResizeEventInit(
  entry: { contentRect?: { width?: number; height?: number } } | undefined | null
): CustomEventInit<CodeBlockResizeDetail> {
  const width = entry?.contentRect?.width
  const height = entry?.contentRect?.height
  return {
    bubbles: true,
    composed: true,
    detail: {
      width: typeof width === 'number' && Number.isFinite(width) ? width : 0,
      height: typeof height === 'number' && Number.isFinite(height) ? height : 0
    }
  }
}

/**
 * Decide whether a code-block-resize event should trigger a re-pin.
 * Same guarding rules as `shouldRepinAfterFrame` — never fight a
 * deliberate scroll-up, never re-pin when auto-follow is already
 * disengaged. Kept as its own helper so the test surface stays
 * symmetrical with the frame-based re-pin.
 */
export function shouldRepinAfterCodeBlockResize(input: {
  autoFollow: boolean
  userScrolledAwayInThisFrame: boolean
}): boolean {
  return shouldRepinAfterFrame(input)
}

/**
 * Decide whether a transcript-content resize should trigger a re-pin.
 *
 * Background — the bug this helper exists to address (Codex follow-up
 * to the Kimi code-block fix in commit a12f913):
 *
 * The per-`HighlightedCodeBlock` ResizeObserver (a12f913) caught the
 * CodeMirror late-measurement case but NOT every source of late layout
 * growth. Codex chats heavy with `Ran /bin/zsh -lc '...'` rows still
 * bounced the user upward when:
 *
 *   - A shell-command activity row mounted with multi-line stdout that
 *     measured asynchronously (similar to CodeMirror).
 *   - A pending tool row transitioned to completed and revealed
 *     previously-hidden output.
 *   - New activity rows were appended during streaming and pushed the
 *     scroll height up faster than the messages-update rAF re-pin
 *     could coalesce.
 *
 * The fix observes the SINGLE inner content div
 * (`.transcript-inner`) with one ResizeObserver — catching ALL of the
 * above plus any future content type — instead of plumbing
 * per-component observers. The re-pin decision uses the same guards
 * as the other re-pin paths so the gating logic stays unified.
 *
 * Why observing the inner content div does NOT re-introduce the
 * documented ResizeObserver feedback loop:
 *
 *   - The historical loop observed the SCROLL CONTAINER itself (or a
 *     wrapper whose content rect was implicitly tied to scrollHeight).
 *     Every `scrollTop` write that caused a reflow re-entered the
 *     observer callback.
 *   - The inner content div's border-box / content-box / device-pixel
 *     -content-box dimensions are determined by its children's
 *     intrinsic sizes (and the flex/grid layout), NOT by the ancestor
 *     scroll container's `scrollTop`. Writing `scrollTop` on the
 *     ancestor cannot change the content div's measured rect, so the
 *     re-pin path cannot loop.
 *   - Even in a pathological spurious-fire scenario, the gate below
 *     keeps us idempotent: when at the bottom and auto-follow is
 *     engaged, `scrollTop = scrollHeight` is a no-op.
 *
 * Same delegation pattern as `shouldRepinAfterCodeBlockResize` so the
 * three re-pin paths (messages-update frame, code-block resize,
 * transcript-content resize) all share one truth source for the
 * scroll-away / auto-follow guards.
 */
export function shouldRepinAfterTranscriptResize(input: {
  autoFollow: boolean
  userScrolledAwayInThisFrame: boolean
}): boolean {
  return shouldRepinAfterFrame(input)
}

/**
 * Decide whether the "↓ N new messages" jump-to-latest pill should be
 * visible on the transcript scroller.
 *
 * The pill makes the *absence* of auto-scroll visible. Once the
 * scroll-listener has disengaged auto-follow (the user scrolled up to
 * read older content) any new messages arriving below are silent — the
 * Slack/Discord/YouTube pattern surfaces a click-to-jump affordance so
 * the user has a one-tap way back to the live edge without losing their
 * place mid-read.
 *
 * Visibility rule — `autoFollow` must be disengaged (user is reading older
 * content; if the transcript is already pinned to the bottom the user can
 * see the new messages directly and the pill would be noise), AND at least
 * one of:
 *   1. `unreadCount > 0` — whole new messages arrived below the viewport.
 *   2. `streamingActive` — a run is streaming into the CURRENT tail bubble.
 *      Text growth inside one message never bumps the message-count-based
 *      unread number, so a user who scrolls up mid-answer would otherwise
 *      get no affordance at all back to the live edge (Claude/Codex show
 *      their jump arrow for this case).
 *
 * Defensive against malformed inputs: a NaN/negative count is treated
 * as zero (no pill unless streaming). This mirrors the
 * `shouldEngageAutoFollow`/`shouldDisengageAutoFollow` non-finite
 * guards so the visibility logic stays robust against any future caller
 * that hands in a stale or partially-initialised value.
 */
export function shouldShowJumpToLatestPill(input: {
  autoFollow: boolean
  unreadCount: number
  streamingActive?: boolean
}): boolean {
  if (input.autoFollow) return false
  if (input.streamingActive === true) return true
  if (!Number.isFinite(input.unreadCount)) return false
  return input.unreadCount > 0
}
