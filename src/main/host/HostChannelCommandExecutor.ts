import type { HostActorIdentity, HostCommand } from '../../shared/hostProtocol'
import type { AppStoreHostAuthorityExecutorResult } from '../../host-runtime/AppStoreHostAuthority'
import { validateHostCommandArguments } from '../../host-runtime/HostCommandArguments'

export type HostChannelAdminFailure = {
  readonly ok: false
  readonly code: string
  readonly message: string
}

export type HostChannelMemberRevocationResult =
  | {
      readonly ok: true
      readonly member: {
        readonly memberId: string
        readonly status: 'revoked'
      }
    }
  | HostChannelAdminFailure

export type HostChannelCloseResult =
  | {
      readonly ok: true
      readonly channel: {
        readonly channelId: string
        readonly status: 'closed'
      }
    }
  | HostChannelAdminFailure

/** Narrow owner-administration port. Invite credentials never enter this boundary. */
export interface HostChannelAdminPort {
  revokeMember(args: {
    channelId: string
    memberId: string
  }): Promise<HostChannelMemberRevocationResult>
  closeChannel(channelId: string): Promise<HostChannelCloseResult>
}

const ERROR_CODE_RE = /^[a-z0-9_]{1,80}$/

function failed(code: string, message: string): AppStoreHostAuthorityExecutorResult {
  return {
    status: 'failed',
    errorCode: ERROR_CODE_RE.test(code) ? code : 'channel_command_failed',
    errorMessage: message.trim().slice(0, 200) || 'Channel command failed'
  }
}

/** Executes only the two governed Host Channel mutations. */
export class HostChannelCommandExecutor {
  constructor(private readonly channels: HostChannelAdminPort) {
    if (
      !channels ||
      typeof channels.revokeMember !== 'function' ||
      typeof channels.closeChannel !== 'function'
    ) {
      throw new Error('HostChannelCommandExecutor requires a complete Channel admin port')
    }
  }

  async execute(
    command: HostCommand,
    _context?: { actor?: HostActorIdentity }
  ): Promise<AppStoreHostAuthorityExecutorResult> {
    if (command.name !== 'channel.member.revoke' && command.name !== 'channel.close') {
      return failed('not_channel_command', 'Command is not a Channel administration command')
    }

    const validated = validateHostCommandArguments(command)
    if (!validated.ok) {
      return failed('invalid_command_arguments', validated.error)
    }

    try {
      if (validated.value.name === 'channel.member.revoke') {
        const result = await this.channels.revokeMember({
          channelId: validated.value.target.channelId!,
          memberId: validated.value.arguments.memberId as string
        })
        return result.ok
          ? { status: 'succeeded', resultSummary: 'Channel member revoked' }
          : failed(result.code, result.message)
      }

      const result = await this.channels.closeChannel(validated.value.target.channelId!)
      return result.ok
        ? { status: 'succeeded', resultSummary: 'Channel closed' }
        : failed(result.code, result.message)
    } catch {
      return failed('channel_command_failed', 'Channel command failed')
    }
  }
}
