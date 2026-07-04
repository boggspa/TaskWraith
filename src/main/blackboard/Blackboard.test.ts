import { describe, expect, it } from 'vitest'
import type { BlackboardEntry } from '../store/types'
import {
  BLACKBOARD_MAX_ENTRIES,
  BLACKBOARD_MAX_STORE_LEN,
  BLACKBOARD_MAX_VALUE_LEN,
  deriveBlackboardFromRoundSummary,
  formatBlackboardForPrompt,
  makeBlackboardEntry,
  markBlackboardEntriesSeen,
  normalizeBlackboardCategory,
  normalizeBlackboardScope,
  pruneBlackboard,
  removeBlackboardEntries,
  selectBlackboardForRound,
  selectBlackboardReadWindow,
  selectUnseenBlackboard,
  upsertBlackboardEntry
} from './Blackboard'

function entry(overrides: Partial<BlackboardEntry> = {}): BlackboardEntry {
  return {
    id: overrides.id ?? 'e1',
    chatId: overrides.chatId ?? 'chat-1',
    roundId: overrides.roundId ?? 'round-1',
    participantId: overrides.participantId ?? 'p1',
    key: overrides.key ?? 'k',
    value: overrides.value ?? 'v',
    category: overrides.category ?? 'note',
    scope: overrides.scope ?? 'session',
    ...(overrides.derivedFrom ? { derivedFrom: overrides.derivedFrom } : {}),
    createdAt: overrides.createdAt ?? '2026-05-31T00:00:00.000Z',
    ...(overrides.seenBy ? { seenBy: overrides.seenBy } : {})
  }
}

describe('normalizeBlackboardCategory', () => {
  it('passes through valid categories', () => {
    expect(normalizeBlackboardCategory('decision')).toBe('decision')
    expect(normalizeBlackboardCategory('risk')).toBe('risk')
    expect(normalizeBlackboardCategory('do-not-repeat')).toBe('do-not-repeat')
  })
  it('falls back to note for junk', () => {
    expect(normalizeBlackboardCategory('nonsense')).toBe('note')
    expect(normalizeBlackboardCategory(undefined)).toBe('note')
    expect(normalizeBlackboardCategory(42)).toBe('note')
  })
})

describe('normalizeBlackboardScope', () => {
  it('passes through valid scopes', () => {
    expect(normalizeBlackboardScope('round')).toBe('round')
    expect(normalizeBlackboardScope('chat')).toBe('chat')
  })
  it('defaults to session for junk', () => {
    expect(normalizeBlackboardScope('forever')).toBe('session')
    expect(normalizeBlackboardScope(null)).toBe('session')
  })
})

describe('makeBlackboardEntry', () => {
  const base = {
    id: 'id-1',
    chatId: 'chat-1',
    roundId: 'round-1',
    participantId: 'p1',
    createdAt: '2026-05-31T00:00:00.000Z'
  }

  it('builds a normalized entry', () => {
    const e = makeBlackboardEntry({ ...base, key: '  topic  ', value: '  hello  ', category: 'risk', scope: 'chat' })
    expect(e).not.toBeNull()
    expect(e).toMatchObject({
      key: 'topic',
      value: 'hello',
      category: 'risk',
      scope: 'chat',
      seenBy: ['p1']
    })
  })

  it('rejects empty key or value (returns null)', () => {
    expect(makeBlackboardEntry({ ...base, key: '   ', value: 'x' })).toBeNull()
    expect(makeBlackboardEntry({ ...base, key: 'x', value: '   ' })).toBeNull()
  })

  it('defaults category=note, scope=session, participant fallback', () => {
    const e = makeBlackboardEntry({ ...base, participantId: '', key: 'k', value: 'v' })
    expect(e).toMatchObject({ category: 'note', scope: 'session', participantId: 'system' })
  })

  it('stores long values beyond the prompt render cap', () => {
    const long = 'x'.repeat(BLACKBOARD_MAX_VALUE_LEN + 50)
    const e = makeBlackboardEntry({ ...base, key: 'k', value: long })
    expect(e!.value).toBe(long)
    expect(e!.value.length).toBeGreaterThan(BLACKBOARD_MAX_VALUE_LEN)
    expect(e!.value.endsWith('…')).toBe(false)
  })

  it('caps stored values at the store limit instead of the prompt render cap', () => {
    const long = 'x'.repeat(BLACKBOARD_MAX_STORE_LEN + 50)
    const e = makeBlackboardEntry({ ...base, key: 'k', value: long })
    expect(e!.value.length).toBeLessThanOrEqual(BLACKBOARD_MAX_STORE_LEN)
    expect(e!.value.length).toBeGreaterThan(BLACKBOARD_MAX_VALUE_LEN)
    expect(e!.value.endsWith('…')).toBe(true)
  })

  it('keeps derivedFrom only when provided', () => {
    expect(makeBlackboardEntry({ ...base, key: 'k', value: 'v' })).not.toHaveProperty('derivedFrom')
    expect(makeBlackboardEntry({ ...base, key: 'k', value: 'v', derivedFrom: 'tool-7' })!.derivedFrom).toBe(
      'tool-7'
    )
  })
})

describe('upsertBlackboardEntry', () => {
  it('appends a fresh entry', () => {
    const out = upsertBlackboardEntry([], entry({ id: 'a' }))
    expect(out).toHaveLength(1)
  })

  it('replaces an entry with the same (participant,key,scope)', () => {
    const first = entry({ id: 'a', participantId: 'p1', key: 'plan', scope: 'session', value: 'old' })
    const second = entry({ id: 'b', participantId: 'p1', key: 'plan', scope: 'session', value: 'new' })
    const out = upsertBlackboardEntry([first], second)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'b', value: 'new' })
  })

  it('does NOT merge when scope differs', () => {
    const a = entry({ id: 'a', participantId: 'p1', key: 'plan', scope: 'session' })
    const b = entry({ id: 'b', participantId: 'p1', key: 'plan', scope: 'chat' })
    expect(upsertBlackboardEntry([a], b)).toHaveLength(2)
  })

  it('does NOT merge across participants', () => {
    const a = entry({ id: 'a', participantId: 'p1', key: 'plan' })
    const b = entry({ id: 'b', participantId: 'p2', key: 'plan' })
    expect(upsertBlackboardEntry([a], b)).toHaveLength(2)
  })

  it('caps at MAX_ENTRIES, dropping the oldest by createdAt', () => {
    let list: BlackboardEntry[] = []
    for (let i = 0; i < BLACKBOARD_MAX_ENTRIES; i++) {
      const n = String(i).padStart(3, '0')
      list = upsertBlackboardEntry(list, entry({ id: `e${n}`, key: `k${n}`, createdAt: `2026-05-31T00:00:00.${n}Z` }))
    }
    expect(list).toHaveLength(BLACKBOARD_MAX_ENTRIES)
    // One more, newest — should evict the oldest (k000).
    list = upsertBlackboardEntry(list, entry({ id: 'newest', key: 'knew', createdAt: '2026-05-31T01:00:00.000Z' }))
    expect(list).toHaveLength(BLACKBOARD_MAX_ENTRIES)
    expect(list.some((e) => e.key === 'k000')).toBe(false)
    expect(list.some((e) => e.key === 'knew')).toBe(true)
  })
})

describe('pruneBlackboard', () => {
  it('drops round-scoped entries from other rounds, keeps current round + session + chat', () => {
    const list = [
      entry({ id: 'r-old', scope: 'round', roundId: 'round-1' }),
      entry({ id: 'r-cur', scope: 'round', roundId: 'round-2' }),
      entry({ id: 's', scope: 'session', roundId: 'round-1' }),
      entry({ id: 'c', scope: 'chat', roundId: 'round-1' })
    ]
    const out = pruneBlackboard(list, 'round-2')
    expect(out.map((e) => e.id).sort()).toEqual(['c', 'r-cur', 's'])
  })
})

describe('selectBlackboardForRound', () => {
  it('hides foreign round-scoped entries but surfaces session/chat', () => {
    const list = [
      entry({ id: 'r-old', scope: 'round', roundId: 'round-1' }),
      entry({ id: 'r-cur', scope: 'round', roundId: 'round-2' }),
      entry({ id: 's', scope: 'session' })
    ]
    expect(selectBlackboardForRound(list, 'round-2').map((e) => e.id).sort()).toEqual(['r-cur', 's'])
  })
})

describe('blackboard seen-by helpers', () => {
  it('filters unseen entries for a participant', () => {
    const list = [
      entry({ id: 'seen', key: 'seen', seenBy: ['p1'] }),
      entry({ id: 'unseen', key: 'unseen', seenBy: ['p2'] }),
      entry({ id: 'legacy', key: 'legacy' })
    ]
    expect(selectUnseenBlackboard(list, 'p1').map((e) => e.id)).toEqual(['unseen', 'legacy'])
  })

  it('marks entries seen without changing the array when nothing changes', () => {
    const list = [
      entry({ id: 'a', key: 'a', seenBy: ['p1'] }),
      entry({ id: 'b', key: 'b', seenBy: [] })
    ]
    const next = markBlackboardEntriesSeen(list, ['b'], 'p1')
    expect(next).not.toBe(list)
    expect(next.find((e) => e.id === 'b')?.seenBy).toEqual(['p1'])
    expect(markBlackboardEntriesSeen(next, ['b'], 'p1')).toBe(next)
  })
})

describe('selectBlackboardReadWindow', () => {
  const list = [
    entry({ id: 'old', key: 'old', category: 'fact', createdAt: '2026-05-31T00:00:00.001Z' }),
    entry({ id: 'mid', key: 'mid', category: 'risk', createdAt: '2026-05-31T00:00:00.002Z', seenBy: ['p1'] }),
    entry({ id: 'new', key: 'new', category: 'risk', createdAt: '2026-05-31T00:00:00.003Z' })
  ]

  it('returns explicit ids and keys without window omission', () => {
    const out = selectBlackboardReadWindow(list, { ids: ['old'], keys: ['new'], last: 1 }, 'p1')
    expect(out.selected.map((e) => e.id)).toEqual(['old', 'new'])
    expect(out.omitted).toBe(0)
  })

  it('filters by category, unseenOnly, and newest window', () => {
    const out = selectBlackboardReadWindow(list, { category: 'risk', unseenOnly: true, last: 1 }, 'p1')
    expect(out.selected.map((e) => e.id)).toEqual(['new'])
    expect(out.omitted).toBe(0)
  })

  it('reports omitted entries outside the first window', () => {
    const out = selectBlackboardReadWindow(list, { first: 2 }, 'p1')
    expect(out.selected.map((e) => e.id)).toEqual(['old', 'mid'])
    expect(out.omitted).toBe(1)
  })
})

describe('removeBlackboardEntries', () => {
  it('removes by key or id and returns the removed entries', () => {
    const list = [entry({ id: 'a', key: 'a' }), entry({ id: 'b', key: 'b' }), entry({ id: 'c', key: 'c' })]
    const out = removeBlackboardEntries(list, { ids: ['a'], keys: ['c'] })
    expect(out.removed.map((e) => e.id).sort()).toEqual(['a', 'c'])
    expect(out.next.map((e) => e.id)).toEqual(['b'])
  })

  it('does not clear the board for an empty selector', () => {
    const list = [entry({ id: 'a', key: 'a' })]
    const out = removeBlackboardEntries(list, {})
    expect(out.next).toBe(list)
    expect(out.removed).toEqual([])
  })

  it('clears a single category when category is the only selector', () => {
    const list = [entry({ id: 'a', category: 'risk' }), entry({ id: 'b', category: 'fact' })]
    const out = removeBlackboardEntries(list, { category: 'risk' })
    expect(out.removed.map((e) => e.id)).toEqual(['a'])
    expect(out.next.map((e) => e.id)).toEqual(['b'])
  })
})

describe('formatBlackboardForPrompt', () => {
  it('returns empty string for no entries', () => {
    expect(formatBlackboardForPrompt([])).toBe('')
  })

  it('groups by category in stable order with author attribution', () => {
    const out = formatBlackboardForPrompt([
      entry({ key: 'naming', value: 'use camelCase', category: 'decision', participantId: 'Codex' }),
      entry({ key: 'db', value: 'sqlite is locked', category: 'risk', participantId: 'Claude' }),
      entry({ key: 'misc', value: 'fyi', category: 'note', participantId: 'Gemini' })
    ])
    expect(out).toContain('Decisions:')
    expect(out).toContain('naming: use camelCase (—Codex)')
    expect(out).toContain('Open risks:')
    expect(out).toContain('db: sqlite is locked (—Claude)')
    // Decisions must render before Open risks (category order).
    expect(out.indexOf('Decisions:')).toBeLessThan(out.indexOf('Open risks:'))
    // Notes render last.
    expect(out.indexOf('Open risks:')).toBeLessThan(out.indexOf('Notes:'))
  })

  it('omits empty category headers', () => {
    const out = formatBlackboardForPrompt([entry({ category: 'fact', key: 'k', value: 'v' })])
    expect(out).toContain('Verified facts:')
    expect(out).not.toContain('Decisions:')
    expect(out).not.toContain('Open risks:')
  })

  it('truncates long values only when rendering the prompt digest', () => {
    const long = `${'x'.repeat(BLACKBOARD_MAX_VALUE_LEN + 200)}tail`
    const e = makeBlackboardEntry({
      id: 'id-1',
      chatId: 'chat-1',
      roundId: 'round-1',
      participantId: 'Codex',
      key: 'long-note',
      value: long,
      category: 'decision',
      scope: 'session',
      createdAt: '2026-05-31T00:00:00.000Z'
    })
    expect(e!.value).toBe(long)

    const out = formatBlackboardForPrompt([e!])
    expect(out).toContain('long-note:')
    expect(out).toContain('… (—Codex)')
    expect(out).not.toContain('tail')
  })
})

describe('deriveBlackboardFromRoundSummary', () => {
  const base = {
    chatId: 'chat-1',
    roundId: 'round-7',
    participantId: 'Codex',
    createdAt: '2026-05-31T00:00:00.000Z',
    makeId: (seq: number) => `id-${seq}`
  }

  const summary = [
    'Round summary:',
    'Decisions: ship the picker pill; use ISO dates',
    'Corrections: GPT-5.2 was mislabelled last round',
    'Open risks: notarization profile may be stale',
    'Next action: run validate:release'
  ].join('\n')

  it('maps each labelled section to a session-scoped entry under a stable key', () => {
    const out = deriveBlackboardFromRoundSummary({ ...base, summary })
    expect(out).toHaveLength(4)
    const byKey = Object.fromEntries(out.map((e) => [e.key, e]))
    expect(byKey['round-decisions']).toMatchObject({
      category: 'decision',
      scope: 'session',
      value: 'ship the picker pill; use ISO dates',
      participantId: 'Codex'
    })
    expect(byKey['round-corrections']).toMatchObject({ category: 'do-not-repeat' })
    expect(byKey['round-open-risks']).toMatchObject({ category: 'risk' })
    expect(byKey['round-next-action']).toMatchObject({ category: 'note' })
  })

  it('stamps provenance + deterministic ids from makeId', () => {
    const out = deriveBlackboardFromRoundSummary({ ...base, summary })
    expect(out[0].id).toBe('id-0')
    expect(out[0].derivedFrom).toBe('round-summary:round-7')
    expect(out.every((e) => e.roundId === 'round-7')).toBe(true)
  })

  it('skips sections that are empty, and returns [] for a blank summary', () => {
    const partial = ['Round summary:', 'Decisions: only this one', 'Open risks:'].join('\n')
    const out = deriveBlackboardFromRoundSummary({ ...base, summary: partial })
    expect(out.map((e) => e.key)).toEqual(['round-decisions'])
    expect(deriveBlackboardFromRoundSummary({ ...base, summary: '' })).toEqual([])
    expect(deriveBlackboardFromRoundSummary({ ...base, summary: '   ' })).toEqual([])
  })

  it('captures multi-line section bodies', () => {
    const multi = [
      'Round summary:',
      'Decisions: first decision',
      'continued onto a second line',
      'Open risks: a risk'
    ].join('\n')
    const out = deriveBlackboardFromRoundSummary({ ...base, summary: multi })
    const decisions = out.find((e) => e.key === 'round-decisions')
    expect(decisions?.value).toBe('first decision continued onto a second line')
  })

  it('round-trips through upsert so a later round replaces the prior derived entries', () => {
    const first = deriveBlackboardFromRoundSummary({ ...base, summary })
    let board = first.reduce((acc, e) => upsertBlackboardEntry(acc, e), [] as ReturnType<typeof entry>[])
    expect(board).toHaveLength(4)
    const round8 = deriveBlackboardFromRoundSummary({
      ...base,
      roundId: 'round-8',
      createdAt: '2026-05-31T01:00:00.000Z',
      summary: ['Round summary:', 'Decisions: new decision', 'Corrections: c', 'Open risks: r', 'Next action: n'].join(
        '\n'
      )
    })
    board = round8.reduce((acc, e) => upsertBlackboardEntry(acc, e), board)
    // Same keys + same author → upsert, not growth.
    expect(board).toHaveLength(4)
    expect(board.find((e) => e.key === 'round-decisions')?.value).toBe('new decision')
  })
})
