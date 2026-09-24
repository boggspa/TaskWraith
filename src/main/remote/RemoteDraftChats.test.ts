import { describe, expect, it } from 'vitest'
import type { ActiveGoal, ChatRecord } from '../store/types'
import {
  abandonedRemoteDraftIdsToDelete,
  buildRemoteDraftChat,
  findReusableRemoteDraft,
  isContentlessRemoteDraftChat,
  isRemoteWorkflowDraftChat,
  isUnstartedRemoteDraftChat,
  remoteDraftVariant,
  remoteDraftIdsToDelete
} from './RemoteDraftChats'

const NOW = Date.UTC(2026, 5, 14, 12, 0, 0)

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: 'New Chat',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: NOW - 1000,
    updatedAt: NOW,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

describe('RemoteDraftChats', () => {
  it('marks bridge-created empty chats as unstarted remote drafts', () => {
    const draft = buildRemoteDraftChat({
      id: 'ios-draft',
      now: NOW,
      target: {
        variant: 'workspace',
        provider: 'grok',
        workspaceId: 'ws-1',
        workspacePath: '/repo'
      }
    })

    expect(isUnstartedRemoteDraftChat(draft)).toBe(true)
    expect(draft).toMatchObject({
      appChatId: 'ios-draft',
      provider: 'grok',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      messages: [],
      runs: []
    })
  })

  it('preserves an explicit reusable title when the phone sends only the default', () => {
    const existing = chat({ title: 'My prepared task', threadTitle: { source: 'user' } })
    const reused = buildRemoteDraftChat({
      id: existing.appChatId,
      existing,
      now: NOW,
      target: {
        variant: 'workspace',
        provider: 'codex',
        title: 'New Chat',
        workspaceId: 'ws-1',
        workspacePath: '/repo'
      }
    })
    expect(reused.title).toBe('My prepared task')
    expect(reused.threadTitle).toEqual({ source: 'user' })
  })

  it('marks a new requested remote title as explicit', () => {
    const draft = buildRemoteDraftChat({
      id: 'ios-named',
      now: NOW,
      target: { variant: 'global', provider: 'codex', title: 'Phone-authored task' }
    })
    expect(draft.threadTitle).toEqual({ source: 'user' })
  })

  it('treats old ios-prefixed empty New Chat shells as draft cleanup candidates', () => {
    expect(isUnstartedRemoteDraftChat(chat({ appChatId: 'ios-old' }))).toBe(true)
  })

  it('does not classify blank desktop chats without a draft marker', () => {
    expect(isUnstartedRemoteDraftChat(chat({ appChatId: 'desktop-empty' }))).toBe(false)
  })

  it('does not classify drafts once they have messages, runs, notes, or links', () => {
    const draft = buildRemoteDraftChat({
      id: 'ios-draft',
      now: NOW,
      target: {
        variant: 'workspace',
        provider: 'codex',
        workspaceId: 'ws-1',
        workspacePath: '/repo'
      }
    })

    expect(
      isUnstartedRemoteDraftChat({
        ...draft,
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'hello',
            timestamp: new Date(NOW).toISOString()
          }
        ]
      })
    ).toBe(false)
    expect(
      isUnstartedRemoteDraftChat({
        ...draft,
        runs: [
          {
            runId: 'r1',
            status: 'running',
            startedAt: new Date(NOW).toISOString()
          }
        ]
      })
    ).toBe(false)
    expect(isUnstartedRemoteDraftChat({ ...draft, pinnedNotes: 'keep this' })).toBe(false)
    expect(isUnstartedRemoteDraftChat({ ...draft, parentChatId: 'parent' })).toBe(false)
  })

  it('finds the newest compatible draft for the requested scope', () => {
    const older = buildRemoteDraftChat({
      id: 'ios-old',
      now: NOW - 100,
      target: {
        variant: 'workspace',
        provider: 'codex',
        workspaceId: 'ws-1',
        workspacePath: '/repo'
      }
    })
    const newer = buildRemoteDraftChat({
      id: 'ios-new',
      now: NOW,
      target: {
        variant: 'workspace',
        provider: 'grok',
        workspaceId: 'ws-1',
        workspacePath: '/repo'
      }
    })
    const otherWorkspace = buildRemoteDraftChat({
      id: 'ios-other',
      now: NOW + 100,
      target: {
        variant: 'workspace',
        provider: 'codex',
        workspaceId: 'ws-2',
        workspacePath: '/other'
      }
    })

    expect(
      findReusableRemoteDraft([older, newer, otherWorkspace], {
        variant: 'workspace',
        provider: 'claude',
        workspaceId: 'ws-1',
        workspacePath: '/repo'
      })?.appChatId
    ).toBe('ios-new')
  })

  it('preserves workflow draft intent distinctly from generic workspace drafts', () => {
    const draft = buildRemoteDraftChat({
      id: 'ios-workflow',
      now: NOW,
      target: {
        variant: 'workflow',
        provider: 'codex',
        workspaceId: 'ws-1',
        workspacePath: '/repo'
      }
    })

    expect(draft.title).toBe('New Workflow')
    expect(remoteDraftVariant(draft)).toBe('workflow')
    expect(isRemoteWorkflowDraftChat(draft)).toBe(true)
    expect(
      findReusableRemoteDraft([draft], {
        variant: 'workflow',
        provider: 'claude',
        workspaceId: 'ws-1',
        workspacePath: '/repo'
      })?.appChatId
    ).toBe('ios-workflow')
  })

  it('returns only unstarted remote draft ids for cleanup', () => {
    const keep = buildRemoteDraftChat({
      id: 'ios-keep',
      now: NOW,
      target: { variant: 'global', provider: 'grok' }
    })
    const stale = buildRemoteDraftChat({
      id: 'ios-stale',
      now: NOW - 100,
      target: {
        variant: 'workspace',
        provider: 'codex',
        workspaceId: 'ws-1',
        workspacePath: '/repo'
      }
    })

    expect(
      remoteDraftIdsToDelete([keep, stale, chat({ appChatId: 'desktop-empty' })], 'ios-keep')
    ).toEqual(['ios-stale'])
  })
})

describe('RemoteDraftChats — contentless drafts + abandoned sweep', () => {
  const goal: ActiveGoal = {
    id: 'g1',
    objective: 'steer it',
    status: 'active',
    mode: 'taskwraith_steered',
    provider: 'codex',
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString()
  }

  function draft(extra: Partial<ChatRecord> = {}, now = NOW): ChatRecord {
    return {
      ...buildRemoteDraftChat({
        id: 'ios-draft',
        now,
        target: {
          variant: 'workspace',
          provider: 'codex',
          workspaceId: 'ws-1',
          workspacePath: '/repo'
        }
      }),
      ...extra
    }
  }

  it('classifies a goal/pin/note-dirtied unstarted draft as contentless (strict predicate does not)', () => {
    for (const dirty of [{ activeGoal: goal }, { pinned: true }, { pinnedNotes: 'later' }]) {
      const dirtied = draft(dirty)
      // Strict predicate protects it (so the create-time reap + ownership guard
      // never nuke a real pinned chat) — which is exactly why it would otherwise
      // strand the abandoned draft forever.
      expect(isUnstartedRemoteDraftChat(dirtied)).toBe(false)
      // Loose predicate still sees a contentless draft → reapable / hideable.
      expect(isContentlessRemoteDraftChat(dirtied)).toBe(true)
    }
  })

  it('does not classify real chats, side-chats, or started drafts as contentless', () => {
    expect(isContentlessRemoteDraftChat(chat({ appChatId: 'desktop-empty' }))).toBe(false)
    expect(isContentlessRemoteDraftChat(draft({ parentChatId: 'parent' }))).toBe(false)
    expect(
      isContentlessRemoteDraftChat(
        draft({
          messages: [
            { id: 'm1', role: 'user', content: 'hi', timestamp: new Date(NOW).toISOString() }
          ]
        })
      )
    ).toBe(false)
  })

  it('sweeps only contentless drafts older than the TTL (incl. goal-dirtied), never fresh ones or real chats', () => {
    const TTL = 24 * 60 * 60 * 1000
    const fresh = { ...draft({ activeGoal: goal }, NOW), appChatId: 'ios-fresh' }
    const old = { ...draft({ activeGoal: goal }, NOW - TTL - 1000), appChatId: 'ios-old' }
    const real = chat({ appChatId: 'desktop-empty', createdAt: NOW - TTL - 1000 })
    expect(abandonedRemoteDraftIdsToDelete([fresh, old, real], NOW, TTL)).toEqual(['ios-old'])
  })
})
