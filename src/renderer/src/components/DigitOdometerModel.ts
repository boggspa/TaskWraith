export const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const

export type DigitRollDirection = 'up' | 'down' | 'steady'

export interface DigitRollFrame {
  cells: number[]
  startIndex: number
  targetIndex: number
}

export interface DigitSlotTransition {
  place: number
  digit: number
  previousDigit: number
}

/** Pure helper: turn a value into the digit list rendered in slots.
 * Negative values are flipped to positive; the caller controls sign
 * via the `sign` prop. Extracted so the model is unit-testable
 * without a DOM. */
export function digitSlotsForValue(value: number, minimumDigits = 1): number[] {
  const abs = Math.abs(Math.trunc(Number.isFinite(value) ? value : 0))
  const digits = String(abs)
    .split('')
    .map((c) => Number.parseInt(c, 10))
  const safeMinimum = Math.max(1, Math.trunc(Number.isFinite(minimumDigits) ? minimumDigits : 1))
  return digits.length >= safeMinimum ? digits : [...Array(safeMinimum - digits.length).fill(0), ...digits]
}

export function digitRollDirection(previous: number, next: number): DigitRollDirection {
  if (!Number.isFinite(previous) || !Number.isFinite(next) || previous === next) return 'steady'
  return next > previous ? 'up' : 'down'
}

export function digitFromRight(digits: number[], place: number): number | undefined {
  const index = digits.length - 1 - place
  return index >= 0 ? digits[index] : undefined
}

export function digitSlotTransitions(
  previousValue: number,
  nextValue: number,
  minimumDigits = 1
): DigitSlotTransition[] {
  const digits = digitSlotsForValue(nextValue, minimumDigits)
  const previousDigits = digitSlotsForValue(previousValue, minimumDigits)
  return digits.map((digit, index) => {
    const place = digits.length - 1 - index
    return {
      place,
      digit,
      previousDigit: digitFromRight(previousDigits, place) ?? digit
    }
  })
}

export function digitRollFrame(
  previousDigit: number,
  nextDigit: number,
  direction: DigitRollDirection
): DigitRollFrame {
  if (direction === 'steady' || previousDigit === nextDigit) {
    return { cells: [nextDigit], startIndex: 0, targetIndex: 0 }
  }

  const step = direction === 'up' ? 1 : -1
  const cells = [previousDigit]
  let cursor = previousDigit
  for (let guard = 0; guard < 10 && cursor !== nextDigit; guard += 1) {
    cursor = (cursor + step + 10) % 10
    cells.push(cursor)
  }

  if (direction === 'up') {
    return { cells, startIndex: 0, targetIndex: cells.length - 1 }
  }

  return {
    cells: [...cells].reverse(),
    startIndex: cells.length - 1,
    targetIndex: 0
  }
}
