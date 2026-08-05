import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'

/**
 * CharOdometer — the DigitOdometer roll generalised to arbitrary text, built
 * for the authoritative seat-change transcript row (provider names, model
 * labels, reasoning suffixes, roles). It reuses the `digit-odometer__*` CSS
 * verbatim (same 1em clipped slots, same 430ms house curve, same 18ms/place
 * stagger, same reduce-motion nulling), so both odometers stay one visual
 * family.
 *
 * Differences from the numeric wheel, and why:
 * - Slots align from the LEFT and are keyed by index. Text has no place-value
 *   carry semantics; a length change simply grows or shrinks the tail.
 * - Digit slots are a fixed `1ch` wide; characters are not. Each slot gets an
 *   explicit measured width (canvas measureText against the host's computed
 *   font — the approach the approved mock used) so the roll never reflows the
 *   surrounding row, and a CSS width transition carries old→new widths in
 *   lockstep with the roll.
 * - Every changed character rolls upward through exactly two cells (old →
 *   new). There is no shortest-path direction question for glyphs.
 *
 * Accessibility mirrors DigitOdometer: the wheels are aria-hidden and a
 * sr-only node carries the real text.
 */

let measureContext: CanvasRenderingContext2D | null = null

function charWidth(char: string, font: string): number | undefined {
  if (!char || !font || typeof document === 'undefined') return undefined
  if (!measureContext) {
    measureContext = document.createElement('canvas').getContext('2d')
  }
  if (!measureContext) return undefined
  measureContext.font = font
  return measureContext.measureText(char).width
}

interface CharSlot {
  previousChar: string
  char: string
}

function buildCharSlots(previous: string, next: string): CharSlot[] {
  const length = Math.max(previous.length, next.length)
  const slots: CharSlot[] = []
  for (let index = 0; index < length; index += 1) {
    slots.push({ previousChar: previous[index] ?? '', char: next[index] ?? '' })
  }
  return slots
}

export function CharOdometer({
  text,
  className
}: {
  text: string
  className?: string
}): JSX.Element {
  const hostRef = useRef<HTMLSpanElement | null>(null)
  const previousTextRef = useRef(text)
  const [font, setFont] = useState('')

  // Ref read inside the memo (DigitOdometer's transitions pattern): the memo
  // recomputes exactly when `text` changes, seeing the not-yet-updated
  // previous text for that one render — which is the roll frame we want.
  const slots = useMemo(() => buildCharSlots(previousTextRef.current, text), [text])
  useEffect(() => {
    previousTextRef.current = text
  }, [text])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const computed = getComputedStyle(host)
    setFont(
      `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`
    )
  }, [])

  return (
    <span
      ref={hostRef}
      className={`digit-odometer char-odometer${className ? ' ' + className : ''}`}
    >
      <span className="sr-only">{text}</span>
      <span className="digit-odometer__visual" aria-hidden>
        {slots.map((slot, index) => (
          <CharSlotView key={`slot-${index}`} slot={slot} index={index} font={font} />
        ))}
      </span>
    </span>
  )
}

function CharSlotView({
  slot,
  index,
  font
}: {
  slot: CharSlot
  index: number
  font: string
}): JSX.Element {
  const { previousChar, char } = slot
  const isRolling = previousChar !== char
  const width = charWidth(char, font)
  const slotStyle: CSSProperties | undefined =
    width === undefined ? undefined : { width: `${width}px` }
  const columnStyle = {
    '--digit-odometer-start': '0em',
    '--digit-odometer-target': isRolling ? '-1em' : '0em',
    '--digit-odometer-delay': `${Math.min(index, 12) * 18}ms`
  } as CSSProperties
  // Spaces must keep their advance inside the 1em-tall block cells.
  const renderChar = (value: string): string => (value === ' ' ? '\u00A0' : value)

  return (
    <span className="digit-odometer__slot char-odometer__slot" style={slotStyle}>
      <span
        key={`${previousChar}-${char}`}
        className={`digit-odometer__column${isRolling ? ' is-rolling' : ''}`}
        style={columnStyle}
      >
        {isRolling ? (
          <>
            <span className="digit-odometer__cell">{renderChar(previousChar)}</span>
            <span className="digit-odometer__cell">{renderChar(char)}</span>
          </>
        ) : (
          <span className="digit-odometer__cell">{renderChar(char)}</span>
        )}
      </span>
    </span>
  )
}
