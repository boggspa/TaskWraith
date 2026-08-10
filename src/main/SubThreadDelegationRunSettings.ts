import type { ChatRecord, ProviderId } from './store/types'
import { getStaticProviderModels } from './providers/StaticProviderModels'

export interface DelegatedSubThreadRunPayloadSettings {
  model: string
  reasoningEffort?: string
  claudeReasoningEffort?: string
  kimiThinking?: boolean
}

export type SubThreadDelegationRunSettingsResolution =
  | {
      ok: true
      requestedModel: string
      reasoningEffort?: string
      kimiThinking?: boolean
      runPayload: DelegatedSubThreadRunPayloadSettings
      providerMetadataPatch: Record<string, unknown>
    }
  | { ok: false; message: string }

export interface SubThreadDelegationRunSettingsRequest {
  provider: ProviderId
  model?: unknown
  reasoningEffort?: unknown
  kimiThinking?: unknown
  /** Present only when delegate_to_subthread is resuming an existing seat. */
  recallChat?: ChatRecord | null
}

const CODEX_REASONING_EFFORTS = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultracode'
])
const CLAUDE_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const KIMI_REASONING_EFFORTS = new Set(['low', 'high', 'max'])
const GROK_REASONING_EFFORTS = new Set(['low', 'medium', 'high'])

const CODEX_EFFORT_ALIASES: Readonly<Record<string, string>> = {
  light: 'low',
  ultra: 'ultracode'
}
const CLAUDE_EFFORT_ALIASES: Readonly<Record<string, string>> = {
  extra: 'xhigh',
  ultracode: 'max'
}

function reasoningMetadataKey(provider: ProviderId): string | undefined {
  if (provider === 'codex') return 'codexReasoningEffort'
  if (provider === 'claude') return 'claudeReasoningEffort'
  if (provider === 'kimi') return 'kimiReasoningEffort'
  if (provider === 'grok') return 'grokReasoningEffort'
  if (provider === 'muse') return 'museReasoningEffort'
  if (provider === 'cursor') return 'cursorReasoningEffort'
  return undefined
}

function normalizeReasoningEffort(
  provider: ProviderId,
  value: unknown,
  requestedModel?: string
): { ok: true; value?: string } | { ok: false; message: string } {
  if (value === undefined) return { ok: true }
  if (typeof value !== 'string' || !value.trim()) {
    return {
      ok: false,
      message: 'delegate_to_subthread: reasoningEffort must be a non-empty string when provided.'
    }
  }
  let normalized = value.trim().toLowerCase()
  if (provider === 'codex') normalized = CODEX_EFFORT_ALIASES[normalized] || normalized
  if (provider === 'claude') normalized = CLAUDE_EFFORT_ALIASES[normalized] || normalized

  const allowed =
    provider === 'codex'
      ? CODEX_REASONING_EFFORTS
      : provider === 'claude'
        ? CLAUDE_REASONING_EFFORTS
        : provider === 'kimi'
          ? KIMI_REASONING_EFFORTS
        : provider === 'grok' || provider === 'cursor'
          ? GROK_REASONING_EFFORTS
          : null
  if (!allowed) {
    return {
      ok: false,
      message: `delegate_to_subthread: reasoningEffort is not supported for ${provider}.`
    }
  }
  if (!allowed.has(normalized)) {
    return {
      ok: false,
      message:
        `delegate_to_subthread: reasoningEffort="${normalized}" is not valid for ${provider}. ` +
        `Supported values: ${[...allowed].join(', ')}.`
    }
  }
  if (requestedModel) {
    const catalog = getStaticProviderModels(provider, { includePreviewModels: true }) as Array<{
      id: string
      isDefault?: boolean
      supportedReasoningEfforts?: Array<{ reasoningEffort: string; disabled?: boolean }>
    }>
    const requestedKey = requestedModel.trim().toLowerCase()
    const knownModel =
      requestedKey === 'cli-default'
        ? catalog.find((model) => model.isDefault)
        : catalog.find((model) => model.id.toLowerCase() === requestedKey)
    if (knownModel && knownModel.id !== 'custom') {
      const modelEfforts = new Set(
        (knownModel.supportedReasoningEfforts || [])
          .filter((option) => !option.disabled)
          .map((option) => option.reasoningEffort.toLowerCase())
      )
      if (!modelEfforts.has(normalized)) {
        const modelLabel =
          requestedKey === 'cli-default'
            ? `default (${knownModel.id})`
            : `"${knownModel.id}"`
        return {
          ok: false,
          message:
            `delegate_to_subthread: ${provider} model ${modelLabel} does not expose ` +
            `reasoningEffort="${normalized}".`
        }
      }
    }
  }
  return { ok: true, value: normalized }
}

function latestRunForProvider(chat: ChatRecord, provider: ProviderId) {
  return [...(chat.runs || [])]
    .reverse()
    .find((run) => !run.provider || run.provider === provider)
}

function inheritedReasoningEffort(
  chat: ChatRecord,
  provider: ProviderId,
  requestedModel: string
): string | undefined {
  const key = reasoningMetadataKey(provider)
  if (!key) return undefined
  const latestRun = latestRunForProvider(chat, provider)
  const value = latestRun?.providerMetadata?.[key] ?? chat.providerMetadata?.[key]
  const normalized = normalizeReasoningEffort(provider, value, requestedModel)
  return normalized.ok ? normalized.value : undefined
}

function buildResolvedSettings(args: {
  provider: ProviderId
  requestedModel: string
  reasoningEffort?: string
  kimiThinking?: boolean
}): SubThreadDelegationRunSettingsResolution {
  const providerMetadataPatch: Record<string, unknown> = {
    selectedModelType: args.requestedModel
  }
  const runPayload: DelegatedSubThreadRunPayloadSettings = { model: args.requestedModel }
  const reasoningKey = reasoningMetadataKey(args.provider)
  if (args.reasoningEffort && reasoningKey) {
    providerMetadataPatch[reasoningKey] = args.reasoningEffort
    if (args.provider === 'claude') {
      runPayload.claudeReasoningEffort = args.reasoningEffort
    } else {
      runPayload.reasoningEffort = args.reasoningEffort
    }
  }
  if (args.provider === 'kimi') {
    providerMetadataPatch.kimiThinkingEnabled = true
    runPayload.kimiThinking = true
  }
  return {
    ok: true,
    requestedModel: args.requestedModel,
    ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
    ...(typeof args.kimiThinking === 'boolean' ? { kimiThinking: args.kimiThinking } : {}),
    runPayload,
    providerMetadataPatch
  }
}

/**
 * Resolve spawn-time provider controls and make recall settings immutable.
 * A recalled sub-thread resumes a native provider session, so changing model
 * controls there would quietly turn one logical seat into a different one and
 * invalidate the cache/session-continuity premise of recall.
 */
export function resolveSubThreadDelegationRunSettings(
  request: SubThreadDelegationRunSettingsRequest
): SubThreadDelegationRunSettingsResolution {
  if (request.recallChat) {
    if (
      request.model !== undefined ||
      request.reasoningEffort !== undefined ||
      request.kimiThinking !== undefined
    ) {
      return {
        ok: false,
        message:
          'delegate_to_subthread: model, reasoningEffort, and kimiThinking are spawn-only controls. ' +
          'Omit them on recall to preserve the existing provider session continuity, or omit ' +
          'subThreadId to start a differently configured seat.'
      }
    }
    const latestRun = latestRunForProvider(request.recallChat, request.provider)
    const requestedModel =
      (typeof latestRun?.requestedModel === 'string' && latestRun.requestedModel.trim()) ||
      (typeof request.recallChat.requestedModel === 'string' &&
        request.recallChat.requestedModel.trim()) ||
      (typeof request.recallChat.providerMetadata?.selectedModelType === 'string' &&
        request.recallChat.providerMetadata.selectedModelType.trim()) ||
      'cli-default'
    const reasoningEffort = inheritedReasoningEffort(
      request.recallChat,
      request.provider,
      requestedModel
    )
    const kimiThinking = request.provider === 'kimi' ? true : undefined
    return buildResolvedSettings({
      provider: request.provider,
      requestedModel,
      reasoningEffort,
      kimiThinking
    })
  }

  let requestedModel = 'cli-default'
  if (request.model !== undefined) {
    if (typeof request.model !== 'string' || !request.model.trim()) {
      return {
        ok: false,
        message: 'delegate_to_subthread: model must be a non-empty string when provided.'
      }
    }
    requestedModel = request.model.trim()
    if (requestedModel.length > 200) {
      return {
        ok: false,
        message: 'delegate_to_subthread: model must be 200 characters or fewer.'
      }
    }
  }

  const effort = normalizeReasoningEffort(
    request.provider,
    request.reasoningEffort,
    requestedModel
  )
  if (!effort.ok) return effort
  if (request.kimiThinking !== undefined) {
    if (request.provider !== 'kimi') {
      return {
        ok: false,
        message: 'delegate_to_subthread: kimiThinking is only supported for kimi.'
      }
    }
    if (typeof request.kimiThinking !== 'boolean') {
      return {
        ok: false,
        message: 'delegate_to_subthread: kimiThinking must be a boolean when provided.'
      }
    }
    if (request.kimiThinking === false) {
      return {
        ok: false,
        message: 'delegate_to_subthread: Kimi thinking is always on and cannot be disabled.'
      }
    }
  }
  return buildResolvedSettings({
    provider: request.provider,
    requestedModel,
    reasoningEffort: effort.value,
    kimiThinking:
      request.provider === 'kimi' ? true : undefined
  })
}
