import type { ChannelWireErrorCode } from './ChannelWireProtocol'

export const CHANNEL_IPC_CHANNELS = {
  list: 'channels:list',
  read: 'channels:read',
  audit: 'channels:audit',
  create: 'channels:create',
  issueInvite: 'channels:issue-invite',
  append: 'channels:append',
  revokeMember: 'channels:revoke-member',
  close: 'channels:close'
} as const

export const CHANNEL_IPC_CHANGED_EVENT = 'channels:changed'

export type ChannelIpcInvokeChannel =
  (typeof CHANNEL_IPC_CHANNELS)[keyof typeof CHANNEL_IPC_CHANNELS]

export type ChannelIpcErrorCode = ChannelWireErrorCode | 'not_authorized' | 'internal_error'

export interface ChannelIpcError {
  code: ChannelIpcErrorCode
  message: string
}

export type ChannelIpcResult<T> = { ok: true; value: T } | { ok: false; error: ChannelIpcError }

export type ChannelIpcStatus = 'active' | 'closed'
export type ChannelIpcMemberStatus = 'pending' | 'active' | 'revoked'
export type ChannelIpcAvailability = 'ready' | 'recovery_blocked'

export type ChannelIpcReference =
  | { kind: 'chat'; id: string }
  | { kind: 'message'; id: string }
  | { kind: 'run'; id: string }
  | { kind: 'artifact'; id: string }

export interface ChannelIpcDisplayEnvelope {
  title: string
  status: ChannelIpcStatus
  memberCount: number
  messageCount: number
}

export interface ChannelIpcChannel {
  channelId: string
  chatId: string
  ownerMemberId: string
  status: ChannelIpcStatus
  createdAt: number
  updatedAt: number
  membershipRevision: number
  messageCount: number
  reference?: ChannelIpcReference
  display: ChannelIpcDisplayEnvelope
  availability: ChannelIpcAvailability
}

export interface ChannelIpcMember {
  memberId: string
  channelId: string
  kind: 'human'
  displayName: string
  status: ChannelIpcMemberStatus
  joinedAt: number
  revokedAt?: number
}

export interface ChannelIpcMessage {
  channelId: string
  sequence: number
  messageId: string
  authorMemberId: string
  clientMessageId: string
  kind: 'human.text'
  content: string
  acceptedAt: number
  contentHash: string
}

export interface ChannelIpcReadResult {
  channel: ChannelIpcChannel
  members: ChannelIpcMember[]
  records: ChannelIpcMessage[]
  highWaterSequence: number
}

export type ChannelIpcAuditEventKind =
  | 'channel.created'
  | 'invite.created'
  | 'admission.began'
  | 'admission.confirmed'
  | 'admission.failed'
  | 'session.reconnected'
  | 'session.disconnected'
  | 'message.accepted'
  | 'message.deduplicated'
  | 'message.rejected'
  | 'replay.completed'
  | 'member.revoked'
  | 'protocol.rejected'

export interface ChannelIpcAuditEvent {
  id: string
  at: number
  kind: ChannelIpcAuditEventKind
  channelId?: string
  memberId?: string
  code?: string
  contentHash?: string
  detail?: string
}

export interface ChannelIpcInviteResult {
  channelId: string
  inviteId: string
  inviteToken: string
  roomId: string
  expiresAt: number
  relayUrls: string[]
  hostRoomOpened: boolean
}

export interface ChannelIpcAppendResult {
  record: ChannelIpcMessage
  deduplicated: boolean
}

export interface ChannelIpcReadInput {
  channelId: string
  resumeAfter: number
  maxRecords?: number
  maxBytes?: number
}

export interface ChannelIpcAuditInput {
  channelId?: string
  limit?: number
}

export interface ChannelIpcCreateInput {
  chatId: string
  ownerDisplayName: string
}

export interface ChannelIpcIssueInviteInput {
  channelId: string
  ttlMs?: number
}

export interface ChannelIpcAppendInput {
  channelId: string
  clientMessageId: string
  content: string
}

export interface ChannelIpcRevokeMemberInput {
  channelId: string
  memberId: string
}

export interface ChannelIpcCloseInput {
  channelId: string
}

export interface ChannelIpcChangeEvent {
  channelId: string
  reason: 'channel' | 'membership' | 'message'
}

export interface ChannelIpcApi {
  list(): Promise<ChannelIpcResult<ChannelIpcChannel[]>>
  read(input: ChannelIpcReadInput): Promise<ChannelIpcResult<ChannelIpcReadResult>>
  audit(input?: ChannelIpcAuditInput): Promise<ChannelIpcResult<ChannelIpcAuditEvent[]>>
  create(input: ChannelIpcCreateInput): Promise<ChannelIpcResult<ChannelIpcChannel>>
  issueInvite(input: ChannelIpcIssueInviteInput): Promise<ChannelIpcResult<ChannelIpcInviteResult>>
  append(input: ChannelIpcAppendInput): Promise<ChannelIpcResult<ChannelIpcAppendResult>>
  revokeMember(input: ChannelIpcRevokeMemberInput): Promise<ChannelIpcResult<ChannelIpcMember>>
  close(input: ChannelIpcCloseInput): Promise<ChannelIpcResult<ChannelIpcChannel>>
  onChanged(callback: (event: ChannelIpcChangeEvent) => void): () => void
}
