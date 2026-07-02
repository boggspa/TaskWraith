/*
 * BridgeTextFold — reconcile an incoming assistant text delta against the
 * bridge-run transcript's already-assembled text, for PHONE-INITIATED runs.
 *
 * Most providers (Codex / Gemini / Kimi, Claude's sliced stream) emit genuine
 * increments — the new suffix only. But Cursor (cursor-agent stream-json, no
 * `--stream-partial-output`) re-states the WHOLE turn in every `assistant`
 * frame, forwarded UNTAGGED (no `cumulative` flag) on agent-output. Blindly
 * appending such a frame re-adds the pre-tool prose below each tool burst,
 * duplicating the bubble in the persisted transcript the phone reads.
 *
 * This is the main-process twin of the renderer's `resolveAssistantDeltaMerge`
 * (src/renderer/src/lib/assistantDeltaMerge.ts) and the iOS
 * `StreamingSnapshotFold` (ios/.../StreamingMarkdown.swift): superset → keep
 * only the tail beyond the already-assembled text; shorter prefix → skip a
 * stale snapshot; otherwise → a genuine increment to append. Pure, so it is
 * unit-tested without the bridge-run state machine.
 *
 * `rendered` is the full concatenation of the assistant text assembled so far
 * (NOT including tool-part content) — i.e. BridgeRunTranscriptState.content.
 */

export type BridgeTextFold = { kind: 'append' } | { kind: 'skip' } | { kind: 'tail'; tail: string }

/**
 * True when a compat-line payload explicitly marks a full-turn cumulative
 * restatement. Mirrors RunItemEventCompat's mapping (`cumulative ||
 * runItemCumulative || snapshot`) — the complete tag set main's adapters use:
 * `cumulative` on the Claude divergent envelope, `runItemCumulative` on
 * Cursor snapshot frames.
 *
 * On the compat lane (sendAgentCompatLine payloads) this predicate is
 * EXHAUSTIVE: a six-provider audit (see commit 77cca2171) found every path
 * that can re-send already-streamed text is either prefix-sliced before
 * forwarding or carries one of these tags, so an untagged compat delta is a
 * verbatim increment and must be appended without shape detection — a
 * repeated chunk that byte-matches the assembled text ("test ", "test ")
 * would otherwise be swallowed by `foldBridgeRunText` as a stale snapshot.
 * Raw/legacy lanes (non-compat stdout) carry no tags and keep the fold.
 */
export function isTaggedCumulativeRestatement(payload: {
  cumulative?: unknown
  runItemCumulative?: unknown
  snapshot?: unknown
}): boolean {
  return (
    payload.cumulative === true || payload.runItemCumulative === true || payload.snapshot === true
  )
}

export function foldBridgeRunText(rendered: string, incoming: string): BridgeTextFold {
  if (!incoming) return { kind: 'append' } // caller no-ops on empty text anyway
  // Nothing assembled yet → first chunk; plain append.
  if (!rendered) return { kind: 'append' }
  // Equal or growing superset of everything assembled → a cumulative snapshot.
  // Only the tail beyond the assembled text is new; the rest already lives in
  // earlier (sealed) text/tool parts and must not be re-appended.
  if (incoming.length >= rendered.length && incoming.startsWith(rendered)) {
    const tail = incoming.slice(rendered.length)
    return tail.length === 0 ? { kind: 'skip' } : { kind: 'tail', tail }
  }
  // A shorter prefix of what we already show → a stale/older snapshot; drop it.
  if (incoming.length < rendered.length && rendered.startsWith(incoming)) {
    return { kind: 'skip' }
  }
  // Otherwise a genuine increment (the new suffix).
  return { kind: 'append' }
}
