import { describe, expect, it } from 'vitest'
import type { ChatRecord, EnsembleConfig, EnsembleParticipant } from '../store/types'
import {
  cleanParticipantId,
  deriveProposedPlanTitle,
  parseExplicitProposedPlan,
  PROPOSED_PLAN_BLOCK,
  resolveEnsembleProposedPlanOwnerId,
  shouldStampEnsembleProposedPlan,
  stripExplicitProposedPlanBlock
} from './EnsembleProposedPlanHelpers'

function participant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'p1',
    provider: 'codex',
    role: 'Work',
    enabled: true,
    order: 1,
    instructions: '',
    permissionPresetId: 'default',
    ...overrides
  }
}

function ensemble(overrides: Partial<EnsembleConfig> = {}): EnsembleConfig {
  return {
    enabled: true,
    maxParticipants: 8,
    participants: [
      participant({ id: 'boss', role: 'Boss', order: 1, provider: 'claude' }),
      participant({ id: 'work', role: 'Work4', order: 2, provider: 'grok' })
    ],
    bossmanParticipantId: 'boss',
    ...overrides
  }
}

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    workflowMode: 'plan',
    ensemble: ensemble(),
    ...overrides
  } as ChatRecord
}

describe('deriveProposedPlanTitle', () => {
  it('uses the first markdown heading, stripping trailing hashes', () => {
    expect(deriveProposedPlanTitle('\n## Build it ##\n- later')).toBe('Build it')
  })

  it('strips a leading list marker and skips blank lines', () => {
    expect(deriveProposedPlanTitle('\n\n- Add the hook\n- Second')).toBe('Add the hook')
  })

  it('truncates titles longer than 80 characters', () => {
    const long = 'A'.repeat(81)
    expect(deriveProposedPlanTitle(long)).toBe(`${'A'.repeat(79)}…`)
  })

  it('falls back when the body has no usable text', () => {
    expect(deriveProposedPlanTitle('   \n\t\n')).toBe('Proposed plan')
  })
})

describe('parseExplicitProposedPlan', () => {
  it('returns null when no proposed_plan block is present', () => {
    expect(parseExplicitProposedPlan('plain text')).toBeNull()
  })

  it('returns null when the captured body is empty', () => {
    expect(parseExplicitProposedPlan('<proposed_plan>\n  \n</proposed_plan>')).toBeNull()
  })

  it('parses the first block case-insensitively and derives title from the body', () => {
    const text =
      'Here is the plan.\n<PROPOSED_PLAN>\n## Build it\n- Add the hook\n</proposed_plan>\nReady.'
    expect(parseExplicitProposedPlan(text)).toEqual({
      title: 'Build it',
      body: '## Build it\n- Add the hook'
    })
  })

  it('ignores a second proposed_plan block', () => {
    const text =
      '<proposed_plan>\n## First\n</proposed_plan>\n<proposed_plan>\n## Second\n</proposed_plan>'
    expect(parseExplicitProposedPlan(text)).toEqual({ title: 'First', body: '## First' })
  })

  it('exposes a capturing regex for the inner body', () => {
    const match = '<proposed_plan> inner </proposed_plan>'.match(PROPOSED_PLAN_BLOCK)
    expect(match?.[1].trim()).toBe('inner')
  })
})

describe('stripExplicitProposedPlanBlock', () => {
  it('returns the original text when no block is present', () => {
    expect(stripExplicitProposedPlanBlock('unchanged')).toBe('unchanged')
  })

  it('strips every proposed_plan block and trims leftover whitespace', () => {
    const text =
      'Here is the plan.\n<proposed_plan>\n## Build it\n- Add the hook\n</proposed_plan>\nReady.'
    expect(stripExplicitProposedPlanBlock(text)).toBe('Here is the plan.\n\nReady.')
  })

  it('strips multiple blocks in one pass', () => {
    expect(
      stripExplicitProposedPlanBlock(
        'a <proposed_plan>one</proposed_plan> b <proposed_plan>two</proposed_plan> c'
      )
    ).toBe('a  b  c')
  })
})

describe('cleanParticipantId', () => {
  it('returns null for non-strings, blanks, and whitespace-only values', () => {
    expect(cleanParticipantId(null)).toBeNull()
    expect(cleanParticipantId(undefined)).toBeNull()
    expect(cleanParticipantId('')).toBeNull()
    expect(cleanParticipantId('   ')).toBeNull()
  })

  it('trims a usable participant id', () => {
    expect(cleanParticipantId('  boss  ')).toBe('boss')
  })
})

describe('resolveEnsembleProposedPlanOwnerId', () => {
  it('prefers a configured bossman who is an ordered foreground participant', () => {
    expect(resolveEnsembleProposedPlanOwnerId(ensemble(), 'round-1')).toBe('boss')
  })

  it('skips a background bossman and uses the last ordered foreground seat', () => {
    const config = ensemble({
      participants: [
        participant({
          id: 'boss',
          role: 'Boss',
          order: 1,
          provider: 'claude',
          stageRole: 'background'
        }),
        participant({ id: 'work', role: 'Work4', order: 2, provider: 'grok' }),
        participant({ id: 'review', role: 'Review', order: 3, provider: 'codex' })
      ]
    })
    expect(resolveEnsembleProposedPlanOwnerId(config, 'round-1')).toBe('review')
  })

  it('falls back to the last active-round participant when the round id matches', () => {
    const config = ensemble({
      bossmanParticipantId: 'missing',
      activeRound: {
        roundId: 'round-1',
        status: 'running',
        prompt: 'Plan this.',
        startedAt: '2026-09-05T00:00:00.000Z',
        participants: [
          { participantId: 'early', order: 1 },
          { participantId: 'late', order: 3 },
          { participantId: 'mid', order: 2 }
        ]
      } as EnsembleConfig['activeRound']
    })
    expect(resolveEnsembleProposedPlanOwnerId(config, 'round-1')).toBe('late')
  })

  it('ignores an active round with a different id and uses the last ordered seat', () => {
    const config = ensemble({
      bossmanParticipantId: undefined,
      activeRound: {
        roundId: 'other-round',
        status: 'running',
        prompt: 'Plan this.',
        startedAt: '2026-09-05T00:00:00.000Z',
        participants: [{ participantId: 'stale', order: 9 }]
      } as EnsembleConfig['activeRound']
    })
    expect(resolveEnsembleProposedPlanOwnerId(config, 'round-1')).toBe('work')
  })
})

describe('shouldStampEnsembleProposedPlan', () => {
  it('stamps only in plan workflow for the resolved owner, including trimmed ids', () => {
    const record = chat()
    expect(shouldStampEnsembleProposedPlan(record, 'round-1', 'boss')).toBe(true)
    expect(shouldStampEnsembleProposedPlan(record, 'round-1', '  boss  ')).toBe(true)
    expect(shouldStampEnsembleProposedPlan(record, 'round-1', 'work')).toBe(false)
  })

  it('does not stamp outside plan workflow or without an ensemble', () => {
    expect(
      shouldStampEnsembleProposedPlan(chat({ workflowMode: 'normal' }), 'round-1', 'boss')
    ).toBe(false)
    expect(shouldStampEnsembleProposedPlan(chat({ ensemble: undefined }), 'round-1', 'boss')).toBe(
      false
    )
  })
})
