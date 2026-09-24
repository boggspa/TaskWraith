import type { ChatMessage } from '../../../main/store/types'

/**
 * The transcript's row identity, in one place.
 *
 * A row key is the message id plus how many rows carrying that same id came
 * before it in the rendered list — NOT the list index.
 *
 * Accumulated infinite scroll prepends older history onto the front of the
 * list, which shifts every following index by the size of the page that just
 * arrived. An index-based key would therefore change for every mounted row on
 * each prepend, orphaning its cached measurement and its DOM element; the
 * re-measure from coarse estimates that follows is visible as exactly the jolt
 * seamless scrolling exists to remove.
 *
 * The occurrence counter preserves the duplicate-id protection that made the
 * index necessary in the first place: duplicate message ids DO exist in
 * historical/imported transcripts (pre-1.0.7 ensemble round-status rows all
 * shared one id), and two rows sharing a measurement slot would mis-size both.
 * For the overwhelmingly common unique id the suffix is always `#0`, so the key
 * survives any amount of prepending or appending.
 *
 * EVERY producer of a row key must derive it from this module. The render path,
 * fan-out lane pairing, jump targets, and in-chat search all look each other's
 * rows up by key, so a second minting scheme does not merely disagree — it
 * silently misses, and the symptom (lane slots vanishing, jumps landing on the
 * wrong row) looks nothing like a keying bug.
 */
export function transcriptRowKey(messageId: string, occurrence: number): string {
  return `${messageId}#${occurrence}`
}

/** Count this message id within the list being walked and return its ordinal. */
export function nextRowOccurrence(
  occurrences: Map<string, number>,
  messageId: string | null | undefined
): number {
  if (typeof messageId !== 'string' || messageId.length === 0) return 0
  const occurrence = occurrences.get(messageId) ?? 0
  occurrences.set(messageId, occurrence + 1)
  return occurrence
}

/**
 * Row keys for a whole message list, index-aligned with the input.
 *
 * Occurrence numbering only makes sense as a single forward walk, so callers
 * that need random access (pairing runs, jump targets, search hits) build the
 * array once and index into it rather than deriving a key per row — deriving
 * one in isolation cannot know how many earlier rows shared its id.
 */
export function buildTranscriptRowKeys(messages: readonly ChatMessage[]): string[] {
  if (!Array.isArray(messages) || messages.length === 0) return []
  const occurrences = new Map<string, number>()
  const keys: string[] = new Array(messages.length)
  for (let index = 0; index < messages.length; index += 1) {
    const id = messages[index]?.id
    keys[index] = transcriptRowKey(id, nextRowOccurrence(occurrences, id))
  }
  return keys
}
