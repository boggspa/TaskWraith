import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type {
  ChatRecord,
  EnsembleBossmanPoll,
  EnsembleBossmanPollVote
} from '../../../main/store/types'
import { EnsemblePollCard } from './EnsemblePollCard'

function vote(choice: string, voterLabel?: string): EnsembleBossmanPollVote {
  return { choice, voterLabel, votedAt: '2026-09-06T00:00:00.000Z' }
}

function poll(overrides: Partial<EnsembleBossmanPoll> = {}): EnsembleBossmanPoll {
  return {
    id: 'poll-1',
    question: 'Ship the slice?',
    options: ['complete', 'keep-working'],
    status: 'open',
    votes: [],
    createdAt: '2026-09-06T00:00:00.000Z',
    ...overrides
  }
}

function chatWith(activePoll: EnsembleBossmanPoll, ensembleExtras = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    ensemble: {
      bossmanControlState: { polls: [activePoll] },
      ...ensembleExtras
    }
  } as unknown as ChatRecord
}

const noVote = (): void => {}

describe('EnsemblePollCard null cases', () => {
  it('renders nothing when chat is null', () => {
    expect(renderToStaticMarkup(<EnsemblePollCard chat={null} pollId="poll-1" />)).toBe('')
  })

  it('renders nothing when the poll id is unknown', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard chat={chatWith(poll())} pollId="missing" onVote={noVote} />
    )
    expect(html).toBe('')
  })

  it('renders nothing when the chat has no ensemble state', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard chat={{ appChatId: 'chat-1' } as unknown as ChatRecord} pollId="poll-1" />
    )
    expect(html).toBe('')
  })
})

describe('EnsemblePollCard open poll', () => {
  it('renders the question and every option inside a labelled group', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard chat={chatWith(poll())} pollId="poll-1" onVote={noVote} />
    )
    expect(html).toContain('Ship the slice?')
    expect(html).toContain('complete')
    expect(html).toContain('keep-working')
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-label="Poll choices"')
  })

  it('enables voting when the user is included, the poll is open, and no vote exists', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard
        chat={chatWith(poll({ includeUser: true }))}
        pollId="poll-1"
        onVote={noVote}
      />
    )
    expect(html).not.toContain('disabled')
  })

  it('disables voting when the user is not included', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard chat={chatWith(poll())} pollId="poll-1" onVote={noVote} />
    )
    expect(html).toContain('disabled')
  })

  it('marks the user choice selected and names it in the status line', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard
        chat={chatWith(poll({ includeUser: true, votes: [vote('complete', 'User')] }))}
        pollId="poll-1"
        onVote={noVote}
      />
    )
    expect(html).toContain('is-selected')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('Your vote: complete')
    // A cast user vote also disables further voting.
    expect(html).toContain('disabled')
  })

  it('shows the timeout only while the poll is open', () => {
    const open = renderToStaticMarkup(
      <EnsemblePollCard
        chat={chatWith(poll({ timeoutAt: '2026-09-07T00:00:00.000Z' }))}
        pollId="poll-1"
      />
    )
    expect(open).toContain('Open until 2026-09-07T00:00:00.000Z')
    const closed = renderToStaticMarkup(
      <EnsemblePollCard
        chat={chatWith(poll({ status: 'closed', timeoutAt: '2026-09-07T00:00:00.000Z' }))}
        pollId="poll-1"
      />
    )
    expect(closed).not.toContain('Open until')
  })

  it('reports per-option share in labels and the progress bar width', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard
        chat={chatWith(poll({ votes: [vote('complete', 'Work1'), vote('keep-working', 'Work2')] }))}
        pollId="poll-1"
      />
    )
    expect(html).toContain('Vote for complete, 50% of 2')
    expect(html).toContain('width:50%')
    expect(html).toContain('--ensemble-poll-share:50%')
  })

  it('uses the singular vote word for a single ballot', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard
        chat={chatWith(poll({ votes: [vote('complete', 'Work1')] }))}
        pollId="poll-1"
      />
    )
    expect(html).toMatch(/Vote for complete, 100% of 1\s+vote\s*"/)
  })
})

describe('EnsemblePollCard seat accounting', () => {
  it('counts responded seats against the target roster', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard
        chat={chatWith(
          poll({
            targetParticipantIds: ['p1', 'p2'],
            votes: [vote('complete', 'Work1'), vote('complete', 'User')]
          })
        )}
        pollId="poll-1"
      />
    )
    expect(html).toContain('2/2 seats responded')
  })

  it('excludes failed and unreachable seats from the denominator', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard
        chat={chatWith(poll({ targetParticipantIds: ['p1', 'p2', 'p3'] }), {
          activeRound: {
            participants: [
              { participantId: 'p2', status: 'failed' },
              { participantId: 'p3', status: 'unreachable' }
            ]
          }
        })}
        pollId="poll-1"
      />
    )
    expect(html).toContain('0/1 seats responded')
  })

  it('falls back to enabled participants when no target roster is set', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard
        chat={chatWith(poll({ votes: [vote('complete', 'Work1')] }), {
          participants: [
            { id: 'p1', enabled: true },
            { id: 'p2', enabled: false }
          ]
        })}
        pollId="poll-1"
      />
    )
    expect(html).toContain('1/1 seats responded')
  })

  it('falls back to a plain ballot count when no seat roster exists', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard
        chat={chatWith(poll({ votes: [vote('complete', 'Work1')] }))}
        pollId="poll-1"
      />
    )
    expect(html).toContain('1 vote cast')
  })
})

describe('EnsemblePollCard voters and status', () => {
  it('lists participant voters but never the User label', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard
        chat={chatWith(poll({ votes: [vote('complete', 'Work1'), vote('complete', 'User')] }))}
        pollId="poll-1"
      />
    )
    expect(html).toContain('aria-label="complete voters"')
    expect(html).toContain('Work1')
    expect(html).not.toContain('>User<')
  })

  it('truncates long voter lists with a remainder count', () => {
    const votes = Array.from({ length: 10 }, (_, index) => vote('complete', `Seat${index}`))
    const html = renderToStaticMarkup(
      <EnsemblePollCard chat={chatWith(poll({ votes }))} pollId="poll-1" />
    )
    expect(html).toContain('Seat0')
    expect(html).toContain('Seat7')
    expect(html).not.toContain('Seat8')
    expect(html).toContain('+2')
  })

  it('marks closed polls in the status line and disables the buttons', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard chat={chatWith(poll({ status: 'closed' }))} pollId="poll-1" />
    )
    expect(html).toContain('Poll closed')
    expect(html).toContain('disabled')
  })

  it('shows no error alert on first render', () => {
    const html = renderToStaticMarkup(
      <EnsemblePollCard chat={chatWith(poll())} pollId="poll-1" onVote={vi.fn()} />
    )
    expect(html).not.toContain('role="alert"')
  })
})
