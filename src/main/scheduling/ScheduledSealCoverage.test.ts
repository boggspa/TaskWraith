import { describe, expect, it } from 'vitest'
import { buildRuntimeProviderRunManagementMatrix } from '../run/ProviderRunManagementBinding'
import { PROVIDER_RUN_MANAGEMENT_IDS } from '../run/ProviderRunManagementMatrix'
import {
  SCHEDULED_SEAL_EVIDENCE_PROVIDER_IDS,
  SCHEDULED_SEAL_PRODUCTION_WIRED_PROVIDER_IDS,
  SCHEDULED_SEAL_RUN_MANAGEMENT_COVERAGE,
  assertScheduledSealRunManagementCoverage
} from './ScheduledSealCoverage'

describe('ScheduledSealCoverage', () => {
  it('keeps producer availability and production wiring independent', () => {
    expect(SCHEDULED_SEAL_EVIDENCE_PROVIDER_IDS).toEqual([
      'codex',
      'claude',
      'kimi',
      'grok',
      'cursor',
      'ollama',
      'antigravity',
      'pi'
    ])
    expect(SCHEDULED_SEAL_PRODUCTION_WIRED_PROVIDER_IDS).toEqual(['cursor'])

    const matrix = buildRuntimeProviderRunManagementMatrix(
      SCHEDULED_SEAL_RUN_MANAGEMENT_COVERAGE
    )
    expect(Object.keys(matrix)).toEqual(PROVIDER_RUN_MANAGEMENT_IDS)
    expect(matrix.gemini).toMatchObject({
      offerState: 'retired-history-only',
      scheduledEvidenceProducer: 'not-implemented',
      productionSealWiring: 'unwired'
    })
    expect(matrix.antigravity).toMatchObject({
      offerState: 'conditionally-offered',
      scheduledEvidenceProducer: 'implemented',
      productionSealWiring: 'unwired'
    })
    expect(matrix.pi).toMatchObject({
      offerState: 'live-selectable',
      scheduledEvidenceProducer: 'implemented',
      productionSealWiring: 'unwired'
    })
    expect(matrix.cursor).toMatchObject({
      scheduledEvidenceProducer: 'implemented',
      productionSealWiring: 'wired'
    })
  })

  it('asserts the nine-provider baseline without requiring stronger seal coverage', () => {
    expect(() => assertScheduledSealRunManagementCoverage()).not.toThrow()
  })
})
