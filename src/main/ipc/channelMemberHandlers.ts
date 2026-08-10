import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  CHANNEL_MEMBER_INVITE_PAYLOAD_TYPE,
  CHANNEL_MEMBER_INVITE_PAYLOAD_VERSION,
  CHANNEL_MEMBER_IPC_CHANNELS,
  type ChannelMemberIpcAppendInput,
  type ChannelMemberIpcBeginJoinInput,
  type ChannelMemberIpcChannel,
  type ChannelMemberIpcConfirmedLocalMutationInput,
  type ChannelMemberIpcError,
  type ChannelMemberIpcErrorCode,
  type ChannelMemberIpcMember,
  type ChannelMemberIpcMembershipSummary,
  type ChannelMemberIpcMessage,
  type ChannelMemberIpcReconnectInput,
  type ChannelMemberIpcResult,
  type ChannelMemberIpcSnapshot
} from '../../shared/collaboration/ChannelMemberIpc'
import { CHANNEL_WIRE_PROTOCOL } from '../../shared/collaboration/ChannelWireProtocol'
import { redactSecrets } from '../../shared/secretRedaction'
import {
  ChannelMemberProductionError,
  type ChannelMemberProductionChannelView,
  type ChannelMemberProductionMembershipSummary,
  type ChannelMemberProductionService,
  type ChannelMemberProductionSnapshot
} from '../collaboration/ChannelMemberProductionService'
import type { ChannelMessage } from '../collaboration/ChannelMessageLog'
import type { ChannelMemberReplicaMember } from '../collaboration/ChannelMemberReplicaStore'

const MAX_IDENTIFIER_LENGTH = 200
const MAX_INVITE_TOKEN_LENGTH = 512
const MAX_RELAY_URL_LENGTH = 2_048
const MAX_RELAY_URLS = 8
const MAX_DISPLAY_NAME_LENGTH = 120
const MAX_TITLE_LENGTH = 200
const MAX_MESSAGE_BYTES = 8_000
const MAX_CLIENT_MESSAGE_ID_LENGTH = 200
const MAX_ERROR_MESSAGE_LENGTH = 240

const HANDLED_CHANNELS = Object.values(CHANNEL_MEMBER_IPC_CHANNELS)

export interface ChannelMemberHandlersDeps {
  service: Pick<
    ChannelMemberProductionService,
    | 'snapshot'
    | 'listMemberships'
    | 'beginJoin'
    | 'confirmJoin'
    | 'reconnect'
    | 'append'
    | 'resume'
    | 'disconnect'
    | 'resetLocalHistory'
    | 'forget'
  >
  assertMainRendererSender: (event: IpcMainInvokeEvent) => void
}

export interface ChannelMemberHandlersRegistration {
  dispose(): void
}

class ChannelMemberIpcBoundaryError extends Error {
  constructor(
    readonly code: Extract<
      ChannelMemberIpcErrorCode,
      'invalid_invite' | 'protocol_error' | 'not_authorized'
    >,
    message: string
  ) {
    super(message)
    this.name = 'ChannelMemberIpcBoundaryError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ChannelMemberIpcBoundaryError('protocol_error', `${label} must be an object.`)
  }
  return value
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const keys = new Set(allowed)
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new ChannelMemberIpcBoundaryError('protocol_error', `${label} contains an unknown field.`)
  }
}

function requireIdentifier(value: unknown, label: string, max = MAX_IDENTIFIER_LENGTH): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    value.length > max ||
    value.includes('\0')
  ) {
    throw new ChannelMemberIpcBoundaryError('protocol_error', `${label} is invalid.`)
  }
  return value
}

function requirePathIdentifier(value: unknown, label: string): string {
  const normalized = requireIdentifier(value, label)
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new ChannelMemberIpcBoundaryError('protocol_error', `${label} is invalid.`)
  }
  return normalized
}

function requireDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ChannelMemberIpcBoundaryError('protocol_error', 'Display name is required.')
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ChannelMemberIpcBoundaryError('protocol_error', 'Display name is invalid.')
  }
  return normalized
}

function requireRelayUrl(value: unknown): string {
  const raw = requireIdentifier(value, 'Channel relay URL', MAX_RELAY_URL_LENGTH)
  try {
    const parsed = new URL(raw)
    if (
      (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('invalid relay URL')
    }
    return parsed.toString().replace(/\/$/, '')
  } catch {
    throw new ChannelMemberIpcBoundaryError(
      'invalid_invite',
      'The Channel invite contains an invalid relay URL.'
    )
  }
}

function parseBeginJoinInput(value: unknown): ChannelMemberIpcBeginJoinInput {
  const input = requireRecord(value, 'Channel member join input')
  requireOnlyKeys(input, ['invite', 'displayName'], 'Channel member join input')
  const invite = requireRecord(input.invite, 'Channel invite')
  requireOnlyKeys(
    invite,
    [
      'type',
      'v',
      'protocol',
      'channelId',
      'chatId',
      'inviteId',
      'inviteToken',
      'roomId',
      'expiresAt',
      'relayUrl',
      'relayUrls',
      'requiresOutOfBandSas',
      'title'
    ],
    'Channel invite'
  )
  if (
    invite.type !== CHANNEL_MEMBER_INVITE_PAYLOAD_TYPE ||
    invite.v !== CHANNEL_MEMBER_INVITE_PAYLOAD_VERSION ||
    invite.protocol !== CHANNEL_WIRE_PROTOCOL ||
    invite.requiresOutOfBandSas !== true
  ) {
    throw new ChannelMemberIpcBoundaryError(
      'invalid_invite',
      'This is not a supported TaskWraith Channel invite.'
    )
  }
  if (!Number.isSafeInteger(invite.expiresAt) || Number(invite.expiresAt) < 1) {
    throw new ChannelMemberIpcBoundaryError('invalid_invite', 'Channel invite expiry is invalid.')
  }
  if (!Array.isArray(invite.relayUrls)) {
    throw new ChannelMemberIpcBoundaryError('invalid_invite', 'Channel invite has no relay list.')
  }
  const relayUrl = requireRelayUrl(invite.relayUrl)
  const relayUrls = Array.from(new Set(invite.relayUrls.map(requireRelayUrl)))
  if (relayUrls.length < 1 || relayUrls.length > MAX_RELAY_URLS || !relayUrls.includes(relayUrl)) {
    throw new ChannelMemberIpcBoundaryError(
      'invalid_invite',
      'Channel invite relay list is invalid.'
    )
  }
  const title =
    invite.title === undefined
      ? ''
      : requireIdentifier(invite.title, 'Channel title', MAX_TITLE_LENGTH)
  return {
    displayName: requireDisplayName(input.displayName),
    invite: {
      type: CHANNEL_MEMBER_INVITE_PAYLOAD_TYPE,
      v: CHANNEL_MEMBER_INVITE_PAYLOAD_VERSION,
      protocol: CHANNEL_WIRE_PROTOCOL,
      channelId: requirePathIdentifier(invite.channelId, 'Channel id'),
      chatId: requireIdentifier(invite.chatId, 'Channel host chat id'),
      inviteId: requirePathIdentifier(invite.inviteId, 'Channel invite id'),
      inviteToken: requireIdentifier(
        invite.inviteToken,
        'Channel invite token',
        MAX_INVITE_TOKEN_LENGTH
      ),
      roomId: requirePathIdentifier(invite.roomId, 'Channel room id'),
      expiresAt: Number(invite.expiresAt),
      relayUrl,
      relayUrls,
      requiresOutOfBandSas: true,
      ...(title ? { title } : {})
    }
  }
}

function parseReconnectInput(value: unknown): ChannelMemberIpcReconnectInput {
  const input = requireRecord(value, 'Channel member reconnect input')
  requireOnlyKeys(input, ['channelId'], 'Channel member reconnect input')
  return {
    ...(input.channelId === undefined
      ? {}
      : { channelId: requirePathIdentifier(input.channelId, 'Channel id') })
  }
}

function parseAppendInput(value: unknown): ChannelMemberIpcAppendInput {
  const input = requireRecord(value, 'Channel member append input')
  requireOnlyKeys(input, ['content', 'clientMessageId'], 'Channel member append input')
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  if (!content || Buffer.byteLength(content, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new ChannelMemberIpcBoundaryError(
      'protocol_error',
      'Channel content must be bounded human text.'
    )
  }
  return {
    content,
    clientMessageId: requireIdentifier(
      input.clientMessageId,
      'Channel client message id',
      MAX_CLIENT_MESSAGE_ID_LENGTH
    )
  }
}

function parseConfirmedLocalMutation(
  value: unknown,
  label: string
): ChannelMemberIpcConfirmedLocalMutationInput {
  const input = requireRecord(value, label)
  requireOnlyKeys(input, ['channelId', 'confirmed'], label)
  if (input.confirmed !== true) {
    throw new ChannelMemberIpcBoundaryError(
      'protocol_error',
      `${label} requires explicit confirmation.`
    )
  }
  return {
    channelId: requirePathIdentifier(input.channelId, 'Channel id'),
    confirmed: true
  }
}

function projectChannel(channel: ChannelMemberProductionChannelView): ChannelMemberIpcChannel {
  return {
    channelId: channel.channelId,
    hostChatId: channel.hostChatId,
    memberId: channel.memberId,
    displayName: channel.displayName,
    title: channel.title,
    status: channel.status,
    savedAt: channel.savedAt,
    updatedAt: channel.updatedAt
  }
}

function projectMember(member: ChannelMemberReplicaMember): ChannelMemberIpcMember {
  return {
    memberId: member.memberId,
    kind: member.kind,
    displayName: member.displayName,
    status: 'active',
    joinedAt: member.joinedAt
  }
}

function projectMessage(message: ChannelMessage): ChannelMemberIpcMessage {
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

function projectError(
  error: ChannelMemberProductionSnapshot['error']
): ChannelMemberIpcError | null {
  if (!error) return null
  return {
    code: error.code,
    message: errorMessage(error.message) || 'Channel member operation failed.'
  }
}

function projectSnapshot(snapshot: ChannelMemberProductionSnapshot): ChannelMemberIpcSnapshot {
  return {
    phase: snapshot.phase,
    connected: snapshot.connected,
    channel: snapshot.channel ? projectChannel(snapshot.channel) : null,
    members: snapshot.members.map(projectMember),
    records: snapshot.records.map(projectMessage),
    highWaterSequence: snapshot.highWaterSequence,
    error: projectError(snapshot.error)
  }
}

function projectSummary(
  summary: ChannelMemberProductionMembershipSummary
): ChannelMemberIpcMembershipSummary {
  return { ...projectChannel(summary), active: summary.active }
}

async function boundary<T>(operation: () => T | Promise<T>): Promise<ChannelMemberIpcResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    if (
      error instanceof ChannelMemberProductionError ||
      error instanceof ChannelMemberIpcBoundaryError
    ) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: errorMessage(error.message) || 'Channel member operation failed.'
        }
      }
    }
    return {
      ok: false,
      error: { code: 'internal_error', message: 'Channel member operation failed.' }
    }
  }
}

export function registerChannelMemberHandlers(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  deps: ChannelMemberHandlersDeps
): ChannelMemberHandlersRegistration {
  if (!ipc || typeof ipc.handle !== 'function') {
    throw new Error('registerChannelMemberHandlers requires an IPC registrar')
  }
  if (!deps?.service || typeof deps.assertMainRendererSender !== 'function') {
    throw new Error('registerChannelMemberHandlers requires its production dependencies')
  }

  const authorize = (event: IpcMainInvokeEvent): void => {
    try {
      deps.assertMainRendererSender(event)
    } catch {
      throw new ChannelMemberIpcBoundaryError(
        'not_authorized',
        'Only the main window may manage joined Channels.'
      )
    }
  }

  for (const channel of HANDLED_CHANNELS) ipc.removeHandler?.(channel)

  ipc.handle('channels:member:list', (event) =>
    boundary(() => {
      authorize(event)
      return deps.service.listMemberships().map(projectSummary)
    })
  )

  ipc.handle('channels:member:snapshot', (event) =>
    boundary(() => {
      authorize(event)
      return projectSnapshot(deps.service.snapshot())
    })
  )

  ipc.handle('channels:member:begin-join', (event, value: unknown) =>
    boundary(async () => {
      authorize(event)
      const input = parseBeginJoinInput(value)
      const result = await deps.service.beginJoin({
        protocol: input.invite.protocol,
        version: input.invite.v,
        channelId: input.invite.channelId,
        hostChatId: input.invite.chatId,
        inviteId: input.invite.inviteId,
        inviteToken: input.invite.inviteToken,
        roomId: input.invite.roomId,
        relayUrls: input.invite.relayUrls,
        displayName: input.displayName,
        expiresAt: input.invite.expiresAt,
        ...(input.invite.title ? { title: input.invite.title } : {})
      })
      if (!/^\d{6}$/.test(result.confirmCode)) {
        throw new ChannelMemberIpcBoundaryError(
          'protocol_error',
          'Channel SAS confirmation code is invalid.'
        )
      }
      return { confirmCode: result.confirmCode }
    })
  )

  ipc.handle('channels:member:confirm-join', (event) =>
    boundary(async () => {
      authorize(event)
      return projectSnapshot(await deps.service.confirmJoin())
    })
  )

  ipc.handle('channels:member:reconnect', (event, value: unknown) =>
    boundary(async () => {
      authorize(event)
      const input = parseReconnectInput(value)
      return projectSnapshot(await deps.service.reconnect(input.channelId))
    })
  )

  ipc.handle('channels:member:append', (event, value: unknown) =>
    boundary(async () => {
      authorize(event)
      const input = parseAppendInput(value)
      const result = await deps.service.append(input)
      return { record: projectMessage(result.record), deduplicated: result.deduplicated }
    })
  )

  ipc.handle('channels:member:resume', (event) =>
    boundary(async () => {
      authorize(event)
      return projectSnapshot(await deps.service.resume())
    })
  )

  ipc.handle('channels:member:disconnect', (event) =>
    boundary(() => {
      authorize(event)
      deps.service.disconnect()
      return projectSnapshot(deps.service.snapshot())
    })
  )

  ipc.handle('channels:member:reset-local-history', (event, value: unknown) =>
    boundary(() => {
      authorize(event)
      const input = parseConfirmedLocalMutation(value, 'Channel local history reset')
      return projectSnapshot(deps.service.resetLocalHistory(input.channelId))
    })
  )

  ipc.handle('channels:member:forget', (event, value: unknown) =>
    boundary(() => {
      authorize(event)
      const input = parseConfirmedLocalMutation(value, 'Channel membership removal')
      deps.service.forget(input.channelId)
      return projectSnapshot(deps.service.snapshot())
    })
  )

  return {
    dispose: () => {
      for (const channel of HANDLED_CHANNELS) ipc.removeHandler?.(channel)
    }
  }
}
