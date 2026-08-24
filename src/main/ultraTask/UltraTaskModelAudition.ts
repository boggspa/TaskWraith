import type { ProviderId } from '../store/types'
import {
  isConcreteUltraTaskModelId,
  type UltraTaskAvailability
} from './UltraTaskCapabilityResolver'
import type { UltraTaskQuotaBinding } from './UltraTaskQuotaBindings'

export type UltraTaskAuditionState =
  | 'eligible'
  | 'unknown'
  | 'quota_limited'
  | 'unconfigured'
  | 'transport_unavailable'
  | 'unsupported'

export type UltraTaskQuotaPoolState = 'available' | 'limited' | 'exhausted' | 'unknown'
export type UltraTaskBillingBasis =
  | 'actual_api'
  | 'projected_api_equivalent'
  | 'subscription'
  | 'local'
  | 'free'
  | 'unknown'

export interface UltraTaskQuotaPoolSnapshot {
  id: string
  provider?: ProviderId
  label?: string
  state: UltraTaskQuotaPoolState
  usedPercent?: number
  remainingUsd?: number
  resetAt?: string
  /** Stale exhaustion is uncertainty, never authority to disable a model. */
  stale?: boolean
}

export interface UltraTaskAuditionRate {
  billingBasis: UltraTaskBillingBasis
  inputUsdPerMillion: number
  outputUsdPerMillion: number
}

export interface UltraTaskAuditionCandidateInput {
  provider: ProviderId
  modelId: string
  label: string
  configured: boolean
  ultraTaskSupported: boolean
  runtimeAvailability: UltraTaskAvailability
  routeAvailability: UltraTaskAvailability
  quotaBinding: UltraTaskQuotaBinding
  rate?: UltraTaskAuditionRate
}

export interface UltraTaskModelAuditionInput {
  candidates: readonly UltraTaskAuditionCandidateInput[]
  quotaPools?: readonly UltraTaskQuotaPoolSnapshot[]
  expectedInputTokens?: number
  expectedOutputTokens?: number
}

export interface UltraTaskAuditionCandidate {
  provider: ProviderId
  modelId: string
  label: string
  state: UltraTaskAuditionState
  reasons: string[]
  quotaPoolIds: string[]
  quotaHeadroomPercent?: number
  quotaEvidence: 'known' | 'unknown' | 'not_applicable'
  billingBasis: UltraTaskBillingBasis
  estimatedCostUsd?: number
  budgetRemainingUsd?: number
  priorityScore: number
  rank: number
}

export interface UltraTaskAuditionProviderSummary {
  provider: ProviderId
  state: UltraTaskAuditionState
  candidateCount: number
  eligibleCount: number
  recommendedModelId?: string
}

export interface UltraTaskModelAuditionResult {
  candidates: UltraTaskAuditionCandidate[]
  providers: UltraTaskAuditionProviderSummary[]
  recommended?: { provider: ProviderId; modelId: string }
}

const STATE_ORDER: Record<UltraTaskAuditionState, number> = {
  eligible: 0,
  unknown: 1,
  quota_limited: 2,
  unconfigured: 3,
  transport_unavailable: 4,
  unsupported: 5
}

const finiteNonnegative = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value))

function estimatedCost(
  candidate: UltraTaskAuditionCandidateInput,
  expectedInputTokens: number,
  expectedOutputTokens: number
): number | undefined {
  const input = finiteNonnegative(candidate.rate?.inputUsdPerMillion)
  const output = finiteNonnegative(candidate.rate?.outputUsdPerMillion)
  if (input === undefined || output === undefined) return undefined
  return (expectedInputTokens * input + expectedOutputTokens * output) / 1_000_000
}

interface PoolObservation {
  state: UltraTaskQuotaPoolState
  headroom?: number
  remainingUsd?: number
  reason: string
}

function observePool(
  candidate: UltraTaskAuditionCandidateInput,
  pool: UltraTaskQuotaPoolSnapshot | undefined,
  cost: number | undefined
): PoolObservation {
  if (!pool || (pool.provider && pool.provider !== candidate.provider)) {
    return { state: 'unknown', reason: 'Quota pool evidence is unavailable.' }
  }
  const label = pool.label?.trim() || pool.id
  if (pool.stale) {
    return { state: 'unknown', reason: `${label} quota evidence is stale.` }
  }
  const usedPercent = finiteNonnegative(pool.usedPercent)
  const headroom = usedPercent === undefined ? undefined : clampPercent(100 - usedPercent)
  let state = pool.state
  if (usedPercent !== undefined && usedPercent >= 100) state = 'exhausted'
  else if (usedPercent !== undefined && usedPercent >= 90 && state === 'available')
    state = 'limited'
  const remainingUsd = finiteNonnegative(pool.remainingUsd)
  if (
    state === 'available' &&
    candidate.rate?.billingBasis === 'actual_api' &&
    cost !== undefined &&
    remainingUsd !== undefined &&
    cost > remainingUsd
  ) {
    state = 'limited'
  }
  return {
    state,
    ...(headroom !== undefined ? { headroom } : {}),
    ...(remainingUsd !== undefined ? { remainingUsd } : {}),
    reason:
      state === 'available'
        ? `${label} has${headroom === undefined ? '' : ` ${headroom.toFixed(0)}%`} headroom.`
        : state === 'unknown'
          ? `${label} quota is unknown.`
          : `${label} is ${state === 'exhausted' ? 'exhausted' : 'quota-limited'}.`
  }
}

interface QuotaAssessment {
  state: 'available' | 'unknown' | 'limited'
  evidence: UltraTaskAuditionCandidate['quotaEvidence']
  reasons: string[]
  headroom?: number
  remainingUsd?: number
}

function assessQuota(
  candidate: UltraTaskAuditionCandidateInput,
  poolsById: ReadonlyMap<string, UltraTaskQuotaPoolSnapshot>,
  cost: number | undefined
): QuotaAssessment {
  const binding = candidate.quotaBinding
  if (binding.kind === 'not_applicable') {
    return {
      state: 'available',
      evidence: 'not_applicable',
      reasons: ['This model does not consume a hosted quota pool.'],
      headroom: 100
    }
  }
  if (binding.kind === 'unknown' || binding.poolIds.length === 0) {
    return {
      state: 'unknown',
      evidence: 'unknown',
      reasons: ['No exact quota-pool binding is known for this model.']
    }
  }
  const observations = binding.poolIds.map((id) => observePool(candidate, poolsById.get(id), cost))
  const available = observations.filter((observation) => observation.state === 'available')
  const unknown = observations.filter((observation) => observation.state === 'unknown')
  const limited = observations.filter(
    (observation) => observation.state === 'limited' || observation.state === 'exhausted'
  )
  const usable =
    binding.satisfaction === 'any'
      ? available.length > 0
      : limited.length === 0 && unknown.length === 0
  const headrooms = available.flatMap((observation) =>
    observation.headroom === undefined ? [] : [observation.headroom]
  )
  const budgets = available.flatMap((observation) =>
    observation.remainingUsd === undefined ? [] : [observation.remainingUsd]
  )
  if (usable) {
    return {
      state: 'available',
      evidence: 'known',
      reasons: observations.map((observation) => observation.reason),
      ...(headrooms.length
        ? {
            headroom:
              binding.satisfaction === 'any' ? Math.max(...headrooms) : Math.min(...headrooms)
          }
        : {}),
      ...(budgets.length
        ? {
            remainingUsd:
              binding.satisfaction === 'any' ? Math.max(...budgets) : Math.min(...budgets)
          }
        : {})
    }
  }
  if (binding.satisfaction === 'any' && unknown.length > 0) {
    return {
      state: 'unknown',
      evidence: 'unknown',
      reasons: observations.map((observation) => observation.reason)
    }
  }
  if (limited.length > 0) {
    return {
      state: 'limited',
      evidence: 'known',
      reasons: observations.map((observation) => observation.reason)
    }
  }
  return {
    state: 'unknown',
    evidence: 'unknown',
    reasons: observations.map((observation) => observation.reason)
  }
}

function priorityScore(
  state: UltraTaskAuditionState,
  quota: QuotaAssessment,
  cost: number | undefined,
  billingBasis: UltraTaskBillingBasis
): number {
  if (state !== 'eligible') return 0
  const headroomSignal = quota.headroom ?? 0
  const budgetSignal =
    billingBasis === 'actual_api' &&
    cost !== undefined &&
    quota.remainingUsd !== undefined &&
    quota.remainingUsd > 0
      ? clampPercent(((quota.remainingUsd - cost) / quota.remainingUsd) * 100)
      : 0
  return Math.max(headroomSignal, budgetSignal)
}

function evaluateCandidate(
  candidate: UltraTaskAuditionCandidateInput,
  duplicate: boolean,
  poolsById: ReadonlyMap<string, UltraTaskQuotaPoolSnapshot>,
  expectedInputTokens: number,
  expectedOutputTokens: number
): Omit<UltraTaskAuditionCandidate, 'rank'> {
  const cost = estimatedCost(candidate, expectedInputTokens, expectedOutputTokens)
  const quota = assessQuota(candidate, poolsById, cost)
  let state: UltraTaskAuditionState
  let reasons: string[]
  if (duplicate) {
    state = 'unsupported'
    reasons = ['The exact provider/model appears more than once in the audition catalog.']
  } else if (!candidate.ultraTaskSupported) {
    state = 'unsupported'
    reasons = ['The model does not explicitly support UltraTask.']
  } else if (!candidate.configured) {
    state = 'unconfigured'
    reasons = ['The provider/model lane is not configured.']
  } else if (
    candidate.runtimeAvailability === 'unavailable' ||
    candidate.routeAvailability === 'unavailable'
  ) {
    state = 'transport_unavailable'
    reasons = ['The model or complete orchestration route is unavailable.']
  } else if (
    candidate.runtimeAvailability === 'unknown' ||
    candidate.routeAvailability === 'unknown'
  ) {
    state = 'unknown'
    reasons = ['Runtime or orchestration availability has not been proved.']
  } else if (quota.state === 'limited') {
    state = 'quota_limited'
    reasons = quota.reasons
  } else if (quota.state === 'unknown') {
    state = 'unknown'
    reasons = quota.reasons
  } else {
    state = 'eligible'
    reasons = quota.reasons
  }
  const billingBasis = candidate.rate?.billingBasis ?? 'unknown'
  return {
    provider: candidate.provider,
    modelId: candidate.modelId,
    label: candidate.label,
    state,
    reasons,
    quotaPoolIds: [...new Set(candidate.quotaBinding.poolIds)],
    ...(quota.headroom !== undefined ? { quotaHeadroomPercent: quota.headroom } : {}),
    quotaEvidence: quota.evidence,
    billingBasis,
    ...(cost !== undefined ? { estimatedCostUsd: cost } : {}),
    ...(quota.remainingUsd !== undefined ? { budgetRemainingUsd: quota.remainingUsd } : {}),
    priorityScore: priorityScore(state, quota, cost, billingBasis)
  }
}

function providerState(candidates: readonly UltraTaskAuditionCandidate[]): UltraTaskAuditionState {
  for (const state of [
    'eligible',
    'unknown',
    'quota_limited',
    'unconfigured',
    'transport_unavailable',
    'unsupported'
  ] as const) {
    if (candidates.some((candidate) => candidate.state === state)) return state
  }
  return 'unsupported'
}

function costRankingValue(candidate: Omit<UltraTaskAuditionCandidate, 'rank'>): number {
  return candidate.billingBasis === 'actual_api' && candidate.budgetRemainingUsd !== undefined
    ? (candidate.estimatedCostUsd ?? Number.POSITIVE_INFINITY)
    : Number.POSITIVE_INFINITY
}

/**
 * Rank concrete candidates without executing anything or inventing a default.
 * A recommendation is emitted only for an actually eligible exact model.
 */
export function auditionUltraTaskModels(
  input: UltraTaskModelAuditionInput
): UltraTaskModelAuditionResult {
  const poolsById = new Map((input.quotaPools ?? []).map((pool) => [pool.id, pool]))
  const expectedInputTokens = finiteNonnegative(input.expectedInputTokens) ?? 0
  const expectedOutputTokens = finiteNonnegative(input.expectedOutputTokens) ?? 0
  const concrete = input.candidates.filter((candidate) =>
    isConcreteUltraTaskModelId(candidate.modelId)
  )
  const counts = new Map<string, number>()
  for (const candidate of concrete) {
    const key = `${candidate.provider}\0${candidate.modelId}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const evaluated = concrete.map((candidate) =>
    evaluateCandidate(
      candidate,
      (counts.get(`${candidate.provider}\0${candidate.modelId}`) ?? 0) > 1,
      poolsById,
      expectedInputTokens,
      expectedOutputTokens
    )
  )
  evaluated.sort(
    (left, right) =>
      STATE_ORDER[left.state] - STATE_ORDER[right.state] ||
      right.priorityScore - left.priorityScore ||
      costRankingValue(left) - costRankingValue(right) ||
      left.provider.localeCompare(right.provider) ||
      left.label.localeCompare(right.label) ||
      left.modelId.localeCompare(right.modelId)
  )
  const candidates = evaluated.map((candidate, index) => ({ ...candidate, rank: index + 1 }))
  const providers = [...new Set(candidates.map((candidate) => candidate.provider))]
    .sort()
    .map((provider) => {
      const providerCandidates = candidates.filter((candidate) => candidate.provider === provider)
      const recommended = providerCandidates.find((candidate) => candidate.state === 'eligible')
      return {
        provider,
        state: providerState(providerCandidates),
        candidateCount: providerCandidates.length,
        eligibleCount: providerCandidates.filter((candidate) => candidate.state === 'eligible')
          .length,
        ...(recommended ? { recommendedModelId: recommended.modelId } : {})
      }
    })
  const recommended = candidates.find((candidate) => candidate.state === 'eligible')
  return {
    candidates,
    providers,
    ...(recommended
      ? { recommended: { provider: recommended.provider, modelId: recommended.modelId } }
      : {})
  }
}
