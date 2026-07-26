import type { ProviderId } from '../store/types'
import {
  assertRuntimeProviderRunManagementBaseline,
  type ProviderRunManagementSchedulingCoverage
} from '../run/ProviderRunManagementBinding'

/**
 * Provider-local evidence builders that exist today. This is an implementation
 * inventory, not an offer/admission set: Gemini remains history-only, while
 * AntiGravity and Pi may report additive skipped receipts until their exact
 * final launch plans are handed through production dispatch.
 */
export const SCHEDULED_SEAL_EVIDENCE_PROVIDER_IDS = Object.freeze([
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral'
] as const satisfies readonly ProviderId[])

export function hasScheduledSealEvidenceProducer(provider: ProviderId): boolean {
  return (SCHEDULED_SEAL_EVIDENCE_PROVIDER_IDS as readonly ProviderId[]).includes(provider)
}

/**
 * Providers with at least one production dispatch route that consumes the
 * exact evidence-derived launch authority. This declaration must stay narrower
 * than the producer inventory; an unwired producer never blocks its provider.
 */
export const SCHEDULED_SEAL_PRODUCTION_WIRED_PROVIDER_IDS = Object.freeze([
  'cursor'
] as const satisfies readonly ProviderId[])

export const SCHEDULED_SEAL_RUN_MANAGEMENT_COVERAGE: ProviderRunManagementSchedulingCoverage =
  Object.freeze({
    scheduledEvidenceProducerProviderIds: SCHEDULED_SEAL_EVIDENCE_PROVIDER_IDS,
    productionSealWiredProviderIds: SCHEDULED_SEAL_PRODUCTION_WIRED_PROVIDER_IDS
  })

/**
 * Assert the universal nine-identity adapter/lifecycle/posture baseline while
 * preserving evidence/wiring as independent, non-admission axes.
 */
export function assertScheduledSealRunManagementCoverage(): void {
  assertRuntimeProviderRunManagementBaseline(SCHEDULED_SEAL_RUN_MANAGEMENT_COVERAGE)
}
