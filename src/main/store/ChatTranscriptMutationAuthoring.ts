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

function normalizedRevision(revision: number | undefined): number {
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? revision! : 0
}

/**
 * Per-live-run id index. Seeding is the one recovery scan; subsequent flushes
 * find and update their own rows in O(changed messages), provided the canonical
 * persistence revision still matches.
 */
export class ChatTranscriptMutationIndex {
  private readonly indexById: Map<string, number>
  private length: number
  private revision: number
  private valid = true

  constructor(messages: readonly ChatMessage[], persistenceRevision?: number) {
    this.indexById = new Map<string, number>()
    for (let index = 0; index < messages.length; index += 1) {
      const id = messages[index]?.id
      if (!id || this.indexById.has(id)) {
        throw new Error('Transcript mutation index requires unique message ids')
      }
      this.indexById.set(id, index)
    }
    this.length = messages.length
    this.revision = normalizedRevision(persistenceRevision)
  }

  isCurrent(persistenceRevision: number | undefined, messageCount: number): boolean {
    return (
      this.valid &&
      this.revision === normalizedRevision(persistenceRevision) &&
      this.length === messageCount
    )
  }

  begin(): ChatTranscriptMutationTransaction {
    if (!this.valid) throw new Error('Transcript mutation index is invalid')
    return new ChatTranscriptMutationTransaction(this)
  }

  invalidate(): void {
    this.valid = false
  }

  indexOf(messageId: string): number {
    return this.indexById.get(messageId) ?? -1
  }

  messageCount(): number {
    return this.length
  }

  update(message: ChatMessage): void {
    if (!message?.id || !this.indexById.has(message.id)) {
      throw new Error(`Indexed transcript message ${message?.id || '<missing>'} is absent`)
    }
  }

  splice(
    index: number,
    deleteCount: number,
    deletedMessageIds: string[],
    messages: ChatMessage[]
  ): void {
    for (let offset = 0; offset < deletedMessageIds.length; offset += 1) {
      if (this.indexById.get(deletedMessageIds[offset]) !== index + offset) {
        throw new Error('Indexed transcript deletion does not match canonical order')
      }
    }
    for (const id of deletedMessageIds) this.indexById.delete(id)
    const previousLength = this.length
    const nextLength = previousLength - deleteCount + messages.length
    const survivorStart = index + deleteCount
    const delta = messages.length - deleteCount
    if (delta !== 0 && survivorStart < previousLength) {
      for (const [id, currentIndex] of this.indexById) {
        if (currentIndex >= survivorStart) this.indexById.set(id, currentIndex + delta)
      }
    }
    for (let offset = 0; offset < messages.length; offset += 1) {
      const message = messages[offset]
      if (!message?.id || this.indexById.has(message.id)) {
        throw new Error('Indexed transcript insertion requires unique message ids')
      }
      this.indexById.set(message.id, index + offset)
    }
    this.length = nextLength
  }

  commit(persistenceRevision: number | undefined): void {
    this.revision = normalizedRevision(persistenceRevision)
  }
}

export class ChatTranscriptMutationTransaction {
  private readonly author: ChatTranscriptMutationAuthor
  private closed = false

  constructor(private readonly index: ChatTranscriptMutationIndex) {
    this.author = new ChatTranscriptMutationAuthor(index.messageCount())
  }

  indexOf(messageId: string): number {
    this.assertOpen()
    return this.index.indexOf(messageId)
  }

  update(message: ChatMessage): void {
    this.assertOpen()
    this.index.update(message)
    this.author.update(message)
  }

  append(messages: ChatMessage[]): void {
    this.splice(this.currentLength(), 0, [], messages)
  }

  splice(
    index: number,
    deleteCount: number,
    deletedMessageIds: string[],
    messages: ChatMessage[]
  ): void {
    this.assertOpen()
    this.author.splice(index, deleteCount, deletedMessageIds, messages)
    this.index.splice(index, deleteCount, deletedMessageIds, messages)
  }

  finish(): AuthoredChatTranscriptMutation {
    this.assertOpen()
    return this.author.finish()
  }

  commit(persistenceRevision: number | undefined): void {
    this.assertOpen()
    this.index.commit(persistenceRevision)
    this.closed = true
  }

  abort(): void {
    if (this.closed) return
    this.index.invalidate()
    this.closed = true
  }

  private currentLength(): number {
    return this.index.messageCount()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Transcript mutation transaction is closed')
  }
}
