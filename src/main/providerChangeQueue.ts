/**
 * Slice B — solo/side-chat provider unlock (Q2: idle → immediate switch,
 * running → queue-at-turn-end). Storage model = Option 1 (King-ratified):
 * the queued change lives on `chat.providerMetadata.pendingProviderChange`,
 * NOT in a new EnsembleOrchestrator queue (that file is concurrent-dirty and
 * excluded; solo gets a small parallel path instead).
 *
 * This module is the shared, node-free contract that BOTH finalize paths and
 * the idle path consume so the switch semantics are byte-identical everywhere:
 *
 *   - IDLE (no active run + no queued run job): the renderer calls
 *     `applyProviderChange(chat, change)` directly and persists (its lane owns
 *     `getDefaultModelForProvider`, so it bakes the target metadata into
 *     `change.providerMetadata`).
 *   - RUNNING: the caller `queueProviderChange(chat, change)` — this writes the
 *     pending record ONLY (provider + sessions untouched, so the in-flight run
 *     keeps its old provider). The switch is then applied at turn end via
 *     `applyPendingProviderChangeOnFinalize(chat)`.
 *   - APPLY-AT-TURN-END has TWO finalize sites, both calling
 *     `applyPendingProviderChangeOnFinalize`:
 *       • desktop-origin runs finalize in the renderer (App.tsx run-completion
 *         where `linkedProviderSessionId` is written) — @RenderWork wires it;
 *       • bridge/iOS-origin runs finalize in main (`finalizeBridgeRunTranscript`)
 *         — @MainWork wires it.
 *     (index.ts:6190 / :6390 are the sub-thread / background flush paths, NOT
 *     the parent solo chat's run finalize — do not hook the switch there.)
 *
 * Hygiene on apply mirrors the ensemble seat-change / composer reroute path:
 * clear `linkedProviderSessionId` + `linkedGeminiSessionId` (a switched provider
 * must NOT resume the old provider's session) and swap in the new provider's
 * metadata. `runtimeProfileId` is per-run (not a ChatRecord field) and is reset
 * at the next dispatch by ComposerService.applyComposerReroutePlan when the
 * provider changed — so it is intentionally not touched here.
 *
 * Pure + deterministic: never mutates its input, never sets `updatedAt`, never
 * touches `messages` / `runs` / `ensemble` (historical transcript is preserved
 * verbatim on a provider switch — Q3-style never-hide-history discipline).
 * Callers own persistence + `updatedAt`.
 */

import type { ChatRecord, ProviderId } from './store/types'
import { isLiveSelectableProvider } from '../shared/retiredProviders'

/** Metadata key under `chat.providerMetadata` that holds a queued switch. */
export const PENDING_PROVIDER_CHANGE_KEY = 'pendingProviderChange'

/**
 * A provider switch queued while a run is active, applied at turn end.
 * `providerMetadata` is the FULL provider-scoped metadata patch to apply on
 * switch (model / reasoning / service tier / etc.), computed at queue time by
 * the renderer — which owns `getDefaultModelForProvider` and the user's picked
 * model. Main applies it verbatim; it does not re-derive model defaults.
 */
export interface PendingProviderChange {
  provider: ProviderId
  /** Provider-scoped metadata to merge on apply (selectedModelType, customModel,
   *  codexReasoningEffort, claudeReasoningEffort, kimiThinkingEnabled, …). */
  providerMetadata?: Record<string, unknown>
  /** ISO timestamp the switch was queued (display/debug only). */
  queuedAt?: string
}

function isProviderId(value: unknown): value is ProviderId {
  return (
    value === 'gemini' ||
    value === 'codex' ||
    value === 'claude' ||
    value === 'kimi' ||
    value === 'grok' ||
    value === 'cursor' ||
    value === 'ollama'
  )
}

/** Read + validate the queued switch, or null when none/malformed. */
export function readPendingProviderChange(chat: ChatRecord): PendingProviderChange | null {
  const raw = (chat.providerMetadata ?? {})[PENDING_PROVIDER_CHANGE_KEY]
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Record<string, unknown>
  if (!isProviderId(candidate.provider)) return null
  const providerMetadata =
    candidate.providerMetadata && typeof candidate.providerMetadata === 'object'
      ? (candidate.providerMetadata as Record<string, unknown>)
      : undefined
  const queuedAt = typeof candidate.queuedAt === 'string' ? candidate.queuedAt : undefined
  return {
    provider: candidate.provider,
    ...(providerMetadata ? { providerMetadata } : {}),
    ...(queuedAt ? { queuedAt } : {})
  }
}

/** Whether a switch is currently queued for turn-end application. */
export function hasPendingProviderChange(chat: ChatRecord): boolean {
  return readPendingProviderChange(chat) !== null
}

/** Remove queued provider-control state without changing the active provider. */
export function clearPendingProviderChange(chat: ChatRecord): ChatRecord {
  if (!(PENDING_PROVIDER_CHANGE_KEY in (chat.providerMetadata ?? {}))) return chat
  const { [PENDING_PROVIDER_CHANGE_KEY]: _dropPending, ...restMetadata } =
    chat.providerMetadata ?? {}
  return {
    ...chat,
    providerMetadata: restMetadata
  }
}

/**
 * RUNNING path: record the switch WITHOUT touching `provider` or the linked
 * session ids, so the in-flight run finishes under the old provider. Returns a
 * new record; caller persists + sets `updatedAt`.
 */
export function queueProviderChange(chat: ChatRecord, change: PendingProviderChange): ChatRecord {
  const pending: PendingProviderChange = {
    provider: change.provider,
    ...(change.providerMetadata ? { providerMetadata: change.providerMetadata } : {}),
    ...(change.queuedAt ? { queuedAt: change.queuedAt } : {})
  }
  return {
    ...chat,
    providerMetadata: {
      ...(chat.providerMetadata ?? {}),
      [PENDING_PROVIDER_CHANGE_KEY]: pending
    }
  }
}

/**
 * IDLE path (immediate) + the turn-end apply: switch `provider`, merge the
 * target provider metadata, and drop any pending record. Never touches
 * messages/runs/ensemble. Returns a new record; caller persists + sets
 * `updatedAt`.
 *
 * Session hygiene (clear both linked session ids) fires ONLY on a genuine
 * provider switch (`change.provider !== chat.provider`). A same-provider
 * model / reasoning tweak — the mid-turn model/reasoning unlock — MUST keep the
 * live provider session so the conversation continues in the same thread; only
 * a real provider change invalidates the old provider's session. (`runtimeProfileId`
 * is per-run, not a ChatRecord field; it is reset at the next dispatch by
 * ComposerService.applyComposerReroutePlan when the provider changed.)
 */
export function applyProviderChange(chat: ChatRecord, change: PendingProviderChange): ChatRecord {
  const providerChanged = change.provider !== chat.provider
  const { [PENDING_PROVIDER_CHANGE_KEY]: _dropPending, ...restMetadata } = chat.providerMetadata ?? {}
  const nextProviderMetadata = {
    ...restMetadata,
    ...(change.providerMetadata ?? {})
  }
  if (!providerChanged) {
    // Same-provider model/reasoning tweak: keep the live session intact.
    return {
      ...chat,
      provider: change.provider,
      providerMetadata: nextProviderMetadata
    }
  }
  // Genuine provider switch: a switched provider must NOT resume the old
  // provider's session — clear both linked session ids.
  const {
    linkedProviderSessionId: _dropProviderSession,
    linkedGeminiSessionId: _dropGeminiSession,
    taskWraithMcpProfileReceipt: _dropMcpProfileReceipt,
    ...restChat
  } = chat
  return {
    ...restChat,
    provider: change.provider,
    providerMetadata: nextProviderMetadata
  }
}

/**
 * Turn-end apply: if a switch is queued, apply it (with hygiene) and clear the
 * pending record; otherwise return the record unchanged (same reference). Call
 * this at BOTH finalize sites (renderer desktop-finalize + main bridge-finalize)
 * BEFORE the next run for the chat dispatches, so the next turn seeds the new
 * provider's session — never the old one.
 */
export function applyPendingProviderChangeOnFinalize(chat: ChatRecord): ChatRecord {
  const pending = readPendingProviderChange(chat)
  if (!pending) return chat
  // Pending changes are executable control state, not historical attribution.
  // Never promote a provider that is retained only for decode/render.
  if (!isLiveSelectableProvider(pending.provider)) {
    return clearPendingProviderChange(chat)
  }
  return applyProviderChange(chat, pending)
}
