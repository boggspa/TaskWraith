import type { ChatRecord, ProviderId } from './store/types'
import {
  getStaticProviderModels,
  isKimiK3Model,
  normalizeCliProviderModel,
  normalizeKimiReasoningEffort
} from './providers/StaticProviderModels'
import { normalizeClaudeEffortFlagForModel } from './ClaudeCliArgs'
import {
  isCursorGrok45ModelId,
  isCursorGrokModelId,
  isGrok45ReasoningModelId,
  isGrokReasoningModelId,
  normalizeGrok45ReasoningEffort,
  normalizeGrok46ReasoningEffort
} from '../shared/grok45Models'
import {
  normalizeOllamaReasoningEffort,
  resolveOllamaReasoningSupport
} from '../shared/ollamaReasoning'
import { isMistralThinkingCapableModel } from '../shared/mistralModels'
import { normalizeMistralThinkingLevel } from './mistral/MistralCliArgs'
import { findPiStaticModel } from './pi/PiModels'
import { piThinkingLevelForEffort } from './pi/PiCliArgs'
import { MUSE_REASONING_EFFORTS, normalizeMuseReasoningEffort } from './muse/MuseCliArgs'
import { normalizeAgyReasoningEffort } from './antigravity/AntigravityCli'

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
const KIMI_K3_REASONING_EFFORTS = new Set(['low', 'high', 'max'])
const KIMI_FIXED_THINKING_EFFORTS = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'ultracode',
  'ultratask',
  'on'
])
const GROK_REASONING_INPUTS = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'ultracode',
  'ultratask'
])
const TOP_TIER_REASONING_EFFORTS = new Set([
  'xhigh',
  'max',
  'maximum',
  'ultra',
  'ultracode',
  'ultratask'
])

const CODEX_EFFORT_ALIASES: Readonly<Record<string, string>> = {
  light: 'low',
  extra: 'xhigh',
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
  if (provider === 'mistral') return 'mistralReasoningEffort'
  if (provider === 'pi') return 'piReasoningEffort'
  if (provider === 'muse') return 'museReasoningEffort'
  if (provider === 'ollama') return 'ollamaReasoningEffort'
  if (provider === 'cursor') return 'cursorReasoningEffort'
  if (provider === 'antigravity') return 'antigravityReasoningEffort'
  return undefined
}

interface DelegationModelMetadata {
  id: string
  isDefault?: boolean
  ultraTaskSupported?: boolean
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; disabled?: boolean }>
}

function staticModelMetadata(
  provider: ProviderId,
  requestedModel: string
): DelegationModelMetadata | undefined {
  const catalog = getStaticProviderModels(provider, {
    includePreviewModels: true
  }) as DelegationModelMetadata[]
  const requestedKey = requestedModel.trim().toLowerCase()
  if (requestedKey === 'cli-default' || requestedKey === 'default') {
    return catalog.find((model) => model.isDefault) || catalog[0]
  }
  const exact = catalog.find((model) => model.id.toLowerCase() === requestedKey)
  if (exact) return exact
  const normalizedModel = normalizeCliProviderModel(provider, requestedModel).toLowerCase()
  return catalog.find((model) => model.id.toLowerCase() === normalizedModel)
}

function enabledModelReasoningEfforts(model: DelegationModelMetadata | undefined): string[] {
  return (model?.supportedReasoningEfforts || [])
    .filter((option) => !option.disabled)
    .map((option) => option.reasoningEffort.trim().toLowerCase())
    .filter(Boolean)
}

function invalidReasoningEffort(
  provider: ProviderId,
  normalized: string,
  supported?: readonly string[]
): { ok: false; message: string } {
  return {
    ok: false,
    message:
      `delegate_to_subthread: reasoningEffort="${normalized}" is not valid for ${provider}.` +
      (supported?.length ? ` Supported values: ${supported.join(', ')}.` : '')
  }
}

function modelHasNoReasoningAxis(
  provider: ProviderId,
  requestedModel: string,
  model: DelegationModelMetadata | undefined
): boolean {
  if (provider === 'grok') return !isGrokReasoningModelId(requestedModel)
  if (provider === 'cursor') return !isCursorGrokModelId(requestedModel)
  if (provider === 'mistral') {
    return Boolean(model) && !isMistralThinkingCapableModel(requestedModel)
  }
  if (provider === 'pi') {
    const piModel = findPiStaticModel(requestedModel)
    return Boolean(piModel) && !piModel?.thinking
  }
  return false
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
  const raw = value.trim().toLowerCase()
  const modelId = requestedModel || 'cli-default'
  const model = staticModelMetadata(provider, modelId)
  const modelEfforts = enabledModelReasoningEfforts(model)

  // Grok/Cursor's Composer rows and known non-thinking Mistral/Pi rows have no
  // effort axis. Delegation remains useful; omit the irrelevant control rather
  // than rejecting the whole worker or forwarding a provider-invalid flag.
  if (modelHasNoReasoningAxis(provider, modelId, model)) return { ok: true }

  if (provider === 'codex') {
    let normalized = CODEX_EFFORT_ALIASES[raw] || raw
    if (raw === 'ultratask') {
      normalized = modelEfforts.at(-1) || 'xhigh'
    }
    if (!CODEX_REASONING_EFFORTS.has(normalized)) {
      return invalidReasoningEffort(provider, raw, [...CODEX_REASONING_EFFORTS])
    }
    if (
      model &&
      model.id !== 'custom' &&
      modelEfforts.length > 0 &&
      !modelEfforts.includes(normalized)
    ) {
      return invalidReasoningEffort(provider, normalized, modelEfforts)
    }
    return { ok: true, value: normalized }
  }

  if (provider === 'claude') {
    const alias = CLAUDE_EFFORT_ALIASES[raw] || raw
    const normalized = normalizeClaudeEffortFlagForModel(alias, modelId)
    if (!normalized || !CLAUDE_REASONING_EFFORTS.has(normalized)) {
      return invalidReasoningEffort(provider, raw, modelEfforts)
    }
    if (
      model &&
      model.id !== 'custom' &&
      modelEfforts.length > 0 &&
      !modelEfforts.includes(normalized)
    ) {
      return invalidReasoningEffort(provider, normalized, modelEfforts)
    }
    return { ok: true, value: normalized }
  }

  if (provider === 'kimi') {
    if (!isKimiK3Model(modelId)) {
      return KIMI_FIXED_THINKING_EFFORTS.has(raw)
        ? { ok: true, value: 'on' }
        : invalidReasoningEffort(provider, raw, [...KIMI_FIXED_THINKING_EFFORTS])
    }
    const candidate = TOP_TIER_REASONING_EFFORTS.has(raw) ? 'max' : raw
    if (!KIMI_K3_REASONING_EFFORTS.has(candidate)) {
      return invalidReasoningEffort(provider, raw, [...KIMI_K3_REASONING_EFFORTS])
    }
    return {
      ok: true,
      value: normalizeKimiReasoningEffort(modelId, candidate) || 'max'
    }
  }

  if (provider === 'grok' || provider === 'cursor') {
    if (!GROK_REASONING_INPUTS.has(raw)) {
      return invalidReasoningEffort(provider, raw, [...GROK_REASONING_INPUTS])
    }
    const grok45 =
      provider === 'grok' ? isGrok45ReasoningModelId(modelId) : isCursorGrok45ModelId(modelId)
    return {
      ok: true,
      value: grok45 ? normalizeGrok45ReasoningEffort(raw) : normalizeGrok46ReasoningEffort(raw)
    }
  }

  if (provider === 'mistral') {
    const normalized = normalizeMistralThinkingLevel(raw === 'ultracode' ? 'ultratask' : raw)
    return normalized
      ? { ok: true, value: normalized }
      : invalidReasoningEffort(provider, raw, ['off', 'low', 'medium', 'high', 'max'])
  }

  if (provider === 'pi') {
    const normalized = piThinkingLevelForEffort(raw)
    return normalized
      ? { ok: true, value: normalized }
      : invalidReasoningEffort(provider, raw, [
          'off',
          'minimal',
          'low',
          'medium',
          'high',
          'xhigh',
          'max'
        ])
  }

  if (provider === 'muse') {
    const valid = new Set<string>([
      ...MUSE_REASONING_EFFORTS,
      'none',
      'off',
      'max',
      'ultracode',
      'ultratask'
    ])
    return valid.has(raw)
      ? { ok: true, value: normalizeMuseReasoningEffort(raw) }
      : invalidReasoningEffort(provider, raw, [...valid])
  }

  if (provider === 'antigravity') {
    const normalized = TOP_TIER_REASONING_EFFORTS.has(raw)
      ? 'high'
      : normalizeAgyReasoningEffort(raw)
    return normalized
      ? { ok: true, value: normalized }
      : invalidReasoningEffort(provider, raw, ['low', 'medium', 'high'])
  }

  if (provider === 'ollama') {
    const support = resolveOllamaReasoningSupport({ modelId })
    if (support.kind === 'unsupported' || support.kind === 'unknown') return { ok: true }
    const valid =
      support.kind === 'toggle'
        ? new Set([
            'off',
            'false',
            'on',
            'true',
            'low',
            'medium',
            'high',
            ...TOP_TIER_REASONING_EFFORTS
          ])
        : new Set(['low', 'medium', 'high', ...TOP_TIER_REASONING_EFFORTS])
    if (!valid.has(raw)) return invalidReasoningEffort(provider, raw, [...valid])
    const normalized = normalizeOllamaReasoningEffort(raw, support)
    return normalized ? { ok: true, value: normalized } : { ok: true }
  }

  return {
    ok: false,
    message: `delegate_to_subthread: reasoningEffort is not supported for ${provider}.`
  }
}

function latestRunForProvider(chat: ChatRecord, provider: ProviderId) {
  return [...(chat.runs || [])].reverse().find((run) => !run.provider || run.provider === provider)
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

  const effort = normalizeReasoningEffort(request.provider, request.reasoningEffort, requestedModel)
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
    kimiThinking: request.provider === 'kimi' ? true : undefined
  })
}
