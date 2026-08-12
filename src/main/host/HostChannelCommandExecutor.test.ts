import { describe, expect, it, vi } from 'vitest'

import type { HostCommand } from '../../shared/hostProtocol'
import { HOST_PROTOCOL_VERSION } from '../../shared/hostProtocol'
import { HostChannelCommandExecutor, type HostChannelAdminPort } from './HostChannelCommandExecutor'

function command(overrides: Partial<HostCommand> = {}): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: '8c2f3ec4-54c0-4f41-bf7a-8d981e1f75fd',
    idempotencyKey: 'channel-command-key',
    actor: { actorId: 'actor', clientId: 'client', clientClass: 'desktop' },
    name: 'channel.member.revoke',
    target: { channelId: 'channel-a' },
    arguments: { memberId: 'member-a' },
    issuedAt: '2026-08-12T20:00:00.000Z',
    ...overrides
  }
}

function port(overrides: Partial<HostChannelAdminPort> = {}): HostChannelAdminPort {
  return {
    revokeMember: vi.fn(async ({ memberId }) => ({
      ok: true as const,
      member: { memberId, status: 'revoked' as const }
    })),
    closeChannel: vi.fn(async (channelId) => ({
      ok: true as const,
      channel: { channelId, status: 'closed' as const }
    })),
    ...overrides
  }
}

describe('HostChannelCommandExecutor', () => {
  it('executes an exact member revocation through the narrow Channel port', async () => {
    const channels = port()
    const result = await new HostChannelCommandExecutor(channels).execute(command())

    expect(result).toEqual({ status: 'succeeded', resultSummary: 'Channel member revoked' })
    expect(channels.revokeMember).toHaveBeenCalledWith({
      channelId: 'channel-a',
      memberId: 'member-a'
    })
  })

  it('executes close and preserves a bounded domain failure', async () => {
    const channels = port({
      closeChannel: vi.fn(async () => ({
        ok: false as const,
        code: 'recovery_blocked',
        message: 'Channel recovery is blocked'
      }))
    })
    const result = await new HostChannelCommandExecutor(channels).execute(
      command({ name: 'channel.close', arguments: {} })
    )

    expect(result).toEqual({
      status: 'failed',
      errorCode: 'recovery_blocked',
      errorMessage: 'Channel recovery is blocked'
    })
  })

  it('rejects non-Channel and non-exact commands without touching the service', async () => {
    const channels = port()
    const executor = new HostChannelCommandExecutor(channels)

    expect(await executor.execute(command({ name: 'thread.select' }))).toMatchObject({
      status: 'failed',
      errorCode: 'not_channel_command'
    })
    expect(
      await executor.execute(
        command({ arguments: { memberId: 'member-a', inviteToken: 'must-not-pass' } })
      )
    ).toMatchObject({ status: 'failed', errorCode: 'invalid_command_arguments' })
    expect(channels.revokeMember).not.toHaveBeenCalled()
    expect(channels.closeChannel).not.toHaveBeenCalled()
  })
})
