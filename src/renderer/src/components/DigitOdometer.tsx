import { Fragment, useEffect, useMemo, useRef, type CSSProperties, type JSX } from 'react'
import {
  digitRollDirection,
  digitRollFrame,
  digitSlotTransitions,
  digitSlotsForValue,
  type DigitRollDirection
} from './DigitOdometerModel'

/**
 * DigitOdometer — skeuomorphic per-digit rolling counter, matching the
 * "secret-sauce" approach used by OpenAI's Codex client.
 *
 * Trick: each digit position renders a CSS-clipped window (height: 1em,
 * overflow: hidden) containing only the short roll frame needed for the current
 * transition. Stable digits render one cell. Changed digits render the previous
 * digit through the next digit in the direction the whole number moved, so carry
 * cases like 29 → 30 roll the ones slot 9 → 0 instead of rewinding through the
 * full 0-9 strip. Slots are keyed by right-side place value, so the ones/tens
 * wheels survive length changes such as 9 → 10 and 99 → 100.
 *
 * Accessibility: the visual wheels are aria-hidden. A real sr-only text node
 * carries the spoken value (e.g. "+47") so assistive tech and copy/selection do
 * not read the decorative roll-frame cells.
 *
 * Reduce-motion: respects `:root[data-reduce-motion="true"]` via CSS
 * and `prefers-reduced-motion` via CSS (animations are nulled out).
 */

export interface DigitOdometerProps {
  /** Number to display. Negative values get the `-` sign automatically unless
   * `sign` is supplied; for "+N" prepend with `sign="+"`. */
  value: number
  /** Optional leading sign ('+' or '-'). When omitted, no sign is
   * rendered. When `sign="+"` and value is 0, renders "+0". */
  sign?: '+' | '-'
  /** Optional ARIA label override; falls back to `${sign ?? ''}${value}`. */
  ariaLabel?: string
  /** Forward an extra class for layout / colour treatments. */
  className?: string
  /** Render a fixed decimal separator before the final N digits. `value`
   * remains an integer, so `value={2851} decimalPlaces={1}` displays 285.1. */
  decimalPlaces?: number
}

export function DigitOdometer({
  value,
  sign,
  ariaLabel,
  className,
  decimalPlaces = 0
}: DigitOdometerProps): JSX.Element {
  const numericValue = Number.isFinite(value) ? Math.trunc(value) : 0
  const displayValue = Math.abs(numericValue)
  const safeDecimalPlaces = Math.max(
    0,
    Math.min(6, Math.trunc(Number.isFinite(decimalPlaces) ? decimalPlaces : 0))
  )
  const minimumDigits = safeDecimalPlaces > 0 ? safeDecimalPlaces + 1 : 1
  const digits = useMemo(
    () => digitSlotsForValue(displayValue, minimumDigits),
    [displayValue, minimumDigits]
  )
  const previousDisplayValueRef = useRef(displayValue)
  const transitions = useMemo(
    () => digitSlotTransitions(previousDisplayValueRef.current, displayValue, minimumDigits),
    [displayValue, minimumDigits]
  )
  const direction = digitRollDirection(previousDisplayValueRef.current, displayValue)
  const effectiveSign = sign ?? (numericValue < 0 ? '-' : undefined)
  const digitLabel =
    safeDecimalPlaces > 0
      ? `${digits.slice(0, -safeDecimalPlaces).join('')}.${digits.slice(-safeDecimalPlaces).join('')}`
      : digits.join('')
  const label = ariaLabel ?? `${effectiveSign ?? ''}${digitLabel}`

  useEffect(() => {
    previousDisplayValueRef.current = displayValue
  }, [displayValue])

  return (
    <span className={`digit-odometer${className ? ' ' + className : ''}`}>
      <span className="sr-only">{label}</span>
      <span className="digit-odometer__visual" aria-hidden>
        {effectiveSign && <span className="digit-odometer__sign">{effectiveSign}</span>}
        {transitions.map(({ digit, previousDigit, place }, index) => {
          return (
            <Fragment key={`place-${place}`}>
              <DigitSlot
                digit={digit}
                place={place}
                previousDigit={previousDigit}
                direction={direction}
              />
              {safeDecimalPlaces > 0 && index === transitions.length - safeDecimalPlaces - 1 && (
                <span className="digit-odometer__decimal">.</span>
              )}
            </Fragment>
          )
        })}
      </span>
    </span>
  )
}

function DigitSlot({
  digit,
  place,
  previousDigit,
  direction
}: {
  digit: number
  place: number
  previousDigit: number
  direction: DigitRollDirection
}): JSX.Element {
  const frame = digitRollFrame(previousDigit, digit, direction)
  const isRolling = frame.startIndex !== frame.targetIndex
  const style = {
    '--digit-odometer-start': `-${frame.startIndex}em`,
    '--digit-odometer-target': `-${frame.targetIndex}em`,
    '--digit-odometer-delay': `${Math.min(place, 6) * 18}ms`
  } as CSSProperties

  return (
    <span className="digit-odometer__slot">
      <span
        key={`${previousDigit}-${digit}-${direction}`}
        className={`digit-odometer__column${isRolling ? ' is-rolling' : ''}`}
        style={style}
      >
        {frame.cells.map((d, index) => (
          <span key={`${d}-${index}`} className="digit-odometer__cell">
            {d}
          </span>
        ))}
      </span>
    </span>
  )
}
