import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'fs'
import { createHash, randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { redactSecrets } from '../../shared/secretRedaction'
import { ChannelError, type ChannelMessageKind, type ChannelStore } from './ChannelStore'

export const CHANNEL_LOG_SCHEMA_VERSION = 1
export const MAX_CHANNEL_MESSAGE_BYTES = 8_000
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 200
export const MAX_REPLAY_RECORDS = 256
export const MAX_REPLAY_BYTES = 512 * 1024
export const MAX_CHANNEL_LOG_BYTES = 64 * 1024 * 1024

export interface ChannelMessage {
  channelId: string
  sequence: number
  messageId: string
  authorMemberId: string
  clientMessageId: string
  kind: ChannelMessageKind
  content: string
  acceptedAt: number
  contentHash: string
}

interface StoredChannelMessage extends ChannelMessage {
  schemaVersion: typeof CHANNEL_LOG_SCHEMA_VERSION
  checksum: string
}

interface LoadedChannelLog {
  messages: ChannelMessage[]
  idempotency: Map<string, ChannelMessage>
}

export interface ChannelReplay {
  records: ChannelMessage[]
  highWaterSequence: number
}

export interface ChannelAppendInput {
  channelId: string
  principalMemberId: string
  identityPublicKey: string
  roomId?: string
  clientMessageId: string
  kind?: ChannelMessageKind
  content: string
  now?: number
}

export interface ChannelAppendResult {
  record: ChannelMessage
  deduplicated: boolean
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function messageChecksum(message: Omit<StoredChannelMessage, 'checksum'>): string {
  return createHash('sha256').update(JSON.stringify(message), 'utf8').digest('hex')
}

function idempotencyKey(authorMemberId: string, clientMessageId: string): string {
  return `${authorMemberId}\u0000${clientMessageId}`
}

function assertClientMessageId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ChannelError('protocol_unsupported', 'client message id is required')
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_CLIENT_MESSAGE_ID_LENGTH) {
    throw new ChannelError('quota_exceeded', 'client message id is invalid')
  }
  return normalized
}

function normalizeContent(value: unknown, redact: (content: string) => string): string {
  if (typeof value !== 'string') {
    throw new ChannelError('human_only', 'Only human text content is supported')
  }
  const normalized = redact(value).trim()
  if (!normalized) throw new ChannelError('protocol_unsupported', 'Message content is empty')
  if (Buffer.byteLength(normalized, 'utf8') > MAX_CHANNEL_MESSAGE_BYTES) {
    throw new ChannelError('quota_exceeded', 'Message content exceeds the P1 limit')
  }
  return normalized
}

/** Mandatory default scrubber for every persisted P1 human-text record. */
export function redactChannelContent(content: string): string {
  return redactSecrets(String(content))
    .replace(/(?:\/Users\/|\/home\/)[^/\s]+(?:\/[^\s]*)?/g, '[redacted-path]')
    .replace(/\/private\/var\/[^\s]+/g, '[redacted-path]')
    .replace(/\/tmp\/[^\s]+/g, '[redacted-path]')
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s]*)*/g, '[redacted-path]')
}

function validateStoredMessage(
  value: unknown,
  channelId: string,
  expectedSequence: number
): ChannelMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChannelError('recovery_blocked', 'Channel log record is malformed')
  }
  const raw = value as Record<string, unknown>
  if (
    raw.schemaVersion !== CHANNEL_LOG_SCHEMA_VERSION ||
    raw.channelId !== channelId ||
    raw.sequence !== expectedSequence ||
    typeof raw.messageId !== 'string' ||
    !raw.messageId ||
    typeof raw.authorMemberId !== 'string' ||
    !raw.authorMemberId ||
    typeof raw.clientMessageId !== 'string' ||
    !raw.clientMessageId ||
    raw.clientMessageId.length > MAX_CLIENT_MESSAGE_ID_LENGTH ||
    raw.kind !== 'human.text' ||
    typeof raw.content !== 'string' ||
    !raw.content ||
    Buffer.byteLength(raw.content, 'utf8') > MAX_CHANNEL_MESSAGE_BYTES ||
    typeof raw.acceptedAt !== 'number' ||
    !Number.isFinite(raw.acceptedAt) ||
    typeof raw.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.contentHash) ||
    typeof raw.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.checksum)
  ) {
    throw new ChannelError('recovery_blocked', 'Channel log record is invalid')
  }

  const withoutChecksum = {
    schemaVersion: raw.schemaVersion,
    channelId: raw.channelId,
    sequence: raw.sequence,
    messageId: raw.messageId,
    authorMemberId: raw.authorMemberId,
    clientMessageId: raw.clientMessageId,
    kind: raw.kind,
    content: raw.content,
    acceptedAt: raw.acceptedAt,
    contentHash: raw.contentHash
  } as Omit<StoredChannelMessage, 'checksum'>
  if (
    contentHash(raw.content) !== raw.contentHash ||
    messageChecksum(withoutChecksum) !== raw.checksum
  ) {
    throw new ChannelError('recovery_blocked', 'Channel log checksum does not match')
  }
  return {
    channelId: raw.channelId,
    sequence: raw.sequence,
    messageId: raw.messageId,
    authorMemberId: raw.authorMemberId,
    clientMessageId: raw.clientMessageId,
    kind: 'human.text',
    content: raw.content,
    acceptedAt: raw.acceptedAt,
    contentHash: raw.contentHash
  }
}

/**
 * The P1 durable log owner. Files are append-only JSONL, one file per channel,
 * and are not provider history or relay state. A complete record is synced
 * before append() returns, while a corrupt interior record blocks recovery.
 */
export class ChannelMessageLog {
  private readonly cache = new Map<string, LoadedChannelLog>()
  private readonly recoveryBlocked = new Set<string>()

  constructor(
    private readonly storageDirectory: string,
    private readonly channels: ChannelStore,
    private readonly redactContent: (content: string) => string = redactChannelContent
  ) {}

  append(args: ChannelAppendInput): ChannelMessage {
    return this.appendWithResult(args).record
  }

  appendWithResult(args: ChannelAppendInput): ChannelAppendResult {
    if (args.kind !== undefined && args.kind !== 'human.text') {
      throw new ChannelError('human_only', 'Only human.text messages are supported')
    }
    const member = this.channels.validateMemberSession({
      channelId: args.channelId,
      memberId: args.principalMemberId,
      identityPublicKey: args.identityPublicKey,
      ...(args.roomId === undefined ? {} : { roomId: args.roomId })
    })
    const clientMessageId = assertClientMessageId(args.clientMessageId)
    const content = normalizeContent(args.content, this.redactContent)
    const loaded = this.load(args.channelId)
    const existing = loaded.idempotency.get(idempotencyKey(member.memberId, clientMessageId))
    if (existing) {
      if (existing.contentHash !== contentHash(content)) {
        throw new ChannelError(
          'idempotency_conflict',
          'client message id was already committed with different content'
        )
      }
      this.channels.reconcileMessageCount(
        args.channelId,
        loaded.messages.length,
        existing.acceptedAt
      )
      return { record: clone(existing), deduplicated: true }
    }

    const message: ChannelMessage = {
      channelId: args.channelId,
      sequence: loaded.messages.length + 1,
      messageId: randomUUID(),
      authorMemberId: member.memberId,
      clientMessageId,
      kind: 'human.text',
      content,
      acceptedAt: args.now ?? Date.now(),
      contentHash: contentHash(content)
    }
    const stored: StoredChannelMessage = {
      schemaVersion: CHANNEL_LOG_SCHEMA_VERSION,
      ...message,
      checksum: ''
    }
    stored.checksum = messageChecksum({ schemaVersion: CHANNEL_LOG_SCHEMA_VERSION, ...message })
    const serialized = `${JSON.stringify(stored)}\n`
    this.appendDurably(args.channelId, serialized)

    // The log is authoritative. If metadata persistence later lags this
    // committed record, recovery still derives sequence and idempotency here.
    loaded.messages.push(message)
    loaded.idempotency.set(idempotencyKey(member.memberId, clientMessageId), message)
    this.channels.recordCommittedMessage(args.channelId, message.sequence, message.acceptedAt)
    return { record: clone(message), deduplicated: false }
  }

  replay(args: {
    channelId: string
    resumeAfter: number
    maxRecords?: number
    maxBytes?: number
  }): ChannelReplay {
    if (!Number.isInteger(args.resumeAfter) || args.resumeAfter < 0) {
      throw new ChannelError('invalid_cursor', 'Replay cursor is invalid')
    }
    const loaded = this.load(args.channelId)
    const highWaterSequence = loaded.messages.length
    if (args.resumeAfter > highWaterSequence) {
      throw new ChannelError('invalid_cursor', 'Replay cursor is ahead of the host')
    }

    const recordLimit = Math.min(args.maxRecords ?? MAX_REPLAY_RECORDS, MAX_REPLAY_RECORDS)
    const byteLimit = Math.min(args.maxBytes ?? MAX_REPLAY_BYTES, MAX_REPLAY_BYTES)
    if (
      !Number.isInteger(recordLimit) ||
      recordLimit < 1 ||
      !Number.isInteger(byteLimit) ||
      byteLimit < 1
    ) {
      throw new ChannelError('protocol_unsupported', 'Replay limits are invalid')
    }

    const records: ChannelMessage[] = []
    for (const record of loaded.messages.slice(args.resumeAfter)) {
      const recordBytes = Buffer.byteLength(JSON.stringify([record]), 'utf8')
      if (recordBytes > byteLimit) {
        throw new ChannelError('recovery_blocked', 'A retained record cannot fit the replay limit')
      }
      const candidateBytes = Buffer.byteLength(JSON.stringify([...records, record]), 'utf8')
      if (records.length >= recordLimit || candidateBytes > byteLimit) break
      records.push(clone(record))
    }
    return { records, highWaterSequence }
  }

  getMessage(channelId: string, sequence: number): ChannelMessage | null {
    if (!Number.isInteger(sequence) || sequence < 1) return null
    return clone(this.load(channelId).messages[sequence - 1] ?? null)
  }

  digest(channelId: string): string {
    return createHash('sha256')
      .update(JSON.stringify(this.load(channelId).messages), 'utf8')
      .digest('hex')
  }

  highWaterSequence(channelId: string): number {
    return this.load(channelId).messages.length
  }

  private load(channelId: string): LoadedChannelLog {
    if (this.recoveryBlocked.has(channelId)) {
      throw new ChannelError('recovery_blocked', 'Channel log recovery is blocked')
    }
    const cached = this.cache.get(channelId)
    if (cached) return cached

    const path = this.pathFor(channelId)
    if (!existsSync(path)) {
      const channel = this.channels.getChannel(channelId)
      if (!channel) throw new ChannelError('not_member', 'Channel was not found')
      if (channel.messageCount !== 0) {
        this.recoveryBlocked.add(channelId)
        throw new ChannelError('recovery_blocked', 'Channel log is missing durable history')
      }
      const empty = { messages: [], idempotency: new Map<string, ChannelMessage>() }
      this.cache.set(channelId, empty)
      return empty
    }

    let source: string
    try {
      source = readFileSync(path, 'utf8')
    } catch {
      this.recoveryBlocked.add(channelId)
      throw new ChannelError('recovery_blocked', 'Channel log cannot be read')
    }

    const messages: ChannelMessage[] = []
    const lines = source.split('\n')
    const lastNonEmpty = lines.length - (source.endsWith('\n') ? 2 : 1)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line) continue
      try {
        messages.push(validateStoredMessage(JSON.parse(line), channelId, messages.length + 1))
      } catch (error) {
        if (index === lastNonEmpty && !source.endsWith('\n')) {
          // A partial final write was never acknowledged. Retain only the
          // complete prefix; any malformed interior record stays fail-closed.
          this.repairTornTail(path, messages)
          break
        }
        this.recoveryBlocked.add(channelId)
        throw error instanceof ChannelError
          ? error
          : new ChannelError('recovery_blocked', 'Channel log recovery failed')
      }
    }

    const idempotency = new Map<string, ChannelMessage>()
    for (const message of messages) {
      const key = idempotencyKey(message.authorMemberId, message.clientMessageId)
      if (idempotency.has(key)) {
        this.recoveryBlocked.add(channelId)
        throw new ChannelError('recovery_blocked', 'Channel log has duplicate idempotency evidence')
      }
      idempotency.set(key, message)
    }
    const loaded = { messages, idempotency }
    this.cache.set(channelId, loaded)
    try {
      this.channels.reconcileMessageCount(
        channelId,
        messages.length,
        messages.at(-1)?.acceptedAt ?? Date.now()
      )
    } catch (error) {
      this.cache.delete(channelId)
      this.recoveryBlocked.add(channelId)
      throw error
    }
    return loaded
  }

  private appendDurably(channelId: string, serialized: string) {
    const path = this.pathFor(channelId)
    mkdirSync(dirname(path), { recursive: true })
    const currentSize = existsSync(path) ? statSync(path).size : 0
    if (currentSize + Buffer.byteLength(serialized, 'utf8') > MAX_CHANNEL_LOG_BYTES) {
      throw new ChannelError('quota_exceeded', 'Channel log storage limit reached')
    }

    const descriptor = openSync(path, 'a')
    try {
      appendFileSync(descriptor, serialized, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }

  private repairTornTail(path: string, messages: ChannelMessage[]) {
    const records = messages.map((message) => {
      const stored: StoredChannelMessage = {
        schemaVersion: CHANNEL_LOG_SCHEMA_VERSION,
        ...message,
        checksum: ''
      }
      stored.checksum = messageChecksum({ schemaVersion: CHANNEL_LOG_SCHEMA_VERSION, ...message })
      return JSON.stringify(stored)
    })
    const temporary = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporary, records.length ? `${records.join('\n')}\n` : '', 'utf8')
    renameSync(temporary, path)
  }

  private pathFor(channelId: string): string {
    if (!channelId || channelId.includes('/') || channelId.includes('\\')) {
      throw new ChannelError('protocol_unsupported', 'Channel id is invalid')
    }
    return join(this.storageDirectory, `${channelId}.jsonl`)
  }
}
