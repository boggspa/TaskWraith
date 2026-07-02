import { describe, expect, it } from 'vitest'
import {
  assessCompletionClaimSupport,
  detectCompletionLanguage,
  detectDeterministicCapabilityStalls,
  normalizeEvidencePackRecord,
  projectCapabilityLedgerFromEvidencePacks
} from './EvidencePackModel'
import type { EvidencePackRecord } from './store/types'

const pack = (
  id: string,
  over: Partial<EvidencePackRecord> = {}
): EvidencePackRecord => ({
  schemaVersion: 1,
  id,
  workspaceId: 'workspace-1',
  mapEntries: [],
  capabilityCells: [],
  completionClaims: [],
  createdAt: `2026-07-02T12:0${id.slice(-1)}:00.000Z`,
  updatedAt: `2026-07-02T12:0${id.slice(-1)}:00.000Z`,
  ...over
})

describe('EvidencePackModel', () => {
  it('normalizes an evidence pack while keeping map provenance separate from cell evidence', () => {
    const normalized = normalizeEvidencePackRecord({
      id: 'pack-1',
      workspaceId: 'workspace-1',
      mapEntries: [
        {
          key: 'Import Buttons',
          title: 'Import buttons',
          provenance: {
            state: 'confirmed_by_tests',
            source: 'scope_radar',
            at: '2026-07-02T12:00:00.000Z'
          }
        }
      ],
      capabilityCells: [
        {
          capabilityKey: 'Import Buttons',
          status: 'verified',
          evidenceRefs: [{ path: 'tests/import-buttons.test.ts', line: 12 }]
        }
      ],
      completionClaims: [
        {
          claim: 'Button fixture imports successfully.',
          supported: true,
          evidenceRefs: [{ path: 'tests/import-buttons.test.ts', line: 12 }]
        }
      ]
    })

    expect(normalized?.mapEntries[0]?.key).toBe('import-buttons')
    expect(normalized?.mapEntries[0]?.provenance.state).toBe('inferred')
    expect(normalized?.capabilityCells[0]?.status).toBe('verified')
    expect(normalized?.capabilityCells[0]?.evidenceRefs).toEqual([
      { path: 'tests/import-buttons.test.ts', line: 12 }
    ])
  })

  it('projects evidence packs into a capability ledger and unsupported claim metric', () => {
    const snapshot = projectCapabilityLedgerFromEvidencePacks([
      pack('pack-1', {
        mapEntries: [
          {
            key: 'import-buttons',
            title: 'Import buttons',
            provenance: {
              state: 'inferred',
              source: 'scope_radar',
              at: '2026-07-02T12:00:00.000Z'
            }
          }
        ],
        capabilityCells: [
          {
            capabilityKey: 'import-buttons',
            title: 'Import buttons',
            status: 'partial',
            evidenceRefs: [{ path: 'fixtures/button.json' }]
          }
        ],
        completionClaims: [
          {
            claim: 'Arbitrary UI import works.',
            supported: false,
            evidenceRefs: [],
            note: 'Only a button fixture is covered.'
          }
        ]
      }),
      pack('pack-2', {
        capabilityCells: [
          {
            capabilityKey: 'import-buttons',
            title: 'Import buttons',
            status: 'verified',
            evidenceRefs: [{ path: 'tests/import-buttons.test.ts', line: 8 }]
          }
        ]
      })
    ], { workspaceId: 'workspace-1', now: new Date('2026-07-02T12:10:00.000Z') })

    expect(snapshot.cells).toHaveLength(1)
    expect(snapshot.cells[0]).toMatchObject({
      capabilityKey: 'import-buttons',
      status: 'verified',
      latestEvidencePackId: 'pack-2'
    })
    expect(snapshot.cells[0]?.evidenceRefs).toHaveLength(2)
    expect(snapshot.mapEntries).toHaveLength(1)
    expect(snapshot.unsupportedCompletionClaims).toBe(1)
    expect(snapshot.unsupportedCompletionClaimRate).toBe(1)
  })

  it('detects deterministic stalls when file diffs do not move capability evidence', () => {
    const signals = detectDeterministicCapabilityStalls([
      pack('pack-1', { diffTouchedFiles: ['src/a.ts'] }),
      pack('pack-2', { diffTouchedFiles: ['src/b.ts'] }),
      pack('pack-3', { diffTouchedFiles: ['src/c.ts'] })
    ])

    expect(signals).toEqual([
      expect.objectContaining({
        kind: 'diff_without_capability_delta',
        severity: 'warning',
        evidencePackIds: ['pack-1', 'pack-2', 'pack-3']
      })
    ])
  })

  it('detects partial capabilities repeated without new evidence', () => {
    const signals = detectDeterministicCapabilityStalls([
      pack('pack-1', {
        capabilityCells: [
          { capabilityKey: 'nested-layout', status: 'partial', evidenceRefs: [{ path: 'fixtures/a.json' }] }
        ]
      }),
      pack('pack-2', {
        capabilityCells: [
          { capabilityKey: 'nested-layout', status: 'partial', evidenceRefs: [{ path: 'fixtures/a.json' }] }
        ]
      }),
      pack('pack-3', {
        capabilityCells: [
          { capabilityKey: 'nested-layout', status: 'partial', evidenceRefs: [{ path: 'fixtures/a.json' }] }
        ]
      })
    ])

    expect(signals.some((signal) => signal.kind === 'partial_without_new_evidence')).toBe(true)
  })

  it('detects completion-style language conservatively', () => {
    expect(detectCompletionLanguage('Implemented and ready for review.')).toEqual([
      'implemented',
      'ready'
    ])
    expect(detectCompletionLanguage('I inspected the code and found the blocker.')).toEqual([])
  })

  it('marks completion claims supported only when evidence backs the run', () => {
    const assessment = assessCompletionClaimSupport('Implemented and ready.', [
      pack('pack-1', {
        chatId: 'chat-1',
        runId: 'run-1',
        completionClaims: [
          {
            claim: 'Import button fixtures work.',
            supported: true,
            evidenceRefs: [{ path: 'src/import.test.ts', line: 12 }]
          }
        ]
      })
    ], { workspaceId: 'workspace-1', chatId: 'chat-1', runId: 'run-1' })

    expect(assessment.status).toBe('supported')
    expect(assessment.supportingEvidenceRefs).toEqual([{ path: 'src/import.test.ts', line: 12 }])
  })

  it('forces a caveat for completion language with only partial evidence', () => {
    const assessment = assessCompletionClaimSupport('Fixed and complete.', [
      pack('pack-1', {
        chatId: 'chat-1',
        runId: 'run-1',
        capabilityCells: [
          {
            capabilityKey: 'ui-import',
            status: 'partial',
            evidenceRefs: [{ path: 'fixtures/button.json' }]
          }
        ]
      })
    ], { workspaceId: 'workspace-1', chatId: 'chat-1', runId: 'run-1' })

    expect(assessment.status).toBe('partial')
    expect(assessment.recommendedCaveat).toContain('partially implemented')
  })

  it('marks unsupported completion claims as unsupported even when the final answer sounds done', () => {
    const assessment = assessCompletionClaimSupport('Done.', [
      pack('pack-1', {
        chatId: 'chat-1',
        runId: 'run-1',
        completionClaims: [
          {
            claim: 'Arbitrary UI import works.',
            supported: false,
            evidenceRefs: [],
            note: 'Only static fixtures were checked.'
          }
        ]
      })
    ], { workspaceId: 'workspace-1', chatId: 'chat-1', runId: 'run-1' })

    expect(assessment.status).toBe('unsupported')
    expect(assessment.recommendedCaveat).toContain('Do not present this as complete')
  })
})
