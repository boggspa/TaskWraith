import { describe, expect, it } from 'vitest'
import {
  findReusablePristineDraft,
  isHideableUnstartedDraft,
  type ReusableDraftChatLike,
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

const reusable = (over: Partial<ReusableDraftChatLike> = {}): ReusableDraftChatLike => ({
  appChatId: 'chat-1',
  scope: 'global',
  chatKind: 'ensemble',
  messages: [],
  ...over
})

describe('findReusablePristineDraft', () => {
  it('reuses a pristine global ensemble draft for a global ensemble create', () => {
    const draftChat = reusable()
    expect(
      findReusablePristineDraft([draftChat], { scope: 'global', chatKind: 'ensemble' })
    ).toBe(draftChat)
  })

  it('returns undefined when only workspace drafts exist for a global create', () => {
    const wsDraft = reusable({ scope: 'workspace', workspaceId: 'ws-1' })
    expect(
      findReusablePristineDraft([wsDraft], { scope: 'global', chatKind: 'ensemble' })
    ).toBeUndefined()
  })

  it('never adopts a single draft for an ensemble create (kind mismatch)', () => {
    const single = reusable({ chatKind: 'single' })
    expect(
      findReusablePristineDraft([single], { scope: 'global', chatKind: 'ensemble' })
    ).toBeUndefined()
  })

  it('never adopts an ensemble draft for a single create (kind mismatch)', () => {
    const ensemble = reusable({ chatKind: 'ensemble' })
    expect(
      findReusablePristineDraft([ensemble], { scope: 'global', chatKind: 'single' })
    ).toBeUndefined()
  })

  it('matches a workspace target only within the same workspace', () => {
    const wsA = reusable({ appChatId: 'a', scope: 'workspace', chatKind: 'ensemble', workspaceId: 'ws-a' })
    const wsB = reusable({ appChatId: 'b', scope: 'workspace', chatKind: 'ensemble', workspaceId: 'ws-b' })
    expect(
      findReusablePristineDraft([wsB, wsA], {
        scope: 'workspace',
        chatKind: 'ensemble',
        workspaceId: 'ws-a'
      })
    ).toBe(wsA)
  })

  it('skips archived drafts', () => {
    const archived = reusable({ archived: true })
    expect(
      findReusablePristineDraft([archived], { scope: 'global', chatKind: 'ensemble' })
    ).toBeUndefined()
  })

  it('skips a started draft (has conversation content)', () => {
    const started = reusable({ messages: [{ role: 'user' }] })
    expect(
      findReusablePristineDraft([started], { scope: 'global', chatKind: 'ensemble' })
    ).toBeUndefined()
  })

  it('skips a summary draft that started a run but persisted no message', () => {
    const startedSummary = reusable({ summaryOnly: true, messageCount: 0, runCount: 1 })
    expect(
      findReusablePristineDraft([startedSummary], { scope: 'global', chatKind: 'ensemble' })
    ).toBeUndefined()
  })

  it('skips a linked-child draft', () => {
    const child = reusable({ parentChatId: 'parent-1' })
    expect(
      findReusablePristineDraft([child], { scope: 'global', chatKind: 'ensemble' })
    ).toBeUndefined()
  })

  it('honors the isExcluded runtime gate (busy / running drafts)', () => {
    const busy = reusable({ appChatId: 'busy-1' })
    expect(
      findReusablePristineDraft([busy], { scope: 'global', chatKind: 'ensemble' }, {
        isExcluded: (id) => id === 'busy-1'
      })
    ).toBeUndefined()
  })

  it('returns the first eligible draft in list order', () => {
    const first = reusable({ appChatId: 'first' })
    const second = reusable({ appChatId: 'second' })
    expect(
      findReusablePristineDraft([first, second], { scope: 'global', chatKind: 'ensemble' })
    ).toBe(first)
  })
})
