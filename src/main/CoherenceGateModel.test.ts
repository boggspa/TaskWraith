import { describe, expect, it } from 'vitest'

import { buildCoherenceGateResult } from './CoherenceGateModel'
import { buildScopeRadarResult } from './ScopeRadarModel'
import type { RepoConventionIndexSnapshot } from './store/types'

const NOW = new Date('2026-07-02T18:00:00.000Z')

function convention(
  entries: RepoConventionIndexSnapshot['entries'] = []
): RepoConventionIndexSnapshot {
  return {
    schemaVersion: 1,
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    generatedAt: NOW.toISOString(),
    entries
  }
}

describe('CoherenceGateModel', () => {
  it('blocks edits to generated or dependency paths', () => {
    const gate = buildCoherenceGateResult({
      now: NOW,
      touchedFiles: ['dist/bundle.js', 'src/importer.ts'],
      repoConventionIndex: convention([
        {
          id: 'generated-paths-avoid-editing',
          kind: 'generated_path',
          title: 'Generated paths should not be edited',
          paths: ['dist'],
          provenance: 'scan',
          updatedAt: NOW.toISOString()
        }
      ]),
      validationCommands: ['npm test -- importer']
    })

    expect(gate.status).toBe('block')
    expect(gate.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'generated_path_edit',
          severity: 'blocker',
          paths: ['dist/bundle.js']
        })
      ])
    )
  })

  it('flags placeholder files and slop budget overages', () => {
    const scopeRadar = buildScopeRadarResult({
      prompt: 'Make my app import UI. It should support arbitrary UI.',
      now: NOW
    })
    const gate = buildCoherenceGateResult({
      now: NOW,
      scopeRadar,
      repoConventionIndex: convention(),
      touchedFiles: [
        'src/importer/Parser.ts',
        'src/importer/Normalizer.ts',
        'src/importer/Mapper.ts',
        'src/importer/Preview.tsx',
        'src/importer/PlaceholderAdapter.ts',
        'src/importer/ImportService.ts'
      ],
      newFiles: [
        'src/importer/Parser.ts',
        'src/importer/Normalizer.ts',
        'src/importer/Mapper.ts',
        'src/importer/Preview.tsx',
        'src/importer/PlaceholderAdapter.ts',
        'src/importer/ImportService.ts'
      ],
      placeholderFiles: ['src/importer/PlaceholderAdapter.ts'],
      validationCommands: ['npm test -- importer']
    })

    expect(gate.status).toBe('block')
    const kinds = gate.findings.map((finding) => finding.kind)
    expect(kinds).toContain('placeholder_only_work')
    expect(kinds).toContain('slop_budget_exceeded')
    expect(kinds).toContain('duplicate_abstraction_risk')
  })

  it('warns when non-documentation changes have no validation evidence', () => {
    const gate = buildCoherenceGateResult({
      now: NOW,
      touchedFiles: ['src/importer.ts'],
      repoConventionIndex: convention()
    })

    expect(gate.status).toBe('warn')
    expect(gate.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'missing_validation_evidence',
          severity: 'warning',
          paths: ['src/importer.ts']
        })
      ])
    )
  })

  it('passes scoped implementation changes with validation evidence', () => {
    const scopeRadar = buildScopeRadarResult({
      prompt: 'Add retry button to failed upload card.',
      now: NOW
    })
    const gate = buildCoherenceGateResult({
      now: NOW,
      scopeRadar,
      repoConventionIndex: convention(),
      touchedFiles: ['src/renderer/src/components/UploadCard.tsx', 'src/renderer/src/components/UploadCard.test.tsx'],
      validationCommands: ['npm test -- UploadCard']
    })

    expect(gate.status).toBe('pass')
    expect(gate.findings).toEqual([])
    expect(gate.counts.touchedFiles).toBe(2)
  })

  it('warns on broad styling drift when style work was not in scope', () => {
    const scopeRadar = buildScopeRadarResult({
      prompt: 'Add retry button to failed upload card.',
      now: NOW
    })
    const gate = buildCoherenceGateResult({
      now: NOW,
      scopeRadar,
      repoConventionIndex: convention([
        {
          id: 'style-system-existing-assets',
          kind: 'style_system',
          title: 'Existing style assets define the visual system',
          paths: ['src/renderer/src/styles/theme.css'],
          provenance: 'scan',
          updatedAt: NOW.toISOString()
        }
      ]),
      touchedFiles: ['src/renderer/src/styles/theme.css'],
      validationCommands: ['npm test -- UploadCard']
    })

    expect(gate.status).toBe('warn')
    expect(gate.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'broad_styling_drift',
          severity: 'warning',
          conventionEntryIds: ['style-system-existing-assets']
        })
      ])
    )
  })
})
