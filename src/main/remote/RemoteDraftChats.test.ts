import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../store/types'
import {
  buildRemoteDraftChat,
  findReusableRemoteDraft,
  isUnstartedRemoteDraftChat,
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

    expect(remoteDraftIdsToDelete([keep, stale, chat({ appChatId: 'desktop-empty' })], 'ios-keep'))
      .toEqual(['ios-stale'])
  })
})
