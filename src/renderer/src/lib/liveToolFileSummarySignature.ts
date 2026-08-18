import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import { TASKWRAITH_CLOSEOUT_KIND } from '../../../shared/taskWraithCloseout'

// This signature is only ever compared for equality (it gates the live
// tool-file diff refresh), so it must never carry the tool output itself.
// It used to: each chunk was `${id}:${JSON.stringify(activities)}` joined into
// one string, rebuilt on every coalesced flush. An ensemble run broadcasts
// whole-chat snapshots 10-100x/second, so that rebuilt a string the size of
// the run's entire streamed tool output tens of times a second - ~100MB/min at
// the low end and ~1GB/min at the high end on a single 142-message run. Those
// are large-object allocations, so they land straight in old space and walked
// V8 into its ~4GB heap cap: the renderer aborted after 44 minutes of ensemble
// streaming on 2026-08-18 23:31. Digesting instead keeps every chunk a fixed
// ~40 characters no matter how much output the run has produced.

// Per-ACTIVITY digest cache. Activities are replaced by spread rather than
// mutated in place (createToolActivity / pairToolResult / the telemetry
// reducers / mergeHydratedToolActivityDetails all build fresh objects), so
// object identity is a sound key. Caching per activity rather than per message
// means appending one activity to a live run re-serialises only that activity
// instead of the whole accumulated list - O(changed), not O(n) per flush.
const activityDigestCache = new WeakMap<ToolActivity, string>()

// Per-LIST digest cache, keyed on the toolActivities array. Ensemble
// deliveries hand us brand-new message objects even when a message's
// activities are untouched, so keying on the message would miss on every
// flush; keying on the array holds the entry across those replacements.
const activityListDigestCache = new WeakMap<readonly ToolActivity[], string>()

// Control-char separator: today's message ids never contain '|', but an id
// that did could let two different (id, digest) splits join into equal
// strings. \u0001 cannot appear in an id at all. Built via fromCharCode so no
// literal control byte lands in this source file (CI control-byte guard).
const CHUNK_SEPARATOR = String.fromCharCode(1)

/**
 * Two independent 32-bit rolling hashes over `value`, emitted with its length.
 * Paired this way a collision needs all three to agree, which is far beyond
 * the handful of comparisons a single streaming run performs.
 */
function digestOf(value: string): string {
  let fnv = 0x811c9dc5
  let djb = 5381
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    fnv = Math.imul(fnv ^ code, 0x01000193)
    djb = Math.imul(djb, 33) ^ code
  }
  return `${value.length.toString(36)}.${(fnv >>> 0).toString(36)}.${(djb >>> 0).toString(36)}`
}

function activityDigest(activity: ToolActivity): string {
  // Defensive: a null/non-object element would throw at WeakMap.set, where the
  // old array-level stringify tolerated it as "null". Unreachable per the type
  // (and a 209,916-message sweep found zero), but free to close.
  if (!activity || typeof activity !== 'object') return '0'
  let digest = activityDigestCache.get(activity)
  if (digest === undefined) {
    digest = digestOf(JSON.stringify(activity))
    activityDigestCache.set(activity, digest)
  }
  return digest
}

function activityListDigest(activities: readonly ToolActivity[]): string {
  let digest = activityListDigestCache.get(activities)
  if (digest === undefined) {
    // Recombining cached per-activity digests is O(count) over ~20-char
    // strings, so an appended activity costs one serialisation, not a full
    // re-serialisation of everything the run has streamed so far.
    let combined = ''
    for (const activity of activities) combined += activityDigest(activity) + ','
    digest = `${activities.length.toString(36)}.${digestOf(combined)}`
    activityListDigestCache.set(activities, digest)
  }
  return digest
}

export function buildLiveToolFileSummarySignature(messages: readonly ChatMessage[]): string {
  const chunks: string[] = []
  for (const message of messages) {
    if (message.metadata?.kind === TASKWRAITH_CLOSEOUT_KIND) continue
    if (!message.toolActivities?.length) continue
    chunks.push(`${message.id}:${activityListDigest(message.toolActivities)}`)
  }
  return chunks.join(CHUNK_SEPARATOR)
}
