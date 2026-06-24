import { describe, it, expect } from 'vitest'
import {
  STICK_ENGAGE_PX,
  STICK_DISENGAGE_PX,
  shouldEngageAutoFollow,
  shouldDisengageAutoFollow,
  shouldRepinAfterFrame,
  shouldRepinAfterCodeBlockResize,
  shouldRepinAfterTranscriptResize,
  shouldShowJumpToLatestPill,
  buildCodeBlockResizeEventInit,
  CODE_BLOCK_RESIZE_EVENT
} from './TranscriptScroll'

describe('TranscriptScroll', () => {
  describe('shouldEngageAutoFollow', () => {
    it('engages when essentially at the bottom', () => {
      expect(shouldEngageAutoFollow(0)).toBe(true)
    })

    it('engages within the threshold band', () => {
      expect(shouldEngageAutoFollow(STICK_ENGAGE_PX - 1)).toBe(true)
      expect(shouldEngageAutoFollow(STICK_ENGAGE_PX)).toBe(true)
    })

    it('does not engage above the threshold', () => {
      expect(shouldEngageAutoFollow(STICK_ENGAGE_PX + 1)).toBe(false)
    })

    it('does not treat a partially scrolled transcript as bottom-pinned', () => {
      // New messages should follow only when the user was already at
      // the live edge. A normal streamed line can be 20-40px tall; if
      // we used that as an engage band, a user reading just above the
      // bottom would get pulled down unexpectedly.
      expect(shouldEngageAutoFollow(40)).toBe(false)
    })

    it('rejects non-finite inputs defensively', () => {
      expect(shouldEngageAutoFollow(Number.NaN)).toBe(false)
      expect(shouldEngageAutoFollow(Number.POSITIVE_INFINITY)).toBe(false)
    })
  })

  describe('shouldDisengageAutoFollow', () => {
    it('does not disengage near the bottom', () => {
      expect(shouldDisengageAutoFollow(0)).toBe(false)
      expect(shouldDisengageAutoFollow(STICK_DISENGAGE_PX)).toBe(false)
    })

    it('disengages beyond the threshold', () => {
      expect(shouldDisengageAutoFollow(STICK_DISENGAGE_PX + 1)).toBe(true)
    })

    it('uses hysteresis: a tighter engage band than disengage', () => {
      // Re-engage requires being genuinely at the live edge; disengage is
      // sensitive (a small scrollbar drag away releases follow). The gap
      // between them is a dead-band that stops a single pixel of layout
      // jitter at the bottom from oscillating the follow state.
      expect(STICK_ENGAGE_PX).toBeLessThan(STICK_DISENGAGE_PX)
    })

    it('rejects non-finite inputs defensively', () => {
      expect(shouldDisengageAutoFollow(Number.NaN)).toBe(false)
      expect(shouldDisengageAutoFollow(Number.POSITIVE_INFINITY)).toBe(false)
    })
  })

  describe('shouldRepinAfterFrame', () => {
    it('re-pins when auto-follow is engaged and the user has not scrolled away', () => {
      expect(
        shouldRepinAfterFrame({
          autoFollow: true,
          userScrolledAwayInThisFrame: false
        })
      ).toBe(true)
    })

    it('skips the re-pin when auto-follow is already disengaged', () => {
      expect(
        shouldRepinAfterFrame({
          autoFollow: false,
          userScrolledAwayInThisFrame: false
        })
      ).toBe(false)
    })

    it('skips the re-pin when the user actively scrolled away in this frame', () => {
      // Critical: this guard prevents the rAF callback from fighting
      // a deliberate user scroll-up.
      expect(
        shouldRepinAfterFrame({
          autoFollow: true,
          userScrolledAwayInThisFrame: true
        })
      ).toBe(false)
    })
  })

  describe('shouldRepinAfterCodeBlockResize', () => {
    it('re-pins when auto-follow is engaged and the user has not scrolled away', () => {
      // The code-block resize path uses the same guards as the
      // frame-update path; this test pins the symmetry so the two
      // helpers cannot diverge by accident.
      expect(
        shouldRepinAfterCodeBlockResize({
          autoFollow: true,
          userScrolledAwayInThisFrame: false
        })
      ).toBe(true)
    })

    it('respects auto-follow disengagement', () => {
      expect(
        shouldRepinAfterCodeBlockResize({
          autoFollow: false,
          userScrolledAwayInThisFrame: false
        })
      ).toBe(false)
    })

    it('respects a user-initiated scroll-away in this frame', () => {
      expect(
        shouldRepinAfterCodeBlockResize({
          autoFollow: true,
          userScrolledAwayInThisFrame: true
        })
      ).toBe(false)
    })
  })

  describe('shouldRepinAfterTranscriptResize', () => {
    it('re-pins when auto-follow is engaged and the user has not scrolled away', () => {
      // The transcript-content resize path (Codex follow-up to the
      // Kimi code-block fix) shares the exact same guards as both
      // `shouldRepinAfterFrame` and `shouldRepinAfterCodeBlockResize`.
      // This test pins the symmetry so the three helpers cannot
      // diverge by accident — they all need to agree that "re-pin
      // when at the bottom and the user has not moved".
      expect(
        shouldRepinAfterTranscriptResize({
          autoFollow: true,
          userScrolledAwayInThisFrame: false
        })
      ).toBe(true)
    })

    it('respects auto-follow disengagement', () => {
      // If the user has already scrolled away enough that auto-follow
      // disengaged, a content resize must NOT yank them back to the
      // bottom — they explicitly opted out of sticky mode.
      expect(
        shouldRepinAfterTranscriptResize({
          autoFollow: false,
          userScrolledAwayInThisFrame: false
        })
      ).toBe(false)
    })

    it('respects a user-initiated scroll-away in this frame', () => {
      // Critical guard: a content resize fired mid-frame must not
      // fight a deliberate user scroll-up that happened in the same
      // frame. This mirrors the per-frame guard on the code-block
      // resize path.
      expect(
        shouldRepinAfterTranscriptResize({
          autoFollow: true,
          userScrolledAwayInThisFrame: true
        })
      ).toBe(false)
    })

    it('matches shouldRepinAfterFrame for every input combination', () => {
      // The two helpers are deliberately delegated to the same
      // underlying gate. If a future change breaks the delegation,
      // this exhaustive cross-check fails immediately rather than
      // letting the three re-pin paths drift apart silently.
      for (const autoFollow of [true, false]) {
        for (const userScrolledAwayInThisFrame of [true, false]) {
          const input = { autoFollow, userScrolledAwayInThisFrame }
          expect(shouldRepinAfterTranscriptResize(input)).toBe(shouldRepinAfterFrame(input))
        }
      }
    })
  })

  // The Raw Events panel in the Inspector reuses these exact helpers
  // (see App.tsx, search for `rawEventsAutoFollowRef`). Before the
  // sticky-bottom fix the panel unconditionally scrolled to the bottom
  // whenever a new event arrived, fighting users trying to read older
  // events during an active run. The tests below pin the behaviour the
  // raw-events surface depends on so a future refactor of these
  // helpers cannot silently regress that fix.
  describe('Raw Events panel (App.tsx Inspector) reuse', () => {
    it('engages sticky-bottom at the same thresholds as the transcript', () => {
      // Both surfaces use the same engage threshold so users get a
      // consistent "near the bottom" feel between the two scrollers.
      expect(shouldEngageAutoFollow(0)).toBe(true)
      expect(shouldEngageAutoFollow(STICK_ENGAGE_PX)).toBe(true)
      expect(shouldEngageAutoFollow(STICK_ENGAGE_PX + 1)).toBe(false)
    })

    it('disengages at the same hysteresis threshold as the transcript', () => {
      expect(shouldDisengageAutoFollow(STICK_DISENGAGE_PX)).toBe(false)
      expect(shouldDisengageAutoFollow(STICK_DISENGAGE_PX + 1)).toBe(true)
    })

    it('does not re-pin when the user has actively scrolled away', () => {
      // This is the original bug: every new event force-scrolled to
      // the bottom regardless of whether the user was reading older
      // entries. With the fix in place the auto-scroll effect calls
      // `shouldRepinAfterFrame` and bails out when the user has
      // recorded a scroll-away intent in the current frame.
      expect(
        shouldRepinAfterFrame({
          autoFollow: true,
          userScrolledAwayInThisFrame: true
        })
      ).toBe(false)
    })

    it('does not re-pin when auto-follow has disengaged', () => {
      // Once the user has scrolled past the disengage threshold,
      // auto-follow flips off until they scroll back to the engage
      // zone. The auto-scroll effect on the Raw Events panel must
      // honour this even when the panel is the active tab.
      expect(
        shouldRepinAfterFrame({
          autoFollow: false,
          userScrolledAwayInThisFrame: false
        })
      ).toBe(false)
    })

    it('re-pins when at the bottom and the user has not moved', () => {
      // The intended common case: user is at the bottom, a new event
      // arrives, the panel scrolls down to show it without any user
      // intervention.
      expect(
        shouldRepinAfterFrame({
          autoFollow: true,
          userScrolledAwayInThisFrame: false
        })
      ).toBe(true)
    })
  })

  describe('shouldShowJumpToLatestPill', () => {
    it('hides the pill when auto-follow is engaged (user is already at the bottom)', () => {
      // The pill is a "jump to where new content is" affordance. When
      // the transcript is sticky-bottom the user already sees new
      // content, so the pill would be visual noise.
      expect(shouldShowJumpToLatestPill({ autoFollow: true, unreadCount: 0 })).toBe(false)
      expect(shouldShowJumpToLatestPill({ autoFollow: true, unreadCount: 5 })).toBe(false)
    })

    it('hides the pill when there are no unread messages', () => {
      // Even when the user has scrolled up, an empty counter means
      // nothing new arrived while they were reading — nothing to
      // advertise.
      expect(shouldShowJumpToLatestPill({ autoFollow: false, unreadCount: 0 })).toBe(false)
    })

    it('shows the pill when scrolled away AND at least one new message arrived', () => {
      // The intended use case: user is reading older content while
      // messages stream in below. Pill surfaces "↓ N new messages".
      expect(shouldShowJumpToLatestPill({ autoFollow: false, unreadCount: 1 })).toBe(true)
      expect(shouldShowJumpToLatestPill({ autoFollow: false, unreadCount: 47 })).toBe(true)
    })

    it('treats non-finite unread counts as zero (no pill)', () => {
      // Defensive parity with shouldEngageAutoFollow's NaN guard: a
      // partially-initialised or corrupted counter must not bleed
      // through as a visible pill.
      expect(shouldShowJumpToLatestPill({ autoFollow: false, unreadCount: Number.NaN })).toBe(false)
      expect(
        shouldShowJumpToLatestPill({ autoFollow: false, unreadCount: Number.POSITIVE_INFINITY })
      ).toBe(false)
    })

    it('treats negative counts as zero (no pill)', () => {
      // A negative delta should never reach this helper, but guard
      // against an off-by-one reset bug from the caller — show
      // nothing rather than a confusing "↓ -2 new messages".
      expect(shouldShowJumpToLatestPill({ autoFollow: false, unreadCount: -1 })).toBe(false)
    })
  })

  describe('buildCodeBlockResizeEventInit', () => {
    it('exposes a stable event name constant', () => {
      // The renderer code path and the App.tsx listener look up this
      // name independently; locking the literal here means a typo on
      // either side trips a test rather than silently breaking
      // re-pin.
      expect(CODE_BLOCK_RESIZE_EVENT).toBe('taskwraith:code-block-resized')
    })

    it('produces a bubbling, composed CustomEventInit with the entry size', () => {
      const init = buildCodeBlockResizeEventInit({
        contentRect: { width: 120, height: 480 }
      })

      // bubbles = true is mandatory: the event has to reach the
      // transcript scroll container which is several DOM levels above
      // the code block element.
      expect(init.bubbles).toBe(true)
      expect(init.composed).toBe(true)
      expect(init.detail).toEqual({ width: 120, height: 480 })
    })

    it('defaults non-finite or missing dimensions to zero', () => {
      // jsdom and some embedded WebKit builds don't populate
      // contentRect on ResizeObserverEntry — the dispatcher should
      // still emit a usable event so listeners can react.
      expect(buildCodeBlockResizeEventInit(undefined).detail).toEqual({ width: 0, height: 0 })
      expect(buildCodeBlockResizeEventInit({}).detail).toEqual({ width: 0, height: 0 })
      expect(
        buildCodeBlockResizeEventInit({ contentRect: { width: Number.NaN, height: 12 } }).detail
      ).toEqual({ width: 0, height: 12 })
      expect(
        buildCodeBlockResizeEventInit({
          contentRect: { width: Number.POSITIVE_INFINITY, height: Number.NaN }
        }).detail
      ).toEqual({ width: 0, height: 0 })
    })
  })
})
