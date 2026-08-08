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
 *   2. After a layout snap-to-bottom write, schedule one extra rAF re-pin
 *      so late-mount layout growth/shrink (ActivityStack collapse, etc.)
 *      can settle and we re-anchor the visible bottom. The re-pin is
 *      gated on `autoFollow` _and_ a flag that goes false the moment we
 *      observe a real user-initiated upward scroll, so the compensation
 *      pass never fights a deliberate scroll-up.
 *
 * Phase E — outer transcript pin ownership is a single coalesced path
 * (`createFollowPinScheduler`): messages-layout trailing re-pin, content
 * ResizeObserver, and scroll-evaluate gap-close share one rAF slot so
 * follow mode writes `scrollTop` at most once per frame after the
 * pre-paint layout snap. Nested LiveActivityViewport pinning stays
 * independent.
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
 * How long a verified user scroll gesture (any direction) stays "live" for
 * Phase-1 anchor-correction deferral. Short enough that a stop settles in
 * about one frame of inertia, long enough to cover wheel/touch momentum
 * ticks. Deliberately narrower than {@link DOWNWARD_INTENT_WINDOW_MS} — that
 * voucher arms follow re-engage; this one only pauses absolute restore mid-
 * fling so it does not fight the reader.
 */
export const USER_SCROLL_GESTURE_WINDOW_MS = 120

/**
 * Width of the pointer hit strip used for overlay scrollbars. macOS overlay
 * scrollbars do not consume layout width (`offsetWidth - clientWidth === 0`),
 * so the native gutter alone cannot identify a thumb drag. Pointer events that
 * start inside this narrow inline-end strip are treated as scrollbar gestures
 * only while the transcript actually overflows.
 */
export const OVERLAY_SCROLLBAR_HIT_PX = 14

export const PROGRAMMATIC_SCROLL_EPSILON_PX = 1

/** Phase-1 absolute-restore epsilon — matches the virtualizer's 0.5px gate. */
export const PHASE1_ANCHOR_CORRECTION_EPSILON_PX = 0.5

/**
 * Distance, in CSS pixels, within which the transcript viewport counts as
 * showing the live edge. This is the same 24px band `captureChatScrollState`
 * uses for its `atBottom` capture and `VIEWPORT_STICK_PX` uses for the
 * contained live-activity viewport, kept as one named constant so "the user
 * can see the latest content" means the same thing everywhere.
 *
 * The jump-to-latest pill uses it as a visibility gate: run machinery
 * (tool batches, reasoning) streams inside fixed-height contained viewports,
 * so raw message arrivals do not prove anything new exists BELOW the reader's
 * viewport. While the reader is inside this band there is nowhere to jump —
 * showing the pill there is a lie, and any unread tally is by definition
 * already read.
 */
export const LIVE_EDGE_PROXIMITY_PX = 24

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

/**
 * Whether a user-owned scroll gesture is currently live (cut 2a).
 *
 * True while the scrollbar pointer is held, or while `lastUserScrollAt` falls
 * inside the short settle window (wheel/touch/key stamps). Sticky
 * "scrolled away / follow off" ownership must NOT feed this — that would
 * starve Phase-1 for the whole reading session.
 */
export function isTranscriptUserScrollGestureLive(input: {
  lastUserScrollAt: number
  scrollbarPointerActive: boolean
  now: number
  windowMs?: number
}): boolean {
  if (input.scrollbarPointerActive) return true
  if (
    !Number.isFinite(input.lastUserScrollAt) ||
    !Number.isFinite(input.now) ||
    input.lastUserScrollAt <= 0
  ) {
    return false
  }
  const windowMs =
    typeof input.windowMs === 'number' && Number.isFinite(input.windowMs) && input.windowMs >= 0
      ? input.windowMs
      : USER_SCROLL_GESTURE_WINDOW_MS
  const elapsed = input.now - input.lastUserScrollAt
  return elapsed >= 0 && elapsed <= windowMs
}

export type Phase1AnchorCorrectionDecision = 'skip' | 'defer' | 'apply'

/**
 * Decide whether Phase-1 absolute anchor correction should write this
 * pre-paint pass (cut 2a). Hard gates (`skipNext`, bottom, missing anchor,
 * sub-epsilon delta) skip entirely. Soft skip (`!measureConverged`) also
 * returns `'skip'` but is re-armable via `shouldRearmPhase1DeferOnSkip`. A
 * live user gesture defers without arming the programmatic scroll guard;
 * otherwise apply.
 */
export function decidePhase1AnchorCorrection(input: {
  skipNext: boolean
  measureConverged: boolean
  atBottom: boolean
  hasAnchor: boolean
  absDeltaPx: number
  gestureLive: boolean
  epsilonPx?: number
}): Phase1AnchorCorrectionDecision {
  const epsilon =
    typeof input.epsilonPx === 'number' &&
    Number.isFinite(input.epsilonPx) &&
    input.epsilonPx >= 0
      ? input.epsilonPx
      : PHASE1_ANCHOR_CORRECTION_EPSILON_PX
  if (input.skipNext) return 'skip'
  if (!input.measureConverged) return 'skip'
  if (input.atBottom) return 'skip'
  if (!input.hasAnchor) return 'skip'
  if (!Number.isFinite(input.absDeltaPx) || input.absDeltaPx <= epsilon) return 'skip'
  if (input.gestureLive) return 'defer'
  return 'apply'
}

/**
 * Whether a Phase-1 skip should keep a previously deferred restore alive.
 *
 * Soft skip only (`!measureConverged` while still anchored away from the
 * bottom): re-arm the settle timer. Hard skips (`skipNext`, atBottom, missing
 * anchor, or a converged sub-epsilon/no-op) must clear — otherwise a flush
 * that hard-skips after the timer would drop the restore forever, or a
 * sub-epsilon skip would spin the timer.
 */
export function shouldRearmPhase1DeferOnSkip(input: {
  deferredPending: boolean
  skipNext: boolean
  atBottom: boolean
  hasAnchor: boolean
  measureConverged: boolean
}): boolean {
  if (!input.deferredPending) return false
  if (input.skipNext) return false
  if (input.atBottom) return false
  if (!input.hasAnchor) return false
  return !input.measureConverged
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

export interface ExternalRestoreLifecycle {
  settled: boolean
  chatSwitchObserved: boolean
}

export function advanceExternalRestoreLifecycle(
  state: ExternalRestoreLifecycle,
  event: 'settled' | 'chat-switch-observed'
): { state: ExternalRestoreLifecycle; shouldClear: boolean } {
  const next = {
    settled: state.settled || event === 'settled',
    chatSwitchObserved: state.chatSwitchObserved || event === 'chat-switch-observed'
  }
  return { state: next, shouldClear: next.settled && next.chatSwitchObserved }
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
    atBottom: distanceFromBottom <= LIVE_EDGE_PROXIMITY_PX
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
  onSettled: () => void = () => {},
  settleFrames = 2
): () => void {
  if (!scroller || !scrollState) return () => {}
  let cancelled = false
  let rafId: number | null = null
  let remainingFrames = Math.max(1, Math.floor(settleFrames))
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
  const applyFrame = () => {
    rafId = null
    apply()
    if (cancelled || !shouldApply()) return
    remainingFrames -= 1
    if (remainingFrames <= 0) {
      onSettled()
      return
    }
    rafId = requestAnimationFrame(applyFrame)
  }
  rafId = requestAnimationFrame(applyFrame)
  return () => {
    cancelled = true
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null
  }
}

export function restoreChatScrollStateWhenReady(
  getScroller: () => HTMLElement | null | undefined,
  scrollState: ChatScrollState | undefined,
  attempts = 8,
  shouldApply: () => boolean = () => true,
  onSettled: () => void = () => {},
  settleFrames = 2
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
        onSettled,
        settleFrames
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
 * Chromium's native scrollbar can move a scroll container without delivering
 * a usable wheel or pointer gesture to its content element. Treat that
 * unclassified upward movement as reader intent only when its geometry rules
 * out every browser-owned write that looks identical in a bare `scroll`
 * event — which in practice means the content and viewport heights must be
 * STABLE between the two samples:
 *
 *   - Content SHRINK: a tail collapse clamps a pinned scrollTop downward
 *     with no gesture (the original ActivityStack case).
 *   - Viewport growth: same clamp, different cause.
 *   - Content GROWTH: a scrollbar drag cannot change content height, so a
 *     height change means the samples STRADDLE app-owned layout and the
 *     movement is unattributable. The killer composite is the ensemble
 *     participant boundary: the settling participant's stack folds to a
 *     one-liner (shrink → browser clamps scrollTop down, scroll event
 *     queued), and the next participant's rows mount in an adjacent commit
 *     (growth) before this evaluation runs. Sampled across both commits the
 *     pair reads "scrollTop dropped while content grew — far from bottom",
 *     which the pre-stability guard scored as a reader drag: follow
 *     disengaged, the layout snap aborted, and the transcript silently lost
 *     its tail at every participant hand-off.
 *
 * Ambiguous churn frames therefore keep APP ownership: the layout-effect
 * snap and resize re-pin proceed, and a real-but-untracked drag defers its
 * disengage to the next event pair with stable geometry (native drags emit a
 * stream of events, so that pair arrives within a frame or two). This cannot
 * reintroduce the fight-the-reader glitch for ordinary gestures: wheel,
 * touch, key, and gutter-tracked scrollbar drags disengage through the
 * explicit intent paths, which do not consult geometry at all.
 *
 * This is deliberately narrower than `shouldTreatScrollAsUserScrollAway`.
 * The regular wheel/touch/key and tracked-scrollbar paths still own the
 * general case. This fallback exists so an ordinary native thumb/track drag
 * cannot leave auto-follow armed and let the next streamed transcript update
 * pull the reader to the tail.
 */
export function shouldTreatUnclassifiedNativeScrollAsUserScrollAway(input: {
  previousScrollTop: number
  nextScrollTop: number
  previousScrollHeight: number
  nextScrollHeight: number
  previousClientHeight: number
  nextClientHeight: number
  isProgrammatic: boolean
}): boolean {
  const geometry = [
    input.previousScrollHeight,
    input.nextScrollHeight,
    input.previousClientHeight,
    input.nextClientHeight
  ]
  if (geometry.some((value) => !Number.isFinite(value))) return false

  // Geometry stability requirement — see the doc comment above. Shrink and
  // viewport growth are browser clamps; content growth means the sample pair
  // straddles an app-owned layout change (participant-boundary fold +
  // next-participant mount) and attribution is impossible.
  if (input.nextScrollHeight < input.previousScrollHeight - 0.5) return false
  if (input.nextScrollHeight > input.previousScrollHeight + 0.5) return false
  if (input.nextClientHeight > input.previousClientHeight + 0.5) return false

  return shouldTreatScrollAsUserScrollAway({
    previousScrollTop: input.previousScrollTop,
    nextScrollTop: input.nextScrollTop,
    distanceFromBottom: input.nextScrollHeight - input.nextScrollTop - input.nextClientHeight,
    isProgrammatic: input.isProgrammatic
  })
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
 * Historical DOM event name for per-code-block late resize (CodeMirror
 * async measure). Phase C replaced transcript code blocks with a static
 * Lezer `<pre>`, which has correct height on first layout, so
 * `HighlightedCodeBlock` no longer dispatches this. Phase E retired the
 * outer scroller listener — wrap-toggle / late growth is covered by the
 * content-level transcript ResizeObserver feeding the coalesced follow
 * pin scheduler. The constant and helpers remain for tests and any
 * residual emitter that must not crash.
 */
export const CODE_BLOCK_RESIZE_EVENT = 'taskwraith:code-block-resized'

/**
 * Payload shape carried on a `CODE_BLOCK_RESIZE_EVENT`. Retained for
 * event-shape lockstep with historical emitters; Phase E does not pin
 * from this event on the outer transcript scroller.
 */
export interface CodeBlockResizeDetail {
  /** Pixel width of the resized block at the time the entry fired. */
  width: number
  /** Pixel height of the resized block at the time the entry fired. */
  height: number
}

/**
 * Build the `CustomEventInit` for a code-block resize dispatch. Retained
 * for tests / residual emitters so the event shape stays stable even
 * though the outer transcript listener was retired in Phase E.
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
 * Same guarding rules as `shouldRepinAfterFrame`. Kept for API/test
 * symmetry; the outer transcript no longer listens for the event.
 */
export function shouldRepinAfterCodeBlockResize(input: {
  autoFollow: boolean
  userScrolledAwayInThisFrame: boolean
}): boolean {
  return shouldRepinAfterFrame(input)
}

/**
 * Coalesce follow-mode pin requests onto a single rAF write.
 *
 * Phase E — the outer transcript has several seams that want to pin
 * while following (messages-layout trailing re-pin, content ResizeObserver,
 * scroll-evaluate gap-close). Without a shared slot each schedules its
 * own frame and streaming growth can write `scrollTop` multiple times
 * per paint. Nested LiveActivityViewport scrollers keep their own owner.
 */
export function createFollowPinScheduler(input: {
  apply: () => void
  requestAnimationFrame?: (callback: FrameRequestCallback) => number
  cancelAnimationFrame?: (handle: number) => void
}): {
  /** Schedule `apply` on the next animation frame; duplicate calls coalesce. */
  schedule: () => void
  /**
   * Apply once now (pre-paint layout path), then ensure exactly one
   * trailing coalesced rAF re-pin is pending for late measure.
   */
  pinNowAndScheduleTrailing: () => void
  /** Drop any pending coalesced frame (manual jump / unmount). */
  cancel: () => void
  /** Test seam: whether a coalesced frame is waiting. */
  isPending: () => boolean
} {
  let rafId: number | null = null

  const schedule = (): void => {
    if (rafId !== null) return
    // Resolve rAF lazily so constructing the scheduler in non-DOM test
    // harnesses does not require a global animation-frame polyfill.
    const raf = input.requestAnimationFrame ?? requestAnimationFrame
    rafId = raf(() => {
      rafId = null
      input.apply()
    })
  }

  return {
    schedule,
    pinNowAndScheduleTrailing: () => {
      input.apply()
      schedule()
    },
    cancel: () => {
      if (rafId === null) return
      const caf = input.cancelAnimationFrame ?? cancelAnimationFrame
      caf(rafId)
      rafId = null
    },
    isPending: () => rafId !== null
  }
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
 * Same delegation pattern as `shouldRepinAfterCodeBlockResize` so gate
 * helpers share one truth source for scroll-away / auto-follow. Phase E
 * routes content-resize pins through `createFollowPinScheduler` +
 * `shouldRepinAfterFrame` rather than a separate listener path.
 */
export function shouldRepinAfterTranscriptResize(input: {
  autoFollow: boolean
  userScrolledAwayInThisFrame: boolean
}): boolean {
  return shouldRepinAfterFrame(input)
}

/**
 * Message roles that render as first-class conversational bubbles. Everything
 * else in the messages array is run machinery: `tool` rows fold into activity
 * stacks (and stream inside the contained live-activity viewport), `system`
 * rows are notices/lifecycle/closeout chrome. Neither is a "new message" in
 * the sense the jump-to-latest pill promises.
 */
const JUMP_PILL_COUNTABLE_ROLES = new Set(['user', 'assistant', 'error'])

/**
 * Metadata kinds that count as messages regardless of their stored role.
 * Guest replies are persisted with `role: 'system' | 'tool'` but render as
 * assistant-style bubbles; the attention kinds (agent questions, plan
 * choices, approvals) are interactive cards that demand the user's input —
 * missing one while scrolled up is exactly what the pill exists to prevent.
 */
const JUMP_PILL_COUNTABLE_METADATA_KINDS = new Set([
  'guestParticipantReply',
  'agentQuestion',
  'planChoice',
  'approval',
  'pendingApproval'
])

/**
 * Whether a transcript entry counts toward the "↓ N new messages" tally.
 *
 * The unread number must count what the USER calls a message — a
 * conversational bubble or an attention card — not every array entry. Long
 * runs append dozens of `tool` activity batches and `system` lifecycle rows
 * per reply; counting those inflated the pill ("44 new messages") while the
 * only *message* still streaming was the current assistant bubble. Most of
 * that machinery also renders INSIDE an existing stack row's contained
 * viewport, so it adds nothing below the reader that a jump could reveal.
 *
 * Accepts `unknown` because the scroll-state hook deliberately treats the
 * messages array as opaque; malformed entries count as machinery (false).
 */
export function isJumpToLatestCountableMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const source = message as {
    role?: unknown
    metadata?: { kind?: unknown } | null
  }
  const kind = source.metadata?.kind
  if (typeof kind === 'string' && JUMP_PILL_COUNTABLE_METADATA_KINDS.has(kind)) {
    return true
  }
  return typeof source.role === 'string' && JUMP_PILL_COUNTABLE_ROLES.has(source.role)
}

/**
 * Count the pill-countable messages in a transcript array. Used for BOTH the
 * unread baseline and the per-update delta so the two are always measured in
 * the same unit — a raw-length baseline against a filtered current count (or
 * vice versa) would corrupt every delta after a chat switch.
 */
export function countJumpToLatestCountableMessages(
  messages: readonly unknown[] | undefined
): number {
  if (!messages) return 0
  let count = 0
  for (const message of messages) {
    if (isJumpToLatestCountableMessage(message)) count += 1
  }
  return count
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
 * Visibility rule — ALL of:
 *   a. `autoFollow` is disengaged (user owns the scroll; when pinned the
 *      new content is already in view and the pill would be noise), AND
 *   b. `awayFromLiveEdge` — the viewport is genuinely more than
 *      `LIVE_EDGE_PROXIMITY_PX` above the scroller's bottom. Follow can be
 *      off while the reader still SEES the live edge (shrink clamps land
 *      there without re-arming follow, and contained live-activity
 *      viewports stream run machinery without growing the outer scroller).
 *      In that state there is nowhere to jump — a pill would send the user
 *      to where they already are, AND
 *   c. at least one of:
 *      1. `unreadCount > 0` — countable messages (see
 *         `isJumpToLatestCountableMessage`) arrived below the viewport.
 *      2. `streamingActive` — a run is streaming into the CURRENT tail
 *         bubble. Text growth inside one message never bumps the
 *         message-count-based unread number, so a user who scrolls up
 *         mid-answer would otherwise get no affordance at all back to the
 *         live edge (Claude/Codex show their jump arrow for this case).
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
  awayFromLiveEdge: boolean
}): boolean {
  if (input.autoFollow) return false
  if (!input.awayFromLiveEdge) return false
  if (input.streamingActive === true) return true
  if (!Number.isFinite(input.unreadCount)) return false
  return input.unreadCount > 0
}
