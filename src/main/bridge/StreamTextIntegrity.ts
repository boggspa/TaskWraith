// UTF-16 integrity for per-delta wire envelopes.
//
// JS strings tolerate lone surrogate halves and heal them on concatenation,
// so a provider delta that splits an emoji (or any astral-plane char) across
// two chunks is invisible on every lane that ACCUMULATES before rendering —
// the renderer, the bridge transcript state, the persisted chat. The remote
// bridge, though, forwards each delta as its own JSON envelope; a chunk
// ending in an unpaired high surrogate serializes as a lone \uD8xx escape,
// and Swift's JSON decoding replaces each stranded half with U+FFFD. The
// phone accumulates those two replacement characters PERMANENTLY while the
// Mac's copy of the same text heals — emoji render as "?" boxes only on iOS
// (F14).
//
// The fix: never let an envelope end mid-surrogate-pair. Hold the trailing
// high surrogate back and lead the following delta with it. Pure module so
// the boundary math is unit-testable.

/** True when the code unit is a UTF-16 high (leading) surrogate. */
function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

export interface LoneSurrogateSplit {
  /** Safe to serialize into its own JSON envelope. */
  emit: string
  /** Trailing lone high surrogate to prepend to the next delta ('' if none). */
  held: string
}

export function splitTrailingLoneHighSurrogate(text: string): LoneSurrogateSplit {
  if (!text) return { emit: text, held: '' }
  if (isHighSurrogate(text.charCodeAt(text.length - 1))) {
    return { emit: text.slice(0, -1), held: text.slice(-1) }
  }
  return { emit: text, held: '' }
}

/** Per-run holdback: joins the previously held half to the incoming delta,
 * then splits any new trailing half. The caller keys stashes by run id and
 * clears them on terminal lines and cumulative restatements (a restatement
 * re-carries the whole healed turn, so a stale half must not lead it). */
export function rejoinHeldSurrogate(held: string, incoming: string): LoneSurrogateSplit {
  return splitTrailingLoneHighSurrogate(held + incoming)
}
