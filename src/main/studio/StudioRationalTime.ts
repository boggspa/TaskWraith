/**
 * Lossless rational time for the Studio companion host.
 *
 * Every value is an integer tick count over a positive integer timescale (the
 * CMTime/FCPXML convention). All arithmetic runs through BigInt
 * cross-multiplication with exact gcd normalisation, so NTSC-style rates
 * (30000/1001) never accumulate floating-point drift and a frame boundary
 * stays a frame boundary after any number of edits.
 *
 * Wire values must remain safe integers after normalisation. Anything that
 * cannot be represented exactly raises a typed StudioTimeError instead of
 * silently rounding — "close" is corruption in a frame-precise editor.
 */

export interface StudioRationalTime {
  /** Integer tick count. May be negative in deltas. */
  readonly n: number
  /** Integer timescale. Always positive in normalised values. */
  readonly d: number
}

export type StudioTimeErrorCode = 'invalid_rational' | 'unrepresentable_time'

export class StudioTimeError extends Error {
  readonly code: StudioTimeErrorCode

  constructor(code: StudioTimeErrorCode, message: string) {
    super(message)
    this.name = 'StudioTimeError'
    this.code = code
  }
}

export const STUDIO_TIME_ZERO: StudioRationalTime = Object.freeze({ n: 0, d: 1 })

const BIG_ZERO = BigInt(0)
const BIG_ONE = BigInt(1)
const BIG_MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

function absBig(value: bigint): bigint {
  return value < BIG_ZERO ? -value : value
}

function gcdBig(a: bigint, b: bigint): bigint {
  let x = absBig(a)
  let y = absBig(b)
  while (y !== BIG_ZERO) {
    const rest = x % y
    x = y
    y = rest
  }
  return x === BIG_ZERO ? BIG_ONE : x
}

function normalise(n: bigint, d: bigint, context: string): StudioRationalTime {
  if (d === BIG_ZERO) {
    throw new StudioTimeError('invalid_rational', `${context}: denominator must not be zero`)
  }
  let num = n
  let den = d
  if (den < BIG_ZERO) {
    num = -num
    den = -den
  }
  const divisor = gcdBig(num, den)
  num /= divisor
  den /= divisor
  if (absBig(num) > BIG_MAX_SAFE || den > BIG_MAX_SAFE) {
    throw new StudioTimeError(
      'unrepresentable_time',
      `${context}: exact value ${num}/${den} exceeds the safe integer range`
    )
  }
  return { n: Number(num), d: Number(den) }
}

/** Structural wire-shape check: integer ticks over a positive integer timescale. */
export function isStudioRationalTime(value: unknown): value is StudioRationalTime {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { n?: unknown; d?: unknown }
  return (
    typeof candidate.n === 'number' &&
    Number.isSafeInteger(candidate.n) &&
    typeof candidate.d === 'number' &&
    Number.isSafeInteger(candidate.d) &&
    candidate.d > 0
  )
}

/** Validate an untrusted wire value and return its normalised form. */
export function studioTimeFromWire(value: unknown, context = 'time'): StudioRationalTime {
  if (!isStudioRationalTime(value)) {
    throw new StudioTimeError(
      'invalid_rational',
      `${context}: expected { n: safe integer, d: positive safe integer }`
    )
  }
  return normalise(BigInt(value.n), BigInt(value.d), context)
}

export function studioTimeAdd(a: StudioRationalTime, b: StudioRationalTime): StudioRationalTime {
  return normalise(
    BigInt(a.n) * BigInt(b.d) + BigInt(b.n) * BigInt(a.d),
    BigInt(a.d) * BigInt(b.d),
    'add'
  )
}

export function studioTimeSub(a: StudioRationalTime, b: StudioRationalTime): StudioRationalTime {
  return normalise(
    BigInt(a.n) * BigInt(b.d) - BigInt(b.n) * BigInt(a.d),
    BigInt(a.d) * BigInt(b.d),
    'subtract'
  )
}

export function studioTimeCompare(a: StudioRationalTime, b: StudioRationalTime): -1 | 0 | 1 {
  const left = BigInt(a.n) * BigInt(b.d)
  const right = BigInt(b.n) * BigInt(a.d)
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function studioTimeEquals(a: StudioRationalTime, b: StudioRationalTime): boolean {
  return studioTimeCompare(a, b) === 0
}

/**
 * True when the time lands exactly on a frame boundary of the given rate:
 * time multiplied by framesPerSecond must be an integer frame count.
 */
export function studioTimeIsFrameAligned(
  time: StudioRationalTime,
  framesPerSecond: StudioRationalTime
): boolean {
  const frameNumerator = BigInt(time.n) * BigInt(framesPerSecond.n)
  const frameDenominator = BigInt(time.d) * BigInt(framesPerSecond.d)
  return frameNumerator % frameDenominator === BIG_ZERO
}
