import { createHash } from 'crypto'

import {
  ChannelHumanPolicyStore,
  type ChannelHumanMigrationPolicyInput
} from './ChannelHumanPolicyStore'
import {
  ChannelError,
  ChannelStore,
  hashChannelInviteToken,
  type ChannelInvite,
  type ChannelMember
} from './ChannelStore'
import {
  MAX_PEOPLE_TO_CHANNEL_REISSUES,
  type PeopleToChannelReissuedAdmission
} from './PeopleToChannelMigrationAdmissionReissue'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/

interface MigratedAdmissionRule {
  channelId: string
  inviteId: string
  roomId: string
  tokenHash: string
  expiresAt: number
  sourceShareId: string
  sourceCollaboratorId: string
  sourceDigest: string
  policy: PeopleToChannelReissuedAdmission['policy']
}

export interface PeopleToChannelMigrationAdmissionAuthorityOptions {
  migrationPlanId: string
  invitations: readonly PeopleToChannelReissuedAdmission[]
}

export interface PeopleToChannelMigrationAdmissionBinding {
  channelId: string
  inviteId: string
  memberId: string
  roomId: string
  tokenHash: string
  expiresAt: number
}

export class PeopleToChannelMigrationAdmissionAuthorityError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationAdmissionAuthorityError'
  }
}

function blocked(message: string): never {
  throw new PeopleToChannelMigrationAdmissionAuthorityError(message)
}

function identifier(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 512 || value.trim() !== value) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function recipientLabel(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 120 ||
    value.trim() !== value
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function key(channelId: string, inviteId: string): string {
  return `${channelId}\u0000${inviteId}`
}

/**
 * An open People invitation did not identify a collaborator before conversion.
 * The synthetic subject intentionally cannot satisfy a legacy allow-list, which
 * preserves the old no-widening behavior until a host makes a new Channel rule.
 */
function openInviteSubject(migrationPlanId: string, inviteId: string): string {
  return `migration_open_${createHash('sha256')
    .update(`${migrationPlanId}\u0000${inviteId}`, 'utf8')
    .digest('hex')
    .slice(0, 32)}`
}

function inputFrom(
  rule: MigratedAdmissionRule,
  memberId: string
): ChannelHumanMigrationPolicyInput {
  return {
    channelId: rule.channelId,
    memberId,
    sourceShareId: rule.sourceShareId,
    sourceCollaboratorId: rule.sourceCollaboratorId,
    sourceDigest: rule.sourceDigest,
    rules: rule.policy.rules,
    requiresHostApproval: rule.policy.requiresHostApproval,
    fullHistory: rule.policy.fullHistory
  }
}

/**
 * Main-only bridge from the encrypted migration admission escrow to the
 * member-keyed Channel policy store. It never projects People identity or
 * policy data and writes policy before an admission handshake can complete.
 */
export class PeopleToChannelMigrationAdmissionAuthority {
  private readonly rulesByInvite = new Map<string, MigratedAdmissionRule>()
  private readonly channels = new Set<string>()

  constructor(private readonly options: PeopleToChannelMigrationAdmissionAuthorityOptions) {
    if (
      !options ||
      !SHA256_PATTERN.test(options.migrationPlanId) ||
      !Array.isArray(options.invitations) ||
      options.invitations.length > MAX_PEOPLE_TO_CHANNEL_REISSUES
    ) {
      blocked('People migration admission authority options are invalid')
    }
    for (const invitation of options.invitations) {
      if (
        !invitation ||
        !identifier(invitation.sourceShareId) ||
        !identifier(invitation.channelId) ||
        !identifier(invitation.inviteId) ||
        !identifier(invitation.roomId) ||
        !INVITE_TOKEN_PATTERN.test(invitation.inviteToken) ||
        !timestamp(invitation.createdAt) ||
        !timestamp(invitation.expiresAt) ||
        invitation.expiresAt < invitation.createdAt ||
        !invitation.policy ||
        !SHA256_PATTERN.test(invitation.policy.sourceDigest) ||
        typeof invitation.policy.requiresHostApproval !== 'boolean' ||
        typeof invitation.policy.fullHistory !== 'boolean'
      ) {
        blocked('People migration admission authority invitation is invalid')
      }
      const pending = invitation.purpose === 'pending-collaborator'
      const open = invitation.purpose === 'open-invite'
      if (
        (!pending && !open) ||
        (pending &&
          (!identifier(invitation.sourceCollaboratorId) ||
            !recipientLabel(invitation.recipientLabel) ||
            invitation.openInviteOrdinal !== undefined)) ||
        (open &&
          (invitation.sourceCollaboratorId !== undefined ||
            invitation.recipientLabel !== undefined ||
            !Number.isSafeInteger(invitation.openInviteOrdinal) ||
            invitation.openInviteOrdinal! < 1))
      ) {
        blocked('People migration admission authority purpose is invalid')
      }
      const inviteKey = key(invitation.channelId, invitation.inviteId)
      if (this.rulesByInvite.has(inviteKey)) {
        blocked('People migration admission authority invitation is duplicated')
      }
      this.rulesByInvite.set(inviteKey, {
        channelId: invitation.channelId,
        inviteId: invitation.inviteId,
        roomId: invitation.roomId,
        tokenHash: hashChannelInviteToken(invitation.inviteToken),
        expiresAt: invitation.expiresAt,
        sourceShareId: invitation.sourceShareId,
        sourceCollaboratorId: pending
          ? invitation.sourceCollaboratorId!
          : openInviteSubject(options.migrationPlanId, invitation.inviteId),
        sourceDigest: invitation.policy.sourceDigest,
        policy: invitation.policy
      })
      this.channels.add(invitation.channelId)
    }
  }

  affectedChannelIds(): readonly string[] {
    return [...this.channels].sort()
  }

  reconcile(args: { store: ChannelStore; policies: ChannelHumanPolicyStore }): number {
    const inputs: ChannelHumanMigrationPolicyInput[] = []
    for (const rule of this.rulesByInvite.values()) {
      const { invite, member } = this.resolveDurableBinding(args.store, rule)
      if (!invite.memberId || !member || member.status === 'revoked') continue
      inputs.push(inputFrom(rule, member.memberId))
    }
    if (inputs.length > 0) {
      args.policies.applyMigrationPolicies({
        migrationPlanId: this.options.migrationPlanId,
        policies: inputs
      })
    }
    return inputs.length
  }

  bind(
    args: PeopleToChannelMigrationAdmissionBinding & {
      store: ChannelStore
      policies: ChannelHumanPolicyStore
    }
  ): boolean {
    const rule = this.rulesByInvite.get(key(args.channelId, args.inviteId))
    if (!rule) return false
    if (
      args.roomId !== rule.roomId ||
      args.tokenHash !== rule.tokenHash ||
      args.expiresAt !== rule.expiresAt ||
      !identifier(args.memberId)
    ) {
      throw new ChannelError(
        'recovery_blocked',
        'Migrated Channel admission does not match authority'
      )
    }
    const { invite, member } = this.resolveDurableBinding(args.store, rule)
    if (
      !invite.memberId ||
      invite.memberId !== args.memberId ||
      !member ||
      member.status === 'revoked'
    ) {
      throw new ChannelError('recovery_blocked', 'Migrated Channel admission is not durably bound')
    }
    args.policies.applyMigrationPolicies({
      migrationPlanId: this.options.migrationPlanId,
      policies: [inputFrom(rule, member.memberId)]
    })
    return true
  }

  private resolveDurableBinding(
    store: ChannelStore,
    rule: MigratedAdmissionRule
  ): { invite: ChannelInvite; member: ChannelMember | null } {
    const channel = store.getChannel(rule.channelId)
    const invite = store.getInvite(rule.channelId, rule.inviteId)
    if (
      !channel ||
      !invite ||
      invite.channelId !== rule.channelId ||
      invite.roomId !== rule.roomId ||
      invite.tokenHash !== rule.tokenHash ||
      invite.expiresAt !== rule.expiresAt
    ) {
      throw new ChannelError(
        'recovery_blocked',
        'Migrated Channel invitation does not match durable authority'
      )
    }
    const member = invite.memberId ? store.getMember(rule.channelId, invite.memberId) : null
    if (invite.memberId && !member) {
      throw new ChannelError('recovery_blocked', 'Migrated Channel invitation lost its member')
    }
    if (member && member.kind !== 'human') {
      throw new ChannelError(
        'recovery_blocked',
        'Migrated Channel invitation is bound to a non-human'
      )
    }
    return { invite, member }
  }
}

export function isPeopleToChannelMigrationAdmissionAuthorityError(
  error: unknown
): error is PeopleToChannelMigrationAdmissionAuthorityError {
  return (
    error instanceof PeopleToChannelMigrationAdmissionAuthorityError &&
    error.code === 'recovery_blocked'
  )
}
