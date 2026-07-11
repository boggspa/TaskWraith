import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DigitOdometer } from './DigitOdometer'
import {
  digitFromRight,
  digitRollDirection,
  digitRollFrame,
  digitSlotTransitions,
  digitSlotsForValue
} from './DigitOdometerModel'

describe('digitSlotsForValue', () => {
  it('returns a single zero slot for value 0', () => {
    expect(digitSlotsForValue(0)).toEqual([0])
  })

  it('splits multi-digit positive values into digit slots', () => {
    expect(digitSlotsForValue(7)).toEqual([7])
    expect(digitSlotsForValue(46)).toEqual([4, 6])
    expect(digitSlotsForValue(100)).toEqual([1, 0, 0])
    expect(digitSlotsForValue(2025)).toEqual([2, 0, 2, 5])
  })

  it('treats negative values by absolute magnitude (sign handled separately)', () => {
    expect(digitSlotsForValue(-23)).toEqual([2, 3])
    expect(digitSlotsForValue(-1)).toEqual([1])
  })

  it('truncates fractional values to their integer part', () => {
    expect(digitSlotsForValue(3.7)).toEqual([3])
    expect(digitSlotsForValue(12.49)).toEqual([1, 2])
  })

  it('treats non-finite values as 0', () => {
    expect(digitSlotsForValue(Number.POSITIVE_INFINITY)).toEqual([0])
    expect(digitSlotsForValue(Number.NEGATIVE_INFINITY)).toEqual([0])
    expect(digitSlotsForValue(Number.NaN)).toEqual([0])
  })

  it('preserves leading zeros only in the absolute form (no leading zeros)', () => {
    // String(46) === '46', not '046' — pin we don't accidentally pad.
    expect(digitSlotsForValue(46)).toHaveLength(2)
    expect(digitSlotsForValue(5)).toHaveLength(1)
  })

  it('handles large numbers without overflow surprises', () => {
    expect(digitSlotsForValue(123456789)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('digitRollFrame', () => {
  it('moves one frame through carry and borrow boundaries', () => {
    expect(digitRollFrame(9, 0, 'up')).toEqual({
      cells: [9, 0],
      startIndex: 0,
      targetIndex: 1
    })
    expect(digitRollFrame(0, 9, 'down')).toEqual({
      cells: [9, 0],
      startIndex: 1,
      targetIndex: 0
    })
  })

  it('can render skipped updates without taking the opposite direction', () => {
    expect(digitRollFrame(5, 8, 'up').cells).toEqual([5, 6, 7, 8])
    expect(digitRollFrame(8, 5, 'down').cells).toEqual([5, 6, 7, 8])
  })

  it('reads previous digits by right-side place value', () => {
    expect(digitFromRight([9], 0)).toBe(9)
    expect(digitFromRight([9], 1)).toBeUndefined()
    expect(digitFromRight([1, 0, 0], 0)).toBe(0)
    expect(digitFromRight([1, 0, 0], 2)).toBe(1)
  })

  it('derives whole-value roll direction deterministically', () => {
    expect(digitRollDirection(46, 47)).toBe('up')
    expect(digitRollDirection(20, 19)).toBe('down')
    expect(digitRollDirection(7, 7)).toBe('steady')
  })
})

describe('digitSlotTransitions', () => {
  it('keeps place-value slots stable when a new leading digit appears', () => {
    expect(digitSlotTransitions(9, 10)).toEqual([
      { place: 1, digit: 1, previousDigit: 1 },
      { place: 0, digit: 0, previousDigit: 9 }
    ])
    expect(digitSlotTransitions(99, 100)).toEqual([
      { place: 2, digit: 1, previousDigit: 1 },
      { place: 1, digit: 0, previousDigit: 9 },
      { place: 0, digit: 0, previousDigit: 9 }
    ])
  })

  it('uses the rightmost live place when a leading digit disappears', () => {
    expect(digitSlotTransitions(10, 9)).toEqual([
      { place: 0, digit: 9, previousDigit: 0 }
    ])
  })

  it('maps carry updates to each digit place independently', () => {
    expect(digitSlotTransitions(19, 20)).toEqual([
      { place: 1, digit: 2, previousDigit: 1 },
      { place: 0, digit: 0, previousDigit: 9 }
    ])
  })

  it('uses absolute magnitude for negative values', () => {
    expect(digitSlotTransitions(-9, -10)).toEqual([
      { place: 1, digit: 1, previousDigit: 1 },
      { place: 0, digit: 0, previousDigit: 9 }
    ])
  })
})

describe('DigitOdometer markup', () => {
  it('renders a hidden semantic value separate from the decorative wheels', () => {
    const html = renderToStaticMarkup(createElement(DigitOdometer, { value: 47, sign: '+' }))

    expect(html).toContain('<span class="sr-only">+47</span>')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('digit-odometer__slot')
  })

  it('adds a minus sign automatically for negative values', () => {
    const html = renderToStaticMarkup(createElement(DigitOdometer, { value: -23 }))

    expect(html).toContain('<span class="sr-only">-23</span>')
  })

  it('supports a fixed decimal separator without giving up rolling digit slots', () => {
    const html = renderToStaticMarkup(
      createElement(DigitOdometer, { value: 2851, decimalPlaces: 1, ariaLabel: '285.1k tokens' })
    )

    expect(html).toContain('<span class="sr-only">285.1k tokens</span>')
    expect(html).toContain('digit-odometer__decimal')
    expect(html).toContain('digit-odometer__slot')
  })
})
