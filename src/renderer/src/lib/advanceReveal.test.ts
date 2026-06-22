import { describe, it, expect } from 'vitest'
import { REVEAL_PARAMS, fadeOpacity, smoothstep } from '../../../shared/revealParams'
import {
  advanceReveal,
  graphemeCount,
  sliceGraphemes,
  snapForwardToWordBoundary,
  toGraphemes,
  type AdvanceRevealInput
} from './advanceReveal'

const P = REVEAL_PARAMS

function wellFormed(s: string): boolean {
  if (typeof (s as { isWellFormed?: () => boolean }).isWellFormed === 'function') {
    return (s as unknown as { isWellFormed: () => boolean }).isWellFormed()
  }
  // No lone surrogates.
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)
}

// Drive the cursor to completion and return [framesUsed, finalRevealed].
function driveToTarget(content: string, opts: Partial<AdvanceRevealInput> = {}, maxFrames = 10000) {
  let revealed = 0
  let frames = 0
  const target = graphemeCount(content)
  while (revealed < target && frames < maxFrames) {
    revealed = advanceReveal({
      prev: content,
      next: content,
      revealed,
      isComplete: false,
      dt: 0.05,
      ...opts
    })
    frames++
  }
  return { frames, revealed, target }
}

describe('grapheme helpers', () => {
  it('counts and slices ASCII by character', () => {
    expect(graphemeCount('hello')).toBe(5)
    expect(sliceGraphemes('hello', 3)).toBe('hel')
    expect(sliceGraphemes('hello', 0)).toBe('')
    expect(sliceGraphemes('hello', 99)).toBe('hello')
  })

  it('treats emoji / ZWJ / flags / combining marks / CJK as single graphemes', () => {
    const family = '👨‍👩‍👧‍👦' // ZWJ sequence
    const flag = '🇬🇧' // regional indicator pair
    const accent = 'é' // e + combining acute = é
    const content = `a${family}b${flag}c${accent}d你好`
    // Only assert the exact count when a real grapheme segmenter is present.
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      expect(graphemeCount(content)).toBe(9)
      expect(sliceGraphemes(content, 2)).toBe(`a${family}`)
      expect(sliceGraphemes(content, 4)).toBe(`a${family}b${flag}`)
    }
    // Robust regardless of segmenter: every prefix slice is well-formed and a
    // real prefix of the content (never splits a surrogate pair).
    for (let n = 0; n <= graphemeCount(content); n++) {
      const s = sliceGraphemes(content, n)
      expect(content.startsWith(s)).toBe(true)
      expect(wellFormed(s)).toBe(true)
    }
  })
})

describe('fadeOpacity / smoothstep', () => {
  it('smoothstep clamps and eases', () => {
    expect(smoothstep(-1)).toBe(0)
    expect(smoothstep(0)).toBe(0)
    expect(smoothstep(1)).toBe(1)
    expect(smoothstep(2)).toBe(1)
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 5)
  })

  it('fades from 0 at the frontier to 1 at the tail, monotonically', () => {
    expect(fadeOpacity(0)).toBe(0)
    expect(fadeOpacity(P.fadeTailChars)).toBe(1)
    expect(fadeOpacity(P.fadeTailChars * 2)).toBe(1) // clamped
    let prev = -1
    for (let d = 0; d <= P.fadeTailChars; d++) {
      const o = fadeOpacity(d)
      expect(o).toBeGreaterThanOrEqual(prev)
      prev = o
    }
  })
})

describe('snapForwardToWordBoundary', () => {
  const g = toGraphemes('the quick brown')
  it('advances to just past the next whitespace', () => {
    // index 5 is inside "quick"; snap to after "quick " (index 10).
    expect(snapForwardToWordBoundary(g, 5, 26)).toBe(10)
  })
  it('returns the raw index when no boundary is within look-ahead', () => {
    const url = toGraphemes('https://example.com/a/very/long/path')
    expect(snapForwardToWordBoundary(url, 3, 5)).toBe(3) // no space within 5
  })
  it('clamps at the end', () => {
    expect(snapForwardToWordBoundary(g, g.length, 26)).toBe(g.length)
  })
})

describe('advanceReveal — convergence', () => {
  it('returns target immediately when there is no backlog', () => {
    expect(
      advanceReveal({ prev: 'abc', next: 'abc', revealed: 3, isComplete: false, dt: 0.05 })
    ).toBe(3)
    expect(
      advanceReveal({ prev: 'abc', next: 'abc', revealed: 5, isComplete: false, dt: 0.05 })
    ).toBe(3)
  })

  it('always converges to the full content (streaming)', () => {
    const content = 'The quick brown fox jumps over the lazy dog. '.repeat(8)
    const { revealed, target, frames } = driveToTarget(content)
    expect(revealed).toBe(target)
    expect(frames).toBeLessThan(target) // word-snapping means fewer frames than chars
    expect(sliceGraphemes(content, revealed)).toBe(content)
  })

  it('never stalls while backlog remains (tiny dt advances >= 1 grapheme)', () => {
    const r = advanceReveal({
      prev: 'abcdefghij',
      next: 'abcdefghij',
      revealed: 0,
      isComplete: false,
      dt: 0.0001
    })
    expect(r).toBeGreaterThanOrEqual(1)
  })

  it('clamps a huge dt to the per-frame anti-slam ceiling while streaming', () => {
    const content = 'x'.repeat(5000)
    // dt of 100s would be ~astronomical; clamped to 0.1, rate capped, step <= maxCharsPerFrame.
    const r = advanceReveal({
      prev: content,
      next: content,
      revealed: 0,
      isComplete: false,
      dt: 100
    })
    expect(r).toBeLessThanOrEqual(P.maxCharsPerFrame)
  })
})

describe('advanceReveal — terminal drain', () => {
  it('drains aggressively on terminal, far past the streaming anti-slam clamp', () => {
    const content = 'y'.repeat(5000)
    // dt is clamped to 0.1s even on terminal, so one frame is not the whole
    // thing — but it advances FAR past the 96-grapheme streaming cap (proving
    // the bypass) and converges within the budget across frames (next test).
    const r = advanceReveal({
      prev: content,
      next: content,
      revealed: 0,
      isComplete: true,
      dt: 0.1
    })
    expect(r).toBeGreaterThan(P.maxCharsPerFrame * 10)
    expect(r).toBeLessThan(5000)
  })

  it('finishes within the completeDrainMs budget across frames', () => {
    const content = 'z'.repeat(5000)
    const { frames } = driveToTarget(content, { isComplete: true }, 100)
    // At 50ms/frame, completeDrainMs=250ms => ~5 frames, allow one slack frame.
    expect(frames).toBeLessThanOrEqual(Math.ceil(P.completeDrainMs / 50) + 1)
  })

  it('advances well past maxCharsPerFrame in a single terminal frame', () => {
    const content = 'q'.repeat(2000)
    const r = advanceReveal({
      prev: content,
      next: content,
      revealed: 0,
      isComplete: true,
      dt: 0.05
    })
    expect(r).toBeGreaterThan(P.maxCharsPerFrame)
  })
})

describe('advanceReveal — divergence rewind', () => {
  it('rewinds the cursor to the common prefix when the segment is rewritten', () => {
    // prev "hello world" revealed 11; next "hello there" => common "hello " (6).
    const r = advanceReveal({
      prev: 'hello world',
      next: 'hello there',
      revealed: 11,
      isComplete: false,
      dt: 0.05
    })
    expect(r).toBeLessThanOrEqual(graphemeCount('hello there'))
    // It must not claim text beyond the common prefix as already-revealed; the
    // returned slice is a valid prefix of the NEW content.
    expect('hello there'.startsWith(sliceGraphemes('hello there', r))).toBe(true)
    // The divergent suffix ("world" vs "there") was rewound, so the cursor is
    // at most a little past the common prefix (6), not stuck at 11.
    expect(r).toBeLessThan(11)
  })

  it('does not rewind on a pure append (the common case)', () => {
    const r = advanceReveal({
      prev: 'hello',
      next: 'hello world',
      revealed: 5,
      isComplete: false,
      dt: 0.05
    })
    expect(r).toBeGreaterThanOrEqual(5)
  })
})

describe('advanceReveal — grapheme safety golden fixture', () => {
  it('never returns a cursor that splits a surrogate / ZWJ / combining cluster', () => {
    const content = `start ${'👨‍👩‍👧‍👦'} mid ${'🇬🇧'} ${'é'}nd 你好世界 done`
    let revealed = 0
    const target = graphemeCount(content)
    let guard = 0
    while (revealed < target && guard < 10000) {
      revealed = advanceReveal({
        prev: content,
        next: content,
        revealed,
        isComplete: false,
        dt: 0.05
      })
      const slice = sliceGraphemes(content, revealed)
      expect(wellFormed(slice)).toBe(true)
      expect(content.startsWith(slice)).toBe(true)
      guard++
    }
    expect(revealed).toBe(target)
    expect(sliceGraphemes(content, revealed)).toBe(content)
  })
})

describe('advanceReveal — guards', () => {
  it('treats negative dt as zero (no backward motion, still no stall)', () => {
    const r = advanceReveal({
      prev: 'abcdef',
      next: 'abcdef',
      revealed: 2,
      isComplete: false,
      dt: -5
    })
    expect(r).toBeGreaterThanOrEqual(2)
  })
})
