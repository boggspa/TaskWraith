import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  advanceExternalRestoreLifecycle,
  DOWNWARD_INTENT_WINDOW_MS,
  USER_SCROLL_GESTURE_WINDOW_MS,
  STICK_ENGAGE_PX,
  STICK_REENGAGE_DOWNWARD_PX,
  STICK_DISENGAGE_PX,
  PROGRAMMATIC_SCROLL_EPSILON_PX,
  captureChatScrollState,
  countJumpToLatestCountableMessages,
  decidePhase1AnchorCorrection,
  shouldRearmPhase1DeferOnSkip,
  expectedBottomScrollTop,
  hasExplicitTranscriptScrollAwayIntent,
  hasRecentTranscriptDownwardIntent,
  isEditableTranscriptKeyTarget,
  isExpectedProgrammaticScroll,
  isJumpToLatestCountableMessage,
  isTranscriptScrollbarPointer,
  isTranscriptUserScrollGestureLive,
  normalizeChatScrollState,
  restoreChatScrollAnchor,
  restoreChatScrollState,
  resolveTranscriptChatSwitchPlan,
  shouldEngageAutoFollow,
  shouldReengageAutoFollowAfterScroll,
  shouldDisengageAutoFollow,
  shouldTreatScrollAsUserScrollAway,
  shouldAbortAutoFollowSnap,
  shouldRepinAfterFrame,
  shouldRepinAfterScrollEvaluation,
  shouldRepinAfterCodeBlockResize,
  shouldRepinAfterTranscriptResize,
  shouldRecordScrollbarDownwardIntent,
  shouldClearScrollbarDownwardIntent,
  shouldSnapAfterChatSwitch,
  shouldShowJumpToLatestPill,
  shouldTreatUnclassifiedNativeScrollAsUserScrollAway,
  buildCodeBlockResizeEventInit,
  createFollowPinScheduler,
  CODE_BLOCK_RESIZE_EVENT
} from './TranscriptScroll'

function fakeRect(top: number, bottom: number): DOMRect {
  return { top, bottom } as DOMRect
}

function fakeMessageNode(input: {
  id: string
  top: number
  bottom: number
}): HTMLElement {
  return {
    getAttribute: (name: string) => (name === 'data-message-id' ? input.id : null),
    getBoundingClientRect: () => fakeRect(input.top, input.bottom)
  } as unknown as HTMLElement
}

function fakeScroller(input: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  top?: number
  bottom?: number
  messages?: HTMLElement[]
  queryTarget?: HTMLElement | null
}): HTMLElement {
  return {
    scrollTop: input.scrollTop,
    scrollHeight: input.scrollHeight,
    clientHeight: input.clientHeight,
    getBoundingClientRect: () => fakeRect(input.top ?? 0, input.bottom ?? input.clientHeight),
    querySelectorAll: () => input.messages ?? [],
    querySelector: () => input.queryTarget ?? null
  } as unknown as HTMLElement
}

describe('TranscriptScroll', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('captureChatScrollState', () => {
    it('captures clamped scroll metrics and bottom state', () => {
      const scroller = fakeScroller({
        scrollTop: 980,
        scrollHeight: 1200,
        clientHeight: 200
      })

      expect(captureChatScrollState(scroller)).toEqual({
        scrollTop: 980,
        scrollHeight: 1200,
        clientHeight: 200,
        scrollRatio: 0.98,
        atBottom: true
      })
    })

    it('captures the first visible message anchor when scrolled away', () => {
      const beforeViewport = fakeMessageNode({ id: 'old', top: -100, bottom: -1 })
      const visible = fakeMessageNode({ id: 'target', top: 48, bottom: 120 })
      const afterViewport = fakeMessageNode({ id: 'later', top: 260, bottom: 320 })
      const scroller = fakeScroller({
        scrollTop: 400,
        scrollHeight: 1200,
        clientHeight: 200,
        top: 20,
        bottom: 220,
        messages: [beforeViewport, visible, afterViewport]
      })

      expect(captureChatScrollState(scroller)).toMatchObject({
        scrollTop: 400,
        atBottom: false,
        anchorMessageId: 'target',
        anchorOffset: 28
      })
    })
  })

  describe('normalizeChatScrollState', () => {
    it('clamps persisted scroll values while preserving a valid anchor', () => {
      expect(
        normalizeChatScrollState({
          scrollTop: -12,
          scrollHeight: 500,
          clientHeight: 180,
          scrollRatio: 1.4,
          atBottom: false,
          anchorMessageId: 'm-1',
          anchorOffset: '42'
        })
      ).toEqual({
        scrollTop: 0,
        scrollHeight: 500,
        clientHeight: 180,
        scrollRatio: 1,
        atBottom: false,
        anchorMessageId: 'm-1',
        anchorOffset: 42
      })
    })

    it('rejects malformed persisted scroll values', () => {
      expect(normalizeChatScrollState(null)).toBeUndefined()
      expect(normalizeChatScrollState({ scrollTop: 1 })).toBeUndefined()
      expect(
        normalizeChatScrollState({
          scrollTop: 1,
          scrollHeight: Number.NaN,
          clientHeight: 100,
          scrollRatio: 0.5
        })
      ).toBeUndefined()
    })
  })

  describe('restoreChatScrollAnchor', () => {
    it('restores by message anchor when the anchor is still present', () => {
      const target = fakeMessageNode({ id: 'm-2', top: 70, bottom: 120 })
      const scroller = fakeScroller({
        scrollTop: 100,
        scrollHeight: 800,
        clientHeight: 200,
        top: 10,
        bottom: 210,
        queryTarget: target
      })

      expect(
        restoreChatScrollAnchor(scroller, {
          scrollTop: 100,
          scrollHeight: 800,
          clientHeight: 200,
          scrollRatio: 0.25,
          atBottom: false,
          anchorMessageId: 'm-2',
          anchorOffset: 25
        })
      ).toBe(true)
      expect(scroller.scrollTop).toBe(135)
    })

    it('reports false when no usable anchor exists', () => {
      const scroller = fakeScroller({
        scrollTop: 100,
        scrollHeight: 800,
        clientHeight: 200
      })

      expect(
        restoreChatScrollAnchor(scroller, {
          scrollTop: 100,
          scrollHeight: 800,
          clientHeight: 200,
          scrollRatio: 0.25,
          atBottom: false
        })
      ).toBe(false)
      expect(scroller.scrollTop).toBe(100)
    })
  })

  describe('restoreChatScrollState', () => {
    it('applies bottom restore across the double-rAF settle path', () => {
      const callbacks: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callbacks.push(callback)
        return callbacks.length
      })
      const scroller = fakeScroller({
        scrollTop: 0,
        scrollHeight: 900,
        clientHeight: 300
      })

      restoreChatScrollState(scroller, {
        scrollTop: 600,
        scrollHeight: 900,
        clientHeight: 300,
        scrollRatio: 1,
        atBottom: true
      })

      expect(scroller.scrollTop).toBe(0)
      callbacks.shift()?.(0)
      expect(scroller.scrollTop).toBe(900)
      callbacks.shift()?.(16)
      expect(scroller.scrollTop).toBe(900)
    })

    it('falls back to ratio restore when the anchor is missing', () => {
      const callbacks: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callbacks.push(callback)
        return callbacks.length
      })
      const scroller = fakeScroller({
        scrollTop: 0,
        scrollHeight: 900,
        clientHeight: 300
      })

      restoreChatScrollState(scroller, {
        scrollTop: 120,
        scrollHeight: 600,
        clientHeight: 200,
        scrollRatio: 0.5,
        atBottom: false,
        anchorMessageId: 'missing',
        anchorOffset: 12
      })

      callbacks.shift()?.(0)
      expect(scroller.scrollTop).toBe(300)
    })

    it('retries long enough for a virtualized anchor to mount after ratio positioning', () => {
      const callbacks: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callbacks.push(callback)
        return callbacks.length
      })
      let queryCount = 0
      const scroller = fakeScroller({
        scrollTop: 0,
        scrollHeight: 900,
        clientHeight: 300,
        top: 0,
        bottom: 300
      })
      scroller.querySelector = () => {
        queryCount += 1
        if (queryCount < 3) return null
        return {
          getBoundingClientRect: () =>
            fakeRect(500 - scroller.scrollTop, 540 - scroller.scrollTop)
        } as HTMLElement
      }
      const onSettled = vi.fn()

      restoreChatScrollState(
        scroller,
        {
          scrollTop: 120,
          scrollHeight: 600,
          clientHeight: 200,
          scrollRatio: 0.5,
          atBottom: false,
          anchorMessageId: 'virtualized-message',
          anchorOffset: 20
        },
        () => true,
        onSettled,
        4
      )

      for (let frame = 0; frame < 4; frame += 1) callbacks.shift()?.(frame * 16)
      expect(scroller.scrollTop).toBe(480)
      expect(onSettled).toHaveBeenCalledTimes(1)
    })

    it('cancels both delayed writes when a rapid chat switch invalidates the restore', () => {
      const callbacks = new Map<number, FrameRequestCallback>()
      let nextId = 1
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const id = nextId++
        callbacks.set(id, callback)
        return id
      })
      vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
      const scroller = fakeScroller({
        scrollTop: 40,
        scrollHeight: 900,
        clientHeight: 300
      })
      let activeChatId = 'chat-b'
      const cancel = restoreChatScrollState(
        scroller,
        {
          scrollTop: 120,
          scrollHeight: 600,
          clientHeight: 200,
          scrollRatio: 0.5,
          atBottom: false
        },
        () => activeChatId === 'chat-b'
      )

      const firstRafId = Math.min(...callbacks.keys())
      const firstCallback = callbacks.get(firstRafId)
      callbacks.delete(firstRafId)
      firstCallback?.(0)
      expect(scroller.scrollTop).toBe(300)

      // Chat C reuses the same DOM scroller after B acquired it but before
      // B's second settle pass. Cleanup must cancel that delayed write.
      activeChatId = 'chat-c'
      scroller.scrollTop = 77
      cancel()
      for (const callback of callbacks.values()) callback(0)

      expect(scroller.scrollTop).toBe(77)
      expect(callbacks.size).toBe(0)
    })
  })

  describe('isTranscriptUserScrollGestureLive', () => {
    // Cut 2a: short settle window for "gesture currently live" — NOT the
    // 400ms downward re-engage voucher, and not sticky scroll-away ownership.
    it('is live while the scrollbar pointer is held', () => {
      expect(
        isTranscriptUserScrollGestureLive({
          lastUserScrollAt: 0,
          scrollbarPointerActive: true,
          now: 10_000
        })
      ).toBe(true)
    })

    it('is live within the dedicated user-scroll gesture window', () => {
      const lastUserScrollAt = 10_000
      expect(
        isTranscriptUserScrollGestureLive({
          lastUserScrollAt,
          scrollbarPointerActive: false,
          now: lastUserScrollAt + USER_SCROLL_GESTURE_WINDOW_MS
        })
      ).toBe(true)
      expect(
        isTranscriptUserScrollGestureLive({
          lastUserScrollAt,
          scrollbarPointerActive: false,
          now: lastUserScrollAt + USER_SCROLL_GESTURE_WINDOW_MS + 1
        })
      ).toBe(false)
    })

    it('rejects zero / non-finite lastUserScrollAt when the pointer is idle', () => {
      expect(
        isTranscriptUserScrollGestureLive({
          lastUserScrollAt: 0,
          scrollbarPointerActive: false,
          now: 10_000
        })
      ).toBe(false)
      expect(
        isTranscriptUserScrollGestureLive({
          lastUserScrollAt: Number.NaN,
          scrollbarPointerActive: false,
          now: 10_000
        })
      ).toBe(false)
    })

    it('honours an explicit windowMs override', () => {
      expect(
        isTranscriptUserScrollGestureLive({
          lastUserScrollAt: 1000,
          scrollbarPointerActive: false,
          now: 1080,
          windowMs: 50
        })
      ).toBe(false)
      expect(
        isTranscriptUserScrollGestureLive({
          lastUserScrollAt: 1000,
          scrollbarPointerActive: false,
          now: 1040,
          windowMs: 50
        })
      ).toBe(true)
    })

    it('keeps the gesture window well below the downward-intent voucher', () => {
      expect(USER_SCROLL_GESTURE_WINDOW_MS).toBeGreaterThanOrEqual(100)
      expect(USER_SCROLL_GESTURE_WINDOW_MS).toBeLessThanOrEqual(150)
      expect(USER_SCROLL_GESTURE_WINDOW_MS).toBeLessThan(DOWNWARD_INTENT_WINDOW_MS)
    })
  })

  describe('decidePhase1AnchorCorrection', () => {
    // Cut 2a: Phase-1 absolute restore — skip hard gates, defer mid-gesture, else apply.
    const ready = {
      skipNext: false,
      measureConverged: true,
      atBottom: false,
      hasAnchor: true,
      absDeltaPx: 12,
      gestureLive: false
    }

    it('skips when skipNext / !converged / atBottom / !anchor / delta<=eps', () => {
      expect(decidePhase1AnchorCorrection({ ...ready, skipNext: true })).toBe('skip')
      expect(decidePhase1AnchorCorrection({ ...ready, measureConverged: false })).toBe('skip')
      expect(decidePhase1AnchorCorrection({ ...ready, atBottom: true })).toBe('skip')
      expect(decidePhase1AnchorCorrection({ ...ready, hasAnchor: false })).toBe('skip')
      expect(decidePhase1AnchorCorrection({ ...ready, absDeltaPx: 0.5 })).toBe('skip')
      expect(decidePhase1AnchorCorrection({ ...ready, absDeltaPx: 0 })).toBe('skip')
    })

    it('defers when hard gates pass but a user scroll gesture is live', () => {
      expect(decidePhase1AnchorCorrection({ ...ready, gestureLive: true })).toBe('defer')
    })

    it('applies when converged, anchored, away from bottom, and gesture settled', () => {
      expect(decidePhase1AnchorCorrection(ready)).toBe('apply')
    })

    it('prefers skip over defer when a hard gate fails during a live gesture', () => {
      expect(
        decidePhase1AnchorCorrection({ ...ready, atBottom: true, gestureLive: true })
      ).toBe('skip')
      expect(
        decidePhase1AnchorCorrection({ ...ready, absDeltaPx: 0.25, gestureLive: true })
      ).toBe('skip')
    })
  })

  describe('shouldRearmPhase1DeferOnSkip', () => {
    // Cut 2a P1: a deferred restore must survive soft layout skips (!converged).
    // Hard skips drop the pending defer so a settle timer cannot revive a
    // restore that is no longer valid (bottom / no anchor / skipNext).
    const pendingSoft = {
      deferredPending: true,
      skipNext: false,
      atBottom: false,
      hasAnchor: true,
      measureConverged: false
    }

    it('re-arms only for a pending defer skipped solely because measure has not converged', () => {
      expect(shouldRearmPhase1DeferOnSkip(pendingSoft)).toBe(true)
      expect(
        shouldRearmPhase1DeferOnSkip({ ...pendingSoft, measureConverged: true })
      ).toBe(false)
    })

    it('does not re-arm hard skips or when nothing was deferred', () => {
      expect(
        shouldRearmPhase1DeferOnSkip({ ...pendingSoft, deferredPending: false })
      ).toBe(false)
      expect(shouldRearmPhase1DeferOnSkip({ ...pendingSoft, skipNext: true })).toBe(false)
      expect(shouldRearmPhase1DeferOnSkip({ ...pendingSoft, atBottom: true })).toBe(false)
      expect(shouldRearmPhase1DeferOnSkip({ ...pendingSoft, hasAnchor: false })).toBe(false)
    })
  })

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

  describe('shouldReengageAutoFollowAfterScroll', () => {
    it('re-engages at the bottom when there was no active user scroll-away', () => {
      expect(
        shouldReengageAutoFollowAfterScroll({
          distanceFromBottom: 0,
          userScrolledAwayInThisFrame: false,
          previousScrollTop: 300,
          nextScrollTop: 300,
          isProgrammatic: false,
          recentDownwardIntent: false
        })
      ).toBe(true)
    })

    it('does not erase upward user intent just because streaming left the viewport near bottom', () => {
      expect(
        shouldReengageAutoFollowAfterScroll({
          distanceFromBottom: 0,
          userScrolledAwayInThisFrame: true,
          previousScrollTop: 300,
          nextScrollTop: 260,
          isProgrammatic: false,
          recentDownwardIntent: false
        })
      ).toBe(false)
    })

    it.each(['wheel', 'touch', 'keyboard', 'scrollbar pointer'])(
      're-engages on a verified downward %s return to the live edge',
      () => {
        expect(
          shouldReengageAutoFollowAfterScroll({
            distanceFromBottom: 1,
            userScrolledAwayInThisFrame: true,
            previousScrollTop: 260,
            nextScrollTop: 300,
            isProgrammatic: false,
            recentDownwardIntent: true
          })
        ).toBe(true)
      }
    )

    it('does not re-engage from app-owned scroll writes', () => {
      expect(
        shouldReengageAutoFollowAfterScroll({
          distanceFromBottom: 1,
          userScrolledAwayInThisFrame: true,
          previousScrollTop: 260,
          nextScrollTop: 300,
          isProgrammatic: true,
          recentDownwardIntent: true
        })
      ).toBe(false)
    })

    it.each([
      ['ordinary assistant delta reflow', 1600, 1998],
      ['Thinking/tool viewport layout', 2600, 3198],
      ['virtual-window anchor correction', 2600, 5198]
    ])('does not re-engage on an unguarded %s landing at the live edge', (_, previous, next) => {
      // Provider deltas and transcript layout can move scrollTop down while the
      // user reads history. Even if a write is not classified as programmatic,
      // direction + position are not user intent and must not trip the strict
      // 2px band.
      expect(
        shouldReengageAutoFollowAfterScroll({
          distanceFromBottom: STICK_ENGAGE_PX,
          userScrolledAwayInThisFrame: true,
          previousScrollTop: previous,
          nextScrollTop: next,
          isProgrammatic: false,
          recentDownwardIntent: false
        })
      ).toBe(false)
    })

    describe('scrollbar pointer hit testing', () => {
      const base = {
        rectLeft: 0,
        rectRight: 1000,
        offsetWidth: 1000,
        clientWidth: 1000,
        scrollHeight: 1600,
        clientHeight: 600
      }

      it('recognises the macOS overlay-scrollbar edge strip', () => {
        expect(isTranscriptScrollbarPointer({ ...base, clientX: 992 })).toBe(true)
        expect(isTranscriptScrollbarPointer({ ...base, clientX: 970 })).toBe(false)
      })

      it('recognises a layout-consuming native scrollbar gutter', () => {
        expect(
          isTranscriptScrollbarPointer({
            ...base,
            clientX: 988,
            clientWidth: 982
          })
        ).toBe(true)
      })

      it('supports an inline-start scrollbar in RTL', () => {
        expect(
          isTranscriptScrollbarPointer({
            ...base,
            clientX: 8,
            direction: 'rtl'
          })
        ).toBe(true)
      })

      it('does not arm pointer intent when the transcript does not overflow', () => {
        expect(
          isTranscriptScrollbarPointer({
            ...base,
            clientX: 992,
            scrollHeight: 600
          })
        ).toBe(false)
      })

      it('records only a real, user-owned downward scrollbar movement', () => {
        expect(
          shouldRecordScrollbarDownwardIntent({
            pointerActive: true,
            isProgrammatic: false,
            previousScrollTop: 260,
            nextScrollTop: 300
          })
        ).toBe(true)
        expect(
          shouldRecordScrollbarDownwardIntent({
            pointerActive: true,
            isProgrammatic: true,
            previousScrollTop: 260,
            nextScrollTop: 300
          })
        ).toBe(false)
        expect(
          shouldRecordScrollbarDownwardIntent({
            pointerActive: false,
            isProgrammatic: false,
            previousScrollTop: 260,
            nextScrollTop: 300
          })
        ).toBe(false)
        expect(
          shouldRecordScrollbarDownwardIntent({
            pointerActive: true,
            isProgrammatic: false,
            previousScrollTop: 300,
            nextScrollTop: 260
          })
        ).toBe(false)
      })

      it('clears a downward voucher when the scrollbar reverses in the same frame', () => {
        let previous = 260
        let hasDownwardVoucher = false
        for (const next of [320, 300]) {
          if (
            shouldRecordScrollbarDownwardIntent({
              pointerActive: true,
              isProgrammatic: false,
              previousScrollTop: previous,
              nextScrollTop: next
            })
          ) {
            hasDownwardVoucher = true
          } else if (
            shouldClearScrollbarDownwardIntent({
              pointerActive: true,
              isProgrammatic: false,
              previousScrollTop: previous,
              nextScrollTop: next
            })
          ) {
            hasDownwardVoucher = false
          }
          previous = next
        }

        expect(hasDownwardVoucher).toBe(false)
      })

      it('keeps the verified pointer movement alive for the short post-pointerup grace', () => {
        const intentAt = 10_000
        expect(
          hasRecentTranscriptDownwardIntent({
            intentAt,
            now: intentAt + DOWNWARD_INTENT_WINDOW_MS
          })
        ).toBe(true)
        expect(
          hasRecentTranscriptDownwardIntent({
            intentAt,
            now: intentAt + DOWNWARD_INTENT_WINDOW_MS + 1
          })
        ).toBe(false)
      })
    })

    it('does not re-engage anchor-correction writes when guard is pre-armed before scrollTop write', () => {
      expect(
        shouldReengageAutoFollowAfterScroll({
          distanceFromBottom: STICK_ENGAGE_PX,
          userScrolledAwayInThisFrame: true,
          previousScrollTop: 2600,
          nextScrollTop: 5198,
          isProgrammatic: true,
          recentDownwardIntent: false
        })
      ).toBe(false)
    })

    describe('downward re-engage band (STICK_REENGAGE_DOWNWARD_PX)', () => {
      it('re-engages a deliberate downward return that lands near the moving live edge', () => {
        // Streaming growth keeps the exact bottom out of reach of a drag —
        // landing a few px short after moving DOWN still means "take me to
        // the live edge" (Claude/Codex re-lock on this gesture).
        expect(
          shouldReengageAutoFollowAfterScroll({
            distanceFromBottom: STICK_ENGAGE_PX + 1,
            userScrolledAwayInThisFrame: true,
            previousScrollTop: 260,
            nextScrollTop: 300,
            isProgrammatic: false,
            recentDownwardIntent: true
          })
        ).toBe(true)
        expect(
          shouldReengageAutoFollowAfterScroll({
            distanceFromBottom: STICK_REENGAGE_DOWNWARD_PX,
            userScrolledAwayInThisFrame: true,
            previousScrollTop: 260,
            nextScrollTop: 300,
            isProgrammatic: false,
            recentDownwardIntent: true
          })
        ).toBe(true)
      })

      it('never captures a stop beyond the band', () => {
        expect(
          shouldReengageAutoFollowAfterScroll({
            distanceFromBottom: STICK_REENGAGE_DOWNWARD_PX + 1,
            userScrolledAwayInThisFrame: true,
            previousScrollTop: 260,
            nextScrollTop: 300,
            isProgrammatic: false,
            recentDownwardIntent: true
          })
        ).toBe(false)
      })

      it('requires a recent verified downward gesture — scroll events alone cannot arm the band', () => {
        // Unarmed restore writes and a coalesced frame whose last input was
        // upward both present as net-downward movement; only verified
        // wheel/touch/key or tracked-scrollbar gestures vouch for the band.
        expect(
          shouldReengageAutoFollowAfterScroll({
            distanceFromBottom: 30,
            userScrolledAwayInThisFrame: true,
            previousScrollTop: 260,
            nextScrollTop: 300,
            isProgrammatic: false,
            recentDownwardIntent: false
          })
        ).toBe(false)
      })

      it('requires a real downward user movement — positional landings stay strict', () => {
        // A shrink clamp or anchor write can land inside the band without
        // any gesture; those must keep the 2px path.
        expect(
          shouldReengageAutoFollowAfterScroll({
            distanceFromBottom: 30,
            userScrolledAwayInThisFrame: true,
            previousScrollTop: 300,
            nextScrollTop: 260,
            isProgrammatic: false,
            recentDownwardIntent: false
          })
        ).toBe(false)
        expect(
          shouldReengageAutoFollowAfterScroll({
            distanceFromBottom: 30,
            userScrolledAwayInThisFrame: false,
            previousScrollTop: 260,
            nextScrollTop: 300,
            isProgrammatic: false,
            recentDownwardIntent: false
          })
        ).toBe(false)
        expect(
          shouldReengageAutoFollowAfterScroll({
            distanceFromBottom: 30,
            userScrolledAwayInThisFrame: true,
            previousScrollTop: 260,
            nextScrollTop: 300,
            isProgrammatic: true,
            recentDownwardIntent: false
          })
        ).toBe(false)
      })
    })
  })

  describe('editable keyboard targets', () => {
    it('keeps transcript navigation keys inside text inputs and nested contenteditable nodes', () => {
      const textarea = {
        matches: (selector: string) => selector.includes('textarea'),
        closest: () => null
      } as unknown as EventTarget
      const nestedEditable = {
        matches: () => false,
        closest: (selector: string) =>
          selector.includes('[contenteditable="true"]') ? ({} as Element) : null
      } as unknown as EventTarget
      const button = {
        matches: () => false,
        closest: () => null
      } as unknown as EventTarget

      expect(isEditableTranscriptKeyTarget(textarea)).toBe(true)
      expect(isEditableTranscriptKeyTarget(nestedEditable)).toBe(true)
      expect(isEditableTranscriptKeyTarget(button)).toBe(false)
    })
  })

  describe('programmatic scroll target helpers', () => {
    it('computes the real bottom scrollTop target', () => {
      expect(expectedBottomScrollTop({ scrollHeight: 1200, clientHeight: 500 })).toBe(700)
      expect(expectedBottomScrollTop({ scrollHeight: 300, clientHeight: 500 })).toBe(0)
    })

    it('matches only the expected app-owned scroll target', () => {
      expect(
        isExpectedProgrammaticScroll({
          expectedScrollTop: 700,
          nextScrollTop: 700 + PROGRAMMATIC_SCROLL_EPSILON_PX
        })
      ).toBe(true)
      expect(
        isExpectedProgrammaticScroll({
          expectedScrollTop: 700,
          nextScrollTop: 650
        })
      ).toBe(false)
      expect(
        isExpectedProgrammaticScroll({
          expectedScrollTop: null,
          nextScrollTop: 700
        })
      ).toBe(false)
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

  describe('shouldTreatScrollAsUserScrollAway', () => {
    it('detects upward scrollTop movement as an immediate scroll-away signal', () => {
      expect(
        shouldTreatScrollAsUserScrollAway({
          previousScrollTop: 320,
          nextScrollTop: 260,
          distanceFromBottom: 60,
          isProgrammatic: false
        })
      ).toBe(true)
    })

    it('ignores downward movement and top-edge jitter', () => {
      expect(
        shouldTreatScrollAsUserScrollAway({
          previousScrollTop: 260,
          nextScrollTop: 320,
          distanceFromBottom: 0,
          isProgrammatic: false
        })
      ).toBe(false)
      expect(
        shouldTreatScrollAsUserScrollAway({
          previousScrollTop: 0,
          nextScrollTop: 0,
          distanceFromBottom: 120,
          isProgrammatic: false
        })
      ).toBe(false)
    })

    it('does not treat app-owned scroll writes as user intent', () => {
      expect(
        shouldTreatScrollAsUserScrollAway({
          previousScrollTop: 320,
          nextScrollTop: 260,
          distanceFromBottom: 60,
          isProgrammatic: true
        })
      ).toBe(false)
    })

    it('ignores the browser clamp after a content-height shrink at the live edge', () => {
      // Ensemble participant close-out: ActivityStack rows collapse, content
      // shrinks, the browser clamps scrollTop down to the NEW maximum and the
      // scroll event lands exactly at the bottom. scrollTop decreased without
      // any user gesture — auto-follow must survive so the next participant's
      // stream keeps following.
      expect(
        shouldTreatScrollAsUserScrollAway({
          previousScrollTop: 5000,
          nextScrollTop: 4700,
          distanceFromBottom: 0,
          isProgrammatic: false
        })
      ).toBe(false)
    })

    it('keeps scroll-away sticky to the disengage threshold', () => {
      // A decrease landing inside the hysteresis dead-band is not user intent
      // (a drag that shallow could not disengage by distance either)...
      expect(
        shouldTreatScrollAsUserScrollAway({
          previousScrollTop: 5000,
          nextScrollTop: 4996,
          distanceFromBottom: STICK_DISENGAGE_PX,
          isProgrammatic: false
        })
      ).toBe(false)
      // ...while a scrollbar drag landing beyond it still disengages
      // synchronously.
      expect(
        shouldTreatScrollAsUserScrollAway({
          previousScrollTop: 5000,
          nextScrollTop: 4990,
          distanceFromBottom: STICK_DISENGAGE_PX + 1,
          isProgrammatic: false
        })
      ).toBe(true)
    })

    it('treats non-finite landing metrics as not-user (intent listeners still own disengage)', () => {
      expect(
        shouldTreatScrollAsUserScrollAway({
          previousScrollTop: 5000,
          nextScrollTop: 4700,
          distanceFromBottom: Number.NaN,
          isProgrammatic: false
        })
      ).toBe(false)
    })
  })

  describe('shouldTreatUnclassifiedNativeScrollAsUserScrollAway', () => {
    const atLiveEdge = {
      previousScrollTop: 800,
      previousScrollHeight: 1_000,
      previousClientHeight: 200,
      isProgrammatic: false
    }

    it('releases follow for an unclassified native scrollbar drag', () => {
      expect(
        shouldTreatUnclassifiedNativeScrollAsUserScrollAway({
          ...atLiveEdge,
          nextScrollTop: 620,
          nextScrollHeight: 1_000,
          nextClientHeight: 200
        })
      ).toBe(true)
    })

    it('keeps app ownership when the sample pair straddles content growth', () => {
      // The ensemble participant-boundary composite: the settling stack
      // folds (shrink → browser clamps scrollTop down) and the next
      // participant's rows mount in an adjacent commit (growth) before this
      // pair is evaluated. Net signature — scrollTop dropped while content
      // grew — is identical to a phantom scrollbar drag during streaming,
      // but a drag cannot change content height, so an unstable pair is
      // unattributable and must not release follow (this exact input
      // previously returned true and lost the tail at every hand-off). A
      // real untracked drag re-qualifies on its next stable event pair.
      expect(
        shouldTreatUnclassifiedNativeScrollAsUserScrollAway({
          ...atLiveEdge,
          nextScrollTop: 620,
          nextScrollHeight: 1_240,
          nextClientHeight: 200
        })
      ).toBe(false)
    })

    it('does not mistake a shrink clamp or viewport growth for reader intent', () => {
      expect(
        shouldTreatUnclassifiedNativeScrollAsUserScrollAway({
          ...atLiveEdge,
          nextScrollTop: 700,
          nextScrollHeight: 950,
          nextClientHeight: 200
        })
      ).toBe(false)
      expect(
        shouldTreatUnclassifiedNativeScrollAsUserScrollAway({
          ...atLiveEdge,
          nextScrollTop: 700,
          nextScrollHeight: 1_000,
          nextClientHeight: 250
        })
      ).toBe(false)
    })
  })

  describe('hasExplicitTranscriptScrollAwayIntent', () => {
    it('accepts wheel, touch, or key ownership recorded before the scroll event', () => {
      expect(
        hasExplicitTranscriptScrollAwayIntent({
          userScrolledAwayInThisFrame: true,
          scrollbarPointerActive: false,
          previousScrollTop: 5000,
          nextScrollTop: 4700
        })
      ).toBe(true)
    })

    it('accepts an upward native scrollbar drag', () => {
      expect(
        hasExplicitTranscriptScrollAwayIntent({
          userScrolledAwayInThisFrame: false,
          scrollbarPointerActive: true,
          previousScrollTop: 5000,
          nextScrollTop: 4700
        })
      ).toBe(true)
    })

    it('does not assign layout geometry or downward scrollbar movement to the user', () => {
      expect(
        hasExplicitTranscriptScrollAwayIntent({
          userScrolledAwayInThisFrame: false,
          scrollbarPointerActive: false,
          previousScrollTop: 5000,
          nextScrollTop: 4700
        })
      ).toBe(false)
      expect(
        hasExplicitTranscriptScrollAwayIntent({
          userScrolledAwayInThisFrame: false,
          scrollbarPointerActive: true,
          previousScrollTop: 4700,
          nextScrollTop: 5000
        })
      ).toBe(false)
    })
  })

  describe('shouldAbortAutoFollowSnap', () => {
    it('uses the latest native sample when a bottom clamp outruns rAF evaluation', () => {
      // The ActivityStack collapses at the live edge and Chromium clamps the
      // viewport from 5000 to 4700. The native scroll listener records 4700,
      // but its rAF evaluator has not run before the next transcript row grows
      // the live edge to 4800. Comparing against the stale evaluated position
      // invents an upward gesture; the native sample proves the viewport did
      // not move after the clamp.
      expect(
        shouldAbortAutoFollowSnap({
          lastRecordedScrollTop: 5000,
          lastNativeScrollTop: 4700,
          currentScrollTop: 4700,
          scrollHeight: 5000,
          clientHeight: 200,
          expectedProgrammaticScrollTop: null,
          hasExplicitScrollAwayIntent: false
        })
      ).toBe(false)
    })

    it('does not invent scroll-away when a clamp event arrives after tail growth', () => {
      // Chromium may coalesce the clamp until after the next participant has
      // already grown the live edge. Both recorded samples are then stale,
      // so geometry alone looks like a 300px upward gesture landing 100px
      // from the bottom. With no input ownership, it is still a layout clamp.
      expect(
        shouldAbortAutoFollowSnap({
          lastRecordedScrollTop: 5000,
          lastNativeScrollTop: 5000,
          currentScrollTop: 4700,
          scrollHeight: 5000,
          clientHeight: 200,
          expectedProgrammaticScrollTop: null,
          hasExplicitScrollAwayIntent: false
        })
      ).toBe(false)
    })

    it('allows pinned streaming growth when scrollTop moves down at the live edge', () => {
      expect(
        shouldAbortAutoFollowSnap({
          lastRecordedScrollTop: 4800,
          lastNativeScrollTop: 4800,
          currentScrollTop: 5200,
          scrollHeight: 5400,
          clientHeight: 200,
          expectedProgrammaticScrollTop: null,
          hasExplicitScrollAwayIntent: false
        })
      ).toBe(false)
    })

    it('blocks a snap when live scrollTop moved upward before the layout effect', () => {
      expect(
        shouldAbortAutoFollowSnap({
          lastRecordedScrollTop: 5200,
          lastNativeScrollTop: 5200,
          currentScrollTop: 4700,
          scrollHeight: 5400,
          clientHeight: 200,
          expectedProgrammaticScrollTop: null,
          hasExplicitScrollAwayIntent: true
        })
      ).toBe(true)
    })

    it('does not treat a programmatic anchor write as user scroll-away', () => {
      expect(
        shouldAbortAutoFollowSnap({
          lastRecordedScrollTop: 5200,
          lastNativeScrollTop: 5200,
          currentScrollTop: 4700,
          scrollHeight: 5400,
          clientHeight: 200,
          expectedProgrammaticScrollTop: 4700,
          hasExplicitScrollAwayIntent: true
        })
      ).toBe(false)
    })

    it('does not block a deliberate downward return near the live edge', () => {
      expect(
        shouldAbortAutoFollowSnap({
          lastRecordedScrollTop: 4700,
          lastNativeScrollTop: 4700,
          currentScrollTop: 5180,
          scrollHeight: 5400,
          clientHeight: 200,
          expectedProgrammaticScrollTop: null,
          hasExplicitScrollAwayIntent: true
        })
      ).toBe(false)
    })
  })

  describe('shouldRepinAfterScrollEvaluation', () => {
    it('re-pins a followed viewport when a settled clamp is now behind the live edge', () => {
      expect(
        shouldRepinAfterScrollEvaluation({
          autoFollow: true,
          userScrolledAwayInThisFrame: false,
          jumpInFlight: false,
          distanceFromBottom: STICK_DISENGAGE_PX + 68
        })
      ).toBe(true)
    })

    it('does not fight explicit scroll-away or a jump-to-latest flight', () => {
      expect(
        shouldRepinAfterScrollEvaluation({
          autoFollow: false,
          userScrolledAwayInThisFrame: true,
          jumpInFlight: false,
          distanceFromBottom: 100
        })
      ).toBe(false)
      expect(
        shouldRepinAfterScrollEvaluation({
          autoFollow: true,
          userScrolledAwayInThisFrame: false,
          jumpInFlight: true,
          distanceFromBottom: 100
        })
      ).toBe(false)
    })

    it('leaves harmless near-edge jitter alone', () => {
      expect(
        shouldRepinAfterScrollEvaluation({
          autoFollow: true,
          userScrolledAwayInThisFrame: false,
          jumpInFlight: false,
          distanceFromBottom: STICK_DISENGAGE_PX
        })
      ).toBe(false)
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

  describe('shouldSnapAfterChatSwitch', () => {
    it('lands at the bottom for an ordinary chat switch', () => {
      expect(
        shouldSnapAfterChatSwitch({
          autoFollow: true,
          userScrolledAwayInThisFrame: false,
          hasPendingManualJump: false
        })
      ).toBe(true)
    })

    it('does not snap over a pending message jump', () => {
      expect(
        shouldSnapAfterChatSwitch({
          autoFollow: true,
          userScrolledAwayInThisFrame: false,
          hasPendingManualJump: true
        })
      ).toBe(false)
    })

    it('keeps the existing scroll-away guards for chat-switch landing', () => {
      expect(
        shouldSnapAfterChatSwitch({
          autoFollow: false,
          userScrolledAwayInThisFrame: false,
          hasPendingManualJump: false
        })
      ).toBe(false)
      expect(
        shouldSnapAfterChatSwitch({
          autoFollow: true,
          userScrolledAwayInThisFrame: true,
          hasPendingManualJump: false
        })
      ).toBe(false)
    })
  })

  describe('resolveTranscriptChatSwitchPlan', () => {
    const scrollState = {
      scrollTop: 320,
      scrollHeight: 1_000,
      clientHeight: 200,
      scrollRatio: 0.4,
      atBottom: false,
      anchorMessageId: 'message-4',
      anchorOffset: 12
    }

    it('keeps first visits and previously pinned chats at the current live edge', () => {
      expect(
        resolveTranscriptChatSwitchPlan({ hasPendingManualJump: false })
      ).toEqual({ kind: 'latest' })
      expect(
        resolveTranscriptChatSwitchPlan({
          cached: { scrollState, autoFollow: true },
          hasPendingManualJump: false
        })
      ).toEqual({ kind: 'latest' })
    })

    it('restores a revisited chat whose reader owned scroll', () => {
      expect(
        resolveTranscriptChatSwitchPlan({
          cached: { scrollState, autoFollow: false },
          hasPendingManualJump: false
        })
      ).toEqual({
        kind: 'restore',
        cached: { scrollState, autoFollow: false }
      })
    })

    it('lets an explicit message jump override cached reading position', () => {
      expect(
        resolveTranscriptChatSwitchPlan({
          cached: { scrollState, autoFollow: false },
          hasPendingManualJump: true
        })
      ).toEqual({ kind: 'manual-jump' })
    })

    it('lets a pending cross-surface restore suppress the ordinary latest snap', () => {
      const pendingExternalRestore = { scrollState, autoFollow: false }
      expect(
        resolveTranscriptChatSwitchPlan({
          cached: undefined,
          pendingExternalRestore,
          hasPendingManualJump: false
        })
      ).toEqual({ kind: 'external-restore', cached: pendingExternalRestore })
    })
  })

  describe('external restore lifecycle', () => {
    it('survives settling before the chat-switch effect observes ownership', () => {
      const settled = advanceExternalRestoreLifecycle(
        { settled: false, chatSwitchObserved: false },
        'settled'
      )
      expect(settled).toEqual({
        state: { settled: true, chatSwitchObserved: false },
        shouldClear: false
      })
      expect(
        advanceExternalRestoreLifecycle(settled.state, 'chat-switch-observed')
      ).toEqual({
        state: { settled: true, chatSwitchObserved: true },
        shouldClear: true
      })
    })

    it('survives the chat-switch effect observing ownership before settling', () => {
      const observed = advanceExternalRestoreLifecycle(
        { settled: false, chatSwitchObserved: false },
        'chat-switch-observed'
      )
      expect(observed).toEqual({
        state: { settled: false, chatSwitchObserved: true },
        shouldClear: false
      })
      expect(advanceExternalRestoreLifecycle(observed.state, 'settled')).toEqual({
        state: { settled: true, chatSwitchObserved: true },
        shouldClear: true
      })
    })

    it('clears a same-chat external restore as soon as it settles', () => {
      expect(
        advanceExternalRestoreLifecycle(
          { settled: false, chatSwitchObserved: true },
          'settled'
        )
      ).toEqual({
        state: { settled: true, chatSwitchObserved: true },
        shouldClear: true
      })
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
      expect(
        shouldShowJumpToLatestPill({ autoFollow: true, unreadCount: 0, awayFromLiveEdge: true })
      ).toBe(false)
      expect(
        shouldShowJumpToLatestPill({ autoFollow: true, unreadCount: 5, awayFromLiveEdge: true })
      ).toBe(false)
    })

    it('hides the pill when there are no unread messages', () => {
      // Even when the user has scrolled up, an empty counter means
      // nothing new arrived while they were reading — nothing to
      // advertise.
      expect(
        shouldShowJumpToLatestPill({ autoFollow: false, unreadCount: 0, awayFromLiveEdge: true })
      ).toBe(false)
    })

    it('shows the pill when scrolled away AND at least one new message arrived', () => {
      // The intended use case: user is reading older content while
      // messages stream in below. Pill surfaces "↓ N new messages".
      expect(
        shouldShowJumpToLatestPill({ autoFollow: false, unreadCount: 1, awayFromLiveEdge: true })
      ).toBe(true)
      expect(
        shouldShowJumpToLatestPill({ autoFollow: false, unreadCount: 47, awayFromLiveEdge: true })
      ).toBe(true)
    })

    it('hides the pill while the viewport still shows the live edge', () => {
      // Follow can be off with the reader parked at the tail: shrink clamps
      // land there without re-arming follow, and contained live-activity
      // viewports churn without growing the outer scroller. A pill there
      // would "jump" to where the user already is.
      expect(
        shouldShowJumpToLatestPill({ autoFollow: false, unreadCount: 5, awayFromLiveEdge: false })
      ).toBe(false)
      expect(
        shouldShowJumpToLatestPill({
          autoFollow: false,
          unreadCount: 0,
          streamingActive: true,
          awayFromLiveEdge: false
        })
      ).toBe(false)
    })

    it('treats non-finite unread counts as zero (no pill)', () => {
      // Defensive parity with shouldEngageAutoFollow's NaN guard: a
      // partially-initialised or corrupted counter must not bleed
      // through as a visible pill.
      expect(
        shouldShowJumpToLatestPill({
          autoFollow: false,
          unreadCount: Number.NaN,
          awayFromLiveEdge: true
        })
      ).toBe(false)
      expect(
        shouldShowJumpToLatestPill({
          autoFollow: false,
          unreadCount: Number.POSITIVE_INFINITY,
          awayFromLiveEdge: true
        })
      ).toBe(false)
    })

    it('treats negative counts as zero (no pill)', () => {
      // A negative delta should never reach this helper, but guard
      // against an off-by-one reset bug from the caller — show
      // nothing rather than a confusing "↓ -2 new messages".
      expect(
        shouldShowJumpToLatestPill({ autoFollow: false, unreadCount: -1, awayFromLiveEdge: true })
      ).toBe(false)
    })

    it('shows the pill during an active stream even with zero unread messages', () => {
      // Text growth inside ONE bubble never bumps the message-count-based
      // unread number, so a user who scrolled up mid-answer needs the
      // affordance from the streaming signal instead.
      expect(
        shouldShowJumpToLatestPill({
          autoFollow: false,
          unreadCount: 0,
          streamingActive: true,
          awayFromLiveEdge: true
        })
      ).toBe(true)
    })

    it('never shows the pill while auto-follow is engaged, streaming or not', () => {
      expect(
        shouldShowJumpToLatestPill({
          autoFollow: true,
          unreadCount: 0,
          streamingActive: true,
          awayFromLiveEdge: true
        })
      ).toBe(false)
    })

    it('hides the pill after the stream ends when nothing is unread', () => {
      expect(
        shouldShowJumpToLatestPill({
          autoFollow: false,
          unreadCount: 0,
          streamingActive: false,
          awayFromLiveEdge: true
        })
      ).toBe(false)
    })
  })

  describe('isJumpToLatestCountableMessage / countJumpToLatestCountableMessages', () => {
    it('counts conversational bubbles and skips run machinery', () => {
      // The pill promises "N new MESSAGES". Tool activity batches and
      // system lifecycle rows are run machinery — most of it renders inside
      // an existing stack row's contained viewport, so counting it both
      // inflates the number and advertises content that is not below the
      // reader at all.
      expect(isJumpToLatestCountableMessage({ role: 'user' })).toBe(true)
      expect(isJumpToLatestCountableMessage({ role: 'assistant' })).toBe(true)
      expect(isJumpToLatestCountableMessage({ role: 'error' })).toBe(true)
      expect(isJumpToLatestCountableMessage({ role: 'tool', toolActivities: [{}] })).toBe(false)
      expect(isJumpToLatestCountableMessage({ role: 'system' })).toBe(false)
    })

    it('counts assistant-style and attention cards stored under machinery roles', () => {
      // Guest replies persist as system/tool rows but render as assistant
      // bubbles; questions/plan choices/approvals demand user input. All of
      // them are exactly what a scrolled-up reader must not miss.
      expect(
        isJumpToLatestCountableMessage({
          role: 'system',
          metadata: { kind: 'guestParticipantReply' }
        })
      ).toBe(true)
      expect(
        isJumpToLatestCountableMessage({
          role: 'tool',
          metadata: { kind: 'guestParticipantReply' }
        })
      ).toBe(true)
      expect(
        isJumpToLatestCountableMessage({ role: 'system', metadata: { kind: 'agentQuestion' } })
      ).toBe(true)
      expect(
        isJumpToLatestCountableMessage({ role: 'system', metadata: { kind: 'planChoice' } })
      ).toBe(true)
      expect(
        isJumpToLatestCountableMessage({ role: 'system', metadata: { kind: 'pendingApproval' } })
      ).toBe(true)
    })

    it('treats sub-thread and closeout chrome as machinery', () => {
      expect(
        isJumpToLatestCountableMessage({ role: 'tool', metadata: { kind: 'subThreadReturn' } })
      ).toBe(false)
      expect(
        isJumpToLatestCountableMessage({ role: 'system', metadata: { kind: 'contextCompaction' } })
      ).toBe(false)
    })

    it('is defensive against malformed entries', () => {
      expect(isJumpToLatestCountableMessage(null)).toBe(false)
      expect(isJumpToLatestCountableMessage(undefined)).toBe(false)
      expect(isJumpToLatestCountableMessage('assistant')).toBe(false)
      expect(isJumpToLatestCountableMessage({})).toBe(false)
      expect(isJumpToLatestCountableMessage({ role: 42 })).toBe(false)
      expect(isJumpToLatestCountableMessage({ role: 'assistant', metadata: null })).toBe(true)
    })

    it('counts across an array the way a real streamed run interleaves kinds', () => {
      expect(countJumpToLatestCountableMessages(undefined)).toBe(0)
      expect(countJumpToLatestCountableMessages([])).toBe(0)
      expect(
        countJumpToLatestCountableMessages([
          { role: 'user' },
          { role: 'tool', toolActivities: [{}] },
          { role: 'tool', toolActivities: [{}] },
          { role: 'system' },
          { role: 'assistant' },
          { role: 'system', metadata: { kind: 'agentQuestion' } },
          null
        ])
      ).toBe(3)
    })
  })

  describe('createFollowPinScheduler', () => {
    it('coalesces multiple schedule() calls into one apply per frame', () => {
      const apply = vi.fn()
      const callbacks: FrameRequestCallback[] = []
      const scheduler = createFollowPinScheduler({
        apply,
        requestAnimationFrame: (cb) => {
          callbacks.push(cb)
          return callbacks.length
        },
        cancelAnimationFrame: vi.fn()
      })

      scheduler.schedule()
      scheduler.schedule()
      scheduler.schedule()
      expect(callbacks).toHaveLength(1)
      expect(apply).not.toHaveBeenCalled()

      callbacks[0]?.(16)
      expect(apply).toHaveBeenCalledTimes(1)
      expect(scheduler.isPending()).toBe(false)
    })

    it('pinNowAndScheduleTrailing applies sync then schedules one trailing frame', () => {
      const apply = vi.fn()
      const callbacks: FrameRequestCallback[] = []
      const scheduler = createFollowPinScheduler({
        apply,
        requestAnimationFrame: (cb) => {
          callbacks.push(cb)
          return callbacks.length
        },
        cancelAnimationFrame: vi.fn()
      })

      scheduler.pinNowAndScheduleTrailing()
      expect(apply).toHaveBeenCalledTimes(1)
      expect(callbacks).toHaveLength(1)

      // Further schedule requests share the trailing slot.
      scheduler.schedule()
      expect(callbacks).toHaveLength(1)

      callbacks[0]?.(32)
      expect(apply).toHaveBeenCalledTimes(2)
    })

    it('cancel drops a pending coalesced frame', () => {
      const apply = vi.fn()
      const cancelAnimationFrame = vi.fn()
      const scheduler = createFollowPinScheduler({
        apply,
        requestAnimationFrame: () => 99,
        cancelAnimationFrame
      })

      scheduler.schedule()
      expect(scheduler.isPending()).toBe(true)
      scheduler.cancel()
      expect(scheduler.isPending()).toBe(false)
      expect(cancelAnimationFrame).toHaveBeenCalledWith(99)
      expect(apply).not.toHaveBeenCalled()
    })
  })

  describe('buildCodeBlockResizeEventInit', () => {
    it('exposes a stable event name constant', () => {
      // Historical event name — Phase E retired the outer scroller listener,
      // but residual emitters / tests still lock the literal.
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
