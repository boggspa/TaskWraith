/*
 * assistantDeltaMerge — 1.0.6 duplication/triplication fix.
 *
 * The transcript renderer accumulates streamed assistant text by
 * appending each `assistant_message_delta` content event onto the live
 * bubble. That is correct ONLY when every event is a true increment.
 * Two providers can instead deliver the WHOLE turn again as a single
 * content event, and a blind append then doubles (or triples) the
 * bubble:
 *
 *   - Claude (Agent SDK, includePartialMessages): incremental
 *     `stream_event` text deltas PLUS a trailing cumulative `assistant`
 *     envelope that re-states the entire turn. Main slices the streamed
 *     prefix off the envelope, but when the envelope DIVERGES from the
 *     streamed deltas (whitespace / block boundaries / thinking
 *     interleave) the slice misses and the full text is forwarded —
 *     now tagged `cumulative` so we REPLACE rather than append.
 *
 *   - Cursor (cursor-agent stream-json, no --stream-partial-output):
 *     each `assistant` frame is a cumulative full-text snapshot,
 *     forwarded untagged. We detect it as a (growing or equal) superset
 *     of what we already show and REPLACE.
 *
 * The other providers (codex / gemini / kimi / grok) only ever emit
 * genuine increments here (or a separate `assistant_message_complete`
 * that already replaces), so they take the `append` path unchanged.
 *
 * This is the solo-run analogue of the guard that already exists on the
 * ensemble path (EnsembleOrchestrator: "non-delta repeat-of-deltas →
 * drop on the floor"). Pure + side-effect free so it can be unit tested
 * in isolation from the 30k-line App.tsx handler that calls it.
 */

export type AssistantDeltaMerge =
  | { action: 'append' }
  | { action: 'replace'; content: string }
  | { action: 'skip' }

/**
 * Decide how an incoming `assistant_message_delta` should fold into the
 * live assistant bubble's `current` content.
 *
 * - `append`  — genuine increment (or a new Codex item): caller appends
 *               `incoming` (with its existing separator / metadata logic).
 * - `replace` — `incoming` is the authoritative full turn: caller swaps
 *               the bubble content for `merge.content`.
 * - `skip`    — `incoming` is a stale/duplicate re-statement we already
 *               render in full: caller leaves the bubble untouched.
 */
export function resolveAssistantDeltaMerge(
  current: string,
  incoming: string,
  options: { cumulative?: boolean; trustedIncremental?: boolean } = {}
): AssistantDeltaMerge {
  // Empty incoming → nothing to add; let the caller no-op via append.
  if (!incoming) return { action: 'append' }

  // Explicit tag from main (it shape-detected a full re-statement that
  // diverged from the streamed deltas) is authoritative.
  if (options.cumulative) return { action: 'replace', content: incoming }

  // Run-item sidecar lane: main's compat mapper tags every restatement
  // (`cumulative || runItemCumulative || snapshot`), and every provider
  // either prefix-slices superset restatements main-side (Claude/Kimi
  // handleCliProviderJsonEvent, Codex item-completed tail, Ollama
  // unstreamedOllamaContent) or tags them (Cursor snapshot frames) — so an
  // untagged sidecar delta is a VERBATIM increment and must append even
  // when it happens to equal or prefix the bubble byte-wise (a repeated
  // chunk like "test ","test " was being shape-swallowed below). The
  // legacy lane never sets this and keeps full shape detection: untagged
  // Cursor banner/text lines still rely on it.
  if (options.trustedIncremental) return { action: 'append' }

  // Nothing streamed yet → first chunk; plain append (onto '').
  if (!current) return { action: 'append' }

  // Incoming restates everything we already show — equal, or a growing
  // superset (cumulative snapshot). A TRUE delta is the new suffix and
  // never starts with the full accumulated text, so this only matches a
  // re-statement. Replace (a no-op when equal). Catches Cursor frames
  // and any Claude envelope whose divergence is a clean tail-extension.
  if (incoming.length >= current.length && incoming.startsWith(current)) {
    return { action: 'replace', content: incoming }
  }

  // Incoming is a shorter prefix of what we already show — a stale/older
  // snapshot we've already surpassed (e.g. an out-of-order Cursor frame).
  // Drop it rather than appending a partial repeat.
  if (incoming.length < current.length && current.startsWith(incoming)) {
    return { action: 'skip' }
  }

  // Otherwise it's a genuine increment (or a new Codex item) — append.
  return { action: 'append' }
}
