import { describe, expect, it } from 'vitest'
import {
  findReusableWorkspaceNewChatDraft,
  type WorkspaceNewChatDraftLike
} from './workspaceNewChatDraftPolicy'

function draft(overrides: Partial<WorkspaceNewChatDraftLike> = {}): WorkspaceNewChatDraftLike {
  return {
    appChatId: 'draft-1',
    scope: 'workspace',
    chatKind: 'single',
    workspaceId: 'workspace-1',
    messages: [],
    ...overrides
  }
}

describe('workspace New Chat draft policy', () => {
  it('never reuses a pristine shell for an explicit New Chat action', () => {
    expect(findReusableWorkspaceNewChatDraft([draft()], 'workspace-1', 'user')).toBeUndefined()
  })

  it('reuses a matching pristine shell during cold startup', () => {
    const reusable = draft()
    expect(findReusableWorkspaceNewChatDraft([reusable], 'workspace-1', 'startup')).toBe(reusable)
  })

  it('does not reuse a busy, mismatched, archived, or started startup draft', () => {
    const candidates = [
      draft({ appChatId: 'busy' }),
      draft({ appChatId: 'other-workspace', workspaceId: 'workspace-2' }),
      draft({ appChatId: 'archived', archived: true }),
      draft({ appChatId: 'started', messages: [{ role: 'user' } as never] })
    ]

    expect(
      findReusableWorkspaceNewChatDraft(candidates, 'workspace-1', 'startup', {
        isExcluded: (chatId) => chatId === 'busy'
      })
    ).toBeUndefined()
  })
})
