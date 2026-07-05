import type { ProviderId } from '../../../main/store/types'

export type ForkCapabilityKind = 'native' | 'emulated' | 'unsupported'

export interface ForkCapabilitySummary {
  provider: ProviderId
  kind: ForkCapabilityKind
  /** Short label for menus and Inspector buttons. */
  label: string
  detail: string
  requiresLinkedSession: boolean
}

export interface UniversalForkResult {
  ok: boolean
  kind?: ForkCapabilityKind
  forkedSessionId?: string
  chatId?: string
  error?: string
}

const IPC_GET_CAPABILITY = 'fork:get-capability'

/** Static fallback until WriteMain exposes fork:get-capability IPC. */
export function buildStaticForkCapability(provider: ProviderId): ForkCapabilitySummary {
  if (provider === 'codex') {
    return {
      provider,
      kind: 'native',
      label: 'Native fork',
      detail: 'Creates a provider-native Codex thread fork via thread/fork and links this chat.',
      requiresLinkedSession: true
    }
  }
  if (
    provider === 'claude' ||
    provider === 'kimi' ||
    provider === 'grok' ||
    provider === 'cursor' ||
    provider === 'ollama'
  ) {
    return {
      provider,
      kind: 'emulated',
      label: 'Emulated fork',
      detail:
        'No native fork on this provider. TaskWraith duplicates the chat transcript and session metadata into an isolated sibling chat.',
      requiresLinkedSession: false
    }
  }
  return {
    provider,
    kind: 'unsupported',
    label: 'Fork unavailable',
    detail:
      provider === 'gemini'
        ? 'Gemini is retired in TaskWraith. Historical chats may still decode, but new forks are not offered.'
        : 'Fork is not supported for this provider in TaskWraith.',
    requiresLinkedSession: false
  }
}

export async function fetchForkCapability(provider: ProviderId): Promise<ForkCapabilitySummary> {
  const api = (typeof window !== 'undefined' ? window.api : undefined) as
    | Record<string, (...params: unknown[]) => Promise<unknown>>
    | undefined
  if (api && typeof api[IPC_GET_CAPABILITY] === 'function') {
    const remote = (await api[IPC_GET_CAPABILITY](provider)) as ForkCapabilitySummary | null
    if (remote && remote.provider === provider && remote.kind) return remote
  }
  return buildStaticForkCapability(provider)
}

export function forkActionLabel(capability: ForkCapabilitySummary): string {
  if (capability.kind === 'native') return 'Fork (native)'
  if (capability.kind === 'emulated') return 'Fork (emulated)'
  return 'Fork unavailable'
}

export function forkSlashDescription(capability: ForkCapabilitySummary): string {
  if (capability.kind === 'native') {
    return 'Fork the linked provider thread (native) and bind this chat to the fork.'
  }
  if (capability.kind === 'emulated') {
    return 'Fork this chat into an isolated sibling with duplicated transcript (emulated — no native provider fork).'
  }
  return capability.detail
}

export interface UniversalForkRequest {
  provider: ProviderId
  threadId?: string
  chatId?: string
  cwd?: string
  model?: string
}

export async function forkAgentThreadUniversal(
  request: UniversalForkRequest
): Promise<UniversalForkResult> {
  const capability = await fetchForkCapability(request.provider)
  if (capability.kind === 'unsupported') {
    return { ok: false, kind: capability.kind, error: capability.detail }
  }
  if (typeof window === 'undefined' || typeof window.api?.forkAgentThread !== 'function') {
    return { ok: false, kind: capability.kind, error: 'Fork API unavailable.' }
  }
  try {
    const response = await window.api.forkAgentThread(request.provider, request.threadId ?? '', {
      cwd: request.cwd,
      model: request.model,
      chatId: request.chatId,
      excludeTurns: capability.kind === 'native' ? true : undefined,
      emulated: capability.kind === 'emulated' ? true : undefined
    })
    const forkedSessionId =
      response?.thread?.id ||
      response?.forkedSessionId ||
      response?.linkedProviderSessionId ||
      response?.sessionId
    const forkedChatId = response?.chatId || response?.forkedChatId
    if (!forkedSessionId && !forkedChatId && capability.kind === 'native') {
      return { ok: false, kind: capability.kind, error: 'Fork succeeded but no session id was returned.' }
    }
    return {
      ok: true,
      kind: response?.kind || capability.kind,
      forkedSessionId: forkedSessionId || undefined,
      chatId: forkedChatId || undefined
    }
  } catch (error) {
    return { ok: false, kind: capability.kind, error: String(error) }
  }
}