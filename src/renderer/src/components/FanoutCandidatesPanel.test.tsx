import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { FanoutWorktreeCandidate } from '../../../main/store/types'
import {
  countAwaitingFanoutCandidates,
  fanoutCandidateStatusLabel,
  fanoutCandidateTitle,
  formatFanoutDiffStat,
  groupFanoutCandidates
} from '../lib/fanoutCandidatesModel'
import { FanoutCandidatesView } from './FanoutCandidatesPanel'

function candidate(overrides: Partial<FanoutWorktreeCandidate> = {}): FanoutWorktreeCandidate {
  return {
    schemaVersion: 1,
    candidateId: 'lane-1',
    roundId: 'r1',
    laneId: 'lane-1',
    runId: 'run-1',
    participantId: 'p1',
    participantLabel: 'Builder',
    provider: 'kimi',
    model: 'k3',
    baseWorkspacePath: '/repo',
    worktreePath: '/worktrees/one',
    branch: 'taskwraith/fanout-builder-abc',
    createdAt: '2026-07-25T01:00:00.000Z',
    status: 'settled',
    runStatus: 'completed',
    diffStat: { files: 3, insertions: 42, deletions: 7 },
    ...overrides
  }
}

describe('fanoutCandidatesModel', () => {
  it('groups by adjudication priority and sorts newest first', () => {
    const groups = groupFanoutCandidates([
      candidate({ candidateId: 'old', createdAt: '2026-07-25T00:00:00.000Z' }),
      candidate({ candidateId: 'new', createdAt: '2026-07-25T02:00:00.000Z' }),
      candidate({ candidateId: 'live', status: 'active', runStatus: undefined }),
      candidate({ candidateId: 'won', status: 'promoted' }),
      candidate({ candidateId: 'lost', status: 'discarded' })
    ])
    expect(groups.awaiting.map((entry) => entry.candidateId)).toEqual(['new', 'old'])
    expect(groups.running.map((entry) => entry.candidateId)).toEqual(['live'])
    expect(groups.resolved.map((entry) => entry.candidateId)).toEqual(['won', 'lost'])
  })

  it('labels statuses including failed/stopped settles', () => {
    expect(fanoutCandidateStatusLabel(candidate())).toBe('Ready to review')
    expect(fanoutCandidateStatusLabel(candidate({ runStatus: 'failed' }))).toBe(
      'Ready · run failed'
    )
    expect(fanoutCandidateStatusLabel(candidate({ runStatus: 'cancelled' }))).toBe(
      'Ready · run stopped'
    )
    expect(fanoutCandidateStatusLabel(candidate({ status: 'active', runStatus: undefined }))).toBe(
      'Running'
    )
    expect(fanoutCandidateStatusLabel(candidate({ status: 'promoted' }))).toBe('Promoted')
  })

  it('formats titles and diff stats', () => {
    expect(fanoutCandidateTitle(candidate())).toBe('Builder · k3')
    expect(fanoutCandidateTitle(candidate({ participantLabel: undefined, model: undefined }))).toBe(
      'p1'
    )
    expect(formatFanoutDiffStat(candidate().diffStat)).toBe('3 files · +42 −7')
    expect(formatFanoutDiffStat({ files: 1, insertions: 2, deletions: 0 })).toBe('1 file · +2 −0')
    expect(formatFanoutDiffStat({ files: 0, insertions: 0, deletions: 0 })).toBe('No changes')
    expect(formatFanoutDiffStat(undefined)).toBeNull()
  })

  it('counts only settled candidates as awaiting', () => {
    expect(
      countAwaitingFanoutCandidates([
        candidate(),
        candidate({ candidateId: 'x', status: 'active' }),
        candidate({ candidateId: 'y', status: 'promoted' })
      ])
    ).toBe(1)
  })
})

describe('FanoutCandidatesView', () => {
  const baseProps = {
    loaded: true,
    loadError: null,
    apiAvailable: true,
    busyCandidateId: null,
    actionNotice: null,
    reviewCandidateId: null,
    reviewDiff: null,
    reviewError: null,
    onRefresh: vi.fn(),
    onReview: vi.fn(),
    onPromote: vi.fn(),
    onDiscard: vi.fn()
  }

  it('renders grouped candidates with actions on settled ones only', () => {
    const html = renderToStaticMarkup(
      <FanoutCandidatesView
        {...baseProps}
        groups={groupFanoutCandidates([
          candidate(),
          candidate({
            candidateId: 'live',
            participantLabel: 'Scout',
            status: 'active',
            runStatus: undefined
          })
        ])}
      />
    )
    expect(html).toContain('Awaiting decision')
    expect(html).toContain('Still running')
    expect(html).toContain('Builder · k3')
    expect(html).toContain('3 files · +42 −7')
    expect(html).toContain('Promote')
    expect(html).toContain('Discard')
    expect(html).toContain('Review diff')
    expect(html).toContain('1 awaiting your decision')
    // The running lane gets no resolve actions.
    expect(html.match(/Promote/g)).toHaveLength(1)
  })

  it('renders the empty state with the how-to hint', () => {
    const html = renderToStaticMarkup(
      <FanoutCandidatesView {...baseProps} groups={groupFanoutCandidates([])} />
    )
    expect(html).toContain('No candidates yet')
    expect(html).toContain('isolation=worktree')
  })

  it('surfaces load errors and promote-conflict reasons', () => {
    const errorHtml = renderToStaticMarkup(
      <FanoutCandidatesView
        {...baseProps}
        groups={groupFanoutCandidates([])}
        loadError="Chat is gone."
      />
    )
    expect(errorHtml).toContain('Chat is gone.')

    const reasonHtml = renderToStaticMarkup(
      <FanoutCandidatesView
        {...baseProps}
        groups={groupFanoutCandidates([
          candidate({ reason: 'The candidate patch no longer applies cleanly — drifted.' })
        ])}
      />
    )
    expect(reasonHtml).toContain('no longer applies cleanly')
  })
})
