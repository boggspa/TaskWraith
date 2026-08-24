import type { HostChannelProjection } from '../../shared/hostProtocol'
import type {
  ChannelProductionChannelInspection,
  ChannelProductionChannelView,
  ChannelProductionMemberView,
  ChannelProductionService,
  ChannelProductionStatus
} from '../collaboration/ChannelProductionService'
import { ChannelError } from '../collaboration/ChannelStore'
import type {
  HostChannelAdminFailure,
  HostChannelAdminPort,
  HostChannelCloseResult,
  HostChannelMemberRevocationResult
} from './HostChannelCommandExecutor'
import type { HostProductionChannelListPort } from '../../host-runtime/HostProductionSuppliers'

type ChannelServicePort = Pick<
  ChannelProductionService,
  'status' | 'listChannels' | 'inspectChannel' | 'revokeMember' | 'closeChannel'
>

export interface HostProductionChannelAdapterOptions {
  readonly getService: () => ChannelServicePort | null
}

export type HostProductionChannelPort = HostProductionChannelListPort & HostChannelAdminPort

function unavailable(): HostChannelAdminFailure {
  return {
    ok: false,
    code: 'host_unavailable',
    message: 'Channels service is unavailable'
  }
}

function operationFailure(error: unknown): HostChannelAdminFailure {
  if (error instanceof ChannelError) {
    return { ok: false, code: error.code, message: error.message.slice(0, 200) }
  }
  return { ok: false, code: 'channel_command_failed', message: 'Channel command failed' }
}

function isRunning(status: ChannelProductionStatus): boolean {
  return status.state === 'running'
}

function projectChannel(
  channel: ChannelProductionChannelView,
  inspection: ChannelProductionChannelInspection
): HostChannelProjection {
  const members = inspection.members
    ?.filter(
      (member): member is ChannelProductionMemberView & { status: 'pending' | 'active' } =>
        member.status === 'pending' || member.status === 'active'
    )
    .map((member) => ({
      memberId: member.memberId,
      kind: member.kind,
      displayName: member.displayName,
      status: member.status
    }))

  return {
    channelId: channel.channelId,
    threadId: channel.chatId,
    ownerMemberId: channel.ownerMemberId,
    title: channel.display.title,
    status: channel.status,
    availability: channel.availability,
    membershipRevision: channel.membershipRevision,
    memberCount: channel.display.memberCount,
    messageCount: channel.messageCount,
    updatedAt: channel.updatedAt,
    ...(members === undefined ? {} : { members }),
    ...(inspection.pendingAdmissionCount === undefined
      ? {}
      : { pendingAdmissionCount: inspection.pendingAdmissionCount }),
    ...(inspection.pendingHumanReviewCount === undefined
      ? {}
      : { pendingHumanReviewCount: inspection.pendingHumanReviewCount })
  }
}

/**
 * Adapts the local Channels runtime into compact Host state and governed owner
 * mutations. This boundary intentionally has no invite, relay, message or
 * identity-key methods.
 */
export function createHostProductionChannelAdapter(
  options: HostProductionChannelAdapterOptions
): HostProductionChannelPort {
  if (!options || typeof options.getService !== 'function') {
    throw new Error('HostProductionChannelAdapter requires getService')
  }

  const runningService = (): ChannelServicePort | null => {
    const service = options.getService()
    return service && isRunning(service.status()) ? service : null
  }

  return {
    listChannels(): HostChannelProjection[] | undefined {
      const service = runningService()
      if (!service) return undefined
      return service
        .listChannels()
        .map((channel) => projectChannel(channel, service.inspectChannel(channel.channelId)))
    },

    async revokeMember(args): Promise<HostChannelMemberRevocationResult> {
      const service = runningService()
      if (!service) return unavailable()
      try {
        const member = await service.revokeMember(args)
        if (member.status !== 'revoked') {
          return {
            ok: false,
            code: 'channel_command_failed',
            message: 'Channel member revocation did not reach a terminal state'
          }
        }
        return { ok: true, member: { memberId: member.memberId, status: 'revoked' } }
      } catch (error) {
        return operationFailure(error)
      }
    },

    async closeChannel(channelId): Promise<HostChannelCloseResult> {
      const service = runningService()
      if (!service) return unavailable()
      try {
        const channel = await service.closeChannel(channelId)
        if (channel.status !== 'closed') {
          return {
            ok: false,
            code: 'channel_command_failed',
            message: 'Channel close did not reach a terminal state'
          }
        }
        return { ok: true, channel: { channelId: channel.channelId, status: 'closed' } }
      } catch (error) {
        return operationFailure(error)
      }
    }
  }
}
