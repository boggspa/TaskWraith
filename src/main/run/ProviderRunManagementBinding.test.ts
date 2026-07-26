import { describe, expect, it } from 'vitest'
import { PROVIDER_ADAPTER_REGISTRATION_IDS } from '../ProviderAdapters'
import { RUN_MANAGER_PROVIDERS } from '../index.constants'
import { availableProviderIds } from '../settings/MainSanitizers'
import { SIGNED_POSTURE_RETENTION_PROVIDER_IDS } from './ProviderRunLifecycleOwnership'
import {
  assertRuntimeProviderRunManagementBaseline,
  buildRuntimeProviderRunManagementMatrix
} from './ProviderRunManagementBinding'
import { PROVIDER_RUN_MANAGEMENT_IDS } from './ProviderRunManagementMatrix'

describe('ProviderRunManagementBinding', () => {
  it('binds independent adapter, lifecycle, and posture declarations across all nine ids', () => {
    expect(PROVIDER_RUN_MANAGEMENT_IDS).toEqual(availableProviderIds())
    expect(PROVIDER_ADAPTER_REGISTRATION_IDS).toEqual(PROVIDER_RUN_MANAGEMENT_IDS)
    expect(RUN_MANAGER_PROVIDERS).toEqual(PROVIDER_RUN_MANAGEMENT_IDS)
    expect(SIGNED_POSTURE_RETENTION_PROVIDER_IDS).toEqual(PROVIDER_RUN_MANAGEMENT_IDS)

    const matrix = assertRuntimeProviderRunManagementBaseline({
      scheduledEvidenceProducerProviderIds: [],
      productionSealWiredProviderIds: []
    })
    for (const row of Object.values(matrix)) {
      expect(row).toMatchObject({
        adapterRegistration: 'registered',
        sharedLifecycle: 'run-manager',
        signedPostureRetention: 'retained'
      })
    }
  })

  it('injects scheduling producer and wiring declarations without merging their axes', () => {
    const matrix = buildRuntimeProviderRunManagementMatrix({
      scheduledEvidenceProducerProviderIds: ['pi'],
      productionSealWiredProviderIds: []
    })

    expect(matrix.pi.scheduledEvidenceProducer).toBe('implemented')
    expect(matrix.pi.productionSealWiring).toBe('unwired')
    expect(matrix.cursor.scheduledEvidenceProducer).toBe('not-implemented')
    expect(matrix.cursor.productionSealWiring).toBe('unwired')
  })

  it('still rejects scheduling wiring that has no matching producer declaration', () => {
    expect(() =>
      assertRuntimeProviderRunManagementBaseline({
        scheduledEvidenceProducerProviderIds: [],
        productionSealWiredProviderIds: ['pi']
      })
    ).toThrow(/pi is marked production seal-wired without an exact evidence producer/)
  })
})
