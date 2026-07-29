/**
 * 1.0.5 — Tier-A markdown highlighting for the composer overlay.
 *
 * Layers Discord-flavoured markdown *syntax highlighting* on top of
 * the existing mention tokenisation, producing flat "rich runs" the
 * `ComposerHighlightOverlay` renders as spans. This is highlighted
 * SOURCE, not WYSIWYG: every character of the draft stays visible in
 * place (markers included), and every style the flags map to is
 * metric-safe — colour, opacity, text-shadow, text-decoration,
 * background. Nothing here may ever change a glyph's advance width
 * or a line's wrap point, or the overlay drifts from the textarea's
 * caret. The enforceable half of that rule lives in
 * `components/composerOverlayMetricSafety.test.ts`, which lint-scans
 * the CSS these flags map to. True WYSIWYG (hidden markers, real
 * bold, monospace code) is deliberately out of scope until the
 * contenteditable migration (`ContenteditableComposer.tsx`) lands.
 *
 * Supported constructs (v1):
 *   - `**bold**`, `*italic*` / `_italic_`, `__underline__`,
 *     `~~strike~~` (same line, non-empty content, exact delimiter
 *     runs — `***x***` stays plain, documented limitation)
 *   - `` `inline code` `` and ``` fenced blocks (line-anchored)
 *   - `> quote` (up to `>>>`), `- ` / `* ` / `+ ` / `1. ` bullets
 *
 * Mention interplay: mention source ranges are MASKED (same-length
 *   `x` fill) before the markdown scan. Delimiter characters inside
 *   a mention label can never open/close a construct, while a
 *   construct may span across a mention (`**hi @codex**` bolds the
 *   mention). Structured mentions (`[@Label](ensemble-dm://id)`)
 *   render shortened text, so runs are emitted per-segment using the
 *   tokeniser's SOURCE lengths — never assume overlay text length
 *   equals draft length.
 */

import type { EnsembleParticipant } from '../../../main/store/types'
import { tokeniseMentions, type MentionTokenSegment } from './mentionHighlight'

export type ComposerMarkdownFlag =
  | 'md-bold'
  | 'md-italic'
  | 'md-underline'
  | 'md-strike'
  | 'md-code'
  | 'md-code-block'
  | 'md-quote'
  | 'md-marker'
  | 'md-quote-marker'
  | 'md-bullet-marker'

/** Deterministic class order — also the order runs report flags in.
 * Exported for `composerOverlayMetricSafety.test.ts`, which asserts
 * every flag has a (metric-safe) CSS rule — adding a flag without
 * styling it fails that lint, not a user's draft. */
export const COMPOSER_MARKDOWN_FLAGS: readonly ComposerMarkdownFlag[] = [
  'md-code-block',
  'md-quote',
  'md-code',
  'md-bold',
  'md-italic',
  'md-underline',
  'md-strike',
  'md-marker',
  'md-quote-marker',
  'md-bullet-marker'
]

export type ComposerMentionRun = Extract<
  MentionTokenSegment,
  { kind: 'mention' } | { kind: 'user-mention' }
>

export interface ComposerRichRun {
  text: string
  /** Present when this run is a resolved mention token. */
  mention?: ComposerMentionRun
  /** Markdown flags covering the whole run (COMPOSER_MARKDOWN_FLAGS order). */
  flags: ComposerMarkdownFlag[]
}

interface FlagRange {
  start: number
  end: number
  flag: ComposerMarkdownFlag
}

interface PlacedSegment {
  seg: MentionTokenSegment
  start: number
  end: number
}

const FENCE_LINE_REGEX = /^\s{0,3}```/
const QUOTE_PREFIX_REGEX = /^(\s{0,3})(>{1,3})(\s?)/
const BULLET_PREFIX_REGEX = /^(\s{0,8})([-+*]|\d{1,3}[.)])(\s+)/
/**
 * Quick reject for the gate: a SUPERSET of anything the scanner can
 * flag. If none of these characters/prefixes appear, the draft has
 * no markdown and the full scan is skipped.
 */
const MARKDOWN_TRIGGER_REGEX = /[`*_~]|^\s{0,3}(?:>|[-+]\s|\d{1,3}[.)]\s)/m

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch)
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch)

function runLength(masked: string, index: number, ch: string, end: number): number {
  let n = 0
  while (index + n < end && masked[index + n] === ch) n++
  return n
}

interface EmphasisSpec {
  length: 1 | 2
  flag: ComposerMarkdownFlag
  /** CommonMark-ish underscore rule: no intra-word open/close. */
  wordBoundary: boolean
}

function emphasisSpecFor(ch: string, run: number): EmphasisSpec | null {
  if (run === 2) {
    if (ch === '*') return { length: 2, flag: 'md-bold', wordBoundary: false }
    if (ch === '_') return { length: 2, flag: 'md-underline', wordBoundary: true }
    if (ch === '~') return { length: 2, flag: 'md-strike', wordBoundary: false }
    return null
  }
  if (run === 1) {
    if (ch === '*') return { length: 1, flag: 'md-italic', wordBoundary: false }
    if (ch === '_') return { length: 1, flag: 'md-italic', wordBoundary: true }
  }
  return null
}

/**
 * Inline scan of one line segment. Code spans claim their intervals
 * first (Discord precedence: backticks beat emphasis), then a single
 * left-to-right emphasis pass that skips claimed characters. Runs of
 * unexpected length (`***`, `~~~`) are skipped whole — plain text
 * beats a wrong guess in a highlighting layer.
 */
function scanInlineRanges(masked: string, from: number, to: number, out: FlagRange[]): void {
  const claims: Array<{ start: number; end: number }> = []

  // Pass 1 — inline code spans (single backtick pairs, non-empty).
  let i = from
  while (i < to) {
    if (masked.charCodeAt(i) !== 96 /* ` */) {
      i++
      continue
    }
    const run = runLength(masked, i, '`', to)
    if (run !== 1) {
      i += run
      continue
    }
    let close = -1
    let j = i + 1
    while (j < to) {
      if (masked.charCodeAt(j) === 96) {
        const closeRun = runLength(masked, j, '`', to)
        if (closeRun === 1 && j > i + 1) {
          close = j
          break
        }
        j += closeRun
        continue
      }
      j++
    }
    if (close === -1) {
      i++
      continue
    }
    out.push({ start: i, end: close + 1, flag: 'md-code' })
    out.push({ start: i, end: i + 1, flag: 'md-marker' })
    out.push({ start: close, end: close + 1, flag: 'md-marker' })
    claims.push({ start: i, end: close + 1 })
    i = close + 1
  }

  const claimAt = (index: number): { start: number; end: number } | undefined =>
    claims.find((claim) => index >= claim.start && index < claim.end)

  // Pass 2 — emphasis.
  i = from
  while (i < to) {
    const claim = claimAt(i)
    if (claim) {
      i = claim.end
      continue
    }
    const ch = masked[i]
    if (ch !== '*' && ch !== '_' && ch !== '~') {
      i++
      continue
    }
    const run = runLength(masked, i, ch, to)
    const spec = emphasisSpecFor(ch, run)
    if (!spec) {
      i += run
      continue
    }
    if (spec.wordBoundary && i > 0 && isWordChar(masked[i - 1])) {
      i += run
      continue
    }
    const contentStart = i + spec.length
    if (contentStart >= to || isSpace(masked[contentStart])) {
      i += run
      continue
    }
    let close = -1
    let j = contentStart
    while (j < to) {
      const closeClaim = claimAt(j)
      if (closeClaim) {
        j = closeClaim.end
        continue
      }
      if (masked[j] === ch) {
        const closeRun = runLength(masked, j, ch, to)
        if (
          closeRun === spec.length &&
          j > contentStart &&
          !isSpace(masked[j - 1]) &&
          (!spec.wordBoundary || !isWordChar(masked[j + spec.length]))
        ) {
          close = j
          break
        }
        j += closeRun
        continue
      }
      j++
    }
    if (close === -1) {
      i += run
      continue
    }
    out.push({ start: i, end: contentStart, flag: 'md-marker' })
    out.push({ start: contentStart, end: close, flag: spec.flag })
    out.push({ start: close, end: close + spec.length, flag: 'md-marker' })
    i = close + spec.length
  }
}

/** Full markdown scan over the mention-masked draft. */
function scanMarkdownRanges(masked: string): FlagRange[] {
  const out: FlagRange[] = []
  const length = masked.length
  let inFence = false
  let lineStart = 0
  while (lineStart <= length) {
    const newlineAt = masked.indexOf('\n', lineStart)
    const lineEnd = newlineAt === -1 ? length : newlineAt
    const line = masked.slice(lineStart, lineEnd)
    if (FENCE_LINE_REGEX.test(line)) {
      out.push({ start: lineStart, end: lineEnd, flag: 'md-code-block' })
      out.push({ start: lineStart, end: lineEnd, flag: 'md-marker' })
      inFence = !inFence
    } else if (inFence) {
      if (lineStart < lineEnd) {
        out.push({ start: lineStart, end: lineEnd, flag: 'md-code-block' })
      }
    } else {
      let offset = 0
      const quote = QUOTE_PREFIX_REGEX.exec(line)
      if (quote) {
        const markStart = lineStart + quote[1].length
        out.push({ start: markStart, end: markStart + quote[2].length, flag: 'md-quote-marker' })
        const contentStart = lineStart + quote[0].length
        if (contentStart < lineEnd) {
          out.push({ start: contentStart, end: lineEnd, flag: 'md-quote' })
        }
        offset = quote[0].length
      }
      const bullet = BULLET_PREFIX_REGEX.exec(line.slice(offset))
      if (bullet) {
        const markStart = lineStart + offset + bullet[1].length
        out.push({ start: markStart, end: markStart + bullet[2].length, flag: 'md-bullet-marker' })
        offset += bullet[0].length
      }
      scanInlineRanges(masked, lineStart + offset, lineEnd, out)
    }
    if (newlineAt === -1) break
    lineStart = newlineAt + 1
  }
  return out
}

/**
 * Place each tokeniser segment at its SOURCE range in the draft.
 * Returns null when accounting doesn't add up to the draft length —
 * the caller must then fall back to mention-only runs rather than
 * guess offsets (defence against future tokeniser drift).
 */
function placeSegments(value: string, base: MentionTokenSegment[]): PlacedSegment[] | null {
  const placed: PlacedSegment[] = []
  let cursor = 0
  for (const seg of base) {
    const sourceLength = seg.kind === 'text' ? seg.text.length : (seg.sourceLength ?? -1)
    if (sourceLength < 0) return null
    placed.push({ seg, start: cursor, end: cursor + sourceLength })
    cursor += sourceLength
  }
  return cursor === value.length ? placed : null
}

function maskMentionRanges(value: string, placed: PlacedSegment[]): string {
  let masked = value
  for (const { seg, start, end } of placed) {
    if (seg.kind === 'text' || end <= start) continue
    masked = `${masked.slice(0, start)}${'x'.repeat(end - start)}${masked.slice(end)}`
  }
  return masked
}

function plainRunOf(seg: MentionTokenSegment): ComposerRichRun {
  if (seg.kind === 'text') return { text: seg.text, flags: [] }
  return { text: seg.text, mention: seg, flags: [] }
}

function coveringFlags(
  ranges: FlagRange[],
  start: number,
  end: number,
  excludeMarkers: boolean
): ComposerMarkdownFlag[] {
  const found = new Set<ComposerMarkdownFlag>()
  for (const range of ranges) {
    if (range.start <= start && range.end >= end) found.add(range.flag)
  }
  if (excludeMarkers) {
    found.delete('md-marker')
    found.delete('md-quote-marker')
    found.delete('md-bullet-marker')
  }
  return COMPOSER_MARKDOWN_FLAGS.filter((flag) => found.has(flag))
}

function sameFlags(left: ComposerMarkdownFlag[], right: ComposerMarkdownFlag[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false
  return true
}

/**
 * Tokenise the draft into rich runs: mention runs (with any covering
 * markdown flags) and text runs cut at markdown boundaries. The
 * concatenation of run texts is IDENTICAL to what the mention-only
 * overlay path renders today — this function only subdivides and
 * annotates, never rewrites.
 */
export function segmentComposerRichText(
  value: string,
  participants: EnsembleParticipant[]
): ComposerRichRun[] {
  if (!value) return []
  const base = tokeniseMentions(value, participants)
  const placed = placeSegments(value, base)
  if (!placed) return base.map(plainRunOf)
  const masked = maskMentionRanges(value, placed)
  const ranges = scanMarkdownRanges(masked)
  if (ranges.length === 0) return base.map(plainRunOf)

  const runs: ComposerRichRun[] = []
  for (const { seg, start, end } of placed) {
    if (seg.kind !== 'text') {
      // Markers can't sit inside a masked mention; only covering
      // construct flags (bold across a mention, quote/code-block
      // lines) apply. Marker-family flags are excluded so a mention
      // on a fence line doesn't render dimmed.
      runs.push({ text: seg.text, mention: seg, flags: coveringFlags(ranges, start, end, true) })
      continue
    }
    const cuts = new Set<number>([start, end])
    for (const range of ranges) {
      if (range.start > start && range.start < end) cuts.add(range.start)
      if (range.end > start && range.end < end) cuts.add(range.end)
    }
    const points = [...cuts].sort((a, b) => a - b)
    for (let k = 0; k + 1 < points.length; k++) {
      const sliceStart = points[k]
      const sliceEnd = points[k + 1]
      const flags = coveringFlags(ranges, sliceStart, sliceEnd, false)
      const text = value.slice(sliceStart, sliceEnd)
      const prev = runs[runs.length - 1]
      if (prev && !prev.mention && sameFlags(prev.flags, flags)) {
        prev.text += text
      } else {
        runs.push({ text, flags })
      }
    }
  }
  return runs
}

/**
 * Does the draft contain any markdown construct the overlay would
 * highlight? Drives the composer's overlay-activation gate alongside
 * `hasResolvedMention` — markdown works in every chat, participants
 * or not (they're only needed to mask mention labels out of the
 * scan).
 */
export function hasComposerMarkdown(value: string, participants: EnsembleParticipant[]): boolean {
  if (!value || !MARKDOWN_TRIGGER_REGEX.test(value)) return false
  return segmentComposerRichText(value, participants).some((run) => run.flags.length > 0)
}
