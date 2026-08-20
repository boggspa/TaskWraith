import {
  ChannelExternalSeatAuthority,
  type ChannelExternalSeat
} from './ChannelExternalSeatAuthority'
import type { ChannelProductionService } from './ChannelProductionService'

export type ChannelExternalSeatResolverService = Pick<
  ChannelProductionService,
  | 'status'
  | 'externalSeatChannelStore'
  | 'externalSeatHumanPolicyStore'
  | 'externalSeatRuntimeAuthority'
>

/**
 * Production tri-state boundary for Channel-native external seats.
 *
 * An array means the authority was readable, including the strict empty array
 * for a healthy owner-only Channel. `null` means the authority could not be
 * enumerated: missing/non-running service, invalid chat id, recovery block, or
 * an unexpected store/runtime failure. Callers must never collapse those two
 * answers because permission gates interpret `[]` as proof that no externals
 * exist.
 */
export function resolveChannelExternalSeatsForChat(input: {
  chatId: string
  service: ChannelExternalSeatResolverService | null | undefined
}): readonly ChannelExternalSeat[] | null {
  if (typeof input.chatId !== 'string' || !input.chatId.trim()) return null
  const service = input.service
  try {
    if (!service || service.status().state !== 'running') return null
    const resolution = new ChannelExternalSeatAuthority({
      channelStore: service.externalSeatChannelStore(),
      humanPolicyStore: service.externalSeatHumanPolicyStore(),
      runtime: service.externalSeatRuntimeAuthority(),
      // X4 seal: terminal migration makes the former People fallback
      // unreachable before either runtime serves. Keeping this explicit makes
      // a legacy read impossible to reintroduce by omission.
      legacy: { mode: 'channel_only' }
    }).resolve(input.chatId)
    return resolution.state === 'ready' ? resolution.seats : null
  } catch {
    return null
  }
}
