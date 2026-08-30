import { describe, expect, it, vi } from 'vitest'
import { createComposerDraftState, draftMembershipChanged, holdsDraft } from './composerDraftState'

describe('holdsDraft', () => {
  it('treats non-whitespace text as a draft', () => {
    expect(holdsDraft('hi')).toBe(true)
  })

  it('does not light the indicator for empty or whitespace-only text', () => {
    expect(holdsDraft('')).toBe(false)
    expect(holdsDraft('   ')).toBe(false)
    expect(holdsDraft(undefined)).toBe(false)
  })
})

describe('draftMembershipChanged', () => {
  it('is false while text changes within an already-held draft', () => {
    expect(draftMembershipChanged({ a: 'ab' }, { a: 'abc' }, 'a')).toBe(false)
  })

  it('is true when a draft appears or disappears', () => {
    expect(draftMembershipChanged({}, { a: 'a' }, 'a')).toBe(true)
    expect(draftMembershipChanged({ a: 'a' }, {}, 'a')).toBe(true)
  })
})

describe('createComposerDraftState reads', () => {
  it('reads a draft, defaulting to empty for unknown or null chats', () => {
    const state = createComposerDraftState({ a: 'hello' })
    expect(state.getDraft('a')).toBe('hello')
    expect(state.getDraft('missing')).toBe('')
    expect(state.getDraft(null)).toBe('')
    expect(state.getDraft(undefined)).toBe('')
  })

  it('keeps the map sparse so a cleared draft cannot resurrect', () => {
    const state = createComposerDraftState({ a: 'hello' })
    state.setDraft('a', '')
    expect(state.getDraftMap()).toEqual({})
  })

  it('applies an updater against the current value', () => {
    const state = createComposerDraftState({ a: 'ab' })
    state.setDraft('a', (previous) => previous + 'c')
    expect(state.getDraft('a')).toBe('abc')
  })

  it('ignores a write with no chat id', () => {
    const state = createComposerDraftState()
    state.setDraft(null, 'x')
    state.setDraft(undefined, 'x')
    expect(state.getDraftMap()).toEqual({})
  })
})

describe('draft-chat-id set identity (the load-bearing perf contract)', () => {
  it('returns the SAME set reference while typing into an existing draft', () => {
    const state = createComposerDraftState({ a: 'a' })
    const before = state.getDraftChatIds()
    state.setDraft('a', 'ab')
    state.setDraft('a', 'abc')
    expect(state.getDraftChatIds()).toBe(before)
  })

  it('returns a NEW set once a draft appears', () => {
    const state = createComposerDraftState()
    const before = state.getDraftChatIds()
    state.setDraft('a', 'a')
    const after = state.getDraftChatIds()
    expect(after).not.toBe(before)
    expect([...after]).toEqual(['a'])
  })

  it('returns a NEW set once the last character is deleted', () => {
    const state = createComposerDraftState({ a: 'a' })
    const before = state.getDraftChatIds()
    state.setDraft('a', '')
    const after = state.getDraftChatIds()
    expect(after).not.toBe(before)
    expect([...after]).toEqual([])
  })

  it('excludes a whitespace-only draft from the set', () => {
    const state = createComposerDraftState()
    state.setDraft('a', '   ')
    expect([...state.getDraftChatIds()]).toEqual([])
  })
})

describe('subscription grain', () => {
  it('wakes only the subscriber for the chat that changed', () => {
    const state = createComposerDraftState()
    const a = vi.fn()
    const b = vi.fn()
    state.subscribeToChat('a', a)
    state.subscribeToChat('b', b)
    state.setDraft('a', 'typing')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('does NOT wake the draft-id subscriber while typing into an existing draft', () => {
    const state = createComposerDraftState({ a: 'a' })
    const ids = vi.fn()
    state.subscribeToDraftChatIds(ids)
    state.setDraft('a', 'ab')
    state.setDraft('a', 'abc')
    state.setDraft('a', 'abcd')
    expect(ids).not.toHaveBeenCalled()
  })

  it('wakes the draft-id subscriber when membership changes', () => {
    const state = createComposerDraftState()
    const ids = vi.fn()
    state.subscribeToDraftChatIds(ids)
    state.setDraft('a', 'a')
    expect(ids).toHaveBeenCalledTimes(1)
    state.setDraft('a', '')
    expect(ids).toHaveBeenCalledTimes(2)
  })

  it('wakes nobody when the value is unchanged', () => {
    const state = createComposerDraftState({ a: 'same' })
    const chat = vi.fn()
    const ids = vi.fn()
    state.subscribeToChat('a', chat)
    state.subscribeToDraftChatIds(ids)
    state.setDraft('a', 'same')
    expect(chat).not.toHaveBeenCalled()
    expect(ids).not.toHaveBeenCalled()
  })

  it('stops notifying after unsubscribe', () => {
    const state = createComposerDraftState()
    const chat = vi.fn()
    const unsubscribe = state.subscribeToChat('a', chat)
    unsubscribe()
    state.setDraft('a', 'x')
    expect(chat).not.toHaveBeenCalled()
  })

  // A live Set already tolerates DELETION mid-iteration, so an unsubscribe-during-
  // notify test proves nothing about the defensive copy. What the copy actually
  // guarantees is the other direction: a listener added while a notification is
  // in flight must wait for the next change instead of firing in the same pass.
  it('does not notify a chat listener that subscribes during an in-flight notify', () => {
    const state = createComposerDraftState()
    const late = vi.fn()
    state.subscribeToChat('a', () => {
      state.subscribeToChat('a', late)
    })
    state.setDraft('a', 'x')
    expect(late).not.toHaveBeenCalled()
  })

  it('does not notify a draft-id listener that subscribes during an in-flight notify', () => {
    const state = createComposerDraftState()
    const late = vi.fn()
    state.subscribeToDraftChatIds(() => {
      state.subscribeToDraftChatIds(late)
    })
    state.setDraft('a', 'x')
    expect(late).not.toHaveBeenCalled()
  })
})

describe('replaceAll', () => {
  it('notifies chats whose text changed and the id subscriber', () => {
    const state = createComposerDraftState({ a: 'a', b: 'b' })
    const a = vi.fn()
    const b = vi.fn()
    const c = vi.fn()
    const ids = vi.fn()
    state.subscribeToChat('a', a)
    state.subscribeToChat('b', b)
    state.subscribeToChat('c', c)
    state.subscribeToDraftChatIds(ids)
    state.replaceAll({ a: 'a', c: 'c' })
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    expect(c).toHaveBeenCalledTimes(1)
    expect(ids).toHaveBeenCalledTimes(1)
    expect([...state.getDraftChatIds()].sort()).toEqual(['a', 'c'])
  })
})
