import { CHANNEL_WIRE_PROTOCOL } from './ChannelWireProtocol'

export const CHANNEL_MEMBER_INVITE_PAYLOAD_TYPE = 'taskwraith-channel-invite'
export const CHANNEL_MEMBER_INVITE_PAYLOAD_VERSION = 1

export const CHANNEL_MEMBER_IPC_CHANNELS = {
  list: 'channels:member:list',
  snapshot: 'channels:member:snapshot',
  beginJoin: 'channels:member:begin-join',
  confirmJoin: 'channels:member:confirm-join',
  reconnect: 'channels:member:reconnect',
  append: 'channels:member:append',
  resume: 'channels:member:resume',
  disconnect: 'channels:member:disconnect',
  resetLocalHistory: 'channels:member:reset-local-history',
  forget: 'channels:member:forget'
} as const

export const CHANNEL_MEMBER_IPC_CHANGED_EVENT = 'channels:member:changed'

export type ChannelMemberIpcInvokeChannel =
  (typeof CHANNEL_MEMBER_IPC_CHANNELS)[keyof typeof CHANNEL_MEMBER_IPC_CHANNELS]

export type ChannelMemberIpcErrorCode =
  | 'invalid_invite'
  | 'invite_expired'
  | 'host_unavailable'
  | 'identity_unavailable'
  | 'not_joined'
  | 'not_connected'
  | 'revoked'
  | 'recovery_blocked'
  | 'protocol_error'
  | 'not_authorized'
  | 'internal_error'

export interface ChannelMemberIpcError {
  code: ChannelMemberIpcErrorCode
  message: string
}

export type ChannelMemberIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ChannelMemberIpcError }

export type ChannelMemberIpcPhase =
  | 'idle'
  | 'connecting'
  | 'awaiting_sas'
  | 'connected'
  | 'disconnected'
  | 'revoked'
  | 'recovery_blocked'

export interface ChannelMemberIpcChannel {
  channelId: string
  hostChatId: string
  memberId: string
  displayName: string
  title: string
  status: 'active' | 'revoked'
  savedAt: number
  updatedAt: number
}

export interface ChannelMemberIpcMembershipSummary extends ChannelMemberIpcChannel {
  active: boolean
}

export interface ChannelMemberIpcMember {
  memberId: string
  kind: 'human' | 'agent'
  displayName: string
  status: 'active'
  joinedAt: number
}

export interface ChannelMemberIpcMessage {
  channelId: string
  sequence: number
  messageId: string
  authorMemberId: string
  clientMessageId: string
  kind: 'human.text' | 'agent.text'
  content: string
  acceptedAt: number
  contentHash: string
}

export interface ChannelMemberIpcSnapshot {
  phase: ChannelMemberIpcPhase
  connected: boolean
  channel: ChannelMemberIpcChannel | null
  members: ChannelMemberIpcMember[]
  records: ChannelMemberIpcMessage[]
  highWaterSequence: number
  error: ChannelMemberIpcError | null
}

export interface ChannelMemberIpcInvitePayload {
  type: typeof CHANNEL_MEMBER_INVITE_PAYLOAD_TYPE
  v: typeof CHANNEL_MEMBER_INVITE_PAYLOAD_VERSION
  protocol: typeof CHANNEL_WIRE_PROTOCOL
  channelId: string
  chatId: string
  inviteId: string
  inviteToken: string
  roomId: string
  expiresAt: number
  relayUrl: string
  relayUrls: string[]
  requiresOutOfBandSas: true
  title?: string
}

export interface ChannelMemberIpcBeginJoinInput {
  invite: ChannelMemberIpcInvitePayload
  displayName: string
}

export interface ChannelMemberIpcReconnectInput {
  channelId?: string
}

export interface ChannelMemberIpcAppendInput {
  content: string
  clientMessageId: string
}

export interface ChannelMemberIpcConfirmedLocalMutationInput {
  channelId: string
  confirmed: true
}

export interface ChannelMemberIpcChangeEvent {
  channelId?: string
  reason: 'snapshot'
}

export interface ChannelMemberIpcApi {
  list(): Promise<ChannelMemberIpcResult<ChannelMemberIpcMembershipSummary[]>>
  snapshot(): Promise<ChannelMemberIpcResult<ChannelMemberIpcSnapshot>>
  beginJoin(
    input: ChannelMemberIpcBeginJoinInput
  ): Promise<ChannelMemberIpcResult<{ confirmCode: string }>>
  confirmJoin(): Promise<ChannelMemberIpcResult<ChannelMemberIpcSnapshot>>
  reconnect(
    input: ChannelMemberIpcReconnectInput
  ): Promise<ChannelMemberIpcResult<ChannelMemberIpcSnapshot>>
  append(
    input: ChannelMemberIpcAppendInput
  ): Promise<ChannelMemberIpcResult<{ record: ChannelMemberIpcMessage; deduplicated: boolean }>>
  resume(): Promise<ChannelMemberIpcResult<ChannelMemberIpcSnapshot>>
  disconnect(): Promise<ChannelMemberIpcResult<ChannelMemberIpcSnapshot>>
  resetLocalHistory(
    input: ChannelMemberIpcConfirmedLocalMutationInput
  ): Promise<ChannelMemberIpcResult<ChannelMemberIpcSnapshot>>
  forget(
    input: ChannelMemberIpcConfirmedLocalMutationInput
  ): Promise<ChannelMemberIpcResult<ChannelMemberIpcSnapshot>>
  onChanged(callback: (event: ChannelMemberIpcChangeEvent) => void): () => void
}
