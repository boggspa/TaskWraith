import type { ChannelIpcErrorCode } from './ChannelIpc'

export const CHANNEL_AGENT_IPC_CHANNELS = {
  overview: 'channels:agent:overview',
  enroll: 'channels:agent:enroll',
  grant: 'channels:agent:grant',
  revoke: 'channels:agent:revoke',
  rotate: 'channels:agent:rotate'
} as const

export type ChannelAgentIpcInvokeChannel =
  (typeof CHANNEL_AGENT_IPC_CHANNELS)[keyof typeof CHANNEL_AGENT_IPC_CHANNELS]

export type ChannelAgentIpcProviderId =
  | 'gemini'
  | 'codex'
  | 'claude'
  | 'kimi'
  | 'grok'
  | 'cursor'
  | 'ollama'
  | 'antigravity'
  | 'pi'
  | 'mistral'
  | 'muse'
  | 'devin'

export type ChannelAgentIpcPermissionPresetId =
  | 'read_only'
  | 'plan'
  | 'default'
  | 'workspace_write'
  | 'full_access'

export type ChannelAgentIpcErrorCode =
  | ChannelIpcErrorCode
  | 'authority_expired'
  | 'channel_unavailable'
  | 'invalid_input'
  | 'not_enrolled'
  | 'rotation_required'

export interface ChannelAgentIpcError {
  code: ChannelAgentIpcErrorCode
  message: string
}

export type ChannelAgentIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ChannelAgentIpcError }

export interface ChannelAgentIpcSeat {
  agentSeatId: string
  displayName: string
  /** Null means the mutable roster/provider descriptor disappeared; cleanup remains available. */
  provider: ChannelAgentIpcProviderId | null
  model: string | null
  role: string | null
}

export interface ChannelAgentIpcMembership {
  channelId: string
  memberId: string
  displayName: string
  keyGeneration: number
  status: 'active' | 'revoked'
}

export interface ChannelAgentIpcMentioner {
  memberId: string
  displayName: string
}

export interface ChannelAgentIpcOverviewSeat {
  seat: ChannelAgentIpcSeat
  currentKeyGeneration: number | null
  membership?: ChannelAgentIpcMembership
}

export interface ChannelAgentIpcOverview {
  channelId: string
  seats: ChannelAgentIpcOverviewSeat[]
  allowedMentioners: ChannelAgentIpcMentioner[]
  permissionPresetIds: ChannelAgentIpcPermissionPresetId[]
  grantLimits: {
    defaultTtlMs: number
    minimumTtlMs: number
    maximumTtlMs: number
    defaultMaxDispatches: number
    maximumDispatches: number
  }
}

export interface ChannelAgentIpcOverviewInput {
  channelId: string
}

interface ChannelAgentIpcActionInput {
  requestId: string
  channelId: string
  agentSeatId: string
}

export interface ChannelAgentIpcEnrollInput extends ChannelAgentIpcActionInput {}

export interface ChannelAgentIpcGrantInput extends ChannelAgentIpcActionInput {
  permissionPresetId: ChannelAgentIpcPermissionPresetId
  allowedMentionerMemberIds?: string[]
  ttlMs?: number
  maxDispatches?: number
}

export interface ChannelAgentIpcRevokeInput extends ChannelAgentIpcActionInput {}

export interface ChannelAgentIpcRotateInput extends ChannelAgentIpcActionInput {
  reEnrollChannelIds?: string[]
}

export interface ChannelAgentIpcAppliedMember {
  channelId: string
  memberId: string
  status: 'active' | 'revoked'
  keyGeneration: number
}

export type ChannelAgentIpcApplied =
  | {
      kind: 'enroll'
      agentSeatId: string
      member: ChannelAgentIpcAppliedMember
    }
  | {
      kind: 'grant'
      agentSeatId: string
      member: ChannelAgentIpcAppliedMember
      allowedMentionerMemberIds: string[]
      permissionPresetId: ChannelAgentIpcPermissionPresetId
      expiresAt: number
      maxDispatches: number
    }
  | {
      kind: 'revoke'
      agentSeatId: string
      member: ChannelAgentIpcAppliedMember
      alreadyRevoked: boolean
    }
  | {
      kind: 'rotate'
      agentSeatId: string
      fromKeyGeneration: number
      toKeyGeneration: number
      members: ChannelAgentIpcAppliedMember[]
      resumed: boolean
    }

export type ChannelAgentIpcOutcome =
  | { status: 'declined' }
  | { status: 'stale' }
  | { status: 'applied'; value: ChannelAgentIpcApplied }

export interface ChannelAgentIpcApi {
  overview(
    input: ChannelAgentIpcOverviewInput
  ): Promise<ChannelAgentIpcResult<ChannelAgentIpcOverview>>
  enroll(input: ChannelAgentIpcEnrollInput): Promise<ChannelAgentIpcResult<ChannelAgentIpcOutcome>>
  grant(input: ChannelAgentIpcGrantInput): Promise<ChannelAgentIpcResult<ChannelAgentIpcOutcome>>
  revoke(input: ChannelAgentIpcRevokeInput): Promise<ChannelAgentIpcResult<ChannelAgentIpcOutcome>>
  rotate(input: ChannelAgentIpcRotateInput): Promise<ChannelAgentIpcResult<ChannelAgentIpcOutcome>>
}
