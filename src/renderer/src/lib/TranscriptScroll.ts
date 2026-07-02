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
 * gesture (`recentDownwardIntent`: wheel/touch/keys — the signals scroll
 * EVENTS cannot fake); the caller then snaps the remaining distance so the
 * gesture completes at the live edge. Scrollbar scrubs, shrink clamps, and
 * unarmed restore writes produce no input gesture and keep the strict 2px
 * path — so pausing a drag near the bottom to read is never captured, and
 * an app-owned reflow can never convert a reading position into a re-lock.
 */
export const STICK_REENGAGE_DOWNWARD_PX = 48

/**
 * How long a downward wheel/touch/key gesture vouches for a near-bottom
 * landing. Long enough to cover the gesture's own momentum and the rAF
 * evaluate that follows it; short enough that a stale flick can't hand the
 * band to an unrelated later layout shift.
 */
export const DOWNWARD_INTENT_WINDOW_MS = 400

export const PROGRAMMATIC_SCROLL_EPSILON_PX = 1

export interface ChatScrollState {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  scrollRatio: number
  atBottom: boolean
  anchorMessageId?: string
  anchorOffset?: number
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
  scrollState: ChatScrollState | undefined
): void {
  if (!scroller || !scrollState) return
  const apply = () => {
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    if (scrollState.atBottom) {
      scroller.scrollTop = scroller.scrollHeight
      return
    }
    if (restoreChatScrollAnchor(scroller, scrollState)) return
    scroller.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollState.scrollRatio * maxScrollTop))
  }
  requestAnimationFrame(() => {
    apply()
    requestAnimationFrame(apply)
  })
}

export function restoreChatScrollStateWhenReady(
  getScroller: () => HTMLElement | null | undefined,
  scrollState: ChatScrollState | undefined,
  attempts = 8
): void {
  if (!scrollState) return
  let remainingAttempts = attempts
  const tryRestore = () => {
    const scroller = getScroller()
    if (scroller) {
      restoreChatScrollState(scroller, scrollState)
      return
    }
    if (remainingAttempts <= 0) return
    remainingAttempts -= 1
    requestAnimationFrame(tryRestore)
  }
  tryRestore()
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
 * move upward. In that case, only a real downward movement back to the live
 * edge should clear the scroll-away guard.
 */
export function shouldReengageAutoFollowAfterScroll(input: {
  distanceFromBottom: number
  userScrolledAwayInThisFrame: boolean
  previousScrollTop: number
  nextScrollTop: number
  isProgrammatic: boolean
  /** True when a downward wheel/touch/key gesture happened within
   *  DOWNWARD_INTENT_WINDOW_MS and no upward gesture followed it. Scroll
   *  EVENTS can't prove a gesture (scrollbar scrubs, restore writes, and a
   *  frame-coalesced net movement all look alike), so the wide band demands
   *  this out-of-band evidence. */
  recentDownwardIntent: boolean
}): boolean {
  const movedDown =
    Number.isFinite(input.previousScrollTop) &&
    Number.isFinite(input.nextScrollTop) &&
    input.nextScrollTop > input.previousScrollTop + 0.5
  if (shouldEngageAutoFollow(input.distanceFromBottom)) {
    if (!input.userScrolledAwayInThisFrame) return true
    if (input.isProgrammatic) return false
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
