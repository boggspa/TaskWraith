import { PROVIDER_ADAPTER_REGISTRATION_IDS } from '../ProviderAdapters'
import { RUN_MANAGER_PROVIDERS } from '../index.constants'
import { SIGNED_POSTURE_RETENTION_PROVIDER_IDS } from './ProviderRunLifecycleOwnership'
import {
  assertProviderRunManagementBaseline,
  buildProviderRunManagementMatrix,
  type ProviderRunManagementMatrix
} from './ProviderRunManagementMatrix'
import type { ProviderId } from '../store/types'

/**
 * Scheduling owns these two declarations separately. They remain required
 * inputs until the scheduling subsystem exports its producer and production
 * wiring registries; this binder must never guess them or freeze a transient
 * count.
 */
export interface ProviderRunManagementSchedulingCoverage {
  readonly scheduledEvidenceProducerProviderIds: Iterable<ProviderId>
  readonly productionSealWiredProviderIds: Iterable<ProviderId>
}

/**
 * Bind the matrix to independently owned runtime declarations. This is a
 * diagnostics/acceptance surface only: neither the result nor its assertion is
 * imported by provider offer or run-admission code.
 */
export function buildRuntimeProviderRunManagementMatrix(
  scheduling: ProviderRunManagementSchedulingCoverage
): ProviderRunManagementMatrix {
  return buildProviderRunManagementMatrix({
    registeredAdapterProviderIds: PROVIDER_ADAPTER_REGISTRATION_IDS,
    sharedLifecycleProviderIds: RUN_MANAGER_PROVIDERS,
    signedPostureRetentionProviderIds: SIGNED_POSTURE_RETENTION_PROVIDER_IDS,
    scheduledEvidenceProducerProviderIds: scheduling.scheduledEvidenceProducerProviderIds,
    productionSealWiredProviderIds: scheduling.productionSealWiredProviderIds
  })
}

export function assertRuntimeProviderRunManagementBaseline(
  scheduling: ProviderRunManagementSchedulingCoverage
): ProviderRunManagementMatrix {
  const matrix = buildRuntimeProviderRunManagementMatrix(scheduling)
  assertProviderRunManagementBaseline(matrix)
  return matrix
}
