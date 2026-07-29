import type { ChatMessage } from '../../../main/store/types'

/*
 * assistantDeltaTarget — interleaving-preserving routing for streamed
 * assistant text.
 *
 * A provider run interleaves assistant prose with tool bursts in stream
 * order (text → tool burst → more text → another burst). The transcript
 * must render those at their true positions: each contiguous text stretch
 * is its own bubble and each tool burst its own ActivityStack row, in
 * order. This mirrors the iOS streaming path (commit af91f0be, which
 * "seals a text segment at every tool_use/tool_call boundary") and the
 * MAIN bridge transcript assembly (`appendBridgeRunText`).
 *
 * The hard case is the CUMULATIVE-RESTATEMENT providers, which re-send the
 * WHOLE turn (not an increment):
 *   - Cursor (cursor-agent stream-json, no --stream-partial-output): tagged
 *     snapshots may cover the whole current segment, and newer model paths
 *     can restart that segment after each tool burst.
 *   - Claude (Agent SDK): incremental deltas PLUS a trailing cumulative
 *     envelope that re-states the turn (tagged `cumulative` when it diverges
 *     from the streamed deltas).
 *
 * An earlier fix merged such a restatement into a SINGLE bubble across a
 * tool boundary — which either clumped the whole turn into the pre-tool
 * bubble (Cursor: tool ends up below all text) or duplicated the pre-burst
 * text into the trailing bubble (Claude divergent envelope). The correct
 * rule, mirroring the bridge: a restatement that spans a tool boundary is
 * reconciled by DISTRIBUTING ONLY ITS POST-LAST-TOOL TAIL — the pre-tool
 * text already lives in earlier bubbles and is never rewritten. If the
 * restatement diverges from that already-rendered pre-tool text (so the tail
 * can't be cleanly extracted), it is SKIPPED, exactly as the bridge skips
 * post-stream restatements (the streamed deltas already produced the
 * correct interleaving).
 *
 * Pure: the decision is a function of the message list, unit-tested in
 * isolation from the 20k-line App.tsx handler that calls it.
 */

export type AssistantDeltaTarget =
  /** Fold the incoming text into the existing assistant message at `index`
   *  (caller still runs the merge helper to decide append/replace/skip). */
  | { action: 'merge'; index: number }
  /** Start a NEW assistant message appended after the current tail (with the
   *  caller's incoming text). */
  | { action: 'append' }
  /** Do nothing — a restatement already covered by the rendered turn. */
  | { action: 'skip' }
  /** Open a NEW assistant bubble holding exactly `text` (a restatement's
   *  post-tool tail), after a trailing tool burst. */
  | { action: 'appendText'; text: string }
  /** Replace the assistant bubble at `index` with exactly `text` (the
   *  post-tool tail) — never the whole turn. */
  | { action: 'replaceText'; index: number; text: string }

interface ResolveAssistantDeltaTargetInput {
  /** The incoming delta/snapshot text. */
  incoming: string
  /** True when main tagged this as a full-turn cumulative restatement. */
  cumulative?: boolean
  /** True on the run-item sidecar lane, whose producer reliably tags every
   *  restatement — an untagged delta is then a verbatim increment and must
   *  never be shape-detected as a restatement (see assistantDeltaMerge). */
  trustedIncremental?: boolean
  /** Cursor's tagged assistant frames may be authoritative snapshots of the
   *  current text SEGMENT rather than the whole turn. Preserve a divergent
   *  post-tool frame instead of applying Claude's safe-to-skip rule. */
  preserveDivergentSnapshot?: boolean
  /** Complete-restatement path only: when a SYSTEM card is the trailing
   *  message, reach the dedupe window back ACROSS it (stop at user/error).
   *  A card landing at the tail between the last streamed delta and the
   *  complete event otherwise empties the turn window, so none of the
   *  skip/merge dedupe fires and the FULL turn re-appends below the card —
   *  the whole answer rendered twice. Streamed DELTAS keep the system
   *  boundary (text after a card correctly opens a new bubble). */
  spanTrailingSystemCards?: boolean
  /**
   * Complete-restatement path only: a user interjection appended while the
   * current run is still streaming is a chronological transcript boundary,
   * but not a provider-turn boundary. Reconcile the provider's final
   * cumulative envelope across that row without copying the pre-interjection
   * prose below it. Streamed deltas leave this false so new output still opens
   * after the user row.
   */
  spanMidRunSteeringMessages?: boolean
}

/** The current turn's trailing maximal run of assistant|tool messages (stops
 * at a user/error/system boundary or the start of the list). */
function trailingTurn(messages: ChatMessage[]): { start: number } {
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role
    if (role === 'assistant' || role === 'tool') start = i
    else break
  }
  return { start }
}

/** The trailing run of system-role messages (0 when the tail isn't system). */
function trailingSystemCount(messages: ChatMessage[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'system') count += 1
    else break
  }
  return count
}

function isMidRunSteeringMessage(message: ChatMessage): boolean {
  return message.role === 'user' && message.metadata?.kind === 'midRunSteering'
}

export function resolveAssistantDeltaTarget(
  messages: ChatMessage[],
  input: ResolveAssistantDeltaTargetInput
): AssistantDeltaTarget {
  // Complete-path dedupe across a trailing system card: resolve routing as if
  // the trailing card(s) were absent, then translate the outcome. Only skip /
  // append-shaped actions can result (the turn's bubbles are not trailing, so
  // merge/replace never targets across the card) — and an append lands AFTER
  // the card, which is exactly the chronological position it should occupy.
  if (input.spanTrailingSystemCards === true) {
    const systemTail = trailingSystemCount(messages)
    if (systemTail > 0) {
      const target = resolveAssistantDeltaTarget(messages.slice(0, messages.length - systemTail), {
        ...input,
        spanTrailingSystemCards: false
      })
      if (target.action === 'skip') return target
      if (target.action === 'appendText') return target
      if (target.action === 'append') return target
      if (target.action === 'merge' || target.action === 'replaceText') {
        // The restatement folds into a bubble ABOVE the system card. Its
        // content is already rendered there (the merge helper would settle
        // increments) — but rather than rewrite history behind a card, treat
        // covered content as rendered and place only a genuinely new tail.
        // resolveAssistantDeltaMerge-style dedupe: exact/prefix coverage is
        // a skip; anything else appends after the card (never duplicating
        // the full turn).
        const bubble = messages[target.index]
        if (bubble && typeof bubble.content === 'string') {
          if (bubble.content === input.incoming) return { action: 'skip' }
          if (bubble.content.startsWith(input.incoming)) return { action: 'skip' }
          if (input.incoming.startsWith(bubble.content)) {
            const tail = input.incoming.slice(bubble.content.length)
            if (tail.trim().length === 0) return { action: 'skip' }
            return { action: 'appendText', text: tail }
          }
        }
        // Divergent restatement (e.g. whitespace-normalized envelope) — the
        // streamed deltas already rendered the turn; skip, as the bridge does.
        return { action: 'skip' }
      }
      return target
    }
  }

  if (input.spanMidRunSteeringMessages === true) {
    let spanStart = messages.length
    let lastSteeringIndex = -1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (
        message.role !== 'assistant' &&
        message.role !== 'tool' &&
        !isMidRunSteeringMessage(message)
      ) {
        break
      }
      spanStart = index
      if (lastSteeringIndex < 0 && isMidRunSteeringMessage(message)) {
        lastSteeringIndex = index
      }
    }

    if (lastSteeringIndex >= spanStart) {
      const prefix = messages
        .slice(spanStart, lastSteeringIndex)
        .filter((message) => message.role === 'assistant')
        .map((message) => message.content)
        .join('')
      if (prefix && !input.incoming.startsWith(prefix)) {
        // A normalized/divergent final envelope cannot be split safely. The
        // incremental bubbles are already authoritative, so lossless skip is
        // preferable to duplicating the whole answer below the interjection.
        return { action: 'skip' }
      }

      const tail = prefix ? input.incoming.slice(prefix.length) : input.incoming
      if (!tail) return { action: 'skip' }
      const postSteeringMessages = messages.slice(lastSteeringIndex + 1)
      const postTarget = resolveAssistantDeltaTarget(postSteeringMessages, {
        ...input,
        incoming: tail,
        spanMidRunSteeringMessages: false,
        spanTrailingSystemCards: false
      })
      const offset = lastSteeringIndex + 1
      if (postTarget.action === 'skip') return postTarget
      if (postTarget.action === 'append') {
        return { action: 'appendText', text: tail }
      }
      if (postTarget.action === 'appendText') return postTarget
      if (postTarget.action === 'replaceText') {
        return {
          ...postTarget,
          index: postTarget.index + offset
        }
      }

      const target = postSteeringMessages[postTarget.index]
      if (!target || target.role !== 'assistant') return { action: 'skip' }
      if (target.content === tail || target.content.startsWith(tail)) {
        return { action: 'skip' }
      }
      return tail.startsWith(target.content)
        ? { action: 'replaceText', index: postTarget.index + offset, text: tail }
        : { action: 'skip' }
    }
  }

  const lastIndex = messages.length - 1
  const last = lastIndex >= 0 ? messages[lastIndex] : null

  const { start } = trailingTurn(messages)
  const turn = messages.slice(start)
  let lastToolTurnIdx = -1
  for (let i = turn.length - 1; i >= 0; i--) {
    if (turn[i].role === 'tool') {
      lastToolTurnIdx = i
      break
    }
  }

  // No tool boundary in this turn → simple routing: a trailing assistant
  // continues (the merge helper handles increment vs same-bubble restatement);
  // otherwise open a fresh bubble.
  if (lastToolTurnIdx < 0) {
    if (last && last.role === 'assistant') return { action: 'merge', index: lastIndex }
    return { action: 'append' }
  }

  // Assistant text already rendered BEFORE the last tool burst of this turn.
  const preBurst = turn
    .slice(0, lastToolTurnIdx)
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
    .join('')
  const trailingAssistant = Boolean(last && last.role === 'assistant')

  // A restatement re-sends the whole turn: tagged `cumulative`, OR an untagged
  // snapshot that supersets the pre-tool text. A genuine delta is a short
  // suffix and never restarts from the full pre-tool prose, so it won't match —
  // except on the trusted-incremental lane, where an untagged delta is a
  // verbatim increment BY CONTRACT (restatements are always tagged upstream),
  // so the shape heuristic must not misread a post-burst chunk that happens to
  // start with the pre-burst text.
  const supersetsPreBurst =
    input.trustedIncremental !== true &&
    preBurst.length > 0 &&
    input.incoming.length >= preBurst.length &&
    input.incoming.startsWith(preBurst)
  const isRestatement = input.cumulative === true || supersetsPreBurst

  if (!isRestatement) {
    // Genuine increment, sealed at the tool boundary.
    if (trailingAssistant) return { action: 'merge', index: lastIndex } // continue post-burst segment
    return { action: 'append' } // open post-burst segment
  }

  // Cumulative restatement spanning a tool boundary. Distribute only the
  // post-last-tool tail; the pre-tool bubbles are authoritative and untouched.
  if (preBurst.length === 0) {
    // Nothing rendered before the tool in this turn → the whole restatement is
    // a fresh post-tool segment.
    if (trailingAssistant) return { action: 'merge', index: lastIndex }
    return { action: 'append' }
  }
  if (!input.incoming.startsWith(preBurst)) {
    if (input.preserveDivergentSnapshot === true) {
      // Cursor sealed the pre-tool segment and started a new snapshot after
      // the tool. Preserve chronology by treating the divergent frame as the
      // complete post-tool segment; loss is worse than a rare duplicate if a
      // future Cursor build changes its snapshot scope.
      if (trailingAssistant) {
        if (last && last.content === input.incoming) return { action: 'skip' }
        // Never let a delayed shorter snapshot erase text from the newer one.
        // This mirrors resolveAssistantDeltaMerge's stale-prefix guard, which
        // replaceText intentionally bypasses.
        if (last && last.content.startsWith(input.incoming)) return { action: 'skip' }
        return { action: 'replaceText', index: lastIndex, text: input.incoming }
      }
      return { action: 'appendText', text: input.incoming }
    }
    // Diverges in the already-rendered pre-tool region (e.g. Claude's
    // whitespace-normalized envelope) — the tail can't be cleanly extracted.
    // The streamed deltas already produced the correct interleaving; skip,
    // exactly as the bridge does (src/main/index.ts post-stream restatement).
    return { action: 'skip' }
  }
  // Prefix-matching Cursor snapshots retain the established whole-turn
  // behavior: strip the pre-tool portion and place only the tail. The
  // segment-specific path above is reserved for the divergent shape observed
  // on Cursor's Grok 4.5 route, where no clean whole-turn tail exists.
  const tail = input.incoming.slice(preBurst.length)
  if (tail.trim().length === 0) {
    // Restatement only re-covers the pre-burst text; nothing new to place.
    return { action: 'skip' }
  }
  if (trailingAssistant) {
    // The post-burst bubble holds exactly the tail (NOT the whole turn —
    // that is the duplication bug). Idempotent when it already matches.
    if (last && last.content === tail) return { action: 'skip' }
    return { action: 'replaceText', index: lastIndex, text: tail }
  }
  // Trailing is the tool burst → open a new post-burst bubble with the tail.
  return { action: 'appendText', text: tail }
}
