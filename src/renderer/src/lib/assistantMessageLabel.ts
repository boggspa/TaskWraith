import { reasoningDisplayLabel, shortModelName } from './composerChipFormat'
import { canonicalModelIdForProvider, humaniseModelId } from './modelDisplayName'
import {
  resolveOllamaDisplayBrand,
  resolveProviderBrandLabel,
  resolveProviderHueClass
} from './ollamaDisplayBrand'
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

interface RunModelCandidate {
  provider?: string
  requestedModel?: string
  actualModel?: string
}

/**
 * Solo-chat branding fallback. A follow-up assistant row whose run record is
 * missing or never attached (`msg.runId` lookup misses, run lacks
 * actualModel/requestedModel) leaves the brand resolvers without a wire id —
 * for Pi that means `resolveProviderHueClass('pi', '')` paints the plain seat
 * color and drops the upstream override (deepseek/qwen/…). Scan the chat's
 * considers only an unambiguous same-provider history. A missing attribution
 * is preferable to borrowing another seat's model and brand, or rewriting an
 * old bubble to a later model from that same seat.
 */
export function mostRecentSoloRunModel(
  runs: ReadonlyArray<RunModelCandidate> | null | undefined,
  provider?: string | null
): string | null {
  if (!Array.isArray(runs)) return null
  let modelForProvider: string | null = null
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]
    const model =
      [run.actualModel, run.requestedModel].find(
        (value): value is string => typeof value === 'string' && value.trim() !== ''
      ) ?? null
    if (!model) continue
    // A model owned by another provider is never an acceptable branding
    // fallback. Reusing it can make an old Pi/Ollama bubble take on a later
    // Claude/Codex model or brand as the chat evolves.
    if (provider && run.provider !== provider) continue
    if (modelForProvider && modelForProvider !== model) return null
    modelForProvider = model
  }
  return modelForProvider
}

type FormatAssistantMessageLabelOptions = {
  /**
   * Ensemble chats stamp each assistant bubble with `ensembleProvider`.
   * Messages that lack it are not Ollama turns — never apply chat-level
   * Ollama brand spoofing to them (that was clobbering Codex/Claude headers
   * when `chat.provider` was `ollama` or stray `providerModel` leaked in).
   */
  isEnsembleChat?: boolean
  /** Run-scoped model for solo/provider chats. Used when the message itself
   * does not carry provider model metadata. */
  soloModelId?: string | null
  soloModelLabel?: string | null
  /**
   * The seat's OWN configured model (`chat.requestedModel`), used only to
   * expand a legacy `cli-default` row. Never overrides a concrete recorded
   * model — a settled run's model is a fact, the seat config is only a guess
   * about a row that never recorded one.
   */
  seatModelId?: string | null
}

const DEFAULT_MODEL_SENTINELS = new Set(['default', 'cli-default'])

/**
 * Expand the legacy `cli-default` sentinel to a concrete wire id before brand
 * resolution.
 *
 * The sentinel means "whatever this seat was configured to", so the seat's own
 * model is the only honest expansion. Going straight to the provider-wide
 * default — what `canonicalModelIdForProvider` returns, and which drifts as new
 * models ship — re-brands an old row with today's pick: an Ollama seat running
 * DeepSeek R1 was painted Alibaba purple because the humanised sentinel label
 * read "Qwen 3". Prefer the seat, keep the provider default as the floor.
 */
function expandDefaultModelSentinel(
  provider: ProviderId | null,
  modelId: string,
  seatModelId?: string | null
): string {
  if (!modelId || !DEFAULT_MODEL_SENTINELS.has(modelId.trim().toLowerCase())) return modelId
  const seat = String(seatModelId || '').trim()
  if (seat && !DEFAULT_MODEL_SENTINELS.has(seat.toLowerCase())) return seat
  return provider ? canonicalModelIdForProvider(provider, modelId) || modelId : modelId
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

function seatSnapshot(message: ChatMessage): Record<string, unknown> | null {
  const value = message.metadata?.ensembleSeatSnapshot
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

const PROVIDER_IDS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral',
  'muse',
  'devin'
])

function assistantProviderForMessage(message: ChatMessage): ProviderId | null {
  const provider = textValue(message.metadata?.assistantProvider)
  return PROVIDER_IDS.has(provider as ProviderId) ? (provider as ProviderId) : null
}

function transcriptShortModelName(
  provider: ProviderId,
  modelLabel: string,
  modelId: string
): string {
  // `shortModelName` preserves the wire id for legacy `cli-default` rows.
  // Resolve the provider-aware concrete default first so an assistant header
  // never says the raw sentinel or an old sibling model name.
  const canonicalModelId = canonicalModelIdForProvider(provider, modelId) || modelId
  return shortModelName(provider, modelLabel, canonicalModelId)
}

function transcriptReasoningLabel(input: {
  provider: ProviderId
  modelId: string
  reasoningEffort?: string | null
  thinkingEnabled?: boolean
}): string {
  const { provider, modelId, reasoningEffort, thinkingEnabled } = input
  return reasoningDisplayLabel({
    provider,
    composerStyle: 'default',
    modelId,
    modelLabel: '',
    codexReasoningEffort: provider === 'codex' ? reasoningEffort || undefined : undefined,
    claudeReasoningEffort: provider === 'claude' ? reasoningEffort || undefined : undefined,
    grokReasoningEffort: provider === 'grok' ? reasoningEffort || undefined : undefined,
    cursorReasoningEffort: provider === 'cursor' ? reasoningEffort || undefined : undefined,
    kimiReasoningEffort: provider === 'kimi' ? reasoningEffort || undefined : undefined,
    kimiThinkingEnabled: provider === 'kimi' ? thinkingEnabled : undefined,
    museReasoningEffort: provider === 'muse' ? reasoningEffort || undefined : undefined,
    mistralReasoningEffort:
      provider === 'mistral' || provider === 'pi' ? reasoningEffort || undefined : undefined,
    devinReasoningEffort: provider === 'devin' ? reasoningEffort || undefined : undefined,
    piReasoningEffort: provider === 'pi' ? reasoningEffort || undefined : undefined,
    ollamaReasoningEffort: provider === 'ollama' ? reasoningEffort || undefined : undefined,
    antigravityReasoningEffort:
      provider === 'antigravity' ? reasoningEffort || undefined : undefined
  })
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
    ...(Number.isFinite(Number(record.saturation))
      ? {
          saturation: Math.max(0, Math.min(100, Math.round(Number(record.saturation))))
        }
      : {}),
    ...(Number.isFinite(Number(record.brightness))
      ? {
          brightness: Math.max(0, Math.min(100, Math.round(Number(record.brightness))))
        }
      : {}),
    ...(typeof record.accent === 'string' && record.accent ? { accent: record.accent } : {}),
    ...(typeof record.slug === 'string' && record.slug ? { slug: record.slug } : {}),
    ...(typeof record.assetKey === 'string' && record.assetKey
      ? { assetKey: record.assetKey }
      : {}),
    ...(typeof record.seed === 'string' && record.seed ? { seed: record.seed } : {}),
    ...(typeof record.hueEnabled === 'boolean' ? { hueEnabled: record.hueEnabled } : {})
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
    const guestProviderLabel = guestProvider
      ? resolveProviderBrandLabel(guestProvider, guestModel) || getProviderLabel(guestProvider)
      : ''
    return withPooledIdentity({
      label: guestProvider
        ? `${guestProviderLabel} / ${guestRole}`
        : `Guest / ${guestRole}`,
      provider: guestProvider,
      providerClass: guestProvider
        ? resolveProviderHueClass(guestProvider, guestModel)
        : null,
      modelBadge:
        guestProvider && guestModel ? transcriptShortModelName(guestProvider, '', guestModel) : null
    })
  }
  const snapshot = seatSnapshot(message)
  const provider =
    (textValue(message.metadata?.ensembleProvider) || textValue(snapshot?.provider) || null) as
      | ProviderId
      | null
  if (!provider) {
    const assistantProvider = assistantProviderForMessage(message)
    const soloProvider = assistantProvider || fallbackProvider
    const allowSoloModel = !options?.isEnsembleChat
    const recordedSoloModel =
      allowSoloModel &&
      typeof message.metadata?.providerModel === 'string' &&
      message.metadata.providerModel
        ? message.metadata.providerModel
        : allowSoloModel
          ? options?.soloModelId || ''
          : ''
    const soloModel = expandDefaultModelSentinel(
      soloProvider,
      recordedSoloModel,
      options?.seatModelId
    )
    const soloModelLabel =
      allowSoloModel &&
      typeof message.metadata?.providerModelLabel === 'string' &&
      message.metadata.providerModelLabel
        ? message.metadata.providerModelLabel
        : allowSoloModel
          ? options?.soloModelLabel || ''
          : ''
    const soloReasoningEffort = textValue(message.metadata?.assistantReasoningEffort)
    const soloThinkingEnabled =
      typeof message.metadata?.assistantThinkingEnabled === 'boolean'
        ? message.metadata.assistantThinkingEnabled
        : undefined
    if (!options?.isEnsembleChat && soloProvider === 'ollama') {
      const modelLabel = soloModelLabel || humaniseModelId('ollama', soloModel)
      const branded = ollamaBrandPresentation(soloModel, modelLabel)
      if (branded) return withPooledIdentity(branded)
    }
    const brandedProviderLabel = soloProvider
      ? resolveProviderBrandLabel(soloProvider, soloModel, soloModelLabel)
      : null
    const soloModelName =
      soloProvider && (soloModel || soloModelLabel)
        ? transcriptShortModelName(soloProvider, soloModelLabel, soloModel || soloModelLabel)
        : null
    const soloReasoningSuffix =
      soloProvider && soloModelName
        ? transcriptReasoningLabel({
            provider: soloProvider,
            modelId: soloModel,
            reasoningEffort: soloReasoningEffort,
            thinkingEnabled: soloThinkingEnabled
          })
        : ''
    const soloModelBadge = soloModelName
      ? soloReasoningSuffix
        ? `${soloModelName} ${soloReasoningSuffix}`
        : soloModelName
      : null
    // New rows carry an immutable speaker identity; older rows retain the
    // chat-level fallback. Either way the header and hue derive from the same
    // provider/model pair.
    return withPooledIdentity({
      label: brandedProviderLabel || fallbackLabel,
      provider: soloProvider,
      providerClass: soloProvider
        ? resolveProviderHueClass(soloProvider, soloModel, soloModelLabel)
        : null,
      modelBadge: soloModelBadge
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
  const ensembleModel = expandDefaultModelSentinel(
    provider,
    textValue(message.metadata?.ensembleModel) || textValue(snapshot?.model),
    textValue(snapshot?.model)
  )
  const ensembleReasoningEffort =
    textValue(message.metadata?.ensembleReasoningEffort) || textValue(snapshot?.reasoningEffort)
  const ensembleThinkingEnabled =
    typeof message.metadata?.ensembleThinkingEnabled === 'boolean'
      ? message.metadata.ensembleThinkingEnabled
      : typeof snapshot?.thinkingEnabled === 'boolean'
        ? snapshot.thinkingEnabled
      : undefined
  const modelName = ensembleModel ? transcriptShortModelName(provider, '', ensembleModel) : null
  // Append a reasoning/thinking suffix when the participant carried one
  // through dispatch so the header mirrors the composer chip the user
  // picked ("5.5 Extra High", "Opus 4.7 · Max", "K2.7 Coding Thinking"). The
  // reasoning helper short-circuits to '' for providers without a
  // reasoning axis (Gemini) or when the effort is 'off'.
  const reasoningSuffix = modelName
    ? transcriptReasoningLabel({
        provider,
        modelId: ensembleModel,
        reasoningEffort: ensembleReasoningEffort,
        thinkingEnabled: ensembleThinkingEnabled
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
  const providerLabel = resolveProviderBrandLabel(provider, ensembleModel) || getProviderLabel(provider)
  return withPooledIdentity({
    label: role ? `${providerLabel} / ${role}` : providerLabel,
    provider,
    // Resolve the brand-spoof hue rather than tinting by the raw provider id.
    // A Pi run's wire id names the BYOK upstream serving it
    // (`deepseek/deepseek-v4-pro`), so attribution tinted `provider-pi` loses
    // the brand the user actually picked — the seat chip and model picker
    // already spoof it, and the transcript was the odd one out. The resolver
    // returns the provider id unchanged when there is no spoof, so every other
    // provider keeps exactly the hue it had.
    providerClass: resolveProviderHueClass(provider, ensembleModel),
    modelBadge: modelBadge || null
  })
}

export { formatAssistantMessageLabel }
export type { AssistantMessageLabelPresentation, FormatAssistantMessageLabelOptions }
