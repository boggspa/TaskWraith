import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { createHash, randomUUID } from 'crypto'
import { dirname, join } from 'path'
import {
  parseSignedChannelAgentPost,
  type SignedChannelAgentPost
} from '../../shared/collaboration/ChannelAgentProtocol'
import {
  CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
  parseChannelAgentMessageProof,
  type ChannelAgentMessageProof
} from '../../shared/collaboration/ChannelAgentMessageProof'
import { redactSecrets } from '../../shared/secretRedaction'
import type {
  ChannelAgentPostAuthorityResult,
  VerifyChannelAgentPostAuthorityInput
} from './ChannelAgentAuthorityState'
import {
  ChannelError,
  type AgentChannelMember,
  type ChannelMessageKind,
  type ChannelStore
} from './ChannelStore'

export const CHANNEL_LOG_SCHEMA_VERSION = 3
const LEGACY_AGENT_LOG_SCHEMA_VERSION = 2
export const MAX_CHANNEL_MESSAGE_BYTES = 8_000
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 200
export const MAX_REPLAY_RECORDS = 256
export const MAX_REPLAY_BYTES = 512 * 1024
export const MAX_CHANNEL_LOG_BYTES = 64 * 1024 * 1024

interface ChannelMessageBase {
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

export interface HumanChannelMessage extends ChannelMessageBase {
  kind: 'human.text'
  agentProof?: never
}

export interface AgentChannelMessage extends ChannelMessageBase {
  kind: 'agent.text'
  agentProof: ChannelAgentMessageProof
}

export type ChannelMessage = HumanChannelMessage | AgentChannelMessage

type StoredChannelMessageWithoutChecksum = ChannelMessage & {
  schemaVersion: 1 | typeof LEGACY_AGENT_LOG_SCHEMA_VERSION | typeof CHANNEL_LOG_SCHEMA_VERSION
}

type StoredChannelMessage = StoredChannelMessageWithoutChecksum & {
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
  kind?: Extract<ChannelMessageKind, 'human.text'>
  content: string
  now?: number
}

export interface ChannelAgentAppendInput {
  signedPost: unknown
  now?: number
}

export interface ChannelAppendResult {
  record: ChannelMessage
  deduplicated: boolean
}

export interface ChannelAgentPostAuthorityVerifier {
  verifyPostAuthority(
    channelId: string,
    input: VerifyChannelAgentPostAuthorityInput
  ): ChannelAgentPostAuthorityResult
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function messageChecksum(message: unknown): string {
  return createHash('sha256').update(JSON.stringify(message), 'utf8').digest('hex')
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
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

/** Mandatory default scrubber for every persisted human or signed-agent record. */
export function redactChannelContent(content: string): string {
  return redactSecrets(String(content))
    .replace(/(?:\/Users\/|\/home\/)[^/\s]+(?:\/[^\s]*)?/g, '[redacted-path]')
    .replace(/\/private\/var\/[^\s]+/g, '[redacted-path]')
    .replace(/\/tmp\/[^\s]+/g, '[redacted-path]')
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s]*)*/g, '[redacted-path]')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  if (actual.length !== expected.length) return false
  const keys = new Set(expected)
  return actual.every((key) => keys.has(key))
}

function storedMessage(message: ChannelMessage): StoredChannelMessage {
  const withoutChecksum: StoredChannelMessageWithoutChecksum = {
    schemaVersion: CHANNEL_LOG_SCHEMA_VERSION,
    ...message
  }
  return { ...withoutChecksum, checksum: messageChecksum(withoutChecksum) }
}

function validateHistoricalAgentMember(
  channels: ChannelStore,
  signedPost: SignedChannelAgentPost,
  acceptedAt: number
): void {
  const post = signedPost.post
  const channel = channels.getChannel(post.channelId)
  const member = channels.getMember(post.channelId, post.agentMemberId)
  if (
    !channel ||
    !member ||
    member.kind !== 'agent' ||
    member.agentSeatId !== post.agentSeatId ||
    member.identityPublicKey !== post.agentPublicKeyB64 ||
    member.keyGeneration !== post.keyGeneration ||
    member.joinedAt > post.createdAt ||
    member.joinedAt > acceptedAt ||
    (member.status !== 'active' && member.status !== 'revoked') ||
    (member.status === 'revoked' &&
      (member.revokedAt === undefined || acceptedAt >= member.revokedAt))
  ) {
    throw new ChannelError('recovery_blocked', 'Agent message membership proof is invalid')
  }
}

function validateStoredMessage(
  value: unknown,
  channelId: string,
  expectedSequence: number,
  channels: ChannelStore,
  redactContent: (content: string) => string,
  agentAuthority?: ChannelAgentPostAuthorityVerifier
): ChannelMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChannelError('recovery_blocked', 'Channel log record is malformed')
  }
  const raw = value as Record<string, unknown>
  if (
    (raw.schemaVersion !== 1 &&
      raw.schemaVersion !== LEGACY_AGENT_LOG_SCHEMA_VERSION &&
      raw.schemaVersion !== CHANNEL_LOG_SCHEMA_VERSION) ||
    raw.channelId !== channelId ||
    raw.sequence !== expectedSequence ||
    typeof raw.messageId !== 'string' ||
    !raw.messageId ||
    typeof raw.authorMemberId !== 'string' ||
    !raw.authorMemberId ||
    typeof raw.clientMessageId !== 'string' ||
    !raw.clientMessageId ||
    raw.clientMessageId.length > MAX_CLIENT_MESSAGE_ID_LENGTH ||
    (raw.kind !== 'human.text' && raw.kind !== 'agent.text') ||
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

  if (contentHash(raw.content) !== raw.contentHash) {
    throw new ChannelError('recovery_blocked', 'Channel log content hash does not match')
  }

  if (raw.kind === 'human.text') {
    if (raw.agentProof !== undefined) {
      throw new ChannelError('recovery_blocked', 'Human log record contains agent proof')
    }
    const message: HumanChannelMessage = {
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
    const withoutChecksum: StoredChannelMessageWithoutChecksum = {
      schemaVersion: raw.schemaVersion,
      ...message
    }
    if (messageChecksum(withoutChecksum) !== raw.checksum) {
      throw new ChannelError('recovery_blocked', 'Channel log checksum does not match')
    }
    return message
  }

  if (
    raw.schemaVersion === 1 ||
    !Number.isSafeInteger(raw.acceptedAt) ||
    !isPlainObject(raw.agentProof)
  ) {
    throw new ChannelError('recovery_blocked', 'Agent log proof is malformed')
  }
  let authorityRevision: number
  let signedPost: SignedChannelAgentPost
  let retainedProof: ChannelAgentMessageProof | null = null
  if (raw.schemaVersion === LEGACY_AGENT_LOG_SCHEMA_VERSION) {
    if (
      !hasExactKeys(raw.agentProof, ['authorityRevision', 'signedPost']) ||
      !Number.isSafeInteger(raw.agentProof.authorityRevision) ||
      (raw.agentProof.authorityRevision as number) < 1
    ) {
      throw new ChannelError('recovery_blocked', 'Legacy agent log proof is malformed')
    }
    const parsedPost = parseSignedChannelAgentPost(raw.agentProof.signedPost)
    if (!parsedPost) throw new ChannelError('recovery_blocked', 'Agent log post is malformed')
    authorityRevision = raw.agentProof.authorityRevision as number
    signedPost = parsedPost
  } else {
    retainedProof = parseChannelAgentMessageProof(raw.agentProof)
    if (!retainedProof) {
      throw new ChannelError('recovery_blocked', 'Agent log proof is malformed')
    }
    authorityRevision = retainedProof.authorityRevision
    signedPost = retainedProof.signedPost
  }
  if (
    signedPost.post.channelId !== raw.channelId ||
    signedPost.post.agentMemberId !== raw.authorMemberId ||
    signedPost.post.clientMessageId !== raw.clientMessageId ||
    signedPost.post.kind !== raw.kind ||
    signedPost.post.content !== raw.content ||
    signedPost.post.contentHash !== raw.contentHash ||
    redactContent(raw.content).trim() !== raw.content
  ) {
    throw new ChannelError('recovery_blocked', 'Agent log proof does not match its record')
  }

  const baseMessage = {
    channelId: raw.channelId,
    sequence: raw.sequence,
    messageId: raw.messageId,
    authorMemberId: raw.authorMemberId,
    clientMessageId: raw.clientMessageId,
    kind: 'agent.text' as const,
    content: raw.content,
    acceptedAt: raw.acceptedAt,
    contentHash: raw.contentHash
  }
  const checksumShape = {
    schemaVersion: raw.schemaVersion,
    ...baseMessage,
    agentProof:
      raw.schemaVersion === LEGACY_AGENT_LOG_SCHEMA_VERSION
        ? { authorityRevision, signedPost }
        : retainedProof!
  }
  if (messageChecksum(checksumShape) !== raw.checksum) {
    throw new ChannelError('recovery_blocked', 'Channel log checksum does not match')
  }
  if (!agentAuthority) {
    throw new ChannelError('recovery_blocked', 'Agent message authority is unavailable')
  }
  validateHistoricalAgentMember(channels, signedPost, raw.acceptedAt)
  let authority: ChannelAgentPostAuthorityResult
  try {
    authority = agentAuthority.verifyPostAuthority(raw.channelId, {
      signedPost,
      acceptedAt: raw.acceptedAt,
      authorityRevision
    })
  } catch {
    throw new ChannelError('recovery_blocked', 'Agent message authority could not be verified')
  }
  if (authority.kind !== 'authorized' || authority.authorityRevision !== authorityRevision) {
    throw new ChannelError('recovery_blocked', 'Agent message authority proof is invalid')
  }
  const verifiedProof: ChannelAgentMessageProof = {
    schemaVersion: CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
    authorityRevision: authority.authorityRevision,
    signedDelegation: authority.delegation,
    signedDispatchGrant: authority.dispatchGrant,
    consumption: authority.consumption,
    signedPost: authority.signedPost
  }
  if (retainedProof && !sameJson(retainedProof, verifiedProof)) {
    throw new ChannelError('recovery_blocked', 'Agent message authority evidence does not match')
  }
  return { ...baseMessage, agentProof: verifiedProof }
}

/**
 * The Channel durable log owner. Files are append-only JSONL, one file per channel,
 * and are not provider history or relay state. A complete record is synced
 * before append() returns, while a corrupt interior record blocks recovery.
 */
export class ChannelMessageLog {
  private readonly cache = new Map<string, LoadedChannelLog>()
  private readonly recoveryBlocked = new Set<string>()

  constructor(
    private readonly storageDirectory: string,
    private readonly channels: ChannelStore,
    private readonly redactContent: (content: string) => string = redactChannelContent,
    private readonly agentAuthority?: ChannelAgentPostAuthorityVerifier
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

    const message: HumanChannelMessage = {
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
    const stored = storedMessage(message)
    const serialized = `${JSON.stringify(stored)}\n`
    this.appendDurably(args.channelId, serialized)

    // The log is authoritative. If metadata persistence later lags this
    // committed record, recovery still derives sequence and idempotency here.
    loaded.messages.push(message)
    loaded.idempotency.set(idempotencyKey(member.memberId, clientMessageId), message)
    this.channels.recordCommittedMessage(args.channelId, message.sequence, message.acceptedAt)
    return { record: clone(message), deduplicated: false }
  }

  appendSignedAgentPost(args: ChannelAgentAppendInput): ChannelAppendResult {
    const signedPost = parseSignedChannelAgentPost(args.signedPost)
    if (!signedPost) {
      throw new ChannelError('identity_mismatch', 'Signed agent post is invalid')
    }
    const post = signedPost.post
    const clientMessageId = assertClientMessageId(post.clientMessageId)
    if (clientMessageId !== post.clientMessageId) {
      throw new ChannelError('identity_mismatch', 'Signed agent client message id is not canonical')
    }
    const redacted = this.redactContent(post.content).trim()
    if (redacted !== post.content) {
      throw new ChannelError(
        'protocol_unsupported',
        'Agent content must be redacted before it is signed'
      )
    }

    const loaded = this.load(post.channelId)
    const key = idempotencyKey(post.agentMemberId, clientMessageId)
    const existing = loaded.idempotency.get(key)
    if (existing) {
      if (existing.kind !== 'agent.text' || !sameJson(existing.agentProof.signedPost, signedPost)) {
        throw new ChannelError(
          'idempotency_conflict',
          'agent client message id was already committed with different proof'
        )
      }
      this.channels.reconcileMessageCount(
        post.channelId,
        loaded.messages.length,
        existing.acceptedAt
      )
      return { record: clone(existing), deduplicated: true }
    }

    const acceptedAt = args.now ?? Date.now()
    if (!Number.isSafeInteger(acceptedAt) || acceptedAt < 0) {
      throw new ChannelError('protocol_unsupported', 'Agent acceptance timestamp is invalid')
    }
    this.requireActiveAgentMember(signedPost, acceptedAt)
    if (!this.agentAuthority) {
      throw new ChannelError('protocol_unsupported', 'Agent message authority is unavailable')
    }
    let authority: ChannelAgentPostAuthorityResult
    try {
      authority = this.agentAuthority.verifyPostAuthority(post.channelId, {
        signedPost,
        acceptedAt
      })
    } catch {
      throw new ChannelError('identity_mismatch', 'Agent message authority could not be verified')
    }
    if (
      authority.kind !== 'authorized' ||
      authority.authorityRevision < 1 ||
      !sameJson(authority.signedPost, signedPost)
    ) {
      const revoked =
        authority.kind === 'denied' &&
        (authority.reason === 'authority_expired' || authority.reason === 'authority_revoked')
      throw new ChannelError(
        revoked ? 'revoked' : 'identity_mismatch',
        'Agent message authority is invalid'
      )
    }

    const message: AgentChannelMessage = {
      channelId: post.channelId,
      sequence: loaded.messages.length + 1,
      messageId: randomUUID(),
      authorMemberId: post.agentMemberId,
      clientMessageId,
      kind: 'agent.text',
      content: post.content,
      acceptedAt,
      contentHash: post.contentHash,
      agentProof: {
        schemaVersion: CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
        authorityRevision: authority.authorityRevision,
        signedDelegation: authority.delegation,
        signedDispatchGrant: authority.dispatchGrant,
        consumption: authority.consumption,
        signedPost: authority.signedPost
      }
    }
    const serialized = `${JSON.stringify(storedMessage(message))}\n`
    this.appendDurably(post.channelId, serialized)
    loaded.messages.push(message)
    loaded.idempotency.set(key, message)
    this.channels.recordCommittedMessage(post.channelId, message.sequence, acceptedAt)
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

  getMessageById(channelId: string, messageId: string): ChannelMessage | null {
    if (
      typeof messageId !== 'string' ||
      messageId.length === 0 ||
      messageId.length > 512 ||
      messageId.trim() !== messageId
    ) {
      return null
    }
    for (let index = 0; index < messageId.length; index += 1) {
      const code = messageId.charCodeAt(index)
      if (code < 0x20 || code === 0x7f) return null
    }
    const message = this.load(channelId).messages.find((entry) => entry.messageId === messageId)
    return clone(message ?? null)
  }

  digest(channelId: string): string {
    return createHash('sha256')
      .update(JSON.stringify(this.load(channelId).messages), 'utf8')
      .digest('hex')
  }

  highWaterSequence(channelId: string): number {
    return this.load(channelId).messages.length
  }

  /** Idempotent explicit erasure; callers remove Channel metadata last. */
  purgeChannels(channelIds: readonly string[]): void {
    const filenames = new Set<string>()
    for (const channelId of new Set(channelIds)) {
      this.pathFor(channelId)
      filenames.add(`${channelId}.jsonl`)
      this.cache.delete(channelId)
      this.recoveryBlocked.delete(channelId)
    }
    let deleted = false
    if (existsSync(this.storageDirectory)) {
      for (const entry of readdirSync(this.storageDirectory, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const matches = [...filenames].some(
          (filename) =>
            entry.name === filename ||
            (entry.name.startsWith(`${filename}.`) && entry.name.endsWith('.tmp'))
        )
        if (!matches) continue
        unlinkSync(join(this.storageDirectory, entry.name))
        deleted = true
      }
    }
    if (deleted) this.syncStorageDirectory()
  }

  /** Global erasure removes every file in the dedicated Channel log directory. */
  purgeAll(): void {
    let deleted = false
    if (existsSync(this.storageDirectory)) {
      for (const entry of readdirSync(this.storageDirectory, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        unlinkSync(join(this.storageDirectory, entry.name))
        deleted = true
      }
    }
    this.cache.clear()
    this.recoveryBlocked.clear()
    if (deleted) this.syncStorageDirectory()
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
        messages.push(
          validateStoredMessage(
            JSON.parse(line),
            channelId,
            messages.length + 1,
            this.channels,
            this.redactContent,
            this.agentAuthority
          )
        )
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

  private requireActiveAgentMember(
    signedPost: SignedChannelAgentPost,
    acceptedAt: number
  ): AgentChannelMember {
    const post = signedPost.post
    const channel = this.channels.getChannel(post.channelId)
    if (!channel) throw new ChannelError('not_member', 'Channel was not found')
    if (channel.status !== 'active') throw new ChannelError('channel_closed', 'Channel is closed')
    const member = this.channels.getMember(post.channelId, post.agentMemberId)
    if (!member || member.kind !== 'agent') {
      throw new ChannelError('not_member', 'Agent member was not found')
    }
    if (member.status === 'revoked') {
      throw new ChannelError('revoked', 'Agent member is revoked')
    }
    if (
      member.status !== 'active' ||
      member.agentSeatId !== post.agentSeatId ||
      member.identityPublicKey !== post.agentPublicKeyB64 ||
      member.keyGeneration !== post.keyGeneration ||
      member.joinedAt > post.createdAt ||
      member.joinedAt > acceptedAt
    ) {
      throw new ChannelError('identity_mismatch', 'Agent member binding is invalid')
    }
    return member
  }

  private repairTornTail(path: string, messages: ChannelMessage[]) {
    const records = messages.map((message) => JSON.stringify(storedMessage(message)))
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

  private syncStorageDirectory(): void {
    try {
      const descriptor = openSync(this.storageDirectory, 'r')
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
    } catch {
      // Some platforms do not allow directory fsync. The unlinks still hold.
    }
  }
}
