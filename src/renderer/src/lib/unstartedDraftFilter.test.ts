import { describe, expect, it } from 'vitest'
import {
  isHideableUnstartedDraft,
  type UnstartedDraftChatLike
} from './unstartedDraftFilter'

const draft = (over: Partial<UnstartedDraftChatLike> = {}): UnstartedDraftChatLike => ({
  appChatId: 'chat-1',
  title: 'New Chat',
  messages: [],
  ...over
})

describe('isHideableUnstartedDraft', () => {
  it('hides a pristine, never-started single draft', () => {
    expect(isHideableUnstartedDraft(draft())).toBe(true)
  })

  it('hides a pristine, never-started ensemble draft (default roster)', () => {
    expect(isHideableUnstartedDraft(draft({ title: 'New Ensemble' }))).toBe(true)
  })

  it('keeps a chat with real conversation content', () => {
    expect(isHideableUnstartedDraft(draft({ messages: [{ role: 'user' }] }))).toBe(false)
  })

  it('keeps a summary chat that has runs but no persisted messages (summary-safe)', () => {
    expect(
      isHideableUnstartedDraft(draft({ summaryOnly: true, messageCount: 0, runCount: 1 }))
    ).toBe(false)
  })

  it('hides a summary chat with zero messages AND zero runs', () => {
    expect(
      isHideableUnstartedDraft(draft({ summaryOnly: true, messageCount: 0, runCount: 0 }))
    ).toBe(true)
  })

  it('keeps a sub-thread / linked child chat', () => {
    expect(isHideableUnstartedDraft(draft({ parentChatId: 'parent-1' }))).toBe(false)
  })

  it('keeps a pinned draft (explicit intent)', () => {
    expect(isHideableUnstartedDraft(draft({ pinned: true }))).toBe(false)
  })

  it('keeps a draft with pinned notes', () => {
    expect(isHideableUnstartedDraft(draft({ pinnedNotes: 'remember this' }))).toBe(false)
  })

  it('treats whitespace-only pinned notes as no intent', () => {
    expect(isHideableUnstartedDraft(draft({ pinnedNotes: '   ' }))).toBe(true)
  })

  it('keeps a draft carrying an active goal', () => {
    expect(isHideableUnstartedDraft(draft({ activeGoal: { objective: 'x' } }))).toBe(false)
  })

  it('keeps a renamed draft (title off the create-factory default)', () => {
    expect(isHideableUnstartedDraft(draft({ title: 'My research thread' }))).toBe(false)
  })

  it('keeps a draft with a populated chat-todo lane', () => {
    expect(isHideableUnstartedDraft(draft({ chatTodos: { plan: [{ id: 't1' }] } }))).toBe(false)
  })

  it('ignores empty chat-todo lanes', () => {
    expect(isHideableUnstartedDraft(draft({ chatTodos: { plan: [], review: null } }))).toBe(true)
  })

  it('never hides a protected (active / running / collaborating) chat', () => {
    expect(
      isHideableUnstartedDraft(draft(), { protectedChatIds: new Set(['chat-1']) })
    ).toBe(false)
  })

  it('still hides an unprotected sibling when a different chat is protected', () => {
    expect(
      isHideableUnstartedDraft(draft({ appChatId: 'chat-2' }), {
        protectedChatIds: new Set(['chat-1'])
      })
    ).toBe(true)
  })
})
