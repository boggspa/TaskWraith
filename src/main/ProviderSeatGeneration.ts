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
  const config = normalizeConfig(input)
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
    freshSessionRequired = true
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
        guaranteeTier: input.guaranteeTier
      }
  return {
    generation,
    freshSessionRequired,
    cacheImpact,
    causes,
    preservedCacheTiers: preservedTiers(config.provider, causes, cacheImpact)
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
