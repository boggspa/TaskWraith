import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type {
  ChannelIpcAppendInput,
  ChannelIpcAppendResult,
  ChannelIpcAuditEvent,
  ChannelIpcAuditInput,
  ChannelIpcChannel,
  ChannelIpcCloseInput,
  ChannelIpcCreateInput,
  ChannelIpcErrorCode,
  ChannelIpcHumanReview,
  ChannelIpcHumanReviewDecisionInput,
  ChannelIpcHumanReviewInput,
  ChannelIpcInviteResult,
  ChannelIpcIssueInviteInput,
  ChannelIpcMigrationHandoff,
  ChannelIpcMigrationHandoffInvitation,
  ChannelIpcMigrationHandoffInput,
  ChannelIpcMember,
  ChannelIpcMessage,
  ChannelIpcReadInput,
  ChannelIpcReadResult,
  ChannelIpcResult,
  ChannelIpcRevokeMemberInput
} from '../../shared/collaboration/ChannelIpc'
import { copyChannelMemberPresentation } from '../../shared/collaboration/ChannelMemberPresentation'
import { redactSecrets } from '../../shared/secretRedaction'
import { assertSafeChatId } from '../ChatPath'
import type { ChannelAuditEvent } from '../collaboration/ChannelAuditLog'
import {
  MAX_CHANNEL_MESSAGE_BYTES,
  MAX_CLIENT_MESSAGE_ID_LENGTH,
  MAX_REPLAY_BYTES,
  MAX_REPLAY_RECORDS,
  type ChannelAppendResult,
  type ChannelMessage
} from '../collaboration/ChannelMessageLog'
import type {
  ChannelProductionChannelView,
  ChannelProductionHumanReviewView,
  ChannelProductionInviteResult,
  ChannelProductionMemberView,
  ChannelProductionPendingAdmissionView,
  ChannelProductionReadResult,
  ChannelProductionService
} from '../collaboration/ChannelProductionService'
import {
  isPeopleToChannelMigrationHandoffError,
  type PeopleToChannelMigrationHandoffService
} from '../collaboration/PeopleToChannelMigrationHandoffService'
import { ChannelError } from '../collaboration/ChannelStore'
import type { ChatRecord } from '../store/types'

const MAX_IDENTIFIER_LENGTH = 512
const MAX_DISPLAY_NAME_LENGTH = 120
const MAX_CHANNEL_TITLE_LENGTH = 200
const MAX_AUDIT_LIMIT = 1_000
const MAX_MIGRATION_HANDOFF_INVITATIONS = 512
const MIN_INVITE_TTL_MS = 1_000
const MAX_INVITE_TTL_MS = 24 * 60 * 60 * 1_000
const MAX_ERROR_MESSAGE_LENGTH = 240

const HANDLED_CHANNELS = [
  'channels:list',
  'channels:read',
  'channels:audit',
  'channels:create',
  'channels:issue-invite',
  'channels:migration-handoff',
  'channels:append',
  'channels:revoke-member',
  'channels:human-reviews',
  'channels:approve-human-review',
  'channels:deny-human-review',
  'channels:close'
] as const

export type ChannelIpcSenderScope = { kind: 'main' } | { kind: 'chat'; chatId: string }

export interface ChannelHandlersDeps {
  service: Pick<
    ChannelProductionService,
    | 'listChannels'
    | 'readChannel'
    | 'listAudit'
    | 'createChannel'
    | 'issueInvite'
    | 'appendHost'
    | 'revokeMember'
    | 'listHumanReviews'
    | 'approveHumanReview'
    | 'denyHumanReview'
    | 'closeChannel'
  >
  getChat: (chatId: string) => Pick<ChatRecord, 'appChatId' | 'title' | 'archived'> | null
  resolveSenderScope: (event: IpcMainInvokeEvent) => ChannelIpcSenderScope
  /** Optional until the migration bootstrap has constructed its handoff authority. */
  migrationHandoff?: Pick<PeopleToChannelMigrationHandoffService, 'snapshot'>
}

export interface ChannelHandlersRegistration {
  dispose(): void
}

class ChannelIpcBoundaryError extends Error {
  constructor(
    readonly code: Extract<ChannelIpcErrorCode, 'not_authorized' | 'internal_error'>,
    message: string
  ) {
    super(message)
    this.name = 'ChannelIpcBoundaryError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ChannelError('protocol_unsupported', `${label} must be an object`)
  }
  return value
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const known = new Set(allowed)
  const unexpected = Object.keys(value).find((key) => !known.has(key))
  if (unexpected) {
    throw new ChannelError('protocol_unsupported', `${label} contains an unknown field`)
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.includes('\0')
  ) {
    throw new ChannelError('protocol_unsupported', `${label} is invalid`)
  }
  return value
}

function requireChatId(value: unknown): string {
  const chatId = requireIdentifier(value, 'chat id')
  try {
    assertSafeChatId(chatId, 'Channel chat id')
  } catch {
    throw new ChannelError('protocol_unsupported', 'chat id is invalid')
  }
  return chatId
}

function requireDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ChannelError('protocol_unsupported', 'owner display name is required')
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ChannelError('protocol_unsupported', 'owner display name is invalid')
  }
  return normalized
}

function requireSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ChannelError('protocol_unsupported', `${label} is invalid`)
  }
  return Number(value)
}

function optionalSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (value === undefined) return undefined
  return requireSafeInteger(value, label, minimum, maximum)
}

function parseReadInput(value: unknown): ChannelIpcReadInput {
  const input = requireRecord(value, 'Channel read input')
  requireOnlyKeys(
    input,
    ['channelId', 'resumeAfter', 'maxRecords', 'maxBytes'],
    'Channel read input'
  )
  const maxRecords = optionalSafeInteger(input.maxRecords, 'max records', 1, MAX_REPLAY_RECORDS)
  const maxBytes = optionalSafeInteger(input.maxBytes, 'max bytes', 1, MAX_REPLAY_BYTES)
  return {
    channelId: requireIdentifier(input.channelId, 'channel id'),
    resumeAfter: requireSafeInteger(input.resumeAfter, 'resume cursor', 0),
    ...(maxRecords === undefined ? {} : { maxRecords }),
    ...(maxBytes === undefined ? {} : { maxBytes })
  }
}

function parseAuditInput(value: unknown): ChannelIpcAuditInput {
  if (value === undefined) return {}
  const input = requireRecord(value, 'Channel audit input')
  requireOnlyKeys(input, ['channelId', 'limit'], 'Channel audit input')
  const limit = optionalSafeInteger(input.limit, 'audit limit', 1, MAX_AUDIT_LIMIT)
  return {
    ...(input.channelId === undefined
      ? {}
      : { channelId: requireIdentifier(input.channelId, 'channel id') }),
    ...(limit === undefined ? {} : { limit })
  }
}

function parseCreateInput(value: unknown): ChannelIpcCreateInput {
  const input = requireRecord(value, 'Channel create input')
  requireOnlyKeys(input, ['chatId', 'ownerDisplayName'], 'Channel create input')
  return {
    chatId: requireChatId(input.chatId),
    ownerDisplayName: requireDisplayName(input.ownerDisplayName)
  }
}

function parseIssueInviteInput(value: unknown): ChannelIpcIssueInviteInput {
  const input = requireRecord(value, 'Channel invite input')
  requireOnlyKeys(input, ['channelId', 'ttlMs'], 'Channel invite input')
  const ttlMs = optionalSafeInteger(
    input.ttlMs,
    'invite lifetime',
    MIN_INVITE_TTL_MS,
    MAX_INVITE_TTL_MS
  )
  return {
    channelId: requireIdentifier(input.channelId, 'channel id'),
    ...(ttlMs === undefined ? {} : { ttlMs })
  }
}

function parseMigrationHandoffInput(value: unknown): ChannelIpcMigrationHandoffInput {
  const input = requireRecord(value, 'Migrated Channel handoff input')
  requireOnlyKeys(input, ['chatId'], 'Migrated Channel handoff input')
  return { chatId: requireChatId(input.chatId) }
}

function parseAppendInput(value: unknown): ChannelIpcAppendInput {
  const input = requireRecord(value, 'Channel append input')
  requireOnlyKeys(input, ['channelId', 'clientMessageId', 'content'], 'Channel append input')
  const clientMessageId = requireIdentifier(input.clientMessageId, 'client message id')
  if (clientMessageId.length > MAX_CLIENT_MESSAGE_ID_LENGTH) {
    throw new ChannelError('protocol_unsupported', 'client message id is invalid')
  }
  if (
    typeof input.content !== 'string' ||
    !input.content.trim() ||
    Buffer.byteLength(input.content, 'utf8') > MAX_CHANNEL_MESSAGE_BYTES
  ) {
    throw new ChannelError('human_only', 'Channel content must be bounded human text')
  }
  return {
    channelId: requireIdentifier(input.channelId, 'channel id'),
    clientMessageId,
    content: input.content
  }
}

function parseRevokeMemberInput(value: unknown): ChannelIpcRevokeMemberInput {
  const input = requireRecord(value, 'Channel revoke input')
  requireOnlyKeys(input, ['channelId', 'memberId'], 'Channel revoke input')
  return {
    channelId: requireIdentifier(input.channelId, 'channel id'),
    memberId: requireIdentifier(input.memberId, 'member id')
  }
}

function parseHumanReviewInput(value: unknown): ChannelIpcHumanReviewInput {
  const input = requireRecord(value, 'Channel human review input')
  requireOnlyKeys(input, ['channelId'], 'Channel human review input')
  return { channelId: requireIdentifier(input.channelId, 'channel id') }
}

function parseHumanReviewDecisionInput(value: unknown): ChannelIpcHumanReviewDecisionInput {
  const input = requireRecord(value, 'Channel human review decision')
  requireOnlyKeys(input, ['channelId', 'reviewId'], 'Channel human review decision')
  return {
    channelId: requireIdentifier(input.channelId, 'channel id'),
    reviewId: requireIdentifier(input.reviewId, 'human review id')
  }
}

function parseCloseInput(value: unknown): ChannelIpcCloseInput {
  const input = requireRecord(value, 'Channel close input')
  requireOnlyKeys(input, ['channelId'], 'Channel close input')
  return { channelId: requireIdentifier(input.channelId, 'channel id') }
}

function projectChannel(channel: ChannelProductionChannelView): ChannelIpcChannel {
  return {
    channelId: channel.channelId,
    chatId: channel.chatId,
    ownerMemberId: channel.ownerMemberId,
    status: channel.status,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    membershipRevision: channel.membershipRevision,
    messageCount: channel.messageCount,
    ...(channel.reference
      ? { reference: { kind: channel.reference.kind, id: channel.reference.id } }
      : {}),
    display: {
      title: channel.display.title,
      status: channel.display.status,
      memberCount: channel.display.memberCount,
      messageCount: channel.display.messageCount
    },
    availability: channel.availability
  }
}

function projectMember(member: ChannelProductionMemberView): ChannelIpcMember {
  return {
    memberId: member.memberId,
    channelId: member.channelId,
    kind: member.kind,
    displayName: member.displayName,
    status: member.status,
    joinedAt: member.joinedAt,
    ...(member.revokedAt === undefined ? {} : { revokedAt: member.revokedAt }),
    ...(member.presentation
      ? { presentation: copyChannelMemberPresentation(member.presentation) }
      : {})
  }
}

function projectPendingAdmission(
  admission: ChannelProductionPendingAdmissionView
): ChannelIpcReadResult['pendingAdmissions'][number] {
  return {
    memberId: admission.memberId,
    displayName: admission.displayName,
    confirmCode: admission.confirmCode,
    expiresAt: admission.expiresAt
  }
}

function projectMessage(message: ChannelMessage): ChannelIpcMessage {
  return {
    channelId: message.channelId,
    sequence: message.sequence,
    messageId: message.messageId,
    authorMemberId: message.authorMemberId,
    clientMessageId: message.clientMessageId,
    kind: message.kind,
    content: message.content,
    acceptedAt: message.acceptedAt,
    contentHash: message.contentHash
  }
}

function projectRead(result: ChannelProductionReadResult): ChannelIpcReadResult {
  return {
    channel: projectChannel(result.channel),
    members: result.members.map(projectMember),
    pendingAdmissions: result.pendingAdmissions.map(projectPendingAdmission),
    records: result.records.map(projectMessage),
    highWaterSequence: result.highWaterSequence
  }
}

function projectAudit(event: ChannelAuditEvent): ChannelIpcAuditEvent {
  return {
    id: event.id,
    at: event.at,
    kind: event.kind,
    ...(event.channelId === undefined ? {} : { channelId: event.channelId }),
    ...(event.memberId === undefined ? {} : { memberId: event.memberId }),
    ...(event.code === undefined ? {} : { code: event.code }),
    ...(event.contentHash === undefined ? {} : { contentHash: event.contentHash }),
    ...(event.detail === undefined ? {} : { detail: event.detail })
  }
}

function projectInvite(invite: ChannelProductionInviteResult): ChannelIpcInviteResult {
  return {
    channelId: invite.channelId,
    inviteId: invite.inviteId,
    inviteToken: invite.inviteToken,
    roomId: invite.roomId,
    expiresAt: invite.expiresAt,
    relayUrls: [...invite.relayUrls],
    hostRoomOpened: invite.hostRoomOpened
  }
}

function migrationBlocked(message: string): never {
  throw new ChannelError('recovery_blocked', message)
}

function migrationIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.includes('\0')
  ) {
    migrationBlocked('Migrated Channel handoff is invalid')
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      migrationBlocked('Migrated Channel handoff is invalid')
    }
  }
  return value
}

function migrationRecipientLabel(value: unknown): string {
  const label = migrationIdentifier(value)
  if (label.length > MAX_DISPLAY_NAME_LENGTH) {
    migrationBlocked('Migrated Channel handoff is invalid')
  }
  return label
}

function migrationTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    migrationBlocked('Migrated Channel handoff is invalid')
  }
  return Number(value)
}

function projectMigrationHandoffInvite(value: unknown): ChannelIpcInviteResult {
  const input = isRecord(value) ? value : migrationBlocked('Migrated Channel handoff is invalid')
  if (!Array.isArray(input.relayUrls) || input.relayUrls.length > 32) {
    migrationBlocked('Migrated Channel handoff is invalid')
  }
  if (typeof input.hostRoomOpened !== 'boolean') {
    migrationBlocked('Migrated Channel handoff is invalid')
  }
  return {
    channelId: migrationIdentifier(input.channelId),
    inviteId: migrationIdentifier(input.inviteId),
    inviteToken: migrationIdentifier(input.inviteToken),
    roomId: migrationIdentifier(input.roomId),
    expiresAt: migrationTimestamp(input.expiresAt),
    relayUrls: input.relayUrls.map(migrationIdentifier),
    hostRoomOpened: input.hostRoomOpened
  }
}

function projectMigrationHandoff(value: unknown, chatId: string): ChannelIpcMigrationHandoff {
  const snapshot = isRecord(value) ? value : migrationBlocked('Migrated Channel handoff is invalid')
  if (
    !Array.isArray(snapshot.invitations) ||
    snapshot.invitations.length > MAX_MIGRATION_HANDOFF_INVITATIONS
  ) {
    migrationBlocked('Migrated Channel handoff is invalid')
  }
  const retiredInvitationCount = migrationTimestamp(snapshot.retiredInvitationCount)
  const relayUnavailableInvitationCount = migrationTimestamp(
    snapshot.relayUnavailableInvitationCount
  )
  if (retiredInvitationCount > MAX_MIGRATION_HANDOFF_INVITATIONS) {
    migrationBlocked('Migrated Channel handoff is invalid')
  }

  const invitations = snapshot.invitations.map((candidate) => {
    const input = isRecord(candidate)
      ? candidate
      : migrationBlocked('Migrated Channel handoff is invalid')
    let projectedChatId: string
    try {
      projectedChatId = requireChatId(input.chatId)
    } catch {
      return migrationBlocked('Migrated Channel handoff is invalid')
    }
    if (projectedChatId !== chatId) migrationBlocked('Migrated Channel handoff scope is invalid')
    if (
      (input.purpose !== 'pending-collaborator' && input.purpose !== 'open-invite') ||
      (input.status !== 'ready' && input.status !== 'relay_unavailable')
    ) {
      migrationBlocked('Migrated Channel handoff is invalid')
    }
    const channelId = migrationIdentifier(input.channelId)
    const purpose: ChannelIpcMigrationHandoffInvitation['purpose'] = input.purpose
    const status: ChannelIpcMigrationHandoffInvitation['status'] = input.status
    const recipientLabel = migrationRecipientLabel(input.recipientLabel)
    const expiresAt = migrationTimestamp(input.expiresAt)
    const invite = input.invite === null ? null : projectMigrationHandoffInvite(input.invite)
    if (
      (status === 'ready' && (!invite || invite.relayUrls.length === 0)) ||
      (status === 'relay_unavailable' && invite !== null) ||
      (invite && (invite.channelId !== channelId || invite.expiresAt !== expiresAt))
    ) {
      migrationBlocked('Migrated Channel handoff is invalid')
    }
    return { channelId, purpose, recipientLabel, expiresAt, status, invite }
  })
  if (
    relayUnavailableInvitationCount !==
    invitations.filter((invitation) => invitation.status === 'relay_unavailable').length
  ) {
    migrationBlocked('Migrated Channel handoff is invalid')
  }
  return { invitations, retiredInvitationCount, relayUnavailableInvitationCount }
}

function projectAppend(result: ChannelAppendResult): ChannelIpcAppendResult {
  return { record: projectMessage(result.record), deduplicated: result.deduplicated }
}

function projectHumanReview(review: ChannelProductionHumanReviewView): ChannelIpcHumanReview {
  if (review.state !== 'queued' && review.state !== 'approved') {
    throw new ChannelError('protocol_unsupported', 'Channel human review is no longer pending')
  }
  return {
    reviewId: review.reviewId,
    channelId: review.channelId,
    memberId: review.memberId,
    displayName: review.displayName,
    content: review.content,
    contentBytes: review.contentBytes,
    state: review.state,
    enqueuedAt: review.enqueuedAt,
    expiresAt: review.expiresAt
  }
}

function errorMessage(value: string): string {
  return redactSecrets(value)
    .replace(/(?:\/Users\/|\/home\/)[^/\s]+(?:\/[^\s]*)?/g, '[redacted-path]')
    .replace(/\/private\/var\/[^\s]+/g, '[redacted-path]')
    .replace(/\/tmp\/[^\s]+/g, '[redacted-path]')
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s]*)*/g, '[redacted-path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH)
}

async function boundary<T>(operation: () => T | Promise<T>): Promise<ChannelIpcResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    if (error instanceof ChannelError || error instanceof ChannelIpcBoundaryError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: errorMessage(error.message) || 'Channel operation failed.'
        }
      }
    }
    return {
      ok: false,
      error: { code: 'internal_error', message: 'Channel operation failed.' }
    }
  }
}

export function registerChannelHandlers(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  deps: ChannelHandlersDeps
): ChannelHandlersRegistration {
  if (!ipc || typeof ipc.handle !== 'function') {
    throw new Error('registerChannelHandlers requires an IPC registrar')
  }
  if (
    !deps ||
    !deps.service ||
    typeof deps.getChat !== 'function' ||
    typeof deps.resolveSenderScope !== 'function' ||
    (deps.migrationHandoff !== undefined &&
      (!deps.migrationHandoff || typeof deps.migrationHandoff.snapshot !== 'function'))
  ) {
    throw new Error('registerChannelHandlers requires its production dependencies')
  }

  const senderScope = (event: IpcMainInvokeEvent): ChannelIpcSenderScope => {
    try {
      const scope = deps.resolveSenderScope(event)
      if (scope?.kind === 'main') return scope
      if (scope?.kind === 'chat') return { kind: 'chat', chatId: requireChatId(scope.chatId) }
    } catch {
      // Collapse main-owned sender lookup failures to one stable denial.
    }
    throw new ChannelIpcBoundaryError('not_authorized', 'Renderer is not authorised for Channels.')
  }

  const assertScopeOwnsChat = (
    scope: ChannelIpcSenderScope,
    chatId: string
  ): Pick<ChatRecord, 'appChatId' | 'title' | 'archived'> => {
    if (scope.kind === 'chat' && scope.chatId !== chatId) {
      throw new ChannelIpcBoundaryError(
        'not_authorized',
        'Renderer is not authorised for this Channel.'
      )
    }
    const chat = deps.getChat(chatId)
    if (!chat || chat.appChatId !== chatId) {
      throw new ChannelError('not_member', 'Channel chat was not found')
    }
    return chat
  }

  const requireOwnedChannel = (
    scope: ChannelIpcSenderScope,
    channelId: string
  ): ChannelProductionChannelView => {
    const channel = deps.service
      .listChannels()
      .find((candidate) => candidate.channelId === channelId)
    if (scope.kind === 'chat' && (!channel || channel.chatId !== scope.chatId)) {
      throw new ChannelIpcBoundaryError(
        'not_authorized',
        'Renderer is not authorised for this Channel.'
      )
    }
    if (!channel) throw new ChannelError('not_member', 'Channel was not found')
    assertScopeOwnsChat(scope, channel.chatId)
    return channel
  }

  const requireOwnedHumanReview = (
    scope: ChannelIpcSenderScope,
    input: ChannelIpcHumanReviewDecisionInput
  ): ChannelProductionHumanReviewView => {
    requireOwnedChannel(scope, input.channelId)
    const review = deps.service
      .listHumanReviews({ channelId: input.channelId, includeResolved: true })
      .find((candidate) => candidate.reviewId === input.reviewId)
    if (!review) throw new ChannelError('not_member', 'Channel human review was not found')
    return review
  }

  for (const channel of HANDLED_CHANNELS) ipc.removeHandler?.(channel)

  ipc.handle('channels:list', (event) =>
    boundary(() => {
      const scope = senderScope(event)
      const channels = deps.service.listChannels()
      if (scope.kind === 'main') return channels.map(projectChannel)
      assertScopeOwnsChat(scope, scope.chatId)
      return channels.filter((channel) => channel.chatId === scope.chatId).map(projectChannel)
    })
  )

  ipc.handle('channels:read', (event, value: unknown) =>
    boundary(() => {
      const scope = senderScope(event)
      const input = parseReadInput(value)
      requireOwnedChannel(scope, input.channelId)
      return projectRead(deps.service.readChannel(input))
    })
  )

  ipc.handle('channels:audit', (event, value?: unknown) =>
    boundary(() => {
      const scope = senderScope(event)
      const input = parseAuditInput(value)
      if (input.channelId) {
        requireOwnedChannel(scope, input.channelId)
        return deps.service.listAudit(input).map(projectAudit)
      }
      if (scope.kind === 'main') return deps.service.listAudit(input).map(projectAudit)
      assertScopeOwnsChat(scope, scope.chatId)
      const channel = deps.service
        .listChannels()
        .find((candidate) => candidate.chatId === scope.chatId)
      if (!channel) return []
      return deps.service
        .listAudit({ channelId: channel.channelId, ...(input.limit ? { limit: input.limit } : {}) })
        .map(projectAudit)
    })
  )

  ipc.handle('channels:create', (event, value: unknown) =>
    boundary(() => {
      const scope = senderScope(event)
      const input = parseCreateInput(value)
      const chat = assertScopeOwnsChat(scope, input.chatId)
      if (chat.archived) throw new ChannelError('channel_closed', 'Archived chats cannot be shared')
      const title = chat.title.trim()
      if (!title || title.length > MAX_CHANNEL_TITLE_LENGTH) {
        throw new ChannelError('protocol_unsupported', 'Channel chat title is invalid')
      }
      return projectChannel(
        deps.service.createChannel({
          chatId: chat.appChatId,
          title,
          ownerDisplayName: input.ownerDisplayName,
          reference: { kind: 'chat', id: chat.appChatId }
        })
      )
    })
  )

  ipc.handle('channels:issue-invite', (event, value: unknown) =>
    boundary(() => {
      const scope = senderScope(event)
      const input = parseIssueInviteInput(value)
      requireOwnedChannel(scope, input.channelId)
      return projectInvite(deps.service.issueInvite(input))
    })
  )

  ipc.handle('channels:migration-handoff', (event, value: unknown) =>
    boundary(() => {
      const scope = senderScope(event)
      const input = parseMigrationHandoffInput(value)
      assertScopeOwnsChat(scope, input.chatId)
      if (!deps.migrationHandoff) return null
      try {
        return projectMigrationHandoff(
          deps.migrationHandoff.snapshot({ chatId: input.chatId }),
          input.chatId
        )
      } catch (error) {
        if (isPeopleToChannelMigrationHandoffError(error)) {
          throw new ChannelError(
            'recovery_blocked',
            'Migrated Channel invitations could not be recovered safely'
          )
        }
        throw error
      }
    })
  )

  ipc.handle('channels:append', (event, value: unknown) =>
    boundary(async () => {
      const scope = senderScope(event)
      const input = parseAppendInput(value)
      requireOwnedChannel(scope, input.channelId)
      return projectAppend(await deps.service.appendHost(input))
    })
  )

  ipc.handle('channels:revoke-member', (event, value: unknown) =>
    boundary(async () => {
      const scope = senderScope(event)
      const input = parseRevokeMemberInput(value)
      const channel = requireOwnedChannel(scope, input.channelId)
      if (input.memberId === channel.ownerMemberId) {
        throw new ChannelError('protocol_unsupported', 'The Channel owner cannot be revoked')
      }
      return projectMember(await deps.service.revokeMember(input))
    })
  )

  ipc.handle('channels:human-reviews', (event, value: unknown) =>
    boundary(() => {
      const scope = senderScope(event)
      const input = parseHumanReviewInput(value)
      requireOwnedChannel(scope, input.channelId)
      return deps.service.listHumanReviews(input).map(projectHumanReview)
    })
  )

  ipc.handle('channels:approve-human-review', (event, value: unknown) =>
    boundary(async () => {
      const scope = senderScope(event)
      const input = parseHumanReviewDecisionInput(value)
      requireOwnedHumanReview(scope, input)
      const result = await deps.service.approveHumanReview(input.reviewId)
      return { reviewId: input.reviewId, ...projectAppend(result.append) }
    })
  )

  ipc.handle('channels:deny-human-review', (event, value: unknown) =>
    boundary(async () => {
      const scope = senderScope(event)
      const input = parseHumanReviewDecisionInput(value)
      requireOwnedHumanReview(scope, input)
      await deps.service.denyHumanReview({ reviewId: input.reviewId })
      return { reviewId: input.reviewId, denied: true as const }
    })
  )

  ipc.handle('channels:close', (event, value: unknown) =>
    boundary(async () => {
      const scope = senderScope(event)
      const input = parseCloseInput(value)
      requireOwnedChannel(scope, input.channelId)
      return projectChannel(await deps.service.closeChannel(input.channelId))
    })
  )

  return {
    dispose: () => {
      for (const channel of HANDLED_CHANNELS) ipc.removeHandler?.(channel)
    }
  }
}
