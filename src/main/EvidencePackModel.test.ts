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

  it('detects completion words only when used assertively', () => {
    // Sentence/clause-initial predicate.
    expect(detectCompletionLanguage('Done.')).toEqual(['done'])
    // Clause-initial + copula predicate.
    expect(detectCompletionLanguage('Done. UI import is implemented.')).toEqual([
      'done',
      'implemented'
    ])
    // Explicit "ready for review" marker.
    expect(detectCompletionLanguage('Implemented and ready for review.')).toEqual([
      'implemented',
      'ready'
    ])
    // Second conjunct as a clause-final predicate.
    expect(detectCompletionLanguage('Fixed and complete.')).toEqual(['fixed', 'complete'])
    expect(detectCompletionLanguage('Implemented and ready.')).toEqual(['implemented', 'ready'])
    // Copula / subject-run assertions.
    expect(detectCompletionLanguage("it's fixed")).toEqual(['fixed'])
    expect(detectCompletionLanguage('everything is complete')).toEqual(['complete'])
    expect(detectCompletionLanguage('now done')).toEqual(['done'])
    // First-person perfective assertions (object noun may follow).
    expect(detectCompletionLanguage("I've implemented the parser")).toEqual(['implemented'])
    expect(detectCompletionLanguage('we finished the migration')).toEqual(['complete'])
    expect(detectCompletionLanguage('I fixed the crash')).toEqual(['fixed'])
    // Explicit markers.
    expect(detectCompletionLanguage('ready to ship')).toEqual(['ready'])
    expect(detectCompletionLanguage('implementation is complete')).toEqual([
      'implemented',
      'complete'
    ])
    expect(detectCompletionLanguage('✅ all tests pass')).toEqual(['done'])
  })

  it('does not flag attributive, prepositional, or subordinate uses (ensemble-intro false positives)', () => {
    // Two real ensemble-intro messages that were being falsely flagged: the
    // completion words there are attributive adjectives / prepositional objects.
    expect(
      detectCompletionLanguage(
        "I don't edit files myself — I route bounded work to the right owner, run typechecks on completed work, run the full test suite for green gates, and give the thumbs-up that lets @Captain commit a round's work in path-scoped slices."
      )
    ).toEqual([])
    expect(
      detectCompletionLanguage(
        "When @King gives the green light after typechecks/tests, I'm also the one who commits completed slices by pathspec."
      )
    ).toEqual([])
    // Other intro phrasings that must not trip the detector.
    expect(detectCompletionLanguage('No work is queued yet, so I\'ll keep my seat warm.')).toEqual(
      []
    )
    expect(
      detectCompletionLanguage("whoever the user wants to drive can hand me a task and I'll route it.")
    ).toEqual([])
    // Attributive adjectives, objects of prepositions, and subordinate clauses.
    expect(detectCompletionLanguage('the completed work is over there')).toEqual([])
    expect(detectCompletionLanguage('when done, hand me a task')).toEqual([])
    expect(detectCompletionLanguage('reviewing the finished slices')).toEqual([])
    expect(detectCompletionLanguage('tracking progress and goal status')).toEqual([])
    expect(detectCompletionLanguage('once complete, notify me')).toEqual([])
    expect(detectCompletionLanguage('the fixed bug is annoying')).toEqual([])
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
