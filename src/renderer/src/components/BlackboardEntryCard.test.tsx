import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BlackboardEntry, ChatRecord, EnsembleParticipant } from '../../../main/store/types'
import {
  BlackboardEntryCard,
  BlackboardGroupedList,
  BlackboardParticipantChip,
  BlackboardSeenByRail,
  buildBlackboardGroups,
  formatBlackboardTimestamp,
  isGeneratedBlackboardKey,
  resolveBlackboardAuthor
} from './BlackboardEntryCard'

function entry(
  partial: Partial<BlackboardEntry> & Pick<BlackboardEntry, 'key' | 'value'>
): BlackboardEntry {
  return {
    id: partial.id ?? `${partial.key}-id`,
    chatId: 'chat-1',
    roundId: partial.roundId ?? 'round-1',
    participantId: partial.participantId ?? 'ensemble-participant-1',
    category: partial.category ?? 'note',
    scope: partial.scope ?? 'session',
    createdAt: partial.createdAt ?? '2026-07-09T10:00:00.000Z',
    ...partial
  }
}

function participant(partial: Partial<EnsembleParticipant> & { id: string }): EnsembleParticipant {
  return {
    provider: 'claude',
    enabled: true,
    role: '',
    instructions: '',
    order: 0,
    ...partial
  } as EnsembleParticipant
}

// Only the ensemble roster/leadership paths are read by attribution; the cast
// keeps fixtures minimal without reproducing the whole ChatRecord shape.
function chatWith(ensemble: Partial<NonNullable<ChatRecord['ensemble']>>): ChatRecord {
  return { ensemble } as unknown as ChatRecord
}

const rosterChat = chatWith({
  participants: [
    participant({ id: 'ensemble-participant-1', role: 'Sol', provider: 'claude' }),
    participant({ id: 'ensemble-participant-2', role: '', provider: 'codex' }),
    participant({ id: 'ensemble-participant-3', role: 'Terra', provider: 'grok' })
  ],
  bossmanParticipantId: 'ensemble-participant-1',
  secondInCommandParticipantId: 'ensemble-participant-3'
})

describe('resolveBlackboardAuthor', () => {
  it('resolves a roster participant to its role name and provider hue', () => {
    const author = resolveBlackboardAuthor(rosterChat, 'ensemble-participant-1')
    expect(author.label).toBe('Sol')
    expect(author.hueClass).toBe('claude')
    expect(author.provider).toBe('claude')
    expect(author.isBossman).toBe(true)
    expect(author.isCaptain).toBe(false)
  })

  it('falls back to the provider display name when the role is blank', () => {
    const author = resolveBlackboardAuthor(rosterChat, 'ensemble-participant-2')
    expect(author.label).toBe('Codex')
    expect(author.hueClass).toBe('codex')
  })

  it('marks the captain (but never both marks at once)', () => {
    const author = resolveBlackboardAuthor(rosterChat, 'ensemble-participant-3')
    expect(author.label).toBe('Terra')
    expect(author.isCaptain).toBe(true)
    expect(author.isBossman).toBe(false)
  })

  it('maps the user, synthesizer, and system pseudo-authors', () => {
    expect(resolveBlackboardAuthor(rosterChat, 'user')).toMatchObject({
      label: 'You',
      isUser: true,
      hueClass: 'user'
    })
    expect(resolveBlackboardAuthor(rosterChat, 'synthesizer').label).toBe('Synthesizer')
    expect(resolveBlackboardAuthor(rosterChat, 'system').label).toBe('System')
  })

  it('humanises stale participant ids whose roster record is gone', () => {
    const author = resolveBlackboardAuthor(rosterChat, 'ensemble-participant-9')
    expect(author.label).toBe('Agent 9')
    expect(author.hueClass).toBe('ensemble')
  })

  it('handles a null chat without throwing', () => {
    expect(resolveBlackboardAuthor(null, 'ensemble-participant-1').label).toBe('Agent 1')
  })
})

describe('isGeneratedBlackboardKey', () => {
  it('suppresses auto-minted user/queued note keys but keeps meaningful slugs', () => {
    expect(isGeneratedBlackboardKey('user-note-20260710103458')).toBe(true)
    expect(isGeneratedBlackboardKey('queued-note-1751967000000-ab12')).toBe(true)
    expect(isGeneratedBlackboardKey('five-pill-architecture')).toBe(false)
    expect(isGeneratedBlackboardKey('round-decisions')).toBe(false)
    expect(isGeneratedBlackboardKey('user-note-taking-strategy')).toBe(false)
  })
})

describe('formatBlackboardTimestamp', () => {
  it('formats ISO stamps and returns empty for garbage', () => {
    expect(formatBlackboardTimestamp('2026-07-09T10:00:00.000Z')).not.toBe('')
    expect(formatBlackboardTimestamp('not-a-date')).toBe('')
    expect(formatBlackboardTimestamp(undefined)).toBe('')
  })
})

describe('BlackboardParticipantChip (static render)', () => {
  it('renders a provider-hued chip with the resolved role name', () => {
    const html = renderToStaticMarkup(
      <BlackboardParticipantChip
        chat={rosterChat}
        participantId="ensemble-participant-1"
        size="md"
      />
    )
    expect(html).toContain('provider-claude')
    expect(html).toContain('--blackboard-chip-color:var(--provider-claude-color, var(--accent))')
    expect(html).toContain('>Sol<')
    expect(html).not.toContain('>ensemble-participant-1<')
    // Raw id stays discoverable via the tooltip.
    expect(html).toContain('Sol (ensemble-participant-1)')
  })

  it('marks the user chip and uses an initial instead of a glyph', () => {
    const html = renderToStaticMarkup(
      <BlackboardParticipantChip chat={rosterChat} participantId="user" size="md" />
    )
    expect(html).toContain('is-user')
    expect(html).toContain('blackboard-chip-initial')
    expect(html).toContain('>You<')
  })
})

describe('BlackboardSeenByRail (static render)', () => {
  it('excludes the author chip and renders remaining seers', () => {
    const html = renderToStaticMarkup(
      <BlackboardSeenByRail
        chat={rosterChat}
        entry={entry({
          key: 'k',
          value: 'v',
          participantId: 'ensemble-participant-1',
          seenBy: ['ensemble-participant-1', 'ensemble-participant-3', 'user']
        })}
      />
    )
    expect(html).toContain('>Terra<')
    expect(html).toContain('>You<')
    expect(html).not.toContain('>Sol<')
  })

  it('renders nothing when only the author has seen the entry', () => {
    const html = renderToStaticMarkup(
      <BlackboardSeenByRail
        chat={rosterChat}
        entry={entry({
          key: 'k',
          value: 'v',
          participantId: 'ensemble-participant-1',
          seenBy: ['ensemble-participant-1']
        })}
      />
    )
    expect(html).toBe('')
  })
})

describe('BlackboardEntryCard (static render)', () => {
  it('shows author chip, scope badge, and meaningful key', () => {
    const html = renderToStaticMarkup(
      <BlackboardEntryCard
        chat={rosterChat}
        entry={entry({
          key: 'five-pill-architecture',
          value: 'Exact five main pill buttons.',
          participantId: 'ensemble-participant-1',
          category: 'decision',
          scope: 'round'
        })}
        variant="popover"
      />
    )
    expect(html).toContain('blackboard-cat-decision')
    expect(html).toContain('>Sol<')
    expect(html).toContain('scope-round')
    expect(html).toContain('five-pill-architecture')
    expect(html).toContain('role="listitem"')
  })

  it('suppresses auto-generated keys but keeps the body', () => {
    const html = renderToStaticMarkup(
      <BlackboardEntryCard
        chat={rosterChat}
        entry={entry({
          key: 'user-note-20260710103458',
          value: 'Concurrent streaming session committed.',
          participantId: 'user'
        })}
        variant="panel"
      />
    )
    expect(html).not.toContain('user-note-20260710103458')
    expect(html).toContain('Concurrent streaming session committed.')
    expect(html).not.toContain('role="listitem"')
  })
})

describe('BlackboardGroupedList (static render)', () => {
  it('renders canonical group labels with entry actions wired through', () => {
    const html = renderToStaticMarkup(
      <BlackboardGroupedList
        chat={rosterChat}
        groups={buildBlackboardGroups([
          entry({ key: 'n1', value: 'a note', category: 'note' }),
          entry({ key: 'd1', value: 'a decision', category: 'decision' })
        ])}
        variant="panel"
        renderEntryActions={(target) => <button data-testid={`del-${target.key}`}>x</button>}
      />
    )
    const decisionsAt = html.indexOf('Decisions')
    const notesAt = html.indexOf('Notes')
    expect(decisionsAt).toBeGreaterThan(-1)
    expect(notesAt).toBeGreaterThan(decisionsAt)
    expect(html).toContain('del-n1')
    expect(html).toContain('del-d1')
  })
})
