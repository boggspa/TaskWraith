import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BlackboardEntry, ChatRecord } from '../../../main/store/types'
import {
  ComposerBlackboardButton,
  ComposerBlackboardDeleteButton,
  ComposerBlackboardPostForm,
  BLACKBOARD_POST_SECTION_OPTIONS,
  buildBlackboardGroups
} from './ComposerBlackboardButton'

function entry(
  partial: Partial<BlackboardEntry> & Pick<BlackboardEntry, 'key' | 'value'>
): BlackboardEntry {
  return {
    id: partial.id ?? `${partial.key}-id`,
    chatId: 'chat-1',
    roundId: partial.roundId ?? 'round-1',
    participantId: partial.participantId ?? 'ensemble-grok',
    category: partial.category ?? 'note',
    scope: partial.scope ?? 'session',
    createdAt: partial.createdAt ?? '2026-07-09T10:00:00.000Z',
    ...partial
  }
}

function chatWith(entries: BlackboardEntry[]): ChatRecord {
  // Only the id + ensemble.blackboard paths are read by these components; the
  // cast keeps the fixture minimal without reproducing the whole ChatRecord.
  return { appChatId: 'chat-1', ensemble: { blackboard: entries } } as unknown as ChatRecord
}

describe('buildBlackboardGroups', () => {
  it('drops empty key/value entries and groups by category in canonical order', () => {
    const groups = buildBlackboardGroups([
      entry({ key: 'n1', value: 'a note', category: 'note' }),
      entry({ key: 'd1', value: 'a decision', category: 'decision' }),
      entry({ key: 'blank', value: '   ', category: 'risk' }), // dropped (empty value)
      entry({ key: '   ', value: 'no key', category: 'fact' }), // dropped (empty key)
      entry({ key: 'r1', value: 'a risk', category: 'risk' })
    ])
    // decision before risk before note (canonical order), fact absent (its only
    // entry was dropped).
    expect(groups.map((g) => g.category)).toEqual(['decision', 'risk', 'note'])
  })

  it('returns no groups for an empty blackboard', () => {
    expect(buildBlackboardGroups([])).toEqual([])
  })

  it('sorts within a category newest-first by createdAt', () => {
    const groups = buildBlackboardGroups([
      entry({
        key: 'old',
        value: 'older',
        category: 'fact',
        createdAt: '2026-07-09T09:00:00.000Z'
      }),
      entry({ key: 'new', value: 'newer', category: 'fact', createdAt: '2026-07-09T11:00:00.000Z' })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].entries.map((e) => e.key)).toEqual(['new', 'old'])
  })
})

describe('ComposerBlackboardButton (static render)', () => {
  it('renders a bare hint-pill trigger consistent with the other footer icons', () => {
    const html = renderToStaticMarkup(
      <ComposerBlackboardButton chat={null} provider="grok" composerStyle="obsidian" />
    )
    expect(html).toContain('aria-label="Blackboard"')
    expect(html).toContain('composer-blackboard-trigger')
    expect(html).toContain('composer-hint-pill')
    expect(html).toContain('data-hint-label="Blackboard"')
    expect(html).toContain('data-composer-control="blackboard"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    // Popover is portaled + collapsed by default → not in the static markup.
    expect(html).not.toContain('composer-blackboard-popover')
  })

  it('shows the presence dot only when the blackboard has entries', () => {
    const empty = renderToStaticMarkup(
      <ComposerBlackboardButton chat={chatWith([])} provider="grok" composerStyle="obsidian" />
    )
    expect(empty).not.toContain('composer-blackboard-trigger-dot')

    const filled = renderToStaticMarkup(
      <ComposerBlackboardButton
        chat={chatWith([entry({ key: 'k', value: 'v' })])}
        provider="grok"
        composerStyle="obsidian"
      />
    )
    expect(filled).toContain('composer-blackboard-trigger-dot')
    expect(filled).toContain('Blackboard — 1 entries')
  })

  it('reflects the disabled prop on the trigger', () => {
    const html = renderToStaticMarkup(
      <ComposerBlackboardButton chat={null} provider="grok" composerStyle="obsidian" disabled />
    )
    expect(html).toContain('disabled')
  })
})

describe('ComposerBlackboardPostForm (static render)', () => {
  it('renders the compact user post controls for an Ensemble chat', () => {
    const html = renderToStaticMarkup(<ComposerBlackboardPostForm chat={chatWith([])} />)

    expect(html).toContain('class="composer-blackboard-compose"')
    expect(html).toContain('aria-label="Post to Blackboard"')
    expect(html).toContain('aria-label="Blackboard entry"')
    expect(html).toContain('Post a note to the Blackboard...')
    expect(html).toContain('aria-label="Blackboard section"')
    expect(html).toContain('Post to')
    expect(html).toContain('<option value="note" selected="">Notes</option>')
    expect(html).toContain('type="submit"')
    expect(html).toContain('disabled')
    expect(html).toContain('>Post</button>')
  })

  it('offers every canonical Blackboard section in its shared render order', () => {
    expect(BLACKBOARD_POST_SECTION_OPTIONS).toEqual([
      { category: 'decision', label: 'Decisions' },
      { category: 'fact', label: 'Facts' },
      { category: 'risk', label: 'Risks' },
      { category: 'do-not-repeat', label: 'Do not repeat' },
      { category: 'note', label: 'Notes' }
    ])
  })

  it('stays hidden when no Ensemble chat can accept the post', () => {
    expect(renderToStaticMarkup(<ComposerBlackboardPostForm chat={null} />)).toBe('')
    expect(renderToStaticMarkup(<ComposerBlackboardPostForm chat={chatWith([])} disabled />)).toBe(
      ''
    )
  })
})

describe('ComposerBlackboardDeleteButton (static render)', () => {
  it('uses the existing compact Blackboard delete action', () => {
    const target = entry({ key: 'stale-note', value: 'Remove me' })
    const html = renderToStaticMarkup(
      <ComposerBlackboardDeleteButton
        entry={target}
        deletingEntryId={null}
        onDelete={() => undefined}
      />
    )

    expect(html).toContain('class="pinned-blackboard-entry-delete"')
    expect(html).toContain('aria-label="Delete blackboard entry stale-note"')
    expect(html).toContain('title="Delete blackboard entry"')
    expect(html).not.toContain('disabled')
  })

  it('disables the action while its entry is being deleted', () => {
    const target = entry({ id: 'delete-me', key: 'stale-note', value: 'Remove me' })
    const html = renderToStaticMarkup(
      <ComposerBlackboardDeleteButton
        entry={target}
        deletingEntryId="delete-me"
        onDelete={() => undefined}
      />
    )

    expect(html).toContain('disabled')
    expect(html).toContain('title="Deleting..."')
  })
})
