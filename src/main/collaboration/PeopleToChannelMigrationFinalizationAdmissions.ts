import { existsSync } from 'fs'

import type { HumanCollaborationSafeStorage } from './HumanCollaborationIdentityStore'
import {
  MAX_PEOPLE_TO_CHANNEL_REISSUES,
  PeopleToChannelMigrationAdmissionReissue,
  PeopleToChannelMigrationAdmissionReissueError,
  type PeopleToChannelAdmissionEscrowResult,
  type PeopleToChannelReissuedAdmission
} from './PeopleToChannelMigrationAdmissionReissue'
import type { PeopleToChannelMigrationExecution } from './PeopleToChannelMigrationExecutionStore'
import type { PeopleToChannelMigrationFinalizationExecution } from './PeopleToChannelMigrationFinalizationExecutionStore'
import type { PeopleToChannelMigrationHistoryMaterialization } from './PeopleToChannelMigrationHistory'
import {
  ChannelError,
  ChannelStore,
  hashChannelInviteToken,
  type ChannelInvite,
  type ChannelStoreMigrationMutation
} from './ChannelStore'
import { channelStoreSubsetDigest } from './ChannelStoreSubsetDigest'
import { validatePeopleToChannelMigrationFinalizationScope } from './PeopleToChannelMigrationFinalizationScope'

export const PEOPLE_TO_CHANNEL_FINALIZATION_ADMISSIONS_VERSION = 1

export type PeopleToChannelMigrationFinalizationAdmissionsStage =
  | 'terminal_escrow_durable'
  | 'terminal_metadata_durable'
  | 'superseded_invitations_retired'

export interface PeopleToChannelMigrationFinalizationAdmissionsOptions {
  /** Separate from the additive escrow; it is bound to the finalization fence. */
  storagePath: string
  safeStorage: HumanCollaborationSafeStorage
  channels: ChannelStore
  randomToken?: () => string
  randomId?: () => string
  afterStage?: (stage: PeopleToChannelMigrationFinalizationAdmissionsStage) => void
}

export interface PeopleToChannelMigrationFinalizationAdmissionsResult {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_FINALIZATION_ADMISSIONS_VERSION
  initialPlanId: string
  planId: string
  invitations: PeopleToChannelReissuedAdmission[]
  terminalEscrowDigest: string | null
  metadataApplied: boolean
  retiredInvitationCount: number
  channelIds: string[]
}

export class PeopleToChannelMigrationFinalizationAdmissionsError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationFinalizationAdmissionsError'
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/

function blocked(message: string): never {
  throw new PeopleToChannelMigrationFinalizationAdmissionsError(message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
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

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function invitationKey(
  value: Pick<PeopleToChannelReissuedAdmission, 'channelId' | 'inviteId'>
): string {
  return `${value.channelId}\u0000${value.inviteId}`
}

function terminalTime(execution: PeopleToChannelMigrationFinalizationExecution): number {
  const value = execution.delta.base.migrationAt
  if (!timestamp(value)) blocked('People migration terminal admission time is invalid')
  return value
}

function assertInitialInvitation(value: PeopleToChannelReissuedAdmission): void {
  const pending = value.purpose === 'pending-collaborator'
  const open = value.purpose === 'open-invite'
  if (
    !value ||
    !identifier(value.sourceShareId) ||
    !identifier(value.channelId) ||
    !identifier(value.inviteId) ||
    !identifier(value.roomId) ||
    !INVITE_TOKEN_PATTERN.test(value.inviteToken) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.expiresAt) ||
    value.expiresAt < value.createdAt ||
    !value.policy ||
    !SHA256_PATTERN.test(value.policy.sourceDigest) ||
    typeof value.policy.requiresHostApproval !== 'boolean' ||
    typeof value.policy.fullHistory !== 'boolean' ||
    (!pending && !open) ||
    (pending &&
      (!identifier(value.sourceCollaboratorId) ||
        typeof value.recipientLabel !== 'string' ||
        !value.recipientLabel ||
        value.openInviteOrdinal !== undefined)) ||
    (open &&
      (value.sourceCollaboratorId !== undefined ||
        value.recipientLabel !== undefined ||
        !Number.isSafeInteger(value.openInviteOrdinal) ||
        value.openInviteOrdinal! < 1))
  ) {
    blocked('People migration terminal initial admission is invalid')
  }
}

function assertAuthorityBinding(args: {
  initial: PeopleToChannelMigrationExecution
  finalization: PeopleToChannelMigrationFinalizationExecution
  initialInvitations: readonly PeopleToChannelReissuedAdmission[]
}): void {
  const { initial, finalization, initialInvitations } = args
  const scope = validatePeopleToChannelMigrationFinalizationScope(finalization.scope)
  const retiredShareIds = new Set(scope.retireShareIds)
  if (
    !initial ||
    !finalization ||
    !SHA256_PATTERN.test(initial.plan.planId) ||
    !SHA256_PATTERN.test(initial.planDigest) ||
    initial.base.planId !== initial.plan.planId ||
    finalization.initialPlanId !== initial.plan.planId ||
    finalization.initialPlanDigest !== initial.planDigest ||
    finalization.delta.base.planId !== finalization.delta.plan.planId ||
    !Array.isArray(initialInvitations) ||
    initialInvitations.length > MAX_PEOPLE_TO_CHANNEL_REISSUES
  ) {
    blocked('People migration terminal admissions do not match their fenced authority')
  }
  const initialKeys = new Set<string>()
  for (const invitation of initialInvitations) {
    assertInitialInvitation(invitation)
    if (!retiredShareIds.has(invitation.sourceShareId)) {
      blocked('People migration terminal admission would retire a P5-retained credential')
    }
    const key = invitationKey(invitation)
    if (initialKeys.has(key)) {
      blocked('People migration terminal initial admissions are duplicated')
    }
    initialKeys.add(key)
  }
  for (const pending of finalization.delta.base.pendingAdmissionReissues) {
    if (
      !pending ||
      !identifier(pending.sourceShareId) ||
      !retiredShareIds.has(pending.sourceShareId)
    ) {
      blocked('People migration terminal admission belongs to the retained P5 scope')
    }
  }
}

function channelInvitation(invitation: PeopleToChannelReissuedAdmission): ChannelInvite {
  return {
    inviteId: invitation.inviteId,
    channelId: invitation.channelId,
    roomId: invitation.roomId,
    tokenHash: hashChannelInviteToken(invitation.inviteToken),
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    ...(invitation.memberPresentation
      ? { memberPresentation: clone(invitation.memberPresentation) }
      : {})
  }
}

function terminalMetadataMutations(args: {
  history: PeopleToChannelMigrationHistoryMaterialization
  invitations: readonly PeopleToChannelReissuedAdmission[]
}): ChannelStoreMigrationMutation[] {
  const byChannel = new Map(
    args.history.metadataMutations.map(
      (mutation) => [mutation.channel.channelId, mutation] as const
    )
  )
  if (byChannel.size !== args.history.metadataMutations.length) {
    blocked('People migration terminal admission metadata target is duplicated')
  }
  const invitationsByChannel = new Map<string, ChannelInvite[]>()
  for (const invitation of args.invitations) {
    if (!byChannel.has(invitation.channelId)) {
      blocked('People migration terminal admission metadata target is missing')
    }
    const entries = invitationsByChannel.get(invitation.channelId) ?? []
    entries.push(channelInvitation(invitation))
    invitationsByChannel.set(invitation.channelId, entries)
  }
  return args.history.metadataMutations.map((mutation) => ({
    mode: mutation.mode,
    beforeDigest: mutation.beforeDigest,
    channel: clone(mutation.channel),
    members: mutation.members.map(clone),
    invites: [
      ...mutation.invites.map(clone),
      ...(invitationsByChannel.get(mutation.channel.channelId) ?? []).map(clone)
    ]
  }))
}

function terminalMetadataAfterInitialRetirement(args: {
  history: PeopleToChannelMigrationHistoryMaterialization
  invitations: readonly PeopleToChannelReissuedAdmission[]
  initialInvitations: readonly PeopleToChannelReissuedAdmission[]
  at: number
}): ChannelStoreMigrationMutation[] {
  const initialKeys = new Set(args.initialInvitations.map(invitationKey))
  return terminalMetadataMutations({
    history: args.history,
    invitations: args.invitations
  }).map((mutation) => ({
    ...mutation,
    invites: mutation.invites.map((invite) =>
      initialKeys.has(invitationKey(invite)) &&
      !invite.memberId &&
      invite.consumedAt === undefined &&
      invite.revokedAt === undefined
        ? { ...invite, revokedAt: args.at }
        : invite
    )
  }))
}

function mutationsMatch(
  channels: ChannelStore,
  mutations: readonly ChannelStoreMigrationMutation[]
): boolean {
  return mutations.every((mutation) => {
    const current = channels.getChannel(mutation.channel.channelId)
    if (!current) return false
    return (
      channelStoreSubsetDigest(
        current,
        channels.listMembers(current.channelId),
        channels.listInvites(current.channelId)
      ) === channelStoreSubsetDigest(mutation.channel, mutation.members, mutation.invites)
    )
  })
}

function verifyInitialTuple(
  channels: ChannelStore,
  source: PeopleToChannelReissuedAdmission
): ChannelInvite | null {
  const invite = channels.getInvite(source.channelId, source.inviteId)
  if (!invite) return null
  if (
    invite.roomId !== source.roomId ||
    invite.tokenHash !== hashChannelInviteToken(source.inviteToken) ||
    invite.createdAt !== source.createdAt ||
    invite.expiresAt !== source.expiresAt
  ) {
    blocked('People migration terminal initial admission does not match Channel metadata')
  }
  return invite
}

function assertNoInitialAdmissionInFlight(args: {
  channels: ChannelStore
  initialInvitations: readonly PeopleToChannelReissuedAdmission[]
}): void {
  for (const source of args.initialInvitations) {
    const invite = verifyInitialTuple(args.channels, source)
    if (invite?.memberId && invite.consumedAt === undefined && invite.revokedAt === undefined) {
      blocked('People migration terminal admission has an in-flight legacy handshake')
    }
  }
}

function assertInitialAdmissionsRetired(args: {
  channels: ChannelStore
  initialInvitations: readonly PeopleToChannelReissuedAdmission[]
}): void {
  for (const source of args.initialInvitations) {
    const invite = verifyInitialTuple(args.channels, source)
    if (!invite) continue
    if (invite.memberId && invite.consumedAt === undefined && invite.revokedAt === undefined) {
      blocked('People migration terminal admission has an in-flight legacy handshake')
    }
    if (!invite.memberId && invite.consumedAt === undefined && invite.revokedAt === undefined) {
      blocked('People migration terminal initial admission remains usable')
    }
  }
}

function retireInitialInvitations(args: {
  channels: ChannelStore
  initialInvitations: readonly PeopleToChannelReissuedAdmission[]
  at: number
}): { retiredInvitationCount: number; channelIds: string[]; metadataApplied: boolean } {
  const revokeIdsByChannel = new Map<string, Set<string>>()
  for (const source of args.initialInvitations) {
    const invite = verifyInitialTuple(args.channels, source)
    if (!invite || invite.revokedAt !== undefined || invite.consumedAt !== undefined) continue
    if (invite.memberId) {
      blocked('People migration terminal admission has an in-flight legacy handshake')
    }
    const ids = revokeIdsByChannel.get(source.channelId) ?? new Set<string>()
    ids.add(source.inviteId)
    revokeIdsByChannel.set(source.channelId, ids)
  }
  if (revokeIdsByChannel.size === 0) {
    return { retiredInvitationCount: 0, channelIds: [], metadataApplied: false }
  }
  const mutations: ChannelStoreMigrationMutation[] = []
  let retiredInvitationCount = 0
  for (const [channelId, inviteIds] of [...revokeIdsByChannel.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const channel = args.channels.getChannel(channelId)
    if (!channel) blocked('People migration terminal invitation target disappeared')
    const members = args.channels.listMembers(channelId)
    const invitations = args.channels.listInvites(channelId)
    const nextInvitations = invitations.map((invite) => {
      if (!inviteIds.has(invite.inviteId)) return invite
      if (invite.memberId || invite.consumedAt !== undefined || invite.revokedAt !== undefined) {
        blocked('People migration terminal invitation state changed during retirement')
      }
      retiredInvitationCount += 1
      return { ...invite, revokedAt: args.at }
    })
    mutations.push({
      mode: 'merge',
      beforeDigest: channelStoreSubsetDigest(channel, members, invitations),
      channel,
      members,
      invites: nextInvitations
    })
  }
  const result = args.channels.applyMigrationBatch(mutations)
  return {
    retiredInvitationCount,
    channelIds: result.channelIds,
    metadataApplied: result.applied
  }
}

/**
 * The final P4 cutover deliberately rotates every still-open migrated Channel
 * credential. The replacement escrow is durable first; only then are the
 * additive-soak credentials revoked. This produces one terminal policy plan
 * for every remaining pending/open admission and avoids restart ambiguity.
 */
export class PeopleToChannelMigrationFinalizationAdmissions {
  constructor(private readonly options: PeopleToChannelMigrationFinalizationAdmissionsOptions) {
    if (!options || typeof options !== 'object' || !options.channels || !options.safeStorage) {
      throw new Error('People migration terminal admissions require durable authorities')
    }
  }

  apply(args: {
    initial: PeopleToChannelMigrationExecution
    finalization: PeopleToChannelMigrationFinalizationExecution
    initialInvitations: readonly PeopleToChannelReissuedAdmission[]
  }): PeopleToChannelMigrationFinalizationAdmissionsResult {
    assertAuthorityBinding(args)
    assertNoInitialAdmissionInFlight({
      channels: this.options.channels,
      initialInvitations: args.initialInvitations
    })
    const terminal = this.reissue(args.finalization)
    let escrow: PeopleToChannelAdmissionEscrowResult | null = null
    let metadataApplied = false
    let channelIds: string[] = []

    if (existsSync(this.options.storagePath)) {
      escrow = terminal.recoverEscrow({
        base: args.finalization.delta.base,
        history: args.finalization.delta.history
      })
      const desired = terminalMetadataMutations({
        history: args.finalization.delta.history,
        invitations: escrow.invitations
      })
      const retiredDesired = terminalMetadataAfterInitialRetirement({
        history: args.finalization.delta.history,
        invitations: escrow.invitations,
        initialInvitations: args.initialInvitations,
        at: terminalTime(args.finalization)
      })
      if (
        !mutationsMatch(this.options.channels, desired) &&
        !mutationsMatch(this.options.channels, retiredDesired)
      ) {
        const applied = terminal.apply({
          base: args.finalization.delta.base,
          history: args.finalization.delta.history
        })
        escrow = { invitations: applied.invitations, escrowDigest: applied.escrowDigest }
        metadataApplied = applied.metadataApplied
        channelIds = applied.channelIds
      }
    } else {
      const applied = terminal.apply({
        base: args.finalization.delta.base,
        history: args.finalization.delta.history
      })
      escrow = { invitations: applied.invitations, escrowDigest: applied.escrowDigest }
      metadataApplied = applied.metadataApplied
      channelIds = applied.channelIds
    }

    if (!escrow) blocked('People migration terminal admission escrow is unavailable')
    if (escrow.invitations.length === 0) {
      const desired = args.finalization.delta.history.metadataMutations
      const retiredDesired = terminalMetadataAfterInitialRetirement({
        history: args.finalization.delta.history,
        invitations: [],
        initialInvitations: args.initialInvitations,
        at: terminalTime(args.finalization)
      })
      if (
        !mutationsMatch(this.options.channels, desired) &&
        !mutationsMatch(this.options.channels, retiredDesired)
      ) {
        const applied = this.options.channels.applyMigrationBatch(desired)
        metadataApplied ||= applied.applied
        channelIds = [...new Set([...channelIds, ...applied.channelIds])].sort()
        this.options.afterStage?.('terminal_metadata_durable')
      }
    }

    const retired = retireInitialInvitations({
      channels: this.options.channels,
      initialInvitations: args.initialInvitations,
      at: terminalTime(args.finalization)
    })
    if (retired.metadataApplied) this.options.afterStage?.('superseded_invitations_retired')
    return {
      schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_ADMISSIONS_VERSION,
      initialPlanId: args.initial.plan.planId,
      planId: args.finalization.delta.base.planId,
      invitations: escrow.invitations.map(clone),
      terminalEscrowDigest: escrow.escrowDigest,
      metadataApplied: metadataApplied || retired.metadataApplied,
      retiredInvitationCount: retired.retiredInvitationCount,
      channelIds: [...new Set([...channelIds, ...retired.channelIds])].sort()
    }
  }

  recover(args: {
    initial: PeopleToChannelMigrationExecution
    finalization: PeopleToChannelMigrationFinalizationExecution
    initialInvitations: readonly PeopleToChannelReissuedAdmission[]
  }): PeopleToChannelMigrationFinalizationAdmissionsResult {
    assertAuthorityBinding(args)
    const escrow = this.reissue(args.finalization).recoverEscrow({
      base: args.finalization.delta.base,
      history: args.finalization.delta.history
    })
    const desired = terminalMetadataAfterInitialRetirement({
      history: args.finalization.delta.history,
      invitations: escrow.invitations,
      initialInvitations: args.initialInvitations,
      at: terminalTime(args.finalization)
    })
    if (!mutationsMatch(this.options.channels, desired)) {
      blocked('People migration terminal Channel metadata is not recoverable')
    }
    assertInitialAdmissionsRetired({
      channels: this.options.channels,
      initialInvitations: args.initialInvitations
    })
    return {
      schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_ADMISSIONS_VERSION,
      initialPlanId: args.initial.plan.planId,
      planId: args.finalization.delta.base.planId,
      invitations: escrow.invitations.map(clone),
      terminalEscrowDigest: escrow.escrowDigest,
      metadataApplied: false,
      retiredInvitationCount: 0,
      channelIds: desired.map((mutation) => mutation.channel.channelId).sort()
    }
  }

  /**
   * Post-receipt recovery for ordinary startups. The committed receipt is the
   * durable authority, so this rebuilds terminal admission state from the
   * sealed escrow alone and never measures live Channel metadata against the
   * frozen migration snapshot — post-commit product activity (messages,
   * members, invites, closures, history deletion) must not re-open recovery.
   * Initial additive invitations must still be unusable wherever they survive.
   */
  recoverCommitted(args: {
    initial: PeopleToChannelMigrationExecution
    finalization: PeopleToChannelMigrationFinalizationExecution
    initialInvitations: readonly PeopleToChannelReissuedAdmission[]
  }): PeopleToChannelMigrationFinalizationAdmissionsResult {
    assertAuthorityBinding(args)
    const escrow = this.reissue(args.finalization).recoverEscrow({
      base: args.finalization.delta.base,
      history: args.finalization.delta.history
    })
    const desired = terminalMetadataAfterInitialRetirement({
      history: args.finalization.delta.history,
      invitations: escrow.invitations,
      initialInvitations: args.initialInvitations,
      at: terminalTime(args.finalization)
    })
    assertInitialAdmissionsRetired({
      channels: this.options.channels,
      initialInvitations: args.initialInvitations
    })
    return {
      schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_ADMISSIONS_VERSION,
      initialPlanId: args.initial.plan.planId,
      planId: args.finalization.delta.base.planId,
      invitations: escrow.invitations.map(clone),
      terminalEscrowDigest: escrow.escrowDigest,
      metadataApplied: false,
      retiredInvitationCount: 0,
      channelIds: desired.map((mutation) => mutation.channel.channelId).sort()
    }
  }

  private reissue(
    finalization: PeopleToChannelMigrationFinalizationExecution
  ): PeopleToChannelMigrationAdmissionReissue {
    return new PeopleToChannelMigrationAdmissionReissue({
      storagePath: this.options.storagePath,
      safeStorage: this.options.safeStorage,
      channels: this.options.channels,
      now: () => terminalTime(finalization),
      ...(this.options.randomToken ? { randomToken: this.options.randomToken } : {}),
      ...(this.options.randomId ? { randomId: this.options.randomId } : {}),
      afterEscrowDurable: () => this.options.afterStage?.('terminal_escrow_durable'),
      afterChannelApplied: () => this.options.afterStage?.('terminal_metadata_durable')
    })
  }
}

export function isPeopleToChannelMigrationFinalizationAdmissionsError(
  error: unknown
): error is
  | PeopleToChannelMigrationFinalizationAdmissionsError
  | PeopleToChannelMigrationAdmissionReissueError
  | ChannelError {
  return (
    (error instanceof PeopleToChannelMigrationFinalizationAdmissionsError ||
      error instanceof PeopleToChannelMigrationAdmissionReissueError ||
      error instanceof ChannelError) &&
    error.code === 'recovery_blocked'
  )
}
