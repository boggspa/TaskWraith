import { describe, expect, it } from 'vitest'

import { buildPromptTaskContract } from './PromptTaskNormalizerModel'
import type { RepoConventionIndexSnapshot } from './store/types'

const NOW = new Date('2026-07-02T18:00:00.000Z')

function convention(): RepoConventionIndexSnapshot {
  return {
    schemaVersion: 1,
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    generatedAt: NOW.toISOString(),
    entries: [
      {
        id: 'component-family-react',
        kind: 'component_family',
        title: 'React component files are part of the UI surface',
        paths: ['src/renderer/src/components/Button.tsx'],
        provenance: 'scan',
        updatedAt: NOW.toISOString(),
        description: 'Prefer established React component and hook patterns.'
      },
      {
        id: 'style-system-existing-assets',
        kind: 'style_system',
        title: 'Existing style assets define the visual system',
        paths: ['src/renderer/src/styles/theme.css'],
        provenance: 'scan',
        updatedAt: NOW.toISOString(),
        description: 'Reuse existing theme tokens before adding broad styling surfaces.'
      }
    ]
  }
}

describe('PromptTaskNormalizerModel', () => {
  it('normalizes Olly-style UI importer intent into a scoped task contract', () => {
    const contract = buildPromptTaskContract({
      prompt: 'Make my app import UI. It should support arbitrary UI from screenshots and React.',
      currentState: 'The visual editor can render local components, but importer behavior is unknown.',
      repoConventionIndex: convention(),
      now: NOW
    })

    expect(contract).toMatchObject({
      schemaVersion: 1,
      generatedAt: NOW.toISOString(),
      riskLevel: 'high',
      inferredMode: 'explore',
      firstSliceKey: 'source-format-contract'
    })
    expect(contract.desiredCapability).toContain('Make my app import UI')
    expect(contract.currentState).toContain('visual editor')
    expect(contract.nonGoals).toContain('Arbitrary support for every possible UI framework or source format.')
    expect(contract.questions.map((question) => question.id)).toContain('source-format')
    expect(contract.acceptanceCriteria.join('\n')).toContain('Every completion claim is backed by an Evidence Pack')
    expect(contract.allowedSurfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'importer/parser modules', source: 'scope_radar' }),
        expect.objectContaining({
          label: 'React component files are part of the UI surface',
          source: 'repo_convention',
          paths: ['src/renderer/src/components/Button.tsx'],
          conventionEntryIds: ['component-family-react']
        }),
        expect.objectContaining({
          label: 'Existing style assets define the visual system',
          source: 'repo_convention',
          paths: ['src/renderer/src/styles/theme.css'],
          conventionEntryIds: ['style-system-existing-assets']
        })
      ])
    )
  })

  it('infers hardening mode for validation-heavy bug prompts', () => {
    const contract = buildPromptTaskContract({
      prompt: 'Fix the upload retry bug and add coverage for the regression.',
      now: NOW
    })

    expect(contract.inferredMode).toBe('harden')
    expect(contract.acceptanceCriteria.join('\n')).toContain('Evidence exists for:')
  })
})
