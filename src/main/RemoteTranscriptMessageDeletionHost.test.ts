import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRecord } from './store/types'
import {
  handleRemoteTranscriptMessageDeletion,
  type RemoteTranscriptMessageDeletionHostDeps
} from './RemoteTranscriptMessageDeletionHost'

function message(id: string, metadata?: ChatMessage['metadata']): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: id,
    timestamp: '2026-08-03T00:00:00.000Z',
    ...(metadata ? { metadata } : {})
  }
}

function chat(messages: ChatMessage[]): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Thread',
    provider: 'codex',
    workspaceId: 'legacy-workspace',
    messages,
    createdAt: 1,
    updatedAt: 1
  } as ChatRecord
}

function deps(record: ChatRecord): RemoteTranscriptMessageDeletionHostDeps & {
  saveChat: ReturnType<typeof vi.fn<(chat: ChatRecord) => void>>
  broadcastChatUpdated: ReturnType<typeof vi.fn<(chat: ChatRecord) => void>>
  pushRemoteThreadSnapshot: ReturnType<
    typeof vi.fn<(chat: ChatRecord, workspaceId: string) => void>
  >
} {
  return {
    getChat: () => record,
    canonicalWorkspaceId: () => 'workspace-1',
    listPendingQuestionIds: () => [],
    saveChat: vi.fn<(chat: ChatRecord) => void>(),
    broadcastChatUpdated: vi.fn<(chat: ChatRecord) => void>(),
    pushRemoteThreadSnapshot: vi.fn<(chat: ChatRecord, workspaceId: string) => void>(),
    now: () => 99
  }
}

describe('handleRemoteTranscriptMessageDeletion', () => {
  it('persists and broadcasts the canonical updated chat', () => {
    const record = chat([message('a'), message('b')])
    const host = deps(record)

    expect(
      handleRemoteTranscriptMessageDeletion(
        { workspaceId: 'workspace-1', threadId: 'chat-1', messageId: 'a' },
        host
      )
    ).toEqual({ ok: true })

    expect(host.saveChat).toHaveBeenCalledTimes(1)
    const saved = host.saveChat.mock.calls[0][0] as ChatRecord
    expect(saved.messages.map((item) => item.id)).toEqual(['b'])
    expect(saved.updatedAt).toBe(99)
    expect(host.broadcastChatUpdated).toHaveBeenCalledWith(saved)
    expect(host.pushRemoteThreadSnapshot).toHaveBeenCalledWith(saved, 'workspace-1')
  })

  it('fails closed across workspace scope without persistence', () => {
    const host = deps(chat([message('a')]))

    expect(
      handleRemoteTranscriptMessageDeletion(
        { workspaceId: 'other-workspace', threadId: 'chat-1', messageId: 'a' },
        host
      )
    ).toEqual({ ok: false, error: 'Thread does not belong to this workspace' })
    expect(host.saveChat).not.toHaveBeenCalled()
  })

  it('revalidates pending question anchors against the canonical registry', () => {
    const record = chat([
      message('question', {
        kind: 'agentQuestion',
        agentQuestion: { questionId: 'q-1', question: 'Choose?' }
      })
    ])
    const host = deps(record)
    host.listPendingQuestionIds = () => ['q-1']

    expect(
      handleRemoteTranscriptMessageDeletion(
        { workspaceId: 'workspace-1', threadId: 'chat-1', messageId: 'question' },
        host
      )
    ).toEqual({
      ok: false,
      error: 'Answer or dismiss the open prompt before deleting this message.'
    })
    expect(host.saveChat).not.toHaveBeenCalled()
  })

  it('reports missing threads and message identities without side effects', () => {
    const host = deps(chat([]))
    host.getChat = () => null
    expect(
      handleRemoteTranscriptMessageDeletion(
        { workspaceId: 'workspace-1', threadId: 'missing', messageId: 'a' },
        host
      )
    ).toEqual({ ok: false, error: 'Thread not found' })

    host.getChat = () => chat([])
    expect(
      handleRemoteTranscriptMessageDeletion(
        { workspaceId: 'workspace-1', threadId: 'chat-1', messageId: 'missing' },
        host
      )
    ).toEqual({ ok: false, error: 'Message not found' })
    expect(host.saveChat).not.toHaveBeenCalled()
  })
})
