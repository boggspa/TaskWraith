import { describe, expect, it } from 'vitest'
import {
  shouldAutoAllowUserRequestedEnsembleImport,
  userPromptExplicitlyRequestsEnsembleCreation
} from './EnsembleRosterImportConsent'

describe('userPromptExplicitlyRequestsEnsembleCreation', () => {
  it.each([
    'Create and activate an Ensemble panel for this task.',
    'Can you make me an ensemble with one model from each provider?',
    'Please set up an Ensemble panel named Release Review.',
    'Import this roster preset and activate it.',
    'Turn this chat into an ensemble with a reviewer.'
  ])('accepts a direct creation request: %s', (prompt) => {
    expect(userPromptExplicitlyRequestsEnsembleCreation(prompt)).toBe(true)
  })

  it.each([
    'Explain how to create an ensemble.',
    'How can I create an ensemble?',
    'Can I create an ensemble?',
    'Do not create an ensemble.',
    'Summarize the design without creating an ensemble.',
    'Review our ensemble configuration.',
    'Create a new Settings panel.',
    'Add another participant to the existing panel.'
  ])('rejects a non-creation or ambiguous request: %s', (prompt) => {
    expect(userPromptExplicitlyRequestsEnsembleCreation(prompt)).toBe(false)
  })
})

describe('shouldAutoAllowUserRequestedEnsembleImport', () => {
  const request = {
    toolName: 'mcp__TaskWraith__ensemble_roster_edit',
    toolArgs: { action: 'import_preset', preset: { name: 'QA panel' } },
    runSource: 'manual' as const,
    prompt: 'Create and activate an Ensemble panel named QA panel.'
  }

  it('auto-allows only the import_preset action for a user-started creation turn', () => {
    expect(shouldAutoAllowUserRequestedEnsembleImport(request)).toBe(true)
    expect(
      shouldAutoAllowUserRequestedEnsembleImport({ ...request, runSource: 'remote' })
    ).toBe(true)
  })

  it('keeps live participant mutations gated', () => {
    for (const action of ['add_participant', 'edit_participant', 'remove_participant']) {
      expect(
        shouldAutoAllowUserRequestedEnsembleImport({
          ...request,
          toolArgs: { action, participant: {} }
        })
      ).toBe(false)
    }
  })

  it('fails closed for read-only, scheduled, retry, missing, or unrelated requests', () => {
    expect(shouldAutoAllowUserRequestedEnsembleImport({ ...request, readOnly: true })).toBe(false)
    for (const runSource of ['scheduled', 'retry', 'permission_retry', 'review', 'host_rerun', 'system'] as const) {
      expect(shouldAutoAllowUserRequestedEnsembleImport({ ...request, runSource })).toBe(false)
    }
    expect(
      shouldAutoAllowUserRequestedEnsembleImport({
        ...request,
        prompt: 'Explain how to create an ensemble.'
      })
    ).toBe(false)
    expect(
      shouldAutoAllowUserRequestedEnsembleImport({
        ...request,
        toolArgs: { action: 'import_preset' },
        prompt: undefined
      })
    ).toBe(false)
  })

  it('does not exempt a different tool even with import-shaped arguments', () => {
    expect(
      shouldAutoAllowUserRequestedEnsembleImport({
        ...request,
        toolName: 'write_file'
      })
    ).toBe(false)
  })
})
