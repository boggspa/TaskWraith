import type { ChatTranscriptOp } from '../../shared/chatUpdateTransport'
import type {
  AuthoredChatTranscriptMutation,
  ChatTranscriptMutationOperation
} from './ChatRecordMutation'
import type { ChatMessage } from './types'

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
}

/**
 * Small producer-side recorder for the transcript edits the producer is
 * already performing. It knows only the current length and explicit ids; it
 * never receives or indexes the historical message array.
 */
export class ChatTranscriptMutationAuthor {
  private readonly operations: ChatTranscriptMutationOperation[] = []
  private transcriptOps: ChatTranscriptOp[] | null = []
  private changedMessageCount = 0
  private length: number

  constructor(initialLength: number) {
    assertCount(initialLength, 'Initial transcript length')
    this.length = initialLength
  }

  append(messages: ChatMessage[]): void {
    this.splice(this.length, 0, [], messages)
  }

  update(message: ChatMessage): void {
    if (!message?.id) throw new Error('Authored message update requires an id')
    this.operations.push({
      type: 'message_put',
      messageId: message.id,
      message
    })
    this.transcriptOps?.push({ op: 'update', id: message.id, message })
    this.changedMessageCount += 1
  }

  delete(index: number, messageId: string): void {
    this.splice(index, 1, [messageId], [])
  }

  /**
   * Record an exact structural edit. Deletion is always representable by id;
   * insertion is representable on the public wire only at the current tail.
   * A middle insertion remains durable but marks renderer delivery for a
   * one-shot recovery snapshot.
   */
  splice(
    index: number,
    deleteCount: number,
    deletedMessageIds: string[],
    messages: ChatMessage[]
  ): void {
    assertCount(index, 'Transcript splice index')
    assertCount(deleteCount, 'Transcript splice deleteCount')
    if (index > this.length || index + deleteCount > this.length) {
      throw new Error('Authored transcript splice is out of bounds')
    }
    if (deletedMessageIds.length !== deleteCount || deletedMessageIds.some((id) => !id)) {
      throw new Error('Authored transcript splice requires every deleted message id')
    }
    if (messages.some((message) => !message?.id)) {
      throw new Error('Authored transcript splice requires every inserted message id')
    }
    if (deleteCount === 0 && messages.length === 0) return

    this.operations.push({ type: 'messages_splice', index, deleteCount, messages })
    const lengthAfterDelete = this.length - deleteCount
    if (this.transcriptOps) {
      for (const id of deletedMessageIds) this.transcriptOps.push({ op: 'delete', id })
      if (messages.length > 0) {
        if (index === lengthAfterDelete) {
          this.transcriptOps.push({ op: 'append', messages })
        } else {
          this.transcriptOps = null
        }
      }
    }
    this.length = lengthAfterDelete + messages.length
    this.changedMessageCount += deleteCount + messages.length
  }

  finish(): AuthoredChatTranscriptMutation {
    return {
      operations: [...this.operations],
      transcriptOps: this.transcriptOps ? [...this.transcriptOps] : null,
      changedMessageCount: this.changedMessageCount
    }
  }
}
