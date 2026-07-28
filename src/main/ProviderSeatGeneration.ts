import { createHash } from 'node:crypto'
import {
  usageCacheCreationInputTokens,
  usageCacheReadInputTokens
} from '../shared/usageAccounting'
import type {
  PromptCacheCapability,
  PromptCacheGuaranteeTier,
  PromptCacheTransport,
  ProviderId,
  ProviderSeatCacheImpact,
  ProviderSeatGeneration,
  ProviderSeatGenerationConfig,
  TaskWraithMcpProfileId
} from './store/types'

export interface ProviderSeatGenerationInput {
  provider: ProviderId
  model: string
  transport: PromptCacheTransport
  guaranteeTier: PromptCacheGuaranteeTier
  systemPromptFingerprint: string
  toolsFingerprint: string
  taskWraithMcpProfileId?: TaskWraithMcpProfileId
  thinkingMode?: string | boolean | null
  reasoningEffort?: string | null
  serviceTier?: string | null
}

export interface ProviderSeatGenerationTransition {
  generation: ProviderSeatGeneration
  freshSessionRequired: boolean
  cacheImpact: ProviderSeatCacheImpact
  causes: Array<
    | 'provider'
    | 'model'
    | 'transport'
    | 'tools'
    | 'system'
    | 'thinking'
    | 'effort'
    | 'service_tier'
    | 'initial'
  >
  preservedCacheTiers: Array<'tools' | 'system' | 'messages'>
}

export interface ProviderSeatRuntimePlan {
  transition: ProviderSeatGenerationTransition
  shouldRotateSession: boolean
  bootstrappedExistingSession: boolean
}

const CACHE_USAGE_KEYS = new Set([
  'cacheReadInputTokens',
  'cache_read_input_tokens',
  'input_cache_read',
  'cacheReadTokens',
  'cachedInputTokens',
  'cached_input_tokens',
  'cacheCreationInputTokens',
  'cache_creation_input_tokens',
  'input_cache_creation',
  'cacheWriteTokens',
  'cache_write_tokens'
])

function normalizedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizedMode(value: string | boolean | null | undefined): string | undefined {
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  return normalizedString(value)
}

/** Hash only stable, main-owned seat-prefix configuration. Callers pass an
 * ordered tuple of scalar/config values; user prompts and transcript content
 * must never enter this fingerprint or every turn would look cache-cold. */
export function fingerprintProviderSeatPrefix(
  kind: 'system' | 'tools',
  components: readonly unknown[]
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(components))
    .digest('hex')
    .slice(0, 24)
  return `${kind}-${digest}`
}

/** CLI transports expose no history-replay lane: the provider session IS the
 * conversation, so rotating it erases real user context. API transports replay
 * chat history from the app store, so rotation there only costs cache warmth. */
export function providerSessionCarriesContext(transport: PromptCacheTransport): boolean {
  return transport === 'cli-opaque'
}

/** Whether nulling providerSessionId on a seat rotation actually costs the
 * user conversation context — the gate for the transcript reset notice.
 * cli-opaque sessions carry the conversation, EXCEPT pi: its CLI session is
 * chat-deterministic (--session-dir/--session-id derived from the chat id),
 * the payload session id is ignored at spawn and never recorded, so rotation
 * never drops pi context and a reset notice would be a false alarm. */
export function providerSeatRotationDropsContext(
  provider: ProviderId,
  transport: PromptCacheTransport
): boolean {
  if (provider === 'pi') return false
  return providerSessionCarriesContext(transport)
}

/** Both dispatch lanes must fingerprint one semantic posture identically. The
 * renderer boundary clamp resolves an unsigned default posture to the
 * 'default' preset (readOnly false) while the signed remote-composer lane
 * leaves effectivePermissions for gate-time resolution — same seat, different
 * payload shape. Absent values therefore normalize to the preset the clamp
 * would re-derive for that approval mode. */
export function providerSeatPosturePrefixComponents(args: {
  approvalMode: string
  presetId?: string | null
  readOnly?: boolean | null
}): { presetId: string; readOnly: boolean } {
  return {
    presetId: args.presetId ?? (args.approvalMode === 'plan' ? 'read_only' : 'default'),
    readOnly: args.readOnly ?? args.approvalMode === 'plan'
  }
}

/** User-facing transcript copy for a REAL seat rotation that drops a
 * context-carrying (CLI) session. False rotations were fixed 2026-07-28; the
 * remaining legitimate ones (model switch, tool-profile change, provider
 * change, stored-session drift) previously erased the conversation silently —
 * the user experienced "resumed sessions are broken". Keep this a plain
 * sentence: it ships as an ordinary system chat message, not a new card kind,
 * so both platforms render it with zero vocabulary changes. */
export function providerSeatRotationNoticeText(args: {
  providerLabel: string
  causes: ProviderSeatGenerationTransition['causes']
  storedSessionMismatch: boolean
  previousModel?: string | null
  nextModel?: string | null
}): string {
  const reasons: string[] = []
  if (args.causes.includes('provider')) reasons.push('the provider changed')
  if (args.causes.includes('model')) {
    reasons.push(
      args.previousModel && args.nextModel && args.previousModel !== args.nextModel
        ? `the model changed (${args.previousModel} → ${args.nextModel})`
        : 'the model changed'
    )
  }
  if (args.causes.includes('transport')) reasons.push('the provider transport changed')
  if (args.causes.includes('tools')) reasons.push('the tool profile changed')
  if (!reasons.length && args.storedSessionMismatch) {
    reasons.push('the stored session no longer matches its recorded configuration')
  }
  if (!reasons.length) reasons.push('the session configuration changed')
  return `Session context reset — ${reasons.join(', ')}. ${args.providerLabel} starts this turn without the previous conversation context.`
}

export interface StoredSeatSessionObservation {
  provider: ProviderId
  transport: PromptCacheTransport
  model?: string
  toolsFingerprint?: string
  taskWraithMcpProfileId?: TaskWraithMcpProfileId | null
  systemPromptFingerprint?: string
}

/** Decide whether a persisted seat generation still describes the stored
 * provider session, comparing ONLY fields the caller could actually observe
 * from durable run records. An unrecorded field is unknown — it must be
 * skipped, never backfilled from the current dispatch (that backfill is what
 * used to rotate healthy sessions whenever two dispatch lanes phrased the
 * same configuration differently). System-prefix drift alone never rotates a
 * context-carrying (CLI) session. */
export function storedSeatSessionRotationRequired(
  stored: ProviderSeatGenerationConfig | null | undefined,
  observed: StoredSeatSessionObservation,
  hasLinkedSession: boolean
): boolean {
  if (!stored || !hasLinkedSession) return false
  if (stored.provider !== observed.provider) return true
  if (stored.transport !== observed.transport) return true
  if (observed.model !== undefined && stored.model !== observed.model) return true
  if (
    observed.toolsFingerprint !== undefined &&
    stored.toolsFingerprint !== observed.toolsFingerprint
  ) {
    return true
  }
  if (
    observed.taskWraithMcpProfileId !== undefined &&
    (stored.taskWraithMcpProfileId || null) !== (observed.taskWraithMcpProfileId || null)
  ) {
    return true
  }
  if (
    observed.systemPromptFingerprint !== undefined &&
    stored.systemPromptFingerprint !== observed.systemPromptFingerprint
  ) {
    return !providerSessionCarriesContext(stored.transport)
  }
  return false
}

function normalizeConfig(input: ProviderSeatGenerationInput): ProviderSeatGenerationConfig {
  const model = input.model.trim()
  const systemPromptFingerprint = input.systemPromptFingerprint.trim()
  const toolsFingerprint = input.toolsFingerprint.trim()
  if (!model || !systemPromptFingerprint || !toolsFingerprint) {
    throw new Error('Provider seat generation requires model, system, and tool fingerprints.')
  }
  return {
    provider: input.provider,
    model,
    transport: input.transport,
    systemPromptFingerprint,
    toolsFingerprint,
    ...(input.taskWraithMcpProfileId
      ? { taskWraithMcpProfileId: input.taskWraithMcpProfileId }
      : {}),
    ...(normalizedMode(input.thinkingMode)
      ? { thinkingMode: normalizedMode(input.thinkingMode) }
      : {}),
    ...(normalizedString(input.reasoningEffort)
      ? { reasoningEffort: normalizedString(input.reasoningEffort) }
      : {}),
    ...(normalizedString(input.serviceTier)
      ? { serviceTier: normalizedString(input.serviceTier) }
      : {})
  }
}

function generationId(config: ProviderSeatGenerationConfig, ordinal: number): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        provider: config.provider,
        model: config.model,
        transport: config.transport,
        system: config.systemPromptFingerprint,
        tools: config.toolsFingerprint,
        profile: config.taskWraithMcpProfileId || null,
        ordinal
      })
    )
    .digest('hex')
    .slice(0, 20)
  return `seat-${config.provider}-${ordinal}-${digest}`
}

function strongerImpact(
  left: ProviderSeatCacheImpact,
  right: ProviderSeatCacheImpact
): ProviderSeatCacheImpact {
  const rank: Record<ProviderSeatCacheImpact, number> = {
    none: 0,
    unsupported: 0,
    partial: 1,
    unknown: 2,
    full: 3
  }
  return rank[right] > rank[left] ? right : left
}

function providerMutableImpact(
  provider: ProviderId,
  field: 'thinking' | 'effort' | 'service_tier'
): ProviderSeatCacheImpact {
  if (provider === 'ollama') return 'unsupported'
  if (field === 'service_tier') return 'none'
  if (field === 'effort') {
    if (provider === 'claude' || provider === 'codex') return 'none'
    return provider === 'gemini' ? 'unsupported' : 'unknown'
  }
  if (field === 'thinking') {
    if (provider === 'claude' || provider === 'kimi') return 'partial'
    if (provider === 'gemini') return 'unsupported'
    return 'unknown'
  }
  return 'unknown'
}

function preservedTiers(
  provider: ProviderId,
  causes: ProviderSeatGenerationTransition['causes'],
  impact: ProviderSeatCacheImpact
): ProviderSeatGenerationTransition['preservedCacheTiers'] {
  if (impact === 'none') return ['tools', 'system', 'messages']
  if (impact === 'unsupported' || impact === 'unknown' || impact === 'full') return []
  if (provider !== 'claude') return []
  if (causes.includes('system')) return ['tools']
  if (causes.includes('thinking')) return ['tools', 'system']
  return []
}

function cacheStatsReported(stats: unknown): boolean {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return false
  const record = stats as Record<string, unknown>
  return Object.keys(record).some((key) => {
    if (!CACHE_USAGE_KEYS.has(key)) return false
    const value = record[key]
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value === 'string' && value.trim()) return Number.isFinite(Number(value.trim()))
    return false
  })
}

export function planProviderSeatGeneration(
  previous: ProviderSeatGeneration | null | undefined,
  input: ProviderSeatGenerationInput,
  now: string = new Date().toISOString()
): ProviderSeatGenerationTransition {
  // Provider-mutable soft fields inherit on absence: only the renderer lane
  // states them on every dispatch, so an unstated value means "lane didn't
  // say", not "user cleared it" — without inheritance the seat config
  // flip-flops between lanes and churns cache evidence.
  const config = normalizeConfig(
    previous
      ? {
          ...input,
          thinkingMode: input.thinkingMode ?? previous.config.thinkingMode,
          reasoningEffort: input.reasoningEffort ?? previous.config.reasoningEffort,
          serviceTier: input.serviceTier ?? previous.config.serviceTier
        }
      : input
  )
  if (!previous) {
    const generation: ProviderSeatGeneration = {
      schemaVersion: 1,
      id: generationId(config, 1),
      ordinal: 1,
      createdAt: now,
      updatedAt: now,
      config,
      guaranteeTier: input.guaranteeTier
    }
    return {
      generation,
      freshSessionRequired: true,
      cacheImpact: input.guaranteeTier === 'unsupported' ? 'unsupported' : 'full',
      causes: ['initial'],
      preservedCacheTiers: []
    }
  }

  const causes: ProviderSeatGenerationTransition['causes'] = []
  let freshSessionRequired = false
  let cacheImpact: ProviderSeatCacheImpact =
    input.guaranteeTier === 'unsupported' ? 'unsupported' : 'none'
  const previousConfig = previous.config
  if (previousConfig.provider !== config.provider) {
    causes.push('provider')
    freshSessionRequired = true
    cacheImpact = 'full'
  }
  if (previousConfig.model !== config.model) {
    causes.push('model')
    freshSessionRequired = true
    cacheImpact = 'full'
  }
  if (previousConfig.transport !== config.transport) {
    causes.push('transport')
    freshSessionRequired = true
    cacheImpact = 'full'
  }
  if (
    previousConfig.toolsFingerprint !== config.toolsFingerprint ||
    previousConfig.taskWraithMcpProfileId !== config.taskWraithMcpProfileId
  ) {
    causes.push('tools')
    freshSessionRequired = true
    cacheImpact = 'full'
  }
  if (previousConfig.systemPromptFingerprint !== config.systemPromptFingerprint) {
    causes.push('system')
    // A CLI session is the conversation itself — cold-starting it for prefix
    // drift trades a cache guarantee for the user's entire context. Only
    // transports with a history-replay lane may rotate here.
    if (!providerSessionCarriesContext(config.transport)) {
      freshSessionRequired = true
    }
    cacheImpact = strongerImpact(
      cacheImpact,
      config.provider === 'claude' ? 'partial' : 'full'
    )
  }
  if (previousConfig.thinkingMode !== config.thinkingMode) {
    causes.push('thinking')
    cacheImpact = strongerImpact(
      cacheImpact,
      providerMutableImpact(config.provider, 'thinking')
    )
  }
  if (previousConfig.reasoningEffort !== config.reasoningEffort) {
    causes.push('effort')
    cacheImpact = strongerImpact(cacheImpact, providerMutableImpact(config.provider, 'effort'))
  }
  if (previousConfig.serviceTier !== config.serviceTier) {
    causes.push('service_tier')
    cacheImpact = strongerImpact(
      cacheImpact,
      providerMutableImpact(config.provider, 'service_tier')
    )
  }

  const ordinal = freshSessionRequired ? previous.ordinal + 1 : previous.ordinal
  if (input.guaranteeTier === 'unsupported') cacheImpact = 'unsupported'
  const preserveCacheEvidence =
    previous.guaranteeTier === input.guaranteeTier &&
    (cacheImpact === 'none' || cacheImpact === 'unsupported')
  const generation: ProviderSeatGeneration = freshSessionRequired
    ? {
        schemaVersion: 1,
        id: generationId(config, ordinal),
        ordinal,
        createdAt: now,
        updatedAt: now,
        config,
        guaranteeTier: input.guaranteeTier
      }
    : {
        ...previous,
        updatedAt: now,
        config,
        guaranteeTier: input.guaranteeTier,
        ...(preserveCacheEvidence ? {} : { cacheEvidence: undefined })
      }
  return {
    generation,
    freshSessionRequired,
    cacheImpact,
    causes,
    preservedCacheTiers: preservedTiers(config.provider, causes, cacheImpact)
  }
}

/** Runtime adapter around generation planning. An already-resumable seat with
 * no persisted generation is bootstrapped from its last-known configuration,
 * so the first dispatch after upgrade can still detect a model/tool change.
 * An initial genuinely fresh seat never needs an extra rotation. */
export function planProviderSeatRuntime(
  previous: ProviderSeatGeneration | null | undefined,
  currentInput: ProviderSeatGenerationInput,
  options: {
    linkedProviderSessionId?: string | null
    bootstrapInput?: ProviderSeatGenerationInput
    now?: string
  } = {}
): ProviderSeatRuntimePlan {
  const now = options.now || new Date().toISOString()
  const linkedProviderSessionId = normalizedString(options.linkedProviderSessionId)
  let baseline = previous
  let bootstrappedExistingSession = false
  if (!baseline && linkedProviderSessionId) {
    baseline = planProviderSeatGeneration(
      undefined,
      options.bootstrapInput || currentInput,
      now
    ).generation
    bootstrappedExistingSession = true
  }
  const transition = planProviderSeatGeneration(baseline, currentInput, now)
  return {
    transition,
    shouldRotateSession: Boolean(
      linkedProviderSessionId && baseline && transition.freshSessionRequired
    ),
    bootstrappedExistingSession
  }
}

export function recordProviderSeatCacheEvidence(
  generation: ProviderSeatGeneration,
  stats: unknown,
  options: { observedAt?: string; runId?: string } = {}
): ProviderSeatGeneration {
  const cacheReadInputTokens = usageCacheReadInputTokens(stats)
  const cacheCreationInputTokens = usageCacheCreationInputTokens(stats)
  const reported = cacheStatsReported(stats)
  if (!reported) return generation
  const state =
    cacheReadInputTokens > 0
      ? 'observed_hit'
      : cacheCreationInputTokens > 0
        ? 'observed_write'
        : 'observed_miss'
  const observedAt = options.observedAt || new Date().toISOString()
  if (
    options.runId &&
    generation.cacheEvidence?.runId === options.runId &&
    generation.cacheEvidence.state === state &&
    generation.cacheEvidence.cacheReadInputTokens === cacheReadInputTokens &&
    generation.cacheEvidence.cacheCreationInputTokens === cacheCreationInputTokens &&
    generation.cacheEvidence.guaranteeTier === generation.guaranteeTier
  ) {
    return generation
  }
  return {
    ...generation,
    updatedAt: observedAt,
    cacheEvidence: {
      state,
      observedAt,
      ...(options.runId ? { runId: options.runId } : {}),
      guaranteeTier: generation.guaranteeTier,
      cacheReadInputTokens,
      cacheCreationInputTokens
    }
  }
}

export function providerSeatCanPrewarm(capability: PromptCacheCapability): boolean {
  return (
    capability.controllable === true &&
    capability.guaranteeTier === 'guaranteed' &&
    (capability.transport === 'api-byok' || capability.transport === 'api-managed')
  )
}
