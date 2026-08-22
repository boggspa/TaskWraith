import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../main/store/types'
import {
  RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
  buildTailChatTranscriptOps,
  parseRendererChatTranscriptMutationRequest
} from './rendererChatTranscriptMutation'

function message(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: '2026-08-22T00:00:00.000Z'
  }
}

describe('rendererChatTranscriptMutation', () => {
  it('derives only the changed tail message for a streaming update', () => {
    const first = message('first', 'settled')
    const before = message('stream', 'hel')
    const after = { ...before, content: 'hello' }

    expect(buildTailChatTranscriptOps([first, before], [first, after])).toEqual([
      { op: 'update', id: 'stream', message: after }
    ])
  })

  it('derives append and tail-delete operations without walking settled history', () => {
    const first = message('first', 'settled')
    const appended = message('stream', 'hello')

    expect(buildTailChatTranscriptOps([first], [first, appended])).toEqual([
      { op: 'append', messages: [appended] }
    ])
    expect(buildTailChatTranscriptOps([first, appended], [first])).toEqual([
      { op: 'delete', id: 'stream' }
    ])
  })

  it('rejects a middle mutation from the tail-owned lane', () => {
    const first = message('first', 'settled')
    const second = message('second', 'also settled')

    expect(
      buildTailChatTranscriptOps([{ ...first, content: 'changed' }, second], [first, second])
    ).toBeNull()
  })

  it('strictly decodes compact requests', () => {
    const updated = message('stream', 'hello')
    const request = {
      version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
      chatId: 'chat-1',
      baseRevision: 3,
      transcriptOps: [{ op: 'update', id: updated.id, message: updated }]
    }

    expect(parseRendererChatTranscriptMutationRequest(request)).toBe(request)
    expect(
      parseRendererChatTranscriptMutationRequest({
        ...request,
        transcriptOps: [{ op: 'update', id: 'different', message: updated }]
      })
    ).toBeNull()
  })
})
