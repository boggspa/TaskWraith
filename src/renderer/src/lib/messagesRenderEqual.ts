import type { ChatMessage } from '../../../main/store/types'

/*
 * messagesRenderEqual — "would these two message lists render identically?"
 *
 * Used by the `chat-updated` handler in App.tsx to suppress redundant
 * transcript work. Ensemble runs broadcast a fresh whole-chat snapshot
 * 10–100×/second (per-participant token tallies, active-round flips, per-tool
 * events). Most of those broadcasts change only chat-level ENSEMBLE metadata,
 * not the rendered message list — yet each one arrives as a brand-new
 * `messages` array (deserialised over IPC), which re-fires the messages-update
 * snap effect (keyed on `currentChat?.messages` identity) and re-renders the
 * transcript. When this returns true, the handler preserves the PREVIOUS
 * `messages` array reference so neither happens; the chat-level metadata still
 * updates.
 *
 * SAFETY CONTRACT — this MUST be conservative (strict). The caller preserves
 * the old array ONLY when this returns true, so:
 *   - A false NEGATIVE (saying "different" when actually equal) costs at most a
 *     redundant render — the existing, correct behaviour.
 *   - A false POSITIVE (saying "equal" when actually different) would preserve a
 *     STALE message list and freeze the transcript — strictly worse than the
 *     bug we're avoiding.
 * So every structural difference returns false; when in any doubt, return false.
 * This is why we deep-compare the FULL message objects rather than a hand-picked
 * subset of "render-affecting" fields (which would risk missing one and freezing).
 */

/**
 * Conservative deep structural equality over the plain-data shapes that make up
 * a persisted ChatMessage: primitives, arrays, and plain objects (plus
 * null/undefined). Any structural difference — differing key sets, lengths,
 * types, or primitive values — returns false. NaN compares unequal (a harmless
 * false negative). Not intended for class instances, Maps/Sets, Dates, or
 * cyclic graphs; ChatMessage carries none of those.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  // typeof null === 'object', so handle null explicitly before the object path.
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false // same typeof, not ===, not object ⇒ unequal primitive
  const aArray = Array.isArray(a)
  const bArray = Array.isArray(b)
  if (aArray || bArray) {
    if (!aArray || !bArray) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const aKeys = Object.keys(ao)
  const bKeys = Object.keys(bo)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, key)) return false
    if (!deepEqual(ao[key], bo[key])) return false
  }
  return true
}

/**
 * True only when `a` and `b` are render-identical message lists. Short-circuits
 * on the cheap signals first (same reference, then length), then per element
 * (reference, then deep). Preserves the strict-by-construction safety contract
 * documented above.
 */
export function messagesRenderEqual(
  a: readonly ChatMessage[],
  b: readonly ChatMessage[]
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue
    if (!deepEqual(a[i], b[i])) return false
  }
  return true
}
