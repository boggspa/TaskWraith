import type { ChatMessage } from '../../../main/store/types'
import { resolveAssistantDeltaMerge } from './assistantDeltaMerge'
import { resolveAssistantDeltaTarget } from './assistantDeltaTarget'

/*
 * applyAssistantDelta — pure folding of one streamed assistant content
 * delta into the live message list.
 *
 * This is the verbatim accumulation core extracted out of the App.tsx
 * `assistant_message_delta` handler (the `updateChatById(runChatId, …)`
 * closure). It was inline in a 22k-line component and therefore
 * untestable; the byte-exact concatenation that the streaming transcript
 * depends on lived on a single unguarded line. Pulling it here:
 *
 *   1. makes the accumulation unit-testable in isolation (no React, no
 *      DOM) — the project's established pattern (see assistantDeltaMerge
 *      / assistantDeltaTarget, the two pure deciders this composes), and
 *   2. gives the planned rAF render-coalescer a single, tested function
 *      to accumulate through, so the "defer the commit, keep the ref
 *      byte-exact" change cannot silently drift the merge rules.
 *
 * Routing (`resolveAssistantDeltaTarget`) and increment-vs-restatement
 * (`resolveAssistantDeltaMerge`) decisions are unchanged — this only
 * performs the array mutation those deciders prescribe. The two
 * non-deterministic inputs the original used (`createMessageId()` and
 * `new Date().toISOString()`) are injected via `deps` so callers in
 * tests can make them deterministic.
 *
 * Pure + side-effect free: returns a NEW messages array (or the same
 * reference unchanged on a skip), never mutates the input.
 */

const ITEM_TRANSITION_SEPARATOR = '\n\n---\n\n'

export interface AssistantDeltaInput {
  /** Incoming delta / snapshot text (the provider's `content`). */
  incoming: string
  /** App run id for the live turn, used by the renderer to keep reveal active. */
  runId?: string
  /** True when main tagged this as a full-turn cumulative restatement. */
  cumulative?: boolean
  /** Codex `itemId`, when present — drives the inter-item `---` separator. */
  itemId?: string
  /** Pre-resolved provider model metadata (Ollama), stamped onto the bubble. */
  providerModelMetadata?: { providerModel?: string; providerModelLabel?: string }
}

export interface AssistantDeltaDeps {
  /** New unique message id for freshly-opened bubbles. */
  createMessageId: () => string
  /** Timestamp (ISO string) for freshly-opened bubbles. */
  now: () => string
}

export function applyAssistantDelta(
  messages: ChatMessage[],
  input: AssistantDeltaInput,
  deps: AssistantDeltaDeps
): ChatMessage[] {
  const incomingItemIdStr =
    typeof input.itemId === 'string' && input.itemId ? input.itemId : undefined
  const incomingRunIdStr = typeof input.runId === 'string' && input.runId ? input.runId : undefined
  const providerModelMetadata = input.providerModelMetadata

  const mergeAssistantMetadata = (
    base: ChatMessage['metadata'] | undefined
  ): ChatMessage['metadata'] | undefined => {
    const next = {
      ...(base ?? {}),
      ...(incomingItemIdStr ? { codexItemId: incomingItemIdStr } : {}),
      ...(providerModelMetadata ?? {})
    }
    return Object.keys(next).length > 0 ? next : undefined
  }

  const deltaTarget = resolveAssistantDeltaTarget(messages, {
    incoming: input.incoming,
    cumulative: input.cumulative === true
  })

  if (deltaTarget.action === 'skip') {
    // Restatement already covered by the rendered turn — no-op.
    return messages
  }

  if (deltaTarget.action === 'appendText') {
    const metadata = mergeAssistantMetadata(undefined)
    const appended: ChatMessage = {
      id: deps.createMessageId(),
      role: 'assistant',
      content: deltaTarget.text,
      timestamp: deps.now(),
      ...(incomingRunIdStr ? { runId: incomingRunIdStr } : {}),
      ...(metadata ? { metadata } : {})
    }
    return [...messages, appended]
  }

  if (deltaTarget.action === 'replaceText') {
    const idx = deltaTarget.index
    const target = messages[idx]
    if (!target) return messages
    const nextMetadata = mergeAssistantMetadata(target.metadata)
    const replaced: ChatMessage = {
      ...target,
      content: deltaTarget.text,
      ...(incomingRunIdStr ? { runId: target.runId ?? incomingRunIdStr } : {}),
      ...(nextMetadata ? { metadata: nextMetadata } : {})
    }
    return [...messages.slice(0, idx), replaced, ...messages.slice(idx + 1)]
  }

  if (deltaTarget.action === 'merge') {
    // 1.0.6 dup-fix — idempotent merge into the trailing assistant bubble.
    // Claude (a cumulative envelope tagged by main) and Cursor (full
    // snapshot frames) can deliver the WHOLE bubble again; a blind append
    // would double it, so decide append vs replace vs skip. Genuine
    // increments + new Codex items append.
    const idx = deltaTarget.index
    const target = messages[idx]
    const merge = resolveAssistantDeltaMerge(target.content, input.incoming, {
      cumulative: input.cumulative === true
    })
    if (merge.action === 'skip') {
      // Stale/duplicate re-statement we already render — untouched.
      return messages
    }
    if (merge.action === 'replace') {
      const nextMetadata = mergeAssistantMetadata(target.metadata)
      const replaced: ChatMessage = {
        ...target,
        content: merge.content,
        ...(incomingRunIdStr ? { runId: target.runId ?? incomingRunIdStr } : {}),
        ...(nextMetadata ? { metadata: nextMetadata } : {})
      }
      return [...messages.slice(0, idx), replaced, ...messages.slice(idx + 1)]
    }
    // merge.action === 'append' — byte-exact concatenation onto the bubble.
    // A Codex item transition (different itemId than the bubble we stream
    // into) gets a horizontal-rule separator so the body + summary don't
    // visually merge into one paragraph.
    const lastItemId =
      typeof target.metadata?.codexItemId === 'string' ? target.metadata.codexItemId : undefined
    const itemTransition =
      incomingItemIdStr !== undefined &&
      lastItemId !== undefined &&
      incomingItemIdStr !== lastItemId &&
      target.content.length > 0
    const separator = itemTransition ? ITEM_TRANSITION_SEPARATOR : ''
    const nextMetadata = mergeAssistantMetadata(target.metadata)
    const appended: ChatMessage = {
      ...target,
      content: target.content + separator + input.incoming,
      ...(incomingRunIdStr ? { runId: target.runId ?? incomingRunIdStr } : {}),
      ...(nextMetadata ? { metadata: nextMetadata } : {})
    }
    return [...messages.slice(0, idx), appended, ...messages.slice(idx + 1)]
  }

  // deltaTarget.action === 'append' — open a fresh bubble with the incoming.
  const metadata = mergeAssistantMetadata(undefined)
  const appended: ChatMessage = {
    id: deps.createMessageId(),
    role: 'assistant',
    content: input.incoming,
    timestamp: deps.now(),
    ...(incomingRunIdStr ? { runId: incomingRunIdStr } : {}),
    ...(metadata ? { metadata } : {})
  }
  return [...messages, appended]
}
