import type { ChatRecord } from '../../../main/store/types'
import { ChatByteLru, DEFAULT_MAX_HYDRATED_CHAT_BYTES } from './chatByteLru'
import { ChatTranscriptStore } from './chatTranscriptStore'

/**
 * T7 App wiring — renderer-heap hydration budget + store handles.
 *
 * Demotion is always `summaryOnly` (never durable delete). Re-focus of a
 * demoted chat rehydrates via `window.api.getChat` (App's existing
 * `hydrateSelectedChatAfterPaint` path) and `commitHydratedChat`.
 */

/** Default hydrated-message budget for App reconcile (Boss: 512 MiB). */
export const APP_MAX_HYDRATED_MESSAGE_BYTES = 512 * 1024 * 1024

/** Comparison-run override: `TASKWRAITH_MAX_HYDRATED_CHAT_BYTES=<int>`. */
export const MAX_HYDRATED_BYTES_ENV_KEY = 'TASKWRAITH_MAX_HYDRATED_CHAT_BYTES'

export interface ChatHydrationRuntime {
  maxBytes: number
  byteLru: ChatByteLru
  transcriptStore: ChatTranscriptStore
  requestPool: ChatHydrationRequestPool<ChatRecord | null>
}

/**
 * One keyed hydration authority for every surface in a renderer.
 *
 * It shares only the exact read+commit promise for one chat id. Focus,
 * composer state, pin reasons, and different chat ids remain independent.
 */
export class ChatHydrationRequestPool<T> {
  private readonly inFlight = new Map<string, Promise<T>>()

  run(chatId: string, hydrate: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(chatId)
    if (existing) return existing

    const request = Promise.resolve()
      .then(hydrate)
      .finally(() => {
        if (this.inFlight.get(chatId) === request) this.inFlight.delete(chatId)
      })
    this.inFlight.set(chatId, request)
    return request
  }

  pendingChatIds(): string[] {
    return Array.from(this.inFlight.keys())
  }
}

function readEnvMap(
  env?: Record<string, string | undefined> | null
): Record<string, string | undefined> {
  if (env) return env
  if (typeof process !== 'undefined' && process.env) {
    return process.env as Record<string, string | undefined>
  }
  return {}
}

/**
 * Resolve the App hydrate budget. Invalid / missing env → default 512 MiB.
 * `0` is accepted (aggressive demote-all-unpinned) for soak probes.
 */
export function resolveMaxHydratedMessageBytes(
  env?: Record<string, string | undefined> | null,
  fallback: number = APP_MAX_HYDRATED_MESSAGE_BYTES
): number {
  const raw = readEnvMap(env)[MAX_HYDRATED_BYTES_ENV_KEY]
  if (raw == null || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.floor(parsed)
}

export function createChatHydrationRuntime(options?: {
  maxBytes?: number
  env?: Record<string, string | undefined> | null
}): ChatHydrationRuntime {
  const maxBytes =
    typeof options?.maxBytes === 'number' && Number.isFinite(options.maxBytes)
      ? Math.max(0, Math.floor(options.maxBytes))
      : resolveMaxHydratedMessageBytes(options?.env)
  return {
    maxBytes,
    byteLru: new ChatByteLru({ maxBytes }),
    transcriptStore: new ChatTranscriptStore(),
    requestPool: new ChatHydrationRequestPool<ChatRecord | null>()
  }
}

/** Fields to spread into `reconcileChatRefMap` (budget active by default). */
export function reconcileHydrationOptions(runtime: ChatHydrationRuntime): {
  maxHydratedMessageBytes: number
  pinnedChatIds: ReadonlySet<string>
  hydrationRetention: Pick<ChatByteLru, 'retain'>
} {
  return {
    maxHydratedMessageBytes: runtime.maxBytes,
    pinnedChatIds: runtime.byteLru.pinnedIds(),
    hydrationRetention: runtime.byteLru
  }
}

/** Re-export so App can keep a single hydration import surface if desired. */
export { DEFAULT_MAX_HYDRATED_CHAT_BYTES }
