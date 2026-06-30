import { reasoningDisplayLabel, shortModelName } from './composerChipFormat'
import { humaniseModelId } from './modelDisplayName'
import { resolveOllamaDisplayBrand } from './ollamaDisplayBrand'
import { getProviderLabel } from './providerLabels'
import type {
  ChatMessage,
  PooledAgentIdentitySnapshot,
  ProviderId
} from '../../../main/store/types'

type AssistantMessageLabelPresentation = {
  label: string
  provider: ProviderId | null
  providerClass: string | null
  modelBadge: string | null
  agentAccent?: string
  pooledAgentIdentity?: PooledAgentIdentitySnapshot
}

type FormatAssistantMessageLabelOptions = {
  /**
   * Ensemble chats stamp each assistant bubble with `ensembleProvider`.
   * Messages that lack it are not Ollama turns — never apply chat-level
   * Ollama brand spoofing to them (that was clobbering Codex/Claude headers
   * when `chat.provider` was `ollama` or stray `providerModel` leaked in).
   */
  isEnsembleChat?: boolean
}

const ollamaBrandPresentation = (
  modelId: string,
  modelLabel: string,
  role?: string
): AssistantMessageLabelPresentation | null => {
  const brand = resolveOllamaDisplayBrand(modelId, modelLabel)
  if (brand) {
    return {
      label: role ? `${brand.providerLabel} / ${role}` : brand.providerLabel,
      provider: 'ollama',
      providerClass: brand.providerClass,
      modelBadge: brand.modelLabel
    }
  }
  if (modelLabel) {
    return {
      label: role ? `${modelLabel} / ${role}` : modelLabel,
      provider: 'ollama',
      providerClass: 'ollama',
      modelBadge: null
    }
  }
  return null
}

const pooledAgentIdentityForMessage = (
  message: ChatMessage
): PooledAgentIdentitySnapshot | undefined => {
  const metadata = message.metadata as Record<string, unknown> | undefined
  const raw = metadata?.pooledAgentIdentity
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const agentId =
    typeof metadata?.pooledAgentId === 'string' && metadata.pooledAgentId.trim()
      ? metadata.pooledAgentId.trim()
      : typeof record.agentId === 'string' && record.agentId.trim()
        ? record.agentId.trim()
        : ''
  const nickname =
    typeof record.nickname === 'string' && record.nickname.trim()
      ? record.nickname.trim()
      : ''
  const iconKind = record.iconKind
  const hue = Number(record.hue)
  if (
    !agentId ||
    !nickname ||
    !Number.isFinite(hue) ||
    (iconKind !== 'named' && iconKind !== 'seed' && iconKind !== 'asset')
  ) {
    return undefined
  }
  return {
    schemaVersion: 1,
    agentId,
    nickname,
    iconKind,
    hue: ((Math.round(hue) % 360) + 360) % 360,
    ...(typeof record.accent === 'string' && record.accent ? { accent: record.accent } : {}),
    ...(typeof record.slug === 'string' && record.slug ? { slug: record.slug } : {}),
    ...(typeof record.assetKey === 'string' && record.assetKey
      ? { assetKey: record.assetKey }
      : {}),
    ...(typeof record.seed === 'string' && record.seed ? { seed: record.seed } : {})
  }
}

const formatAssistantMessageLabel = (
  message: ChatMessage,
  fallbackLabel: string,
  fallbackProvider: ProviderId | null,
  options?: FormatAssistantMessageLabelOptions
): AssistantMessageLabelPresentation => {
  const pooledAgentIdentity = pooledAgentIdentityForMessage(message)
  const withPooledIdentity = (
    presentation: AssistantMessageLabelPresentation
  ): AssistantMessageLabelPresentation =>
    pooledAgentIdentity
      ? {
          ...presentation,
          label: pooledAgentIdentity.nickname,
          agentAccent: pooledAgentIdentity.accent,
          pooledAgentIdentity
        }
      : presentation

  if (message.metadata?.kind === 'guestParticipantReply') {
    const guestProvider = (message.metadata?.guestProvider as ProviderId | undefined) ?? null
    const guestRole =
      typeof message.metadata?.guestRole === 'string' && message.metadata.guestRole
        ? message.metadata.guestRole
        : 'Guest'
    const guestModel =
      typeof message.metadata?.guestModel === 'string' ? message.metadata.guestModel : ''
    return withPooledIdentity({
      label: guestProvider
        ? `${getProviderLabel(guestProvider)} / ${guestRole}`
        : `Guest / ${guestRole}`,
      provider: guestProvider,
      providerClass: guestProvider,
      modelBadge: guestProvider && guestModel ? shortModelName(guestProvider, '', guestModel) : null
    })
  }
  const provider = (message.metadata?.ensembleProvider as ProviderId | undefined) ?? null
  if (!provider) {
    if (!options?.isEnsembleChat && fallbackProvider === 'ollama') {
      const model =
        typeof message.metadata?.providerModel === 'string' ? message.metadata.providerModel : ''
      const modelLabel =
        typeof message.metadata?.providerModelLabel === 'string'
          ? message.metadata.providerModelLabel
          : humaniseModelId('ollama', model)
      const branded = ollamaBrandPresentation(model, modelLabel)
      if (branded) return withPooledIdentity(branded)
    }
    // Solo chats: use the chat-level provider as the colouring hook.
    // The label is still the plain provider name (no role suffix
    // since there's no ensemble context). The composer chip already
    // shows the model in solo chats — no need to duplicate it here.
    return withPooledIdentity({
      label: fallbackLabel,
      provider: fallbackProvider,
      providerClass: fallbackProvider,
      modelBadge: null
    })
  }
  const role =
    typeof message.metadata?.ensembleRole === 'string' ? message.metadata.ensembleRole : ''
  // Ensemble preview: surface the participant's short model name as a
  // dim badge appended to "Provider / Role". Prep work for 1.0.4 where
  // two Claudes or two Codexes will share a provider — the model is
  // the only thing that visually distinguishes them in the transcript.
  // Falls back to no badge when the participant doesn't carry a model
  // (legacy ensemble chats from before this metadata existed).
  const ensembleModel =
    typeof message.metadata?.ensembleModel === 'string' ? message.metadata.ensembleModel : ''
  const ensembleReasoningEffort =
    typeof message.metadata?.ensembleReasoningEffort === 'string'
      ? message.metadata.ensembleReasoningEffort
      : ''
  const ensembleThinkingEnabled =
    typeof message.metadata?.ensembleThinkingEnabled === 'boolean'
      ? message.metadata.ensembleThinkingEnabled
      : undefined
  const modelName = ensembleModel ? shortModelName(provider, '', ensembleModel) : null
  // Append a reasoning/thinking suffix when the participant carried one
  // through dispatch so the header mirrors the composer chip the user
  // picked ("5.5 Extra High", "Opus 4.7 · Max", "K2.7 Code Thinking"). The
  // reasoning helper short-circuits to '' for providers without a
  // reasoning axis (Gemini) or when the effort is 'off'.
  const reasoningSuffix = modelName
    ? reasoningDisplayLabel({
        provider,
        // `reasoningDisplayLabel` doesn't read `composerStyle` — only the
        // sibling `formatComposerModelChip` does — but the shared
        // `ComposerChipContext` interface requires it. Any valid value
        // works; `'default'` is the most neutral.
        composerStyle: 'default',
        modelId: ensembleModel,
        modelLabel: '',
        codexReasoningEffort: provider === 'codex' ? ensembleReasoningEffort : undefined,
        claudeReasoningEffort: provider === 'claude' ? ensembleReasoningEffort : undefined,
        kimiThinkingEnabled: provider === 'kimi' ? ensembleThinkingEnabled : undefined
      })
    : ''
  const modelBadge = modelName
    ? reasoningSuffix
      ? `${modelName} ${reasoningSuffix}`
      : modelName
    : null
  if (provider === 'ollama' && ensembleModel) {
    const humanLabel = humaniseModelId('ollama', ensembleModel)
    const branded = ollamaBrandPresentation(ensembleModel, humanLabel, role)
    if (branded) {
      return withPooledIdentity({
        ...branded,
        // Keep reasoning suffix on the badge when the participant carried one.
        modelBadge: modelBadge || branded.modelBadge
      })
    }
  }
  return withPooledIdentity({
    label: role ? `${getProviderLabel(provider)} / ${role}` : getProviderLabel(provider),
    provider,
    providerClass: provider,
    modelBadge: modelBadge || null
  })
}

export { formatAssistantMessageLabel }
export type { AssistantMessageLabelPresentation, FormatAssistantMessageLabelOptions }
