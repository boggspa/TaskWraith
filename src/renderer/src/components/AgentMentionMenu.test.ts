import { describe, expect, it } from 'vitest'
import {
  composerEnsembleGroupMentionCandidates,
  composerMentionParticipantColor,
  filterComposerMentionCandidates,
  type ComposerMentionCandidate
} from './AgentMentionMenu'
import type { EnsembleParticipant } from '../../../main/store/types'

const candidates: ComposerMentionCandidate[] = [
  {
    id: 'agent:1',
    kind: 'agent',
    agentId: '1',
    name: 'Builder',
    detail: 'Claude worker'
  },
  {
    id: 'workspace:src/renderer/App.tsx',
    kind: 'workspace-file',
    name: 'src/renderer/App.tsx',
    path: 'src/renderer/App.tsx',
    detail: 'Workspace file'
  },
  {
    id: 'external:/Users/me/Other Project',
    kind: 'external-grant',
    name: 'Other Project',
    path: '/Users/me/Other Project',
    detail: 'Editable external path',
    access: 'write'
  }
]

describe('filterComposerMentionCandidates', () => {
  it('matches agents, workspace file paths, and external grant paths', () => {
    expect(filterComposerMentionCandidates(candidates, 'build').map((item) => item.id)).toEqual([
      'agent:1'
    ])
    expect(
      filterComposerMentionCandidates(candidates, 'renderer/app').map((item) => item.id)
    ).toEqual(['workspace:src/renderer/App.tsx'])
    expect(
      filterComposerMentionCandidates(candidates, 'other project').map((item) => item.id)
    ).toEqual(['external:/Users/me/Other Project'])
  })

  it('preserves both rows when two same-provider ensemble participants both match', () => {
    // 1.0.4 same-provider ensemble: two Codex participants in the
    // mention menu. The candidate shape uses participant.id in the
    // candidate id so they never collide, and the haystack includes
    // both name (role) and detail (provider · model), so a query of
    // `cod` matches both entries — the user picks the right one
    // explicitly rather than the resolver guessing.
    const ensembleCandidates: ComposerMentionCandidate[] = [
      {
        id: 'participant:codex-brodex',
        kind: 'participant',
        participantId: 'codex-brodex',
        provider: 'codex',
        name: 'Brodex',
        detail: 'Codex · gpt-5.5'
      },
      {
        id: 'participant:codex-chodex',
        kind: 'participant',
        participantId: 'codex-chodex',
        provider: 'codex',
        name: 'Chodex #2',
        detail: 'Codex · gpt-5.4-mini'
      }
    ]
    const matches = filterComposerMentionCandidates(ensembleCandidates, 'cod')
    expect(matches).toHaveLength(2)
    expect(matches.map((item) => item.id)).toEqual([
      'participant:codex-brodex',
      'participant:codex-chodex'
    ])
    expect(matches[0].name).toBe('Brodex')
    expect(matches[1].name).toBe('Chodex #2')
  })

  it('finds provider-neutral group rows by token or stage description', () => {
    const groups = composerEnsembleGroupMentionCandidates([
      {
        id: 'reviewer',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: '',
        order: 1,
        stageRole: 'reviewer'
      } as EnsembleParticipant
    ])

    expect(filterComposerMentionCandidates(groups, 'review').map((item) => item.name)).toEqual([
      '@Reviewers'
    ])
  })
})

describe('composerEnsembleGroupMentionCandidates', () => {
  const seat = (
    id: string,
    order: number,
    stageRole: EnsembleParticipant['stageRole'],
    enabled = true
  ): EnsembleParticipant =>
    ({
      id,
      provider: 'codex',
      enabled,
      role: id,
      instructions: '',
      order,
      stageRole
    }) as EnsembleParticipant

  it('lists @All plus only populated enabled stages in canonical order', () => {
    const groups = composerEnsembleGroupMentionCandidates([
      seat('worker', 1, 'worker'),
      seat('scout-1', 2, 'scout'),
      seat('scout-2', 3, 'scout'),
      seat('reviewer-disabled', 4, 'reviewer', false),
      seat('background', 5, 'background')
    ])

    expect(groups.map((candidate) => candidate.name)).toEqual([
      '@All',
      '@Scouts',
      '@Workers',
      '@BG'
    ])
    expect(groups.find((candidate) => candidate.name === '@Scouts')?.detail).toContain('2 seats')
    expect(groups.every((candidate) => candidate.kind === 'group')).toBe(true)
  })

  it('uses the OS-following accent and keeps the visible token as insertion text', () => {
    const [all] = composerEnsembleGroupMentionCandidates([seat('any', 1, undefined)])

    expect(all).toMatchObject({
      id: 'group:all',
      kind: 'group',
      name: '@All',
      color: 'var(--accent)'
    })
    expect(all).not.toHaveProperty('participantId')
    expect(all).not.toHaveProperty('provider')
    expect(all).not.toHaveProperty('path')
  })

  it('lists configured authority groups with enabled member counts', () => {
    const boss = seat('boss', 1, 'worker')
    const captain = seat('captain', 2, 'reviewer')
    const disabledCaptain = seat('captain-disabled', 3, 'scout', false)
    const groups = composerEnsembleGroupMentionCandidates([boss, captain, disabledCaptain], {
      bossmanParticipantId: boss.id,
      captainParticipantIds: [captain.id, disabledCaptain.id]
    })

    expect(groups.map((candidate) => candidate.name)).toEqual([
      '@All',
      '@Captains',
      '@Management',
      '@Workers',
      '@Reviewers'
    ])
    expect(groups.find((candidate) => candidate.name === '@Captains')?.detail).toContain('1 seat')
    expect(groups.find((candidate) => candidate.name === '@Management')?.detail).toContain(
      '2 seats'
    )
  })

  it('returns no dead group rows when every participant is disabled', () => {
    expect(composerEnsembleGroupMentionCandidates([seat('worker', 1, 'worker', false)])).toEqual([])
  })
})

describe('composerMentionParticipantColor', () => {
  it('uses spoofed Ollama branding colors for ensemble mention rows', () => {
    expect(composerMentionParticipantColor({ provider: 'ollama', model: 'qwen3.5:9b' })).toBe(
      'var(--provider-alibaba-color, var(--accent))'
    )
    expect(composerMentionParticipantColor({ provider: 'ollama', model: 'ornith:35b' })).toBe(
      'var(--provider-deep-reinforce-color, var(--accent))'
    )
    expect(
      composerMentionParticipantColor({ provider: 'ollama', model: 'laguna-xs-2.1:q8_0' })
    ).toBe('var(--provider-poolside-color, var(--accent))')
  })

  it('keeps non-Ollama participants on their provider color', () => {
    expect(composerMentionParticipantColor({ provider: 'codex', model: 'gpt-5.5' })).toBe(
      'var(--provider-codex-color, var(--accent))'
    )
  })
})
