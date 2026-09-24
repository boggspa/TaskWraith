import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_PROVIDER_ID,
  RETIRED_PROVIDER_IDS,
  isLiveSelectableProvider
} from '../../shared/retiredProviders'
import { PROVIDER_ACTION_ADAPTERS } from '../../shared/providerActionTaxonomy'
import type { ProviderId } from '../store/types'
import {
  PROVIDER_RUN_MANAGEMENT_DECLARATIONS,
  PROVIDER_RUN_MANAGEMENT_IDS,
  assertProviderRunManagementBaseline,
  buildProviderRunManagementMatrix,
  providerRunManagementBaselineIssues,
  type ProviderRunManagementCoverageInput,
  type ProviderRunManagementMatrix
} from './ProviderRunManagementMatrix'

const ALL_PROVIDERS: readonly ProviderId[] = [...PROVIDER_RUN_MANAGEMENT_IDS]

function coverage(
  overrides: Partial<ProviderRunManagementCoverageInput> = {}
): ProviderRunManagementCoverageInput {
  return {
    registeredAdapterProviderIds: ALL_PROVIDERS,
    sharedLifecycleProviderIds: ALL_PROVIDERS,
    signedPostureRetentionProviderIds: ALL_PROVIDERS,
    scheduledEvidenceProducerProviderIds: [],
    productionSealWiredProviderIds: [],
    ...overrides
  }
}

describe('ProviderRunManagementMatrix', () => {
  it('keeps one provider-parametric row for every stable identity', () => {
    const matrix = buildProviderRunManagementMatrix(coverage())

    expect(Object.keys(matrix)).toEqual(PROVIDER_RUN_MANAGEMENT_IDS)
    for (const provider of PROVIDER_RUN_MANAGEMENT_IDS) {
      expect(matrix[provider]).toMatchObject({
        provider,
        adapterRegistration: 'registered',
        sharedLifecycle: 'run-manager',
        signedPostureRetention: 'retained'
      })
    }
  })

  it('keeps offer policy independent from management maturity', () => {
    const matrix = buildProviderRunManagementMatrix(
      coverage({
        scheduledEvidenceProducerProviderIds: [],
        productionSealWiredProviderIds: []
      })
    )

    expect(matrix.gemini.offerState).toBe('retired-history-only')
    expect(matrix.gemini.sharedLifecycle).toBe('run-manager')
    expect(matrix.codex.offerState).toBe('live-selectable')
    expect(matrix.codex.scheduledEvidenceProducer).toBe('not-implemented')
    expect(matrix.antigravity.offerState).toBe('conditionally-offered')
    expect(matrix.antigravity.productionSealWiring).toBe('unwired')
    expect(() => assertProviderRunManagementBaseline(matrix)).not.toThrow()
  })

  it('mirrors product-owned offer state without deriving it from assurance axes', () => {
    for (const provider of PROVIDER_RUN_MANAGEMENT_IDS) {
      const declared = PROVIDER_RUN_MANAGEMENT_DECLARATIONS[provider].offerState
      const expected = isLiveSelectableProvider(provider)
        ? 'live-selectable'
        : provider === ANTIGRAVITY_PROVIDER_ID
          ? 'conditionally-offered'
          : RETIRED_PROVIDER_IDS.has(provider)
            ? 'retired-history-only'
            : null
      expect(declared, provider).toBe(expected)
    }
  })

  it('reports independent tool mediation, broker observability, and provenance axes', () => {
    const matrix = buildProviderRunManagementMatrix(coverage())

    expect(matrix.kimi).toMatchObject({
      toolMediationMode: 'taskwraith-broker-only',
      brokerObservability: 'host-authoritative',
      binaryRuntimeProvenance: 'descriptor-bound-runtime-admission'
    })
    expect(matrix.cursor).toMatchObject({
      toolMediationMode: 'hybrid-taskwraith-broker-and-provider-native',
      brokerObservability: 'broker-calls-only',
      binaryRuntimeProvenance: 'observed-cli-path-and-version'
    })
    expect(matrix.pi).toMatchObject({
      toolMediationMode: 'provider-native-launch-allowlist',
      brokerObservability: 'none'
    })
    expect(matrix.antigravity).toMatchObject({
      toolMediationMode: 'route-dependent-taskwraith-or-provider-native',
      brokerObservability: 'route-dependent',
      binaryRuntimeProvenance: 'route-dependent-api-or-advisory-cli-publisher'
    })
    expect(matrix.muse).toMatchObject({
      toolMediationMode: 'hybrid-taskwraith-broker-and-provider-native',
      brokerObservability: 'broker-and-observable-native-events',
      binaryRuntimeProvenance: 'observed-cli-path-and-version'
    })
  })

  it('keeps Claude run-management truth aligned with its catalog-only launch surface', () => {
    expect(PROVIDER_ACTION_ADAPTERS.claude).toMatchObject({
      nativeSurface: 'catalog-only',
      nativeMediation: 'not-applicable'
    })
    expect(PROVIDER_RUN_MANAGEMENT_DECLARATIONS.claude).toMatchObject({
      toolMediationMode: 'taskwraith-broker-only',
      brokerObservability: 'host-authoritative'
    })
  })

  it('reports adapter, lifecycle, and signed-posture omissions separately', () => {
    const matrix = buildProviderRunManagementMatrix(
      coverage({
        registeredAdapterProviderIds: ALL_PROVIDERS.filter((provider) => provider !== 'pi'),
        sharedLifecycleProviderIds: ALL_PROVIDERS.filter((provider) => provider !== 'claude'),
        signedPostureRetentionProviderIds: ALL_PROVIDERS.filter(
          (provider) => provider !== 'antigravity'
        )
      })
    )

    expect(providerRunManagementBaselineIssues(matrix)).toEqual([
      {
        provider: 'claude',
        axis: 'sharedLifecycle',
        message: 'claude is outside the shared RunManager lifecycle.'
      },
      {
        provider: 'antigravity',
        axis: 'signedPostureRetention',
        message: 'antigravity does not retain the normalized signed posture in run state.'
      },
      {
        provider: 'pi',
        axis: 'adapterRegistration',
        message: 'pi is missing its provider adapter registration.'
      }
    ])
  })

  it('rejects production seal wiring without an exact producer', () => {
    const matrix = buildProviderRunManagementMatrix(
      coverage({
        scheduledEvidenceProducerProviderIds: [],
        productionSealWiredProviderIds: ['pi']
      })
    )

    expect(providerRunManagementBaselineIssues(matrix)).toContainEqual({
      provider: 'pi',
      axis: 'productionSealWiring',
      message: 'pi is marked production seal-wired without an exact evidence producer.'
    })
    expect(() => assertProviderRunManagementBaseline(matrix)).toThrow(
      /pi is marked production seal-wired without an exact evidence producer/
    )
  })

  it('keeps declarations exhaustive without exposing a combined maturity flag', () => {
    expect(Object.keys(PROVIDER_RUN_MANAGEMENT_DECLARATIONS)).toEqual(PROVIDER_RUN_MANAGEMENT_IDS)

    const matrix = buildProviderRunManagementMatrix(coverage())
    for (const row of Object.values(matrix)) {
      expect(row).not.toHaveProperty('managed')
      expect(row).not.toHaveProperty('maturity')
      expect(row).not.toHaveProperty('admitted')
      expect(row).not.toHaveProperty('selectable')
    }
  })

  it('detects a missing or mis-keyed provider row', () => {
    const matrix = buildProviderRunManagementMatrix(coverage())
    const malformed = {
      ...matrix,
      pi: { ...matrix.pi, provider: 'codex' }
    } as unknown as ProviderRunManagementMatrix

    expect(providerRunManagementBaselineIssues(malformed)).toContainEqual({
      provider: 'pi',
      axis: 'provider',
      message: 'Run-management row pi is missing or carries the wrong provider id.'
    })
  })
})
