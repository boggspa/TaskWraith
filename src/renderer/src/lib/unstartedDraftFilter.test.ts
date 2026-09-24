import { describe, expect, it } from 'vitest'
import {
  findSurvivableUnstartedDraftId,
  isHideableUnstartedDraft,
  type SurvivableDraftChatLike
} from './unstartedDraftFilter'

/** Minimal pristine, never-started "New Chat" record for the draft filter. */
function draft(overrides: Partial<SurvivableDraftChatLike> = {}): SurvivableDraftChatLike {
  return {
    appChatId: 'd1',
    createdAt: 1000,
    title: 'New Chat',
    messages: [],
    ...overrides
  }
}

describe('isHideableUnstartedDraft', () => {
  it('hides a bare pristine draft', () => {
    expect(isHideableUnstartedDraft(draft())).toBe(true)
  })
  it('keeps protected ids visible', () => {
    expect(isHideableUnstartedDraft(draft(), { protectedChatIds: new Set(['d1']) })).toBe(false)
  })
  it('keeps intent-bearing drafts visible (pinned / goal / renamed / todos)', () => {
    expect(isHideableUnstartedDraft(draft({ pinned: true }))).toBe(false)
    expect(isHideableUnstartedDraft(draft({ pinnedNotes: 'note' }))).toBe(false)
    expect(isHideableUnstartedDraft(draft({ activeGoal: {} }))).toBe(false)
    expect(isHideableUnstartedDraft(draft({ title: 'Renamed' }))).toBe(false)
    expect(isHideableUnstartedDraft(draft({ chatTodos: { a: [{}] } }))).toBe(false)
  })
  it('uses title provenance before placeholder spelling', () => {
    expect(
      isHideableUnstartedDraft(
        draft({ title: 'New Chat', threadTitle: { source: 'user' } })
      )
    ).toBe(false)
    expect(
      isHideableUnstartedDraft(
        draft({ title: 'Automatic title', threadTitle: { source: 'prompt-fallback' } })
      )
    ).toBe(true)
  })
  it('keeps started chats visible (messages / runs / child)', () => {
    expect(isHideableUnstartedDraft(draft({ messages: [{ role: 'user' } as never] }))).toBe(false)
    expect(
      isHideableUnstartedDraft(draft({ summaryOnly: true, messageCount: 0, runCount: 1 }))
    ).toBe(false)
    expect(isHideableUnstartedDraft(draft({ parentChatId: 'p' }))).toBe(false)
  })
})

describe('findSurvivableUnstartedDraftId — the "one survivable New Chat" rule', () => {
  it('returns undefined when there are no hideable drafts', () => {
    expect(findSurvivableUnstartedDraftId([])).toBeUndefined()
    expect(
      findSurvivableUnstartedDraftId([draft({ messages: [{ role: 'user' } as never] })])
    ).toBeUndefined()
  })

  it('picks the single hideable draft', () => {
    expect(findSurvivableUnstartedDraftId([draft({ appChatId: 'only' })])).toBe('only')
  })

  it('picks the NEWEST draft by createdAt', () => {
    const chats = [
      draft({ appChatId: 'old', createdAt: 1000 }),
      draft({ appChatId: 'new', createdAt: 3000 }),
      draft({ appChatId: 'mid', createdAt: 2000 })
    ]
    expect(findSurvivableUnstartedDraftId(chats)).toBe('new')
  })

  it('breaks createdAt ties deterministically by appChatId (largest id)', () => {
    const chats = [
      draft({ appChatId: 'a', createdAt: 1000 }),
      draft({ appChatId: 'b', createdAt: 1000 })
    ]
    expect(findSurvivableUnstartedDraftId(chats)).toBe('b')
    expect(findSurvivableUnstartedDraftId([...chats].reverse())).toBe('b')
  })

  it('skips already-protected drafts so the slot is not wasted', () => {
    // The active chat (or a composer-draft chat) stays visible anyway; the
    // survivable slot must fall through to the next newest hideable draft.
    const chats = [
      draft({ appChatId: 'old', createdAt: 1000 }),
      draft({ appChatId: 'active', createdAt: 3000 }),
      draft({ appChatId: 'mid', createdAt: 2000 })
    ]
    expect(findSurvivableUnstartedDraftId(chats, { protectedChatIds: new Set(['active']) })).toBe(
      'mid'
    )
  })

  it('skips intent-bearing drafts (they stay visible on their own)', () => {
    const chats = [
      draft({ appChatId: 'empty', createdAt: 1000 }),
      draft({ appChatId: 'pinned', createdAt: 3000, pinned: true })
    ]
    expect(findSurvivableUnstartedDraftId(chats)).toBe('empty')
  })
})
