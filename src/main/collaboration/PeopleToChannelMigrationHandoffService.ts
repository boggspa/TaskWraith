import {
  MAX_PEOPLE_TO_CHANNEL_REISSUES,
  type PeopleToChannelReissuedAdmission
} from './PeopleToChannelMigrationAdmissionReissue'
import type { PeopleToChannelCutoverRoute } from './PeopleToChannelMigrationCutoverCoordinator'
import type {
  ChannelProductionInviteResult,
  ChannelProductionService
} from './ChannelProductionService'
import {
  PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION,
  type PeopleToChannelMigrationProductionRunResult
} from './PeopleToChannelMigrationProductionRunner'

export const PEOPLE_TO_CHANNEL_HANDOFF_VERSION = 2

export type PeopleToChannelMigrationHandoffInput = Pick<
  PeopleToChannelMigrationProductionRunResult,
  'schemaVersion' | 'planId' | 'phase' | 'routes' | 'invitations'
>

export interface PeopleToChannelMigrationHandoffInvitation {
  channelId: string
  chatId: string
  purpose: PeopleToChannelReissuedAdmission['purpose']
  /** Human-readable host label; legacy collaborator ids never cross this boundary. */
  recipientLabel: string
  expiresAt: number
  status: 'ready' | 'relay_unavailable'
  /** Null deliberately withholds the token until a usable relay projection exists. */
  invite: ChannelProductionInviteResult | null
}

export interface PeopleToChannelMigrationHandoffSnapshot {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_HANDOFF_VERSION
  planId: string
  phase: PeopleToChannelMigrationProductionRunResult['phase']
  routes: PeopleToChannelCutoverRoute[]
  invitations: PeopleToChannelMigrationHandoffInvitation[]
  retiredInvitationCount: number
  relayUnavailableInvitationCount: number
}

export interface PeopleToChannelMigrationHandoffServiceOptions {
  migration: PeopleToChannelMigrationHandoffInput
  channels: Pick<ChannelProductionService, 'describeExistingInvite'>
}

export class PeopleToChannelMigrationHandoffError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationHandoffError'
  }
}

function blocked(message: string): never {
  throw new PeopleToChannelMigrationHandoffError(message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value) && value.trim() === value
}

function recipientLabel(value: unknown): value is string {
  if (!nonBlank(value) || value.length > 120) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function validateRoute(value: PeopleToChannelCutoverRoute): void {
  if (
    !value ||
    !nonBlank(value.chatId) ||
    !nonBlank(value.channelId) ||
    (value.origin !== 'general' &&
      value.origin !== 'people' &&
      value.origin !== 'general-and-people')
  ) {
    blocked('People migration handoff route is invalid')
  }
}

function validateInvitation(value: PeopleToChannelReissuedAdmission): void {
  const pending = value?.purpose === 'pending-collaborator'
  const open = value?.purpose === 'open-invite'
  if (
    (!pending && !open) ||
    !nonBlank(value.channelId) ||
    !nonBlank(value.inviteId) ||
    !nonBlank(value.inviteToken) ||
    !nonBlank(value.roomId) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt < 0 ||
    (pending &&
      (!nonBlank(value.sourceCollaboratorId) ||
        !recipientLabel(value.recipientLabel) ||
        value.openInviteOrdinal !== undefined)) ||
    (open &&
      (value.sourceCollaboratorId !== undefined ||
        value.recipientLabel !== undefined ||
        !Number.isSafeInteger(value.openInviteOrdinal) ||
        value.openInviteOrdinal! < 1))
  ) {
    blocked('People migration handoff invitation is invalid')
  }
}

function assertProjectedCredential(
  source: PeopleToChannelReissuedAdmission,
  projected: ChannelProductionInviteResult
): void {
  if (
    projected.channelId !== source.channelId ||
    projected.inviteId !== source.inviteId ||
    projected.inviteToken !== source.inviteToken ||
    projected.roomId !== source.roomId ||
    projected.expiresAt !== source.expiresAt ||
    !Array.isArray(projected.relayUrls) ||
    projected.relayUrls.some((url) => !nonBlank(url)) ||
    typeof projected.hostRoomOpened !== 'boolean'
  ) {
    blocked('People migration handoff projection changed its invite authority')
  }
}

/**
 * Converts the encrypted migration escrow result into a host-only, chat-scoped
 * handoff. Source policy, share ids, member presentation, and retired tokens
 * never enter the projection; a token is withheld when no relay URL is usable.
 */
export class PeopleToChannelMigrationHandoffService {
  private readonly routesByChannel = new Map<string, PeopleToChannelCutoverRoute>()

  constructor(private readonly options: PeopleToChannelMigrationHandoffServiceOptions) {
    const migration = options?.migration
    if (
      !migration ||
      migration.schemaVersion !== PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION ||
      !nonBlank(migration.planId) ||
      (migration.phase !== 'cutover_applied' &&
        migration.phase !== 'finalizing' &&
        migration.phase !== 'committed') ||
      !Array.isArray(migration.routes) ||
      !Array.isArray(migration.invitations) ||
      migration.invitations.length > MAX_PEOPLE_TO_CHANNEL_REISSUES ||
      !options.channels ||
      typeof options.channels.describeExistingInvite !== 'function'
    ) {
      throw new Error('People migration handoff options are invalid')
    }
    const chatIds = new Set<string>()
    for (const route of migration.routes) {
      validateRoute(route)
      if (chatIds.has(route.chatId) || this.routesByChannel.has(route.channelId)) {
        blocked('People migration handoff route is duplicated')
      }
      chatIds.add(route.chatId)
      this.routesByChannel.set(route.channelId, clone(route))
    }
    const inviteIds = new Set<string>()
    for (const invitation of migration.invitations) {
      validateInvitation(invitation)
      if (!this.routesByChannel.has(invitation.channelId) || inviteIds.has(invitation.inviteId)) {
        blocked('People migration handoff invitation has no unique cutover route')
      }
      inviteIds.add(invitation.inviteId)
    }
  }

  snapshot(input: { chatId?: string } = {}): PeopleToChannelMigrationHandoffSnapshot {
    if (input.chatId !== undefined && !nonBlank(input.chatId)) {
      blocked('People migration handoff chat scope is invalid')
    }
    const selectedRoutes = [...this.routesByChannel.values()]
      .filter((route) => input.chatId === undefined || route.chatId === input.chatId)
      .sort((left, right) => compareText(left.chatId, right.chatId))
    const selectedChannels = new Set(selectedRoutes.map((route) => route.channelId))
    const invitations: PeopleToChannelMigrationHandoffInvitation[] = []
    let retiredInvitationCount = 0
    let relayUnavailableInvitationCount = 0

    for (const source of this.options.migration.invitations) {
      if (!selectedChannels.has(source.channelId)) continue
      const route = this.routesByChannel.get(source.channelId)!
      const projected = this.options.channels.describeExistingInvite({
        channelId: source.channelId,
        inviteId: source.inviteId,
        inviteToken: source.inviteToken,
        roomId: source.roomId,
        expiresAt: source.expiresAt
      })
      if (!projected) {
        retiredInvitationCount += 1
        continue
      }
      assertProjectedCredential(source, projected)
      const relayUnavailable = projected.relayUrls.length === 0
      if (relayUnavailable) relayUnavailableInvitationCount += 1
      invitations.push({
        channelId: source.channelId,
        chatId: route.chatId,
        purpose: source.purpose,
        recipientLabel:
          source.purpose === 'pending-collaborator'
            ? source.recipientLabel!
            : `Open invitation ${source.openInviteOrdinal!}`,
        expiresAt: source.expiresAt,
        status: relayUnavailable ? 'relay_unavailable' : 'ready',
        invite: relayUnavailable ? null : clone(projected)
      })
    }

    invitations.sort((left, right) =>
      compareText(
        `${left.chatId}\u0000${left.channelId}\u0000${left.purpose}\u0000${left.recipientLabel}`,
        `${right.chatId}\u0000${right.channelId}\u0000${right.purpose}\u0000${right.recipientLabel}`
      )
    )
    return {
      schemaVersion: PEOPLE_TO_CHANNEL_HANDOFF_VERSION,
      planId: this.options.migration.planId,
      phase: this.options.migration.phase,
      routes: selectedRoutes.map(clone),
      invitations,
      retiredInvitationCount,
      relayUnavailableInvitationCount
    }
  }
}

export function isPeopleToChannelMigrationHandoffError(
  error: unknown
): error is PeopleToChannelMigrationHandoffError {
  return error instanceof PeopleToChannelMigrationHandoffError && error.code === 'recovery_blocked'
}
