import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../store/types'
import { resolveEnsembleUserFanoutTargets } from './EnsembleUserFanout'

function participant(
  id: string,
  role: string,
  order: number,
  patch: Partial<EnsembleParticipant> = {}
): EnsembleParticipant {
  return {
    id,
    provider: id.startsWith('codex') ? 'codex' : id.startsWith('grok') ? 'grok' : 'claude',
    enabled: true,
    role,
    order,
    model: `${id}-model`,
    permissionPresetId: 'default',
    ...patch,
    instructions: patch.instructions || 'Answer the user.'
  }
}

const ROSTER: EnsembleParticipant[] = [
  participant('codex-boss', 'CodexBoss', 1, { stageRole: 'worker' }),
  participant('grok-scout', 'GrokScout', 2, {
    stageRole: 'scout',
    permissionPresetId: 'read_only'
  }),
  participant('claude-review', 'ClaudeReview', 3, { stageRole: 'reviewer' })
]

describe('resolveEnsembleUserFanoutTargets', () => {
  it('returns unique enabled targets in prompt order without stage or permission filtering', () => {
    const result = resolveEnsembleUserFanoutTargets({
      text: '@ClaudeReview verify it, then @GrokScout inspect it; @ClaudeReview owns the verdict.',
      participants: ROSTER
    })

    expect(result.targets.map((target) => target.id)).toEqual(['claude-review', 'grok-scout'])
    expect(result.ambiguities).toEqual([])
    expect(result.hasParticipantMention).toBe(true)
  })

  it('uses the persisted exact picker identity only to disambiguate its visible tag', () => {
    const codexPeer = participant('codex-peer', 'CodexPeer', 4, { model: 'gpt-5.6-terra' })
    const result = resolveEnsembleUserFanoutTargets({
      text: '@codex take this lane.',
      participants: [...ROSTER, codexPeer],
      exactTargetParticipantId: codexPeer.id
    })

    expect(result.targets.map((target) => target.id)).toEqual([codexPeer.id])
    expect(result.ambiguities).toEqual([])
  })

  it('retains unresolved ambiguity without dispatching the representative seat', () => {
    const codexPeer = participant('codex-peer', 'CodexPeer', 4, { model: 'gpt-5.6-terra' })
    const result = resolveEnsembleUserFanoutTargets({
      text: '@codex take this lane.',
      participants: [...ROSTER, codexPeer]
    })

    expect(result.targets).toEqual([])
    expect(result.ambiguities).toHaveLength(1)
    expect(result.ambiguities[0].participants.map((target) => target.id)).toEqual([
      'codex-boss',
      'codex-peer'
    ])
  })

  it('does not treat unknown, user, disabled, or untagged advisory ids as fan-out targets', () => {
    const disabled = participant('grok-disabled', 'GrokDisabled', 5, { enabled: false })
    const result = resolveEnsembleUserFanoutTargets({
      text: '@user please note @Unknown and @GrokDisabled.',
      participants: [...ROSTER, disabled],
      exactTargetParticipantId: 'codex-boss'
    })

    expect(result.targets).toEqual([])
    expect(result.ambiguities).toEqual([])
    expect(result.hasParticipantMention).toBe(false)
  })

  it('preserves an exact current structured tag after its visible alias changes', () => {
    const result = resolveEnsembleUserFanoutTargets({
      text: '[@FormerName](ensemble-dm://grok-scout) inspect this.',
      participants: ROSTER,
      exactTargetParticipantId: 'grok-scout'
    })

    expect(result.targets.map((target) => target.id)).toEqual(['grok-scout'])
    expect(result.hasParticipantMention).toBe(true)
  })

  it('treats a structured participant identity as authoritative over its visible alias', () => {
    const reviewer = participant('claude-reviewer', 'Reviewer', 4)
    const result = resolveEnsembleUserFanoutTargets({
      text: '[@Reviewer](ensemble-dm://grok-scout) inspect this.',
      participants: [...ROSTER, reviewer]
    })

    expect(result.targets.map((target) => target.id)).toEqual(['grok-scout'])
    expect(result.ambiguities).toEqual([])
  })

  it('keeps structured and plain targets in their source order', () => {
    const result = resolveEnsembleUserFanoutTargets({
      text: '[@FormerName](ensemble-dm://grok-scout) first, then @ClaudeReview.',
      participants: ROSTER
    })

    expect(result.targets.map((target) => target.id)).toEqual(['grok-scout', 'claude-review'])
  })

  it('expands a stage group to every enabled seat in roster order', () => {
    const scout2 = participant('grok-scout-2', 'GrokScout2', 5, { stageRole: 'scout' })
    const result = resolveEnsembleUserFanoutTargets({
      text: '@Scouts inspect the two paths.',
      participants: [scout2, ...ROSTER]
    })

    expect(result.targets.map((target) => target.id)).toEqual(['grok-scout', 'grok-scout-2'])
    expect(result.ambiguities).toEqual([])
    expect(result.hasParticipantMention).toBe(true)
  })

  it('makes @All include enabled typed, untyped, and background seats', () => {
    const anySeat = participant('claude-any', 'ClaudeAny', 4)
    const background = participant('grok-bg', 'GrokBackground', 5, {
      stageRole: 'background'
    })
    const disabled = participant('grok-disabled', 'GrokDisabled', 6, {
      enabled: false,
      stageRole: 'worker'
    })
    const result = resolveEnsembleUserFanoutTargets({
      text: '@All re-check the latest steer.',
      participants: [...ROSTER, anySeat, background, disabled]
    })

    expect(result.targets.map((target) => target.id)).toEqual([
      'codex-boss',
      'grok-scout',
      'claude-review',
      'claude-any',
      'grok-bg'
    ])
  })

  it('treats @BG as the background group rather than an ambiguous participant alias', () => {
    const background1 = participant('grok-bg-1', 'BackgroundOne', 4, {
      stageRole: 'background'
    })
    const background2 = participant('claude-bg-2', 'BackgroundTwo', 5, {
      stageRole: 'background'
    })
    const result = resolveEnsembleUserFanoutTargets({
      text: '@BG run the long checks.',
      participants: [...ROSTER, background2, background1]
    })

    expect(result.targets.map((target) => target.id)).toEqual(['grok-bg-1', 'claude-bg-2'])
    expect(result.ambiguities).toEqual([])
  })

  it('dedupes explicit seats across mixed participant and group signals', () => {
    const background = participant('grok-bg', 'GrokBackground', 4, {
      stageRole: 'background'
    })
    const result = resolveEnsembleUserFanoutTargets({
      text: '@Workers first, @GrokScout second, then @All.',
      participants: [...ROSTER, background]
    })

    expect(result.targets.map((target) => target.id)).toEqual([
      'codex-boss',
      'grok-scout',
      'claude-review',
      'grok-bg'
    ])
  })

  it('does not let an exact participant picker narrow a group signal', () => {
    const result = resolveEnsembleUserFanoutTargets({
      text: '@Reviewers verify it.',
      participants: ROSTER,
      exactTargetParticipantId: 'codex-boss'
    })

    expect(result.targets.map((target) => target.id)).toEqual(['claude-review'])
  })

  it('retains an empty current group as an explicit routing signal', () => {
    const result = resolveEnsembleUserFanoutTargets({
      text: '@BG run the long checks.',
      participants: ROSTER
    })

    expect(result.targets).toEqual([])
    expect(result.hasParticipantMention).toBe(true)
  })
})
