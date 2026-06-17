import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  computeContinuousHopsPopoverPosition,
  CONTINUOUS_HOPS_RANGE,
  ContinuousHopsLimitChip
} from './ContinuousHopsLimitChip'

/**
 * SSR tests — the project's testing convention is renderToStaticMarkup. We
 * cover the structural guarantees: the chip is a focusable <button>, the
 * fraction text matches the props, a11y attrs are set, and the popover stays
 * unmounted in the default closed state. Interactive flows (open / type /
 * Set) need a runtime DOM and are best covered by a manual eyeball in the
 * running app before ship.
 */

function render(props: { hops: number; maxHops: number; disabled?: boolean }): string {
  return renderToStaticMarkup(
    <ContinuousHopsLimitChip
      hops={props.hops}
      maxHops={props.maxHops}
      onSave={() => {
        /* noop */
      }}
      disabled={props.disabled}
    />
  )
}

describe('ContinuousHopsLimitChip', () => {
  it('renders the hops/maxHops fraction in the chip text', () => {
    const html = render({ hops: 3, maxHops: 8 })
    expect(html).toContain('3/8')
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
