import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  computeContinuousHopsPopoverPosition,
  CONTINUOUS_HOPS_RANGE,
  ContinuousHopsLimitChip,
  resolveContinuousHopsTone
} from './ContinuousHopsLimitChip'

/**
 * SSR tests — the project's testing convention is renderToStaticMarkup. We
 * cover the structural guarantees: the chip is a focusable <button>, the
 * fraction text matches the props, a11y attrs are set, and the popover stays
 * unmounted in the default closed state. Interactive flows (open / type /
 * Set) need a runtime DOM and are best covered by a manual eyeball in the
 * running app before ship.
 */

function render(props: {
  hops: number
  maxHops: number
  disabled?: boolean
  roundStatus?: 'running' | 'completed' | 'cancelled' | 'failed'
  activeGoalStatus?: 'active' | 'paused' | 'blocked' | 'completed' | null
}): string {
  return renderToStaticMarkup(
    <ContinuousHopsLimitChip
      hops={props.hops}
      maxHops={props.maxHops}
      roundStatus={props.roundStatus}
      activeGoalStatus={props.activeGoalStatus}
      onSave={() => {
        /* noop */
      }}
      disabled={props.disabled}
    />
  )
}

describe('ContinuousHopsLimitChip', () => {
  it('renders the hops/maxHops fraction as animated digits with an accessible label', () => {
    const html = render({ hops: 3, maxHops: 8 })
    expect(html).toContain('composer-ensemble-hop-meter-count')
    expect(html).toContain('digit-odometer')
    expect(html).toContain('aria-label="Continuous round max handoff turns: 3 of 8"')
  })

  it('uses the neutral tone below the final 30% of turns', () => {
    const html = render({ hops: 15, maxHops: 64, roundStatus: 'running' })
    expect(html).toContain('is-neutral')
  })

  it('turns warning in the final 30% and danger in the final 10%', () => {
    expect(resolveContinuousHopsTone({ hops: 45, maxHops: 64, roundStatus: 'running' })).toBe(
      'warning'
    )
    expect(resolveContinuousHopsTone({ hops: 58, maxHops: 64, roundStatus: 'running' })).toBe(
      'danger'
    )
  })

  it('shows success when a terminal round ended by completing or blocking the active goal', () => {
    expect(
      resolveContinuousHopsTone({
        hops: 64,
        maxHops: 64,
        roundStatus: 'completed',
        activeGoalStatus: 'completed'
      })
    ).toBe('success')
    expect(
      resolveContinuousHopsTone({
        hops: 64,
        maxHops: 64,
        roundStatus: 'completed',
        activeGoalStatus: 'blocked'
      })
    ).toBe('success')
  })

  it('leaves a terminal completed round at the cap in the danger tone without a goal stop', () => {
    expect(resolveContinuousHopsTone({ hops: 64, maxHops: 64, roundStatus: 'completed' })).toBe(
      'danger'
    )
  })

  it('renders a <button> (so it is keyboard focusable + click-activatable)', () => {
    const html = render({ hops: 0, maxHops: 6 })
    expect(html).toMatch(/<button[^>]*>/)
    expect(html).toContain('composer-ensemble-hop-meter')
    expect(html).toContain('is-clickable')
  })

  it('sets aria-haspopup + aria-expanded for screen-reader users', () => {
    const html = render({ hops: 0, maxHops: 6 })
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
  })

  it('disables the button when `disabled` is true', () => {
    const html = render({ hops: 0, maxHops: 6, disabled: true })
    expect(html).toContain('disabled')
  })

  it('does NOT render the popover in the default (closed) SSR state', () => {
    const html = render({ hops: 0, maxHops: 6 })
    expect(html).not.toContain('continuous-hops-popover')
    expect(html).not.toContain('Max handoff turns')
  })

  it('exposes a sensible MIN..MAX range constant', () => {
    expect(CONTINUOUS_HOPS_RANGE.min).toBeGreaterThanOrEqual(1)
    expect(CONTINUOUS_HOPS_RANGE.max).toBeGreaterThan(CONTINUOUS_HOPS_RANGE.min)
    // Existing default is 6; the range must comfortably contain it so a saved
    // value never under/over-flows the editor.
    expect(CONTINUOUS_HOPS_RANGE.min).toBeLessThanOrEqual(6)
    expect(CONTINUOUS_HOPS_RANGE.max).toBeGreaterThanOrEqual(6)
    expect(CONTINUOUS_HOPS_RANGE.max).toBe(500)
  })

  it('positions the edit popover above the trigger', () => {
    const position = computeContinuousHopsPopoverPosition({
      triggerRect: { left: 760, top: 920, width: 34 },
      popoverHeight: 154,
      viewportWidth: 1280
    })

    expect(position.top).toBeLessThan(920)
    expect(position.top).toBe(760)
  })

  it('keeps the edit popover horizontally inside the viewport', () => {
    const leftEdge = computeContinuousHopsPopoverPosition({
      triggerRect: { left: 2, top: 920, width: 34 },
      popoverHeight: 154,
      viewportWidth: 1280
    })
    const rightEdge = computeContinuousHopsPopoverPosition({
      triggerRect: { left: 1264, top: 920, width: 34 },
      popoverHeight: 154,
      viewportWidth: 1280
    })

    expect(leftEdge.left).toBe(8)
    expect(rightEdge.left).toBe(1012)
  })
})
