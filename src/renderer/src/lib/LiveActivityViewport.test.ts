import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_REVEAL_EVENT,
  REVEAL_HEADER_ALLOWANCE_PX,
  VIEWPORT_STICK_PX,
  createViewportRevealLedger,
  distanceFromBottom,
  viewportRevealKey,
  edgeFadeState,
  isExpandRevealTransition,
  nextAutoFollow,
  REVEAL_GROWTH_CEILING_PX,
  revealGrownMaxHeight,
  revealScrollAdjustment,
  shouldRepinOnContentGrowth,
  shouldResetRevealGrowth,
  shouldShowViewportJump
} from './LiveActivityViewport'

describe('distanceFromBottom', () => {
  it('computes remaining scroll distance to the bottom edge', () => {
    expect(distanceFromBottom({ scrollHeight: 500, scrollTop: 300, clientHeight: 200 })).toBe(0)
    expect(distanceFromBottom({ scrollHeight: 500, scrollTop: 250, clientHeight: 200 })).toBe(50)
  })
})

describe('nextAutoFollow', () => {
  it('follows when within the stick threshold and releases past it', () => {
    expect(nextAutoFollow(0, true)).toBe(true)
    expect(nextAutoFollow(VIEWPORT_STICK_PX, false)).toBe(true)
    expect(nextAutoFollow(VIEWPORT_STICK_PX + 1, true)).toBe(false)
  })

  it('re-engages when the user scrolls back near the bottom', () => {
    expect(nextAutoFollow(10, false)).toBe(true)
  })

  it('preserves current state for non-finite metrics', () => {
    expect(nextAutoFollow(Number.NaN, true)).toBe(true)
    expect(nextAutoFollow(Number.POSITIVE_INFINITY, false)).toBe(false)
  })
})

describe('shouldShowViewportJump', () => {
  it('only shows when collapsed and not following', () => {
    expect(shouldShowViewportJump({ expanded: false, following: false })).toBe(true)
    expect(shouldShowViewportJump({ expanded: false, following: true })).toBe(false)
    expect(shouldShowViewportJump({ expanded: true, following: false })).toBe(false)
  })
})

describe('edgeFadeState', () => {
  it('hides both fades when content fits without overflow', () => {
    expect(edgeFadeState({ scrollHeight: 120, clientHeight: 120, scrollTop: 0 })).toEqual({
      top: false,
      bottom: false
    })
  })

  it('shows bottom fade when scrolled away from the live edge', () => {
    expect(edgeFadeState({ scrollHeight: 300, clientHeight: 120, scrollTop: 0 })).toEqual({
      top: false,
      bottom: true
    })
  })

  it('shows top fade when scrolled up through overflow', () => {
    expect(edgeFadeState({ scrollHeight: 300, clientHeight: 120, scrollTop: 80 })).toEqual({
      top: true,
      bottom: true
    })
  })

  it('hides bottom fade when pinned to the live edge', () => {
    expect(edgeFadeState({ scrollHeight: 300, clientHeight: 120, scrollTop: 180 })).toEqual({
      top: true,
      bottom: false
    })
  })

  it('returns no fades for non-finite metrics', () => {
    expect(edgeFadeState({ scrollHeight: Number.NaN, clientHeight: 120, scrollTop: 0 })).toEqual({
      top: false,
      bottom: false
    })
  })
})

describe('isExpandRevealTransition', () => {
  it('fires only on a collapsed→expanded transition', () => {
    expect(isExpandRevealTransition(false, true)).toBe(true)
    expect(isExpandRevealTransition(true, true)).toBe(false)
    expect(isExpandRevealTransition(true, false)).toBe(false)
    expect(isExpandRevealTransition(false, false)).toBe(false)
  })
})

describe('ACTIVITY_REVEAL_EVENT', () => {
  it('pins the DOM event name cards dispatch and viewports listen for', () => {
    expect(ACTIVITY_REVEAL_EVENT).toBe('live-activity-reveal')
  })
})

describe('revealGrownMaxHeight', () => {
  it('keeps the base clamp when the detail already fits', () => {
    expect(
      revealGrownMaxHeight({ baseMaxHeight: 168, detailHeight: 100, headerAllowance: 28 })
    ).toBe(168)
  })

  it('grows to fit detail plus the header allowance', () => {
    expect(
      revealGrownMaxHeight({ baseMaxHeight: 168, detailHeight: 300, headerAllowance: 28 })
    ).toBe(328)
  })

  it('never exceeds the growth ceiling', () => {
    expect(
      revealGrownMaxHeight({ baseMaxHeight: 168, detailHeight: 900, headerAllowance: 28 })
    ).toBe(REVEAL_GROWTH_CEILING_PX)
  })

  it('returns the base clamp for non-finite detail heights', () => {
    expect(
      revealGrownMaxHeight({ baseMaxHeight: 168, detailHeight: Number.NaN, headerAllowance: 28 })
    ).toBe(168)
  })
})

describe('shouldResetRevealGrowth', () => {
  it('resets once content fits back inside the base clamp', () => {
    expect(shouldResetRevealGrowth({ contentHeight: 150, baseMaxHeight: 168 })).toBe(true)
    expect(shouldResetRevealGrowth({ contentHeight: 400, baseMaxHeight: 168 })).toBe(false)
  })
})

describe('shouldRepinOnContentGrowth', () => {
  it('re-pins only while collapsed and following', () => {
    expect(shouldRepinOnContentGrowth({ expanded: false, following: true })).toBe(true)
  })

  it('never moves a paused (inspecting) viewport', () => {
    expect(shouldRepinOnContentGrowth({ expanded: false, following: false })).toBe(false)
  })

  it('never scrolls the expanded free-flow view', () => {
    expect(shouldRepinOnContentGrowth({ expanded: true, following: true })).toBe(false)
    expect(shouldRepinOnContentGrowth({ expanded: true, following: false })).toBe(false)
  })
})

describe('revealScrollAdjustment', () => {
  it('returns null when the target is already fully visible', () => {
    expect(
      revealScrollAdjustment({
        scrollTop: 100,
        clientHeight: 168,
        targetTop: 120,
        targetBottom: 200
      })
    ).toBeNull()
  })

  it('bottom-aligns a target that extends below the fold', () => {
    expect(
      revealScrollAdjustment({
        scrollTop: 0,
        clientHeight: 168,
        targetTop: 150,
        targetBottom: 300
      })
    ).toBe(132)
  })

  it('top-aligns a target above the window, keeping the header allowance visible', () => {
    expect(
      revealScrollAdjustment({
        scrollTop: 400,
        clientHeight: 168,
        targetTop: 200,
        targetBottom: 260,
        headerAllowance: REVEAL_HEADER_ALLOWANCE_PX
      })
    ).toBe(200 - REVEAL_HEADER_ALLOWANCE_PX)
  })

  it('shows the head of a target taller than the window', () => {
    expect(
      revealScrollAdjustment({
        scrollTop: 0,
        clientHeight: 168,
        targetTop: 200,
        targetBottom: 600,
        headerAllowance: REVEAL_HEADER_ALLOWANCE_PX
      })
    ).toBe(200 - REVEAL_HEADER_ALLOWANCE_PX)
  })

  it('keeps the bottom-aligned header allowance visible for a target that just fits', () => {
    // span (targetBottom - (targetTop - allowance)) === clientHeight exactly:
    // bottom-aligning also top-aligns the allowance edge.
    expect(
      revealScrollAdjustment({
        scrollTop: 0,
        clientHeight: 168,
        targetTop: 200,
        targetBottom: 340,
        headerAllowance: 28
      })
    ).toBe(172)
  })

  it('never scrolls to a negative offset', () => {
    expect(
      revealScrollAdjustment({
        scrollTop: 50,
        clientHeight: 168,
        targetTop: 10,
        targetBottom: 60,
        headerAllowance: 28
      })
    ).toBe(0)
  })

  it('returns null for non-finite metrics', () => {
    expect(
      revealScrollAdjustment({
        scrollTop: Number.NaN,
        clientHeight: 168,
        targetTop: 0,
        targetBottom: 100
      })
    ).toBeNull()
  })
})

describe('viewportRevealKey', () => {
  it('scopes a lane id by surface so nested viewports never share a claim', () => {
    expect(viewportRevealKey('msg-1', 'ensemble-fanout-result-viewport')).not.toBe(
      viewportRevealKey('msg-1', 'ensemble-fanout-tools-viewport')
    )
  })

  it('is stable for the same lane and surface across remounts', () => {
    expect(viewportRevealKey('msg-1', 'ensemble-fanout-result-viewport')).toBe(
      viewportRevealKey('msg-1', 'ensemble-fanout-result-viewport')
    )
  })

  it('refuses to key an unidentifiable viewport', () => {
    // No owning message means no way to tell a re-appearance from a first
    // appearance. Withholding the reveal is the safe half of that trade: the
    // band is reserved by CSS either way, so nothing can be stranded.
    expect(viewportRevealKey(null, 'ensemble-fanout-result-viewport')).toBeNull()
    expect(viewportRevealKey('', 'ensemble-fanout-result-viewport')).toBeNull()
    expect(viewportRevealKey(undefined, undefined)).toBeNull()
  })
})

describe('createViewportRevealLedger', () => {
  it('grants the reveal once and refuses it after the animation starts', () => {
    const ledger = createViewportRevealLedger()
    expect(ledger.claim('lane-a')).toBe(true)
    ledger.seal('lane-a')
    // The row remounts constantly: its rowKey embeds the list index, so a
    // fan-out wave relocating on its second lane, a virtualisation eviction, or
    // a history page prepend all rebuild the node. None may replay the reveal.
    expect(ledger.claim('lane-a')).toBe(false)
    expect(ledger.claim('lane-a')).toBe(false)
  })

  it('re-arms when a claim is released before the animation ever started', () => {
    // StrictMode mounts, unmounts and remounts every component once. That
    // teardown happens before the browser dispatches animationstart, so the
    // claim is still unsealed and must be handed back — otherwise the reveal is
    // spent on a mount the user never saw, and dev never shows it at all.
    const ledger = createViewportRevealLedger()
    expect(ledger.claim('lane-a')).toBe(true)
    ledger.release('lane-a')
    expect(ledger.claim('lane-a')).toBe(true)
  })

  it('ignores a release once the reveal has been sealed', () => {
    const ledger = createViewportRevealLedger()
    ledger.claim('lane-a')
    ledger.seal('lane-a')
    ledger.release('lane-a')
    expect(ledger.claim('lane-a')).toBe(false)
  })

  it('tracks lanes independently', () => {
    const ledger = createViewportRevealLedger()
    expect(ledger.claim('lane-a')).toBe(true)
    ledger.seal('lane-a')
    expect(ledger.claim('lane-b')).toBe(true)
  })

  it('seals and releases unknown keys without inventing a claim', () => {
    const ledger = createViewportRevealLedger()
    ledger.release('never-claimed')
    expect(ledger.claim('never-claimed')).toBe(true)

    const other = createViewportRevealLedger()
    other.seal('never-claimed')
    expect(other.claim('never-claimed')).toBe(false)
  })
})
