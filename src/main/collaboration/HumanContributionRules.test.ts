import { describe, expect, it } from 'vitest'
import {
  assertSettablePreset,
  contributionModeForRules,
  contributionRulesForPreset,
  deriveContributionRules,
  effectiveContributionRules,
  HumanCollaborationDenialError,
  humanCollaborationDenialCode,
  normalizeContributionRules,
  SETTABLE_CONTRIBUTION_PRESETS
} from './HumanContributionRules'

/*
 * Phase 2 (P2a) — pins the rules model's safety properties:
 * mode-migration equivalence, fail-closed normalization, and the hard gate on
 * the not-yet-shipped direct-dispatch tier (spec §3/§4).
 */
describe('contribution rules presets', () => {
  it('derives Phase 1-equivalent rules from mode (migration)', () => {
    const readOnly = deriveContributionRules('readOnly')
    expect(readOnly.preset).toBe('readOnly')
    expect(readOnly.viewProjection).toBe(true)
    expect(readOnly.appendComment).toBe(false)
    expect(readOnly.providerDispatch).toBe('never')

    const comments = deriveContributionRules('comments')
    expect(comments.preset).toBe('comments')
    expect(comments.appendComment).toBe(true)
    expect(comments.requestHostAction).toBe(false)
    expect(comments.createHostDraft).toBe('host-click')
    expect(comments.providerDispatch).toBe('never')
  })

  it('maps rules back to the legacy mode consistently', () => {
    expect(contributionModeForRules(contributionRulesForPreset('readOnly'))).toBe('readOnly')
    expect(contributionModeForRules(contributionRulesForPreset('comments'))).toBe('comments')
    expect(contributionModeForRules(contributionRulesForPreset('requestHostAction'))).toBe('comments')
    expect(contributionModeForRules(contributionRulesForPreset('autoDraft'))).toBe('comments')
  })

  it('every settable preset keeps providerDispatch at never (no direct tier)', () => {
    for (const preset of SETTABLE_CONTRIBUTION_PRESETS) {
      expect(contributionRulesForPreset(preset).providerDispatch).toBe('never')
    }
  })

  it('rejects the directLimited preset at set-time with a typed denial', () => {
    expect(() => assertSettablePreset('directLimited')).toThrow(/not available/)
    try {
      assertSettablePreset('directLimited')
    } catch (error) {
      expect(humanCollaborationDenialCode(error)).toBe('protocol_unsupported')
    }
    expect(() => assertSettablePreset('yolo')).toThrow(/not available/)
  })

  it('degrades a directLimited rules object to the comments-equivalent shape', () => {
    const rules = contributionRulesForPreset('directLimited')
    expect(rules.preset).toBe('comments')
    expect(rules.providerDispatch).toBe('never')
  })
})

describe('normalizeContributionRules (fail-closed)', () => {
  it('returns undefined for non-object shapes', () => {
    expect(normalizeContributionRules(null)).toBeUndefined()
    expect(normalizeContributionRules('comments')).toBeUndefined()
    expect(normalizeContributionRules([1, 2])).toBeUndefined()
  })

  it('clamps a forged direct-limited dispatch back to never', () => {
    const normalized = normalizeContributionRules({
      preset: 'comments',
      providerDispatch: 'direct-limited',
      appendComment: true
    })
    expect(normalized?.providerDispatch).toBe('never')
  })

  it('never widens booleans past the preset baseline, but allows narrowing', () => {
    // readOnly baseline forbids comments; a forged appendComment:true cannot widen.
    const widened = normalizeContributionRules({ preset: 'readOnly', appendComment: true })
    expect(widened?.appendComment).toBe(false)
    // comments baseline allows comments; an explicit false narrows.
    const narrowed = normalizeContributionRules({ preset: 'comments', appendComment: false })
    expect(narrowed?.appendComment).toBe(false)
  })

  it('bounds maxContributionBytes between the floor and the 8000 cap', () => {
    expect(
      normalizeContributionRules({ preset: 'comments', maxContributionBytes: 10_000_000 })
        ?.maxContributionBytes
    ).toBe(8000)
    expect(
      normalizeContributionRules({ preset: 'comments', maxContributionBytes: 0 })
        ?.maxContributionBytes
    ).toBe(256)
    expect(
      normalizeContributionRules({ preset: 'comments', maxContributionBytes: 2048 })
        ?.maxContributionBytes
    ).toBe(2048)
  })

  it('degrades an unknown preset to comments and drops junk collaborator ids', () => {
    const normalized = normalizeContributionRules({
      preset: 'directLimited',
      allowedCollaboratorIds: ['a', '', 42, 'b']
    })
    expect(normalized?.preset).toBe('comments')
    expect(normalized?.allowedCollaboratorIds).toEqual(['a', 'b'])
  })
})

describe('effectiveContributionRules', () => {
  it('prefers persisted rules and falls back to mode derivation', () => {
    const persisted = contributionRulesForPreset('requestHostAction')
    expect(
      effectiveContributionRules({ mode: 'comments', contributionRules: persisted }).requestHostAction
    ).toBe(true)
    expect(effectiveContributionRules({ mode: 'comments' }).requestHostAction).toBe(false)
    expect(effectiveContributionRules({ mode: 'readOnly' }).appendComment).toBe(false)
  })
})

describe('HumanCollaborationDenialError', () => {
  it('carries a typed code alongside the human-readable message', () => {
    const error = new HumanCollaborationDenialError('read_only', 'Collaboration share is read-only.')
    expect(error.message).toBe('Collaboration share is read-only.')
    expect(error.code).toBe('read_only')
    expect(humanCollaborationDenialCode(error)).toBe('read_only')
    expect(humanCollaborationDenialCode(new Error('plain'))).toBeNull()
  })
})
