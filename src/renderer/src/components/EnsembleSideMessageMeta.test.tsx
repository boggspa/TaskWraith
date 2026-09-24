import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import type { EnsembleSideMessageRoster } from '../../../shared/ensembleSideMessage'
import { EnsembleSideMessageMeta } from './EnsembleSideMessageMeta'

/** The crown and hat paths `ParticipantRoleIcon` draws, so the assertions pin
 *  the actual glyph rather than the fact that some SVG was emitted. */
const CROWN_PATH = 'M4.7 17.8h14.6l1.2-9.1-4.8 3.4-3.7-6-3.7 6-4.8-3.4 1.2 9.1Z'
const HAT_PATH = 'M5.2 15.8c2.3 1.2 11.3 1.2 13.6 0'

function sideMessage(
  metadata: NonNullable<ChatMessage['metadata']>,
  content = '↪ Boss to Capt: standby.'
): ChatMessage {
  return {
    id: 'ensemble-side-message-r1-1-1',
    role: 'system',
    content,
    timestamp: '2026-09-09T01:03:00.000Z',
    metadata: { kind: 'ensembleSideMessage', ...metadata }
  }
}

const roster: EnsembleSideMessageRoster = {
  participants: [
    { id: 'p-boss', order: 1 },
    { id: 'p-capt', order: 2 },
    { id: 'p-work3', order: 3, stageRole: 'worker' },
    { id: 'p-review2', order: 4, stageRole: 'reviewer' },
    { id: 'p-work2', order: 5, stageRole: 'worker' }
  ],
  bossmanParticipantId: 'p-boss',
  captainParticipantIds: ['p-capt']
}

function render(message: ChatMessage): string {
  return renderToStaticMarkup(<EnsembleSideMessageMeta message={message} roster={roster} />)
}

const bossToCapt = sideMessage({
  fromParticipantId: 'p-boss',
  fromProvider: 'codex',
  fromRole: 'Boss',
  toParticipantIds: ['p-capt'],
  toProviders: ['claude'],
  toRoles: ['Capt']
})

describe('EnsembleSideMessageMeta', () => {
  it('names both ends of the route with the seat vocabulary', () => {
    const markup = render(bossToCapt)
    expect(markup).toContain('#1 Boss')
    expect(markup).toContain('#2 Capt')
    expect(markup).toContain('ensemble-side-route-arrow')
    // The whole route, for a reader who cannot see the arrow.
    expect(markup).toContain('aria-label="#1 Boss to #2 Capt"')
  })

  it('tints each end with its OWN provider accent', () => {
    const markup = render(bossToCapt)
    expect(markup).toContain('var(--provider-codex-color, var(--accent))')
    expect(markup).toContain('var(--provider-claude-color, var(--accent))')
  })

  it('gives the sender and recipient the glyph their authority earns', () => {
    const markup = render(bossToCapt)
    expect(markup).toContain(CROWN_PATH)
    expect(markup).toContain(HAT_PATH)
  })

  it('renders the reader as You, ahead of any seat recipients', () => {
    const markup = render(
      sideMessage({
        fromParticipantId: 'p-work3',
        fromProvider: 'kimi',
        fromRole: 'Work3',
        toUser: true,
        toParticipantIds: ['p-capt'],
        toProviders: ['claude'],
        toRoles: ['Capt']
      })
    )
    expect(markup).toContain('ensemble-side-party is-user')
    expect(markup).toContain('aria-label="#3 Work3 to You, #2 Capt"')
    // Ordered inside the row's CONTENT. Both names also occur in that
    // aria-label at the head of the markup, where they are already in route
    // order — comparing over the whole string passes either way round.
    const rendered = markup.slice(markup.indexOf('>') + 1)
    expect(rendered.indexOf('You')).toBeGreaterThan(-1)
    expect(rendered.indexOf('You')).toBeLessThan(rendered.indexOf('#2 Capt'))
  })

  it('elides a fan-out past three recipients and keeps the full route in the title', () => {
    const markup = render(
      sideMessage({
        fromParticipantId: 'p-boss',
        fromProvider: 'codex',
        fromRole: 'Boss',
        toParticipantIds: ['p-capt', 'p-work3', 'p-review2', 'p-work2'],
        toProviders: ['claude', 'kimi', 'cursor', 'codex'],
        toRoles: ['Capt', 'Work3', 'Review2', 'Work2']
      })
    )
    expect(markup).toContain('+1')
    expect(markup).not.toContain('#5 Work2<')
    expect(markup).toContain('title="#1 Boss to #2 Capt, #3 Work3, #4 Review2, #5 Work2"')
  })

  it('names a role-less seat by its provider rather than by its ordinal', () => {
    const markup = render(
      sideMessage({
        fromParticipantId: 'p-boss',
        fromProvider: 'codex',
        fromRole: '',
        toParticipantIds: ['p-capt'],
        toProviders: ['claude'],
        toRoles: ['']
      })
    )
    expect(markup).toContain('Codex')
    expect(markup).toContain('Claude')
    expect(markup).not.toContain('#1')
  })

  it('carries the note time, which the hover-only footer does not', () => {
    expect(render(bossToCapt)).toContain('ensemble-side-route-time')
  })

  it('renders nothing when no route can be recovered, so the caller keeps its own label', () => {
    expect(render(sideMessage({}, 'no prefix at all'))).toBe('')
  })

  it('leaves the recipient separator to CSS instead of injecting one', () => {
    // A middot in the markup would be read aloud and copied out with the
    // names; `.ensemble-side-party + .ensemble-side-party::before` draws it.
    expect(render(bossToCapt)).not.toContain('·')
  })
})
