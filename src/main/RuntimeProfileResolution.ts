import type { ChatRecord, ChatScope, ProviderId, RuntimeProfile } from './store/types'

/**
 * Concrete built-in runtime identity used when a dispatch has no persisted
 * profile selection. Keeping the implicit default concrete matters for shared
 * provider processes: `undefined` and the built-in profile launch differently
 * and therefore must not describe the same seat in two different ways.
 */
export function defaultRuntimeProfileId(provider: ProviderId, scope: ChatScope): string {
  return `builtin:${provider}:${scope === 'global' ? 'global' : 'local'}`
}

export function resolveRuntimeProfileIdForScope(input: {
  provider: ProviderId
  scope: ChatScope
  runtimeProfileId?: string | null
}): string {
  const requested = input.runtimeProfileId?.trim()
  return requested || defaultRuntimeProfileId(input.provider, input.scope)
}

/**
 * Runtime-profile resolution (Phase B3.4 extraction).
 *
 * Pure function that picks which `RuntimeProfile` applies to a given chat +
 * provider, given:
 *
 *   1. Per-chat user selection (held in the renderer as
 *      `selectedRuntimeProfileByChatId`, would be a remote-side state in the
 *      iOS bridge).
 *   2. Persisted choice on `chat.providerMetadata.runtimeProfileId`.
 *   3. The default — first profile matching the provider and chat scope.
 *
 * Extracted from `App.tsx:getRuntimeProfileIdForChat` so the future iOS
 * bridge can answer "what runtime profile should this request use?" without
 * forking the resolution rules.
 */
export function resolveRuntimeProfileIdForChat(input: {
  chat?: ChatRecord | null
  provider: ProviderId
  /** Renderer-side per-chat override (chat appChatId → profile id). May be
   * an empty map for callers that don't carry session-scoped overrides. */
  selectionByChatId?: Record<string, string>
  /** All available profiles. The default (provider + chat-scope match) is picked from this list. */
  profiles: RuntimeProfile[]
}): string | undefined {
  const { chat, provider, selectionByChatId, profiles } = input
  const chatId = chat?.appChatId
  const sessionOverride = chatId && selectionByChatId ? selectionByChatId[chatId] : undefined
  const metadataRuntimeProfileId =
    typeof chat?.providerMetadata?.runtimeProfileId === 'string'
      ? chat.providerMetadata.runtimeProfileId
      : undefined
  const chatScope: ChatScope = chat?.scope === 'global' ? 'global' : 'workspace'
  const candidates = profiles.filter(
    (profile) => profile.provider === provider && profile.scope === chatScope
  )
  const candidateIds = new Set(candidates.map((profile) => profile.id))
  const matchingCandidateId = (profileId?: string): string | undefined =>
    profileId && candidateIds.has(profileId) ? profileId : undefined
  const providerDefault = candidates[0]?.id

  return (
    matchingCandidateId(sessionOverride) ||
    matchingCandidateId(metadataRuntimeProfileId) ||
    providerDefault
  )
}
